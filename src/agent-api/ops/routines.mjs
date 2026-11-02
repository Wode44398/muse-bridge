// 定时任务（Routines）：到点让 Claude 或 Gemini 无人值守跑一段提示词。经现成 /api/routines* 路由（校验、条数上限、额度闸都在那儿）。

import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { internalRequest, routeError } from '../internal.mjs';

defineGroup('routines', '定时任务', '到点自动跑的任务（Claude 或 Gemini，无人值守）。');

const SCHEDULE_DESC = '{ type: daily（每天）| weekdays（工作日）| weekly（每周，配 days: [0=周日…6=周六]）| hourly（每小时，只看 minute）| once（一次性，配 at: 毫秒时间戳）| manual（只手动运行）| cron（配 cron: 5 段表达式「分 时 日 月 周」，最多每小时一次）, hour: 0-23, minute: 0-59 }，按服务器所在时区';
const ENGINE = {
  engine: { type: 'string', enum: ['claude', 'gemini'], desc: '谁来跑：claude（默认，工具最全）或 gemini（要 Vertex 扩展）' },
  model: { type: 'string', desc: '模型 id；不填用服务器默认' },
  effort: { type: 'string', desc: 'Claude 的思考强度（不支持 ultracode）或 Gemini 的思考档' },
  search: { type: 'boolean', desc: '只对 Gemini：联网搜索' },
};
// Code 侧设置（只对 Claude）：在哪个文件夹里跑、每次开 worktree、权限模式、会话方式、跑完通知
const CODE = {
  description: { type: 'string', max: 300, desc: '一句话说明（给人看）' },
  cwd: { type: 'string', desc: '工作文件夹的绝对路径；空 = 默认工作空间' },
  worktree: { type: 'boolean', desc: '每次运行先从仓库切一个新 git worktree 再干活（文件夹须是 git 仓库）' },
  branch: { type: 'string', desc: '配合 worktree：从哪个分支切；空 = 按设置' },
  permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'], desc: '权限模式；空 = 设置默认。default / acceptEdits 遇到要批准的操作会停下来等人' },
  fast: { type: 'boolean', desc: 'Fast 模式（模型支持时）' },
  sessionMode: { type: 'string', enum: ['new', 'continue'], desc: 'new = 每次新会话（默认）；continue = 接着上次那个会话往下聊' },
  notify: { type: 'boolean', desc: '每次跑完给打开着的 bridge 发通知' },
};
const codeBody = (args) => Object.fromEntries(Object.keys(CODE).filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
const engineBody = (args) => ({
  ...(args.engine ? { agent: args.engine === 'gemini' ? 'vertex' : 'claude' } : {}),
  ...(args.model !== undefined ? { model: args.model } : {}),
  ...(args.effort !== undefined ? { effort: args.effort } : {}),
  ...(args.search !== undefined ? { search: args.search } : {}),
});
const view = (r) => ({
  id: r.id, name: r.name, prompt: r.prompt, engine: r.agent === 'vertex' ? 'gemini' : 'claude',
  ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}), ...(r.agent === 'vertex' ? { search: !!r.search } : {}),
  ...(r.description ? { description: r.description } : {}),
  ...(r.agent !== 'vertex' ? { cwd: r.cwd || null, worktree: !!r.worktree, ...(r.branch ? { branch: r.branch } : {}), permissionMode: r.permissionMode || null, fast: !!r.fast, sessionMode: r.sessionMode || 'new' } : {}),
  notify: !!r.notify,
  schedule: r.schedule, enabled: !!r.enabled, nextRun: r.nextRun || null,
  last: r.lastRun ? { at: r.lastRun, status: r.lastStatus || null, preview: r.lastPreview || '', ...(r.lastSessionId ? { sessionId: r.lastSessionId } : {}) } : null,
  runs: (r.runs || []).slice(0, 5).map((x) => ({ at: x.at, trigger: x.trigger, status: x.status, ...(x.sessionId ? { sessionId: x.sessionId } : {}), ...(x.preview ? { preview: x.preview } : {}) })),
});
function fail(r, what) {
  const msg = routeError(r);
  const code = r.status === 404 ? 'not_found' : r.status === 403 ? 'forbidden' : r.status === 429 ? 'quota' : r.status === 400 ? 'bad_args' : 'failed';
  throw new OpError(code, what + '：' + msg);
}

defineOp({
  name: 'routines.list', title: '列出定时任务',
  desc: '每条带下次运行时间与上次结果（状态、前 200 字预览、Claude 的结果会话 id——用 sessions.read 看全文）。running 是此刻正在跑的 id。',
  handler: async (ctx, args, env) => {
    const r = await internalRequest(env.identity, 'GET', '/api/routines');
    if (r.status !== 200 || !r.json) fail(r, '列出');
    return { routines: (r.json.routines || []).map(view), running: r.json.running || [] };
  },
});

defineOp({
  name: 'routines.create', title: '新建定时任务',
  desc: '到点无人值守地跑 prompt。成员启用中的条数有上限。结果：Claude 的进会话列表，Gemini 的进 Gemini 对话历史。',
  access: 'write',
  params: {
    prompt: { type: 'string', required: true, max: 20_000, desc: '到点要执行的内容（写清楚产出放哪）' },
    name: { type: 'string', max: 120 },
    schedule: { type: 'object', required: true, desc: SCHEDULE_DESC },
    enabled: { type: 'boolean', default: true },
    ...ENGINE,
    ...CODE,
  },
  example: { name: '早间新闻', prompt: '整理今天的科技新闻，写进 notes/新闻/今天日期.md', schedule: { type: 'daily', hour: 8, minute: 30 } },
  handler: async (ctx, args, env) => {
    const r = await internalRequest(env.identity, 'POST', '/api/routines', { name: args.name || '', prompt: args.prompt, schedule: args.schedule, enabled: args.enabled, ...engineBody(args), ...codeBody(args) });
    if (r.status !== 200 || !r.json?.ok) fail(r, '新建');
    return { routine: view(r.json.routine) };
  },
});

defineOp({
  name: 'routines.update', title: '修改 / 启停定时任务',
  desc: '只改传了的字段。enabled=false 停用、true 启用。',
  access: 'write',
  params: {
    id: { type: 'string', required: true },
    prompt: { type: 'string', max: 20_000 }, name: { type: 'string', max: 120 },
    schedule: { type: 'object', desc: SCHEDULE_DESC }, enabled: { type: 'boolean' },
    ...ENGINE,
    ...CODE,
  },
  handler: async (ctx, args, env) => {
    const body = { id: args.id, ...engineBody(args), ...codeBody(args) };
    for (const k of ['prompt', 'name', 'schedule', 'enabled']) if (args[k] !== undefined) body[k] = args[k];
    const r = await internalRequest(env.identity, 'POST', '/api/routines/update', body);
    if (r.status !== 200 || !r.json?.ok) fail(r, '修改');
    return { routine: view(r.json.routine) };
  },
});

defineOp({
  name: 'routines.run', title: '立即运行一次',
  desc: '不等结果就返回；之后用 routines.list 看 last（Claude 的结果会话可用 chat.wait 等）。',
  access: 'write',
  params: { id: { type: 'string', required: true } },
  handler: async (ctx, args, env) => {
    const r = await internalRequest(env.identity, 'POST', '/api/routines/run', { id: args.id });
    if (r.status !== 200 || !r.json?.ok) fail(r, '运行');
    return { id: args.id, started: !r.json.already, ...(r.json.already ? { note: '它已经在跑了' } : {}) };
  },
});

defineOp({
  name: 'routines.delete', title: '删除定时任务',
  access: 'danger',
  params: { id: { type: 'string', required: true } },
  handler: async (ctx, args, env) => {
    const r = await internalRequest(env.identity, 'POST', '/api/routines/delete', { id: args.id });
    if (r.status !== 200 || !r.json?.ok) fail(r, '删除');
    return { id: args.id, deleted: true };
  },
});

