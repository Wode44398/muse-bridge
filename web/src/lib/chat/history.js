// 历史侧：transcript 消息归一成视图模型、语义指纹对账（原地合并）、attach 前剪尾去重、会话正文预取。

import { api } from '../api.js';
import { session, ui } from '../state.svelte.js';
import { forgetTaskTool } from '../dock.svelte.js';
import { cacheMessages, getCachedMessagesMeta } from '../cache.js';
import { taskRunning } from '../taskModel.js';
import { t as tt } from '../i18n.js';   // 本文件的 t 是工具行/任务局部变量，翻译函数取别名 tt
import { chat } from './store.svelte.js';
import { revokeMessageBlobUrls, toUiAttachments, toDeliverAtts } from './attachments.js';
import { makeTool, noticeFromEvent } from './turn.js';

// 历史段归一：tools 条目补齐直播同款字段（id/input/status/ms/task——旧服务端只给 name/summary），
// notice 段走同一构造器（at 缺省 0 求稳定，指纹不看它）；其余段原样。
function normSeg(s) {
  if (!s || typeof s !== 'object') return s;
  if (s.kind === 'tools') return { kind: 'tools', open: !!s.open, tools: (Array.isArray(s.tools) ? s.tools : []).map((t) => {
    const tool = makeTool({ ...t, status: t.status || 'done' });
    // 历史里仍标 running 的后台任务 = 已经死了：bridge 一轮 = 一次 query，进程收尾时后台任务
    // 跟着结束；transcript 里没有完成记录只说明「那一轮没等到它」。不收干净的话刷新之后
    // 「任务」面板会永远挂着一条假的 Running（真在跑的那一轮由 /api/attach 重放重建，不走这里）。
    if (tool.task && taskRunning(tool.task.status)) {
      tool.task.status = 'stopped';
      // 记下是兜底收的：挂起接力那轮还活着的话 bg_hold / 进度帧会把它拉回来（reviveTask）
      tool.task.autoStopped = true;
      if (!tool.task.summary) tool.task.summary = tt('进程结束时中止');
    }
    return tool;
  }) };
  if (s.kind === 'notice') return { ...noticeFromEvent(s), at: s.at || 0 };
  if (s.kind === 'steer' && Array.isArray(s.atts)) return { ...s, atts: toUiAttachments(s.atts) };   // 插话里的附件：同用户气泡的取图形态
  return s;
}

export function toUiMessages(raw, sid) {
  return (raw || []).map((msg) => {
    if (msg.role === 'user') return { role: 'user', text: msg.text, attachments: toUiAttachments(msg.attachments), ...(msg.uuid ? { uuid: msg.uuid } : {}) };
    // assistant：后端现在直接给结构化 segments（text/tools/notice/ask，与直播同构）；旧后端/纯文本兜底成单 text 段。
    // startedAt 兜底用 0 而非 Date.now()：历史消息（status done）不显示计时，而稳定值让
    // 「缓存快照 vs 网络刷新」逐字节可比——内容没变就跳过整树替换。
    const segments = (Array.isArray(msg.segments) && msg.segments.length ? msg.segments : [{ kind: 'text', md: msg.text || '' }]).map(normSeg);
    // 服务端重建时能标出「这一轮是错误」（如 CLI 认证失败的合成回答）→ 与直播 error 事件落成同一张错误卡
    const failed = msg.status === 'error';
    const out = { role: 'assistant', segments, thinking: '', thinkingOpen: false, status: failed ? 'error' : 'done', error: failed ? (msg.error || tt('出错了')) : null, tokens: 0, thinkingTokens: 0, startedAt: msg.ts || 0, elapsed: 0, question: null };
    // 助手产物附件（服务端从 transcript 重提取）→ 与直播 done 同款卡片
    const atts = toDeliverAtts(msg.attachments, sid);
    if (atts.length) out.attachments = atts;
    // 撞限额的那一轮 → 限额卡（与直播 error 事件的 limit 同形）
    if (failed && msg.limit && typeof msg.limit === 'object') out.limit = { type: String(msg.limit.type || ''), resetsAt: Number(msg.limit.resetsAt) || 0, text: String(msg.limit.text || '') };
    return out;
  });
}

// attach 重放会从头完整重建当前这一轮；若历史尾部【已经】带着这一轮的内容（before 过滤
// 失效、loadSession 网络失败回退到含本轮的缓存快照、加载与挂载间的竞态都会造成），不剪掉
// 就会整轮问答显示两遍。只认「最后一个 user 气泡文本 = 本轮 prompt」这一种形态，命中则
// 从它起剪到末尾——随后的重放原样补回，净效果就是去重。
// 返回被剪掉那条用户气泡的附件（交给重放补回的气泡沿用；blob 预览不在这里释放）。
export function trimTurnTail(userText) {
  if (!userText) return null;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const msg = chat.messages[i];
    if (msg.role !== 'user') continue;
    if ((msg.text || '') !== userText) return null;
    const atts = msg.attachments || null;
    chat.messages.splice(i);
    return atts;
  }
  return null;
}

// ---- 语义指纹（transcript merge 用）----------------------------------------------
// 只看内容，忽略 tokens/elapsed/startedAt/__notified 这些直播派生字段。否则同一条消息
// 「直播渲染出来的」和「transcript 重建出来的」永远不相等，对账时 mergeMessages 会从
// 第 0 条开始全量替换——整屏 DOM 重建、闪一下、白丢滚动位置。
// media 返回 null = 【不参与比较】：transcript 重建刻意不还原媒体富 UI（见 readSessionMessages），
// 把它计入指纹的话，一轮生成过图片的对话每次对账都会被判成"有变化"，然后拿重建版覆盖
// 掉——刚生成的图就这么没了。
// tools 只看 tool_use id 列表（不含 status/summary/task）：直播与历史的 id 同源（transcript
// 里的 tool_use.id），任务状态/子转录这些直播比历史更富的字段一律不进指纹，否则对账会
// 拿历史的贫版把富卡换掉。没有 id 的旧服务端条目回落 name|summary。
// notice 只看 subtype/from/to：at 直播是服务端 Date.now()、历史是 jsonl 时间戳，永远对不上。
// 压缩条目额外带「有没有摘要」：直播按位置认摘要帧，万一没认出来，对账时拿历史那份（有摘要）补上。
function segFp(s) {
  if (!s) return null;
  switch (s.kind) {
    case 'text': return ['t', (s.md || '').trim()];
    case 'tools': return ['k', (s.tools || []).map((t) => (t.id || ((t.name || '') + '|' + (t.summary || ''))) + (t.compact && t.compact.summary ? '#s' : '') + (t.images ? '#i' + t.images : ''))];
    case 'notice': return ['n', s.subtype || '', s.from || '', s.to || ''];
    case 'steer': return ['s', (s.text || '').trim()];
    case 'ask': return ['q', s.qid || '', !!s.answered, !!s.cancelled, (s.items || []).map((it) => (it.selected || []).join(',') + '|' + (it.custom || ''))];
    case 'plan': return ['p', s.qid || '', !!s.answered, s.decision || ''];   // 计划审批卡（qid = tool_use id，直播与历史同源）
    // 内嵌图表：id + 代码长度 + 是否报错（直播定稿的代码与 transcript 里的 widget_code 同一份；断流的半截会被历史版替换）
    case 'widget': return ['w', s.id || '', (s.code || '').length, s.status === 'error'];
    default: return null;
  }
}
function msgFp(m) {
  if (!m) return '';
  if (m.role === 'user') return JSON.stringify(['u', m.text || '', (m.attachments || []).map((a) => a.name || '')]);
  return JSON.stringify(['a', (m.segments || []).map(segFp).filter(Boolean), (m.attachments || []).map((a) => a.path || a.name || ''), m.status === 'error' ? (m.error || 'err') + (m.limit ? '#' + m.limit.type : '') : '']);
}

// 指纹对用户消息只看文字 + 附件名（故意不看 URL：URL 带 token/局域网地址，每次都可能不同，
// 看了就会整条重建）。代价是 URL 本身永远换不进来——直播气泡的 blob:、缓存里写死的旧
// token / 局域网地址，一旦失效就一直破图。所以在相同前缀里单独把附件 URL 对到服务端那份：
// 只换 attachments 这一个字段，不动消息对象本身（不触发整条重建）。返回是否有改动。
function refreshAttachmentUrls(curList, next, n) {
  let changed = false;
  for (let k = 0; k < n; k++) {
    const a = curList[k], b = next[k];
    if (!a || a.role !== 'user' || !b || !(b.attachments || []).length) continue;
    const urls = (x) => (x.attachments || []).map((t) => [t.url || '', t.thumb || '']);
    if (JSON.stringify(urls(a)) === JSON.stringify(urls(b))) continue;
    const old = a.attachments || [];
    // 按位合并（指纹已保证附件名逐个对得上）：保留直播那份的 path/file（「重试」要靠 path 重发），
    // 只拿服务端的 url/thumb 覆盖。
    a.attachments = b.attachments.map((t, j) => { const { vurl, ...o } = old[j] || {}; return { ...o, ...t }; });   // vurl 随旧的一起释放，封面改走服务端抽帧
    revokeMessageBlobUrls([{ attachments: old }]);
    changed = true;
  }
  return changed;
}

export function mergeMessages(next) {
  const curList = chat.messages;
  let i = 0;
  while (i < curList.length && i < next.length && msgFp(curList[i]) === msgFp(next[i])) i++;
  const urlsChanged = refreshAttachmentUrls(curList, next, i);
  if (i === curList.length && i === next.length) return urlsChanged;   // 正文一模一样 → 只可能换了附件 URL
  const dropped = curList.slice(i);
  curList.splice(i, curList.length - i, ...next.slice(i));
  revokeMessageBlobUrls(dropped);   // 被换掉的那批里若挂着本地 blob 预览，跟着一起释放
  // 工作台任务视图正盯着被换掉那批里的条目 → 收掉（否则它盯着一个已不在视图里的旧 proxy）
  for (const msg of dropped) for (const s of (msg.segments || [])) if (s.kind === 'tools') for (const t of s.tools) forgetTaskTool(t);
  return true;
}

// —— 会话正文预取：列表刷新后，把最近几条「没缓存或已过期」的会话正文悄悄拉回本地 ——
// 之后点开直接渲染缓存，不等隧道往返。串行不抢带宽；缓存 ts ≥ 服务端 mtime 则跳过；
// 正在生成/等提问的会话不取（transcript 是半截）。
let _prefetching = false;
export async function prefetchSessions(list) {
  if (_prefetching || ui.offline) return;
  _prefetching = true;
  try {
    for (const s of (list || []).slice(0, 5)) {
      if (session.busy) break;                      // 开始流式 → 让路
      if (s.thinking || s.pending) continue;
      const meta = await getCachedMessagesMeta(s.id);
      if (meta && s.mtime && meta.ts >= s.mtime) continue;
      // 超大的会话（Desktop / CLI 常年在跑的，transcript 几十上百 MB）不是正开着的就不预取（10-21）
      if (s.size > 20 * 1024 * 1024 && s.id !== session.id) continue;
      try {
        // 带上缓存那份的指纹：Desktop / CLI 在跑时 mtime 一直变，内容没变服务端只回 unchanged
        const d = await api.session(s.id, meta && meta.fp);
        if (d.unchanged) continue;
        cacheMessages(s.id, toUiMessages(d.messages || [], s.id), d.fp);
      } catch { break; }                            // 网络不行 → 别继续白试
    }
  } finally { _prefetching = false; }
}
