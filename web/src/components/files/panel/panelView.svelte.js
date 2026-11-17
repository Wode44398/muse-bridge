// 工作空间（手机 FilesPanel）的预览与缩略图：打开文件（混合画廊 / 文档序列）、查看器里的动作、关掉后回位高亮；
// 行 / 格子的缩略图地址与失败回退。P 是外壳（FilesPanel.svelte）交出来的状态与动作视图，见那边的 P。
import { tick, untrack } from 'svelte';
import { t } from '../../../lib/i18n.js';
import { isOffline, mediaFallbackUrl } from '../../../lib/server.js';
import { closePreview, cloudFileUrl, previewRemove, previewReplace, preview as pv } from '../../../lib/preview.svelte.js';
import { extOf, kindOf as fkKind } from '../../../lib/fileKinds.js';
import { GRID_THUMB_EXT, buildSequence, fmtDur, rectOf } from '../../../lib/fileGrid.js';
import { askRename } from '../../../lib/renamePrompt.js';
import { hasLocalThumb, localFileUrl, localReadText, localThumbUrl } from '../../../lib/localfs.js';
import { baseKey, fmtSize, kindOf } from '../../../lib/files/common.js';
import { fmtTime } from './panelLook.js';

export function createPanelView(P) {
  // —— 预览 ——
  // 统一构造查看器条目：云端走 /api（origin cloud），本地走 SAF 原生流式（origin local，url=/__localfile，带 Range）。
  // mt=mtime：让查看器衍生图 URL 与列表图标完全一致（命中浏览器缓存秒出 blur 底）+ 文件替换后自动 bust。
  // 原生位置（含这台电脑）不带 ws：带了 cloudFileUrl 就当成服务器上的路径去 /api/file 取了
  const srcItem = (it, kind) => ({ origin: P.isLocal ? 'local' : 'cloud', rel: P.itemRel(it), name: it.name, kind, mt: it.mtime, ws: P.desktopNative ? '' : P.cloudRoot, nativeLocation: P.desktopNative ? P.desktopLocationId : '' });
  // 格子 / 行缩略图元素（data-rel）：一次扫一遍建表，画廊几百项也只读一次布局
  function cellEls() {
    const m = new Map();
    for (const el of P.scroller?.querySelectorAll('[data-rel]') || []) {
      const r = el.dataset.rel;
      if (!m.has(r)) m.set(r, []);
      m.get(r).push(el);
    }
    return m;
  }
  // 这一项此刻在视口里的矩形（「最近」与正文里可能各有一格，取看得见的那个）；看不见给 null，查看器就地淡入
  function cellRect(r, els) {
    for (const el of els?.get(r) || []) { const box = rectOf(el, P.scroller); if (box) return box; }
    return null;
  }
  // 查看器描述符：在 srcItem 之上补列表已知的大小、补充元数据里的宽高 / 时长、格子矩形（从它放大进入、关闭缩回），
  // 大图标视图把格子正显示的 640 档当 blur 底与视频海报（gif 例外：查看器里放原图动画）
  function descOf(f, els) {
    const kind = fkKind(f.name);
    const d = { ...srcItem(f, kind) };
    if (Number.isFinite(f.size)) d.size = f.size;
    const m = P.meta[f.name];
    if (m) { d.width = m.w; d.height = m.h; d.duration = m.dur; }
    if (kind === 'image' || kind === 'video') {
      d.originRect = cellRect(P.itemRel(f), els);
      if (P.viewMode === 'large' && !P.isLocal && !P.desktopNative && extOf(f.name) !== 'gif') d.thumbUrl = cloudFileUrl(P.itemRel(f), { grid: true, mt: f.mtime, ws: P.cloudRoot });
    }
    // 手机本地的文本类：在线壳里 /__localfile 不一定通，经原生桥整份读出来交给查看器
    if (P.isLocal && (kind === 'markdown' || kind === 'text' || kind === 'html')) d.text = localReadText(P.itemRel(f));
    return d;
  }
  // 打开文件：同一文件夹里的图片与视频按列表当前顺序组成一个混合画廊；文档（PDF / Markdown / Office / 文本 / 网页）组成
  // 前后翻页序列；音频自成一组。手机本地的文本类要整份读出来，只放点开的那一份、不拉进序列（几百个源码文件挨个读太重）。
  function openFile(item) {
    if (P.wsPick) return;                // 选择器形态只挑文件夹：文件列出来是给你认路的，不点开
    if (P.selecting) { P.toggleSel(item.name); return; }
    const kind = fkKind(item.name);
    if (kind === 'other') { P.preview = { name: item.name, rel: P.itemRel(item), kind: 'other', local: P.isLocal }; return; }   // 其余（压缩包等）
    const r0 = P.itemRel(item);
    const localDoc = (f) => P.isLocal && ['markdown', 'text', 'html'].includes(fkKind(f.name));
    const { seq, index } = buildSequence(P.showFiles, item, { accept: (f) => !localDoc(f), same: (f) => P.itemRel(f) === r0 });
    const els = cellEls();
    P.openPreview(seq.map((f) => descOf(f, els)), index, { actions: viewerActs() });
    openMap = new Map(pv.items.map((it, i) => [it.key, seq[i]]));
    lastRel = r0;
  }

  // md/文本 → 沉浸式文档查看/编辑器（云端 fetch；本地 SAF 已读文本）。新建 Markdown 后直接进编辑也走这里
  function openDocPreview(item, k, extra = {}) {
    const r = P.itemRel(item);
    const kind = k === 'md' ? 'markdown' : 'text';
    if (P.isLocal) P.openPreview([{ origin: 'local', rel: r, name: item.name, kind, text: localReadText(r), ...extra }], 0);
    else P.openPreview([{ origin: 'cloud', rel: r, name: item.name, kind, ws: P.desktopNative ? '' : P.cloudRoot, nativeLocation: P.desktopNative ? P.desktopLocationId : '', ...extra }], 0);
  }

  // —— 查看器里的动作（kit/actions.js：「发送给 AI…」「重命名…」F2、「删除」Del）——
  // openMap：本页这一轮打开时建的「查看器条目 key → 列表项」；关掉查看器即作废。lastRel：最后看的那一项（关闭后滚回去）
  let openMap = null;
  let lastRel = '';
  const srcOf = (it) => (it?.key && (openMap?.get(it.key) || openMap?.get(baseKey(it.key)))) || null;
  function viewerActs() {
    const a = {};
    // 发送给 AI：先关查看器，再弹本页那张选目标的菜单（同长按菜单里的「发送给 AI」）
    if (!P.readonly && !P.guest && (!P.desktopExtra || P.pcLocal)) a.sendAi = (it) => {
      const f = srcOf(it);
      if (!f) return;
      closePreview();
      P.ai.item = f; P.ai.view = 'root';
    };
    // 重命名：查看器 z-index 300，本页自己的改名框在 .ws-root 的层叠上下文里压不过它——用挂在 body 上的应用级改名框
    // 明暗：媒体查看器恒暗，文档类跟随本页（与删除确认框一致）；失败提示改出在查看器里（本页的 toast 在查看器下层，看不见）
    if ((!P.isLocal || P.localOps.rename) && !P.readonly) a.rename = async (it, vctx) => {
      const f = srcOf(it);
      if (!f) return;
      const name = await askRename(f.name, { dark: ['image', 'video', 'audio'].includes(it?.kind) ? true : undefined });
      if (!name || name === f.name || !(await P.viaViewer(vctx, () => P.renameTo(f, name)))) return;
      const nf = { ...f, name, ...(f.rel ? { rel: f.rel.replace(/[^/]*$/, name) } : {}) };
      const i = pv.items.findIndex((x) => x.key === it.key);
      if (i < 0 || !openMap) return;
      openMap.delete(baseKey(it.key));
      previewReplace(i, descOf(nf, null));
      openMap.set(pv.items[i].key, nf);
      lastRel = P.itemRel(nf);
    };
    // 删除：同长按菜单（确认框在查看器之上；电脑位置里是移到回收站），删掉后画廊停在下一张，删空了就关
    if ((!P.isLocal || P.localOps.del) && !P.readonly) a.trash = async (it, vctx) => {
      const f = srcOf(it);
      if (!f || !(await P.viaViewer(vctx, () => P.doDelete(f)))) return;
      const i = pv.items.findIndex((x) => x.key === it.key);
      openMap?.delete(baseKey(it.key));
      if (i >= 0) previewRemove(i);
    };
    return a;
  }
  // 关掉查看器：最后看的那一项不在可视区就滚过去（只滚本页列表，不牵动外层），再短暂高亮一下——人知道自己刚才看到哪儿了
  let flashRel = $state('');
  let flashTimer = 0;
  $effect(() => {
    const open = pv.open, cur = pv.items[pv.index];
    untrack(() => {
      if (!openMap) return;
      if (open) { const f = srcOf(cur); if (f) lastRel = P.itemRel(f); return; }
      const r = lastRel;
      openMap = null; lastRel = '';
      if (r) revealAfterClose(r);
    });
  });
  async function revealAfterClose(r) {
    await tick();
    const el = cellEls().get(r)?.at(-1);   // 「最近」在前、正文在后：回到正文那一格
    if (!el || !P.scroller) return;
    const box = el.getBoundingClientRect(), sr = P.scroller.getBoundingClientRect(), cs = getComputedStyle(P.scroller);
    const top = sr.top + (parseFloat(cs.paddingTop) || 0), bottom = sr.bottom - (parseFloat(cs.paddingBottom) || 0);
    if (box.top < top || box.bottom > bottom) P.scroller.scrollTop += (box.top + box.bottom) / 2 - (top + bottom) / 2;
    flashRel = r;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flashRel = ''), 1400);
  }

  // —— 媒体缩略图：图片/视频行叠真实预览图，加载完成才淡入——加载前类型图标就是占位缓冲。
  // 云端走 /api/file?thumb=1（图片 sharp 320 webp / 视频 ffmpeg 抽帧，失败 404 不喂原字节）；
  // 本地 tab（离线壳内）：新 apk 走 /__localfile&thumb=1 原生缩略（图片+视频，SAF 系统缩略
  // 优先+兜底自解/抽帧）；旧 apk 退回图片全尺寸流式、视频保持类型图标。
  const canLocalThumb = hasLocalThumb() && isOffline();
  const thumbable = (it) => {
    if (it.isDir) return false;
    if (it.nativeThumb) return true;
    const k = kindOf(it.name);
    if (!P.isLocal) return k === 'img' || k === 'mov';
    if (canLocalThumb) return k === 'img' || k === 'mov';
    return k === 'img' && isOffline();
  };
  // 拿到的是「系统类型图标」而不是真缩略图：小且正方（Windows 回落的 32×32）。
  // 按尺寸判而不是按扩展名判——PDF/Office 这类真有缩略图提供程序的，回来的是大图或非
  // 正方的整页预览，那种仍该按缩略图铺满。
  const iconThumb = (it) => !!it.nativeThumb && it.nativeThumbW > 0
    && it.nativeThumbW === it.nativeThumbH && it.nativeThumbW <= 48;
  const thumbSrc = (it) => (it.nativeThumb || (P.isLocal
    ? (canLocalThumb ? localThumbUrl(P.rel(it.name)) : localFileUrl(P.rel(it.name)))
    : cloudFileUrl(P.itemRel(it), { thumb: true, mt: it.mtime, ws: P.desktopNative ? '' : P.cloudRoot, nativeLocation: P.desktopNative ? P.desktopLocationId : '' })));
  const thumbOk = (e) => e.currentTarget.classList.add('ok');
  // 失败：云端先按 mediaFallbackUrl 做一次 LAN→隧道自愈重试（媒体 <img> 没有 fetch 那套
  // noteNetFail 自愈，见 server.js）；仍失败/本地失败 → 保持透明，底下类型图标继续兜底。
  function thumbErr(e) {
    const img = e.currentTarget;
    if (img.dataset.cloud && !img.dataset.retried) {
      img.dataset.retried = '1';
      const next = mediaFallbackUrl(img.src);
      if (next !== img.src) { img.src = next; return; }
    }
    img.classList.remove('ok');
  }

  // —— 图标 / 大图标视图的格子 ——
  // 服务端列表档在图片、视频之外还能出的：PDF 与 Office 首页、音频内嵌封面、TIFF。只在图标视图要——
  // 列表行 34px 小图标犯不上为每个文稿起一次转换。失败一律 404，格子退回类型线稿图标（扩展名表见 lib/fileGrid.js GRID_THUMB_EXT）。
  const cellThumbable = (it) => thumbable(it) || (!P.isLocal && !P.desktopNative && !it.isDir && GRID_THUMB_EXT.has(extOf(it.name)));
  // 图片 / 视频：缩略图没到时只铺底色（不先闪一下类型图标）；其余先摆线稿图标，封面 / 首页到了再盖上
  const isMedia = (it) => { const k = fkKind(it.name); return k === 'image' || k === 'video'; };
  // 大图标两列，一格在手机上 170 多 px、三倍屏要五百多像素：走 640 的 grid 档；图标视图三列用列表同一张 320
  const cellSrc = (it) => it.nativeThumb || (P.isLocal ? thumbSrc(it)
    : cloudFileUrl(P.itemRel(it), { thumb: P.viewMode !== 'large', grid: P.viewMode === 'large', mt: it.mtime, ws: P.desktopNative ? '' : P.cloudRoot, nativeLocation: P.desktopNative ? P.desktopLocationId : '' }));
  function cellErr(e) {
    const img = e.currentTarget, before = img.src;
    thumbErr(e);
    if (img.src !== before) return;    // 换了条线路重试
    img.parentElement?.classList.add('bad');
  }
  // 副行：文件夹＝项目数；大图标＝日期 · 大小；图标＝按修改日期排序时给日期，否则给大小
  const cellSub = (f) => f.isDir ? (P.meta[f.name]?.n != null ? t('{n} 项', { n: P.meta[f.name].n }) : '')
    : P.viewMode === 'large' ? [fmtTime(f.mtime), fmtSize(f.size)].filter(Boolean).join(' · ')
    : P.sortPref.key === 'mtime' ? fmtTime(f.mtime) : fmtSize(f.size);
  const durOf = (f) => (kindOf(f.name) === 'mov' && P.meta[f.name]?.dur > 0 ? fmtDur(P.meta[f.name].dur) : '');


  return {
    get cellErr() { return cellErr; },
    get cellSrc() { return cellSrc; },
    get cellSub() { return cellSub; },
    get cellThumbable() { return cellThumbable; },
    get durOf() { return durOf; },
    get flashRel() { return flashRel; }, set flashRel(v) { flashRel = v; },
    get iconThumb() { return iconThumb; },
    get isMedia() { return isMedia; },
    get openDocPreview() { return openDocPreview; },
    get openFile() { return openFile; },
    get thumbErr() { return thumbErr; },
    get thumbOk() { return thumbOk; },
    get thumbSrc() { return thumbSrc; },
    get thumbable() { return thumbable; },
  };
}
