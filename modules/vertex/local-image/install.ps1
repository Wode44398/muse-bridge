param([string]$ModelHome = '')
$ErrorActionPreference = 'Stop'
# Default model home matches server/local-image.mjs: BRIDGE_LOCAL_IMAGE_HOME, else <data root>\local-image\qwen-image-2.1
# (this script lives in <data root>\modules\vertex\local-image; a source checkout's data root is the repository root).
if (-not $ModelHome) { $ModelHome = $env:BRIDGE_LOCAL_IMAGE_HOME }
if (-not $ModelHome) { $ModelHome = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path 'local-image\qwen-image-2.1' }
Write-Host "Model home: $ModelHome (about 33 GB; use -ModelHome to put it on a data disk, and give Bridge the same BRIDGE_LOCAL_IMAGE_HOME)"
New-Item -ItemType Directory -Force -Path $ModelHome | Out-Null
$py = Join-Path $ModelHome 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $py)) {
    python -m venv (Join-Path $ModelHome 'venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create Python environment' }
}
& $py -m pip install 'torch==2.14.1' 'torchvision==0.29.1' --index-url https://download.pytorch.org/whl/cu130
if ($LASTEXITCODE -ne 0) { throw 'CUDA PyTorch installation failed' }
& $py -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Inference dependencies installation failed' }
& $py (Join-Path $PSScriptRoot 'download-model.py') (Join-Path $ModelHome 'model')
if ($LASTEXITCODE -ne 0) { throw 'Checkpoint download or verification failed' }
Write-Host 'Installed. Open Vertex > Images > Qwen Image 2.1 > Local deployment to start.'
