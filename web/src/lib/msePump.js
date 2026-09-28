// MSE 全速缓冲泵 —— YouTube 式播放内核。
//
// 为什么存在：<video src> 的取流由 Chromium 媒体管线掌控，它按播放进度「小口小口」拉
// （多次小段 Range + 主动限速/歇停），实测大码率视频在 LAN 上只能拉到 ~8MB/s，
// 远低于同一台服务器上下载器能跑到的 90MB/s —— 4K 120Mbps 原片直接喂不饱、播放卡顿。
// 这里改成我们自己控制：一根 fetch 连接全速拉服务端 fMP4 流（/api/file/stream，remux=原画
// / 转码=流畅），攒批 append 进 SourceBuffer 深缓冲。网络能跑多快就缓多快，直到：
//   · 缓冲超前 > AHEAD_S（低码率片不无限吞内存/流量），或
//   · SourceBuffer 配额打满（高码率片的天然节流；QuotaExceeded → 剪身后已播段重试）。
//
// 时间轴：服务端流从 -ss t 起、时间戳归零；append 前设 timestampOffset=t 把数据映射回
// 绝对时间轴 → videoEl.currentTime/buffered/duration 全是真值，播放器无需偏移换算。
// seek：目标在 buffered 内 → 原生 currentTime（瞬时）；缓冲外 → 掐掉当前 fetch、
// sb.abort() 复位解析器、以新 t 重开流（旧 buffered 保留，回看免重拉）。
//
// 所有失败（mime 不支持/fetch 非 200/append 异常）→ onFatal 一次，调用方走回退链。

const AHEAD_S = 90;        // 缓冲超前软上限（秒）：低码率片到这就歇口气
const BACK_S = 12;         // 配额吃紧时身后保留这些秒，更早的剪掉
const BATCH_BYTES = 2 << 20;   // 攒批 append（网络 chunk 只有几十 KB，逐块 append 反而慢）

export function isMseSupported(mime) {
  try { return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime); } catch { return false; }
}

// createMsePump(videoEl, { mime, duration, urlFor(t), startAt, onFatal }) →
//   { objectUrl, seek(t), destroy() }
// 调用方把 objectUrl 设为 <video src>；destroy 于换源/卸载时必须调（掐 fetch + revoke）。
export function createMsePump(videoEl, { mime, duration, urlFor, startAt = 0, onFatal }) {
  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  let sb = null;
  let gen = 0;               // 代际：seek/destroy 后旧泵循环自行退出
  let destroyed = false;
  let fatalSent = false;
  let ctrl = null;           // 当前 fetch 的 AbortController

  const fatal = (e) => { if (fatalSent || destroyed) return; fatalSent = true; try { onFatal?.(e); } catch {} };
  const idle = () => (sb && sb.updating)
    ? new Promise((r) => sb.addEventListener('updateend', r, { once: true }))
    : Promise.resolve();
  const sleep = (ms2) => new Promise((r) => setTimeout(r, ms2));

  // 缓冲超前量（当前播放点所在 range 的余量；不在任何 range 内=0，急需数据）
  function ahead() {
    try {
      const b = videoEl.buffered, t = videoEl.currentTime;
      for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.5 && t <= b.end(i)) return b.end(i) - t;
    } catch {}
    return 0;
  }

  async function appendChunk(buf, myGen) {
    for (let tries = 0; ; tries++) {
      if (myGen !== gen || destroyed) return false;
      await idle();
      if (myGen !== gen || destroyed) return false;
      try { sb.appendBuffer(buf); return true; }
      catch (e) {
        if (e && e.name === 'QuotaExceededError' && tries < 40) {
          // 配额打满（高码率片的常态）：剪掉身后已播段，等一拍让播放消耗/浏览器自回收
          try {
            const cut = Math.max(0, (videoEl.currentTime || 0) - BACK_S);
            if (cut > 0.5) { await idle(); sb.remove(0, cut); }
          } catch {}
          await sleep(700);
          continue;
        }
        fatal(e); return false;
      }
    }
  }

  async function run(t) {
    const myGen = ++gen;
    try { ctrl?.abort(); } catch {}
    ctrl = new AbortController();
    try {
      await idle();
      if (myGen !== gen || destroyed) return;
      try { if (sb.updating) sb.abort(); } catch {}
      try { sb.timestampOffset = t; } catch (e) { fatal(e); return; }
      const res = await fetch(urlFor(t), { signal: ctrl.signal });
      if (!res.ok || !res.body) { fatal(new Error('stream http ' + res.status)); return; }
      const reader = res.body.getReader();
      let batch = [], batchSize = 0;
      const flush = async () => {
        if (!batchSize) return true;
        const buf = new Uint8Array(batchSize);
        let o = 0; for (const c of batch) { buf.set(c, o); o += c.length; }
        batch = []; batchSize = 0;
        return appendChunk(buf, myGen);
      };
      for (;;) {
        if (myGen !== gen || destroyed) { try { reader.cancel(); } catch {} return; }
        // 超前够深就歇（低码率片省内存/流量）；配额节流由 appendChunk 兜着
        while (ahead() > AHEAD_S) {
          if (myGen !== gen || destroyed) { try { reader.cancel(); } catch {} return; }
          await sleep(500);
        }
        const { value, done } = await reader.read();
        if (myGen !== gen || destroyed) return;
        if (done) {
          if (!(await flush())) return;
          await idle();
          if (myGen === gen && !destroyed && ms.readyState === 'open') { try { ms.endOfStream(); } catch {} }
          return;
        }
        batch.push(value); batchSize += value.length;
        if (batchSize >= BATCH_BYTES) { if (!(await flush())) return; }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // seek/destroy 主动掐的
      if (myGen === gen && !destroyed) fatal(e);
    }
  }

  ms.addEventListener('sourceopen', () => {
    if (destroyed || sb) return;
    try { sb = ms.addSourceBuffer(mime); } catch (e) { fatal(e); return; }
    try { if (duration > 0) ms.duration = duration; } catch {}
    try { videoEl.currentTime = startAt > 0.1 ? startAt : 0; } catch {}
    run(startAt);
  }, { once: true });
  // sourceopen 永不来（挂了个不认的 objectURL 等）→ 兜底超时
  setTimeout(() => { if (!sb && !destroyed) fatal(new Error('sourceopen timeout')); }, 10_000);

  return {
    objectUrl,
    // 目标在 buffered 内→原生瞬时 seek；缓冲外→重开流。返回实际采用的方式（调试用）。
    seek(t) {
      try {
        const b = videoEl.buffered;
        for (let i = 0; i < b.length; i++) {
          if (t >= b.start(i) && t < b.end(i) - 0.3) { videoEl.currentTime = t; return 'buffered'; }
        }
      } catch {}
      try { videoEl.currentTime = t; } catch {}
      run(t);
      return 'restart';
    },
    destroy() {
      destroyed = true; gen++;
      try { ctrl?.abort(); } catch {}
      try { URL.revokeObjectURL(objectUrl); } catch {}
    },
  };
}
