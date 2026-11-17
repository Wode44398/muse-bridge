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
  // 手机：轻点显隐（3s 自动藏）、中央 ±10s 与大播放钮（液态玻璃）；双击左右三分之一 ±10s（连击累计；对应那颗 ±10 钮
  //   原地长成一枚玻璃胶囊：圆环转一圈、旁边报累计秒数）；
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
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { hasBlob, resolveSrc } from '../../lib/mediaCache.js';
  import { mediaFallbackUrl } from '../../lib/server.js';
  import { createMsePump, isMseSupported } from '../../lib/msePump.js';
  import { pointer } from '../../lib/layout.svelte.js';
  import { t, tc } from '../../lib/i18n.js';
  import { cloudMediaUrl } from '../../lib/preview.svelte.js';
  import { localTierUrl, localVer } from '../../lib/localfs.js';
  import { chapterAt, clampRate, fmtTime, loadAvPrefs, resumeStore, saveAvPrefs, wheelStep } from '../../lib/avUtil.js';
  import { claimSession, screenAwake } from '../../lib/avSession.js';
  import { useViewer } from './kit/context.js';
  import ViewerState from './kit/ViewerState.svelte';
  import ViewerSlider from './kit/ViewerSlider.svelte';
  import VIcon from './kit/VIcon.svelte';
  import { tip } from './kit/tooltip.js';
  import { clusterGlass, pillGlass } from './kit/clusterGlass.js';
  import { createVideoSubs } from './video/videoSubs.svelte.js';
  import { createVideoFs } from './video/videoFs.svelte.js';
  import { createVideoGear } from './video/videoGear.svelte.js';
  import { createVideoKeys } from './video/videoKeys.svelte.js';
  import { createVideoTouch } from './video/videoTouch.svelte.js';

  let { item, active = true } = $props();
  const viewer = useViewer();
  const touch = $derived(viewer.inShell ? viewer.touch : !pointer.fine);
  // P：本组件状态与动作的视图（getter / setter 直通这里的 $state 与模块脚本里的接力变量），交给拆出去的逻辑模块（preview/video/*.svelte.js）；
  // 模块各自的状态与动作建好后也挂到 P 上（expose），彼此都经 P 互相够得着。模块按原来的位置创建，效果的先后不变。
  const P = {
    get AS() { return AS; },
    // 入参只给读口：配了写口 Svelte 会把它按「组件内可写」编译，组件销毁后读到的就是旧值而不是父组件的当前值
    get active() { return active; },
    get api() { return api; },
    get applyRate() { return applyRate; },
    get armHide() { return armHide; },
    get baseRate() { return baseRate; }, set baseRate(v) { baseRate = v; },
    get chapters() { return chapters; },
    get dead() { return dead; }, set dead(v) { dead = v; },
    get doSkip() { return doSkip; },
    get effCur() { return effCur; },
    get effDur() { return effDur; },
    get ended() { return ended; }, set ended(v) { ended = v; },
    get errored() { return errored; }, set errored(v) { errored = v; },
    get fader() { return fader; },
    get flash() { return flash; },
    get frameStep() { return frameStep; },
    get fsCarry() { return fsCarry; }, set fsCarry(v) { fsCarry = v; },
    get fsLeaveSystem() { return fsLeaveSystem; },
    get haptic() { return haptic; },
    get hasAudio() { return hasAudio; },
    get inChip() { return inChip; },
    get item() { return item; },
    get loop() { return loop; }, set loop(v) { loop = v; },
    get lp2x() { return lp2x; }, set lp2x(v) { lp2x = v; },
    get lpT() { return lpT; }, set lpT(v) { lpT = v; },
    get meta() { return meta; }, set meta(v) { meta = v; },
    get muted() { return muted; }, set muted(v) { muted = v; },
    get osd() { return osd; }, set osd(v) { osd = v; },
    get pause() { return pause; },
    get pipAutoOwner() { return pipAutoOwner; }, set pipAutoOwner(v) { pipAutoOwner = v; },
    get play() { return play; },
    get playing() { return playing; }, set playing(v) { playing = v; },
    get qualityNow() { return qualityNow; },
    get rateLabel() { return rateLabel; },
    get resume() { return resume; },
    get rkey() { return rkey; },
    get scrubEnd() { return scrubEnd; },
    get scrubInput() { return scrubInput; },
    get scrubStart() { return scrubStart; },
    get seekTo() { return seekTo; },
    get setQuality() { return setQuality; },
    get setRate() { return setRate; },
    get setVolume() { return setVolume; },
    get showControls() { return showControls; },
    get showOsd() { return showOsd; },
    get skipSide() { return skipSide; }, set skipSide(v) { skipSide = v; },
    get smoothHint() { return smoothHint; }, set smoothHint(v) { smoothHint = v; },
    get srv() { return srv; },
    get started() { return started; }, set started(v) { started = v; },
    get toggleMute() { return toggleMute; },
    get togglePlay() { return togglePlay; },
    get touch() { return touch; },
    get userPaused() { return userPaused; }, set userPaused(v) { userPaused = v; },
    get vh() { return vh; }, set vh(v) { vh = v; },
    get videoEl() { return videoEl; }, set videoEl(v) { videoEl = v; },
    get viewer() { return viewer; },
    get volIcon() { return volIcon; },
    get volume() { return volume; }, set volume(v) { volume = v; },
    get vw() { return vw; }, set vw(v) { vw = v; },
  };
  const expose = (o) => Object.defineProperties(P, Object.getOwnPropertyDescriptors(o));
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

  // —— 卡顿提示（原画喂不动时建议切到流畅画质）——
  // 只认「播着播着自己停下来等数据」：自己跳出来的等待（拖进度 / 跳转 / 换画质 / 跳完头几秒 / 长按 2 倍速）不算，
  // 一闪而过的（不到 STALL_MIN）也不算。STALL_WIN 内记满 3 次，或者一次卡住超过 STALL_LONG，才提示。
  // 提示露 10 秒自己收（还卡着就留到恢复）；同一个视频最多提示 2 次、两次至少隔 HINT_GAP——不理它就别再催。
  const STALL_MIN = 600, STALL_LONG = 6000, STALL_WIN = 60000, SEEK_GRACE = 4000, HINT_GAP = 180000;
  let smoothHint = $state(false);
  let stallT = null, stallAt = 0, stalls = [], seekMark = 0;
  let hintT = null, hintCount = 0, hintAt = 0;
  function offerSmooth() {
    const now = performance.now();
    if (smoothHint || hintCount >= 2 || (hintAt && now - hintAt < HINT_GAP)) return;
    if (!stepOk('smooth-mse') && !stepOk('smooth-src')) return;
    smoothHint = true; hintCount++; hintAt = now; stalls = [];
    clearTimeout(hintT);
    const chk = () => { if (stallAt && loading && !dead) hintT = setTimeout(chk, 3000); else smoothHint = false; };
    hintT = setTimeout(chk, 10000);
  }
  // 一次等待结束（恢复播放 → count=true 记账；暂停 / 跳走了 → 不记）
  function stallEnd(count) {
    clearTimeout(stallT);
    if (!stallAt) return;
    const now = performance.now(), real = now - stallAt >= STALL_MIN;
    stallAt = 0;
    if (!count || !real) return;
    stalls = stalls.filter((x) => now - x < STALL_WIN);
    stalls.push(now);
    if (stalls.length >= 3) offerSmooth();
  }

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
    clearTimeout(stallT); clearTimeout(hintT); smoothHint = false; stallAt = 0; stalls = []; seekMark = performance.now();
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
    (meta ? Promise.resolve() : loadMeta()).then(() => { if (!dead) P.findSubs(); });
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
    if (!resumeChecked) { resumeChecked = true; P.offerResume(); }
  }
  function onLoadedData() { armPoster(true); kickMeta(); liveDone(); }
  function onDur() { if (step !== 'orig-src') return; const d = videoEl?.duration; if (isFinite(d) && d > 0) { metaDur = d; if (videoEl.currentTime > d) { try { videoEl.currentTime = 0; } catch {} } } }
  let lastPos = 0, lastSave = 0;
  function onTime() {
    if (!scrubbing) cur = videoEl?.currentTime || 0;
    onProgress();
    const now = performance.now();
    if (now - lastPos > 1000) { lastPos = now; sess?.position(effDur, effCur, videoEl?.playbackRate || 1); }
    if (playing && now - lastSave > 5000) { lastSave = now; P.saveResume(); }
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
    if (scrubbing || stallAt) return;   // 拖进度时的等待是自己跳出来的，不算「网络喂不动」
    // 原画播着播着停下来等数据 → 开始记一次卡顿（判定见上面「卡顿提示」）。缓存 blob 源不算
    if (qualityNow !== 'orig' || !playing || !item.streamUrl || srcIsBlob || lp2x) return;
    const now = performance.now();
    if (!videoEl || videoEl.seeking || seeking || now - seekMark < SEEK_GRACE) return;
    stallAt = now;
    clearTimeout(stallT); stallT = setTimeout(() => { if (stallAt && loading && !dead) offerSmooth(); }, STALL_LONG);
  }
  function onPlaying() {
    loading = false; playing = true; started = true; ended = false; P.cancelCd();
    stallEnd(true);
    applyRate();
    sess?.playing(true);
    // 控件露着就重新计时；收着的不叫出来（跳转 / 缓冲完恢复播放也会来这里——双击跳转后只该留跳转胶囊。
    // 暂停 → 播放时的计时由外框跟着 autoHide 自己起）
    if (controls) armHide();
  }
  function onPause() {
    if (scrubHeld) return;   // 拖进度时悄悄停的：播放态不变，松手就续播
    stallEnd(false);
    playing = false; sess?.playing(false);
    P.saveResume();
    if (!ended) showControls();
  }
  function onEnded() {
    if (loop) { seekTo(0); videoEl?.play().catch(() => {}); return; }   // 手动循环：MSE 播完回 0 要泵重开流，不能交给 loop 属性
    playing = false; ended = true; sess?.playing(false);
    resume.clear(rkey());
    showControls();
    const nx = P.nextItem;
    if (active && nx && nx.kind === 'video' && !P.cdCancelled) P.startCountdown();
  }
  function onErr() {
    if (!src) return;   // 忽略空 src 的伪 error
    if (step === 'orig-src' && srcIsBlob && !cacheDowngraded) {   // 缓存 blob 坏 → 原始 URL 重试
      cacheDowngraded = true; revoke(); revoke = () => {}; srcIsBlob = false; src = rawUrl(); return;
    }
    failStep(step);
  }
  function onSeeking() { seeking = true; seekMark = performance.now(); stallEnd(false); }
  function onSeeked() { seeking = false; seekMark = performance.now(); onProgress(); liveDone(); }
  let seeking = $state(false);
  function onVolume() { if (!videoEl) return; volume = Math.round(videoEl.volume * 100) / 100; muted = videoEl.muted; }

  function play() { const v = videoEl; if (!v) return; if (ended) { P.replay(); return; } userPaused = false; v.play().catch(() => showControls()); }
  function pause() { const v = videoEl; if (!v) return; userPaused = true; v.pause(); }
  function togglePlay() { const v = videoEl; if (!v) return; if (v.paused || ended) play(); else pause(); }

  function seekTo(sec) {
    sec = Math.max(0, Math.min(effDur || 0, sec));
    if (!videoEl) return;
    seekMark = performance.now();
    if (ended && sec < (effDur || 0) - 0.5) { ended = false; P.cancelCd(); }
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
    scrubbing = true; scrubT = v; P.wantStoryboard();
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
    if (a?.getAttribute?.('role') !== 'slider' || P.wrap?.ownerDocument !== a.ownerDocument) return;
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

  // —— 状态气泡（按键反馈，YouTube 顶部那颗）/ 中央播放暂停闪烁 ——
  let osd = $state(null), osdT = null, osdSeq = 0;
  function showOsd(icon, text) { osd = { icon, text, id: ++osdSeq }; clearTimeout(osdT); osdT = setTimeout(() => (osd = null), 800); }
  let flashUi = $state(null), flashT = null;
  function flash(icon) { flashUi = { icon, id: ++osdSeq }; clearTimeout(flashT); flashT = setTimeout(() => (flashUi = null), 500); }

  // —— 跳转反馈（双击两侧 / 点 ±10 钮 / 方向键 / 进度轨滚轮）——
  // 对应那一侧的 ±10 钮原地「长出一截」变成胶囊：圆环箭头顺着方向转一圈，旁边报累计秒数；连着跳就累加——
  // 圆环再转一圈、数字翻一下、胶囊鼓一下。胶囊就摆在那颗钮的位置上：控件露着时是按钮自己在回应，
  // 控件收着时（双击）只有它一个露出来。最后一跳 800ms 后收起。
  // 触屏上胶囊垫液态玻璃（kit/clusterGlass.js 的 pillGlass，只在露着时挂），电脑上是扁平深色胶囊。
  // 两段式显隐：show = 节点挂着，on = 露着。收起时先 on = false 让它（连玻璃）淡出，再卸节点
  function fader(ms = 260) {
    let show = $state(false), on = $state(false), tm = null;
    return {
      get show() { return show; },
      get on() { return on; },
      set(v) {
        clearTimeout(tm);
        if (v) { show = true; on = true; }
        else if (on || show) { on = false; tm = setTimeout(() => { if (!dead) show = false; }, ms); }
      },
      kill() { clearTimeout(tm); },
    };
  }
  const chip = { l: fader(), r: fader() };
  let chipAmt = $state({ l: 10, r: 10 });   // 胶囊上报的累计秒数（淡出那一下还留着）
  let chipN = $state({ l: 0, r: 0 });       // 每跳一次 +1：圆环重转一圈、胶囊鼓一下
  let skipSide = '', skipTimer = null;      // 正在累计的那一侧（'' = 没有）
  function doSkip(side, sec = 10) {
    if (!effDur) return;
    const more = skipSide === side;
    if (!more && skipSide) chip[skipSide].set(false);
    chipAmt[side] = more ? chipAmt[side] + sec : sec;
    chipN[side]++;
    skipSide = side; chip[side].set(true);
    seekBy(side === 'r' ? sec : -sec);
    if (touch) haptic('tick');
    clearTimeout(skipTimer); skipTimer = setTimeout(endSkip, 800);
  }
  function endSkip() {
    clearTimeout(skipTimer);
    if (skipSide) { chip[skipSide].set(false); skipSide = ''; }
  }
  // 点中央 ±10 钮：跳转，并给控件续上计时（连着点的时候别中途收走）。
  // 例外：双击两侧时第一下把控件叫了出来，第二下可能正落在这颗钮上（内核会把点在按钮边上的触点吸到按钮上）——
  // 那是双击，照双击办：控件收回去，只留胶囊
  function clusterSkip(side, e) {
    const dbl = P.lastTap.side === side && e.timeStamp - P.lastTap.t < 300;
    doSkip(side);
    if (dbl) { P.lastTap.t = 0; viewer.chrome.hide(); } else armHide();
  }
  // 累计中点在胶囊上也算「接着跳」（横屏时胶囊在中间三分之一里，不在双击的那一侧）
  function inChip(x, y) {
    const r = skipSide ? P.stage?.querySelector('.vp-chip.' + skipSide)?.getBoundingClientRect() : null;
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  expose(createVideoSubs(P));
  expose(createVideoFs(P));
  expose(createVideoGear(P));
  expose(createVideoKeys(P));
  // —— 向外框声明 ——
  $effect(() => {
    if (!active) return;
    const err = errored, lk = P.locked;
    return viewer.declare({
      autoHide: () => (playing && !scrubbing && !ended) || P.locked || P.pipNative,
      autoHideMs: () => (touch ? 3000 : 2500),
      arrowKbd: ['PgUp', 'PgDn'],
      seekKeys: true,                    // ←/→/Home/End 归播放器（±10s / 回开头 / 到结尾），混排画廊里也一样；换文件用 PgUp / PgDn
      soloBottom: true,                  // 底栏只放播放条：混排画廊的缩略图条不叠在进度条下面
      barNav: () => touch,               // 触屏横滑是拖进度，换文件走顶栏的上一个 / 下一个
      keys: P.onKeys,
      onBack: P.onBack,
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
    const cp = viewer.canPrev, cn = P.nextVidIdx >= 0, art = poster, title = item.name;
    const s = claimSession({ title, artwork: art || '' }, {
      play: () => play(), pause: () => pause(),
      seekbackward: (d) => seekBy(-(d?.seekOffset || 10)),
      seekforward: (d) => seekBy(d?.seekOffset || 10),
      seekto: (d) => { if (d && Number.isFinite(d.seekTime)) seekTo(d.seekTime); },
      previoustrack: cp ? () => viewer.prev() : null,
      nexttrack: cn ? () => P.goNextVid() : null,
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
  $effect(() => { if (!active) untrack(() => { P.cancelCd(); try { if (videoEl && !videoEl.paused) videoEl.pause(); } catch {} }); });

  // src 就绪后尝试自动播放（失败=移动端策略，留暂停态+控件，用户点播放）
  $effect(() => {
    const s = src, v = videoEl;
    if (!s || !v || !active) return;
    untrack(() => { if (userPaused || ended || scrubHeld) return; v.play().catch(() => { showControls(); }); });
  });

  expose(createVideoTouch(P));
  onMount(() => {
    P.selfPage = !viewer.inShell || !!P.wrap?.parentElement?.classList.contains('vw-page');
    // 全屏接力：上一个实例留下的全屏（全屏里换了视频）直接认领；或者它刚把预览从内嵌宿主抬上来、等这边进全屏
    if (active) {
      const kept = fsTake(), c = fsCarry;
      fsCarry = null;
      if (kept) { P.fsMode = kept; P.fsReq = kept === 'web'; }
      else if (c && Date.now() - c.at < 3000) { if (!vw && c.vw) { vw = c.vw; vh = c.vh; } P.enterFs(); }
    }
    const onVis = () => { if (document.visibilityState === 'hidden') P.saveResume(); };
    document.addEventListener('fullscreenchange', P.onFsChange);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', P.saveResume);
    window.addEventListener('bridge-pip', P.onBridgePip);
    return () => {
      document.removeEventListener('fullscreenchange', P.onFsChange);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', P.saveResume);
      window.removeEventListener('bridge-pip', P.onBridgePip);
    };
  });
  // 网页画中画进出（<video> 事件；apk 原生画中画走 bridge-pip）
  $effect(() => {
    const v = videoEl; if (!v) return;
    const on = () => (P.pipOn = true), off = () => (P.pipOn = false);
    v.addEventListener('enterpictureinpicture', on); v.addEventListener('leavepictureinpicture', off);
    return () => { v.removeEventListener('enterpictureinpicture', on); v.removeEventListener('leavepictureinpicture', off); };
  });
  onDestroy(() => {
    P.saveResume();
    // 接力：留下停在哪、是不是用户自己暂停的（新实例 4 秒内认领，见 load 那段 $effect）。
    // 只在预览还开着时留（换宿主 / 重排；认领时再核对是不是同一个文件）；关掉查看器再重开不算接力，照常出「从 x:xx 继续」。
    // 销毁回调里读响应式状态拿到的是变更前的旧值，所以问 previewIsOpen()（普通变量）
    const open = previewIsOpen();
    relay = open && (started || effCur > 0.3) && !ended && !errored ? { key: rkey(), t: effCur, paused: userPaused, at: Date.now() } : null;
    dead = true;
    liveReset();
    if (P.g) { P.g = null; P.listen(false); }
    P.dragAnim?.cancel(); P.dragAnim = null;
    clearTimeout(lpT); clearTimeout(skipTimer); clearTimeout(stallT); clearTimeout(hintT); clearTimeout(osdT); clearTimeout(flashT);
    chip.l.kill(); chip.r.kill(); P.hint.kill();
    clearTimeout(P.resumeT); clearTimeout(P.lockT); clearTimeout(P.levelT); clearTimeout(volT); clearTimeout(metaT); clearTimeout(posterT); clearInterval(P.cdT);
    if (P.fsMode) {
      // 全屏里换到另一个视频（查看器还开着）：全屏留给随后挂上的新实例认领，1.5 秒没人认领（下一项不是视频）再退；
      // 查看器关了就当场退出
      const m = P.fsMode;
      if (open) { P.fsMode = ''; P.resetBright(); fsHold(m); } else P.exitFs();
    } else P.resetBright();
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
  const clusterVis = $derived(clusterOn && !scrubbing && !ended && !lp2x && !P.seekUi && !P.locked && !P.pipNative);
</script>

<!-- 进度轨悬停 / 拖动气泡上方：storyboard 缩略帧 + 章节名 -->
{#snippet railTip(v)}
  {#if P.sb}<span class="vp-sbf" style={P.sbStyle(v, 1)}></span>{/if}
  {#if chapters.length}{@const c = chapterAt(chapters, v)}{#if c?.title}<span class="vp-chap">{c.title}</span>{/if}{/if}
{/snippet}

{#snippet rail()}
  <!-- 外包一层只为截方向键（与全局同步长）和滚轮（每格 ±5s）；display:contents 不参与布局 -->
  <div class="vp-railk" role="presentation" onkeydowncapture={railKey} use:wheelStep={wheelSeek}>
    <ViewerSlider class="vp-rail" value={shownT} max={effDur || 0} buffered={bufAbs} label={t('进度')}
      format={fmtTime} hoverFormat={touch ? null : fmtTime} valueText={(v) => fmtTime(v) + ' / ' + fmtTime(effDur)}
      tip={P.hasTip ? railTip : null} {marks} onhover={(v) => { if (v != null) P.wantStoryboard(); }}
      onstart={scrubStart} oninput={scrubInput} onchange={scrubEnd} onend={blurSlider} disabled={!effDur} />
  </div>
{/snippet}

{#snippet timeBtn()}
  <button type="button" class="vp-time" onclick={() => (remain = !remain)} aria-label={remain ? t('显示已播放时间') : t('显示剩余时间')}>
    <span class="vp-tnow">{timeText}</span><em> / {fmtTime(effDur)}</em>
    {#if chapterNow?.title && !touch}<span class="vp-tchap">· {chapterNow.title}</span>{/if}
  </button>
{/snippet}

<!-- 跳转胶囊（s = 'l' | 'r'）：圆环本体 + 累计秒数；摆在对应那颗 ±10 钮的位置上，往外长一截 -->
{#snippet skipChip(s)}
  {#if chip[s].show}
    <div class="vp-chip {s}" class:on={chip[s].on} data-skip={s} aria-hidden="true"
      use:pillGlass={{ on: chip[s].on && !viewer.closing && !P.pipNative, glass: touch, beat: chipN[s] }}>
      {#key chipN[s]}<span class="vp-chip-ic"><VIcon name={s === 'l' ? 'skipBack' : 'skipFwd'} size={36} stroke={1.5} /></span>{/key}
      <span class="vp-chip-t">{#key chipAmt[s]}<b>{chipAmt[s]}</b>{/key}<em>{t('秒')}</em></span>
    </div>
  {/if}
{/snippet}

{#snippet subsBtn()}
  {#if P.subTracks.length}
    <button type="button" class="vw-btn vp-cc" class:cc-on={P.subIdx >= 0} onclick={P.toggleSubs} use:tip={{ label: P.subIdx >= 0 ? t('关闭字幕') : t('字幕'), kbd: 'C' }}>
      <VIcon name="subtitles" /><i></i>
    </button>
  {/if}
{/snippet}

{#snippet gearBtn()}
  <button type="button" class="vw-btn vp-gear" class:open={P.gearOpen} bind:this={P.gearEl} onclick={P.onGear} use:tip={t('设置')} aria-haspopup="menu" aria-expanded={P.gearOpen}>
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
        {#if P.nextItem}
          <button type="button" class="vw-btn" onclick={(e) => { dropFocus(e); P.goNextVid(); }} use:tip={{ label: t('下一个'), kbd: 'Shift+N' }}><VIcon name="nextTrack" /></button>
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
        {#if P.pipOk}
          <button type="button" class="vw-btn" class:open={P.pipOn} onclick={(e) => { dropFocus(e); P.togglePip(); }} use:tip={{ label: t('画中画'), kbd: 'I' }}><VIcon name="pip" /></button>
        {/if}
        <button type="button" class="vw-btn" onclick={(e) => { dropFocus(e); P.toggleFs(); }} use:tip={{ label: P.fsOn ? t('退出全屏') : t('全屏'), kbd: 'F' }}>
          <VIcon name={P.fsOn ? 'exitFullscreen' : 'fullscreen'} />
        </button>
      </div>
    {:else}
      <div class="vp-row">
        {@render timeBtn()}
        <span class="vp-sp"></span>
        {@render subsBtn()}
        {@render gearBtn()}
        {#if P.pipOk && !P.fsOn}
          <button type="button" class="vw-btn" onclick={P.togglePip} aria-label={t('画中画')}><VIcon name="pip" /></button>
        {/if}
        {#if P.fsOn}
          <button type="button" class="vw-btn" onclick={P.lock} aria-label={t('锁定')}><VIcon name="lock" /></button>
        {/if}
        <button type="button" class="vw-btn" onclick={P.toggleFs} aria-label={P.fsOn ? t('退出全屏') : t('全屏')}>
          <VIcon name={P.fsOn ? 'exitFullscreen' : 'fullscreen'} />
        </button>
      </div>
      {@render rail()}
    {/if}
  </div>
{/snippet}

<div class="vp-wrap" class:touch class:nocur class:lift={!!P.drag && !P.selfPage} class:pipn={P.pipNative} bind:this={P.wrap}
  style:transform={P.drag ? (P.selfPage ? `translate3d(0,${P.drag.y}px,0)` : `translate3d(${P.drag.x}px,${P.drag.y}px,0) scale(${P.drag.k})`) : null}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="vp-stage" bind:this={P.stage} role="presentation" onpointerdown={P.stageDown} onclick={P.stageClick}
      style:touch-action="none">
      <!-- data-noheal：播放器有自己的回退链（runStep），全局 mediaHeal 别再并行改 src。出错时也一直挂着，重试才有元素可用 -->
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={videoEl} class="vp-video" src={src || undefined} poster={posterShown || undefined} data-noheal
        playsinline preload="metadata" style:filter={P.bright < 1 && !P.nativeBright() ? `brightness(${P.bright})` : null}
        onloadedmetadata={onLoadedMeta} onloadeddata={onLoadedData} ondurationchange={onDur} ontimeupdate={onTime} onprogress={onProgress}
        onwaiting={onWaiting} onplaying={onPlaying} onplay={() => { ended = false; }} onpause={onPause} onended={onEnded} onerror={onErr}
        onseeking={onSeeking} onseeked={onSeeked} onvolumechange={onVolume}></video>

      <!-- 字幕：控件出来时整体上移让出底栏 -->
      {#if P.subLines.length && !errored}
        <div class="vp-subs" class:up={controls && !P.locked && !P.pipNative} class:scrub={scrubbing} aria-live="off">
          {#each P.subLines as line, i (i)}<span>{line}</span>{/each}
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

      {#if P.pipOn && !errored}
        <div class="vp-pipnote"><VIcon name="pip" size={28} /><span>{t('正在画中画中播放')}</span></div>
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
      {#if P.levelUi}
        <div class="vp-top"><span class="vw-pill vp-level"><VIcon name={P.levelUi.kind === 'bright' ? 'brightness' : P.levelUi.v === 0 ? 'mute' : 'volumeHigh'} size={18} />
          <i class="vp-level-bar"><i style:transform="scaleX({P.levelUi.v})"></i></i></span></div>
      {/if}

      <!-- 中央播放 / 暂停闪烁（电脑单击 / 空格） -->
      {#if flashUi}
        {#key flashUi.id}<div class="vp-flash"><VIcon name={flashUi.icon} size={30} /></div>{/key}
      {/if}

      <!-- 横向拖动 seek：画面实时跟着走，顶部一枚胶囊报目标时间与偏移 -->
      {#if P.seekUi}
        <div class="vp-top still"><span class="vw-pill vp-seek">
          <b>{fmtTime(P.seekUi.t)}</b><em>/ {fmtTime(effDur)}</em><i>{P.seekUi.d >= 0 ? '+' : '−'}{fmtTime(Math.abs(P.seekUi.d))}</i>
        </span></div>
      {/if}

      <!-- 续播 -->
      {#if P.resumeUi && !errored && !ended}
        <div class="vp-low left"><button type="button" class="vw-pill vp-pillbtn" onclick={P.doResume}><VIcon name="play" size={16} />{t('从 {t} 继续', { t: fmtTime(P.resumeUi.t) })}</button></div>
      {/if}

      <!-- 播完：重播 / 下一个倒计时 -->
      {#if ended && !errored}
        <div class="vp-end" class:cd={P.nextCd > 0 && !!P.nextItem}>
          {#if P.nextCd > 0 && P.nextItem}
            <div class="vp-next" role="status">
              <span class="vp-next-k">{t('接下来')}</span>
              <span class="vp-next-n">{P.nextItem.name}</span>
              <span class="vp-next-c">{t('{n} 秒后播放', { n: P.nextCd })}</span>
              <span class="vp-next-a">
                <button type="button" class="vw-pbtn" onclick={() => P.cancelCd(true)}>{t('取消')}</button>
                <button type="button" class="vw-pbtn pri" onclick={P.goNext}>{t('立即播放')}</button>
              </span>
            </div>
          {:else}
            <button type="button" class="vp-big" onclick={P.replay} use:tip={t('重播')}><VIcon name="replay" size={34} /></button>
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
        <!-- 跳转胶囊露着的那一侧：这颗钮的图标和玻璃先让出来（胶囊的圆环就画在同一个位置上），按钮本身照样能点 -->
        <div class="vp-cluster" class:hide={!clusterVis} use:clusterGlass={{ on: clusterVis && !viewer.closing, mute: chip.l.on ? 'l' : chip.r.on ? 'r' : '' }}>
          <button type="button" class="vp-cbtn" class:ghost={chip.l.on} data-glass="l" onclick={(e) => clusterSkip('l', e)} aria-label={t('快退 10 秒')} tabindex={clusterVis ? 0 : -1}><VIcon name="skipBack10" size={36} stroke={1.5} /></button>
          <button type="button" class="vp-cbtn main" data-glass="m" class:busy={showSpin} onclick={togglePlay} aria-label={playing ? t('暂停') : t('播放')} tabindex={clusterVis ? 0 : -1}>
            <VIcon name={playing ? 'pause' : 'play'} size={34} />
          </button>
          <button type="button" class="vp-cbtn" class:ghost={chip.r.on} data-glass="r" onclick={(e) => clusterSkip('r', e)} aria-label={t('快进 10 秒')} tabindex={clusterVis ? 0 : -1}><VIcon name="skipFwd10" size={36} stroke={1.5} /></button>
        </div>
      {/if}

      <!-- 跳转胶囊（双击两侧 / 点 ±10 钮 / 方向键） -->
      {#if !errored}
        {@render skipChip('l')}
        {@render skipChip('r')}
      {/if}

      <!-- 卡顿提示：建议切到流畅画质（整枚可点） -->
      {#if P.hint.show}
        <button type="button" class="vp-hint" class:on={P.hint.on} onclick={() => setQuality('smooth')}
          use:pillGlass={{ on: P.hint.on && !viewer.closing, glass: touch }}>
          <span class="vp-hint-a">{t('当前网络较慢')}</span><span class="vp-hint-b">{t('切换到流畅画质')}</span>
        </button>
      {/if}

      <!-- 锁屏：点一下露出解锁钮 -->
      {#if P.locked && P.lockUi}
        <div class="vp-lock"><button type="button" class="vw-pill vp-pillbtn" onclick={P.unlock}><VIcon name="unlock" size={18} />{t('点按解锁')}</button></div>
      {/if}
  </div>
</div>

<style>
  .vp-wrap { position: absolute; inset: 0; background: #000; container-type: size; }
  /* 混排画廊里下滑缩小：黑底与画面外的黑边透明，只剩画面本身跟手（同画廊里的图片） */
  .vp-wrap.lift, .vp-wrap.lift .vp-video { background: transparent; }
  .vp-wrap.nocur, .vp-wrap.nocur * { cursor: none; }
  /* --vp-gap：中央三钮的间距（跳转胶囊按它算出 ±10 钮的位置） */
  .vp-stage { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; --vp-gap: clamp(28px, 12cqw, 64px); }
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
  .vp-cluster { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: var(--vp-gap); pointer-events: none; }
  .vp-cluster:not(.hide) .vp-cbtn { pointer-events: auto; }
  .vp-cbtn { position: relative; width: 52px; height: 52px; border: 0; padding: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    color: #fff; background: rgba(22, 22, 24, .38); box-shadow: inset 0 0 0 .5px rgba(255, 255, 255, .22), inset 0 1px 0 rgba(255, 255, 255, .18);
    -webkit-backdrop-filter: blur(14px) saturate(1.5); backdrop-filter: blur(14px) saturate(1.5); -webkit-tap-highlight-color: transparent;
    transition: opacity var(--mo-quick) var(--ea-fade), transform 240ms cubic-bezier(.2, .8, .2, 1); }
  .vp-cbtn.main { width: 68px; height: 68px; }
  .vp-cbtn :global(.vw-ic) { filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .28)); transition: opacity var(--mo-quick) var(--ea-fade); }
  /* 被跳转胶囊接管的那颗：图标当场让出（胶囊的圆环在同一个位置接上），胶囊收起时再淡回来 */
  .vp-cbtn.ghost :global(.vw-ic) { opacity: 0; transition-duration: 0s; }
  .vp-cluster:global(.glass) .vp-cbtn { background: none; box-shadow: 0 6px 22px rgba(0, 0, 0, .16); -webkit-backdrop-filter: none; backdrop-filter: none; }
  .vp-cluster.hide .vp-cbtn { opacity: 0; -webkit-backdrop-filter: none; backdrop-filter: none; }
  .vp-cbtn.busy :global(.vw-ic) { opacity: 0; }
  .vp-cbtn:active { transform: scale(1.08); }

  /* 中央闪烁 */
  .vp-flash { position: absolute; left: 50%; top: 50%; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .5); color: #fff; pointer-events: none;
    animation: vpFlash var(--mo-page) var(--ea-out) forwards; }
  @keyframes vpFlash { from { opacity: 1; transform: scale(.85); } to { opacity: 0; transform: scale(1.35); } }

  /* —— 跳转胶囊：摆在对应那颗 ±10 钮的位置上、往外长一截（52 高，圆环那头和按钮重合）——
     触屏垫液态玻璃（pillGlass 生效时带 .glass、自己不画底），电脑 / 不支持的内核是扁平深色胶囊。
     露出来不淡入（圆环要和那颗钮的图标当场接上），收起时淡出；字从圆环那头滑出来，数字每跳一次从下面翻上来 */
  .vp-chip { position: absolute; top: calc(50% - 26px); width: max-content; height: 52px; display: flex; align-items: center; border-radius: 26px;
    color: #fff; white-space: nowrap; pointer-events: none; background: var(--vw-pill-bg); opacity: 0; transition: opacity var(--mo-quick) var(--ea-fade); }
  .vp-chip.r { left: calc(50% + 34px + var(--vp-gap)); padding-right: 17px; }
  .vp-chip.l { right: calc(50% + 34px + var(--vp-gap)); padding-left: 17px; flex-direction: row-reverse; }
  .vp-chip.on { opacity: 1; transition-duration: 60ms; }
  .vp-chip:global(.glass) { background: none; box-shadow: 0 6px 22px rgba(0, 0, 0, .16); }
  .vp-chip-ic { flex: none; width: 52px; height: 52px; display: flex; align-items: center; justify-content: center; }
  .vp-chip-ic :global(.vw-ic) { filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .28)); }
  /* 圆环 + 箭头绕圆心转一圈（圆心在 24 网格的 12, 12.9，见 lib/viewerIcons.js） */
  .vp-chip-ic :global(.vi-spin) { transform-box: view-box; transform-origin: 12px 12.9px; animation: vpSpinFwd 560ms cubic-bezier(.2, .7, .2, 1) both; }
  .vp-chip.l .vp-chip-ic :global(.vi-spin) { animation-name: vpSpinBack; }
  @keyframes vpSpinFwd { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @keyframes vpSpinBack { from { transform: rotate(0deg); } to { transform: rotate(-360deg); } }
  .vp-chip-t { display: flex; align-items: baseline; gap: 3px; text-shadow: 0 1px 2px rgba(0, 0, 0, .35); animation: vpChipT var(--mo-quick) var(--ea-decel) both; }
  .vp-chip.r .vp-chip-t { margin-left: -5px; --vp-from: -8px; }
  .vp-chip.l .vp-chip-t { margin-right: -5px; --vp-from: 8px; }
  @keyframes vpChipT { from { opacity: 0; transform: translateX(var(--vp-from, 0)); } }
  .vp-chip-t b { display: inline-block; font-size: 17px; font-weight: 600; letter-spacing: -.01em; font-variant-numeric: tabular-nums; animation: vpTick var(--mo-quick) var(--ea-decel) both; }
  .vp-chip-t em { font-style: normal; font-size: 13px; font-weight: 500; color: rgba(255, 255, 255, .72); }
  @keyframes vpTick { from { opacity: 0; transform: translateY(45%); } }

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

  /* —— 卡顿提示：顶栏下方居中一枚胶囊，左半句说现象、右半句是动作，整枚可点。
     放顶上：横屏时画面中间是三钮、下面是字幕和底栏，只有这里空着。触屏垫液态玻璃（同跳转胶囊），电脑是扁平深色胶囊 —— */
  .vp-hint { position: absolute; top: calc(var(--vw-bar-h, 56px) + 10px); left: 0; right: 0; margin-inline: auto; width: max-content; max-width: calc(100% - 24px);
    box-sizing: border-box; min-height: 36px; display: flex; align-items: center; gap: 10px; padding: 0 16px; border: 0; border-radius: 999px;
    font: inherit; font-size: 13px; line-height: 1.35; color: #fff; white-space: nowrap; cursor: pointer; background: var(--vw-pill-bg); -webkit-tap-highlight-color: transparent;
    animation: vpPillIn var(--mo-quick) var(--ea-decel); transition: opacity var(--mo-quick) var(--ea-fade); }
  .vp-hint:not(.on) { opacity: 0; pointer-events: none; }
  .vp-wrap.touch .vp-hint { min-height: 44px; padding: 0 18px; }
  .vp-hint:global(.glass) { background: none; box-shadow: 0 6px 22px rgba(0, 0, 0, .16); text-shadow: 0 1px 2px rgba(0, 0, 0, .35); }
  .vp-hint-a { color: rgba(255, 255, 255, .8); }
  .vp-hint-b { padding-left: 10px; border-left: 1px solid rgba(255, 255, 255, .24); font-weight: 600; }
  .vp-hint:active .vp-hint-b { opacity: .7; }
  .vp-hint:focus-visible { outline: 1.5px solid #fff; outline-offset: 2px; }

  /* —— 底栏上沿：续播（左） —— */
  .vp-low { position: absolute; left: 50%; bottom: calc(var(--vw-bottom, 96px) + 12px); transform: translateX(-50%); animation: vpPillIn var(--mo-quick) var(--ea-decel); }
  .vp-low.left { left: 16px; transform: none; }
  .vp-pillbtn { border: 0; font: inherit; font-size: 13px; cursor: pointer; min-height: 36px; }
  .vp-wrap.touch .vp-pillbtn { min-height: 44px; padding-left: 16px; padding-right: 16px; }
  .vp-pillbtn:active { opacity: .8; }
  .vp-lock { position: absolute; left: 50%; bottom: max(28px, var(--sab, 0px)); transform: translateX(-50%); animation: vpPillIn var(--mo-quick) var(--ea-decel); }
  .vp-lock .vp-pillbtn { min-height: 44px; padding: 0 18px; }
  .vp-pipnote { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 10px; color: rgba(255, 255, 255, .6); font-size: 13px; pointer-events: none; }

  /* 原生画中画（apk 整个 WebView 缩成小窗）：只留画面与字幕 */
  .vp-wrap.pipn :global(.vw-state), .vp-wrap.pipn .vp-low, .vp-wrap.pipn .vp-end, .vp-wrap.pipn .vp-chip, .vp-wrap.pipn .vp-hint { display: none; }

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
