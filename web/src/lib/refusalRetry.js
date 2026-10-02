// 安全栅门的两条「编辑提示词并重试」路径：
//
// ① retryRefused——官方 /code 输入框上方回退横条（RefusalBand）的 Edit prompt and retry with {original}。
// 消息被拒后已经切到回退模型重试过（服务端发 session{swapped} → settings.model 已是回退模型）。
// 这条动作把三件事一次做完：
//   ② 检查点回滚到被拒的那条用户消息——只回对话锚点、不回滚文件（rewindToMessage 的 'chat'
//      模式：被拒的那一轮什么文件也没改，回滚文件只会误伤别的轮）；
//   ① 会话模型切回被拒时的原模型并记忆（等于用户手动切回，下一轮 bridge 显式传它）；
//   ③ 把原文填回输入栏聚焦，让人改一改再发。
// 顺序上先回滚再切模型：回滚失败时不留「模型已切、对话没回」的半截状态；成功路径上两者互不
// 依赖，先后无差。失败只 toast，指去用消息气泡上的回滚按钮（官方同款语义
// "Couldn't go back to that message. Use Rewind on the message instead."）。
// 返回 true = 已回滚并预填（横条据此收起），false = 什么也没动。
//
// ② answerRefusalPrompt——本轮被安全栅门暂停时的 Paused 卡（claude.ai 同款）二选一：
//   retry_fallback：回话即可——服务端交给 CLI，CLI 换回退模型重试，本轮照常往下流；
//   edit_prompt：回话后 CLI 自行中断本轮；等收轮（session.busy 落下）再回滚到被拒的用户消息、
//                原文填回输入框（官方 onEditPromptRewind 同款：回滚失败时原文照样回输入框）；
//   cancelled（X）：CLI 按经典拒答收尾。
import { session, settings, refusalBand } from './state.svelte.js';
import { chat, rewindToMessage, rememberCurrentPrefs } from './chat.svelte.js';
import { prefillComposer, composerHasDraft } from './composerBridge.svelte.js';
import { dropToast } from './dragdrop.svelte.js';
import { api } from './api.js';
import { t } from './i18n.js';

const FAIL = () => t('回不到那条消息，请用消息上的回滚按钮');
const DRAFT = () => t('先发送或清空输入框里的草稿，再点「编辑并重试」');

export async function retryRefused(notice) {
  if (!notice) return false;
  if (session.busy) { dropToast(t('这一轮还在生成，等它结束再重试')); return false; }
  // 官方：composer 有草稿 ⇒ 拒绝并提示先发送 / 清空（"Send or clear your draft first…"）
  if (composerHasDraft()) { dropToast(DRAFT()); return false; }
  // 被拒请求对应的用户消息 uuid = transcript 里的 uuid（气泡在 user uuid 事件 / 历史重建时挂上）
  const uuid = notice.refusedUserUuid || null;
  const m = uuid ? chat.messages.find((x) => x && x.role === 'user' && x.uuid === uuid) : null;
  if (!m) { dropToast(FAIL()); return false; }
  const text = m.text || '';   // 回滚会把这条气泡连同其后全部移除，原文先留住
  try { await rewindToMessage(m, 'chat'); }
  catch { dropToast(FAIL()); return false; }
  // 切回原模型（自动回退把 settings.model 换成了回退模型；notice.from 缺失时不动）。SDK 的 original_model
  // 带 [1m] 后缀（oneM 表里的模型 bridge 跑 query 时一律 to1M），picker / sidecar 只认裸 id——不剥的话芯片会
  // 印出 'claude-opus-5[1m]' 原串且恒判 mismatch（与 claude.mjs 的 bare 同口径）。
  const back = String(notice.from || '').replace(/\[1m\]$/, '');
  if (back && settings.model !== back) { settings.model = back; rememberCurrentPrefs(); }
  prefillComposer(text);
  // 已处理：横条即刻收起（官方 resolveRefusalFallback），不等下一条消息发出才清
  refusalBand.notice = null;
  return true;
}

function lastUserMessage() {
  for (let i = chat.messages.length - 1; i >= 0; i--) { const x = chat.messages[i]; if (x && x.role === 'user') return x; }
  return null;
}
// 等本轮收尾（CLI 中断 → 软停止收成 done）；超时返回 false
function waitIdle(ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (!session.busy) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 120);
    };
    tick();
  });
}

export async function answerRefusalPrompt(p, choice) {
  if (!p || p.busy) return false;
  if (choice === 'edit_prompt' && composerHasDraft()) { dropToast(DRAFT()); return false; }
  const um = lastUserMessage();   // 被拒的 = 本轮的用户气泡（服务端发卡前已补发它的 anchor uuid）
  const text = um ? (um.text || '') : '';
  p.busy = true;
  try {
    await api.answer(p.qid, choice === 'cancelled' ? { cancelled: true } : { choice });
  } catch (e) {
    p.busy = false;
    // 404 = 服务端已不在等这一问（超时 / 这一轮已结束）：卡片作废
    if (e && e.status === 404) { if (refusalBand.prompt === p) refusalBand.prompt = null; }
    else dropToast(t('提交失败，请重试'));
    return false;
  }
  if (refusalBand.prompt && refusalBand.prompt.qid === p.qid) refusalBand.prompt = null;
  if (choice !== 'edit_prompt') return true;
  const back = () => { prefillComposer(text); dropToast(FAIL()); return false; };
  if (!(await waitIdle(20_000))) return back();
  const m = (um && chat.messages.includes(um) && um.uuid) ? um : lastUserMessage();
  if (!m || !m.uuid) return back();
  try { await rewindToMessage(m, 'chat'); } catch { return back(); }
  prefillComposer(text);
  return true;
}
