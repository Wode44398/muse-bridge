// 视频播放器（VideoPlayer）的字幕（同名 .vtt / .srt，自绘）与 storyboard 缩略帧。
// P 是外壳（VideoPlayer.svelte）交出来的状态与动作视图，见那边的 P。
import { t } from '../../../lib/i18n.js';
import { cloudFileUrl } from '../../../lib/preview.svelte.js';
import { localFileUrl, localList } from '../../../lib/localfs.js';
import { cuesAt, decodeSubtitle, parseCues, srtToVtt, storyboardCell } from '../../../lib/avUtil.js';

export function createVideoSubs(P) {
  // —— 字幕：同名 .vtt / .srt（或 名字.语言.srt），默认开第一条；自绘字幕层（不用 <track>，样式与位置自己掌握）——
  let subTracks = $state.raw([]);     // [{ name, lang, ext, url }]
  let subIdx = $state(-1), lastSub = 0;
  let cues = $state.raw([]);
  let cueGen = 0;
  const subLines = $derived(subIdx >= 0 && cues.length ? cuesAt(cues, P.effCur) : []);
  const subName = (i) => { const s = subTracks[i]; return s ? (s.lang || s.name) : ''; };
  function findSubs() {
    if (P.dead) return;
    const st = P.item.saveTarget;
    if (!st?.rel) return;
    const rel = String(st.rel);
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const join = (n) => (dir ? dir + '/' : '') + n;
    let list = [];
    if (P.srv() && Array.isArray(P.meta?.subs)) {
      list = P.meta.subs.map((s) => ({ name: s.name, lang: s.lang || '', ext: s.ext, url: cloudFileUrl(join(s.name), { ws: st.ws || '', http: true }) }));
    } else if (st.origin === 'local') {
      const base = P.item.name.replace(/\.[^.]+$/, '').toLowerCase();
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
      if (g !== cueGen || P.dead) return;
      cues = parseCues(tr.ext === 'srt' ? srtToVtt(text) : text);
    } catch {
      if (g !== cueGen || P.dead) return;
      subIdx = -1;
      P.viewer.toast(t('字幕加载失败'), { kind: 'err' });
    }
  }
  function toggleSubs() {
    if (!subTracks.length) return;
    if (subIdx >= 0) { selectSub(-1); P.showOsd('subtitles', t('字幕已关闭')); }
    else { const i = Math.min(lastSub, subTracks.length - 1); selectSub(i); P.showOsd('subtitles', subName(i)); }
  }

  // —— storyboard 缩略帧（悬停 / 拖动时才去要；服务端一次 ffmpeg 出整张雪碧图，忙时 503 过会儿再要）——
  let sb = $state.raw(null), sbImg = '';
  let sbBusy = false, sbGiveUp = false, sbRetryAt = 0;
  async function wantStoryboard() {
    if (!P.srv() || sb || sbBusy || sbGiveUp || Date.now() < sbRetryAt) return;
    sbBusy = true;
    try {
      const r = await fetch(P.api('storyboard'));
      if (r.status === 503) { sbRetryAt = Date.now() + 4000; return; }
      if (!r.ok) { sbGiveUp = true; return; }
      const m = await r.json();
      const url = P.api('storyboard', '&img=1&v=' + (m.v || 0), true);
      await new Promise((res, rej) => { const im = new Image(); im.onload = res; im.onerror = rej; im.src = url; });
      if (P.dead) return;
      sbImg = url; sb = m;
    } catch { sbGiveUp = true; } finally { sbBusy = false; }
  }
  function sbStyle(v, k = 1) {
    const c = storyboardCell(sb, v);
    if (!c || !sbImg) return '';
    return `width:${c.w * k}px;height:${c.h * k}px;background-image:url("${sbImg}");background-size:${c.W * k}px ${c.H * k}px;background-position:${-c.x * k}px ${-c.y * k}px`;
  }
  const hasTip = $derived(!!sb || P.chapters.length > 0);


  return {
    get findSubs() { return findSubs; },
    get hasTip() { return hasTip; },
    get sb() { return sb; }, set sb(v) { sb = v; },
    get sbStyle() { return sbStyle; },
    get selectSub() { return selectSub; },
    get subIdx() { return subIdx; }, set subIdx(v) { subIdx = v; },
    get subLines() { return subLines; },
    get subName() { return subName; },
    get subTracks() { return subTracks; }, set subTracks(v) { subTracks = v; },
    get toggleSubs() { return toggleSubs; },
    get wantStoryboard() { return wantStoryboard; },
  };
}
