// 右键点中的是什么（contextOf），以及给它哪些条目（rowsFor）。条目按「点中的东西」给，最可能用的放最上面：
//   选中正文：复制、复制为 Markdown、引用回复、在网上搜索；选区里认出链接 / 路径时，第一项换成打开它
//   没选字、点在回复上：复制整条、复制为 Markdown、引用整条、全选这条
//   链接 / 路径 / 代码块 / 输入框各一套
// 认不出的（界面骨架、图片……）返回 null，交还给桌面壳的系统菜单或浏览器默认。
import { t } from '../i18n.js';
import { ANSWER, skinOf } from './host.js';
import * as A from './actions.js';

const EDITABLE = 'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
const TEXT_INPUT = /^(text|search|url|email|tel|password|number|)$/i;
const URL_RE = /https?:\/\/[^\s<>"'）)】]+/;
const PATH_IN = /(?:^|[\s(（「`'"])((?:\.\/)?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]+(?::\d+){0,2})(?=$|[\s)）」`'",.，。:;；])/;
const SEP = { sep: true };
const it = (icon, label, act, o = {}) => ({ icon, label, act, ...o });

// 右键点在不在选区上：有墨就问墨（行带外扩一点），没有就看选区的矩形
function onSelection(D, range, x, y) {
  const ink = D.api.curInk();
  if (ink) {
    const lr = ink.svg.getBoundingClientRect();
    return ink.contains(x - lr.left, y - lr.top);
  }
  for (const r of range.getClientRects()) {
    if (x >= r.left - 24 && x <= r.right + 24 && y >= r.top - 6 && y <= r.bottom + 6) return true;
  }
  return false;
}

export function contextOf(D, target, x, y, kb = false) {
  if (!target) return null;
  const skin = skinOf(target, D.skin);
  const base = { skin, el: target };
  const ed = target.closest(EDITABLE);
  if (ed) {
    if (ed.closest('.cm-editor, .xterm')) return null;
    if (ed.tagName === 'INPUT' && !TEXT_INPUT.test(ed.type || '')) return null;
    return { ...base, kind: 'input', ed };
  }
  const sel = D.win.getSelection();
  const anchorEl = sel && A.elOf(sel.anchorNode);
  const hasSel = !!(sel && sel.rangeCount && !sel.isCollapsed && anchorEl && (D.skin || anchorEl.closest('.sel-text')));
  if (hasSel) {
    const range = sel.getRangeAt(0);
    if (kb || onSelection(D, range, x, y)) return { ...base, el: anchorEl, kind: 'sel', range, text: sel.toString() };
  }
  const content = D.skin ? target : target.closest('.sel-text');
  if (!content) return null;
  if (hasSel) A.clearSel(D);   // 点在选区外：按点中的东西给菜单，原来的选区收掉
  const a = target.closest('a[href]');
  if (a && /^(https?:|mailto:)/i.test(a.getAttribute('href') || '')) return { ...base, kind: 'link', href: a.href };
  const code = target.closest('code');
  if (code && !code.closest('pre') && A.PATH_RE.test(code.textContent.trim())) return { ...base, kind: 'path', path: code.textContent.trim() };
  const pre = target.closest('pre');
  if (pre) return { ...base, kind: 'code', pre };
  const ans = ANSWER[skin] && target.closest(ANSWER[skin]);
  if (ans) return { ...base, kind: 'msg', msg: ans, pt: { x, y } };
  const ub = skin === 'claude' && target.closest('.bubble.sel-text');
  if (ub) return { ...base, kind: 'umsg', msg: ub, pt: { x, y } };
  return null;
}

// 选区里认出来的东西：链接 → 打开它；相对路径 → 在这个分页的工作台里打开
function smartOf(D, ctx) {
  const frag = ctx.range.cloneContents();
  const a = frag.querySelector && frag.querySelector('a[href]');
  const href = a && /^https?:/i.test(a.getAttribute('href') || '') ? a.href : (ctx.text.match(URL_RE) || [])[0];
  if (href) {
    let host = href;
    try { host = new URL(href).host; } catch {}
    return it('out', t('打开链接'), () => A.openLink(href), { obj: host });
  }
  const m = A.canOpenPath(ctx.skin) && ctx.text.match(PATH_IN);
  if (m) return it('folderOpen', t('在工作区打开'), () => A.openPath(ctx.skin, m[1]), { obj: m[1].replace(/(?::\d+){1,2}$/, '').split('/').pop() });
  return null;
}

export function rowsFor(D, ctx) {
  const canQuote = () => !!A.composerFor(D, ctx.el, ctx.skin);
  switch (ctx.kind) {
    case 'sel': {
      const smart = smartOf(D, ctx);
      const q = canQuote();
      return [
        smart, smart && SEP,
        it('copy', t('复制'), () => A.copySel(D, false), { hk: A.keyLabel('C') }),
        it('md', t('复制为 Markdown'), () => A.copySel(D, true)),
        SEP,
        q && it('quote', t('引用回复'), () => A.quote(D, ctx, ctx.text)),
        q && SEP,
        it('search', t('在网上搜索「{q}」', { q: A.trunc(ctx.text, 8) }), () => A.search(D, ctx.text)),
      ];
    }
    case 'msg': {
      const q = canQuote();
      return [
        it('copy', t('复制整条回复'), () => A.copyEl(D, ctx.msg, false)),
        it('md', t('复制为 Markdown'), () => A.copyEl(D, ctx.msg, true)),
        SEP,
        q && it('quote', t('引用整条回复'), () => A.quote(D, ctx, ctx.msg.innerText, ctx.msg)),
        q && SEP,
        it('all', t('全选这条'), () => D.api.selectAll(ctx.msg, ctx.pt)),
      ];
    }
    case 'umsg':
      return [
        it('copy', t('复制这条消息'), () => A.copyEl(D, ctx.msg, false)),
        it('all', t('全选这条'), () => D.api.selectAll(ctx.msg, ctx.pt)),
      ];
    case 'link': {
      let host = ctx.href;
      try { host = new URL(ctx.href).host; } catch {}
      return [
        it('out', t('打开链接'), () => A.openLink(ctx.href), { obj: host }),
        SEP,
        it('link', t('复制链接'), () => A.copyText(ctx.href, t('已复制链接'))),
      ];
    }
    case 'path': {
      const name = ctx.path.replace(/(?::\d+){1,2}$/, '').split('/').pop();
      return [
        A.canOpenPath(ctx.skin) && it('folderOpen', t('在工作区打开'), () => A.openPath(ctx.skin, ctx.path), { obj: name }),
        it('copy', t('复制路径'), () => A.copyText(ctx.path, t('已复制路径'))),
      ];
    }
    case 'code':
      return [
        it('copy', t('复制代码'), () => A.copyCode(ctx.pre, false)),
        it('md', t('复制为 Markdown'), () => A.copyCode(ctx.pre, true)),
      ];
    case 'input': {
      const ed = ctx.ed;
      const has = A.edHasSel(ed);
      const ce = !('value' in ed) || ed.tagName === 'DIV';
      return [
        it('cut', t('剪切'), () => A.edCmd(ed, 'cut'), { hk: A.keyLabel('X'), disabled: !has || ed.readOnly }),
        it('copy', t('复制'), () => A.edCmd(ed, 'copy'), { hk: A.keyLabel('C'), disabled: !has }),
        it('clip', t('粘贴'), () => A.edPaste(ed), { hk: A.keyLabel('V'), disabled: ed.readOnly }),
        ce && it('plain', t('粘贴为纯文本'), () => A.edPaste(ed), { hk: A.keyLabel('V', true) }),
        SEP,
        it('all', t('全选'), () => A.edSelectAll(ed), { hk: A.keyLabel('A'), disabled: A.edEmpty(ed) }),
      ];
    }
  }
  return [];
}
