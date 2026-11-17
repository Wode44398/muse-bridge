// 视频播放器（VideoPlayer）的设置齿轮菜单（倍速 / 画质 / 字幕 / 循环 / 下载）、续播提示、播完的下一个倒计时。
// P 是外壳（VideoPlayer.svelte）交出来的状态与动作视图，见那边的 P。
import { t } from '../../../lib/i18n.js';
import { RATES, RESUME_MIN } from '../../../lib/avUtil.js';
import { saveLabel } from '../../../lib/save.js';

export function createVideoGear(P) {
  // —— 设置齿轮（倍速 / 画质 / 字幕 / 循环 / 下载）——
  let gearEl = $state(), gearOpen = $state(false);
  function openGear(items = gearItems, title = '') {
    gearOpen = true;
    P.viewer.openMenu({ anchor: gearEl, place: 'top', items, title, onclose: () => { gearOpen = false; } });
  }
  function onGear() { if (gearOpen) P.viewer.closeMenu(); else openGear(); }
  function gearItems() {
    const dl = P.viewer.canDownload();
    return [
      { id: 'rate', label: t('播放速度'), icon: 'speed', detail: P.rateLabel(P.baseRate), submenu: { title: t('播放速度'), items: rateItems } },
      P.item.streamUrl && { id: 'quality', label: t('画质'), icon: 'quality', detail: P.qualityNow === 'smooth' ? t('流畅') : t('原画'),
        submenu: { title: t('画质'), items: () => [
          { label: t('原画'), note: t('完整分辨率与码率'), checked: P.qualityNow === 'orig', onSelect: () => P.setQuality('orig') },
          { label: t('流畅'), note: t('转码 ≤1080p · 更抗弱网省流量'), checked: P.qualityNow === 'smooth', onSelect: () => P.setQuality('smooth') },
        ] } },
      P.subTracks.length > 0 && { id: 'subs', label: t('字幕'), icon: 'subtitles', detail: P.subIdx >= 0 ? P.subName(P.subIdx) : t('关'),
        submenu: { title: t('字幕'), items: () => [
          { label: t('关'), checked: P.subIdx < 0, onSelect: () => P.selectSub(-1) },
          ...P.subTracks.map((s, i) => ({ label: P.subName(i), checked: P.subIdx === i, onSelect: () => P.selectSub(i) })),
        ] } },
      { id: 'loop', label: t('循环播放'), icon: 'loop', detail: P.loop ? t('开') : t('关'), keepOpen: true, onSelect: () => { P.loop = !P.loop; } },
      dl && { sep: true },
      dl && { id: 'download', label: saveLabel(t('下载')), icon: 'download', onSelect: () => P.viewer.download() },
    ].filter(Boolean);
  }
  function rateItems() {
    const custom = !RATES.includes(P.baseRate);
    return [
      ...RATES.map((r) => ({ label: P.rateLabel(r), checked: r === P.baseRate, onSelect: () => P.setRate(r) })),
      { label: t('自定义'), checked: custom, detail: custom ? P.baseRate + '×' : '', submenu: { title: t('自定义'), items: customItems } },
    ];
  }
  function customItems() {
    return [
      { label: t('当前'), detail: P.baseRate + '×', disabled: true },
      { label: '+0.05', icon: 'plus', keepOpen: true, onSelect: () => bumpRate(0.05) },
      { label: '−0.05', icon: 'minus', keepOpen: true, onSelect: () => bumpRate(-0.05) },
    ];
  }
  // 触屏菜单选完就收（keepOpen 只在电脑生效）：微调后原地再长出来，连点方便
  function bumpRate(d) { P.setRate(P.baseRate + d); if (P.touch) setTimeout(() => { if (!P.dead) openGear(customItems, t('自定义')); }, 60); }

  // —— 续播（按文件记位置，≥30s 才记；打开时出「从 x:xx 继续」，点了才跳）——
  let resumeUi = $state(null), resumeT = null;
  function offerResume() {
    const r = P.resume.get(P.rkey());
    const d = P.effDur || P.videoEl?.duration || 0;
    if (!r || !(r.t >= RESUME_MIN) || (d > 0 && r.t >= d - 10)) return;
    resumeUi = { t: r.t };
    clearTimeout(resumeT); resumeT = setTimeout(() => (resumeUi = null), 8000);
  }
  function doResume() { const x = resumeUi?.t; resumeUi = null; clearTimeout(resumeT); if (x > 0) { P.seekTo(x); P.play(); } }
  function saveResume() { if (!P.started || P.ended) return; const x = P.effCur; if (x >= RESUME_MIN) P.resume.set(P.rkey(), x, P.effDur); }

  // —— 播完：重播 + 下一个视频 5s 倒计时（可取消）——
  // 下一个视频（跳过画廊里夹着的图片 / 文档，最多往后看 200 项）：播完倒计时、底栏「下一个」、Shift+N 都去这条
  const nextVidIdx = $derived.by(() => {
    const n = Math.min(P.viewer.count, P.viewer.index + 201);
    for (let i = P.viewer.index + 1; i < n; i++) if (P.viewer.itemAt(i)?.kind === 'video') return i;
    return -1;
  });
  const nextItem = $derived(nextVidIdx >= 0 ? P.viewer.itemAt(nextVidIdx) : null);
  function goNextVid() { if (nextVidIdx >= 0) P.viewer.go(nextVidIdx); }
  let nextCd = $state(0), cdT = null, cdCancelled = false;
  function startCountdown() {
    nextCd = 5; clearInterval(cdT);
    cdT = setInterval(() => { nextCd -= 1; if (nextCd <= 0) { clearInterval(cdT); cdT = null; goNextVid(); } }, 1000);
  }
  function cancelCd(user = false) { clearInterval(cdT); cdT = null; nextCd = 0; if (user) cdCancelled = true; }
  function goNext() { cancelCd(); goNextVid(); }
  function replay() { P.ended = false; cancelCd(); P.seekTo(0); P.userPaused = false; P.videoEl?.play().catch(() => {}); }


  return {
    get cancelCd() { return cancelCd; },
    get cdCancelled() { return cdCancelled; }, set cdCancelled(v) { cdCancelled = v; },
    get cdT() { return cdT; }, set cdT(v) { cdT = v; },
    get doResume() { return doResume; },
    get gearEl() { return gearEl; }, set gearEl(v) { gearEl = v; },
    get gearOpen() { return gearOpen; }, set gearOpen(v) { gearOpen = v; },
    get goNext() { return goNext; },
    get goNextVid() { return goNextVid; },
    get nextCd() { return nextCd; }, set nextCd(v) { nextCd = v; },
    get nextItem() { return nextItem; },
    get nextVidIdx() { return nextVidIdx; },
    get offerResume() { return offerResume; },
    get onGear() { return onGear; },
    get replay() { return replay; },
    get resumeT() { return resumeT; }, set resumeT(v) { resumeT = v; },
    get resumeUi() { return resumeUi; }, set resumeUi(v) { resumeUi = v; },
    get saveResume() { return saveResume; },
    get startCountdown() { return startCountdown; },
  };
}
