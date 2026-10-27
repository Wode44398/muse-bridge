# M8（K27 / N36）：dimensio（harness）的两段式退役。test-admin.ps1（测试服）与 admin.ps1（正式服）共用这一份。
#
# 以前停服直接 Stop-Process -Force（Windows 上就是 TerminateProcess）：在跑的会话被腰斩、转录里没有任何说明、
# 最后几秒没落盘。脚本手里没有 harness 令牌，走 sessions 目录下的请求文件（agent 写不进那个目录）：
# prepare（冻结新会话）→ 等在跑的跑完（最多 WaitMinutes 分钟）→ commit（强制排空）→ 等 harness 自己退出。
# 旧版 harness 不认请求文件：几秒内没回状态就不再等，交还调用方照旧强杀。协议另一半见 harness/server/retire.ts。
#
# 本文件必须存成 UTF-8 带 BOM：powershell.exe 5.1 遇到无 BOM 的文件按 GBK 解析，中文注释会吞掉下一行代码。
# 只往 stderr 说话：admin.ps1 的 stdout 是给 bridge 服务控制台解析的 JSON。

function Write-RetireRequest([string]$Dir, [hashtable]$Body) {
  $Body.requestedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  # WriteAllText 默认 UTF-8 无 BOM（harness 也能读带 BOM 的，但别给它添麻烦）
  [IO.File]::WriteAllText((Join-Path $Dir 'retire.request.json'), ($Body | ConvertTo-Json -Compress))
}

function Read-RetireStatus([string]$Dir) {
  try { Get-Content -Raw -Encoding UTF8 (Join-Path $Dir 'retire.status.json') | ConvertFrom-Json } catch { $null }
}

function Test-RetirePort([int]$Port) {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

# 返回 'idle'（harness 没在跑）| 'legacy'（旧版，不认请求文件）| 'drained'（排空后自己退了）| 'stuck'（25 秒内没退）。
# 除 'drained' 外，调用方照旧强杀。
function Invoke-HarnessRetire([string]$SessionsDir, [int]$Port, [int]$WaitMinutes = 10) {
  if (-not (Test-RetirePort $Port)) { return 'idle' }
  # 目录是 harness 第一次存会话时才建的：从没存过会话的 harness 照样要走排空，目录由这里补上。
  New-Item -ItemType Directory -Force -Path $SessionsDir | Out-Null
  $asked = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Write-RetireRequest $SessionsDir @{ action = 'prepare'; ttlMs = [int64](([Math]::Max(0, $WaitMinutes) + 5) * 60000) }
  $started = Get-Date
  $deadline = $started.AddMinutes([Math]::Max(0, $WaitMinutes))
  $announced = $false
  $supported = $false
  do {
    Start-Sleep -Milliseconds 1000
    $st = Read-RetireStatus $SessionsDir
    if (-not $st -or $st.updatedAt -lt $asked) {
      if (((Get-Date) - $started).TotalSeconds -gt 6) { break }  # 旧版 harness：不等了
      continue
    }
    $supported = $true
    $n = @($st.runs).Count
    if ($n -eq 0) { break }
    if (-not $announced) {
      [Console]::Error.WriteLine("dimensio 还有 $n 个会话在跑，已冻结新会话，等它们跑完（最多 $WaitMinutes 分钟）…")
      $announced = $true
    }
  } while ((Get-Date) -lt $deadline)
  if (-not $supported) {
    Remove-Item -LiteralPath (Join-Path $SessionsDir 'retire.request.json') -Force -ErrorAction SilentlyContinue
    return 'legacy'
  }
  Write-RetireRequest $SessionsDir @{ action = 'commit'; force = $true }
  $until = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $until -and (Test-RetirePort $Port)) {
    Start-Sleep -Milliseconds 300
  }
  if (Test-RetirePort $Port) {
    [Console]::Error.WriteLine('dimensio 25 秒内没有自己退出，改为强杀')
    return 'stuck'
  }
  [Console]::Error.WriteLine('dimensio 已排空并自行退出')
  return 'drained'
}
