// 预览入口统一：聊天流里的各个「点开」都走 openPreview + 统一外框。
//
// 数据：往隔离实例（--name 指定）的数据目录里放几份假媒体与附件（样张只读，复制过去），再在页面里把
// chat.messages 换成一段假会话——用户发了两张图 + 一份 PDF，助手回了生成的图 / 视频 / 音乐。
// 不碰真实会话、不落盘会话记录。假媒体只落在该实例自己的数据目录（%TEMP%\bridge-preview-qa\inst-<name>\data）：
// dev.mjs stop 不删数据根，但会顺手删掉这些假媒体（media\e17e0001-* 与 uploads\1763000000*）；--fresh 起实例时整个数据根重建。
//
// 场景（全部真手势点聊天流里的元素，结论靠数值）：
//   entry-gallery  点用户的第二张图 → 会话画廊 3 张（2 张上传 + 1 张生成）、从第 2 张开、带 originRect；翻到下一张是生成图
//   entry-name     点生成图 → 下载名 = 提示词前 40 字 + .png（真点「下载」截下 <a download>），信息面板里有完整提示词
//   entry-video    生成视频卡：海报帧、时长角标；点开进查看器即播，海报不指向视频本身
//   entry-audio    生成音乐的迷你播放条：点播放真在走；展开进查看器（迷你条停下、查看器读到时长）
//   entry-pdf      用户的 PDF 附件芯片 → PDF 画布画出来
//   entry-layer    笔记里点附件 = 压一层：返回（系统返回 / Esc）回到笔记原位置，再关才真关
//   entry-ctx      图片上下文菜单：电脑右键 = 查看器自己的菜单（复制图片写进剪贴板是 PNG）；触屏长按只记录（长按识别归图片查看器）
//                  放在最后：触屏档长按后 gestures 那两下不 await 的鼠标事件回执一直挂着，同一会话里之后每次截图前
//                  settle 的 mouseMoved 都要等满 30 秒超时（框架问题，已报给地基）
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as C from '../lib/checks.mjs';
import { SAMPLES_DIR, parseArgs, pidFile, readJson } from '../lib/paths.mjs';

const IDS = { img: 'e17e0001-0000-4000-8000-00000000a001', vid: 'e17e0001-0000-4000-8000-00000000a002', aud: 'e17e0001-0000-4000-8000-00000000a003' };
// 长提示词（> 40 字，带 / 和 : 这类不能进文件名的字符）
const PROMPT = '一只橘猫坐在雨天的窗台上：水彩风格/柔和晨光，窗外是模糊的城市天际线与远处的霓虹灯，画面安静而温暖，细节丰富';
const UP = { a: '1763000000000-窗台.jpg', b: '1763000000001-图.webp', pdf: '1763000000002-季度报告.pdf' };
const USER_TEXT = '【pvqa-entry】看看这两张图和这份报告';

// Node 侧：把样张复制进实例的 media / uploads（只在缺的时候复制）
function seed() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.name) return '要用 --name 指定隔离实例（假会话的媒体与附件放进它的数据目录）';
  const inst = readJson(pidFile(String(a.name)));
  if (!inst?.dataRoot) return '实例 pid.json 里没有 dataRoot';
  const media = path.join(inst.dataRoot, 'media'), up = path.join(inst.dataRoot, 'uploads');
  mkdirSync(media, { recursive: true });
  mkdirSync(up, { recursive: true });
  const cp = (rel, dst) => { if (!existsSync(dst)) copyFileSync(path.join(SAMPLES_DIR, rel), dst); };
  const rec = (id, ext, kind, prompt, src) => {
    cp(src, path.join(media, id + '.' + ext));
    const j = path.join(media, id + '.json');
    if (!existsSync(j)) writeFileSync(j, JSON.stringify({ id, ext, kind, prompt, model: 'pvqa', created: Date.now() }));
  };
  rec(IDS.img, 'png', 'image', PROMPT, '图片/透明.png');
  rec(IDS.vid, 'mp4', 'video', '海边日落延时', '视频/竖拍-1080x1920.mp4');
  rec(IDS.aud, 'mp3', 'music', '轻松的钢琴小品', '音频/带封面.mp3');
  cp('图片/相机EXIF.jpg', path.join(up, UP.a));
  cp('图片/图.webp', path.join(up, UP.b));
  cp('文档/中文字体.pdf', path.join(up, UP.pdf));
  return '';
}

const raw = (f, thumb) => '/api/upload/raw?name=' + encodeURIComponent(f) + (thumb ? '&thumb=' + thumb : '');
const img = (f) => ({ name: f.replace(/^\d+-/, ''), kind: 'image', url: raw(f), thumb: raw(f, 'preview'), file: f });
const MESSAGES = [
  { role: 'user', text: USER_TEXT, attachments: [img(UP.a), img(UP.b), { name: '季度报告.pdf', kind: 'file', url: null, file: UP.pdf }] },
  {
    role: 'assistant',
    segments: [
      { kind: 'text', md: '好的，下面是生成的图、视频与音乐。' },
      { kind: 'media', mediaKind: 'image', id: IDS.img, status: 'ready', prompt: PROMPT, ext: 'png' },
      { kind: 'media', mediaKind: 'video', id: IDS.vid, status: 'ready', prompt: '海边日落延时', ext: 'mp4' },
      { kind: 'media', mediaKind: 'music', id: IDS.aud, status: 'ready', prompt: '轻松的钢琴小品', ext: 'mp3' },
    ],
    thinking: '', thinkingOpen: false, status: 'done', error: null, tokens: 0, thinkingTokens: 0, startedAt: 0, elapsed: 0,
    question: null, phase: 'done', idle: false, bgHold: null, textBreak: false, wait: null, thinkStart: 0, thinkEnd: null,
    retry: null, compacting: false, hint: null, hintAt: 0, replayAt: 0,
  },
];

// 页面侧：进 Claude 分页、换上假会话（已经在就不动）。返回 'set' | 'kept'
async function ensureChat(ctx) {
  const err = seed();
  if (err) { ctx.assert('准备假会话数据', false, err); throw new Error(err); }
  const r = await ctx.eval(`(async () => {
    const S = await import('/src/lib/state.svelte.js');
    const Ch = await import('/src/lib/chat.svelte.js');
    const msgs = ${JSON.stringify(MESSAGES)};
    const ready = () => document.querySelectorAll('.thread .u-img').length === 2 && document.querySelector('.thread .cmv') && document.querySelector('.thread .cma') && document.querySelector('.thread .cmi');
    if (Ch.chat.messages?.[0]?.text === msgs[0].text && ready()) return 'kept';
    S.ui.screen = 'claude';
    await __pvqa.until(() => document.querySelector('.thread, .greeting'), 30000, 'Claude 分页');
    await __pvqa.sleep(400);
    Ch.chat.messages = msgs;
    S.ui.view = 'chat';
    await __pvqa.until(ready, 20000, '假会话渲染');
    // 空态（问候 + 输入框）有退场动画，退完之前它还盖在聊天流上
    await __pvqa.until(() => !document.querySelector('main.hero'), 6000, '空态退场');
    await __pvqa.sleep(300);
    return 'set';
  })()`, { timeout: 60000 });
  ctx.metric('_chat', r);
  return r;
}

const PV = `__pvqa.pv.preview`;
const cur = (expr) => `(() => { const p = ${PV}; const it = p.items[p.index]; return ${expr}; })()`;

// 聊天流里的元素：先滚到视口正中（输入栏浮在滚动区下沿，「nearest」会停在它底下），确认落点没被挡再点
async function revealIn(ctx, sel, { text = null } = {}) {
  await ctx.eval(`(async () => { const tx = ${JSON.stringify(text)}; const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => tx == null || (e.textContent || '').includes(tx));
    if (!el) return false; el.scrollIntoView({ block: 'center' }); for (let i = 0, prev = ''; i < 40; i++) { await new Promise((r) => requestAnimationFrame(r)); const b = el.getBoundingClientRect(); const k = Math.round(b.top) + ''; if (k === prev) break; prev = k; } return true; })()`);
  return ctx.g.center(sel, { text });
}
async function tapIn(ctx, sel, { text = null, what = sel } = {}) {
  const c = await revealIn(ctx, sel, { text });
  ctx.assert(what + ' 点得到（没被挡住）', c.hitOk, c.hit);
  await ctx.g.tap(c.x, c.y);
  return c;
}

// 打开查看器的「更多」菜单，点名字含 text 的那一项。
// 触屏菜单是弹簧展开（ios27 MorphMenu）：展开到八成之前菜单项不接手势、点下去落在挡板上，
// 慢一点的档 250ms 还没展开够——等落点真命中菜单项、且隔两帧位置不再动再点
async function menuPick(ctx, text) {
  await ctx.g.tapSel('.vw-btn[aria-haspopup="menu"]', { within: ctx.ROOT_SEL });
  const c = await ctx.waitFor(`(async () => {
    const at = () => { const it = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
      if (!it) return null; const b = it.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const h = document.elementFromPoint(x, y); return { x, y, ok: !!h && (h === it || it.contains(h)) }; };
    const a = at(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const b = at();
    return a && b && b.ok && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 ? b : null; })()`, 5000, '菜单项可点');
  await ctx.g.tap(c.x, c.y);
}

export default [
  {
    id: 'entry-gallery',
    title: '聊天图片：会话画廊，从点的那张开，带缩略图位置',
    tags: ['entry'],
    timeout: 120000,
    async run(ctx) {
      await ensureChat(ctx);
      const t0 = Date.now();
      const c = await tapIn(ctx, '.thread .u-img:nth-of-type(2)', { what: '第二张缩略图' });
      await ctx.waitFor(`!!__pvqa.root()`, 8000, '查看器根');
      const st = await ctx.eval(`(() => { const p = ${PV}; const it = p.items[p.index]; return { n: p.items.length, index: p.index, kinds: p.items.map((x) => x.kind).join(','), origins: p.items.map((x) => x.origin).join(','), name: it?.name, rect: it?.originRect ? { ...it.originRect } : null }; })()`);   // 条目是深代理：CDP 按值回传代理会变成 {}，先拷成普通对象
      ctx.metric('gallery', st);
      ctx.assert('画廊 = 3 张（2 张上传 + 1 张生成）', st.n === 3, st.n, { expect: 3 });
      ctx.assert('从点的那张（第 2 张）开', st.index === 1, st.index, { expect: 1 });
      ctx.assert('全是图片、来源依次 upload,upload,vertex', st.kinds === 'image,image,image' && st.origins === 'upload,upload,vertex', st.origins);
      ctx.assert('当前名字 = 去掉时间戳的上传名', st.name === '图.webp', st.name);
      ctx.assert('带 originRect（缩略图位置）', !!st.rect && Math.abs(st.rect.x - (c.x - c.w / 2)) <= 2 && Math.abs(st.rect.w - c.w) <= 2, st.rect);
      const im = await C.image(ctx, { t0 });
      if (im) ctx.assert('主图是上传原件（/api/upload/raw）', /\/api\/upload\/raw\?name=[^&]*%E5%9B%BE\.webp/.test(im.src), im.src.slice(0, 90));
      await ctx.shot('open');
      // 翻到下一张：触屏左滑、电脑方向键
      if (ctx.touch) await ctx.g.swipe({ x: ctx.cfg.w * 0.8, y: ctx.cfg.h / 2 }, { x: ctx.cfg.w * 0.15, y: ctx.cfg.h / 2 }, { ms: 260, steps: 12 });
      else await ctx.g.key('arrowright');
      const ni = await ctx.waitFor(`${PV}.index === 2 ? ${PV}.items[2].name : null`, 6000, '翻到第 3 张').catch(() => null);
      ctx.assert('翻到下一张 = 生成图（提示词命名 .png）', !!ni && /\.png$/.test(ni), ni);
    },
  },
  {
    id: 'entry-name',
    title: '生成图片：下载名 = 提示词前 40 字 + 扩展名，信息面板有提示词',
    tags: ['entry'],
    timeout: 120000,
    async run(ctx) {
      await ensureChat(ctx);
      await tapIn(ctx, '.thread .cmi', { what: '生成图' });
      await ctx.waitFor(`!!__pvqa.root()`, 8000, '查看器根');
      const st = await ctx.eval(cur(`({ n: p.items.length, index: p.index, name: it.name, prompt: it.prompt, dl: it.downloadHref })`));
      ctx.metric('item', { ...st, dl: String(st.dl || '').replace(/token=[^&]+/, 'token=…').slice(0, 90) });
      ctx.assert('生成图也进会话画廊（第 3 张）', st.n === 3 && st.index === 2, `${st.index}/${st.n}`);
      const stem = String(st.name || '').replace(/\.png$/, '');
      ctx.assert('下载名以 .png 结尾', /\.png$/.test(st.name || ''), st.name);
      ctx.assert('下载名不含 \\ / : * ? " < > |', !/[\\/:*?"<>|]/.test(st.name || ''), st.name);
      ctx.assert('文件名主干 ≤ 40 字、取自提示词开头', Array.from(stem).length <= 40 && stem.length > 8 && PROMPT.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').startsWith(stem), stem);
      ctx.assert('完整提示词带进条目', st.prompt === PROMPT, (st.prompt || '').length);
      await C.image(ctx);
      // 真点「下载」：截下 <a download> 的名字（不让浏览器真去下）
      await ctx.eval(`(() => { window.__pvqaDl = []; const orig = HTMLAnchorElement.prototype.click; if (!window.__pvqaDlOrig) window.__pvqaDlOrig = orig;
        HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute('download')) { window.__pvqaDl.push({ name: this.download, href: this.getAttribute('href') }); return; } return window.__pvqaDlOrig.call(this); }; return true; })()`);
      try {
        await menuPick(ctx, '下载');
        const dl = await ctx.waitFor(`window.__pvqaDl.length ? window.__pvqaDl[0] : null`, 5000, '下载被触发').catch(() => null);
        ctx.metric('download', dl ? { name: dl.name, href: String(dl.href).replace(/token=[^&]+/, 'token=…').slice(0, 90) } : null);
        ctx.assert('点「下载」用的文件名 = 提示词名 + .png', !!dl && dl.name === st.name, dl?.name);
      } finally {
        await ctx.eval(`(() => { if (window.__pvqaDlOrig) HTMLAnchorElement.prototype.click = window.__pvqaDlOrig; return true; })()`).catch(() => {});
      }
      await ctx.sleep(400);
      // 信息面板：完整提示词
      await menuPick(ctx, '文件信息');
      const info = await ctx.waitFor(`(() => { const d = document.querySelector('.vw-info'); if (!d) return null; const rows = [...d.querySelectorAll('.vw-info-row')].map((r) => [r.querySelector('dt')?.textContent.trim(), r.querySelector('dd')?.textContent.trim()]); const hit = rows.find((r) => r[0] === '提示词'); return hit ? { rows: rows.length, prompt: hit[1] } : null; })()`, 6000, '信息面板提示词行').catch(() => null);
      ctx.metric('info', info ? { rows: info.rows, promptLen: info.prompt.length } : null);
      ctx.assert('信息面板显示完整提示词', !!info && info.prompt === PROMPT, info?.prompt?.slice(0, 20));
      await ctx.shot('info');
    },
  },
  {
    id: 'entry-video',
    title: '生成视频卡：海报 + 时长 + 播放钮，点开进查看器即播',
    tags: ['entry'],
    timeout: 120000,
    async run(ctx) {
      await ensureChat(ctx);
      const card = await ctx.waitFor(`(() => { const c = document.querySelector('.thread .cmv'); if (!c) return null; const im = c.querySelector('img.cmv-media'), v = c.querySelector('video.cmv-media'), d = c.querySelector('.cmv-dur');
        const painted = (im && im.complete && im.naturalWidth > 0) || (v && v.readyState >= 2); if (!painted || !d) return null; const r = c.getBoundingClientRect();
        return { stage: im ? 'img' : v ? 'video' : 'none', nw: im?.naturalWidth || v?.videoWidth || 0, nh: im?.naturalHeight || v?.videoHeight || 0, dur: d.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), play: !!c.querySelector('.cmv-play') }; })()`, 15000, '视频卡海报与时长').catch(() => null);
      await revealIn(ctx, '.thread .cmv');
      ctx.metric('card', card);
      ctx.assert('卡片画出了海报帧', !!card && card.nw > 0, card?.stage);
      ctx.assert('时长角标（m:ss）', !!card && /^\d+:\d\d$/.test(card.dur), card?.dur);
      ctx.assert('竖视频卡片按画面比例（高 > 宽）', !!card && card.h > card.w, card ? `${card.w}×${card.h}` : null);
      ctx.assert('有播放钮', !!card?.play, card?.play);
      await ctx.shot('card');
      const t0 = Date.now();
      await tapIn(ctx, '.thread .cmv', { what: '视频卡' });
      await ctx.waitFor(`!!__pvqa.root()`, 8000, '查看器根');
      const st = await ctx.eval(cur(`({ n: p.items.length, kind: it.kind, poster: it.poster, url: it.url, rect: !!it.originRect, dur: it.duration || 0 })`));
      ctx.metric('item', { n: st.n, kind: st.kind, rect: st.rect, dur: st.dur, poster: String(st.poster || '').slice(0, 70) });
      ctx.assert('单独打开（不进图片画廊）', st.n === 1 && st.kind === 'video', `${st.n}/${st.kind}`);
      ctx.assert('海报不指向视频本身', !!st.poster && st.poster !== st.url && /[?&]v=(thumb|preview)/.test(st.poster), String(st.poster).slice(0, 60));
      ctx.assert('带 originRect 与已知时长', st.rect && st.dur > 0, `${st.rect}/${st.dur}`);
      // 点开即播：不用场景自己调 play()
      const auto = await ctx.waitFor(`(() => { const v = __pvqa.root()?.querySelector('video'); return v && !v.paused && v.currentTime > 0.3 ? { t: +v.currentTime.toFixed(2), muted: v.muted } : null; })()`, 12000, '自动播放').catch(() => null);
      ctx.metric('autoplay', auto);
      ctx.metric('autoplayMs', auto ? Date.now() - t0 : null);
      ctx.assert('点开即播（currentTime 前进）', !!auto, auto);
      await C.video(ctx, { t0, play: false });
      await ctx.shot('viewer');
    },
  },
  {
    id: 'entry-audio',
    title: '生成音乐迷你播放条：点播放真在走，展开进查看器',
    tags: ['entry'],
    timeout: 120000,
    async run(ctx) {
      await ensureChat(ctx);
      const bar = await ctx.eval(`(() => { const c = document.querySelector('.thread .cma'); if (!c) return null; const r = c.getBoundingClientRect(); const bs = [...c.querySelectorAll('button')].map((b) => { const q = b.getBoundingClientRect(); return Math.round(Math.min(q.width, q.height)); }); return { w: Math.round(r.width), h: Math.round(r.height), btnMin: Math.min(...bs), title: c.querySelector('.cma-title')?.textContent.trim(), bg: getComputedStyle(c).backgroundColor }; })()`);
      ctx.metric('bar', bar);
      ctx.assert('迷你条在', !!bar && bar.h >= 44, bar && `${bar.w}×${bar.h}`);
      ctx.assert(ctx.touch ? '触屏按钮 ≥ 44' : '桌面按钮 ≥ 32', !!bar && bar.btnMin >= (ctx.touch ? 44 : 32), bar?.btnMin);
      ctx.assert('标题 = 提示词', bar?.title === '轻松的钢琴小品', bar?.title);
      const pre = await ctx.waitFor(`(() => { const s = document.querySelector('.thread .cma-time')?.textContent || ''; return /\\d+:\\d\\d$/.test(s.trim()) ? s.trim() : null; })()`, 10000, '没播先探到时长').catch(() => null);
      ctx.assert('没播之前就显示时长', !!pre, pre, { level: 'goal' });
      await tapIn(ctx, '.thread .cma-play', { what: '播放钮' });
      const play = await ctx.waitFor(`(() => { const a = document.querySelector('.thread .cma audio'); return a && !a.paused && a.currentTime > 0.8 ? { t: +a.currentTime.toFixed(2), dur: Math.round(a.duration), src: (a.currentSrc || '').slice(0, 5) } : null; })()`, 15000, '迷你条播放').catch(() => null);
      ctx.metric('play', play);
      ctx.assert('点播放后 currentTime 前进', !!play, play);
      ctx.assert('整段缓存成本地 blob 再播', play?.src === 'blob:', play?.src);
      const fill = await ctx.eval(`(() => { const f = document.querySelector('.thread .cma-fill'); const m = /scaleX\\(([\\d.e-]+)\\)/.exec(f?.style.transform || ''); return m ? +(+m[1]).toFixed(4) : null; })()`);
      ctx.metric('fill', fill);
      ctx.assert('进度条在走', fill > 0, fill);
      await ctx.shot('playing');
      await tapIn(ctx, '.thread .cma-exp', { what: '展开钮' });
      await ctx.waitFor(`!!__pvqa.root()`, 8000, '查看器根');
      const st = await ctx.eval(cur(`({ n: p.items.length, kind: it.kind, origin: it.origin, name: it.name, dur: it.duration || 0, mini: document.querySelector('.thread .cma audio')?.paused })`));
      ctx.metric('item', st);
      ctx.assert('展开 = 查看器里的音频（生成作品）', st.n === 1 && st.kind === 'audio' && st.origin === 'vertex', `${st.kind}/${st.origin}`);
      ctx.assert('展开时迷你条停下', st.mini === true, st.mini);
      ctx.assert('下载名 = 提示词 + .mp3', st.name === '轻松的钢琴小品.mp3', st.name);
      await C.audio(ctx);
      await ctx.shot('viewer');
    },
  },
  {
    id: 'entry-pdf',
    title: '用户的 PDF 附件：芯片可点，进查看器画出来',
    tags: ['entry'],
    timeout: 120000,
    async run(ctx) {
      await ensureChat(ctx);
      const t0 = Date.now();
      const c = await tapIn(ctx, '.thread .u-file.u-open', { text: '季度报告', what: 'PDF 附件芯片' });
      ctx.assert(ctx.touch ? '芯片高 ≥ 44' : '芯片高 ≥ 32', c.h >= (ctx.touch ? 44 : 32), Math.round(c.h));
      await ctx.waitFor(`!!__pvqa.root()`, 8000, '查看器根');
      const st = await ctx.eval(cur(`({ n: p.items.length, kind: it.kind, origin: it.origin, name: it.name, url: (it.url || '').replace(location.origin, '').slice(0, 80) })`));
      ctx.metric('item', st);
      ctx.assert('PDF 条目（聊天附件）', st.n === 1 && st.kind === 'pdf' && st.origin === 'upload', `${st.kind}/${st.origin}`);
      ctx.assert('名字去掉存盘时间戳', st.name === '季度报告.pdf', st.name);
      await C.canvas(ctx, { t0 });
      await ctx.shot();
    },
  },
  {
    id: 'entry-md-img',
    title: '回答正文里的 markdown 图片：点图进查看器，同段两张成组、从点的那张开',
    tags: ['entry'],
    timeout: 120000,
    async run(ctx) {
      await ensureChat(ctx);
      // 临时追加一条助手消息（正文两张 markdown 图），验完撤掉，不影响其它场景的假会话
      const md = '正文里的两张图：\n\n![窗台](' + raw(UP.a) + ')\n\n![](' + raw(UP.b) + ')';
      const msg = { ...MESSAGES[1], pvqaMd: true, segments: [{ kind: 'text', md }] };
      await ctx.eval(`(async () => { const Ch = await import('/src/lib/chat.svelte.js');
        Ch.chat.messages = [...Ch.chat.messages.filter((m) => !m.pvqaMd), ${JSON.stringify(msg)}];
        await __pvqa.until(() => { const im = [...document.querySelectorAll('.thread .answer img')]; return im.length === 2 && im.every((x) => x.complete && x.naturalWidth > 0); }, 15000, '正文图片加载');
        return true; })()`, { timeout: 30000 });
      try {
        const cursor = await ctx.eval(`getComputedStyle(document.querySelector('.thread .answer img')).cursor`);
        ctx.assert('正文图片悬停是放大镜光标', cursor === 'zoom-in', cursor, { level: 'info' });
        await tapIn(ctx, '.thread .answer img[alt="窗台"]', { what: '正文第一张图' });
        await ctx.waitFor(`!!__pvqa.root()`, 8000, '查看器根');
        const st = await ctx.eval(`(() => { const p = ${PV}; const it = p.items[p.index]; return { n: p.items.length, index: p.index, kinds: p.items.map((x) => x.kind).join(','), origin: it?.origin, name: it?.name, rect: !!it?.originRect }; })()`);
        ctx.metric('mdGallery', st);
        ctx.assert('同段两张成组、从点的那张开', st.n === 2 && st.index === 0 && st.kinds === 'image,image', st);
        ctx.assert('名字取自地址（去掉存盘时间戳），不是「raw」', st.name === '窗台.jpg', st.name);
        ctx.assert('带缩略图位置（开场从图放大）', st.rect, st.rect);
        await C.image(ctx);
        await ctx.shot();
      } finally {
        await ctx.eval(`(async () => { const Ch = await import('/src/lib/chat.svelte.js'); Ch.chat.messages = Ch.chat.messages.filter((m) => !m.pvqaMd); return true; })()`).catch(() => {});
      }
    },
  },
  {
    id: 'entry-layer',
    title: '笔记里的附件：压一层打开，返回回到笔记原位置，再关才真关',
    tags: ['entry'],
    timeout: 120000,
    async run(ctx) {
      await ctx.open([ctx.item('笔记/笔记.md', { kind: 'markdown' })], 0);
      await C.text(ctx, '预览样张笔记', { name: 'md 标题渲染' });
      // 等排版落定再量再点：这篇有公式，KaTeX 按需加载，到货后阅读态整篇重渲（mdState.epoch），图也会重新解码——
      // 赶在这之前点，链接节点在按下和抬起之间被换掉，点击就丢了。条件：公式已渲染、图片到齐、300ms 内正文没变
      const settled = await ctx.waitFor(`(async () => { const md = __pvqa.root()?.querySelector('.doc-md'); if (!md || !md.querySelector('.katex')) return null;
        if ([...md.querySelectorAll('img')].some((i) => !i.complete)) return null;
        let n = 0; const mo = new MutationObserver(() => n++); mo.observe(md, { childList: true, subtree: true }); await new Promise((r) => setTimeout(r, 300)); mo.disconnect(); return n === 0; })()`, 10000, '笔记排版落定').catch(() => false);
      ctx.assert('笔记排版落定（公式已渲染、图片到齐）', !!settled, settled, { level: 'info' });
      const LINK = `[...__pvqa.root().querySelectorAll('a')].find((a) => (a.textContent || '').includes('PDF 附件'))`;
      // 链接在文末：滚到滚动区中间，记下它离视口顶的距离（回来后要落回同一处）
      const before = await ctx.eval(`(async () => { const a = ${LINK}; if (!a) return null; a.scrollIntoView({ block: 'center' });
        for (let i = 0, prev = ''; i < 40; i++) { await new Promise((r) => requestAnimationFrame(r)); const k = Math.round(a.getBoundingClientRect().top) + ''; if (k === prev) break; prev = k; }
        return Math.round(a.getBoundingClientRect().top); })()`);
      ctx.assert('笔记里有「PDF 附件」链接', before != null, before);
      if (before == null) return;
      // 窄屏上链接会折行，包围盒中心可能落在别的链接上：取第一个行盒的中心，并确认落点就是这条链接
      const c = await ctx.eval(`(() => { const a = ${LINK}; const b = a.getClientRects()[0]; const x = b.left + Math.min(b.width / 2, 12), y = b.top + b.height / 2; const h = document.elementFromPoint(x, y); return { x, y, ok: !!h && (h === a || a.contains(h)) }; })()`);
      ctx.assert('「PDF 附件」点得到（没被挡住、没点到别的链接）', c.ok, c);
      await ctx.g.tap(c.x, c.y);
      const up = await ctx.waitFor(`(() => { const p = ${PV}; const it = p.items[p.index]; return it && it.kind === 'pdf' ? { depth: __pvqa.pv.previewLayers.depth, name: it.name } : null; })()`, 8000, '附件层').catch(() => null);
      ctx.metric('pushed', up);
      ctx.assert('点附件 = 压一层（depth 1，当前是 PDF）', up?.depth === 1 && up.name === '横竖混排.pdf', up);
      // 压层失败时后面的「返回 / 位置 / 再关」都没有意义（Esc 会直接关掉查看器，关闭动画期间还能骗过检查）：判不过并停下
      if (!up) { ctx.assert('压层失败，返回链路无从验证', false, null); return; }
      await C.canvas(ctx);
      if (!ctx.touch) {
        const lbl = await ctx.eval(`(() => { const b = document.querySelector('.vw-close'); return b ? (b.getAttribute('aria-label') || b.title || '') : null; })()`);
        ctx.metric('closeLabel', lbl);
        ctx.assert('层叠时左上钮语义是「返回」', /返回/.test(lbl || ''), lbl, { level: 'goal' });
      }
      await ctx.shot('attachment');
      // 返回：触屏走系统返回（浏览器通道 = history.back），电脑按 Esc
      if (ctx.touch) await ctx.eval(`(history.back(), true)`); else await ctx.g.key('Escape');
      // 关闭动画（约 320ms）里 preview.open 仍为真：排除 .vw-closing，并隔 450ms 再采一次，两次都还开着才算「回到笔记」
      const BACK = `(() => { const p = ${PV}; const it = p.items[p.index]; if (!p.open || !it || it.kind !== 'markdown' || document.querySelector('.vw-closing')) return null; const a = ${LINK}; return a ? { depth: __pvqa.pv.previewLayers.depth, top: Math.round(a.getBoundingClientRect().top) } : null; })()`;
      let back = await ctx.waitFor(BACK, 8000, '回到笔记').catch(() => null);
      if (back) { await ctx.sleep(450); back = await ctx.eval(BACK).catch(() => null); }
      ctx.metric('back', back);
      ctx.assert('返回 = 回到笔记（查看器还开着，depth 0）', back?.depth === 0, back);
      // 文档重新排版有个过程：等位置稳定再比
      const top = back ? await ctx.waitFor(`(async () => { let prev = null; for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 50)); const a = ${LINK}; const k = a ? Math.round(a.getBoundingClientRect().top) : null; if (k === prev) return k; prev = k; } return prev; })()`, 6000, '位置稳定').catch(() => null) : null;
      ctx.metric('linkTop', { before, after: top });
      ctx.assert('回到离开时的位置（链接离视口顶 ±48px）', top != null && Math.abs(top - before) <= 48, `${before} → ${top}`);
      await ctx.shot('back');
      // 再关一次：这次真关
      await ctx.g.tapSel('.vw-close', { within: ctx.ROOT_SEL });
      const closed = await ctx.waitFor(`!${PV}.open && !__pvqa.root()`, 8000, '查看器关闭').catch(() => false);
      ctx.assert('栈空后再关 = 真关', !!closed, closed);
    },
  },
  {
    id: 'entry-ctx',
    title: '图片上下文菜单：查看器自己的（与 ⋯ 同源：保存 / 分享 / 复制图片 / 发送给 AI / 信息），复制图片写 PNG',
    tags: ['entry'],
    timeout: 120000,
    isolate: true,   // 触屏长按会把输入通道弄脏（见文件头）：运行器把它排到最后、单开会话
    async run(ctx) {
      await ensureChat(ctx);
      if (!ctx.touch) {
        try { await ctx.pg.send('Browser.grantPermissions', { origin: new URL(await ctx.eval('location.origin')).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }); } catch (e) { ctx.metric('_grant', String(e.message || e).slice(0, 80)); }
      }
      await tapIn(ctx, '.thread .u-img', { what: '第一张缩略图' });
      await ctx.waitFor(`!!__pvqa.root()`, 8000, '查看器根');
      const im = await C.image(ctx);
      if (!im) return;
      const x = Math.round(im.rect.x + im.rect.w / 2), y = Math.round(im.rect.y + im.rect.h / 2);
      if (ctx.touch) {
        // 触屏：长按识别在图片查看器（ImageView）里，由那条线接 viewer.contextMenu({x,y})；这里只记录现状
        await ctx.g.longPress(x, y, { hold: 700 });
        const m = await ctx.waitFor(`(() => { const m = document.querySelector('[role=menu]'); return m ? [...m.querySelectorAll('[role=menuitem]')].map((b) => b.textContent.trim()) : null; })()`, 2500, '长按菜单').catch(() => null);
        ctx.metric('longPressMenu', m);
        ctx.assert('长按出查看器自己的菜单', !!m && m.some((s) => s.includes('复制图片')), m, { level: 'info' });
        await ctx.shot('longpress');
        // 收尾：关掉菜单、把挂着的触摸序列取消掉，别把开着的菜单和半截手势留给后面
        await ctx.eval(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`).catch(() => {});
        await ctx.pg.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }, 3000).catch(() => {});
        return;
      }
      // 电脑：右键
      await ctx.pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await ctx.pg.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
      await ctx.pg.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
      const m = await ctx.waitFor(`(() => { const m = document.querySelector('[role=menu]'); if (!m) return null; const r = m.getBoundingClientRect(); return { items: [...m.querySelectorAll('[role=menuitem]')].map((b) => b.textContent.trim()), x: Math.round(r.left), y: Math.round(r.top) }; })()`, 4000, '右键菜单').catch(() => null);
      ctx.metric('menu', m);
      ctx.assert('右键出查看器自己的菜单', !!m, m?.items?.length);
      ctx.assert('菜单有「复制图片」与「下载」', !!m && m.items.some((s) => s.includes('复制图片')) && m.items.some((s) => s.includes('下载')), m?.items);
      // 右键菜单与 ⋯ 同一数据源（Windows 照片：右键也有信息、旋转等）；聊天图片不是工作区文件，不出重命名 / 删除
      ctx.assert('右键菜单与 ⋯ 同源（有旋转与文件信息）', !!m && m.items.some((s) => s.includes('文件信息')) && m.items.some((s) => /旋转/.test(s)), m?.items);
      ctx.assert('聊天图片的右键菜单不出重命名 / 删除', !!m && !m.items.some((s) => /重命名|删除/.test(s)), m?.items);
      ctx.assert('菜单开在右键处附近', !!m && Math.abs(m.x - x) < 260 && Math.abs(m.y - y) < 420, m && `${m.x},${m.y} vs ${x},${y}`);
      await ctx.shot('menu');
      await ctx.g.tapSel('[role=menu] [role=menuitem]', { text: '复制图片' });
      const toast = await ctx.waitFor(`(() => { const t = document.querySelector('.vw-toast'); return t ? { text: t.textContent.trim(), err: t.classList.contains('err') } : null; })()`, 8000, '复制结果提示').catch(() => null);
      ctx.metric('toast', toast);
      ctx.assert('复制有结果提示（成功或失败都要说）', !!toast, toast);
      const clip = await ctx.eval(`(async () => { try { const it = await navigator.clipboard.read(); const b = it[0] && it[0].types.includes('image/png') ? await it[0].getType('image/png') : null; return { types: it.flatMap((x) => x.types), size: b ? b.size : 0 }; } catch (e) { return { err: String(e.message || e).slice(0, 80) }; } })()`, { timeout: 10000 });
      ctx.metric('clipboard', clip);
      ctx.assert('剪贴板里是 PNG', !!clip?.types?.includes('image/png') && clip.size > 1000, clip, { level: toast && !toast.err ? 'must' : 'goal' });
      ctx.assert('成功提示「已复制图片」', toast?.text === '已复制图片', toast?.text, { level: clip?.types ? 'must' : 'goal' });
    },
  },
];
