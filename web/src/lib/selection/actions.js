// 菜单里每一项真正做的事。D 是 controller 给每个文档建的状态（D.api 里是墨的反馈、整条临时墨、全选）。
import { t } from '../i18n.js';
import { showToast } from '../toast.svelte.js';
import { rangeToMd } from './markdown.js';
import { pageRootOf, bgOf, themeOf } from './host.js';

const viewOf = (el) => el.ownerDocument.defaultView;
const elOf = (n) => (n && n.nodeType === 3 ? n.parentElement : n);
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const keyLabel = (k, shift = false) => (isMac ? (shift ? '⇧⌘' : '⌘') + k : 'Ctrl+' + (shift ? 'Shift+' : '') + k);
export const charCount = (s) => String(s).replace(/\s+/g, '').length;
export const trunc = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// 叠好的选区色（飞行物的底）：与 ink.css / selection.css 同一组
const FLAT = {
  claude: ['#62382a', '#f5dacd'], codex: ['#31587a', '#b8dcff'], agy: ['#22354f', '#dae6f8'],
  dimensio: ['#52261d', '#ebcfc2'], bridge: ['#4a4945', '#dfdcd3'],
};

export function fontOf(el, skin) {
  try { return viewOf(el).getComputedStyle(pageRootOf(el, skin)).fontFamily; } catch { return ''; }
}
export const menuTheme = (el) => themeOf(bgOf(el));

// ── 剪贴板 ──
// 只在安全上下文里有 navigator.clipboard（局域网 http 打开时没有）：退回隐藏文本框 + execCommand，
// 这会抢走选区和焦点，所以先记下、复制完原样还回去（还回去的选区锚点不变，墨不会重长）
export async function writeText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  const sel = getSelection();
  const saved = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const active = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  try { active?.focus?.({ preventScroll: true }); } catch {}
  if (saved) { sel.removeAllRanges(); sel.addRange(saved); }
  return ok;
}

function done(D, ink, label) {
  if (ink) D.api.feedback(ink, label);
  else showToast(label);
}

export function copySel(D, md) {
  const sel = D.win.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  const ink = D.api.curInk();
  if (md) {
    writeText(rangeToMd(sel.getRangeAt(0)));
    done(D, ink, t('已复制 Markdown'));
    return;
  }
  // 普通复制走浏览器自己的复制：剪贴板里连带一份富文本，粘到文档里格式还在
  let ok = false;
  try { ok = D.doc.execCommand('copy'); } catch {}
  if (!ok) writeText(sel.toString());
  done(D, ink, t('已复制 · {n} 字', { n: charCount(sel.toString()) }));
}

export function copyEl(D, el, md) {
  D.api.clear();
  const r = D.doc.createRange();
  r.selectNodeContents(el);
  writeText(md ? rangeToMd(r) : el.innerText.trim());
  const ink = D.api.tempInk(r);
  const label = md ? t('已复制 Markdown') : t('已复制 · {n} 字', { n: charCount(el.innerText) });
  if (ink) setTimeout(() => D.api.feedback(ink, label), 260);
  else showToast(label);
}

export function codeText(pre) {
  const code = pre.querySelector('code');
  if (code) return code.textContent.replace(/\n$/, '');
  const c = pre.cloneNode(true);
  c.querySelectorAll('button, [role="button"], [aria-hidden="true"]').forEach((x) => x.remove());
  return c.textContent.replace(/\n$/, '');
}

export function copyCode(pre, md) {
  const code = codeText(pre);
  const m = (pre.querySelector('code')?.className || '').match(/language-([\w+#-]+)/);
  const lang = pre.dataset.lang || (m ? m[1] : '');
  writeText(md ? '```' + lang + '\n' + code + '\n```' : code);
  showToast(md ? t('已复制 Markdown') : t('已复制代码'));
}

export function copyText(text, label) {
  writeText(text);
  showToast(label);
}

// ── 引用回复：引文飞进这个分页的输入栏，落地时以 Markdown 引用插在最前面，光标停在下面 ──
// 只在这个分页自己的根节点里找输入栏（各分页常驻在同一文档里，别跨页找到别人的）；其他分页没有对话输入栏，不给引用
export function composerFor(D, el, skin) {
  if (skin === 'codex') return D.doc.getElementById('prompt-textarea');
  if (skin === 'bridge') return null;
  const root = pageRootOf(el, skin);
  if (!root || root === el.ownerDocument.body) return null;
  const list = [...root.querySelectorAll('[data-sel-composer]')].filter((c) => c.offsetParent !== null);
  return list[list.length - 1] || null;
}

function insertAtStart(el, text) {
  const doc = el.ownerDocument, win = doc.defaultView;
  el.focus({ preventScroll: true });
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') el.setSelectionRange(0, 0);
  else {
    const r = doc.createRange();
    r.selectNodeContents(el);
    r.collapse(true);
    const s = win.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  // insertText 走编辑命令：触发 input 事件（各页输入栏的状态跟着更新），还进撤销栈
  let ok = false;
  try { ok = doc.execCommand('insertText', false, text); } catch {}
  if (!ok && 'value' in el) {
    el.value = text + el.value;
    el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}

export function quote(D, ctx, text, srcEl) {
  const comp = composerFor(D, ctx.el, ctx.skin);
  if (!comp) return;
  // 引文按 Markdown 取：列表的「- 」、加粗、行内代码都留着（纯文本会把列表项之间的空行变成一行空的「>」）
  let md = '';
  try {
    if (ctx.range) md = rangeToMd(ctx.range);
    else if (srcEl) { const r = D.doc.createRange(); r.selectNodeContents(srcEl); md = rangeToMd(r); }
  } catch {}
  const body = String(md || text).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) return;
  const q = body.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n') + '\n\n';
  const off = D.api.frameOffset();
  let src = null;
  if (ctx.range) src = [...ctx.range.getClientRects()].find((r) => r.width > 1);
  else if (srcEl) src = [...srcEl.getClientRects()].find((r) => r.width > 1) || srcEl.getBoundingClientRect();
  const dst = comp.getBoundingClientRect();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  D.api.clear();   // 选区的墨随之退场：引文被「拿走」了
  if (!src || reduce) { insertAtStart(comp, q); return; }
  const cs = viewOf(comp).getComputedStyle(comp);
  const skin = ctx.skin;
  const dark = themeOf(bgOf(comp)) === 'dark';
  const fl = document.createElement('div');
  fl.className = 'sel-flyer';
  const inner = document.createElement('div');
  inner.textContent = trunc(body, 60);
  inner.style.background = FLAT[skin]?.[dark ? 0 : 1] || FLAT.bridge[dark ? 0 : 1];
  inner.style.color = viewOf(ctx.el).getComputedStyle(ctx.el).color;
  inner.style.fontFamily = cs.fontFamily;
  fl.append(inner);
  document.body.append(fl);
  const tx = dst.left + off.x + parseFloat(cs.paddingLeft || 0) - 8;
  const ty = dst.top + off.y + parseFloat(cs.paddingTop || 0) - 2;
  const sx = src.left + off.x - 8, sy = src.top + off.y + (src.height - inner.offsetHeight) / 2;
  fl.style.left = tx + 'px';
  fl.style.top = ty + 'px';
  // 横向先走（缓出）、纵向后落（缓入）：路径是一道抛物线，像被抛进输入栏；途中抬起一点投影
  fl.animate([{ transform: `translateX(${sx - tx}px)` }, { transform: 'translateX(0)' }], { duration: 480, easing: 'cubic-bezier(.2,.7,.25,1)', fill: 'both' });
  inner.animate([
    { transform: `translateY(${sy - ty}px) scale(1.06)`, boxShadow: '0 0 0 rgba(0,0,0,0)' },
    { boxShadow: '0 10px 24px rgba(0,0,0,.22)', offset: 0.45 },
    { transform: 'translateY(0) scale(.96)', boxShadow: '0 0 0 rgba(0,0,0,0)', opacity: 1 },
  ], { duration: 480, easing: 'cubic-bezier(.55,0,.35,1)', fill: 'both' });
  setTimeout(() => {
    insertAtStart(comp, q);
    fl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: 'both' }).finished.then(() => fl.remove(), () => fl.remove());
  }, 440);
}

// ── 打开 ──
export function search(D, text) {
  const q = String(text).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (q) window.open('https://www.google.com/search?q=' + encodeURIComponent(q), '_blank', 'noopener,noreferrer');
}

export function openLink(href) {
  window.open(href, '_blank', 'noopener,noreferrer');
}

// 回答里的相对路径（web/src/app.css:155）→ 在这个分页的工作台里打开那个文件（行号工作台不支持跳，去掉）
export const PATH_RE = /^(?:\.\/)?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]+(?::\d+){0,2}$/;
export const canOpenPath = (skin) => skin === 'claude' || skin === 'agy' || skin === 'codex';
export async function openPath(skin, path) {
  const p = String(path).trim().replace(/(?::\d+){1,2}$/, '').replace(/^\.\//, '');
  const i = p.lastIndexOf('/');
  const rel = i > 0 ? p.slice(0, i) : '';
  const name = p.slice(i + 1);
  const dock = await import('../dock.svelte.js');
  const host = skin === 'agy' ? dock.agyHost : skin === 'codex' ? dock.codexHost : dock.claudeHost;
  if (!host?.state?.ws) { showToast(t('这个对话还没有工作区，打不开文件')); return; }
  // ws 显式带上：Claude 的文件卡默认以身份文件根为根，回答里的相对路径是相对这条对话的工作区说的
  host.openFiles({ ws: host.state.ws, rel, open: name });
}

// ── 输入框 ──
export function edHasSel(ed) {
  if (ed.tagName === 'INPUT' || ed.tagName === 'TEXTAREA') return (ed.selectionEnd ?? 0) > (ed.selectionStart ?? 0);
  const s = viewOf(ed).getSelection();
  return !!(s && s.rangeCount && !s.isCollapsed && ed.contains(s.anchorNode));
}
export function edEmpty(ed) {
  return 'value' in ed && ed.tagName !== 'DIV' ? !ed.value : !ed.textContent.trim();
}
export function edCmd(ed, cmd) {
  ed.focus({ preventScroll: true });
  try { ed.ownerDocument.execCommand(cmd); } catch {}
}
export async function edPaste(ed) {
  let text = null;
  try { text = await viewOf(ed).navigator.clipboard.readText(); } catch {}
  if (text == null) { showToast(t('浏览器没让读剪贴板，请按 {k} 粘贴', { k: keyLabel('V') })); return; }
  ed.focus({ preventScroll: true });
  try { ed.ownerDocument.execCommand('insertText', false, text); } catch {}
}
export function edSelectAll(ed) {
  ed.focus({ preventScroll: true });
  if (typeof ed.select === 'function' && ed.tagName !== 'DIV') { ed.select(); return; }
  const r = ed.ownerDocument.createRange();
  r.selectNodeContents(ed);
  const s = viewOf(ed).getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

export function clearSel(D) {
  try { D.win.getSelection().removeAllRanges(); } catch {}
}

export { elOf };
