// 视频播放器（VideoPlayer）的键盘快捷键与返回。
// P 是外壳（VideoPlayer.svelte）交出来的状态与动作视图，见那边的 P。
import { t } from '../../../lib/i18n.js';
import { stepRate } from '../../../lib/avUtil.js';
import { isEditable } from '../kit/context.js';

export function createVideoKeys(P) {
  // —— 键盘（先于外框处理；返回 true = 吃掉，外框 preventDefault）——
  function onKeys(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
    if (isEditable(e.target)) return false;
    const k = e.key;
    if ((k === ' ' || k === 'Enter') && e.target?.closest?.('button, a, [role="menuitem"]')) return false;   // 聚焦按钮时空格 = 点它
    if (!P.videoEl || P.errored) {
      if (k === 'PageUp') { P.viewer.prev(); return true; }
      if (k === 'PageDown') { P.viewer.next(); return true; }
      return false;
    }
    switch (k) {
      case ' ': case 'k': case 'K': { const go = P.videoEl.paused || P.ended; P.togglePlay(); P.flash(go ? 'play' : 'pause'); return true; }
      case 'j': case 'J': P.doSkip('l', 10); return true;
      case 'l': case 'L': P.doSkip('r', 10); return true;
      case 'ArrowLeft': P.doSkip('l', e.shiftKey ? 30 : 10); P.armHide(); return true;
      case 'ArrowRight': P.doSkip('r', e.shiftKey ? 30 : 10); P.armHide(); return true;
      case 'ArrowUp': case 'ArrowDown': {
        if (!P.hasAudio) return true;
        P.setVolume((P.muted ? 0 : P.volume) + (k === 'ArrowUp' ? 0.05 : -0.05));
        P.showOsd(P.volIcon, Math.round((P.muted ? 0 : P.volume) * 100) + '%');
        return true;
      }
      case 'm': case 'M': if (P.hasAudio) { P.toggleMute(); P.showOsd(P.volIcon, P.muted ? t('静音') : Math.round(P.volume * 100) + '%'); } return true;
      case 'f': case 'F': P.toggleFs(); return true;
      case 'i': case 'I': if (P.pipOk) P.togglePip(); return true;
      case 'c': case 'C': P.toggleSubs(); return true;
      case 'Home': P.seekTo(0); P.armHide(); return true;
      case 'End': P.seekTo(P.effDur); return true;
      case 'PageUp': P.viewer.prev(); return true;
      case 'PageDown': P.viewer.next(); return true;
      case 'N': if (e.shiftKey) { if (P.nextItem) P.goNextVid(); else P.viewer.next(); return true; } return false;
      case 'P': if (e.shiftKey) { P.viewer.prev(); return true; } return false;
      case '<': case '>': { P.setRate(stepRate(P.baseRate, k === '>' ? 1 : -1)); P.showOsd('speed', P.baseRate + '×'); return true; }
      case ',': case '.': {
        if (e.shiftKey) { P.setRate(stepRate(P.baseRate, k === '.' ? 1 : -1)); P.showOsd('speed', P.baseRate + '×'); return true; }
        if (P.videoEl.paused) { P.frameStep(k === '.' ? 1 : -1); return true; }
        return false;
      }
    }
    if (!e.shiftKey && k >= '0' && k <= '9' && k.length === 1 && P.effDur) { P.seekTo(P.effDur * (+k / 10)); P.armHide(); return true; }
    return false;
  }
  function onBack() {
    if (P.locked) { P.unlock(); return true; }
    if (P.fsOn) { P.exitFs(); return true; }
    return false;
  }


  return {
    get onBack() { return onBack; },
    get onKeys() { return onKeys; },
  };
}
