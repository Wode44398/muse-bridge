// Claude 分页「吐字」引擎（Svelte action，挂在 Thread 的 .answer 上）。
//
// —— 旧版的问题（2026-07 复刻官网那版）——
// 官网是 opacity 0→1、0.4s linear 的渐入，写头约 20 个叶子 span 同时在淡入成一道「波」。bridge 照搬后
// 看着一顿一顿：数据每 ~100ms 一批（chat.svelte.js 节流 + 隧道抖动更大），一整批字同时出生、同时淡入，
// 于是是「一坨一坨」地冒；表格更糟——半截数据行一边打一边把整张表的列宽来回顶，已显示的列左右挪。
// 行尾一个词边打边长，长到放不下时整词「跳」到下一行。
//
// —— 新做法：先排版、后显形 ——
// 1) 到达的文本立刻按完整 markdown 排版进 DOM（末块先过 mdStream.repairTail 修补写头：表头一完整就成表、
//    数据行整行到齐才放、半截语法先扣住），但还没轮到的字是隐形的（.c-wait，opacity 0）——排版走在显形
//    前面两三百毫秒，换行、列宽在字显形之前就已定好，显形只是改透明度，不再引起任何位移。
// 2) 播放器按「可见字」逐帧推进显形边界，思路同音视频的抖动缓冲：一批字其实是在上一批到这一批之间
//    由模型逐个生成的，就把它们均匀铺回那段时间（重建生成时间线），再整体延后 L 播放——L 取最近到达
//    间隔的 85 分位（0.1–0.6s 自适应：网络稳就贴近实时，隧道抖就多缓一点）。于是显形速度跟模型真实的
//    生成节奏一样匀，不随批次「先冲后爬」。偶发的长停顿超出缓冲时，那一批压进 L 内播完（略快、不卡）；
//    积压最多 1s；收轮后剩余部分 0.35s 内吐完。单位是 DOM 里的可见字，URL、表格分隔行、围栏这些
//    不显示的 markdown 语法不占播放时间。
// 3) 每个字从显形那一刻起 0.4s 线性淡入（对齐官网时长），于是写头是一道连续的渐变、而不是一批批跳。
// 4) 盒子（表格单元格、列表项、代码卡、引用条、分隔线、图片、行内代码底色、公式）随它包住的第一个字
//    一起淡入；没轮到之前同样隐形——不会出现「格子 / 圆点 / 代码底色先到、字后到」。
//
// —— 跨全量重渲染不回跳 ——
// Thread 的 {@html} 每批把末块整棵子树换掉。显形边界、每段字的出生时刻都记在「可见字序号」上，不挂在
// DOM 节点上：每次 DOM 变化（MutationObserver，微任务里、在绘制之前）和每一帧都把活跃区（还在淡入或
// 隐形的那一截）拆包、重新按序号切 span 并直接写 opacity。前缀稳定由 repairTail 保证（单测里逐字扫描）。
//
// —— DOM 手术的禁区（头号坑，勿改）——
// 只拆自己插的 span、只 normalize 被拆 span 的父元素，【绝不】对 action 根节点 normalize：Svelte 5 的
// {#each} 与每个 {@html} 都拿挂在根这一层的空文本节点当插入锚点，normalize 会把它们删光，之后插入的
// 内容全进「空气」——长回答输出到一半断掉、切会话回来只剩工具行。根这一层的文本节点也绝不替换。
//
// live=false（历史消息）一律实体显示、零开销（不挂 MutationObserver）；同一段从流式转收尾时把剩下的
// 吐完再转静态。key 变了（Svelte 按下标复用 div 去显示别的段）立即重置。系统「减弱动态效果」直接实体。
//
// —— 给别的渲染器用（可选参数，Claude 分页一个都不传，行为不变）——
// boxes：额外按盒子处理的类名（自家代码卡的外壳之类，内置只认 md-codewrap）；chrome：界面零件的类名（代码卡
// 标题栏里的语言标、复制钮），子树里的字不计数、不逐字显形，随包住它的盒子一起出现。
// 顶层节点若是常驻的包裹层（{@html} 是它唯一的子节点 → 受控 innerHTML，内容原地整块换），按变更记录把它的
// 可见字数缓存作废——Svelte 整块替换顶层节点时这一步什么也不做。
// fx：换一种显形质感（agy 分页用）——{ dur 每字显形时长 ms, ease(p)→透明度, blur 起始虚化 px, blurEase(p)→虚化剩余比例 }。
// 不传就是 Claude 官网那套 0.4s 线性淡入，行为与以前逐字节相同。

const CLS = 'c-in';          // 自家 span（淡入中 / 隐形）
const WAIT = 'c-wait';       // 隐形（CSS: opacity 0）
const BOX = 'c-bx';          // 被托管透明度的盒子

const DUR = 400;             // 字的淡入时长（官网 0.4s）
const BOX_DUR = 280;         // 盒子的淡入时长
const INIT_MAX = 400;        // 挂载 / 换段时已有可见字超过这么多 → 直接实体（切回正在跑的会话、重连重放）
const SNAP = 1600;           // 积压超过这么多（后台切回、重放补发）→ 跳到只剩 SNAP_KEEP 个字待吐
const SNAP_KEEP = 240;
// 播放器（时间单位：秒）
const GAP_MAX = 0.6;         // 到达间隔超过这么久算停顿（工具 / 思考 / 网络卡），按这么长重建
const LAG_MIN = 0.1, LAG_MAX = 0.6;
const MAX_LAG = 1.0;         // 待播部分最多拖这么久，超了整体压缩
const DRAIN = 0.35;          // 收轮后剩余部分在这么久内吐完
const TAU_S = 0.04;          // 显形边界对目标的轻微低通（抹平段与段交界处的速度折角）
const MERGE_MS = 28;         // 同一时间片内显形的字并成一段（少建 span，肉眼无差别）

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const fadeOp = (age) => (age >= DUR ? 1 : age <= 0 ? 0 : age / DUR);
const boxOp = (age) => { const x = age >= BOX_DUR ? 1 : age <= 0 ? 0 : age / BOX_DUR; return 1 - (1 - x) * (1 - x); };

const BOX_TAGS = new Set(['LI', 'TH', 'TD', 'HR', 'IMG', 'INPUT', 'BLOCKQUOTE', 'KBD', 'MARK']);
const isKatex = (el) => el.classList.contains('katex') || el.classList.contains('katex-display');
function isBox(el) {
  const tag = el.tagName;
  if (BOX_TAGS.has(tag)) return true;
  if (tag === 'CODE') return !el.parentElement || el.parentElement.tagName !== 'PRE';   // 行内代码有底色
  return el.classList.contains('md-codewrap') || isKatex(el);
}

// 按文档序给可见文本编号。计数口径：<pre> 外的纯空白文本节点不算（marked 在块标签间留的结构性换行，
// 随正文增长会位移）；KaTeX 内部不算（<annotation> 藏着 LaTeX 源），公式整体当一个「空盒子」。
function walk(root, st) {
  for (let c = root.firstChild; c;) {
    const next = c.nextSibling;          // onText 可能把 c 换成碎片，先记下一个
    if (c.nodeType === 3) {
      const v = c.nodeValue;
      if (v && (st.pre || /\S/.test(v))) { if (st.onText) st.onText(c, st.i); st.i += v.length; }
    } else if (c.nodeType === 1) visit(c, st);
    c = next;
  }
}
function visit(el, st) {
  if (st.chrome && st.chrome(el)) return;
  if (isBox(el) || (st.box && st.box(el))) {
    const rec = { el, a: st.i, b: 0 };
    if (!isKatex(el)) descend(el, st);
    rec.b = st.i;
    if (st.boxes) st.boxes.push(rec);
  } else descend(el, st);
}
function descend(el, st) {
  const pre = st.pre;
  if (el.tagName === 'PRE') st.pre = true;
  walk(el, st);
  st.pre = pre;
}

// 切点别切开代理对、组合附加符、ZWJ 表情序列、变体选择符、肤色修饰——否则淡入途中字形会拆开再合上。
function safeCut(v, o) {
  while (o > 0 && o < v.length) {
    const c = v.charCodeAt(o), p = v.charCodeAt(o - 1);
    if ((c >= 0xdc00 && c <= 0xdfff) || (c >= 0x0300 && c <= 0x036f) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f) || c === 0x20e3 || p === 0x200d) { o++; continue; }
    if (c === 0xd83c) { const d = v.charCodeAt(o + 1); if (d >= 0xdffb && d <= 0xdfff) { o += 2; continue; } }
    break;
  }
  return o;
}

const classTest = (list) => (Array.isArray(list) && list.length ? (el) => list.some((c) => el.classList.contains(c)) : null);

export function claudeFade(node, opts = {}) {
  let key, live = false, mode = 'static';
  // 可选：额外的盒子类名 / 界面零件类名（见文件头）。只在挂载时读一次——可见字数按节点缓存，口径不能中途变。
  const xbox = classTest(opts && opts.boxes), chrome = classTest(opts && opts.chrome);
  const fx = (opts && opts.fx) || null;
  const dur = (fx && fx.dur) || DUR;
  const opOf = fx && fx.ease
    ? (age) => (age >= dur ? 1 : age <= 0 ? 0 : fx.ease(age / dur))
    : fadeOp;
  const blur0 = (fx && fx.blur) || 0;
  const blurOf = (age) => {
    if (!blur0 || age >= dur) return 0;
    const p = age <= 0 ? 0 : age / dur;
    return blur0 * (fx.blurEase ? fx.blurEase(p) : 1 - p);
  };
  let Rf = 0, shown = 0, solid = 0;     // 显形边界（浮点 / 整数）；solid 之前全实体
  let marks = [];                       // 淡入中的段 [{a,b,t}]（可见字序号区间 + 显形时刻）
  let plan = [], planBase = 0;          // 待播段 [{a,b,t0,t1}]：可见字 [a,b) 在 t0..t1 内匀速显形；planBase = 已播完的边界
  let gaps = [], lastArr = 0, lastT = 0, lastTotal = 0;
  let raf = 0, touched = new Set();
  const lens = new WeakMap();           // 顶层节点 → 可见字数（Svelte 只整块替换顶层节点，按节点缓存即可）
  const mo = typeof MutationObserver === 'function' ? new MutationObserver((recs) => { stale(recs); run(); }) : null;

  // 变更落在某个顶层节点内部（常驻包裹层的内容被整块换掉）：它的可见字数缓存作废。
  function stale(recs) {
    for (const r of recs) {
      let n = r.target;
      if (n === node) continue;
      while (n && n.parentNode !== node) n = n.parentNode;
      if (n) lens.delete(n);
    }
  }

  function lenOf(n) {
    if (n.nodeType === 3) { const t = n.nodeValue; return t && /\S/.test(t) ? t.length : 0; }
    let L = lens.get(n);
    if (L === undefined) {
      if (isKatex(n)) L = 0;
      else if (chrome && chrome(n)) L = 0;
      else { const st = { i: 0, pre: false, chrome }; descend(n, st); L = st.i; }
      lens.set(n, L);
    }
    return L;
  }
  function tops() {
    const out = [];
    let total = 0;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1 && c.nodeType !== 3) continue;
      const L = lenOf(c);
      if (c.nodeType === 3 && !L) continue;
      out.push({ n: c, a: total, b: total + L });
      total += L;
    }
    return { list: out, total };
  }

  // 把某个顶层节点里自家的 span 拆回纯文本、盒子摘掉托管。只 normalize 被拆 span 的父元素（见文件头禁区）。
  function clean(top) {
    if (top.nodeType !== 1) return;
    const spans = top.querySelectorAll('span.' + CLS);
    if (spans.length) {
      const parents = new Set();
      for (const s of spans) {
        const p = s.parentNode;
        if (!p) continue;
        p.replaceChild(document.createTextNode(s.textContent), s);
        parents.add(p);
      }
      for (const p of parents) if (p !== node && p.isConnected) p.normalize();
    }
    for (const el of top.querySelectorAll('.' + BOX)) unbox(el);
    if (top.classList.contains(BOX)) unbox(top);
  }
  function unbox(el) { el.classList.remove(BOX, WAIT); el.style.opacity = ''; }
  function cleanAll() { for (const t of touched) if (t.isConnected) clean(t); touched = new Set(); }

  // —— 播放器：重建生成时间线 + 延后 L 播放 ——
  function lag() {
    if (!gaps.length) return 0.12;
    const g = [...gaps].sort((x, y) => x - y);
    return Math.min(LAG_MAX, Math.max(LAG_MIN, g[Math.min(g.length - 1, Math.floor(g.length * 0.85))] * 1.1 + 0.02));
  }
  // 把 t 之后的待播时间整体线性压到 until 前播完（t 时刻的进度不变，曲线连续）。
  function squeeze(t, until) {
    const end = plan.length ? plan[plan.length - 1].t1 : t;
    if (end <= until) return;
    const k = (until - t) / (end - t);
    for (const p of plan) { p.t0 = p.t0 > t ? t + (p.t0 - t) * k : p.t0; p.t1 = t + (p.t1 - t) * k; }
  }
  function arrive(t, from, to) {
    const first = !lastArr;
    const raw = first ? 0.1 : t - lastArr;
    if (!first && raw < GAP_MAX) { gaps.push(raw); if (gaps.length > 24) gaps.shift(); }   // 长停顿不撑大缓冲
    const gap = Math.min(GAP_MAX, raw);
    lastArr = t;
    const prevEnd = plan.length ? plan[plan.length - 1].t1 : 0;
    let t1 = t + lag();
    const t0 = Math.max(t1 - gap, prevEnd, t);
    if (t1 < t0 + 0.02) t1 = t0 + Math.min(gap, 0.02 + (to - from) / 800);   // 前面排满了：接在后面按原节奏
    plan.push({ a: from, b: to, t0, t1 });
    squeeze(t, t + (live ? MAX_LAG : DRAIN));
  }
  function target(t) {
    while (plan.length && t >= plan[0].t1) { planBase = plan[0].b; plan.shift(); }
    const p = plan[0];
    if (!p || t <= p.t0) return planBase;
    return p.a + (p.b - p.a) * (t - p.t0) / (p.t1 - p.t0);
  }

  function pace(ms, total) {
    const t = ms / 1000;
    const dt = Math.min(0.1, Math.max(0, t - lastT));
    lastT = t;
    if (total > lastTotal) {
      if (total - Rf > SNAP) {                           // 积压过多：大半直接一起淡入，只留一小截逐字
        const to = total - SNAP_KEEP;
        marks.push({ a: shown, b: to, t: ms });
        Rf = shown = planBase = to; plan = [];
        arrive(t, to, total);
      } else arrive(t, lastTotal, total);
    } else if (total < lastTotal) {                      // 内容变短（撤回 / 重放）：边界、待播段、淡入段一并收回
      Rf = Math.min(Rf, total); shown = Math.min(shown, total); solid = Math.min(solid, total);
      planBase = Math.min(planBase, total);
      plan = plan.filter((p) => p.a < total).map((p) => (p.b > total ? { ...p, b: total } : p));
      marks = marks.filter((m) => m.a < total).map((m) => (m.b > total ? { ...m, b: total } : m));
    }
    lastTotal = total;
    if (!live) squeeze(t, t + DRAIN);
    const goal = Math.min(total, target(t));
    if (goal > Rf) Rf = goal - Rf < 0.5 ? goal : Rf + (goal - Rf) * (1 - Math.exp(-dt / TAU_S));
    if (!plan.length && Rf < total) Rf = total;          // 计划播完了（低通的尾巴）：收齐
    const R = Math.floor(Rf + 1e-6);
    if (R > shown) {
      const last = marks[marks.length - 1];
      if (last && last.b === shown && ms - last.t < MERGE_MS) last.b = R;
      else marks.push({ a: shown, b: R, t: ms });
      shown = R;
    }
    while (marks.length && ms - marks[0].t >= dur) { solid = marks[0].b; marks.shift(); }
    if (!marks.length) solid = shown;
  }

  // 某可见字（p）的显形时刻；-1 = 早已实体；Infinity = 还没轮到。
  function bornChar(p) {
    if (p >= shown) return Infinity;
    for (const m of marks) if (p >= m.a && p < m.b) return m.t;
    return -1;
  }
  // 空盒子（分隔线 / 图片 / 公式 / 空单元格）在序号 p 处：显形边界到达 p 即出现。
  function bornAt(p) {
    if (p > shown) return Infinity;
    for (const m of marks) if (p > m.a && p <= m.b) return m.t;
    if (p === 0 && marks.length && marks[0].a === 0) return marks[0].t;
    return -1;
  }

  // —— 一帧：量 → 推进 → 只重绘活跃区 ——
  function frame(t) {
    const { list, total } = tops();
    pace(t, total);
    let busy = shown < total || marks.length > 0;
    const next = new Set();
    for (const { n, a, b } of list) {
      if (n.nodeType !== 1) continue;                     // 根这一层的文本节点不碰（Svelte 锚点同层）
      const empty = b === a;
      const active = b > solid || (empty && a >= solid);
      if (!active) continue;
      next.add(n);
      if (touched.has(n)) clean(n);
      const st = { i: a, pre: false, boxes: [], box: xbox, chrome, onText: (tn, i0) => paintText(tn, i0, t) };
      visit(n, st);
      for (const r of st.boxes) {
        const born = r.b === r.a ? bornAt(r.a) : bornChar(r.a);
        if (born === Infinity) { r.el.classList.add(BOX, WAIT); continue; }
        if (born < 0) continue;
        const age = t - born;
        if (age < BOX_DUR) { r.el.classList.add(BOX); r.el.style.opacity = String(boxOp(age)); busy = true; }
      }
    }
    for (const n of touched) if (!next.has(n) && n.isConnected) clean(n);   // 刚转实体的顶层节点：拆包还原
    touched = next;
    return busy;
  }

  // 把一个文本节点按 [solid | 各淡入段 | 隐形] 切开重建。
  function paintText(tn, i0, t) {
    const val = tn.nodeValue, i1 = i0 + val.length;
    if (i1 <= solid) return;
    const cuts = [];
    for (const m of marks) {
      const x = Math.max(i0, m.a), y = Math.min(i1, m.b);
      if (y > x) cuts.push({ x, y, op: opOf(t - m.t), bl: blurOf(t - m.t) });
    }
    if (shown < i1) cuts.push({ x: Math.max(i0, shown), y: i1, wait: true });
    if (!cuts.length) return;
    const parent = tn.parentNode;
    if (!parent || parent === node) return;
    const frag = document.createDocumentFragment();
    let cur = 0;
    for (const c of cuts) {
      let x = safeCut(val, c.x - i0);
      const y = safeCut(val, c.y - i0);
      if (x < cur) x = cur;
      if (y <= x) continue;
      if (x > cur) frag.appendChild(document.createTextNode(val.slice(cur, x)));
      const sp = document.createElement('span');
      sp.className = c.wait ? CLS + ' ' + WAIT : CLS;
      if (!c.wait) {
        sp.style.opacity = c.op.toFixed(3);
        if (c.bl > 0.05) sp.style.filter = 'blur(' + c.bl.toFixed(2) + 'px)';
      }
      sp.textContent = val.slice(x, y);
      frag.appendChild(sp);
      cur = y;
    }
    if (cur < val.length) frag.appendChild(document.createTextNode(val.slice(cur)));
    parent.replaceChild(frag, tn);
  }

  function run() {
    if (mode === 'static') return;
    if (mo) stale(mo.takeRecords());                     // 同步调用（update）时还没投递的变更先认领，免得按旧缓存量
    if (!live && typeof document !== 'undefined' && document.hidden) { toStatic(); return; }   // 后台没人看：收尾不必等 rAF（后台根本不跑）
    let busy = false;
    try { busy = frame(now()); }
    catch (e) { console.warn('[claudeFade]', e); toStatic(); return; }   // 出任何岔子都退回实体，字绝不能卡在隐形
    if (mo) mo.takeRecords();                            // 自己的 DOM 手术不再回调自己
    if (busy) { if (!raf) raf = requestAnimationFrame(loop); }
    else if (!live) toStatic();
  }
  function loop() { raf = 0; run(); }

  function toStatic() {
    mode = 'static';
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (mo) mo.disconnect();
    cleanAll();
    marks = []; plan = [];
    const total = tops().total;
    Rf = shown = solid = lastTotal = planBase = total;
  }

  function reset(o) {
    toStatic();
    key = o.key; live = !!o.live;
    if (!live || reduceMotion() || !mo) return;
    const total = lastTotal;
    const anim = total <= INIT_MAX;
    Rf = shown = solid = anim ? 0 : total;
    lastTotal = Rf;                                      // 从 0 起算时首批内容也算一次「到达」
    plan = []; planBase = Rf; gaps = []; lastArr = 0; lastT = now() / 1000;
    mode = 'live';
    mo.observe(node, { childList: true, subtree: true, characterData: true });
    run();                                               // 同步隐藏首批内容：action 在绘制前执行
  }

  reset(opts || {});

  return {
    update(o) {
      o = o || {};
      if (o.key !== key) { reset(o); return; }
      const was = live;
      live = !!o.live;
      if (live === was) return;
      if (live && mode === 'static') {                   // 同一段又活了（续跑）：从当前全长接着吐
        if (reduceMotion() || !mo) return;
        mode = 'live'; lastT = now() / 1000; plan = []; planBase = Rf; gaps = []; lastArr = 0;
        mo.observe(node, { childList: true, subtree: true, characterData: true });
      }
      run();                                             // live→false：剩余部分按 DRAIN 吐完再转静态
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (mo) mo.disconnect();
    },
  };
}
