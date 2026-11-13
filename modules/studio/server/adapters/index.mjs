// 方言 → 适配器（方案 §4）。统一接口：
//   { dialect, kinds, test(provider, ctx) → { detail? }, listModels(provider, ctx) → [{ id, label, kind|null }],
//     voices?(provider, ctx, model) → [{ id, label, note? }], run(req, provider, ctx) → { assets: [{ bytes, mime, meta? }] } }
// run 的 req：{ kind, model, card, prompt, negative, params（按卡规范化过）, inputs: [{ role, data: Buffer, mime, name }],
//   thread: { turns: [{ userText, data, mime, signature }] } | null }
// run 的 ctx：{ secret: { key, sa }, signal, progress({ progress?, elapsed?, eta?, note? }), submitted()（发出去就收不回了）,
//   devKey（vertex 方言借的 Gemini key）, dispatcher（成员的服务：只许连公网）, log }
// 适配器内部不管 SDK 回的是数组、字节还是 URL，都抹平成 { bytes, mime }。

import { googleAdapter } from './google.mjs';
import { openrouterAdapter } from './openrouter.mjs';
import { localAdapter } from './local.mjs';
import { openaiAdapter } from './openai.mjs';
import { falAdapter } from './fal.mjs';
import { replicateAdapter } from './replicate.mjs';
import { elevenlabsAdapter } from './elevenlabs.mjs';
import { minimaxAdapter } from './minimax.mjs';
import { arkAdapter } from './ark.mjs';

const ADAPTERS = {
  vertex: googleAdapter('vertex'),
  gemini: googleAdapter('gemini'),
  openrouter: openrouterAdapter,
  local: localAdapter,
  openai: openaiAdapter,
  fal: falAdapter,
  replicate: replicateAdapter,
  elevenlabs: elevenlabsAdapter,
  minimax: minimaxAdapter,
  ark: arkAdapter,
};

export function adapterFor(dialect) {
  const a = ADAPTERS[dialect];
  if (!a) throw Object.assign(new Error('不认识的方言：' + dialect), { status: 400 });
  return a;
}
