// 应用内对话框的状态与纯逻辑（uiAlert / uiConfirm 的数据层，界面是 components/DialogHost.svelte）。
//
// 为什么单独成文件、且不 import 任何东西：dialogs.js 依赖 i18n / nativeDesktop / svelte mount，
// 测试没法在 node 里直接拉起；把「队列、合并、默认焦点、截断、出队」这些纯逻辑放在这里，
// 测试用 svelte/compiler 单独编译本文件就能跑（见 dialogs.test.js）。
//
// 数据流：dialogs.js 调 request() 入队 → DialogHost 渲染 activeRequest() → 用户点按钮 / 按键 /
// 点遮罩 / 系统返回 → settle(id, role) 标记 closing 并 resolve → 退场动画播完后出队。
// 一次只显示一个（FIFO）；连续相同的 alert 合并成「×n」（Composer 选了一批超限文件时会连发同一句）。

// 截断上限与桌面壳 messageBox 一致（client/desktop/main.cjs：message 2000、detail 4000、按钮 40），
// 换成应用内弹窗后不改变「超长文案会被截」的既有行为；标题是新加的小标题，给 200 足够。
export const MSG_MAX = 2000;
export const DETAIL_MAX = 4000;
export const TITLE_MAX = 200;
export const LABEL_MAX = 40;
// 排队上限：正常不会超过个位数；真有代码在循环里狂弹（且每句都不一样、合并不了）时，
// 超出的直接按「取消」返回，免得用户要点几百下才能回到界面。
export const QUEUE_MAX = 50;
// 退场时长：与 app.css 的 .ov-panel.closing（--mo-quick 200ms）对齐，多留 20ms 让最后一帧画完再卸载。
export const EXIT_MS = 220;

const TYPES = ['info', 'error', 'warning', 'question'];

// queue 里既有正在显示的、也有正在退场的（closing=true）和排队等待的；渲染侧只取前两种。
export const dlg = $state({ queue: [] });

// 宿主登记（非响应式，只给 dialogs.js 判断「有没有人在画」用）：
//   ready  有一个 DialogHost 已挂载并认领；dialogs.js 据此决定要不要自挂载 / 走兜底
//   owner  认领者标记，第二个 DialogHost 实例（比如 App 也挂了一份）发现已有主人就不渲染，避免叠两层
export const host = { ready: false, owner: null };
// 键盘处理由 DialogHost 注入（它知道当前焦点在哪个按钮上）；dialogs.js 的全局捕获监听只负责转交。
export const hooks = { key: null };

let seq = 0;
// id → [resolve, …]：合并进同一条的多次调用各自有 Promise，结算时一起 resolve。放在响应式状态外面——
// 函数进 $state 会被代理，也没必要触发渲染。
const waiters = new Map();
// 弹窗打开前的焦点，全部弹窗结束后还回去（键盘用户按完 Enter 还停在原来的按钮上）。
let restoreTo = null;

/** 转成字符串并截断到 max 个 UTF-16 单元以内（含末尾省略号）；不把代理对劈成半个字。 */
export function clip(v, max) {
  let s;
  try { s = v == null ? '' : String(v); } catch { s = ''; }
  if (!(max >= 1) || s.length <= max) return s;
  let cut = max - 1;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;   // 截点前一位是高代理 → 连它一起丢，免得渲染成 �
  return s.slice(0, cut) + '…';
}

/**
 * 把调用参数规整成一条请求。opts 里任何字段缺省、为 null、类型不对都按默认处理，调用方不必自己兜。
 * danger 缺省取 type==='warning'（旧调用里 warning 基本都是删除 / 放弃修改这类不可逆操作）；
 * 它只影响 confirm（确认钮变红、默认焦点落到取消上），alert 只有一个按钮，不染红。
 */
export function makeRequest(kind, message, opts, defaults) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const d = defaults && typeof defaults === 'object' ? defaults : {};
  const k = kind === 'confirm' ? 'confirm' : 'alert';
  const type = TYPES.includes(o.type) ? o.type : (k === 'confirm' ? 'question' : 'info');
  const label = (v, fb) => clip(v, LABEL_MAX).trim() || clip(fb, LABEL_MAX).trim();
  return {
    id: ++seq,
    kind: k,
    type,
    danger: o.danger == null ? type === 'warning' : !!o.danger,
    title: clip(o.title, TITLE_MAX).trim(),
    message: clip(message, MSG_MAX),
    detail: clip(o.detail, DETAIL_MAX),
    okLabel: label(o.okLabel, d.ok || 'OK'),
    cancelLabel: label(o.cancelLabel, d.cancel || 'Cancel'),
    count: 1,
    closing: false,
  };
}

/** b 能不能并进 a（a 是队尾那条）：都是 alert、文案按钮完全一致、a 还没在退场。 */
export function canMerge(a, b) {
  return !!a && !!b && a.kind === 'alert' && b.kind === 'alert' && !a.closing
    && a.type === b.type && a.title === b.title && a.message === b.message
    && a.detail === b.detail && a.okLabel === b.okLabel;
}

/**
 * 入队。只和队尾比较能否合并——隔着别的弹窗的同句提示不并，保持用户看到的先后顺序。
 * 返回 { status: 'merged'|'queued'|'full', target }，target 是最终承载这次调用的那条（合并时是队尾旧条）。
 */
export function enqueue(queue, req, max = QUEUE_MAX) {
  const last = queue[queue.length - 1];
  if (canMerge(last, req)) { last.count += 1; return { status: 'merged', target: last }; }
  let live = 0;
  for (const r of queue) if (!r.closing) live += 1;
  if (live >= max) return { status: 'full', target: null };
  queue.push(req);
  return { status: 'queued', target: req };
}

/** 当前该显示的那条：队列里第一个没在退场的。 */
export function activeRequest(queue = dlg.queue) {
  for (const r of queue) if (!r.closing) return r;
  return null;
}

/** 默认焦点 / 回车落在哪个按钮：危险确认给「取消」（防手快一路回车删掉东西），其余给确认钮。 */
export function defaultRole(req) {
  return req && req.kind === 'confirm' && req.danger ? 'cancel' : 'ok';
}

/** Esc、点遮罩、系统返回算哪个按钮：confirm 算取消；alert 只有一个按钮，视同确定。 */
export function escRole(req) {
  return req && req.kind === 'confirm' ? 'cancel' : 'ok';
}

/** 按钮角色 → Promise 的值：confirm 返回布尔，alert 返回 undefined（与旧实现一致）。 */
export function valueOf(req, role) {
  return req && req.kind === 'confirm' ? role === 'ok' : undefined;
}

/** Tab / 方向键在 len 个按钮间循环；idx<0（焦点不在任何按钮上）时正向落第一个、反向落最后一个。 */
export function cycleIndex(len, idx, dir) {
  if (!(len > 0)) return -1;
  const step = dir < 0 ? -1 : 1;
  if (!(idx >= 0 && idx < len)) return step > 0 ? 0 : len - 1;
  return (idx + step + len) % len;
}

// —— 指针防误触：出现后的时间窗 + 连击 ——
// 原来的系统框是模态的，会挡住「打开它的那次双击」的第二下；应用内弹窗是同步画出来的，第二下会直接落在
// 新画的遮罩 / 按钮上——确认框当场按取消返回、提示框一闪就没，连点「确定」还会把排队的下一条也点掉。
// 弹窗（或排队的下一条）画出来之后这么久之内的按下一律不算：盖得住一次双击的间隔与触屏补发的兼容事件，
// 又远短于人读完一句话再去点的时间。
export const SHOW_GUARD_MS = 350;

/**
 * 事件发生的时刻，performance.now() 口径。现代内核的 e.timeStamp 就是这个口径，而且是按下真正发生的时刻
 * （主线程卡住时比处理函数里现读更早——弹窗出现之前就按下、事件晚到的，照样算在时间窗里）；
 * 个别老内核给的是纪元毫秒或 0，认不出就用 now。
 */
export function eventTime(e, now) {
  const ts = e && typeof e.timeStamp === 'number' ? e.timeStamp : NaN;
  return ts > 0 && ts <= now + 1000 ? ts : now;
}

/** 这一下按下是否落在弹窗出现后的时间窗里（出现之前就按下的也算）。还没记过出现时刻（-Infinity）时不挡。 */
export function pressTooSoon(at, shownAt, ms = SHOW_GUARD_MS) {
  return Number.isFinite(shownAt) && at - shownAt < ms;
}

/**
 * 弹窗里的一次 click 该不该吞掉：双击 / 连击的第二下起（detail > 1，挡住比时间窗更慢的双击；
 * pointerdown 的 detail 恒为 0，所以这个判断只能放在 click 上），或者它对应的按下已经被时间窗挡掉了。
 * 键盘（空格 / 回车）与程序触发的 click detail 为 0，照常放行。
 */
export function strayClick(detail, pressSwallowed) {
  const d = Number(detail) || 0;
  return d > 1 || (!!pressSwallowed && d > 0);
}

// —— 只有 message、没有 detail 时的排版 ——
// 不少老调用点把问句和后果说明写成一整段（「删除「a」？已经跑出来的会话会保留。」），整段 15/600 粗体既重又没分级。
// 显示时在第一处句末拆开：前半句照旧是粗体问句，后半段用说明的字号与次要色——和调用方自己拆 message / detail
// 的排版一致。拆不开的长句（一整句写了两行多）整段降到中等字重，免得几行粗体压过来。系统框兜底路径不受影响。
const CJK_END = '。？！';
const ASCII_END = '.?!';
const CLOSERS = '」』）)】》〉"”’\'';
// 约两行：宽 400 的卡片正文区一行约 24 个汉字 / 48 个西文字符（汉字记 2）
export const LONG_UNITS = 96;

/** 粗略的版面宽度：全角字符（CJK、全角标点）记 2，其余记 1。 */
export function textUnits(s) {
  let n = 0;
  for (const ch of String(s ?? '')) n += ch.codePointAt(0) >= 0x2e80 ? 2 : 1;
  return n;
}

const letters = (s) => (s.match(/\p{L}/gu) || []).length;

/** 第一处可拆的位置（前半句的结尾下标）；拆不开返回 -1。 */
function leadEnd(m) {
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    let end;
    if (c === '\n') end = i;
    else if (CJK_END.includes(c) || ASCII_END.includes(c)) {
      end = i + 1;
      while (end < m.length && CLOSERS.includes(m[end])) end++;   // 句末之后的收尾引号 / 括号归前半句
      // 西文句点 / 问号后面要跟空白才算句末（3.5、a.com/?x=1、v1.2 都不是）
      if (ASCII_END.includes(c) && end < m.length && !/\s/.test(m[end])) continue;
    } else continue;
    if (!m.slice(end).trim()) return -1;   // 后面没东西了：就是一整句
    // 太短的「前半句」不是句子：序号「1.」、缩写「e.g.」
    if (letters(m.slice(0, end)) < (ASCII_END.includes(c) ? 3 : 2)) continue;
    return end;
  }
  return -1;
}

/**
 * 正文怎么排：{ lead 粗体那句, rest 拆下来的说明（只在没有 detail 时才拆）, long 前半句太长、改用中等字重 }。
 * 调用方已经给了 detail 的不再拆——它自己分过级了。
 */
export function msgLayout(message, detail) {
  const m = String(message ?? '');
  let lead = m, rest = '';
  if (!detail) {
    const cut = leadEnd(m);
    if (cut > 0) {
      lead = m.slice(0, cut).trimEnd();
      rest = m.slice(cut).replace(/^\s+/, '');
    }
  }
  return { lead, rest, long: textUnits(lead) > LONG_UNITS };
}

function activeEl() {
  try { return typeof document !== 'undefined' ? document.activeElement : null; } catch { return null; }
}
const inHost = (el) => !!(el && typeof el.closest === 'function' && el.closest('[data-dialog-host]'));

function restoreFocus() {
  const el = restoreTo;
  restoreTo = null;
  if (!el || typeof el.focus !== 'function' || el.isConnected === false) return;
  // 只在焦点还留在弹窗里（或已经掉到 body）时才还回去；调用方在 then 里自己挪了焦点就别抢
  const now = activeEl();
  const doc = typeof document !== 'undefined' ? document : null;
  if (now && doc && now !== doc.body && now !== doc.documentElement && !inHost(now)) return;
  try { el.focus({ preventScroll: true }); } catch {}
}

function reducedMotion() {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** 入队并返回 Promise：alert → undefined，confirm → boolean。 */
export function request(kind, message, opts, defaults) {
  const req = makeRequest(kind, message, opts, defaults);
  return new Promise((resolve) => {
    const wasIdle = !activeRequest(dlg.queue);
    const r = enqueue(dlg.queue, req);
    if (r.status === 'full') {
      try { console.warn('[dialogs] 弹窗排队超过上限，已按取消处理：', req.message.slice(0, 80)); } catch {}
      resolve(valueOf(req, 'cancel'));
      return;
    }
    if (wasIdle && r.status === 'queued') {
      const el = activeEl();
      if (!inHost(el)) restoreTo = el;
    }
    const id = r.target.id;
    const list = waiters.get(id);
    if (list) list.push(resolve); else waiters.set(id, [resolve]);
  });
}

/**
 * 结算一条：标记退场、resolve 它名下所有调用，动画播完出队。返回是否真的结算了（重复点击 / 已结算返回 false）。
 * instant：立刻出队（兜底路径、测试、减弱动效时用）。
 */
export function settle(id, role, { instant = false } = {}) {
  const req = dlg.queue.find((r) => r.id === id);
  if (!req || req.closing) return false;
  req.closing = true;
  const v = valueOf(req, role);
  const list = waiters.get(id) || [];
  waiters.delete(id);
  // 后面没有排队的了才还焦点；还有下一条时焦点交给下一条的默认按钮
  if (!activeRequest(dlg.queue)) restoreFocus();
  const drop = () => {
    const i = dlg.queue.findIndex((r) => r.id === id);
    if (i >= 0) dlg.queue.splice(i, 1);
  };
  if (instant || reducedMotion()) drop(); else setTimeout(drop, EXIT_MS);
  for (const fn of list) { try { fn(v); } catch {} }
  return true;
}

/** 有没有调用在等结果（dialogs.js 兜底路径用：宿主起不来时把排着的逐个交给系统弹窗）。 */
export function pendingCount() {
  let n = 0;
  for (const r of dlg.queue) if (!r.closing) n += 1;
  return n;
}
