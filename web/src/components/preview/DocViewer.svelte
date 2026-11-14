<script>
  // 文档查看/编辑器（亮色文档 surface，自带头部，盖在 MediaViewer 暗壳之上）。
  // Markdown 走 Obsidian 式三态：阅读（obsmd 渲染）｜编辑（Live Preview，CM6 懒加载，
  // 光标进块显源码、表格 Excel 式常驻编辑）｜源码（同一 CM 实例关装饰）。
  // 纯文本/代码走 CodeView（CM6 只读查看：行号、语法高亮、查找 Ctrl+F、跳行 Ctrl+G、换行 Alt+Z、
  // 字号缩放；编辑从工具/菜单进）；CSV/TSV 默认 TableView 表格；JSON 默认格式化、可切原文；日志级别着色。
  // 字节读进来自己解码（BOM → UTF-8 → GB18030/Big5/Shift_JIS 打分），副标题标编码、菜单可改编码重开；
  // 大文件只读前 N MB（标「仅显示前 xx」、不可编辑）。保存写回云端(/api/file/save)或手机本地(SAF localWrite)。
  //   · Obsidian 风笔记补全：frontmatter「笔记属性」面板、[[双链]]/相对 md 链接查看器内跳转
  //     （导航栈，返回逐级回退）、#标签 / ==高亮== / callout、底部「反向链接 / 出链」面板
  //     （/api/file/mdlinks，云端）+ 词数统计
  //   · md 编辑态防抖自动保存（失败退草稿+限次重试）；未保存草稿按文件键存内存，误关再开自动恢复
  //     （磁盘期间被别处改过：先三方合并，合不上以磁盘为准、横幅让用户选）
  //   · 键盘避让（padding-bottom: --kb）；返回自动落盘（不可保存时才弹确认）
  import { untrack, tick } from 'svelte';
  import { api } from '../../lib/api.js';
  import { mediaFallbackUrl } from '../../lib/server.js';
  import '../../lib/doctheme.css';   // --md-* 纸面配色令牌（亮象牙白 / 暗暖墨，跟随全站明暗；编辑态/Office/PDF 共用）
  import { localWrite, localWriteB64, hasLocalWrite, localList, localReadText, localFileUrl } from '../../lib/localfs.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { normalizeItem, cloudFileUrl, previewPush } from '../../lib/preview.svelte.js';
  import { nativeWorkspaceWriteText, isNativeDesktop, desktopOpenExternal, nativePathForFile, nativeLocLocalOnly } from '../../lib/nativeDesktop.js';
  import { parseNote, renderObsMarkdown, renderPropWikilinks, noteStats, escapeHtml, escapeRegex, propKind, PROP_ICONS, MD_EXT_RE, scanFootnotes, renderFootnoteSection, lexObsBlocks, EMBED_SRC_OK } from '../../lib/obsmd.js';
  import { findSafeCut } from '../../lib/md.js';
  import { srcBlocks, readMapper } from '../../lib/mdanchors.js';
  import { merge3, textHash } from '../../lib/textmerge.js';
  import { setPreviewDetail } from '../../lib/preview.svelte.js';
  import { registerDraft } from '../../lib/uiReport.js';
  import { fsChange, fsMatches } from '../../lib/fsSync.svelte.js';
  import { IS_SHARE } from '../../lib/share.js';
  import { t, tc, tr, locale } from '../../lib/i18n.js';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { guardSelection } from '../../lib/touchSelection.js';
  import { edgeAutoScroll } from '../../lib/touchAutoScroll.js';
  import { previewViewAs } from '../../lib/preview.svelte.js';
  import { useViewer, isEditable } from './kit/context.js';
  import ViewerState from './kit/ViewerState.svelte';
  import VIcon from './kit/VIcon.svelte';
  import { fmtBytes } from './kit/actions.js';
  import CodeView from './CodeView.svelte';
  import TableView from './TableView.svelte';
  import FindBar from './paged/FindBar.svelte';
  import { readCapped, capFor, SAVE_MAX } from '../../lib/codeview/readtext.js';
  import { detectEncoding, decodeBytes, encLabel, isUtf8, eolOf, ENCODINGS, looksText } from '../../lib/codeview/encoding.js';
  import { looksLikeLog } from '../../lib/codeview/textutil.js';
  import { looksMinified, formatJsonAsync } from '../../lib/codeview/jsonfmt.js';
  import { siblingDesc, artifactRef } from '../../lib/docres.js';
  import { langOf, iconKindOf, kindOf } from '../../lib/fileKinds.js';

  // 纯文本 / 代码 / 日志 / JSON / CSV（非 md）走 CodeView（CM6 只读视图，编辑入口在顶栏工具与 ⋮ 菜单里，
  // 默认不是可写 textarea）；CSV / TSV 默认表格（TableView），可切原文。读取按字节、带上限（lib/codeview/readtext.js），
  // 编码自动识别（BOM → 严格 UTF-8 → GB18030 / Big5 / Shift_JIS 打分），副标题显示编码、⋮ 里可手动换编码重新解码；
  // 截断显示的、超过保存上限的、服务端不认的扩展名一律只读（以前截断后再保存会把文件截短）。

  // 顶栏、toast、加载 / 错误 / 不支持态交给统一查看器外框（kit/context.js）：这里向外框声明标题（栈顶那篇）、
  // 副标题（保存状态 / 所在文件夹）、栏内自定义区（阅读 / 编辑 / 源码三段 + 文本文件的保存钮）与返回拦截
  // （先退笔记栈、未保存先确认）。编辑器内核不动。
  let { item } = $props();
  const viewer = useViewer();

  // —— 双链导航栈：栈顶=当前文档；[[链接]]/反链点击 push、返回 pop（安卓返回同步接管）——
  let stack = $state([item]);
  const cur = $derived(stack[stack.length - 1]);
  const isMd = $derived(cur.kind === 'markdown');
  const isDelim = $derived(/^(csv|tsv)$/i.test(cur.ext || ''));
  // 没扩展名 / 不认识的文件：先嗅前 4KB（sniff.v：'text' 像文本 | 'bin' 二进制 | 'forced' 用户点了「以文本方式打开」）
  let sniff = $state(null);
  const sniffKind = $derived(sniff?.key === draftKeyOf(cur) ? sniff.v : '');
  const isText = $derived(cur.kind === 'text' || isMd || isDelim || sniffKind === 'text' || sniffKind === 'forced');
  // 当前文档的读取结果：截断（只显示前 N MB）、原始编码与换行、文件字节数
  let trunc = $state(null);        // null | { shown, total }
  let encInfo = $state(null);      // { key, encoding, bom, eol }
  let byteLen = $state(0);
  const curEnc = $derived(encInfo?.key === draftKeyOf(cur) ? encInfo : null);
  // 公开分享页（/w/）是只读身份：写接口对 share 一律 401，编辑入口直接不给。
  // 截断显示的（存回去会把文件截短）、超过服务端保存上限的、二进制硬按文本打开的不给编辑；
  // 云端走 /api/file/save 的还得是服务端认的文本扩展名（点文件、无扩展名的它回 415，入口不给就不会存到一半才报错）
  const editable = $derived(!IS_SHARE && !!cur.saveTarget && (cur.saveTarget.origin !== 'local' || hasLocalWrite())
    && !trunc && !(byteLen > SAVE_MAX) && sniffKind !== 'forced' && srvSavable(cur));
  const SRV_TEXT_EXT = new Set('txt md markdown json csv tsv log js mjs cjs ts jsx tsx css scss html htm xml svg yml yaml py rb go rs sh bat ps1 ini toml conf env sql vue c h cpp cc hpp java kt swift php lua r tex rst gitignore'.split(' '));
  function srvSavable(c) {
    const st = c.saveTarget;
    if (!st || st.origin !== 'cloud' || st.nativeLocation) return true;   // 手机本地 / 电脑客户端本机写不经服务端
    const n = String(st.rel || c.name || '').split('/').pop(), i = n.lastIndexOf('.');   // 同 path.extname：点文件没有扩展名
    return i > 0 && SRV_TEXT_EXT.has(n.slice(i + 1).toLowerCase());
  }
  // 非 UTF-8 的文件不自动保存（保存要转成 UTF-8，得用户点头）：md 的停笔自动存、离开静默存都按「不可自动保存」走
  const mdAuto = $derived(isMd && editable && isUtf8(curEnc?.encoding));

  // —— 未保存草稿（按文件键存内存，跨重开恢复）——
  // 值是 { text, base }：base=这份草稿基于的磁盘原文。重开时磁盘若已不是 base（期间 Claude/其他端改过），
  // 不能拿草稿直接盖——先三方合并，合不上就进冲突区让用户选（见 restoreDraft）。
  const DRAFTS = (window.__bridgeDocDrafts ||= new Map());
  const STALE = (window.__bridgeDocStale ||= new Map());      // 与磁盘冲突、没自动恢复的草稿：文件键 → { text }（关掉重开还在，等用户决定）
  const SAVEQ = (window.__bridgeDocSaveQ ||= new Map());      // 每篇最后一个写请求（只 resolve）：写入按篇串行，load() 读盘前先等它
  const draftKeyOf = (c) => (c.saveTarget ? c.saveTarget.origin + ':' + (c.saveTarget.ws || c.saveTarget.nativeLocation || '') + ':' + c.saveTarget.rel : c.key);
  const linksKeyOf = (c) => (c.saveTarget?.ws || c.saveTarget?.nativeLocation || '') + ':' + (c.saveTarget?.rel || '');
  const draftKey = $derived(draftKeyOf(cur));

  let content = $state(''), original = $state('');
  // md：'preview'(阅读) | 'live'(编辑=Live Preview) | 'source'(源码)；文本文件：'view'(只读查看) | 'edit'(编辑)
  let mode = $state('preview');
  // —— 文本文件（非 md）的查看状态 ——
  let cv = $state(null), tv = $state(null);   // CodeView / TableView 实例
  let wrap = $state(false);                   // 自动换行：按类别（纯文本 / 代码 / 日志 / JSON）记在本机
  let wrapCat = '', wrapKept = null;          // wrapKept：本机记着的（或按类别默认的）那个值，用户真切换了才回写
  let isLog = $state(false);
  let jsonPretty = $state(null);              // { key, src, text }：压成一行的 JSON 默认格式化显示（src＝格式化的是哪份原文）
  let jsonRaw = $state(false);                // 看原文
  let tableRaw = $state(false);               // CSV / TSV 看原文
  let rawBytes = null, rawFor = '';           // 读到的原始字节（手动换编码时重新解码；非响应式）
  const ENCS = (window.__bridgeDocEnc ||= new Map());   // 文件键 → { encoding, bom, eol }：保存按原编码 / BOM 写回
  const lang = $derived(langOf(cur.name));
  const showTable = $derived(isDelim && !tableRaw && mode !== 'edit');
  const jsonCan = $derived(jsonPretty?.key === draftKeyOf(cur) && jsonPretty.src === content);   // 改过 / 换过编码就作废，显示当前正文
  const shown = $derived(mode !== 'edit' && jsonCan && !jsonRaw ? jsonPretty.text : content);
  let loading = $state(true), loadError = $state(false);
  let restored = $state(false);   // false | 'draft'（原样恢复草稿）| 'merged'（草稿与磁盘新修改已合并）
  let stale = $state(null);       // 当前文档的冲突草稿 { key, text }（横幅：恢复草稿 / 丢弃）
  // 编辑中与磁盘冲突：保存时发现（服务端 409 / 本地现读对不上）或跟盘时发现别处改的正是你改的那几行，
  // 三方合并合不上 → { key, theirs }；横幅让用户选「保留我的 / 用最新版」，期间自动保存暂停
  let conflict = $state(null);
  let justSaved = $state(false), savedT = null;   // 刚保存完：顶栏副标题短暂显示「已保存」
  const dirty = $derived(content !== original);

  // —— 工作区协同：编辑态上抛（agent 的 workspace.view 看得到模式与未保存标记）+
  // 草稿提供者（agent draft() 拿编辑器里的当前全文，防止它拿磁盘旧稿盖掉用户没存的字）。
  $effect(() => { setPreviewDetail({ mode, dirty }); });
  $effect(() => registerDraft(() => ({
    rel: cur?.saveTarget?.rel || cur?.name || '',
    ws: cur?.saveTarget?.ws || '',
    mode, dirty, text: content,
  })));

  // 顶栏副标题：保存状态优先，平时显示所在文件夹。纸面灰阶，不用彩色块（冲突才用警示色）
  const folder = $derived((cur.saveTarget?.rel || '').split('/').slice(0, -1).join(' / '));
  const status = $derived(
    !isText || loading ? null
      : conflict ? { kind: 'warn', text: t('与别处的修改冲突') }
      : saving ? { kind: 'busy', text: t('正在保存…') }
      : dirty && editable ? { kind: 'dirty', text: t('未保存') }
      : justSaved ? { kind: 'ok', text: t('已保存') }
      : !editable ? { kind: 'ro', text: t('只读') }
      : folder ? { kind: 'path', text: folder } : null);
  // 编码 / 换行跟在状态后面（同 VS Code 状态栏）：电脑上文本文件常显；md 绝大多数是 UTF-8，只在不是的时候才显。
  // 触屏顶栏窄（标题 + 三个工具），只在真不是 UTF-8（GB18030 / Big5 / Shift_JIS…）时占位，BOM / CRLF 看菜单里的「编码」
  const encText = $derived.by(() => {
    const e = curEnc;
    if (!isText || loading || !e) return '';
    if (viewer.touch) return isUtf8(e.encoding) ? '' : encLabel(e.encoding, false);
    const plain = isUtf8(e.encoding) && !e.bom;
    if (isMd && plain) return '';
    return encLabel(e.encoding, e.bom) + (e.eol === '\r\n' ? ' · CRLF' : '');
  });

  const MD_MODES = ['preview', 'live', 'source'];
  const lastMdMode = () => (MD_MODES.includes(window.__bridgeMdMode) ? window.__bridgeMdMode : 'preview');
  function setMdMode(m) {
    if (m === mode) return;
    if (m === 'preview' && mode !== 'preview' && dirty && mdAuto) save(true);   // 切回阅读即落盘
    grabScroll();            // 换模式不回到顶部：先记下进度，新模式渲染完按比例落回原处
    pendingScroll = true;
    mode = m;
    window.__bridgeMdMode = m;
  }

  // —— 模式切换保住阅读进度 ——
  // 对齐的是「视口顶下 dy 那条线上的字」：切换前后它的屏幕 y 不变。两态之间传**源码位置**（可带小数）——
  // 阅读态 y ↔ 源码走 lib/mdanchors.js 的块级刻度（顶层块逐个配对，列表逐项、代码逐行、段落逐软换行细分），
  // 编辑态 y ↔ 源码走 CM 自己的行高表（mdeditor topPos/scrollToPos，行内按字符插值、落定后再精调）。
  // 两个方向用同一张表，阅读→编辑→阅读往返不漂移。不用整篇像素比例——编辑态是 CM 虚拟滚动，
  // 视口外的高度是估算值，纯比例会偏出几屏。停在文首时只记「顶部」，另一态也回顶（两态首屏各排各的）。
  let docScrollEl = $state(null);
  let anchor = null, pendingScroll = false;
  // 从附件层返回（previewPop 后本组件按原条目重建）：按离开时记下的锚点落回原处
  const RESUME = (window.__pvDocResume ||= new Map());
  // svelte-ignore state_referenced_locally
  { const r = RESUME.get(item?.key); if (r) { RESUME.delete(item.key); anchor = r; pendingScroll = true; } }
  const anchorDy = (h) => Math.min(120, Math.round((h || 0) * 0.2));
  const nlz = (s) => s.replace(/\r\n?/g, '\n');   // CM 文档的换行一律是 \n：两边偏移都按归一后的文本算

  // 阅读态映射：源码侧的顶层块只在正文变了时重切（与阅读态分块渲染同一组分块、同一份脚注上下文）
  let srcMemo = null;
  function readMap() {
    const page = docScrollEl?.firstElementChild;
    if (!mdEl || !page || !note) return null;
    const text = nlz(content);
    if (srcMemo?.text !== text) {
      const footnotes = scanFootnotes(note.body);
      const base = text.length - nlz(note.body).length;
      srcMemo = { text, base, blocks: srcBlocks(splitTopBlocks(note.body), base, (s) => lexObsBlocks(s, { footnotes })) };
    }
    return readMapper({ root: mdEl, page, blocks: srcMemo.blocks, base: srcMemo.base, total: text.length, text });
  }

  // anchor：{ top:true } 或 { pos, off, snip?, sdy? }——pos 是锚线上（或锚线下方 off 像素处、空隙吸附时）的源码位置；
  // snip/sdy 是锚线那一行的一小段字与它首字顶相对锚线的差，另一态能找到这段字就直接按它对齐（比按字符插值准）。
  // anchorFor：上次按 anchor 落位时的正文与落定的阅读态 scrollTop——落位之后用户没滚过、没改过字，
  // 再切换就沿用同一个锚点，不重新量（两态版面不完全相同，重量一次会差几像素，来回切就会一点点漂）
  let anchorFor = null;
  function grabScroll() {
    if (anchor && anchorFor?.text === content) {
      const sc = mode !== 'preview' ? editor?.view?.scrollDOM : docScrollEl;
      const settled = mode !== 'preview' ? sc?.__mdeSettled : anchorFor.readSt;
      if (sc && settled != null && Math.abs(sc.scrollTop - settled) <= 2) return;
    }
    anchorFor = null;
    if (mode !== 'preview') {
      const sc = editor?.view?.scrollDOM;
      if (sc) anchor = sc.scrollTop <= 1 ? { top: true } : editor.topPos(anchorDy(sc.clientHeight), true);
      return;
    }
    const sc = docScrollEl, m = sc && readMap();
    if (!m) return;
    if (sc.scrollTop <= 1) { anchor = { top: true }; return; }
    const y = sc.scrollTop + anchorDy(sc.clientHeight);
    anchor = m.toSrc(y);
    if (!anchor.off) Object.assign(anchor, m.snipAt(y, anchor.pos));   // 锚线上的一小段字：另一态直接找它对齐（见 mdanchors snipAt）
  }
  function applyScroll() {
    const a = anchor;
    if (!a) return;
    const af = (anchorFor = { text: content, readSt: null });
    if (mode !== 'preview') {
      if (a.top) editor?.scrollToPos?.(0);
      else editor?.scrollToPos?.(a.pos, anchorDy(editor.view.scrollDOM.clientHeight) + (a.off || 0), a.snip ? { snip: a.snip, sdy: a.sdy } : null);
      return;
    }
    // 阅读态高度还会因图片解码变，补两拍；用户一动手立刻收手，不跟人抢滚动
    let last = -1, n = 0;
    const put = () => {
      const sc = docScrollEl;
      if (!sc || !sc.isConnected || mode !== 'preview') return true;
      if (last >= 0 && Math.abs(sc.scrollTop - last) > 2) return true;
      const m = a.top ? null : readMap();
      if (a.top) sc.scrollTop = 0;
      else if (m) {
        let y = m.toY(a.pos);   // 锚线应在的页内 y；带着锚线文字的，在附近找到同一段字就以它为准
        const hit = a.snip ? m.findSnip(a.snip, y + (a.sdy || 0)) : null;
        if (hit != null) y = hit - (a.sdy || 0);
        sc.scrollTop = Math.max(0, Math.min(Math.round(y - anchorDy(sc.clientHeight) - (a.off || 0)), sc.scrollHeight - sc.clientHeight));
      }
      last = af.readSt = sc.scrollTop;
      return false;
    };
    put();
    const id = setInterval(() => { if (put() || ++n >= 3) clearInterval(id); }, 60);
  }
  $effect(() => {
    const el = docScrollEl;
    mdBlocks;                                   // 阅读态 DOM 渲染完再落位
    if (mdRendering) return;                    // 分块途中块还没长全，等全量出齐再插值
    if (mode !== 'preview' || !el) return;
    if (untrack(() => takeJumpHead())) return;  // 双链 [[笔记#标题]] 跳过来：定位到标题，这次不按进度落位
    if (!pendingScroll) return;
    pendingScroll = false;
    applyScroll();
  });

  // 提示统一走外框的 toast 出口（文档皮肤胶囊、底栏上沿往上 12px）
  function showToast(m) { viewer.toast(m, { ms: 1800 }); }

  let seq = 0;   // 竞态闸：快速连点双链时只认最后一次加载
  let loadCtrl = null;   // 在途加载的中止柄：换文档/卸载时掐掉，不陪葬
  async function load() {
    const my = ++seq, c = cur, dk = draftKeyOf(c);
    loading = true; loadError = false; restored = false; stale = null; conflict = null;
    trunc = null; jsonRaw = false; tableRaw = false; rawBytes = null; rawFor = '';
    mode = c.kind === 'markdown' ? (MD_MODES.includes(c.startMode) ? c.startMode : lastMdMode()) : 'view';
    loadLinks(c);
    const forced = sniff?.key === dk && (sniff.v === 'text' || sniff.v === 'forced');
    const textish = c.kind === 'text' || c.kind === 'markdown' || /^(csv|tsv)$/i.test(c.ext || '') || forced;
    // 不认识的文件（无扩展名、未知扩展名）：嗅前 4KB，像文本就按文本开，否则「无法预览」+ 以文本方式打开
    const probe = !textish && c.kind === 'other' && !!c.url && iconKindOf(c.name) === 'file';
    if (!textish && !probe) { loading = false; return; }
    // 首包 12s 超时——切后台回来的半开 socket 会让 fetch 永挂（转圈永远转的元凶，
    // 同聊天流 07-30 看门狗的病根）；头到了正文另给 120s 兜底，超时/断网走「重试」错误态（见 readCapped）
    loadCtrl?.abort();
    const ctrl = (loadCtrl = new AbortController());
    try {
      if (probe) {
        const head = await readCapped(c.url, { cap: 4096, size: c.size, signal: ctrl.signal });
        if (my !== seq) return;
        const v = looksText(head.bytes) ? 'text' : 'bin';
        sniff = { key: dk, v };
        if (v === 'bin') { loading = false; return; }
      }
      const cap = capFor(viewer.touch);
      let text = null, det = { encoding: 'utf-8', bom: false }, bytes = null, total = Number.isFinite(c.size) ? c.size : null, truncated = false;
      if (c.text != null) {                                     // 本地：调用方已读
        text = c.text;
        // 栈里的 text 是压栈那一刻读的：跳走期间存过就旧了（返回再拿它当原文，下次自动保存会把刚存的盖回去）。能现读就现读
        if (c.saveTarget?.origin === 'local') { const fresh = localReadText(c.saveTarget.rel); if (fresh || !text) text = fresh; }
        // 本地读接口按 UTF-8 解：解出替换符（GBK 老文件）且有字节地址可取 → 改按字节读、识别编码
        if (text && text.includes('\uFFFD') && c.url) text = null;
        else {
          text = text || '';
          if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); det = { encoding: 'utf-8', bom: true }; }
          if (text.length > cap) { text = text.slice(0, cap); truncated = true; }
        }
      }
      if (text == null) {
        // 这篇还有写请求在途（跳走马上回来 / 关掉马上重开）：先等它落盘再读，否则读到写入之前的旧文（最多等 8s）
        const q = SAVEQ.get(dk);
        if (q) await Promise.race([q, new Promise((r) => setTimeout(r, 8000))]);
        if (my !== seq) return;
        // 按字节读、带上限：超过上限只取前 cap（流式读够就掐断，几十 MB 的日志不整个拉进内存）
        const r = await readCapped(c.url, { cap, size: c.size, signal: ctrl.signal });
        if (my !== seq) return;
        bytes = r.bytes; total = r.total; truncated = r.truncated;
        det = detectEncoding(bytes);
        text = decodeBytes(bytes, det.encoding, { partial: truncated });
      }
      if (my !== seq) return;
      rawBytes = bytes; rawFor = dk;
      const e = { key: dk, encoding: det.encoding, bom: det.bom, eol: eolOf(text) };
      ENCS.set(dk, { encoding: e.encoding, bom: e.bom, eol: e.eol });
      encInfo = e;
      byteLen = total ?? bytes?.length ?? text.length;
      trunc = truncated ? { shown: bytes?.length ?? cap, total } : null;
      if (c.kind !== 'markdown') prepText(c, dk, text, truncated);
      original = text;
      linkSigs.set(linksKeyOf(c), linkSigOf(text));   // 这次拉的出链索引对应的就是这份磁盘原文
      content = truncated ? text : restoreDraft(c, dk, text);   // 截断的只读：不恢复草稿（草稿是整篇的，拿它盖会出事）
      loading = false;
    } catch { if (my === seq) { loadError = true; loading = false; } }
  }
  // 文本文件的查看偏好：日志识别、换行按类别取本机记忆（纯文本默认换行，代码 / 日志 / JSON 默认不换）、
  // 压成一行的 JSON 后台格式化（失败 = 带注释 / 截断的，按原文显示）
  function prepText(c, dk, text, truncated) {
    const lg = langOf(c.name);
    isLog = !lg && !/^(csv|tsv)$/i.test(c.ext || '') && looksLikeLog(text, c.name);
    wrapCat = isLog ? 'log' : lg === 'json' ? 'json' : lg ? 'code' : 'text';
    let w = null;
    try { w = localStorage.getItem('pv.wrap.' + wrapCat); } catch {}
    wrap = wrapKept = w == null ? wrapCat === 'text' : w === '1';
    if (jsonPretty?.key !== dk) jsonPretty = null;
    if (lg === 'json' && !truncated && looksMinified(text)) {
      const sig = loadCtrl?.signal;
      formatJsonAsync(text, { signal: sig }).then((s) => {
        if (s && s !== text && draftKeyOf(cur) === dk && !sig?.aborted) jsonPretty = { key: dk, src: text, text: s };
      }).catch(() => {});
    }
  }
  // 只在用户切过之后回写（打开时读出来的 / 默认值不落盘：没动过就别替用户记一个默认）
  $effect(() => { const w = wrap; if (wrapCat && w !== wrapKept) { wrapKept = w; try { localStorage.setItem('pv.wrap.' + wrapCat, w ? '1' : '0'); } catch {} } });

  // 「以文本方式打开」：二进制 / 不认识的类型硬按文本解（只读）
  function forceText() { sniff = { key: draftKeyOf(cur), v: 'forced' }; load(); }

  // 手动换编码重新解码（VS Code「通过编码重新打开」）：有没存的修改先不让换（换了就丢）
  async function reopenAs(encName) {
    if (dirty) { showToast(t('有未保存的修改，先保存再换编码')); return; }
    const c = cur, dk = draftKeyOf(c);
    let bytes = rawFor === dk ? rawBytes : null;
    if (!bytes) {
      if (!c.url) return;
      try { bytes = (await readCapped(c.url, { cap: capFor(viewer.touch), size: c.size })).bytes; }
      catch { showToast(t('读取失败')); return; }
      if (draftKeyOf(cur) !== dk || dirty) return;
      rawBytes = bytes; rawFor = dk;
    }
    const text = decodeBytes(bytes, encName, { partial: !!trunc });
    const det = detectEncoding(bytes.subarray(0, 4));
    const e = { key: dk, encoding: encName, bom: det.bom && det.encoding === encName, eol: eolOf(text) };
    ENCS.set(dk, { encoding: e.encoding, bom: e.bom, eol: e.eol });
    encInfo = e;
    original = text;
    applyText(text, true);
    if (c.kind !== 'markdown') prepText(c, dk, text, !!trunc);
  }
  // 挂载/换文档（含双链跳转）即加载。只跟 cur：load → loadLinks 同步读了 links、拉回来又写它，
  // 不隔开的话云端 md 第一次打开会被出链索引的回包再触发一整遍加载（正文重拉、阅读/编辑态被复位）
  $effect(() => { cur; untrack(() => load()); });

  // 草稿恢复（验收 e2e-3）：草稿记着它基于的磁盘原文（base），拿它和刚读到的磁盘现状比——
  //   · 草稿 = 磁盘：早已落盘（多半是跳走时的静默保存），丢掉草稿，不报「已恢复」、不强切编辑态；
  //   · 磁盘 = base：期间没人动过这篇，原样恢复（之后照常自动保存）；
  //   · 磁盘变了（Claude 的 Edit / 其他端）：三方合并，两边改的不是同一处就合上、两边的新内容都留；
  //     合不上就以磁盘为准，草稿转进冲突区，横幅让用户选「恢复草稿（覆盖磁盘）」或「丢弃」——
  //     绝不拿旧草稿静默盖掉别处的新修改。
  function restoreDraft(c, dk, text) {
    if (STALE.get(dk)?.text === text) STALE.delete(dk);
    const d = DRAFTS.get(dk);
    let out = text;
    if (d && d.text !== text) {
      if (d.base === text) { out = d.text; restored = 'draft'; }
      else {
        const m = typeof d.base === 'string' ? merge3(d.base, d.text, text) : null;
        if (m == null) STALE.set(dk, { text: d.text });
        else if (m !== text) { out = m; restored = 'merged'; }
      }
    }
    if (out === text) DRAFTS.delete(dk);
    if (restored && c.kind === 'markdown') mode = 'live';
    const s = STALE.get(dk);
    stale = s ? { key: dk, text: s.text } : null;
    return out;
  }
  // 冲突横幅：恢复草稿 = 用草稿换掉正文（编辑器里走事务，可撤销；随后照常自动保存覆盖磁盘）
  function useStale() {
    const s = stale;
    if (!s || draftKeyOf(cur) !== s.key) return;
    STALE.delete(s.key); stale = null;
    if (editor) editor.setDoc(s.text);
    else content = s.text;
    if (isMd && mode === 'preview') setMdMode('live');
    restored = 'draft';
  }
  function dropStale() { if (stale) STALE.delete(stale.key); stale = null; }

  function onEdit() { if (dirty) DRAFTS.set(draftKey, { text: content, base: original }); else DRAFTS.delete(draftKey); }
  $effect(() => { content; if (!loading) onEdit(); });   // 编辑即存草稿

  // —— agent 跟盘：Claude 的 Edit/Write 落盘成功（SSE fs 事件）→ 当前文档跟上磁盘 ——
  // 命中当前文档（rel 后缀 + ws 前缀匹配）就拉磁盘新文：
  //   · 手上没有没存的字：直接换成新文（阅读态按标题锚点保住进度；编辑态走最小差异事务，光标不跳）；
  //   · 手上有没存的字：三方合并（基准=上次读到/写下的磁盘原文），两边改的不是同一处就合上、接着自动保存；
  //     改到了同一处就进冲突横幅，绝不拿编辑器里的旧稿盖掉别处的新修改（以前这里直接跳过，下一次自动
  //     保存就把别处的修改整篇覆盖了）；
  //   · 自己的写正在途：等写完再看，免得拿半截状态去合并。
  // 服务端的写前校验（baseHash → 409）兜住事件没到、或本地文件这类没有事件的情况。
  let fsT = null, pendingFs = false;
  async function refreshFromDisk() {
    const my = ++seq, c = cur, key = draftKeyOf(c);
    if (c.text != null || !c.url || trunc) return;   // 本地 SAF 文件不是 agent 改的对象；截断显示的大文件不跟（每次事件重拉几 MB）
    try {
      const text = await readDisk(c);
      if (text == null) return;
      if (my !== seq || loading) return;
      if (saving) { pendingFs = true; return; }
      if (conflict?.key === key) { if (text !== conflict.theirs) conflict = { key, theirs: text }; return; }
      if (text === original) return;
      const base = original, mine = content;
      if (mine === base) {
        if (isMd && mode === 'preview') { grabScroll(); pendingScroll = true; }
        original = text;
        applyText(text, true);
        syncLinks(c, text);
        showToast(t('已同步 Claude 的修改'));
        return;
      }
      const m = merge3(base, mine, text);
      if (m == null) { conflict = { key, theirs: text }; clearTimeout(saveT); return; }
      original = text;
      applyText(m);
      showToast(t('已合并别处对这篇的修改'));
      resave(true);
    } catch { /* 跟盘失败无害，下次事件再试 */ }
  }
  // 换正文：编辑器在就走最小差异事务（光标随改动映射、Ctrl+Z 可撤销，content 由 onChange 回写）；
  // raw=true 时再把 content 设成磁盘原样（CRLF 文件：编辑器里是 LF，不设的话会被当成改动、白写一遍）
  function applyText(x, raw = false) {
    if (editor && edFor === draftKey) editor.applyText(x);
    else content = x;
    if (raw) content = x;
  }
  let fsSeen = 0;   // 只认新事件：效应因 mode/dirty 等其它依赖重跑时不重复拉取
  $effect(() => {
    if (fsChange.seq === fsSeen) return;
    const st = cur?.saveTarget;
    if (!fsChange.path || loading || !st || st.origin !== 'cloud') return;
    if (!fsMatches(fsChange.path, { ws: st.ws || '', rel: st.rel || '' })) return;
    fsSeen = fsChange.seq;
    clearTimeout(fsT);
    fsT = setTimeout(() => untrack(refreshFromDisk), 400);   // 连续多次 Edit 只刷最后一拍
    return () => clearTimeout(fsT);
  });

  // —— 保存：以发出那一刻的快照为准（验收 e2e-4 / e2e-3）——
  // 写请求在途时用户还会打字、跳去别的笔记、甚至关掉查看器：await 之后不再读 cur/draftKey/dirty 这些
  // 派生量（那时它们可能已指向另一篇，组件也可能已卸载），只认发出时拍下的那篇、那份文本——
  // 只把真正写出去的那份记为已保存；草稿只在恰好等于那份时才删。同一篇同时只发一个请求：
  // 在途期间又要存的记一笔，回来后按那时的最新内容补发；已经跳走/关掉的，拿草稿（每次改动都记）补发。
  // 写入按篇串行（SAVEQ），旧稿不会后到盖新稿。
  let saveT = null, saveFails = 0, alive = true;
  const inflight = new Map();          // 本实例在途的写：文件键 → { again }
  let saveTick = $state(0);            // inflight 变了 → saving 重算
  const saving = $derived((saveTick, inflight.has(draftKey)));
  const topItem = () => stack[stack.length - 1];   // 当前文档（直接读状态，卸载后读也不触发派生量告警）

  // 写前校验：base=这次保存基于的那份磁盘原文。磁盘已经不是它（别处改过）→ 抛 conflict（带磁盘现状），
  // 由 saveDoc 走三方合并，不覆盖。云端交给服务端比指纹（409）；电脑客户端本地文件壳没有读接口，
  // 拿加载时那个地址现读一次；手机本地 SAF 现读比对（后两者读写之间有极小窗口，够用）
  function conflictErr(current) { const e = new Error('conflict'); e.conflict = true; e.current = current; return e; }
  const noBom = (s) => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
  // 现读磁盘全文（跟盘 / 写前校验）：按这篇加载时识别的编码解（GBK 文件拿 r.text() 读出来是乱码，会被当成「别处改过」）
  async function readDisk(c) {
    const e = ENCS.get(draftKeyOf(c));
    const r = await fetch(c.url, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return null;
    if (!e || isUtf8(e.encoding)) return noBom(await r.text());
    return decodeBytes(new Uint8Array(await r.arrayBuffer()), e.encoding);
  }
  async function writeDoc(c, text, base) {
    const st = c.saveTarget, guard = typeof base === 'string';
    // 编码：一律写 UTF-8。原文带 UTF-8 BOM 的补回 BOM（指纹仍按去掉 BOM 的算，同服务端）；
    // 非 UTF-8 的必须先经 save() 里用户确认转码（确认后这里记成 UTF-8）——兜底：没确认的不写，免得静默改了编码
    const enc = ENCS.get(draftKeyOf(c));
    if (enc && !isUtf8(enc.encoding)) throw new Error(t('需要先确认转成 UTF-8'));
    const out = enc?.bom ? '\uFEFF' + text : text;
    if (st.origin === 'cloud' && st.nativeLocation) {
      if (guard && c.url) {
        let cur = null;
        try { cur = await readDisk(c); } catch {}
        if (cur != null && cur !== base) throw conflictErr(cur);
      }
      return nativeWorkspaceWriteText(st.rel, out, st.nativeLocation);
    }
    if (st.origin === 'cloud') {
      try { return await api.saveFileGuarded(st.rel, out, st.ws, guard ? textHash(base) : undefined); }
      catch (e) { if (e?.status === 409 && typeof e.body?.current === 'string') throw conflictErr(e.body.current); throw e; }
    }
    if (guard) { const cur = noBom(localReadText(st.rel)); if (cur && cur !== base) throw conflictErr(cur); }
    const r = localWrite(st.rel, out);
    if (!r || r.error) throw new Error(r && r.error || t('写入失败'));
  }
  function queueWrite(key, c, text, base) {
    const p = (SAVEQ.get(key) || Promise.resolve()).then(() => writeDoc(c, text, base));
    const tail = p.then(() => {}, () => {});
    SAVEQ.set(key, tail);
    tail.then(() => { if (SAVEQ.get(key) === tail) SAVEQ.delete(key); });
    return p;
  }

  function save(quiet = false) {
    cv?.flush();   // CodeView 大文档的改动是防抖回调的：存之前把最后一拍拿回来
    if (!editable || content === original || conflict) return;
    const c = topItem(), key = draftKeyOf(c), enc = ENCS.get(key);
    if (enc && !isUtf8(enc.encoding)) {
      // 原文不是 UTF-8（GBK / Big5 / UTF-16…）：保存只能写 UTF-8，先说清楚再存；自动 / 静默保存不替用户做这个决定
      if (quiet || asking) return;
      const text = content;
      asking = true;
      return uiConfirm(t('这个文件是 {enc} 编码，保存后会转成 UTF-8（其他只认 {enc} 的程序可能读成乱码）。', { enc: encLabel(enc.encoding) }), { okLabel: t('转成 UTF-8 并保存') })
        .then((ok) => {
          if (!ok || !alive || draftKeyOf(topItem()) !== key) return;
          const e = { encoding: 'utf-8', bom: false, eol: enc.eol };
          ENCS.set(key, e);
          encInfo = { key, ...e };
          // 不带写前校验：磁盘上是旧编码的字节，服务端按 UTF-8 算的指纹必然对不上；用户已明确确认覆盖
          return saveDoc(c, text, false, undefined);
        })
        .finally(() => { asking = false; });
    }
    return saveDoc(c, content, quiet, original);
  }
  // base：这次写入基于的磁盘原文（当前文档=original；补存草稿=草稿记的 base）
  async function saveDoc(c, text, quiet, base) {
    const key = draftKeyOf(c);
    const f = inflight.get(key);
    if (f) { f.again = true; return; }
    inflight.set(key, { again: false }); saveTick++;
    let ok = false, clash = null;
    try {
      await queueWrite(key, c, text, base);
      ok = true;
      const d = DRAFTS.get(key);
      if (d?.text === text) DRAFTS.delete(key);
      else if (d) DRAFTS.set(key, { text: d.text, base: text });   // 在途期间又改了：草稿留着兜底，它现在基于刚写下的这份
      if (draftKeyOf(topItem()) === key) {
        original = text; restored = false; saveFails = 0;
        justSaved = true; clearTimeout(savedT); savedT = setTimeout(() => (justSaved = false), 2200);
      }
      if (alive) syncLinks(c, text);   // 出链集合变了才重算索引（见 syncLinks）
      if (!quiet && alive) showToast(t('已保存'));
    } catch (e) {
      if (e?.conflict) clash = e.current;
      else {
        if (draftKeyOf(topItem()) === key) saveFails++;
        if (alive) showToast(t('保存失败：{reason}', { reason: tr(e?.body?.error || e?.message || '') }));
      }
    } finally {
      const again = inflight.get(key)?.again;
      inflight.delete(key); saveTick++;
      const isCur = alive && draftKeyOf(topItem()) === key;
      if (clash != null) onConflict(c, key, text, base, clash);
      else if (isCur) resave(again);
      else if (ok) {
        // 已跳去别的笔记 / 查看器已关：这篇离开时的最新内容在草稿里，比刚写的新就接着补存
        const d = DRAFTS.get(key);
        if (d && d.text !== text) saveDoc(c, d.text, true, d.base);
      }
      if (pendingFs && isCur) { pendingFs = false; refreshFromDisk(); }
    }
  }
  // 保存时发现磁盘已被别处改过：三方合并「基准 → 我这次要写的」「基准 → 磁盘现状」。
  //   · 合得上：磁盘现状成为新原文，正文并入对方的修改（写请求在途期间又打的字也一并保留），接着照常保存；
  //   · 合不上：当前文档停掉自动保存、出冲突横幅；已跳走/已关的那篇把草稿留着原基准，下次打开时
  //     restoreDraft 会发现磁盘≠基准，再合并一次或进冲突区——两种情况都不覆盖别处的修改。
  function onConflict(c, key, text, base, theirs) {
    const m = typeof base === 'string' ? merge3(base, text, theirs) : null;
    if (!(alive && draftKeyOf(topItem()) === key)) {
      if (m != null) { DRAFTS.set(key, { text: m, base: theirs }); saveDoc(c, m, true, theirs); }
      else DRAFTS.set(key, { text, base });
      return;
    }
    if (m != null) {
      const next = content === text ? m : merge3(text, content, m);
      if (next != null) {
        original = theirs;
        applyText(next);
        showToast(t('已合并别处对这篇的修改'));
        resave(true);
        return;
      }
    }
    conflict = { key, theirs };
    clearTimeout(saveT);
  }
  // 冲突横幅：保留我的 = 以磁盘现状为基准写下编辑器里的版本（用户明确选择覆盖别处这次修改）；
  // 用最新版 = 正文换成磁盘版本（编辑器里是一个事务，想要回自己的字可以撤销）
  function keepMine() {
    const cf = conflict;
    if (!cf || cf.key !== draftKeyOf(cur)) return;
    conflict = null;
    saveDoc(topItem(), content, false, cf.theirs);
  }
  function takeTheirs() {
    const cf = conflict;
    if (!cf || cf.key !== draftKeyOf(cur)) return;
    conflict = null;
    original = cf.theirs;
    applyText(cf.theirs, true);
    DRAFTS.delete(cf.key);
  }
  // 写完之后当前文档仍有没存的：失败按 3s 重试（限 3 次，草稿始终兜底）；在途期间有人要过保存就立刻补发；
  // md 编辑态照常 1.2s 自动保存（文本文件仍是手动保存，不替它自动存）
  function resave(again) {
    if (content === original || !editable || conflict) return;
    clearTimeout(saveT);
    if (saveFails > 0) { if (saveFails < 3) saveT = setTimeout(() => save(true), 3000); return; }
    if (again || (mdAuto && mode !== 'preview')) saveT = setTimeout(() => save(true), again ? 0 : 1200);
  }

  // md 编辑态：停笔 1.2s 自动落盘（Obsidian 无保存键心智）；文本文件仍手动保存
  $effect(() => {
    content;
    if (loading || !mdAuto || mode === 'preview' || !dirty || conflict) return;
    clearTimeout(saveT);
    saveT = setTimeout(() => save(true), 1200);
    return () => clearTimeout(saveT);
  });

  // md 可保存 → 离开时静默落盘（失败有草稿兜底）；只有不可自动保存时才弹确认。
  // 确认走应用内弹窗（异步），所以改成「把离开后要做的事 go 交进来」：
  //   干净 / 已自动保存 → 当场同步执行（返回键、点链接的手感不变）；
  //   要问 → 等用户答完，且这期间还停在同一篇、查看器也没被关掉，才执行。
  // 系统返回的层回调（popNote）因此仍是同步的：先把这次返回吃掉，再异步问。
  let asking = false, gone = false;
  $effect(() => () => { gone = true; });
  function guardDirty(go) {
    if (!dirty) { go(); return; }
    if (mdAuto) { save(true); go(); return; }
    if (asking) return;   // 已经在问了（连点返回 / 连按返回键）：不排第二个同样的确认
    asking = true;
    const at = cur;
    uiConfirm(t('有未保存的修改，确定离开？（草稿会临时保留）'), { okLabel: t('离开') })
      .then((ok) => { if (ok && !gone && cur === at) go(); })
      .finally(() => { asking = false; });
  }
  // 外框的关闭钮 / Esc 先问这里：true = 自己消费了（未保存且用户取消、或退回上一篇笔记），false = 交给外框关查看器
  function back() {
    if (leaving) return false;                     // 已经问过并确认离开：放行给外框关
    cv?.flush();                                   // 代码编辑器的最后一笔（防抖还没回写 content）先收进来再判脏
    if (!dirty || mdAuto) {            // 干净 / 可静默落盘：同步决定，手感不变
      if (dirty) save(true);
      if (stack.length > 1) { stack = stack.slice(0, -1); return true; }
      return false;
    }
    guardDirty(() => {                             // 要问：先吃掉这次关闭，答「离开」后再退一篇或关查看器
      if (stack.length > 1) stack = stack.slice(0, -1);
      else { leaving = true; viewer.close(); }
    });
    return true;
  }
  let leaving = false;
  function popNote() {
    if (stack.length > 1) guardDirty(() => { if (stack.length > 1) stack = stack.slice(0, -1); });
  }
  $effect(() => { if (stack.length > 1) return pushBackLayer(popNote); });   // 系统返回：先弹笔记栈，再轮到关查看器

  // —— 文本文件（非 md）：查看 ⇄ 编辑。默认只读查看（CodeView），编辑入口在顶栏工具与 ⋮ 菜单 ——
  const textDoc = $derived(isText && !isMd && !loading && !loadError);
  function setTextMode(m) {
    if (m === mode || isMd) return;
    if (m === 'edit' && !editable) return;
    cv?.flush();
    mode = m;
  }
  const toggleEdit = () => setTextMode(mode === 'edit' ? 'view' : 'edit');
  // —— md 阅读态：查找（Ctrl+F）+ 键盘滚动 ——
  // 查找：共用 FindBar + CSS 自定义高亮（::highlight），不改 DOM、不打断选区，与 Word 快速预览同一做法；
  //   不支持的内核退化成选中当前命中。正文分块渲染 / 双链索引到货重渲时按原查询重扫（保住当前第几个）。
  // 滚动：焦点在 .doc-scroll 里（打开时给它、点正文也会落到它上面）由浏览器原生滚；焦点在顶栏 / 外框上时
  //   这里代滚一下并把焦点交回滚动区，之后的键又回到原生滚动。
  const HL = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';
  let fOpen = $state(false), fQuery = $state(''), fCur = $state(0), fTotal = $state(0), fCase = $state(false);
  let findBar = $state(null);
  let fHits = [];
  const F_MAX = 5000;
  function clearHl() { if (HL) { CSS.highlights.delete('md-hit'); CSS.highlights.delete('md-cur'); } }
  function mdSearch(q, keep = false) {
    const was = fCur;
    clearHl();
    fHits = []; fCur = 0; fTotal = 0;
    if (!q || !pageEl || !docScrollEl) return;
    const needle = fCase ? q : q.toLowerCase();
    const walker = document.createTreeWalker(pageEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement;
        if (!p || p.closest('.doc-tailhost, .doc-rendering, style, script')) return NodeFilter.FILTER_REJECT;
        return p.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;   // 折叠着的块里的字不算
      },
    });
    for (let n = walker.nextNode(); n && fHits.length < F_MAX; n = walker.nextNode()) {
      const raw = n.data;
      // 不区分大小写：整段转小写再找；大小写折叠改了长度的极少数字符（İ 之类）就按原文、原样的查询词找，免得区间错位
      const low = fCase ? raw : raw.toLowerCase();
      const fold = !fCase && low.length === raw.length;
      const s = fold ? low : raw;
      const nd = fCase || fold ? needle : q;
      for (let i = s.indexOf(nd); i >= 0 && fHits.length < F_MAX; i = s.indexOf(nd, i + nd.length)) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + nd.length);
        fHits.push(r);
      }
    }
    fTotal = fHits.length;
    if (!fHits.length) return;
    if (keep && was) { fCur = Math.min(was, fHits.length); paintHits(); return; }
    // 从当前看到的位置往后找第一个
    const top = docScrollEl.getBoundingClientRect().top;
    const k = fHits.findIndex((r) => r.getBoundingClientRect().bottom >= top);
    fCur = (k < 0 ? 0 : k) + 1;
    paintHits(); revealHit();
  }
  function paintHits() {
    const c = fHits[fCur - 1];
    if (HL) {
      CSS.highlights.set('md-hit', new Highlight(...fHits));
      if (c) { const one = new Highlight(c); one.priority = 1; CSS.highlights.set('md-cur', one); }
    } else if (c) {
      try { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(c); } catch {}
    }
  }
  function revealHit() {
    const c = fHits[fCur - 1];
    if (!c || !docScrollEl) return;
    const r = c.getBoundingClientRect(), sr = docScrollEl.getBoundingClientRect();
    const topGap = viewer.touch ? 16 : 64;   // 电脑查找卡浮在右上角，命中别藏在它下面
    if (r.top < sr.top + topGap || r.bottom > sr.bottom - 40) docScrollEl.scrollTop += r.top - sr.top - Math.round(sr.height / 3);
  }
  function mdStep(dir) {
    if (!fHits.length) return;
    fCur = ((fCur - 1 + dir + fHits.length) % fHits.length) + 1;
    paintHits(); revealHit();
  }
  function mdCase(on) { fCase = on; mdSearch(fQuery); }
  function openMdFind() {
    if (isMd && mode !== 'preview') return;
    if (fOpen) { findBar?.focus(); return; }
    fOpen = true;
  }
  function closeMdFind() {
    // 焦点还在查找条里就交回正文滚动区（查找条一卸载焦点会掉到 body，Tab 从头走、键盘滚不动）
    const a = document.activeElement;
    if (fOpen && docScrollEl && (!a || a === document.body || a.closest?.('.fb'))) try { docScrollEl.focus({ preventScroll: true }); } catch {}
    fOpen = false; fQuery = ''; fHits = []; fCur = 0; fTotal = 0; clearHl();
  }
  // 换篇 / 切到编辑或源码：收起查找
  $effect(() => { cur.key; mode; untrack(() => { if (fOpen) closeMdFind(); }); });
  // 正文换了（分块续渲、双链索引到货重渲）：按原查询重扫，区间才不会指向已被替换掉的节点
  $effect(() => { mdBlocks; if (untrack(() => fOpen && fQuery)) tick().then(() => { if (fOpen && fQuery) mdSearch(fQuery, true); }); });
  $effect(() => () => clearHl());
  // 电脑：md 打开（或从编辑切回阅读）后把焦点给滚动区，方向键 / 空格 / PgDn 直接能滚；焦点已在别的控件上就不抢
  $effect(() => {
    if (!isMd || mode !== 'preview' || loading || loadError || !docScrollEl || viewer.touch || viewer.active === false) return;
    const el = docScrollEl;
    tick().then(() => {
      const a = document.activeElement, root = viewer.root?.();
      if (el.isConnected && (!a || a === document.body || a === root)) try { el.focus({ preventScroll: true }); } catch {}
    });
  });
  function mdKeys(e) {
    if (mode !== 'preview' || !docScrollEl) return false;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyF') { openMdFind(); return true; }
    if (fOpen && (k === 'F3' || (mod && !e.altKey && e.code === 'KeyG'))) { if (fQuery) mdStep(e.shiftKey ? -1 : 1); else findBar?.focus(); return true; }
    if (k === 'Escape' && fOpen) { closeMdFind(); return true; }
    if (mod || e.altKey || isEditable(e.target)) return false;
    if (docScrollEl.contains(e.target)) return false;   // 焦点在滚动区里：浏览器原生滚（含平滑与连按加速）
    const el = docScrollEl, page = Math.max(40, el.clientHeight - 48);
    let dy = null, to = null;
    switch (k) {
      case 'ArrowDown': dy = 48; break;
      case 'ArrowUp': dy = -48; break;
      case 'PageDown': dy = page; break;
      case 'PageUp': dy = -page; break;
      case ' ': if (e.target?.closest?.('button, a, [role="button"]')) return false; dy = e.shiftKey ? -page : page; break;
      case 'Home': to = 0; break;
      case 'End': to = el.scrollHeight; break;
      default: return false;
    }
    if (to != null) el.scrollTo({ top: to }); else el.scrollBy({ top: dy });
    try { el.focus({ preventScroll: true }); } catch {}
    return true;
  }

  // 查看器键盘：Ctrl+S 存；表格态交给 TableView、代码态交给 CodeView（查找 / 跳行 / 换行 / 字号）；编辑中 Esc 先退回查看
  function docKeys(e) {
    if (loading || loadError || !isText || e.isComposing) return false;
    if (isMd) return mdKeys(e);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyS') { if (editable && dirty) save(); return true; }
    if (showTable ? tv?.handleKey(e) : cv?.handleKey(e)) return true;
    if (e.key === 'Escape' && mode === 'edit') { setTextMode('view'); return true; }
    return false;
  }
  function docTools() {
    if (isMd && mode === 'preview' && !loading && !loadError && !viewer.touch) return [{ id: 'find', icon: 'search', label: t('查找'), kbd: 'Ctrl+F', active: fOpen, onClick: openMdFind }];
    if (!textDoc) return [];
    const edit = editable ? { id: 'edit', icon: 'edit', label: mode === 'edit' ? t('完成编辑') : t('编辑'), active: mode === 'edit', onClick: toggleEdit } : null;
    if (showTable) {
      return [
        { id: 'raw', icon: 'code', label: t('查看原文'), onClick: () => (tableRaw = true) },
        { id: 'find', icon: 'search', label: t('筛选行'), kbd: 'Ctrl+F', onClick: () => tv?.openFind() },
        edit,
      ].filter(Boolean);
    }
    const out = [];
    if (isDelim && mode !== 'edit') out.push({ id: 'table', icon: 'table', label: t('表格视图'), onClick: () => (tableRaw = false) });
    else if (!viewer.touch) out.push({ id: 'wrap', icon: 'wrap', label: t('自动换行'), kbd: 'Alt+Z', active: wrap, onClick: () => (wrap = !wrap) });
    out.push({ id: 'find', icon: 'search', label: t('查找'), kbd: 'Ctrl+F', onClick: () => cv?.openFind() });
    if (edit) out.push(edit);
    return out.slice(0, 3);
  }
  function docMenu() {
    const out = [];
    if (item.origKind === 'image') out.push({ id: 'asImage', label: t('查看图片'), icon: 'image', onSelect: () => previewViewAs('image') });
    if (!isText || loading || loadError) return out;
    if (isMd && mode === 'preview') out.push({ id: 'find', label: t('查找…'), icon: 'search', kbd: 'Ctrl+F', onSelect: openMdFind });
    if (!isMd) {
      if (editable) out.push({ id: 'edit', label: mode === 'edit' ? t('完成编辑') : t('编辑'), icon: 'edit', onSelect: toggleEdit });
      if (showTable) {
        out.push({ id: 'find', label: t('筛选行…'), icon: 'search', kbd: 'Ctrl+F', onSelect: () => tv?.openFind() });
        out.push({ id: 'goto', label: t('跳到行…'), icon: 'gotoLine', kbd: 'Ctrl+G', onSelect: () => tv?.openGoto() });
        out.push({ id: 'raw', label: t('查看原文'), icon: 'code', onSelect: () => (tableRaw = true) });
      } else {
        out.push({ id: 'find', label: t('查找…'), icon: 'search', kbd: 'Ctrl+F', onSelect: () => cv?.openFind() });
        out.push({ id: 'goto', label: t('跳到行…'), icon: 'gotoLine', kbd: 'Ctrl+G', onSelect: () => cv?.openGoto() });
        out.push({ id: 'wrap', label: t('自动换行'), icon: 'wrap', kbd: 'Alt+Z', checked: wrap, keepOpen: true, onSelect: () => (wrap = !wrap) });
        out.push({ id: 'fs', label: t('字号'), icon: 'textSize', submenu: { title: t('字号'), items: () => [
          { id: 'fsUp', label: tc('字号', '放大'), icon: 'zoomIn', kbd: 'Ctrl+=', keepOpen: true, onSelect: () => cv?.zoom(1) },
          { id: 'fsDown', label: tc('字号', '缩小'), icon: 'zoomOut', kbd: 'Ctrl+-', keepOpen: true, onSelect: () => cv?.zoom(-1) },
          { id: 'fsReset', label: t('默认大小'), kbd: 'Ctrl+0', onSelect: () => cv?.zoomReset() },
        ] } });
        if (isDelim && mode !== 'edit') out.push({ id: 'table', label: t('表格视图'), icon: 'table', onSelect: () => (tableRaw = false) });
        if (jsonCan && mode !== 'edit') out.push({ id: 'json', label: jsonRaw ? t('格式化显示') : t('查看原文'), icon: 'code', onSelect: () => (jsonRaw = !jsonRaw) });
      }
    }
    if (out.length) out.push({ sep: true });
    const ce = curEnc;
    out.push({ id: 'enc', label: t('编码'), icon: 'encoding', detail: ce ? encLabel(ce.encoding, ce.bom) : '', submenu: { title: t('通过编码重新打开'), items: () =>
      ENCODINGS.map((x) => ({ id: 'enc:' + x.value, label: x.label, checked: curEnc?.encoding === x.value, onSelect: () => reopenAs(x.value) })) } });
    out.push({ id: 'copyAll', label: t('复制全文'), icon: 'copy', onSelect: () => { cv?.flush(); copyText(content).then((ok) => showToast(ok ? t('已复制') : t('复制失败'))); } });
    return out;
  }

  // —— 向外框声明顶栏 ——
  $effect(() => viewer.declare({
    title: () => cur.name,
    dragItem: () => cur,
    subtitle: '',                 // 不要外框默认的画廊计数（副标题是保存状态 / 文件夹，见 subHead）
    subtitleSnippet: subHead,
    barEnd: barEndSnip,
    onBack: back,
    tools: docTools,
    menu: docMenu,
    keys: docKeys,
  }));
  // 恢复 / 合并了草稿：常驻一条提示，直到保存或换篇（原 .doc-restored）
  $effect(() => {
    if (!restored || stale || conflict) return;
    const h = viewer.toast(restored === 'merged' ? t('已把未保存的草稿与别处的新修改合并') : t('已恢复未保存草稿'), { ms: 0 });
    return () => h.close();
  });

  // —— md 双链数据（/api/file/mdlinks；按 rel 缓存，返回导航秒出，后台刷新）——
  const LINKS_CACHE = (window.__bridgeMdLinks ||= new Map());
  let links = $state(null);
  // 当前文档的出链索引在路上、手上又没有缓存可先用：![[图]] 先占位（embedUrl 给 ''），不按「笔记同目录/名字」
  // 猜一个地址发请求——猜错就是每张图一次 404 加一闪裂图，索引到了再换真地址
  let linksPending = $state(false);
  let linksFor = '';   // links 属于哪篇（linksKeyOf）：同一篇刷新时旧索引留到新的到货，换篇才清空（不然阅读态整篇重渲两次、图先掉回兜底地址再换回）
  async function loadLinks(c) {
    const cacheKey = linksKeyOf(c);
    if (linksFor !== cacheKey) { links = null; linksFor = cacheKey; }
    linksPending = false;
    // primary 的双链/反链仍由服务端算（它就在 vault 根上）；服务端不认识的位置（额外位置 / 连远端时这台电脑的文件）才跳过。
    if (c.kind !== 'markdown' || c.saveTarget?.origin !== 'cloud' || nativeLocLocalOnly(c.saveTarget?.nativeLocation)) return;
    const rel = c.saveTarget.rel;
    if (LINKS_CACHE.has(cacheKey)) links = LINKS_CACHE.get(cacheKey);
    else if (!links) linksPending = true;
    try {
      const r = await api.mdLinks(rel, c.saveTarget.ws);
      LINKS_CACHE.set(cacheKey, r);
      if (linksKeyOf(cur) === cacheKey) links = r;
    } catch {}
    finally { if (linksKeyOf(cur) === cacheKey) linksPending = false; }   // 失败也收：退回按名单/同目录解析
  }
  // 保存/跟盘后要不要重算出链：只看正文里的出链集合（[[ ]] / ![[ ]] / 相对 md 链接）变没变——反链是别的
  // 笔记链过来的，跟这篇怎么改无关。以前每次自动保存（≥10s 一次）都整篇重算，服务端每次读整棵树的 md。
  // 变了也按 10s 限频合并（连着改几个链接只算最后一次）
  const linkSigs = new Map();   // linksKeyOf → 上次拉索引时的出链集合
  let linksT = null, lastLinksAt = 0;
  const linkSigOf = (text) => [...new Set(Array.from(String(text).matchAll(/(!?)\[\[([^[\]\n]+?)\]\]|\]\(([^()\s]+?\.md)\)/gi),
    (m) => (m[2] != null ? m[1] + m[2].split(/[|#]/)[0].trim().toLowerCase() : 'md:' + m[3].toLowerCase())))].sort().join('\n');
  function syncLinks(c, text) {
    const key = linksKeyOf(c), sig = linkSigOf(text);
    if (linkSigs.get(key) === sig) return;
    linkSigs.set(key, sig);
    clearTimeout(linksT);
    linksT = setTimeout(() => {
      lastLinksAt = Date.now();
      LINKS_CACHE.delete(key);
      if (alive && linksKeyOf(topItem()) === key) loadLinks(topItem());
    }, Math.max(0, lastLinksAt + 10_000 - Date.now()));
  }
  const outLinks = $derived(links?.outgoing?.filter((o) => !o.embed) || []);
  const blCount = $derived(links?.backlinks?.reduce((n, b) => n + b.count, 0) || 0);

  // —— 笔记结构：frontmatter 属性 + 正文渲染 + 统计 ——
  const note = $derived(isMd ? parseNote(content) : null);
  // 词数/字符数只在尾栏显示，不必逐键重算（长文档每键整篇扫一遍）：打开/换篇/存盘后当场算，编辑中停笔 400ms 再算
  let stats = $state(null), statsT = null, statsFor = '';
  $effect(() => {
    const body = note?.body, key = draftKey;
    clearTimeout(statsT);
    if (body == null) { stats = null; return; }
    if (statsFor !== key || loading || !dirty) { statsFor = key; stats = noteStats(body); return; }
    statsT = setTimeout(() => { stats = noteStats(body); }, 400);
    return () => clearTimeout(statsT);
  });
  let propsOpen = $state(true);

  const dirOf = (rel) => String(rel || '').split('/').slice(0, -1).join('/');
  function joinRel(dir, p) {
    const segs = (dir ? dir.split('/') : []).concat(String(p).split('/'));
    const out = [];
    for (const s of segs) { if (!s || s === '.') continue; s === '..' ? out.pop() : out.push(s); }
    return out.join('/');
  }

  // —— [[ 补全名单（/api/file/mdnames，与 mdlinks 同一棵目录树）——
  // 编辑器补全用；resolveWiki / embedUrl 也拿它兜底：出链只在保存后重算，编辑时新写的 [[X]]
  // 在那之前点开会报「未找到笔记」。按「位置 + 目录」缓存 30s，过期先给旧名单、后台换新。
  // 本地（手机 SAF）没有服务端遍历，退化成同目录；分享只读页/接口不可用时给空表（补全不弹）。
  const NAMES_CACHE = (window.__bridgeMdNames ||= new Map());
  const ATTACH_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|ico|pdf|mp3|wav|m4a|ogg|flac|aac|opus|mp4|webm|mov|mkv|ogv|m4v|canvas|base)$/i;
  const namesKeyOf = (c) => (c.saveTarget?.origin || '') + ':' + (c.saveTarget?.ws || c.saveTarget?.nativeLocation || '') + ':' + dirOf(c.saveTarget?.rel || '');
  let namesNow = null;   // 当前笔记最近拿到的名单（embedUrl 同步查；换文档即清）
  $effect(() => { cur; namesNow = null; });
  async function fetchNames(c) {
    const st = c.saveTarget;
    if (c.kind !== 'markdown' || !st) return [];
    const dir = dirOf(st.rel);
    if (st.origin === 'local') {
      let l; try { l = localList(dir); } catch {}
      const arr = Array.isArray(l?.items) ? l.items : Array.isArray(l) ? l : [];
      return arr.filter((f) => f && !f.isDir && f.name && (MD_EXT_RE.test(f.name) || ATTACH_RE.test(f.name))).map((f) => {
        const md = MD_EXT_RE.test(f.name);
        return { name: md ? f.name.replace(/\.[^.]+$/, '') : f.name, md, path: joinRel(dir, f.name), rel: f.name };
      });
    }
    if (nativeLocLocalOnly(st.nativeLocation)) return [];   // 服务端不认识的位置（同 loadLinks）
    try {
      const r = await api.mdNames(st.rel, st.ws);
      const base = dir ? dir + '/' : '';
      const names = (r?.names || []).map((n) => ({ ...n, rel: base && n.path.startsWith(base) ? n.path.slice(base.length) : n.path }));
      names.truncated = !!r?.truncated;
      return names;
    } catch { return []; }
  }
  function linkNames(c = cur) {
    const key = namesKeyOf(c), hit = NAMES_CACHE.get(key);
    let p = hit?.p;
    if (!hit || Date.now() - hit.at >= 30_000) {
      const fresh = fetchNames(c).then((names) => (names.length || !hit ? names : hit.p));   // 刷新失败别拿空表盖掉旧的
      NAMES_CACHE.set(key, { at: Date.now(), p: fresh });
      p = hit ? hit.p : fresh;
    }
    return p.then((names) => {
      if (namesKeyOf(cur) === key && namesNow !== names) { namesNow = names; refreshEmbeds(); }   // 名单到货：编辑态的嵌入可能解析得出了
      return names;
    });
  }
  // 在名单里认一个 [[名字]]：带路径的按相对路径后缀认（同服务端 mdlinks），裸名先笔记后附件；
  // 名单已按离当前笔记的远近排好，取第一个就是最浅的那个（与 mdlinks「同名取最浅」一致）
  function findInNames(names, target) {
    const k = String(target || '').trim().replace(/\\/g, '/').toLowerCase();
    if (!k || !names?.length) return null;
    const noExt = k.replace(/\.(md|markdown|mdown|mkd)$/, '');
    if (k.includes('/')) {
      return names.find((n) => {
        const s = (n.md ? n.path.replace(/\.[^./]+$/, '') : n.path).toLowerCase();
        const want = n.md ? noExt : k;
        return s === want || s.endsWith('/' + want);
      }) || null;
    }
    return names.find((n) => n.md && n.name.toLowerCase() === noExt) || names.find((n) => !n.md && n.name.toLowerCase() === k) || null;
  }
  // [[笔记#标题 补全：认出那篇笔记、取原文（标题由补全侧抽取并缓存）
  async function readNote(name) {
    const c = cur, st = c.saveTarget;
    if (!st) return null;
    const k = String(name).toLowerCase();
    const o = links?.outgoing?.find((x) => x.path && x.name.toLowerCase() === k);
    const rel = o?.path || findInNames(await linkNames(c), name)?.path;
    if (!rel || !MD_EXT_RE.test(rel)) return null;
    if (rel === st.rel) return content;
    if (st.origin === 'local') { try { return localReadText(rel); } catch { return null; } }
    try {
      const r = await fetch(cloudFileUrl(rel, { ws: st.ws, nativeLocation: st.nativeLocation }), { cache: 'no-store', credentials: 'same-origin' });   // 同 load()：别拿 30s 缓存里的旧标题
      return r.ok && +(r.headers.get('content-length') || 0) < 2_000_000 ? await r.text() : null;
    } catch { return null; }
  }

  // ![[嵌入]] / 相对资源 → 可加载 URL：mdlinks 已解析的路径优先，回落同目录拼接。
  // wiki=true（![[名字]]，按全库名字解析）且出链索引还在路上、名单里也没有 → ''（占位，见 linksPending）
  // media：这些地址落在 <img> 上，局域网直连时要走 mediaUrl（手机 WebView 的 <img> 经 LAN 会整批裂图，见 server.js）
  const fileUrlOf = (st, rel) => (st.origin === 'cloud' ? cloudFileUrl(rel, { ws: st.ws, nativeLocation: st.nativeLocation, media: true }) : localFileUrl(rel));
  const resolvedEmbed = (name) => {
    const k = String(name).toLowerCase();
    return links?.outgoing?.find((o) => o.path && o.name.toLowerCase() === k)?.path
      || findInNames(namesNow, name)?.path || null;   // 编辑时新插的 ![[附件]]：出链还没重算，先认补全名单
  };
  // 改写出去的 URL → 工作区相对路径：阅读态里 [附件](x.pdf) 的 href 已换成可加载 URL，点它时据此认回原文件，
  // 压一层进查看器（不让浏览器直接跳到裸 URL——网页版会离开 bridge，桌面壳会丢给系统浏览器）
  const embedBack = new Map();
  function embedUrl(name, wiki = false) {
    const st = cur.saveTarget;
    // Claude / Codex / dimensio 产物（没有 saveTarget）：按这篇在本机的路径解析同目录资源，走各家产物接口（lib/docres.js）
    if (!st) { const d = siblingDesc(cur, name); return d ? normalizeItem(d).url : null; }
    const rel = resolvedEmbed(name);
    if (!rel && wiki && linksPending) return '';
    const r = rel || joinRel(dirOf(st.rel), name);
    const u = fileUrlOf(st, r);
    if (u) { embedBack.set(u, r); if (embedBack.size > 400) embedBack.delete(embedBack.keys().next().value); }
    return u;
  }
  // 主地址只是猜的（索引和名单里都没有：额外授权位置、手机本地、索引失败）时的备选：<笔记目录>/attachments/<名字>
  //（bridge 插图的落盘处，同 saveAttachment）。阅读态/编辑态的图加载失败时按序换上
  function embedAlts(name) {
    const st = cur.saveTarget;
    if (!st || String(name).includes('/') || resolvedEmbed(name)) return [];
    return [fileUrlOf(st, joinRel(dirOf(st.rel), ATTACH_DIR + '/' + name))];
  }
  // 阅读态（与编辑态 callout 卡里的 HTML）：img 带 data-alt 的，加载失败换下一个备选（error 不冒泡，挂捕获）
  function embedFallback(e) {
    const img = e.target;
    if (img?.tagName !== 'IMG') return;
    const viaTunnel = mediaFallbackUrl(img.src);   // 走的局域网：先换隧道重试同一张，不算失败
    if (viaTunnel !== img.src) { img.src = viaTunnel; return; }
    if (!img.dataset?.alt) return;
    const [next, ...rest] = img.dataset.alt.split('\n');
    if (rest.length) img.dataset.alt = rest.join('\n'); else img.removeAttribute('data-alt');
    if (EMBED_SRC_OK.test(next)) img.src = next;
  }
  // —— 插图 / 附件（编辑器粘贴、拖入、「插入 ▸ 图片或附件…」→ mdeditor/attach.js 调这里）——
  // 存放位置照 Obsidian「当前文件夹下的子文件夹」：<笔记目录>/attachments/（没有就建）。手机本地（SAF）
  // 不能建目录：已有 attachments/ 就放进去，否则放笔记同目录。链接写法照 Obsidian「尽可能短」：名单里
  // 这个名字只指向刚存的文件就写裸名，否则带上 attachments/ 前缀，免得认到别处的同名图。
  const ATTACH_DIR = 'attachments';
  async function saveAttachment(file, name) {
    const st = cur.saveTarget;
    if (!st || IS_SHARE) throw new Error(t('此文档不可写'));
    const dir = dirOf(st.rel);
    let folder, finalName;
    if (st.origin === 'local') {
      if (file.size > 20 * 1024 * 1024) throw new Error(t('手机本地附件不能超过 20MB'));
      const here = localList(dir);
      const hasSub = here.some((f) => f.isDir && f.name === ATTACH_DIR);
      folder = hasSub ? joinRel(dir, ATTACH_DIR) : dir;
      const taken = new Set((hasSub ? localList(folder) : here).map((f) => f.name.toLowerCase()));
      finalName = name;
      const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
      for (let i = 1; taken.has(finalName.toLowerCase()); i++) finalName = `${base} (${i})${ext}`;   // SAF 同名直接覆盖，先避让
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''));
        fr.onerror = () => reject(fr.error || new Error(t('读取文件失败')));
        fr.readAsDataURL(file);
      });
      const r = localWriteB64(joinRel(folder, finalName), b64);
      if (!r.ok) throw new Error(r.error);
      finalName = r.name || finalName;
    } else {
      if (nativeLocLocalOnly(st.nativeLocation)) throw new Error(t('这个位置暂不支持插入附件'));
      folder = joinRel(dir, ATTACH_DIR);
      const id = 'up' + Math.random().toString(36).slice(2, 12), CHUNK = 1024 * 1024;
      const ws = st.ws ? '&ws=' + encodeURIComponent(st.ws) : '';
      for (let off = 0; ; off += CHUNK) {
        const last = off + CHUNK >= file.size ? 1 : 0;
        const r = await api.post(`/api/files/upload?path=${encodeURIComponent(folder)}&id=${id}&last=${last}&mk=1&name=${encodeURIComponent(name)}${ws}`, file.slice(off, off + CHUNK));
        if (last) { finalName = r?.name || name; break; }
      }
    }
    const rel = joinRel(folder, finalName);
    // 补全/嵌入名单里补上新文件：embedUrl 立刻认得 ![[它]]（出链要等保存后才重算）
    const entry = { name: finalName, md: false, path: rel, rel: rel.slice(dir ? dir.length + 1 : 0) };
    let names = [];
    try { names = await linkNames(); } catch {}
    const clash = findInNames(names, finalName);
    // 手机本地的名单只列笔记同目录，放进 attachments/ 的下次打开就认不出裸名 → 一律带前缀
    const link = (clash && clash.path !== rel) || (st.origin === 'local' && folder !== dir) ? entry.rel : finalName;
    for (const list of [names, namesNow]) if (list && !list.some((n) => n.path === rel)) list.push(entry);
    return { link, rel };
  }

  // 拖进来的文件本来就在这个工作空间里（桌面端从文件面板 / 资源管理器拖）：不复制，直接写链接（Obsidian
  // 从侧栏拖笔记/附件同款）。绝对路径→相对路径由服务端换算（壳不把位置根的绝对路径给页面）。
  // 笔记目录子树里的写 [[ ]]（同名唯一写裸名，否则带相对笔记目录的路径；md 去扩展名、不嵌入）；
  // 子树外的 [[ ]] 认不到（名单只扫子树），写标准相对链接 ![](../x.png) / [名](../x.md)。
  async function linkExisting(file) {
    const st = cur.saveTarget;
    if (!st || st.origin !== 'cloud' || nativeLocLocalOnly(st.nativeLocation)) return null;
    const abs = nativePathForFile(file);
    if (!abs) return null;
    let rel = null;
    try { rel = (await api.post('/api/files/relpaths', { paths: [abs], ws: st.ws || '' }))?.rels?.[0] || null; } catch {}
    if (!rel) return null;
    const dir = dirOf(st.rel), name = rel.split('/').pop();
    const md = MD_EXT_RE.test(name), embed = !md && ATTACH_RE.test(name) && !/\.(canvas|base)$/i.test(name);
    if (!dir || rel.startsWith(dir + '/')) {
      const sub = dir ? rel.slice(dir.length + 1) : rel;
      const bare = md ? name.replace(/\.[^.]+$/, '') : name;
      let names = [];
      try { names = await linkNames(); } catch {}
      const hit = findInNames(names, bare);
      const target = hit && hit.path !== rel ? (md ? sub.replace(/\.[^.]+$/, '') : sub) : bare;
      return { text: (embed ? '!' : '') + '[[' + target + ']]' };
    }
    const up = dir.split('/'), down = rel.split('/');
    let k = 0;
    while (k < up.length && k < down.length - 1 && up[k] === down[k]) k++;
    const relPath = [...Array(up.length - k).fill('..'), ...down.slice(k)].join('/').replace(/ /g, '%20');
    return { text: embed ? `![](${relPath})` : `[${md ? name.replace(/\.[^.]+$/, '') : name}](${relPath})` };
  }

  // —— 阅读态分块渐进渲染 ——
  // 整篇同步 renderObsMarkdown 在大文档（长研报/大量公式表格）上会把主线程冻住十几秒起：
  // 转圈是合成器线程在动、点返回却毫无反应——「卡加载还退不出去」的真相就是这一口气渲染。
  // 复用聊天流式的 findSafeCut 顶层块切点把正文切成 ~8KB 块：首块当帧就出，其余块按
  // 每帧 ~12ms 预算分帧追加，返回/切模式随时点随时走。块前缀字符串不变，Svelte each
  // 直接跳过已渲染块，追加只长尾巴。
  let mdBlocks = $state([]);        // 已出炉的 HTML 块
  let mdRendering = $state(false);  // 队列里还有块（文末出细转圈）
  let renderJob = 0;
  // 同一篇重渲（双链索引晚到 / 后台刷新）：旧 DOM 留到新块全部渲完再一次换上，不先截短成半篇；
  // 换的那一刻手指 / 鼠标正按在正文上（或刚抬起 350ms 内）就再等等——点下去的链接被换掉，这一下 click 会落空
  let mdBody = null;
  let mdPress = 0;
  const mdPressing = () => performance.now() < mdPress;
  function splitTopBlocks(text) {
    const parts = [];
    let rest = text;
    for (;;) {
      const cut = findSafeCut(rest, 8000, 400);
      if (cut < 0) break;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) parts.push(rest);
    return parts;
  }
  $effect(() => {
    // 显式依赖：正文 + 双链索引（![[嵌入]]/相对资源 URL 靠 links 解析，索引到货要重渲染；在路上时嵌入先占位）
    const body = isMd && mode === 'preview' && !loading && !loadError ? (note?.body ?? '') : null;
    links; linksPending;
    const job = ++renderJob;
    const same = body != null && body === mdBody && untrack(() => mdBlocks.length > 0);
    mdBody = body;
    if (body == null) { mdBlocks = []; mdRendering = false; return; }
    const parts = splitTopBlocks(body);
    // 脚注定义预扫全文：引用和定义常不在同一块，各块共用这一个上下文 → 编号全篇一致，
    // 脚注区等最后一块渲完再补在文末（只出一次）
    const footnotes = scanFootnotes(body);
    const acc = [];
    // 分帧调度：前台跟 rAF 走 60fps；后台页 rAF 被浏览器挂起（本项目老坑），
    // setTimeout 兜底保证切后台也能把剩余块渲完，回前台不是半篇。
    const schedule = () => {
      let ran = false;
      const run = () => { if (ran) return; ran = true; step(); };
      requestAnimationFrame(run);
      setTimeout(run, 250);
    };
    const step = () => {
      if (job !== renderJob) return;
      const t0 = performance.now();
      while (acc.length < parts.length && performance.now() - t0 < 12) acc.push(renderObsMarkdown(parts[acc.length], { embedUrl, embedAlts, footnotes }));
      if (acc.length < parts.length) { if (!same) { mdBlocks = [...acc]; mdRendering = true; } schedule(); return; }
      const notes = renderFootnoteSection(footnotes, { embedUrl, embedAlts });
      const blocks = notes ? [...acc, notes] : [...acc];
      const commit = () => {
        if (job !== renderJob) return;
        if (same && mdPressing()) { setTimeout(commit, 120); return; }
        mdBlocks = blocks;
        mdRendering = false;
      };
      commit();
    };
    step();
    return () => { renderJob++; };   // 卸载/换文档：掐断分帧链
  });

  // —— 文末尾栏：两模式共用一份 DOM，谁在前台谁收编（阅读态挂进 .doc-tailhost；
  //    编辑态由 CM 文末块 widget 收编，见 mdeditor/tail.js）——
  let tailEl = $state(null), tailHost = $state(null);
  $effect(() => { if (tailHost && tailEl) { tailEl.hidden = false; tailHost.appendChild(tailEl); } });

  // —— 点击接管：[[双链]] / 相对 md 链接 → 查看器内跳转；#锚 → 滚到标题 ——
  let mdEl = $state(null);
  // ![[图]] 备选地址的换图（embedFallback）：阅读态正文 + 编辑器容器（callout 卡里的 HTML）各挂一个捕获监听
  $effect(() => {
    const els = [mdEl, edEl].filter(Boolean);
    for (const el of els) el.addEventListener('error', embedFallback, true);
    return () => { for (const el of els) el.removeEventListener('error', embedFallback, true); };
  });
  // 触屏长选区护栏：拖选择柄时固定端滚出屏幕会被浏览器误命中到文首/左侧聊天（选区溢出全文），
  // 活动端拖出正文会跨进别的面板——见 lib/touchSelection.js；拖到上下边缘自动滚动见 touchAutoScroll.js
  let pageEl = $state(null);
  $effect(() => {
    const el = pageEl;
    if (!el) return;
    const down = () => { mdPress = Infinity; };
    const up = () => { if (mdPress === Infinity) mdPress = performance.now() + 350; };
    el.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      mdPress = 0;
      el.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  });
  $effect(() => {
    if (!pageEl) return;
    const offGuard = guardSelection(pageEl, { scroller: () => docScrollEl, allEl: () => mdEl });
    const offScroll = edgeAutoScroll(pageEl, { scroller: () => docScrollEl });
    return () => { offGuard(); offScroll(); };
  });
  // head：[[笔记#标题]] / 相对链接的 #片段——新笔记加载、渲染完后定位到该标题（验收 e2e-8）
  function openNote(rel, head = '') {
    guardDirty(() => {
      // name 必须取 rel 的真实文件名（带扩展名）——normalize 按 name 推 kind，
      // 反链/出链给的是去掉 .md 的展示名，直接用会被当成未知类型走占位页。
      const base = { rel, name: rel.split('/').pop() };
      const it = cur.saveTarget?.origin === 'local'
        ? normalizeItem({ origin: 'local', ...base, text: localReadText(rel) })
        : normalizeItem({ origin: 'cloud', ...base, ws: cur.saveTarget?.ws || '', nativeLocation: cur.saveTarget?.nativeLocation || '' });
      stack = [...stack, it];
      jumpHead = head ? { key: draftKeyOf(it), depth: stack.length, head } : null;
    });
  }
  // 跨笔记跳标题只消费一次（返回/重载这篇不再跳）；两态各自定位：阅读态滚 DOM 标题，编辑态交给 CM
  let jumpHead = null;
  function takeJumpHead() {
    const j = jumpHead;
    if (!j || loading || stack.length !== j.depth || draftKeyOf(cur) !== j.key) return false;
    jumpHead = null;
    pendingScroll = false;
    if (mode === 'preview') {
      // 等 tick：本 effect 与 {@html} 块的更新同一轮 flush、effect 先跑，这时标题还没进 DOM（同代码块头那条）
      tick().then(() => {
        const sc = docScrollEl;
        if (!scrollToHeading(j.head, { instant: true }) || !sc) return;
        const st0 = sc.scrollTop;   // 图片/公式晚到撑高了上文：过一会儿再对一次（用户已经动手就不管）
        setTimeout(() => { if (sc.isConnected && Math.abs(sc.scrollTop - st0) <= 2) findHeadEl(j.head)?.scrollIntoView({ block: 'start' }); }, 250);
      });
    } else if (editor && !editor.scrollToHeading(j.head, { select: false })) showToast(t('找不到标题「{name}」', { name: j.head }));
    return true;
  }
  // 标题匹配：先比原文（忽略大小写、首尾空白），再比 slug 口径（空白/下划线/连字符算同一个 -、去标点）——
  // 相对链接的 #片段常写成 GitHub 式 slug；Obsidian 的 [[笔记#父标题#子标题]] 认最后一段
  const headSlug = (s) => String(s).trim().toLowerCase().replace(/[\s_-]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '');
  function findHeadEl(txt) {
    const hs = [...(mdEl?.querySelectorAll('h1,h2,h3,h4,h5,h6') || [])];
    const raw = String(txt).trim(), last = raw.split('#').filter((s) => s.trim()).pop()?.trim() || raw;
    for (const w of raw === last ? [raw] : [raw, last]) {
      const lw = w.toLowerCase(), sw = headSlug(w);
      const h = hs.find((x) => x.textContent.trim().toLowerCase() === lw) || (sw && hs.find((x) => headSlug(x.textContent) === sw));
      if (h) return h;
    }
    return null;
  }
  function scrollToHeading(txt, { instant = false } = {}) {
    const h = findHeadEl(txt);
    if (h) { h.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' }); return true; }
    showToast(t('找不到标题「{name}」', { name: txt }));
    return false;
  }
  async function resolveWiki(name, head = '') {
    const c = cur, k = String(name).toLowerCase();
    const hit = links?.outgoing?.find((o) => o.path && o.name.toLowerCase() === k)
      || findInNames(await linkNames(c), name);   // 出链只在保存后重算：编辑时新写的 [[X]] 先查补全名单
    if (c !== cur) return;                         // 等名单期间已经跳走了
    if (hit) {
      if (MD_EXT_RE.test(hit.path)) {
        // [[本篇#标题]]：就地跳，不再把同一篇压一层栈重载
        if (head && hit.path === cur.saveTarget?.rel) {
          if (mode === 'preview') scrollToHeading(head);
          else if (!editor?.scrollToHeading(head)) showToast(t('找不到标题「{name}」', { name: head }));
          return;
        }
        return openNote(hit.path, head);
      }
      openAttachment(hit.path);   // 附件类：应用内统一查看器（曾经 window.open 在桌面壳会被丢去系统浏览器）
      return;
    }
    if (cur.saveTarget?.origin === 'local') return resolveLocalWiki(name, head);
    // 产物 md 没有全库索引：[[名字]] 按同目录的「名字.md」开
    if (!cur.saveTarget && artifactRef(cur)) return openRelNote(MD_EXT_RE.test(name) ? name : name + '.md', head);
    showToast(links ? t('未找到笔记「{name}」', { name }) : t('链接索引加载中…'));
  }
  function resolveLocalWiki(name, head = '') {
    const dir = dirOf(cur.saveTarget.rel);
    let l; try { l = localList(dir); } catch {}
    const arr = Array.isArray(l?.items) ? l.items : Array.isArray(l) ? l : [];
    const k = String(name).toLowerCase();
    const hit = arr.find((f) => f && !f.isDir && MD_EXT_RE.test(f.name || '') && String(f.name).replace(/\.[^.]+$/, '').toLowerCase() === k);
    if (hit) openNote(joinRel(dir, hit.name), head);
    else showToast(t('未找到笔记「{name}」', { name }));
  }
  // 相对链接拆成 路径 + #片段（片段交给 openNote 定位标题，不再直接扔掉）
  function splitHref(href) {
    const s = String(href), i = s.indexOf('#');
    let p = i < 0 ? s : s.slice(0, i), h = i < 0 ? '' : s.slice(i + 1);
    try { p = decodeURIComponent(p); } catch {}
    try { h = decodeURIComponent(h); } catch {}
    return [p, h];
  }
  // 阅读态给代码块补围栏头（语言 + 复制）——编辑态的 fence head 有这一条，两边得长一样。
  // 四空格缩进式代码块（pre.indented）编辑态没有围栏行、也就没有头，这里也不补。
  // 等 tick：本 effect 和 {@html} 块的更新在同一轮 flush 里，effect 先跑——直接插会插进马上被
  // 换掉的旧 DOM（katex 到货/正文变了、块字符串变化时整块重建，头就丢了；实测首次打开带公式的
  // 笔记一个头都没有）。tick 之后 DOM 已是新的。
  $effect(() => {
    mdBlocks;
    const el = mdEl;
    if (!el) return;
    tick().then(() => {
      for (const pre of el.querySelectorAll('pre:not(.indented)')) {
        if (pre.firstElementChild?.classList.contains('doc-fence')) continue;
        const lang = (String(pre.querySelector('code')?.className || '').match(/language-([\w+#-]+)/) || [])[1] || '';
        const head = document.createElement('div');
        head.className = 'doc-fence';
        head.innerHTML = '<span class="doc-fence-lang"></span><button type="button" class="doc-fence-copy">' + t('复制') + '</button>';
        head.firstChild.textContent = lang;
        pre.insertBefore(head, pre.firstChild);
      }
      // 带语言的代码块上色（与编辑态同一套解析器与配色）：有这种块才懒加载高亮模块
      const codes = [...el.querySelectorAll('pre:not(.indented) > code[class*="language-"]:not([data-hl])')];
      if (codes.length) import('../../lib/mdeditor/hl.js').then((m) => { for (const c of codes) m.highlightPre(c); }).catch(() => {});
    });
  });

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }

  // 脚注跳转：点上标 → 滚到文末对应条目；条目里的 ↩ → 回到刚才点的那个引用处
  //（同一脚注被引用多次时回到点过的那一处，没点过就回第一处）。落点闪一下，找得到自己跳到了哪儿。
  let lastFnRef = null;
  function jumpFootnote(a) {
    const id = a.dataset.fn || '';
    const esc = window.CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    const q = (sel) => mdEl?.querySelector(sel.replace('$', () => esc));
    let dest;
    if (a.classList.contains('fn-back')) {
      dest = lastFnRef?.isConnected && lastFnRef.dataset.fn === id ? lastFnRef : q('sup.fn-ref a[data-fn="$"]');
    } else {
      lastFnRef = a;
      dest = q('section.footnotes li[data-fn="$"]');
    }
    if (!dest) return;
    dest.scrollIntoView({ behavior: 'smooth', block: 'center' });
    dest.classList.remove('fn-flash');
    void dest.offsetWidth;                    // 重触发动画（连点同一处）
    dest.classList.add('fn-flash');
    setTimeout(() => dest.classList.remove('fn-flash'), 1300);
  }

  // —— 阅读态勾任务（Obsidian 阅读视图同款）：可自动保存的笔记才放开勾选框，点了改源码里那一处 [ ] / [x] 并落盘 ——
  // 勾选框与源码按出现顺序一一对应（跳过 frontmatter 与代码围栏）；数目对不上（嵌入、HTML 里手写的框）就不动，提示去编辑态
  $effect(() => {
    mdBlocks;
    const el = mdEl, on = mdAuto;
    if (!el) return;
    tick().then(() => { for (const cb of el.querySelectorAll('input.task-cb')) cb.disabled = !on; });
  });
  const TASK_RE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\](?=[ \t])/;
  function taskMarks(text) {
    const out = [];
    const fm = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
    let i = fm ? fm[0].length : 0, fence = '';
    while (i < text.length) {
      let j = text.indexOf('\n', i);
      if (j < 0) j = text.length;
      const line = text.slice(i, j);
      const f = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})/.exec(line);
      if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = ''; }
      else if (f) fence = f[1];
      else { const m = TASK_RE.exec(line); if (m) out.push({ pos: i + m[1].length + 1, on: m[2] !== ' ' }); }
      i = j + 1;
    }
    return out;
  }
  // 点中的勾选框：直接点在框上；触屏再放宽到框四周 14px（框 17px，命中 ≥44px）
  function taskCbAt(e) {
    if (!mdAuto || !mdEl) return null;
    const tg = e.target;
    if (tg?.matches?.('input.task-cb')) return tg;
    if (!viewer.touch) return null;
    const cb = tg?.closest?.('li.task-list-item')?.querySelector(':scope > .task-body input.task-cb');
    if (!cb) return null;
    const r = cb.getBoundingClientRect();
    return e.clientX >= r.left - 14 && e.clientX <= r.right + 14 && e.clientY >= r.top - 14 && e.clientY <= r.bottom + 14 ? cb : null;
  }
  function toggleTask(cb, was) {
    const all = [...mdEl.querySelectorAll('input.task-cb')], idx = all.indexOf(cb);
    const marks = taskMarks(content), m = marks[idx];
    if (idx < 0 || marks.length !== all.length || !m || m.on !== was) { showToast(t('这一项没法在阅读态勾选，请到编辑态修改')); return; }
    content = content.slice(0, m.pos) + (m.on ? ' ' : 'x') + content.slice(m.pos + 1);
    save(true);
  }

  function mdClick(e) {
    const tcb = taskCbAt(e);
    if (tcb) { e.preventDefault(); e.stopPropagation(); toggleTask(tcb, tcb === e.target ? !tcb.checked : tcb.checked); return; }
    const cp = e.target.closest('.doc-fence-copy');
    if (cp) {
      e.stopPropagation();
      copyText(cp.closest('pre')?.querySelector('code')?.textContent || '');
      cp.textContent = t('已复制');
      setTimeout(() => (cp.textContent = t('复制')), 1200);
      return;
    }
    const fn = e.target.closest('sup.fn-ref a, a.fn-back');
    if (fn) { e.preventDefault(); jumpFootnote(fn); return; }
    const a = e.target.closest('a');
    if (!a) return;
    if (a.classList.contains('wk')) {
      e.preventDefault();
      const name = a.dataset.wk || '', head = a.dataset.head || '';
      if (!name) { if (head) scrollToHeading(head); return; }
      resolveWiki(name, head);
      return;
    }
    // 相对附件链接：obsmd 已把 href 改写成可加载地址、原文记在 data-rel——点开走应用内查看器，不让浏览器整页跳到裸文件
    const dataRel = a.getAttribute('data-rel');
    if (dataRel) { e.preventDefault(); openRelFile(dataRel); return; }
    const href = a.getAttribute('href') || '';
    const att = href && embedBack.get(href);   // 改写过的相对附件链接：认回原文件，压一层打开
    if (att && !MD_EXT_RE.test(att)) { e.preventDefault(); openAttachment(att); return; }
    if (!href || /^([a-z][a-z0-9+.-]*:|\/)/i.test(href)) return;   // 外链 / 站内 URL / 其他协议放行
    if (href.startsWith('#')) { e.preventDefault(); let h = href.slice(1); try { h = decodeURIComponent(h); } catch {} scrollToHeading(h); return; }
    e.preventDefault();   // 余下都是相对路径：一律查看器内接管
    const [p, h] = splitHref(href);
    if (!p) return;
    if (MD_EXT_RE.test(p)) openRelNote(p, h);
    else openRelFile(p);
  }

  // —— 相对链接（[另一篇](b.md)、[日志](logs/a.log)、[附件](../x.pdf)）：按这篇所在目录解析 ——
  // 工作空间 / 手机本地按 saveTarget；Claude / Codex / dimensio 产物（没有 saveTarget）按产物接口（lib/docres.js）
  function relDescOf(p) {
    const st = cur.saveTarget;
    if (!st) return siblingDesc(cur, p);
    const hit = links?.outgoing?.find((o) => o.path && o.name.toLowerCase() === String(p).toLowerCase());
    const rel = hit ? hit.path : joinRel(dirOf(st.rel), p);
    if (!rel) return null;
    const name = rel.split('/').pop();
    return st.origin === 'local' ? { origin: 'local', rel, name } : { origin: 'cloud', rel, name, ws: st.ws || '', nativeLocation: st.nativeLocation || '' };
  }
  function pushDoc(d, head = '') {
    guardDirty(() => {
      const it = normalizeItem(d.origin === 'local' ? { ...d, text: localReadText(d.rel) } : d);
      stack = [...stack, it];
      jumpHead = head ? { key: draftKeyOf(it), depth: stack.length, head } : null;
    });
  }
  function openRelNote(p, head = '') {
    if (cur.saveTarget) { openNote(joinRel(dirOf(cur.saveTarget.rel), p), head); return; }
    const d = siblingDesc(cur, p);
    if (d) pushDoc(d, head);
    else showToast(t('无法打开这个链接'));
  }
  // 文本类（代码 / 日志 / CSV…）压进本查看器的栈（返回回到这篇）；其余（图 / PDF / 音视频 / 网页…）
  // 在统一查看器里压一层打开（openAttachDesc），返回落回这篇笔记的原位置
  function openRelFile(p) {
    const d = relDescOf(p);
    if (!d) { showToast(t('无法打开这个链接')); return; }
    const k = kindOf(d.name);
    if (k === 'text' || k === 'markdown' || /\.(csv|tsv)$/i.test(d.name)) pushDoc(d);
    else openAttachDesc(d);
  }

  // —— Live Preview / 源码编辑器（CM6，懒加载 chunk；同一实例双模切换）——
  let edEl = $state(null);
  let editor = null, edFor = null;   // 编辑器句柄非响应式；edFor=绑定的文件键
  const wantEditor = $derived(isMd && !loading && !loadError && (mode === 'live' || mode === 'source'));

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
    const st = cur.saveTarget || {};
    openAttachDesc(st.origin === 'local'
      ? { origin: 'local', rel, name: rel.split('/').pop() }
      : { origin: 'cloud', rel, name: rel.split('/').pop(), ws: st.ws || '', nativeLocation: st.nativeLocation || '' });
  }
  // 描述符版（relDescOf / siblingDesc 算好的，含产物 md 的同目录资源）：先记下阅读进度，返回时按它落位
  function openAttachDesc(desc) {
    if (!desc) return;
    grabScroll();
    if (anchor && cur?.key) RESUME.set(cur.key, anchor);
    previewPush(desc, 0, { resume: $state.snapshot(cur) });
  }

  function openRelHref(href) {
    const [p, h] = splitHref(href);
    if (!p) { if (h && !editor?.scrollToHeading(h)) showToast(t('找不到标题「{name}」', { name: h })); return; }   // [x](#标题)：本文内跳
    if (/^(https?:|mailto:|tel:)/i.test(p)) { openExt(p); return; }
    if (MD_EXT_RE.test(p)) { openRelNote(p, h); return; }
    openRelFile(p);
  }

  $effect(() => {
    const want = wantEditor, el = edEl, m = mode, key = draftKey, ro = !editable;
    if (!want || !el) { destroyEditor(); return; }
    let gone = false;
    (async () => {
      const mod = await import('../../lib/mdeditor/index.js');
      if (gone || !edEl) return;
      if (editor && edFor === key) {
        editor.setMode(m === 'live' ? 'live' : 'source');
        embedSig = untrack(() => embedSigOf(content));   // LP 刚按当前解析整篇建过
        if (m === 'live') noteTooBig(mod);
        if (pendingScroll) { pendingScroll = false; applyScroll(); }
        flushEdWaiters();
        return;
      }
      destroyEditor();
      editor = mod.createMdEditor({
        parent: el,
        doc: untrack(() => content),
        mode: m === 'live' ? 'live' : 'source',
        readOnly: ro,
        onChange: (text) => { content = text; },
        onSave: () => save(),
        onNavigate: (name, head) => {
          if (name) resolveWiki(name, head);
          else if (head && !editor?.scrollToHeading(head)) showToast(t('找不到标题「{name}」', { name: head }));
        },
        openLink: (url) => openExt(url),
        openRel: openRelHref,
        resolveUrl: embedUrl,
        resolveAlts: embedAlts,         // ![[图]] 主地址是猜的时候的备选（ImageWidget 加载失败按序换）
        renderMd: (src) => renderObsMarkdown(src, { embedUrl, embedAlts }),
        tailEl: () => tailEl,
        linkNames: () => linkNames(),   // [[ 补全名单（complete.js）
        readNote,                       // [[笔记#标题 补全取那篇笔记的原文
        saveAttachment,                 // 粘贴/拖入/选择的图片与文件存成附件（mdeditor/attach.js）
        linkExisting,                   // 拖进来的是库里已有的文件：直接写链接不复制
      });
      embedSig = untrack(() => embedSigOf(content));
      if (m === 'live') noteTooBig(mod);
      if (!ro) linkNames();             // 进编辑就预取：补全首弹不等网络，新写的链接/嵌入点开也认得
      edFor = key;
      if (!takeJumpHead() && pendingScroll) { pendingScroll = false; applyScroll(); }   // 双链跳标题优先于保进度
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
    for (const m of String(text).matchAll(/!\[\[([^[\]\n]+?)\]\]/g)) s += (embedUrl(m[1].split(/[|#]/)[0].trim(), true) ?? '') + '\n';
    return s;
  }
  function refreshEmbeds() {
    if (!editor || edFor !== draftKey || mode !== 'live') return;
    const sig = embedSigOf(content);
    if (sig === embedSig) return;
    embedSig = sig;
    editor.refresh?.();
  }
  $effect(() => { links; linksPending; untrack(refreshEmbeds); });

  // 文档超过 LP 的上限（mdeditor LP_MAX）时 LP 不做任何装饰、只剩源码——给一句提示，免得以为渲染坏了
  let tooBigFor = '';
  function noteTooBig(mod) {
    if (!mod.LP_MAX || untrack(() => content).length <= mod.LP_MAX || tooBigFor === draftKey) return;
    tooBigFor = draftKey;
    showToast(t('文档过大，已关闭实时预览'));
  }

  // 等编辑器建好（阅读态里粘贴/拖进图片：先切到编辑态，编辑器是懒加载的）
  const edWaiters = [];
  function flushEdWaiters() { while (edWaiters.length) edWaiters.shift()(); }
  function whenEditor() {
    if (editor && edFor === draftKey) return Promise.resolve(editor);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      edWaiters.push(() => { clearTimeout(timer); resolve(editor && edFor === draftKey ? editor : null); });
    });
  }

  // —— 阅读态插图：粘贴 / 拖入文件 → 切到编辑态，落在对应位置（Obsidian 阅读视图不能插图，这里直接替用户切过去；
  // 以前阅读态对粘贴/拖入毫无反应，拖放还冒泡给外层面板，看上去就是「插图失败」）——
  const filesOf = (dt) => (dt?.files?.length ? [...dt.files] : [...(dt?.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean));
  const hasFiles = (dt) => [...(dt?.types || [])].includes('Files');
  // 阅读态 y（相对 doc-scroll 内容顶）→ 源码位置；映射不了就文末
  function readPos(clientY) {
    const sc = docScrollEl, m = sc && readMap();
    if (!m) return null;
    const y = clientY == null ? sc.scrollTop + sc.clientHeight / 2 : sc.scrollTop + clientY - sc.getBoundingClientRect().top;
    return m.toSrc(y)?.pos ?? null;
  }
  async function insertFromRead(files, pos, pasted) {
    if (!editable) { showToast(t('此文档不可写')); return; }
    // 额外授权位置（桌面壳 loc-*）存不了附件（saveAttachment 必然抛错）：当场说清楚，别先切到编辑态再报失败
    const st = cur.saveTarget;
    if (st?.origin === 'cloud' && nativeLocLocalOnly(st.nativeLocation)) {
      showToast(t('插入失败：{reason}', { reason: t('这个位置暂不支持插入附件') }));
      return;
    }
    setMdMode('live');
    const ed = await whenEditor();
    if (!alive) return;
    if (!ed?.insertFiles?.(files, { pos, pasted })) showToast(t('插入失败：{reason}', { reason: files[0]?.name || '' }));
  }
  function readDragOver(e) {
    if (!isMd || !editable || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
  }
  function readDrop(e) {
    if (!isMd || !hasFiles(e.dataTransfer)) return;
    const files = filesOf(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();   // 别再冒泡到外层（工作空间/对话的拖放上传）
    insertFromRead(files, readPos(e.clientY), false);
  }
  function readPaste(e) {
    const cd = e.clipboardData;
    const files = filesOf(cd);
    if (!isMd || !files.length || (cd.getData('text/plain') || '').trim()) return;   // 同编辑态：剪贴板带文字时让文字优先
    e.preventDefault();
    insertFromRead(files, readPos(null), true);
  }
  $effect(() => () => {
    // 关查看器（没有浮层可收时的 Esc、安卓返回都直接卸载组件，绕过 guardDirty）：停笔不到 1.2s、
    // 自动保存还没触发的内容当场补存，不能只留在内存草稿里
    // （卸载后别读派生量 editable：直接按当前文档的保存目标判断）
    // 代码编辑器（CodeView）大文档的改动有 200ms 防抖：先收最后一笔（它这时还没卸载——本 effect 建得比模板早，先拆）；
    // 非 UTF-8 的文件不静默存（保存会转码，要用户点头），留在草稿里
    try { cv?.flush(); } catch {}
    const c = topItem(), st = c?.saveTarget;
    if (st && !IS_SHARE && content !== original && !conflict && (st.origin !== 'local' || hasLocalWrite())
      && isUtf8(ENCS.get(draftKeyOf(c))?.encoding)) saveDoc(c, content, true, original);
    alive = false; destroyEditor(); loadCtrl?.abort(); clearTimeout(linksT); clearTimeout(statsT); flushEdWaiters();
  });   // 组件卸载兜底：编辑器销毁 + 在途加载掐断（在途的写照常发完，见 saveDoc）

  // —— 属性面板（阅读态只读；编辑态的可写面板在 mdeditor/props.js，类型判定共用 obsmd.propKind）——
  const chipText = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v));

  // 反链摘录：转义 + 命中本笔记名的片段加亮
  function blExcerpt(line) {
    const html = escapeHtml(line);
    try { return html.replace(new RegExp(escapeRegex(escapeHtml(String(cur.name).replace(/\.[^.]+$/, ''))), 'gi'), '<b>$&</b>'); }
    catch { return html; }
  }
</script>

<!-- 顶栏副标题（交给外框顶栏渲染）：保存状态优先，平时显示所在文件夹 -->
{#snippet subHead()}
  {#if status}
    {#key status.kind}
      {#if status.kind === 'dirty'}
        <!-- 未保存：点一下立刻存（md 也会在停笔 1.2s 后自动存） -->
        <button class="doc-sub" data-kind="dirty" onclick={() => save()}><i class="doc-sub-dot"></i><span class="doc-sub-t">{status.text}</span></button>
      {:else}
        <span class="doc-sub" data-kind={status.kind}>
          {#if status.kind === 'busy'}<i class="vw-spin doc-sub-spin"></i>
          {:else if status.kind === 'ok'}<VIcon name="check" size={12} stroke={2.4} />
          {:else if status.kind === 'warn'}<VIcon name="error" size={12} stroke={2} />
          {/if}<span class="doc-sub-t">{status.text}</span>
        </span>
      {/if}
    {/key}
  {/if}
  {#if encText}<span class="doc-sub doc-sub-enc" class:solo={!status}>{encText}</span>{/if}
{/snippet}

<!-- 顶栏自定义区（交给外框）：md 的阅读 / 编辑 / 源码三段；纯文本有改动时的保存钮 -->
{#snippet barEndSnip()}
  {#if isMd}
    <div class="doc-seg">
      <span class="doc-seg-cap" style:transform="translateX({mode === 'live' ? '100%' : mode === 'source' ? '200%' : '0'})"></span>
      <button class:on={mode === 'preview'} onclick={() => setMdMode('preview')}>{t('阅读')}</button>
      <button class:on={mode === 'live'} onclick={() => setMdMode('live')}>{t('编辑')}</button>
      <button class:on={mode === 'source'} onclick={() => setMdMode('source')}>{t('源码')}</button>
    </div>
  {/if}
  {#if editable && isText && !isMd && dirty && !conflict}
    <!-- 纯文本文件不自动保存：有改动时给一个文字按钮（md 自动保存，不需要） -->
    <button class="doc-savebtn" disabled={saving} onclick={() => save()}>{t('保存')}</button>
  {/if}
{/snippet}

<div class="doc-root">
  {#if conflict}
    <div class="doc-notice warn" role="alert">
      <svg class="doc-notice-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8.5v4.5M12 16.5h.01"/><circle cx="12" cy="12" r="9"/></svg>
      <span class="doc-notice-t">{t('这篇在别处被修改了，和你没保存的改动冲突')}</span>
      <span class="doc-notice-acts">
        <button class="pri" onclick={keepMine}>{t('保留我的')}</button>
        <button onclick={takeTheirs}>{t('用最新版')}</button>
      </span>
    </div>
  {:else if stale}
    <div class="doc-notice" role="alert">
      <svg class="doc-notice-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11v5M12 7.5h.01"/><circle cx="12" cy="12" r="9"/></svg>
      <span class="doc-notice-t">{t('这篇在别处被修改过，未保存的草稿没有自动恢复')}</span>
      <span class="doc-notice-acts">
        <button class="pri" onclick={useStale}>{t('恢复草稿')}</button>
        <button onclick={dropStale}>{t('丢弃')}</button>
      </span>
    </div>
  {:else if trunc && !loading}
    <div class="doc-notice" role="status">
      <span class="doc-notice-ic"><VIcon name="info" size={17} /></span>
      <span class="doc-notice-t">{trunc.total ? t('文件较大，仅显示前 {shown}（共 {total}），不可编辑', { shown: fmtBytes(trunc.shown), total: fmtBytes(trunc.total) }) : t('仅显示前 {shown}，不可编辑', { shown: fmtBytes(trunc.shown) })}</span>
      {#if viewer.canDownload()}
        <span class="doc-notice-acts"><button onclick={() => viewer.download()}>{t('下载完整文件')}</button></span>
      {/if}
    </div>
  {/if}

  {#if isMd && mode === 'preview' && viewer.touch}
    <FindBar bind:this={findBar} open={fOpen} bind:query={fQuery} current={fCur} total={fTotal} caseSensitive={fCase} touch
      onquery={(q) => mdSearch(q)} onstep={mdStep} oncase={mdCase} onclose={closeMdFind} />
  {/if}
  <div class="doc-body">
    {#if isMd && mode === 'preview' && !viewer.touch}
      <FindBar bind:this={findBar} open={fOpen} bind:query={fQuery} current={fCur} total={fTotal} caseSensitive={fCase}
        onquery={(q) => mdSearch(q)} onstep={mdStep} oncase={mdCase} onclose={closeMdFind} />
    {/if}
    {#if loading}
      <ViewerState kind="loading" />
    {:else if loadError}
      <ViewerState kind="error" icon="page" title={t('加载失败')} onRetry={load} />
    {:else if !isText}
      <!-- 没有内嵌查看器的类型：文件名 + 下载（外框 ⋮ 里还有打开方式 / 分享 / 文件信息） -->
      <!-- 嗅过是二进制的（无扩展名 / 不认识的）：「无法预览」+ 下载 + 以文本方式打开（只读硬解） -->
      <ViewerState kind="unsupported" title={sniffKind === 'bin' ? t('无法预览') : ''} detail={cur.name}
        actions={cur.url ? [{ label: t('以文本方式打开'), onClick: forceText }] : []} />
    {:else if isMd && mode === 'preview'}
      <div class="doc-scroll" bind:this={docScrollEl} tabindex="-1">
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="doc-page" bind:this={pageEl} onclick={mdClick} ondragover={readDragOver} ondrop={readDrop} onpaste={readPaste}>
          {#if note?.props?.length}
            <section class="doc-props" class:gap={/^[ \t]*\r?\n/.test(note.body)}>
              <button class="doc-props-h" onclick={(e) => { e.stopPropagation(); propsOpen = !propsOpen; }}>
                <VIcon name="chev" size={14} class={propsOpen ? 'doc-chev' : 'doc-chev closed'} />
                {t('笔记属性')}<span class="doc-props-n">{note.props.length}</span>
              </button>
              {#if propsOpen}
                <div class="doc-props-tbl sel-text">
                  {#each note.props as p (p.key)}
                    <div class="doc-prop">
                      <div class="doc-prop-k">{@html PROP_ICONS[propKind(p)] || PROP_ICONS.text}<span>{p.key}</span></div>
                      <div class="doc-prop-v">
                        {#if propKind(p) === 'tags'}
                          {#each p.value as v}<span class="doc-chip doc-chip-tag">#{chipText(v)}</span>{/each}
                        {:else if propKind(p) === 'list'}
                          {#each p.value as v}<span class="doc-chip">{@html renderPropWikilinks(chipText(v))}</span>{/each}
                        {:else if propKind(p) === 'json'}
                          <code class="doc-prop-json">{JSON.stringify(p.value)}</code>
                        {:else if propKind(p) === 'bool'}
                          <input type="checkbox" checked={p.value} disabled>
                        {:else if String(p.value) === ''}
                          <span class="doc-prop-empty">{t('空')}</span>
                        {:else}
                          <span class="doc-prop-txt">{@html renderPropWikilinks(String(p.value))}</span>
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </section>
          {/if}

          <div class="doc-md sel-text" bind:this={mdEl}>{#each mdBlocks as b}{@html b}{/each}</div>
          {#if mdRendering}<div class="doc-rendering"><span class="vw-spin" style:--s="20px"></span></div>{/if}

          <!-- 尾栏落位点：阅读态把共用的 .doc-tail 收编到这儿（编辑态则由 CM 文末 widget 收编） -->
          <div class="doc-tailhost" bind:this={tailHost}></div>
        </div>
      </div>
    {:else if isMd}
      <!-- 编辑（Live Preview）/ 源码：CM6 编辑器，懒加载；容器常驻由 effect 填充。
           格式工具全在编辑器自带的选中浮条 + 右键菜单里（mdeditor/menu.js），无底部工具栏 -->
      <div class="doc-cm" bind:this={edEl}></div>
    {:else if showTable}
      <!-- CSV / TSV：表格（冻结表头 + 行列虚拟滚动），⋮ / 顶栏可切原文 -->
      {#key draftKey}<TableView bind:this={tv} text={content} name={cur.name} />{/key}
    {:else}
      <!-- 纯文本 / 代码 / 日志 / JSON：CM6 只读查看（行号、高亮、查找、跳行、换行、字号），编辑 = 同一实例放开只读 -->
      {#key draftKey}
        <CodeView bind:this={cv} text={shown} name={cur.name} {lang} editing={mode === 'edit'} bind:wrap log={isLog}
          eol={curEnc?.eol || '\n'} onchange={(s) => (content = s)} />
      {/key}
    {/if}
  </div>

  <!-- 文末尾栏（反向链接 / 出链 / 词数）：阅读态与编辑态**共用这一份 DOM**——阅读态挂进
       .doc-tailhost，编辑态由 CM 文末块 widget（mdeditor/tail.js）收编，两边观感天然一致。
       故意常驻在模式分支之外：分支切换时 Svelte 先换 DOM 后跑 effect，若归分支所有会在
       编辑器销毁前被摘走，留给 CM 一个悬空节点。 -->
  <div class="doc-tail" bind:this={tailEl} hidden>
    {#if isMd && !loading && !loadError}
      {#if blCount || outLinks.length}
        <section class="doc-links">
          {#if links?.backlinks?.length}
            <div class="doc-lk-h">
              <VIcon name="link" size={14} />
              {t('反向链接')}<span class="doc-lk-n">{blCount}</span>
            </div>
            <div class="doc-bls">
              {#each links.backlinks as b (b.path)}
                <button class="doc-bl" onclick={(e) => { e.stopPropagation(); openNote(b.path); }}>
                  <div class="doc-bl-name">{b.name}{#if b.count > 1}<span class="doc-bl-n">{b.count}</span>{/if}</div>
                  {#each b.excerpts as x}<div class="doc-bl-x">{@html blExcerpt(x)}</div>{/each}
                </button>
              {/each}
            </div>
          {/if}
          {#if outLinks.length}
            <div class="doc-lk-h">
              <VIcon name="external" size={14} />
              {t('出链')}<span class="doc-lk-n">{outLinks.length}</span>
            </div>
            <div class="doc-outs">
              {#each outLinks as o (o.name)}
                <button class="doc-out" class:dead={!o.path} onclick={(e) => { e.stopPropagation(); resolveWiki(o.name); }}><span class="doc-out-t">{o.name}</span></button>
              {/each}
            </div>
          {/if}
        </section>
      {/if}
      {#if stats}
        <div class="doc-stats">{t('{n} 个词', { n: stats.words.toLocaleString(locale()) })} · {t('{n} 个字符', { n: stats.chars.toLocaleString(locale()) })}{#if links?.backlinks?.length}{' · '}{t('{n} 条反向链接', { n: links.backlinks.length })}{/if}</div>
      {/if}
    {/if}
  </div>

</div>

<style>
  /* 配色令牌 --md-* 在 lib/doctheme.css（与编辑态 .mde、Office、PDF 查看器共用一份，跟随全站明暗：
     亮＝Claude 象牙白、暗＝claude.ai 深色暖墨）。本组件不写死纸面颜色，叠加深浅用 rgba(var(--md-ink), α)。 */
  .doc-root {
    position: absolute; inset: 0; background: var(--md-bg); color: var(--md-fg); display: flex; flex-direction: column;
    padding-bottom: var(--kb, 0px);
  }

  /* —— 顶栏由外框（kit ViewerBar）画；这里只剩交给它渲染的副标题（保存状态）与自定义区（三段 / 保存钮）。
     这些元素写在本组件的 snippet 里，作用域样式照样生效。整条纸面灰阶，只有冲突用警示色 —— */
  .doc-sub { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-width: 0; padding: 0; border: 0; background: none;
    font: inherit; font-size: 12px; line-height: 1.3; color: var(--md-fg-3); letter-spacing: .1px; text-align: left; animation: docsub var(--mo-quick) var(--ea-decel) both; }
  .doc-sub-t { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .doc-sub[data-kind='dirty'] { color: var(--md-fg-2); cursor: pointer; }
  .doc-sub[data-kind='warn'] { color: var(--md-danger); }
  .doc-sub-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--md-accent); flex: none; }
  .doc-sub-spin { --s: 10px; }
  /* 编码 / 换行（何时显示见 encText）：跟在保存状态后面，用中点隔开；单独出现时不带点；窄了先省略自己 */
  .doc-sub-enc { display: block; flex: 0 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .doc-sub-enc:not(.solo)::before { content: '·'; margin-right: 5px; }
  @keyframes docsub { from { opacity: 0; transform: translateY(2px); } }

  /* 阅读/编辑/源码 三段切换：暖灰轨道 + 滑帽（亮白 / 暗里抬一级的暖灰） */
  /* 三段等宽（grid 1fr）：滑帽固定 1/3 宽，英文三段字长不一（Read/Edit/Source）时也对得齐 */
  .doc-seg { position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; background: rgba(var(--md-ink), .06); border-radius: 999px; padding: 2px; flex: none; }
  .doc-seg-cap { position: absolute; top: 2px; left: 2px; width: calc(33.333% - 1.4px); height: calc(100% - 4px); background: var(--md-thumb); border-radius: 999px;
    box-shadow: var(--md-shadow-thumb); transition: transform var(--mo-quick, 200ms) var(--md-ease); }
  .doc-seg button { position: relative; z-index: 1; padding: 5px 12px; font-size: 12.5px; color: var(--md-fg-2); font-weight: 500; flex: 1 0 auto;
    border-radius: 999px; transition: color var(--mo-micro, 140ms); }
  .doc-seg button.on { color: var(--md-fg); font-weight: 600; }
  /* 英文（html[lang=en]，lib/i18n.js 设置）：等宽三段按最长的 Source 撑宽，收窄左右内边距给文件名腾位（窄屏/工作台侧栏）；中文不动 */
  :global(html[lang='en']) .doc-seg button { padding-left: 8px; padding-right: 8px; }
  /* 触屏：段按钮视觉 30 高（轨道 34）、13px 字，命中区上下各扩 7px 到 44（外框顶栏 52 高，扩出去也还在栏内） */
  :global(.vw-touch) .doc-seg button { padding-top: 7px; padding-bottom: 7px; font-size: 13px; line-height: 16px; }
  :global(.vw-touch) .doc-seg button::after { content: ''; position: absolute; left: 0; right: 0; top: -7px; bottom: -7px; }

  /* CM6 编辑器容器（内部样式在 mdeditor/editor.css，全局注入防 Svelte 剪枝） */
  .doc-cm { position: absolute; inset: 0; }

  /* 纯文本文件的保存：文字按钮（深珊瑚），不用色块 */
  .doc-savebtn { flex: none; padding: 6px 4px 6px 6px; font-size: 15px; font-weight: 600; color: var(--md-accent-deep); background: none;
    transition: opacity var(--mo-micro, 140ms); }
  .doc-savebtn:disabled { opacity: .4; }
  .doc-savebtn:not(:disabled):active { opacity: .55; }

  /* 顶栏下方的提示条（与磁盘冲突 / 草稿没自动恢复）：内嵌在版面里，不浮在正文上 */
  .doc-notice { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 9px 12px 9px 14px;
    font-size: 13px; line-height: 1.45; color: var(--md-fg); background: var(--md-panel); box-shadow: inset 0 -.5px 0 rgba(var(--md-ink), .12);
    animation: docsub .2s ease both; }
  .doc-notice.warn { background: var(--md-warn-bg); }
  .doc-notice-ic { width: 17px; height: 17px; flex: none; color: var(--md-fg-3); }
  .doc-notice.warn .doc-notice-ic { color: var(--md-danger); }
  .doc-notice-t { flex: 1 1 180px; min-width: 0; }
  .doc-notice-acts { display: inline-flex; gap: 6px; margin-left: auto; }
  .doc-notice-acts button { padding: 5px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; color: var(--md-fg); background: rgba(var(--md-ink), .07);
    transition: background var(--mo-tap, 90ms); }
  .doc-notice-acts button.pri { color: var(--md-bg); background: var(--md-fg); }
  .doc-notice-acts button:active { background: rgba(var(--md-ink), .13); }
  .doc-notice-acts button.pri:active { background: color-mix(in srgb, var(--md-fg) 80%, var(--md-bg)); }
  /* 触屏：提示条按钮视觉 28 高，命中区上下各扩 8px 到 44 */
  :global(.vw-touch) .doc-notice-acts button { position: relative; }
  :global(.vw-touch) .doc-notice-acts button::after { content: ''; position: absolute; left: -3px; right: -3px; top: -10px; bottom: -10px; }

  .doc-body { flex: 1; min-height: 0; position: relative; }
  /* 分块渲染进行中：文末小转圈（kit .vw-spin；正文已可读可滚，不挡内容） */
  .doc-rendering { display: flex; justify-content: center; padding: 14px 0 6px; }

  .doc-scroll { position: absolute; inset: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  /* 滚动区可聚焦（tabindex=-1，键盘滚动用），整页不画焦点环 */
  .doc-scroll:focus, .doc-scroll:focus-visible { outline: none; }
  /* 触屏：脚注上标与脚注里的「↩」只有十来像素宽，用隐形 ::after 扩命中区（↩ 独占一处扩到 44；上标夹在正文里，扩到约 32，不压上下行） */
  :global(.vw-touch) .doc-md :global(a.fn-back), :global(.vw-touch) .doc-md :global(sup.fn-ref a) { position: relative; }
  :global(.vw-touch) .doc-md :global(a.fn-back::after) { content: ''; position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; transform: translate(-50%, -50%); }
  :global(.vw-touch) .doc-md :global(sup.fn-ref a::after) { content: ''; position: absolute; left: 50%; top: 50%; width: 30px; height: 32px; transform: translate(-50%, -50%); }
  /* 查找命中：::highlight 只认少数属性，变量取不到原元素上的值，写死两档（暖黄 / 珊瑚，与 PDF、Word 快速预览一致） */
  :global(::highlight(md-hit)) { background-color: rgba(235, 196, 98, .45); color: inherit; }
  :global(::highlight(md-cur)) { background-color: rgba(217, 119, 87, .55); color: inherit; }

  .doc-page { max-width: 760px; margin: 0 auto; padding: 14px 20px 60px; --ts-sel: var(--md-accent-soft); }   /* 触屏选区锁定时正文仍用这个高亮色（lib/touchSelection.js） */

  /* —— 笔记属性（frontmatter）面板 ——
     几何照编辑态面板（mdeditor/props.js + editor.css .mde-props）排：键列 138px = 26px 图标盒 + 1px +
     键名 6px 内边距，值从同一 x 起，行高按编辑态输入框撑出的 35px——切模式时键名/值不横跳。
     编辑态多出的「添加笔记属性」一行属合理差异；面板到正文的距离另由 margin-bottom 补齐。 */
  /* margin-bottom = 编辑态面板的 6px；frontmatter 后空一行（.gap，绝大多数笔记如此）再加这一行空行
     的 27.52px（行高，编辑态 .cm-line 不留纵向内边距）——编辑态正文前就是「面板 + 一行空行」 */
  .doc-props { border-bottom: 1px solid var(--md-line); padding: 2px 0 8px; margin-bottom: 6px; }
  .doc-props.gap { margin-bottom: 33.52px; }
  .doc-props-h { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--md-fg-3); font-weight: 550; padding: 6px 4px 6px 0; transition: color var(--mo-micro, 140ms); }
  .doc-props-h:active { color: var(--md-fg-2); }
  /* 触屏：「笔记属性」标题视觉约 30 高，命中区上下扩到 44、左右各多 8px（不改版面几何，切模式不跳） */
  .doc-props-h { position: relative; }
  :global(.vw-touch) .doc-props-h::after { content: ''; position: absolute; left: -8px; right: -8px; top: -9px; bottom: -9px; }
  .doc-props-h :global(.doc-chev) { transition: transform var(--mo-quick, 200ms) var(--md-ease); transform: rotate(90deg); }
  .doc-props-h :global(.doc-chev.closed) { transform: rotate(0deg); }
  .doc-props-n { margin-left: 2px; font-size: 11.5px; background: var(--md-bg-2); color: var(--md-fg-3); padding: 1px 7px; border-radius: 999px; }
  .doc-props-tbl { display: flex; flex-direction: column; gap: 1px; }
  /* 键名/值的文字盒照编辑态输入框：同字号、4px 6px 内边距、line-height normal（input 的默认），行高才一致 */
  .doc-prop { display: flex; gap: 6px; padding: 2px 0; min-height: calc(13.5px * 1.72 + 12px); align-items: center; font-size: 14px; }   /* = 编辑态行：输入框 23.22 + 上下 4px + 行 2px */
  .doc-prop-k { flex: none; width: 138px; display: flex; align-items: center; gap: 1px; color: var(--md-fg-2); overflow: hidden; }
  .doc-prop-k :global(svg) { width: 15px; height: 15px; flex: none; margin: 0 5.5px; opacity: .72; }
  .doc-prop-k span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 6px; font-size: 13.5px; line-height: normal; }
  .doc-prop-v { flex: 1; min-width: 0; color: var(--md-fg); display: flex; flex-wrap: wrap; gap: 4px; align-items: center; word-break: break-word; }
  .doc-prop-txt { white-space: pre-wrap; padding: 4px 6px; line-height: normal; }
  .doc-prop-empty { color: var(--md-fg-4); padding: 4px 6px; line-height: normal; }
  .doc-prop-json { font-family: var(--md-mono); font-size: 12.5px; color: var(--md-json); background: var(--md-json-bg); border-radius: 5px; padding: 2px 7px; word-break: break-all; }
  .doc-chip { background: var(--md-bg-2); border-radius: 999px; padding: 2px 10px; font-size: 13px; word-break: break-all; }
  .doc-chip-tag { color: var(--md-accent-deep); background: var(--md-accent-tint); }
  /* 只读勾选框自绘（原生 disabled 态是一坨灰）；编辑态 .mde-pv-bool 是同一副框，改一处两边一起改 */
  .doc-prop-v input[type="checkbox"] {
    appearance: none; -webkit-appearance: none; width: 16px; height: 16px; margin: 4px 6px; border-radius: 5px;   /* margin 同编辑态 .mde-pv-bool */
    border: 1.6px solid var(--md-line-2); background: var(--md-field); position: relative; opacity: 1;
  }
  .doc-prop-v input[type="checkbox"]:checked { background: var(--md-accent); border-color: var(--md-accent); }
  .doc-prop-v input[type="checkbox"]:checked::after {
    content: ''; position: absolute; left: 4.2px; top: 1px; width: 3.8px; height: 7.6px;
    border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(43deg);
  }

  /* 属性面板里 [[双链]] 值的链接样（正文里的 a.wk 在 lib/mdrender.css） */
  .doc-props :global(a.wk) { color: var(--md-accent-deep); text-decoration: none; border-bottom: 1px solid var(--md-wk-line); cursor: pointer; word-break: break-all; }
  .doc-props :global(a.wk:active) { background: var(--md-accent-tint); }

  /* Markdown 预览排版——正文块/行内元素的规则在 lib/mdrender.css（随 obsmd 注入，
     与编辑态 callout 卡共用一份）；这里只留阅读态特有的：容器、文首对齐、围栏头。
     数值与 mdeditor/editor.css 的 Live Preview 保持一致，两个模式来回切时不该有观感落差
     （字号/行高/间距/块样式全对齐；字体统一走全局 --sans）*/
  /* 上内边距 1px + 上外边距 −1px：净高为 0（编辑态行不留纵向内边距，文首就是第一行），但这 1px 挡住
     首块的上外边距穿过 .doc-md 与属性面板的 margin-bottom 折叠成取大值——编辑态是「面板 + 空行 +
     标题行 padding-top」相加 */
  .doc-md { font-size: 16px; line-height: 1.72; word-wrap: break-word; padding-top: 1px; margin-top: -1px; }
  .doc-md :global(*) { -webkit-touch-callout: default; }   /* 长按可起选择/复制（body 全局是禁的）*/
  .doc-md :global(::selection) { background: var(--md-accent-soft); }
  /* 文首齐平：阅读↔编辑切换时首屏不上下跳。编辑态文首就是第一行（content 14px，行本身不留纵向
     内边距），阅读态首块上外边距清零；首块是标题时换成编辑态该级标题行的 padding-top；代码块/
     callout/引用与编辑态同样从 0 起（自带内边距或是块 widget）；表格 widget 自带 6px 外边距；
     列表行上下各 2.4px。有属性面板时，面板与正文之间的「空行」由 .doc-props 的 margin-bottom 补，
     首块同样按这套规则贴上去。
     前缀 .doc-root 多压一级特异度：共享排版（mdrender.css）里的块外边距规则要稳稳被盖住。 */
  .doc-root .doc-page > .doc-md > :global(:first-child) { margin-top: 0; }
  .doc-root .doc-page > .doc-md > :global(h1:first-child) { margin-top: .35em; }
  .doc-root .doc-page > .doc-md > :global(h2:first-child) { margin-top: .3em; }
  .doc-root .doc-page > .doc-md > :global(h3:first-child) { margin-top: .25em; }
  .doc-root .doc-page > .doc-md > :global(h4:first-child),
  .doc-root .doc-page > .doc-md > :global(h5:first-child),
  .doc-root .doc-page > .doc-md > :global(h6:first-child) { margin-top: .2em; }
  .doc-root .doc-page > .doc-md > :global(table:first-child) { margin-top: 6px; }
  .doc-root .doc-page > .doc-md > :global(hr:first-child) { margin-top: .86em; }   /* 编辑态 --- 行的上半行（线在行正中） */
  .doc-root .doc-page > .doc-md > :global(ul:first-child > li:first-child),
  .doc-root .doc-page > .doc-md > :global(ol:first-child > li:first-child) { margin-top: 2.4px; }
  /* 代码块围栏头（语言 + 复制）：编辑态有，阅读态也补上，两边同一副长相；定高 22px = 编辑态
     .mde-fencehead 撑出的那一行，下面紧接第一行代码（不留缝，块内逐行与编辑态同位） */
  .doc-md :global(.doc-fence) { display: flex; align-items: center; gap: 10px; height: 22px; white-space: normal; font-family: var(--sans); line-height: 1.2; }
  .doc-md :global(.doc-fence-lang) { color: var(--md-fg-3); font-size: 11.5px; text-transform: lowercase; letter-spacing: .3px; }
  .doc-md :global(.doc-fence-copy) { margin-left: auto; border: 1px solid var(--md-line); background: var(--md-panel); color: var(--md-fg-2); font-size: 11.5px; padding: 2px 10px; border-radius: 999px;
    transition: background var(--mo-micro, 140ms), color var(--mo-micro, 140ms); }
  .doc-md :global(.doc-fence-copy:active) { background: var(--md-bg-3); }
  /* 触屏：代码块「复制」视觉 20 高，命中区上下各扩 12px、左右 8px 到 44（扩出的部分落在代码块头的留白上） */
  :global(.vw-touch) .doc-md :global(.doc-fence-copy) { position: relative; }
  :global(.vw-touch) .doc-md :global(.doc-fence-copy)::after { content: ''; position: absolute; left: -8px; right: -8px; top: -14px; bottom: -14px; }
  /* 阅读态可勾选的任务框（自动保存开着才可点，见 toggleTask） */
  .doc-md :global(input.task-cb:not(:disabled)) { cursor: pointer; }
  /* ![[图]] 地址还在解析（出链索引在路上）：淡色占位块，同编辑态 .mde-img-pending */
  .doc-md :global(img.wk-pending) { display: inline-block; height: 96px; max-width: 100%; border-radius: 8px; background: var(--md-bg-2); vertical-align: bottom; }
  .doc-md :global(img.wk-pending:not([width])) { width: 160px; }   /* 写了尺寸（![[x|305]]）就按它的宽占位 */

  /* —— 文末尾栏：反向链接 / 出链 / 词数（阅读态挂 .doc-tailhost，编辑态被 CM 收编进正文末尾）—— */
  .doc-tail[hidden] { display: none; }
  .doc-links { margin-top: 34px; border-top: 1px solid var(--md-line); padding-top: 12px; display: flex; flex-direction: column; gap: 6px; }
  .doc-lk-h { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--md-fg-3); font-weight: 550; margin: 8px 0 2px; }
  .doc-lk-h :global(.vw-ic) { color: var(--md-fg-3); }
  .doc-lk-n { font-size: 11.5px; background: var(--md-bg-2); color: var(--md-fg-3); padding: 1px 7px; border-radius: 999px; }
  .doc-bls { display: flex; flex-direction: column; gap: 8px; }
  .doc-bl { text-align: left; background: var(--md-panel); border: 1px solid var(--md-line); border-radius: 12px; padding: 9px 12px;
    transition: background var(--mo-micro, 140ms), border-color var(--mo-micro, 140ms); }
  @media (hover: hover) { .doc-bl:hover { border-color: var(--md-line-2); background: var(--md-panel-hi); } }
  .doc-bl:active { background: var(--md-bg-2); }
  .doc-bl-name { font-size: 14px; font-weight: 600; color: var(--md-accent-deep); display: flex; align-items: center; gap: 6px; min-width: 0; }
  .doc-bl-n { flex: none; font-size: 11px; background: var(--md-accent-tint); color: var(--md-accent-deep); border-radius: 999px; padding: 0 6px; }
  .doc-bl-x { margin-top: 4px; font-size: 12.5px; color: var(--md-fg-2); line-height: 1.55; word-break: break-all;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .doc-bl-x :global(b) { color: var(--md-fg); background: var(--md-mark); font-weight: 600; border-radius: 2px; }
  .doc-outs { display: flex; flex-wrap: wrap; gap: 7px; }
  .doc-out { font-size: 13px; color: var(--md-accent-deep); background: var(--md-accent-tint); border: 1px solid color-mix(in srgb, var(--md-accent-deep) 22%, transparent); border-radius: 999px; padding: 4px 12px;
    position: relative; display: inline-flex; max-width: 100%; transition: background var(--mo-micro, 140ms); }
  .doc-out-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .doc-out:active { background: var(--md-accent-soft); }
  /* 触屏：胶囊 34 高 + 上下各 5 的隐形命中区 = 44（绝对定位按内边距盒算、不含 1px 边框，所以偏移写 6）；行距 10，相邻两行的命中区不叠 */
  :global(.vw-touch) .doc-outs { gap: 10px 8px; }
  :global(.vw-touch) .doc-out { padding: 6px 14px; min-height: 34px; align-items: center; }
  :global(.vw-touch) .doc-out::after { content: ''; position: absolute; left: -5px; right: -5px; top: -6px; bottom: -6px; }
  .doc-out.dead { color: var(--md-fg-3); background: var(--md-bg-2); border-color: var(--md-line); border-style: dashed; }
  .doc-stats { margin-top: 26px; padding: 10px 0 4px; text-align: center; font-size: 12px; color: var(--md-fg-3); }
</style>
