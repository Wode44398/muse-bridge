// 压缩上下文的进度（额度卡里那个键、托盘上下文环都读它）。放在卡片外面：压到一半关掉卡片再打开，
// 键还在原地转；托盘的环也能据此转圈。
//   phase: '' | 'busy' | 'ok' | 'err'；before / after 是压之前、之后的 { used, total, pct }。

import { codex, compactThread, errText } from '../store.svelte.js';

export const compaction = $state({ id: '', phase: '', before: null, after: null, error: '', at: 0 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctxNow = (id) => codex.threads[id]?.ctx || null;

/**
 * 压这条线程。服务端接了就开始压，压完由线程事件带来新的上下文用量；
 * 等到用量真的掉下来才算压完（最多等 maxWait），等不到也算发出去了，只是没有「腾出多少」可看。
 */
export async function startCompact(id, { maxWait = 30000 } = {}) {
  if (!id || (compaction.id === id && compaction.phase === 'busy')) return;
  const before = ctxNow(id);
  Object.assign(compaction, { id, phase: 'busy', before, after: null, error: '', at: Date.now() });
  try {
    await compactThread(id);
  } catch (e) {
    if (compaction.id === id) Object.assign(compaction, { phase: 'err', error: errText(e) });
    return;
  }
  const t0 = Date.now();
  while (Date.now() - t0 < maxWait) {
    const now = ctxNow(id);
    if (now && (!before || now.used < before.used)) {
      if (compaction.id === id) Object.assign(compaction, { phase: 'ok', after: now, at: Date.now() });
      return;
    }
    await sleep(250);
  }
  if (compaction.id === id) Object.assign(compaction, { phase: 'ok', after: null, at: Date.now() });
}

/** 卡片看完了：清掉「已压缩」的状态，下次打开是普通的键。 */
export function clearCompaction(id) {
  if (!id || compaction.id === id) {
    if (compaction.phase === 'busy') return;
    Object.assign(compaction, { id: '', phase: '', before: null, after: null, error: '' });
  }
}
