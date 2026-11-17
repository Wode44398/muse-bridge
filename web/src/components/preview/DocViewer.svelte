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
  import { untrack } from 'svelte';
  import '../../lib/doctheme.css';   // --md-* 纸面配色令牌（亮象牙白 / 暗暖墨，跟随全站明暗；编辑态/Office/PDF 共用）
  import { hasLocalWrite, localReadText } from '../../lib/localfs.js';
  import { previewViewAs, setPreviewDetail } from '../../lib/preview.svelte.js';
  import { PROP_ICONS, escapeHtml, escapeRegex, lexObsBlocks, propKind, renderPropWikilinks, scanFootnotes } from '../../lib/obsmd.js';
  import { readMapper, srcBlocks } from '../../lib/mdanchors.js';
  import { merge3 } from '../../lib/textmerge.js';
  import { registerDraft } from '../../lib/uiReport.js';
  import { fsChange, fsMatches } from '../../lib/fsSync.svelte.js';
  import { IS_SHARE } from '../../lib/share.js';
  import { locale, t, tc } from '../../lib/i18n.js';
  import { useViewer } from './kit/context.js';
  import ViewerState from './kit/ViewerState.svelte';
  import VIcon from './kit/VIcon.svelte';
  import { fmtBytes } from './kit/actions.js';
  import CodeView from './CodeView.svelte';
  import TableView from './TableView.svelte';
  import FindBar from './paged/FindBar.svelte';
  import { SAVE_MAX, capFor, readCapped } from '../../lib/codeview/readtext.js';
  import { ENCODINGS, decodeBytes, detectEncoding, encLabel, eolOf, isUtf8, looksText } from '../../lib/codeview/encoding.js';
  import { looksLikeLog } from '../../lib/codeview/textutil.js';
  import { formatJsonAsync, looksMinified } from '../../lib/codeview/jsonfmt.js';
  import { iconKindOf, langOf } from '../../lib/fileKinds.js';
  import { createDocSave } from './doc/docSave.svelte.js';
  import { createDocFind } from './doc/docFind.svelte.js';
  import { createDocLinks } from './doc/docLinks.svelte.js';
  import { createDocAttach } from './doc/docAttach.svelte.js';
  import { createDocRead } from './doc/docRead.svelte.js';
  import { createDocEditor } from './doc/docEditor.svelte.js';

  // 纯文本 / 代码 / 日志 / JSON / CSV（非 md）走 CodeView（CM6 只读视图，编辑入口在顶栏工具与 ⋮ 菜单里，
  // 默认不是可写 textarea）；CSV / TSV 默认表格（TableView），可切原文。读取按字节、带上限（lib/codeview/readtext.js），
  // 编码自动识别（BOM → 严格 UTF-8 → GB18030 / Big5 / Shift_JIS 打分），副标题显示编码、⋮ 里可手动换编码重新解码；
  // 截断显示的、超过保存上限的、服务端不认的扩展名一律只读（以前截断后再保存会把文件截短）。

  // 顶栏、toast、加载 / 错误 / 不支持态交给统一查看器外框（kit/context.js）：这里向外框声明标题（栈顶那篇）、
  // 副标题（保存状态 / 所在文件夹）、栏内自定义区（阅读 / 编辑 / 源码三段 + 文本文件的保存钮）与返回拦截
  // （先退笔记栈、未保存先确认）。编辑器内核不动。
  let { item } = $props();
  const viewer = useViewer();
  // P：本组件状态与动作的视图（getter / setter 直通这里的 $state），交给拆出去的逻辑模块（preview/doc/*.svelte.js）；
  // 模块各自的状态与动作建好后也挂到 P 上（expose），彼此都经 P 互相够得着。模块按原来的位置创建，效果的先后不变。
  const P = {
    get DRAFTS() { return DRAFTS; },
    get ENCS() { return ENCS; },
    get RESUME() { return RESUME; },
    get SAVEQ() { return SAVEQ; },
    get anchor() { return anchor; }, set anchor(v) { anchor = v; },
    get applyScroll() { return applyScroll; },
    get applyText() { return applyText; },
    get conflict() { return conflict; }, set conflict(v) { conflict = v; },
    get content() { return content; }, set content(v) { content = v; },
    get cur() { return cur; },
    get cv() { return cv; }, set cv(v) { cv = v; },
    get dirty() { return dirty; },
    get docScrollEl() { return docScrollEl; }, set docScrollEl(v) { docScrollEl = v; },
    get draftKey() { return draftKey; },
    get draftKeyOf() { return draftKeyOf; },
    get editable() { return editable; },
    get encInfo() { return encInfo; }, set encInfo(v) { encInfo = v; },
    get grabScroll() { return grabScroll; },
    get isMd() { return isMd; },
    get justSaved() { return justSaved; }, set justSaved(v) { justSaved = v; },
    get linksKeyOf() { return linksKeyOf; },
    get loadCtrl() { return loadCtrl; }, set loadCtrl(v) { loadCtrl = v; },
    get loadError() { return loadError; }, set loadError(v) { loadError = v; },
    get loading() { return loading; }, set loading(v) { loading = v; },
    get mdAuto() { return mdAuto; },
    get mode() { return mode; }, set mode(v) { mode = v; },
    get original() { return original; }, set original(v) { original = v; },
    get pendingFs() { return pendingFs; }, set pendingFs(v) { pendingFs = v; },
    get pendingScroll() { return pendingScroll; }, set pendingScroll(v) { pendingScroll = v; },
    get readMap() { return readMap; },
    get refreshFromDisk() { return refreshFromDisk; },
    get restored() { return restored; }, set restored(v) { restored = v; },
    get savedT() { return savedT; }, set savedT(v) { savedT = v; },
    get setMdMode() { return setMdMode; },
    get showToast() { return showToast; },
    get stack() { return stack; }, set stack(v) { stack = v; },
    get viewer() { return viewer; },
  };
  const expose = (o) => Object.defineProperties(P, Object.getOwnPropertyDescriptors(o));

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
      : P.saving ? { kind: 'busy', text: t('正在保存…') }
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
    if (m === 'preview' && mode !== 'preview' && dirty && mdAuto) P.save(true);   // 切回阅读即落盘
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
    if (!P.mdEl || !page || !P.note) return null;
    const text = nlz(content);
    if (srcMemo?.text !== text) {
      const footnotes = scanFootnotes(P.note.body);
      const base = text.length - nlz(P.note.body).length;
      srcMemo = { text, base, blocks: srcBlocks(P.splitTopBlocks(P.note.body), base, (s) => lexObsBlocks(s, { footnotes })) };
    }
    return readMapper({ root: P.mdEl, page, blocks: srcMemo.blocks, base: srcMemo.base, total: text.length, text });
  }

  // anchor：{ top:true } 或 { pos, off, snip?, sdy? }——pos 是锚线上（或锚线下方 off 像素处、空隙吸附时）的源码位置；
  // snip/sdy 是锚线那一行的一小段字与它首字顶相对锚线的差，另一态能找到这段字就直接按它对齐（比按字符插值准）。
  // anchorFor：上次按 anchor 落位时的正文与落定的阅读态 scrollTop——落位之后用户没滚过、没改过字，
  // 再切换就沿用同一个锚点，不重新量（两态版面不完全相同，重量一次会差几像素，来回切就会一点点漂）
  let anchorFor = null;
  function grabScroll() {
    if (anchor && anchorFor?.text === content) {
      const sc = mode !== 'preview' ? P.editor?.view?.scrollDOM : docScrollEl;
      const settled = mode !== 'preview' ? sc?.__mdeSettled : anchorFor.readSt;
      if (sc && settled != null && Math.abs(sc.scrollTop - settled) <= 2) return;
    }
    anchorFor = null;
    if (mode !== 'preview') {
      const sc = P.editor?.view?.scrollDOM;
      if (sc) anchor = sc.scrollTop <= 1 ? { top: true } : P.editor.topPos(anchorDy(sc.clientHeight), true);
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
      if (a.top) P.editor?.scrollToPos?.(0);
      else P.editor?.scrollToPos?.(a.pos, anchorDy(P.editor.view.scrollDOM.clientHeight) + (a.off || 0), a.snip ? { snip: a.snip, sdy: a.sdy } : null);
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
    P.mdBlocks;                                   // 阅读态 DOM 渲染完再落位
    if (P.mdRendering) return;                    // 分块途中块还没长全，等全量出齐再插值
    if (mode !== 'preview' || !el) return;
    if (untrack(() => P.takeJumpHead())) return;  // 双链 [[笔记#标题]] 跳过来：定位到标题，这次不按进度落位
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
    P.loadLinks(c);
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
      P.linkSigs.set(linksKeyOf(c), P.linkSigOf(text));   // 这次拉的出链索引对应的就是这份磁盘原文
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
    if (P.editor) P.editor.setDoc(s.text);
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
      const text = await P.readDisk(c);
      if (text == null) return;
      if (my !== seq || loading) return;
      if (P.saving) { pendingFs = true; return; }
      if (conflict?.key === key) { if (text !== conflict.theirs) conflict = { key, theirs: text }; return; }
      if (text === original) return;
      const base = original, mine = content;
      if (mine === base) {
        if (isMd && mode === 'preview') { grabScroll(); pendingScroll = true; }
        original = text;
        applyText(text, true);
        P.syncLinks(c, text);
        showToast(t('已同步 Claude 的修改'));
        return;
      }
      const m = merge3(base, mine, text);
      if (m == null) { conflict = { key, theirs: text }; clearTimeout(P.saveT); return; }
      original = text;
      applyText(m);
      showToast(t('已合并别处对这篇的修改'));
      P.resave(true);
    } catch { /* 跟盘失败无害，下次事件再试 */ }
  }
  // 换正文：编辑器在就走最小差异事务（光标随改动映射、Ctrl+Z 可撤销，content 由 onChange 回写）；
  // raw=true 时再把 content 设成磁盘原样（CRLF 文件：编辑器里是 LF，不设的话会被当成改动、白写一遍）
  function applyText(x, raw = false) {
    if (P.editor && P.edFor === draftKey) P.editor.applyText(x);
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

  expose(createDocSave(P));

  // —— 文本文件（非 md）：查看 ⇄ 编辑。默认只读查看（CodeView），编辑入口在顶栏工具与 ⋮ 菜单 ——
  const textDoc = $derived(isText && !isMd && !loading && !loadError);
  function setTextMode(m) {
    if (m === mode || isMd) return;
    if (m === 'edit' && !editable) return;
    cv?.flush();
    mode = m;
  }
  const toggleEdit = () => setTextMode(mode === 'edit' ? 'view' : 'edit');
  expose(createDocFind(P));
  function docKeys(e) {
    if (loading || loadError || !isText || e.isComposing) return false;
    if (isMd) return P.mdKeys(e);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyS') { if (editable && dirty) P.save(); return true; }
    if (showTable ? tv?.handleKey(e) : cv?.handleKey(e)) return true;
    if (e.key === 'Escape' && mode === 'edit') { setTextMode('view'); return true; }
    return false;
  }
  function docTools() {
    if (isMd && mode === 'preview' && !loading && !loadError && !viewer.touch) return [{ id: 'find', icon: 'search', label: t('查找'), kbd: 'Ctrl+F', active: P.fOpen, onClick: P.openMdFind }];
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
    if (isMd && mode === 'preview') out.push({ id: 'find', label: t('查找…'), icon: 'search', kbd: 'Ctrl+F', onSelect: P.openMdFind });
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
    out.push({ id: 'copyAll', label: t('复制全文'), icon: 'copy', onSelect: () => { cv?.flush(); P.copyText(content).then((ok) => showToast(ok ? t('已复制') : t('复制失败'))); } });
    return out;
  }

  // —— 向外框声明顶栏 ——
  $effect(() => viewer.declare({
    title: () => cur.name,
    dragItem: () => cur,
    subtitle: '',                 // 不要外框默认的画廊计数（副标题是保存状态 / 文件夹，见 subHead）
    subtitleSnippet: subHead,
    barEnd: barEndSnip,
    onBack: P.back,
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

  expose(createDocLinks(P));
  expose(createDocAttach(P));
  expose(createDocRead(P));
  expose(createDocEditor(P));

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
        <button class="doc-sub" data-kind="dirty" onclick={() => P.save()}><i class="doc-sub-dot"></i><span class="doc-sub-t">{status.text}</span></button>
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
    <button class="doc-savebtn" disabled={P.saving} onclick={() => P.save()}>{t('保存')}</button>
  {/if}
{/snippet}

<div class="doc-root">
  {#if conflict}
    <div class="doc-notice warn" role="alert">
      <svg class="doc-notice-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8.5v4.5M12 16.5h.01"/><circle cx="12" cy="12" r="9"/></svg>
      <span class="doc-notice-t">{t('这篇在别处被修改了，和你没保存的改动冲突')}</span>
      <span class="doc-notice-acts">
        <button class="pri" onclick={P.keepMine}>{t('保留我的')}</button>
        <button onclick={P.takeTheirs}>{t('用最新版')}</button>
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
    <FindBar bind:this={P.findBar} open={P.fOpen} bind:query={P.fQuery} current={P.fCur} total={P.fTotal} caseSensitive={P.fCase} touch
      onquery={(q) => P.mdSearch(q)} onstep={P.mdStep} oncase={P.mdCase} onclose={P.closeMdFind} />
  {/if}
  <div class="doc-body">
    {#if isMd && mode === 'preview' && !viewer.touch}
      <FindBar bind:this={P.findBar} open={P.fOpen} bind:query={P.fQuery} current={P.fCur} total={P.fTotal} caseSensitive={P.fCase}
        onquery={(q) => P.mdSearch(q)} onstep={P.mdStep} oncase={P.mdCase} onclose={P.closeMdFind} />
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
        <div class="doc-page" bind:this={P.pageEl} onclick={P.mdClick} ondragover={P.readDragOver} ondrop={P.readDrop} onpaste={P.readPaste}>
          {#if P.note?.props?.length}
            <section class="doc-props" class:gap={/^[ \t]*\r?\n/.test(P.note.body)}>
              <button class="doc-props-h" onclick={(e) => { e.stopPropagation(); P.propsOpen = !P.propsOpen; }}>
                <VIcon name="chev" size={14} class={P.propsOpen ? 'doc-chev' : 'doc-chev closed'} />
                {t('笔记属性')}<span class="doc-props-n">{P.note.props.length}</span>
              </button>
              {#if P.propsOpen}
                <div class="doc-props-tbl sel-text">
                  {#each P.note.props as p (p.key)}
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

          <div class="doc-md sel-text" bind:this={P.mdEl}>{#each P.mdBlocks as b}{@html b}{/each}</div>
          {#if P.mdRendering}<div class="doc-rendering"><span class="vw-spin" style:--s="20px"></span></div>{/if}

          <!-- 尾栏落位点：阅读态把共用的 .doc-tail 收编到这儿（编辑态则由 CM 文末 widget 收编） -->
          <div class="doc-tailhost" bind:this={P.tailHost}></div>
        </div>
      </div>
    {:else if isMd}
      <!-- 编辑（Live Preview）/ 源码：CM6 编辑器，懒加载；容器常驻由 effect 填充。
           格式工具全在编辑器自带的选中浮条 + 右键菜单里（mdeditor/menu.js），无底部工具栏 -->
      <div class="doc-cm" bind:this={P.edEl}></div>
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
  <div class="doc-tail" bind:this={P.tailEl} hidden>
    {#if isMd && !loading && !loadError}
      {#if P.blCount || P.outLinks.length}
        <section class="doc-links">
          {#if P.links?.backlinks?.length}
            <div class="doc-lk-h">
              <VIcon name="link" size={14} />
              {t('反向链接')}<span class="doc-lk-n">{P.blCount}</span>
            </div>
            <div class="doc-bls">
              {#each P.links.backlinks as b (b.path)}
                <button class="doc-bl" onclick={(e) => { e.stopPropagation(); P.openNote(b.path); }}>
                  <div class="doc-bl-name">{b.name}{#if b.count > 1}<span class="doc-bl-n">{b.count}</span>{/if}</div>
                  {#each b.excerpts as x}<div class="doc-bl-x">{@html blExcerpt(x)}</div>{/each}
                </button>
              {/each}
            </div>
          {/if}
          {#if P.outLinks.length}
            <div class="doc-lk-h">
              <VIcon name="external" size={14} />
              {t('出链')}<span class="doc-lk-n">{P.outLinks.length}</span>
            </div>
            <div class="doc-outs">
              {#each P.outLinks as o (o.name)}
                <button class="doc-out" class:dead={!o.path} onclick={(e) => { e.stopPropagation(); P.resolveWiki(o.name); }}><span class="doc-out-t">{o.name}</span></button>
              {/each}
            </div>
          {/if}
        </section>
      {/if}
      {#if P.stats}
        <div class="doc-stats">{t('{n} 个词', { n: P.stats.words.toLocaleString(locale()) })} · {t('{n} 个字符', { n: P.stats.chars.toLocaleString(locale()) })}{#if P.links?.backlinks?.length}{' · '}{t('{n} 条反向链接', { n: P.links.backlinks.length })}{/if}</div>
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
