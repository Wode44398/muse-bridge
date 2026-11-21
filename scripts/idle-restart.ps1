# Idle restart for the maintainer host (admin.ps1 deployment). Replaces the ad-hoc
# %TEMP%\bridge-idle-restart\restart-<tag>.ps1 copies that sessions used to clone.
#
# Busy signal = <root>\live-runs.json (src/runtime/live-runs-file.mjs): every running turn of
# every agent (Claude, Codex, Antigravity, dimensio). The old copies only read inflight-runs.json,
# which tracks Claude turns only -- they restarted the server in the middle of agy / dimensio runs.
#
#   Schedule (returns at once; run it from inside a bridge session, then end the turn):
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\idle-restart.ps1 -Schedule -Tag 669
#   The task waits until nothing is running 3 checks in a row, runs admin.ps1 restart-server once,
#   logs to %TEMP%\bridge-idle-restart\log.txt and deletes its own task. It exits early when the
#   8787 server process changed since scheduling (someone else restarted) or another
#   BridgeRestart* task is already waiting (that one restarts onto the same code). 12h cap.
param(
  [string]$Tag = '',
  [switch]$Schedule,
  [int]$StartPid = 0,
  [string]$Root = 'C:\Users\you\claude-bridge'
)
$ErrorActionPreference = 'Continue'
if (-not $Tag) { $Tag = (Get-Date -Format 'MMddHHmm') }
$Tag = ($Tag -replace '[^A-Za-z0-9_-]', '')
$task = 'BridgeRestart' + $Tag
$dir = Join-Path $env:TEMP 'bridge-idle-restart'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir 'log.txt'
function L($m) { Add-Content -Path $log -Value ("{0:yyyy-MM-dd HH:mm:ss} [restart-{1}] {2}" -f (Get-Date), $Tag, $m) -Encoding utf8 }
function Owner() { $l = @(Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue); if ($l.Count) { [int]$l[0].OwningProcess } else { 0 } }
function Waiting() {
  @(Get-ScheduledTask -TaskName 'BridgeRestart*' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -ne $task -and $_.State -eq 'Running' })
}

if ($Schedule) {
  $other = Waiting
  if ($other.Count) {
    L ("not scheduled: {0} is already waiting and will restart onto the same code" -f $other[0].TaskName)
    Write-Output ("already waiting: {0}" -f $other[0].TaskName)
    exit 0
  }
  $pidNow = Owner
  $self = $MyInvocation.MyCommand.Path
  $tr = "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$self`" -Tag $Tag -StartPid $pidNow -Root `"$Root`""
  schtasks /create /tn $task /sc once /sd 2099/01/01 /st 23:59 /f /tr $tr | Out-Null
  schtasks /run /tn $task | Out-Null
  L ("scheduled; server pid={0}" -f $pidNow)
  Write-Output ("scheduled {0} (server pid {1}); log: {2}" -f $task, $pidNow, $log)
  exit 0
}

# Number of running turns, or -1 when unknown (treated as busy).
function Busy($serverPid) {
  $n = -1
  # Server older than live-runs.json (first restart onto this code): only the Claude ledger is available.
  if (-not (Test-Path (Join-Path $Root 'live-runs.json'))) { $n = 0 }
  else { try {
    $j = Get-Content (Join-Path $Root 'live-runs.json') -Raw -Encoding utf8 -ErrorAction Stop | ConvertFrom-Json
    $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$j.at
    # Fresh and written by the process that owns 8787 now; otherwise the numbers are stale.
    if ($age -ge 0 -and $age -lt 90000 -and [int]$j.pid -eq $serverPid) { $n = [int]$j.total }
  } catch {} }
  if ($n -lt 0) { return -1 }
  # Belt and braces: the Claude ledger too.
  try {
    $r = (Get-Content (Join-Path $Root 'inflight-runs.json') -Raw -Encoding utf8 -ErrorAction Stop).Trim()
    if ($r -ne '[]') { $c = ([regex]::Matches($r, '"sessionId"')).Count; if ($c -gt $n) { $n = $c } }
  } catch {}
  return $n
}

try {
  if (-not $StartPid) { $StartPid = Owner }
  L ("started; server pid={0}" -f $StartPid)
  Start-Sleep -Seconds 60
  $deadline = (Get-Date).AddHours(12)
  $idle = 0
  $lastBusy = -2
  while ((Get-Date) -lt $deadline) {
    if ((Waiting).Count) { $idle = 0; Start-Sleep -Seconds 15; continue }
    $o = Owner
    if ($o -eq 0) { $idle = 0; Start-Sleep -Seconds 20; continue }
    if ($o -ne $StartPid) { L ("server already restarted by someone else (pid {0} -> {1}), nothing to do" -f $StartPid, $o); break }
    $b = Busy $o
    if ($b -ne $lastBusy) { L ("busy={0}" -f $b); $lastBusy = $b }
    if ($b -eq 0) { $idle++ } else { $idle = 0 }
    if ($idle -ge 3) {
      L ("idle, restart-server (pid before={0})" -f $o)
      $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'admin.ps1') -Action restart-server 2>&1 | Out-String
      L ("admin exit={0} output={1}" -f $LASTEXITCODE, $out.Trim())
      $n = 0
      for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Seconds 3; $n = Owner; if ($n -ne 0 -and $n -ne $o) { break } }
      $code = 0
      try { $code = (Invoke-RestMethod -TimeoutSec 5 -Uri 'http://127.0.0.1:8787/api/app/version').code } catch {}
      L ("after restart: pid {0} -> {1}, code={2}" -f $o, $n, $code)
      if ($n -ne 0 -and $n -ne $o) { break }
      $idle = 0
    }
    Start-Sleep -Seconds 10
  }
  if ((Get-Date) -ge $deadline) { L 'gave up: never idle within 12h' }
} finally {
  L 'done'
  schtasks /delete /tn $task /f | Out-Null
}
