// 尺寸参数（方案 §10）的前端纯逻辑：取值 / 默认（改图默认原图）/ 校验 / 值芯片，以及和服务端规则逐例对拍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSize, sizeProblems, sizeIssues, customStart, isCustomSize, sizeFromRatio, sizeGrid, gridMatch, pickRatio, pickTier, nearestTier } from './size.js';
import { resolveValues, payloadParams, paramIssues, visibleSpec } from './params.js';
import { controlOf, chipValue } from './render.js';
import * as server from '../../../../modules/studio/server/cards/size.mjs';

const FLEX = { width: { min: 16, max: 3840, multipleOf: 16 }, height: { min: 16, max: 3840, multipleOf: 16 }, aspect: { min: 1 / 3, max: 3 }, pixels: { min: 655360, max: 8294400 }, exact: true };
const SIZE = {
  key: 'size', label: '尺寸', type: 'size', group: 'basic', format: 'size', default: 'auto', editDefault: 'original', custom: FLEX, encode: 'x',
  options: [{ value: 'auto', label: '自动' }, { value: 'original', label: '原图', only: { $edit: true } }, { value: '1024x1024', label: '1024×1024', hint: '1:1' }, { value: '2048x1152', label: '2048×1152', hint: '16:9' }],
};
const lab = (o) => String(o.label ?? o.value);

test('和服务端同一套规则：解析与判定逐例一致', () => {
  const cases = [[2048, 1152], [2000, 1000], [4096, 1024], [3840, 1024], [512, 512], [3840, 2160], [16, 16], [1920, 1080], [1024, 3072], [1008, 3072]];
  for (const [w, h] of cases) {
    const s = { width: w, height: h };
    assert.deepEqual(sizeProblems(FLEX, s), server.sizeProblems(FLEX, s), `${w}x${h}`);
    assert.deepEqual(sizeProblems({ ...FLEX, exact: false }, s), server.sizeProblems({ ...FLEX, exact: false }, s), `${w}x${h} exact:false`);
  }
  for (const v of ['1536x864', '1024*1024', '1024×1536', '2K', '', null, { width: 2, height: 3 }, { width: 0, height: 3 }]) assert.deepEqual(parseSize(v), server.parseSize(v), String(v));
});

test('默认：没有要改的图 = 自动；有要改的图 = 原图（「原图」档只在那时出现）', () => {
  assert.equal(resolveValues([SIZE], {}, 'm').size, 'auto');
  assert.equal(resolveValues([SIZE], {}, 'm', { edit: true }).size, 'original');
  assert.equal(resolveValues([SIZE], { size: 'auto' }, 'm', { edit: true }).size, 'auto', '手动选了自动就不被原图覆盖');
  assert.equal(resolveValues([SIZE], { size: 'original' }, 'm').size, 'auto', '没有改图素材了：原图不成立，回默认');
  assert.equal(resolveValues([SIZE], { size: 'original' }, 'm', { edit: true }).size, 'original');
  assert.equal(resolveValues([SIZE], { size: '2048x1152' }, 'm').size, '2048x1152');
});

test('自定义宽高：打到一半的不合规值也留在草稿里，问题由 paramIssues 报、提交前拦', () => {
  const v = resolveValues([SIZE], { size: { width: 2000, height: 1000 } }, 'm');
  assert.deepEqual(v.size, { width: 2000, height: 1000 });
  const bad = paramIssues([SIZE], v);
  assert.equal(bad.length, 1); assert.equal(bad[0].issues[0].code, 'multiple');
  const good = resolveValues([SIZE], { size: { width: 2048, height: 1152 } }, 'm');
  assert.deepEqual(paramIssues([SIZE], good), []);
  assert.deepEqual(payloadParams([SIZE], good), { size: { width: 2048, height: 1152 } });
  // 没有自由宽高规则的尺寸参数不收对象
  const tiers = { ...SIZE, custom: undefined, editDefault: undefined, options: [{ value: '1K' }, { value: '2K' }], default: '2K' };
  assert.equal(resolveValues([tiers], { size: { width: 2048, height: 1152 } }, 'm').size, '2K');
  assert.deepEqual(sizeIssues(tiers, { width: 1, height: 1 }), [{ code: 'custom' }]);
});

test('「默认，不传」不发；被 when 藏起来的不查也不发', () => {
  const sz = { ...SIZE, options: [{ value: '', label: '默认' }], default: '', editDefault: undefined, custom: { width: { min: 16 }, height: { min: 16 }, exact: false } };
  const asp = { key: 'aspect_ratio', type: 'enum', options: [{ value: '16:9' }], default: '16:9', when: { size: '' } };
  const v0 = resolveValues([asp, sz], {}, 'm');
  assert.deepEqual(payloadParams([asp, sz], v0), { aspect_ratio: '16:9' });
  const v1 = resolveValues([asp, sz], { size: { width: 1200, height: 800 } }, 'm');
  assert.equal(visibleSpec(asp, v1), false, '填了自定义尺寸就藏起比例');
  assert.deepEqual(payloadParams([asp, sz], v1), { size: { width: 1200, height: 800 } });
  const gated = { ...sz, key: 'width_height', options: [], default: { width: 1024, height: 1024 }, when: { aspect_ratio: 'custom' }, custom: { width: { max: 10 }, height: { max: 10 } } };
  const ar = { key: 'aspect_ratio', type: 'enum', options: [{ value: '1:1' }, { value: 'custom' }], default: '1:1' };
  assert.deepEqual(paramIssues([ar, gated], resolveValues([ar, gated], {}, 'm')), [], '藏着的默认值不合规也不拦');
});

test('控件与值芯片：size 用自己的控件；自动、原图、档位、宽高都写在芯片上', () => {
  assert.equal(controlOf(SIZE), 'size');
  assert.equal(chipValue(SIZE, 'auto', { labelOf: lab, values: {} }), '自动');
  assert.equal(chipValue(SIZE, 'original', { labelOf: lab, values: { $edit: true } }), '原图');
  assert.equal(chipValue(SIZE, '2048x1152', { labelOf: lab, values: {} }), '2048×1152');
  assert.equal(chipValue(SIZE, { width: 1600, height: 900 }, { labelOf: lab, values: {} }), '1600×900');
});

test('进「自定义」的起步宽高：沿用当前预设；否则取一个合规的方图', () => {
  assert.deepEqual(customStart(SIZE, '2048x1152'), { width: 2048, height: 1152 });
  const s = customStart(SIZE, 'auto');
  assert.deepEqual(sizeProblems(FLEX, s), []);
  const seed = { custom: { width: { min: 1 }, height: { min: 1 }, aspect: { min: 1 / 16, max: 16 }, pixels: { min: 921600, max: 4624220 } } };
  assert.deepEqual(sizeProblems(seed.custom, customStart(seed, '2K')), []);
  const rep = { custom: { width: { min: 256, max: 2048, multipleOf: 16 }, height: { min: 256, max: 2048, multipleOf: 16 } }, default: { width: 1024, height: 768 } };
  assert.deepEqual(customStart(rep, undefined), { width: 1024, height: 768 });
  assert.equal(isCustomSize(customStart(rep, undefined)), true);
});

test('素材条件：选项 only 条件表看 $ref / 前面参数（Veo 有参考图只能 8 秒、海螺 1080P 没有 10 秒）', () => {
  const dur = { key: 'durationSeconds', type: 'enum', default: 8, options: [{ value: 4, only: { $ref: false } }, { value: 6, only: { $ref: false } }, { value: 8 }] };
  assert.equal(resolveValues([dur], { durationSeconds: 4 }, 'm').durationSeconds, 4);
  assert.equal(resolveValues([dur], { durationSeconds: 4 }, 'm', { ref: true }).durationSeconds, 8);
  const res = { key: 'resolution', type: 'enum', default: '768P', options: [{ value: '768P' }, { value: '1080P' }] };
  const d2 = { key: 'durationSeconds', type: 'enum', default: 6, options: [{ value: 6 }, { value: 10, only: { resolution: ['512P', '768P'] } }] };
  assert.equal(resolveValues([res, d2], { resolution: '1080P', durationSeconds: 10 }, 'm').durationSeconds, 6);
  assert.equal(resolveValues([res, d2], { resolution: '768P', durationSeconds: 10 }, 'm').durationSeconds, 10);
});

test('原图适配：前端 fitSize 与服务端逐例一致；出错的边单独标出', async () => {
  const { fitSize, badSides } = await import('./size.js');
  const SEED = { width: { min: 1 }, height: { min: 1 }, aspect: { min: 1 / 16, max: 16 }, pixels: { min: 921600, max: 4624220 }, exact: true };
  for (const rule of [FLEX, SEED, { ...FLEX, exact: false }]) {
    for (const [w, h] of [[1920, 1080], [640, 480], [6000, 4000], [4000, 1000], [2048, 1152], [800, 600], [1, 1], [12000, 300]]) {
      assert.deepEqual(fitSize(rule, { width: w, height: h }), server.fitSize(rule, { width: w, height: h }), `${w}x${h}`);
    }
  }
  assert.deepEqual([...badSides(sizeProblems(FLEX, { width: 4096, height: 1024 }))].sort(), ['height', 'width'], '宽超限 + 比例超 3:1：两条都算');
  assert.deepEqual([...badSides(sizeProblems(FLEX, { width: 3999, height: 1600 }))], ['width'], '只有宽超限且不是 16 倍数');
});

// —— 方案 §11：比例 × 档位（不让人自己算 16 的倍数）——
test('比例 × 档位：换算出来的宽高一律合规；格子里能认出当前是哪一格', () => {
  const grid = sizeGrid(SIZE);
  assert.deepEqual(grid.ratios, ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9']);
  assert.deepEqual(grid.tiers.map((t) => t.id), ['1K', '2K', '4K']);
  for (const t of grid.tiers) for (const r of grid.ratios) {
    const s = sizeFromRatio(FLEX, r, t.edge);
    assert.deepEqual(sizeProblems(FLEX, s), [], `${r} ${t.id} → ${s.width}x${s.height}`);
    assert.deepEqual(gridMatch(SIZE, s, grid), { ratio: r, tier: t.id }, `${r} ${t.id}`);
  }
  assert.deepEqual(sizeFromRatio(FLEX, '16:9', 2048), { width: 2048, height: 1152 });
  assert.deepEqual(sizeFromRatio(FLEX, '16:9', 4096), { width: 3840, height: 2160 }, '4K 夹到上限');
  assert.deepEqual(sizeFromRatio(FLEX, '1:1', 1024), { width: 1024, height: 1024 });
  const k1 = sizeFromRatio(FLEX, '16:9', 1024);
  assert.ok(k1.width * k1.height >= 655360 && k1.width % 16 === 0 && k1.height % 16 === 0, '1K 的 16:9 不够最低像素：整体放大到合规');
  assert.equal(sizeFromRatio(FLEX, '4:1', 1024), null, '规则不许的比例不出');
  // 预设字符串也认得出是哪一格
  assert.deepEqual(gridMatch(SIZE, '2048x1152', grid), { ratio: '16:9', tier: '2K' });
  assert.deepEqual(gridMatch(SIZE, 'auto', grid), { ratio: null, tier: null });
  assert.deepEqual(gridMatch(SIZE, { width: 1600, height: 912 }, grid), { ratio: null, tier: null }, '自己打的数不在格子上');
});

test('比例 × 档位：点比例沿用当前档位，点档位沿用当前比例；自动 / 原图时各用第一档 / 方图', () => {
  const grid = sizeGrid(SIZE);
  assert.deepEqual(pickRatio(SIZE, 'auto', '16:9', grid), sizeFromRatio(FLEX, '16:9', 1024));
  assert.deepEqual(pickRatio(SIZE, { width: 2048, height: 2048 }, '16:9', grid), { width: 2048, height: 1152 });
  assert.deepEqual(pickTier(SIZE, { width: 2048, height: 1152 }, '4K', grid), { width: 3840, height: 2160 });
  assert.deepEqual(pickTier(SIZE, 'auto', '2K', grid), { width: 2048, height: 2048 });
  // 自己打的宽高：换档保持它的实际比例
  const t = pickTier(SIZE, { width: 1600, height: 800 }, '2K', grid);
  assert.ok(Math.abs(t.width / t.height - 2) < 0.03 && Math.max(t.width, t.height) === 2048);
  assert.equal(nearestTier(grid, { width: 1536, height: 1024 }).id, '2K');
  assert.equal(nearestTier(grid, null).id, '1K');
});

test('比例 × 档位：上限低的模型去掉够不着的档；成套命名预设的模型不摆格子；没有自由宽高的不摆', () => {
  const small = { ...SIZE, options: [], custom: { width: { min: 256, max: 1440, multipleOf: 32 }, height: { min: 256, max: 1440, multipleOf: 32 }, exact: true } };
  assert.deepEqual(sizeGrid(small).tiers.map((t) => t.id), ['1K', '2K'], '2K 实际是 1440（上限），4K 和它一样、去掉');
  const seedream = { ...SIZE, options: [], custom: { width: { min: 16 }, height: { min: 16 }, aspect: { min: 1 / 16, max: 16 }, pixels: { min: 921600, max: 4624220 }, exact: false } };
  assert.deepEqual(sizeGrid(seedream).tiers.map((t) => t.id), ['1K', '2K']);
  const named = { ...SIZE, options: [{ value: 'square_hd', label: 'Square HD' }, { value: 'landscape_16_9', label: 'Landscape 16:9' }] };
  assert.equal(sizeGrid(named), null);
  assert.equal(sizeGrid({ ...SIZE, custom: undefined }), null);
});
