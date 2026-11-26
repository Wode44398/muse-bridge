// 页面里的小工具（window.__qa）：拿到与应用同一份模块实例（vite dev 冷模块图里 import 同一个 URL），
// 造作品 / 任务 / 素材、点按钮、复位状态。场景（scenarios.mjs）只调这些，不直接摸 DOM 细节。
// v4「作品台」（方案 §12）：每页一面作品墙（studio.walls）、焦点（studio.focus）、素材架挑选态（studio.pick）。
// 墙用隔离后端里的真实作品（真宽高、真波形）当底子；要极端内容的状态再往上叠造出来的。
export const HELPERS_SRC = String.raw`
// 资源计时默认只记 250 条，vite 开发态几百个模块早就记满了：放大，init 要靠它找到应用自己那一份模块地址
try { performance.setResourceTimingBufferSize(50000); } catch {}
window.__qa = {
  PAGES: ['image', 'video', 'voice', 'music'],
  // 拿应用自己那一份模块：vite 热更新过的模块地址带 ?t=<时间戳>，import 裸路径会拿到另一份实例（状态对不上、目录永远是空的）。
  // 按页面实际请求过的地址（performance 资源记录）去 import；没请求过的（还没懒加载）才用裸路径。
  imp(p) {
    const hit = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => { try { return new URL(n).pathname === p; } catch { return false; } }).pop();
    return import(hit || p);
  },
  async init() {
    this.st = await this.imp('/src/lib/state.svelte.js');
    this.st.ui.screen = 'studio';
    await this.until(() => document.querySelector('.studio-root .sd-page.on'), 15000, 'Studio 外壳');
    await this.until(() => performance.getEntriesByType('resource').some((e) => e.name.includes('/src/modules/studio/media.svelte.js')), 15000, 'Studio 模块');
    this.m = await this.imp('/src/modules/studio/media.svelte.js');
    this.layers = await this.imp('/src/modules/studio/layers.js');
    this.nav = await this.imp('/src/lib/settingsNav.svelte.js');
    this.dnd = await this.imp('/src/lib/dragdrop.svelte.js');
    this.sdrag = await this.imp('/src/modules/studio/drag.js');
    this.adrag = await this.imp('/src/modules/studio/assetDrag.js');
    this.lay = (await this.imp('/src/lib/layout.svelte.js')).layout;
    await this.until(() => this.m.studio.catalog, 15000, '模型目录');
    // 四面墙和素材架都从后端拉一遍，拍下来当每个状态的底子（复位时原样放回）
    await Promise.all(this.PAGES.map((p) => this.m.loadWall(p, true)));
    await this.m.loadAssets(true);
    const { studio } = this.m;
    this.base = { assets: studio.assets.slice(), walls: Object.fromEntries(this.PAGES.map((p) => [p, studio.walls[p].items.slice()])) };
    return true;
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async until(fn, ms = 6000, what = '') {
    const t0 = Date.now();
    for (;;) { let v; try { v = fn(); } catch {} if (v) return v; if (Date.now() - t0 > ms) throw new Error('等不到：' + (what || String(fn).slice(0, 80))); await this.sleep(60); }
  },
  $(s, root = document) { return root.querySelector(s); },
  vis(el) { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest('[inert],[hidden]') && getComputedStyle(el).visibility !== 'hidden'; },
  find(s, text, root = document) {
    const els = [...root.querySelectorAll(s)].filter((e) => this.vis(e));
    if (text == null) return els[0] || null;
    return els.find((e) => (e.textContent || '').replace(/\s+/g, ' ').includes(text) || (e.getAttribute('aria-label') || '').includes(text)) || null;
  },
  async click(s, text, root) {
    const el = await this.until(() => this.find(s, text, root), 5000, s + (text ? ' 「' + text + '」' : ''));
    el.click();
    await this.sleep(120);
    return true;
  },
  page() { return document.querySelector('.studio-root .sd-page.on'); },
  // 等某个元素位置停稳（连续 3 帧左上角不动），最多 ms 毫秒：设置页推入子页是 JS 弹簧（requestAnimationFrame），
  // 注入的「关动画」只管 CSS，机器一忙 900ms 都走不完，DOM 量在半路、和截图对不上（2026-11-06 t820「高级」页右移 69～125px）
  async stable(sel, ms = 3000) {
    const t0 = Date.now(); let last = null, same = 0;
    while (Date.now() - t0 < ms) {
      await new Promise((r) => requestAnimationFrame(r));
      const el = typeof sel === 'string' ? [...document.querySelectorAll(sel)].pop() : sel;
      const r = el?.getBoundingClientRect();
      const k = r ? Math.round(r.left * 2) + ',' + Math.round(r.top * 2) + ',' + Math.round(r.width) : '';
      same = k && k === last ? same + 1 : 0; last = k;
      if (same >= 3) return true;
    }
    return false;
  },
  // 等页面上跑着的有限时长动画（WAAPI：FLIP、焦点放大、Sheet 弹簧）播完；无限的（错拍标、墨）不等
  async idle(ms = 2500) {
    const runs = document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime));
    await Promise.race([Promise.all(runs.map((a) => a.finished.catch(() => {}))), this.sleep(ms)]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
  // 像手指一样滚：只滚最近的那个可滚动祖先（overflow auto / scroll），把 el 滚到顶（'start'）或中间（'center'）。
  // 别用 scrollIntoView：它连 overflow:hidden 的外层（平板设置面板、浮层外壳）也一起滚，偏移会留到下一个状态。
  scrollTo(el, pos = 'start') {
    if (!el) return;
    let p = el.parentElement;
    for (; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 2) break; }
    if (!p) return;
    const r = el.getBoundingClientRect(), pr = p.getBoundingClientRect();
    p.scrollTop += r.top - pr.top - (pos === 'center' ? (pr.height - r.height) / 2 : 8);
  },
  // 触发右键菜单（作品墙 / 素材架 / 音频行）：MouseEvent 没有 pointerType，组件当鼠标右键处理
  ctx(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.6, clientY: r.top + Math.min(r.height * 0.4, 40), button: 2 }));
    return true;
  },
  // —— 造数据（假图要带 width / height：只有 viewBox 的 SVG 没有固有尺寸，width:auto 的 <img> 会塌成 0 宽）——
  svg(prompt, w = 1024, h = 1024) {
    let x = 2166136261; for (const c of String(prompt)) x = Math.imul(x ^ c.codePointAt(0), 16777619); x >>>= 0;
    const a = x % 360, b = (a + 40 + (x >> 8) % 80) % 360;
    const s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(' + a + ' 55% 66%)"/><stop offset="1" stop-color="hsl(' + b + ' 50% 30%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="' + w * 0.7 + '" cy="' + h * 0.32 + '" r="' + Math.min(w, h) * 0.12 + '" fill="#fff6e0" fill-opacity=".8"/><path d="M0 ' + h * 0.78 + ' Q ' + w * 0.3 + ' ' + h * 0.55 + ' ' + w * 0.55 + ' ' + h * 0.72 + ' T ' + w + ' ' + h * 0.6 + ' V ' + h + ' H 0 Z" fill="#14202a" fill-opacity=".55"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  },
  // 能真解码的静音 WAV（4kHz、8 位单声道，时长同作品）：空的 data:audio/wav 会让播放器走失败态
  wav(sec = 8) {
    const key = 'w' + sec;
    if ((this._wav ||= {})[key]) return this._wav[key];
    const n = Math.round(4000 * sec), b = new Uint8Array(44 + n), v = new DataView(b.buffer);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 4000, true); v.setUint32(28, 4000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, 'data'); v.setUint32(40, n, true);
    b.fill(128, 44);
    let bin = ''; for (let i = 0; i < b.length; i += 8192) bin += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
    return (this._wav[key] = 'data:audio/wav;base64,' + btoa(bin));
  },
  seq: 0,
  nid(p = 'qa') { return p + (++this.seq).toString(36) + Math.random().toString(36).slice(2, 6); },
  peaks(seed = 1) { const out = []; for (let i = 0; i < 120; i++) out.push(Math.max(0.05, Math.min(1, 0.45 + 0.4 * Math.sin(i / 5 + seed) * Math.cos(i / 13 + seed * 2)))); return out; },
  /** 造一件作品（kind = image / video / audio / music）：图是渐变 SVG，音频是能解码的静音 WAV + 造的波形 */
  asset(kind, prompt, extra = {}) {
    const id = this.nid();
    const w = extra.w || 1024, h = extra.h || 1024;
    const vis = kind === 'image' || kind === 'video';
    return { id, kind, prompt, provider: extra.provider || '', model: extra.model || 'gemini-3.1-flash-lite-image', params: extra.params || {}, parents: extra.parents || [],
      ...(vis ? { w, h } : { peaks: extra.peaks || this.peaks(prompt.length % 7), duration: extra.duration || 8 }),
      createdAt: extra.createdAt || Date.now() - (extra.ago || 0), thread: extra.thread, url: vis ? this.svg(prompt, w, h) : this.wav(extra.duration || 8), thumb: vis ? this.svg(prompt, 320, Math.round(320 * h / w)) : '',
      ...(kind === 'video' ? { duration: extra.duration || 4 } : {}), ...(extra.wsPath ? { wsPath: extra.wsPath } : {}) };
  },
  /** 真作品换个 id 再用一次（续改链、刚出的结果）：地址写成绝对的，mediaSrc 原样用，图是真的 */
  clone(a, extra = {}) {
    const abs = (u) => (u && u.startsWith('/') ? location.origin + u : u);
    const id = this.nid('cl');
    return { ...a, url: abs(a.url) + (a.kind === 'image' ? '&v=preview' : ''), thumb: abs(a.thumb || a.url + '&v=thumb'), id, createdAt: Date.now() - (extra.ago ?? 0), ...extra };
  },
  real(page, i = 0) { return (this.base.walls[page] || [])[i] || null; },
  realWhere(page, fn) { return (this.base.walls[page] || []).find(fn) || null; },
  // —— 复位：关浮层 / 焦点 / 挑选态、收素材架、清草稿与任务；墙和素材架回到真实底子（或给定列表）——
  //   walls：{ image: [...] } 只换给定的几页；empty: true 四面墙全空
  async reset({ page = 'image', walls = null, empty = false, assets = null } = {}) {
    const { studio } = this.m;
    try { window.gc?.(); } catch {}   // 见 cdp.mjs 的 --expose-gc
    for (let i = 0; i < 12 && this.layers.closeTopLayer(); i++) await this.sleep(30);
    if (this.__cat) this.restoreCatalog();
    try { this.dnd.cancelDrag(); } catch {}
    if (this.st.ui.settingsOpen) { try { this.nav.closeSettings?.(); } catch {} this.st.ui.settingsOpen = false; }
    studio.focus = null;
    studio.pick = null;
    studio.drawer = false;
    studio.side.pinned = false;
    studio.side.tab = 'works';
    studio.side.dock = true;   // 参数坞默认开（要看托盘参数段的状态自己关掉它）
    studio.notice = ''; studio.flash = '';
    studio.advOpen = false;
    studio.filesTarget = null;
    studio.jobs = [];
    for (const p of this.PAGES) studio.drafts[p] = { model: '', params: {}, inputs: [], parent: null, negative: '' };
    studio.views.image = { thread: null, turns: [] };
    for (const p of ['video', 'voice', 'music']) studio.views[p] = { focus: null };
    for (const p of this.PAGES) {
      const w = studio.walls[p];
      w.items = empty ? [] : (walls && walls[p]) ? walls[p] : this.base.walls[p].slice();
      w.loaded = true; w.loading = false; w.done = true; w.err = ''; w.cursor = null;
    }
    studio.assets = assets ? assets : empty ? [] : this.base.assets.slice();
    studio.assetsDone = true; studio.assetsErr = '';
    studio.filter = 'all'; studio.q = '';
    studio.page = page;
    await this.sleep(60);
    for (const f of document.querySelectorAll('.studio-root .cp-field')) { f.textContent = ''; f.dispatchEvent(new Event('input', { bubbles: true })); }
    // 上一个状态点开过全文的音频行收回去（组件状态不随复位重挂）
    for (const x of document.querySelectorAll('.studio-root .sw-ahit[aria-expanded="true"]')) x.click();
    // 素材架的搜索框开着就关掉
    document.querySelector('.studio-root .sd-shelf-q .sd-ib')?.click();
    for (const r of document.querySelectorAll('.studio-root .sw-scroll, .studio-root .sd-shelf-body, .studio-root .sd-dock-pane, .studio-root .sf-scroll')) r.scrollTop = 0;
    await this.sleep(200);
    await this.idle(1500);
    return true;
  },
  async go(page) { this.m.studio.page = page; await this.until(() => document.querySelector('.studio-root .sd-page.on')?.getAttribute('aria-label'), 4000); await this.sleep(250); },
  // 素材架打开：宽屏展开侧列，平板 / 手机拉出抽屉
  async shelf(open = true) {
    const { studio } = this.m;
    if (this.lay.expanded) studio.side.pinned = open; else studio.drawer = open;
    await this.sleep(420); await this.idle(1500);
  },
  typeText(text) {
    const f = this.page().querySelector('.cp-field');
    f.focus();
    f.textContent = text;
    f.dispatchEvent(new Event('input', { bubbles: true }));
    const r = document.createRange(); r.selectNodeContents(f); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  },
  /** 造一个任务（kind = image / video / speech / music）；extra.params 决定取景框比例 */
  job(kind, prompt, extra = {}) {
    const { currentModel } = this.m;
    const page = { image: 'image', video: 'video', speech: 'voice', music: 'music' }[kind];
    const id = 'job' + (++this.seq) + Math.random().toString(36).slice(2, 6);
    return { id, kind, key: currentModel(page)?.key || '', prompt, params: extra.params || {}, inputs: [], state: extra.state || 'running', progress: extra.progress ?? 0.42,
      createdAt: Date.now() - (extra.ago ?? 14000), elapsed: (extra.ago ?? 14000) / 1000, eta: extra.eta ?? 21, finishedAt: null, result: extra.result || [], error: extra.error || null,
      ...(extra.thread ? { thread: extra.thread } : {}), ...(extra.uncancelable ? { uncancelable: true } : {}), ...(extra.mine ? { __mine: true } : {}) };
  },
  /** 墙上放一个在跑的任务 */
  runJob(kind, prompt, extra = {}) { return this.m.upsertJob(this.job(kind, prompt, extra)); },
  /** 墙上放一张失败卡：先在跑、再失败（亲眼看着失败的才上墙） */
  failJob(kind, prompt, error, extra = {}) {
    const j = this.job(kind, prompt, extra);
    this.m.upsertJob(j);
    return this.m.upsertJob({ ...j, state: 'error', error });
  },
  /** 打开焦点：图像带续改链（chain = 作品列表，at = 看第几版，dev / err = 链尾在跑 / 失败的一轮） */
  async focus(a, { chain = null, at = null, dev = null, err = null } = {}) {
    const { studio } = this.m;
    const page = a.kind === 'video' ? 'video' : 'image';
    if (studio.page !== page) await this.go(page);
    if (page === 'image') {
      const list = chain || [a];
      const turns = list.map((x) => ({ jobId: null, prompt: x.prompt || '', state: 'done', assets: [x], error: '', srcUrl: '' }));
      if (dev) { const j = this.runJob('image', dev, { thread: list[0].id }); turns.push({ jobId: j.id, prompt: dev, state: 'running', assets: [], error: '', srcUrl: '' }); }
      if (err) { const j = this.failJob('image', err.prompt, err.error, { thread: list[0].id }); turns.push({ jobId: j.id, prompt: err.prompt, state: 'error', assets: [], error: err.error, srcUrl: '' }); }
      studio.views.image = { thread: list[0].id, turns };
      studio.focus = { page, asset: at != null ? list[at] : a };
    } else {
      studio.views.video.focus = { asset: a };
      studio.focus = { page, asset: a };
    }
    await this.until(() => document.querySelector('.studio-root .sd-page.on .sf .sf-media'), 4000, '焦点');
    await this.sleep(300); await this.idle(2500);
  },
  // —— v3（方案 §9.3）：自动识别出来的目录 ——
  // 后端会话用真目录跑出来的样例（catalog-v3.sample.json：schema 卡、继承卡、通用卡、shelf、isNew），换进 studio.catalog；
  // 收尾 restoreCatalog() 换回真后端的目录。
  async v3(page, idRe) {
    if (!this.__cat) this.__cat = JSON.stringify(this.m.studio.catalog);
    this._sample ||= await (await fetch('/scripts/studio-qa/catalog-v3.sample.json')).json();
    const c = JSON.parse(JSON.stringify(this._sample));
    for (const k of ['_note', '_resolve', '_providers']) delete c[k];
    this.m.studio.catalog = c;
    this.m.studio.resolved = {};
    if (idRe) {
      const kind = { image: 'image', video: 'video', voice: 'speech', music: 'music' }[page];
      const m = c.kinds[kind].groups.flatMap((g) => g.models).find((x) => new RegExp(idRe).test(x.id));
      if (m) this.m.studio.drafts[page].model = m.key;
    }
    await this.sleep(250);
  },
  // 十几个参数的 schema 模型：几十个选项的长枚举、超长英文标签、带 desc / unit / hint / format，挂进当前目录的图像第一组
  bigModel() {
    const LONG = ['photographic', 'cinematic', 'analog-film', 'anime', 'comic-book', 'digital-art', 'enhance', 'fantasy-art', 'isometric', 'line-art', 'low-poly',
      'modeling-compound', 'neon-punk', 'origami', 'pixel-art', 'tile-texture', '3d-model', 'watercolor', 'oil-painting', 'charcoal-sketch', 'ukiyo-e', 'art-nouveau',
      'art-deco', 'bauhaus', 'brutalist', 'cyberpunk', 'steampunk', 'vaporwave', 'synthwave', 'film-noir', 'polaroid', 'risograph', 'screen-print', 'blueprint',
      'chalkboard', 'claymation', 'stained-glass', 'paper-cutout', 'embroidery', 'mosaic', 'graffiti', 'long-exposure-night-photography-with-light-trails'];
    const params = [
      { key: 'aspect_ratio', label: '比例', type: 'enum', group: 'basic', format: 'aspect', default: '1:1', options: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '9:21', '5:4', '4:5', '1:4', '4:1', '1:8', '8:1'].map((v) => ({ value: v, label: v === 'auto' ? '自动' : v })) },
      { key: 'resolution', label: '分辨率', type: 'enum', group: 'basic', format: 'resolution', default: '1K', options: [{ value: '1K', label: '1K', hint: '$0.03' }, { value: '2K', label: '2K', hint: '$0.06' }, { value: '4K', label: '4K', hint: '$0.12' }] },
      { key: 'quality', label: '画质', type: 'enum', group: 'basic', default: 'high', options: ['low', 'medium', 'high', 'auto'].map((v) => ({ value: v, label: v })) },
      { key: 'n', label: '张数', type: 'number', group: 'basic', format: 'count', min: 1, max: 4, step: 1, default: 1 },
      { key: 'style_preset', label: '风格', type: 'enum', group: 'advanced', default: '', desc: 'Style preset applied before sampling.', options: [{ value: '', label: '默认' }, ...LONG.map((v) => ({ value: v, label: v }))] },
      { key: 'num_inference_steps', label: '采样步数', type: 'number', group: 'advanced', min: 1, max: 80, step: 1, default: 28, desc: 'Number of denoising steps.' },
      { key: 'guidance_scale', label: '引导强度', type: 'number', group: 'advanced', min: 0, max: 20, step: 0.1, default: 3.5 },
      { key: 'output_format', label: '格式', type: 'enum', group: 'advanced', default: 'jpeg', options: [{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }] },
      { key: 'output_compression', label: '压缩率', type: 'number', group: 'advanced', min: 0, max: 100, step: 1, unit: '%', default: 90, when: { output_format: ['jpeg', 'webp'] } },
      { key: 'background', label: '背景', type: 'enum', group: 'advanced', default: 'auto', options: ['auto', 'transparent', 'opaque'].map((v) => ({ value: v, label: v })) },
      { key: 'safety_tolerance', label: 'Safety tolerance (lower is stricter, higher is more permissive)', type: 'number', group: 'advanced', min: 1, max: 6, step: 1, default: 2, desc: 'Tolerance level for input and output moderation.' },
      { key: 'prompt_upsampling', label: 'Prompt upsampling with a large language model before generation', type: 'bool', group: 'advanced', default: true },
      { key: 'raw', label: 'Raw mode', type: 'bool', group: 'advanced', default: false },
      { key: 'image_prompt_strength', label: 'Image prompt strength', type: 'number', group: 'advanced', min: 0, max: 1, step: 0.01, default: 0.1 },
      { key: 'negative_prompt', label: '负面提示词', type: 'text', group: 'advanced', multiline: true },
      { key: 'seed', label: '种子', type: 'seed', group: 'advanced' },
      { key: 'extra', label: '原始参数', type: 'json', group: 'advanced', desc: 'Passed through as-is.' },
    ];
    const c = this.m.studio.catalog;
    if (!this.__cat) this.__cat = JSON.stringify(c);
    const g = c.kinds.image.groups[0];
    const key = g.provider.id + '/qa/flux-schema-model';
    g.models = [{ key, id: 'qa/flux-schema-model-with-a-very-long-identifier', label: 'FLUX.2 Pro', kind: 'image', async: false, paramSource: 'schema', isNew: true, vendor: 'black-forest-labs', inputs: { text: true, images: { max: 8, roles: ['edit', 'ref'] } }, params }, ...g.models.filter((x) => x.key !== key)];
    this.m.studio.catalog = { ...c };
    this.m.studio.drafts.image.model = key;
    return key;
  },
  // 尺寸参数（方案 §10）：variant 'flex' = GPT Image 自由尺寸（自动 / 原图 / 预设 / 自定义，没有比例）；
  // 'split' = Replicate 式「比例选 custom 才出宽 × 高」（没有档位，只有两个输入框）。挂进图像第一组并选中
  sizeModel(variant = 'flex', size) {
    const FLEX = { width: { min: 16, max: 3840, multipleOf: 16 }, height: { min: 16, max: 3840, multipleOf: 16 }, aspect: { min: 1 / 3, max: 3 }, pixels: { min: 655360, max: 8294400 }, exact: true };
    const px = (w, h, hint) => ({ value: w + 'x' + h, label: w + '×' + h, hint });
    const params = variant === 'split' ? [
      { key: 'aspect_ratio', label: '比例', type: 'enum', group: 'basic', format: 'aspect', default: 'custom', options: ['1:1', '16:9', '3:2', '2:3', '9:16', 'match_input_image', 'custom'].map((v) => ({ value: v, label: v })) },
      { key: 'width_height', label: '尺寸', type: 'size', group: 'basic', format: 'size', options: [], default: { width: 1024, height: 1024 }, when: { aspect_ratio: 'custom' },
        custom: { width: { min: 256, max: 2048, multipleOf: 16 }, height: { min: 256, max: 2048, multipleOf: 16 }, exact: false }, encode: 'split', fields: { width: 'width', height: 'height' } },
      { key: 'output_format', label: '格式', type: 'enum', group: 'advanced', default: 'webp', options: ['webp', 'jpg', 'png'].map((v) => ({ value: v, label: v })) },
      { key: 'extra', label: '原始参数', type: 'json', group: 'advanced' },
    ] : [
      { key: 'size', label: '尺寸', type: 'size', group: 'basic', format: 'size', default: 'auto', editDefault: 'original', custom: FLEX, encode: 'x',
        options: [{ value: 'auto', label: '自动' }, { value: 'original', label: '原图', only: { $edit: true } }, px(1024, 1024, '1:1'), px(1536, 1024, '3:2'), px(1024, 1536, '2:3'), px(2048, 2048, '1:1'), px(2048, 1152, '16:9'), px(1152, 2048, '9:16'), px(3840, 2160, '16:9'), px(2160, 3840, '9:16')] },
      { key: 'quality', label: '画质', type: 'enum', group: 'basic', default: 'high', options: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ value: v, label: v })) },
      { key: 'count', label: '张数', type: 'number', group: 'basic', format: 'count', min: 1, max: 10, step: 1, integer: true, default: 1 },
      { key: 'outputFormat', label: '格式', type: 'enum', group: 'basic', default: 'png', options: [{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }, { value: 'gif', label: 'GIF' }] },
      { key: 'outputCompression', label: '压缩质量', type: 'number', group: 'advanced', min: 0, max: 100, step: 1, integer: true, unit: '%', default: 100, when: { outputFormat: ['jpeg', 'webp'] } },
      { key: 'frameCount', label: '帧数', type: 'number', group: 'advanced', min: 2, max: 16, step: 1, integer: true, default: 9, when: { outputFormat: 'gif' } },
      { key: 'frameDurationMs', label: '每帧时长', type: 'number', group: 'advanced', min: 20, max: 2000, step: 10, integer: true, unit: 'ms', default: 200, when: { outputFormat: 'gif' } },
      { key: 'background', label: '背景', type: 'enum', group: 'advanced', default: 'auto', options: [{ value: 'auto', label: '自动' }, { value: 'opaque', label: '不透明' }, { value: 'transparent', label: '透明', only: { outputFormat: ['png', 'webp'] } }] },
      { key: 'moderation', label: '审核', type: 'enum', group: 'advanced', default: 'auto', options: [{ value: 'auto', label: '自动' }, { value: 'low', label: '宽松' }] },
      { key: 'complexity', label: '规划强度', type: 'enum', group: 'advanced', default: '', options: [{ value: '', label: '默认' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }] },
      { key: 'extra', label: '额外参数', type: 'json', group: 'advanced' },
    ];
    const c = this.m.studio.catalog;
    if (!this.__cat) this.__cat = JSON.stringify(c);
    const g = c.kinds.image.groups[0];
    const key = g.provider.id + '/qa/size-' + variant;
    const label = variant === 'split' ? 'FLUX.2 [pro]' : 'gpt-image-2.6-sunburst-c';
    g.models = [{ key, id: 'qa/size-' + variant, label, kind: 'image', async: false, paramSource: variant === 'split' ? 'card' : 'family', ...(variant === 'split' ? {} : { inheritsFrom: 'gpt-image-2.6-sunburst' }),
      inputs: { text: true, images: { max: 16, roles: ['edit', 'ref'] } }, params }, ...g.models.filter((x) => x.key !== key)];
    this.m.studio.catalog = { ...c };
    this.m.studio.drafts.image.model = key;
    this.m.studio.drafts.image.params = size !== undefined ? { [variant === 'split' ? 'width_height' : 'size']: size } : {};
    return key;
  },
  restoreCatalog() { if (this.__cat) { this.m.studio.catalog = JSON.parse(this.__cat); this.__cat = null; } this.m.studio.resolved = {}; },
};
`;
