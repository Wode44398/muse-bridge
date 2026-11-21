// 全服忙闲的落盘信号 live-runs.json（2026-11-20）：给宿主机上的「空闲时重启」脚本（scripts/idle-restart.ps1）看。
//
// 以前那些脚本看的是 inflight-runs.json——那是 Claude 轮的落盘台账（runtime/inflight.mjs，给重启后续跑用），
// 只记 Claude：只有 agy / Codex / dimensio 在跑时它是 []，脚本判「空闲」照样 restart-server，把它们腰斩。
// 这里按 agent 分开记全部在跑的轮：gen 表（Claude / Codex / agy）+ gen 表外的（dimensio 的 harness 子进程，经
// service-control 的 refreshExtraLive 现问）。内容变了就写；不变也每 30 秒刷一次 at，脚本据此认出「服务端还活着、数是新的」
//（at 超过 90 秒没动 = 服务端卡死 / 退了，当忙处理，不拿旧数动手）。
//
//   { at, pid, total, byAgent: { claude, codex, agy, dimensio } }
import { writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { listGens } from './gen.mjs';
import { refreshExtraLive } from './service-control.mjs';

const TICK_MS = 5_000;
const HEARTBEAT_MS = 30_000;

/** gen 表的 key 前缀 → agent（codex: / agy: 是各自扩展的前缀，其余都是 Claude 的身份 key）。 */
export function agentOfGenKey(key) {
  const k = String(key || '');
  if (k.startsWith('codex:')) return 'codex';
  if (k.startsWith('agy:')) return 'agy';
  return 'claude';
}

/** 眼下的忙闲快照（dimensio 传进来：异步现问的结果）。 */
export function liveRunsSnapshot(dimensio = 0, now = Date.now()) {
  const byAgent = { claude: 0, codex: 0, agy: 0, dimensio: Math.max(0, Number(dimensio) || 0) };
  for (const g of listGens()) if (!g.done) byAgent[agentOfGenKey(g.key)] += 1;
  const total = byAgent.claude + byAgent.codex + byAgent.agy + byAgent.dimensio;
  return { at: now, pid: process.pid, total, byAgent };
}

let timer = null;
export function startLiveRunsFile(root) {
  if (timer) return;
  const file = path.join(root, 'live-runs.json');
  let last = '';
  let lastAt = 0;
  let ticking = false;
  const write = (snap) => {
    const body = JSON.stringify(snap.byAgent) + snap.total;
    if (body === last && snap.at - lastAt < HEARTBEAT_MS) return;
    last = body; lastAt = snap.at;
    const tmp = file + '.tmp';
    try { writeFileSync(tmp, JSON.stringify(snap)); renameSync(tmp, file); } catch {}
  };
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try { write(liveRunsSnapshot(await refreshExtraLive())); } catch {} finally { ticking = false; }
  };
  void tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
}
