// 排队消息 / 连接器状态 / 限额自动续跑的镜像与操作口，以及撤回插话（都不碰直播流，只读写各自的显示态）。

import { api } from '../api.js';
import { session, compose } from '../state.svelte.js';
import { IS_CSNAP } from '../csnap.js';
import { prefillComposer, composerHasDraft } from '../composerBridge.svelte.js';
import { t as tt } from '../i18n.js';   // 本文件的 t 是工具行/任务局部变量，翻译函数取别名 tt
import { devices } from '../devices.svelte.js';   // 用户的电脑（设备）：发消息带上本机设备 id / 新会话选的电脑
import { parseDeviceRef } from '../deviceRefs.js';   // 引用电脑上的文件夹（device://）：排队消息放回输入框时认出来
import { showToast } from '../toast.svelte.js';
import { chat } from './store.svelte.js';

// —— 插话 / 稍后发送（官方 Code 页：Claude 工作中 回车 = 插话，Ctrl+Enter = 稍后发送）——
// 排队消息由服务端持有（手机电脑看同一份、页面关了也照发），这里只是镜像 + 操作口。
export const queueState = $state({ bySession: {}, error: '' });
// 连接器（MCP）状态：每轮 init 帧带来（会话信息面板「连接器」卡）
export const mcpState = $state({ bySession: {} });

export function queuedItems(sid = session.id) {
  return (sid && queueState.bySession[sid]) || [];
}

// —— 5 小时限额「重置后自动继续」（官方 /code 限额卡的勾选框；服务端 src/runtime/limit-resume.mjs 持有）——
// 状态按会话镜像：{ type, resetsAt, optedIn, armed, attempt, fireAt, firing }；null = 没有在等的续跑。
// 来源三处：撞墙那一轮的 error 事件（resume 字段）、总线 limit_resume 事件、限额卡挂上时主动拉一次。
export const limitResume = $state({ bySession: {} });
export function noteLimitResume(sid, st) {
  if (!sid) return;
  if (st) limitResume.bySession[sid] = st;
  else limitResume.bySession[sid] = null;
}
export async function fetchLimitResume(sid) {
  if (!sid || IS_CSNAP) return;
  try {
    const r = await api.get(`/api/claude/limit-resume?session=${encodeURIComponent(sid)}`);
    noteLimitResume(sid, r ? r.state : null);
  } catch {}
}
export async function setLimitAutoContinue(sid, on) {
  if (!sid || IS_CSNAP) return;
  const prev = limitResume.bySession[sid];
  if (prev) limitResume.bySession[sid] = { ...prev, optedIn: on, armed: on && prev.attempt < 3 };   // 先跟手，回包再校正
  try {
    const r = await api.post('/api/claude/limit-resume', { session: sid, on: !!on });
    if (r && r.state && r.state.type) noteLimitResume(sid, r.state);
  } catch {
    if (prev) limitResume.bySession[sid] = prev;
    showToast(tt('操作失败，请重试'));
  }
}

export async function refreshQueue(sid = session.id) {
  if (!sid || IS_CSNAP) return;
  try {
    const r = await api.get(`/api/claude/queue?session=${encodeURIComponent(sid)}`);
    queueState.bySession[sid] = Array.isArray(r?.items) ? r.items : [];
  } catch {}
}

async function queueOp(op, extra = {}) {
  const sid = session.id;
  if (!sid) return null;
  try {
    const r = await api.post('/api/claude/queue', { session: sid, op, ...extra });
    if (r && Array.isArray(r.items)) queueState.bySession[sid] = r.items;
    return r;
  } catch (e) {
    queueState.error = (e && e.body && e.body.error) || tt('操作失败，请重试');
    return null;
  }
}
export const removeQueued = (id) => queueOp('remove', { id });
export const moveQueued = (id, to) => queueOp('move', { id, to });
export const clearQueued = () => queueOp('clear');
export async function promoteQueued(id) {
  const r = await queueOp('promote', { id });
  if (r && r.sent === false) queueState.error = tt('现在没法立即发送，它会在 Claude 处理完后发出');
  return r;
}
// 放回输入框编辑（排队栏 ✎ / 菜单 / 输入框空着按 ↑ / 工作中按 Esc）：从队列取出，文字经外部预填桥
// 灌进当前输入栏，附件回暂存区。输入框里已有草稿就不动（官方同款：先发送或清空）。
export async function editQueued(id) {
  if (composerHasDraft()) { queueState.error = tt('输入框里已有草稿，先发送或清空再编辑排队消息'); return false; }
  const r = await queueOp('take', { id });
  const it = r && r.item;
  if (!it) return false;
  prefillComposer(it.text || '');
  restoreAttachments(it.attachments, it.files);
  return true;
}
// 服务端交还的附件路径 → 输入栏暂存区同款条目（放回输入框、「立即打断」直接重发共用）
export function attsFromPaths(paths, files) {
  return (paths || []).map((p, i) => {
    // 引用电脑上的文件夹：放回成文件夹卡（原始文件不在了，不能再改为上传）
    const ref = parseDeviceRef(p);
    if (ref) {
      const name = (files && files[i]) || ref.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      return { path: p, name, kind: 'folder', url: null, count: null, note: '', pending: false, device: { id: ref.deviceId, name: devices.list.find((d) => d.id === ref.deviceId)?.name || '' } };
    }
    return { path: p, name: (files && files[i]) || String(p).split(/[\\/]/).pop(), kind: 'file', url: null, pending: false, local: true };
  });
}
// 放回输入框的附件（排队消息「编辑」与撤回插话共用）：按路径回暂存区，已在的不重复放
function restoreAttachments(paths, files) {
  for (const a of attsFromPaths(paths, files)) {
    if (!compose.attachments.some((x) => x.path === a.path)) compose.attachments.push(a);
  }
}
export function editLastQueued() {
  const list = queuedItems();
  return list.length ? editQueued(list[list.length - 1].id) : Promise.resolve(false);
}

// —— 撤回插话 ——
// 插话在 Claude 真读到之前是「虚」的（气泡虚线、半透明）：点「撤回」/ 输入框空着按 ↑ 或工作中按 Esc，
// 服务端把它从这一轮里抽回（还没写进 CLI 就摘掉，已在 CLI 队列里就 cancel_async_message），
// 原文与附件回到输入栏。CLI 抢先读到了就撤不回，气泡转实。气泡的消失由流里的 steer_state withdrawn 负责（单写者）。
const retracting = new Set();
function lastAssistant() {
  for (let i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i].role === 'assistant') return chat.messages[i];
  return null;
}
// 当前这一轮里还能撤回的插话（从新到旧）
export function retractableSteers() {
  const m = lastAssistant();
  if (!m || m.status !== 'streaming') return [];
  return m.segments.filter((s) => s.kind === 'steer' && s.retractable && !s.read && !s.cancelled).reverse();
}
// 从这一轮里抽回一条插话（撤回 /「立即打断」共用）：成功回服务端的 { ok, message, attachments, files }，
// 失败回 null（已写好提示、读到了的气泡转实）。how = 'retract' | 'force'，只决定气泡上显示哪个「…中」。
export async function takeSteer(uuid, how = 'retract') {
  const sid = session.id;
  if (!sid || !uuid || retracting.has(uuid)) return null;
  const seg = lastAssistant()?.segments.find((s) => s.kind === 'steer' && s.uuid === uuid);
  retracting.add(uuid);
  if (seg) seg.retracting = how;
  let r = null;
  try { r = await api.post('/api/claude/unsteer', { session: sid, uuid }); }
  catch (e) { r = (e && e.body) || { ok: false }; }
  finally { retracting.delete(uuid); if (seg) seg.retracting = false; }
  if (!r || !r.ok) {
    if (seg && r && r.reason) seg.read = true;   // CLI 抢先读到了 / 服务端已不认这条：气泡转实，不再给撤回
    queueState.error = r && r.reason === 'read' ? tt('Claude 已经读到这条了')
      : r && r.reason ? (how === 'force' ? tt('这条插话已经不能打断重发了') : tt('这条插话撤不回了'))
        : (how === 'force' ? tt('打断没成功，请重试') : tt('撤回没成功，请重试'));
    return null;
  }
  return r;
}
export async function retractSteer(uuid) {
  const sid = session.id;
  if (!sid || !uuid || retracting.has(uuid)) return false;
  if (composerHasDraft()) { queueState.error = tt('输入框里已有草稿，先发送或清空再撤回插话'); return false; }
  const r = await takeSteer(uuid, 'retract');
  if (!r) return false;
  if (session.id === sid) {
    prefillComposer(r.message || '');
    restoreAttachments(r.attachments, r.files);
  }
  return true;
}
export function retractLastSteer() {
  const s = retractableSteers()[0];
  return s ? retractSteer(s.uuid) : Promise.resolve(false);
}
