"""Download the official Qwen Image 2.1 checkpoint from ModelScope, verifying hashes."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.parse
import urllib.request

# install.ps1 passes <model home>/model; without an argument fall back to BRIDGE_LOCAL_IMAGE_HOME/model, then
# <data root>/local-image/qwen-image-2.1/model (this file lives in <data root>/modules/vertex/local-image/).
_HOME = os.environ.get('BRIDGE_LOCAL_IMAGE_HOME') or Path(__file__).resolve().parents[3] / 'local-image' / 'qwen-image-2.1'
ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else Path(_HOME) / 'model')
REPO = 'Qwen/Qwen-Image-2.1'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open(f'https://modelscope.cn/api/v1/models/{REPO}/repo/files?Recursive=true', timeout=60) as response:
    manifest = json.load(response)
files = [f for f in manifest['Data']['Files'] if f['Type'] == 'blob' and not f['Path'].startswith('assets/')]
ROOT.mkdir(parents=True, exist_ok=True)
(ROOT.parent / 'model-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')

def digest(p):
    with p.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def download(entry):
    rel = entry['Path']
    target = ROOT / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and target.stat().st_size == entry['Size'] and digest(target) == entry['Sha256']:
        print('Verified existing:', rel, flush=True)
        return
    partial = target.with_name(target.name + '.part')
    url = f'https://modelscope.cn/models/{REPO}/resolve/master/' + urllib.parse.quote(rel)
    for attempt in range(3):
        subprocess.run(['curl.exe', '--noproxy', '*', '--fail', '--location', '--silent', '--show-error',
                        '--retry', '3', '--connect-timeout', '30', '--max-time', '7200',
                        '--continue-at', '-', '--output', str(partial), url], check=True)
        if partial.stat().st_size == entry['Size'] and digest(partial) == entry['Sha256']:
            partial.replace(target)
            print('Verified:', rel, entry['Size'], flush=True)
            return
        partial.unlink()
    raise RuntimeError('Hash/size mismatch: ' + rel)

print('Downloading', len(files), 'files,', round(sum(f['Size'] for f in files) / 1e9, 2), 'GB', flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(download, files))
print('Checkpoint verified.', flush=True)
(ROOT / '.verified.json').write_text(json.dumps({'repo': REPO, 'files': len(files)}), encoding='utf-8')
