// 视频播放器（VideoPlayer）的电脑单击 / 双击与触屏手势（轻点、双击跳转、长按 2×、横滑拖进度、竖滑亮度音量与下滑关闭）。
// P 是外壳（VideoPlayer.svelte）交出来的状态与动作视图，见那边的 P。
import { untrack } from 'svelte';
import { SPRING, spring, velocityTracker } from '../../../lib/motion.js';

export function createVideoTouch(P) {
  // —— 电脑：单击播放 / 暂停，双击全屏 ——
  function stageClick(e) {
    if (P.touch || P.locked) return;
    if (e.target?.closest?.('button, a, [role="slider"]')) return;
    if (P.errored) return;
    const go = P.videoEl?.paused || P.ended;
    P.togglePlay(); P.flash(go ? 'play' : 'pause');
    if (e.detail === 2) P.toggleFs();
  }

  // —— 触屏手势 ——
  // 抬手 / 移动挂在 window 上按 pointerId 过滤：宿主滑轨抢了捕获也照样收得到；只有归自己的手势才 setPointerCapture。
  let wrap = $state(), stage = $state();
  let selfPage = $state(true);        // 外框 .vw-page 直接挂着；false = 嵌在别人的滑轨里（混排画廊）：下滑关闭的跟手缩小自己演
  let g = null;
  let lastTap = { t: 0, x: 0, side: '' };
  // 下滑关闭跟手：{ x, y, k }。外框自己的页（selfPage）只位移，缩小与圆角交给外框舞台（dragProgress）；
  // 混排画廊里外框不缩舞台（dragLift:false）→ 照画廊图片页同款：跟手平移 + 按下滑距离缩到 0.6，播放器自己做
  let drag = $state(null), dragP = 0, dragAnim = null;
  let seekUi = $state(null);          // { t, d }：横向拖动 seek 的大气泡
  let levelUi = $state(null), levelT = null;   // { kind:'bright'|'vol', v }
  const vty = velocityTracker(100);   // 竖向（下滑关闭）甩速

  // 卡顿提示露不露：和顶栏下方那排胶囊（2× / 音量 / 拖进度时间）同一个位置，它们在就先让开
  const hint = P.fader();
  const hintWant = $derived(P.smoothHint && P.qualityNow === 'orig' && !P.errored && !P.ended && !P.lp2x && !P.osd && !levelUi && !seekUi && !P.locked && !P.pipNative);
  $effect(() => { const v = hintWant; untrack(() => hint.set(v)); });

  function sideOf(x) { const r = wrap.getBoundingClientRect(); const q = (x - r.left) / (r.width || 1); return q < 1 / 3 ? 'l' : q > 2 / 3 ? 'r' : 'c'; }
  function startLp() {
    clearTimeout(P.lpT);
    if (!P.playing) return;
    P.lpT = setTimeout(() => {
      if (!g || g.mode !== 'maybe') return;
      g.mode = 'lp'; P.lp2x = true; P.viewer.chrome.hide();
      P.applyRate();
      P.haptic('heavy');   // 短促锐利，进入 2x 的确认感
    }, 480);
  }
  function endLp() {
    clearTimeout(P.lpT); P.lpT = null;
    if (P.lp2x) { P.lp2x = false; P.applyRate(); }
  }
  function listen(on) {
    const f = on ? window.addEventListener : window.removeEventListener;
    f('pointermove', gMove); f('pointerup', gUp); f('pointercancel', gCancel);
  }
  function stageDown(e) {
    if (!P.touch || g || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target?.closest?.('button, a, [role="slider"]')) return;
    const r = wrap.getBoundingClientRect();
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, mode: 'maybe', W: r.width || 1, H: r.height || 1, q0: (e.clientX - r.left) / (r.width || 1), from: 0, rel: null };
    vty.reset(); vty.add(e.clientY, e.timeStamp);
    if (dragAnim) { dragAnim.cancel(); dragAnim = null; drag = null; dragP = 0; P.viewer.dragProgress(0); }
    listen(true);
    if (!P.locked) startLp();
  }
  function own(mode) {
    g.mode = mode;
    try { stage?.setPointerCapture(g.id); } catch {}
  }
  function gMove(e) {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    vty.add(e.clientY, e.timeStamp);
    if (g.mode === 'lp' || g.mode === 'pass') return;
    if (g.mode === 'maybe') {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      clearTimeout(P.lpT);
      if (P.locked) { g.mode = 'pass'; return; }
      if (Math.abs(dx) > Math.abs(dy)) {
        // 横滑 = 拖进度（画廊里也是：换文件走顶栏的上一个 / 下一个）
        if (P.effDur > 0) { own('seek'); g.from = P.effCur; g.rel = P.viewer.chrome.hold(); P.scrubStart(g.from); }
        else { g.mode = 'pass'; return; }
      } else if (P.fsOn) {
        if (g.q0 < 1 / 3) { own('bright'); g.from = P.bright; }
        else if (g.q0 > 2 / 3) { own('vol'); g.from = P.muted ? 0 : P.volume; }
        else if (dy > 0) own('fsdown');
        else { g.mode = 'pass'; return; }
      } else if (dy > 0) own('dismiss');   // 混排画廊里也归播放器：画廊对视频页只接管起手横滑
      else own('fsup');
    }
    switch (g.mode) {
      case 'seek': {
        const span = Math.min(P.effDur, 90);   // 滑过整个屏宽 = 90 秒（短片 = 全长）
        const tt = Math.max(0, Math.min(P.effDur, g.from + (dx / g.W) * span));
        seekUi = { t: tt, d: tt - g.from }; P.scrubInput(tt);
        break;
      }
      case 'bright': P.setBright(g.from - dy / (g.H * 0.7)); showLevel('bright', P.bright); break;
      case 'vol': if (P.hasAudio) { P.setVolume(g.from - dy / (g.H * 0.7)); showLevel('vol', P.muted ? 0 : P.volume); } break;
      case 'dismiss': dismissMove(dx, dy, g.H); break;
      default: break;
    }
  }
  function dismissMove(dx, dy, H) {
    if (selfPage) { drag = { x: 0, y: dy >= 0 ? dy : dy * 0.3, k: 1 }; dragP = Math.min(1, Math.max(0, dy) / 320); }
    else if (dy >= 0) { drag = { x: dx, y: dy, k: Math.max(0.6, 1 - (dy / H) * 0.4) }; dragP = Math.min(1, dy / (H * 0.45)); }
    else { drag = { x: dx * 0.5, y: dy * 0.3, k: 1 }; dragP = 0; }
    P.viewer.dragProgress(dragP);
  }
  // 松手：甩得快（>600px/s 向下）或拖过 15% 高且没往回甩 → 关；否则弹簧归位（位移 / 缩放 / 背景压暗一起回）
  function releaseDismiss(dy, vy, H) {
    if (dy > 0 && (vy > 600 || (dy > H * 0.15 && vy > -100))) { P.exitFs(); P.viewer.close(); return; }
    settleDrag();
  }
  function settleDrag() {
    const from = drag, p0 = dragP;
    dragAnim?.cancel(); dragAnim = null;
    if (!from) { dragP = 0; P.viewer.dragProgress(0); return; }
    dragAnim = spring({
      from: 1, to: 0, ...SPRING.crisp, restDist: 0.002, restVel: 0.02,
      onUpdate: (k) => { if (P.dead) return; drag = { x: from.x * k, y: from.y * k, k: 1 - (1 - from.k) * k }; dragP = p0 * k; P.viewer.dragProgress(dragP); },
      onDone: () => { dragAnim = null; if (P.dead) return; drag = null; dragP = 0; P.viewer.dragProgress(0); },
    });
    if (!dragAnim.alive) dragAnim = null;
  }
  function showLevel(kind, v) { levelUi = { kind, v }; clearTimeout(levelT); }
  function hideLevel() { clearTimeout(levelT); levelT = setTimeout(() => (levelUi = null), 600); }

  function gUp(e) {
    if (!g || e.pointerId !== g.id) return;
    const s = g; g = null; listen(false);
    try { stage?.releasePointerCapture(s.id); } catch {}
    const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
    if (s.mode === 'lp') { endLp(); return; }   // 松手退出 2x，不当轻点
    endLp();
    switch (s.mode) {
      case 'maybe': tap(e); return;
      case 'seek': {
        const tt = seekUi ? seekUi.t : s.from;
        seekUi = null; s.rel?.();
        P.scrubEnd(tt);
        return;
      }
      case 'bright': hideLevel(); return;
      case 'vol': hideLevel(); return;
      case 'fsdown': if (dy > 80) P.exitFs(); return;
      case 'fsup': if (dy < -60) P.enterFs(); return;
      case 'dismiss': releaseDismiss(dy, vty.get(), s.H); return;
      default: return;
    }
  }
  function gCancel(e) {
    if (!g || e.pointerId !== g.id) return;
    const s = g; g = null; listen(false);
    endLp();
    if (s.mode === 'seek') { seekUi = null; s.rel?.(); P.scrubEnd(s.from); }   // 手势被系统收走：回到拖之前的位置
    else if (s.mode === 'dismiss') settleDrag();
    else if (s.mode === 'bright' || s.mode === 'vol') hideLevel();
  }

  function tap(e) {
    if (P.locked) { P.flashLock(); return; }
    const now = e.timeStamp, x = e.clientX, side = sideOf(x);
    // 跳转胶囊还露着：同侧单击（或点在胶囊上）= 接着累计
    if (P.skipSide && ((side !== 'c' && side === P.skipSide) || P.inChip(x, e.clientY))) { P.doSkip(P.skipSide); lastTap.t = 0; return; }
    if (now - lastTap.t < 300 && side !== 'c' && side === lastTap.side && Math.abs(x - lastTap.x) < 80) {
      P.doSkip(side); P.viewer.chrome.hide(); lastTap.t = 0;   // 双击：第一下唤出的控件收回去
      return;
    }
    lastTap = { t: now, x, side };
    P.viewer.chrome.toggle();
  }


  return {
    get drag() { return drag; }, set drag(v) { drag = v; },
    get dragAnim() { return dragAnim; }, set dragAnim(v) { dragAnim = v; },
    get g() { return g; }, set g(v) { g = v; },
    get hint() { return hint; },
    get lastTap() { return lastTap; }, set lastTap(v) { lastTap = v; },
    get levelT() { return levelT; }, set levelT(v) { levelT = v; },
    get levelUi() { return levelUi; }, set levelUi(v) { levelUi = v; },
    get listen() { return listen; },
    get seekUi() { return seekUi; }, set seekUi(v) { seekUi = v; },
    get selfPage() { return selfPage; }, set selfPage(v) { selfPage = v; },
    get stage() { return stage; }, set stage(v) { stage = v; },
    get stageClick() { return stageClick; },
    get stageDown() { return stageDown; },
    get wrap() { return wrap; }, set wrap(v) { wrap = v; },
  };
}
