// Claude 分页「检查点回滚」（2026-07-30 探针实证后落地）。
//
// 文件回滚：SDK enableFileCheckpointing 在每次文件编辑前快照（默认关，必须显式开——
// runClaudeChat 与这里的临时 query 都开）；回滚 = 起一个【不发消息】的 resume query
// 保住控制通道，等 init 后调 Query.rewindFiles(用户消息 uuid)。零 prompt = 零 API
// 调用 = 零 token 成本。
//
// 对话回滚：不动 transcript，只在【下一轮】query 带 resumeSessionAt=锚点（目标用户
// 消息之前最后一条 assistant 的 uuid）。CLI 按 parentUuid 链在同一 jsonl 里分叉，
// 之后普通 resume 自动粘在新分支上（探针 C5 实证），孤儿轮不再进入上下文。
//
// 探针踩过的坑（勿改回）：
//  · rewindFiles 锚点必须是 jsonl 里 type:user 条目的 uuid；SDK 流里冒出来的 user
//    消息多为 tool_result 包装，用它们的 uuid 会报 "No file checkpoint found"。
//  · rewindFiles 是控制通道请求，要趁 query 存活时调；break for-await 会自动触发
//    iterator.return() 把通道关掉——这里用后台 drain + 轮询 init。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ROOT } from '../config/index.mjs';
import { claudeEngineEnv } from '../runtime/claude-account.mjs';
import { claudeCliOptions } from '../runtime/claude-cli.mjs';   // Claude Code 可执行文件在哪（SDK 自带的不传）
import { PEER_OFF_ENV, PEER_OFF_SETTINGS } from '../runtime/session-peers.mjs';   // 这个临时 CLI 不进跨会话通道

// —— 待生效的对话回滚锚点（sessionId → resumeSessionAt uuid）——
// 下一轮 runClaudeChat 消费；落盘防服务重启丢账。历史接口也按它截断视图，
// 让「回滚了但还没发下一条消息」期间重开会话看到的就是截断后的对话。
const PENDING_PATH = path.join(ROOT, 'rewind-pending.json');
const pending = new Map();
try { if (existsSync(PENDING_PATH)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(PENDING_PATH, 'utf8')))) pending.set(k, v); } catch {}
function persist() { try { writeFileSync(PENDING_PATH, JSON.stringify(Object.fromEntries(pending))); } catch {} }
export function pendingRewindAnchor(sessionId) { return (sessionId && pending.get(sessionId)) || null; }
export function setPendingRewind(sessionId, anchor) { if (sessionId && anchor) { pending.set(sessionId, anchor); persist(); } }
export function clearPendingRewind(sessionId) { if (pending.delete(sessionId)) persist(); }

// 扫 transcript：确认目标 uuid 是一条真实用户消息，并算出对话回滚锚点
// （它前面最后一条 assistant 的 uuid；目标是首条消息时为 null——对话没有更早处可回）。
export function findRewindAnchors(file, userUuid) {
  let found = false, convAnchor = null, lastAsst = null;
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || !o.uuid || o.isSidechain) continue;
    if (o.uuid === userUuid) {
      if (o.type !== 'user' || o.isMeta) return null;
      found = true; convAnchor = lastAsst;
    }
    if (o.type === 'assistant') lastAsst = o.uuid;
  }
  return found ? { convAnchor } : null;
}

// 号池换号重发用的分叉锚点：沿【目标用户消息的 parentUuid 链】往回找第一条真回答（跳过附件 /
// system 帧 / 合成的 API 错误消息）。不能按文件顺序取「前一条 assistant」——会话里有过分叉时，
// 文件里排在前面的可能是废弃分支上的合成错误消息（实测锚到它，重发那轮直接起不来）。
// 链上先碰到别的用户消息（上一轮也没答出来）就返回 null：不分叉，原样重发。
export function findRetryAnchor(file, userUuid) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const byId = new Map();
  for (const line of text.split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o && o.uuid && !o.isSidechain) byId.set(o.uuid, o);
  }
  const target = byId.get(userUuid);
  if (!target || target.type !== 'user') return null;
  let cur = target.parentUuid ? byId.get(target.parentUuid) : null;
  for (let guard = 0; cur && guard < 10_000; guard++) {
    if (cur.type === 'assistant' && !cur.isApiErrorMessage && !(cur.message && cur.message.model === '<synthetic>')) return cur.uuid;
    if (cur.type === 'user' && !cur.isMeta && cur.message && !(Array.isArray(cur.message.content) && cur.message.content.every((b) => b && b.type === 'tool_result'))) return null;
    cur = cur.parentUuid ? byId.get(cur.parentUuid) : null;
  }
  return null;
}

// 文件回滚执行器。resolve 为 SDK 的 RewindFilesResult；检查点缺失等业务失败会 throw，
// 由路由层归类（旧会话没开过检查点 / 该消息后没改过文件 → 软失败）。
export async function rewindClaudeFiles({ sessionId, cwd, ctx, userUuid }) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const abort = new AbortController();
  const engineEnv = claudeEngineEnv(ctx);
  async function* silent() { await gate; }   // 保活输入流：不 yield 任何消息
  const q = query({
    prompt: silent(),
    options: {
      ...claudeCliOptions(),
      cwd,
      resume: sessionId,
      enableFileCheckpointing: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      maxTurns: 1,
      abortController: abort,
      // resume 同一个会话 id：通道开着的话它会以这个会话的身份登记、开收件箱（session-peers.mjs PEER_OFF_*）
      env: { ...(engineEnv || process.env), ...PEER_OFF_ENV },
      settings: JSON.stringify(PEER_OFF_SETTINGS),
    },
  });
  // 注意：不发消息的 resume query 不一定会发 init 事件（实测等 init 会白等超时）。
  // 策略：任何消息到达即视为就绪快进；否则 1.5s 宽限后直接尝试调用，
  // 「transport not ready」按未就绪重试，业务错误（无检查点等）原样上抛。
  let ready = false;
  const drain = (async () => { try { for await (const m of q) { ready = true; } } catch {} })();
  try {
    const t0 = Date.now();
    while (!ready && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 100));
    let lastErr = null;
    while (Date.now() - t0 < 20000) {
      try {
        return await q.rewindFiles(userUuid, { dryRun: false });
      } catch (e) {
        if (!/not ready/i.test(String((e && e.message) || e))) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastErr || new Error('回滚引擎初始化超时，请重试');
  } finally {
    // 进程收尸纪律：无论成败都放行输入流、掐掉子进程、等 drain 退出（各带超时兜底）。
    release();
    try { abort.abort(); } catch {}
    try { await Promise.race([q.return(), new Promise((r) => setTimeout(r, 3000))]); } catch {}
    await Promise.race([drain, new Promise((r) => setTimeout(r, 2000))]);
  }
}
