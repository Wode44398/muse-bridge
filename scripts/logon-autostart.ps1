# logon-autostart.ps1 -- bring up bridge server / tunnel / watchdog at logon.
#
# Replaces the three Startup-folder copies (ClaudeBridge-*.vbs). Windows runs
# Startup-folder items ~3 minutes after logon (2026-11-05: tunnel/watchdog came
# up 3.3/3.5 min after login after a GPU bugcheck reboot), and anyone who
# starts things by hand in that window gets duplicates. The BridgeAutostart
# scheduled task (logon trigger, no delay) runs this instead.
#
# Idempotent: only launches what is not already running, so a second logon
# (RDP + console) or a manual start racing it does not double anything.
# Launches go through the same task-*.vbs files admin.ps1 uses; the server
# goes through task-server.vbs (no /direct) -> schtasks /Run BridgeServer.
# Log stays pure English (ANSI Get-Content mangles non-ASCII).

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $PSScriptRoot 'logon-autostart.log'
function L($m) { Add-Content -Path $log -Encoding UTF8 -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }
function Launch($vbs) { Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $root $vbs) + '"') }

$procs = @(Get-CimInstance Win32_Process -Filter "name='node.exe' or name='cloudflared.exe'" -ErrorAction SilentlyContinue)
$server   = @(Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue).Count -gt 0
$tunnel   = @($procs | Where-Object { $_.CommandLine -match 'cloudflared-bridge\.yml' }).Count -gt 0
$watchdog = @($procs | Where-Object { $_.CommandLine -match 'tunnel-watchdog' }).Count -gt 0

$done = @()
if (-not $server)   { Launch 'task-server.vbs';   $done += 'server' }
if (-not $tunnel)   { Launch 'task-tunnel.vbs';   $done += 'tunnel' }
if (-not $watchdog) { Launch 'task-watchdog.vbs'; $done += 'watchdog' }
L ("logon: launched [{0}]; already running: server={1} tunnel={2} watchdog={3}" -f ($done -join ','), $server, $tunnel, $watchdog)
