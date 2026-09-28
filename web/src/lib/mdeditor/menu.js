// menu.js —— 编辑器交互层：选中浮条 + 右键菜单（Obsidian 式），替代旧底部格式工具栏。
// 全部 DOM 挂在编辑器容器(.mde)内的 overlay，坐标一律「视口坐标 - 容器 rect」相对定位并夹紧，
// 不用 position:fixed —— 工作台侧栏用 transform 圈定 containing block，fixed 的视口数学会崩。
//
// 子菜单铺法（2026-09-16 重做，修「窄栏里子菜单不停跳」）：
//   ① 右侧放得下 → 贴主菜单右缘；② 放不下 → 左飞出；③ 两边都挤（工作台窄栏/手机）→
//   靠余量大的一侧贴容器边、从锚点行「下一行」起铺（叠在主菜单上，锚点行本身仍露着并高亮）。
//   老写法把子菜单直接叠在锚点行上：子菜单一出现就把锚点盖在指针底下 → 锚点 pointerleave、
//   子菜单里的项又按「主菜单普通项」逻辑排了 250ms 缓关 → 关掉后指针又落回锚点 → 再开……
//   每 370ms 闪一次。现在子菜单内的项永不排缓关、锚点行不被盖，两处根都断了。
import { EditorView } from '@codemirror/view';
import { commands, setHeading } from './commands.js';

const SVG = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${extra}${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
const TXT = (t) => `<span class="mi-txt">${t}</span>`;

const ICONS = {
  wik: SVG(['M7 4H4v16h3', 'M11 4H9v16h2', 'M13 4h2v16h-2', 'M17 4h3v16h-3']),
  ext: SVG(['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6']),
  find: SVG(['m21 21-4.3-4.3'], '<circle cx="11" cy="11" r="7"/>'),
  fmt: SVG(['M4 7V4h16v3', 'M9 20h6', 'M12 4v16']),
  para: SVG(['M13 4v16', 'M17 4v16', 'M19 4H9.5a4.5 4.5 0 0 0 0 9H13']),
  ins: SVG(['M11 12H3', 'M16 6H3', 'M16 18H3', 'M18 9v6', 'M21 12h-6']),
  bold: SVG(['M7 5h6.5a3.5 3.5 0 0 1 0 7H7z', 'M7 12h7.5a3.5 3.5 0 0 1 0 7H7z']),
  italic: SVG(['M19 5h-8', 'M13 19H5', 'M15 5l-6 14']),
  strike: SVG(['M16 4H9a3 3 0 0 0-2.83 4', 'M14 12a4 4 0 0 1 0 8H6', 'M4 12h16']),
  hl: SVG(['m9 11-6 6v3h9l3-3', 'm22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4l8 8Z']),
  code: SVG(['m16 18 6-6-6-6', 'm8 6-6 6 6 6']),
  math: SVG(['M18 5H7l6 7-6 7h11']),
  cmt: SVG(['M19 5 5 19'], '<circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>'),
  clear: SVG(['m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21', 'M22 21H7', 'm5 11 9 9']),
  ul: SVG(['M9 6h12', 'M9 12h12', 'M9 18h12'], '<circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>'),
  ol: SVG(['M10 6h11', 'M10 12h11', 'M10 18h11', 'M4 6h1v4', 'M4 10h2', 'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1']),
  task: SVG(['m9 11 3 3L22 4', 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11']),
  h1: TXT('H1'), h2: TXT('H2'), h3: TXT('H3'), h4: TXT('H4'), h5: TXT('H5'), h6: TXT('H6'),
  body: SVG(['M17 6H3', 'M21 12H3', 'M15 18H3']),
  quote: SVG(['M10 11H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v6a4 4 0 0 1-4 4', 'M20 11h-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v6a4 4 0 0 1-4 4']),
  foot: SVG(['M4 8h9', 'M4 13h16', 'M4 18h16', 'M18 3v5', 'm16.5 4.5 1.5-1.5']),
  table: SVG(['M3 12h18', 'M12 3v18'], '<rect x="3" y="3" width="18" height="18" rx="2.5"/>'),
  callout: SVG(['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z']),
  hr: SVG(['M4 12h16', 'M6 6h4', 'M14 6h4', 'M6 18h4', 'M14 18h4']),
  codeblk: SVG(['m10 9-2.5 3L10 15', 'm14 9 2.5 3L14 15'], '<rect x="3" y="3" width="18" height="18" rx="2.5"/>'),
  mathblk: SVG(['M15.5 8H9l4 4-4 4h6.5'], '<rect x="3" y="3" width="18" height="18" rx="2.5"/>'),
  cut: SVG(['M20 4 8.12 15.88', 'M14.47 14.48 20 20', 'M8.12 9.12 12 13'], '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>'),
  copy: SVG(['M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'], '<rect x="9" y="9" width="13" height="13" rx="2.5"/>'),
  paste: SVG(['M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'], '<rect x="8" y="2" width="8" height="4" rx="1.2"/>'),
  all: SVG(['M5 3a2 2 0 0 0-2 2', 'M19 3a2 2 0 0 1 2 2', 'M21 19a2 2 0 0 1-2 2', 'M5 21a2 2 0 0 1-2-2', 'M9 3h2', 'M13 3h2', 'M9 21h2', 'M13 21h2', 'M3 9v2', 'M3 13v2', 'M21 9v2', 'M21 13v2']),
  undo: SVG(['M3 7v6h6', 'M21 17a9 9 0 0 0-15-6.7L3 13']),
  redo: SVG(['M21 7v6h-6', 'M3 17a9 9 0 0 1 15-6.7L21 13']),
  chev: SVG(['m9 6 6 6-6 6']),
  check: SVG(['m5 12 5 5L20 7']),
  more: SVG([], '<circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none"/>'),
  props: SVG(['M4 7h5', 'M4 12h5', 'M4 17h5', 'M13 7h7', 'M13 12h7', 'M13 17h4']),
  info: SVG(['M12 16v-4.5', 'M12 8h.01'], '<circle cx="12" cy="12" r="9"/>'),
  trash: SVG(['M4 7h16', 'M9 7V5h6v2', 'm7 7 1 13h8l1-13', 'M10 11v5', 'M14 11v5']),
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
const MOD = isMac ? '⌘' : 'Ctrl';
// 快捷键提示只给有鼠标的桌面端看；触屏没键盘，字是白占宽度
const finePointer = () => { try { return matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return false; } };

// 当前行状态（段落设置子菜单的 ✓）
function lineState(state) {
  const t = state.doc.lineAt(state.selection.main.head).text.replace(/^\s*/, '');
  const h = /^(#{1,6})\s/.exec(t);
  return {
    heading: h ? h[1].length : 0,
    task: /^[-*+] \[[ xX]\]/.test(t),
    bullet: /^[-*+] (?!\[)/.test(t),
    ordered: /^\d+[.)] /.test(t),
    quote: /^>/.test(t),
  };
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
}

export function createMenuCtl() {
  let view = null, host = null, root = null;
  let bar = null, barRo = null, menu = null, sub = null;
  let menuOpen = false, pointerDown = false;
  let barT = null, scrollT = null, subHoverT = null, subCloseT = null, flashT = null;
  let findQ = '';

  // ———— 小气泡（查找计数等） ————
  function flash(msg) {
    if (!root) return;
    let f = root.querySelector('.mde-flash');
    if (!f) { f = document.createElement('div'); f.className = 'mde-flash'; root.appendChild(f); }
    f.textContent = msg;
    f.classList.add('on');
    clearTimeout(flashT);
    flashT = setTimeout(() => f.classList.remove('on'), 1400);
  }

  // ———— 剪贴板 ————
  async function doCopy(v) {
    const r = v.state.selection.main;
    if (r.empty) return;
    const t = v.state.sliceDoc(r.from, r.to);
    try { await navigator.clipboard.writeText(t); } catch { legacyCopy(t); }
    flash('已复制');
  }
  async function doCut(v) {
    const r = v.state.selection.main;
    if (r.empty || v.state.readOnly) return;
    const t = v.state.sliceDoc(r.from, r.to);
    try { await navigator.clipboard.writeText(t); } catch { legacyCopy(t); }
    v.dispatch({ changes: { from: r.from, to: r.to }, selection: { anchor: r.from } });
    v.focus();
  }
  async function doPaste(v) {
    if (v.state.readOnly) return;
    let t = '';
    try { t = await navigator.clipboard.readText(); } catch {}
    if (!t) { flash('无法读取剪贴板，请用键盘粘贴'); return; }
    v.dispatch(v.state.replaceSelection(t));
    v.focus();
  }

  // ———— 查找：循环选中下一处（选区即查询词） ————
  function findNext(v) {
    const r = v.state.selection.main;
    if (!r.empty) findQ = v.state.sliceDoc(r.from, r.to);
    if (!findQ) return;
    const hay = v.state.doc.toString().toLowerCase(), q = findQ.toLowerCase();
    let total = 0;
    for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) total++;
    if (!total) { flash('未找到'); return; }
    let idx = hay.indexOf(q, r.to);
    if (idx === -1) idx = hay.indexOf(q);
    let ord = 0;
    for (let i = hay.indexOf(q); i !== -1 && i <= idx; i = hay.indexOf(q, i + q.length)) ord++;
    v.dispatch({ selection: { anchor: idx, head: idx + q.length }, scrollIntoView: true });
    v.focus();
    flash(`第 ${ord} / ${total} 处`);
  }

  // ———— 菜单数据（按当前选区/只读态现算） ————
  function buildItems(v) {
    const ro = v.state.readOnly;
    const r = v.state.selection.main;
    const hasSel = !r.empty;
    const selText = hasSel ? v.state.sliceDoc(r.from, r.to).replace(/\s+/g, ' ').trim() : '';
    const shortSel = selText.length > 10 ? selText.slice(0, 10) + '…' : selText;
    const ls = lineState(v.state);
    const items = [];
    if (!ro) {
      items.push({ icon: 'wik', label: '新增链接', cmd: 'wikilink' });
      items.push({ icon: 'ext', label: '新增外部链接', cmd: 'link' });
    }
    if (hasSel && selText) items.push({ icon: 'find', label: `查找 “${shortSel}”`, run: findNext });
    if (items.length) items.push('-');
    if (!ro) {
      items.push({
        icon: 'fmt', label: '文本格式', sub: [
          { icon: 'bold', label: '加粗', cmd: 'bold', key: `${MOD}+B` },
          { icon: 'italic', label: '倾斜', cmd: 'italic', key: `${MOD}+I` },
          { icon: 'strike', label: '删除线', cmd: 'strike' },
          { icon: 'hl', label: '高亮', cmd: 'highlight' },
          '-',
          { icon: 'code', label: '代码', cmd: 'code' },
          { icon: 'math', label: '数学', cmd: 'math' },
          { icon: 'cmt', label: '注释', cmd: 'comment' },
          '-',
          { icon: 'clear', label: '清除格式', cmd: 'clearFormat' },
        ],
      });
      items.push({
        icon: 'para', label: '段落设置', sub: [
          { icon: 'ul', label: '无序列表', cmd: 'bullet', on: ls.bullet },
          { icon: 'ol', label: '有序列表', cmd: 'ordered', on: ls.ordered },
          { icon: 'task', label: '任务列表', cmd: 'task', on: ls.task },
          '-',
          ...[1, 2, 3, 4, 5, 6].map((n) => ({ icon: 'h' + n, label: `${n} 级标题`, run: (vw) => setHeading(vw, n), on: ls.heading === n })),
          { icon: 'body', label: '正文', run: (vw) => setHeading(vw, 0), on: !ls.heading && !ls.bullet && !ls.ordered && !ls.task && !ls.quote },
          '-',
          { icon: 'quote', label: '引用', cmd: 'quote', on: ls.quote },
        ],
      });
      items.push({
        icon: 'ins', label: '插入', sub: [
          { icon: 'props', label: '笔记属性', cmd: 'props' },
          { icon: 'foot', label: '脚注', cmd: 'footnote' },
          { icon: 'table', label: '表格', cmd: 'table' },
          { icon: 'callout', label: '标注', cmd: 'callout' },
          { icon: 'hr', label: '分隔线', cmd: 'hr' },
          '-',
          { icon: 'codeblk', label: '代码块', cmd: 'codeblock' },
          { icon: 'mathblk', label: '数学块', cmd: 'mathblock' },
        ],
      });
      items.push('-');
    }
    if (!ro && hasSel) items.push({ icon: 'cut', label: '剪切', run: doCut, key: `${MOD}+X` });
    if (hasSel) items.push({ icon: 'copy', label: '复制', run: doCopy, key: `${MOD}+C` });
    if (!ro) items.push({ icon: 'paste', label: '粘贴', run: doPaste, key: `${MOD}+V` });
    items.push({ icon: 'all', label: '全选', cmd: 'selectAll', key: `${MOD}+A` });
    if (!ro) {
      items.push('-');
      items.push({ icon: 'undo', label: '撤销', cmd: 'undo', key: `${MOD}+Z` });
      items.push({ icon: 'redo', label: '重做', cmd: 'redo', key: isMac ? '⇧⌘Z' : 'Ctrl+Y' });
    }
    return items;
  }

  function runItem(it) {
    if (it.run) it.run(view);
    else if (it.cmd) commands[it.cmd]?.(view);
  }

  // ———— 键盘高亮（↑↓ 走项、→/Enter 开子菜单、← 收子菜单）————
  // 高亮态是 .hi 类而非真焦点：焦点必须一直留在编辑器里，命令才有选区可作用。
  function itemsOf(m) { return m ? [...m.querySelectorAll('.mde-mi')] : []; }
  function hiOf(m) { return m?.querySelector('.mde-mi.hi') || null; }
  function setHi(m, b) {
    if (!m) return;
    for (const x of itemsOf(m)) x.classList.toggle('hi', x === b);
    b?.scrollIntoView?.({ block: 'nearest' });
  }
  function moveHi(m, dir) {
    const list = itemsOf(m);
    if (!list.length) return;
    const cur = list.indexOf(hiOf(m));
    const next = cur === -1 ? (dir > 0 ? 0 : list.length - 1) : (cur + dir + list.length) % list.length;
    setHi(m, list[next]);
  }

  // ———— 菜单 DOM ————
  // isSub：子菜单里的项永远不排「缓关子菜单」——那是主菜单普通项才该做的事；
  // 老版本没分，子菜单一被 hover 就在 250ms 后把自己关掉（窄栏叠放时更成了闪烁循环）。
  function menuEl(items, isSub = false) {
    const m = document.createElement('div');
    m.className = 'mde-menu';
    m.setAttribute('role', 'menu');
    const showKeys = finePointer();
    for (const it of items) {
      if (it === '-') { m.insertAdjacentHTML('beforeend', '<div class="mde-msep"></div>'); continue; }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.className = 'mde-mi' + (it.danger ? ' mde-mi-danger' : '');
      b.innerHTML = `<span class="mi-ic">${ICONS[it.icon] || it.svg || ''}</span><span class="mi-lb"></span>` +
        (it.sub ? `<span class="mi-more">${ICONS.chev}</span>`
          : it.on ? `<span class="mi-chk">${ICONS.check}</span>`
          : it.key && showKeys ? `<kbd class="mi-key"></kbd>` : '');
      b.querySelector('.mi-lb').textContent = it.label;   // label 可能含选中原文，textContent 防注入
      if (it.key && showKeys && !it.sub && !it.on) b.querySelector('.mi-key').textContent = it.key;
      b.__it = it;
      b.addEventListener('pointerdown', (e) => e.preventDefault());   // 别抢编辑器焦点/选区
      if (it.sub) {
        b.addEventListener('click', () => (sub && sub._for === b ? closeSub() : openSub(b, it)));
        b.addEventListener('pointerenter', (e) => {
          setHi(m, b);
          if (e.pointerType !== 'mouse') return;
          clearTimeout(subHoverT);
          clearTimeout(subCloseT);
          if (sub && sub._for === b) return;          // 自己的子菜单已开着：什么都别动
          subHoverT = setTimeout(() => openSub(b, it), 120);
        });
        b.addEventListener('pointerleave', () => clearTimeout(subHoverT));
      } else {
        b.addEventListener('click', () => { closeAll(); runItem(it); });
        b.addEventListener('pointerenter', (e) => {
          setHi(m, b);
          if (isSub || e.pointerType !== 'mouse' || !sub) return;
          clearTimeout(subCloseT);
          subCloseT = setTimeout(closeSub, 250);   // 缓关：斜向滑进子菜单不被误杀
        });
      }
      m.appendChild(b);
    }
    m.addEventListener('pointerenter', () => clearTimeout(subCloseT));
    return m;
  }

  function openSub(anchorBtn, it) {
    closeSub();
    if (!menu) return;
    sub = menuEl(it.sub, true);
    sub._for = anchorBtn;
    sub.classList.add('mde-submenu');
    sub.style.visibility = 'hidden';
    root.appendChild(sub);
    const hr = host.getBoundingClientRect();
    const mr = menu.getBoundingClientRect();
    const rr = anchorBtn.getBoundingClientRect();
    sub.style.maxHeight = Math.max(120, hr.height - 16) + 'px';
    const w = sub.offsetWidth, h = sub.offsetHeight;
    const rightX = mr.right - hr.left + 4;
    const leftX = mr.left - hr.left - w - 4;
    let x, y = rr.top - hr.top - 6, origin = 'top left';
    if (rightX + w <= hr.width - 6) x = rightX;                       // ① 右侧放得下
    else if (leftX >= 6) { x = leftX; origin = 'top right'; }          // ② 左飞出
    else {                                                             // ③ 两边都挤 → 叠放：贴余量大的一侧、从锚点行的下一行（或上一行）起铺
      const roomR = hr.right - mr.right, roomL = mr.left - hr.left;
      x = roomR >= roomL ? Math.max(6, hr.width - w - 6) : 6;
      const side = roomR >= roomL ? 'right' : 'left';
      // 顶/底边与锚点行咬合 2px：指针滑过去不经过主菜单的相邻项（不然会误触它的 hover）。
      // 锚点行必须一直露着——盖住它就是老 bug 的根；下方不够就翻到上方，两头都不够就限高滚动，
      // 连 180px 都凑不出才认栽盖住。
      const belowY = rr.bottom - hr.top - 2, below = hr.height - belowY - 8;
      const aboveEnd = rr.top - hr.top + 2, above = aboveEnd - 6;
      let dir = 'down';
      if (h <= below) y = belowY;
      else if (h <= above) { y = aboveEnd - h; dir = 'up'; }
      else if (Math.max(below, above) >= 180) {
        if (below >= above) { y = belowY; sub.style.maxHeight = below + 'px'; }
        else { sub.style.maxHeight = above + 'px'; y = aboveEnd - sub.offsetHeight; dir = 'up'; }
      }
      origin = (dir === 'up' ? 'bottom ' : 'top ') + side;
      sub.classList.add('stacked');
    }
    y = clamp(y, 6, Math.max(6, hr.height - sub.offsetHeight - 8));
    sub.style.left = x + 'px';
    sub.style.top = y + 'px';
    sub.style.transformOrigin = origin;
    sub.style.visibility = '';
    anchorBtn.classList.add('sub-open');
    sub.offsetWidth;   // 强制 reflow 让过渡从初始态起跑（rAF 在 Browser pane 合成器冻结时永不触发）
    sub.classList.add('open');
  }
  function closeSub() {
    clearTimeout(subHoverT);
    clearTimeout(subCloseT);
    sub?._for?.classList.remove('sub-open');
    sub?.remove();
    sub = null;
  }

  // cx/cy 视口坐标（contextmenu 事件点 / 选中条 ⋯ 锚点）；items 省略=编辑器默认菜单，
  // 传入=调用方自备的菜单（属性面板的属性菜单走这条，共用同一套外观/定位/夹紧）
  function openMenu(cx, cy, items) {
    closeAll();
    if (!view || !root) return;
    hideBar();
    menu = menuEl(items || buildItems(view));
    menu.style.visibility = 'hidden';
    root.appendChild(menu);
    const hr = host.getBoundingClientRect();
    menu.style.maxHeight = Math.max(140, hr.height - 16) + 'px';
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const rawX = cx - hr.left;
    let x = clamp(rawX, 8, Math.max(8, hr.width - w - 8));
    let y = cy - hr.top;
    let up = false;
    if (y + h > hr.height - 8 && y - h >= 8) { y = y - h; up = true; }   // 下方放不下且上方够 → 往上开
    y = clamp(y, 8, Math.max(8, hr.height - h - 8));
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.transformOrigin = (up ? 'bottom' : 'top') + ' ' + (x < rawX - 4 ? 'right' : 'left');
    menu.style.visibility = '';
    menuOpen = true;
    menu.offsetWidth;   // 强制 reflow 让过渡从初始态起跑（rAF 在 Browser pane 合成器冻结时永不触发）
    menu.classList.add('open');
  }
  function closeMenu() {
    closeSub();
    menu?.remove();
    menu = null;
    menuOpen = false;
  }
  function closeAll() {
    closeMenu();
  }

  // ———— 选中浮条 ————
  function buildBar(ro) {
    bar?.remove();
    bar = document.createElement('div');
    bar.className = 'mde-selbar';
    bar.setAttribute('role', 'toolbar');
    barRo = ro;
    const mk = (html, title, fn, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      if (cls) b.className = cls;
      b.innerHTML = html;
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', fn);
      bar.appendChild(b);
      return b;
    };
    const sep = () => bar.insertAdjacentHTML('beforeend', '<span class="sb-sep"></span>');
    if (!ro) {
      mk(ICONS.bold, '加粗', () => commands.bold(view));
      mk(ICONS.italic, '斜体', () => commands.italic(view));
      mk(ICONS.strike, '删除线', () => commands.strike(view));
      mk(ICONS.hl, '高亮', () => commands.highlight(view));
      sep();
      mk(ICONS.code, '行内代码', () => commands.code(view));
      mk(ICONS.wik, '双链', () => commands.wikilink(view));
    } else {
      mk(ICONS.copy, '复制', () => doCopy(view));
      mk(ICONS.find, '查找下一处', () => findNext(view));
    }
    sep();
    mk(ICONS.more, '更多', () => {
      const r = bar.getBoundingClientRect();
      openMenu(r.left, r.bottom + 8);
    }, 'sb-more');
    root.appendChild(bar);
  }

  function showBar() {
    if (!view || !root || menuOpen || pointerDown) return;
    const r = view.state.selection.main;
    if (r.empty) return hideBar();
    let c1 = null, c2 = null;
    try { c1 = view.coordsAtPos(r.from, 1); c2 = view.coordsAtPos(r.to, -1); } catch {}
    if (!c1) return hideBar();
    const ro = view.state.readOnly;
    if (!bar || barRo !== ro) buildBar(ro);
    const hr = host.getBoundingClientRect();
    // 浮条常驻布局（visibility 藏着），不必先 display 再量：offsetWidth 直接可读
    const w = bar.offsetWidth, h = bar.offsetHeight;
    const midX = ((c1.left + (c2 ? c2.right : c1.left)) / 2) - hr.left;
    const x = clamp(midX - w / 2, 6, Math.max(6, hr.width - w - 6));
    let y = c1.top - hr.top - h - 10;
    let below = false;
    if (y < 6) { y = (c2 ? c2.bottom : c1.bottom) - hr.top + 10; below = true; }
    y = clamp(y, 6, Math.max(6, hr.height - h - 6));
    bar.style.left = x + 'px';
    bar.style.top = y + 'px';
    bar.classList.toggle('below', below);
    if (!bar.classList.contains('show')) bar.offsetWidth;   // 从初始态起跑过渡
    bar.classList.add('show');
  }
  function hideBar() {
    bar?.classList.remove('show');
  }

  function scheduleBar(delay = 250) {
    clearTimeout(barT);
    barT = setTimeout(showBar, delay);
  }

  function onSelChange(v) {
    view = v;
    if (v.state.selection.main.empty) { clearTimeout(barT); hideBar(); return; }
    scheduleBar();
  }

  // ———— 右键 ————
  function onContextMenu(e, v) {
    view = v;
    if (e.target.closest?.('.mde-table')) return false;   // 表格格子交还原生（格内粘贴等）
    e.preventDefault();
    const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos != null) {
      const r = v.state.selection.main;
      if (r.empty || pos < r.from || pos > r.to) v.dispatch({ selection: { anchor: pos } });
    }
    openMenu(e.clientX, e.clientY);
    return true;
  }

  const extension = [
    EditorView.updateListener.of((u) => { if (u.selectionSet || u.docChanged) onSelChange(u.view); }),
    EditorView.domEventHandlers({ contextmenu: onContextMenu }),
  ];

  // ———— 全局监听（attach 装，destroy 卸） ————
  function onDocPointerDown(e) {
    if (root?.contains(e.target)) return;
    if (menuOpen) closeAll();
    if (host?.contains(e.target)) { pointerDown = true; clearTimeout(barT); hideBar(); }
  }
  function onWinPointerUp() {
    if (!pointerDown) return;
    pointerDown = false;
    scheduleBar(120);
  }
  function onScroll() {
    if (menuOpen) closeAll();
    hideBar();
    clearTimeout(scrollT);
    scrollT = setTimeout(showBar, 180);
  }
  function onKeyDown(e) {
    if (!menuOpen) return;
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAll(); scheduleBar(80); return; }
    const active = sub || menu;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      moveHi(active, k === 'ArrowDown' ? 1 : -1);
    } else if (k === 'ArrowRight' || k === 'Enter' || k === ' ') {
      const b = hiOf(active);
      if (!b) { if (k !== 'ArrowRight') return; e.preventDefault(); moveHi(active, 1); return; }
      e.preventDefault(); e.stopPropagation();
      if (b.__it?.sub) { openSub(b, b.__it); moveHi(sub, 1); }
      else if (k !== 'ArrowRight') b.click();
    } else if (k === 'ArrowLeft') {
      if (!sub) return;
      e.preventDefault(); e.stopPropagation();
      const anchor = sub._for;
      closeSub();
      setHi(menu, anchor);
    }
  }
  function onFocusOut() {
    setTimeout(() => {
      const a = document.activeElement;
      if (host && a && !host.contains(a)) { hideBar(); closeAll(); }
    }, 80);
  }

  function attach(v, hostEl) {
    view = v;
    host = hostEl;
    root = document.createElement('div');
    root.className = 'mde-pop';
    host.appendChild(root);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('pointerup', onWinPointerUp, true);
    document.addEventListener('keydown', onKeyDown, true);
    v.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    v.dom.addEventListener('focusout', onFocusOut);
  }

  function destroy() {
    clearTimeout(barT); clearTimeout(scrollT); clearTimeout(subHoverT); clearTimeout(subCloseT); clearTimeout(flashT);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    window.removeEventListener('pointerup', onWinPointerUp, true);
    document.removeEventListener('keydown', onKeyDown, true);
    try { view?.scrollDOM.removeEventListener('scroll', onScroll); view?.dom.removeEventListener('focusout', onFocusOut); } catch {}
    root?.remove();
    root = null; bar = null; menu = null; sub = null; view = null; host = null;
  }

  return { extension, attach, destroy, openMenu, flash };
}
