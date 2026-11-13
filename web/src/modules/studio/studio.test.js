import test from 'node:test';
import assert from 'node:assert/strict';
import { catKind, pageOf, splitKey, joinKey, fileKind, uploadRel } from './kinds.js';
import { resolveValues, payloadParams, visibleSpec, optionsOf, roleState, jsonError, basicSpecs, advancedSpecs, promptLangs, textFitsLangs } from './params.js';
import { layoutLineage, chainOf } from './lineage.js';

test('种类三套叫法互转', () => {
  assert.equal(catKind('voice'), 'speech');
  assert.equal(catKind('image'), 'image');
  for (const k of ['speech', 'audio', 'voice', 'tts']) assert.equal(pageOf(k), 'voice');
  assert.equal(pageOf('music'), 'music');
  assert.equal(pageOf('chat'), null);
});

test('模型键只按第一个斜杠切（模型 id 自己可以带斜杠）', () => {
  assert.deepEqual(splitKey('or/openai/gpt-image-2.5'), { provider: 'or', model: 'openai/gpt-image-2.5' });
  assert.deepEqual(splitKey('veo-3.1'), { provider: '', model: 'veo-3.1' });
  assert.equal(joinKey('vx', 'imagen-4'), 'vx/imagen-4');
  assert.equal(fileKind('a/b/封面.PNG'), 'image');
  assert.equal(fileKind('台词.md'), 'text');
  assert.equal(fileKind('x.zip'), null);
});

const SPECS = [
  { key: 'aspect', type: 'enum', group: 'basic', default: '1:1', options: [{ value: '1:1' }, { value: '16:9' }, { value: '4:1', only: ['nb-2'] }] },
  { key: 'size', type: 'enum', group: 'basic', default: '2K', options: [{ value: '1K' }, { value: '2K' }, { value: '4K', only: { aspect: ['1:1', '16:9'] } }] },
  { key: 'person', type: 'enum', group: 'advanced', options: [{ value: 'allow' }, { value: 'deny' }], when: { size: '1K' } },
  { key: 'temp', type: 'number', group: 'advanced', min: 0, max: 2, step: 0.05, default: 1 },
  { key: 'audio', type: 'bool', group: 'basic' },
  { key: 'seed', type: 'seed', group: 'advanced' },
  { key: 'extra', type: 'json', group: 'advanced' },
  { key: 'neg', type: 'text', group: 'advanced' },
];

test('取值：非法值回默认，only 按模型 id 与按其它参数两种写法都认', () => {
  const v = resolveValues(SPECS, { aspect: '4:1', size: '4K', temp: 9, audio: 'yes' }, 'imagen-4');
  assert.equal(v.aspect, '1:1');          // 4:1 只对 nb-2
  assert.equal(v.size, '4K');             // aspect=1:1 时 4K 成立
  assert.equal(v.temp, 1);                // 越界回默认
  assert.equal(v.audio, false);           // 类型不对回默认
  assert.equal(v.seed, -1);
  const nb = resolveValues(SPECS, { aspect: '4:1', size: '4K' }, 'nb-2');
  assert.equal(nb.aspect, '4:1');
  assert.equal(nb.size, '2K');            // aspect=4:1 时 4K 不成立 → 默认 2K
  assert.deepEqual(optionsOf(SPECS[1], 'nb-2', nb).map((o) => o.value), ['1K', '2K']);
});

test('when 不满足的不显示也不发；json 解析、空文本不发', () => {
  const v = resolveValues(SPECS, { size: '2K', extra: '{"style":"raw"}', neg: '  ' }, 'x');
  assert.equal(visibleSpec(SPECS[2], v), false);
  const p = payloadParams(SPECS, v);
  assert.equal('person' in p, false);
  assert.deepEqual(p.extra, { style: 'raw' });
  assert.equal('neg' in p, false);
  const p2 = payloadParams(SPECS, { ...v, size: '1K', extra: '{bad' });
  assert.equal(p2.person, 'allow');
  assert.equal('extra' in p2, false);
  assert.equal(jsonError('{bad'), 'syntax');
  assert.equal(jsonError('[1]'), 'object');
  assert.equal(jsonError('{"a":1}'), '');
  assert.deepEqual(basicSpecs(SPECS, v).map((s) => s.key), ['aspect', 'size', 'audio']);
  assert.deepEqual(advancedSpecs(SPECS, v).map((s) => s.key), ['temp', 'seed', 'extra', 'neg']);
});

test('素材角色：模型不收 / 已满 / 首尾帧与参考图互斥 / 单槽替换', () => {
  const veo = { inputs: { text: true, images: { max: 3, roles: ['first', 'last', 'ref'] } } };
  assert.equal(roleState(veo, 'first', []).ok, true);
  assert.equal(roleState(veo, 'ref', [{ role: 'first' }]).reason, 'frameMix');
  assert.equal(roleState(veo, 'last', [{ role: 'ref' }]).reason, 'refMix');
  assert.equal(roleState(veo, 'first', [{ role: 'first' }]).replace, true);
  assert.equal(roleState(veo, 'ref', [{ role: 'ref' }, { role: 'ref' }, { role: 'ref' }]).reason, 'full');
  assert.equal(roleState(veo, 'audio', []).reason, 'model');
  const omni = { inputs: { images: { max: 1, roles: ['first'] } } };
  assert.equal(roleState(omni, 'last', []).reason, 'model');
  const nb = { inputs: { images: { max: 1, roles: ['edit', 'ref'] } } };
  assert.equal(roleState(nb, 'edit', []).ok, true);
  assert.equal(roleState(nb, 'ref', [{ role: 'ref' }]).reason, 'full');
  const tts = { inputs: { text: true } };
  assert.equal(roleState(tts, 'first', []).reason, 'model');
});

test('血缘泳道：直线链、分叉、并入、上游不在列表里画 stub', () => {
  // 新 → 旧：v 视频由 a 图派生，a 由 b 续改；m 音乐独立；c 有个不在列表里的父
  const rows = [
    { id: 'v', parents: ['a'] },
    { header: true },
    { id: 'm' },
    { id: 'a', parents: ['b'] },
    { id: 'c', parents: ['gone'] },
    { id: 'b' },
  ];
  const L = layoutLineage(rows);
  assert.equal(L[0].lane, 0);
  assert.deepEqual(L[0].out.map((e) => e.to), ['a']);
  assert.deepEqual(L[1].pass.map((e) => e.lane), [0]);     // 分组标题行线穿过
  assert.equal(L[2].lane, 1);                                // m 不占 a 的道
  assert.deepEqual(L[2].pass.map((e) => e.to), ['a']);
  assert.equal(L[3].lane, 0);
  assert.deepEqual(L[3].into.map((e) => e.from), ['v']);
  assert.equal(L[4].stub, true);
  assert.equal(L[5].lane, 0);
  assert.deepEqual(L[5].into.map((e) => e.from), ['a']);
  assert.deepEqual([...chainOf(rows, 'a')].sort(), ['a', 'b', 'v']);
});

test('血缘泳道：两个孩子并到同一个父，最多三道', () => {
  const rows = [{ id: 'x1', parents: ['p'] }, { id: 'x2', parents: ['p'] }, { id: 'x3', parents: ['q'] }, { id: 'x4', parents: ['r'] }, { id: 'p' }, { id: 'q' }, { id: 'r' }];
  const L = layoutLineage(rows);
  assert.equal(L[0].lane, 0);
  assert.equal(L[1].lane, 1);
  assert.equal(L[3].lane, 2);                                // 第四道并进第三道
  assert.equal(L[4].lane, 0);
  assert.deepEqual(L[4].into.map((e) => e.from).sort(), ['x1', 'x2']);
});

test('提示词语言：只认英文的模型拦下中文，汉字认 zh 或 ja 任一', () => {
  assert.equal(promptLangs({ inputs: {} }), null);
  assert.deepEqual(promptLangs({ inputs: { promptLang: 'EN' } }), ['en']);
  assert.deepEqual(promptLangs({ inputs: { promptLang: ['en', 'ja'] } }), ['en', 'ja']);
  assert.equal(textFitsLangs('ambient synth, rain', ['en']), true);
  assert.equal(textFitsLangs('温暖的钢琴', ['en']), false);
  assert.equal(textFitsLangs('piano 钢琴', ['en']), false);
  assert.equal(textFitsLangs('漢字とかな', ['en', 'ja']), true);
  assert.equal(textFitsLangs('한국어', ['en', 'ja']), false);
  assert.equal(textFitsLangs('任何文字', null), true);
});

test('本机上传素材只发 uploads 相对名（服务器回的绝对路径取最后一段）', () => {
  assert.equal(uploadRel('C:\\Users\\you\\claude-bridge\\uploads\\1793891304685-手机 照片.jpg'), '1793891304685-手机 照片.jpg');
  assert.equal(uploadRel('C:/Users/you/claude-bridge/uploads/17-a.png'), '17-a.png');
  assert.equal(uploadRel('/srv/bridge/.bridge/uploads/17-a.png'), '17-a.png');
  assert.equal(uploadRel('E:\\bridge-users\\bob\\.bridge\\uploads\\17-b.webp'), '17-b.webp');
  assert.equal(uploadRel('17-a.png'), '17-a.png');
  assert.equal(uploadRel('dir\\17-a.png'), 'dir/17-a.png');
  assert.equal(uploadRel(''), '');
  assert.equal(uploadRel(null), '');
});
