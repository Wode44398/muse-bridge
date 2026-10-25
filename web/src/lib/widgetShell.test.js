// 内嵌图表渲染壳的纯函数部分：流式剥脚本、可见内容判定、srcdoc 整页（CSP / nonce / 壳脚本语法）、下载用的独立文件、段落落段。
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripScripts, visibleMarkup, isSvgCode, buildSrcdoc, standaloneFile, widgetCss, WIDGET_CSP, RAMPS, cleanCss, fileStem } from './widgetShell.js';
import { applyWidgetEvent } from './widgetSeg.js';
import { retractSegments } from './retract.js';

test('stripScripts：成对的、没写完的 <script> 都剥掉；<meta>/<base> 一并去掉', () => {
  assert.equal(stripScripts('<div>a</div><script>x()</script><p>b</p>'), '<div>a</div><p>b</p>');
  assert.equal(stripScripts('<div>a</div><script src="https://cdnjs.cloudflare.com/x.js"></script><script>let s = "</scr'), '<div>a</div>');
  assert.equal(stripScripts('<meta http-equiv="refresh" content="0;url=https://e.x"><base href="https://e.x/"><b>x</b>'), '<b>x</b>');
});

test('visibleMarkup：只有样式 / defs / 标题 / 读屏标题时不算可见', () => {
  assert.equal(visibleMarkup('<style>.a{color:red}</style>'), false);
  assert.equal(visibleMarkup('<svg viewBox="0 0 680 100"><title>t</title><desc>d</desc><defs><marker id="a"></marker></defs>'), false);
  assert.equal(visibleMarkup('<h2 class="sr-only">summary</h2><style>x{}</style>'), false);
  assert.equal(visibleMarkup('<svg viewBox="0 0 680 100"><rect x="1"'), true);
  assert.equal(visibleMarkup('<div style="padding:1rem 0">hi'), true);
  assert.equal(visibleMarkup('hello'), true);
});

test('isSvgCode：以 <svg 开头才是 SVG 模式', () => {
  assert.equal(isSvgCode('  <svg viewBox="0 0 1 1"></svg>'), true);
  assert.equal(isSvgCode('<div><svg></svg></div>'), false);
});

test('srcdoc：CSP 在最前、只放白名单 CDN；nonce 只留字母数字；壳脚本语法正确', () => {
  const doc = buildSrcdoc({ nonce: 'ab"c1<x', mode: 'light', vars: { '--surface-0': '#fff', 'bad key': 'x', '--font-sans': '"Anthropic Sans", system-ui' } });
  assert.match(doc, /^<!doctype html><html data-mode="light" style="--surface-0:#fff;--font-sans:&quot;Anthropic Sans&quot;, system-ui"><head><meta http-equiv="Content-Security-Policy"/);
  assert.doesNotMatch(doc, /bad key/);
  assert.match(WIDGET_CSP, /default-src 'none'/);
  assert.match(WIDGET_CSP, /form-action 'none'/);
  assert.match(WIDGET_CSP, /frame-src 'none'/);
  assert.doesNotMatch(WIDGET_CSP, /'self'/);
  const script = /<script>([\s\S]*)<\/script><\/body>/.exec(doc)[1];
  assert.match(script, /var N="abc1x",M=1800;/);
  assert.match(buildSrcdoc({ nonce: 'a', maxH: 600 }), /M=600;/, '高度上限进壳脚本（超了才开纵向滚动条）');
  assert.doesNotThrow(() => new Function(script), '壳脚本能被解析');
  assert.equal(doc.split('</script>').length - 1, 1, '壳里只有一个 </script>');
});

test('widgetCss：色带类明暗两套、作用域可换（shadow 根用 .wroot）', () => {
  const css = widgetCss({ root: '.wroot', dark: '.wroot[data-mode="dark"]', body: '.wroot' });
  assert.match(css, new RegExp(`\\.c-teal>rect[^{]*\\{fill:${RAMPS.teal[0]};stroke:${RAMPS.teal[4]}`));
  assert.match(css, /\.wroot\[data-mode="dark"\] \.c-teal>rect/);
  assert.match(css, /\.wroot \.t\{font-size:14px/);
  assert.doesNotMatch(css, /:root/);
});

test('standaloneFile：SVG 补 xmlns + 内联样式与箭头、剥脚本；HTML 包成整页', () => {
  const svg = standaloneFile('<svg viewBox="0 0 680 100" role="img"><rect class="box"/><script>x()</script></svg>', 'q3 revenue/by:region');
  assert.equal(svg.name, 'q3_revenue_by_region.svg');
  assert.match(svg.text, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 680 100" role="img" data-mode="light"><style>/);
  assert.match(svg.text, /<marker id="arrow"/);
  assert.doesNotMatch(svg.text, /<script>x/);
  const html = standaloneFile('<div>hi</div>', '');
  assert.equal(html.name, 'visual.html');
  assert.match(html.text, /<div id="vis"><div>hi<\/div><\/div>/);
});

test('widget 段：start → delta（接得上才追加）→ 定稿 → 报错', () => {
  const m = { segments: [{ kind: 'text', md: '先看图：' }] };
  applyWidgetEvent(m, { type: 'widget_start', id: 'w1' });
  assert.deepEqual(m.segments[1], { kind: 'widget', id: 'w1', title: '', loading: [], code: '', status: 'loading', error: '' });
  applyWidgetEvent(m, { type: 'widget_delta', id: 'w1', from: 0, add: '', title: 'flow', loading: ['画框', '连线'] });
  applyWidgetEvent(m, { type: 'widget_delta', id: 'w1', from: 0, add: '<svg>' });
  applyWidgetEvent(m, { type: 'widget_delta', id: 'w1', from: 9, add: 'gap' });   // 接不上：丢
  applyWidgetEvent(m, { type: 'widget_delta', id: 'w1', from: 5, add: '<rect/>' });
  assert.equal(m.segments[1].code, '<svg><rect/>');
  assert.equal(m.segments[1].status, 'streaming');
  assert.deepEqual(m.segments[1].loading, ['画框', '连线']);
  applyWidgetEvent(m, { type: 'widget', id: 'w1', title: 'flow', loading: ['画框'], code: '<svg><rect/></svg>' });
  assert.equal(m.segments[1].status, 'ready');
  assert.equal(m.segments[1].code, '<svg><rect/></svg>');
  applyWidgetEvent(m, { type: 'widget_delta', id: 'w1', from: 17, add: 'late' });   // 定稿后不再动
  assert.equal(m.segments[1].code, '<svg><rect/></svg>');
  applyWidgetEvent(m, { type: 'widget_done', id: 'w1', isError: true, error: 'too large' });
  assert.equal(m.segments[1].status, 'error');
  assert.equal(m.segments[1].error, 'too large');
  assert.equal(m.segments.length, 2);
});

test('widget 段：收尾帧不凭空建段；撤回区间按图表段序号整段删', () => {
  const m = { segments: [{ kind: 'text', md: 'a' }] };
  applyWidgetEvent(m, { type: 'widget_done', id: 'gone', isError: true, error: 'x' });
  assert.equal(m.segments.length, 1, '段已被撤 / 换掉时 widget_done 不长出空卡');
  for (const id of ['w0', 'w1', 'w2']) applyWidgetEvent(m, { type: 'widget_start', id });
  retractSegments(m, { textFrom: 0, textTo: 0, thinkFrom: 0, thinkTo: 0, toolsFrom: 0, toolsTo: 0, widgetsFrom: 1, widgetsTo: 2 });
  assert.deepEqual(m.segments.map((s) => s.id || s.kind), ['text', 'w0', 'w2']);
});

test('cleanCss（手机静态预览）：取图写法全作废、转义写法整条去掉、改不到宿主、fixed 改 absolute', () => {
  const css = cleanCss(".a{background:url(https://x/i.png)} .b{background-image:image-set('https://x/i.png' 1x)} .c{background:-webkit-image-set('https://x/j.png' 1x)} .d{background:u\\72l(https://x/k.png);color:red} @import 'https://x/s.css'; .e{mask:url(#m)} .f{background:url(data:image/png;base64,AAAA)}");
  assert.doesNotMatch(css, /https:\/\/x/);
  assert.match(css, /color:red/, '同一条规则里别的声明留着');
  assert.match(css, /url\(#m\)/, '文内引用留着');
  assert.match(css, /url\(data:image\/png/, 'data: 留着');
  assert.doesNotMatch(cleanCss(':host{position:fixed!important;inset:0} ::part(x){color:red} :host-context(body){}'), /:host|::part/);
  assert.equal(cleanCss('.x{position: fixed; inset:0}'), '.x{position:absolute; inset:0}');
  assert.equal(cleanCss('position:fixed;top:0'), 'position:absolute;top:0');
});

test('fileStem：下载文件名只留字母数字下划线连字符', () => {
  assert.equal(fileStem('q3 revenue/by:region'), 'q3_revenue_by_region');
  assert.equal(fileStem(''), 'visual');
  assert.equal(fileStem('!!!'), 'visual');
});
