// 工具中枢 · 项目记忆：Antigravity 会话读写所属项目的共享记忆（复用 Claude 项目对话的 mcp/project-tools.mjs，
// 存在 <dataDir>/project-memory/<项目 id>/，MEMORY.md 是索引）。
//
// agy 的工具清单整个进程只取一次、不能按会话增减，所以每个会话都有一个「项目」：
//   · 会话属于某个 Antigravity 项目（会话元数据 projectId）→ agy-<项目 id>，同一项目的会话共用；
//   · 没挂项目 → 按规整后的工作目录 agy-cwd-<哈希>，同一个文件夹里的会话共用。
// 只碰 bridge 自己的数据目录，没有对外副作用。

import { createHash } from 'node:crypto';
import path from 'node:path';
import { makeProjectMcp } from '@bridge/core/mcp/project-tools.mjs';
import { foldAgyPath } from '../../paths.mjs';
import { getSessionMeta } from '../../sessions.mjs';

const SAFE_ID = /^[A-Za-z0-9-]{1,80}$/;

/** 一个 agy 会话的项目记忆 id（稳定：同项目 / 同目录的会话拿到同一个）；拿不到返回 ''。 */
export function agyMemoryProjectId(ctx, gen) {
  const sid = gen?.sessionId || '';
  const meta = sid ? getSessionMeta(ctx?.agyDir, sid) : null;
  const pid = String(meta?.projectId || gen?.projectId || '');
  if (pid && SAFE_ID.test(pid)) return 'agy-' + pid;
  const cwd = String(meta?.cwd || gen?.cwd || '');
  if (!cwd) return '';
  const folded = foldAgyPath(path.resolve(cwd));
  return 'agy-cwd-' + createHash('sha1').update(folded).digest('hex').slice(0, 16);
}

export const PROJECT_GROUP = Object.freeze({
  key: 'project',
  setting: 'projectMemory',
  available: (ctx) => ctx?.kind === 'admin' && !!ctx?.dataDir,
  build: ({ ctx, getGen }) => makeProjectMcp({ ctx, projectId: () => agyMemoryProjectId(ctx, getGen && getGen()) }),
});
