// 彻底删除一个 Antigravity 会话（不可恢复）：
//   1. 先在侧车表里换成「已删除」墓碑——列表、详情、搜索、续聊立刻都挡掉（agy 进程没退出前 session/list 可能还列着它）；
//   2. 在跑就停：清掉排队，按停止，等这一轮收尾（有上限，不卡死接口）；
//   3. 关掉并忘掉 ACP 挂载（主进程与桌面版存储进程都问一遍）；
//   4. 删 agy 自己的文件（purge-files.mjs，删不掉的进待清理清单，下次 agy 进程 spawn 前清）；
//   5. 删 bridge 这边的侧车：工具返回内容、设备连接、搜索索引条目、已收尾的 gen 缓存。

import { getLiveGens, getGens, clearCurrentGenIfMatches } from '@bridge/core/runtime/gen.mjs';
import { setAgentDeviceLink } from '@bridge/core/runtime/agent-device-links.mjs';
import { acpClientsOf, acpFor, agyDataDirsOf } from './acp/index.mjs';
import { agyGenKey } from './presence.mjs';
import { drainQueue } from './queue.mjs';
import { markSessionDeleted, isSessionDeleted } from './sessions.mjs';
import { dropToolOutputs } from './tool-outputs.mjs';
import { forgetAgySearchEntry } from './transcript-search.mjs';
import { isAgySessionId, purgeSessionFiles } from './purge-files.mjs';

const STOP_WAIT_MS = 8_000;
const CLOSE_WAIT_MS = 5_000;

const within = (p, ms) => Promise.race([
  Promise.resolve(p).catch(() => {}),
  new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }),
]);

/**
 * 返回 { ok, sessionId, stopped, removed:[路径], pending:[删不掉、等下次 spawn 前清的路径] }。
 * id 不是 uuid 形状直接拒（status 400）。deps 供测试注入（数据目录、rm）。
 */
export async function deleteAgySession(ctx, sessionId, deps = {}) {
  const id = String(sessionId || '').trim();
  if (!isAgySessionId(id)) throw Object.assign(new Error('会话 id 格式不对'), { status: 400 });
  const agyDir = ctx?.agyDir;
  if (!agyDir) throw Object.assign(new Error('缺少 Antigravity 数据目录'), { status: 500 });

  markSessionDeleted(agyDir, id);

  // 在跑：排着的话不再接着发，停掉这一轮并等它收尾（收尾时写元数据会被墓碑挡掉）
  const genKey = agyGenKey(ctx.key || 'admin');
  drainQueue(genKey, id);
  let stopped = false;
  const live = getLiveGens(genKey).filter((g) => g.sessionId === id);
  for (const g of live) {
    stopped = true;
    try { g.abort.abort(); } catch {}
  }
  if (live.length) await within(Promise.all(live.map((g) => g.settled)), STOP_WAIT_MS);
  drainQueue(genKey, id);

  const clients = new Set([...acpClientsOf(ctx), acpFor(ctx, id)]);
  for (const c of clients) {
    try { if (c.hasActiveTurn?.(id)) c.cancelSession(id); } catch {}
    await within(c.closeSession?.(id), CLOSE_WAIT_MS);
    try { c.forgetSession?.(id); } catch {}
  }

  const dirs = deps.dataDirs || agyDataDirsOf(ctx);
  const { removed, pending } = purgeSessionFiles(id, dirs, { file: deps.pendingFile, rm: deps.rm });

  dropToolOutputs(agyDir, id);
  try { setAgentDeviceLink(ctx, 'agy', id, ''); } catch {}
  forgetAgySearchEntry(ctx, id);
  for (const g of [...getGens(genKey)]) {
    if (g.sessionId === id && g.done) clearCurrentGenIfMatches(genKey, g);
  }

  return { ok: true, sessionId: id, stopped, removed, pending };
}

/** POST /api/chat 的 agy 分支外面套一层：已删除的会话不许续聊（否则 agy 会把它重新写活）。 */
export function rejectDeletedChat(handler) {
  return (req, res, opts = {}) => {
    if (opts.sessionId && isSessionDeleted(opts.ctx?.agyDir, opts.sessionId)) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '这个对话已经删除' }));
      return;
    }
    return handler(req, res, opts);
  };
}
