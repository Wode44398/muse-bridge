// 安卓本地文件链路（安卓线）：新 apk 的原生能力在前端是否用上、用得对。mode 'apk2…' = 本地桩 + 新原生（localstub v2：
// 衍生档 preview 1600 / poster 1080 / max ≤16.7MP（只在显式 &thumb=max 时出）/ 原图区域块 &region=、原图一律原字节不静默降档、max-age + ETag 缓存头、If-None-Match → 304、rel 解析缓存、
// localStat / localExif / 存相册 / 壁纸 / 文件管理器 / 画中画）；同名 '-old' 场景用旧 apk（mode 'apk…'）做对照。
// 本地分页只在手机壳里有：只跑触屏档。真机上 304 回不了（WebResourceResponse 不收 3xx，照样 200 + 同一 ETag），这里量的是缓存头的上限。
import * as C from '../lib/checks.mjs';
import SWIPE from './swipe.mjs';

const TOUCH = (cfg) => cfg.touch;
const L = {
  gallery: ['存到相册', 'Save to Photos'],
  wallpaper: ['设为壁纸…', 'Set as wallpaper…'],
  reveal: ['在文件管理器中显示', 'Show in Files'],
  info: ['文件信息', 'File info'],
  share: ['分享', 'Share'],
  openWith: ['打开方式…', 'Open with…'],
};
const hasAny = (labels, names) => names.some((n) => labels.includes(n));
const MORE = '.vw-bar button[aria-haspopup="menu"]';

/** 本地桩统计快照与差值（run.mjs 每个场景结束清 requests/byKind/log，bytes 不清，所以都按差值算） */
function snap(ctx) { const s = ctx.local.server.stats; return { requests: s.requests, bytes: s.bytes, log: s.log.length, byKind: { ...s.byKind }, resolveMiss: s.resolveMiss || 0 }; }
function delta(ctx, a) {
  const s = ctx.local.server.stats, byKind = {};
  for (const [k, v] of Object.entries(s.byKind)) { const d = v - (a.byKind[k] || 0); if (d) byKind[k] = d; }
  return { requests: s.requests - a.requests, bytes: s.bytes - a.bytes, byKind, resolveMiss: (s.resolveMiss || 0) - a.resolveMiss, log: s.log.slice(a.log) };
}
const kb = (n) => Math.round(n / 1024);

/** 顶栏收起了就先点一下画面叫出来（单击切换顶栏），再点 ⋮；返回菜单项文字 */
async function openMenu(ctx) {
  const vis = await ctx.eval(`(() => { const b = __pvqa.root()?.querySelector(${JSON.stringify(MORE)}); return !!b && !b.closest('.vw-hide') && __pvqa.effOpacity(b) > 0.5; })()`).catch(() => false);
  if (!vis) { await ctx.g.tap(ctx.cfg.w / 2, ctx.cfg.h / 2); await ctx.sleep(600); }
  await ctx.g.tapSel(MORE, { within: ctx.ROOT_SEL });
  await ctx.waitFor(`document.querySelectorAll('[role=menuitem]').length > 0`, 5000, '菜单展开');
  await ctx.sleep(450);   // 菜单展开动效走完再读 / 截图
  return ctx.eval(`[...document.querySelectorAll('[role=menuitem]')].map((b) => { const l = b.querySelector('.mm-lbl, .vw-pop-l'); return ((l && l.childNodes[0] ? l.childNodes[0].textContent : b.textContent) || '').trim(); })`);
}
async function tapMenu(ctx, names) {
  for (const n of names) {
    const ok = await ctx.g.tapSel('[role=menuitem]', { text: n, timeout: 1500 }).then(() => true, () => false);
    if (ok) return true;
  }
  return false;
}
async function closeMenu(ctx) {
  await ctx.g.tap(ctx.cfg.w * 0.12, ctx.cfg.h * 0.9);   // 点菜单外（左下角）
  await ctx.waitFor(`document.querySelectorAll('[role=menuitem]').length === 0`, 4000, '菜单收起').catch(() => {});
  await ctx.sleep(300);
}

/** 双击放大；无头里第一下偶尔没认成双击（查看器刚上屏），没放大就隔一会再来一次 */
async function zoomIn(ctx) {
  for (let i = 0; i < 3; i++) {
    await ctx.g.doubleTap(ctx.cfg.w / 2, ctx.cfg.h * 0.45);
    const ok = await ctx.waitFor(`(() => { const s = __pvqa.imgState(); return s && s.effScale > 1.5; })()`, 1500, '双击放大').then(() => true, () => false);
    if (ok) return true;
    await ctx.sleep(700);
  }
  return false;
}

// —— 1. 衍生档与「原图加载」开关 ——
//   关（默认）：画廊主图走 preview 档、blur 底与列表同一 URL；首开只拉 preview + 320 底，不拉原图、不出 max 档；
//              放大先升 max 档（≤16.7MP，原图够小 passthrough 直出原字节）；48MP 再放大超过 max 档的分辨率 → 按可见区拉原图区域块，缩回去放掉
//   开：主图 / 预载 / 放大都是真原图字节，不出现 max 档 / 区域块 / preview 档；原图真解不了才退 max 档并提示一句
//   HEIC 描述符：关 = preview 档、开 = 全分辨率转 JPEG（&as=jpeg）；视频海报走 poster 档
const isBroken = (x) => x.broken === true;
// 拉原图字节：整张 full，或超过 256KB 的 Range（imageMeta 读文件头只要几十 KB，那不算）
const origPull = (x) => x.kind === 'full' || (x.kind === 'range' && x.bytes > 256 << 10);
const tag = (x) => `${x.rel.split('/').pop()} ${x.kind}${x.tier ? '/' + x.tier : ''} ${x.code}${isBroken(x) ? ' 坏' : ''}`;
/** 区域块现状：数量 / 已上屏数 / 视口中心那块（清晰度 = 块的像素 ÷ min(它覆盖的原图像素, 它此刻占的设备像素)，≥1 即不糊） */
const TILE_STATE = `(() => {
  const ts = [...(__pvqa.root()?.querySelectorAll('img.iv-tile') || [])];
  const on = ts.filter((im) => im.complete && im.naturalWidth > 0 && getComputedStyle(im).opacity === '1');
  const cx = innerWidth / 2, cy = innerHeight / 2, dpr = devicePixelRatio || 1;
  const hit = on.find((im) => { const r = im.getBoundingClientRect(); return r.left <= cx && r.right >= cx && r.top <= cy && r.bottom >= cy; });
  let sharp = null, src = null;
  if (hit) {
    const r = hit.getBoundingClientRect(), q = /[?&]region=(\\d+),(\\d+),(\\d+),(\\d+)/.exec(hit.getAttribute('src') || '');
    const ow = q ? +q[3] : hit.naturalWidth;
    sharp = +(hit.naturalWidth / Math.min(ow, r.width * dpr)).toFixed(3);
    src = (hit.getAttribute('src') || '').replace(/^.*?[?&]region=/, 'region=');
  }
  const hi = __pvqa.root()?.querySelector('img.iv-hi');
  return { n: ts.length, on: on.length, center: !!hit, sharp, src, hi: hi ? { nw: hi.naturalWidth, nh: hi.naturalHeight, max: /&thumb=max/.test(hi.getAttribute('src') || '') } : null };
})()`;
const setFullRes = (ctx, on) => ctx.eval(`(async () => { const S = await import('/src/lib/state.svelte.js'); S.prefs.fullResMedia = ${on ? 'true' : 'false'}; return S.prefs.fullResMedia; })()`);
const tiers = {
  id: 'android-tiers', title: '本地 · 新 apk 衍生档与原图开关（关：preview→max→区域块；开：真原图、解不了才退并提示；HEIC / poster 描述符）', tags: ['android', 'local'], mode: 'apk2', only: TOUCH, timeout: 200000,
  async cleanup(ctx) {
    try { ctx.local?.server?.breakOrig?.clear(); } catch {}
    await setFullRes(ctx, false).catch(() => {});
  },
  async run(ctx) {
    const R = (p) => ctx.local.rel(p);
    await setFullRes(ctx, false);
    const items = [
      ctx.item('混排/混排-01.jpg', { kind: 'image' }),
      ctx.item('混排/混排-04.mp4', { kind: 'video' }),
      { origin: 'local', rel: R('图片/假的-样张.heic'), name: '假的-样张.heic', kind: 'image' },
      ctx.item('图片/动图.gif', { kind: 'image' }),
      ctx.item('图片/矢量.svg', { kind: 'image' }),
    ];
    const DESC = `__pvqa.pv.preview.items.map((i) => ({ url: i.url || null, previewUrl: i.previewUrl || null, thumbUrl: i.thumbUrl || null, poster: i.poster || null, maxUrl: i.maxUrl || null, lowUrl: i.lowUrl || null, tileBase: i.tileBase || null, fullRes: i.fullRes }))`;
    const a0 = snap(ctx);
    const t0 = Date.now();
    await ctx.open(items, 0);
    const d = await ctx.eval(`(async () => { const fs = await import('/src/lib/localfs.js');
      return { list: ${DESC}, listIcon: fs.localThumbUrl(${JSON.stringify(items[0].rel)}), has: fs.hasLocalPreview(), region: fs.hasLocalRegion() }; })()`);
    ctx.metric('_descriptors', d);
    const [img, vid, heic, gif, svg] = d.list;
    ctx.assert('能力探测 hasLocalPreview / hasLocalRegion', d.has === true && d.region === true, { has: d.has, region: d.region });
    ctx.assert('原图开关关：描述符 fullRes = false', img.fullRes === false, img.fullRes);
    ctx.assert('图片 previewUrl = &thumb=preview', /&thumb=preview$/.test(img.previewUrl || ''), img.previewUrl);
    ctx.assert('图片 maxUrl = &thumb=max、tileBase = 原图地址（区域块底）', /&thumb=max$/.test(img.maxUrl || '') && !!img.tileBase && !/&thumb=/.test(img.tileBase), { maxUrl: img.maxUrl, tileBase: img.tileBase });
    ctx.assert('图片 thumbUrl 与列表图标同一 URL（不带 mt）', img.thumbUrl === d.listIcon, img.thumbUrl);
    ctx.assert('图片 url 是原图（不带档位）', !!img.url && !/&thumb=/.test(img.url), img.url);
    ctx.assert('视频 poster = &thumb=poster', /&thumb=poster$/.test(vid.poster || ''), vid.poster);
    ctx.assert('HEIC url 带 &as=jpeg（全分辨率转 JPEG）', /&as=jpeg$/.test(heic.url || ''), heic.url);
    ctx.assert('HEIC 主图走 preview 档', /&thumb=preview$/.test(heic.previewUrl || ''), heic.previewUrl);
    ctx.assert('GIF 不走衍生档（动图保留，也没有 max / 区域块）', gif.previewUrl === gif.url && !gif.maxUrl && !gif.tileBase, gif);
    ctx.assert('SVG 不走衍生档（矢量保留，也没有 max / 区域块）', svg.previewUrl === svg.url && !svg.maxUrl && !svg.tileBase, svg);

    const st = await C.image(ctx, { t0 });
    ctx.assert('主图是 preview 档', !!st && /&thumb=preview/.test(st.src), st?.src);
    ctx.assert('preview 档长边 1600（2400×1800 原图）', !!st && Math.max(st.nw, st.nh) === 1600, st ? `${st.nw}×${st.nh}` : null);
    await ctx.shot('preview');
    const a1 = delta(ctx, a0);
    ctx.metric('openRequests', a1.byKind);
    ctx.metric('_openLog', a1.log.map(tag));
    ctx.metric('openKB', kb(a1.bytes));
    // 动图 / 矢量本来就给原图（画廊预取邻居时会拉）；假 HEIC 的 preview 档出不了（404）会退到原图转 JPEG（同样 404）——这三样不算
    const fullTiered = a1.log.filter((x) => origPull(x) && /\.(jpe?g|png|webp|avif|tiff?)$/i.test(x.rel));
    ctx.assert('首开不拉原图（有档位的位图只拉 preview 档 + 320 底）', fullTiered.length === 0, a1.log.map(tag));
    ctx.assert('首开不出 max 档 / 区域块', !a1.log.some((x) => x.kind === 'thumb:max' || x.kind === 'region'), a1.log.map(tag));

    // 双击放大 → 先升 max 档（2400×1800 不超上限：max 档 passthrough 直出原字节，2400 宽）
    const a2 = snap(ctx);
    await zoomIn(ctx);
    const up = await ctx.waitFor(`(() => { const s = __pvqa.imgState(); return s && s.nw === 2400 ? s : null; })()`, 12000, '放大后升 max 档').catch(() => null);
    ctx.assert('双击放大后升到 max 档（&thumb=max，2400 宽 = 原图直出）', !!up && /&thumb=max/.test(up.src), up ? { nw: up.nw, nh: up.nh, src: up.src.slice(-50) } : await ctx.eval(`__pvqa.imgState()`).catch(() => null));
    const z2 = delta(ctx, a2);
    ctx.metric('zoomRequests', z2.byKind);
    ctx.metric('_zoomLog', z2.log.map(tag));
    const r01 = z2.log.filter((x) => /混排-01\.jpg$/.test(x.rel));
    ctx.assert('放大只拉 max 档、没拉原图（混排-01）', r01.some((x) => x.kind === 'thumb:max' && x.code === 200) && !r01.some(origPull), r01.map((x) => tag(x) + ' ' + kb(x.bytes) + 'KB'));
    ctx.assert('不超上限的图不分块', (await ctx.eval(TILE_STATE)).n === 0, await ctx.eval(TILE_STATE));
    await ctx.shot('zoomed');

    // 48MP 超大图：preview 档先上屏；放大先升 max 档（≤16.7MP 的缩小版）；再捏大到超过 max 档的分辨率 → 视口里挂原图区域块；缩回去放掉
    await ctx.close(); await ctx.sleep(400);
    const a3 = snap(ctx);
    const t1 = Date.now();
    await ctx.open([ctx.item('图片/大图-8000x6000.jpg', { kind: 'image' })], 0);
    const big = await C.image(ctx, { t0: t1 });
    ctx.assert('超大图先上 preview 档（1600 宽）', !!big && big.nw === 1600, big ? `${big.nw}×${big.nh}` : null);
    await zoomIn(ctx);
    const bigUp = await ctx.waitFor(`(() => { const s = __pvqa.imgState(); return s && s.nw > 1600 ? s : null; })()`, 25000, '超大图放大后换 max 档').catch(() => null);
    const px = bigUp ? bigUp.nw * bigUp.nh : 0;
    ctx.assert('超大图放大后换上 max 档（&thumb=max，>1600 且 ≤16.7MP）', px > 1600 * 1200 && px <= 4096 * 4096 * 1.001 && /&thumb=max/.test(bigUp?.src || ''), bigUp ? `${bigUp.nw}×${bigUp.nh} ${bigUp.src.slice(-30)}` : null);
    const d3 = delta(ctx, a3);
    const maxHit = d3.log.find((x) => x.kind === 'thumb:max' && x.code === 200);
    ctx.assert('max 档由原生衍生（没把 48MP 原字节交给 WebView）', !!maxHit && !d3.log.some(origPull), d3.log.map((x) => `${x.kind}/${x.tier || '-'}/${x.code}/${kb(x.bytes)}KB`));
    // 捏合再放大（2.2 倍）：每个原图像素占的设备像素超过 max 档能给的 → 按可见区拉区域块
    const a3b = snap(ctx);
    await ctx.g.pinch({ x: Math.round(ctx.cfg.w / 2), y: Math.round(ctx.cfg.h / 2) }, 2.2, { steps: 14, radius: 60, ms: 420, settle: 700 });
    const tl = await ctx.waitFor(`(() => { const t = ${TILE_STATE}; return t.center ? t : null; })()`, 25000, '视口中心挂上区域块').catch(() => null);
    const tlNow = tl || await ctx.eval(TILE_STATE).catch(() => null);
    const d3b = delta(ctx, a3b);
    const regs = d3b.log.filter((x) => x.kind === 'region');
    ctx.metric('tiles', { ...tlNow, regionReq: regs.length, regionKB: kb(regs.reduce((n, x) => n + (x.bytes || 0), 0)), scale: (await ctx.eval(`__pvqa.imgState()`).catch(() => null))?.effScale });
    ctx.assert('放大超过 max 档分辨率后，视口中心挂上原图区域块（已解码上屏）', !!tl, tlNow);
    ctx.assert('区域块够清晰（块像素 ≥ 它此刻要的设备像素，封顶原图）', !!tl && tl.sharp >= 0.95, tl?.sharp);
    ctx.assert('区域块由原生应答（&region=，200）、一屏不超过 24 块', regs.length > 0 && regs.every((x) => x.code === 200 || x.code === 304) && (tlNow?.n || 0) <= 24, { regs: regs.map((x) => `${x.region} ${x.code} ${kb(x.bytes)}KB`).slice(0, 12), n: tlNow?.n });
    ctx.assert('分块时仍没拉 48MP 原图', !d3b.log.some(origPull), d3b.log.map(tag).slice(0, 20));
    await ctx.shot('big-tiles');
    // 双击缩回 → 区域块放掉
    await ctx.g.doubleTap(ctx.cfg.w / 2, ctx.cfg.h / 2);
    const gone = await ctx.waitFor(`(() => { const t = ${TILE_STATE}; const s = __pvqa.imgState(); return t.n === 0 && s && s.effScale < 1.05 ? t : null; })()`, 8000, '缩回后区域块放掉').catch(() => null);
    ctx.assert('缩回后区域块全部放掉', !!gone, await ctx.eval(TILE_STATE).catch(() => null));
    ctx.metric('bigKB', { total: kb(delta(ctx, a3).bytes), max: maxHit ? kb(maxHit.bytes) : null, original: 10540 });

    // 视频海报：海报档被拉（不是 320 小图糊上去）
    await ctx.close(); await ctx.sleep(400);
    const a4 = snap(ctx);
    await ctx.open([ctx.item('视频/竖拍-1080x1920.mp4', { kind: 'video' })], 0);
    const pst = await ctx.waitFor(`(() => { const v = __pvqa.root()?.querySelector('video'); return v && v.poster ? v.poster.replace(location.origin, '') : null; })()`, 8000, '视频 poster').catch(() => null);
    ctx.assert('<video poster> 用 poster 档', /&thumb=poster$/.test(pst || ''), pst);
    await ctx.sleep(800);
    ctx.metric('videoRequests', delta(ctx, a4).byKind);

    // —— 「原图加载」开：主图 / 放大都是真原图字节，不出 max 档 / 区域块 / preview 档 ——
    await ctx.close(); await ctx.sleep(400);
    await setFullRes(ctx, true);
    const a5 = snap(ctx);
    const t5 = Date.now();
    await ctx.open([ctx.item('图片/大图-8000x6000.jpg', { kind: 'image' }), ctx.item('混排/混排-01.jpg', { kind: 'image' })], 0);
    const d5 = (await ctx.eval(DESC)) || [];
    const [bigD, mixD] = d5;
    ctx.assert('开：描述符 fullRes = true、previewUrl = 原图', !!bigD && bigD.fullRes === true && bigD.previewUrl === bigD.url && mixD?.previewUrl === mixD?.url, d5);
    const on1 = await C.image(ctx, { t0: t5, timeout: 40000 });
    ctx.metric('fullResOpenMs', on1 ? Date.now() - t5 : null);
    ctx.assert('开：主图首开就是原图（8000 宽、不带档位）', !!on1 && on1.nw === 8000 && !/&thumb=/.test(on1.src), on1 ? `${on1.nw}×${on1.nh} ${on1.src.slice(-40)}` : null);
    await zoomIn(ctx);
    await ctx.sleep(1500);
    const on2 = await ctx.eval(`__pvqa.imgState()`).catch(() => null);
    const tOn = await ctx.eval(TILE_STATE).catch(() => null);
    ctx.assert('开：放大后仍是原图（不升 max 档、不分块）', !!on2 && on2.nw === 8000 && !/&thumb=/.test(on2.src) && !tOn?.hi?.max && (tOn?.n || 0) === 0, { nw: on2?.nw, src: on2?.src?.slice(-40), tiles: tOn });
    const d5l = delta(ctx, a5);
    ctx.metric('_fullResLog', d5l.log.map(tag));
    ctx.metric('fullResKB', kb(d5l.bytes));
    const onTiered = d5l.log.filter((x) => x.kind === 'thumb:max' || x.kind === 'thumb:preview' || x.kind === 'region');
    ctx.assert('开：没有 max 档 / preview 档 / 区域块请求', onTiered.length === 0, d5l.log.map(tag));
    const bigOrig = d5l.log.filter((x) => /大图-8000x6000\.jpg$/.test(x.rel) && (x.kind === 'full' || x.kind === 'range') && x.code >= 200 && x.code < 300);
    ctx.assert('开：48MP 原字节真交给了 WebView', bigOrig.reduce((n, x) => n + (x.bytes || 0), 0) >= 10e6 || (!bigOrig.length && on1?.nw === 8000), bigOrig.map(tag));
    await ctx.shot('fullres-zoomed');

    // 开 + 原图真解不了（桩回坏字节）：退到 max 档上屏 + 提示一句「原图过大，已显示高清预览」
    await ctx.close(); await ctx.sleep(400);
    const brokenRel = R('图片/超高-1080x8000.jpg');
    ctx.local.server.breakOrig.add(brokenRel);
    const a6 = snap(ctx);
    await ctx.open([ctx.item('图片/超高-1080x8000.jpg', { kind: 'image' })], 0);
    const fb = await ctx.waitFor(`(() => { const s = __pvqa.imgState(); return s && s.complete && s.nw > 0 && /&thumb=max/.test(s.src) && __pvqa.effOpacity(__pvqa.mainImg()) > 0.98 ? s : null; })()`, 20000, '原图解不了退到 max 档').catch(() => null);
    ctx.assert('开 + 原图解不了：退到 max 档上屏', !!fb, fb ? `${fb.nw}×${fb.nh}` : await ctx.eval(`__pvqa.imgState()`).catch(() => null));
    const toast = await ctx.waitFor(`(() => [...document.querySelectorAll('.vw-toast')].map((e) => e.textContent.trim()).find((s) => /原图过大，已显示高清预览|Original too large/.test(s)) || null)()`, 6000, '退档提示').catch(() => null);
    ctx.assert('开 + 原图解不了：提示「原图过大，已显示高清预览」', !!toast, toast);
    const d6 = delta(ctx, a6);
    ctx.metric('_fallbackLog', d6.log.map(tag));
    ctx.assert('退档顺序：先要原图（坏）→ 再要 max 档；没有静默先拉档位', d6.log.findIndex(isBroken) >= 0 && d6.log.findIndex(isBroken) < d6.log.findIndex((x) => x.kind === 'thumb:max'), d6.log.map(tag));
    await ctx.shot('fullres-fallback');
    ctx.local.server.breakOrig.clear();

    // 开 + HEIC：主图直接要全分辨率 JPEG（&as=jpeg → full 档），不走 preview 档；假样张转不了就停在错误态（不转圈）
    await ctx.close(); await ctx.sleep(400);
    const a7 = snap(ctx);
    await ctx.open([{ origin: 'local', rel: R('图片/假的-样张.heic'), name: '假的-样张.heic', kind: 'image' }], 0);
    const hd = (await ctx.eval(DESC))?.[0];
    ctx.assert('开：HEIC previewUrl = 原图转 JPEG（&as=jpeg）', !!hd && hd.previewUrl === hd.url && /&as=jpeg$/.test(hd.url || ''), hd);
    const herr = await ctx.waitFor(`!!__pvqa.root()?.querySelector('.iv-err')`, 10000, 'HEIC 错误态').catch(() => false);
    const d7 = delta(ctx, a7);
    ctx.metric('_heicLog', d7.log.map(tag));
    const hMain = d7.log.filter((x) => x.kind === 'full' || x.kind === 'range' || x.kind === 'thumb:preview' || x.kind === 'thumb:max');
    // 假样张在桩里没有实体文件（直接 404），请求层面只能看「先要的是原图（&as=jpeg）而不是 preview 档」；全分辨率转换本身由描述符 + 原生 T_FULL 保证
    ctx.assert('开：HEIC 主图先要原图转 JPEG（不先拉 preview 档），解不了给错误态', hMain[0]?.kind === 'full' && herr === true, { log: d7.log.map(tag), err: herr });
    await setFullRes(ctx, false);
  },
};

// —— 2. 侧滑：同一套量法（swipe.mjs 的 swipe-local-saf150：SAF 每请求 +150ms、CPU×4、从第 16 张起滑 8 张），新旧 apk 对照字节与请求 ——
const BASE = SWIPE.find((s) => s.id === 'swipe-local-saf150');
function swipeAB({ id, title, mode, v2 }) {
  return {
    ...BASE, id, title, mode, tags: ['android', 'local', 'swipe'], only: TOUCH,
    async run(ctx) {
      const a = snap(ctx);
      await BASE.run(ctx);
      const d = delta(ctx, a);
      ctx.metric('requests', d.byKind);
      ctx.metric('totalKB', kb(d.bytes));
      ctx.metric('kbPerImage', kb(d.bytes / 9));   // 首张 + 8 划
      ctx.metric('resolveMiss', v2 ? d.resolveMiss : null);
      const cur = await ctx.eval(`__pvqa.imgState()`).catch(() => null);
      ctx.metric('lastImg', cur ? { src: cur.src.replace(/^https?:\/\/[^/]+/, '').slice(-60), nw: cur.nw, nh: cur.nh } : null);
      if (v2) {
        ctx.assert('侧滑主图都走 preview 档（没拉一张原图）', !d.byKind.full && (d.byKind['thumb:preview'] || 0) >= 9, d.byKind);
        ctx.assert('当前主图是 1600 档', !!cur && Math.max(cur.nw, cur.nh) === 1600 && /&thumb=preview/.test(cur.src), cur ? `${cur.nw}×${cur.nh}` : null);
        const rels = new Set(d.log.map((x) => x.rel)).size;
        ctx.assert('每张图 SAF 定位只付一次（解析缓存：定位次数 ≤ 碰到的文件数）', d.resolveMiss <= rels, { resolveMiss: d.resolveMiss, rels, requests: d.requests });
      }
    },
  };
}
const swipeNew = swipeAB({ id: 'android-swipe-saf150', title: '本地 · 新 apk 侧滑（preview 档、SAF +150ms、CPU×4）', mode: 'apk2:150', v2: true });
const swipeOld = swipeAB({ id: 'android-swipe-saf150-old', title: '本地 · 旧 apk 侧滑对照（原图、SAF +150ms、CPU×4）', mode: 'apk:150', v2: false });

// —— 3. 复用：关掉再开同一张不再发请求（max-age）；强制复验走 If-None-Match → 304 ——
function reuse({ id, title, mode, v2 }) {
  return {
    id, title, mode, tags: ['android', 'local'], only: TOUCH,
    async run(ctx) {
      const it = ctx.item('图片/相机EXIF.jpg', { kind: 'image' });
      await ctx.open([it], 0);
      await C.image(ctx);
      await ctx.sleep(500);
      await ctx.close(); await ctx.sleep(600);
      const a = snap(ctx);
      const t0 = Date.now();
      await ctx.open([it], 0);
      const st = await C.image(ctx, { t0 });
      await ctx.sleep(500);
      const d = delta(ctx, a);
      ctx.metric('reopenRequests', d.byKind);
      ctx.metric('reopenKB', kb(d.bytes));
      ctx.metric('reopenMs', st ? Date.now() - t0 : null);
      if (!v2) return;
      ctx.assert('重开同一张：零请求（Blink 缓存按 max-age 直接复用）', d.requests === 0, d.byKind);
      const a2 = snap(ctx);
      const hv = await ctx.eval(`(async () => { const u = __pvqa.pv.preview.items[0].previewUrl; const r = await fetch(u, { cache: 'no-cache' }); await r.arrayBuffer();
        return { status: r.status, etag: r.headers.get('etag'), cc: r.headers.get('cache-control'), lm: r.headers.get('last-modified'), tier: r.headers.get('x-bridge-tier') }; })()`);
      const d2 = delta(ctx, a2);
      ctx.metric('revalidate', { ...hv, server: d2.byKind });
      ctx.assert('衍生档带 ETag + max-age', !!hv.etag && /max-age=86400/.test(hv.cc || ''), hv);
      ctx.assert('强制复验 → 304（没重传字节）', (d2.byKind['304'] || 0) >= 1 && d2.bytes === 0, d2.byKind);
      const og = await ctx.eval(`(async () => { const r = await fetch(__pvqa.pv.preview.items[0].url, { headers: { Range: 'bytes=0-99' } }); const b = await r.arrayBuffer(); return { status: r.status, len: b.byteLength, cr: r.headers.get('content-range'), etag: r.headers.get('etag') }; })()`);
      ctx.assert('原图 Range 仍回 206', og.status === 206 && og.len === 100 && /^bytes 0-99\//.test(og.cr || ''), og);
    },
  };
}

// —— 4. 菜单：新 apk 的本地项按能力出现；视频不给「设为壁纸」；旧 apk 一项都不出 ——
const menu = {
  id: 'android-menu', title: '本地 · 新 apk 菜单（存到相册 / 设为壁纸 / 在文件管理器中显示）', tags: ['android', 'local'], mode: 'apk2', only: TOUCH,
  async run(ctx) {
    await ctx.open([ctx.item('图片/相机EXIF.jpg', { kind: 'image' })], 0);
    await C.image(ctx);
    await ctx.sleep(400);
    const labels = await openMenu(ctx);
    ctx.metric('imageMenu', labels);
    ctx.assert('图片菜单有「存到相册」', hasAny(labels, L.gallery), labels);
    ctx.assert('图片菜单有「设为壁纸…」', hasAny(labels, L.wallpaper), labels);
    ctx.assert('图片菜单有「在文件管理器中显示」', hasAny(labels, L.reveal), labels);
    ctx.assert('图片菜单有「分享」「打开方式…」', hasAny(labels, L.share) && hasAny(labels, L.openWith), labels);
    await ctx.shot('image-menu');
    // 点「存到相册」：等待提示 → 完成提示带相册名；原生调用带上 rel
    await tapMenu(ctx, L.gallery);
    const toast = await ctx.waitFor(`(() => { const t = [...document.querySelectorAll('.vw-toast')].map((e) => e.textContent.trim()).find((s) => /已存到相册|Saved to Photos/.test(s)); return t || null; })()`, 6000, '存相册完成提示').catch(() => null);
    ctx.assert('存到相册 → 完成提示（相册名只报文件夹名）', !!toast && /「Bridge」|\(Bridge\)/.test(toast) && !/Pictures/.test(toast), toast);
    await ctx.shot('saved');
    const calls = await ctx.eval(`__pvqaLocal.calls.filter((c) => /^local(SaveToGallery|SetWallpaper|Reveal)$/.test(c.fn)).map((c) => c.fn + ':' + c.args[0])`);
    ctx.assert('原生 localSaveToGallery 收到本地 rel', calls.some((c) => c.startsWith('localSaveToGallery:' + ctx.local.rel(''))), calls);
    // 在文件管理器中显示
    await ctx.sleep(1200);
    await openMenu(ctx);
    await tapMenu(ctx, L.reveal);
    await ctx.sleep(300);
    const c2 = await ctx.eval(`__pvqaLocal.calls.filter((c) => c.fn === 'localReveal').length`);
    ctx.assert('「在文件管理器中显示」调到原生 localReveal', c2 >= 1, c2);

    // 视频：存相册有、壁纸没有
    await ctx.close(); await ctx.sleep(400);
    await ctx.open([ctx.item('视频/竖拍-1080x1920.mp4', { kind: 'video' })], 0);
    await ctx.sleep(1200);
    const vl = await openMenu(ctx);
    ctx.metric('videoMenu', vl);
    ctx.assert('视频菜单有「存到相册」', hasAny(vl, L.gallery), vl);
    ctx.assert('视频菜单没有「设为壁纸…」', !hasAny(vl, L.wallpaper), vl);
    await ctx.shot('video-menu');
    await closeMenu(ctx);
  },
};
const menuOld = {
  id: 'android-menu-old', title: '本地 · 旧 apk 菜单不出新项', tags: ['android', 'local'], mode: 'apk', only: TOUCH,
  async run(ctx) {
    await ctx.open([ctx.item('图片/相机EXIF.jpg', { kind: 'image' })], 0);
    await C.image(ctx);
    await ctx.sleep(400);
    const labels = await openMenu(ctx);
    ctx.metric('imageMenu', labels);
    ctx.assert('旧 apk：没有「存到相册」「设为壁纸…」「在文件管理器中显示」', !hasAny(labels, [...L.gallery, ...L.wallpaper, ...L.reveal]), labels);
    ctx.assert('旧 apk：「分享」「打开方式…」照旧', hasAny(labels, L.share) && hasAny(labels, L.openWith), labels);
    const st = await ctx.eval(`(() => { const i = __pvqa.pv.preview.items[0]; return { previewUrl: i.previewUrl || null, thumbUrl: i.thumbUrl || null }; })()`);
    ctx.assert('旧 apk：画廊不用 preview 档（原生没有）', !/thumb=preview/.test(st.previewUrl || ''), st);
    await closeMenu(ctx);
  },
};

// —— 5. 文件信息：原生 localStat 补大小 / 时间，localExif 补尺寸（转正后）/ 拍摄时间 / 相机 / 参数 ——
async function infoRowsOf(ctx, want, ms = 8000) {
  return ctx.waitFor(`(() => { const rows = [...document.querySelectorAll('.vw-info-row')].map((r) => [r.querySelector('dt')?.textContent.trim(), r.querySelector('dd')?.textContent.trim()]);
    return rows.some((r) => ${JSON.stringify(want)}.includes(r[0])) ? rows : null; })()`, ms, '信息行 ' + want.join('/')).catch(() => ctx.eval(`[...document.querySelectorAll('.vw-info-row')].map((r) => [r.querySelector('dt')?.textContent.trim(), r.querySelector('dd')?.textContent.trim()])`));
}
const rowVal = (rows, names) => (rows || []).find((r) => names.includes(r[0]))?.[1] ?? null;
const info = {
  id: 'android-info', title: '本地 · 文件信息里的 EXIF（拍摄时间 / 相机 / 参数 / 转正尺寸）', tags: ['android', 'local'], mode: 'apk2', only: TOUCH,
  async run(ctx) {
    await ctx.open([ctx.item('图片/相机EXIF.jpg', { kind: 'image' })], 0);
    await C.image(ctx);
    await ctx.sleep(400);
    await openMenu(ctx);
    await tapMenu(ctx, L.info);
    const rows = await infoRowsOf(ctx, ['拍摄时间', 'Date taken']);
    ctx.metric('rows', rows);
    ctx.assert('拍摄时间 2024-05-01 12:34', rowVal(rows, ['拍摄时间', 'Date taken']) === '2024-05-01 12:34', rowVal(rows, ['拍摄时间', 'Date taken']));
    ctx.assert('相机 Canon EOS R5（型号已含品牌不重复）', rowVal(rows, ['相机', 'Camera']) === 'Canon EOS R5', rowVal(rows, ['相机', 'Camera']));
    ctx.assert('拍摄参数 f/2.8 · 1/125 s · ISO 400 · 50 mm', rowVal(rows, ['拍摄参数', 'Exposure']) === 'f/2.8 · 1/125 s · ISO 400 · 50 mm', rowVal(rows, ['拍摄参数', 'Exposure']));
    ctx.assert('尺寸是原图的 2400 × 1600（不是 preview 档的 1600）', rowVal(rows, ['尺寸', 'Dimensions']) === '2400 × 1600', rowVal(rows, ['尺寸', 'Dimensions']));
    ctx.assert('大小由原生 localStat 补上', !!rowVal(rows, ['大小', 'Size']), rowVal(rows, ['大小', 'Size']));
    ctx.assert('尺寸只出一行', (rows || []).filter((r) => ['尺寸', 'Dimensions'].includes(r[0])).length === 1, rows);
    await ctx.shot('info');

    await ctx.close(); await ctx.sleep(400);
    await ctx.open([ctx.item('图片/EXIF方向6-竖拍.jpg', { kind: 'image' })], 0);
    await C.image(ctx);
    await ctx.sleep(400);
    await openMenu(ctx);
    await tapMenu(ctx, L.info);
    const r2 = await infoRowsOf(ctx, ['相机', 'Camera']);
    ctx.metric('rowsExif6', r2);
    ctx.assert('EXIF 方向 6：尺寸按转正后报 3000 × 4000', rowVal(r2, ['尺寸', 'Dimensions']) === '3000 × 4000', rowVal(r2, ['尺寸', 'Dimensions']));
    const st = await ctx.eval(`__pvqa.imgState()`);
    ctx.assert('EXIF 方向 6：preview 档已转正（竖图）', !!st && st.nh > st.nw, st ? `${st.nw}×${st.nh}` : null);

    await ctx.close(); await ctx.sleep(400);
    await ctx.open([ctx.item('视频/竖拍-1080x1920.mp4', { kind: 'video' })], 0);
    await ctx.sleep(1000);
    await openMenu(ctx);
    await tapMenu(ctx, L.info);
    const r3 = await infoRowsOf(ctx, ['时长', 'Duration']);
    ctx.metric('rowsVideo', r3);
    ctx.assert('视频：时长与分辨率', !!rowVal(r3, ['时长', 'Duration']) && rowVal(r3, ['分辨率', 'Resolution', '尺寸', 'Dimensions']) === '1080 × 1920', r3);
    ctx.assert('视频：分辨率只出一行（原生元数据不重复补「尺寸」）', (r3 || []).filter((r) => ['分辨率', 'Resolution', '尺寸', 'Dimensions'].includes(r[0])).length === 1, r3);
    await ctx.shot('video-info');
  },
};

// —— 6. 大文本：原生 localReadText 只读前 2MB，截断的正文不能原样交给编辑器（存回去会把文件截短）——
const text = {
  id: 'android-text', title: '本地 · 超过 2MB 的文本不拿截断的正文当原文', tags: ['android', 'local'], mode: 'apk2', only: TOUCH, timeout: 120000,
  async run(ctx) {
    const desc = async (rel) => {
      const it = ctx.item(rel, { kind: 'text' });
      const txt = await ctx.eval(`window.AndroidStore.localReadText(${JSON.stringify(it.rel)})`, { timeout: 30000 });
      return { it: { ...it, text: txt }, len: txt ? txt.length : 0 };
    };
    for (const [rel, big, probe] of [['代码/运行.log', true, '处理请求'], ['代码/大文件.js', true, 'export function handler1('], ['笔记/笔记.md', false, '预览样张笔记']]) {
      const { it, len } = await desc(rel);
      const a = snap(ctx);
      const t0 = Date.now();
      await ctx.open([it], 0);
      const d = await ctx.eval(`(() => { const i = __pvqa.pv.preview.items[0]; return { text: i.text == null ? null : i.text.length, size: i.size ?? null }; })()`);
      ctx.metric(rel, { readLen: len, desc: d });
      if (big) ctx.assert(`${rel}：截断正文不进描述符、大小由 localStat 给`, d.text == null && d.size > 2 * 1024 * 1024, d);
      else ctx.assert(`${rel}：小文件照旧用调用方读好的正文`, d.text === len && len > 0, d);
      await C.text(ctx, probe, { t0, timeout: 45000, name: rel + ' 正文出来' });
      if (rel === '代码/运行.log') {
        const ro = await ctx.waitFor(`(() => { const t = __pvqa.root()?.innerText || ''; return /仅显示前|只读|Showing (the )?first|Read-only/i.test(t); })()`, 6000, '截断 / 只读提示').catch(() => false);
        ctx.assert('12.5MB 日志：截断提示 + 只读（文本线的 readCapped）', !!ro, ro, { level: 'goal' });
        await ctx.shot('log');
      }
      ctx.metric(rel + ' 读取', { requests: delta(ctx, a).byKind, kb: kb(delta(ctx, a).bytes) });
      await ctx.close(); await ctx.sleep(500);
    }
  },
};

// —— 7. 本地音频走 /__localfile Range 流式（不整个下成 blob）——依赖影音线的 AudioPlayer 改版，基线上不过属预期 ——
const audio = {
  id: 'android-audio', title: '本地 · 40 分钟音频走 Range 流式', tags: ['android', 'local'], mode: 'apk2', only: TOUCH,
  async run(ctx) {
    const a = snap(ctx);
    const t0 = Date.now();
    await ctx.open([ctx.item('音频/长音频-40分钟.mp3', { kind: 'audio' })], 0);
    await C.audio(ctx, { t0, timeout: 30000 });
    await ctx.sleep(800);
    const d = delta(ctx, a);
    ctx.metric('requests', d.byKind);
    ctx.metric('kb', kb(d.bytes));
    ctx.assert('音频走 Range（206）', (d.byKind.range || 0) >= 1, d.byKind, { level: 'goal' });
    ctx.assert('没把整个文件下完', d.bytes < 0.5 * 40 * 60 * 16000, kb(d.bytes) + 'KB', { level: 'goal' });
  },
};

export default [tiers, reuse({ id: 'android-reuse', title: '本地 · 新 apk 重开复用与 304', mode: 'apk2', v2: true }), menu, info, text, audio,
  reuse({ id: 'android-reuse-old', title: '本地 · 旧 apk 重开对照', mode: 'apk', v2: false }), menuOld, swipeNew, swipeOld];
