// 流式写头修补（mdStream.js）：逐形态断言 + 逐字前缀扫描（可见文字必须单调增长）。
// 跑法：node --test web/src/lib/mdStream.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { repairTail, repairInline, splitCells } from './mdStream.js';

marked.setOptions({ gfm: true, breaks: true });
// 流式末块渲染（md.js renderStreamingMarkdown）会去掉代码块末尾 marked 自带的隐形换行，这里同治
const html = (s) => marked.parse(s, { async: false }).replace(/\n<\/code><\/pre>/g, '</code></pre>');

// 近似吐字引擎眼里的「可见文字」：标签之间的文本段，去掉纯空白段，解实体。
function visible(h) {
  const out = [];
  for (const seg of h.split(/<[^>]*>/)) {
    if (!/\S/.test(seg)) continue;
    out.push(seg.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
  }
  return out.join('');
}
const tags = (h) => (h.match(/<(\w+)/g) || []).map((x) => x.slice(1));

test('表格：表头 + 首行到齐才出表；之后数据行整行到齐才放', () => {
  assert.equal(repairTail('前文\n| 名称 | 数'), '前文\n');                       // 表头还在打
  assert.equal(repairTail('前文\n| 名称 | 数量 |\n|---|:-'), '前文\n');       // 分隔行在打
  assert.equal(repairTail('前文\n| 名称 | 数量 |\n|---|---|\n'), '前文\n');  // 首行没来
  assert.equal(repairTail('前文\n| a | b |\n|---|---|\n| 1 | 2'), '前文\n'); // 首行没到齐
  const one = '| a | b |\n|---|---|\n| 1 | 2 |';
  assert.equal(repairTail(one), one);                                        // 首行到齐（只差换行）
  assert.ok(html(repairTail(one)).includes('<td>2</td>'));
  const src = one + '\n| 3 | 4';
  assert.equal(repairTail(src), one + '\n');
  assert.equal(repairTail(src + ' |'), src + ' |');
  assert.equal(repairTail(one + '\n'), one + '\n');
});

test('setext / 分隔线 / 列表标记 / 标题井号：整行先扣住', () => {
  assert.ok(!html(repairTail('Hello\n-')).includes('<h2>'));
  assert.equal(repairTail('Hello\n---'), 'Hello\n');
  assert.equal(repairTail('段落\n- '), '段落\n');
  assert.equal(repairTail('段落\n12'), '段落\n');
  assert.equal(repairTail('段落\n##'), '段落\n');
  assert.equal(repairTail('- [ ]'), '');
  assert.equal(repairTail('- **'), '');
});

test('代码块：围栏开头没换行先扣住，进行中补闭合，半截闭合围栏不闪', () => {
  assert.equal(repairTail('说明\n```py'), '说明\n');
  assert.equal(repairTail('```js\nconst a = 1'), '```js\nconst a = 1\n```');
  assert.equal(repairTail('```js\nconst a = 1\n``'), '```js\nconst a = 1\n```');
  assert.equal(repairTail('```js\nx\n```'), '```js\nx\n```');
  assert.ok(html(repairTail('~~~\nfoo')).includes('<pre>'));
});

test('行内：未闭合强调 / 代码补齐，只有开头的扣住', () => {
  assert.equal(repairInline('这是**重点'), '这是**重点**');
  assert.equal(repairInline('这是**'), '这是');
  assert.equal(repairInline('运行 `npm i'), '运行 `npm i`');
  assert.equal(repairInline('运行 `'), '运行');
  assert.equal(repairInline('**粗 *斜'), '**粗 *斜***');
  assert.equal(repairInline('删除~~旧的'), '删除~~旧的~~');
  assert.equal(repairInline('区间 90~95'), '区间 90~95');
  assert.equal(repairInline('2 * 3'), '2 * 3');
  assert.equal(repairInline('snake_case_na'), 'snake_case_na');
  assert.equal(repairInline('**粗体 '), '**粗体**');
});

test('行内：链接与图片', () => {
  assert.equal(repairInline('见 [文档](https://exa'), '见 <a>文档</a>');
  assert.equal(repairInline('见 [文档'), '见');
  assert.equal(repairInline('见 [文档]'), '见');
  assert.equal(repairInline('图 ![示意](a.p'), '图');
  assert.equal(repairInline('见 [文档](a.md) 和'), '见 [文档](a.md) 和');
});

test('数学块没闭合整块扣住；行内 HTML / 实体 / 反斜杠', () => {
  assert.equal(repairTail('公式：\n$$\nE=mc'), '公式：\n');
  assert.equal(repairInline('展开 <deta'), '展开');
  assert.equal(repairInline('R&'), 'R');
  assert.equal(repairInline('路径 C:\\'), '路径 C:');
});

test('splitCells：转义竖线不切', () => {
  assert.deepEqual(splitCells('| a | b\\|c |'), [' a ', ' b\\|c ']);
});

const SAMPLE = `## 结论

先说**结论**：方案 B 更稳，理由见下表。用 \`npm run build\` 出包，详情看 [构建说明](docs/build.md)。

| 方案 | 首字延迟 | 备注 |
|---|:---:|---|
| A | 1.7s | 走 **常驻** CLI |
| B | 0.9s | 预热 + \`warmTake\` |

1. 第一步：装依赖
2. 第二步：跑测试
   - 子项 *斜体* 说明
- [ ] 待办一
- [x] 已完成

> 引用里也有 **粗体** 和 ~~删除线~~。

\`\`\`js
const x = 1;
console.log(x * 2);
\`\`\`

---

最后一段，English words and 中文混排，区间 90~95%，结束。`;

// 逐字喂进去：每一步的可见文字都应是下一步的前缀（吐字引擎按可见字序号显形，前缀稳定 = 不回跳）。
function sweep(fix) {
  let prev = '', bad = [];
  for (let i = 1; i <= SAMPLE.length; i++) {
    const v = visible(html(fix(SAMPLE.slice(0, i))));
    if (!v.startsWith(prev)) bad.push({ i, at: JSON.stringify(SAMPLE.slice(Math.max(0, i - 12), i)), prev: prev.slice(-12), now: v.slice(-12) });
    prev = v;
  }
  return bad;
}

test('逐字前缀扫描：修补后可见文字单调增长（对照：不修补会大量回跳）', () => {
  const raw = sweep((s) => s);
  const fixed = sweep(repairTail);
  assert.ok(raw.length > 20, '对照组应该有大量回跳，否则样张没覆盖到');
  assert.deepEqual(fixed, [], '修补后不应有回跳：' + JSON.stringify(fixed.slice(0, 5)));
  // 结构也不该闪：修补后任何时刻都不出现 h2 以外的标题、也不出现「先成段落后成表」
  for (let i = 1; i <= SAMPLE.length; i++) {
    const t = tags(html(repairTail(SAMPLE.slice(0, i))));
    assert.ok(!t.includes('h1') && !t.includes('h3'), '不应闪出别级标题 @' + i);
  }
});
