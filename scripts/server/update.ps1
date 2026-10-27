<#
The Bridge 服务端更新（Windows 版，配合 install-windows.ps1 装的计划任务形态）：拉最新代码 → 按需装依赖 → 重建前端 → 重启服务端。
对照 scripts/server/update.sh（Linux + systemd）。

  powershell -ExecutionPolicy Bypass -File scripts\server\update.ps1              更新完立即重启（在跑的对话会被打断，记录保留）
  powershell -ExecutionPolicy Bypass -File scripts\server\update.ps1 -NoRestart   只更新不重启：再到控制台「服务控制」点「空闲时重启」，
                                                                                  等所有人的对话跑完再换新代码（控制台「检查并更新」就是这样调的）
参数
  -Force      代码没变也重装全部依赖、重建前端、重启（修复安装）
  -DataRoot   数据根（默认：服务端里跑时用它的 BRIDGE_DATA_ROOT → 计划任务里的 --data-root → 环境变量 → 程序根）
  -TaskName   计划任务名（默认 BridgeServer）：用来找数据根；服务没在跑时用它启动
  -Node       node.exe 路径（默认 PATH 上的 node）

和 update.sh 不一样的地方（都是 Windows 的文件锁逼出来的）：
  · 跑着的服务端锁着程序根与 harness 的 node_modules（.node 原生模块、SDK 自带的 claude.exe），在线 npm ci 会删到一半
    报 EPERM、把依赖弄残。所以这两处的依赖：服务停着就当场装；服务在跑就写 <数据根>\bridge-service.deps，交给守护启动器
    在下一次拉起服务端之前装（两条命之间的空档只有启动器站得到）。web、harness/web 只是构建期依赖，照常当场装。
  · 依赖只在 package.json / package-lock.json 有变化、或 node_modules 不在时才装（update.sh 每次都 npm ci）。
  · 代码没变、该装的都在，就直接收工（update.sh 不带 --no-restart 时仍会重装重启）；要那个效果加 -Force。
  · 重启：写 <数据根>\bridge-service.restart，启动器收掉服务端整棵进程树、立即重新拉起（等同 systemctl restart）。

最后一行 BRIDGE_UPDATE_RESULT=updated|unchanged <提交> 给控制台看（「服务控制 → 更新」据此决定要不要接着重启），与 update.sh 一致。
私有仓库：运行服务的账号要能 git pull 不用交互（凭据管理器里存好凭据，或用带令牌的 https 远端 / 部署密钥）。
#>
param(
  [switch]$NoRestart,
  [switch]$Force,
  [string]$DataRoot = '',
  [string]$TaskName = 'BridgeServer',
  [string]$Node = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'win\service-common.ps1')
Set-BridgeConsoleUtf8

function Say([string]$m) { Write-Host "==> $m" }
function Warn([string]$m) { Write-Host "[!] $m" }
function Invoke-Git {
  # 简单函数（不是高级函数）：--ff-only 这类参数原样进 $args，不会被当成本函数的参数名
  & git @args
  if ($LASTEXITCODE -ne 0) { throw ('git {0} 失败（退出码 {1}）' -f ($args -join ' '), $LASTEXITCODE) }
}
function Get-Head { return "$(Invoke-Git rev-parse HEAD)".Trim() }
function Get-HeadLine { return "$(Invoke-Git log -1 --format='%h %s')".Trim() }

try {
  $Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
  $Data = Resolve-BridgeDataRoot $DataRoot $TaskName $Root
  # 在服务端进程树里跑（控制台「检查并更新」拉起的，或在 bridge 的终端里手动跑的）：没人能回答交互提示
  $inService = ($env:BRIDGE_SUPERVISED -eq 'windows')
  if ($inService) { $env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never' }

  Set-Location -LiteralPath $Root
  if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) { throw "不是 git 部署（$Root 下找不到 .git）" }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw '找不到 git：先装 Git for Windows（winget install Git.Git）' }
  if (-not $Node) { $c = Get-Command node.exe -ErrorAction SilentlyContinue; if ($c) { $Node = $c.Source } }
  if (-not $Node) { $rec = Read-BridgeServicePid $Data; if ($rec -and $rec.node) { $Node = [string]$rec.node } }
  if (-not $Node -or -not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw '找不到 node.exe（用 -Node 指定）' }
  $npm = Get-BridgeNpm $Node

  $launcher = Get-BridgeLauncher $Data
  $svcUp = [bool]$launcher
  $port = Get-BridgePort $Data
  if ($svcUp) { Say "服务在跑：启动器 pid $($launcher.pid)，服务端 pid $($launcher.child)（数据根 $Data）" }
  else { Say "服务没在跑（数据根 $Data 上没有活着的启动器）" }

  # ── 拉代码：先 fetch 看清要变什么，再快进（等同 git pull --ff-only）────────────────
  $before = Get-Head
  Say "git fetch（$([Environment]::UserName)）"
  Invoke-Git fetch
  $upstream = "$(& git rev-parse '@{u}')".Trim()
  if ($LASTEXITCODE -ne 0 -or -not $upstream) { throw '当前分支没有上游，不知道从哪拉（git branch --set-upstream-to=origin/<分支>）' }
  $changed = @()
  if ($upstream -ne $before) {
    & git merge-base --is-ancestor $before $upstream
    if ($LASTEXITCODE -ne 0) { throw '本地有上游没有的提交（或已经分叉），不能快进——先在服务器上把分支理顺再更新' }
    $changed = @(Invoke-Git diff --name-only $before $upstream | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
  }

  # ── 要装哪些依赖、要不要构建 ─────────────────────────────────────────────────────
  # Runtime：服务端运行时加载（跑着时被锁）；其余两处只是构建期依赖
  $pkgs = @(
    @{ Dir = '.'; Prefix = ''; Runtime = $true },
    @{ Dir = 'harness'; Prefix = 'harness/'; Runtime = $true },
    @{ Dir = 'harness/web'; Prefix = 'harness/web/'; Runtime = $false },
    @{ Dir = 'web'; Prefix = 'web/'; Runtime = $false }
  ) | Where-Object { Test-Path -LiteralPath (Join-Path (Join-Path $Root $_.Dir) 'package.json') -PathType Leaf }
  foreach ($p in $pkgs) {
    $p.Need = $Force -or -not (Test-Path -LiteralPath (Join-Path (Join-Path $Root $p.Dir) 'node_modules') -PathType Container) -or
      ($changed -contains ($p.Prefix + 'package.json')) -or ($changed -contains ($p.Prefix + 'package-lock.json'))
  }
  $builds = @(@{ Dir = 'harness/web'; Out = 'harness\web\dist\index.html' }, @{ Dir = 'web'; Out = 'public\app\index.html' }) |
    Where-Object { Test-Path -LiteralPath (Join-Path (Join-Path $Root $_.Dir) 'package.json') -PathType Leaf }
  $needBuild = $Force -or ($upstream -ne $before) -or @($builds | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Root $_.Out) -PathType Leaf) }).Count -gt 0
  $needDeps = @($pkgs | Where-Object { $_.Need })

  if ($upstream -eq $before -and -not $needDeps.Count -and -not $needBuild) {
    Say "已经是最新（$(Get-HeadLine)）"
    [Console]::Out.WriteLine("BRIDGE_UPDATE_RESULT=unchanged $before")   # 最后一行给控制台看
    exit 0
  }

  # 服务没被启动器托管、端口上却有东西在跑（别的方式起的 / 手动 npm start）：它锁着 node_modules，装运行时依赖会把依赖弄残
  if (-not $svcUp -and @($needDeps | Where-Object { $_.Runtime }).Count -and (Test-BridgePortListening $port)) {
    throw ("端口 $port 上有服务在跑，但这个数据根上没有 bridge-service 启动器（别的方式起的？手动 npm start？）。" +
      'Windows 上服务端开着时 node_modules 被占用，装依赖会删到一半失败——先停掉它再更新；如果它就是计划任务托管的，用 -DataRoot 指明数据根')
  }

  if ($upstream -ne $before) {
    Say "git merge --ff-only（$($before.Substring(0, 8)) → $($upstream.Substring(0, 8))，$($changed.Count) 个文件）"
    Invoke-Git merge --ff-only $upstream
  }
  $after = Get-Head

  # ── 依赖 ────────────────────────────────────────────────────────────────────────
  $deferred = @()
  foreach ($p in $needDeps) {
    if ($p.Runtime -and $svcUp) { $deferred += $p.Dir; continue }
    $npmArgs = @()
    if ($p.Dir -ne '.') { $npmArgs += @('--prefix', $p.Dir) }
    $npmArgs += 'ci'
    if ($p.Runtime) { $npmArgs += '--omit=dev' }
    $npmArgs += @('--no-audit', '--no-fund')
    Say "npm $($npmArgs -join ' ')"
    Invoke-BridgeNpm $npm $npmArgs
  }
  if ($deferred.Count) {
    $depsFile = Join-Path $Data 'bridge-service.deps'
    $prev = @()
    try { $prev = @((Get-Content -LiteralPath $depsFile -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json).dirs) } catch { }
    $dirs = @(@($prev) + $deferred | Where-Object { $_ } | Select-Object -Unique)
    Write-BridgeTextNoBom $depsFile (ConvertTo-Json -InputObject @{ dirs = $dirs; head = $after; at = (Get-Date).ToString('o') } -Compress)
    Say ("{0} 的依赖有变化：服务端开着时 node_modules 被占用，交给启动器在下次拉起服务端之前装（{1}）" -f ($deferred -join '、'), $depsFile)
  }

  # ── 前端 ────────────────────────────────────────────────────────────────────────
  if ($needBuild) {
    foreach ($b in $builds) {
      Say "npm --prefix $($b.Dir) run build"
      Invoke-BridgeNpm $npm @('--prefix', $b.Dir, 'run', 'build')
    }
  }

  $result = 'unchanged'
  if ($after -ne $before -or $Force) { $result = 'updated' }
  Say "现在是 $(Get-HeadLine)"

  # ── 重启 ────────────────────────────────────────────────────────────────────────
  $depsNote = ''
  if ($deferred.Count) { $depsNote = '（根目录 / harness 的依赖会在重启时由启动器装好）' }
  if ($NoRestart) {
    if ($svcUp) { Say "没有重启：到控制台「服务控制」点「空闲时重启」，或 New-Item -ItemType File -Force '$(Join-Path $Data 'bridge-service.restart')'$depsNote" }
    else { Say "服务没在跑：Start-ScheduledTask -TaskName $TaskName 启动" }
  } elseif ($result -eq 'unchanged' -and -not $deferred.Count) {
    Say '代码没变（只补了缺的依赖 / 构建），不用重启'
  } elseif ($svcUp) {
    $oldChild = $launcher.child
    Write-BridgeTextNoBom (Join-Path $Data 'bridge-service.restart') ''
    if ($inService) {
      Say "已请求重启$depsNote：本脚本跑在服务端进程树里，会跟着被收掉；新进程起来后看 $(Join-Path $Data 'server.out.log')"
    } else {
      Say "已请求重启$depsNote，等启动器换上新进程…"
      $limit = 120
      if ($deferred.Count) { $limit = 1800 }
      $deadline = (Get-Date).AddSeconds($limit)
      $ok = $false
      $rec = $null
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 1
        $rec = Read-BridgeServicePid $Data
        if ($rec -and $rec.child -and $rec.child -ne $oldChild -and $rec.state -eq 'running' -and (Test-BridgeHealth $port)) { $ok = $true; break }
      }
      if ($ok) { Say "已重启：服务端 pid $($rec.child)，http://127.0.0.1:$port/healthz 正常" }
      else { Warn "$limit 秒内没等到新进程健康，看日志：$(Join-Path $Data 'server.out.log')" }
    }
  } else {
    $t = Get-BridgeTask $TaskName
    if ($t) {
      Start-ScheduledTask -TaskPath '\' -TaskName $TaskName
      Say "服务没在跑：已启动计划任务 $TaskName"
    } else {
      Warn "服务没在跑，也没有计划任务 $TaskName：用 scripts\server\install-windows.ps1 装成计划任务（或自己 node src\server.mjs）"
    }
  }
  [Console]::Out.WriteLine("BRIDGE_UPDATE_RESULT=$result $after")   # 最后一行给控制台看
  exit 0
} catch {
  Write-Host "[x] 更新失败：$($_.Exception.Message)"
  exit 1
}
