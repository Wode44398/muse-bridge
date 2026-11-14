// 音视频播放器共用的系统集成：
//   claimSession  媒体会话（锁屏 / 通知栏 / 耳机线控 / 蓝牙键）。同一时刻只有一个播放器持有——
//                 后挂载的抢过去，先挂载的 release 时发现不是自己的就不清（画廊切换时新页先挂、旧页后卸）。
//   screenAwake   视频播放中保持亮屏：Screen Wake Lock（页面切回前台自动重拿）+ apk 原生 AndroidStore.keepScreenOn。
// 浏览器 / WebView 不支持的能力静默跳过，不抛错。

let owner = null;
const ACTIONS = ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'];
const ms = () => (typeof navigator !== 'undefined' && navigator.mediaSession) || null;
const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };

function metadata({ title = '', artist = '', album = '', artwork = '' } = {}) {
  try {
    if (typeof MediaMetadata === 'undefined') return null;
    return new MediaMetadata({ title, artist, album, artwork: artwork ? [{ src: abs(artwork) }] : [] });
  } catch { return null; }
}

export function claimSession(info = {}, handlers = {}) {
  const tok = {};
  owner = tok;
  const s = ms();
  if (s) {
    const m = metadata(info);
    if (m) try { s.metadata = m; } catch {}
    for (const a of ACTIONS) { try { s.setActionHandler(a, handlers[a] || null); } catch {} }
  }
  const mine = () => owner === tok && !!ms();
  return {
    // 封面 / 标题晚到（ID3 解析完、媒体信息回来）时补一次
    update(next) { if (!mine()) return; const m = metadata(next); if (m) try { ms().metadata = m; } catch {} },
    playing(on) { if (mine()) try { ms().playbackState = on ? 'playing' : 'paused'; } catch {} },
    position(duration, position, rate = 1) {
      if (!mine() || typeof ms().setPositionState !== 'function') return;
      if (!(duration > 0) || !Number.isFinite(duration)) return;
      try { ms().setPositionState({ duration, position: Math.max(0, Math.min(duration, position || 0)), playbackRate: rate > 0 ? rate : 1 }); } catch {}
    },
    release() {
      if (owner !== tok) return;
      owner = null;
      const x = ms();
      if (!x) return;
      for (const a of ACTIONS) { try { x.setActionHandler(a, null); } catch {} }
      try { x.metadata = null; x.playbackState = 'none'; } catch {}
    },
  };
}

export function screenAwake() {
  let want = false, lock = null, pending = false;
  const native = () => { try { return typeof window !== 'undefined' ? window.AndroidStore : null; } catch { return null; } };
  async function acquire() {
    if (!want || lock || pending || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    const wl = typeof navigator !== 'undefined' ? navigator.wakeLock : null;
    if (!wl) return;
    pending = true;
    try {
      const l = await wl.request('screen');
      if (!want) { l.release().catch(() => {}); return; }
      lock = l;
      l.addEventListener('release', () => { if (lock === l) lock = null; });
    } catch {} finally { pending = false; }
  }
  const onVis = () => { if (document.visibilityState === 'visible') acquire(); };
  return {
    set(on) {
      on = !!on;
      if (on === want) return;
      want = on;
      try { native()?.keepScreenOn?.(on); } catch {}
      if (on) { document.addEventListener('visibilitychange', onVis); acquire(); }
      else {
        document.removeEventListener('visibilitychange', onVis);
        const l = lock; lock = null;
        try { l?.release().catch(() => {}); } catch {}
      }
    },
  };
}
