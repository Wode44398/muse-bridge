// ctx.claude.ensureProject(path, { who, name }?)（八期，能力名 claude.ensureProject）：确保某个文件夹是这个人的 Claude 项目。
// 已经是（含默认工作空间）就直接返回；不是就建一个——走侧栏「新建项目」同一份代码（claude-projects.mjs 的 createProject：
// 路径授权、上限、落盘都在那里），建了推一帧 claude.projects 让在线的 Claude 侧栏重拉。只做加法：不改名、不删。
// who：身份上下文（list / handler 收到的那个），缺省服务器主机。→ { id, name, path, created }
import path from 'node:path';
import { createProject, listProjects } from '../claude-projects.mjs';
import { identityOfCtx } from '../agent-api/internal.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { busPublish } from '../runtime/bus.mjs';
import { samePath } from './workspace.mjs';

const HOST = Object.freeze({ kind: 'admin', user: null });

export async function ensureClaudeProject(p, { who, name } = {}) {
  const dir = typeof p === 'string' ? p.trim() : '';
  if (!dir || dir.length > 1024 || /[\u0000-\u001f\u007f]/.test(dir) || !path.isAbsolute(dir)) throw Object.assign(new Error('ctx.claude.ensureProject 要文件夹的绝对路径'), { status: 400 });
  const identity = who == null ? HOST : identityOfCtx(who);
  if (!identity) throw Object.assign(new Error('这个身份没有 Claude 项目（需要服务器主机或账号）'), { status: 403 });
  const c = contextFor(identity);
  if (!c.claudeProjects) throw Object.assign(new Error('这个身份没有 Claude 项目'), { status: 403 });
  const hit = listProjects(c.claudeProjects, c).find((x) => !x.quick && x.path && samePath(x.path, dir));
  if (hit) return { id: String(hit.id), name: String(hit.name || path.basename(dir)), path: hit.path, created: false };
  const made = createProject(c.claudeProjects, c, { path: dir, ...(typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, 80) } : {}) });
  try { busPublish(c.key, { type: 'claude.projects' }); } catch {}
  return { id: String(made.id), name: String(made.label || made.name || path.basename(dir)), path: made.path, created: true };
}
