// 同机 agent 实例（dimensio）调核心运行时（共享终端 / 共享浏览器）的两条内部接口共用的认法与门禁：
//   · 凭据：bridge 拉起实例时给的同机凭据（agent-api/instance-auth.mjs：主机密钥 → 管理员，dvt1 按人令牌 → 那个成员），只认本机直连；
//   · 只认 dimensio：别的实例（codex / agy）在进程内就有这两样，不走这里；
//   · 要有命令行（ctx.shell）且对应插件开着——与 Claude / agy 拿终端、浏览器的条件一致（agents/claude/plan.mjs、agy 的 hub）；
//   · 工作空间过 authorizeProjectPath：与面板的 dockCtx 同一道闸，返回的规范路径就是面板那边池键里的路径。
import { readBody } from '../../runtime/body.mjs';
import { instanceCaller } from '../../agent-api/instance-auth.mjs';
import { authorizeProjectPath } from '../../project-paths.mjs';
import { pluginOn } from '../../plugins/state.mjs';

export const json = (res, code, obj) => {
  if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

const AGENTS = new Set(['dimensio']);
const PLUGIN_NAME = { terminal: '共享终端', browser: '内置浏览器' };

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1].trim() : '';
}

/**
 * 认调用方、读请求体、圈工作空间。失败时已回好响应，返回 null；成功返回 { ctx, ws, body }。
 * plugin：'terminal' | 'browser'。
 */
export async function runtimeCaller(req, res, { plugin, maxBody = 256 * 1024 }) {
  const who = instanceCaller(req, bearer(req));
  // 不是同机实例凭据、或不是本机直连：当作不存在
  if (!who) { json(res, 404, { error: 'not found' }); return null; }
  const agent = String(who.instance || '');
  if (!AGENTS.has(agent)) { json(res, 403, { error: `${agent || '这个调用方'} 不能用这个接口`, code: 'agent' }); return null; }
  if (!pluginOn(plugin)) { json(res, 403, { error: `「${PLUGIN_NAME[plugin] || plugin}」插件没开`, code: 'plugin_off' }); return null; }
  const ctx = who.ctx;
  if (!ctx.shell) { json(res, 403, { error: '该功能仅对完整权限用户开放', code: 'no_shell' }); return null; }
  let body;
  try { body = JSON.parse(await readBody(req, maxBody)); } catch { json(res, 400, { error: 'bad json' }); return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { json(res, 400, { error: 'bad json' }); return null; }
  // 不给 ws 时 authorizeProjectPath 会退回 ctx.cwd：实例必须说清是哪个工作空间，免得落到别的池键上
  if (typeof body.ws !== 'string' || !body.ws.trim()) { json(res, 400, { error: '需要 ws（工作空间路径）', code: 'ws' }); return null; }
  let ws;
  try { ws = authorizeProjectPath(ctx, body.ws); } catch (e) { json(res, e?.status || 403, { error: e?.message || String(e), code: 'ws' }); return null; }
  return { ctx, ws, body };
}

/** 请求方断开（实例那边的工具被停止、超时）就中止：res 的 close 在正常写完之后也会触发，所以看 writableEnded。 */
export function abortOnClose(res) {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  return ac.signal;
}
