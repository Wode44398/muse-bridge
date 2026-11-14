// 终端的触屏手势层（Svelte action）：一块透明层盖在 xterm 上，手指的事全归它管。
//
// 为什么要盖一层：xterm 自己的触摸处理有两个毛病——①手指一碰就聚焦它的隐藏输入框，安卓上
// 键盘立刻弹出来（维护者反馈「点哪都弹键盘」），想往上翻翻输出都不行；②滚动没有惯性，长输出
// 要一下一下地搓。这一层 touchstart 就 preventDefault：不派生鼠标事件、焦点不动（输入行开着
// 键盘就继续开着，没开就不会开），也不让 sheet 把下拉当成收起（宿主挂 data-sheet-nodrag）。
//
// 单指滚动不直接改 scrollTop，而是给 xterm 派发合成 wheel 事件、按行量化：普通屏 xterm 滚
// 回滚缓冲；vim / less 这类备用屏没有回滚，xterm 自己换成 ↑/↓ 键发给程序；程序开了鼠标上报
// 就发滚轮报告——三种情形由 xterm 分流，这里不用分。松手按手速带惯性（备用屏不带：那是在按键）。
// 双指 = 缩放字号（过程中只做 CSS 缩放，松手才真改字号，免得每一帧都重排、给 PTY 发 resize）。
// 点按 / 长按交给宿主（点按：链接弹菜单、收键盘、直接键盘模式下唤键盘；长按：进选择文本）。

const SLOP = 8;          // 超过这么多像素才算动了（之前都可能是点按 / 长按）
const LONG_MS = 480;     // 长按门槛
const TAP_MS = 450;      // 比这还久才抬手的不算点按（但也没到长按：按住不动又松开，什么都不做）
const FRICTION = 0.955;  // 惯性每 16ms 剩下的速度比例
const V_MIN = 0.02;      // px/ms，低于它惯性停下
const V_FLING = 0.25;    // px/ms，松手速度超过它才甩出惯性

export function termTouch(node, opts) {
  let o = opts;
  let mode = '';           // '' | 'pending' | 'scroll' | 'pinch'
  let sx = 0, sy = 0, st = 0, lastY = 0;
  let acc = 0;             // 还没攒够一行的滚动量（px）
  let samples = [];        // [t, y]
  let longTimer = 0, longFired = false;
  let fling = 0;           // rAF id
  let pinch0 = 0, pinchScale = 1, pinchMid = null;
  let caught = false;      // 这一下按住的是正在惯性滚动的内容（= 按停它），抬手不算点按

  const term = () => o.term?.();
  const rowH = () => {
    const t = term();
    const scr = t?.element?.querySelector('.xterm-screen');
    const h = scr && t.rows ? scr.clientHeight / t.rows : 0;
    return h > 4 ? h : 16;
  };

  // 派发 n 次「一行」的滚轮（n 带符号：正 = 往后翻、看更新的）。鼠标上报模式下一次事件就是一格，
  // 所以按行逐个发，而不是一次发 n 行的大 delta。
  function wheelRows(n) {
    const t = term();
    const el = t?.element;
    if (!el || !n) return;
    const scr = el.querySelector('.xterm-screen') || el;
    const r = scr.getBoundingClientRect();
    const h = rowH();
    const cx = r.left + Math.min(r.width / 2, 40), cy = r.top + r.height / 2;
    const k = Math.min(Math.abs(n), 40);
    for (let i = 0; i < k; i++) {
      scr.dispatchEvent(new WheelEvent('wheel', {
        deltaY: Math.sign(n) * h, deltaMode: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true,
      }));
    }
  }
  function scrollPx(dy) {      // dy = 手指位移（向下为正 = 想看更早的内容）
    acc += dy;
    const h = rowH();
    const n = Math.trunc(acc / h);
    if (!n) return;
    acc -= n * h;
    wheelRows(-n);
  }

  function stopFling() { if (fling) { cancelAnimationFrame(fling); fling = 0; } }
  function startFling(v) {
    const t = term();
    if (!t || t.buffer.active.type === 'alternate') return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(48, now - last);
      last = now;
      scrollPx(v * dt);
      v *= Math.pow(FRICTION, dt / 16);
      // 滚到头了（最顶 / 最底）就别空转
      const b = term()?.buffer.active;
      const atEdge = b && ((v > 0 && b.viewportY <= 0) || (v < 0 && b.viewportY >= b.baseY));
      fling = Math.abs(v) > V_MIN && !atEdge ? requestAnimationFrame(step) : 0;
    };
    fling = requestAnimationFrame(step);
  }

  function clearLong() { if (longTimer) { clearTimeout(longTimer); longTimer = 0; } }
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  function onStart(e) {
    if (e.cancelable) e.preventDefault();
    caught = !!fling;
    stopFling();
    if (e.touches.length >= 2) {
      clearLong();
      if (mode !== 'pinch') {
        mode = 'pinch';
        pinch0 = dist(e.touches[0], e.touches[1]) || 1;
        pinchScale = 1;
        pinchMid = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
        o.onPinch?.(1, 'start', pinchMid);
      }
      return;
    }
    const p = e.touches[0];
    mode = 'pending';
    sx = p.clientX; sy = p.clientY; st = e.timeStamp; lastY = p.clientY;
    acc = 0; samples = [[e.timeStamp, p.clientY]];
    longFired = false;
    clearLong();
    longTimer = setTimeout(() => {
      longTimer = 0;
      if (mode !== 'pending') return;
      longFired = true;
      mode = '';
      try { navigator.vibrate?.(8); } catch { /* 不支持就算了 */ }
      o.onLongPress?.(sx, sy);
    }, LONG_MS);
  }

  function onMove(e) {
    if (e.cancelable) e.preventDefault();
    if (mode === 'pinch') {
      if (e.touches.length < 2) return;
      pinchScale = (dist(e.touches[0], e.touches[1]) || 1) / pinch0;
      o.onPinch?.(pinchScale, 'move', pinchMid);
      return;
    }
    if (mode !== 'pending' && mode !== 'scroll') return;
    const p = e.touches[0];
    if (!p) return;
    if (mode === 'pending') {
      if (Math.abs(p.clientX - sx) < SLOP && Math.abs(p.clientY - sy) < SLOP) return;
      clearLong();
      mode = 'scroll';
      // 判定前那几像素也算进去：滚动从按下的位置算起，内容一下就追上手指
      lastY = sy;
    }
    const dy = p.clientY - lastY;
    lastY = p.clientY;
    samples.push([e.timeStamp, p.clientY]);
    while (samples.length > 2 && e.timeStamp - samples[0][0] > 90) samples.shift();
    scrollPx(dy);
  }

  function onEnd(e) {
    if (e.cancelable) e.preventDefault();
    if (mode === 'pinch') {
      if (e.touches.length >= 2) return;          // 三指松开一指：还在捏
      mode = e.touches.length ? 'pinch-tail' : '';
      o.onPinch?.(pinchScale, 'end', pinchMid);
      return;
    }
    if (mode === 'pinch-tail') { if (!e.touches.length) mode = ''; return; }
    clearLong();
    const was = mode;
    mode = '';
    if (was === 'scroll') {
      let v = 0;
      if (samples.length >= 2) {
        const [t0, y0] = samples[0], [t1, y1] = samples[samples.length - 1];
        // 手指停住一会儿再松开（最后一个采样离现在很久）= 不甩
        if (e.timeStamp - t1 < 60) v = (y1 - y0) / Math.max(1, t1 - t0);
      }
      if (Math.abs(v) > V_FLING) startFling(v);
      return;
    }
    if (was === 'pending' && !longFired && !caught && e.timeStamp - st < TAP_MS) o.onTap?.(sx, sy);
  }

  function onCancel() {
    clearLong();
    if (mode === 'pinch') o.onPinch?.(pinchScale, 'end', pinchMid);
    mode = '';
  }

  node.addEventListener('touchstart', onStart, { passive: false });
  node.addEventListener('touchmove', onMove, { passive: false });
  node.addEventListener('touchend', onEnd, { passive: false });
  node.addEventListener('touchcancel', onCancel);
  // 安卓长按会派 contextmenu（选文字 / 系统菜单），这一层上一律不要
  const noMenu = (e) => e.preventDefault();
  node.addEventListener('contextmenu', noMenu);
  return {
    update(next) { o = next; },
    destroy() {
      clearLong(); stopFling();
      node.removeEventListener('touchstart', onStart);
      node.removeEventListener('touchmove', onMove);
      node.removeEventListener('touchend', onEnd);
      node.removeEventListener('touchcancel', onCancel);
      node.removeEventListener('contextmenu', noMenu);
    },
  };
}

// 命中测试：屏幕坐标 → 终端里的 (列, 缓冲区行)，都从 0 起；落在终端外返回 null。
export function cellAt(term, x, y) {
  const scr = term?.element?.querySelector('.xterm-screen');
  if (!scr || !term.cols || !term.rows) return null;
  const r = scr.getBoundingClientRect();
  if (x < r.left || y < r.top || x > r.right || y > r.bottom) return null;
  const col = Math.min(term.cols - 1, Math.floor((x - r.left) / (r.width / term.cols)));
  const row = Math.min(term.rows - 1, Math.floor((y - r.top) / (r.height / term.rows)));
  return { col, line: term.buffer.active.viewportY + row };
}

// 一条「逻辑行」（被自动折行拆开的几行拼回去）的文字，以及每个字符落在哪一格。
// 网址在窄屏上常被折成两三行：链接识别和点按命中都要按逻辑行来找。
// 返回 { text, at: [[line, col], …] }（at 与 text 的 UTF-16 下标一一对应）。
export function logicalLine(term, lineIdx) {
  const b = term.buffer.active;
  let first = lineIdx;
  while (first > 0 && b.getLine(first)?.isWrapped) first--;
  let text = '';
  const at = [];
  for (let i = first; i < b.length; i++) {
    const line = b.getLine(i);
    if (!line || (i > first && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      if (cell.getWidth() === 0) continue;          // 宽字符的后半格
      const ch = cell.getChars() || ' ';
      for (let k = 0; k < ch.length; k++) at.push([i, x]);
      text += ch;
    }
  }
  return { text: text.replace(/\s+$/, ''), at, first };
}

// 整个缓冲区的纯文本（选择文本视图、复制全部用）：折行拼回逻辑行，去掉尾部空行。
export function bufferText(term) {
  const b = term.buffer.active;
  const out = [];
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (!line) continue;
    const next = b.getLine(i + 1);
    // 后面还接着折行：这一行要整宽取（尾巴上的空格是正文的一部分），否则去掉行尾空白
    const s = line.translateToString(!(next && next.isWrapped));
    if (line.isWrapped && out.length) out[out.length - 1] += s;
    else out.push(s);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}
