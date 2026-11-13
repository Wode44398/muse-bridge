import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killGuardVerdict, killGuardCheck, makeKillGuardHook, parseNetstat, parseLsof } from './kill-guard.mjs';

const ps = (c, o = {}) => killGuardVerdict(c, { shell: 'powershell', ...o });
const sh = (c, o = {}) => killGuardVerdict(c, { shell: 'bash', ...o });
const no = (v, kind, c) => { assert.ok(v, `${c} 应拦下`); assert.equal(v.kind, kind, `${c} 拦下的类别`); };
const ok = (v, c) => assert.equal(v, null, `${c} 应放行：${v && v.reason}`);

test('转录里的真实命令：按端口查出来再停的拒，停自己句柄 / 字面 PID 的放行', () => {
  // A5-57 #1204：按 8791/8793 端口查监听进程、按映像名过滤后停——误停了 agent trading 的服务
  const c1 = String.raw`foreach ($port in 8791, 8793) { Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and ($p.ProcessName -in 'python','node')) { "stop $port -> $($p.ProcessName) $($p.Id)"; Stop-Process -Id $p.Id -Force -Confirm:$false } } }`;
  no(ps(c1), 'port', c1);
  // #1001：netstat 查端口、taskkill 停
  const c2 = String.raw`for pid in $(netstat -ano | grep ":8792 " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID $pid //F >/dev/null 2>&1; done`;
  no(sh(c2), 'port', c2);
  const c3 = String.raw`$c = Get-NetTCPConnection -LocalPort 8899 -State Listen -ErrorAction SilentlyContinue; if ($c) { Stop-Process -Id $c.OwningProcess -Force -Confirm:$false; "stopped $($c.OwningProcess)" }`;
  no(ps(c3), 'port', c3);
  // #1275 / #1280：停自己刚起的进程（Start-Process -PassThru 的句柄），#1280 先查端口空不空、被占就换
  const c4 = String.raw`$p = Start-Process -PassThru -WindowStyle Hidden -FilePath node -ArgumentList "server.mjs","18899"; Start-Sleep -Milliseconds 700; Stop-Process -Id $p.Id -Force -Confirm:$false; "stopped my pid $($p.Id)"`;
  ok(ps(c4), c4);
  const c5 = String.raw`$port=28431; if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { "port busy, pick another"; return }; $p = Start-Process -PassThru -FilePath node -ArgumentList "server.mjs","$port"; Stop-Process -Id $p.Id -Force -Confirm:$false`;
  ok(ps(c5), c5);
  // A5-58 #1356：父会话按字面 PID 停子 agent 的进程
  const c6 = String.raw`foreach ($id in 69332, 76100, 80280) { Stop-Process -Id $id -Force -Confirm:$false }`;
  ok(ps(c6), c6);
  const c7 = String.raw`taskkill //PID 93052 //T //F; sleep 2; netstat -ano | findstr :8787`;
  ok(sh(c7), c7);
});

test('按端口停的工具、按映像名停：直接拒', () => {
  for (const c of ['npx kill-port 3000', 'fkill :3000', 'fuser -k 3000/tcp']) no(sh(c), 'port-tool', c);
  for (const c of ['taskkill /IM node.exe /F', 'taskkill //F //IM python.exe', 'pkill -f "node server.mjs"', 'killall node', 'tskill node']) no(sh(c), 'image', c);
  for (const c of ['Stop-Process -Name python -Force', 'kill -Name node', 'Get-Process node | Stop-Process -Force', 'Stop-Process -Name $n', 'Stop-Process -Name msedge, chrome', 'taskkill /IM py* /F', 'Get-Process | Stop-Process']) no(ps(c), 'image', c);
  no(sh('killall -9 python3'), 'image', 'killall python3');
  no(sh('taskkill /F /FI "WINDOWTITLE eq dev*"'), 'image', '按窗口标题筛');
});

test('停自家 app（名字只有它自己）：放行', () => {
  // 生产转录里按名字重启自家 app、桌面端、资源管理器的（部署 bridge-client、重建 homepodcast），同名的只有它自己
  for (const c of ['taskkill /IM homepodcast.exe /F', 'tskill SnippingTool', 'pkill -f shot.mjs', 'pkill -f "http.server 8137"']) ok(sh(c), c);
  for (const c of ['Stop-Process -Name explorer -Force', 'Get-Process bridge-client -ErrorAction SilentlyContinue | Stop-Process -Force']) ok(ps(c), c);
  ok(ps(String.raw`Stop-Process -Id 53936
for ($i = 0; $i -lt 40; $i++) { if (-not (Get-Process bridge-client -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 250 }
$left = Get-Process bridge-client -ErrorAction SilentlyContinue
if ($left) { $left | Stop-Process -Force; Start-Sleep -Milliseconds 800 }`), '部署 bridge-client 收残留');
  ok(ps(String.raw`Get-Process | ? Name -match 'icloud|apple' | % { $n=$_.Name; try { Stop-Process -Id $_.Id -Force -EA Stop; "已结束 $n" } catch { "失败 $n : $_" } }`), '按名字停 iCloud');
});

test('目标从端口或进程名算出来的：拒', () => {
  no(sh('kill -9 $(lsof -ti:3000)'), 'port', 'lsof');
  no(sh('lsof -ti:3000 | xargs kill'), 'port', 'xargs');
  no(sh('while read p; do kill $p; done < <(lsof -ti:3000)'), 'port', 'done < <(lsof)');
  no(ps('gps python* | % { $_.Kill() }'), 'name', 'gps 名字 | .Kill()');
  no(ps('Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess -Force'), 'port', '(Get-Net).OwningProcess');
  no(ps('[Diagnostics.Process]::GetProcessById((Get-NetTCPConnection -LocalPort 3000).OwningProcess).Kill()'), 'port', '.Kill()');
  no(sh(String.raw`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 | % { Stop-Process -Id $_.OwningProcess -Force }"`), 'port', '套 powershell -Command');
  no(sh(String.raw`cmd //c "for /f \"tokens=5\" %a in ('netstat -ano ^| findstr :3000') do taskkill /PID %a /F"`), 'port', '套 cmd /c');
  no(sh('kill $(pgrep -f "python -m http.server 8791")'), 'name', 'pgrep');
  no(ps(`Get-Process | Where-Object { $_.ProcessName -eq 'node' } | Stop-Process`), 'name', 'Where ProcessName');
  no(ps(`Get-CimInstance Win32_Process | ? { $_.Name -eq 'node.exe' } | % { Stop-Process -Id $_.ProcessId }`), 'name', 'CIM 按 Name');
  no(ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`), 'name', 'CIM -Filter Name');
  no(sh(`wmic process where name="node.exe" delete`), 'name', 'wmic where name');
  no(ps('$ps = Get-Process python; foreach ($x in $ps) { Stop-Process -Id $x.Id }'), 'name', 'Get-Process 名字再循环');
});

test('测试服转录里做对了的收尾：PID 文件、按命令行核对过再停，放行', () => {
  // 子 agent 从自己的 PID 文件读 PID、核一眼进程名再停
  ok(ps(String.raw`$pidFile="C:\x\logs\diag_server.pid"; $id=[int](Get-Content $pidFile); $proc=Get-Process -Id $id -ErrorAction SilentlyContinue; if ($proc -and $proc.ProcessName -eq 'node') { Stop-Process -Id $id; "stopped $id" } else { "not running: $id" }`), 'PID 文件 + 核进程名');
  ok(ps(String.raw`foreach ($f in @("srv8815.pid","srv8825.pid")) { $procId = [int]((Get-Content "$logd\$f").Trim()); $p = Get-Process -Id $procId -ErrorAction SilentlyContinue; if ($p) { "$f -> PID $procId ($($p.ProcessName)) stopping"; Stop-Process -Id $procId -Confirm:$false } }; Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 8815,8825 } | Select-Object LocalPort, OwningProcess`), 'PID 文件 + 事后看端口');
  ok(sh('kill $(cat logs/server.pid); sleep 1; netstat -ano | grep :8802'), 'kill $(cat pid 文件)');
  // 按端口查出候选，但按命令行核对是自己的服务再停
  ok(ps(String.raw`Get-NetTCPConnection -LocalPort 8804 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").CommandLine; if ($c -like '*server.mjs 8804*') { Stop-Process -Id $_.OwningProcess -Force; "stopped $($_.OwningProcess)" } }`), '端口 + 命令行核对');
  ok(ps(String.raw`$c = Get-NetTCPConnection -LocalPort 8806 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; $p.CommandLine; if ($p.CommandLine -match 'server.mjs 8806') { Stop-Process -Id $p.ProcessId -Force } }`), '端口 + 命令行 -match');
  // 生产转录里做对了、早先版本误拦的：PID 文件读出来再停、停完再看端口；按命令行 / 可执行路径 / 父进程筛
  ok(sh('kill $p; netstat -ano | grep :3000'), '停完再看端口');
  ok(ps(String.raw`$S = "C:\x\overlay-assets"
foreach ($l in (Get-Content "$S\pids.txt")) { $id = [int]($l.Split('=')[1]); try { Stop-Process -Id $id -Force -ErrorAction Stop; "stopped $l" } catch { "gone $l" } }
Get-NetTCPConnection -LocalPort 8851,8852 -State Listen -ErrorAction SilentlyContinue | Measure-Object`), 'pids.txt 循环 + 事后看端口');
  ok(ps(String.raw`$p = Get-Content (Join-Path $smoke 'pids.json') -Raw | ConvertFrom-Json
foreach ($id in @($p.vite, $p.server, $p.fake)) { $proc = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($proc) { Stop-Process -Id $id -Confirm:$false } }
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 18970, 5197 } | Select-Object LocalPort, OwningProcess`), 'pids.json 句柄字段');
  ok(ps(String.raw`$bpid = [int](Get-Content (Join-Path $cfg.T 'bridge.pid'))
Stop-Process -Id $bpid -Force
$kids = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ParentProcessId -eq $bpid }
foreach ($k in $kids) { Stop-Process -Id $k.ProcessId -Force -ErrorAction SilentlyContinue }
$listen = Get-NetTCPConnection -LocalPort $cfg.harnessPort -State Listen -ErrorAction SilentlyContinue`), '按父进程筛子进程');
  ok(ps(String.raw`Get-Process -Id 83696,47396 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Get-NetTCPConnection -LocalPort 8851 -State Listen | Select-Object OwningProcess`), 'Get-Process -Id 字面 | Stop-Process');
  ok(sh(String.raw`powershell -NoProfile -Command "\$p=[int](Get-Content C:\x\server.pid); (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine; taskkill /T /F /PID \$p | Out-Null; [bool](Get-NetTCPConnection -LocalPort 8830 -State Listen -ErrorAction SilentlyContinue)"`), '套 powershell 的 PID 文件');
  ok(sh(String.raw`for p in $(cut -f1 logs/pids.tsv | tr -d '\r'); do if tasklist //FI "PID eq $p" 2>/dev/null | grep -qiE "claude|python"; then echo "kill $p"; taskkill //PID $p //T //F >/dev/null 2>&1; fi; done`), 'pids.tsv 循环 + tasklist 核名字');
  ok(sh(String.raw`W=$(cat /proc/17941/winpid 2>/dev/null); [ -n "$W" ] && taskkill //F //T //PID $W; tasklist //FI "IMAGENAME eq chrome.exe" 2>/dev/null | tail -3`), 'PID 文件带 2>/dev/null');
  ok(sh(String.raw`until grep -q "done S0" d4/vcap.log || ! tasklist //FI "PID eq 55688" | grep -q 55688; do sleep 10; done; echo "[$(date -u +%H:%M:%SZ)] S0 done -> kill old child 55688"; taskkill //PID 55688 //T //F`), 'echo 串里的 kill 字样');
  ok(sh(String.raw`wmic process where "commandline like '%drive.mjs%' and name='node.exe'" get processid 2>/dev/null | grep -o "[0-9]\+" | while read p; do taskkill //PID $p //T //F; done`), 'wmic 按命令行 like');
  ok(sh(String.raw`for p in $(wmic process where "name='chrome.exe'" get ProcessId,CommandLine 2>/dev/null | grep "r6video" | awk '{print $NF}'); do taskkill //F //PID $p >/dev/null; done`), '列命令行再 grep');
  ok(ps(String.raw`$p = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -like '*ee64eeb1*' }; foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force }`), '按可执行路径筛');
  // 生产转录：核对后打印 $l.OwningProcess 再停（读变量不算新来源）；核对和端口写在同一个条件里
  ok(sh('powershell -NoProfile -Command "\n\\$l = Get-NetTCPConnection -State Listen -LocalPort 8799 -ErrorAction SilentlyContinue | Select-Object -First 1\nif (\\$l) {\n  \\$c = Get-CimInstance Win32_Process -Filter (\\"ProcessId=\\" + \\$l.OwningProcess)\n  if (\\$c.CommandLine -match \'server/index\\.ts\') {\n    Write-Output (\'摘除 harness PID \' + \\$l.OwningProcess)\n    Stop-Process -Id \\$l.OwningProcess -Force\n  } else { Write-Output \'不是 harness\' }\n}\n"; sleep 1'), '核对后打印再停');
  ok(ps(String.raw`$p = Get-CimInstance Win32_Process -Filter "ProcessId=16668"; if($p -and $p.CommandLine -match 'src/server.mjs' -and (Get-NetTCPConnection -LocalPort 8816 -State Listen -ErrorAction SilentlyContinue).OwningProcess -eq 16668){ Get-CimInstance Win32_Process -Filter "ParentProcessId=16668" | % { Stop-Process -Id $_.ProcessId -Force }; Stop-Process -Id 16668 -Force }`), '命令行和端口同一个 if');
  ok(sh(String.raw`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { \$_.CommandLine -match 'vite --port 5175' -or (\$_.CommandLine -match 'src/server.mjs' -and (Get-NetTCPConnection -OwningProcess \$_.ProcessId -LocalPort 8797 -State Listen -ErrorAction SilentlyContinue)) } | % { taskkill /PID \$_.ProcessId /T /F | Out-Null }"`), '命令行和端口同一个筛选块');
  no(ps(String.raw`$l = Get-NetTCPConnection -LocalPort 8799 -State Listen; Write-Output $l.OwningProcess; Stop-Process -Id $l.OwningProcess -Force`), 'port', '只读变量没核对');
  ok(ps('$shell = @(Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\'" | Where-Object {\n  $c = [string]$_.CommandLine\n  $c.IndexOf(\'claude-in-finance\\native-profile\', [StringComparison]::OrdinalIgnoreCase) -ge 0 })\nforeach ($p in $shell) { Stop-Process -Id $p.ProcessId -Force }'), '命令行存变量再 IndexOf');
  // 查了命令行但没比对就停的，照拒
  no(ps(String.raw`$c = Get-NetTCPConnection -LocalPort 8832 -State Listen -ErrorAction SilentlyContinue; if ($c) { $vp = $c.OwningProcess | Select-Object -First 1; Get-CimInstance Win32_Process -Filter "ProcessId=$vp" | Select-Object ProcessId, CommandLine; Stop-Process -Id $vp -Force }`), 'port', '看了命令行没比对');
  no(ps(String.raw`Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*x*' } | % { Stop-Process -Id $_.ProcessId }; Get-NetTCPConnection -LocalPort 3000 | % { Stop-Process -Id $_.OwningProcess }`), 'port', '前一句的核对不算数');
  // 同一批转录里真该拦的：子 agent 按映像名停全部 node、按端口停
  no(sh(`taskkill //F //IM node.exe //FI "WINDOWTITLE eq *" >/dev/null 2>&1; echo done`), 'image', 'taskkill 全部 node');
  no(sh(String.raw`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 18801 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }"; sleep 1`), 'port', '子 agent 套 powershell 按端口停');
});

test('放行：字面 PID、自己的句柄、只查端口、搜源码、git、adb shell', () => {
  ok(sh('node server.mjs & PID=$!; sleep 1; curl -s localhost:3000; kill $PID'), 'kill $PID');
  ok(sh('node server.mjs & PID=$!; netstat -ano | findstr :3000; kill $PID'), '句柄 + netstat');
  ok(sh('python -m http.server 8000 & sleep 1; netstat -ano | grep 8000; kill %1'), 'kill %1');
  ok(sh('kill -9 123 456; lsof -i :3000'), 'kill 字面 + lsof');
  ok(sh('taskkill //PID 123 //T //F >/dev/null 2>&1; netstat -ano | grep 3000'), 'taskkill 字面 + 重定向');
  ok(sh(`cmd //c "taskkill /PID 1234 /F" && netstat -ano`), '套 cmd 的字面 taskkill');
  ok(sh('kill -s TERM 4242; netstat -ano'), 'kill -s');
  ok(sh('kill -0 $pid && netstat -ano'), 'kill -0 探活');
  ok(ps('Stop-Process -Id 1234, 5678 -Force -ErrorAction SilentlyContinue; Get-NetTCPConnection -LocalPort 8791'), 'Stop-Process 字面列表');
  ok(ps('$p = Start-Process node -ArgumentList server.mjs -PassThru; Get-NetTCPConnection -LocalPort 3000; $p | Stop-Process'), '句柄管道');
  ok(ps('$p = Start-Process node -PassThru; netstat -ano | findstr 3000; $p.Kill()'), '句柄 .Kill()');
  ok(ps('Get-NetTCPConnection -State Listen -LocalPort 8791 | Select OwningProcess'), '只查端口');
  ok(ps(`$c = Get-NetTCPConnection -LocalPort 8899 -State Listen; Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" | Select CommandLine`), '查端口归属');
  ok(sh(String.raw`grep -rn "Stop-Process\|OwningProcess\|taskkill" scripts/ src/ | head`), 'grep 源码');
  ok(sh(String.raw`cd /c/x && rg -n 'netstat|kill' src | head -20`), 'rg 源码');
  ok(ps(String.raw`Select-String -Path src\*.mjs -Pattern "taskkill /IM|Get-NetTCPConnection.*Stop-Process"`), 'Select-String 源码');
  ok(ps(String.raw`Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*scenario.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`), '按命令行筛');
  ok(sh('git log --oneline -5 -- scripts/zombie-reaper.ps1'), 'git log');
  ok(sh(`git commit -m "fix: 不再 taskkill /IM node.exe，改按 PID 停"`), 'git commit 文案');
  ok(sh('echo skill-creator; netstat -ano | findstr 8787'), 'skill 字样');
  ok(sh('docker kill web; docker ps'), 'docker kill');
  ok(sh("cat > notes.md <<'EOF'\n别用 taskkill /IM node.exe，也别 Get-NetTCPConnection | % { Stop-Process -Id $_.OwningProcess }\nit's fine\nEOF\nwc -l notes.md"), 'heredoc 写文档');
  no(sh("bash <<'EOF'\npkill node\nEOF"), 'image', 'heredoc 喂给 bash');
  no(sh("cat <<'EOF' | sh\nkillall node\nEOF"), 'image', 'heredoc 管道给 sh');
  ok(sh('adb shell pkill frida-server; adb shell am force-stop com.x'), 'adb shell pkill');
  ok(sh('adb -s emulator-5554 shell "kill -9 $(pidof frida)"'), 'adb shell 带引号');
  ok(sh(`adb shell 'netstat -tlnp | grep 27042'; adb shell kill 1234`), 'adb shell netstat');
});

test('bridge 服务自己的 PID：字面也拒', () => {
  no(sh('taskkill /PID 4242 /T /F', { protectedPids: [4242] }), 'self', 'taskkill 自己');
  no(ps('Stop-Process -Id 99, 4242 -Force', { protectedPids: [4242] }), 'self', 'Stop-Process 自己');
  ok(sh('taskkill /PID 4243 /F; curl http://127.0.0.1:8787/ -d 4242', { protectedPids: [4242] }), '别的段里出现同一个数字');
});

test('拒绝文案告诉模型正路', () => {
  const v = ps('Get-NetTCPConnection -LocalPort 3000 | % { Stop-Process -Id $_.OwningProcess }');
  assert.match(v.reason, /没跑/);
  assert.match(v.reason, /没看清是谁/);
  assert.match(v.reason, /TaskStop/);
  assert.match(v.reason, /先单独查出 PID/);
  assert.match(v.reason, /按字面 PID 停/);
  assert.match(v.reason, /换端口/);
  // 文案要短：每次拒都进上下文
  for (const c of ['Stop-Process -Name node', 'npx kill-port 3000', v && 'x']) {
    const r = c === 'x' ? v : ps(c);
    assert.ok(r.reason.length < 300, `拒绝文案过长：${r.reason.length}`);
  }
});

test('Docker Desktop 全机一份：按名字停它不拦；docker CLI 仍拦', () => {
  ok(ps(`Stop-Process -Name 'Docker Desktop' -Force; Stop-Process -Name 'com.docker.backend' -Force`), '停 Docker Desktop');
  no(ps('Stop-Process -Name docker -Force'), 'image', 'docker CLI');
});

test('钩子：Bash / PowerShell 都管，子 agent 也管；只回 deny 或放行，绝不回 allow', async () => {
  const h = makeKillGuardHook({ protectedPids: [4242], probe: stub({}) });
  assert.deepEqual(await h({ tool_name: 'Read', tool_input: { file_path: 'x' } }), { continue: true });
  assert.deepEqual(await h({ tool_name: 'Bash', tool_input: { command: 'npm test' } }), { continue: true });
  assert.deepEqual(await h({ tool_name: 'PowerShell', tool_input: { command: 'Stop-Process -Id 777 -Force' } }), { continue: true });
  const d = (await h({ tool_name: 'Bash', agent_id: 'sub1', tool_input: { command: 'taskkill /IM node.exe /F' } })).hookSpecificOutput;
  assert.equal(d.hookEventName, 'PreToolUse');
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /共用进程名/);
  const p = (await h({ tool_name: 'PowerShell', tool_input: { command: 'Stop-Process -Name node' } })).hookSpecificOutput;
  assert.equal(p.permissionDecision, 'deny');
  assert.deepEqual(await h({ tool_name: 'Bash', tool_input: {} }), { continue: true });
  assert.deepEqual(await h(null), { continue: true });
});

// ── 端口类现场核查：现场查询用桩 ──
// stub({ 端口: [pid…] }, { pid: { name, cmd, created } })；throws / hang 模拟查询失败、超时
function stub(listen, procs = {}, o = {}) {
  const calls = { listeners: 0, procs: 0 };
  return {
    calls,
    async listeners(ports) {
      calls.listeners++;
      if (o.throws) throw new Error('netstat failed');
      if (o.hang) return new Promise(() => {});
      return new Map(ports.map((p) => [p, (listen[p] || []).map((pid) => ({ pid, addr: '0.0.0.0' }))]));
    },
    async procs(pids) {
      calls.procs++;
      if (o.procsThrow) throw new Error('cim failed');
      return new Map(pids.filter((p) => procs[p]).map((p) => [p, { pid: p, ...procs[p] }]));
    },
    async ancestors() { return o.ancestors || []; },
  };
}
const A557 = String.raw`foreach ($port in 8791, 8793) { Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false } }`;
const live = (c, probe, o = {}) => killGuardCheck(c, { shell: o.shell || 'powershell', protectedPids: o.protectedPids || [], probe, timeoutMs: 200, procTimeoutMs: 200, ...o });

test('端口类先抽字面端口：-LocalPort、:端口、findstr、lsof、字面循环变量；抽不全给 null', () => {
  const ports = (c, shell = 'powershell') => { const v = killGuardVerdict(c, { shell }); assert.equal(v && v.kind, 'port', c); return v.ports; };
  assert.deepEqual(ports(A557), [8791, 8793]);
  assert.deepEqual(ports('Get-NetTCPConnection -State Listen -LocalPort 8796,5182 | % { Stop-Process -Id $_.OwningProcess -Force }'), [8796, 5182]);
  assert.deepEqual(ports('$c = Get-NetTCPConnection -LocalPort 8832 -State Listen; if ($c) { taskkill /PID $c.OwningProcess /T /F }'), [8832]);
  assert.deepEqual(ports(`for p in $(netstat -ano | grep ":8792 " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID $p //F; done`, 'bash'), [8792]);
  assert.deepEqual(ports(String.raw`for p in 8788 5288; do pid=$(netstat -ano | grep -E "[:.]$p .*LISTENING|\[::1\]:$p .*LISTENING" | awk '{print $NF}' | head -1); [ -n "$pid" ] && taskkill //PID $pid //T //F; done`, 'bash'), [8788, 5288]);
  assert.deepEqual(ports('kill -9 $(lsof -ti:3000)', 'bash'), [3000]);
  assert.deepEqual(ports('while read p; do kill $p; done < <(lsof -i :3000 -t)', 'bash'), [3000]);
  assert.deepEqual(ports(`taskkill //F //PID $(netstat -ano | findstr 8791 | awk '{print $5}')`, 'bash'), [8791]);
  assert.deepEqual(ports(String.raw`powershell -NoProfile -Command "foreach(\$port in 8797,5181){\$p=(Get-NetTCPConnection -State Listen -LocalPort \$port).OwningProcess; if(\$p){Stop-Process -Id \$p -Force}}"`, 'bash'), [8797, 5181]);
  // 只看结果、没接给停进程的顶层查询不算来源（里面的通配和 8787 都不影响）
  assert.deepEqual(ports(`netstat -ano | grep -E ":879[0-9] "; netstat -ano | findstr :8787; taskkill //F //PID $(netstat -ano | grep "127.0.0.1:8791 .*LISTENING" | awk '{print $5}')`, 'bash'), [8791]);
  // 变量按位置认：前一个循环的 $port 不吃后一个循环（事后检查 8787）的值
  assert.deepEqual(ports(String.raw`$pids = @()
foreach ($port in 5198, 18971) { $pids += (Get-NetTCPConnection -LocalPort $port -State Listen).OwningProcess }
foreach ($id in $pids) { Stop-Process -Id $id -Force }
foreach ($port in 5198, 8787) { "$port listen=$([bool](Get-NetTCPConnection -LocalPort $port -State Listen))" }`), [5198, 18971]);
  // 抽不全：端口是算出来的、通配、来源里没写端口
  assert.equal(ports(`$port = ([uri]$info.api).Port; Get-NetTCPConnection -LocalPort $port -State Listen | % { Stop-Process -Id $_.OwningProcess }`), null);
  assert.equal(ports(`taskkill //F //PID $(netstat -ano | grep -E ":879[0-9] .*LISTENING" | awk '{print $5}')`, 'bash'), null);
  assert.equal(ports('Get-NetTCPConnection -State Listen | % { Stop-Process -Id $_.OwningProcess }'), null);
  assert.equal(ports('Stop-Process -Id $l.OwningProcess -Force'), null);
  assert.equal(ports('8791, 8793 | % { Get-NetTCPConnection -LocalPort $_ } | % { Stop-Process -Id $_.OwningProcess }'), null);
});

test('现场核查：单端口单 PID 放行；双 PID 拒并点名；没人监听放行', async () => {
  const one = stub({ 8791: [63324], 8793: [] }, { 63324: { name: 'node.exe', cmd: 'node src\\server.mjs 8791', created: 2000 } });
  assert.equal(await live(A557, one), null);
  assert.equal(one.calls.listeners, 1);
  assert.equal(await live('kill -9 $(lsof -ti:3000)', stub({ 3000: [77] }), { shell: 'bash' }), null);
  assert.equal(await live(A557, stub({})), null, '端口上没人监听');
  // A5-57：0.0.0.0:8791 是 agent trading，127.0.0.1:8791 是测试服
  const two = stub({ 8791: [63324, 81234] }, { 63324: { name: 'python.exe', cmd: 'python E:\\agent trading\\serve.py' }, 81234: { name: 'node.exe', cmd: 'node src/server.mjs 8791' } });
  const v = await live(A557, two);
  no(v, 'port', '双绑定');
  assert.match(v.reason, /不止一个进程/);
  assert.match(v.reason, /PID 63324 python\.exe「python E:\\agent trading\\serve\.py」/);
  assert.match(v.reason, /PID 81234 node\.exe/);
  assert.match(v.reason, /按字面 PID 停/);
  assert.ok(v.reason.length < 400, `拒绝文案过长：${v.reason.length}`);
  // 进程详情查不到：照拒，只列 PID
  const bare = await live(A557, stub({ 8791: [1, 2] }, {}, { procsThrow: true }));
  no(bare, 'port', '双绑定 + 详情失败');
  assert.match(bare.reason, /PID 1；PID 2/);
});

test('现场核查：查询失败 / 超时 / 抽不出端口 / 看不到 PID，维持原判', async () => {
  no(await live(A557, stub({}, {}, { throws: true })), 'port', '查询失败');
  const t0 = Date.now();
  no(await live(A557, stub({}, {}, { hang: true })), 'port', '查询超时');
  assert.ok(Date.now() - t0 < 1500, '超时要掐住');
  const p = stub({ 3000: [5] });
  no(await live(`$port = ([uri]$info.api).Port; Get-NetTCPConnection -LocalPort $port -State Listen | % { Stop-Process -Id $_.OwningProcess }`, p), 'port', '端口是变量');
  assert.equal(p.calls.listeners, 0, '抽不出端口就不查');
  const nopid = { ...stub({}), async listeners(ports) { return new Map(ports.map((x) => [x, [{ pid: null, addr: '0.0.0.0' }]])); } };
  no(await live('kill $(lsof -ti:3000)', nopid, { shell: 'bash' }), 'port', 'ss 没权限看不到 PID');
  // 别的类不走现场核查
  const q = stub({ 3000: [5] });
  no(await live('taskkill /IM node.exe /F', q, { shell: 'bash' }), 'image', '映像名');
  no(await live('Get-NetTCPConnection -LocalPort 3000 | % { Stop-Process -Id $_.OwningProcess }; Get-Process node | Stop-Process', q), 'image', '端口过了、映像名照拒');
  no(await live(`kill $(lsof -ti:3000); kill $(pgrep -f "node server.mjs")`, q, { shell: 'bash' }), 'port', '端口过了、进程名照拒（不做现场核查）');
  assert.equal(q.calls.listeners, 0, '混着进程名来源的不查');
});

test('现场核查：监听的是 bridge 自己或它的父 / 祖先，拒', async () => {
  const self = await live('Get-NetTCPConnection -LocalPort 8787 -State Listen | % { Stop-Process -Id $_.OwningProcess }', stub({ 8787: [4242] }, { 4242: { name: 'node.exe', cmd: 'node src/server.mjs' } }), { protectedPids: [4242] });
  no(self, 'port', 'bridge 自己');
  assert.match(self.reason, /PID 4242 node\.exe.*bridge 服务本身/);
  no(await live('Get-NetTCPConnection -LocalPort 8787 -State Listen | % { Stop-Process -Id $_.OwningProcess }', stub({ 8787: [process.pid] })), 'port', 'process.pid 总是护着');
  const anc = await live('kill $(lsof -ti:9000)', stub({ 9000: [3131] }, {}, { ancestors: [3131] }), { shell: 'bash' });
  no(anc, 'port', 'bridge 的祖先');
  assert.match(anc.reason, /父 \/ 祖先进程/);
});

test('现场核查：监听进程早于本会话开始，拒；晚于或查不到起始时间，放行', async () => {
  const procs = { 500: { name: 'python.exe', cmd: 'python serve.py', created: 1000 } };
  const old = await live(A557, stub({ 8791: [500] }, procs), { sessionStart: 5000 });
  no(old, 'port', '本会话之前就在跑');
  assert.match(old.reason, /PID 500 python\.exe「python serve\.py」 在本会话开始之前/);
  assert.equal(await live(A557, stub({ 8791: [500] }, procs), { sessionStart: 500 }), null, '本会话里起的');
  assert.equal(await live(A557, stub({ 8791: [500] }, procs, { procsThrow: true }), { sessionStart: 5000 }), null, '详情查不到不因此拒');
  assert.equal(await live(A557, stub({ 8791: [500] }, procs)), null, '没有会话起点就不比');
});

test('钩子：端口类走现场核查（转录第一条 timestamp 当会话起点），子 agent 一样', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-'));
  const tp = path.join(dir, 's.jsonl');
  fs.writeFileSync(tp, '{"type":"mode"}\n{"type":"user","timestamp":"2026-11-08T00:00:00.000Z"}\n');
  try {
    const start = Date.parse('2026-11-08T00:00:00.000Z');
    const mk = (created, pids = [700]) => makeKillGuardHook({ checkStart: true, protectedPids: [4242], timeoutMs: 200, procTimeoutMs: 200, probe: stub({ 8791: pids }, { 700: { name: 'node.exe', cmd: 'node x', created } }) });
    const inp = { tool_name: 'PowerShell', agent_id: 'sub1', transcript_path: tp, tool_input: { command: A557 } };
    assert.deepEqual(await mk(start + 60000)(inp), { continue: true });
    const d = (await mk(start - 60000)(inp)).hookSpecificOutput;
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.permissionDecisionReason, /本会话开始之前/);
    const two = (await mk(start + 60000, [700, 701])(inp)).hookSpecificOutput;
    assert.equal(two.permissionDecision, 'deny');
    assert.match(two.permissionDecisionReason, /PID 700 node\.exe「node x」；PID 701/);
    // 默认不比起始时间
    const off = makeKillGuardHook({ timeoutMs: 200, probe: stub({ 8791: [700] }, { 700: { created: 1 } }) });
    assert.deepEqual(await off(inp), { continue: true });
    // 永远不回 allow
    for (const h of [mk(start + 60000), mk(start - 60000)]) assert.notEqual(((await h(inp)).hookSpecificOutput || {}).permissionDecision, 'allow');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('netstat / lsof 输出解析', () => {
  const out = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:8791           0.0.0.0:0              LISTENING       63324',
    '  TCP    127.0.0.1:8791         0.0.0.0:0              LISTENING       81234',
    '  TCP    127.0.0.1:8791         127.0.0.1:55001        ESTABLISHED     81234',
    '  TCP    127.0.0.1:55001        127.0.0.1:8791         ESTABLISHED     999',
    '  TCP    [::]:8791              [::]:0                 LISTENING       63324',
    '  TCP    0.0.0.0:18791          0.0.0.0:0              侦听            12',
    '  UDP    0.0.0.0:8791           *:*                                    4',
  ].join('\r\n');
  const m = parseNetstat(out, [8791, 18791, 5173]);
  assert.deepEqual([...new Set(m.get(8791).map((x) => x.pid))], [63324, 81234]);
  assert.deepEqual(m.get(18791).map((x) => x.pid), [12], '状态词本地化也认');
  assert.deepEqual(m.get(5173), []);
  const l = parseLsof('p123\nn*:3000\nn[::1]:3000\np456\nn127.0.0.1:3001\n', [3000, 3001]);
  assert.deepEqual(l.get(3000).map((x) => x.pid), [123, 123]);
  assert.deepEqual(l.get(3001).map((x) => x.pid), [456]);
});
