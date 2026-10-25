// md 编辑器按键与 Live Preview 装饰（状态层，不起 DOM）：对齐 Obsidian 的几条行为——
//   · 段落下单个「-」不把上一行变成标题（Obsidian setext 要 ≥2 个「-」）；「- 」画成空圆点、行尾回车去掉它
//   · 列表后顶格写的懒续行不再悬挂对齐到上一项正文；空项退格整段删标记回行首
//   · Tab / Shift+Tab 的从属缩进：续行挂到所属项下、空行后的段落挂到上面的项下、首项挂不上给提示
//   · ![[图]] 地址还在解析时占位（ImageWidget src=''）
//   · 引用 / callout 源码 / 列表项里的单个「-」同口径；callout 卡里的嵌入图随解析结果重绘；插图失败不留空行
// 跑法：cd web && node --test src/lib/mdeditor/mdeditor.test.js（给目录不行；src/lib/*.test.js 的 glob 也不含子目录）
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./_nodehooks.mjs', import.meta.url);
globalThis.window ??= globalThis;   // widgets / props 里零星的 window.xxx 判断
const S = await import('@codemirror/state');
const V = await import('@codemirror/view');
const L = await import('@codemirror/language');
const MD = await import('@codemirror/lang-markdown');
const { omExtensions } = await import('./mdext.js');
const keys = await import('./keys.js');
const LP = await import('./livePreview.js');
const cmds = await import('./commands.js');
const attach = await import('./attach.js');
const obsmd = await import('../obsmd.js');

// —— 装配：与 index.js 同一套语言配置；假 view 只有 state/dispatch（命令只用到这些）——
function makeState(text, cursor = text.length, extra = []) {
  return S.EditorState.create({
    doc: text,
    selection: { anchor: cursor },
    extensions: [
      MD.markdown({
        base: MD.markdownLanguage,
        extensions: [...omExtensions, { remove: ['Superscript', 'Subscript'] }],
        completeHTMLTags: false, addKeymap: false, pasteURLAsLink: false,
      }),
      keys.indentConf.of(L.indentUnit.of(keys.detectIndentUnit(text))),
      extra,
    ],
  });
}
function fakeView(state) {
  const v = {
    state, composing: false, compositionStarted: false, destroyed: false, hasFocus: false, focus() {},
    dispatch(...args) {
      const tr = args[0] instanceof S.Transaction ? args[0] : v.state.update(...args);
      v.state = tr.state;
    },
  };
  return v;
}
// 「|」标光标：'- a\n- |' → { doc, cursor }
function at(src) {
  const i = src.indexOf('|');
  return { doc: src.slice(0, i) + src.slice(i + 1), cursor: i };
}
const show = (v) => { const d = v.state.doc.toString(), h = v.state.selection.main.head; return d.slice(0, h) + '|' + d.slice(h); };
function press(src, key, { shift = false, flash = null } = {}) {
  const { doc, cursor } = at(src);
  const v = fakeView(makeState(doc, cursor));
  // 同 keymap：同一个键的绑定按顺序跑，直到有一个接手（Backspace 前面还有 closeBrackets 的一条）
  for (const b of keys.mdKeymap({ flash }).filter((x) => x.key === key)) {
    const run = shift ? b.shift : b.run;
    if (run && run(v)) { v.handled = true; break; }
  }
  return v;
}
function typeText(v, text) {
  for (const ch of text) {
    const h = v.state.selection.main.head;
    v.dispatch({ changes: { from: h, insert: ch }, selection: { anchor: h + 1 }, userEvent: 'input.type' });
  }
}

// —— Live Preview：读出每行的行装饰 class 与替换 widget ——
function lpState(doc, cursor = doc.length, opts = {}) {
  let st = makeState(doc, cursor, [LP.livePreview(opts)]);
  const effs = st.facet(V.EditorView.focusChangeEffect).map((f) => f(st, true)).filter(Boolean);
  return st.update({ effects: effs }).state;   // 聚焦（不聚焦时什么都不揭示）
}
function lineInfo(st) {
  const out = new Map();
  for (const set of st.facet(V.EditorView.decorations)) {
    if (typeof set === 'function') continue;
    for (const it = set.iter(); it.value; it.next()) {
      const ln = st.doc.lineAt(it.from).number, v = it.value;
      const e = out.get(ln) || { cls: [], widgets: [], sty: '' };
      if (v.spec?.widget) e.widgets.push(v.spec.widget);
      else if (it.from === it.to && v.spec?.class != null) {
        e.cls.push(...String(v.spec.class).split(' ').filter(Boolean));
        e.sty += v.spec.attributes?.style || '';
      }
      out.set(ln, e);
    }
  }
  return (n) => out.get(n) || { cls: [], widgets: [], sty: '' };
}

// ———————————— 反馈 5：底部单个「-」 ————————————
test('单个「-」：高亮按 H2 打的 token 归一（行挂 mde-line-sdash），源码态 / LP、打字中途都一样；「--」不挂', async () => {
  // 语法树仍是 SetextHeading2，theme.js 照样给上一行和「-」打 mde-t-h mde-t-h2（1.4em 粗体）——只看行级 h2 抓不到这个
  const hasSetext2 = (st) => { let f = false; L.syntaxTree(st).iterate({ enter: (n) => { if (n.name === 'SetextHeading2') f = true; } }); return f; };
  const srcOnly = (doc) => makeState(doc, doc.length, [LP.singleDashPlain]);
  for (const doc of ['上一行文字\n-', '上一行文字\n- ', '> 说明\n> -', '第一行\n第二行\n-']) {
    const st = srcOnly(doc);
    assert.ok(hasSetext2(st), '树里仍是 setext：' + JSON.stringify(doc));
    const Li = lineInfo(st);
    for (let n = 1; n <= st.doc.lines; n++) assert.ok(Li(n).cls.includes('mde-line-sdash'), JSON.stringify(doc) + ' L' + n);
  }
  for (const doc of ['上一行文字\n--\n正文', '上一行文字\n=', '上一行文字\n-x', '- a\n- b']) {
    const Li = lineInfo(srcOnly(doc));
    assert.ok(!Li(1).cls.includes('mde-line-sdash'), JSON.stringify(doc));
  }
  // LP 下同样挂（LP 自己的单减号分支只是不加行级 h2）
  const lp = lineInfo(makeState('上一行文字\n-', 0, [LP.livePreview({}), LP.singleDashPlain]));
  assert.ok(lp(1).cls.includes('mde-line-sdash') && !lp(1).cls.includes('mde-line-h2'));
  // 反馈原样：「结尾段落。」行尾回车再输入「-」，上一行立刻归一；再补一个「-」变成真 H2，归一撤掉
  const v = fakeView(srcOnly('结尾段落。'));
  typeText(v, '\n-');
  assert.ok(lineInfo(v.state)(1).cls.includes('mde-line-sdash'));
  typeText(v, '-');
  assert.ok(!lineInfo(v.state)(1).cls.includes('mde-line-sdash'));
  // 归一规则在 editor.css 里：行里的标题 token 回正文字号、字重
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./editor.css', import.meta.url), 'utf8');
  assert.match(css, /\.mde \.mde-line-sdash \.mde-t-h \{ font-size: inherit; font-weight: inherit; \}/);
});

test('LP：段落下单个「-」不出 H2（光标在哪都一样），「--」仍是 H2', () => {
  for (const cur of [0, 3, 6]) {
    const L1 = lineInfo(lpState('上一行文字\n-', cur));
    assert.ok(!L1(1).cls.includes('mde-line-h2'), 'cursor ' + cur);
  }
  const L2 = lineInfo(lpState('上一行文字\n--\n正文'));
  assert.ok(L2(1).cls.includes('mde-line-h2'));
});

test('LP：段落下的「- 」画成空圆点（Obsidian 里它是空列表项）', () => {
  const L1 = lineInfo(lpState('说明：\n- \n'));
  assert.ok(L1(2).cls.includes('mde-li'));
  assert.ok(L1(2).widgets.some((w) => w.constructor.name === 'ListMarkWidget'));
  assert.ok(!L1(1).cls.includes('mde-line-h2'));
});

test('Enter：段落下「- 」行尾回车 = 去掉空项，光标留在行首', () => {
  assert.equal(show(press('说明：\n- |', 'Enter')), '说明：\n|');
  // 只有一个「-」（还没空格）不接手，交给默认换行
  assert.ok(!press('说明：\n-|', 'Enter').handled);
});

test('引用 / callout 源码 / 列表项里，段落下的单个「-」同样不出 H2；空圆点按所在层级画', () => {
  for (const doc of ['> 说明\n> -', '> 说明\n> - ', '> [!note]\n> 说明\n> - ']) {
    for (const cur of [0, doc.length]) {
      const L1 = lineInfo(lpState(doc, cur));
      for (let n = 1; n <= 3; n++) assert.ok(!L1(n).cls.includes('mde-line-h2'), JSON.stringify(doc) + ' L' + n + ' cur ' + cur);
    }
  }
  assert.ok(lineInfo(lpState('> 说明\n> - ', 0))(2).widgets.some((w) => w.constructor.name === 'ListMarkWidget'));
  assert.ok(lineInfo(lpState('> 说明\n> --\n\n正文', 0))(1).cls.includes('mde-line-h2'), '「--」在引用里仍是 H2');
  // 「1. a」里段落下的「- 」是它的子项：第二级（48px），圆点换 circle；与真的嵌套列表同一个位置
  const L2 = lineInfo(lpState('1. a\n   说明\n   - ', 0));
  assert.match(L2(3).sty, /--mde-li-pad:48px/);
  assert.equal(L2(3).widgets.find((w) => w.constructor.name === 'ListMarkWidget')?.shape, 'circle');
  assert.match(lineInfo(lpState('1. a\n   说明\n   - x', 0))(3).sty, /--mde-li-pad:48px/);
});

test('Enter / Backspace：引用里「> - 」去掉空项、留下「> 」；列表项里留缩进；顶级行尾退格同 Enter', () => {
  assert.equal(show(press('> 说明\n> - |', 'Enter')), '> 说明\n> |');
  assert.equal(show(press('1. a\n   说明\n   - |', 'Enter')), '1. a\n   说明\n   |');
  assert.equal(show(press('说明：\n- |', 'Backspace')), '说明：\n|');
  assert.equal(show(press('> 说明\n> - |', 'Backspace')), '> 说明\n> |');
});

test('Tab：段落下的「- 」（画成空圆点）= 首项，挂不上去给提示；菜单入口（commands）同样提示', () => {
  let msg = '';
  const flash = (m) => { msg = m; };
  const v = press('说明：\n- |', 'Tab', { flash });
  assert.equal(v.state.doc.toString(), '说明：\n- ');
  assert.ok(msg && v.handled);
  msg = '';
  press('1. a\n   说明\n   - |', 'Tab', { flash });
  assert.ok(msg, '列表项里的也提示');
  // 手机浮条 / 右键菜单走 commands.indentList（withFocus 包一层）：opts 原样转进去
  msg = '';
  const { doc, cursor } = at('- a|');
  const mv = fakeView(makeState(doc, cursor));
  cmds.commands.indentList(mv, { flash });
  assert.ok(msg);
});

// ———————————— 反馈 7：列表后回到左侧顶格 ————————————
test('列表末项回车两次退出列表，接着写的字在编辑态按普通段落顶格显示', () => {
  const v = press('- 第一项|', 'Enter');
  assert.equal(show(v), '- 第一项\n- |');
  keys.mdKeymap({}).find((x) => x.key === 'Enter').run(v);
  assert.equal(show(v), '- 第一项\n|');
  typeText(v, '另：正文');
  const L1 = lineInfo(lpState(v.state.doc.toString(), 0));
  assert.ok(!L1(2).cls.includes('mde-li') && !L1(2).cls.includes('mde-li-cont'), '懒续行不悬挂对齐');
  assert.ok(L1(1).cls.includes('mde-li'));
});

test('LP：缩进够到正文列的续行仍按列表续行对齐', () => {
  const L1 = lineInfo(lpState('- 第一项\n  续行', 0));
  assert.ok(L1(2).cls.includes('mde-li-cont'));
  // 嵌套：缩进只够外层正文列的懒续行，归外层那一项
  const L2 = lineInfo(lpState('- a\n  - b\n  c', 0));
  assert.ok(L2(3).cls.includes('mde-li-cont'));
});

test('Backspace：顶级空项整段删标记回行首；有字的项、嵌套空项不走这条', () => {
  assert.equal(show(press('- a\n- |', 'Backspace')), '- a\n|');
  assert.equal(show(press('- a\n- [ ] |', 'Backspace')), '- a\n|');
  assert.equal(show(press('> - a\n> - |', 'Backspace')), '> - a\n> |');
  assert.notEqual(show(press('- a\n  - |', 'Backspace')), '- a\n|');
});

// ———————————— 反馈 6：Tab 从属缩进 ————————————
test('Tab：第二项成为上一项的子项；Shift+Tab 退回', () => {
  const v = press('- a\n- b|', 'Tab');
  assert.equal(v.state.doc.toString(), '- a\n  - b');
  keys.mdKeymap({}).find((x) => x.key === 'Tab').shift(v);
  assert.equal(v.state.doc.toString(), '- a\n- b');
});

test('Tab：懒续行挂到它所属的那一项下面，不再把整个上一项搬成子项', () => {
  assert.equal(press('- a\n- b\nc|', 'Tab').state.doc.toString(), '- a\n- b\n  c');
});

test('Tab：已对齐的段落续行再进一级；Shift+Tab 先退回正文列、再退成顶格', () => {
  const v = press('- a\n  续行|', 'Tab');
  assert.equal(v.state.doc.toString(), '- a\n    续行');
  const tab = keys.mdKeymap({}).find((x) => x.key === 'Tab');
  tab.shift(v);
  assert.equal(v.state.doc.toString(), '- a\n  续行');
  tab.shift(v);
  assert.equal(v.state.doc.toString(), '- a\n续行');
});

test('Tab：列表后空一行写的段落，挂到上面那一项下（成为它的第二段）；连选的整段一起挪', () => {
  assert.equal(press('- a\n\nb|', 'Tab').state.doc.toString(), '- a\n\n  b');
  assert.equal(press('- a\n  - b\n\nc|', 'Tab').state.doc.toString(), '- a\n  - b\n\n    c');
  const { doc } = at('- a\n\nb\nc|');
  const v = fakeView(makeState(doc).update({ selection: { anchor: doc.indexOf('b'), head: doc.length } }).state);
  keys.mdKeymap({}).find((x) => x.key === 'Tab').run(v);
  assert.equal(v.state.doc.toString(), '- a\n\n  b\n  c');
});

test('Tab：首项挂不上去给提示；普通段落（上面没有列表）吞掉 Tab 不改字', () => {
  let msg = '';
  const v = press('- a|', 'Tab', { flash: (m) => { msg = m; } });
  assert.equal(v.state.doc.toString(), '- a');
  assert.ok(msg);
  assert.equal(press('普通段落|', 'Tab').state.doc.toString(), '普通段落');
});

// ———————————— 反馈 4：嵌入图 ————————————
test('LP：![[图]] 地址还在解析（resolveUrl 给 \'\'）→ 占位，不是裂图；解析得出 → 真地址 + 备选', () => {
  const pend = lineInfo(lpState('![[a.png|305]]\n正文', undefined, { resolveUrl: () => '' }))(1).widgets.find((w) => w.constructor.name === 'ImageWidget');
  assert.equal(pend.src, '');
  assert.equal(pend.w, 305);
  const ok = lineInfo(lpState('![[a.png]]\n正文', undefined, {
    resolveUrl: (n, wiki) => (wiki ? 'bridge-workspace://local/primary/' + encodeURIComponent(n) : null),
    resolveAlts: (n) => ['/alt/' + n],
  }))(1).widgets.find((w) => w.constructor.name === 'ImageWidget');
  assert.equal(ok.src, 'bridge-workspace://local/primary/a.png');
  assert.deepEqual(ok.alts, ['/alt/a.png']);
});

test('LP：lpRefresh 让嵌入地址按最新解析重建', () => {
  let url = '';
  let st = lpState('![[a.png]]\n正文', undefined, { resolveUrl: () => url });
  const img = (s) => lineInfo(s)(1).widgets.find((w) => w.constructor.name === 'ImageWidget');
  assert.equal(img(st).src, '');
  url = '/api/file?path=a.png';
  st = st.update({ effects: LP.lpRefresh.of(null) }).state;
  assert.equal(img(st).src, '/api/file?path=a.png');
});

test('LP：callout 卡里的 ![[图]] 解析结果变了，重建出的卡与旧卡不相等（CM 会重绘，图不再卡在占位）', () => {
  let url = '';
  const doc = '> [!note]\n> ![[a.png]]\n\n正文';
  let st = lpState(doc, doc.length, { resolveUrl: (n, wiki) => (wiki ? url : null), renderMd: () => '' });
  const card = (s) => lineInfo(s)(1).widgets.find((w) => w.constructor.name === 'CalloutWidget');
  const before = card(st);
  assert.ok(before);
  st = st.update({ effects: LP.lpRefresh.of(null) }).state;
  assert.ok(card(st).eq(before), '解析结果没变：判等，不重绘');
  url = '/api/file?path=a.png';
  st = st.update({ effects: LP.lpRefresh.of(null) }).state;
  assert.ok(!card(st).eq(before), '索引到货：不相等');
});

// ———————————— 阅读态插图：块后换行只跟成功的链接一起写 ————————————
function attachView(doc, saveAttachment, flash = () => {}) {
  return fakeView(makeState(doc, 0, [attach.attachments({ saveAttachment, flash })]));
}
const settle = () => new Promise((r) => setTimeout(r, 0));
test('插图：存附件失败时文档一个字不动（不留空行）；成功时换行与链接同一笔写入', async () => {
  const doc = '| a |\n| - |\n| 1 |';
  let msg = '';
  const bad = attachView(doc, async () => { throw new Error('这个位置暂不支持插入附件'); }, (m) => { msg = m; });
  assert.ok(attach.insertFilesAt(bad, [new File(['x'], 'p.png', { type: 'image/png' })], doc.length, false, '\n\n'));
  await settle();
  assert.equal(bad.state.doc.toString(), doc);
  assert.match(msg, /这个位置暂不支持插入附件/);
  const ok = attachView(doc, async (_f, name) => ({ link: name }));
  attach.insertFilesAt(ok, [new File(['x'], 'p.png', { type: 'image/png' }), new File(['y'], 'q.pdf')], doc.length, false, '\n\n');
  await settle(); await settle();
  assert.equal(ok.state.doc.toString(), doc + '\n\n![[p.png]]\n![[q.pdf]]');
});

// ———————————— 词数统计（单趟扫描与旧正则写法同口径）————————————
test('noteStats：与旧的正则写法结果一致', () => {
  const old = (s) => ({
    words: (s.match(/[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g) || []).length + (s.match(/[A-Za-z0-9_$'-]+/g) || []).length,
    chars: s.replace(/\s/g, '').length,
  });
  const pool = ['中', '文', 'a', 'Z', '9', '_', '$', "'", '-', ' ', '\n', '\t', '　', ' ', '，', '。', 'é', 'ア', '한', '😀', '#', '[', ' ', '﻿'];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 300; k++) {
    let s = '';
    for (let i = 0, n = Math.floor(rnd() * 60); i < n; i++) s += pool[Math.floor(rnd() * pool.length)];
    assert.deepEqual(obsmd.noteStats(s), old(s), JSON.stringify(s));
  }
});
