#!/usr/bin/env node
// 文件预览场景运行器（用法见同目录 README.md）：
//   node web/scripts/preview-qa/run.mjs --name head [--profiles p393,d1440] [--scenarios open-,swipe-] [--tags baseline] [--out <目录>]
//        [--url http://127.0.0.1:8841/]（不给 --name 时用）[--no-shots] [--local-delay 0] [--timeout 40] [--list] [--resume]
//   --timeout：整体超时（分钟），到点收掉 Edge 退出；--resume：--out 目录里已有 report.json 时，跑完过的档直接沿用、只补没跑的档（长跑中途断了接着跑）。
// 每个视口档起一个全新的无头 Edge（临时 profile，缓存是冷的）；逐个场景：复位 → 跑 → 断言 / 指标 → 截图（JPEG）+ 通用检测。
// 输出：<out>/report.json（全部断言、指标、问题、代码状态）、<out>/summary.md、<out>/<档>/<场景>[-<名>].jpg。
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE, REPO, QA_ROOT, SAMPLES_DIR, SAMPLES_REL, parseArgs, readJson, pidFile, sleep } from './lib/paths.mjs';
import { PROFILES, DEFAULT_PROFILES, newSession, bind, emulate } from './gestures.mjs';
import { installLocalStub } from './localstub.mjs';
import { PVQA_SRC, ROOT_SEL } from './lib/page.mjs';
import { digest } from './lib/digest.mjs';
import { DETECT_SRC } from '../studio-qa/detect.mjs';
import { PROBE_SRC, checkShot, shotCheckAvailable } from '../studio-qa/shotcheck.mjs';

const a = parseArgs(process.argv.slice(2));
const inst = a.name ? readJson(pidFile(String(a.name))) : null;
if (a.name && !inst) { console.error('找不到实例 ' + a.name + ' 的 pid.json：先 node web/scripts/preview-qa/dev.mjs start --name ' + a.name); process.exit(2); }
// 同一实例同时只许一路 runner：两路并跑时 vite / 后端被抢，每个场景截图都多卡约 30 秒，还会串场（--force 硬上）
const LOCK = a.name && !a.list ? path.join(path.dirname(pidFile(String(a.name))), 'runner.lock') : '';
if (LOCK) {
  const held = readJson(LOCK);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  if (held?.pid && held.pid !== process.pid && alive(held.pid) && !a.force) {
    console.error(`实例 ${a.name} 上已有一路 run.mjs 在跑（pid ${held.pid}，${held.at}，输出 ${held.out}）：等它跑完再来，或换个实例；确认是残留锁可加 --force`);
    process.exit(2);
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), out: String(a.out || '') }));
  const drop = () => { try { if (readJson(LOCK)?.pid === process.pid) unlinkSync(LOCK); } catch {} };
  process.on('exit', drop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { drop(); process.exit(130); });
}
const URL0 = String(a.url || inst?.url || '');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(String(a.out || path.join(QA_ROOT, 'runs', stamp)));
const SHOTS = !a['no-shots'];
const PROFILE_IDS = a.profiles ? String(a.profiles).split(',') : DEFAULT_PROFILES;
const PREFIX = a.scenarios ? String(a.scenarios).split(',') : null;
const TAGS = a.tags ? String(a.tags).split(',') : null;
const LOCAL_DELAY = Number(a['local-delay'] || 0);
const TIMEOUT_MIN = Number(a.timeout || 40);

// —— 场景加载：scenarios/*.mjs（_ 开头的是模板，不加载），每个文件 export default 一个场景或数组 ——
async function loadScenarios() {
  const dir = path.join(HERE, 'scenarios');
  const list = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort()) {
    const m = await import(pathToFileURL(path.join(dir, f)).href);
    for (const s of [].concat(m.default || [])) list.push({ mode: 'web', tags: [], timeout: 90000, ...s, file: f });
  }
  const ids = new Set();
  for (const s of list) { if (ids.has(s.id)) throw new Error('场景 id 重复：' + s.id); ids.add(s.id); }
  return list;
}
const SC = await loadScenarios();
if (a.list) {
  for (const s of SC) console.log(`${s.id.padEnd(28)} ${String(s.mode).padEnd(8)} [${(s.tags || []).join(',')}] ${s.title || ''}${s.profiles ? '  档：' + s.profiles.join(',') : ''}`);
  process.exit(0);
}
if (!URL0) { console.error('缺 --name 或 --url'); process.exit(2); }

// 整体超时自杀（收尾见 finally；这里是兜底）
const live = new Set();
const killer = setTimeout(async () => { console.error(`整体超时 ${TIMEOUT_MIN} 分钟，收掉 Edge 退出`); for (const s of live) { try { await s.close(); } catch {} } process.exit(3); }, TIMEOUT_MIN * 60_000);
killer.unref();

function codeState() {
  const st = { repo: REPO, head: '', dirty: [] };
  try { st.head = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  try { st.dirty = execFileSync('git', ['-C', REPO, 'status', '--short', '--', 'web/src'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch {}
  st.frontend = inst?.web?.sha ? `git 快照 ${inst.web.sha}（不受工作区改动影响${inst.web.patched?.length ? '；补丁：' + inst.web.patched.join('、') : ''}）`
    : inst?.web?.ref === 'dir' ? `目录 ${inst.web.dir}` : '工作区（含未提交改动，见 dirty）';
  if (inst?.web?.sha || inst?.web?.ref === 'dir') st.dirty = [];   // 快照 / 外部目录：本树的未提交改动与它无关
  return st;
}

async function bootApp(pg, cfg) {
  const u = new URL(URL0);
  if (cfg.lang && cfg.lang !== 'zh') u.searchParams.set('lang', cfg.lang);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 冷 vite（第一次见到快照 / 新依赖）首屏可能要几十秒：导航与等待都放宽
      await pg.send('Page.navigate', { url: u.href }, 90000);
      await pg.eval(`(async () => { for (let i = 0; i < 900; i++) { if (document.readyState === 'complete' && !document.documentElement.hasAttribute('data-booting') && document.querySelector('#app *, body > div *')) return true; await new Promise((r) => setTimeout(r, 100)); } throw new Error('页面没起来'); })()`, { timeout: 100000 });
      await sleep(600);
      await pg.eval(`__pvqa.init()`, { timeout: 30000 });
      // 坑：新文档上的第一下输入，浏览器的命中测试会落到 <html> 上（实测点按、触摸都一样；一秒多以后或先有一次鼠标移动就正常）。
      // 先在角上发一次 mouseMoved「暖」一下命中测试，再把指针挪出视口（不留 hover 态）。
      try { await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }); await sleep(100); await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cfg.w + 400, y: cfg.h + 400 }); } catch {}
      return;
    } catch (e) {
      // vite 第一次见到某些依赖会预构建并整页重载（「Inspected target navigated or closed」），重来一次
      if (attempt) throw e;
      process.stdout.write('  启动重试：' + String(e.message || e).slice(0, 80) + '\n');
      await sleep(2500);
    }
  }
}

async function settle(pg, cfg) {
  try { await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cfg.w + 400, y: cfg.h + 400 }); } catch {}
  await pg.eval(`(async () => {
    const imgs = [...document.images].filter((i) => !i.complete && i.loading !== 'lazy');
    await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))), new Promise((r) => setTimeout(r, 2000))]);
    try { await document.fonts.ready; } catch {}
    const runs = document.getAnimations().filter((x) => x.playState === 'running' && Number.isFinite(x.effect?.getComputedTiming?.().endTime));
    await Promise.race([Promise.all(runs.map((x) => x.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 1500))]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return true;
  })()`, { timeout: 15000 }).catch(() => {});
}

async function capture(pg) {
  const r = await pg.send('Page.captureScreenshot', { format: 'jpeg', quality: 72, captureBeyondViewport: false }, 45000);
  return Buffer.from(r.data, 'base64');
}
/** 截图并核对健全性（shotcheck.mjs）：对不上就强制重新合成再拍，最多再拍两次 */
async function healthyShot(pg) {
  const probes = await pg.eval(`__qaShotProbes()`).catch(() => null);
  let buf = null, check = null;
  const history = [];
  for (let i = 0; i < 3; i++) {
    if (i) await pg.eval(`(async () => { const de = document.documentElement; de.style.transform = 'translateZ(0)'; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); de.style.transform = ''; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); await new Promise((r) => setTimeout(r, 300)); return 1; })()`).catch(() => {});
    buf = await capture(pg);
    check = probes ? await checkShot(buf, probes) : null;
    if (!check || check.ok) return { buf, check, retries: i, history };
    history.push(check.problems.slice(0, 3));
  }
  return { buf, check, retries: 2, history };
}

// 通用检测（studio-qa/detect.mjs）对查看器的已知误报：
// - PDF / 演示文稿（pdf.js 渲染）的文字层：透明 span 按字形盒子叠放，本来就压在画布上，选字用，看不见
// - 表格网格 .sg-scroll：宽表自己横向滚动是设计如此
function benignIssue(it) {
  const sel = String(it?.sel || '');
  if (it?.type === 'overlap' && /\.textLayer\b|\bspan\.markedContent\b/.test(sel)) return true;
  if (it?.type === 'hscroll' && /\bsg-scroll\b/.test(sel)) return true;
  return false;
}

/** 场景上下文：场景只通过它做事（模板见 scenarios/_template.mjs） */
function makeCtx({ pg, cfg, sc, rec, outDir, local }) {
  const g = bind(pg, cfg);
  const ctx = {
    pg, cfg, g, local, sc, outDir,
    touch: !!cfg.touch, ROOT_SEL,
    samplesDir: SAMPLES_DIR, samplesRel: SAMPLES_REL,
    opts: { localDelay: LOCAL_DELAY },
    sleep,
    eval: (expr, o) => pg.eval(expr, o),
    /** 样张相对路径 → 查看器描述符（同 FilesPanel.srcItem）。origin 缺省：apk 模式 local、否则 cloud */
    item(rel, { origin, kind } = {}) {
      const o = origin || (local ? 'local' : 'cloud');
      const abs = path.join(SAMPLES_DIR, rel);
      const mt = existsSync(abs) ? statSync(abs).mtimeMs : 0;
      const name = rel.split('/').pop();
      const d = o === 'local' ? { origin: 'local', rel: local.rel(rel), name, mt } : { origin: 'cloud', rel: SAMPLES_REL + '/' + rel, name, mt, ws: '', nativeLocation: '' };
      if (kind) d.kind = kind;
      return d;
    },
    /** 样张某个目录下的条目（按名字排序；filter 用正则或函数） */
    gallery(dir, { origin, kind = 'image', filter = /\.(jpe?g|png|gif|webp|svg)$/i } = {}) {
      const names = readdirSync(path.join(SAMPLES_DIR, dir)).filter((n) => (typeof filter === 'function' ? filter(n) : filter.test(n))).sort();
      return names.map((n) => ctx.item(dir + '/' + n, { origin, kind }));
    },
    /** 打开查看器（同 FilesPanel：openPreview(items, index)），等到查看器根出现 */
    async open(items, index = 0) {
      await pg.eval(`(async () => { __pvqa.pv.openPreview(${JSON.stringify(items)}, ${index}); await __pvqa.until(() => __pvqa.root(), 8000, '查看器根 ${ROOT_SEL}'); return true; })()`, { timeout: 15000 });
    },
    async close() { await pg.eval(`(() => { try { __pvqa.pv.closePreview(); } catch {} return true; })()`).catch(() => {}); },
    /** 等页面里的表达式为真（表达式可 await），返回它的值 */
    async waitFor(expr, ms = 10000, what = '') {
      return pg.eval(`__pvqa.until(async () => (${expr}), ${ms}, ${JSON.stringify(what || expr.slice(0, 60))})`, { timeout: ms + 5000 });
    },
    /** 断言。level：'must'（必须过，默认）| 'goal'（改版目标，基线上不过是预期的）| 'info'（只记录） */
    assert(name, ok, value, { level = 'must', expect } = {}) { rec.asserts.push({ name, ok: !!ok, value, level, ...(expect != null ? { expect } : {}) }); return !!ok; },
    metric(name, value) { rec.metrics[name] = value; },
    /** 截图（JPEG）+ 通用检测（越界 / 裁切 / 命中区 / 安全区，限定在查看器根里；没有根就查全页） */
    async shot(name = '') {
      // 截图前把自己的页面拉回前台：后台标签页 rAF 降到 1Hz，captureScreenshot 会卡满超时
      try { await pg.send('Page.bringToFront', {}, 5000); } catch {}
      await settle(pg, cfg);
      const scope = (await pg.eval(`!!__pvqa.root()`).catch(() => false)) ? ROOT_SEL : null;
      const raw = await pg.eval(`__qaDetect(${JSON.stringify({ touch: !!cfg.touch, ...(scope ? { scope } : {}) })})`).catch((e) => [{ type: 'detect', msg: String(e.message || e) }]);
      const issues = raw.filter((it) => !benignIssue(it));
      if (raw.length > issues.length) rec.metrics._exempt = (rec.metrics._exempt || 0) + raw.length - issues.length;
      if (cfg.touch && scope) {
        for (const s of await pg.eval(`__pvqa.smallTargets(44)`).catch(() => [])) issues.push({ type: 'tap44', sel: s.sel, text: s.label, msg: `触屏命中区 ${s.w}×${s.h} < 44` });
      }
      const tag = sc.id + (name ? '-' + name : '');
      for (const it of issues) rec.issues.push({ at: tag, ...it });
      if (!SHOTS) return null;
      const hs = await healthyShot(pg);
      const file = path.join(outDir, tag + '.jpg');
      writeFileSync(file, hs.buf);
      rec.shots.push({ file: path.relative(OUT, file), retries: hs.retries, ok: hs.check ? hs.check.ok : null });
      if (hs.check && !hs.check.ok) rec.issues.push({ at: tag, type: 'shot', msg: '截图和页面对不上（重拍两次仍坏）：' + hs.check.problems.slice(0, 3).join('；') });
      return file;
    },
    /** 环境：{ cpu: 4, network: '4g' | null, cache: false } —— 场景结束时运行器自动复原 */
    async throttle({ cpu, network, cache } = {}) {
      if (cpu != null) await g.cpu(cpu);
      if (network !== undefined) await g.network(network);
      if (cache != null) await g.cacheDisabled(!cache);
    },
  };
  return ctx;
}

async function runProfile(pid, results = [], onRec = () => {}) {
  const cfg = PROFILES[pid];
  if (!cfg) throw new Error('未知视口档 ' + pid);
  const outDir = path.join(OUT, pid);
  mkdirSync(outDir, { recursive: true });
  // 同模式的排在一起，少换几次页面；isolate:true 的场景（会把输入通道弄脏的，如触屏长按）排到最后、各自单开会话
  const list = SC.filter((s) => (!s.profiles || s.profiles.includes(pid)) && (!s.only || s.only(cfg)) && (!PREFIX || PREFIX.some((p) => s.id.startsWith(p))) && (!TAGS || TAGS.some((t) => (s.tags || []).includes(t))))
    .sort((x, y) => (!!x.isolate - !!y.isolate) || String(x.mode).localeCompare(String(y.mode)));
  if (!list.length) return results;
  let sess = null, pg = null, mode = null, local = null;
  const strays = [];
  const openSess = async () => {
    sess = await newSession(cfg);
    live.add(sess);
    pg = sess.pg;
    await pg.send('Page.addScriptToEvaluateOnNewDocument', { source: DETECT_SRC + '\n' + PROBE_SRC + '\n' + PVQA_SRC });
    mode = null;
  };
  const dropSess = async () => {
    if (local) { try { await local.uninstall(); } catch {} local = null; }
    if (!sess) return;
    strays.push(...(sess.strays || []));
    try { await sess.close(); } catch {}
    live.delete(sess);
    sess = null; pg = null; mode = null;
  };
  // 输入通道体检：上一个场景留下没回执的鼠标 / 触摸事件时，之后每个 Input.dispatch* 都要等满 30 秒超时
  const inputOk = async () => { try { await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cfg.w + 400, y: cfg.h + 400 }, 3000); return true; } catch { return false; } };
  const localKey = (sc) => String(sc.mode) + (sc.local ? JSON.stringify(sc.local) : '');
  try {
    await openSess();
    let prevIsolate = false;
    for (const sc of list) {
      const rec = { id: sc.id, title: sc.title || '', mode: sc.mode, file: sc.file, asserts: [], metrics: {}, issues: [], shots: [], error: null, logs: [] };
      let t0 = Date.now();
      // 场景超时后撤掉它对页面的操作权：还在后台跑的 sc.run 下一次 send / eval 直接抛错，不会串到下一个场景里去
      const guard = { off: false };
      try {
        if (sc.isolate || prevIsolate || !(await inputOk())) {
          if (!sc.isolate && !prevIsolate) rec.metrics._inputReset = true;
          await dropSess();
          await openSess();
        }
        prevIsolate = !!sc.isolate;
        // 模式：'web' = 普通网页（云端文件）；'apk' / 'apk:<延迟毫秒>' = 装本地桩（离线壳 + 手机本地文件）；'apk2…' = 本地桩 + 新 apk 原生能力（localstub v2）
        // sc.local：额外的桩选项（如 { preview: true } = 旧 apk 桩也宣称有本地预览档）
        if (localKey(sc) !== mode) {
          if (local) { await local.uninstall(); local = null; }
          if (String(sc.mode).startsWith('apk')) {
            const d = String(sc.mode).split(':')[1];
            local = await installLocalStub(pg, { delayMs: d != null ? Number(d) : LOCAL_DELAY, v2: String(sc.mode).startsWith('apk2'), ...(sc.local || {}) });
          }
          await bootApp(pg, cfg);
          mode = localKey(sc);
          rec.bootMs = Date.now() - t0;   // 冷 vite 首屏可能几十秒到几分钟：单独记，不算进场景耗时
          t0 = Date.now();
        } else {
          await pg.eval(`(() => { try { __pvqa.pv.closePreview(); } catch {} return true; })()`).catch(() => {});
          await sleep(300);
        }
        pg.logs.length = 0;
        const sp = new Proxy(pg, { get: (t, k) => ((k === 'send' || k === 'eval') && typeof t[k] === 'function' ? (...args) => (guard.off ? Promise.reject(new Error('场景已超时取消')) : t[k](...args)) : t[k]) });
        const ctx = makeCtx({ pg: sp, cfg, sc, rec, outDir, local });
        let timer;
        await Promise.race([sc.run(ctx), new Promise((_, rej) => { timer = setTimeout(() => { guard.off = true; rej(new Error('场景超时 ' + sc.timeout + 'ms')); }, sc.timeout); })]).finally(() => clearTimeout(timer));
        if (local) rec.metrics.localServer = { requests: local.server.stats.requests, byKind: { ...local.server.stats.byKind }, thumbMiss: local.server.stats.thumbMiss };
      } catch (e) {
        guard.off = true;
        rec.error = String(e.message || e).slice(0, 500);
        if (SHOTS && pg) { try { writeFileSync(path.join(outDir, sc.id + '.error.jpg'), await capture(pg)); rec.shots.push({ file: path.join(pid, sc.id + '.error.jpg'), error: true }); } catch {} }
      } finally {
        // 复原：关查看器、取消降速 / 限网 / 禁缓存
        if (pg) {
          try { await pg.send('Emulation.setCPUThrottlingRate', { rate: 1 }); } catch {}
          try { await pg.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); } catch {}
          try { await pg.send('Network.setCacheDisabled', { cacheDisabled: false }); } catch {}
          try { if (sc.cleanup) await sc.cleanup(makeCtx({ pg, cfg, sc, rec, outDir, local })); } catch {}
        }
        if (local) local.server.stats.requests = 0, local.server.stats.byKind = {}, local.server.stats.thumbMiss = 0, local.server.stats.log.length = 0;
      }
      rec.logs = (pg?.logs || []).filter((l) => !/\[vite\]|Download the Svelte|DevTools/.test(l.text)).slice(0, 12);
      rec.ms = Date.now() - t0;
      const must = rec.asserts.filter((x) => x.level === 'must');
      rec.ok = !rec.error && must.every((x) => x.ok);
      results.push(rec);
      onRec();   // 每个场景跑完就落盘：中途断了 report.json 里也有已跑完的部分
      const goals = rec.asserts.filter((x) => x.level === 'goal');
      process.stdout.write(`  ${pid.padEnd(10)} ${sc.id.padEnd(28)} ${rec.error ? '出错：' + rec.error.slice(0, 100) : (rec.ok ? '通过' : '不过：' + must.filter((x) => !x.ok).map((x) => x.name).join('、'))}`
        + `${goals.length ? `　目标 ${goals.filter((x) => x.ok).length}/${goals.length}` : ''}${rec.issues.length ? `　问题 ${rec.issues.length}` : ''}${rec.metrics._inputReset ? '　（输入卡住，重开了会话）' : ''}　${(rec.ms / 1000).toFixed(1)}s\n`);
    }
  } finally {
    await dropSess();
    if (strays.length) { (report.strays ||= {})[pid] = strays.slice(0, 20); process.stdout.write(`  （关掉了 ${strays.length} 个不请自来的标签页：${strays.slice(0, 3).join('、')}）\n`); }
  }
  return results;
}

mkdirSync(OUT, { recursive: true });
const report = { at: new Date().toISOString(), url: URL0, instance: inst ? { name: inst.name, apiPort: inst.apiPort, vitePort: inst.vitePort, web: inst.web } : null, code: codeState(), profiles: PROFILE_IDS, opts: { localDelay: LOCAL_DELAY, shots: SHOTS, scenarios: PREFIX, tags: TAGS }, results: {} };
// --resume：沿用旧报告里已完整跑完的档（档内没有 (boot) 启动失败）；前端来源对不上就拒绝，免得把两份代码的结果拼在一起
const prev = a.resume ? readJson(path.join(OUT, 'report.json')) : null;
if (prev) {
  const same = JSON.stringify(prev.instance?.web || null) === JSON.stringify(report.instance?.web || null) && JSON.stringify(prev.opts?.scenarios || null) === JSON.stringify(PREFIX) && JSON.stringify(prev.opts?.tags || null) === JSON.stringify(TAGS);
  if (!same) { console.error('--resume：旧报告的前端来源或 --scenarios / --tags 和这次不一样，不拼接（换个 --out，或去掉 --resume）'); process.exit(2); }
  report.at = prev.at; report.resumedAt = [...(prev.resumedAt || []), new Date().toISOString()];
  for (const [p, rs] of Object.entries(prev.results || {})) if (PROFILE_IDS.includes(p) && (prev.done || []).includes(p) && !rs.some((x) => x.id === '(boot)')) report.results[p] = rs;
  report.done = (prev.done || []).filter((p) => report.results[p]);
}
const save = () => writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
for (const pid of PROFILE_IDS) {
  const c = PROFILES[pid];
  if (report.results[pid]) { process.stdout.write(`== ${pid}：沿用旧报告（${report.results[pid].length} 项，--resume）\n`); continue; }
  process.stdout.write(`== ${pid}${c ? `（${c.w}×${c.h} @${c.dpr}${c.touch ? ' 触摸' : ''}${c.theme === 'dark' ? ' 暗色' : ''}）` : ''}\n`);
  report.results[pid] = [];
  try { await runProfile(pid, report.results[pid], save); (report.done ||= []).push(pid); }
  catch (e) { report.results[pid].push({ id: '(boot)', error: String(e.message || e), asserts: [], metrics: {}, issues: [] }); process.stdout.write('  启动失败：' + e.message + '\n'); }
  save();
}

// —— summary.md ——
const L = ['# 文件预览场景检测', '', `时间：${new Date().toLocaleString('zh-CN')}　地址：${URL0}`, `代码：HEAD ${report.code.head}；前端 ${report.code.frontend}`, ''];
if (report.code.dirty.length) L.push('工作区 web/src 未提交改动：', '', ...report.code.dirty.map((x) => '- `' + x + '`'), '');
L.push('| 档 | 场景 | 结果 | 目标 | 问题 | 关键指标 |', '|---|---|---|---|---|---|');
const fmt = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v));
let nBad = 0;
for (const [pid, rs] of Object.entries(report.results)) {
  for (const r of rs) {
    if (!r.ok) nBad++;
    const goals = (r.asserts || []).filter((x) => x.level === 'goal');
    const keys = Object.entries(r.metrics || {}).filter(([k]) => k !== 'localServer' && !k.startsWith('_')).slice(0, 5).map(([k, v]) => `${k}=${fmt(v)}`).join('；');
    L.push(`| ${pid} | ${r.id} | ${r.error ? '出错' : r.ok ? '通过' : '不过'} | ${goals.length ? goals.filter((x) => x.ok).length + '/' + goals.length : ''} | ${(r.issues || []).length || ''} | ${keys.replace(/\|/g, '/')} |`);
  }
}
L.push('', `**不过 / 出错 ${nBad} 项**`, '');
const dg = digest(report);
if (dg.length) L.push('## 数值摘要', '', ...dg);
if (SHOTS && !shotCheckAvailable()) L.push('（没装 sharp：截图健全性没核对）', '');
for (const [pid, rs] of Object.entries(report.results)) {
  const bad = rs.filter((r) => r.error || (r.asserts || []).some((x) => !x.ok) || (r.issues || []).length);
  if (!bad.length) continue;
  L.push(`## ${pid}`, '');
  for (const r of bad) {
    L.push(`### ${r.id}　${r.title || ''}`);
    if (r.error) L.push(`- **出错**：${r.error}`);
    for (const x of r.asserts || []) if (!x.ok) L.push(`- ${x.level === 'goal' ? '目标未达' : x.level === 'info' ? '记录' : '**断言不过**'}：${x.name} = \`${fmt(x.value)}\`${x.expect != null ? '（期望 ' + fmt(x.expect) + '）' : ''}`);
    const byType = {};
    for (const it of r.issues || []) (byType[it.type] ||= []).push(it);
    for (const [t, its] of Object.entries(byType)) L.push(`- \`${t}\` ×${its.length}：${its.slice(0, 4).map((it) => `${it.msg || ''}${it.sel ? ' `' + it.sel + '`' : ''}${it.text ? '「' + String(it.text).slice(0, 16) + '」' : ''}`).join('；')}`);
    L.push('');
  }
}
writeFileSync(path.join(OUT, 'summary.md'), L.join('\n'));
save();
clearTimeout(killer);
process.stdout.write(`\n报告：${path.join(OUT, 'report.json')}\n摘要：${path.join(OUT, 'summary.md')}\n`);
