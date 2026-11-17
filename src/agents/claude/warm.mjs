// 停放着的 CLI 进程（会话常驻、新会话预热）的登记表，与从外面关掉它们的入口。

import { statSync } from 'node:fs';
import { findGenBySession } from '../../runtime/gen.mjs';

// ---- 会话 CLI 常驻（2026-10-01，对齐官方桌面端的 WarmLifecycle）-----------------------
// 以前一轮 = 一次 query = 一个 CLI 进程：每条消息都现起 claude.exe + resume，光 spawn→init 就 2.6–5s
//（实测），桌面端则一个会话一个长命进程、空闲 30 分钟才关，续聊只等模型本身。现在一轮定局后
// CLI 不退：台账照常结清（closeTurn——对界面、别的设备、并发上限这轮都已结束），进程【停放】在这里，
// 同会话下一条消息若启动参数完全一致（warmSig：模型/effort/fast/提示词 append/扩展/MCP 开关/账号 token/cwd）
// 就直接推进同一个输入流开新一轮（warmTake，与挂起接力 handoff 同一套换 gen 手法）；不一致、
// 有待生效的回滚锚点、transcript 被别的写入者动过，一律关掉它冷起，与以前完全一样。
// 停放期顺带收输入建议（SDK promptSuggestions 在 result 后 7–14s 才来，输入流一关就丢——原先的
// 40s「挂等」就是这段的前身）。一份 transcript 不许两个 CLI：冷起前必须先关掉停放的那个（releaseWarm）。
export const SUGGEST_WAIT_MS = 40_000;
export const WARM_IDLE_MS = Math.max(0, Number(process.env.BRIDGE_CLAUDE_WARM_MS ?? 15 * 60_000) || 0);
const WARM_MAX = Math.max(1, Number(process.env.BRIDGE_CLAUDE_WARM_MAX ?? 4) || 4);   // 全服停放上限（每个常驻 ~320MB 工作集）
export const warmRuns = new Map();   // key|sid -> { sig, parkedAt, stat(), take(), close(), done }
export const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
// transcript 指纹：停放期间若有别的写入者（官方桌面端接力同一会话、手工编辑）动过它，活进程的内存历史就旧了。
export function warmStat(file) { try { const s = statSync(file); return s.size + ':' + s.mtimeMs; } catch { return ''; } }
export async function closeWarm(entry) {
  entry.close();
  await Promise.race([entry.done, sleep(5000)]);
}
// 关掉某会话停放的 CLI 并等它退干净（删会话、文件回滚这类要碰 transcript 的操作先调它）。
export async function releaseWarmClaude(key, sid) {
  if (!sid) return;
  // 刚回完 done、还在定局收尾的那一轮马上就要停放——等它停好再关，别让它关完之后又停进来。
  const fin = findGenBySession(key, sid);
  if (fin && !fin.done && fin.finalizing) { if (fin.hurry) fin.hurry(); await Promise.race([fin.settled, sleep(10_000)]); }
  const e = warmRuns.get(key + '|' + sid);
  if (e) await closeWarm(e);
}
// 关掉这个身份（ctx.key）停放的全部 CLI 与新会话预热进程，并等它们退干净（删号 / 停用 / 降档时
// runtime/account-lifecycle.mjs 调；不受「最近写过的会话」窗口限制）。返回关了几个。
export async function releaseWarmOf(key) {
  if (!key) return 0;
  const prefix = key + '|';
  const list = [...warmRuns.entries()].filter(([lk]) => lk.startsWith(prefix)).map(([, e]) => e);
  const sp = spareRuns.get(key);
  if (sp) { try { sp.close(); } catch {} }
  await Promise.all(list.map((e) => closeWarm(e).catch(() => {})));
  return list.length + (sp ? 1 : 0);
}
// ---- 新会话预热（2026-10-18，对齐官方桌面端的 spare 进程）------------------------------------
// 续聊有上面的停放，新会话第一条消息却仍要冷起：spawn + 工具/插件/MCP 握手 2.5–3s 全压在首字上。
// 前端在「新对话」输入框获得焦点/开始打字时打 POST /api/chat/prewarm（带与发送相同的选项）：服务端
// 提前跑一遍【没有消息】的 runClaudeChat——启动参数照常算、query 照常建、等初始化完成后停放在
// 第一轮之前（parkSpare）。真消息来了 warmSig 一致就走与续聊完全相同的 warmTake 接管，否则关掉冷起。
// 没有用 SDK 的 prewarm()/claim：它要求 MCP、钩子、canUseTool 在预热时定死，而 bridge 这些都是
// 每轮现建、闭包挂在本次 runClaudeChat 上的；这里整次调用一起提前，闭包天然跟着走。
// 只给主机 admin（非沙箱、非快照）：每个预热进程约 300MB，每个 caller key 至多一个。
export const SPARE_MS = Math.max(0, Number(process.env.BRIDGE_CLAUDE_SPARE_MS ?? 10 * 60_000) || 0);
export const spareRuns = new Map();  // ctx.key -> { sig, parkedAt, readyAt, touch(), take(), close() }
export function spareStatus(key) {
  const e = spareRuns.get(key);
  return e ? { parkedAt: e.parkedAt, readyAt: e.readyAt || 0 } : null;
}

// 超过全服上限：关掉停放最久的（不含刚登记的这个）。
export function evictWarm(keep) {
  const parked = [...warmRuns.values()].filter((e) => e !== keep).sort((a, b) => a.parkedAt - b.parkedAt);
  while (parked.length && warmRuns.size > WARM_MAX) {
    const e = parked.shift();
    console.log(`[claude] warm CLI ${e.lk.split('|').pop().slice(0, 8)} evicted (over ${WARM_MAX} parked)`);
    e.close();
  }
}
