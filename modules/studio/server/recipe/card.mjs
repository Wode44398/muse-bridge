// 配方 → 模型卡。卡上的参数就是配方 params 里声明的（界面、list_media_models、按卡规范化都照它），
// 另外补一个「额外参数」extra：JSON 请求体时原样并进去（同其它方言的约定）。

import { P, opts } from '../cards/spec.mjs';

const ETA = { image: 30, video: 180, speech: 15, music: 90 };

function toSpec(p) {
  const base = { key: p.key, label: p.label || p.key, group: p.group, ...(p.desc ? { desc: p.desc } : {}), ...(p.default !== undefined ? { default: p.default } : {}) };
  switch (p.type) {
    case 'enum': return { ...base, type: 'enum', options: opts(p.options) };
    case 'number': return { ...base, type: 'number', ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}), ...(p.step ? { step: p.step } : {}) };
    case 'bool': return { ...base, type: 'bool' };
    case 'json': return { ...base, type: 'json' };
    default: return { ...base, type: 'text', max: 4000 };
  }
}

/** 配方（已 normalizeRecipe）+ 模型条目 → 卡。card.recipe 带着配方，jobs 据此换成配方适配器。 */
export function recipeCard(recipe, entry) {
  const params = (recipe.params || []).map(toSpec);
  if (recipe.submit.bodyType !== 'multipart' && !params.some((s) => s.key === 'extra')) params.push(P.json());
  const ins = recipe.inputs || {};
  return {
    id: `recipe:${entry.id}`, kind: entry.kind,
    ...(entry.label && entry.label !== entry.id ? { label: entry.label } : {}),
    ...(recipe.note ? { desc: recipe.note } : {}),
    async: !!recipe.poll,
    inputs: { text: true, ...(ins.images ? { images: { max: ins.images.max, roles: ins.images.roles } } : {}),
      ...(ins.audio ? { audio: { max: ins.audio.max } } : {}), ...(ins.video ? { video: { max: ins.video.max } } : {}), multiTurn: false },
    params, paramSource: 'recipe', recipe,
    etaSec: recipe.etaSec || ETA[entry.kind] || 60,
  };
}
