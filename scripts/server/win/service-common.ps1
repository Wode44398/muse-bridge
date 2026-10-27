# The Bridge 服务端 Windows 托管的公共函数：install-windows.ps1 与 update.ps1 点源引用（. "$PSScriptRoot\win\service-common.ps1"）。
# 只有查询与小工具，不注册、不改任何系统设置。PowerShell 5.1 兼容（不用 ?? / ?: / && / -AsHashtable）。
# 本文件与调用它的脚本都存成带 BOM 的 UTF-8：PowerShell 5.1 读不带 BOM 的文件按系统 ANSI 代码页解码，中文会乱、甚至语法错。

function Set-BridgeConsoleUtf8 {
  # 输出按 UTF-8 编码：被服务端以管道拉起时（控制台「服务控制 → 更新」）中文日志才不乱码。没有控制台时设不上，无所谓。
  $utf8 = New-Object System.Text.UTF8Encoding $false
  try { [Console]::OutputEncoding = $utf8 } catch { }
  $global:OutputEncoding = $utf8
}

function ConvertTo-BridgeFullPath([string]$Path) {
  # 按 PowerShell 的当前位置解析相对路径（[IO.Path]::GetFullPath 用的是进程当前目录，两者可能不同）；路径不存在也行
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function ConvertTo-BridgeQuotedArg([string]$Value) {
  # 按 Windows 命令行规则加引号：结尾的反斜杠要成对，否则会把收尾的引号转义掉（D:\ → "D:\\"）
  return '"' + ($Value -replace '(\\+)$', '$1$1') + '"'
}

function Get-BridgeTask([string]$TaskName) {
  try { return Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction Stop } catch { return $null }
}

function Test-BridgeTaskIsOurs($Task) {
  # 动作是本启动器（scripts\server\win\bridge-service.mjs）才算我们的；旧主机形态的同名任务跑的是 wscript task-server.vbs
  foreach ($a in @($Task.Actions)) { if ([string]$a.Arguments -match 'bridge-service\.mjs') { return $true } }
  return $false
}

function Get-BridgeTaskDataRoot([string]$TaskName) {
  # 计划任务动作里的 --data-root（install-windows.ps1 写进去的）；没有任务、没给数据根、或读不到任务 → $null
  $t = Get-BridgeTask $TaskName
  if (-not $t) { return $null }
  foreach ($a in @($t.Actions)) {
    $line = [string]$a.Arguments
    if ($line -notmatch 'bridge-service\.mjs') { continue }
    if ($line -match '--data-root(?:=|\s+)"([^"]+)"') { return ($Matches[1] -replace '\\\\$', '\') }   # 引号前成对的反斜杠还原成一个
    if ($line -match '--data-root(?:=|\s+)(\S+)') { return $Matches[1] }
  }
  return $null
}

function Resolve-BridgeDataRoot([string]$Explicit, [string]$TaskName, [string]$ProgramRoot) {
  # 数据根，与启动器自己的取法（--data-root > 环境变量 BRIDGE_DATA_ROOT > 程序根）对齐：
  #   显式参数 > 在服务端进程树里（BRIDGE_SUPERVISED=windows）就信环境变量（启动器亲手设的）> 计划任务里的 --data-root
  #   > 环境变量 BRIDGE_DATA_ROOT > 程序根
  if ($Explicit) { return ConvertTo-BridgeFullPath $Explicit }
  if ($env:BRIDGE_SUPERVISED -eq 'windows' -and $env:BRIDGE_DATA_ROOT) { return ConvertTo-BridgeFullPath $env:BRIDGE_DATA_ROOT }
  $fromTask = Get-BridgeTaskDataRoot $TaskName
  if ($fromTask) { return ConvertTo-BridgeFullPath $fromTask }
  if ($env:BRIDGE_DATA_ROOT) { return ConvertTo-BridgeFullPath $env:BRIDGE_DATA_ROOT }
  return $ProgramRoot
}

function Read-BridgeServicePid([string]$DataRoot) {
  # 启动器写的 <数据根>\bridge-service.pid（JSON）；启动器正在改写时可能读到半截，重试两次
  $f = Join-Path $DataRoot 'bridge-service.pid'
  for ($i = 0; $i -lt 3; $i++) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $f -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json) } catch { Start-Sleep -Milliseconds 200 }
  }
  return $null
}

function Get-BridgeLauncher([string]$DataRoot) {
  # 数据根上的启动器还活着就返回 pid 文件内容，否则 $null。与 bridge-service.mjs 的 launcherAlive 同一套核对，防 PID 复用
  # （重启后旧 pid 文件里的号可能已归别人）：创建时间差一分钟以内、是 node、命令行（查得到的话）里有 bridge-service。
  $rec = Read-BridgeServicePid $DataRoot
  if (-not $rec -or -not $rec.pid -or -not $rec.startedAt) { return $null }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$rec.pid)" -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  if ($p.CreationDate -and [Math]::Abs(([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() - [double]$rec.startedAt) -gt 60000) { return $null }
  if ($p.Name -notmatch '^node(\.exe)?$') { return $null }
  if ($p.CommandLine -and $p.CommandLine -notmatch 'bridge-service') { return $null }
  return $rec
}

function Get-BridgePort([string]$DataRoot) {
  # 与服务端同一个取法：环境变量 PORT > 数据根 config.json 的 port > 8787
  if ($env:PORT -match '^\d+$') { return [int]$env:PORT }
  try {
    $c = Get-Content -LiteralPath (Join-Path $DataRoot 'config.json') -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
    if ($c.port) { return [int]$c.port }
  } catch { }
  return 8787
}

function Test-BridgePortListening([int]$Port) {
  # 只读查监听表，不往端口上连
  try { return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1) } catch { return $false }
}

function Test-BridgeHealth([int]$Port, [int]$TimeoutMs = 3000) {
  # GET /healthz；显式不走代理（系统代理会把 127.0.0.1 也转出去）
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/healthz")
    $req.Proxy = $null
    $req.Timeout = $TimeoutMs
    $resp = $req.GetResponse()
    try { return ([int]$resp.StatusCode -eq 200) } finally { $resp.Close() }
  } catch { return $false }
}

function Write-BridgeTextNoBom([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}

function Get-BridgeNpm([string]$Node) {
  # 与这个 node.exe 同目录的 npm-cli.js（绕开 npm.cmd / npm.ps1 外壳，也保证和服务端用同一个 Node）；没有再找 PATH 上的 npm.cmd
  $cli = Join-Path (Split-Path -Parent $Node) 'node_modules\npm\bin\npm-cli.js'
  if (Test-Path -LiteralPath $cli -PathType Leaf) { return @($Node, $cli) }
  $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($cmd) { return @($cmd.Source) }
  throw '找不到 npm：装 Node.js 时把 npm 一起装上'
}

function Invoke-BridgeNpm([string[]]$Npm, [string[]]$Arguments) {
  $exe = $Npm[0]
  $pre = @()
  if ($Npm.Count -gt 1) { $pre = @($Npm[1..($Npm.Count - 1)]) }
  & $exe @pre @Arguments
  if ($LASTEXITCODE -ne 0) { throw ('npm {0} 失败（退出码 {1}）' -f ($Arguments -join ' '), $LASTEXITCODE) }
}
