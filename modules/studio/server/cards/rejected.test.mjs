// 上游拒收过的取值（方案 §11.4）：识别、标记、报错头一行。纯函数，不连网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRejected, markRejected, rejectedLine } from './rejected.mjs';

const card = { params: [
  { key: 'quality', label: '画质', type: 'enum', default: 'auto', options: [{ value: 'auto', label: '自动' }, { value: 'low', label: '低' }, { value: 'max', label: '最高' }] },
  { key: 'outputFormat', label: '格式', type: 'enum', default: 'png', options: [{ value: 'png', label: 'PNG' }, { value: 'svg', label: 'SVG' }, { value: 'gif', label: 'GIF' }] },
  { key: 'moderation', label: '审核', type: 'enum', default: 'auto', options: [{ value: 'auto', label: '自动' }, { value: 'low', label: '宽松' }] },
  { key: 'count', label: '张数', type: 'number', min: 1, max: 10, default: 1 },
] };
const err = (message, status = 400, detail = '') => Object.assign(new Error(message), { status, detail });

test('上游带引号点了取值：记到那个参数上', () => {
  const r = detectRejected(card, { quality: 'auto', outputFormat: 'svg', count: 1 }, err("某中转 400：Invalid value: 'svg'. Supported values are: 'png', 'jpeg', and 'webp'."));
  assert.deepEqual(r, { key: 'outputFormat', value: 'svg', label: '格式', optionLabel: 'SVG' });
  assert.equal(rejectedLine(r), '这个服务不收「格式：SVG」');
});

test('只点了字段名（output_format）也认；状态码写在报错文字里也认', () => {
  assert.equal(detectRejected(card, { outputFormat: 'gif' }, err('Unsupported parameter: output_format is not supported with this model.'))?.key, 'outputFormat');
  assert.equal(detectRejected(card, { outputFormat: 'gif' }, Object.assign(new Error('上游返回 422：unknown field "gif"'), {}))?.value, 'gif');
});

test('点不到名、默认值、数值参数、鉴权 / 额度 / 审核 / 超时：都不记', () => {
  assert.equal(detectRejected(card, { outputFormat: 'svg' }, err('Bad request')), null, '没点名');
  assert.equal(detectRejected(card, { outputFormat: 'png' }, err("Invalid value: 'png'")), null, '默认值不算（那是整个请求的问题）');
  assert.equal(detectRejected(card, { outputFormat: 'svg' }, err("Invalid value: 'svg'", 401)), null);
  assert.equal(detectRejected(card, { outputFormat: 'svg' }, err("quota exceeded for 'svg'", 429)), null);
  assert.equal(detectRejected(card, { outputFormat: 'svg' }, err("upstream 'svg' timeout", 504)), null);
  assert.equal(detectRejected(card, { count: 9 }, err("Invalid value: '9' for n")), null);
});

test('同一个取值属于两个参数（都是 low）时不靠取值认，要看字段名', () => {
  const sent = { quality: 'low', moderation: 'low' };
  assert.equal(detectRejected(card, sent, err("Invalid value: 'low'")), null);
  assert.equal(detectRejected(card, sent, err("Unknown parameter: 'moderation'."))?.key, 'moderation');
});

test('目录：拒收过的选项标 rejected，别的不动', () => {
  const out = markRejected(card.params, { outputFormat: ['svg'] });
  assert.deepEqual(out[1].options.map((o) => [o.value, !!o.rejected]), [['png', false], ['svg', true], ['gif', false]]);
  assert.equal(out[0], card.params[0]);
  assert.equal(markRejected(card.params, null), card.params);
});
