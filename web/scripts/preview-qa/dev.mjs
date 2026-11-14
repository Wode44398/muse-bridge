#!/usr/bin/env node
// 预览验证用的隔离 dev 环境：免鉴权后端 + vite，一条命令起、一条命令收。用法见同目录 README.md。
//   node web/scripts/preview-qa/dev.mjs start  [--name a] [--api-port 8840] [--vite-port 8841] [--ttl 60] [--overlay <目录>] [--restart] [--fresh] [--ref <git 提交> | --web <web 目录>]
//     --fresh：起之前清掉本实例的数据根与用户根（服务端 Office 转 PDF 缓存、缩略图缓存都在里面），量「冷」打开耗时用。
//     --ref：前端用某个提交的源码（git archive 到 %TEMP%/bridge-preview-qa/snap-<sha>/，node_modules 用 junction 指回本树），
//            用来在同事改到一半时照样跑「改版前基线」；后端照旧用当前树（预览改版不动后端）。
//     --web：前端直接用某个目录（另一个 worktree 的 web/ 等）。
//   node web/scripts/preview-qa/dev.mjs stop   [--name a | --all]
//   node web/scripts/preview-qa/dev.mjs status
// 纪律（摸底「验证与发布路径」约束 1-4）：
//   - 数据根 / BRIDGE_USERS_ROOT 每个实例各自一份（%TEMP%\bridge-preview-qa\inst-<name>\），VAULT_PATH 共用样张 vault（只读用）；
//   - BRIDGE_MODULES_SKIP=dimensio,codex（不然会把生产 8799 的 harness 赶下线）、BRIDGE_CLAUDE_IN_CHROME=0、BRIDGE_NO_ROUTINES=1、
//     BRIDGE_OVERLAY_DIR 指私有 overlay（不然 dev 页白屏），删掉 ANTHROPIC_BASE_URL 等继承来的变量；
//   - NO_AUTH 实例只听 127.0.0.1；vite 也只听 127.0.0.1；
//   - 两个进程都带 --ttl 自杀定时器（默认 60 分钟），到点收自己的整棵进程树；
//   - stop 只按 pid.json 里记下的 PID 收：先用 Win32_Process 核对命令行里有本实例的启动脚本和 --qa-name，再 taskkill /T /F。
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { HERE, REPO, WEB, QA_ROOT, VAULT, SAMPLES_DIR, instDir, pidFile, parseArgs, readJson, findPorts, portFree, procInfo, listenerPid, killTree, sleep } from './lib/paths.mjs';

const a = parseArgs(process.argv.slice(2));
const cmd = a._[0] || 'status';
const NAME = String(a.name || 'a').replace(/[^\w-]/g, '').slice(0, 24) || 'a';
const BACKEND_BOOT = path.join(HERE, 'lib', 'backend-boot.mjs');
const VITE_BOOT = path.join(HERE, 'lib', 'vite-boot.mjs');
const OVERLAY = String(a.overlay || process.env.PREVIEW_QA_OVERLAY || 'C:\\Users\\you\\bridge-private');

const say = (s) => process.stdout.write(s + '\n');

/** 这个 PID 是不是本实例起的那个进程（命令行里有启动脚本文件名和 --qa-name <name>） */
function isOurs(pid, script, name) {
  const p = procInfo(pid);
  if (!p) return { alive: false };
  const c = String(p.cmd || '');
  const ok = c.includes(path.basename(script)) && new RegExp('--qa-name\\s+"?' + name + '"?(\\s|$)').test(c);
  return { alive: true, ours: ok, cmd: c, created: p.created };
}

function cleanEnv(extra) {
  const env = { ...process.env };
  // 继承来的 bridge / Claude 相关变量全部清掉，免得测试实例连到正式数据或正式上游
  for (const k of Object.keys(env)) {
    if (/^BRIDGE_/i.test(k) || /^(PORT|VAULT_PATH|ANTHROPIC_BASE_URL|_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL|PV_PUBLIC_DOMAIN|STUDIO_QA_VITE_CACHE)$/i.test(k)) delete env[k];
  }
  return { ...env, ...extra };
}

async function waitHttp(url, ms, what) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (r.status < 500) return Date.now() - t0;
      last = 'HTTP ' + r.status;
    } catch (e) { last = String(e.cause?.code || e.message || e); }
    await sleep(400);
  }
  throw new Error(what + ' 等不到就绪（' + url + '，最后：' + last + '）');
}

async function stopInstance(name, { quiet = false } = {}) {
  const pf = pidFile(name);
  const info = readJson(pf);
  if (!info) { if (!quiet) say(`实例 ${name}：没有 pid.json，什么也不做`); return { name, stopped: [] }; }
  const res = { name, stopped: [], skipped: [] };
  for (const [role, script] of [['vite', VITE_BOOT], ['backend', BACKEND_BOOT]]) {
    const pid = info[role]?.pid;
    if (!pid) continue;
    const chk = isOurs(pid, script, name);
    if (!chk.alive) { res.stopped.push({ role, pid, note: '已不在' }); continue; }
    if (!chk.ours) { res.skipped.push({ role, pid, why: '命令行对不上，不杀', cmd: chk.cmd?.slice(0, 200) }); continue; }
    killTree(pid);
    await sleep(300);
    res.stopped.push({ role, pid, note: procInfo(pid) ? '仍在（请人工核对）' : '已收' });
  }
  // 端口复核：监听者若仍是我们的 PID 说明没收掉
  for (const [role, port] of [['vite', info.vitePort], ['backend', info.apiPort]]) {
    const lp = port ? listenerPid(port) : 0;
    if (lp && (lp === info[role]?.pid)) res.skipped.push({ role, pid: lp, why: '端口 ' + port + ' 还在听' });
  }
  if (!res.skipped.length) {
    rmSync(pf, { force: true });
    // 后端的临时目录是本实例独占的（soffice 的 lo-prof-* 临时 profile 不清理会一直堆，见摸底「文档类」差距 10）：进程收干净后整个删掉
    const tmp = path.join(instDir(name), 'tmp');
    if (existsSync(tmp)) { const n = readdirSync(tmp).filter((x) => x.startsWith('lo-prof-')).length; try { rmSync(tmp, { recursive: true, force: true }); res.tmpCleared = { dir: tmp, loProfiles: n }; } catch (e) { res.tmpCleared = { dir: tmp, err: String(e.message || e) }; } }
    // scenarios/entry.mjs 往本实例数据根写的假媒体（固定 id / 前缀，只删这些）：以前要人工删，停实例时顺手清掉
    const fake = [];
    for (const [sub, re] of [['media', /^e17e0001-/], ['uploads', /^1763000000\d{3}-/]]) {
      const d = path.join(instDir(name), 'data', sub);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) if (re.test(f)) { try { rmSync(path.join(d, f), { force: true }); fake.push(sub + '/' + f); } catch {} }
    }
    if (fake.length) res.fakeMediaCleared = fake.length;
  }
  if (!quiet) say(JSON.stringify(res, null, 1));
  return res;
}

/** 把 ref 的前端相关源码导出到快照目录（已导出过就复用），返回快照里的 web 目录 */
function snapshot(ref) {
  const sha = execFileSync('git', ['-C', REPO, 'rev-parse', '--verify', ref + '^{commit}'], { encoding: 'utf8' }).trim();
  const dir = path.join(QA_ROOT, 'snap-' + sha.slice(0, 12));
  if (!existsSync(path.join(dir, '.ok'))) {
    mkdirSync(dir, { recursive: true });
    const zip = path.join(QA_ROOT, 'snap-' + sha.slice(0, 12) + '.zip');
    execFileSync('git', ['-C', REPO, 'archive', '--format=zip', '-o', zip, sha, 'web', 'src', 'harness/web'], { stdio: 'inherit' });
    // 用 Windows 自带的 bsdtar（能解 zip）；Git Bash 的 GNU tar 会把 C: 当成远程主机
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xf', zip, '-C', dir], { stdio: 'inherit' });
    rmSync(zip, { force: true });
    // node_modules 不在 git 里：建 junction 指回本树（本树的又是指回主树的 junction，取真实路径）
    for (const rel of ['node_modules', 'web/node_modules', 'harness/web/node_modules']) {
      const src = path.join(REPO, rel);
      if (existsSync(src) && !existsSync(path.join(dir, rel))) symlinkSync(realpathSync(src), path.join(dir, rel), 'junction');
    }
    writeFileSync(path.join(dir, '.ok'), sha);
  }
  const patched = patchSnapshot(path.join(dir, 'web'));
  return { sha, web: path.join(dir, 'web'), patched };
}

/** 老提交里还没有 dev 专用的 isOffline 覆盖开关（本地桩要靠它走手机「本地」分页）：只补这一处测试设施，不动任何行为。 */
function patchSnapshot(web) {
  const f = path.join(web, 'src', 'lib', 'server.js');
  if (!existsSync(f)) return [];
  const src = readFileSync(f, 'utf8');
  const mark = path.join(web, '..', '.patched');
  const MSG = 'server.js：补 dev 专用 isOffline 覆盖开关';
  // 已含开关：要么是本函数之前补的（有 .patched 记号），要么这个提交本来就带（不算补丁）
  if (src.includes('__BRIDGE_DEV_OFFLINE__')) return existsSync(mark) || !src.includes('DEV_OFFLINE_MOCK') ? [MSG] : [];
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const head = 'export function isOffline() {' + eol;
  if (!src.includes(head)) return ['（server.js 里找不到 isOffline，没补开关）'];
  const hook = 'export function isOffline() {' + eol
    + "  try { if (import.meta.env.DEV && (window.__BRIDGE_DEV_OFFLINE__ === true || new URLSearchParams(location.search).has('offlinemock'))) return true; } catch {}" + eol;
  writeFileSync(f, src.replace(head, hook));
  writeFileSync(mark, MSG);
  return [MSG];
}

async function start() {
  const dir = instDir(NAME);
  const old = readJson(pidFile(NAME));
  if (old) {
    const alive = ['backend', 'vite'].some((r) => old[r]?.pid && isOurs(old[r].pid, r === 'vite' ? VITE_BOOT : BACKEND_BOOT, NAME).ours);
    if (alive && !a.restart) { say(`实例 ${NAME} 已在跑：${old.url}（要重起加 --restart，或先 stop）`); say(JSON.stringify(old, null, 1)); return; }
    await stopInstance(NAME, { quiet: true });
  }
  if (!existsSync(SAMPLES_DIR)) say(`（提醒：样张目录还没有：${SAMPLES_DIR}。先跑 python web/scripts/preview-qa/make-samples.py --out "${SAMPLES_DIR}"）`);
  let apiPort = Number(a['api-port']) || 0, vitePort = Number(a['vite-port']) || 0;
  if (apiPort && !(await portFree(apiPort))) throw new Error('后端端口 ' + apiPort + ' 被占');
  if (vitePort && !(await portFree(vitePort))) throw new Error('vite 端口 ' + vitePort + ' 被占');
  if (!apiPort || !vitePort) {
    // 多实例并存：从 8840 起找连续两个空闲口，跳过别的实例 pid.json 里登记过的口（哪怕它此刻没在听）
    const taken = new Set();
    for (const d of (existsSync(QA_ROOT) ? readdirSync(QA_ROOT) : [])) {
      if (!d.startsWith('inst-')) continue;
      const j = readJson(path.join(QA_ROOT, d, 'pid.json'));
      if (j && d !== 'inst-' + NAME) { taken.add(j.apiPort); taken.add(j.vitePort); }
    }
    let s = 8840;
    for (;;) {
      const [p1, p2] = await findPorts(2, s);
      if (!taken.has(p1) && !taken.has(p2) && (!apiPort || p1 !== apiPort) && (!vitePort || p2 !== vitePort)) { apiPort ||= p1; vitePort ||= p2; break; }
      s = p1 + 2;
    }
  }
  const ttl = Math.max(1, Number(a.ttl) || 60);
  const dataRoot = path.join(dir, 'data');
  const usersRoot = path.join(dir, 'users');
  const viteCache = path.join(dir, 'vite-cache');
  const logs = path.join(dir, 'logs');
  const tmpDir = path.join(dir, 'tmp');   // 后端独占的 TEMP：soffice 的 lo-prof-*、ffmpeg 中间文件都落这里，stop 时整个删
  // --fresh：清掉本实例的数据根与用户根（office-cache 转好的 PDF、thumb-cache 缩略图都在数据根里），量冷启动耗时用；
  // vite 预构建缓存保留（清了只会让首屏慢几十秒，和预览无关）
  if (a.fresh) for (const d of [dataRoot, usersRoot]) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  for (const d of [dataRoot, usersRoot, viteCache, logs, tmpDir, VAULT]) mkdirSync(d, { recursive: true });

  const common = {
    BRIDGE_OVERLAY_DIR: OVERLAY,
    BRIDGE_MODULES_SKIP: 'dimensio,codex',
    BRIDGE_CLAUDE_IN_CHROME: '0',
    BRIDGE_NO_ROUTINES: '1',
  };
  const beEnv = cleanEnv({
    ...common,
    BRIDGE_NO_AUTH: '1',
    PORT: String(apiPort),
    BRIDGE_DATA_ROOT: dataRoot,
    VAULT_PATH: VAULT,
    BRIDGE_USERS_ROOT: usersRoot,
    TEMP: tmpDir, TMP: tmpDir,
  });
  const viteEnv = cleanEnv({ ...common, BRIDGE_API: 'http://127.0.0.1:' + apiPort, STUDIO_QA_VITE_CACHE: viteCache, BRIDGE_DATA_ROOT: dataRoot });

  const snap = a.ref ? snapshot(String(a.ref)) : null;   // 先导出快照再起进程：导出失败不留孤儿
  // --web <目录>：直接用另一份前端源码树（别的 worktree 的 web/、手工解好的快照）；和 --ref 二选一
  const altWeb = !snap && a.web ? path.resolve(String(a.web)) : null;
  if (altWeb && !existsSync(path.join(altWeb, 'scripts', 'studio-qa', 'vite.qa.mjs'))) throw new Error('--web 目录不像 bridge 的 web/（缺 scripts/studio-qa/vite.qa.mjs）：' + altWeb);
  const webDir = snap ? snap.web : altWeb || WEB;
  const beLog = path.join(logs, 'backend.log'), viLog = path.join(logs, 'vite.log');
  const be = spawn(process.execPath, [BACKEND_BOOT, '--qa-name', NAME, '--ttl', String(ttl)], {
    cwd: REPO, env: beEnv, detached: true, windowsHide: true, stdio: ['ignore', openSync(beLog, 'a'), openSync(beLog, 'a')],
  });
  be.unref();
  const vi = spawn(process.execPath, [VITE_BOOT, '--qa-name', NAME, '--port', String(vitePort), '--ttl', String(ttl), ...(webDir !== WEB ? ['--web', webDir] : [])], {
    cwd: webDir, env: viteEnv, detached: true, windowsHide: true, stdio: ['ignore', openSync(viLog, 'a'), openSync(viLog, 'a')],
  });
  vi.unref();
  const t0 = Date.now();
  const info = {
    name: NAME, url: `http://127.0.0.1:${vitePort}/`, apiPort, vitePort, ttlMin: ttl,
    startedAt: new Date(t0).toISOString(), expiresAt: new Date(t0 + ttl * 60_000).toISOString(),
    backend: { pid: be.pid, log: beLog }, vite: { pid: vi.pid, log: viLog },
    dataRoot, usersRoot, vault: VAULT, samples: SAMPLES_DIR, viteCache, overlay: OVERLAY, repo: REPO,
    web: snap ? { ref: String(a.ref), sha: snap.sha, dir: snap.web, patched: snap.patched } : altWeb ? { ref: 'dir', dir: altWeb } : { ref: 'working-tree', dir: WEB },
  };
  writeFileSync(pidFile(NAME), JSON.stringify(info, null, 1));
  try {
    info.backend.readyMs = await waitHttp(`http://127.0.0.1:${apiPort}/healthz`, 120_000, '后端');
    info.vite.readyMs = await waitHttp(info.url, 90_000, 'vite');
    // 首页模块先拉一遍：让 vite 把依赖预构建做完（不然第一次打开页面会中途整页重载）
    try { await fetch(info.url + 'src/main.js', { signal: AbortSignal.timeout(60000) }); } catch {}
  } catch (e) {
    say('启动失败：' + e.message + '\n  后端日志：' + beLog + '\n  vite 日志：' + viLog);
    await stopInstance(NAME, { quiet: true });
    process.exitCode = 1;
    return;
  }
  // 核对：监听端口的就是我们起的 PID
  info.backend.listener = listenerPid(apiPort);
  info.vite.listener = listenerPid(vitePort);
  writeFileSync(pidFile(NAME), JSON.stringify(info, null, 1));
  say(JSON.stringify(info, null, 1));
}

function status() {
  const rows = [];
  for (const d of (existsSync(QA_ROOT) ? readdirSync(QA_ROOT) : [])) {
    if (!d.startsWith('inst-')) continue;
    const name = d.slice(5);
    const j = readJson(pidFile(name));
    if (!j) { rows.push({ name, state: '无 pid.json（已停）' }); continue; }
    const be = isOurs(j.backend?.pid, BACKEND_BOOT, name), vi = isOurs(j.vite?.pid, VITE_BOOT, name);
    rows.push({ name, url: j.url, apiPort: j.apiPort, backend: j.backend?.pid + (be.ours ? ' 在跑' : be.alive ? ' PID 被别的进程占用' : ' 已不在'), vite: j.vite?.pid + (vi.ours ? ' 在跑' : vi.alive ? ' PID 被别的进程占用' : ' 已不在'), expiresAt: j.expiresAt });
  }
  say(JSON.stringify(rows, null, 1));
}

if (cmd === 'start') await start();
else if (cmd === 'stop') {
  if (a.all) { for (const d of (existsSync(QA_ROOT) ? readdirSync(QA_ROOT) : [])) if (d.startsWith('inst-')) await stopInstance(d.slice(5)); }
  else await stopInstance(NAME);
} else if (cmd === 'status') status();
else { say('用法：dev.mjs start|stop|status [--name a]（见 README.md）'); process.exitCode = 2; }
