// v3（方案 §9.2 / §9.3）：参数渲染器（render.js）与模型选择器（picker.js）的纯逻辑。
// 选择器那几条用后端会话真跑出来的目录样例（web/scripts/studio-qa/catalog-v3.sample.json，来自 modules/studio/server/discovery/）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatOf, controlOf, aspectSplit, paramGroups, fmtNumber, chipValue, searchOptions, needsSearch, cleanLabel, humanValue, hitParts } from './render.js';
import { pickerGroups, modelCount, paramSource, isFresh, vendorName, splitGroup, shelfHits } from './picker.js';

const lab = (o) => String(o.label ?? o.value);

test('渲染提示只看 format；没写 format 时只认「选项几乎全是比值」= 比例', () => {
  assert.equal(formatOf({ key: 'duration', format: 'duration' }), 'duration');
  assert.equal(formatOf({ key: 'duration', type: 'enum', options: [{ value: '4' }, { value: '8' }] }), '');   // 不按键名猜
  assert.equal(formatOf({ key: 'x', type: 'enum', options: [{ value: 'auto' }, { value: '16:9' }, { value: '9:16' }] }), 'aspect');
  assert.equal(formatOf({ key: 'x', type: 'enum', options: [{ value: '1:1' }] }), '');   // 一个比值不算
});

test('控件挑选：短枚举分段、长 / 多选项菜单、比例格、小范围整数分段、滑条、多行文本', () => {
  assert.equal(controlOf({ type: 'enum' }, [{ value: 'low' }, { value: 'high' }], { labelOf: lab, room: 130 }), 'seg');
  assert.equal(controlOf({ type: 'enum' }, [{ value: 'a very long option label' }, { value: 'b' }], { labelOf: lab, room: 130 }), 'select');
  assert.equal(controlOf({ type: 'enum' }, Array.from({ length: 5 }, (_, i) => ({ value: 'v' + i })), { labelOf: lab }), 'select');
  assert.equal(controlOf({ type: 'enum', format: 'aspect' }, [{ value: 'auto' }, { value: '16:9' }], { labelOf: lab }), 'aspect');
  assert.equal(controlOf({ type: 'number', min: 1, max: 4, step: 1 }), 'steps');
  assert.equal(controlOf({ type: 'number', min: 4, max: 8, step: 1, format: 'duration' }), 'slider');   // 时长不做分段
  assert.equal(controlOf({ type: 'number', min: 0, max: 2, step: 0.05 }), 'slider');
  assert.equal(controlOf({ type: 'number' }), 'number');
  assert.equal(controlOf({ type: 'text', multiline: true }), 'textarea');
  assert.equal(controlOf({ type: 'text' }), 'text');
  assert.equal(controlOf({ type: 'json' }), 'json');
});

test('比例格：命名项在前、常用的在前；有「更多比例」时前面摆 7 个（加它正好两排四格）；选中值在后面时自动展开', () => {
  const opts = ['auto', '21:9', '16:9', '1:1', '1:8', '9:16', '4:3', '3:4', '3:2', '2:3', '8:1'].map((v) => ({ value: v }));
  const a = aspectSplit(opts, '1:1');
  assert.deepEqual(a.head.map((o) => o.value), ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2']);
  assert.deepEqual(a.more.map((o) => o.value).sort(), ['1:8', '21:9', '2:3', '8:1'].sort());
  assert.equal(aspectSplit(opts.slice(0, 8), '1:1').more.length, 0);   // 放得下就不收
  assert.equal(a.open, false);
  assert.equal(aspectSplit(opts, '8:1').open, true);
});

test('分组：basic 按语义排（比例在前）、advanced 按控件种类排、json 收到「更多」最末；when 不满足不出', () => {
  const g = paramGroups([
    { key: 'duration', type: 'enum', group: 'basic', format: 'duration' }, { key: 'aspect_ratio', type: 'enum', group: 'basic', format: 'aspect' }, { key: 'x', type: 'json', group: 'basic' },
    { key: 's', type: 'number', group: 'advanced', min: 0, max: 1 }, { key: 'b', type: 'bool', group: 'advanced' }, { key: 'e', type: 'enum', group: 'advanced' },
    { key: 'c', type: 'number', group: 'advanced', when: { b: true } },
  ], { b: false });
  assert.deepEqual(g.map((x) => [x.id, x.specs.map((s) => s.key)]), [['basic', ['aspect_ratio', 'duration']], ['advanced', ['s', 'b', 'e', 'x']]]);
});

test('翻译层：括号说明从参数名里去掉；接口原值整理成人话（常见词、音频格式、连字符）', () => {
  assert.equal(cleanLabel('Safety tolerance (lower is stricter, higher is more permissive)'), 'Safety tolerance');
  assert.equal(cleanLabel('采样步数'), '采样步数');
  const W = { '': '默认', high: '高', auto: '自动' };
  assert.equal(humanValue({ value: 'high' }, W), '高');
  assert.equal(humanValue({ value: 'auto', label: 'auto' }, W), '自动');
  assert.equal(humanValue({ value: 'mp3_44100_128' }), 'MP3 · 44.1kHz · 128k');
  assert.equal(humanValue({ value: 'pcm_16000' }), 'PCM · 16kHz');
  assert.equal(humanValue({ value: 'analog-film' }), 'Analog film');
  assert.equal(humanValue({ value: '1080p' }), '1080p');
  assert.equal(humanValue({ value: '' }, W), '默认');
  assert.equal(humanValue({ value: 'reference', label: '参考' }), '参考');   // 后端给了不同的 label 就用它
});

test('数值显示带单位与小数位；值芯片只出值（默认项、关着的开关、种子不占芯片）', () => {
  assert.equal(fmtNumber({ step: 0.05 }, 1), '1.00');
  assert.equal(fmtNumber({ step: 1, unit: 's' }, 8), '8 s');
  assert.equal(fmtNumber({ step: 1, unit: '%' }, 90), '90%');
  assert.equal(chipValue({ type: 'enum', options: [{ value: '16:9', label: '16:9' }] }, '16:9'), '16:9');
  assert.equal(chipValue({ type: 'enum', options: [{ value: '', label: '默认' }] }, ''), null);
  assert.equal(chipValue({ type: 'bool' }, false), null);
  assert.equal(chipValue({ type: 'bool' }, true), '');
  assert.equal(chipValue({ type: 'seed' }, 42), null);
  assert.equal(chipValue({ type: 'number', format: 'count', min: 1, max: 4, step: 1 }, 2), '×2');
});

test('长枚举：超过 12 项要搜索；搜索认标签 / 值 / hint、不计较大小写与空格', () => {
  const opts = Array.from({ length: 40 }, (_, i) => ({ value: 'style-' + i, label: 'Style ' + i, hint: i === 7 ? '$0.04' : undefined }));
  assert.equal(needsSearch(opts), true);
  assert.equal(needsSearch(opts.slice(0, 12)), false);
  assert.deepEqual(searchOptions(opts, 'style 3').map((o) => o.value), ['style-3', 'style-30', 'style-31', 'style-32', 'style-33', 'style-34', 'style-35', 'style-36', 'style-37', 'style-38', 'style-39']);
  assert.deepEqual(searchOptions(opts, '0.04').map((o) => o.value), ['style-7']);
});

const SAMPLE = JSON.parse(readFileSync(new URL('../../../scripts/studio-qa/catalog-v3.sample.json', import.meta.url), 'utf8'));

test('选择器：主列表不含备选；聚合服务按厂商分小组；搜到的备选单独一组；选中的备选留在主列表', () => {
  const groups = SAMPLE.kinds.image.groups;
  const or = groups.find((g) => g.provider.dialect === 'openrouter');
  const { main, shelf } = splitGroup(or);
  assert.ok(shelf.length > 10 && main.length >= 1);
  const orOut = pickerGroups(groups).find((g) => g.provider.dialect === 'openrouter');
  assert.equal(orOut.count, main.length);
  assert.ok(orOut.sections.every((s) => s.models.every((m) => !m.shelf)));
  const hit = shelf[0];
  // 搜到的备选单独一组，不混进主列表
  assert.ok(!pickerGroups(groups, { q: hit.label }).flatMap((g) => g.sections.flatMap((s) => s.models)).some((m) => m.key === hit.key));
  assert.ok(shelfHits(groups, hit.label).some((x) => x.model.key === hit.key));
  assert.deepEqual(shelfHits(groups, ''), []);
  assert.ok(pickerGroups(groups, { current: hit.key }).flatMap((g) => g.sections.flatMap((s) => s.models)).some((m) => m.key === hit.key));
  assert.ok(modelCount(groups) > 8);
});

test('参数来源行与新模型朱点（本机选过就不再冒）', () => {
  const vids = SAMPLE.kinds.video.groups.flatMap((g) => g.models);
  const omni = vids.find((m) => /omni-1\.2/.test(m.id));
  assert.deepEqual(paramSource(omni), { kind: 'family', from: omni.inheritsFrom });
  assert.equal(paramSource(vids.find((m) => m.paramSource === 'schema')).kind, 'schema');
  assert.equal(paramSource(vids.find((m) => m.paramSource === 'generic')).kind, 'generic');
  assert.equal(paramSource({ paramSource: 'card' }), null);
  assert.equal(isFresh(omni, new Set()), !!omni.isNew);
  assert.equal(isFresh(omni, new Set([omni.key])), false);
  assert.equal(vendorName('black-forest-labs'), 'Black Forest Labs');
  assert.equal(vendorName('some-new-lab'), 'Some New Lab');
});

test('样例里每个参数都挑得出控件（任意 schema 都渲染得了）', () => {
  const all = Object.values(SAMPLE.kinds).flatMap((k) => k.groups.flatMap((g) => g.models)).concat(SAMPLE._resolve?.model || []);
  let n = 0;
  for (const m of all) for (const p of m.params || []) {
    const c = controlOf(p, p.options || [], { labelOf: lab, room: 128 });
    assert.ok(['seg', 'aspect', 'select', 'steps', 'slider', 'number', 'switch', 'seed', 'voice', 'text', 'textarea', 'json'].includes(c), m.id + ' ' + p.key);
    n++;
  }
  assert.ok(n > 50);
});

test('hitParts：只在名字里命中才切段，大小写不敏感', () => {
  assert.deepEqual(hitParts('Aria (warm)', 'ar'), ['', 'Ar', 'ia (warm)']);
  assert.deepEqual(hitParts('MP3 · 44.1kHz', 'khz'), ['MP3 · 44.1', 'kHz', '']);
  assert.equal(hitParts('Aria', 'zz'), null);
  assert.equal(hitParts('Aria', ''), null);
});
