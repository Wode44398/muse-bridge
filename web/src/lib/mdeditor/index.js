// mdeditor —— Obsidian 式 Live Preview / 源码 双模编辑器（CodeMirror 6 内核）。
// DocViewer 懒加载本模块（编辑器 chunk 不进主包，阅读模式零开销）。
// 文档=纯 markdown 源码；Live Preview 全靠视图层装饰（livePreview.js），
// 模式切换只是 Compartment 重配，同一编辑器实例、撤销栈不断。
import { EditorView, keymap, scrollPastEnd, placeholder, BlockType } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, indentUnit } from '@codemirror/language';
import { omExtensions } from './mdext.js';
import { mdHighlight } from './theme.js';
import { livePreview } from './livePreview.js';
import { docTail } from './tail.js';
import { commands } from './commands.js';
import { mdKeys, detectIndentUnit, indentConf } from './keys.js';
import { wikiCompletion } from './complete.js';
import { createMenuCtl } from './menu.js';
import { attachments } from './attach.js';
import { touchSelectGuard, keepNativeTouchSelection } from './touchGuard.js';
import { edgeAutoScroll } from '../touchAutoScroll.js';
import { t } from '../i18n.js';
import './editor.css';

// opts:
//   parent      挂载点（编辑器自滚动，占满父容器）
//   doc         初始 markdown 源码
//   mode        'live' | 'source'
//   readOnly    只读（本地无写权限等）
//   onChange(text)        文档变更（喂 DocViewer 的 draft/dirty/自动保存）
//   onSave()              Ctrl/Cmd+S
//   onNavigate(name,head) [[双链]] 点按（name 空 = 本文档内锚点）
//   openLink(url)         外链
//   openRel(href)         相对路径链接（./xx.md 等）
//   resolveUrl(name)      相对资源/![[嵌入]] → 可加载 URL（DocViewer.embedUrl）
//   renderMd(src)         callout 等整块渲染（obsmd，与阅读模式同观感）
//   saveAttachment(file, name) → Promise<{ link }>  粘贴/拖入/选择的文件存成附件，link 写进 ![[ ]]（attach.js；不给=不接管）
export function createMdEditor(opts = {}) {
  const { parent, doc = '', mode = 'live', readOnly = false } = opts;
  const lpComp = new Compartment();
  const roComp = new Compartment();
  const menuCtl = createMenuCtl();   // 选中浮条 + 右键菜单（替代旧底部工具栏）
  // widget 侧要用的编辑器能力（属性面板的属性菜单/提示气泡复用同一套）
  const lpOpts = { ...opts, openMenu: (x, y, items) => menuCtl.openMenu(x, y, items), flash: (m) => menuCtl.flash(m) };
  // 只读开关连带空文档占位：不能写的空文档不该提示「开始书写」
  const roExt = (ro) => [EditorState.readOnly.of(ro), EditorView.editable.of(!ro), ro ? [] : placeholder(t('开始书写…'))];

  const state = EditorState.create({
    doc,
    extensions: [
      history(),
      EditorView.lineWrapping,
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        // markdownLanguage 自带的 ^上标^ ~下标~ 阅读态与 Obsidian 都不认，编辑态也按原文显示
        extensions: [...omExtensions, { remove: ['Superscript', 'Subscript'] }],
        completeHTMLTags: false,
        addKeymap: false,        // Enter/Backspace 由 keys.js 的 mdKeymap 接管（nonTightLists:false 等）
        pasteURLAsLink: false,   // 换成 keys.js 的版本（格式内部也能粘成链接）
      }),
      // 缩进字符跟文档既有风格：Tab 列表缩进、lang-markdown 续行的 normalizeIndent、代码块缩进同源
      indentConf.of(indentUnit.of(detectIndentUnit(doc))),
      syntaxHighlighting(mdHighlight, { fallback: false }),
      ...wikiCompletion(opts),   // [[ 笔记名 / [[# 标题 / #标签 补全（两种模式都要，不进 lpComp）；补全键位 Prec.highest，弹出时 Enter/Tab 先选候选
      mdKeys(lpOpts),            // Prec.high：先于下面的 historyKeymap / defaultKeymap
      keymap.of([...historyKeymap, ...defaultKeymap]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange?.(u.state.doc.toString());
      }),
      EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
      // 光标离视口/软键盘边缘留 48px（默认 5px，打字到底部时插入符贴边）
      EditorView.cursorScrollMargin.of({ x: 8, y: 48 }),
      scrollPastEnd(),
      docTail(lpOpts),   // 文末尾栏（反链/出链/词数）：两种模式都挂，底部与阅读态一致
      menuCtl.extension,
      attachments(lpOpts),  // 粘贴/拖入图片与文件 → 存附件、写 ![[ ]]
      touchSelectGuard(),   // 触屏长选区护栏（起拖时固定端被误命中、活动端甩出可视区）
      roComp.of(roExt(readOnly)),
      lpComp.of(mode === 'live' ? livePreview(lpOpts) : []),
    ],
  });

  const view = new EditorView({ state, parent });
  parent.classList.add('mde');
  menuCtl.attach(view, parent);
  keepNativeTouchSelection(view);   // 触屏：系统刚选好的字别被 CM 原样重写（会收起选择柄）
  const offAutoScroll = edgeAutoScroll(view.contentDOM, { scroller: () => view.scrollDOM });   // 拖柄贴边自动滚动

  const api = {
    view,
    setMode(m) { view.dispatch({ effects: lpComp.reconfigure(m === 'live' ? livePreview(lpOpts) : []) }); },
    setReadOnly(ro) { view.dispatch({ effects: roComp.reconfigure(roExt(ro)) }); },
    getDoc: () => view.state.doc.toString(),
    setDoc(text) {
      if (text === view.state.doc.toString()) return;
      // 整篇换内容（外部重载等）：缩进风格按新文档重新探测
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        effects: indentConf.reconfigure(indentUnit.of(detectIndentUnit(text))),
      });
    },
    // 把正文换成 text，但只改真正不同的那一段（公共首尾不动）：外部修改（Claude 的 Edit / 三方合并）合进来时
    // 光标、滚动位置随改动映射，不整篇重置；走一个事务，Ctrl+Z 可撤销。userEvent 用 'merge' 而不是 input——
    // 有序列表重排等输入过滤器不该去改别人写进来的内容。
    applyText(text) {
      const cur = view.state.doc.toString(), next = String(text).replace(/\r\n?/g, '\n');
      if (next === cur) return;
      const n = Math.min(cur.length, next.length);
      let a = 0;
      while (a < n && cur.charCodeAt(a) === next.charCodeAt(a)) a++;
      let b = 0;
      while (b < n - a && cur.charCodeAt(cur.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
      view.dispatch({ changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) }, userEvent: 'merge' });
    },
    cmd(name) { const fn = commands[name]; if (fn) fn(view); },
    // [[#标题]] / [[笔记#标题]]：标题落到视口上部（与阅读态 block:'start' 一致；默认的 scrollIntoView:true
    // 是 nearest，目标在下方时只滚到刚露出，标题贴着底边）。认 ATX 与 Setext 标题；匹配口径同阅读态：
    // 原文（忽略大小写）→ slug（空白/下划线/连字符同算 -、去标点）；[[笔记#父#子]] 认最后一段。
    // select:false 只滚不动光标（跨笔记跳过来时不抢焦点、手机上不弹键盘）。
    scrollToHeading(text, { select = true } = {}) {
      const doc = view.state.doc;
      const slug = (s) => String(s).trim().toLowerCase().replace(/[\s_-]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '');
      const raw = String(text).trim(), last = raw.split('#').filter((s) => s.trim()).pop()?.trim() || raw;
      const heads = [];
      let fence = null, n0 = 1;
      if (doc.lines > 2 && doc.line(1).text === '---') {   // 跳过 frontmatter（收尾 --- 前一行会被误认成 Setext 标题）
        for (let k = 2; k <= doc.lines; k++) if (doc.line(k).text === '---') { n0 = k + 1; break; }
      }
      for (let n = n0; n <= doc.lines; n++) {
        const line = doc.line(n), tx = line.text;
        const f = /^ {0,3}(`{3,}|~{3,})/.exec(tx);
        if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
        if (f) { fence = f[1]; continue; }
        const m = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(tx);
        if (m) { heads.push({ line, t: m[1] }); continue; }
        if (n < doc.lines && tx.trim() && !/^\s*([-*+]|\d+[.)]|>|\|)/.test(tx) && /^ {0,3}(=+|-+)\s*$/.test(doc.line(n + 1).text)) heads.push({ line, t: tx.trim() });
      }
      let hit = null;
      for (const w of raw === last ? [raw] : [raw, last]) {
        const lw = w.toLowerCase(), sw = slug(w);
        hit = heads.find((h) => h.t.trim().toLowerCase() === lw) || (sw && heads.find((h) => slug(h.t) === sw));
        if (hit) break;
      }
      if (!hit) return false;
      view.scrollDOM.__mdeScrollGen = (view.scrollDOM.__mdeScrollGen || 0) + 1;   // 收掉模式切换还在进行的进度精调
      const eff = EditorView.scrollIntoView(hit.line.from, { y: 'start', yMargin: 8 });
      if (select) { view.dispatch({ selection: { anchor: hit.line.to }, effects: eff }); view.focus(); }
      else view.dispatch({ effects: eff });
      return true;
    },
    // 模式切换对齐阅读进度：视口顶下 dy 那条线 ↔ 文档位置（可带小数：行块内按字符线性插值——
    // 阅读态那一侧也是这么插的，两边同口径，往返不漂移）。
    // 行的几何以 DOM 为准：CM 的行高表会落后于 DOM（表格/属性面板这类 widget 渲染后又长高、而 CM 没重量，
    // 实测差 6–18px）；行高表只用来在视口外找行、先把目标滚进视口。
    // snap=true 时返回 { pos, off }：锚线落在空行（块与块之间的空隙）上，吸附到下一个非空行的行首，
    // off=那一行在锚线下方的像素数——与阅读态 mdanchors 的空隙吸附同口径，空隙下面那块两态对齐。
    topPos(dy = 0, snap = false) {
      const doc = view.state.doc;
      const geo = (b) => {   // 行块的屏幕几何：渲染着的普通行量 .cm-line，量不到（视口外 / 整块 widget）用行高表
        if (b.type === BlockType.Text && b.from >= view.viewport.from && b.to <= view.viewport.to) {
          try { const d = view.domAtPos(b.from), el = (d.node.nodeType === 3 ? d.node.parentElement : d.node).closest('.cm-line'); if (el) { const r = el.getBoundingClientRect(); return { top: r.top, h: r.height }; } } catch {}
        }
        return { top: b.top + view.documentTop, h: b.height };
      };
      const Y = view.scrollDOM.getBoundingClientRect().top + dy;   // 锚线的屏幕 y
      const hit = view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + 1, y: Y }, false);   // 按 DOM 认行
      const b = hit != null ? view.lineBlockAt(hit) : view.lineBlockAtHeight(Math.max(0, Y - view.documentTop));
      const g = geo(b);
      const f = Math.max(0, Math.min(1, (Y - g.top) / Math.max(1, g.h)));
      const pos = Math.min(doc.length, b.to > b.from ? b.from + f * (b.to - b.from) : b.from + f);   // 空行按 1 个字符宽算（含换行）
      if (!snap) return pos;
      const blank = (l) => /^\s*(>\s*)*$/.test(l.text);   // 空行 / 引用里的空行
      const line = doc.lineAt(b.from);
      if (b.to <= line.to && blank(line)) {
        for (let n = line.number + 1; n <= Math.min(doc.lines, line.number + 20); n++) {
          const nx = doc.line(n);
          if (blank(nx)) continue;
          const off = geo(view.lineBlockAt(nx.from)).top - Y;
          if (off >= 0 && off <= 80) return { pos: nx.from, off };
          break;
        }
      }
      // 锚线上那一行的一小段纯文字（口径同阅读态 mdanchors.SNIP_RE）+ 首字顶相对锚线的差：另一态找到同一段字直接对齐，
      // 不受两态折行差异、隐藏标记占字符数的影响
      const cr = view.contentDOM.getBoundingClientRect();
      for (let x = cr.left + 2; x < cr.right - 8; x += 18) {
        const p0 = view.posAtCoords({ x, y: Y });
        if (p0 == null || view.lineBlockAt(p0).type !== BlockType.Text) continue;   // widget（callout/表格…）里认不出屏上的字，不取

        const m = /^[^\t\n\r*_`~=[\]<>#|$%\\!&]{4,24}/.exec(doc.sliceString(p0, Math.min(doc.length, p0 + 24)));
        if (!m) continue;
        const lo = Math.max(0, Math.floor(pos) - 800), w = doc.sliceString(lo, Math.min(doc.length, Math.floor(pos) + 800)), wi = w.indexOf(m[0]);
        if (wi < 0 || w.indexOf(m[0], wi + 1) >= 0) continue;   // pos 前后 ±800 字里只出现一次才用（同 scrollToPos 的认法）
        const c = view.coordsAtPos(p0, 1);
        if (!c || c.top > Y + 8 || c.bottom < Y - 8) continue;
        return { pos, off: 0, snip: m[0], sdy: c.top - Y };
      }
      return { pos, off: 0 };
    },
    // snip：{ snip, sdy }（topPos / 阅读态 snipAt 给的锚线文字）——目标行渲染出来后，在 pos 附近找到这段字，
    // 让它的首字顶落在 dy 线下 sdy 处；找不到（跨了标记、被折叠）就按位置插值
    scrollToPos(pos, dy = 0, snip = null) {
      const len = view.state.doc.length;
      const p = Math.max(0, Math.min(len, +pos || 0));
      const sc = view.scrollDOM;
      const gen = (sc.__mdeScrollGen = (sc.__mdeScrollGen || 0) + 1);   // 新的一次定位作废上一次还没收尾的精调
      // 文首直接回顶：scrollIntoView(0,'start') 会把第一行贴着视口顶，吃掉 content 的上内边距，切模式首屏上跳一截
      // __mdeSettled：最后一次由这里落定的 scrollTop——DocViewer 据此判断用户之后动没动过（没动就沿用同一锚点，往返零漂移）
      if (p === 0 && !dy) { sc.scrollTop = 0; sc.__mdeSettled = 0; return; }
      // 在 CM 已渲染的 DOM 里（含 callout/表格 widget 里渲染出来的字）找锚线文字：离 nearY ±240px 内只有一处才算
      //（重复短语、代码里的 variable 会认错行）；coordsAtPos 量不到 widget 里的字，所以直接搜 DOM 文本
      const snipY = (nearY) => {
        const hits = [], rg = document.createRange();
        const tw = document.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) {
          for (let i = n.data.indexOf(snip.snip); i >= 0; i = n.data.indexOf(snip.snip, i + 1)) {
            rg.setStart(n, i); rg.setEnd(n, i + 1);
            const c = rg.getClientRects()[0];
            if (c && Math.abs(c.top - nearY) <= 240) hits.push(c.top);
          }
        }
        return hits.length === 1 ? hits[0] : null;
      };
      const posY = () => {   // topPos 的反函数：位置 → 屏幕 y（几何口径同 topPos：渲染着的行量 DOM）
        const b = view.lineBlockAt(Math.min(len, Math.floor(p)));
        let top = b.top + view.documentTop, h = b.height;
        if (b.type === BlockType.Text && b.from >= view.viewport.from && b.to <= view.viewport.to) {
          try { const d = view.domAtPos(b.from), el = (d.node.nodeType === 3 ? d.node.parentElement : d.node).closest('.cm-line'); if (el) { const r = el.getBoundingClientRect(); top = r.top; h = r.height; } } catch {}
        }
        const f = b.to > b.from ? Math.min(1, (p - b.from) / (b.to - b.from)) : Math.min(1, p - b.from);
        return top + Math.max(0, f) * h;
      };
      const screenY = () => {   // 锚线应在的屏幕 y：按位置算出的附近找到了锚线文字，就以那段字为准
        const y = posY();
        const h = snip?.snip ? snipY(y + (snip.sdy || 0)) : null;
        return h != null ? h - (snip.sdy || 0) : y;
      };
      // 先交给 CM 把目标行滚进视口（它边滚边量视口外的估算行高），之后按实际几何把小数位置精调到 dy 这条线。
      // 头几帧逐帧对，之后每 120ms 再对一次、共约 1.2s：跳到远处时语法树是后台增量解析的，解析到那一段后
      // 标题等行才换上大字号、行高变了（实测源码态约 150ms 后下移 49px），CM 只保视口顶那一行不动，下面的字会漂；
      // 每拍顺手 requestMeasure，让 CM 的行高表也跟上 DOM。用户一动手（滚轮/触摸/按键/点按）立刻收手，不跟人抢滚动
      // 别的代码（或拖滚动条）把视口挪走了一大截（>150px，CM 自己为保视口顶做的微调远小于此）也收手
      view.dispatch({ effects: EditorView.scrollIntoView(Math.min(len, Math.floor(p)), { y: 'start', yMargin: dy }) });
      let n = 0, stop = false;
      sc.__mdeSettled = null;
      const quit = () => { stop = true; };
      const evs = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
      for (const e of evs) sc.addEventListener(e, quit, { passive: true, capture: true });
      const fix = () => {
        if (n > 0 && sc.__mdeSettled != null && Math.abs(sc.scrollTop - sc.__mdeSettled) > 150) stop = true;
        if (!stop && sc.__mdeScrollGen === gen && view.dom.isConnected) {
          const want = Math.max(0, Math.round(sc.scrollTop + screenY() - (sc.getBoundingClientRect().top + dy)));
          if (Math.abs(sc.scrollTop - want) >= 1) sc.scrollTop = want;
          sc.__mdeSettled = sc.scrollTop;
          view.requestMeasure();
          if (++n < 4) { requestAnimationFrame(fix); return; }
          if (n < 14) { setTimeout(fix, 120); return; }
        }
        for (const e of evs) sc.removeEventListener(e, quit, { capture: true });
      };
      requestAnimationFrame(fix);
    },
    focus: () => view.focus(),
    destroy: () => { offAutoScroll(); menuCtl.destroy(); view.destroy(); },
  };
  if (typeof window !== 'undefined') window.__mde = api;   // 调试句柄（真机排障也用得上）
  return api;
}
