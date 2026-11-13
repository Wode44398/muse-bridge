"""Bridge's loopback-only Qwen Image worker. Own venv/checkpoint, no cloud calls."""
import base64
import io
import json
import os
from pathlib import Path
import secrets
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Bridge (server/local-image.mjs) always starts this worker with BRIDGE_LOCAL_IMAGE_HOME set to the model directory.
ROOT = Path(os.environ.get('BRIDGE_LOCAL_IMAGE_HOME') or Path(__file__).resolve().parents[3] / 'local-image' / 'qwen-image-2.1')
PORT = int(os.environ.get('BRIDGE_LOCAL_IMAGE_PORT', '8190'))
TOKEN = (ROOT / 'runtime.key').read_text().strip()
SETTINGS = json.loads((ROOT / 'settings.json').read_text(encoding='utf-8'))
state = dict(service='bridge-qwen-image', state='starting', pid=os.getpid(), settings=SETTINGS,
             step=0, steps=0, error='', startedAt=time.time())
lock = threading.Lock()
pipe = None

def load():
    global pipe
    try:
        import torch
        from diffusers import QwenImage21Pipeline
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA is unavailable in the local image environment')
        torch.set_num_threads(SETTINGS.get('cpuThreads', 8))
        torch.backends.cuda.matmul.allow_tf32 = SETTINGS.get('tf32', True)
        state['gpu'] = torch.cuda.get_device_name(0)
        pipe = QwenImage21Pipeline.from_pretrained(
            str(ROOT / 'model'), torch_dtype=getattr(torch, SETTINGS['dtype']), local_files_only=True)
        if SETTINGS['vaeTiling']:
            tile = SETTINGS.get('vaeTileSize', 256)
            pipe.vae.enable_tiling(tile_sample_min_height=tile, tile_sample_min_width=tile,
                                   tile_sample_stride_height=tile * 3 // 4, tile_sample_stride_width=tile * 3 // 4)
        if SETTINGS['offload'] == 'sequential':
            pipe.enable_sequential_cpu_offload()
        else:
            pipe.enable_model_cpu_offload()
        state.update(state='ready', phase='idle')
    except Exception as exc:
        state.update(state='error', error=str(exc))
        traceback.print_exc()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self):
        return secrets.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN)

    def do_GET(self):
        if not self.authorized():
            return self.reply(401, {'error': 'unauthorized'})
        if self.path != '/health':
            return self.reply(404, {'error': 'not found'})
        self.reply(200, state.copy())

    def do_POST(self):
        if not self.authorized():
            return self.reply(401, {'error': 'unauthorized'})
        if self.path == '/shutdown':
            if state['state'] == 'busy':
                return self.reply(409, {'error': 'Image generation is still running'})
            self.reply(200, {'ok': True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path != '/generate':
            return self.reply(404, {'error': 'not found'})
        if state['state'] != 'ready' or not lock.acquire(blocking=False):
            return self.reply(409, {'error': 'Image model is not ready or is busy'})
        state.update(state='busy', phase='encoding', step=0, steps=0)
        try:
            from PIL import Image
            import torch
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 140_000_000:
                raise ValueError('Invalid request size')
            data = json.loads(self.rfile.read(length))
            prompt = str(data['prompt']).strip()
            width, height = int(data['width']), int(data['height'])
            steps, seed = int(data.get('steps', 40)), int(data.get('seed', -1))
            if not prompt or len(prompt) > 12000 or not 1 <= steps <= 100:
                raise ValueError('Invalid prompt or steps')
            if min(width, height) < 256 or max(width, height) > 6144 or width * height > 17_000_000 or width % 32 or height % 32:
                raise ValueError('Invalid image dimensions')
            if seed < 0:
                seed = secrets.randbelow(2**31)
            if not 0 <= seed < 2**32:
                raise ValueError('Invalid seed')
            cfg, count = float(data.get('cfg', 1)), int(data.get('count', 1))
            negative = data.get('negativePrompt', '')
            cache, resolution = data.get('useKvCache', True), data.get('referenceResolution', 1024)
            sigmas = data.get('sigmas')
            if not 1 <= cfg <= 10 or not 1 <= count <= 4 or not isinstance(negative, str) or len(negative) > 12000 or not isinstance(cache, bool) or resolution not in [512, 1024, 2048]:
                raise ValueError('Invalid generation parameters')
            if sigmas is not None and (not isinstance(sigmas, list) or len(sigmas) != steps or any(not isinstance(v, (int, float)) or not 0 < v <= 1 or (i and v >= sigmas[i-1]) for i, v in enumerate(sigmas))):
                raise ValueError('Invalid sigmas')
            encoded_images = data.get('images', [data['image']] if data.get('image') else [])
            if not isinstance(encoded_images, list) or len(encoded_images) > 10:
                raise ValueError('Invalid reference images')
            references, total_bytes = [], 0
            for encoded in encoded_images:
                raw = base64.b64decode(encoded, validate=True)
                total_bytes += len(raw)
                reference = Image.open(io.BytesIO(raw))
                if reference.width * reference.height > 32_000_000:
                    raise ValueError('Reference image is too large')
                references.append(reference.convert('RGBA' if reference.mode == 'RGBA' else 'RGB'))
            if total_bytes > 100_000_000:
                raise ValueError('Reference images exceed 100 MB')
            if data.get('transparent', False):
                prompt = 'This is an RGBA image with transparency. ' + prompt + '. The image has alpha channel and the background is transparent.'
            state['steps'] = steps
            def progress(_pipe, step, timestep, kwargs):
                state['step'] = step + 1
                state['phase'] = 'decoding' if step + 1 == steps else 'sampling'
                return kwargs
            outputs = []
            torch.cuda.reset_peak_memory_stats()
            for batch_index in range(count):
                state.update(batchIndex=batch_index + 1, count=count, step=0, phase='encoding')
                began = time.monotonic()
                item_seed = (seed + batch_index) % 2**32
                result = pipe(prompt=prompt, image=references or None, width=width, height=height,
                              num_inference_steps=steps, generator=torch.Generator('cuda').manual_seed(item_seed),
                              true_cfg_scale=cfg, negative_prompt=negative if cfg > 1 else None,
                              use_kv_cache=cache, output_resolution=resolution, sigmas=sigmas,
                              callback_on_step_end=progress).images[0]
                output = io.BytesIO()
                state['phase'] = 'saving'
                result.save(output, format='PNG')
                outputs.append({'image': base64.b64encode(output.getvalue()).decode(), 'seed': item_seed,
                                'width': result.width, 'height': result.height, 'steps': steps,
                                'seconds': round(time.monotonic() - began, 2),
                                'peakVramMb': round(torch.cuda.max_memory_allocated() / 1024**2),
                                'hasAlpha': result.mode == 'RGBA'})
            self.reply(200, {'images': outputs})
        except Exception as exc:
            traceback.print_exc()
            self.reply(500, {'error': str(exc)[:500]})
            try:
                pipe.maybe_free_model_hooks()
                torch.cuda.empty_cache()
            except Exception:
                pass
        finally:
            state.update(state='ready', phase='idle')
            lock.release()

if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    threading.Thread(target=load, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()
