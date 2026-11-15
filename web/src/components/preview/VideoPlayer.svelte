<script module>
  import { previewLift, previewDrop, previewIsOpen } from '../../lib/preview.svelte.js';
  // 当前持有「自动进画中画」开关的播放器实例（见 setPipAuto 那段 $effect）
  let pipAutoOwner = null;
  // 跨实例接力（同一个文件的播放器被重建时接着放，不从头来、不弹「继续播放」）：
  // 触屏全屏要把内嵌宿主的预览抬到 App 级实例、退出再放回去；转屏 / 折叠屏开合让工作台从 sheet 重排成侧列——
  // 这几种情况下旧实例销毁、新实例马上挂上。旧实例销毁时留下 { key, t, paused, at }，新实例 4 秒内认领。
  let relay = null;
  // 全屏接力：{ at, vw, vh }。旧实例请求全屏后把预览抬走（自己随即销毁），新实例挂上后凭它进全屏
  let fsCarry = null;
  // 全屏保留：全屏里换到下一个视频（播完自动下一个、顶栏上一个 / 下一个）时旧实例销毁、新实例随后才挂上——
  // 全屏（横屏 + 沉浸 / 浏览器全屏）先不退，留给新实例认领；1.5 秒没人认领（下一项不是视频）就照常退出
  let fsKeep = null;   // { mode, timer }
  // 退出全屏的系统侧动作（与实例无关）：方向交还系统、退浏览器全屏；从内嵌宿主抬上来的预览放回原窗口
  function fsLeaveSystem(mode) {
    const wasLand = window.innerWidth > window.innerHeight;
    try { const A = window.AndroidStore; if (typeof A?.setOrientation === 'function') A.setOrientation('auto'); } catch {}
    if (mode === 'web') { try { if (document.fullscreenElement) document.exitFullscreen(); } catch {} }
    try { screen.orientation?.unlock?.(); } catch {}
    previewDrop(wasLand && mode !== 'pseudo');   // 横着的：等屏幕转回去、工作台排回原样再放
  }
  function fsHold(mode) {
    clearTimeout(fsKeep?.timer);
    fsKeep = { mode, timer: setTimeout(() => { fsKeep = null; fsLeaveSystem(mode); }, 1500) };
  }
  function fsTake() {
    const k = fsKeep;
    if (!k) return '';
    clearTimeout(k.timer); fsKeep = null;
    if (k.mode === 'web' && !document.fullscreenElement) { fsLeaveSystem(k.mode); return ''; }
    return k.mode;
  }
</script>

<script>
  // 自定义视频播放器（MediaViewer 外框内）：电脑端 YouTube 桌面版、手机端 YouTube 手机版同款交互。
  //
  // 播放内核 = 四级回退链（quality × transport）：
  //   ① 原画-MSE   /api/file/stream&remux=1（视频零转码全画质）+ msePump 全速深缓冲 —— 默认主路径。
  //      <video src> 的取流被 Chromium 按播放进度限速（实测 LAN 只拉 ~8MB/s，下载器能跑 90MB/s），
  //      120Mbps 4K 原片喂不饱必卡；MSE 自己一根 fetch 全速拉流灌 SourceBuffer，网络多快缓多快。
  //   ② 原画-直连  <video src=/api/file>（本地缓存 blob 命中时优先走这条：0 网络最快）
  //   ③ 流畅-MSE   /api/file/stream（服务端转码 H.264≤1080p ~6Mbps）+ msePump
  //   ④ 流畅-直连  <video src=stream&t=>（换 src 续播，tOff 偏移时间轴）
  //   任一级失败（解码/网络/配额）自动降级下一级；LAN 死链先重写成隧道 URL 原级重试一次。
  //   MSE 级 timestampOffset 映射绝对时间轴，currentTime/buffered 全真值；只有 ④ 需要 tOff 换算。
  //
  // 电脑：鼠标一动唤出控件、静止 2.5s 连光标一起藏；单击播放/暂停（中央图标闪一下）、双击全屏；
  //   底栏两行：进度轨（悬停加粗、悬停气泡带 storyboard 缩略帧与章节名、缓冲段、章节缝）+
  //   左「播放 / 下一个 / 音量（悬停展开）/ 时间（点按切剩余）」右「字幕 / 设置齿轮 / 画中画 / 全屏」；
  //   快捷键 Space/K J/L ←/→（±10s）↑/↓ M F I C 0-9 Home/End , . < >，按键后顶部出状态气泡；翻画廊用 PgUp/PgDn。
  // 手机：轻点显隐（3s 自动藏）、中央 ±10s 与大播放钮（液态玻璃）；双击左右三分之一 ±10s（连击累计 + 半月 ripple）；
  //   长按 2 倍速；横向拖动 = 拖进度（画面实时跟着走，顶部出时间胶囊）；全屏里左半亮度、右半音量、中间下滑退出全屏；
  //   非全屏上滑进全屏、下滑关闭；全屏方向跟视频宽高比；可锁屏。画廊里换文件用顶栏的上一个 / 下一个（横滑一律是拖进度）。
  // 拖进度（进度轨 / 横滑）：不等松手，画面跟着拖到的位置实时出帧（liveSeek：上一次 seek 落定才发下一次，缓冲外的限频），
  //   拖的时候先悄悄暂停、松手续播。
  // 两端共有：按文件续播（≥30s 出「从 x:xx 继续」）、音量/静音/倍速全局记忆、播完重播 + 5s 下一个倒计时、
  //   画中画、媒体会话（锁屏/耳机线控）、同名 .vtt/.srt 字幕、亮屏锁、延迟转圈、错误态重试。
  //
  // 外框契约：底栏交给外框底栏槽 bottom，显隐走 viewer.chrome（播放中 autoHide，暂停 / 拖进度保持显示）；
  // 下滑关闭走 viewer.dragProgress / viewer.close；设置菜单走 viewer.openMenu（触屏 ios27、电脑扁平）。
  // 嵌在别人的滑轨里（父节点不是外框的 .vw-page，如混排画廊）时：手势全归播放器（宿主对视频页不接管任何滑动）；
  // 下滑关闭——跟画廊图片页同一套手感（跟手位移 + 缩小、松手按距离 / 甩速判定，外框 dragLift:false 不缩舞台，
  // 视觉由播放器自己做）；轻点 / 双击 / 长按 / 全屏手势也归播放器；宿主用 active 告诉它是不是当前页（非当前页不加载、不声明）。
  import { onMount, onDestroy, untrack, tick } from 'svelte';
  import { resolveSrc, hasBlob } from '../../lib/mediaCache.js';
  import { mediaFallbackUrl } from '../../lib/server.js';
  import { createMsePump, isMseSupported } from '../../lib/msePump.js';
  import { pointer } from '../../lib/layout.svelte.js';
  import { t, tc } from '../../lib/i18n.js';
  import { cloudMediaUrl, cloudFileUrl } from '../../lib/preview.svelte.js';
  import { localFileUrl, localTierUrl, localVer, localList, hasPip as nativeHasPip, setPipAuto } from '../../lib/localfs.js';
  import {
    fmtTime, parseCues, srtToVtt, cuesAt, chapterAt, storyboardCell, resumeStore, RESUME_MIN, RATES, clampRate,
    loadAvPrefs, saveAvPrefs, stepRate, decodeSubtitle, wheelStep,
  } from '../../lib/avUtil.js';
  import { claimSession, screenAwake } from '../../lib/avSession.js';
  import { velocityTracker, spring, SPRING } from '../../lib/motion.js';
  import { saveLabel } from '../../lib/save.js';
  import { useViewer, isEditable } from './kit/context.js';
  import ViewerState from './kit/ViewerState.svelte';
  import ViewerSlider from './kit/ViewerSlider.svelte';
  import VIcon from './kit/VIcon.svelte';
  import { tip } from './kit/tooltip.js';
  import { clusterGlass } from './kit/clusterGlass.js';

  let { item, active = true } = $props();
  const viewer = useViewer();
  const touch = $derived(viewer.inShell ? viewer.touch : !pointer.fine);
  const AS = () => { try { return window.AndroidStore || null; } catch { return null; } };

  let videoEl = $state();
  let src = $state(''), revoke = () => {};
  let srcIsBlob = false;
  let loading = $state(true), errored = $state(false);
  let playing = $state(false), started = $state(false), ended = $state(false);
  let metaDur = $state(0), cur = $state(0), buffered = $state(0);
  const controls = $derived(viewer.chrome.visible);   // 控件可见（外框 chrome）
  let scrubbing = $state(false), scrubT = $state(0);   // 拖动中 + 拖到的绝对时间
  let dead = false, loaded = false, userPaused = false;

  // —— 全局偏好（音量 / 静音 / 倍速）：只在用户操作时落盘，volumechange 事件只同步状态 ——
  const LS = (() => { try { return window.localStorage; } catch { return null; } })();
  const prefs0 = loadAvPrefs(LS);
  let volume = $state(prefs0.volume), muted = $state(prefs0.muted);
  let baseRate = $state(prefs0.rate);
  let loop = $state(false);
  const persist = () => saveAvPrefs(LS, { volume, muted, rate: baseRate });
  const resume = resumeStore(LS);
  const rkey = () => item.cacheKey || item.key;

  // —— 回退链 ——
  const STEPS = ['orig-mse', 'orig-src', 'smooth-mse', 'smooth-src'];
  let step = $state('orig-src');      // 当前生效级
  let stepAt = 0;                     // 本级起播位置（早期失败时接力用）
  let probeData = $state(null);       // /stream?probe=1：{duration,mseCodecs,hasAudio,...}
  let pump = null;                    // msePump 控制器（MSE 级）
  let lanRetried = false, cacheDowngraded = false;
  let fixedUrl = null, fixedStreamUrl = null;   // LAN 死链重写后的隧道版
  let pendingSeek = -1;               // 直连级等 metadata 再应用的位置
  const qualityNow = $derived(step.startsWith('smooth') ? 'smooth' : 'orig');
  const isMse = $derived(step.endsWith('mse'));

  const rawUrl = () => fixedUrl || item.url;
  const rawStream = () => fixedStreamUrl || item.streamUrl;

  const SMOOTH_V = 'avc1.64002A';   // 服务端转码钉死 high@4.2
  function mimeFor(s) {
    if (!probeData) return null;
    const a = probeData.hasAudio ? ', mp4a.40.2' : '';
    if (s === 'orig-mse') return probeData.mseCodecs ? `video/mp4; codecs="${probeData.mseCodecs}${a}"` : null;
    return `video/mp4; codecs="${SMOOTH_V}${a}"`;
  }
  function stepOk(s) {
    if (s === 'orig-src') return true;
    if (!item.streamUrl) return false;
    if (s === 'smooth-src') return true;
    if (!probeData || !(probeData.duration > 0)) return false;
    const m = mimeFor(s);
    return !!m && isMseSupported(m);
  }

  // —— 服务端衍生物（媒体信息 / storyboard）：只有服务端认识的云端文件才有 ——
  const srv = () => !!item.streamUrl && item.saveTarget?.origin === 'cloud';
  const api = (what, extra = '', img = false) =>
    cloudMediaUrl(item.saveTarget.rel, what, { ws: item.saveTarget.ws || '', mt: item.mtime || 0, img, extra });
  let meta = $state.raw(null);        // { duration,width,height,fps,hasAudio,chapters,subs }
  const hasAudio = $derived(probeData && probeData.hasAudio === false ? false : meta && meta.hasAudio === false ? false : true);
  const fps = $derived(meta?.fps > 0 ? meta.fps : 30);
  const chapters = $derived(Array.isArray(meta?.chapters) && meta.chapters.length > 1 ? meta.chapters : []);
  async function loadMeta() {
    if (!srv()) return;
    try { const r = await fetch(api('media-meta')); if (r.ok) { const m = await r.json(); if (!dead) meta = m; } } catch {}
  }

  // —— 时间轴（MSE/原画直连=绝对；仅流畅直连需要 tOff 偏移）——
  let tOff = $state(0);
  const probeDur = $derived(probeData?.duration || 0);
  const effDur = $derived(probeDur || metaDur);
  const effCur = $derived(step === 'smooth-src' ? tOff + cur : cur);
  const shownT = $derived(scrubbing ? scrubT : effCur);
  const bufAbs = $derived(Math.min(effDur || 0, (step === 'smooth-src' ? tOff : 0) + buffered));
  const chapterNow = $derived(chapters.length ? chapterAt(chapters, shownT) : null);
  const marks = $derived(chapters.length && effDur ? chapters.slice(1).map((c) => c.start / effDur) : null);
  let remain = $state(false);         // 时间显示：已播 / 剩余

  let vw = $state(0), vh = $state(0);
  const isLocal = $derived(item.saveTarget?.origin === 'local');
  const poster = $derived.by(() => {
    const p = item.poster;
    if (p && p !== item.url) return p;
    if (isLocal) { try { if (AS()?.hasLocalPreview?.() === true) return localTierUrl(item.saveTarget.rel, 'poster', localVer(item.size, item.mtime)); } catch {} }
    return null;
  });
  // 本地视频的海报帧要原生现抽（解一帧，和首帧抢 IO / CPU），而本地文件首帧通常 100ms 内就到：
  // 先不挂海报，起播 250ms 还没出画面才挂上；首帧先到的，出画面 600ms 后补挂（此时已在播、不再抢首段），
  // 只为之后换源 / 回退重载那一下有海报垫着、不黑屏。还停在开头没播过就不补：没播过时挂上海报，内核会拿海报盖掉已出的首帧
  // （云端海报就是列表缩略图、多半已在缓存里，照常立刻挂）
  let posterLate = $state(false), posterT = null;
  const posterShown = $derived(!isLocal || posterLate ? poster : null);
  function armPoster(afterFrame = false) {
    clearTimeout(posterT);
    if (!isLocal || posterLate) return;
    posterT = setTimeout(() => {
      const v = videoEl;
      if (dead) return;
      if (afterFrame ? v && (!v.paused || v.currentTime > 0) : !(v?.readyState >= 2)) posterLate = true;
    }, afterFrame ? 600 : 250);
  }

  // —— 卡顿提示 ——
  let smoothHint = $state(false);
  let stallT = null, stallCount = 0;

  // —— 触觉（apk 原生桥优先：EFFECT_HEAVY_CLICK 那种短促锐利；网页兜底 navigator.vibrate）——
  function haptic(kind) {
    try { if (window.AndroidStore?.haptic) { window.AndroidStore.haptic(kind); return; } } catch {}
    try { navigator.vibrate?.(kind === 'heavy' ? 30 : kind === 'tick' ? 8 : 15); } catch {}
  }

  // 显隐计时由外框做（autoHide 为真时静止 2.5s / 3s 淡出）：这里只负责「唤出并重新计时」
  function armHide() { viewer.chrome.poke(); }
  function showControls() { viewer.chrome.show(); }

  function killPump() { try { pump?.destroy(); } catch {} pump = null; }

  // —— 换级（回退链/画质切换共用）——
  function runStep(s, at = 0) {
    if (dead || !videoEl) return;
    killPump(); revoke(); revoke = () => {}; srcIsBlob = false;
    clearTimeout(stallT); smoothHint = false; stallCount = 0;
    step = s; stepAt = at; loading = true; errored = false;
    buffered = 0; tOff = 0; pendingSeek = -1;
    if (s === 'orig-mse' || s === 'smooth-mse') {
      const remux = s === 'orig-mse';
      cur = at;
      pump = createMsePump(videoEl, {
        mime: mimeFor(s), duration: probeDur, startAt: at,
        urlFor: (sec) => rawStream() + (remux ? '&remux=1' : '') + '&t=' + Math.max(0, Math.round(sec * 10) / 10),
        onFatal: () => failStep(s),
      });
      src = pump.objectUrl;
    } else if (s === 'orig-src') {
      cur = 0; pendingSeek = at > 0.1 ? at : -1;
      resolveSrc(item.cacheKey, rawUrl())
        .then((r) => { if (dead || step !== s) { try { r.revoke(); } catch {} return; } src = r.src; revoke = r.revoke; srcIsBlob = !!r.cached; })
        .catch(() => { if (!dead && step === s) { src = rawUrl(); } });
    } else {   // smooth-src
      tOff = at; cur = 0;
      src = rawStream() + '&t=' + Math.max(0, Math.round(at * 10) / 10);
    }
  }

  // LAN 死链先原级重试（重写成隧道 URL），不行降级下一可用级，全灭出错误 UI。
  function failStep(s) {
    if (dead || step !== s || errored) return;
    const at = effCur > 0.5 ? effCur : stepAt;
    if (!lanRetried) {
      lanRetried = true;
      const fu = mediaFallbackUrl(item.url);
      const fs = item.streamUrl ? mediaFallbackUrl(item.streamUrl) : null;
      if (fu !== item.url || (fs && fs !== item.streamUrl)) { fixedUrl = fu; fixedStreamUrl = fs; runStep(s, at); return; }
    }
    const i = STEPS.indexOf(s);
    for (let j = i + 1; j < STEPS.length; j++) if (stepOk(STEPS[j])) { runStep(STEPS[j], at); return; }
    errored = true; loading = false;
  }

  function setQuality(q) {
    if (q === qualityNow) return;
    const at = effCur || 0;
    const seq = q === 'smooth' ? ['smooth-mse', 'smooth-src'] : ['orig-mse', 'orig-src'];
    const s = seq.find(stepOk);
    if (s) runStep(s, at);
  }

  // 媒体信息（章节 / 字幕清单 / 帧率）不在首帧关键路径上：首帧画面到了（loadeddata，或兜底 1.5s）再去要，
  // 冷文件时不和 stream probe / remux 抢服务端起 ffprobe / ffmpeg 进程；本地文件找同名字幕要同步列目录（原生 SAF 查询），
  // 也别卡在首帧解码前的主线程上
  let metaKicked = false, metaT = null;
  function kickMeta() {
    clearTimeout(metaT);
    if (metaKicked || dead) return;
    metaKicked = true;
    (meta ? Promise.resolve() : loadMeta()).then(() => { if (!dead) findSubs(); });
  }

  async function load(at = 0) {
    loading = true; errored = false;
    if (item.streamProbeUrl) {
      // no-store：probe 格式随版本演进，命中浏览器 HTTP 缓存的旧响应会让 MSE 误判降级；
      // 体积极小且服务端自有 ffprobe 结果缓存，每次真拉不亏。
      try { const r = await fetch(item.streamProbeUrl, { cache: 'no-store' }); if (r.ok) probeData = await r.json(); } catch {}
    }
    if (dead) return;
    // 本地缓存命中 → 直连 blob 最快；否则 MSE 原画优先（没条件再直连）
    let first = 'orig-src';
    if (!(item.cacheKey && (await hasBlob(item.cacheKey)))) first = stepOk('orig-mse') ? 'orig-mse' : 'orig-src';
    if (dead) return;
    runStep(first, at);
    armPoster();
    if (!metaKicked) { clearTimeout(metaT); metaT = setTimeout(kickMeta, 1500); }
  }

  // 出错后重试：复位回退链与 LAN 重写，从出错时的位置接着来（<video> 一直挂着，重试才真能重来）
  function retry() {
    const at = effCur > 0.5 ? effCur : 0;
    cacheDowngraded = false; lanRetried = false; fixedUrl = null; fixedStreamUrl = null; errored = false;
    if (!meta) metaKicked = false;   // 上次媒体信息也没拿到：重试时一并再要
    killPump(); revoke(); revoke = () => {}; src = '';
    load(at);
  }

  let resumeChecked = false;
  function onLoadedMeta() {
    const d = videoEl?.duration;
    if (videoEl?.videoWidth) { vw = videoEl.videoWidth; vh = videoEl.videoHeight; }
    if (step === 'orig-src') {
      if (d === Infinity) { try { videoEl.currentTime = 1e7; } catch {} }   // 流式无时长兜底：跳极大处逼出真时长
      else if (isFinite(d) && d > 0) metaDur = d;
      if (pendingSeek >= 0) { try { videoEl.currentTime = pendingSeek; } catch {} pendingSeek = -1; }
    } else if (isMse && isFinite(d) && d > 0) metaDur = d;
    loading = false;
    applyRate();
    if (!resumeChecked) { resumeChecked = true; offerResume(); }
  }
  function onLoadedData() { armPoster(true); kickMeta(); liveDone(); }
  function onDur() { if (step !== 'orig-src') return; const d = videoEl?.duration; if (isFinite(d) && d > 0) { metaDur = d; if (videoEl.currentTime > d) { try { videoEl.currentTime = 0; } catch {} } } }
  let lastPos = 0, lastSave = 0;
  function onTime() {
    if (!scrubbing) cur = videoEl?.currentTime || 0;
    onProgress();
    const now = performance.now();
    if (now - lastPos > 1000) { lastPos = now; sess?.position(effDur, effCur, videoEl?.playbackRate || 1); }
    if (playing && now - lastSave > 5000) { lastSave = now; saveResume(); }
  }
  // 缓冲显示：取「当前播放点所在的那段」，不是最后一段（seek 回看后不会把远处的缓冲当成眼前的）
  function onProgress() {
    try {
      const b = videoEl.buffered, x = videoEl.currentTime || 0;
      for (let i = 0; i < b.length; i++) if (x >= b.start(i) - 0.3 && x <= b.end(i) + 0.3) { buffered = b.end(i); return; }
      buffered = 0;
    } catch {}
  }
  function onWaiting() {
    loading = true;
    if (scrubbing) return;   // 拖进度时的等待是自己跳出来的，不算「网络喂不动」
    // 原画反复喂不动（弱网 vs 大码率）→ 提示切流畅。缓存 blob 源不算。
    if (qualityNow === 'orig' && playing && item.streamUrl && !srcIsBlob) {
      stallCount++;
      clearTimeout(stallT); stallT = setTimeout(() => { if (loading) smoothHint = true; }, 4000);
      if (stallCount >= 3) smoothHint = true;
    }
  }
  function onPlaying() {
    loading = false; playing = true; started = true; ended = false; cancelCd();
    clearTimeout(stallT);
    applyRate();
    sess?.playing(true);
    armHide();
  }
  function onPause() {
    if (scrubHeld) return;   // 拖进度时悄悄停的：播放态不变，松手就续播
    playing = false; sess?.playing(false);
    saveResume();
    if (!ended) showControls();
  }
  function onEnded() {
    if (loop) { seekTo(0); videoEl?.play().catch(() => {}); return; }   // 手动循环：MSE 播完回 0 要泵重开流，不能交给 loop 属性
    playing = false; ended = true; sess?.playing(false);
    resume.clear(rkey());
    showControls();
    const nx = nextItem;
    if (active && nx && nx.kind === 'video' && !cdCancelled) startCountdown();
  }
  function onErr() {
    if (!src) return;   // 忽略空 src 的伪 error
    if (step === 'orig-src' && srcIsBlob && !cacheDowngraded) {   // 缓存 blob 坏 → 原始 URL 重试
      cacheDowngraded = true; revoke(); revoke = () => {}; srcIsBlob = false; src = rawUrl(); return;
    }
    failStep(step);
  }
  function onSeeking() { seeking = true; }
  function onSeeked() { seeking = false; onProgress(); liveDone(); }
  let seeking = $state(false);
  function onVolume() { if (!videoEl) return; volume = Math.round(videoEl.volume * 100) / 100; muted = videoEl.muted; }

  function play() { const v = videoEl; if (!v) return; if (ended) { replay(); return; } userPaused = false; v.play().catch(() => showControls()); }
  function pause() { const v = videoEl; if (!v) return; userPaused = true; v.pause(); }
  function togglePlay() { const v = videoEl; if (!v) return; if (v.paused || ended) play(); else pause(); }

  function seekTo(sec) {
    sec = Math.max(0, Math.min(effDur || 0, sec));
    if (!videoEl) return;
    if (ended && sec < (effDur || 0) - 0.5) { ended = false; cancelCd(); }
    if (isMse && pump) { pump.seek(sec); cur = sec; return; }
    if (step === 'orig-src') { try { videoEl.currentTime = sec; } catch {} cur = videoEl.currentTime || sec; return; }
    // 流畅直连：缓冲窗内原生 seek（含回看），窗外重开流带 &t=
    const rel = sec - tOff;
    let bufEnd = 0;
    try { const b = videoEl.buffered; if (b && b.length) bufEnd = b.end(b.length - 1); } catch {}
    if (rel >= 0 && rel <= bufEnd) { try { videoEl.currentTime = rel; } catch {} cur = rel; }
    else { tOff = sec; cur = 0; buffered = 0; loading = true; src = rawStream() + '&t=' + Math.max(0, Math.round(sec * 10) / 10); }
  }
  const seekBy = (d) => seekTo(effCur + d);
  function frameStep(dir) { if (!videoEl || !videoEl.paused) return; seekTo(effCur + dir / fps); }

  // —— 拖进度（进度轨 / 触屏横滑共用）：不用等松手，画面跟着拖到的位置实时出帧 ——
  // 拖之前在播的先悄悄暂停（播放态显示不变，免得每跳一下漏一小段声音），松手续播。
  // 实时 seek 的节奏：上一次落定（seeked / 换源后的 loadeddata）才发下一次，中间拖过的位置直接丢掉只留最新的；
  // 目标在缓冲里的几乎是瞬时的，缓冲外的要重开流（服务端起一次 ffmpeg），至少隔 450ms。
  let scrubHeld = false;
  let liveT = -1, liveBusy = false, liveAt = 0, liveTimer = null, liveGuard = null;
  function inBuffer(sec) {
    if (step === 'orig-src') return true;   // 直连原文件：内核自己按 Range 取，随便跳
    const x = step === 'smooth-src' ? sec - tOff : sec;
    try { const b = videoEl.buffered; for (let i = 0; i < b.length; i++) if (x >= b.start(i) && x < b.end(i) - 0.3) return true; } catch {}
    return false;
  }
  function liveSeek(sec) { liveT = sec; livePump(); }
  function livePump() {
    clearTimeout(liveTimer);
    if (dead || liveBusy || liveT < 0 || !scrubbing || !videoEl) return;
    const wait = liveAt + (inBuffer(liveT) ? 30 : 450) - performance.now();
    if (wait > 0) { liveTimer = setTimeout(livePump, wait); return; }
    const sec = liveT; liveT = -1;
    if (Math.abs(sec - effCur) < 0.04) return;
    liveBusy = true; liveAt = performance.now();
    seekTo(sec);
    clearTimeout(liveGuard); liveGuard = setTimeout(liveDone, 2500);   // 落定事件一直不来（网断了）也放行
  }
  function liveDone() { if (!liveBusy) return; clearTimeout(liveGuard); liveBusy = false; livePump(); }
  function liveReset() { clearTimeout(liveTimer); clearTimeout(liveGuard); liveT = -1; liveBusy = false; }
  function scrubStart(v) {
    scrubbing = true; scrubT = v; wantStoryboard();
    const el = videoEl;
    if (el && !el.paused && !ended) { scrubHeld = true; try { el.pause(); } catch {} }
  }
  function scrubInput(v) { scrubT = v; liveSeek(v); }
  function scrubEnd(v) {
    liveReset(); scrubbing = false;
    const go = scrubHeld;
    scrubHeld = false;
    // 续播的：别正好落在片尾（暂停着跳到片尾不触发 ended，再 play() 会从头放）——留 0.25s 让它自己播完
    seekTo(go && effDur > 1 ? Math.min(v, effDur - 0.25) : v);
    if (go && !userPaused) videoEl?.play().catch(() => showControls());
    armHide();
  }
  // 指针拖完滑块把焦点还给查看器根（不是 blur 到 BODY：那样出了外框的 Tab 圈）：之后 ←/→ 是 ±10s、空格是播放 / 暂停
  // （键盘 Tab 上去的不受影响：onend 只在指针松手时回调）
  function blurSlider() {
    if (touch) return;
    const a = document.activeElement;
    if (a?.getAttribute?.('role') !== 'slider' || wrap?.ownerDocument !== a.ownerDocument) return;
    const r = viewer.root?.();
    if (r && r !== a) { try { r.focus({ preventScroll: true }); } catch {} }
    if (document.activeElement === a) a.blur();
  }
  // 鼠标点完底栏按钮同理：焦点交回查看器根，不 blur 到 BODY（键盘 Enter / 空格触发的 e.detail=0，焦点留在按钮上）
  function dropFocus(e) {
    if (!e.detail) return;
    const btn = e.currentTarget, r = viewer.root?.();
    if (r && r !== btn) { try { r.focus({ preventScroll: true }); } catch {} }
    if (document.activeElement === btn) btn.blur();
  }
  // 聚焦在进度轨上时的方向键：与全局同步长（←/→ ±10s、Shift ±30s），↑/↓ 仍是音量——滑块自己按 1/20 时长走太碎
  function railKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !effDur) return;
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation();
      doSkip(k === 'ArrowRight' ? 'r' : 'l', e.shiftKey ? 30 : 10); armHide();
    } else if ((k === 'ArrowUp' || k === 'ArrowDown') && hasAudio) {
      e.preventDefault(); e.stopPropagation();
      setVolume((muted ? 0 : volume) + (k === 'ArrowUp' ? 0.05 : -0.05));
      showOsd(volIcon, Math.round((muted ? 0 : volume) * 100) + '%');
    }
  }
  // 聚焦在音量条上：四个方向键都是音量 ±5%（滑块自带一格 1% 太碎；也别让进度的键位抢走）
  function volKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target?.getAttribute?.('role') !== 'slider') return;
    const k = e.key, up = k === 'ArrowUp' || k === 'ArrowRight', dn = k === 'ArrowDown' || k === 'ArrowLeft';
    if (!up && !dn) return;
    e.preventDefault(); e.stopPropagation();
    setVolume((muted ? 0 : volume) + (up ? 0.05 : -0.05));
  }
  // 滚轮：进度轨每格 ±5s，音量区每格 ±5%（与音频一致）
  function wheelSeek(n) { if (effDur) { doSkip(n > 0 ? 'r' : 'l', 5 * Math.abs(n)); armHide(); } }
  function wheelVol(n) {
    if (!hasAudio) return;
    setVolume((muted ? 0 : volume) + 0.05 * n);
    openVol(); if (!volHover) closeVolSoon();
  }

  // —— 速度 ——
  let lp2x = $state(false);           // 长按 2 倍速中
  let lpT = null;
  function applyRate() {
    const v = videoEl; if (!v) return;
    try { v.defaultPlaybackRate = baseRate; v.playbackRate = lp2x ? 2 : baseRate; } catch {}
  }
  function setRate(r) { baseRate = clampRate(r); applyRate(); persist(); }
  const rateLabel = (r) => (r === 1 ? tc('files', '正常') : r + '×');

  // —— 音量 ——
  $effect(() => { const v = videoEl, vol = volume, m = muted; if (!v) return; try { v.volume = vol; v.muted = m; } catch {} });
  const volIcon = $derived(!hasAudio || muted || volume === 0 ? 'mute' : volume < 0.5 ? 'volumeLow' : 'volumeHigh');
  function setVolume(x) {
    volume = Math.max(0, Math.min(1, Math.round(x * 100) / 100));
    if (volume > 0 && muted) muted = false;
    persist();
  }
  function toggleMute() {
    muted = !muted;
    if (!muted && volume === 0) volume = 0.5;
    persist();
  }
  // 音量展开（电脑）：悬停进组立即展开；离开 300ms 后收（拖着滑块不收）
  let volOpen = $state(false), volHover = false, volDrag = false, volT = null;
  function openVol() { clearTimeout(volT); volOpen = true; }
  function closeVolSoon() { clearTimeout(volT); volT = setTimeout(() => { if (!volDrag && !volHover) volOpen = false; }, 300); }

  // —— 状态气泡（按键反馈，YouTube 顶部那颗）/ 中央播放暂停闪烁 / 双击跳转 ripple ——
  let osd = $state(null), osdT = null, osdSeq = 0;
  function showOsd(icon, text) { osd = { icon, text, id: ++osdSeq }; clearTimeout(osdT); osdT = setTimeout(() => (osd = null), 800); }
  let flashUi = $state(null), flashT = null;
  function flash(icon) { flashUi = { icon, id: ++osdSeq }; clearTimeout(flashT); flashT = setTimeout(() => (flashUi = null), 500); }
  let skipUi = $state(null);          // { side:'l'|'r', amt }
  let skipTimer = null;
  function doSkip(side, sec = 10) {
    if (!effDur) return;
    skipUi = skipUi && skipUi.side === side ? { side, amt: skipUi.amt + sec } : { side, amt: sec };
    seekBy(side === 'r' ? sec : -sec);
    if (touch) haptic('tick');
    clearTimeout(skipTimer); skipTimer = setTimeout(() => (skipUi = null), 750);
  }

  // —— 字幕：同名 .vtt / .srt（或 名字.语言.srt），默认开第一条；自绘字幕层（不用 <track>，样式与位置自己掌握）——
  let subTracks = $state.raw([]);     // [{ name, lang, ext, url }]
  let subIdx = $state(-1), lastSub = 0;
  let cues = $state.raw([]);
  let cueGen = 0;
  const subLines = $derived(subIdx >= 0 && cues.length ? cuesAt(cues, effCur) : []);
  const subName = (i) => { const s = subTracks[i]; return s ? (s.lang || s.name) : ''; };
  function findSubs() {
    if (dead) return;
    const st = item.saveTarget;
    if (!st?.rel) return;
    const rel = String(st.rel);
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const join = (n) => (dir ? dir + '/' : '') + n;
    let list = [];
    if (srv() && Array.isArray(meta?.subs)) {
      list = meta.subs.map((s) => ({ name: s.name, lang: s.lang || '', ext: s.ext, url: cloudFileUrl(join(s.name), { ws: st.ws || '', http: true }) }));
    } else if (st.origin === 'local') {
      const base = item.name.replace(/\.[^.]+$/, '').toLowerCase();
      for (const f of localList(dir)) {
        if (f.isDir) continue;
        const m = /^(.*?)(?:\.([^.]{1,12}))?\.(vtt|srt)$/i.exec(f.name);
        if (!m || m[1].toLowerCase() !== base) continue;
        list.push({ name: f.name, lang: m[2] || '', ext: m[3].toLowerCase(), url: localFileUrl(join(f.name)) });
        if (list.length >= 8) break;
      }
    }
    subTracks = list;
    if (list.length && subIdx < 0) selectSub(0);
  }
  async function selectSub(i) {
    subIdx = i;
    if (i >= 0) lastSub = i;
    cues = [];
    const g = ++cueGen;
    if (i < 0) return;
    const tr = subTracks[i];
    try {
      const r = await fetch(tr.url);
      if (!r.ok) throw new Error(String(r.status));
      const text = decodeSubtitle(await r.arrayBuffer());
      if (g !== cueGen || dead) return;
      cues = parseCues(tr.ext === 'srt' ? srtToVtt(text) : text);
    } catch {
      if (g !== cueGen || dead) return;
      subIdx = -1;
      viewer.toast(t('字幕加载失败'), { kind: 'err' });
    }
  }
  function toggleSubs() {
    if (!subTracks.length) return;
    if (subIdx >= 0) { selectSub(-1); showOsd('subtitles', t('字幕已关闭')); }
    else { const i = Math.min(lastSub, subTracks.length - 1); selectSub(i); showOsd('subtitles', subName(i)); }
  }

  // —— storyboard 缩略帧（悬停 / 拖动时才去要；服务端一次 ffmpeg 出整张雪碧图，忙时 503 过会儿再要）——
  let sb = $state.raw(null), sbImg = '';
  let sbBusy = false, sbGiveUp = false, sbRetryAt = 0;
  async function wantStoryboard() {
    if (!srv() || sb || sbBusy || sbGiveUp || Date.now() < sbRetryAt) return;
    sbBusy = true;
    try {
      const r = await fetch(api('storyboard'));
      if (r.status === 503) { sbRetryAt = Date.now() + 4000; return; }
      if (!r.ok) { sbGiveUp = true; return; }
      const m = await r.json();
      const url = api('storyboard', '&img=1&v=' + (m.v || 0), true);
      await new Promise((res, rej) => { const im = new Image(); im.onload = res; im.onerror = rej; im.src = url; });
      if (dead) return;
      sbImg = url; sb = m;
    } catch { sbGiveUp = true; } finally { sbBusy = false; }
  }
  function sbStyle(v, k = 1) {
    const c = storyboardCell(sb, v);
    if (!c || !sbImg) return '';
    return `width:${c.w * k}px;height:${c.h * k}px;background-image:url("${sbImg}");background-size:${c.W * k}px ${c.H * k}px;background-position:${-c.x * k}px ${-c.y * k}px`;
  }
  const hasTip = $derived(!!sb || chapters.length > 0);

  // —— 全屏：'web' Fullscreen API（整个查看器根进全屏，方向锁跟视频宽高比）| 'native' apk 原生沉浸（横片转横屏、竖片只藏系统栏）|
  //    'pseudo' 拿不到真全屏（浏览器拒绝）时的页内全屏态（手势与锁屏照样可用）——
  // 触屏上内嵌宿主（工作台 sheet / 侧列）里的预览铺不满屏，而且转成横屏后工作台会整个重排、把播放器连带销毁：
  // 先把预览抬到 App 级实例（previewLift），这一页随即卸载，新实例凭 fsCarry 进全屏；退出时 fsLeaveSystem 再放回原窗口
  let fsMode = $state('');
  const fsOn = $derived(!!fsMode);
  let fsReq = false;
  const nativeOrient = () => typeof AS()?.setOrientation === 'function';
  function enterFs() {
    if (touch && viewer.inShell && viewer.host !== 'app') {
      fsCarry = { at: Date.now(), vw, vh };
      if (previewLift()) return;
      fsCarry = null;
    }
    const land = !(vh > vw);   // 尺寸未知按横片
    if (nativeOrient()) {
      try { AS().setOrientation(land ? 'landscape' : 'portrait'); } catch {}
      fsMode = 'native';
      return;
    }
    const el = viewer.root?.() || wrap;   // 整个查看器进全屏：顶栏 / 底栏 / 菜单都还在
    if (el?.requestFullscreen) {
      fsReq = true;
      el.requestFullscreen().then(() => {
        if (!fsReq) return;
        fsMode = 'web';
        try { screen.orientation?.lock?.(land ? 'landscape' : 'portrait').catch(() => {}); } catch {}
      }).catch(() => { fsReq = false; fsMode = 'pseudo'; });
    } else if (videoEl?.webkitEnterFullscreen) {
      try { videoEl.webkitEnterFullscreen(); } catch { fsMode = 'pseudo'; }
    } else fsMode = 'pseudo';
  }
  function exitFs() {
    const m = fsMode;
    fsMode = ''; fsReq = false; locked = false;
    resetBright();
    if (m) fsLeaveSystem(m);
  }
  function toggleFs() { if (fsOn) exitFs(); else enterFs(); showControls(); }
  function onFsChange() {
    if (document.fullscreenElement) { if (fsReq) fsMode = 'web'; return; }
    if (fsMode === 'web') exitFs();
  }

  // —— 亮度（全屏左半竖滑）：apk 原生 setBrightness 优先，否则 CSS 滤镜压暗画面 ——
  let bright = $state(1);
  const nativeBright = () => typeof AS()?.setBrightness === 'function';
  function setBright(v) {
    bright = Math.max(0.15, Math.min(1, v));
    if (nativeBright()) { try { AS().setBrightness(bright); } catch {} }
  }
  function resetBright() {
    if (bright !== 1 && nativeBright()) { try { AS().setBrightness(-1); } catch {} }
    bright = 1;
  }

  // —— 锁屏（触屏全屏）：手势全停，点一下只露出解锁钮 ——
  let locked = $state(false), lockUi = $state(false), lockT = null;
  function lock() { locked = true; viewer.closeMenu(); viewer.chrome.hide(); flashLock(); }
  function unlock() { locked = false; lockUi = false; clearTimeout(lockT); showControls(); }
  function flashLock() { lockUi = true; clearTimeout(lockT); lockT = setTimeout(() => (lockUi = false), 2500); }

  // —— 画中画：网页 Picture-in-Picture API；apk 走原生 AndroidStore.enterPip(w,h) + 'bridge-pip' 事件 ——
  // apk 有 enterPip 方法不等于系统支持（Android 8 以下、厂商关了 PiP 特性）：问原生 hasPip，别出一个点了只报错的钮
  const pipOk = (() => { try { return typeof window.AndroidStore?.enterPip === 'function' ? nativeHasPip() : !!document.pictureInPictureEnabled; } catch { return false; } })();
  let pipOn = $state(false), pipNative = $state(false);
  async function togglePip() {
    const A = AS();
    if (typeof A?.enterPip === 'function') {
      let ok = false;
      try { ok = !!A.enterPip(vw || 16, vh || 9); } catch {}
      if (!ok) viewer.toast(t('无法进入画中画'), { kind: 'err' });
      return;
    }
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await videoEl.requestPictureInPicture();
    } catch { viewer.toast(t('无法进入画中画'), { kind: 'err' }); }
  }
  function onBridgePip(e) {
    if (!active) return;
    pipNative = !!e?.detail?.active;
    if (pipNative) { viewer.closeMenu(); viewer.chrome.hide(); }
    else {
      // 小窗被划掉 / 点了关闭（closed）= 用户不要看了：暂停（记成用户暂停，回到前台不自己续播）；点小窗放大回来照常续播
      if (e?.detail?.closed) pause();
      showControls();
    }
  }
  // 播放中允许「按 Home 离开自动进小窗」，暂停 / 播完 / 出错 / 离开当前页就撤掉。多个播放器同挂（混排画廊邻页、
  // 关闭动画里的旧实例）时只认最后开的那个，旧实例收尾不会把新实例刚开的自动小窗关掉
  $effect(() => {
    if (!pipOk || !AS()?.setPipAuto) return;
    const on = active && playing && !ended && !errored;
    const w = vw, h = vh;
    if (!on) return;
    const me = {};
    pipAutoOwner = me;
    setPipAuto(true, w || 16, h || 9);
    return () => { if (pipAutoOwner === me) { pipAutoOwner = null; setPipAuto(false, 0, 0); } };
  });

  // —— 设置齿轮（倍速 / 画质 / 字幕 / 循环 / 下载）——
  let gearEl = $state(), gearOpen = $state(false);
  function openGear(items = gearItems, title = '') {
    gearOpen = true;
    viewer.openMenu({ anchor: gearEl, place: 'top', items, title, onclose: () => { gearOpen = false; } });
  }
  function onGear() { if (gearOpen) viewer.closeMenu(); else openGear(); }
  function gearItems() {
    const dl = viewer.canDownload();
    return [
      { id: 'rate', label: t('播放速度'), icon: 'speed', detail: rateLabel(baseRate), submenu: { title: t('播放速度'), items: rateItems } },
      item.streamUrl && { id: 'quality', label: t('画质'), icon: 'quality', detail: qualityNow === 'smooth' ? t('流畅') : t('原画'),
        submenu: { title: t('画质'), items: () => [
          { label: t('原画'), note: t('完整分辨率与码率'), checked: qualityNow === 'orig', onSelect: () => setQuality('orig') },
          { label: t('流畅'), note: t('转码 ≤1080p · 更抗弱网省流量'), checked: qualityNow === 'smooth', onSelect: () => setQuality('smooth') },
        ] } },
      subTracks.length > 0 && { id: 'subs', label: t('字幕'), icon: 'subtitles', detail: subIdx >= 0 ? subName(subIdx) : t('关'),
        submenu: { title: t('字幕'), items: () => [
          { label: t('关'), checked: subIdx < 0, onSelect: () => selectSub(-1) },
          ...subTracks.map((s, i) => ({ label: subName(i), checked: subIdx === i, onSelect: () => selectSub(i) })),
        ] } },
      { id: 'loop', label: t('循环播放'), icon: 'loop', detail: loop ? t('开') : t('关'), keepOpen: true, onSelect: () => { loop = !loop; } },
      dl && { sep: true },
      dl && { id: 'download', label: saveLabel(t('下载')), icon: 'download', onSelect: () => viewer.download() },
    ].filter(Boolean);
  }
  function rateItems() {
    const custom = !RATES.includes(baseRate);
    return [
      ...RATES.map((r) => ({ label: rateLabel(r), checked: r === baseRate, onSelect: () => setRate(r) })),
      { label: t('自定义'), checked: custom, detail: custom ? baseRate + '×' : '', submenu: { title: t('自定义'), items: customItems } },
    ];
  }
  function customItems() {
    return [
      { label: t('当前'), detail: baseRate + '×', disabled: true },
      { label: '+0.05', icon: 'plus', keepOpen: true, onSelect: () => bumpRate(0.05) },
      { label: '−0.05', icon: 'minus', keepOpen: true, onSelect: () => bumpRate(-0.05) },
    ];
  }
  // 触屏菜单选完就收（keepOpen 只在电脑生效）：微调后原地再长出来，连点方便
  function bumpRate(d) { setRate(baseRate + d); if (touch) setTimeout(() => { if (!dead) openGear(customItems, t('自定义')); }, 60); }

  // —— 续播（按文件记位置，≥30s 才记；打开时出「从 x:xx 继续」，点了才跳）——
  let resumeUi = $state(null), resumeT = null;
  function offerResume() {
    const r = resume.get(rkey());
    const d = effDur || videoEl?.duration || 0;
    if (!r || !(r.t >= RESUME_MIN) || (d > 0 && r.t >= d - 10)) return;
    resumeUi = { t: r.t };
    clearTimeout(resumeT); resumeT = setTimeout(() => (resumeUi = null), 8000);
  }
  function doResume() { const x = resumeUi?.t; resumeUi = null; clearTimeout(resumeT); if (x > 0) { seekTo(x); play(); } }
  function saveResume() { if (!started || ended) return; const x = effCur; if (x >= RESUME_MIN) resume.set(rkey(), x, effDur); }

  // —— 播完：重播 + 下一个视频 5s 倒计时（可取消）——
  // 下一个视频（跳过画廊里夹着的图片 / 文档，最多往后看 200 项）：播完倒计时、底栏「下一个」、Shift+N 都去这条
  const nextVidIdx = $derived.by(() => {
    const n = Math.min(viewer.count, viewer.index + 201);
    for (let i = viewer.index + 1; i < n; i++) if (viewer.itemAt(i)?.kind === 'video') return i;
    return -1;
  });
  const nextItem = $derived(nextVidIdx >= 0 ? viewer.itemAt(nextVidIdx) : null);
  function goNextVid() { if (nextVidIdx >= 0) viewer.go(nextVidIdx); }
  let nextCd = $state(0), cdT = null, cdCancelled = false;
  function startCountdown() {
    nextCd = 5; clearInterval(cdT);
    cdT = setInterval(() => { nextCd -= 1; if (nextCd <= 0) { clearInterval(cdT); cdT = null; goNextVid(); } }, 1000);
  }
  function cancelCd(user = false) { clearInterval(cdT); cdT = null; nextCd = 0; if (user) cdCancelled = true; }
  function goNext() { cancelCd(); goNextVid(); }
  function replay() { ended = false; cancelCd(); seekTo(0); userPaused = false; videoEl?.play().catch(() => {}); }

  // —— 键盘（先于外框处理；返回 true = 吃掉，外框 preventDefault）——
  function onKeys(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
    if (isEditable(e.target)) return false;
    const k = e.key;
    if ((k === ' ' || k === 'Enter') && e.target?.closest?.('button, a, [role="menuitem"]')) return false;   // 聚焦按钮时空格 = 点它
    if (!videoEl || errored) {
      if (k === 'PageUp') { viewer.prev(); return true; }
      if (k === 'PageDown') { viewer.next(); return true; }
      return false;
    }
    switch (k) {
      case ' ': case 'k': case 'K': { const go = videoEl.paused || ended; togglePlay(); flash(go ? 'play' : 'pause'); return true; }
      case 'j': case 'J': doSkip('l', 10); return true;
      case 'l': case 'L': doSkip('r', 10); return true;
      case 'ArrowLeft': doSkip('l', e.shiftKey ? 30 : 10); armHide(); return true;
      case 'ArrowRight': doSkip('r', e.shiftKey ? 30 : 10); armHide(); return true;
      case 'ArrowUp': case 'ArrowDown': {
        if (!hasAudio) return true;
        setVolume((muted ? 0 : volume) + (k === 'ArrowUp' ? 0.05 : -0.05));
        showOsd(volIcon, Math.round((muted ? 0 : volume) * 100) + '%');
        return true;
      }
      case 'm': case 'M': if (hasAudio) { toggleMute(); showOsd(volIcon, muted ? t('静音') : Math.round(volume * 100) + '%'); } return true;
      case 'f': case 'F': toggleFs(); return true;
      case 'i': case 'I': if (pipOk) togglePip(); return true;
      case 'c': case 'C': toggleSubs(); return true;
      case 'Home': seekTo(0); armHide(); return true;
      case 'End': seekTo(effDur); return true;
      case 'PageUp': viewer.prev(); return true;
      case 'PageDown': viewer.next(); return true;
      case 'N': if (e.shiftKey) { if (nextItem) goNextVid(); else viewer.next(); return true; } return false;
      case 'P': if (e.shiftKey) { viewer.prev(); return true; } return false;
      case '<': case '>': { setRate(stepRate(baseRate, k === '>' ? 1 : -1)); showOsd('speed', baseRate + '×'); return true; }
      case ',': case '.': {
        if (e.shiftKey) { setRate(stepRate(baseRate, k === '.' ? 1 : -1)); showOsd('speed', baseRate + '×'); return true; }
        if (videoEl.paused) { frameStep(k === '.' ? 1 : -1); return true; }
        return false;
      }
    }
    if (!e.shiftKey && k >= '0' && k <= '9' && k.length === 1 && effDur) { seekTo(effDur * (+k / 10)); armHide(); return true; }
    return false;
  }
  function onBack() {
    if (locked) { unlock(); return true; }
    if (fsOn) { exitFs(); return true; }
    return false;
  }

  // —— 向外框声明 ——
  $effect(() => {
    if (!active) return;
    const err = errored, lk = locked;
    return viewer.declare({
      autoHide: () => (playing && !scrubbing && !ended) || locked || pipNative,
      autoHideMs: () => (touch ? 3000 : 2500),
      arrowKbd: ['PgUp', 'PgDn'],
      seekKeys: true,                    // ←/→/Home/End 归播放器（±10s / 回开头 / 到结尾），混排画廊里也一样；换文件用 PgUp / PgDn
      soloBottom: true,                  // 底栏只放播放条：混排画廊的缩略图条不叠在进度条下面
      barNav: () => touch,               // 触屏横滑是拖进度，换文件走顶栏的上一个 / 下一个
      keys: onKeys,
      onBack,
      bottom: err || lk ? null : bar,   // 出错 / 锁屏时撤掉底栏
      menu: [],                          // 倍速 / 画质都在底栏齿轮里，⋮ 只留外框通用项
      info: () => [
        vw ? { label: t('分辨率'), value: `${vw} × ${vh}` } : null,
        effDur ? { label: t('时长'), value: fmtTime(effDur) } : null,
        meta?.fps > 0 ? { label: t('帧率'), value: `${Math.round(meta.fps * 100) / 100} fps` } : null,
      ].filter(Boolean),
    }, { key: item.key });
  });

  // 换项（Shift+N / PgUp / 播完自动下一个）时旧页连同聚焦着的按钮一起销毁，焦点掉到 BODY 就出了外框的 Tab 圈：交回查看器根
  $effect(() => {
    if (!active || touch) return;
    void item.key;
    tick().then(() => {
      if (dead || viewer.closing) return;
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected) return;
      try { viewer.root?.()?.focus({ preventScroll: true }); } catch {}
    });
  });

  // —— 系统集成：媒体会话 / 亮屏 ——
  let sess = null;
  $effect(() => {
    if (!active) return;
    const cp = viewer.canPrev, cn = nextVidIdx >= 0, art = poster, title = item.name;
    const s = claimSession({ title, artwork: art || '' }, {
      play: () => play(), pause: () => pause(),
      seekbackward: (d) => seekBy(-(d?.seekOffset || 10)),
      seekforward: (d) => seekBy(d?.seekOffset || 10),
      seekto: (d) => { if (d && Number.isFinite(d.seekTime)) seekTo(d.seekTime); },
      previoustrack: cp ? () => viewer.prev() : null,
      nexttrack: cn ? () => goNextVid() : null,
    });
    sess = s;
    untrack(() => s.playing(playing));
    return () => { s.release(); if (sess === s) sess = null; };
  });
  const awake = screenAwake();
  $effect(() => { awake.set(playing && active); });

  // 只在当前页时加载；离开当前页暂停
  $effect(() => {
    if (!(active && videoEl && !loaded)) return;
    untrack(() => {
      loaded = true;
      // 接力：刚销毁的上一个实例放的也是这个文件（抬到全屏 / 放回窗口 / 转屏重排）→ 从它停下的地方接着来
      const r = relay && relay.key === rkey() && Date.now() - relay.at < 4000 ? relay : null;
      relay = null;
      if (r) { resumeChecked = true; userPaused = r.paused; if (r.t > 0.3) cur = r.t; }
      load(r ? r.t : 0);
    });
  });
  $effect(() => { if (!active) untrack(() => { cancelCd(); try { if (videoEl && !videoEl.paused) videoEl.pause(); } catch {} }); });

  // src 就绪后尝试自动播放（失败=移动端策略，留暂停态+控件，用户点播放）
  $effect(() => {
    const s = src, v = videoEl;
    if (!s || !v || !active) return;
    untrack(() => { if (userPaused || ended || scrubHeld) return; v.play().catch(() => { showControls(); }); });
  });

  // —— 电脑：单击播放 / 暂停，双击全屏 ——
  function stageClick(e) {
    if (touch || locked) return;
    if (e.target?.closest?.('button, a, [role="slider"]')) return;
    if (errored) return;
    const go = videoEl?.paused || ended;
    togglePlay(); flash(go ? 'play' : 'pause');
    if (e.detail === 2) toggleFs();
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

  function sideOf(x) { const r = wrap.getBoundingClientRect(); const q = (x - r.left) / (r.width || 1); return q < 1 / 3 ? 'l' : q > 2 / 3 ? 'r' : 'c'; }
  function startLp() {
    clearTimeout(lpT);
    if (!playing) return;
    lpT = setTimeout(() => {
      if (!g || g.mode !== 'maybe') return;
      g.mode = 'lp'; lp2x = true; viewer.chrome.hide();
      applyRate();
      haptic('heavy');   // 短促锐利，进入 2x 的确认感
    }, 480);
  }
  function endLp() {
    clearTimeout(lpT); lpT = null;
    if (lp2x) { lp2x = false; applyRate(); }
  }
  function listen(on) {
    const f = on ? window.addEventListener : window.removeEventListener;
    f('pointermove', gMove); f('pointerup', gUp); f('pointercancel', gCancel);
  }
  function stageDown(e) {
    if (!touch || g || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target?.closest?.('button, a, [role="slider"]')) return;
    const r = wrap.getBoundingClientRect();
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, mode: 'maybe', W: r.width || 1, H: r.height || 1, q0: (e.clientX - r.left) / (r.width || 1), from: 0, rel: null };
    vty.reset(); vty.add(e.clientY, e.timeStamp);
    if (dragAnim) { dragAnim.cancel(); dragAnim = null; drag = null; dragP = 0; viewer.dragProgress(0); }
    listen(true);
    if (!locked) startLp();
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
      clearTimeout(lpT);
      if (locked) { g.mode = 'pass'; return; }
      if (Math.abs(dx) > Math.abs(dy)) {
        // 横滑 = 拖进度（画廊里也是：换文件走顶栏的上一个 / 下一个）
        if (effDur > 0) { own('seek'); g.from = effCur; g.rel = viewer.chrome.hold(); scrubStart(g.from); }
        else { g.mode = 'pass'; return; }
      } else if (fsOn) {
        if (g.q0 < 1 / 3) { own('bright'); g.from = bright; }
        else if (g.q0 > 2 / 3) { own('vol'); g.from = muted ? 0 : volume; }
        else if (dy > 0) own('fsdown');
        else { g.mode = 'pass'; return; }
      } else if (dy > 0) own('dismiss');   // 混排画廊里也归播放器：画廊对视频页只接管起手横滑
      else own('fsup');
    }
    switch (g.mode) {
      case 'seek': {
        const span = Math.min(effDur, 90);   // 滑过整个屏宽 = 90 秒（短片 = 全长）
        const tt = Math.max(0, Math.min(effDur, g.from + (dx / g.W) * span));
        seekUi = { t: tt, d: tt - g.from }; scrubInput(tt);
        break;
      }
      case 'bright': setBright(g.from - dy / (g.H * 0.7)); showLevel('bright', bright); break;
      case 'vol': if (hasAudio) { setVolume(g.from - dy / (g.H * 0.7)); showLevel('vol', muted ? 0 : volume); } break;
      case 'dismiss': dismissMove(dx, dy, g.H); break;
      default: break;
    }
  }
  function dismissMove(dx, dy, H) {
    if (selfPage) { drag = { x: 0, y: dy >= 0 ? dy : dy * 0.3, k: 1 }; dragP = Math.min(1, Math.max(0, dy) / 320); }
    else if (dy >= 0) { drag = { x: dx, y: dy, k: Math.max(0.6, 1 - (dy / H) * 0.4) }; dragP = Math.min(1, dy / (H * 0.45)); }
    else { drag = { x: dx * 0.5, y: dy * 0.3, k: 1 }; dragP = 0; }
    viewer.dragProgress(dragP);
  }
  // 松手：甩得快（>600px/s 向下）或拖过 15% 高且没往回甩 → 关；否则弹簧归位（位移 / 缩放 / 背景压暗一起回）
  function releaseDismiss(dy, vy, H) {
    if (dy > 0 && (vy > 600 || (dy > H * 0.15 && vy > -100))) { exitFs(); viewer.close(); return; }
    settleDrag();
  }
  function settleDrag() {
    const from = drag, p0 = dragP;
    dragAnim?.cancel(); dragAnim = null;
    if (!from) { dragP = 0; viewer.dragProgress(0); return; }
    dragAnim = spring({
      from: 1, to: 0, ...SPRING.crisp, restDist: 0.002, restVel: 0.02,
      onUpdate: (k) => { if (dead) return; drag = { x: from.x * k, y: from.y * k, k: 1 - (1 - from.k) * k }; dragP = p0 * k; viewer.dragProgress(dragP); },
      onDone: () => { dragAnim = null; if (dead) return; drag = null; dragP = 0; viewer.dragProgress(0); },
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
        scrubEnd(tt);
        return;
      }
      case 'bright': hideLevel(); return;
      case 'vol': hideLevel(); return;
      case 'fsdown': if (dy > 80) exitFs(); return;
      case 'fsup': if (dy < -60) enterFs(); return;
      case 'dismiss': releaseDismiss(dy, vty.get(), s.H); return;
      default: return;
    }
  }
  function gCancel(e) {
    if (!g || e.pointerId !== g.id) return;
    const s = g; g = null; listen(false);
    endLp();
    if (s.mode === 'seek') { seekUi = null; s.rel?.(); scrubEnd(s.from); }   // 手势被系统收走：回到拖之前的位置
    else if (s.mode === 'dismiss') settleDrag();
    else if (s.mode === 'bright' || s.mode === 'vol') hideLevel();
  }

  function tap(e) {
    if (locked) { flashLock(); return; }
    const now = e.timeStamp, x = e.clientX, side = sideOf(x);
    if (skipUi && side !== 'c' && side === skipUi.side) { doSkip(side); lastTap.t = 0; return; }   // 指示存活期内同侧单击=继续累计
    if (now - lastTap.t < 300 && side !== 'c' && side === lastTap.side && Math.abs(x - lastTap.x) < 80) {
      doSkip(side); viewer.chrome.hide(); lastTap.t = 0;   // 双击：第一下唤出的控件收回去
      return;
    }
    lastTap = { t: now, x, side };
    viewer.chrome.toggle();
  }

  onMount(() => {
    selfPage = !viewer.inShell || !!wrap?.parentElement?.classList.contains('vw-page');
    // 全屏接力：上一个实例留下的全屏（全屏里换了视频）直接认领；或者它刚把预览从内嵌宿主抬上来、等这边进全屏
    if (active) {
      const kept = fsTake(), c = fsCarry;
      fsCarry = null;
      if (kept) { fsMode = kept; fsReq = kept === 'web'; }
      else if (c && Date.now() - c.at < 3000) { if (!vw && c.vw) { vw = c.vw; vh = c.vh; } enterFs(); }
    }
    const onVis = () => { if (document.visibilityState === 'hidden') saveResume(); };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', saveResume);
    window.addEventListener('bridge-pip', onBridgePip);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', saveResume);
      window.removeEventListener('bridge-pip', onBridgePip);
    };
  });
  // 网页画中画进出（<video> 事件；apk 原生画中画走 bridge-pip）
  $effect(() => {
    const v = videoEl; if (!v) return;
    const on = () => (pipOn = true), off = () => (pipOn = false);
    v.addEventListener('enterpictureinpicture', on); v.addEventListener('leavepictureinpicture', off);
    return () => { v.removeEventListener('enterpictureinpicture', on); v.removeEventListener('leavepictureinpicture', off); };
  });
  onDestroy(() => {
    saveResume();
    // 接力：留下停在哪、是不是用户自己暂停的（新实例 4 秒内认领，见 load 那段 $effect）。
    // 只在预览还开着时留（换宿主 / 重排；认领时再核对是不是同一个文件）；关掉查看器再重开不算接力，照常出「从 x:xx 继续」。
    // 销毁回调里读响应式状态拿到的是变更前的旧值，所以问 previewIsOpen()（普通变量）
    const open = previewIsOpen();
    relay = open && (started || effCur > 0.3) && !ended && !errored ? { key: rkey(), t: effCur, paused: userPaused, at: Date.now() } : null;
    dead = true;
    liveReset();
    if (g) { g = null; listen(false); }
    dragAnim?.cancel(); dragAnim = null;
    clearTimeout(lpT); clearTimeout(skipTimer); clearTimeout(stallT); clearTimeout(osdT); clearTimeout(flashT);
    clearTimeout(resumeT); clearTimeout(lockT); clearTimeout(levelT); clearTimeout(volT); clearTimeout(metaT); clearTimeout(posterT); clearInterval(cdT);
    if (fsMode) {
      // 全屏里换到另一个视频（查看器还开着）：全屏留给随后挂上的新实例认领，1.5 秒没人认领（下一项不是视频）再退；
      // 查看器关了就当场退出
      const m = fsMode;
      if (open) { fsMode = ''; resetBright(); fsHold(m); } else exitFs();
    } else resetBright();
    awake.set(false);
    try { if (document.pictureInPictureElement === videoEl) document.exitPictureInPicture(); } catch {}
    killPump();
    revoke();
  });

  const showSpin = $derived((loading || seeking) && !errored && !ended && !!src);
  const timeText = $derived(remain && effDur ? '−' + fmtTime(Math.max(0, effDur - shownT)) : fmtTime(shownT));
  const nocur = $derived(!touch && playing && !controls && !scrubbing);
  const clusterOn = $derived(controls || !started);
  // 触屏中央三钮露不露（玻璃底只在露着时挂滤镜，见 kit/clusterGlass.js）；查看器正在关（整体淡出）时先撤玻璃
  const clusterVis = $derived(clusterOn && !scrubbing && !ended && !lp2x && !seekUi && !locked && !pipNative);
</script>

<!-- 进度轨悬停 / 拖动气泡上方：storyboard 缩略帧 + 章节名 -->
{#snippet railTip(v)}
  {#if sb}<span class="vp-sbf" style={sbStyle(v, 1)}></span>{/if}
  {#if chapters.length}{@const c = chapterAt(chapters, v)}{#if c?.title}<span class="vp-chap">{c.title}</span>{/if}{/if}
{/snippet}

{#snippet rail()}
  <!-- 外包一层只为截方向键（与全局同步长）和滚轮（每格 ±5s）；display:contents 不参与布局 -->
  <div class="vp-railk" role="presentation" onkeydowncapture={railKey} use:wheelStep={wheelSeek}>
    <ViewerSlider class="vp-rail" value={shownT} max={effDur || 0} buffered={bufAbs} label={t('进度')}
      format={fmtTime} hoverFormat={touch ? null : fmtTime} valueText={(v) => fmtTime(v) + ' / ' + fmtTime(effDur)}
      tip={hasTip ? railTip : null} {marks} onhover={(v) => { if (v != null) wantStoryboard(); }}
      onstart={scrubStart} oninput={scrubInput} onchange={scrubEnd} onend={blurSlider} disabled={!effDur} />
  </div>
{/snippet}

{#snippet timeBtn()}
  <button type="button" class="vp-time" onclick={() => (remain = !remain)} aria-label={remain ? t('显示已播放时间') : t('显示剩余时间')}>
    <span class="vp-tnow">{timeText}</span><em> / {fmtTime(effDur)}</em>
    {#if chapterNow?.title && !touch}<span class="vp-tchap">· {chapterNow.title}</span>{/if}
  </button>
{/snippet}

{#snippet subsBtn()}
  {#if subTracks.length}
    <button type="button" class="vw-btn vp-cc" class:cc-on={subIdx >= 0} onclick={toggleSubs} use:tip={{ label: subIdx >= 0 ? t('关闭字幕') : t('字幕'), kbd: 'C' }}>
      <VIcon name="subtitles" /><i></i>
    </button>
  {/if}
{/snippet}

{#snippet gearBtn()}
  <button type="button" class="vw-btn vp-gear" class:open={gearOpen} bind:this={gearEl} onclick={onGear} use:tip={t('设置')} aria-haspopup="menu" aria-expanded={gearOpen}>
    <VIcon name="settings" />
  </button>
{/snippet}

<!-- 底栏（交给外框底栏槽渲染）。电脑：进度轨在上、按钮行在下；触屏：时间与功能钮一行、全宽进度轨在下 -->
{#snippet bar()}
  <div class="vp-bar" class:fine={!touch} class:scrub={scrubbing && touch} onpointerdown={(e) => e.stopPropagation()} role="presentation">
    {#if !touch}
      {@render rail()}
      <div class="vp-row">
        <button type="button" class="vw-btn" onclick={(e) => { dropFocus(e); togglePlay(); }} use:tip={{ label: playing ? t('暂停') : ended ? t('重播') : t('播放'), kbd: 'K' }}>
          <VIcon name={playing ? 'pause' : ended ? 'replay' : 'play'} />
        </button>
        {#if nextItem}
          <button type="button" class="vw-btn" onclick={(e) => { dropFocus(e); goNextVid(); }} use:tip={{ label: t('下一个'), kbd: 'Shift+N' }}><VIcon name="nextTrack" /></button>
        {/if}
        <div class="vp-vol" class:open={volOpen} role="group" aria-label={t('音量')} use:wheelStep={wheelVol} onkeydowncapture={volKey}
          onpointerenter={() => { volHover = true; openVol(); }} onpointerleave={() => { volHover = false; closeVolSoon(); }}
          onfocusin={openVol} onfocusout={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) closeVolSoon(); }}>
          <button type="button" class="vw-btn" disabled={!hasAudio} onclick={(e) => { dropFocus(e); toggleMute(); }} use:tip={{ label: muted ? t('取消静音') : t('静音'), kbd: 'M' }}>
            <VIcon name={volIcon} />
          </button>
          <div class="vp-vol-slot">
            <ViewerSlider class="vp-vol-sl" value={muted ? 0 : volume} max={1} step={0.01} label={t('音量')} disabled={!hasAudio}
              valueText={(v) => Math.round(v * 100) + '%'} oninput={setVolume} onstart={() => (volDrag = true)} onend={() => { volDrag = false; blurSlider(); if (!volHover) closeVolSoon(); }} />
          </div>
        </div>
        <div class="vp-tgroup" class:shift={!volOpen}>{@render timeBtn()}</div>
        <span class="vp-sp"></span>
        {@render subsBtn()}
        {@render gearBtn()}
        {#if pipOk}
          <button type="button" class="vw-btn" class:open={pipOn} onclick={(e) => { dropFocus(e); togglePip(); }} use:tip={{ label: t('画中画'), kbd: 'I' }}><VIcon name="pip" /></button>
        {/if}
        <button type="button" class="vw-btn" onclick={(e) => { dropFocus(e); toggleFs(); }} use:tip={{ label: fsOn ? t('退出全屏') : t('全屏'), kbd: 'F' }}>
          <VIcon name={fsOn ? 'exitFullscreen' : 'fullscreen'} />
        </button>
      </div>
    {:else}
      <div class="vp-row">
        {@render timeBtn()}
        <span class="vp-sp"></span>
        {@render subsBtn()}
        {@render gearBtn()}
        {#if pipOk && !fsOn}
          <button type="button" class="vw-btn" onclick={togglePip} aria-label={t('画中画')}><VIcon name="pip" /></button>
        {/if}
        {#if fsOn}
          <button type="button" class="vw-btn" onclick={lock} aria-label={t('锁定')}><VIcon name="lock" /></button>
        {/if}
        <button type="button" class="vw-btn" onclick={toggleFs} aria-label={fsOn ? t('退出全屏') : t('全屏')}>
          <VIcon name={fsOn ? 'exitFullscreen' : 'fullscreen'} />
        </button>
      </div>
      {@render rail()}
    {/if}
  </div>
{/snippet}

<div class="vp-wrap" class:touch class:nocur class:lift={!!drag && !selfPage} class:pipn={pipNative} bind:this={wrap}
  style:transform={drag ? (selfPage ? `translate3d(0,${drag.y}px,0)` : `translate3d(${drag.x}px,${drag.y}px,0) scale(${drag.k})`) : null}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="vp-stage" bind:this={stage} role="presentation" onpointerdown={stageDown} onclick={stageClick}
      style:touch-action="none">
      <!-- data-noheal：播放器有自己的回退链（runStep），全局 mediaHeal 别再并行改 src。出错时也一直挂着，重试才有元素可用 -->
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={videoEl} class="vp-video" src={src || undefined} poster={posterShown || undefined} data-noheal
        playsinline preload="metadata" style:filter={bright < 1 && !nativeBright() ? `brightness(${bright})` : null}
        onloadedmetadata={onLoadedMeta} onloadeddata={onLoadedData} ondurationchange={onDur} ontimeupdate={onTime} onprogress={onProgress}
        onwaiting={onWaiting} onplaying={onPlaying} onplay={() => { ended = false; }} onpause={onPause} onended={onEnded} onerror={onErr}
        onseeking={onSeeking} onseeked={onSeeked} onvolumechange={onVolume}></video>

      <!-- 字幕：控件出来时整体上移让出底栏 -->
      {#if subLines.length && !errored}
        <div class="vp-subs" class:up={controls && !locked && !pipNative} class:scrub={scrubbing} aria-live="off">
          {#each subLines as line, i (i)}<span>{line}</span>{/each}
        </div>
      {/if}

      {#if showSpin}
        <ViewerState kind="loading" size={36} />
      {/if}

      {#if errored}
        <div class="vp-err" role="presentation">
          <ViewerState kind="error" icon="video" title={t('视频加载失败')} overlay={false} onRetry={retry} />
        </div>
      {/if}

      {#if pipOn && !errored}
        <div class="vp-pipnote"><VIcon name="pip" size={28} /><span>{t('正在画中画中播放')}</span></div>
      {/if}

      <!-- 双击 / 方向键跳转半月指示（YouTube 同款：ripple + 三箭头 + 累计秒数） -->
      {#if skipUi}
        <div class="vp-skip {skipUi.side === 'l' ? 'left' : 'right'}">
          {#key skipUi.amt}
            <div class="vp-skip-in">
              <div class="vp-skip-arrows" class:rev={skipUi.side === 'l'}><i></i><i></i><i></i></div>
              <span>{t('{n} 秒', { n: skipUi.amt })}</span>
            </div>
          {/key}
        </div>
      {/if}

      <!-- 长按 2x 标签 -->
      {#if lp2x}
        <div class="vp-top"><span class="vw-pill"><b>2×</b><VIcon name="fastForward" size={16} /></span></div>
      {/if}

      <!-- 按键状态气泡（音量 / 倍速 / 字幕） -->
      {#if osd && !lp2x}
        {#key osd.id}
          <div class="vp-top"><span class="vw-pill vp-osd"><VIcon name={osd.icon} size={18} /><b>{osd.text}</b></span></div>
        {/key}
      {/if}

      <!-- 全屏亮度 / 音量竖滑：顶部电平条 -->
      {#if levelUi}
        <div class="vp-top"><span class="vw-pill vp-level"><VIcon name={levelUi.kind === 'bright' ? 'brightness' : levelUi.v === 0 ? 'mute' : 'volumeHigh'} size={18} />
          <i class="vp-level-bar"><i style:transform="scaleX({levelUi.v})"></i></i></span></div>
      {/if}

      <!-- 中央播放 / 暂停闪烁（电脑单击 / 空格） -->
      {#if flashUi}
        {#key flashUi.id}<div class="vp-flash"><VIcon name={flashUi.icon} size={30} /></div>{/key}
      {/if}

      <!-- 横向拖动 seek：画面实时跟着走，顶部一枚胶囊报目标时间与偏移 -->
      {#if seekUi}
        <div class="vp-top still"><span class="vw-pill vp-seek">
          <b>{fmtTime(seekUi.t)}</b><em>/ {fmtTime(effDur)}</em><i>{seekUi.d >= 0 ? '+' : '−'}{fmtTime(Math.abs(seekUi.d))}</i>
        </span></div>
      {/if}

      <!-- 卡顿提示：切流畅 -->
      {#if smoothHint && qualityNow === 'orig' && !errored && !ended}
        <div class="vp-low"><button type="button" class="vw-pill vp-pillbtn" onclick={() => setQuality('smooth')}>{t('网络吃紧 · 切换流畅播放')}</button></div>
      {:else if resumeUi && !errored && !ended}
        <div class="vp-low left"><button type="button" class="vw-pill vp-pillbtn" onclick={doResume}><VIcon name="play" size={16} />{t('从 {t} 继续', { t: fmtTime(resumeUi.t) })}</button></div>
      {/if}

      <!-- 播完：重播 / 下一个倒计时 -->
      {#if ended && !errored}
        <div class="vp-end" class:cd={nextCd > 0 && !!nextItem}>
          {#if nextCd > 0 && nextItem}
            <div class="vp-next" role="status">
              <span class="vp-next-k">{t('接下来')}</span>
              <span class="vp-next-n">{nextItem.name}</span>
              <span class="vp-next-c">{t('{n} 秒后播放', { n: nextCd })}</span>
              <span class="vp-next-a">
                <button type="button" class="vw-pbtn" onclick={() => cancelCd(true)}>{t('取消')}</button>
                <button type="button" class="vw-pbtn pri" onclick={goNext}>{t('立即播放')}</button>
              </span>
            </div>
          {:else}
            <button type="button" class="vp-big" onclick={replay} use:tip={t('重播')}><VIcon name="replay" size={34} /></button>
          {/if}
        </div>
      {/if}

      <!-- 电脑：没起播（自动播放被拦）时的中央大播放钮 -->
      {#if !touch && !started && !playing && !loading && !errored && !ended}
        <button type="button" class="vp-big" onclick={play} aria-label={t('播放')}><VIcon name="play" size={34} /></button>
      {/if}

      <!-- 触屏：中央 −10 / 播放暂停 / +10（随控件显隐） -->
      {#if touch && !errored}
        <!-- 玻璃底是舞台里的兄弟节点（clusterGlass 插在这层前面、按按钮的盒子摆），按钮自己只画图标 -->
        <div class="vp-cluster" class:hide={!clusterVis} use:clusterGlass={{ on: clusterVis && !viewer.closing }}>
          <button type="button" class="vp-cbtn" data-glass onclick={() => doSkip('l')} aria-label={t('快退 10 秒')} tabindex={clusterVis ? 0 : -1}><VIcon name="skipBack10" size={30} stroke={1.9} /></button>
          <button type="button" class="vp-cbtn main" data-glass class:busy={showSpin} onclick={togglePlay} aria-label={playing ? t('暂停') : t('播放')} tabindex={clusterVis ? 0 : -1}>
            <VIcon name={playing ? 'pause' : 'play'} size={34} />
          </button>
          <button type="button" class="vp-cbtn" data-glass onclick={() => doSkip('r')} aria-label={t('快进 10 秒')} tabindex={clusterVis ? 0 : -1}><VIcon name="skipFwd10" size={30} stroke={1.9} /></button>
        </div>
      {/if}

      <!-- 锁屏：点一下露出解锁钮 -->
      {#if locked && lockUi}
        <div class="vp-lock"><button type="button" class="vw-pill vp-pillbtn" onclick={unlock}><VIcon name="unlock" size={18} />{t('点按解锁')}</button></div>
      {/if}
  </div>
</div>

<style>
  .vp-wrap { position: absolute; inset: 0; background: #000; container-type: size; }
  /* 混排画廊里下滑缩小：黑底与画面外的黑边透明，只剩画面本身跟手（同画廊里的图片） */
  .vp-wrap.lift, .vp-wrap.lift .vp-video { background: transparent; }
  .vp-wrap.nocur, .vp-wrap.nocur * { cursor: none; }
  .vp-stage { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .vp-video { width: 100%; height: 100%; object-fit: contain; background: #000; }

  /* 错误态铺满只为居中：自身不吃指针（出错时照样能下滑关闭 / 翻页），只有按钮接手 */
  .vp-err { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; background: #000; }
  .vp-err :global(.vw-state-acts) { pointer-events: auto; }

  /* 字幕：白字 + 近黑半透明底块（压在视频上不用 blur）；字号跟画面短边走 */
  .vp-subs { position: absolute; left: 6%; right: 6%; bottom: 6%; display: flex; flex-direction: column; align-items: center; gap: 2px;
    pointer-events: none; text-align: center; transition: transform var(--mo-quick) var(--ea-std), opacity var(--mo-quick) var(--ea-fade); }
  /* 控件出来时：字幕底边贴到底栏内容上沿以上 8px（--vw-bottom 含底栏顶部 30px 渐变区，先抵掉自身 6% 的底距）。
     横屏 393 高时中央三钮下沿到底栏之间只剩 ~60px，只有贴着底栏才放得下两行不压钮 */
  .vp-subs.up { transform: translateY(calc(6cqh - var(--vw-bottom, 0px) + 22px)); }
  /* 拖进度时：缩略帧 / 章节 / 时间气泡正好落在字幕那一带，字幕还是拖之前那句、没用，先淡出让位 */
  .vp-subs.scrub { opacity: 0; }
  .vp-subs span { white-space: pre-line; background: rgba(8, 8, 8, .75); color: #fff; padding: .1em .45em; border-radius: 4px;
    font-size: clamp(15px, 4.2cqmin, 30px); line-height: 1.35; font-weight: 500; letter-spacing: .01em; -webkit-box-decoration-break: clone; box-decoration-break: clone; }

  /* 大圆钮（电脑起播 / 重播）：半透明实底 */
  .vp-big { position: absolute; width: 72px; height: 72px; border: 0; padding: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, .5); color: #fff; cursor: pointer; transition: transform var(--mo-tap) var(--ea-out), background-color var(--mo-tap) var(--ea-out); }
  .vp-big:active { background: rgba(0, 0, 0, .62); transform: scale(.96); }
  @media (hover: hover) { .vp-big:hover { background: rgba(0, 0, 0, .62); } }
  .vp-end { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; background: rgba(0, 0, 0, .35); }
  .vp-end.cd { background: rgba(0, 0, 0, .5); }
  .vp-end > * { pointer-events: auto; }
  .vp-end .vp-big { position: static; }

  /* 下一个倒计时：近黑实底卡（压在任意画面上都读得清；会动的画面上不用 backdrop-filter）+ 一圈极淡的发丝边分层 */
  .vp-next { display: flex; flex-direction: column; align-items: center; gap: 8px; width: min(400px, 88%); box-sizing: border-box; padding: 22px 24px 20px;
    border-radius: 18px; background: rgba(20, 20, 22, .94); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .08), 0 12px 40px rgba(0, 0, 0, .45);
    text-align: center; color: #fff; animation: vpPillIn var(--mo-base) var(--ea-decel); }
  .vp-next-k { font-size: 13px; font-weight: 500; color: rgba(255, 255, 255, .62); letter-spacing: .04em; }
  .vp-next-n { font-size: 19px; font-weight: 600; line-height: 1.35; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; word-break: break-all; }
  .vp-next-c { font-size: 14px; color: rgba(255, 255, 255, .78); font-variant-numeric: tabular-nums; }
  .vp-next-a { display: flex; gap: 10px; margin-top: 10px; }

  /* 触屏中央三钮：液态玻璃（kit/clusterGlass.js 把玻璃底铺在舞台里、按钮正下方；生效时容器带 .glass，按钮自己不画底）。
     显隐只动每个按钮自己的不透明度——容器（玻璃的祖先）一带 opacity，玻璃就采不到画面、变成黑块。
     不支持 SVG backdrop 的内核（iOS / Firefox）走退路：按钮自己一层磨砂 + 细高光边 */
  .vp-cluster { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: clamp(28px, 12cqw, 64px); pointer-events: none; }
  .vp-cluster:not(.hide) .vp-cbtn { pointer-events: auto; }
  .vp-cbtn { position: relative; width: 52px; height: 52px; border: 0; padding: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    color: #fff; background: rgba(22, 22, 24, .38); box-shadow: inset 0 0 0 .5px rgba(255, 255, 255, .22), inset 0 1px 0 rgba(255, 255, 255, .18);
    -webkit-backdrop-filter: blur(14px) saturate(1.5); backdrop-filter: blur(14px) saturate(1.5); -webkit-tap-highlight-color: transparent;
    transition: opacity var(--mo-quick) var(--ea-fade), transform 240ms cubic-bezier(.2, .8, .2, 1); }
  .vp-cbtn.main { width: 68px; height: 68px; }
  .vp-cbtn :global(.vw-ic) { filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .28)); }
  .vp-cluster:global(.glass) .vp-cbtn { background: none; box-shadow: 0 6px 22px rgba(0, 0, 0, .16); -webkit-backdrop-filter: none; backdrop-filter: none; }
  .vp-cluster.hide .vp-cbtn { opacity: 0; -webkit-backdrop-filter: none; backdrop-filter: none; }
  .vp-cbtn.busy :global(.vw-ic) { opacity: 0; }
  .vp-cbtn:active { transform: scale(1.08); }

  /* 中央闪烁 */
  .vp-flash { position: absolute; left: 50%; top: 50%; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .5); color: #fff; pointer-events: none;
    animation: vpFlash var(--mo-page) var(--ea-out) forwards; }
  @keyframes vpFlash { from { opacity: 1; transform: scale(.85); } to { opacity: 0; transform: scale(1.35); } }

  /* —— 双击跳转半月指示 —— */
  .vp-skip { position: absolute; top: 0; bottom: 0; width: 38%; display: flex; align-items: center; justify-content: center; pointer-events: none; overflow: hidden; }
  .vp-skip.left { left: 0; border-radius: 0 100vh 100vh 0 / 0 50% 50% 0; background: radial-gradient(closest-side at 30% 50%, rgba(255,255,255,.14), rgba(255,255,255,.05) 70%, transparent); }
  .vp-skip.right { right: 0; border-radius: 100vh 0 0 100vh / 50% 0 0 50%; background: radial-gradient(closest-side at 70% 50%, rgba(255,255,255,.14), rgba(255,255,255,.05) 70%, transparent); }
  .vp-skip-in { display: flex; flex-direction: column; align-items: center; gap: 7px; color: #fff; animation: vpSkipPop var(--mo-base) var(--ea-decel); }
  .vp-skip-in span { font-size: 13px; font-weight: 500; text-shadow: 0 1px 3px rgba(0,0,0,.5); }
  @keyframes vpSkipPop { from { transform: scale(.82); opacity: .4; } }
  .vp-skip-arrows { display: flex; gap: 3px; }
  .vp-skip-arrows.rev { flex-direction: row-reverse; }
  .vp-skip-arrows i { width: 0; height: 0; border-style: solid; border-width: 7px 0 7px 11px; border-color: transparent transparent transparent #fff; opacity: .5; animation: vpArr calc(var(--mo-page) * 2) var(--ea-fade) infinite; }
  .vp-skip-arrows.rev i { transform: rotate(180deg); }
  .vp-skip-arrows i:nth-child(2) { animation-delay: var(--mo-micro); }
  .vp-skip-arrows i:nth-child(3) { animation-delay: calc(var(--mo-micro) * 2); }
  @keyframes vpArr { 0%, 100% { opacity: .35; } 40% { opacity: 1; } }

  /* —— 顶部居中：2x / 状态气泡 / 电平条 —— */
  .vp-top { position: absolute; top: calc(var(--vw-bar-h, 56px) + 10px); left: 50%; transform: translateX(-50%); pointer-events: none; animation: vpPillIn var(--mo-quick) var(--ea-decel); }
  .vp-top b { font-weight: 600; font-size: 14px; font-variant-numeric: tabular-nums; }
  .vp-osd { padding: 8px 14px; }
  .vp-level { padding: 9px 14px; }
  .vp-level-bar { position: relative; display: block; width: 96px; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, .24); overflow: hidden; }
  .vp-level-bar i { position: absolute; inset: 0; background: #fff; transform-origin: left center; }
  @keyframes vpPillIn { from { opacity: 0; scale: .92; } }

  /* —— 横向拖动 seek：顶部时间胶囊（目标时间 / 总长 + 偏移）—— */
  .vp-top.still { animation: none; }
  .vp-seek { padding: 9px 16px; gap: 6px; font-variant-numeric: tabular-nums; }
  .vp-seek b { font-size: 16px; }
  .vp-seek em { font-style: normal; color: rgba(255, 255, 255, .6); font-size: 13px; }
  .vp-seek i { font-style: normal; margin-left: 6px; padding-left: 10px; border-left: 1px solid rgba(255, 255, 255, .22); color: rgba(255, 255, 255, .86); font-size: 13px; }
  .vp-sbf { display: block; flex: none; border-radius: 8px; background-color: #111; background-repeat: no-repeat; box-shadow: 0 0 0 1px rgba(255, 255, 255, .16); }

  /* —— 底栏上沿：卡顿提示（居中）/ 续播（左） —— */
  .vp-low { position: absolute; left: 50%; bottom: calc(var(--vw-bottom, 96px) + 12px); transform: translateX(-50%); animation: vpPillIn var(--mo-quick) var(--ea-decel); }
  .vp-low.left { left: 16px; transform: none; }
  .vp-pillbtn { border: 0; font: inherit; font-size: 13px; cursor: pointer; min-height: 36px; }
  .vp-wrap.touch .vp-pillbtn { min-height: 44px; padding-left: 16px; padding-right: 16px; }
  .vp-pillbtn:active { opacity: .8; }
  .vp-lock { position: absolute; left: 50%; bottom: max(28px, var(--sab, 0px)); transform: translateX(-50%); animation: vpPillIn var(--mo-quick) var(--ea-decel); }
  .vp-lock .vp-pillbtn { min-height: 44px; padding: 0 18px; }
  .vp-pipnote { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 10px; color: rgba(255, 255, 255, .6); font-size: 13px; pointer-events: none; }

  /* 原生画中画（apk 整个 WebView 缩成小窗）：只留画面与字幕 */
  .vp-wrap.pipn :global(.vw-state), .vp-wrap.pipn .vp-low, .vp-wrap.pipn .vp-end { display: none; }

  /* —— 底栏内容（容器、渐变、显隐由外框 .vw-bottom 给）—— */
  .vp-bar { display: flex; flex-direction: column; padding-inline: env(safe-area-inset-left, 0px) env(safe-area-inset-right, 0px); }
  .vp-row { display: flex; align-items: center; gap: 2px; min-width: 0; }
  /* 播放器这一族图标是「实心块 + 线」：线条描边提到 2，和实心的播放 / 暂停一样重（自带 stroke-width 的细节不受影响）。
     电脑：按钮 40、图标 24（外框通用的 32 / 18 压在大画面上太小太细）；触屏图标 24 */
  .vp-bar :global(.vw-btn .vw-ic) { --s: 24px; }
  .vp-bar :global(.vw-btn .vw-ic svg) { stroke-width: 2; }
  .vp-bar :global(.vw-btn .vw-ic) { filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, .35)); }
  .vp-bar.fine { padding-inline: 4px; }
  .vp-bar.fine .vp-row { gap: 2px; margin-top: 4px; }
  .vp-bar.fine :global(.vw-btn) { width: 40px; height: 40px; border-radius: 10px; }
  .vp-sp { flex: 1; min-width: 4px; }
  .vp-bar :global(.vp-rail) { margin: 0 2px; }
  .vp-railk { display: contents; }
  /* 触屏拖进度：上面那排按钮淡出，时间气泡 / 缩略帧抬到整个底栏内容之上（轨道中线往上 = 半条轨 22 + 按钮排 44 + 8） */
  .vp-bar:not(.fine) .vp-row { transition: opacity var(--mo-quick) var(--ea-fade); }
  .vp-bar.scrub .vp-row { opacity: 0; pointer-events: none; }
  .vp-bar:not(.fine) :global(.vp-rail .vw-tipbox), .vp-bar:not(.fine) :global(.vp-rail .vw-bubble) { bottom: 74px; }
  .vp-sbf + :global(.vp-chap) { margin-top: -2px; }
  .vp-bar :global(.vp-chap) { font-size: 12px; font-weight: 600; color: #fff; text-shadow: 0 1px 2px rgba(0, 0, 0, .7); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .vp-time { display: inline-flex; align-items: center; gap: 0; height: 32px; padding: 0 8px; border: 0; border-radius: 8px; background: none; cursor: pointer;
    color: #fff; font: inherit; font-size: 14px; font-variant-numeric: tabular-nums; text-shadow: 0 1px 2px rgba(0, 0, 0, .5); white-space: nowrap; min-width: 0; }
  .vp-time em { font-style: normal; color: rgba(255, 255, 255, .6); margin-left: 3px; }
  .vp-tchap { margin-left: 8px; color: rgba(255, 255, 255, .85); overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
  @media (hover: hover) { .vp-time:hover { background: var(--vw-hover); } }
  .vp-time:focus-visible { outline: 1.5px solid var(--vw-fg-3); outline-offset: -1.5px; }
  .vp-bar:not(.fine) .vp-time { height: 44px; padding-left: 6px; }

  /* 音量：滑块槽常驻 64px、未展开时透明；后面的时间组用 transform 左移补位（不动 width） */
  .vp-vol { position: relative; z-index: 1; display: flex; align-items: center; flex: none; pointer-events: none; }
  /* 收起时滑条槽仍占 64px、压在左移过来的时间钮上：外框不吃指针，只有喇叭钮与展开后的槽吃 */
  .vp-vol > .vw-btn { pointer-events: auto; }
  .vp-vol-slot { width: 64px; padding: 0 6px 0 2px; opacity: 0; pointer-events: none; transition: opacity var(--mo-quick) var(--ea-fade); }
  .vp-vol.open .vp-vol-slot { opacity: 1; pointer-events: auto; }
  .vp-tgroup { display: flex; align-items: center; min-width: 0; transition: transform var(--mo-quick) var(--ea-std); }
  .vp-tgroup.shift { transform: translateX(-64px); }

  /* 字幕钮：开着时图标下方一道短白线（.vw-btn.on 的强调色就是白，看不出来） */
  .vp-cc { position: relative; }
  .vp-cc i { position: absolute; left: 50%; bottom: 3px; width: 14px; height: 2px; margin-left: -7px; border-radius: 1px; background: #fff;
    transform: scaleX(0); transition: transform var(--mo-micro) var(--ea-std); }
  .vp-cc.cc-on i { transform: scaleX(1); }
  :global(.vw-touch) .vp-cc i { bottom: 6px; }
  .vp-bar.fine .vp-cc i { bottom: 5px; width: 16px; margin-left: -8px; }
</style>
