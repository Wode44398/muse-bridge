# zombie-reaper.ps1 —— 会话遗留进程收尸器（计划任务 BridgeZombieReaper 每 30 分钟跑一次）
#
# 背景：AI 会话的一次性验收/探针脚本（无头 Edge、stdin 灌代码的 node）被中途打断时，
# Windows 没有「父死子随」，孤儿进程会永远挂着吃内存甚至空转吃满整核
# （2026-07-30 实例：19 个无头 Edge 占 29.8GB + 两个 node 探针各烧 12 小时 CPU；
#  2026-09-23 实例：profile 叫 %TEMP%\shot-*、audit-* 的 29 棵无头 Edge 树 + 204 个 profile 目录 13.4GB，
#  旧指纹只认 Temp\edge-* 这个目录名，挂了 6 个多小时没认出来）。
# 本脚本按【指纹 + 孤儿判定 + 最小年龄】收尸，绝不碰正常进程：
#   无头浏览器（taskkill /T /F 整树收）—— 不看目录名，以下同时满足才算：
#     msedge.exe / chrome.exe 的根进程（命令行无 --type=）、命令行含 --headless、
#     --user-data-dir 在 %TEMP% 下（名字不限）、孤儿、年龄达标；
#     另外还有活进程连着它调试端口（CDP 会话）的也不收。浏览器没有 8 小时兜底：
#     父进程活着就是有人在用（harness 共享浏览器、在跑的验收），多久都不碰。
#     Edge 怪癖：环境里带 __COMPAT_LAYER（Claude 会话的 Git Bash 就带）时，被 spawn 的
#     msedge.exe 约 1 秒内 exit 0，真浏览器是它带 --edge-skip-compat-layer-relaunch 重启出的
#     子进程，一出生就是孤儿 —— 脚本侧的 child.kill() / taskkill /T 都够不着，只能靠这里收。
#   node 探针（单进程收；孤儿，或指纹命中且 >8 小时无条件收）：
#     命令行以 --input-type=module - 结尾（stdin 内联脚本）
#     命令行含 Temp\claude\*scratchpad （会话草稿目录里的脚本）
#   孤儿判定：父进程已死，或父进程出生晚于子进程（PID 复用导致的假父亲）
#   最小年龄：默认 30 分钟（正在跑的验收不受影响）
# 另附带清理 %TEMP% 下残留的 Chromium profile 目录：名字不限，但必须真像 profile（含
# Local State 文件或 Default 子目录；或外壳目录里只装着这样一个 profile，如 harness-cdp-*\profile），
# 且没有活进程命令行引用它、单例锁 lockfile 没被持有、目录最后改动超过最小年龄。删之前先整体
# 改名挪进 %TEMP%\zombie-reaper-trash —— 目录里有文件被打开时 Windows 拒绝改名，活 profile 绝不会
# 被删一半。不像 profile 的临时目录一律不碰；WebView2 的 EBWebView、目录联接也不碰。
#
# 用法：零参数=正常收尸；-DryRun 只打印会收/会删什么，不动手、不写日志（真跑还多一道改名
# 占用探测，DryRun 列出的目录真跑时仍可能因被占用而跳过）；-MinAgeMinutes 覆盖最小年龄（自测用）。
param(
  [switch]$DryRun,
  [int]$MinAgeMinutes = 30
)
$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $PSScriptRoot 'zombie-reaper.log'
$now = Get-Date
$stamp = $now.ToString('yyyy-MM-dd HH:mm')
# %TEMP% 规范成全路径；拿不到或是盘根时，浏览器指纹和目录清理整体停用（宁可不收，不可乱收）
$tempRoot = $null
if ($env:TEMP) { $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') }
if ($tempRoot -and $tempRoot.Length -le 3) { $tempRoot = $null }
$script:tcp = $null

function Get-UserDataDir([string]$cl) {
  # 实测三种写法："--user-data-dir=C:\a b"（crashpad 子进程）、--user-data-dir="C:\a"（Edge 重启后）、
  # --user-data-dir=C:\a；重复出现时 Chromium 以最后一个为准
  $ms = [regex]::Matches($cl, '"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+)')
  if ($ms.Count -eq 0) { return $null }
  $g = $ms[$ms.Count - 1].Groups
  $v = @($g[1].Value, $g[2].Value, $g[3].Value | Where-Object { $_ })[0].Replace('/', '\')
  if (-not [IO.Path]::IsPathRooted($v)) { return $null }   # 相对路径不知道相对谁，不认
  try { return [IO.Path]::GetFullPath($v).TrimEnd('\') } catch { return $null }
}

function Test-UnderTemp([string]$path) {
  return [bool]($tempRoot -and $path -and $path.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase))
}

function Test-HeadlessTempBrowser($p) {
  if ($p.Name -ne 'msedge.exe' -and $p.Name -ne 'chrome.exe') { return $false }   # Electron 壳等别的 exe 一概不认
  $cl = $p.CommandLine
  if (-not $cl) { return $false }
  if ($cl -match '(^|[\s"])--type=') { return $false }                   # renderer/gpu/utility/crashpad 子进程
  if ($cl -notmatch '(^|[\s"])--headless(=|[\s"]|$)') { return $false }   # 维护者自己开的浏览器没有 --headless
  return (Test-UnderTemp (Get-UserDataDir $cl))                           # 默认 profile / TEMP 外的 profile 不认
}

function Test-NodeSignature($p) {
  $cl = $p.CommandLine
  if (-not $cl -or $p.Name -ne 'node.exe') { return $false }
  if ($cl -match '--input-type=module\s+-\s*$') { return $true }
  if ($cl -match 'Temp[/\\]claude[/\\].*scratchpad') { return $true }
  return $false
}

$all = @(Get-CimInstance Win32_Process)
$byPid = @{}
$kidsOf = @{}
foreach ($p in $all) {
  $byPid[[int]$p.ProcessId] = $p
  $pp = [int]$p.ParentProcessId
  if (-not $kidsOf.ContainsKey($pp)) { $kidsOf[$pp] = New-Object System.Collections.ArrayList }
  [void]$kidsOf[$pp].Add($p)
}

function Test-Orphan($p) {
  $parent = $byPid[[int]$p.ParentProcessId]
  return [bool]((-not $parent) -or ($parent.CreationDate -gt $p.CreationDate))   # 父死 / PID 复用假父亲
}

# 按创建时间核对过的子孙树（含根）。收尸就逐个结束这张清单里的进程——
# 【不能】用 taskkill /T：它只按 ParentProcessId 找子进程、不核对出生时间，PID 被复用时会把
# 「父 PID 恰好悬空成这个号」的不相干进程链整条带走（bridge 服务链的父 PID 就曾是悬空的，09-24）。
function Get-Tree($root) {
  $tree = New-Object System.Collections.ArrayList
  [void]$tree.Add($root)
  $seen = @{ ([int]$root.ProcessId) = $true }
  for ($i = 0; $i -lt $tree.Count; $i++) {
    $cur = $tree[$i]
    foreach ($c in $kidsOf[[int]$cur.ProcessId]) {
      # 出生早于「父亲」的是 PID 复用，不算这棵树的
      if ($seen.ContainsKey([int]$c.ProcessId) -or $c.CreationDate -lt $cur.CreationDate) { continue }
      $seen[[int]$c.ProcessId] = $true
      [void]$tree.Add($c)
    }
  }
  return ,$tree
}

function Test-CdpClient($root) {
  # 还有活进程连着它的调试端口 = 还有人在驱动。Edge 重启后父进程必死，靠这条认出「在跑的验收」
  if ($null -eq $script:tcp) { $script:tcp = @(Get-NetTCPConnection) }
  $mine = @($script:tcp | Where-Object { $_.OwningProcess -eq $root.ProcessId })
  $ports = @($mine | Where-Object { $_.State -eq 'Listen' } | ForEach-Object { $_.LocalPort })
  return [bool](@($mine | Where-Object { $_.State -eq 'Established' -and $ports -contains $_.LocalPort }).Count)
}

$kills = @()
foreach ($p in $all) {
  $isBrowser = Test-HeadlessTempBrowser $p
  if (-not $isBrowser -and -not (Test-NodeSignature $p)) { continue }
  if (-not $p.CreationDate) { continue }
  $age = $now - $p.CreationDate
  if ($age.TotalMinutes -lt $MinAgeMinutes) { continue }
  $orphan = Test-Orphan $p
  $cmd = $p.CommandLine.Substring(0, [math]::Min(120, $p.CommandLine.Length))
  if ($isBrowser) {
    if (-not $orphan -or (Test-CdpClient $p)) { continue }   # 有人在用，多久都不碰
    $treeList = Get-Tree $p
    $kills += [pscustomobject]@{ Tree = $true; Id = $p.ProcessId; Name = $p.Name; Procs = $treeList.Count; Members = @($treeList | ForEach-Object { [int]$_.ProcessId }); AgeH = [math]::Round($age.TotalHours, 1); Orphan = $true; Profile = (Get-UserDataDir $p.CommandLine); Cmd = $cmd }
  } elseif ($orphan -or $age.TotalHours -gt 8) {
    $kills += [pscustomobject]@{ Tree = $false; Id = $p.ProcessId; Name = $p.Name; AgeH = [math]::Round($age.TotalHours, 1); Orphan = $orphan; Cmd = $cmd }
  }
}

$lines = New-Object System.Collections.Generic.List[string]
foreach ($k in $kills) {
  if ($k.Tree) {
    $tag = if ($DryRun) { 'WOULD-KILL-TREE' } else { 'KILL-TREE' }
    if (-not $DryRun) {
      $failed = 0
      foreach ($id in $k.Members) { try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $failed++ } } }
      if ($failed) { $tag = "KILL-TREE-FAILED(left=$failed)" }
    }
    $lines.Add("[$stamp] $tag pid=$($k.Id) $($k.Name) procs=$($k.Procs) age=$($k.AgeH)h orphan=$($k.Orphan) profile=$($k.Profile) :: $($k.Cmd)")
  } else {
    $tag = if ($DryRun) { 'WOULD-KILL' } else { 'KILL' }
    $lines.Add("[$stamp] $tag pid=$($k.Id) $($k.Name) age=$($k.AgeH)h orphan=$($k.Orphan) :: $($k.Cmd)")
    if (-not $DryRun) { Stop-Process -Id $k.Id -Force }
  }
}

# ── 残留 profile 目录 ─────────────────────────────────────────────────────────
function Test-Skip([string]$path) {
  if ([IO.Path]::GetFileName($path) -eq 'EBWebView') { return $true }   # WebView2 数据，属于装机应用
  # 目录联接/符号链接一律不碰（PS 5.1 的 Remove-Item -Recurse 会钻进联接删目标）
  try { return [bool]([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) } catch { return $true }
}

function Test-ChromiumProfile([string]$dir) {
  return ([IO.File]::Exists((Join-Path $dir 'Local State')) -or [IO.Directory]::Exists((Join-Path $dir 'Default')))
}

function Test-Referenced([string]$dir) {
  $needle = $dir.ToLowerInvariant()
  if ($liveText.IndexOf($needle, [StringComparison]::Ordinal) -lt 0) { return $false }
  return [regex]::IsMatch($liveText, [regex]::Escape($needle) + '(?![^\\"''\s])')   # 防 shot-1 被 shot-12 冒认
}

function Test-LockHeld([string]$dir) {
  # Chromium 单例锁：浏览器活着时独占打开、关闭即删；打得开说明是崩溃遗留的空壳
  $lf = Join-Path $dir 'lockfile'
  if (-not [IO.File]::Exists($lf)) { return $false }
  try { [IO.File]::Open($lf, 'Open', 'Read', 'None').Dispose(); return $false } catch { return $true }
}

if ($tempRoot) {
  if (-not $DryRun -and $kills.Count) { Start-Sleep -Milliseconds 800 }   # 等刚收掉的进程松手
  $liveText = (@(Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }) -join "`n").ToLowerInvariant().Replace('/', '\')
  $trashRoot = Join-Path $tempRoot 'zombie-reaper-trash'
  # 上一轮没删干净的（挪进回收区时已确认没人在用）先补删；rd 不钻目录联接、能删只读文件
  if (-not $DryRun -and [IO.Directory]::Exists($trashRoot)) {
    foreach ($t in [IO.Directory]::GetDirectories($trashRoot)) { & "$env:SystemRoot\System32\cmd.exe" /c rd /s /q "$t" *> $null }
  }

  $cands = New-Object System.Collections.Generic.List[object]
  foreach ($d in [IO.Directory]::GetDirectories($tempRoot)) {
    if ($d -eq $trashRoot -or (Test-Skip $d)) { continue }
    if (Test-ChromiumProfile $d) { $cands.Add([pscustomobject]@{ Dir = $d; Guard = $d }); continue }
    # 外壳里只装着一个 profile（harness/bridge 的 mkdtemp()\profile 形态）：只删 profile，外壳不碰
    $only = $null; $more = $true
    try {
      $e = [IO.Directory]::EnumerateFileSystemEntries($d).GetEnumerator()
      if ($e.MoveNext()) { $only = $e.Current; $more = $e.MoveNext() }
      $e.Dispose()
    } catch { continue }
    if ($only -and -not $more -and [IO.Directory]::Exists($only) -and -not (Test-Skip $only) -and (Test-ChromiumProfile $only)) {
      $cands.Add([pscustomobject]@{ Dir = $only; Guard = $d })
    }
  }

  foreach ($c in $cands) {
    if (($now - [IO.Directory]::GetLastWriteTime($c.Dir)).TotalMinutes -lt $MinAgeMinutes) { continue }
    if (Test-Referenced $c.Guard) { continue }   # 有活进程命令行指着它（浏览器本身、驱动脚本）
    if (Test-LockHeld $c.Dir) { continue }       # 浏览器还活着
    if ($DryRun) { $lines.Add("[$stamp] WOULD-SWEEP $($c.Dir)"); continue }
    [void][IO.Directory]::CreateDirectory($trashRoot)
    $dst = Join-Path $trashRoot ([guid]::NewGuid().ToString('N').Substring(0, 8))
    try { [IO.Directory]::Move($c.Dir, $dst) } catch { continue }   # 改名被拒 = 里面有文件开着 = 活的
    & "$env:SystemRoot\System32\cmd.exe" /c rd /s /q "$dst" *> $null
    $lines.Add("[$stamp] SWEEP $($c.Dir)" + $(if ([IO.Directory]::Exists($dst)) { ' (partial, retry next run)' }))
  }
  if (-not $DryRun -and [IO.Directory]::Exists($trashRoot) -and [IO.Directory]::GetFileSystemEntries($trashRoot).Length -eq 0) {
    [IO.Directory]::Delete($trashRoot)
  }
}

if ($lines.Count) {
  if (-not $DryRun) {
    Add-Content -LiteralPath $log -Value $lines -Encoding UTF8
    # 日志限长：只留最后 2000 行（首轮大扫除一次就可能几百行 SWEEP）
    $tail = @(Get-Content -LiteralPath $log -Tail 2000 -Encoding UTF8)
    if ($tail.Count) { [System.IO.File]::WriteAllLines($log, [string[]]$tail) }
  }
  $lines | ForEach-Object { $_ }
} else {
  Write-Output "clean ($($now.ToString('HH:mm')))"
}
