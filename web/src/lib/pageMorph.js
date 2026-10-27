// —— 页面级转场引擎：主页 ⇄ 分页、分页 ⇄ 分页、主页明暗换场 ——
//
// 【2026-09-26 重做】此前五个入口三种说法：Claude / Gemini 是「裁窗从方块展开」、ChatGPT /
// dimensio / 工作空间硬切（ChatGPT 首开还黑→白→黑闪三下），返回又一律「整页往右滑走」——
// 打开像放大、关闭像翻页，空间关系自相矛盾；且裁窗动画跑在主线程上，切页那一帧要渲染整个
// 分页，点完常常先愣一两百毫秒才开始动。粗糙感主要来自这两件事，不在于哪一段不够花哨。
//
// 现在只有一个空间模型：主页是底座，每个分页都是住在自己入口里的一张卡片。
//   打开 = 入口长成这一页，主页同时以入口为原点往后退、压暗（纵深）；
//   关闭 = 这一页收回它自己的入口，主页回到前面——入口在哪，卡片就回哪；
//   分页之间直达（助手 / 命令面板）= 纵深淡换：旧页后退淡出，新页从近处落定。
//
// 实现：View Transitions。浏览器把切页前后两个画面各拍一张快照，动画只在快照（贴图）上做：
// 分页再重（长会话、液态玻璃、iframe）也不参与逐帧重绘，切页那一帧的渲染也藏在快照后面。
// 几何全部由这里用 WAAPI 驱动伪元素（弹簧离线积分成 linear() 缓动，见 motion.springCurve），
// 不用 UA 默认的交叉淡化；伪元素的静态样式（裁切、铺放、原点）在 app.css 的 html[data-vt] 段。
//
// 兜底：内核不支持 / 系统减弱动效 / 用户关了转场 / 页面在后台——直接切，绝不卡住；
// 任何一次转场 1.8s 内没落幕就强制跳到终态。
import { tick } from 'svelte';
import { ui, prefs, rootScreen } from './state.svelte.js';
import { springCurve, NAV_SPRING, EASE, reduced, bezier } from './motion.js';

export const PAGE_NAME = 'bridge-page';
const HERO_NAME = 'bridge-hero';
const HOME_PUSH = 1.08;      // 打开分页时主页朝入口推近的倍率（关闭时从这里退回 1）

// 各分页的根盒（必须是真正产生盒子的元素：dimensio 的 .hxroot 是 display:contents，取它的 .shell）
const ROOTS = {
  claude: '.claude-slide',
  vertex: '.vertex-slide',
  chatgpt: '.chatgpt-page',
  harness: '.hxroot > .shell, .hx-placeholder',   // 入场期间是同色底板（HarnessPage 延后挂载）
  antigravity: '.hxroot > .shell, .hx-placeholder',
  files: '.fd-root:not(.embedded), .ws-root:not(.embedded)',
};
// 入口：手机四宫格里是 [data-entry=<key>] .tile；桌面 Dock 按 aria-label 找图标
const DOCK_LABEL = { claude: 'Claude', chatgpt: 'ChatGPT', harness: 'dimensio', vertex: 'Vertex' };

const html = () => document.documentElement;
const vp = () => ({ W: innerWidth, H: innerHeight });
let current = null;          // 正在跑的 ViewTransition
let seq = 0;                 // 代次：新转场一起，旧转场的收尾回调全部作废

export function morphSupported() {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function';
}
export function canMorph() {
  return morphSupported() && !reduced() && !prefs.noEnterAnim && !document.hidden;
}

function rectOf(src) {
  if (!src) return null;
  if (typeof src.getBoundingClientRect === 'function') {
    const r = src.getBoundingClientRect();
    return r.width > 1 && r.height > 1 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  }
  if (typeof src.x === 'number' && src.w > 1 && src.h > 1) return { x: src.x, y: src.y, w: src.w, h: src.h };
  return null;
}
function onScreen(r) {
  const { W, H } = vp();
  return !!r && r.x + r.w > 0 && r.y + r.h > 0 && r.x < W && r.y < H;
}
export function pageRoot(key) {
  const sel = ROOTS[key];
  if (!sel) return null;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}
// 入口方块 { el, rect, radius }；拿不到（入口被隐藏、从助手 / 命令面板进来）返回 null。
export function entryOf(key) {
  const k = key === 'antigravity' ? 'harness' : key;
  const tile = document.querySelector(`[data-entry="${k}"] .tile`);
  if (tile) { const rect = rectOf(tile); if (onScreen(rect)) return { el: tile, rect, radius: 30 }; }
  const lab = DOCK_LABEL[k];
  const dico = lab && document.querySelector(`button.ditem[aria-label="${lab}"] .dico`);
  if (dico) { const rect = rectOf(dico); if (onScreen(rect)) return { el: dico, rect, radius: 12 }; }
  return null;
}

function clearNames() {
  for (const el of document.querySelectorAll('[style*="view-transition-name"]')) el.style.viewTransitionName = '';
}
// 主页那张静态壁纸 <img> 本身解码好了没有：另开 Image 预解码不保证页面里这个元素首帧就画得出来
// （大图按显示尺寸异步解码，头几帧是空的——转场里就是先一片黑、图再冒出来）。在转场的更新回调里
// 等它（此时画面冻结在旧快照上，不算卡），有封顶。
export async function homeWallpaperReady(cap = 300) {
  const img = document.querySelector('.home .wp-img:not(.wp-fx)');
  if (!img?.decode) return;
  try { await Promise.race([img.decode(), new Promise((r) => setTimeout(r, cap))]); } catch {}
}

// 伪元素动画挂在 <html> 上、按名字指向伪元素：转场结束后它们不会自己消失（fill:'both' 停在终值），
// 下一次转场建出同名伪元素时会被旧终值串味（例如上一次「打开」把 new(root) 压成透明的终值）。
// 所以每一段都记账，收场 / 下一段开场时统一撤掉。
let liveAnims = [];
function dropAnims() {
  for (const a of liveAnims.splice(0)) { try { a.cancel(); } catch {} }
}
function anim(pseudo, frames, opts) {
  try {
    const a = html().animate(frames, { fill: 'both', ...opts, pseudoElement: `::view-transition-${pseudo}` });
    liveAnims.push(a);
    return a;
  } catch { return null; }
}

// 开一次转场。
//   before(ctx)：给【旧画面】里的元素命名（旧快照拍下之前）
//   update()：改状态（可 async），随后等 Svelte 把 DOM 刷完
//   afterUpdate(ctx)：给【新画面】里的元素命名、量新几何（新快照拍下之前）
//   play(ctx)：伪元素就绪后编排动画
// 返回的 promise 在转场结束（或被跳过）时 resolve，任何失败路径都不 reject。
function run(kind, { before, update, afterUpdate, play, vars = {}, spring = null }) {
  const my = ++seq;
  if (current) { try { current.skipTransition(); } catch {} }
  dropAnims();
  clearNames();
  const root = html();
  const sp = springCurve(spring || (kind === 'close' ? NAV_SPRING.close : NAV_SPRING.open));
  vars = { '--vt-dur': sp.duration + 'ms', '--vt-ease': sp.easing, ...vars };
  root.dataset.vt = kind;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  ui.morphing = kind;
  const ctx = { W: innerWidth, H: innerHeight, spring: sp };
  try { before?.(ctx); } catch {}
  let vt;
  try {
    vt = document.startViewTransition(async () => {
      await update();
      await tick();
      try { afterUpdate?.(ctx); } catch {}
    });
  } catch {
    cleanup(my, vars);
    return Promise.resolve(update());
  }
  current = vt;
  vt.ready.then(() => { if (my === seq) { try { play?.(ctx); } catch {} } }).catch(() => {});
  const done = vt.finished.catch(() => {}).then(() => cleanup(my, vars));
  // 保险：动画不落幕（事件丢失、伪元素没建起来）就强制收场——宁可没有动画，也不许把页面晾住
  const guard = setTimeout(() => { if (my === seq && current === vt) { try { vt.skipTransition(); } catch {} } }, 1800);
  done.then(() => clearTimeout(guard));
  return done;
}
function cleanup(my, vars) {
  if (my !== seq) return;
  current = null;
  dropAnims();
  const root = html();
  delete root.dataset.vt;
  for (const k of Object.keys(vars)) root.style.removeProperty(k);
  clearNames();
  ui.morphing = '';
}

// —— 打开：入口 → 分页 ——
// from：入口方块（元素或 {x,y,w,h}；缺省按 key 自己找）；radius：它的圆角；
// hero + heroTo：入口里要单独飞过去的图标、分页里它的落点选择器（可选）。
export function openPage(key, { from = null, radius = null, hero = null, heroTo = null, onSwitch = null } = {}) {
  const doSwitch = () => { ui.screen = key; onSwitch?.(); };
  if (ui.screen === key) return Promise.resolve();
  if (!canMorph()) { doSwitch(); return Promise.resolve(); }
  const ent = from ? { rect: rectOf(from), radius: radius ?? 30 } : entryOf(key);
  const src = ent && onScreen(ent.rect) ? ent.rect : null;
  const r0 = ent?.radius ?? radius ?? 30;
  const { W, H } = vp();
  const ox = src ? src.x + src.w / 2 : W / 2, oy = src ? src.y + src.h / 2 : H / 2;
  let heroOk = false;
  return run('open', {
    vars: { '--vt-ox': ox + 'px', '--vt-oy': oy + 'px' },
    before: () => {
      // 共享元素：入口里的图标单独飞到分页里的同款图标上（Gemini 十字星 → 问候语上方那颗）
      if (hero && heroTo && onScreen(rectOf(hero))) { hero.style.viewTransitionName = HERO_NAME; heroOk = true; }
    },
    update: doSwitch,
    afterUpdate: (ctx) => {
      const root = pageRoot(key);
      if (root) root.style.viewTransitionName = PAGE_NAME;
      ctx.page = !!root;
      if (heroOk) {
        const land = root && [...root.querySelectorAll(heroTo)].find((el) => onScreen(rectOf(el)));
        // 没有落点（分页停在对话记录里）：图标不单飞，留在主页快照里跟着退后
        if (land) land.style.viewTransitionName = HERO_NAME;
        else hero.style.viewTransitionName = '';
      }
    },
    play: ({ spring, page }) => {
      const d = spring.duration;
      const s = src || { x: W * 0.07, y: H * 0.07, w: W * 0.86, h: H * 0.86 };
      if (page) {
        anim(`group(${PAGE_NAME})`, [
          { transform: `translate(${s.x}px, ${s.y}px)`, width: s.w + 'px', height: s.h + 'px', borderRadius: r0 + 'px' },
          { transform: 'translate(0px, 0px)', width: W + 'px', height: H + 'px', borderRadius: '0px' },
        ], { duration: d, easing: spring.easing });
        // 内容随卡片一起浮现：前三成就到不透明，读作「方块本身变成了这一页」，而不是一张图渐显
        anim(`new(${PAGE_NAME})`, [{ opacity: 0 }, { opacity: 1 }], { duration: Math.round(d * 0.3), easing: EASE.fade });
        // 新画面除去分页就只剩底色：藏起来，让退后的主页压暗到黑里而不是灰里
        anim('new(root)', [{ opacity: 0 }, { opacity: 0 }], { duration: d });
      }
      // 主页朝入口推近、压暗（镜头「飞进」这个入口）：以入口为原点放大——入口本身不动，
      // 卡片就是从这一点长出来的；放大而不是缩小，屏幕四周永远不会露出黑边
      anim('old(root)', [
        { transform: 'scale(1)', opacity: 1 },
        { transform: `scale(${HOME_PUSH})`, opacity: page ? 0.4 : 0 },
      ], { duration: d, easing: spring.easing });
    },
  });
}

// —— 关闭：分页 → 入口 ——
// fromRect：手势返回时页面此刻的视觉矩形（已经缩小 / 位移），转场从这里接着走；可传函数（等键盘收完再量）；
// fromRadius：那一刻的圆角。onSwitch：切回主页的同一拍里要复位的本地状态（位移、sliding…）。
export async function closePage(key = ui.screen, { fromRect = null, fromRadius = 0, onSwitch = null } = {}) {
  // 单 agent 模式没有主页可回：根页本身关不掉（返回键到底由 nav 交给原生退后台），
  // 别的页（工作空间等）关掉 = 纵深淡换回根页。
  const base = rootScreen();
  if (base !== 'home') {
    if (ui.screen === base) { onSwitch?.(); return; }
    return switchPage(base, { onSwitch });
  }
  const doSwitch = () => { ui.screen = 'home'; onSwitch?.(); };
  if (ui.screen === 'home') { onSwitch?.(); return; }
  if (!canMorph()) { doSwitch(); return; }
  await settleKeyboard(pageRoot(key));
  if (ui.screen === 'home') { onSwitch?.(); return; }
  const root = pageRoot(key);
  const { W, H } = vp();
  if (typeof fromRect === 'function') fromRect = fromRect();
  const start = fromRect || rectOf(root) || { x: 0, y: 0, w: W, h: H };
  let tgt = null;
  return run('close', {
    vars: { '--vt-ox': W / 2 + 'px', '--vt-oy': H / 2 + 'px' },
    before: () => { if (root) root.style.viewTransitionName = PAGE_NAME; },
    update: async () => {
      if (root) root.style.viewTransitionName = '';
      doSwitch();
      await tick();
      await homeWallpaperReady(250);
    },
    afterUpdate: (ctx) => {
      // 新画面（主页）已排好版：量入口方块的落点，主页「回到前面」的原点也放在它上面，
      // 这样主页放大的全程入口都钉在原地，卡片落得准
      const ent = entryOf(key);
      tgt = ent ? { ...ent.rect, r: ent.radius, el: ent.el } : null;
      if (tgt) {
        html().style.setProperty('--vt-ox', tgt.x + tgt.w / 2 + 'px');
        html().style.setProperty('--vt-oy', tgt.y + tgt.h / 2 + 'px');
      }
      ctx.page = !!root;
      // 快照层在转场期间吃掉所有点击：记下主页各入口的落点，下面「落地前就点下一个」时用
      ctx.tiles = [...document.querySelectorAll('[data-entry]')]
        .map((btn) => { const el = btn.querySelector('.tile'); return { key: btn.dataset.entry, el, r: rectOf(el) }; })
        .filter((t) => t.r && onScreen(t.r));
    },
    play: ({ spring, page, tiles }) => {
      const d = spring.duration;
      tapThrough(tiles, d);
      // 找不到入口（从助手 / 命令面板开的页、入口被隐藏）：收成屏幕中间一张小卡再化开
      const t = tgt || { x: W * 0.3, y: H * 0.34, w: W * 0.4, h: H * 0.32, r: 28 };
      if (page) {
        anim(`group(${PAGE_NAME})`, [
          { transform: `translate(${start.x}px, ${start.y}px)`, width: start.w + 'px', height: start.h + 'px', borderRadius: fromRadius + 'px' },
          { transform: `translate(${t.x}px, ${t.y}px)`, width: t.w + 'px', height: t.h + 'px', borderRadius: t.r + 'px' },
        ], { duration: d, easing: spring.easing });
        // 页面快照在后半程化开，露出主页快照里入口本来的样子——卡片「落进」方块
        anim(`old(${PAGE_NAME})`, tgt
          ? [{ opacity: 1 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }]
          : [{ opacity: 1 }, { opacity: 0 }],
        { duration: Math.round(d * (tgt ? 0.72 : 0.55)), easing: 'linear' });
        // 入口「接住」卡片：落到的那一刻轻轻鼓一下再回原样（真实主页 DOM 上做，透过化开的卡片看得见）
        try {
          tgt?.el?.animate([
            { transform: 'scale(1)' }, { transform: 'scale(1.07)', offset: 0.35 }, { transform: 'scale(1)' },
          ], { duration: 420, delay: Math.round(d * 0.42), easing: EASE.std, fill: 'none' });
        } catch {}
      }
      // 主页退回原位、提亮（镜头从入口里退出来）：以入口为原点从推近的位置缩回。
      // 手势返回时主页已经原样露在身后，从原样起步，否则松手那一帧主页会突然跳一下
      anim('new(root)', fromRect
        ? [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1)', opacity: 1 }]
        : [{ transform: `scale(${HOME_PUSH})`, opacity: 0.4 }, { transform: 'scale(1)', opacity: 1 }],
      { duration: d, easing: spring.easing });
    },
  });
}

// 焦点还在要离开的分页里的输入框上：先让它失焦；软键盘真开着的话，等它收完、视口复原再开转场。
// 转场进行中视口尺寸一变（键盘收起），浏览器会直接跳过整段转场——页面「啪」地消失。
// 键盘开没开看视口比「这个朝向见过的最高视口」矮了多少（resizes-content 下键盘会把 innerHeight 顶小）；
// 没开就不等，开着最多等 360ms。
const tallest = { p: 0, l: 0 };
const orient = () => (innerWidth > innerHeight ? 'l' : 'p');
if (typeof window !== 'undefined') {
  const note = () => { const o = orient(); tallest[o] = Math.max(tallest[o], innerHeight); };
  note();
  window.addEventListener('resize', note);
}
function settleKeyboard(root) {
  const ae = document.activeElement;
  if (!ae || !root?.contains(ae) || !(ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) return Promise.resolve();
  try { ae.blur(); } catch {}
  const vv = window.visualViewport;
  const h = Math.min(innerHeight, vv ? vv.height : innerHeight);
  if (!vv || tallest[orient()] - h < 120) return Promise.resolve();
  return new Promise((res) => {
    let t = 0;
    const done = () => { clearTimeout(t); vv.removeEventListener('resize', onR); res(); };
    // 键盘收起会连着来几次 resize：最后一次之后静 80ms 才算落定
    const onR = () => { clearTimeout(t); t = setTimeout(done, 80); };
    vv.addEventListener('resize', onR);
    t = setTimeout(done, 360);
  });
}

// 收回入口的后半程（卡片已经小了）点主页上的某个入口 = 直接打开它：跳过剩下的收尾、从那一格长出新页。
// 没有这一条的话，最后这 ~250ms 里的点击全被快照层吞掉——「回到主页马上点下一个」要点两次。
// 前半程卡片还盖着大半屏，点到的其实是它，不接。
function tapThrough(tiles, d) {
  if (!tiles?.length) return;
  const vt = current, t0 = performance.now();
  const onDown = (e) => {
    if (current !== vt) { off(); return; }
    if (performance.now() - t0 < d * 0.4) return;
    const hit = tiles.find(({ r }) => e.clientX >= r.x - 6 && e.clientX <= r.x + r.w + 6 && e.clientY >= r.y - 6 && e.clientY <= r.y + r.h + 6);
    if (!hit) return;
    off();
    try { e.preventDefault(); } catch {}
    try { vt.skipTransition(); } catch {}
    // 等跳过落地（DOM 已是主页终态）再开下一段，否则新转场拍到的旧画面是半路的快照
    vt.finished.catch(() => {}).then(() => openPage(hit.key, { from: hit.el, radius: 30 }));
  };
  const off = () => window.removeEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerdown', onDown, true);
  vt?.finished.catch(() => {}).then(off);
}

// —— 分页 ⇄ 分页（不经主页：助手导航、命令面板）：纵深淡换 ——
export function switchPage(key, { onSwitch = null } = {}) {
  const doSwitch = () => { ui.screen = key; onSwitch?.(); };
  if (ui.screen === key) return Promise.resolve();
  if (!canMorph()) { doSwitch(); return Promise.resolve(); }
  const { W, H } = vp();
  return run('switch', {
    vars: { '--vt-ox': W / 2 + 'px', '--vt-oy': H / 2 + 'px' },
    update: doSwitch,
    play: ({ spring }) => {
      anim('old(root)', [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.94)', opacity: 0 }],
        { duration: 200, easing: EASE.accel });
      anim('new(root)', [{ transform: 'scale(1.05)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: spring.duration, delay: 70, easing: spring.easing });
    },
  });
}

// —— 预测式返回：边缘右滑时页面怎么跟手 ——
// 不再整页 1:1 往右平移（那是「翻回上一页」的语言，而这一页的来处是主页上的入口）：
// 页面随手指缩小、只跟一小段位移、四角长出圆角，身后主页露出来——手感像把卡片捏起来。
// 松手判定完成就把此刻的形态交给 closePage 续走（收回入口），判定取消则弹簧回到 0。
export function backPeek(dragX, W = innerWidth) {
  const p = Math.max(0, Math.min(1, dragX / Math.max(1, W)));
  const e = 1 - (1 - p) * (1 - p);      // 先快后慢：头几十像素就给出明显的形变
  const s = 1 - 0.13 * e;
  const tx = W * 0.15 * e;
  const r = Math.min(28, dragX * 0.8);
  return {
    s, tx, r,
    transform: dragX > 0 ? `translateX(${tx.toFixed(2)}px) scale(${s.toFixed(4)})` : null,
    // clip-path 在元素自身坐标里（变换之前），视觉圆角 = r，故除以 s
    clip: dragX > 0 ? `inset(0 round ${(r / s).toFixed(2)}px)` : null,
  };
}

// —— 统一入口：去某个分页 / 回主页，自动选打开、关闭还是直达 ——
export function goto(key, opts = {}) {
  if (!key || key === ui.screen) return Promise.resolve();
  if (key === 'home') return closePage(ui.screen, opts);
  if (ui.screen === 'home') return openPage(key, opts);
  return switchPage(key, opts);
}

// —— 入口图标「浮现」：从虚到实、微微放大落定（主题换场 / 开机揭幕共用）——
// items: [{ el, at }]，at = 该图标开始浮现的时刻（ms，相对动画起点）
function bloom(items) {
  const sp = springCurve(NAV_SPRING.settle);
  for (const { el, at } of items) {
    try {
      el.animate([
        { opacity: 0, transform: 'scale(.8)', filter: 'blur(6px)' },
        { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' },
      ], { duration: sp.duration, delay: Math.max(0, Math.round(at)), easing: sp.easing, fill: 'backwards' });
    } catch {}
  }
}
const homeIcons = () => [...document.querySelectorAll('.grid .entry .ico, .ditem .dico')]
  .map((el) => ({ el, r: rectOf(el) })).filter((o) => o.r && onScreen(o.r));

// —— 开机揭幕：封面方块打开成一扇窗，主页在窗里 ——
// 旧版窗口是「透明洞 + 9999px 黑环」在主线程上逐帧改宽高，且只等了另一张 Image 的解码——主页里那张
// 壁纸元素本身常常还没画出来，窗子打开看见的是一片黑，半秒后主页才「啪」地出现；标题飞往左上
// 靠逐帧改 top/left/字号，字形一路抖。现在：
//   · 旧快照 = 封面（底色 + 方块 + 居中标题），新快照 = 已经解码画好的主页（更新回调里等 img.decode）；
//   · 主页快照裁成方块、随弹簧张开到整屏（clip-path），窗里的景同时从 1.06 落定——推近对焦的感觉；
//   · 白方块到风景之间 140ms 交叉淡化，不再一帧硬换；
//   · 标题是共享元素：UA 按两端几何插值、贴图缩放，零重排，字不抖；
//   · 入口图标在窗口张到它时逐个浮现。
// square：封面方块 {x,y,w,h,r}；apply()：切到主页的状态改动（booted 等）。
export function bootReveal({ square, apply }) {
  const { W, H } = vp();
  const q = square || { x: W / 2 - 74, y: H / 2 - 74, w: 148, h: 148, r: 34 };
  const cx = q.x + q.w / 2, cy = q.y + q.h / 2;
  return run('boot', {
    spring: NAV_SPRING.settle,
    vars: { '--vt-ox': cx + 'px', '--vt-oy': cy + 'px' },
    before: () => {
      const brand = document.querySelector('.brand.show');
      if (brand) brand.style.viewTransitionName = 'bridge-brand';
    },
    update: async () => { await apply(); await tick(); await homeWallpaperReady(450); },
    afterUpdate: (ctx) => { ctx.icons = homeIcons(); },
    play: ({ spring, icons }) => {
      const d = spring.duration;
      anim('new(root)', [
        { clipPath: `inset(${q.y}px ${W - q.x - q.w}px ${H - q.y - q.h}px ${q.x}px round ${q.r}px)` },
        { clipPath: 'inset(0px 0px 0px 0px round 0px)' },
      ], { duration: d, easing: spring.easing });
      anim('new(root)', [{ transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: d + 380, easing: EASE.decel });
      anim('new(root)', [{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: EASE.fade });
      // 窗口（方块）半边长从 q.w/2 张到覆盖整屏：图标所在的「切比雪夫半径」被扫到的那一刻浮现
      const full = Math.max(cx, W - cx, cy, H - cy);
      bloom((icons || []).map(({ el, r }) => {
        const dd = Math.max(Math.abs(r.x + r.w / 2 - cx), Math.abs(r.y + r.h / 2 - cy)) + Math.max(r.w, r.h) * 0.3;
        const p = Math.min(1, Math.max(0, (dd - q.w / 2) / Math.max(1, full - q.w / 2)));
        return { el, at: spring.reach(p) };
      }));
    },
  });
}

// —— 主页明暗换场（点 THE BRIDGE）——
// 新主题从标题那一点以柔边圆波铺开（暗→明像天光漫开，明→暗像夜色合拢）：
//   · 波前起步快、收尾慢——点下去的一瞬间标题周围就换了天色，最远的角落慢慢收完；
//   · 新画面边铺边从 1.045 落定到 1，旧画面同时朝外推远 3%：波前两侧一收一放，纵深出来了；
//   · 入夜时旧画面先暗下去（黄昏），天亮时不压（暗场压了也看不出）；
//   · 入口图标按离标题的远近，在波前扫到自己的那一刻逐个浮现（从虚到实、微微放大落定）。
// 整段 ~1.05s，一个焦点。apply()：同步切换状态的函数（setHomeMode）；prepare()：可选预备
// （解码新壁纸），在拍旧快照之前等完（封顶 900ms，拿不到图也照样换）。
const REVEAL = { dur: 1050, ease: [0.3, 0.55, 0.18, 1] };
export async function morphTheme(originEl, apply, { prepare = null, toLight = true } = {}) {
  if (!canMorph()) { apply(); return; }
  if (prepare) { try { await Promise.race([prepare(), new Promise((r) => setTimeout(r, 900))]); } catch {} }
  const { W, H } = vp();
  const o = rectOf(originEl);
  const ox = o ? o.x + Math.min(o.w, 60) / 2 : 40, oy = o ? o.y + o.h / 2 : 40;
  const far = Math.max(Math.hypot(ox, oy), Math.hypot(W - ox, oy), Math.hypot(ox, H - oy), Math.hypot(W - ox, H - oy));
  const feather = Math.round(Math.min(300, Math.max(150, far * 0.24)));
  const R = far + feather;
  const ease = bezier(...REVEAL.ease);
  await run('theme', {
    vars: { '--vt-ox': ox + 'px', '--vt-oy': oy + 'px', '--vt-f': feather + 'px' },
    update: apply,
    afterUpdate: (ctx) => {
      // 新画面里的入口图标（手机四宫格 / 桌面 Dock），记下各自离标题多远
      ctx.icons = homeIcons().map(({ el, r }) => ({ el, d: Math.hypot(r.x + r.w / 2 - ox, r.y + r.h / 2 - oy) }));
    },
    play: (ctx) => {
      const D = REVEAL.dur;
      const easing = `cubic-bezier(${REVEAL.ease.join(',')})`;
      anim('new(root)', [{ '--vt-r': '0px' }, { '--vt-r': R + 'px' }], { duration: D, easing });
      anim('new(root)', [{ transform: 'scale(1.045)' }, { transform: 'scale(1)' }], { duration: D + 200, easing: EASE.decel });
      // 旧画面朝外推远（以标题为原点放大——缩小会在右下露出黑边）；入夜时先暗下去
      anim('old(root)', toLight
        ? [{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }]
        : [{ transform: 'scale(1)', filter: 'brightness(1)' }, { transform: 'scale(1.03)', filter: 'brightness(.5)' }],
      { duration: D, easing });
      // 图标：波前（实心区外沿）扫到它的时刻浮现
      bloom((ctx.icons || []).map(({ el, d }) => {
        let t = 1;
        for (let i = 0; i <= 80; i++) { const tt = i / 80; if (R * ease(tt) - feather * 0.55 >= d) { t = tt; break; } }
        return { el, at: t * D };
      }));
    },
  });
}
