// 媒体模型调用配置弹层的纯逻辑：草稿往返、按参数种类还原取值、毛病提示。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaDraft, mediaPayload, mediaProblem, baseParams } from './mediaAdv.js';

const CFG = {
  base: { params: [
    { key: 'outputFormat', label: '格式', type: 'enum', options: [{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }] },
    { key: 'duration', label: '时长', type: 'enum', options: [{ value: 5, label: '5' }, { value: 10, label: '10' }] },
    { key: 'count', label: '张数', type: 'number', min: 1, max: 4 },
    { key: 'hd', label: '高清', type: 'bool' },
    { key: 'extra', label: '额外参数', type: 'json' },
  ], hasExtra: true },
  effective: { params: [] },
  over: { options: { outputFormat: ['svg'] }, defaults: { duration: 10, hd: true }, extra: { moderation: 'low' } },
  recipe: null,
};

test('草稿往返：没改就和原来的提交体一样；json 参数不进可编辑列表', () => {
  const params = baseParams(CFG);
  assert.deepEqual(params.map((s) => s.key), ['outputFormat', 'duration', 'count', 'hd']);
  const d = mediaDraft(CFG);
  assert.deepEqual(d.options, { outputFormat: ['svg'] });
  assert.deepEqual(d.defaults, { duration: '10', hd: 'true' });
  assert.deepEqual(mediaPayload(d, params), { over: CFG.over, recipe: null });
});

test('按种类还原：选项是数字的补值也是数字，默认值对上原选项类型；全清空 = null', () => {
  const params = baseParams(CFG);
  const d = { options: { duration: ['15', ''] }, defaults: { duration: '15', count: '2', outputFormat: '' }, extra: '', recipeOn: false, recipe: '' };
  assert.deepEqual(mediaPayload(d, params), { over: { options: { duration: [15] }, defaults: { duration: 15, count: 2 } }, recipe: null });
  assert.deepEqual(mediaPayload({ options: {}, defaults: {}, extra: '  ', recipeOn: false, recipe: '{"x":1}' }, params), { over: null, recipe: null });
});

test('毛病：额外请求体 / 配方不是 JSON 对象、数字越界，各给人话', () => {
  const params = baseParams(CFG);
  const ok = { options: {}, defaults: {}, extra: '', recipeOn: false, recipe: '' };
  assert.equal(mediaProblem(ok, params), '');
  assert.match(mediaProblem({ ...ok, extra: '[1]' }, params), /JSON 对象/);
  assert.match(mediaProblem({ ...ok, extra: '{x' }, params), /不是合法的 JSON/);
  assert.match(mediaProblem({ ...ok, recipeOn: true }, params), /配方是空的/);
  assert.match(mediaProblem({ ...ok, recipeOn: true, recipe: '{"submit":' }, params), /配方不是合法的 JSON/);
  assert.match(mediaProblem({ ...ok, defaults: { count: '9' } }, params), /1–4/);
  assert.match(mediaProblem({ ...ok, defaults: { count: 'x' } }, params), /要是数字/);
});

test('有配方时参数表用生效卡（配方自己的参数），补上的取值不算原选项', () => {
  const cfg = { recipe: { submit: {} }, effective: { params: [{ key: 'size', type: 'enum', options: [{ value: 'a' }, { value: 'b', custom: true }] }] }, base: { params: [] } };
  assert.deepEqual(baseParams(cfg)[0].options, [{ value: 'a' }]);
  assert.equal(mediaDraft(cfg).recipeOn, true);
});
