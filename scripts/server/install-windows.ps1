<#
The Bridge 服务端装成 Windows 计划任务：开机就跑、不用登录、崩了自动拉起——对标 Linux 的 scripts/server/install.sh + systemd。
Windows VPS 或自己的电脑都行。完整步骤（装 Node / Git、首次生成令牌、隧道、更新、卸载、常见问题）见 docs/deploy-windows.md。

  # 管理员 PowerShell（开机触发器只有管理员能建），在程序目录里：
  powershell -ExecutionPolicy Bypass -File scripts\server\install-windows.ps1 -DataRoot D:\bridge-data
  powershell -ExecutionPolicy Bypass -File scripts\server\install-windows.ps1 -WhatIf       # 只看要做什么，什么都不改
  powershell -ExecutionPolicy Bypass -File scripts\server\install-windows.ps1 -Uninstall

做的事（可以重复执行：数据、令牌、账号一概不动）：
  1. 检查 Node（≥ 22.6）、程序目录、依赖与前端是否就绪；数据根不存在就建
  2. 让你输入运行账号（默认当前账号）的密码，注册计划任务（默认名 BridgeServer）：
       动作     <node.exe> "<程序根>\scripts\server\win\bridge-service.mjs" [--data-root "<数据根>"]，工作目录 = 程序根
       账号     登录类型 Password（「不管用户是否登录都运行」），RunLevel Limited
       触发器   开机（延迟 30 秒，让网络先起来）；加 -AtLogon 再加一个「登录时」
       设置     电池供电也启动、不因电池停止、执行时限无限、失败后每 1 分钟重试最多 999 次、
                已在运行则忽略新实例、错过了尽快补跑、优先级正常（任务默认的 7 是低于正常）
  3. 立即启动并等 /healthz（-NoStart 跳过）

参数
  -TaskName    计划任务名（默认 BridgeServer）
  -DataRoot    数据根（config.json、账号、会话、日志都在这；默认 = 程序根）。计划任务的动作带不了环境变量，所以以
               --data-root 参数交给启动器，由它设成服务端的 BRIDGE_DATA_ROOT——不另包一层 .cmd（少一个进程、少一层引号转义）
  -Node        node.exe 路径（默认 PATH 上的 node）
  -Port        只用于结尾提示的地址（默认：数据根 config.json 的 port，没有就 8787）
  -AtLogon     另加「登录时」触发器（开机触发器之外多一次拉起的机会）
  -Credential  运行账号的凭据（脚本化部署用；不给就弹窗让你输）
  -NoStart     装完不启动
  -Force       已有同名任务时不再确认、直接覆盖；-Uninstall 时连不是本启动器的同名任务也删
  -WhatIf      只做只读检查、打印将要做的事：不注册、不建目录、不要密码
  -Uninstall   先写 stop 文件让启动器收掉服务端进程树、优雅退出，再删计划任务；数据不动

为什么登录类型用 Password、要你输一次密码：
  · 默认的 Interactive 只在你登录之后才跑——VPS 重启后没人登录，服务就起不来。
  · S4U（「不存储密码」）不用密码，但它的登录会话里没有由密码派生的 DPAPI 主密钥：bridge 的扩展中心凭据、
    自定义 API 的密钥都用 DPAPI（当前用户）加密，在 S4U 下解不开；也访问不了网络共享。
  · LocalSystem（SYSTEM 账号）的家目录是 C:\Windows\System32\config\systemprofile：~/.claude 等全落到那里，
    你已有的 Claude 登录态、会话、配置一概看不到；agent 以 SYSTEM 身份跑也等于把整台机器交出去。
  密码只交给任务计划程序（Windows 自己加密保存），本脚本不落盘、不打印。改了账号密码要重跑本脚本（加 -Force）。
#>
param(
  [string]$TaskName = 'BridgeServer',
  [string]$DataRoot = '',
  [string]$Node = '',
  [int]$Port = 0,
  [switch]$AtLogon,
  [System.Management.Automation.PSCredential]$Credential = $null,
  [switch]$NoStart,
  [switch]$Force,
  [switch]$WhatIf,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'win\service-common.ps1')
Set-BridgeConsoleUtf8

$Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$Launcher = Join-Path $Root 'scripts\server\win\bridge-service.mjs'
$Me = [Security.Principal.WindowsIdentity]::GetCurrent().Name

function Say([string]$m) { Write-Host ''; Write-Host "==> $m" -ForegroundColor Cyan }
function Note([string]$m) { Write-Host "    $m" }
function Warn([string]$m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Die([string]$m) { Write-Host "[x] $m" -ForegroundColor Red; exit 1 }
function Plan([string]$m) { Write-Host "    [WhatIf] $m" -ForegroundColor DarkGray }

function Show-TaskInfo($t) {
  foreach ($a in @($t.Actions)) { Note ('动作：{0} {1}' -f $a.Execute, $a.Arguments) }
  Note ('账号：{0}（登录类型 {1}）  状态：{2}' -f $t.Principal.UserId, $t.Principal.LogonType, $t.State)
}

function Get-TaskLauncherDataRoot($t) {
  # 一个「我们的」任务实际用的数据根：--data-root，没给就是它那份程序根（启动器的上上上级目录）
  $d = Get-BridgeTaskDataRoot $TaskName
  if ($d) { return (ConvertTo-BridgeFullPath $d) }
  foreach ($a in @($t.Actions)) {
    if ([string]$a.Arguments -match '"([^"]*bridge-service\.mjs)"') { return (Split-Path (Split-Path (Split-Path (Split-Path $Matches[1])))) }
  }
  return $Root
}

function Stop-Launcher([string]$Data, $Rec) {
  # 写 stop 文件：启动器每 2 秒看一次，收掉服务端整棵进程树、删掉 stop 与 pid 文件后自己退出
  $stop = Join-Path $Data 'bridge-service.stop'
  if ($WhatIf) { Plan "写 $stop，等启动器（pid $($Rec.pid)）收掉服务端进程树后退出"; return $true }
  Write-BridgeTextNoBom $stop ''
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-BridgeLauncher $Data)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  Warn '60 秒内启动器没退干净'
  return $false
}

if (-not (Test-Path -LiteralPath (Join-Path $Root 'src\server.mjs') -PathType Leaf)) { Die "找不到 $Root\src\server.mjs——请在仓库里运行本脚本" }
if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) { Die "找不到启动器 $Launcher" }
if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) { Die '只能在 Windows 上用；Linux 用 scripts/server/install.sh' }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($WhatIf) { Write-Host '（-WhatIf 演练：只做只读检查、打印将要做的事；不注册任务、不建目录、不要密码）' -ForegroundColor DarkGray }
$existing = Get-BridgeTask $TaskName

# ── 卸载 ───────────────────────────────────────────────────────────────────────
if ($Uninstall) {
  Say "卸载计划任务 $TaskName"
  if (-not $existing) { Note "没有名为 $TaskName 的计划任务，什么都不用做"; exit 0 }
  Show-TaskInfo $existing
  $ours = Test-BridgeTaskIsOurs $existing
  if (-not $ours -and -not $Force) { Die '这个任务的动作不是 bridge-service.mjs，不是本启动器建的——不动它。确定要删加 -Force' }
  if (-not $isAdmin) {
    if ($WhatIf) { Warn '当前不是管理员：真卸载时要用管理员身份运行 PowerShell' } else { Die '请用管理员身份运行 PowerShell 再卸载' }
  }
  $data = $Root
  if ($DataRoot) { $data = ConvertTo-BridgeFullPath $DataRoot } elseif ($ours) { $data = Get-TaskLauncherDataRoot $existing }
  if ($ours) {
    $rec = Get-BridgeLauncher $data
    if ($rec) { Say "让启动器优雅退出（数据根 $data）"; $null = Stop-Launcher $data $rec }
    else { Note "数据根 $data 上没有在跑的启动器" }
  }
  if ($WhatIf) { Plan "Stop-ScheduledTask（还在跑的话）、Unregister-ScheduledTask -TaskName $TaskName"; exit 0 }
  $now = Get-BridgeTask $TaskName
  if ($now -and $now.State -eq 'Running') { Stop-ScheduledTask -TaskPath '\' -TaskName $TaskName }
  Unregister-ScheduledTask -TaskPath '\' -TaskName $TaskName -Confirm:$false
  Remove-Item -LiteralPath (Join-Path $data 'bridge-service.stop') -Force -ErrorAction SilentlyContinue
  Say '已卸载'
  Note "数据（config.json、账号、会话、日志）都还在 $data，要彻底清掉自己删。"
  Note '控制台里开的公网访问随服务端一起停；隧道如果另用 cloudflared service install 装过，另行在管理员 PowerShell 里 cloudflared service uninstall。'
  exit 0
}

# ── 安装 ───────────────────────────────────────────────────────────────────────
Say '检查环境'
if (-not $isAdmin) {
  if ($WhatIf) { Warn '当前不是管理员：真装时要用管理员身份运行 PowerShell（开机触发器只有管理员能建）' }
  else { Die '请用管理员身份运行 PowerShell（开机触发器只有管理员能建）：开始菜单里右键 Windows PowerShell →「以管理员身份运行」' }
}

if (-not $Node) { $c = Get-Command node.exe -ErrorAction SilentlyContinue; if ($c) { $Node = $c.Source } }
if (-not $Node -or -not (Test-Path -LiteralPath $Node -PathType Leaf)) { Die '找不到 node.exe：先装 Node.js 24（winget install OpenJS.NodeJS.LTS），或用 -Node 指定路径' }
$Node = (Resolve-Path -LiteralPath $Node).Path
$nodeVer = "$(& $Node -p 'process.versions.node')".Trim()
if ($nodeVer -notmatch '^(\d+)\.(\d+)') { Die "读不出 Node 版本（$Node）" }
if ([int]$Matches[1] -lt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -lt 6)) { Die "Node 版本太旧（v$nodeVer）：要 ≥ 22.6，推荐 24" }
Note "Node     $Node（v$nodeVer）"
Note "程序根   $Root"

$dataExplicit = ''
if (-not $DataRoot -and $env:BRIDGE_DATA_ROOT) {
  # 环境变量里已经有数据根（启动器也会读到它）：照它装，并且写死进任务参数，别让两边各认各的
  $DataRoot = $env:BRIDGE_DATA_ROOT
  Note "沿用环境变量 BRIDGE_DATA_ROOT=$DataRoot 作为数据根"
}
if ($DataRoot) { $dataExplicit = (ConvertTo-BridgeFullPath $DataRoot) -replace '(?<=[^:\\])\\+$', '' }
$data = $Root
if ($dataExplicit) { $data = $dataExplicit }
if ($dataExplicit) { Note "数据根   $data" } else { Note "数据根   $data（= 程序根；VPS 上建议 -DataRoot 放到程序目录外，升级、备份都清爽）" }
$createData = -not (Test-Path -LiteralPath $data -PathType Container)

if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules') -PathType Container)) { Warn '程序根还没装依赖：先跑 npm ci --omit=dev 等（docs/deploy-windows.md「拿代码、装依赖、构建前端」）' }
if (-not (Test-Path -LiteralPath (Join-Path $Root 'public\app\index.html') -PathType Leaf)) { Warn '前端还没构建：npm --prefix web ci; npm --prefix web run build' }
$cfgPath = Join-Path $data 'config.json'
$hasConfig = Test-Path -LiteralPath $cfgPath -PathType Leaf
if (-not $hasConfig) {
  Warn '数据根里还没有 config.json：第一次启动会自动生成（含明文访问令牌）。多用户 VPS 建议先按文档用 gen-token --hash 生成、并写上 "features": { "multiUser": true }'
} else {
  $cfg = $null
  try { $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Warn 'config.json 不是合法 JSON：服务端会拒绝启动，先修好它' }
  if ($cfg) {
    $mu = if ($cfg.features -and $null -ne $cfg.features.multiUser) { [bool]$cfg.features.multiUser } elseif ($cfg.edition -eq 'server') { $true } else { $false }
    if ($mu) { Note '多用户   开（注册、邀请码、普通账号登录）' } else { Note '多用户   关：只有管理员与服务账号能登录；要开写 "features": { "multiUser": true }' }
  }
}
if ($Port -le 0) { $Port = Get-BridgePort $data }

# ── 同名任务 ───────────────────────────────────────────────────────────────────
$oldData = $null
if ($existing) {
  Say "已有同名计划任务 $TaskName"
  Show-TaskInfo $existing
  if (Test-BridgeTaskIsOurs $existing) { $oldData = Get-TaskLauncherDataRoot $existing }
  else { Warn '它不是本启动器建的任务。覆盖前先停掉原来那套启动方式（它的停止脚本、开机自启项、看门狗），覆盖之后也别再跑它的安装脚本，那会把任务改回去' }
  if ($WhatIf) { Plan '这里会要求你输入 y 确认覆盖（-Force 跳过）' }
  elseif (-not $Force) {
    $ans = Read-Host "覆盖计划任务 $TaskName？输入 y 确认"
    if ($ans -notmatch '^\s*(y|yes|是)\s*$') { Die '没有确认，已取消（-Force 跳过确认）' }
  }
}

# ── 运行账号与密码 ─────────────────────────────────────────────────────────────
$runAs = $Me
if ($Credential) { $runAs = $Credential.UserName }
Say "运行账号 $runAs"
Note '登录类型 Password（「不管用户是否登录都运行」）：开机就跑、不用登录。为什么不用 S4U / SYSTEM 见脚本开头注释'
if ($WhatIf) { Plan "弹出 Get-Credential，输入 $runAs 的 Windows 登录密码（微软账号登录的电脑填微软账号密码，不是 PIN）" }
elseif (-not $Credential) {
  $Credential = Get-Credential -UserName $runAs -Message 'The Bridge 服务端以这个账号在后台运行（开机即跑、不用登录）。请输入它的 Windows 登录密码——微软账号登录的电脑填微软账号密码，不是 PIN。密码只交给任务计划程序保存。'
  if (-not $Credential) { Die '没有输入密码，已取消' }
  $runAs = $Credential.UserName
}
if ($runAs -ne $Me) { Warn "运行账号 $runAs 不是当前账号：确认它能读写程序目录、写数据目录，node.exe 也不在别人的用户目录下" }

if ($createData) {
  if ($WhatIf) { Plan "新建数据根目录 $data，并给 $runAs 加「修改」权限" }
  else {
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    # 管理员身份新建的目录属主可能是 Administrators 组；给运行账号显式加「修改」，受限令牌下也写得进去
    & icacls.exe $data /grant "${runAs}:(OI)(CI)M" | Out-Null
    Note "已新建 $data"
  }
}

# ── 计划任务 ───────────────────────────────────────────────────────────────────
$argLine = ConvertTo-BridgeQuotedArg $Launcher
if ($dataExplicit) { $argLine += ' --data-root ' + (ConvertTo-BridgeQuotedArg $dataExplicit) }
$action = New-ScheduledTaskAction -Execute $Node -Argument $argLine -WorkingDirectory $Root
$boot = New-ScheduledTaskTrigger -AtStartup
$boot.Delay = 'PT30S'
$triggers = @($boot)
if ($AtLogon) { $triggers += New-ScheduledTaskTrigger -AtLogOn -User $runAs }
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -DontStopOnIdleEnd -Priority 5
$desc = 'The Bridge 服务端：scripts\server\win\bridge-service.mjs 守护 src\server.mjs（install-windows.ps1 注册，见 docs\deploy-windows.md）'

Say "计划任务 $TaskName"
Note "动作     $Node $argLine"
Note "工作目录 $Root"
Note "账号     $runAs（登录类型 Password，RunLevel Limited）"
if ($AtLogon) { Note "触发器   开机（延迟 30 秒）+ $runAs 登录时" } else { Note '触发器   开机（延迟 30 秒）' }
Note '设置     电池供电也启动、不因电池停止、执行时限无限、失败后每 1 分钟重试（最多 999 次）、已在运行则忽略新实例、错过了尽快补跑、优先级正常'
if ($WhatIf) { Plan "Register-ScheduledTask -TaskName $TaskName -User $runAs -Password <你输入的密码> -RunLevel Limited -Force" }
else {
  $pw = $Credential.GetNetworkCredential().Password
  try {
    Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger $triggers -Settings $settings `
      -User $runAs -Password $pw -RunLevel Limited -Description $desc -Force | Out-Null
  } catch {
    $msg = $_.Exception.Message
    Write-Host "[x] 注册计划任务失败：$msg" -ForegroundColor Red
    if ($msg -match '0x8007052E|password|密码') { Note '多半是密码不对：微软账号登录的电脑要填微软账号的密码（不是 PIN）' }
    if ($msg -match '0x80070569|logon type|登录类型') { Note '账号没有「作为批处理作业登录」的权限：secpol.msc → 本地策略 → 用户权限分配 → 作为批处理作业登录，把它加进去（域策略可能会盖掉）' }
    exit 1
  } finally { $pw = $null }
  Note '已注册'
}

# ── 启动 ───────────────────────────────────────────────────────────────────────
$started = $false
if ($NoStart) { Say '按 -NoStart 没有启动' }
else {
  Say '启动'
  # 本数据根 / 旧任务的数据根上若有启动器在跑（同名任务的上一版），先让它退出——新的任务定义要重新拉起才生效
  $targets = @($data)
  if ($oldData -and $oldData -ne $data) { $targets += $oldData }
  foreach ($d in $targets) {
    $rec = Get-BridgeLauncher $d
    if ($rec) { Note "数据根 $d 上的启动器（pid $($rec.pid)）还在跑旧的任务定义，先让它退出"; $null = Stop-Launcher $d $rec }
  }
  $t = Get-BridgeTask $TaskName
  for ($i = 0; $i -lt 10 -and $t -and $t.State -eq 'Running' -and -not $WhatIf; $i++) { Start-Sleep -Seconds 1; $t = Get-BridgeTask $TaskName }
  $blocked = ''
  if ($t -and $t.State -eq 'Running') { $blocked = "计划任务 $TaskName 还有实例在跑（旧定义的进程）" }
  elseif (Test-BridgePortListening $Port) { $blocked = "端口 $Port 已经有程序在听（别的方式起的 bridge？别的服务？）" }
  if ($blocked) {
    Warn "$blocked：先停掉它，再 Start-ScheduledTask -TaskName $TaskName（或重启电脑）"
    if ($WhatIf) { Plan '真装时这里会跳过启动' }
  } elseif ($WhatIf) {
    Plan "Start-ScheduledTask -TaskName $TaskName，等 http://127.0.0.1:$Port/healthz（最多 90 秒）"
  } else {
    Start-ScheduledTask -TaskPath '\' -TaskName $TaskName
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
      if (Test-BridgeHealth $Port) { $started = $true; break }
      Start-Sleep -Seconds 1
    }
    if ($started) { Note "起来了：http://127.0.0.1:$Port/healthz 正常" }
    else { Warn ('90 秒内没起来，看日志：{0}' -f (Join-Path $data 'server.out.log')) }
  }
}

$logFile = Join-Path $data 'server.out.log'
$stopFile = Join-Path $data 'bridge-service.stop'
$restartFile = Join-Path $data 'bridge-service.restart'
$tail = ''
if ($WhatIf) { $tail = '——以上为 -WhatIf 演练，什么都没改' }
Write-Host ''
Write-Host '────────────────────────────────────────────────────────────────────'
Write-Host " The Bridge 服务端 · Windows 计划任务 $TaskName$tail"
Write-Host "   地址      http://127.0.0.1:$Port（外网走隧道，见 docs/deploy-windows.md）"
Write-Host "   局域网    新生成的配置（带 defaultsVersion:2）在计划任务托管下只听本机；要局域网直连，在 config.json 写 `"bindHost`": `"0.0.0.0`" 并放行防火墙"
Write-Host "   接入      在程序目录里 `$env:BRIDGE_DATA_ROOT='$data'; node src\cli.mjs access（地址、令牌与配对的取法）/ node src\cli.mjs pair（手机扫码配对）"
Write-Host "   程序      $Root"
Write-Host "   数据      $data"
Write-Host "   日志      $logFile（超过 2MB 轮转，保留 .1–.5；启动器自己的事件也写在里面）"
if (-not $hasConfig) {
  Write-Host "   令牌      第一次启动后：`$env:BRIDGE_DATA_ROOT='$data'; npm run -s show-token（在程序目录里跑）"
}
Write-Host ' 日常'
Write-Host "   启动      Start-ScheduledTask -TaskName $TaskName"
Write-Host "   停止      New-Item -ItemType File -Force '$stopFile'   （优雅：收掉服务端整棵进程树再退出）"
Write-Host "             Stop-ScheduledTask -TaskName $TaskName   （硬停：服务端跟着没，detached 的孙进程可能留下）"
Write-Host "   重启      控制台「服务控制 → 重启」，或 New-Item -ItemType File -Force '$restartFile'"
Write-Host "   更新      powershell -ExecutionPolicy Bypass -File '$Root\scripts\server\update.ps1'，或控制台「服务控制 → 检查并更新」"
Write-Host "   卸载      powershell -ExecutionPolicy Bypass -File '$Root\scripts\server\install-windows.ps1' -Uninstall"
Write-Host ' 还要自己做的'
Write-Host '   公网访问  登录后到控制台「服务控制 → 公网访问」里开：临时地址（免注册）/ Cloudflare 隧道（贴令牌）/ 自己的域名'
Write-Host '             服务端自己托管 cloudflared（没有就自动下载）、断了自愈；不用另装 cloudflared 服务'
Write-Host '   系统更新  Windows Update 会自动重启：设好「活动时间」，或用组策略关掉自动重启（VPS 建议改成只下载、自己挑时间装）'
Write-Host '             重启之后服务会自己起来（开机触发器），但在跑的对话会被打断'
Write-Host '────────────────────────────────────────────────────────────────────'
