// Vertex (Gemini) 对话控制器。把 vertex 的 SSE 流（session / text / done / error）变成
// 响应式消息模型。独立于 claude 的 chat.svelte.js —— vertex 是另一套会话空间与模型，
// 互不干扰（切分页不混消息）。复用 sse.js 的 startChat。
//
// 事件比 claude 简单：无 thinking / tool / workflow，只有流式 text（来源脚注也以 text 追加）。
// 注：后端 runVertexChat 不进 currentGen 缓冲，故断线 attach 恢复对 vertex 无效；Gemini
// 响应快，正常流走 onEvent/onClose。会话回看结构与 claude /api/session 同构（{messages:[{role,text}]}）。

import { startChat } from './sse.js';
import { api } from './api.js';
import { caps, vertex as vs } from './state.svelte.js';
import { cacheVertexMessages, getCachedVertexMessages, getCachedVertexMessagesMeta } from './cache.js';
import { t, tr } from './i18n.js';

export const vchat = $state({
  messages: [],      // {role:'user',text} | {role:'assistant',md,status,error,startedAt,elapsed}
  busy: false,
  sessionId: null,
  view: 'greeting',  // 'greeting' | 'chat'
});

let handle = null, timer = null;

const sentAttachments = (list) => (list || []).map((a) => ({
  path: a.path || null,
  name: a.name,
  kind: a.kind,
  url: a.url || null,
}));

function replaceMessages(next) {
  for (const m of vchat.messages || []) {
    for (const a of m?.atts || []) {
      if (typeof a?.url === 'string' && a.url.startsWith('blob:')) {
        try { URL.revokeObjectURL(a.url); } catch {}
      }
    }
  }
  vchat.messages = next;
}

function newAssistant() {
  vchat.messages.push({ role: 'assistant', md: '', status: 'streaming', error: null, startedAt: Date.now(), elapsed: 0 });
  return vchat.messages[vchat.messages.length - 1];   // 返回代理元素（Svelte5 push 深代理）
}
const cur = () => vchat.messages[vchat.messages.length - 1];

// —— 流式文本节流（与 claude 页同法）：token 增量先入缓冲，80ms 批量刷进响应式状态。
// 每 token 都触发整段重渲染是长回答掉帧根源；批量后肉眼仍是连续打字机。
let vBuf = '', vMsg = null, vTimer = null;
function vFlush() {
  if (vTimer) { clearTimeout(vTimer); vTimer = null; }
  if (vMsg && vBuf) vMsg.md += vBuf;
  vBuf = ''; vMsg = null;
}
function vQueue(m, chunk) {
  if (vMsg && vMsg !== m) vFlush();
  vMsg = m; vBuf += chunk;
  if (!vTimer) vTimer = setTimeout(vFlush, 80);
}

function onEvent(m, ev) {
  if (ev.type !== 'text') vFlush();   // 非 text 事件先落缓冲，保证顺序正确
  switch (ev.type) {
    case 'session': if (ev.sessionId) vchat.sessionId = ev.sessionId; break;
    case 'text': vQueue(m, ev.text || ''); break;
    case 'error': m.status = 'error'; m.error = tr(ev.message || ev.title) || t('出错了'); break;
    case 'done': if (!m.md.trim() && ev.result) m.md += ev.result; m.status = 'done'; break;
  }
}

function startTimer() { stopTimer(); timer = setInterval(() => { const m = cur(); if (m && m.role === 'assistant' && m.status === 'streaming') m.elapsed = Date.now() - m.startedAt; }, 200); }
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

function finish(m) {
  vFlush();   // 收尾兜底：onError/onClose 路径也把缓冲文本刷进消息
  stopTimer();
  if (m && m.role === 'assistant' && m.status === 'streaming') m.status = 'done';
  if (handle) { vchat.sessionId = handle.sessionId || vchat.sessionId; handle = null; }
  vchat.busy = false;
  if (vchat.sessionId) cacheVertexMessages(vchat.sessionId, vchat.messages);   // 本轮快照落缓存，下次点开秒进
}

function errText(e) {
  if (e && e.status === 401) return t('需要登录');
  const msg = (e && e.message) || String(e || '');
  if (/reconnect|network|fetch/i.test(msg)) return t('连接中断，请重试');
  return tr(msg) || t('出错了');
}

// attachments: [{path, name, kind, url}]（上传完成后的暂存）；图片/PDF 以 inlineData
// 喂给 Gemini（仅当轮可见，历史以 📎 标注）。
export function vsend(text, attachments) {
  const txt = (text || '').trim();
  const atts = Array.isArray(attachments) ? attachments : [];
  if ((!txt && !atts.length) || vchat.busy) return;
  vLoadGen++;   // 作废在途的历史刷新——慢返回不覆盖即将开始的流式轮
  if (vchat.view !== 'chat') vchat.view = 'chat';
  vchat.messages.push({ role: 'user', text: txt, atts: sentAttachments(atts) });
  vchat.busy = true;
  const m = newAssistant();
  startTimer();

  const d = caps.data?.vertex?.defaults || {};
  const params = {
    message: txt, agent: 'vertex',
    vertexModel: vs.chatModel || d.model,
    vertexThink: vs.chatThink || d.think,
    vertexSearch: !!vs.chatSearch,
    vertexFastVision: vs.fastVision !== false,   // 快速识图：图片降采样提速（默认开）
    vertexUrl: !!vs.chatUrl, vertexCode: !!vs.chatCode, vertexMediaRes: vs.chatMediaRes || 'auto',
  };
  if ((vs.chatSystem || '').trim()) params.vertexSystem = vs.chatSystem.trim();
  if (atts.length) params.attachments = atts.map((a) => a.path).filter(Boolean);
  if (vchat.sessionId) params.sessionId = vchat.sessionId;

  // reconnect:false —— vertex 不进服务端 currentGen 缓冲，attach 通道是 Claude 专属；
  // 复用它会在断流时把恰好在跑的 Claude 任务事件串进 Gemini 气泡。断了就明确报错。
  handle = startChat(params, {
    onEvent: (ev) => onEvent(m, ev),
    onError: (e) => { if (m.status === 'streaming') { m.status = 'error'; m.error = errText(e); } finish(m); },
    onClose: () => finish(m),
  }, { reconnect: false });
}

export function vstop() {
  // 不调 /api/stop —— 那中止的是同 key 的 Claude currentGen（vertex 不注册 gen），
  // 会误杀后台正在跑的 Claude 长任务。断开本请求即可：后端 req close → abort。
  if (handle) handle.stop();
  const m = cur();
  if (m && m.role === 'assistant' && m.status === 'streaming') m.status = 'done';
  finish(m);
}

export function vnewChat() {
  // 流式中也能新建：vertex 流不进服务端缓冲、断开即中止（vstop 语义），Gemini 轮短，
  // 「切走=放弃当前回答」符合直觉——总好过点了没反应。
  if (vchat.busy) vstop();
  vLoadGen++;   // 作废在途的历史刷新——慢返回不把空白新聊天顶回旧会话
  replaceMessages([]);
  vchat.sessionId = null;
  vchat.view = 'greeting';
}

function toUiMessages(data) {
  // startedAt 用 0 而非 Date.now()：历史消息（done）不显示计时，稳定值让缓存快照与
  // 网络刷新逐字节可比——内容没变就不整树替换。
  return (data?.messages || []).map((msg) =>
    msg.role === 'user'
      ? { role: 'user', text: msg.text }
      : { role: 'assistant', md: msg.text || '', status: 'done', error: null, startedAt: 0, elapsed: 0 }
  );
}

// 「切走/新聊天/发送」推进代数，作废在途的网络刷新——慢返回不覆盖新内容（与 claude 页同法）。
let vLoadGen = 0;
const sameSnapshot = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };

// 缓存优先：本地有快照先渲染（点开即进，不等隧道往返 ~1s），网络返回有变化再替换。
export async function vloadSession(id) {
  // 流式中点会话：看的就是这条 → 不动；别的 → 中止当前轮再切（不再静默卡死）。
  if (vchat.busy) {
    if (id === vchat.sessionId) return;
    vstop();
  }
  const gen = ++vLoadGen;
  let shown = false;
  const cached = await getCachedVertexMessages(id);
  if (cached && cached.length && gen === vLoadGen && !vchat.busy) {
    replaceMessages(cached);
    vchat.sessionId = id;
    vchat.view = 'chat';
    shown = true;
  }
  let msgs;
  try { msgs = toUiMessages(await api.vertexSession(id)); cacheVertexMessages(id, msgs); }
  catch { return; }   // 网络失败：缓存已渲染就先看缓存；没缓存维持原状
  if (gen !== vLoadGen || vchat.busy) return;      // 期间已切走/开始发送 → 刷新作废
  if (shown && sameSnapshot(vchat.messages, msgs)) return;   // 内容没变 → 不动 DOM/视口
  replaceMessages(msgs);
  vchat.sessionId = id;
  vchat.view = 'chat';
}

// —— 会话正文预取：列表刷新后把最近几条「没缓存或已过期」的会话拉回本地（与 claude 页同法）——
let _vPrefetching = false;
export async function vprefetchSessions(list) {
  if (_vPrefetching) return;
  _vPrefetching = true;
  try {
    for (const s of (list || []).slice(0, 5)) {
      if (vchat.busy) break;                        // 开始流式 → 让路
      const meta = await getCachedVertexMessagesMeta(s.id);
      if (meta && s.mtime && meta.ts >= s.mtime) continue;
      try { cacheVertexMessages(s.id, toUiMessages(await api.vertexSession(s.id))); } catch { break; }
    }
  } finally { _vPrefetching = false; }
}
