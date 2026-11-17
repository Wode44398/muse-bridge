// 文档查看 / 编辑器（DocViewer）的Live Preview / 源码编辑器（CM6 懒加载，同一实例双模）、嵌入跟上解析数据、阅读态插图转编辑、卸载兜底。
// P 是外壳（DocViewer.svelte）交出来的状态与动作视图，见那边的 P。
import { untrack } from 'svelte';
import { hasLocalWrite } from '../../../lib/localfs.js';
import { previewPush } from '../../../lib/preview.svelte.js';
import { desktopOpenExternal, isNativeDesktop, nativeLocLocalOnly } from '../../../lib/nativeDesktop.js';
import { MD_EXT_RE, renderObsMarkdown } from '../../../lib/obsmd.js';
import { IS_SHARE } from '../../../lib/share.js';
import { t } from '../../../lib/i18n.js';
import { isUtf8 } from '../../../lib/codeview/encoding.js';

export function createDocEditor(P) {
  // —— Live Preview / 源码编辑器（CM6，懒加载 chunk；同一实例双模切换）——
  let edEl = $state(null);
  let editor = null, edFor = null;   // 编辑器句柄非响应式；edFor=绑定的文件键
  const wantEditor = $derived(P.isMd && !P.loading && !P.loadError && (P.mode === 'live' || P.mode === 'source'));

  function destroyEditor() { try { editor?.destroy(); } catch {} editor = null; edFor = null; }

  // 外链：桌面壳显式交系统浏览器（window.open 在壳里靠 setWindowOpenHandler 兜底，
  // 语义含混且非 http 协议会被静默 deny）；网页保持新标签。
  function openExt(url) {
    if (isNativeDesktop() && /^https?:/i.test(url)) { desktopOpenExternal(url); return; }
    window.open(url, '_blank', 'noopener');
  }
  // 笔记里的附件（图/PDF/音视频…）：进应用内统一查看器（沿用当前宿主：全屏或 dock 内嵌），
  // 不再 window.open 裸 URL——桌面壳里那会打开系统浏览器（bridge-workspace:// 则被静默吞掉）。
  // 压一层（previewPush）而不是替换整个画廊：关掉附件回到这篇笔记的原位置（返回键 / 左上返回 / Esc 同）。
  function openAttachment(rel) {
    const st = P.cur.saveTarget || {};
    openAttachDesc(st.origin === 'local'
      ? { origin: 'local', rel, name: rel.split('/').pop() }
      : { origin: 'cloud', rel, name: rel.split('/').pop(), ws: st.ws || '', nativeLocation: st.nativeLocation || '' });
  }
  // 描述符版（relDescOf / siblingDesc 算好的，含产物 md 的同目录资源）：先记下阅读进度，返回时按它落位
  function openAttachDesc(desc) {
    if (!desc) return;
    P.grabScroll();
    if (P.anchor && P.cur?.key) P.RESUME.set(P.cur.key, P.anchor);
    previewPush(desc, 0, { resume: $state.snapshot(P.cur) });
  }

  function openRelHref(href) {
    const [p, h] = P.splitHref(href);
    if (!p) { if (h && !editor?.scrollToHeading(h)) P.showToast(t('找不到标题「{name}」', { name: h })); return; }   // [x](#标题)：本文内跳
    if (/^(https?:|mailto:|tel:)/i.test(p)) { openExt(p); return; }
    if (MD_EXT_RE.test(p)) { P.openRelNote(p, h); return; }
    P.openRelFile(p);
  }

  $effect(() => {
    const want = wantEditor, el = edEl, m = P.mode, key = P.draftKey, ro = !P.editable;
    if (!want || !el) { destroyEditor(); return; }
    let gone = false;
    (async () => {
      const mod = await import('../../../lib/mdeditor/index.js');
      if (gone || !edEl) return;
      if (editor && edFor === key) {
        editor.setMode(m === 'live' ? 'live' : 'source');
        embedSig = untrack(() => embedSigOf(P.content));   // LP 刚按当前解析整篇建过
        if (m === 'live') noteTooBig(mod);
        if (P.pendingScroll) { P.pendingScroll = false; P.applyScroll(); }
        flushEdWaiters();
        return;
      }
      destroyEditor();
      editor = mod.createMdEditor({
        parent: el,
        doc: untrack(() => P.content),
        mode: m === 'live' ? 'live' : 'source',
        readOnly: ro,
        onChange: (text) => { P.content = text; },
        onSave: () => P.save(),
        onNavigate: (name, head) => {
          if (name) P.resolveWiki(name, head);
          else if (head && !editor?.scrollToHeading(head)) P.showToast(t('找不到标题「{name}」', { name: head }));
        },
        openLink: (url) => openExt(url),
        openRel: openRelHref,
        resolveUrl: P.embedUrl,
        resolveAlts: P.embedAlts,         // ![[图]] 主地址是猜的时候的备选（ImageWidget 加载失败按序换）
        renderMd: (src) => renderObsMarkdown(src, { embedUrl: P.embedUrl, embedAlts: P.embedAlts }),
        tailEl: () => P.tailEl,
        linkNames: () => P.linkNames(),   // [[ 补全名单（complete.js）
        readNote: P.readNote,                       // [[笔记#标题 补全取那篇笔记的原文
        saveAttachment: P.saveAttachment,                 // 粘贴/拖入/选择的图片与文件存成附件（mdeditor/attach.js）
        linkExisting: P.linkExisting,                   // 拖进来的是库里已有的文件：直接写链接不复制
      });
      embedSig = untrack(() => embedSigOf(P.content));
      if (m === 'live') noteTooBig(mod);
      if (!ro) P.linkNames();             // 进编辑就预取：补全首弹不等网络，新写的链接/嵌入点开也认得
      edFor = key;
      if (!P.takeJumpHead() && P.pendingScroll) { P.pendingScroll = false; P.applyScroll(); }   // 双链跳标题优先于保进度
      flushEdWaiters();
    })();
    return () => { gone = true; };
  });

  // —— 编辑态的 ![[嵌入]] 跟上异步到货的解析数据 ——
  // 编辑器建好时出链索引/名单常常还没到（mdlinks 几百毫秒，正文走本地协议几十毫秒就到），LP 只在建的那一刻
  // 解析一次地址：到货不通知的话图一直停在占位/兜底地址上，要等聚焦或改字才重解析。只在嵌入地址真变了时
  // 才让 LP 整篇重建一次（比对正文里所有 ![[图]] 的解析结果），大文档不白重建
  let embedSig = '';
  function embedSigOf(text) {
    let s = '';
    for (const m of String(text).matchAll(/!\[\[([^[\]\n]+?)\]\]/g)) s += (P.embedUrl(m[1].split(/[|#]/)[0].trim(), true) ?? '') + '\n';
    return s;
  }
  function refreshEmbeds() {
    if (!editor || edFor !== P.draftKey || P.mode !== 'live') return;
    const sig = embedSigOf(P.content);
    if (sig === embedSig) return;
    embedSig = sig;
    editor.refresh?.();
  }
  $effect(() => { P.links; P.linksPending; untrack(refreshEmbeds); });

  // 文档超过 LP 的上限（mdeditor LP_MAX）时 LP 不做任何装饰、只剩源码——给一句提示，免得以为渲染坏了
  let tooBigFor = '';
  function noteTooBig(mod) {
    if (!mod.LP_MAX || untrack(() => P.content).length <= mod.LP_MAX || tooBigFor === P.draftKey) return;
    tooBigFor = P.draftKey;
    P.showToast(t('文档过大，已关闭实时预览'));
  }

  // 等编辑器建好（阅读态里粘贴/拖进图片：先切到编辑态，编辑器是懒加载的）
  const edWaiters = [];
  function flushEdWaiters() { while (edWaiters.length) edWaiters.shift()(); }
  function whenEditor() {
    if (editor && edFor === P.draftKey) return Promise.resolve(editor);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      edWaiters.push(() => { clearTimeout(timer); resolve(editor && edFor === P.draftKey ? editor : null); });
    });
  }

  // —— 阅读态插图：粘贴 / 拖入文件 → 切到编辑态，落在对应位置（Obsidian 阅读视图不能插图，这里直接替用户切过去；
  // 以前阅读态对粘贴/拖入毫无反应，拖放还冒泡给外层面板，看上去就是「插图失败」）——
  const filesOf = (dt) => (dt?.files?.length ? [...dt.files] : [...(dt?.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean));
  const hasFiles = (dt) => [...(dt?.types || [])].includes('Files');
  // 阅读态 y（相对 doc-scroll 内容顶）→ 源码位置；映射不了就文末
  function readPos(clientY) {
    const sc = P.docScrollEl, m = sc && P.readMap();
    if (!m) return null;
    const y = clientY == null ? sc.scrollTop + sc.clientHeight / 2 : sc.scrollTop + clientY - sc.getBoundingClientRect().top;
    return m.toSrc(y)?.pos ?? null;
  }
  async function insertFromRead(files, pos, pasted) {
    if (!P.editable) { P.showToast(t('此文档不可写')); return; }
    // 额外授权位置（桌面壳 loc-*）存不了附件（saveAttachment 必然抛错）：当场说清楚，别先切到编辑态再报失败
    const st = P.cur.saveTarget;
    if (st?.origin === 'cloud' && nativeLocLocalOnly(st.nativeLocation)) {
      P.showToast(t('插入失败：{reason}', { reason: t('这个位置暂不支持插入附件') }));
      return;
    }
    P.setMdMode('live');
    const ed = await whenEditor();
    if (!P.alive) return;
    if (!ed?.insertFiles?.(files, { pos, pasted })) P.showToast(t('插入失败：{reason}', { reason: files[0]?.name || '' }));
  }
  function readDragOver(e) {
    if (!P.isMd || !P.editable || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
  }
  function readDrop(e) {
    if (!P.isMd || !hasFiles(e.dataTransfer)) return;
    const files = filesOf(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();   // 别再冒泡到外层（工作空间/对话的拖放上传）
    insertFromRead(files, readPos(e.clientY), false);
  }
  function readPaste(e) {
    const cd = e.clipboardData;
    const files = filesOf(cd);
    if (!P.isMd || !files.length || (cd.getData('text/plain') || '').trim()) return;   // 同编辑态：剪贴板带文字时让文字优先
    e.preventDefault();
    insertFromRead(files, readPos(null), true);
  }
  $effect(() => () => {
    // 关查看器（没有浮层可收时的 Esc、安卓返回都直接卸载组件，绕过 guardDirty）：停笔不到 1.2s、
    // 自动保存还没触发的内容当场补存，不能只留在内存草稿里
    // （卸载后别读派生量 editable：直接按当前文档的保存目标判断）
    // 代码编辑器（CodeView）大文档的改动有 200ms 防抖：先收最后一笔（它这时还没卸载——本 effect 建得比模板早，先拆）；
    // 非 UTF-8 的文件不静默存（保存会转码，要用户点头），留在草稿里
    try { P.cv?.flush(); } catch {}
    const c = P.topItem(), st = c?.saveTarget;
    if (st && !IS_SHARE && P.content !== P.original && !P.conflict && (st.origin !== 'local' || hasLocalWrite())
      && isUtf8(P.ENCS.get(P.draftKeyOf(c))?.encoding)) P.saveDoc(c, P.content, true, P.original);
    P.alive = false; destroyEditor(); P.loadCtrl?.abort(); clearTimeout(P.linksT); clearTimeout(P.statsT); flushEdWaiters();
  });   // 组件卸载兜底：编辑器销毁 + 在途加载掐断（在途的写照常发完，见 saveDoc）

  return {
    get edEl() { return edEl; }, set edEl(v) { edEl = v; },
    get edFor() { return edFor; }, set edFor(v) { edFor = v; },
    get editor() { return editor; }, set editor(v) { editor = v; },
    get openAttachDesc() { return openAttachDesc; },
    get openAttachment() { return openAttachment; },
    get readDragOver() { return readDragOver; },
    get readDrop() { return readDrop; },
    get readPaste() { return readPaste; },
    get refreshEmbeds() { return refreshEmbeds; },
  };
}
