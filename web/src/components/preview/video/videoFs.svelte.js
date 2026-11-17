// 视频播放器（VideoPlayer）的全屏（Fullscreen API / 触屏横屏沉浸）、亮度、锁屏、画中画。
// P 是外壳（VideoPlayer.svelte）交出来的状态与动作视图，见那边的 P。
import { t } from '../../../lib/i18n.js';
import { previewLift } from '../../../lib/preview.svelte.js';
import { hasPip as nativeHasPip, setPipAuto } from '../../../lib/localfs.js';

export function createVideoFs(P) {
  // —— 全屏：'web' Fullscreen API（整个查看器根进全屏，方向锁跟视频宽高比）| 'native' apk 原生沉浸（横片转横屏、竖片只藏系统栏）|
  //    'pseudo' 拿不到真全屏（浏览器拒绝）时的页内全屏态（手势与锁屏照样可用）——
  // 触屏上内嵌宿主（工作台 sheet / 侧列）里的预览铺不满屏，而且转成横屏后工作台会整个重排、把播放器连带销毁：
  // 先把预览抬到 App 级实例（previewLift），这一页随即卸载，新实例凭 fsCarry 进全屏；退出时 fsLeaveSystem 再放回原窗口
  let fsMode = $state('');
  const fsOn = $derived(!!fsMode);
  let fsReq = false;
  const nativeOrient = () => typeof P.AS()?.setOrientation === 'function';
  function enterFs() {
    if (P.touch && P.viewer.inShell && P.viewer.host !== 'app') {
      P.fsCarry = { at: Date.now(), vw: P.vw, vh: P.vh };
      if (previewLift()) return;
      P.fsCarry = null;
    }
    const land = !(P.vh > P.vw);   // 尺寸未知按横片
    if (nativeOrient()) {
      try { P.AS().setOrientation(land ? 'landscape' : 'portrait'); } catch {}
      fsMode = 'native';
      return;
    }
    const el = P.viewer.root?.() || P.wrap;   // 整个查看器进全屏：顶栏 / 底栏 / 菜单都还在
    if (el?.requestFullscreen) {
      fsReq = true;
      el.requestFullscreen().then(() => {
        if (!fsReq) return;
        fsMode = 'web';
        try { screen.orientation?.lock?.(land ? 'landscape' : 'portrait').catch(() => {}); } catch {}
      }).catch(() => { fsReq = false; fsMode = 'pseudo'; });
    } else if (P.videoEl?.webkitEnterFullscreen) {
      try { P.videoEl.webkitEnterFullscreen(); } catch { fsMode = 'pseudo'; }
    } else fsMode = 'pseudo';
  }
  function exitFs() {
    const m = fsMode;
    fsMode = ''; fsReq = false; locked = false;
    resetBright();
    if (m) P.fsLeaveSystem(m);
  }
  function toggleFs() { if (fsOn) exitFs(); else enterFs(); P.showControls(); }
  function onFsChange() {
    if (document.fullscreenElement) { if (fsReq) fsMode = 'web'; return; }
    if (fsMode === 'web') exitFs();
  }

  // —— 亮度（全屏左半竖滑）：apk 原生 setBrightness 优先，否则 CSS 滤镜压暗画面 ——
  let bright = $state(1);
  const nativeBright = () => typeof P.AS()?.setBrightness === 'function';
  function setBright(v) {
    bright = Math.max(0.15, Math.min(1, v));
    if (nativeBright()) { try { P.AS().setBrightness(bright); } catch {} }
  }
  function resetBright() {
    if (bright !== 1 && nativeBright()) { try { P.AS().setBrightness(-1); } catch {} }
    bright = 1;
  }

  // —— 锁屏（触屏全屏）：手势全停，点一下只露出解锁钮 ——
  let locked = $state(false), lockUi = $state(false), lockT = null;
  function lock() { locked = true; P.viewer.closeMenu(); P.viewer.chrome.hide(); flashLock(); }
  function unlock() { locked = false; lockUi = false; clearTimeout(lockT); P.showControls(); }
  function flashLock() { lockUi = true; clearTimeout(lockT); lockT = setTimeout(() => (lockUi = false), 2500); }

  // —— 画中画：网页 Picture-in-Picture API；apk 走原生 AndroidStore.enterPip(w,h) + 'bridge-pip' 事件 ——
  // apk 有 enterPip 方法不等于系统支持（Android 8 以下、厂商关了 PiP 特性）：问原生 hasPip，别出一个点了只报错的钮
  const pipOk = (() => { try { return typeof window.AndroidStore?.enterPip === 'function' ? nativeHasPip() : !!document.pictureInPictureEnabled; } catch { return false; } })();
  let pipOn = $state(false), pipNative = $state(false);
  async function togglePip() {
    const A = P.AS();
    if (typeof A?.enterPip === 'function') {
      let ok = false;
      try { ok = !!A.enterPip(P.vw || 16, P.vh || 9); } catch {}
      if (!ok) P.viewer.toast(t('无法进入画中画'), { kind: 'err' });
      return;
    }
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await P.videoEl.requestPictureInPicture();
    } catch { P.viewer.toast(t('无法进入画中画'), { kind: 'err' }); }
  }
  function onBridgePip(e) {
    if (!P.active) return;
    pipNative = !!e?.detail?.active;
    if (pipNative) { P.viewer.closeMenu(); P.viewer.chrome.hide(); }
    else {
      // 小窗被划掉 / 点了关闭（closed）= 用户不要看了：暂停（记成用户暂停，回到前台不自己续播）；点小窗放大回来照常续播
      if (e?.detail?.closed) P.pause();
      P.showControls();
    }
  }
  // 播放中允许「按 Home 离开自动进小窗」，暂停 / 播完 / 出错 / 离开当前页就撤掉。多个播放器同挂（混排画廊邻页、
  // 关闭动画里的旧实例）时只认最后开的那个，旧实例收尾不会把新实例刚开的自动小窗关掉
  $effect(() => {
    if (!pipOk || !P.AS()?.setPipAuto) return;
    const on = P.active && P.playing && !P.ended && !P.errored;
    const w = P.vw, h = P.vh;
    if (!on) return;
    const me = {};
    P.pipAutoOwner = me;
    setPipAuto(true, w || 16, h || 9);
    return () => { if (P.pipAutoOwner === me) { P.pipAutoOwner = null; setPipAuto(false, 0, 0); } };
  });


  return {
    get bright() { return bright; }, set bright(v) { bright = v; },
    get enterFs() { return enterFs; },
    get exitFs() { return exitFs; },
    get flashLock() { return flashLock; },
    get fsMode() { return fsMode; }, set fsMode(v) { fsMode = v; },
    get fsOn() { return fsOn; },
    get fsReq() { return fsReq; }, set fsReq(v) { fsReq = v; },
    get lock() { return lock; },
    get lockT() { return lockT; }, set lockT(v) { lockT = v; },
    get lockUi() { return lockUi; }, set lockUi(v) { lockUi = v; },
    get locked() { return locked; }, set locked(v) { locked = v; },
    get nativeBright() { return nativeBright; },
    get onBridgePip() { return onBridgePip; },
    get onFsChange() { return onFsChange; },
    get pipNative() { return pipNative; }, set pipNative(v) { pipNative = v; },
    get pipOk() { return pipOk; },
    get pipOn() { return pipOn; }, set pipOn(v) { pipOn = v; },
    get resetBright() { return resetBright; },
    get setBright() { return setBright; },
    get toggleFs() { return toggleFs; },
    get togglePip() { return togglePip; },
    get unlock() { return unlock; },
  };
}
