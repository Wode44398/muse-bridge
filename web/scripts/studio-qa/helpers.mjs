// 页面里的小工具（window.__qa）：拿到与应用同一份模块实例（vite dev 冷模块图里 import 同一个 URL），
// 造作品 / 任务 / 素材、点按钮、复位状态。场景（scenarios.mjs）只调这些，不直接摸 DOM 细节。
export const HELPERS_SRC = String.raw`
window.__qa = {
  async init() {
    this.st = await import('/src/lib/state.svelte.js');
    this.m = await import('/src/modules/studio/media.svelte.js');
    this.layers = await import('/src/modules/studio/layers.js');
    this.nav = await import('/src/lib/settingsNav.svelte.js');
    this.dnd = await import('/src/lib/dragdrop.svelte.js');
    this.sdrag = await import('/src/modules/studio/drag.js');
    this.adrag = await import('/src/modules/studio/assetDrag.js');
    this.base = { assets: this.m.studio.assets.slice() };
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
    el.scrollIntoView?.({ block: 'nearest' });
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
      const k = r ? Math.round(r.left * 2) + ',' + Math.round(r.top * 2) : '';
      same = k && k === last ? same + 1 : 0; last = k;
      if (same >= 3) return true;
    }
    return false;
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
  // —— 造数据（假图要带 width / height：只有 viewBox 的 SVG 没有固有尺寸，width:auto 的 <img> 会塌成 0 宽）——
  svg(prompt, w = 1024, h = 1024) {
    let x = 2166136261; for (const c of String(prompt)) x = Math.imul(x ^ c.codePointAt(0), 16777619); x >>>= 0;
    const a = x % 360, b = (a + 40 + (x >> 8) % 80) % 360;
    const s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(' + a + ' 55% 66%)"/><stop offset="1" stop-color="hsl(' + b + ' 50% 30%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="' + w * 0.7 + '" cy="' + h * 0.32 + '" r="' + Math.min(w, h) * 0.12 + '" fill="#fff6e0" fill-opacity=".8"/><path d="M0 ' + h * 0.78 + ' Q ' + w * 0.3 + ' ' + h * 0.55 + ' ' + w * 0.55 + ' ' + h * 0.72 + ' T ' + w + ' ' + h * 0.6 + ' V ' + h + ' H 0 Z" fill="#14202a" fill-opacity=".55"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  },
  // 能真解码的静音 WAV（4kHz、8 位单声道，时长同作品）：空的 data:audio/wav 会让播放器走失败态（11-06 起媒体失败会显示「重新加载」）
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
  asset(kind, prompt, extra = {}) {
    const id = 'qa' + (++this.seq).toString(36) + Math.random().toString(36).slice(2, 6);
    const w = extra.w || 1024, h = extra.h || 1024;
    const vis = kind === 'image' || kind === 'video';
    return { id, kind, prompt, provider: extra.provider || '', model: extra.model || 'gemini-3.1-flash-lite-image', params: {}, parents: extra.parents || [], w, h,
      createdAt: extra.createdAt || Date.now() - (extra.ago || 0), thread: extra.thread, url: vis ? this.svg(prompt, w, h) : this.wav(extra.duration || 8), thumb: vis ? this.svg(prompt, 320, Math.round(320 * h / w)) : '', duration: extra.duration || (vis ? undefined : 8), ...(extra.wsPath ? { wsPath: extra.wsPath } : {}) };
  },
  history() {
    const A = (k, p, x) => this.asset(k, p, x);
    const base = A('image', '黄昏的海边灯塔，胶片质感，远处有渔船', { ago: 86400e3 * 1.2 });
    base.thread = base.id;
    const edit = A('image', '加一只停在栏杆上的海鸥', { ago: 86400e3 * 1.1, thread: base.id, parents: [base.id] });
    const list = [
      A('image', '一碗冒着热气的拉面，俯拍，木桌，柔和的自然光，浅景深，杂志封面风格，右上角留出放标题的空间', { ago: 600e3, model: 'gemini-3-pro-image' }),
      A('audio', '欢迎来到 Media Studio。今天我们用一句话做出一张图、一段视频和一首曲子。', { ago: 3600e3 * 2, model: 'gemini-2.5-flash-tts', duration: 6 }),
      A('video', '镜头缓慢推近灯塔，海浪拍岸', { ago: 3600e3 * 5, model: 'veo-3.1-lite-generate-001', parents: [edit.id], w: 1280, h: 720, duration: 4 }),
      A('music', 'Warm piano and strings, slow tempo, cinematic', { ago: 86400e3 * 0.6, model: 'lyria-002', duration: 30 }),
      edit, base,
      A('image', 'A very long English prompt that keeps going: an isometric cutaway of a tiny bookshop with warm lamps, rain outside, cats on shelves', { ago: 86400e3 * 3, model: 'gpt-image-2.6-sunburst', w: 1536, h: 1024 }),
      A('image', '竖版海报', { ago: 86400e3 * 4, w: 720, h: 1280 }),
    ];
    return list;
  },
  // —— 复位：关浮层、收抽屉、清草稿与画布、清任务；作品回到基线（或给定列表）——
  async reset({ assets = null, page = 'image' } = {}) {
    const { studio } = this.m;
    for (let i = 0; i < 12 && this.layers.closeTopLayer(); i++) await this.sleep(30);
    if (this.__cat) this.restoreCatalog();   // 上一个 v3 状态换进来的样例目录
    try { this.dnd.cancelDrag(); } catch {}
    if (this.st.ui.settingsOpen) { try { this.nav.closeSettings?.(); } catch {} this.st.ui.settingsOpen = false; }
    document.querySelectorAll('.sst-layer').forEach(() => {});
    studio.drawer = false;
    studio.notice = '';
    studio.jobs = [];
    for (const p of ['image', 'video', 'voice', 'music']) {
      studio.drafts[p] = { model: '', params: {}, inputs: [], parent: null, negative: '' };
    }
    studio.views.image = { thread: null, turns: [] };
    for (const p of ['video', 'voice', 'music']) studio.views[p] = { focus: null };
    studio.assets = assets ? assets : this.base.assets.slice();
    studio.filter = 'all'; studio.q = '';
    studio.side.tab = 'works';
    studio.side.dock = true;   // 参数坞默认开（值芯片的状态会自己关掉它）
    studio.page = page;
    await this.sleep(60);
    for (const f of document.querySelectorAll('.studio-root .cp-field')) { f.textContent = ''; f.dispatchEvent(new Event('input', { bubbles: true })); }
    document.querySelector('.studio-root .sb-q-x')?.click();
    for (const r of document.querySelectorAll('.studio-root .sd-dock-pane, .studio-root .ws')) r.scrollTop = 0;   // 上一个状态滚到底的右栏 / 作品流别带过来
    await this.sleep(160);
    return true;
  },
  async go(page) { this.m.studio.page = page; await this.until(() => document.querySelector('.studio-root .sd-page.on')?.getAttribute('aria-label'), 4000); await this.sleep(200); },
  typeText(text) {
    const f = this.page().querySelector('.cp-field');
    f.focus();
    f.textContent = text;
    f.dispatchEvent(new Event('input', { bubbles: true }));
    const r = document.createRange(); r.selectNodeContents(f); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  },
  job(kind, prompt, extra = {}) {
    const { studio, currentModel } = this.m;
    const page = { image: 'image', video: 'video', speech: 'voice', music: 'music' }[kind];
    const id = 'job' + (++this.seq) + Math.random().toString(36).slice(2, 6);
    return { id, kind, key: currentModel(page)?.key || '', prompt, params: {}, inputs: [], state: extra.state || 'running', progress: extra.progress ?? 0.42,
      createdAt: Date.now() - (extra.ago ?? 14000), elapsed: (extra.ago ?? 14000) / 1000, eta: extra.eta ?? 21, finishedAt: null, result: extra.result || [], error: extra.error || null, ...(extra.uncancelable ? { uncancelable: true } : {}) };
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
  restoreCatalog() { if (this.__cat) { this.m.studio.catalog = JSON.parse(this.__cat); this.__cat = null; } this.m.studio.resolved = {}; },
};
`;
