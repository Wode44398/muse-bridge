// 悬浮胶囊挂载 Claude（维护者内部的胶囊挂载方案）：把菊花从 greeting / 对话底部【拖进】顶部悬浮胶囊，
// 即把 Claude 挂载进去（new 用当前 model/effort 开新会话；continue 续连被拖那条对话）。
//
// 原生桥（MainActivity.NativeStore，window.AndroidStore.*）：
//   mountClaude(jsonCfg) / unmountClaude() / capsuleDropHint(bool) / getCutout()->{x,y,w,h}(屏幕 raw px) / isFloatingShellRunning()
// 仅离线 apk WebView + 悬浮外壳开着时可用；dev / 在线壳 / 没开悬浮窗 → canMount()=false，菊花保持原 tickle、不进拖拽态。

const S = () => (typeof window !== 'undefined' ? window.AndroidStore : null);

export function hasCapsule() { const s = S(); return !!(s && typeof s.mountClaude === 'function' && typeof s.getCutout === 'function'); }
export function shellRunning() { try { return !!S().isFloatingShellRunning(); } catch { return false; } }
// 可挂载 = 原生支持 + 悬浮外壳正在跑（没开壳就没胶囊可挂）。
export function canMount() { return hasCapsule() && shellRunning(); }

export function getCutout() { try { return JSON.parse(S().getCutout() || '{}'); } catch { return {}; } }
export function mountClaude(cfg) { try { S().mountClaude(JSON.stringify(cfg || {})); return true; } catch { return false; } }
export function unmountClaude() { try { S().unmountClaude(); } catch {} }
export function capsuleDropHint(inZone) { try { S().capsuleDropHint(!!inZone); } catch {} }

// Svelte action：长按菊花起拖 → 跟手影像 → 进/出顶部判定区调 capsuleDropHint → 区内松手 mountClaude。
//   use:mountDrag={{ config: () => ({ kind:'new'|'continue', sessionId?, model?, effort? }) }}
// config 是【函数】，松手时才调，确保读到最新 session.id / model / effort。
export function mountDrag(node, opts = {}) {
  let getConfig = (opts && opts.config) || (() => ({}));
  let startX = 0, startY = 0, pointerId = null;
  let holdTimer = null, dragging = false, inZone = false, suppressClick = false;
  let ghost = null, ghostOff = { x: 15, y: 15 }, cutout = null;
  const dpr = () => window.devicePixelRatio || 1;

  // 判定区（§2.2 宽松，不必精准对挖孔）：以挖孔为中心的顶部宽松带。
  // 优先读原生注入的 --cutout-* CSS 变量（已是 CSS px、与 clientX/Y 同坐标系，最可靠）；
  // 兜底走 getCutout() 的屏幕 raw px ÷ dpr。
  function computeZone() {
    let x, y, w, h;
    try {
      const cs = getComputedStyle(document.documentElement);
      const num = (k) => parseFloat(cs.getPropertyValue(k));
      w = num('--cutout-w');
      if (w > 0) { x = num('--cutout-x'); y = num('--cutout-y'); h = num('--cutout-h'); }
    } catch {}
    if (!(w > 0)) {
      const c = getCutout(); const r = dpr();
      if (!c || !c.w) { cutout = null; return; }
      x = c.x / r; y = c.y / r; w = c.w / r; h = c.h / r;
    }
    cutout = { cx: x + w / 2, cyTop: y, cyBottom: y + h };
  }
  function isInZone(fx, fy) {
    if (!cutout) return fy < window.innerHeight * 0.16;   // 没挖孔信息：顶部带兜底
    return fy < cutout.cyBottom + window.innerHeight * 0.12 && Math.abs(fx - cutout.cx) < window.innerWidth * 0.40;
  }

  function makeGhost(x, y) {
    ghost = node.cloneNode(true);   // 克隆菊花当前视觉（含已注入的雪碧图 svg）
    Object.assign(ghost.style, {
      position: 'fixed', left: '0', top: '0', margin: '0', zIndex: '99999',
      pointerEvents: 'none', transition: 'none', opacity: '0.96',
      filter: 'drop-shadow(0 4px 14px rgba(0,0,0,.35))',
      transform: `translate(${x}px,${y}px) scale(1.15)`,
    });
    document.body.appendChild(ghost);
  }
  function moveGhost(x, y, big) { if (ghost) ghost.style.transform = `translate(${x}px,${y}px) scale(${big ? 1.32 : 1.15})`; }
  function removeGhost() { if (ghost) { ghost.remove(); ghost = null; } }

  function startDrag(x, y) {
    dragging = true; inZone = false;
    computeZone();
    // 独占指针：避免拖到一半被页面滚动接管而 pointercancel（「拖一小段就被吸回」的真因之一）。
    try { if (pointerId != null) node.setPointerCapture(pointerId); } catch {}
    const r = node.getBoundingClientRect();
    ghostOff = { x: r.width / 2, y: r.height / 2 };
    makeGhost(x - ghostOff.x, y - ghostOff.y);
    try { node.style.opacity = '0.25'; } catch {}   // 原菊花淡出＝被「拎起」
  }
  function endDrag(x, y) {
    if (inZone) {
      mountClaude(getConfig());   // 挂载！原生接管：预热态 → 待命辉光亮 + 震 B
      if (ghost && cutout) {       // 影像坠入挖孔 + 缩没
        ghost.style.transition = 'transform .34s cubic-bezier(.4,0,.2,1), opacity .34s';
        ghost.style.transform = `translate(${cutout.cx - ghostOff.x}px,${cutout.cyTop - 6}px) scale(0.18)`;
        ghost.style.opacity = '0';
        setTimeout(removeGhost, 360);
      } else removeGhost();
    } else {                        // 区外松手：弹性吸回原位（§2.3）
      const r = node.getBoundingClientRect();
      if (ghost) {
        ghost.style.transition = 'transform .3s cubic-bezier(.34,1.56,.64,1), opacity .3s';
        ghost.style.transform = `translate(${r.left}px,${r.top}px) scale(1)`;
        ghost.style.opacity = '0';
        setTimeout(removeGhost, 320);
      }
    }
    capsuleDropHint(false);
    try { node.style.opacity = ''; } catch {}
    dragging = false; inZone = false;
  }

  function onMove(e) {
    const x = e.clientX, y = e.clientY;
    if (!dragging) { if (Math.hypot(x - startX, y - startY) > 10) cancelHold(); return; }   // 长按前移动＝滚动/误触，放手
    if (e.cancelable) e.preventDefault();
    const nowIn = isInZone(x, y);
    if (nowIn !== inZone) { inZone = nowIn; capsuleDropHint(nowIn); }   // 进/出区 → 原生胶囊变大+震 A / 恢复
    moveGhost(x - ghostOff.x, y - ghostOff.y, inZone);
  }
  function onUp(e) {
    detach(); cancelHold();
    try { if (pointerId != null) node.releasePointerCapture(pointerId); } catch {}
    pointerId = null;
    if (dragging) { suppressClick = true; endDrag(e.clientX, e.clientY); }
  }
  function cancelHold() { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } }
  function detach() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  }

  function onDown(e) {
    if (e.button != null && e.button !== 0) return;   // 仅主键 / 触摸
    if (!canMount()) return;                            // 不可挂载（非 apk / 壳没开）→ 不拦截，菊花照常 tickle
    startX = e.clientX; startY = e.clientY; pointerId = e.pointerId;
    dragging = false; suppressClick = false;
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    cancelHold();
    holdTimer = setTimeout(() => { holdTimer = null; startDrag(startX, startY); }, 500);   // 长按 500ms 起拖（同原生阈值）
  }
  // 拖拽结束后吞掉菊花 button 的那次 click（否则误触 tickle 动画）。
  function onClickCapture(e) { if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; } }

  const prevTouchAction = node.style.touchAction;
  node.style.touchAction = 'none';   // 关键：pointerdown 后浏览器不把手势判成滚动，长按拖拽全程不被 pointercancel 打断
  node.addEventListener('pointerdown', onDown);
  node.addEventListener('click', onClickCapture, true);
  return {
    update(next) { if (next && next.config) getConfig = next.config; },
    destroy() {
      node.style.touchAction = prevTouchAction;
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('click', onClickCapture, true);
      detach(); cancelHold(); removeGhost();
    },
  };
}
