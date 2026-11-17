// 预览验证的手势库与视口档。只基于 studio-qa/cdp.mjs 的 launchEdge / openPage（无头 Edge、临时 profile），
// 绝不附着维护者的浏览器或桌面壳。坐标一律是 CSS 像素（视口坐标）。
//
// 坑（摸底「验证与发布路径」约束 5、6）都在这里封掉：
//   - 触点一律带 id；touchStart / touchMove 传当前按着的全部手指；抬手发 touchEnd（不带触点 = 全部抬起），
//     多指里只抬一根用 liftFinger（touchMove 只传剩下的手指）。不带 id 的触点会残留成下一场的第三根手指。
//   - dispatchTouchEvent 按多久都不出 contextmenu：触屏长按临时开 setEmitTouchEventsForMouse，
//     发 mousePressed / mouseReleased，两下都不 await（回执要等手势收尾、收尾又等回执，会互相挂住）。
//   - 第二根手指一落下就不合成 click：验多指别调 .click()。
//   - Ctrl+滚轮用 modifiers:2；滚轮前先 mouseMoved 到落点（滚的是指针下的容器）。
//   - 连做几次滑动，场间等约 2 秒让惯性停下（swipe 的 settle 参数）。
//   - 触摸仿真会在指针位置留灰点：截图前 pointerOut 把指针挪出视口。
//   - 截图一律 JPEG；attach 后 bringToFront + setFocusEmulationEnabled（openPage 已做），否则页面降到 1Hz。
import { launchEdge, openPage, sleep } from '../studio-qa/cdp.mjs';

export { sleep };

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 16; SM-S9370 Build/BP2A.250605.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/155.0.7570.0 Mobile Safari/537.36';
const phone = { touch: true, mobile: true, ua: PHONE_UA, sat: 40, sab: 20, lang: 'zh', theme: 'light' };
const desk = { touch: false, mobile: false, sat: 0, sab: 0, lang: 'zh', theme: 'light' };

/** 视口档。加档就往这里加一行（id 唯一）。 */
export const PROFILES = {
  p393: { id: 'p393', w: 393, h: 873, dpr: 2.75, ...phone },                         // 维护者的手机（1080×2520 / 2.75）
  'p393-dark': { id: 'p393-dark', w: 393, h: 873, dpr: 2.75, ...phone, theme: 'dark' },
  p360: { id: 'p360', w: 360, h: 780, dpr: 3, ...phone, sat: 32, sab: 18 },          // 窄屏安卓
  fold720: { id: 'fold720', w: 720, h: 900, dpr: 2.5, ...phone, sat: 32, sab: 16 },  // 折叠屏展开
  d1440: { id: 'd1440', w: 1440, h: 900, dpr: 1, ...desk },
  'd1440-dark': { id: 'd1440-dark', w: 1440, h: 900, dpr: 1, ...desk, theme: 'dark' },
  'd1440-125': { id: 'd1440-125', w: 1440, h: 900, dpr: 1.25, ...desk },              // DPR≠1 的电脑档（Windows 125% 缩放）
};
export const DEFAULT_PROFILES = ['p393', 'p360', 'fold720', 'd1440', 'd1440-dark'];

export async function emulate(pg, cfg, over = {}) {
  const c = { ...cfg, ...over };
  await pg.send('Emulation.setDeviceMetricsOverride', { width: c.w, height: c.h, deviceScaleFactor: c.dpr, mobile: !!c.mobile, screenWidth: c.w, screenHeight: c.h });
  await pg.send('Emulation.setTouchEmulationEnabled', c.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  if (c.ua) await pg.send('Emulation.setUserAgentOverride', { userAgent: c.ua, platform: 'Linux armv8l', userAgentMetadata: { platform: 'Android', platformVersion: '16', architecture: '', model: 'SM-S9370', mobile: !!c.mobile, brands: [{ brand: 'Android WebView', version: '155' }] } });
  await pg.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: c.theme === 'dark' ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: c.reducedMotion ? 'reduce' : 'no-preference' }] });
}

/** 新文档最早期注入：主题、安全区（同 apk 原生注入，根元素 inline style 的 --sat / --sab） */
export function preludeSource(cfg) {
  return `(() => {
    try { localStorage.setItem('bridge-theme', ${JSON.stringify(cfg.theme || 'light')}); } catch {}
    let done = false;
    const apply = () => { const de = document.documentElement; if (!de || done) return; done = true;
      de.style.setProperty('--sat', '${cfg.sat || 0}px'); de.style.setProperty('--sab', '${cfg.sab || 0}px'); };
    apply();
    if (!done) { document.addEventListener('readystatechange', apply); new MutationObserver((_, ob) => { if (document.documentElement) { apply(); ob.disconnect(); } }).observe(document, { childList: true, subtree: true }); }
  })();`;
}

/** 起一个全新的无头 Edge（临时 profile）+ 页面会话，并按档仿真。用完 await env.close()（try/finally）。 */
// 坑（2026-11-13 实测）：本机 Edge 会给全新的临时 profile 隐式登录并开同步，约 20 秒后同步 / 外部注册
// （HKCU\Software\Microsoft\Edge\Extensions）装上一串扩展，扩展再自己开 claude.ai/oauth、chatgpt.com、edge://sync-confirmation-dialog
// 等新标签页抢前台 —— 我们的页面被挤到后台，rAF 降到 1Hz（最长帧 1000ms），侧滑「翻不过去」、captureScreenshot 45 秒超时。
// 对策两层：启动参数关同步 / 扩展 / 登录；再盯住新开的页面目标，不是自己的就立刻关掉并把自己的页面拉回前台。
const ISOLATE_ARGS = ['--disable-sync', '--disable-extensions', '--disable-component-extensions-with-background-pages', '--disable-default-apps',
  '--no-service-autorun',
  // cdp.mjs 自己带了 --disable-features=Translate,msEdgeTranslate；同名开关只认最后一个，这里合并写全
  '--disable-features=Translate,msEdgeTranslate,msImplicitSignin,msEdgeSyncConsent,msSignInPromo,EdgeSidebar,msUndersideButton'];

export async function newSession(profileId, { extraArgs = [] } = {}) {
  const cfg = typeof profileId === 'object' ? profileId : PROFILES[profileId];
  if (!cfg) throw new Error('未知视口档：' + profileId + '（可选：' + Object.keys(PROFILES).join(',') + '）');
  const edge = await launchEdge({ extraArgs: [...ISOLATE_ARGS, ...extraArgs] });
  try {
    const pg = await openPage(edge);
    const strays = [];
    edge.conn.on('Target.targetCreated', ({ targetInfo: ti }) => {
      if (ti.type !== 'page' || ti.targetId === pg.targetId) return;
      strays.push(ti.url.slice(0, 120));
      edge.conn.send('Target.closeTarget', { targetId: ti.targetId }).catch(() => {}).then(() => pg.send('Page.bringToFront').catch(() => {}));
    });
    await edge.conn.send('Target.setDiscoverTargets', { discover: true });
    await emulate(pg, cfg);
    await pg.send('Page.addScriptToEvaluateOnNewDocument', { source: preludeSource(cfg) });
    return { edge, pg, cfg, g: bind(pg, cfg), strays, close: () => edge.close() };
  } catch (e) { await edge.close(); throw e; }
}

// —— 基础 ————————————————————————————————————————————————————————————————
const touchPts = (list) => list.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i + 1, radiusX: 4, radiusY: 4, force: 1 }));
const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
const ease = (k) => 1 - (1 - k) * (1 - k);   // 手指先快后慢

/** 选择器 → 元素中心（先滚进视口、等位置稳定、用 elementFromPoint 确认落点）。text 可选：按文字 / aria-label 过滤。 */
export async function center(pg, sel, { text = null, within = null, timeout = 8000, block = 'nearest' } = {}) {
  const r = await pg.eval(`(async () => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[inert],[hidden]'); };
    // within 可能匹配到 keep-alive 隐藏分页里的同名根（约束 8）：只在可见的根里找
    const roots = () => ${within ? `[...document.querySelectorAll(${JSON.stringify(within)})].filter(vis)` : '[document]'};
    const pick = () => { const els = roots().flatMap((root) => [...root.querySelectorAll(${JSON.stringify(sel)})]).filter(vis);
      const tx = ${JSON.stringify(text)}; return tx == null ? els[0] : els.find((e) => (e.textContent || '').replace(/\\s+/g, ' ').includes(tx) || (e.getAttribute('aria-label') || '').includes(tx) || (e.getAttribute('title') || '').includes(tx)); };
    const t0 = Date.now(); let el = null;
    while (!(el = pick())) { if (Date.now() - t0 > ${timeout}) return { err: '找不到 ' + ${JSON.stringify(sel + (text ? ' 「' + text + '」' : ''))} }; await new Promise((r) => setTimeout(r, 60)); }
    el.scrollIntoView({ block: ${JSON.stringify(block)}, inline: 'nearest' });
    let prev = ''; for (let i = 0; i < 40; i++) { await new Promise((r) => requestAnimationFrame(r)); const b = el.getBoundingClientRect(); const k = Math.round(b.left) + ',' + Math.round(b.top); if (k === prev) break; prev = k; }
    const b = el.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, w: b.width, h: b.height, hitOk: !!hit && (hit === el || el.contains(hit) || hit.contains(el)), hit: hit ? hit.tagName.toLowerCase() + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.split(/\\s+/).filter((c) => !/^svelte-/.test(c)).slice(0, 2).join('.') : '') : '' };
  })()`, { timeout: timeout + 5000 });
  if (r?.err) throw new Error(r.err);
  return r;
}

/** 点按（触屏档走触摸，电脑档走鼠标左键单击） */
export async function tap(pg, cfg, x, y, { hold = 60 } = {}) {
  if (cfg.touch) {
    await pg.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touchPts([{ x, y, id: 1 }]) });
    await sleep(hold);
    await pg.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await pg.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(Math.min(hold, 40));
    await pg.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
}

/** 双击 / 双点（gap = 两下之间的毫秒） */
export async function doubleTap(pg, cfg, x, y, { gap = 120 } = {}) {
  if (cfg.touch) {
    await tap(pg, cfg, x, y, { hold: 40 });
    await sleep(gap);
    await tap(pg, cfg, x, y, { hold: 40 });
  } else {
    await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (const n of [1, 2]) {
      await pg.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n });
      await pg.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: n });
      if (n === 1) await sleep(gap);
    }
  }
}

/** 长按：触屏档临时开 setEmitTouchEventsForMouse，真等 hold 毫秒（会补 contextmenu、不合成 click） */
export async function longPress(pg, cfg, x, y, { hold = 800 } = {}) {
  if (cfg.touch) {
    await pg.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    const quiet = (type, buttons) => pg.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 }, hold + 3000).catch(() => {});
    quiet('mousePressed', 1);   // 不 await（见文件头）
    await sleep(hold);
    quiet('mouseReleased', 0);
    await sleep(200);
    await pg.send('Emulation.setEmitTouchEventsForMouse', { enabled: false }).catch(() => {});
  } else {
    await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await pg.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(hold);
    await pg.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
}

/** 单指滑动（触屏）。ms=总时长、steps=中间点数、hold=落指后停多久再动、settle=抬手后等多久（惯性）。
 *  返回 { endAt }：抬手那一刻的 Date.now()（页面里的精确时刻请在页面侧挂 touchend 监听取 performance.now()）。 */
export async function swipe(pg, cfg, from, to, { ms = 220, steps = 12, hold = 0, settle = 0, easing = true } = {}) {
  if (!cfg.touch) return drag(pg, cfg, from, to, { ms, steps });
  const n = Math.max(2, steps);
  const dt = ms / n;
  await pg.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touchPts([{ ...from, id: 1 }]) });
  if (hold) await sleep(hold);
  for (let i = 1; i <= n; i++) {
    const k = easing ? ease(i / n) : i / n;
    await pg.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touchPts([{ ...lerp(from, to, k), id: 1 }]) });
    await sleep(dt);
  }
  await pg.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const endAt = Date.now();
  if (settle) await sleep(settle);
  return { endAt };
}

/** 双指捏合 / 张开：以 c 为中心，两指距离从 2*radius 变到 2*radius*scale（scale>1 放大）。angle=两指连线角度（度）。 */
export async function pinch(pg, cfg, c, scale = 2, { steps = 12, radius = 60, ms = 300, angle = 0, settle = 0 } = {}) {
  if (!cfg.touch) throw new Error('pinch 只在触屏档可用');
  const n = Math.max(2, steps);
  const ca = Math.cos((angle * Math.PI) / 180), sa = Math.sin((angle * Math.PI) / 180);
  const pts = (r) => touchPts([{ x: c.x - r * ca, y: c.y - r * sa, id: 1 }, { x: c.x + r * ca, y: c.y + r * sa, id: 2 }]);
  await pg.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(radius) });
  for (let i = 1; i <= n; i++) {
    await pg.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(radius * (1 + ((scale - 1) * i) / n)) });
    await sleep(ms / n);
  }
  await pg.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  if (settle) await sleep(settle);
}

/** 多指里只抬起一部分：remaining = 还按着的手指（带 id）。全部抬起直接发 touchEnd。 */
export async function liftFinger(pg, remaining) {
  if (!remaining?.length) return pg.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return pg.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touchPts(remaining) });
}

/** 鼠标拖动（按下 → 插值移动带 buttons → 松开）。button: left|middle|right；modifiers 同 CDP（1 Alt 2 Ctrl 4 Meta 8 Shift）。 */
export async function drag(pg, cfg, from, to, { ms = 300, steps = 16, button = 'left', modifiers = 0, hold = 0 } = {}) {
  const n = Math.max(2, steps);
  const buttons = { left: 1, right: 2, middle: 4 }[button] || 1;
  await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, modifiers });
  await pg.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button, buttons, clickCount: 1, modifiers });
  if (hold) await sleep(hold);
  for (let i = 1; i <= n; i++) {
    const p = lerp(from, to, i / n);
    await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button, buttons, modifiers });
    await sleep(ms / n);
  }
  await pg.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button, buttons: 0, clickCount: 1, modifiers });
}

/** 滚轮：dy>0 向下（缩小方向），ctrl=true 带 Ctrl（modifiers:2）。ticks 次、每次间隔 gap 毫秒。 */
export async function wheel(pg, cfg, x, y, { dy = -120, dx = 0, ctrl = false, shift = false, ticks = 1, gap = 40 } = {}) {
  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
  await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  for (let i = 0; i < ticks; i++) {
    await pg.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, modifiers });
    if (gap) await sleep(gap);
  }
}

/** 悬停（鼠标移到 x,y；steps>1 时从当前位置插值过去，触发 mouseenter/移动唤出控件） */
const lastMouse = new WeakMap();   // 每个页面各记一份上次的鼠标位置
export async function hover(pg, cfg, x, y, { steps = 1, ms = 0 } = {}) {
  const from = lastMouse.get(pg) || { x, y };
  for (let i = 1; i <= steps; i++) {
    const p = lerp(from, { x, y }, i / steps);
    await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    if (ms) await sleep(ms / steps);
  }
  lastMouse.set(pg, { x, y });
}

/** 截图前把指针挪出视口（触摸仿真的灰点、hover 态都撤掉） */
export async function pointerOut(pg, cfg) {
  try { await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cfg.w + 400, y: cfg.h + 400 }); } catch {}
  lastMouse.delete(pg);
}

// —— 键盘 ————————————————————————————————————————————————————————————————
const KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }, tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 }, esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 }, delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 }, pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 }, end: { key: 'End', code: 'End', keyCode: 35 },
  '+': { key: '+', code: 'Equal', keyCode: 187, text: '+' }, '=': { key: '=', code: 'Equal', keyCode: 187, text: '=' },
  '-': { key: '-', code: 'Minus', keyCode: 189, text: '-' }, ',': { key: ',', code: 'Comma', keyCode: 188, text: ',' }, '.': { key: '.', code: 'Period', keyCode: 190, text: '.' },
  '/': { key: '/', code: 'Slash', keyCode: 191, text: '/' }, '?': { key: '?', code: 'Slash', keyCode: 191, text: '?' },
};
for (let i = 1; i <= 12; i++) KEYS['f' + i] = { key: 'F' + i, code: 'F' + i, keyCode: 111 + i };
export function parseKey(spec) {
  const parts = String(spec).split('+');
  // 允许 "ctrl++" 这种写法：末尾空串还原成 '+'
  if (parts.length > 1 && parts[parts.length - 1] === '' ) { parts.pop(); parts[parts.length - 1] = '+'; }
  let modifiers = 0;
  const bits = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };
  while (parts.length > 1 && bits[parts[0].toLowerCase()] != null) modifiers |= bits[parts.shift().toLowerCase()];
  const base = parts.join('+');
  let k = KEYS[base.toLowerCase()];
  if (!k && base.length === 1) {
    const ch = base, up = ch.toUpperCase();
    const isDigit = /[0-9]/.test(ch);
    k = { key: modifiers & 8 ? up : ch, code: isDigit ? 'Digit' + ch : 'Key' + up, keyCode: up.charCodeAt(0), text: modifiers & 8 ? up : ch };
  }
  if (!k) throw new Error('不认识的键：' + spec);
  return { k, modifiers };
}
/** 按键：'escape'、'arrowright'、'ctrl+0'、'shift+?'、'f'、'space' */
export async function key(pg, cfg, spec, { hold = 0 } = {}) {
  const { k, modifiers } = parseKey(spec);
  const ev = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
  const withText = k.text && !(modifiers & ~8) ? { ...ev, text: k.text, unmodifiedText: k.text } : ev;
  await pg.send('Input.dispatchKeyEvent', { type: k.text && !(modifiers & ~8) ? 'keyDown' : 'rawKeyDown', ...withText });
  if (hold) await sleep(hold);
  await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
}

// —— 环境仿真 ————————————————————————————————————————————————————————————
/** CPU 降速（1 = 不降） */
export const cpu = (pg, rate = 4) => pg.send('Emulation.setCPUThrottlingRate', { rate });
/** 网络档：'4g' | '3g' | 'wifi' | null（关）；也可传 { latency, down, up }（毫秒 / Mbps） */
export async function network(pg, preset) {
  const P = { wifi: { latency: 8, down: 80, up: 30 }, '4g': { latency: 60, down: 20, up: 8 }, '3g': { latency: 200, down: 1.6, up: 0.75 } };
  const c = typeof preset === 'string' ? P[preset] : preset;
  await pg.send('Network.enable');
  if (!c) return pg.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  return pg.send('Network.emulateNetworkConditions', { offline: false, latency: c.latency, downloadThroughput: (c.down * 1e6) / 8, uploadThroughput: (c.up * 1e6) / 8 });
}
export async function cacheDisabled(pg, on = true) { await pg.send('Network.enable'); return pg.send('Network.setCacheDisabled', { cacheDisabled: !!on }); }

/** 把以上手势绑到某个页面 + 档上：g.tap(x,y)、g.swipe(from,to,opts)、g.tapSel('.mv-btn', { text: '关闭' }) …… */
export function bind(pg, cfg) {
  const g = {
    center: (sel, o) => center(pg, sel, o),
    tap: (x, y, o) => tap(pg, cfg, x, y, o),
    doubleTap: (x, y, o) => doubleTap(pg, cfg, x, y, o),
    longPress: (x, y, o) => longPress(pg, cfg, x, y, o),
    swipe: (from, to, o) => swipe(pg, cfg, from, to, o),
    pinch: (c, s, o) => pinch(pg, cfg, c, s, o),
    liftFinger: (rest) => liftFinger(pg, rest),
    drag: (from, to, o) => drag(pg, cfg, from, to, o),
    wheel: (x, y, o) => wheel(pg, cfg, x, y, o),
    hover: (x, y, o) => hover(pg, cfg, x, y, o),
    key: (spec, o) => key(pg, cfg, spec, o),
    pointerOut: () => pointerOut(pg, cfg),
    cpu: (r) => cpu(pg, r),
    network: (p) => network(pg, p),
    cacheDisabled: (on) => cacheDisabled(pg, on),
    // 落点被别的东西挡住（浮动 dock、吸底栏）时不盲点坐标：先滚到视口正中重算，仍挡住就抛错并报出挡它的元素（o.force 硬点）
    async tapSel(sel, o = {}) {
      let c = await center(pg, sel, o);
      if (!c.hitOk) c = await center(pg, sel, { ...o, block: 'center' });
      if (!c.hitOk && !o.force) throw new Error(`点不到 ${sel}${o.text ? '「' + o.text + '」' : ''}：落点被 ${c.hit || '（无）'} 挡住`);
      await tap(pg, cfg, c.x, c.y);
      return c;
    },
    async hoverSel(sel, o = {}) { const c = await center(pg, sel, o); await hover(pg, cfg, c.x, c.y, { steps: 4, ms: 80 }); return c; },
    async longPressSel(sel, o = {}) { const c = await center(pg, sel, o); await longPress(pg, cfg, c.x, c.y, o); return c; },
  };
  return g;
}
