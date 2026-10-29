import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { DATA_ROOT } from '@bridge/core/runtime/paths.mjs';
import { overlayHook } from '@bridge/core/runtime/overlay-hooks.mjs';

export const LOCAL_IMAGE_MODEL = 'qwen-image-2.1-local';
// 模型目录（约 33 GB 权重 + 独立 venv）：环境变量 BRIDGE_LOCAL_IMAGE_HOME > 私有 overlay 的 localImageHome 钩子
// （部署方把已装好的模型放在别处时用，字符串或返回字符串的函数）> <数据根>/local-image/qwen-image-2.1
//（与 local-image/install.ps1 不带 -ModelHome 时的默认一致）。
function modelHome() {
  if (process.env.BRIDGE_LOCAL_IMAGE_HOME) return process.env.BRIDGE_LOCAL_IMAGE_HOME;
  const h = overlayHook('localImageHome');
  try { const v = typeof h === 'function' ? h() : h; if (typeof v === 'string' && v.trim()) return v.trim(); } catch {}
  return path.join(DATA_ROOT, 'local-image', 'qwen-image-2.1');
}
const HOME = modelHome();
const PORT = Number(process.env.BRIDGE_LOCAL_IMAGE_PORT || 8190);
const PYTHON = path.join(HOME, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const SCRIPT = fileURLToPath(new URL('../local-image/server.py', import.meta.url));
const SETTINGS = path.join(HOME, 'settings.json');
const KEY = path.join(HOME, 'runtime.key');
export const DEFAULT_SETTINGS = Object.freeze({ dtype: 'bfloat16', offload: 'model', vaeTiling: true, vaeTileSize: 256, tf32: true, cpuThreads: 8 });
let pendingStart = 0, control = Promise.resolve(), generationBusy = false, spawnError = '';

export function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid deployment settings');
  const result = { ...DEFAULT_SETTINGS, ...value };
  if (!['bfloat16', 'float16'].includes(result.dtype) || !['model', 'sequential'].includes(result.offload) || typeof result.vaeTiling !== 'boolean' || typeof result.tf32 !== 'boolean' || ![256, 512, 768].includes(result.vaeTileSize) || !Number.isInteger(result.cpuThreads) || result.cpuThreads < 1 || result.cpuThreads > 32) {
    throw new Error('Invalid precision, memory mode or VAE tiling');
  }
  if (Object.keys(value).some(k => !(k in DEFAULT_SETTINGS))) throw new Error('Unknown deployment setting');
  return result;
}
function settings() {
  if (!existsSync(SETTINGS)) return { ...DEFAULT_SETTINGS };
  return normalizeSettings(JSON.parse(readFileSync(SETTINGS, 'utf8')));
}
function atomicSettings(data) {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(SETTINGS + '.tmp', JSON.stringify(data, null, 2) + '\n');
  renameSync(SETTINGS + '.tmp', SETTINGS);
}
function request(endpoint, body, timeout = 2500) {
  return new Promise((resolve, reject) => {
    if (!existsSync(KEY)) return reject(new Error('Local image service has not been started'));
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: endpoint, method: payload ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + readFileSync(KEY, 'utf8').trim(), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 400_000_000) res.destroy(new Error('Image response too large')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks));
          if (res.statusCode !== 200) reject(new Error(data.error || 'Local image service HTTP ' + res.statusCode));
          else resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Local image service timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}
export async function localImageStatus() {
  const installed = existsSync(PYTHON) && existsSync(path.join(HOME, 'model/.verified.json'));
  const base = { installed, settings: settings(), home: HOME, endpoint: `http://127.0.0.1:${PORT}`, state: 'off', error: spawnError };
  try {
    const live = await request('/health');
    if (live.service !== 'bridge-qwen-image') throw new Error('Unexpected local image service');
    pendingStart = 0;
    return { ...base, ...live, settings: base.settings, runningSettings: live.settings };
  } catch {
    if (pendingStart && Date.now() - pendingStart < 15000) base.state = 'starting';
    return base;
  }
}
async function start() {
  const current = await localImageStatus();
  if (current.state !== 'off') return current;
  if (!current.installed) throw new Error('尚未安装模型或权重校验未完成');
  mkdirSync(HOME, { recursive: true });
  if (!existsSync(KEY)) writeFileSync(KEY, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  if (!existsSync(SETTINGS)) atomicSettings(DEFAULT_SETTINGS);
  const log = openSync(path.join(HOME, 'worker.log'), 'a');
  try {
    const child = spawn(PYTHON, ['-u', SCRIPT], { detached: true, windowsHide: true,
      env: { ...process.env, BRIDGE_LOCAL_IMAGE_HOME: HOME, BRIDGE_LOCAL_IMAGE_PORT: String(PORT), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', log, log] });
    pendingStart = Date.now(); spawnError = '';
    child.on('error', error => { pendingStart = 0; spawnError = error.message; });
    child.on('exit', code => { pendingStart = 0; if (code) spawnError = `Image worker exited (${code}); see worker.log`; });
    child.unref();
  } finally { closeSync(log); }
  return localImageStatus();
}
async function stop() {
  const current = await localImageStatus();
  if (generationBusy || current.state === 'busy') throw new Error('正在生成图片，请完成后再停止或修改部署参数');
  if (current.state === 'off') return current;
  // Use the authenticated worker's shutdown endpoint; never kill arbitrary Python processes.
  await request('/shutdown', {});
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if ((await localImageStatus()).state === 'off') return localImageStatus();
  }
  throw new Error('Local image service is still stopping');
}
export function controlLocalImage(action, value) {
  const operation = control.then(async () => {
    if (action === 'start') return start();
    if (action === 'stop') return stop();
    if (action !== 'settings') throw new Error('Unknown local image action');
    const next = normalizeSettings(value);
    const current = await localImageStatus();
    if (generationBusy || current.state === 'busy') throw new Error('正在生成图片，请完成后再停止或修改部署参数');
    const restart = current.state !== 'off';
    if (restart) await stop();
    atomicSettings(next);
    return restart ? start() : localImageStatus();
  });
  control = operation.catch(() => {});
  return operation;
}

export function imageDimensions(aspect = 'auto', size = '2K', source, custom) {
  if (size === 'custom') return validateDimensions(custom?.width, custom?.height);
  let ratio = 1;
  if (aspect === 'auto' && source?.width && source?.height) ratio = source.width / source.height;
  else if (/^\d+:\d+$/.test(aspect)) { const [w, h] = aspect.split(':').map(Number); ratio = w / h; }
  if (!Number.isFinite(ratio) || ratio < 1 / 3 || ratio > 3) ratio = 1;
  if (!['1K', '2K', '4K'].includes(size)) throw new Error('Invalid image size');
  const side = { '1K': 1024, '2K': 2048, '4K': 4096 }[size];
  let width = Math.round(side * Math.sqrt(ratio) / 32) * 32;
  let height = Math.round(side / Math.sqrt(ratio) / 32) * 32;
  const maxSide = size === '4K' ? 6144 : 3072;
  if (Math.max(width, height) > maxSide) { const scale = maxSide / Math.max(width, height); width = Math.floor(width * scale / 32) * 32; height = Math.floor(height * scale / 32) * 32; }
  return validateDimensions(width, height);
}
export function validateDimensions(width, height) {
  if (![width, height].every(v => Number.isInteger(v) && v >= 256 && v <= 6144 && v % 32 === 0) || width * height > 17_000_000) throw new Error('宽高须为 256–6144 间的 32 倍数，总像素不能超过 1700 万');
  return { width, height };
}
export function generationSettings({ steps = 40, seed = -1, cfg = 1, negativePrompt = '', count = 1, useKvCache = true, referenceResolution = 1024, sigmas = null, transparent = false } = {}) {
  if (!Number.isInteger(steps) || steps < 1 || steps > 100 || !Number.isInteger(seed) || seed < -1 || seed >= 2 ** 32) throw new Error('Invalid steps or seed');
  if (!Number.isFinite(cfg) || cfg < 1 || cfg > 10 || typeof negativePrompt !== 'string' || negativePrompt.length > 12000) throw new Error('Invalid CFG or negative prompt');
  if (!Number.isInteger(count) || count < 1 || count > 4 || typeof useKvCache !== 'boolean' || typeof transparent !== 'boolean' || ![512, 1024, 2048].includes(referenceResolution)) throw new Error('Invalid image count, cache or reference resolution');
  if (sigmas !== null && (!Array.isArray(sigmas) || sigmas.length !== steps || sigmas.some((v, i) => !Number.isFinite(v) || v <= 0 || v > 1 || (i > 0 && v >= sigmas[i - 1])))) throw new Error('自定义 Sigma 须与采样步数一致，并在 (0, 1] 内严格递减');
  return { steps, seed, cfg, negativePrompt, count, useKvCache, referenceResolution, sigmas, transparent };
}
export async function generateLocalImage({ prompt, image, images, aspectRatio = 'auto', imageSize = '2K', width, height, onProgress, ...parameters }) {
  if (generationBusy) throw new Error('本机图像模型正在处理另一张图片，请稍后再试');
  generationBusy = true;
  let timer;
  try {
    const opts = generationSettings(parameters);
    const status = await localImageStatus();
    if (status.state !== 'ready') throw new Error(status.error || '请在「本机部署」启动 Qwen Image 2.1，等待模型就绪');
    const references = images ?? (image ? [image] : []);
    if (!Array.isArray(references) || references.length > 10 || references.some(v => !Buffer.isBuffer(v)) || references.reduce((n, v) => n + v.length, 0) > 100_000_000) throw new Error('Invalid reference images or internal reference size budget exceeded');
    const source = references.length ? await (await import('sharp')).default(references.at(-1)).metadata() : undefined;
    const dimensions = imageDimensions(aspectRatio, imageSize, source, { width, height });
    timer = setInterval(() => { localImageStatus().then(s => onProgress?.({ step: s.step || 0, steps: s.steps || opts.steps, batchIndex: s.batchIndex || 1, count: opts.count, phase: s.phase })).catch(() => {}); }, 2000);
    const timeout = 60 * 60_000 * opts.count * Math.ceil(opts.steps / 40) * (opts.cfg > 1 ? 2 : 1);
    const result = await request('/generate', { prompt, images: references.map(v => v.toString('base64')), ...dimensions, ...opts }, timeout);
    const outputs = result.images ?? (result.image ? [result] : []);
    if (outputs.length !== opts.count || outputs.some(v => typeof v.image !== 'string' || !v.image)) throw new Error('Local model returned incomplete images');
    return outputs.map(({ image: encoded, ...details }) => ({ bytes: Buffer.from(encoded, 'base64'), mime: 'image/png', ...details, ...opts, seed: details.seed, count: opts.count, referenceCount: references.length }));
  } finally { clearInterval(timer); generationBusy = false; }
}
