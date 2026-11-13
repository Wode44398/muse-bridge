#!/usr/bin/env node
// Media Studio 真实操作流（真后端、真点按、真上传；用法见 README.md）：
//   node web/scripts/studio-qa/flows.mjs --url http://127.0.0.1:8822/ --out <目录> --files <放测试图的目录> [--gen] [--only upload,paste,…]
// 每一步都用 CDP 的触摸事件点（Input.dispatchTouchEvent），系统选择器走 Page.setInterceptFileChooserDialog 真塞文件，
// 粘贴派真的 ClipboardEvent、桌面拖入派真的 DragEvent、工作空间拖入是抽屉「文件」里按住 → 拖到输入框 → 松手。
// 不带 --gen 只验到「素材挂上、上传落盘、发给后端的是相对名」为止，不花钱；带 --gen 才真生成（图像 Lite 1K，最多 3 张）。
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { launchEdge, openPage, sleep } from './cdp.mjs';
import { DETECT_SRC } from './detect.mjs';
import { HELPERS_SRC } from './helpers.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));
const URL0 = String(args.url || 'http://127.0.0.1:8822/');
const OUT = path.resolve(String(args.out || 'studio-qa-flows'));
const FILES = path.resolve(String(args.files || '.'));
const GEN = !!args.gen;
const ONLY = args.only ? String(args.only).split(',') : null;
const LITE = String(args.model || 'gemini-3.1-flash-lite-image');
mkdirSync(OUT, { recursive: true });

const picks = readdirSync(FILES).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
if (!picks.length) throw new Error('--files 目录里没有图片');
const photo = path.join(FILES, picks.find((f) => /\.jpe?g$/i.test(f)) || picks[0]);
const pastePng = path.join(FILES, picks.find((f) => /\.png$/i.test(f)) || picks[0]);

const PHONE = { w: 393, h: 873, dpr: 2.75, sat: 40, sab: 20 };
const log = [];
const say = (s) => { log.push(s); process.stdout.write(s + '\n'); };

async function setup(pg, cfg) {
  // vite 第一次见到某些依赖会预构建并整页重载：失败就重来一次（脚本注入只装一回）
  try { await setupOnce(pg, cfg, true); } catch (e) { say('  启动重试：' + String(e.message || e).slice(0, 80)); await sleep(2500); await setupOnce(pg, cfg, false); }
}
async function setupOnce(pg, cfg, first) {
  await pg.send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: cfg.dpr, mobile: !!cfg.touch, screenWidth: cfg.w, screenHeight: cfg.h });
  await pg.send('Emulation.setTouchEmulationEnabled', cfg.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  if (first) await pg.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { try { localStorage.setItem('bridge-theme', 'light'); } catch {}
    const ap = () => { const de = document.documentElement; if (!de) return false; de.style.setProperty('--sat', '${cfg.sat}px'); de.style.setProperty('--sab', '${cfg.sab}px'); return true; };
    if (!ap()) document.addEventListener('readystatechange', ap); })();` + DETECT_SRC + HELPERS_SRC });
  await pg.send('Page.setInterceptFileChooserDialog', { enabled: true });
  await pg.send('DOM.enable');
  await pg.send('Page.navigate', { url: URL0 });
  await pg.eval(`(async () => { for (let i = 0; i < 200; i++) { if (document.readyState === 'complete' && !document.documentElement.hasAttribute('data-booting')) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })()`);
  await sleep(800);
  await pg.eval(`(async () => { await __qa.init(); __qa.st.ui.screen = 'studio'; await __qa.until(() => document.querySelector('.studio-root .sd-page.on'), 15000); await __qa.until(() => __qa.m.studio.catalog, 15000); return true; })()`);
  await sleep(500);
}

/** 元素中心（先滚进视口）；sel 可带 text：在匹配的元素里找文字 */
async function center(pg, sel, text = null) {
  const r = await pg.eval(`(async () => { const el = await __qa.until(() => __qa.find(${JSON.stringify(sel)}, ${JSON.stringify(text)}), 8000, ${JSON.stringify(sel + ' ' + (text || ''))});
    el.scrollIntoView({ block: 'center' });
    // 等位置稳定（sheet / 菜单的入场动画还在跑时点下去会落空）：连续两帧不动才算
    let prev = null; for (let i = 0; i < 40; i++) { await new Promise((r) => requestAnimationFrame(r)); const b = el.getBoundingClientRect(); const k = Math.round(b.left) + ',' + Math.round(b.top); if (k === prev) break; prev = k; await __qa.sleep(40); }
    const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  return r;
}
async function tap(pg, sel, text = null) {
  const { x, y } = await center(pg, sel, text);
  await pg.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await sleep(60);
  await pg.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(350);
}
async function click(pg, sel, text = null) {
  const { x, y } = await center(pg, sel, text);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await pg.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await sleep(350);
}
async function shot(pg, name) {
  const r = await pg.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 }, 45000);
  writeFileSync(path.join(OUT, name + '.jpg'), Buffer.from(r.data, 'base64'));
}
const draft = (pg, page = 'image') => pg.eval(`JSON.parse(JSON.stringify(__qa.m.studio.drafts['${page}'].inputs.map((x) => ({ role: x.role, upload: x.upload, path: x.path, asset: x.asset, pending: x.pending, name: x.name }))))`);
async function uploadedOk(pg, rel) {
  if (!rel || /[\\/]/.test(rel) || /^[a-z]:/i.test(rel)) return { ok: false, why: 'upload 不是 uploads 里的相对名：' + rel };
  const st = await pg.eval(`fetch('/api/upload/raw?name=' + encodeURIComponent(${JSON.stringify(rel)})).then((r) => r.status)`);
  return st === 200 ? { ok: true } : { ok: false, why: '/api/upload/raw 回 ' + st };
}
async function waitInputs(pg, page, n) {
  await pg.eval(`__qa.until(() => { const a = __qa.m.studio.drafts['${page}'].inputs; return a.length >= ${n} && a.every((x) => !x.pending); }, 20000, '素材上传')`);
}
async function useLite(pg) {
  const key = await pg.eval(`(() => { const m = __qa.m.modelsOf('image').find((x) => x.id === ${JSON.stringify(LITE)}); if (m) __qa.m.setModel('image', m.key); return m?.key || ''; })()`);
  if (!key) throw new Error('目录里没有 ' + LITE);
  // 1K：比例自动、尺寸 1K
  await pg.eval(`(() => { const m = __qa.m.currentModel('image'); for (const p of m.params || []) { if (p.key === 'imageSize' && (p.options || []).some((o) => o.value === '1K')) __qa.m.setParam('image', 'imageSize', '1K'); } })()`);
  return key;
}
async function typeAndSend(pg, text) {
  await tap(pg, '.sd-page.on .cp-field');
  await pg.send('Input.insertText', { text });
  await sleep(300);
  const n0 = await pg.eval(`__qa.m.studio.jobs.length`);
  const dis = await pg.eval(`!!document.querySelector('.studio-root .sd-page.on .cp-send')?.disabled`);
  if (dis) throw new Error('发送钮是灰的（素材还在上传 / 当前模型不收这份素材？）');
  await tap(pg, '.sd-page.on .cp-send');
  await pg.eval(`__qa.until(() => __qa.m.studio.jobs.length > ${n0}, 8000, '点发送后建出任务')`);
}
async function waitDone(pg, timeout = 120000) {
  const r = await pg.eval(`(async () => { const t0 = Date.now(); for (;;) { const turns = __qa.m.studio.views.image.turns; const last = turns[turns.length - 1];
      if (last && last.jobId) { const j = __qa.m.studio.jobs.find((x) => x.id === last.jobId); if (j && (j.state === 'done' || j.state === 'error' || j.state === 'canceled')) return { state: j.state, error: j.error || '', n: (j.result || []).length, inputs: j.inputs, ms: Date.now() - t0 }; }
      if (Date.now() - t0 > ${timeout}) return { state: 'timeout' }; await __qa.sleep(500); } })()`, { timeout: timeout + 10000 });
  return r;
}

const results = [];
async function step(id, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  const t0 = Date.now();
  try { const r = await fn(); const ok = r?.ok !== false; results.push({ id, ...r, ok, ms: Date.now() - t0 }); say(`${ok ? '✔' : '✘'} ${id} ${r?.note || ''}`); }
  catch (e) { results.push({ id, ok: false, error: String(e.message || e).slice(0, 300) }); say(`✘ ${id} ${e.message}`); }
}

const edge = await launchEdge();
let gens = 0;
try {
  const pg = await openPage(edge);
  let chooser = null;
  pg.conn.on('Page.fileChooserOpened', (p, sid) => { if (sid === pg.sessionId) chooser = p; });
  await setup(pg, { ...PHONE, touch: true });

  // ① 从相册上传：＋ → 改这张图 → 这台设备 → 系统选择器塞一张手机照片
  await step('upload', async () => {
    await pg.eval(`__qa.reset({ page: 'image' })`);
    await tap(pg, '.sd-page.on .cp-ib');
    await sleep(500);
    const roles = await pg.eval(`[...document.querySelectorAll('.studio-root .op')].filter((b) => __qa.vis(b)).map((b) => b.textContent.trim())`);
    if (roles.some((x) => /改这张图|改图/.test(x))) await tap(pg, '.studio-root .op', roles.find((x) => /改这张图|改图/.test(x)).slice(0, 3));
    await sleep(400);
    chooser = null;
    await tap(pg, '.studio-root .op', '这台设备');
    for (let i = 0; i < 40 && !chooser; i++) await sleep(100);
    if (!chooser) throw new Error('系统文件选择器没弹出来');
    await pg.send('DOM.setFileInputFiles', { files: [photo], backendNodeId: chooser.backendNodeId });
    await waitInputs(pg, 'image', 1);
    const ins = await draft(pg);
    const chk = await uploadedOk(pg, ins[0]?.upload);
    await shot(pg, '01-upload');
    if (!chk.ok) return { ok: false, note: chk.why, inputs: ins };
    return { note: '挂上「' + ins[0].role + '」，upload=' + ins[0].upload, inputs: ins };
  });

  // ② 用上传的图当素材改图（真打一张 Lite 1K）
  await step('gen-edit', async () => {
    if (!GEN) return { note: '（没带 --gen，跳过真生成）' };
    await useLite(pg);
    if (!(await draft(pg)).some((x) => x.upload)) return { ok: false, note: '上一步没挂上上传的图，不发' };
    await typeAndSend(pg, '把天空改成黄昏的橙色，其它不动');
    gens++;
    const r = await waitDone(pg);
    await sleep(1500);
    await shot(pg, '02-gen-edit');
    if (r.state !== 'done') return { ok: false, note: '任务 ' + r.state + ' ' + (r.error || ''), job: r };
    return { note: '出图 ' + r.n + ' 张，' + Math.round(r.ms / 1000) + 's，任务里的素材 ' + JSON.stringify(r.inputs), job: r };
  });

  // ③ 续改：接着说「再加…」
  await step('gen-continue', async () => {
    if (!GEN) return { note: '（没带 --gen，跳过）' };
    if (!(await pg.eval(`__qa.m.studio.views.image.turns.some((t) => t.assets?.length)`))) return { ok: false, note: '画布上还没有上一轮的图，不续改' };
    await typeAndSend(pg, '再在天空里加一只白色的海鸥');
    gens++;
    const r = await waitDone(pg);
    await sleep(1500);
    await shot(pg, '03-gen-continue');
    const turns = await pg.eval(`__qa.m.studio.views.image.turns.length`);
    if (r.state !== 'done') return { ok: false, note: '任务 ' + r.state + ' ' + (r.error || '') };
    return { note: '续改链 ' + turns + ' 轮，thread=' + (await pg.eval(`__qa.m.studio.views.image.thread`)) };
  });

  // ④ 粘贴一张图进输入框（真 ClipboardEvent + 真文件）
  await step('paste', async () => {
    await pg.eval(`__qa.reset({ page: 'image' })`);
    await tap(pg, '.sd-page.on .cp-field');
    const b64 = (await import('node:fs')).readFileSync(pastePng).toString('base64');
    await pg.eval(`(async () => { const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const f = new File([u], ${JSON.stringify(path.basename(pastePng))}, { type: 'image/png' }); const dt = new DataTransfer(); dt.items.add(f);
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
    await waitInputs(pg, 'image', 1);
    const ins = await draft(pg);
    const chk = await uploadedOk(pg, ins[0]?.upload);
    await shot(pg, '04-paste');
    if (!chk.ok) return { ok: false, note: chk.why, inputs: ins };
    if (GEN && gens < 3) {
      await useLite(pg);
      await typeAndSend(pg, '把这张图改成水彩画风格');
      gens++;
      const r = await waitDone(pg);
      await sleep(1500);
      await shot(pg, '04b-paste-gen');
      if (r.state !== 'done') return { ok: false, note: '粘贴的图生成失败：' + r.state + ' ' + (r.error || '') };
      return { note: '粘贴挂上 upload=' + ins[0].upload + '，生成成功', inputs: ins };
    }
    return { note: '粘贴挂上 upload=' + ins[0].upload, inputs: ins };
  });

  // ⑤ 工作空间选图：＋ → 参考图 → 工作空间 → 素材 → 点一张
  await step('workspace-pick', async () => {
    await pg.eval(`__qa.reset({ page: 'image' })`);
    await tap(pg, '.sd-page.on .cp-ib');
    await sleep(500);
    const roles = await pg.eval(`[...document.querySelectorAll('.studio-root .op')].filter((b) => __qa.vis(b) && !b.disabled).map((b) => b.textContent.trim())`);
    if (roles.length > 1) await tap(pg, '.studio-root .op', roles.find((x) => /参考/.test(x)) || roles[0]);
    await sleep(400);
    await tap(pg, '.studio-root .op', '工作空间');
    await sleep(1200);
    await tap(pg, '.studio-root button', '素材');
    await sleep(1200);
    await tap(pg, '.studio-root .wp-img');
    await waitInputs(pg, 'image', 1);
    const ins = await draft(pg);
    await shot(pg, '05-workspace-pick');
    if (!ins[0]?.path) return { ok: false, note: '没挂上 path 素材', inputs: ins };
    return { note: '挂上 path=' + ins[0].path, inputs: ins };
  });

  // ⑥ 工作空间拖入：抽屉「文件」里按住一张图 → 拖到输入框 → 松手（真触摸）
  await step('workspace-drag', async () => {
    await pg.eval(`__qa.reset({ page: 'image' })`);
    await tap(pg, '.studio-root .sd-rail-btn');
    await pg.eval(`__qa.until(() => __qa.m.studio.drawer, 3000, '点侧栏钮后抽屉打开')`);
    await sleep(500);
    await tap(pg, '.studio-root .sb-top .seg button', '文件');
    await sleep(1800);
    // 文件页默认开在 saveDir（Media Studio）：先回工作空间根，再进「素材」文件夹
    // saveDir 还不存在（一张都没自动存过）时文件页直接开在根上，没有「回根」可点
    if (await pg.eval(`!!document.querySelector('.studio-root .sd-rail .pb-root')`)) { await tap(pg, '.studio-root .sd-rail .pb-root'); await sleep(1500); }
    await tap(pg, '.studio-root .sd-rail button.folder', '素材');
    await sleep(1500);
    const from = await center(pg, '.studio-root .sd-rail .frow', '海边小屋');
    await pg.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 3 }] });
    await sleep(700);   // 按住过 420ms 起拖
    const to = await pg.eval(`(() => { const b = document.querySelector('.studio-root .sd-page.on .cp').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 30 }; })()`);
    for (let i = 1; i <= 12; i++) {
      await pg.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / 12, y: from.y + (to.y - from.y) * i / 12, id: 3 }] });
      await sleep(40);
    }
    await sleep(500);
    await shot(pg, '06a-workspace-drag-hover');
    await pg.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: to.x, y: to.y, id: 3 }] });
    await sleep(1200);
    const ins = await draft(pg);
    await shot(pg, '06b-workspace-drag-drop');
    if (!ins.length) return { ok: false, note: '松手后没挂上素材' };
    return { note: '拖入挂上 ' + ins[0].role + ' ' + (ins[0].path || ins[0].upload || ''), inputs: ins };
  });

  // ⑦ 接着做：抽屉作品流里生成过的那张 →「…」→ 用作视频首帧
  await step('continue-video', async () => {
    await pg.eval(`__qa.reset({ page: 'image' })`);
    await pg.eval(`__qa.m.loadAssets(true)`); await sleep(1200);
    const n = await pg.eval(`__qa.m.studio.assets.filter((a) => a.kind === 'image').length`);
    if (!n) return { note: '（作品流里还没有图像，跳过；带 --gen 跑一遍就有）' };
    await tap(pg, '.studio-root .sd-rail-btn');
    await sleep(600);
    await tap(pg, '.studio-root .wr .wr-more');
    await sleep(700);
    await shot(pg, '07a-work-menu');
    await tap(pg, '.studio-root .mn-it, .studio-root .wm-i', '视频首帧');
    await sleep(900);
    const ins = await draft(pg, 'video');
    const page = await pg.eval(`__qa.m.studio.page`);
    await shot(pg, '07b-continue-video');
    if (page !== 'video' || !ins.some((x) => x.role === 'first' && x.asset)) return { ok: false, note: '没切到视频页或没挂上首帧', inputs: ins, page };
    return { note: '切到视频页，首帧来自作品 ' + ins[0].asset };
  });

  // ⑧ 返回键逐层关闭：开参数 sheet → 返回关 sheet → 开抽屉 → 返回收抽屉
  await step('back-layers', async () => {
    await pg.eval(`__qa.reset({ page: 'image' })`);
    await tap(pg, '.sd-page.on .cp-all');
    await sleep(600);
    const a = await pg.eval(`__qa.layers.layerCount()`);
    await pg.eval(`window.__bridgeBack ? window.__bridgeBack() : history.back()`);
    await sleep(700);
    const b = await pg.eval(`__qa.layers.layerCount()`);
    await tap(pg, '.studio-root .sd-rail-btn');
    await sleep(500);
    await pg.eval(`window.__bridgeBack ? window.__bridgeBack() : history.back()`);
    await sleep(600);
    const drawer = await pg.eval(`__qa.m.studio.drawer`);
    const screen = await pg.eval(`__qa.st.ui.screen`);
    const ok = a === 1 && b === 0 && !drawer && screen === 'studio';
    return { ok, note: `sheet 开时 ${a} 层 → 返回后 ${b} 层；抽屉返回后 ${drawer ? '还开着' : '收起'}；仍在 ${screen}` };
  });
} finally {
  await edge.close();
}

// ⑨ 桌面：从系统拖一张图进来（HTML5 DragEvent + 真文件）
if (!ONLY || ONLY.includes('desktop-drop')) {
  const e2 = await launchEdge();
  try {
    const pg = await openPage(e2);
    await setup(pg, { w: 1440, h: 900, dpr: 1, sat: 0, sab: 0, touch: false });
    await step('desktop-drop', async () => {
      await pg.eval(`__qa.reset({ page: 'image' })`);
      const b64 = (await import('node:fs')).readFileSync(photo).toString('base64');
      await pg.eval(`(async () => { const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const f = new File([u], ${JSON.stringify(path.basename(photo))}, { type: 'image/jpeg' }); const dt = new DataTransfer(); dt.items.add(f);
        const cf = __qa.page().querySelector('.cf'); const cp = __qa.page().querySelector('.cp').getBoundingClientRect();
        const o = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: cp.left + 40, clientY: cp.top + 20 };
        cf.dispatchEvent(new DragEvent('dragenter', o)); await __qa.sleep(250); cf.dispatchEvent(new DragEvent('dragover', o)); await __qa.sleep(250);
        __qa.page().querySelector('.cp').dispatchEvent(new DragEvent('drop', o)); return true; })()`);
      await waitInputs(pg, 'image', 1);
      const ins = await draft(pg);
      const chk = await uploadedOk(pg, ins[0]?.upload);
      await shot(pg, '09-desktop-drop');
      if (!chk.ok) return { ok: false, note: chk.why, inputs: ins };
      return { note: '系统拖入挂上 ' + ins[0].role + '，upload=' + ins[0].upload };
    });
  } finally { await e2.close(); }
}

writeFileSync(path.join(OUT, 'flows.json'), JSON.stringify({ at: new Date().toISOString(), gen: GEN, gens, results }, null, 1));
const bad = results.filter((r) => !r.ok);
say(`\n${results.length - bad.length}/${results.length} 通过${GEN ? '，真生成 ' + gens + ' 张' : ''}`);
process.exitCode = bad.length ? 1 : 0;
