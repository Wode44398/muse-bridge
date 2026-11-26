// Codex 输入栏的纯逻辑（不碰 DOM / Svelte / 文案，有单测）：发送键的样子、按键的意思、斜杠命令过滤、
// 审批选项、提问作答的拼装、排队拖动的落点、吉祥物的帧表。

/* ---------------- 发送键 ----------------
 * 「让位」：空着又没在跑时这一格不存在（none）；有字 = ready；跑着 = busy；跑着又打了字 = steer（回车插话）。 */
export function sendState({ draft = false, busy = false } = {}) {
  if (busy) return draft ? 'steer' : 'busy';
  return draft ? 'ready' : 'none';
}

/**
 * 输入框里按下一个键是什么意思。返回：
 *   'plan'（Shift+Tab 切计划模式）| 'send' | 'steer' | 'queue' | null（交给浏览器：换行、输入法上屏……）
 * touch = 触屏软键盘：回车是换行，发送靠键（外接键盘的 Ctrl+回车照样认）。
 */
export function keyAction(e, { busy = false, draft = false, touch = false } = {}) {
  if (!e) return null;
  if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return 'plan';
  if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.altKey) return null;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod && touch) return null;
  if (!draft) return mod || !touch ? 'noop' : null;
  if (busy) return mod ? 'queue' : 'steer';
  return 'send';
}

/** 输入框占位字用哪一句（文案在组件里）。 */
export function placeholderKind({ home = true, plan = false, busy = false, touch = false } = {}) {
  if (busy) return touch ? 'busyTouch' : 'busy';
  if (plan) return 'plan';
  return home ? 'home' : 'thread';
}

/* ---------------- 斜杠命令 ---------------- */

// needThread：要有一条真线程才能做（首页还没有线程 id）
export const SLASH = [
  { cmd: '/review', needThread: true },
  { cmd: '/compact', needThread: true },
  { cmd: '/plan' },
  { cmd: '/model' },
  { cmd: '/status' },
  { cmd: '/fork', needThread: true },
  { cmd: '/new', needThread: true },
];

/**
 * 输入框里是不是在打斜杠命令：只认整段就是「/xxx」（不带空格）。
 * names：cmd -> 该命令的中文名（按名字也能搜到）。返回能用的命令列表；不是斜杠命令返回 null。
 */
export function slashMatches(text, { inThread = false, names = {} } = {}) {
  const v = String(text ?? '');
  if (!/^\/\S*$/.test(v)) return null;
  const q = v.slice(1).toLowerCase();
  return SLASH.filter((s) => (inThread || !s.needThread) && (s.cmd.slice(1).startsWith(q) || (q && String(names[s.cmd] || '').toLowerCase().includes(q))));
}

/** 「!命令」= 在线程的项目里直接跑一条 shell 命令（管理员）。不是返回 null。 */
export function bangCommand(text) {
  const m = /^!\s*([\s\S]*\S)\s*$/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/* ---------------- 审批 ---------------- */

/** 工作目录写成项目内的相对路径（不在项目里就原样）。 */
export function relPath(cwd, root) {
  const c = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const r = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!c) return '';
  if (!r) return c;
  const ci = c.toLowerCase(), ri = r.toLowerCase();
  if (ci === ri) return '.';
  if (ci.startsWith(ri + '/')) return c.slice(r.length + 1);
  return c;
}

/** 审批面板的几个选项（顺序即数字键 1、2、3……）。 */
export function permOptions(ask, { admin = false } = {}) {
  const out = [{ key: 'once' }];
  if (ask?.canAlways) out.push({ key: 'always' });
  if (admin && ask?.codex?.canRule && ask?.preview?.kind === 'command') out.push({ key: 'rule' });
  out.push({ key: 'deny' });
  return out;
}

/** 按前缀规则允许时那段前缀（Codex 给的 proposedRule 可能是词组数组）。 */
export function ruleText(ask) {
  const r = ask?.codex?.proposedRule ?? ask?.codex?.proposedExecpolicyAmendment ?? null;
  if (Array.isArray(r)) return r.join(' ');
  return r ? String(r) : '';
}

/** 一段 unified diff 拆成行，标上增 / 删 / 段头（审批里的改动预览用）。 */
export function diffLines(diff, max = 400) {
  const lines = String(diff || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const l of lines) {
    if (out.length >= max) break;
    if (/^(diff --git|index |--- |\+\+\+ )/.test(l)) continue;
    const k = l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx';
    out.push({ k, text: l });
  }
  while (out.length && out[out.length - 1].k === 'ctx' && !out[out.length - 1].text) out.pop();
  return { lines: out, cut: lines.length > max };
}

/* ---------------- 提问 ---------------- */

/** 一个问题的作答：选中的标签（按选项顺序）+ 自己写的。没答返回 null。 */
export function questionAnswer(q, picked = [], custom = '') {
  const labels = (q?.options || []).map((o) => o.label);
  const selected = labels.filter((l) => picked.includes(l));
  const c = String(custom || '').trim();
  if (!selected.length && !c) return null;
  return c ? { selected, custom: c } : { selected };
}

/** 所有问题都答了才拼成作答载荷；否则 null。 */
export function questionPayload(answers, n) {
  if (!Array.isArray(answers) || answers.length < n) return null;
  for (let i = 0; i < n; i++) if (!answers[i]) return null;
  return { answers: answers.slice(0, n) };
}

/* ---------------- 排队拖动 ---------------- */

/** 拖着的那张卡（from）的中线现在在 y：它该落到第几位。mids = 各卡当前中线（不含拖动位移）。 */
export function dropIndex(mids, from, y) {
  // 落点 = 其余卡里中线在它上面的有几张
  let n = 0;
  for (let i = 0; i < mids.length; i++) if (i !== from && mids[i] < y) n++;
  return n;
}

export function moveItem(list, from, to) {
  const a = [...list];
  if (from < 0 || from >= a.length || to < 0 || to >= a.length || from === to) return a;
  const [x] = a.splice(from, 1);
  a.splice(to, 0, x);
  return a;
}

/* ---------------- 附件 ---------------- */

export function fmtSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

/* ---------------- 吉祥物（官方精灵图的帧表：8 列 × 11 行） ---------------- */

export const PET = {
  idle: { row: 0, d: [280, 110, 110, 140, 140, 320].map((x) => x * 6) },
  'running-right': { row: 1, n: 8, a: 120, b: 220 },
  'running-left': { row: 2, n: 8, a: 120, b: 220 },
  waving: { row: 3, n: 4, a: 140, b: 280 },
  jumping: { row: 4, n: 5, a: 140, b: 280 },
  failed: { row: 5, n: 8, a: 140, b: 240 },
  waiting: { row: 6, n: 6, a: 150, b: 260 },
  running: { row: 7, n: 6, a: 120, b: 220 },
  review: { row: 8, n: 6, a: 150, b: 280 },
};

/** 一段动作的帧序列：循环的就它自己；一次性的演三遍再落回待机（loopAt = 之后从哪一帧开始循环）。 */
export function petFrames(name, loop) {
  const s = PET[name] || PET.idle;
  const idle = PET.idle.d.map((d, c) => ({ r: 0, c, d }));
  if (s === PET.idle) return { frames: idle, loopAt: 0 };
  const one = Array.from({ length: s.n }, (_, c) => ({ r: s.row, c, d: c === s.n - 1 ? s.b : s.a }));
  if (loop) return { frames: one, loopAt: 0 };
  const rep = [...one, ...one, ...one];
  return { frames: [...rep, ...idle], loopAt: rep.length };
}

export const petPos = (f) => `${(f.c / 7) * 100}% ${(f.r / 10) * 100}%`;

/** 官方「看你」的 16 个方向（第 10、11 行）：按指针相对吉祥物中心的角度选；太近或太远不看。 */
export function petLook(dx, dy) {
  const dist = Math.hypot(dx, dy);
  if (dist < 8 || dist > 260) return null;
  const a = Math.round((((180 / Math.PI) * Math.atan2(dx, -dy) + 360) % 360) / 22.5) % 16;
  return { r: 9 + Math.floor(a / 8), c: a % 8, d: 0 };
}

/** 线程状态 → 吉祥物该演哪段：等你决定时抬头、干活时敲电脑，其余待机（跑完 / 出错那一下由调用方另演）。 */
export function petMood({ ask = false, busy = false } = {}) {
  if (ask) return { name: 'waiting', loop: true };
  if (busy) return { name: 'running', loop: true };
  return { name: 'idle', loop: false };
}
