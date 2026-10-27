# watchdog-keeper.ps1 -- relaunch tunnel-watchdog if its process is gone.
#
# The tunnel-watchdog self-heals the server and the tunnel, but nothing
# guarded the watchdog itself: its only launch points were logon autostart
# and manual admin.ps1. On 2026-08-09 ~23:49 the watchdog was terminated
# together with the server (external kill; no crash log, no self-exit path)
# and the bridge stayed down for hours. This keeper closes that gap.
#
# Runs every 30 min via the BridgeWatchdogKeeper scheduled task
# (wscript watchdog-keeper-hidden.vbs -> this file, windowless).
# Silent no-op when the watchdog is alive; logs only on relaunch.
# Log stays pure English (ANSI Get-Content mangles non-ASCII).

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $PSScriptRoot 'watchdog-keeper.log'

$alive = Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'tunnel-watchdog' } | Select-Object -First 1
if ($alive) { exit 0 }

Add-Content -Path $log -Encoding UTF8 -Value ("[{0}] watchdog gone -> relaunch via task-watchdog.vbs" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $root 'task-watchdog.vbs') + '"')
