#!/usr/bin/env node
// Media Studio 真实操作流（真后端、真点按、真上传；用法见 README.md）：
//   node web/scripts/studio-qa/flows.mjs --url http://127.0.0.1:8822/ --out <目录> --files <放测试图的目录> [--gen] [--only upload,paste,…]
// 每一步都用 CDP 的触摸事件点（Input.dispatchTouchEvent），系统选择器走 Page.setInterceptFileChooserDialog 真塞文件，
// 粘贴派真的 ClipboardEvent、桌面拖入派真的 DragEvent、素材架 / 文件里按住 → 拖到输入框 → 松手，抽屉是左缘真滑出来的。
// 不带 --gen 只验到「素材挂上、上传落盘、发给后端的是相对名」为止，不花钱；带 --gen 才真生成（图像 Lite 1K，最多 3 张）：
//   墙上发一张 → 取景框显影 → 原地换成作品格子（同一格）；打开它在焦点里接着改 → 版本条多一格；粘贴的图再改一张。
// v4（方案 §12）：没有侧栏钮了（手机抽屉靠左缘右滑）、没有任务托盘；「接着做」在焦点里；挑作品走 ＋ → 作品。
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
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
// --provider <服务名片段>：同名模型几家都有时指定走哪家（例：隔离实例的 Vertex 没有出图权限，--model gemini-nano-banana-2.1 --provider Gemini）
const PROVIDER = args.provider ? String(args.provider) : '';
// --token <令牌>：后端开着令牌鉴权时（比如另起的、带出图凭据的实例）先写进 localStorage，上传核对也带上
const TOKEN = args.token ? String(args.token) : '';
const MAX_GEN = 3;
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
  if (first) await pg.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { try { localStorage.setItem('bridge-theme', 'light'); ${TOKEN ? `localStorage.setItem('bridge-token', ${JSON.stringify(TOKEN)});` : ''} } catch {}
    const ap = () => { const de = document.documentElement; if (!de) return false; de.style.setProperty('--sat', '${cfg.sat}px'); de.style.setProperty('--sab', '${cfg.sab}px'); return true; };
    if (!ap()) document.addEventListener('readystatechange', ap); })();` + DETECT_SRC + HELPERS_SRC });
  await pg.send('Page.setInterceptFileChooserDialog', { enabled: true });
  await pg.send('DOM.enable');
  await pg.send('Page.navigate', { url: URL0 });
  // 刚发出 navigate 时求值可能还落在旧文档（about:blank，readyState 早就是 complete）：要等到新页面、应用挂出来、__qa 注入好
  await pg.eval(`(async () => { for (let i = 0; i < 300; i++) { if (location.href.startsWith(${JSON.stringify(new URL(URL0).origin)}) && window.__qa && document.readyState === 'complete' && !document.documentElement.hasAttribute('data-boot') && document.querySelector('#app *, body > div *')) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })()`, { timeout: 40000 });
  await sleep(800);
  await pg.eval(`(async () => { await __qa.init(); return true; })()`, { timeout: 60000 });
  await sleep(500);
}

/** 元素中心（等位置稳定）；sel 可带 text：在匹配的元素里找文字 */
async function center(pg, sel, text = null) {
  return pg.eval(`(async () => { const el = await __qa.until(() => __qa.find(${JSON.stringify(sel)}, ${JSON.stringify(text)}), 8000, ${JSON.stringify(sel + ' ' + (text || ''))});
    const b0 = el.getBoundingClientRect(); if (b0.bottom > innerHeight || b0.top < 0) __qa.scrollTo(el, 'center');
    // 等位置稳定（sheet / 菜单的入场动画还在跑时点下去会落空）：连续两帧不动才算
    let prev = null; for (let i = 0; i < 40; i++) { await new Promise((r) => requestAnimationFrame(r)); const b = el.getBoundingClientRect(); const k = Math.round(b.left) + ',' + Math.round(b.top); if (k === prev) break; prev = k; await __qa.sleep(40); }
    const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
}
async function touchAt(pg, x, y) {
  await pg.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await sleep(60);
  await pg.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(350);
}
async function tap(pg, sel, text = null) { const { x, y } = await center(pg, sel, text); await touchAt(pg, x, y); }
async function click(pg, sel, text = null) {
  const { x, y } = await center(pg, sel, text);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await pg.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await sleep(350);
}
/** 按住 from 拖到 to 再松手（真触摸；按住过 420ms 才起拖） */
async function touchDrag(pg, from, to, id = 3) {
  await pg.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id }] });
  await sleep(700);
  for (let i = 1; i <= 14; i++) {
    await pg.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / 14, y: from.y + (to.y - from.y) * i / 14, id }] });
    await sleep(40);
  }
  await sleep(500);
}
async function touchUp(pg, to, id = 3) { await pg.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: to.x, y: to.y, id }] }); await sleep(1200); }
/** 手机：左缘往右滑出素材架抽屉（真手势） */
let swipeTrace = '';
async function edgeSwipe(pg) {
  // 记下这一下手势里页面收到的指针事件（拉不出抽屉时看是被谁截走了）
  await pg.eval(`(() => { window.__sw = []; if (!window.__swOn) { window.__swOn = 1; for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) document.addEventListener(t, (e) => window.__sw && window.__sw.length < 6 && window.__sw.push(t + '@' + Math.round(e.clientX) + ':' + String(e.target.className?.baseVal ?? e.target.className).split(' ')[0]), true); } return 1; })()`);
  await pg.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 6, y: 420, id: 5 }] });
  for (let i = 1; i <= 12; i++) { await pg.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 6 + i * 22, y: 420 + i, id: 5 }] }); await sleep(16); }
  await pg.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  // 抽屉是松手后弹簧走到底（onSettle）才算开：等它，最多 2.5 秒
  await pg.eval(`(async () => { for (let i = 0; i < 50 && !__qa.m.studio.drawer; i++) await __qa.sleep(50); await __qa.sleep(250); return 1; })()`);
  swipeTrace = await pg.eval(`(window.__sw || []).join(' ') + ' | drag.on=' + !!__qa.dnd.drag?.on + ' morphing=' + JSON.stringify(__qa.st.ui.morphing) + ' pick=' + !!__qa.m.studio.pick`);
}
async function shot(pg, name) {
  const r = await pg.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 }, 45000);
  writeFileSync(path.join(OUT, name + '.jpg'), Buffer.from(r.data, 'base64'));
}
const draft = (pg, page = 'image') => pg.eval(`JSON.parse(JSON.stringify(__qa.m.studio.drafts['${page}'].inputs.map((x) => ({ role: x.role, upload: x.upload, path: x.path, asset: x.asset, pending: x.pending, name: x.name }))))`);
async function uploadedOk(pg, rel) {
  if (!rel || /[\\/]/.test(rel) || /^[a-z]:/i.test(rel)) return { ok: false, why: 'upload 不是 uploads 里的相对名：' + rel };
  const st = await pg.eval(`fetch('/api/upload/raw?name=' + encodeURIComponent(${JSON.stringify(rel)}), ${TOKEN ? `{ headers: { Authorization: 'Bearer ' + ${JSON.stringify(TOKEN)} } }` : '{}'}).then((r) => r.status)`);
  return st === 200 ? { ok: true } : { ok: false, why: '/api/upload/raw 回 ' + st };
}
async function waitInputs(pg, page, n) {
  await pg.eval(`__qa.until(() => { const a = __qa.m.studio.drafts['${page}'].inputs; return a.length >= ${n} && a.every((x) => !x.pending); }, 20000, '素材上传')`);
}
// 真后端的复位：只关浮层 / 焦点 / 挑选态 / 抽屉、清草稿；墙和任务都是真的，不动
async function soft(pg, page = 'image') {
  await pg.eval(`(async () => { const { studio } = __qa.m; try { window.gc?.(); } catch {} for (let i = 0; i < 12 && __qa.layers.closeTopLayer(); i++) await __qa.sleep(40);
    studio.focus = null; studio.pick = null; studio.drawer = false; studio.page = '${page}';
    for (const p of __qa.PAGES) { studio.drafts[p].inputs = []; studio.drafts[p].parent = null; }
    for (const f of document.querySelectorAll('.studio-root .cp-field')) { f.textContent = ''; f.dispatchEvent(new Event('input', { bubbles: true })); }
    await __qa.sleep(500); return 1; })()`);
}
async function useLite(pg) {
  const key = await pg.eval(`(() => { const m = __qa.m.modelsOf('image').find((x) => x.id === ${JSON.stringify(LITE)} && (!${JSON.stringify(PROVIDER)} || String(x.provider?.name || '').includes(${JSON.stringify(PROVIDER)}))); if (m) __qa.m.setModel('image', m.key); return m?.key || ''; })()`);
  if (!key) throw new Error('目录里没有 ' + LITE);
  await pg.eval(`(() => { const m = __qa.m.currentModel('image'); for (const p of m.params || []) { if (p.key === 'imageSize' && (p.options || []).some((o) => o.value === '1K')) __qa.m.setParam('image', 'imageSize', '1K'); } return 1; })()`);
  return key;
}
let gens = 0;
async function typeAndSend(pg, text) {
  if (gens >= MAX_GEN) throw new Error('已经真生成 ' + gens + ' 张，不再发');
  await tap(pg, '.sd-page.on .cp-field');
  await pg.send('Input.insertText', { text });
  await sleep(400);
  const n0 = await pg.eval(`__qa.m.studio.jobs.length`);
  const st = await pg.eval(`document.querySelector('.studio-root .sd-page.on .cp-send')?.dataset.s`);
  if (st !== 'ready') throw new Error('发送键不是可发状态（' + st + '）');
  await tap(pg, '.sd-page.on .cp-send');
  const id = await pg.eval(`__qa.until(() => __qa.m.studio.jobs.length > ${n0} && __qa.m.studio.jobs[0].id, 8000, '点发送后建出任务')`);
  gens++;
  return id;
}
async function waitJob(pg, id, timeout = 150000) {
  return pg.eval(`(async () => { const t0 = Date.now(); for (;;) { const j = __qa.m.studio.jobs.find((x) => x.id === ${JSON.stringify(id)});
      if (j && (j.state === 'done' || j.state === 'error' || j.state === 'canceled')) return { state: j.state, error: j.error || '', n: (j.result || []).length, result: (j.result || []).map((a) => a.id), inputs: j.inputs, ms: Date.now() - t0 };
      if (Date.now() - t0 > ${timeout}) return { state: 'timeout' }; await __qa.sleep(300); } })()`, { timeout: timeout + 10000 });
}
const results = [];
async function step(id, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  const t0 = Date.now();
  try { const r = await fn(); const ok = r?.ok !== false; results.push({ id, ...r, ok, ms: Date.now() - t0 }); say(`${ok ? '✔' : '✘'} ${id} ${r?.note || ''}`); }
  catch (e) { results.push({ id, ok: false, error: String(e.message || e).slice(0, 300) }); say(`✘ ${id} ${e.message}`); }
}

const edge = await launchEdge();
let genAsset = null;
try {
  const pg = await openPage(edge);
  let chooser = null;
  pg.conn.on('Page.fileChooserOpened', (p, sid) => { if (sid === pg.sessionId) chooser = p; });
  await setup(pg, { ...PHONE, touch: true });

  // ① 从相册上传：＋ → 改这张图 → 这台设备 → 系统选择器塞一张手机照片
  await step('upload', async () => {
    await soft(pg, 'image');
    await tap(pg, '.sd-page.on .cp-plus');
    await sleep(500);
    const roles = await pg.eval(`[...document.querySelectorAll('.studio-root .op')].filter((b) => __qa.vis(b)).map((b) => b.textContent.trim())`);
    const edit = roles.find((x) => /改这张图/.test(x));
    if (edit) await tap(pg, '.studio-root .op', '改这张图');
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

  // ② 墙上发一张（用上传的图改）：取景框在墙最前面显影 → 原地换成作品格子（同一格、同一位置）
  await step('gen-wall', async () => {
    if (!GEN) return { note: '（没带 --gen，跳过真生成）' };
    await useLite(pg);
    if (!(await draft(pg)).some((x) => x.upload)) return { ok: false, note: '上一步没挂上上传的图，不发' };
    const id = await typeAndSend(pg, '把天空改成黄昏的橙色，其它不动');
    // 在跑：墙最前面那一格是取景框
    await pg.eval(`__qa.until(() => document.querySelector('.studio-root .sd-page.on .sw-it.dev .sw-dev'), 6000, '取景框')`);
    await sleep(1800);
    const dev = await pg.eval(`(() => { const it = document.querySelector('.studio-root .sd-page.on .sw-it.dev'); const r = it.getBoundingClientRect(); it.dataset.qaCell = '1'; return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), ink: !!it.querySelector('canvas') }; })()`);
    await shot(pg, '02a-gen-devframe');
    const r = await waitJob(pg, id);
    if (r.state !== 'done') { await shot(pg, '02x-gen-fail'); return { ok: false, note: '任务 ' + r.state + ' ' + (r.error || '') }; }
    // 显影中（1.6s）截一张，显完再截一张
    await sleep(700);
    await shot(pg, '02b-gen-reveal');
    await sleep(3200);
    await shot(pg, '02c-gen-landed');
    const after = await pg.eval(`(() => { const it = document.querySelector('.studio-root .sd-page.on .sw-it[data-qa-cell]'); if (!it) return null; const r = it.getBoundingClientRect(); const tile = it.querySelector('.sw-tile');
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), dev: !!it.querySelector('.sw-dev'), asset: tile?.dataset.asset || '' }; })()`);
    genAsset = r.result[0];
    if (!after) return { ok: false, note: '取景框那一格不见了（被换成了另一个节点，不是原地换）', dev };
    const same = after.asset === genAsset && !after.dev;
    return { ok: same, note: `取景框 ${dev.w}×${dev.h}@(${dev.x},${dev.y}) → 作品格子 ${after.w}×${after.h}@(${after.x},${after.y})，同一节点${same ? '、是结果作品' : '，但内容不对：' + JSON.stringify(after)}；${Math.round(r.ms / 1000)}s`, dev, after, job: r };
  });

  // ③ 打开刚出的那张，在焦点里接着改：版本条多一格（续改中末格在晕），出图后焦点跟到新一版
  await step('gen-continue', async () => {
    if (!GEN) return { note: '（没带 --gen，跳过）' };
    if (!genAsset) return { ok: false, note: '上一步没出图，不续改' };
    await soft(pg, 'image');
    await tap(pg, `.studio-root .sd-page.on .sw-tile[data-asset="${genAsset}"]`);
    await pg.eval(`__qa.until(() => document.querySelector('.studio-root .sd-page.on .sf .sf-media'), 6000, '焦点')`);
    await sleep(1500);
    const v0 = await pg.eval(`document.querySelectorAll('.studio-root .sd-page.on .sf-strip .sf-vt').length`);
    await shot(pg, '03a-focus');
    const id = await typeAndSend(pg, '再在天空里加一只白色的海鸥');
    await sleep(2500);
    const v1 = await pg.eval(`document.querySelectorAll('.studio-root .sd-page.on .sf-strip .sf-vt').length`);
    await shot(pg, '03b-focus-dev');
    const r = await waitJob(pg, id);
    if (r.state !== 'done') { await shot(pg, '03x-fail'); return { ok: false, note: '任务 ' + r.state + ' ' + (r.error || '') }; }
    await sleep(3500);
    await shot(pg, '03c-focus-new');
    const v2 = await pg.eval(`(() => ({ n: document.querySelectorAll('.studio-root .sd-page.on .sf-strip button.sf-vt').length, on: document.querySelector('.studio-root .sd-page.on .sf-strip .sf-vt.on') ? [...document.querySelectorAll('.studio-root .sd-page.on .sf-strip button.sf-vt')].findIndex((x) => x.classList.contains('on')) : -1, focus: __qa.m.studio.focus?.asset?.id, label: document.querySelector('.studio-root .sd-page.on .sf-vn')?.textContent || '' }))()`);
    const ok = v2.n === Math.max(2, v0 + 1) && v2.focus === r.result[0] && v2.on === v2.n - 1;
    return { ok, note: `版本条 ${v0} 格 → 续改中 ${v1} 格 → 出图后 ${v2.n} 格（墨圈在第 ${v2.on + 1} 格，「${v2.label}」），焦点${v2.focus === r.result[0] ? '跟到新一版' : '没跟到新一版'}`, job: r };
  });

  // ④ 粘贴一张图进输入框（真 ClipboardEvent + 真文件）
  await step('paste', async () => {
    await soft(pg, 'image');
    await tap(pg, '.sd-page.on .cp-field');
    const b64 = readFileSync(pastePng).toString('base64');
    await pg.eval(`(async () => { const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const f = new File([u], ${JSON.stringify(path.basename(pastePng))}, { type: 'image/png' }); const dt = new DataTransfer(); dt.items.add(f);
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
    await waitInputs(pg, 'image', 1);
    const ins = await draft(pg);
    const chk = await uploadedOk(pg, ins[0]?.upload);
    await shot(pg, '04-paste');
    if (!chk.ok) return { ok: false, note: chk.why, inputs: ins };
    if (GEN && gens < MAX_GEN) {
      await useLite(pg);
      const id = await typeAndSend(pg, '把这张图改成水彩画风格');
      const r = await waitJob(pg, id);
      await sleep(3000);
      await shot(pg, '04b-paste-gen');
      if (r.state !== 'done') return { ok: false, note: '粘贴的图生成失败：' + r.state + ' ' + (r.error || '') };
      return { note: '粘贴挂上 upload=' + ins[0].upload + '，生成成功', inputs: ins };
    }
    return { note: '粘贴挂上 upload=' + ins[0].upload, inputs: ins };
  });

  // ⑤ 工作空间选图：＋ → 参考图 → 工作空间 → 素材 → 点一张
  await step('workspace-pick', async () => {
    await soft(pg, 'image');
    await tap(pg, '.sd-page.on .cp-plus');
    await sleep(500);
    const roles = await pg.eval(`[...document.querySelectorAll('.studio-root .op')].filter((b) => __qa.vis(b) && !b.disabled).map((b) => b.textContent.trim())`);
    if (roles.some((x) => /参考/.test(x))) await tap(pg, '.studio-root .op', '参考图');
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
    return { note: '挂上 ' + ins[0].role + ' path=' + ins[0].path, inputs: ins };
  });

  // ⑥ ＋ → 作品：手机上是一张作品格子表单，点一张就挂上（作品飞进素材行）
  await step('works-pick', async () => {
    await soft(pg, 'video');
    await tap(pg, '.sd-page.on .cp-plus');
    await sleep(500);
    const roles = await pg.eval(`[...document.querySelectorAll('.studio-root .op')].filter((b) => __qa.vis(b) && !b.disabled).map((b) => b.textContent.trim())`);
    if (roles.some((x) => /首帧/.test(x))) await tap(pg, '.studio-root .op', '首帧');
    await sleep(400);
    await tap(pg, '.studio-root .op', '作品');
    await pg.eval(`__qa.until(() => __qa.find('.studio-root .aa-w'), 8000, '作品格子')`);
    await sleep(600);
    await shot(pg, '06a-works-grid');
    await tap(pg, '.studio-root .aa-w');
    await sleep(900);
    const ins = await draft(pg, 'video');
    await shot(pg, '06b-works-picked');
    if (!ins.some((x) => x.role === 'first' && x.asset)) return { ok: false, note: '没挂上作品当首帧', inputs: ins };
    return { note: '作品当首帧挂上 asset=' + ins[0].asset };
  });

  // ⑦ 素材架拖进输入框：左缘右滑拉出抽屉 → 按住一格 → 拖到输入框 → 松手（抽屉让开）
  await step('shelf-drag', async () => {
    await soft(pg, 'image');
    await edgeSwipe(pg);
    if (!(await pg.eval(`__qa.m.studio.drawer`))) return { ok: false, note: '左缘右滑没拉出抽屉：' + swipeTrace };
    await shot(pg, '07a-shelf-drawer');
    const from = await center(pg, '.studio-root .sd-shelf .sd-tile[data-kind="image"]');
    const to = await pg.eval(`(() => { const b = document.querySelector('.studio-root .sd-page.on .cp').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 24 }; })()`);
    await touchDrag(pg, from, to);
    await shot(pg, '07b-shelf-drag-hover');
    await touchUp(pg, to);
    const ins = await draft(pg);
    await shot(pg, '07c-shelf-drag-drop');
    if (!ins.some((x) => x.asset)) return { ok: false, note: '松手后没挂上作品', inputs: ins };
    return { note: '拖入挂上 ' + ins[0].role + ' asset=' + ins[0].asset + '；抽屉' + ((await pg.eval(`__qa.m.studio.drawer`)) ? '还开着' : '已让开') };
  });

  // ⑧ 工作空间拖入：抽屉「文件」里按住一张图 → 拖到输入框 → 松手（真触摸）
  await step('workspace-drag', async () => {
    await soft(pg, 'image');
    await edgeSwipe(pg);
    if (!(await pg.eval(`__qa.m.studio.drawer`))) return { ok: false, note: '左缘右滑没拉出抽屉：' + swipeTrace };
    await tap(pg, '.studio-root .sd-shelf-seg button', '文件');
    await sleep(1800);
    // 文件页默认开在 saveDir（Media Studio）：先回工作空间根，再进「素材」文件夹；saveDir 不存在时直接开在根上
    if (await pg.eval(`!!__qa.find('.studio-root .sd-shelf .pb-root')`)) { await tap(pg, '.studio-root .sd-shelf .pb-root'); await sleep(1500); }
    await tap(pg, '.studio-root .sd-shelf button.folder', '素材');
    await sleep(1500);
    const from = await center(pg, '.studio-root .sd-shelf .frow', '海边小屋');
    const to = await pg.eval(`(() => { const b = document.querySelector('.studio-root .sd-page.on .cp').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 24 }; })()`);
    await touchDrag(pg, from, to);
    await shot(pg, '08a-workspace-drag-hover');
    await touchUp(pg, to);
    const ins = await draft(pg);
    await shot(pg, '08b-workspace-drag-drop');
    if (!ins.length) return { ok: false, note: '松手后没挂上素材' };
    return { note: '拖入挂上 ' + ins[0].role + ' ' + (ins[0].path || ins[0].upload || '') };
  });

  // ⑨ 接着做：墙上点一张图 → 焦点「接着做」→ 用作视频首帧
  await step('continue-video', async () => {
    await soft(pg, 'image');
    await tap(pg, '.studio-root .sd-page.on .sw-tile');
    await pg.eval(`__qa.until(() => document.querySelector('.studio-root .sd-page.on .sf .sf-acts'), 6000, '焦点')`);
    await sleep(1200);
    const hasCont = await pg.eval(`[...document.querySelectorAll('.studio-root .sd-page.on .sf-acts .sf-b[aria-haspopup="menu"]')].some((b) => !b.classList.contains('icon'))`);
    if (!hasCont) return { ok: false, note: '焦点里没有「接着做」' };
    await tap(pg, '.studio-root .sd-page.on .sf-acts .sf-b', '接着做');
    await sleep(800);
    await shot(pg, '09a-continue-menu');
    await tap(pg, '.studio-root .wm-i', '视频首帧');
    await sleep(1000);
    const ins = await draft(pg, 'video');
    const page = await pg.eval(`__qa.m.studio.page`);
    await shot(pg, '09b-continue-video');
    if (page !== 'video' || !ins.some((x) => x.role === 'first' && x.asset)) return { ok: false, note: '没切到视频页或没挂上首帧', inputs: ins, page };
    return { note: '切到视频页，首帧来自作品 ' + ins.find((x) => x.role === 'first').asset };
  });

  // ⑩ 返回键逐层关：全部参数表单 → 焦点 → 挑选态 → 抽屉，最后仍在 Studio
  await step('back-layers', async () => {
    await soft(pg, 'image');
    const back = () => pg.eval(`(async () => { window.__bridgeBack ? window.__bridgeBack() : history.back(); await __qa.sleep(700); return 1; })()`);
    const out = [];
    await tap(pg, '.sd-page.on .t-all'); await sleep(700);
    const a = await pg.eval(`__qa.layers.layerCount()`); await back();
    // 页面状态快照：返回没关掉东西时看是不是别的层在前面、或帧率卡住
    const diag = await pg.eval(`(async () => { const pv = await __qa.imp('/src/lib/preview.svelte.js'); const u = __qa.st.ui; let n = 0; const t0 = performance.now(); await Promise.race([new Promise((r) => { const f = () => { n++; if (performance.now() - t0 > 300) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), __qa.sleep(600)]); return JSON.stringify({ vis: document.visibilityState, focus: document.hasFocus(), raf300: n, preview: !!pv.preview?.open, settings: u.settingsOpen, login: u.loginOpen, drawer: u.drawerOpen, screen: u.screen }); })()`);

    out.push(`表单 ${a} 层 → ${await pg.eval(`__qa.layers.layerCount()`)} 层`);
    await tap(pg, '.studio-root .sd-page.on .sw-tile'); await sleep(1200);
    const f1 = await pg.eval(`!!__qa.m.studio.focus`); await back();
    out.push(`焦点 ${f1 ? '开' : '没开'} → ${(await pg.eval(`!!__qa.m.studio.focus`)) ? '还开着' : '关了'}`);
    await pg.eval(`__qa.m.startPick('image', 'ref')`); await sleep(600);
    const p1 = await pg.eval(`!!__qa.m.studio.pick`); await back();
    out.push(`挑选态 ${p1 ? '开' : '没开'} → ${(await pg.eval(`!!__qa.m.studio.pick`)) ? '还在' : '退了'}`);
    await edgeSwipe(pg);
    const d1 = await pg.eval(`__qa.m.studio.drawer`); await back();
    const d2 = await pg.eval(`__qa.m.studio.drawer`);
    out.push(`抽屉 ${d1 ? '开' : '没开'} → ${d2 ? '还开着' : '收起'}`);
    const screen = await pg.eval(`__qa.st.ui.screen`);
    const ok = a === 1 && f1 && d1 && p1 && !d2 && screen === 'studio' && !(await pg.eval(`!!__qa.m.studio.focus || !!__qa.m.studio.pick || __qa.layers.layerCount() > 0`));
    // 没过时带上第一下返回之后的页面状态（帧率 raf300 很低＝合成器卡住、动画走不完，层关不掉）
    return { ok, note: out.join('；') + '；仍在 ' + screen + (ok ? '' : '；' + diag) };
  });
} finally {
  await edge.close();
}

// ⑪ 桌面：从系统拖一张图进来（HTML5 DragEvent + 真文件）；＋ → 作品 → 素材架挑选态里点一张
if (!ONLY || ONLY.includes('desktop-drop') || ONLY.includes('desktop-pick')) {
  const e2 = await launchEdge();
  try {
    const pg = await openPage(e2);
    await setup(pg, { w: 1440, h: 900, dpr: 1, sat: 0, sab: 0, touch: false });
    await step('desktop-drop', async () => {
      await soft(pg, 'image');
      const b64 = readFileSync(photo).toString('base64');
      await pg.eval(`(async () => { const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const f = new File([u], ${JSON.stringify(path.basename(photo))}, { type: 'image/jpeg' }); const dt = new DataTransfer(); dt.items.add(f);
        const cf = __qa.page().querySelector('.cf'); const cp = __qa.page().querySelector('.cp').getBoundingClientRect();
        const o = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: cp.left + 40, clientY: cp.top + 20 };
        cf.dispatchEvent(new DragEvent('dragenter', o)); await __qa.sleep(250); cf.dispatchEvent(new DragEvent('dragover', o)); await __qa.sleep(250);
        __qa.page().querySelector('.cp').dispatchEvent(new DragEvent('drop', o)); return true; })()`);
      await waitInputs(pg, 'image', 1);
      const ins = await draft(pg);
      const chk = await uploadedOk(pg, ins[0]?.upload);
      await shot(pg, '11-desktop-drop');
      if (!chk.ok) return { ok: false, note: chk.why, inputs: ins };
      return { note: '系统拖入挂上 ' + ins[0].role + '，upload=' + ins[0].upload };
    });
    await step('desktop-pick', async () => {
      await soft(pg, 'image');
      await click(pg, '.sd-page.on .cp-plus');
      await sleep(500);
      const roles = await pg.eval(`[...document.querySelectorAll('.studio-root .op')].filter((b) => __qa.vis(b) && !b.disabled).map((b) => b.textContent.trim())`);
      if (roles.some((x) => /参考/.test(x))) await click(pg, '.studio-root .op', '参考图');
      await sleep(400);
      await click(pg, '.studio-root .op', '作品');
      await sleep(900);
      const pick = await pg.eval(`JSON.parse(JSON.stringify(__qa.m.studio.pick))`);
      await shot(pg, '12a-desktop-pick');
      if (!pick) return { ok: false, note: '没进素材架挑选态' };
      await click(pg, '.studio-root .sd-shelf .sd-tile.ok');
      await sleep(1000);
      const ins = await draft(pg);
      await shot(pg, '12b-desktop-picked');
      const ended = !(await pg.eval(`!!__qa.m.studio.pick`));
      if (!ins.some((x) => x.asset && x.role === pick.role)) return { ok: false, note: '点了没挂上', inputs: ins };
      return { ok: ended, note: `挑选态（${pick.role}）点一张挂上 asset=${ins[0].asset}；挑选态${ended ? '已退出' : '没退出'}` };
    });
  } finally { await e2.close(); }
}

writeFileSync(path.join(OUT, 'flows.json'), JSON.stringify({ at: new Date().toISOString(), gen: GEN, gens, results }, null, 1));
const bad = results.filter((r) => !r.ok);
say(`\n${results.length - bad.length}/${results.length} 通过${GEN ? '，真生成 ' + gens + ' 次' : ''}`);
process.exitCode = bad.length ? 1 : 0;
