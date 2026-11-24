// ctx.claude.memoryDir(path, { who }?) / ctx.claude.memoryInfo(path, { who }?)：某个工作目录的 Claude 记忆目录在哪、有没有东西。
// 找法与工作台「记忆」卡同一份（runtime/memory-graph.mjs 的 resolveMemoryDir，照 Claude Code 的 autoMemoryDirectory 规则）。
// 只给位置与篇数，不读内容——要读内容插件自己读（它本来就在服务器上）。
// who：身份上下文（list / handler 收到的那个）；缺省按服务器主机算（主机的 Claude 配置目录）。
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { resolveMemoryDir } from '../runtime/memory-graph.mjs';

const COUNT_CAP = 2000;
const HOST = Object.freeze({ kind: 'admin', configDir: null });

function absOrNull(p) {
  if (typeof p !== 'string') return null;
  const s = p.trim();
  if (!s || s.length > 1024 || /[\u0000-\u001f\u007f]/.test(s) || !path.isAbsolute(s)) return null;
  return path.resolve(s);
}
const idOf = (who) => (who && typeof who === 'object' && typeof who.kind === 'string' ? who : HOST);

/** → 记忆目录的绝对路径（目录不存在也给算出来的路径）；path 不是绝对路径 → null。 */
export async function claudeMemoryDir(p, { who } = {}) {
  const ws = absOrNull(p);
  if (!ws) return null;
  try { return (await resolveMemoryDir(idOf(who), ws))?.dir || null; } catch { return null; }
}

/** → { dir, exists, index（MEMORY.md 在不在）, files（目录第一层的 .md 数，封顶 2000） } | null */
export async function claudeMemoryInfo(p, opts = {}) {
  const dir = await claudeMemoryDir(p, opts);
  if (!dir) return null;
  let ents = null;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch {}
  if (!ents) return { dir, exists: false, index: false, files: 0 };
  let files = 0;
  let index = false;
  for (const e of ents) {
    if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
    if (e.name === 'MEMORY.md') index = true;
    if (files < COUNT_CAP) files++;
  }
  return { dir, exists: true, index, files };
}
