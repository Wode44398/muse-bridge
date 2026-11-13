#!/usr/bin/env node
// Media Studio 真机条件检测（用法见同目录 README.md）：
//   node web/scripts/studio-qa/run.mjs --url http://127.0.0.1:8822/ --out <目录> [--only p393,d1440] [--states image-,ov-] [--no-shots]
// 每一档视口起一个全新的无头 Edge：触摸仿真 + 移动 UA + 真实 DPR + 注入 --sat/--sab + （可选）系统字号放大；
// 逐个状态复位 → 布置 → 检测（detect.mjs）→ 截图（有问题再截一张带标注的）。输出 report.json + summary.md。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchEdge, openPage, sleep } from './cdp.mjs';
import { DETECT_SRC } from './detect.mjs';
import { HELPERS_SRC } from './helpers.mjs';
import { textZoomScript } from './textzoom.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { PROBE_SRC, checkShot, shotCheckAvailable } from './shotcheck.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));
const URL0 = String(args.url || 'http://127.0.0.1:8822/');
const OUT = path.resolve(String(args.out || 'studio-qa-out'));
const ONLY = args.only ? String(args.only).split(',') : null;
const STATES = args.states ? String(args.states).split(',') : null;
const SHOTS = !args['no-shots'];

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 16; SM-S9370 Build/BP2A.250605.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/155.0.7570.0 Mobile Safari/537.36';
const TAB_UA = 'Mozilla/5.0 (Linux; Android 16; SM-X920 Build/BP2A.250605.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/155.0.7570.0 Safari/537.36';
const phone = { touch: true, mobile: true, ua: PHONE_UA, sat: 40, sab: 20, lang: 'zh', theme: 'light' };
export const MATRIX = [
  { id: 'p393', w: 393, h: 873, dpr: 2.75, ...phone },                         // 维护者的手机（1080×2520 / 2.75）
  { id: 'p393-115', w: 393, h: 873, dpr: 2.75, ...phone, zoom: 1.15 },
  { id: 'p393-130', w: 393, h: 873, dpr: 2.75, ...phone, zoom: 1.3 },
  { id: 'p360', w: 360, h: 780, dpr: 3, ...phone, sat: 32, sab: 18 },          // 窄屏安卓
  { id: 'p360-115', w: 360, h: 780, dpr: 3, ...phone, sat: 32, sab: 18, zoom: 1.15 },
  { id: 'p360-130', w: 360, h: 780, dpr: 3, ...phone, sat: 32, sab: 18, zoom: 1.3 },
  { id: 'fold720', w: 720, h: 900, dpr: 2.5, ...phone, sat: 32, sab: 16 },     // 折叠屏展开
  { id: 't820', w: 820, h: 1180, dpr: 2, ...phone, ua: TAB_UA, mobile: true, sat: 24, sab: 16 },
  { id: 'd1440', w: 1440, h: 900, dpr: 1, touch: false, mobile: false, sat: 0, sab: 0, lang: 'zh', theme: 'light' },
  { id: 'p393-en', w: 393, h: 873, dpr: 2.75, ...phone, lang: 'en' },
  { id: 'p393-dark', w: 393, h: 873, dpr: 2.75, ...phone, theme: 'dark' },
  { id: 'd1440-en', w: 1440, h: 900, dpr: 1, touch: false, mobile: false, sat: 0, sab: 0, lang: 'en', theme: 'light' },
  { id: 'd1440-dark', w: 1440, h: 900, dpr: 1, touch: false, mobile: false, sat: 0, sab: 0, lang: 'zh', theme: 'dark' },   // v3：桌面暗色（纸墨两套都要看）
  { id: 'd1440-desk', w: 1440, h: 900, dpr: 1, touch: false, mobile: false, sat: 0, sab: 0, lang: 'zh', theme: 'light', desk: true },
];

const NOANIM = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}`;
function prelude(cfg) {
  return `(() => {
    try { localStorage.setItem('bridge-theme', ${JSON.stringify(cfg.theme)}); localStorage.setItem('bridge-glass', 'A'); } catch {}
    // 新文档刚建时 <html> 还不存在：等解析器建出根元素（readystatechange → interactive 早于模块脚本执行）再挂，
    // 同 apk 原生注入的写法（根元素 inline style 上的 --sat / --sab）
    let done = false;
    const apply = () => {
      const de = document.documentElement;
      if (!de || done) return;
      done = true;
      de.style.setProperty('--sat', '${cfg.sat}px'); de.style.setProperty('--sab', '${cfg.sab}px');
      const st = document.createElement('style'); st.id = '__qa_noanim'; st.textContent = ${JSON.stringify(NOANIM)};
      (document.head || de).appendChild(st);
    };
    apply();
    if (!done) {
      new MutationObserver((_, ob) => { if (document.documentElement && document.head) { apply(); ob.disconnect(); } }).observe(document, { childList: true, subtree: true });
      document.addEventListener('readystatechange', apply);
    }
  })();`;
}

async function emulate(pg, cfg, over = {}) {
  const c = { ...cfg, ...over };
  await pg.send('Emulation.setDeviceMetricsOverride', { width: c.w, height: c.h, deviceScaleFactor: c.dpr, mobile: !!c.mobile, screenWidth: c.w, screenHeight: c.h });
  if (c.touch) await pg.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  else await pg.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  if (c.ua) await pg.send('Emulation.setUserAgentOverride', { userAgent: c.ua, platform: 'Linux armv8l', userAgentMetadata: { platform: 'Android', platformVersion: '16', architecture: '', model: 'SM-S9370', mobile: !!c.mobile, brands: [{ brand: 'Android WebView', version: '155' }] } });
}

async function settle(pg, cfg) {
  // 触摸仿真会在最后一个指针位置画一个灰色圆点：截图前把指针挪出视口
  try { await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cfg.w + 400, y: cfg.h + 400 }); } catch {}
  await pg.eval(`(async () => {
    const imgs = [...document.images].filter((i) => !i.complete);
    await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))), new Promise((r) => setTimeout(r, 1500))]);
    try { await document.fonts.ready; } catch {}
    // NOANIM 只清得掉 CSS 动画；Svelte 过渡走 Web Animations（Sheet 入场的弹簧），机器忙时量到半路——等有限时长的播完
    const runs = document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime));
    await Promise.race([Promise.all(runs.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 1500))]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
}

async function capture(pg) {
  const r = await pg.send('Page.captureScreenshot', { format: 'jpeg', quality: 72, captureBeyondViewport: false }, 45000);
  return Buffer.from(r.data, 'base64');
}
async function shot(pg, file) { writeFileSync(file, await capture(pg)); }

/** 截图并核对健全性（shotcheck.mjs）：截出来的和 DOM 对不上就强制重新合成再拍，最多再拍两次；
 *  返回 { buf, check, retries, history, probes }——history 记下每次没过的原因，重拍好了也留痕。 */
async function healthyShot(pg) {
  const probes = await pg.eval(`__qaShotProbes()`);
  const history = [], failed = [];
  let buf = null, check = null;
  for (let i = 0; i < 3; i++) {
    if (i) {
      // 强制整页重新合成：根元素挂一帧 translateZ(0) 再撤掉，等两帧
      await pg.eval(`(async () => { const de = document.documentElement; de.style.transform = 'translateZ(0)'; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); de.style.transform = ''; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); await new Promise((r) => setTimeout(r, 300)); return 1; })()`);
    }
    buf = await capture(pg);
    check = await checkShot(buf, probes);
    if (!check || check.ok) return { buf, check, retries: i, history, probes, failed };
    history.push(check.problems.slice(0, 4));
    failed.push(buf);
  }
  return { buf, check, retries: 2, history, probes, failed };
}
// 成因（2026-11-05 实测）：Page.captureScreenshot 取的是合成器当前那一帧；无头 Edge 走软件光栅化，机器一忙（两轮检测并行），
// 刚换过内容的瓦片还没画完就被截下来——没画的瓦片填成底色，或者合成器拿错贴图把顶栏平铺满屏。DOM 是好的，强制重新合成再拍就对。
// 偶发（全矩阵约千分之一到百分之一），所以每张都核对，坏了重拍，重拍两次还坏才算问题；坏的首拍另存 *.shotfail-N.jpg 留证。

async function boot(pg, cfg) {
  const u = new URL(URL0);
  if (cfg.lang && cfg.lang !== 'zh') u.searchParams.set('lang', cfg.lang);
  if (cfg.desk) { u.searchParams.set('fdmock', ''); }
  await pg.send('Page.navigate', { url: u.href });
  await pg.eval(`(async () => { for (let i = 0; i < 200; i++) { if (document.readyState === 'complete' && !document.documentElement.hasAttribute('data-booting') && document.querySelector('#app *, body > div *')) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })()`, { timeout: 30000 });
  await sleep(800);
  await pg.eval(`(async () => { await __qa.init(); __qa.st.ui.screen = 'studio'; await __qa.until(() => document.querySelector('.studio-root .sd-page.on'), 15000, 'Studio 外壳'); await __qa.until(() => __qa.m.studio.catalog, 15000, '模型目录'); return true; })()`, { timeout: 40000 });
  await sleep(600);
}

async function runConfig(cfg, out) {
  const edge = await launchEdge();
  const results = [];
  try {
    const pg = await openPage(edge);
    await emulate(pg, cfg);
    await pg.send('Page.addScriptToEvaluateOnNewDocument', { source: prelude(cfg) });
    if (cfg.zoom && cfg.zoom !== 1) await pg.send('Page.addScriptToEvaluateOnNewDocument', { source: textZoomScript(cfg.zoom) });
    await pg.send('Page.addScriptToEvaluateOnNewDocument', { source: DETECT_SRC + '\n' + HELPERS_SRC + '\n' + PROBE_SRC });
    // vite 第一次见到某些依赖会预构建并整页重载（「Inspected target navigated or closed」），重来一次
    try { await boot(pg, cfg); } catch (e) { process.stdout.write('  启动重试：' + String(e.message || e).slice(0, 80) + '\n'); await sleep(2500); await boot(pg, cfg); }
    const list = SCENARIOS.filter((s) => (!s.only || s.only(cfg)) && (!STATES || STATES.some((p) => s.id.startsWith(p))) && (!cfg.desk || s.id.startsWith('set-')));
    for (const sc of list) {
      const t0 = Date.now();
      const rec = { id: sc.id, title: sc.title, issues: [], error: null, logs: [] };
      pg.logs.length = 0;
      try {
        if (sc.metrics) { await emulate(pg, cfg, { h: sc.metrics.height ?? cfg.h }); await pg.eval(`document.documentElement.style.setProperty('--sab', '${sc.metrics.sab ?? cfg.sab}px')`); await sleep(500); }
        await pg.eval(`(async () => { ${sc.run}\n return true; })()`, { timeout: 30000 });
        await settle(pg, cfg);
        rec.issues = await pg.eval(`__qaDetect({ touch: ${!!cfg.touch} })`);
        if (SHOTS) {
          const base = path.join(out, sc.id);
          const hs = await healthyShot(pg);
          writeFileSync(base + '.jpg', hs.buf);
          hs.failed.forEach((b, k) => writeFileSync(base + '.shotfail-' + (k + 1) + '.jpg', b));
          rec.dom = hs.probes?.dom;
          rec.shot = hs.check ? { ok: hs.check.ok, retries: hs.retries, checked: hs.check.checked, history: hs.history } : { skipped: true };
          // 截图坏掉算问题、不算通过（重拍好了只在 summary 里留痕）
          if (hs.check && !hs.check.ok) rec.issues.push({ type: 'shot', sel: 'screenshot', text: '', rect: { x: 0, y: 0, w: 0, h: 0 }, msg: '截图和页面对不上（重拍两次仍坏）：' + hs.check.problems.slice(0, 3).join('；') });
          if (rec.issues.length) {
            await pg.eval(`__qaMark(${JSON.stringify(rec.issues)})`);
            await shot(pg, base + '.marked.jpg');
            await pg.eval(`__qaMark(null)`);
          }
        }
      } catch (e) {
        rec.error = String(e.message || e).slice(0, 400);
      } finally {
        try { if (sc.cleanup) await pg.eval(`(async () => { ${sc.cleanup}\n return true; })()`); } catch {}
        if (sc.metrics) { try { await emulate(pg, cfg); await pg.eval(`document.documentElement.style.setProperty('--sab', '${cfg.sab}px')`); await sleep(400); } catch {} }
      }
      rec.logs = pg.logs.filter((l) => !/\[vite\]|Download the Svelte|DevTools/.test(l.text)).slice(0, 12);
      rec.ms = Date.now() - t0;
      results.push(rec);
      const n = rec.issues.length;
      const retry = rec.shot?.retries ? `（截图首拍坏，重拍 ${rec.shot.retries} 次${rec.shot.ok ? '后正常' : '仍坏'}）` : '';
      process.stdout.write(`  ${cfg.id} ${sc.id.padEnd(22)} ${rec.error ? '出错：' + rec.error.slice(0, 90) : n ? n + ' 个问题' : '0'}${retry}\n`);
    }
  } finally {
    await edge.close();
  }
  return results;
}

const all = {};
mkdirSync(OUT, { recursive: true });
const cfgs = MATRIX.filter((c) => !ONLY || ONLY.includes(c.id));
for (const cfg of cfgs) {
  const out = path.join(OUT, cfg.id);
  mkdirSync(out, { recursive: true });
  process.stdout.write(`== ${cfg.id}（${cfg.w}×${cfg.h} @${cfg.dpr}${cfg.zoom ? ' 字号 ' + Math.round(cfg.zoom * 100) + '%' : ''}${cfg.lang !== 'zh' ? ' ' + cfg.lang : ''}${cfg.theme === 'dark' ? ' 暗色' : ''}）\n`);
  try { all[cfg.id] = await runConfig(cfg, out); }
  catch (e) { all[cfg.id] = [{ id: '(boot)', issues: [], error: String(e.message || e) }]; process.stdout.write('  启动失败：' + e.message + '\n'); }
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), url: URL0, matrix: cfgs, results: all }, null, 1));
}

// summary.md：每档每个状态的问题计数 + 问题清单
const lines = ['# Media Studio 真机条件检测', '', `时间：${new Date().toLocaleString('zh-CN')}　地址：${URL0}`, ''];
let total = 0;
lines.push('| 档 | 状态数 | 有问题的状态 | 问题数 | 出错 |', '|---|---|---|---|---|');
for (const [id, rs] of Object.entries(all)) {
  const n = rs.reduce((s, r) => s + r.issues.length, 0); total += n;
  lines.push(`| ${id} | ${rs.length} | ${rs.filter((r) => r.issues.length).length} | ${n} | ${rs.filter((r) => r.error).length} |`);
}
lines.push('', `**合计 ${total} 个问题**`, '');
if (SHOTS && !shotCheckAvailable()) lines.push('（没装 sharp：截图健全性没核对）', '');
const retried = Object.entries(all).flatMap(([id, rs]) => rs.filter((r) => r.shot?.retries).map((r) => `${id} / ${r.id}：首拍坏（${(r.shot.history[0] || []).join('；').slice(0, 140)}），重拍 ${r.shot.retries} 次${r.shot.ok ? '后正常' : '仍坏'}`));
if (retried.length) lines.push('## 截图首拍坏、重拍的状态', '', ...retried.map((x) => '- ' + x), '');
for (const [id, rs] of Object.entries(all)) {
  const bad = rs.filter((r) => r.issues.length || r.error);
  if (!bad.length) continue;
  lines.push(`## ${id}`, '');
  for (const r of bad) {
    lines.push(`### ${r.id}　${r.title || ''}`);
    if (r.error) lines.push(`- **出错**：${r.error}`);
    for (const it of r.issues) lines.push(`- \`${it.type}\` ${it.msg}　—　\`${it.sel}\`${it.text ? '「' + it.text + '」' : ''}`);
    lines.push('');
  }
}
writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n'));
process.stdout.write(`\n合计 ${total} 个问题 → ${path.join(OUT, 'summary.md')}\n`);
