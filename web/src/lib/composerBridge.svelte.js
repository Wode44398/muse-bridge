// 输入栏「外部预填」桥（.svelte.js：draft 是 runes 状态，Composer 订阅 nonce 变化把文本灌进输入框）。
//
// 为什么用「草稿 + 序号」推送、而不是把 Composer 的 DOM 句柄交出去：输入框是 contenteditable，
// 同一时刻可能有不止一只 Composer（greeting 态 / chat 态各一只，转场期短暂并存；快照页又是
// 另一只）——谁在场谁接单；lib 层的调用方（refusalRetry 的「编辑并重试」、日后助手转交等）
// 不需要知道哪只输入栏活着。nonce 单调递增：同一段文本连填两次也要各生效一次。
export const draft = $state({ text: '', nonce: 0 });

// 把文本灌进当前输入栏并聚焦。Composer 用完即清 draft.text——换会话 / 转场重挂的输入栏
// 不会再灌一遍旧草稿。
export function prefillComposer(text) {
  draft.text = String(text ?? '');
  draft.nonce++;
}

// 「输入框里此刻有没有未发出的草稿」：官方「Edit prompt and retry」在有草稿时拒绝（提示先发送
// 或清空），绝不能拿被拒消息的原文把人正在写的东西冲掉。Composer 挂载时登记读取器、卸载时
// 注销；多只并存时任一有草稿即算有。
const readers = new Set();
export function registerComposerReader(fn) {
  readers.add(fn);
  return () => { readers.delete(fn); };
}
export function composerHasDraft() {
  for (const fn of readers) { try { if (fn()) return true; } catch {} }
  return false;
}
