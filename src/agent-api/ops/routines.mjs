// 定时任务（Routines）：到点让 Claude 无人值守跑一段提示词（Gemini 引擎 2026-11-04 随 Gemini 对话下线）。经现成 /api/routines* 路由（校验、条数上限、额度闸都在那儿）。

import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { internalRequest, routeError } from '../internal.mjs';

defineGroup('routines', '定时任务', '到点让 Claude 无人值守跑的任务。');

const SCHEDULE_DESC = '{ type, …该类型的字段 }：daily（每天，hour + minute）| weekdays（工作日，hour + minute）| weekly（每周，days: [0=周日…6=周六] + hour + minute）| hourly（每小时，只有 minute）| once（一次性，at: 毫秒时间戳或 ISO 时间串，不带时区按服务器时区）| manual（只手动运行，没有别的字段）| cron（cron: 5 段表达式「分 时 日 月 周」，最多每小时一次）。hour 0-23 缺省 9，minute 0-59 缺省 0，按服务器所在时区；不认识的字段、越界的值直接报错。例：{"type":"daily","hour":9,"minute":0}、{"type":"weekly","days":[1,3],"hour":8,"minute":30}、{"type":"once","at":"2026-12-01T09:00"}、{"type":"cron","cron":"0 9 * * 1-5"}';
// 各类型认的字段与例子。weekday 是老数据的单个星期几（读回来的 weekly 也带着它），照收不宣传。
const SCHED_KEYS = { manual: [], once: ['at'], hourly: ['minute'], daily: ['hour', 'minute'], weekdays: ['hour', 'minute'], weekly: ['days', 'weekday', 'hour', 'minute'], cron: ['cron'] };
const SCHED_EXAMPLE = {
  manual: { type: 'manual' }, once: { type: 'once', at: '2026-12-01T09:00' }, hourly: { type: 'hourly', minute: 15 },
  daily: { type: 'daily', hour: 9, minute: 0 }, weekdays: { type: 'weekdays', hour: 8, minute: 30 },
  weekly: { type: 'weekly', days: [1, 3], hour: 8, minute: 30 }, cron: { type: 'cron', cron: '0 9 * * 1-5' },
};
// 接口层的频率校验。界面与老数据共用的 normSchedule（routine-schedule.mjs）为兼容是宽松兜底的：不认识的 type 当每天、
// 多余字段不管、越界夹紧、缺 hour 补 9——agent 传错（time:'08:30'、type:'weekday'、hour:25）就静默建成别的时间。
// 所以这里先严格查一遍、交给路由的是干净的对象；cron 表达式本身与一次性时间已过照旧由路由严格校验。
function scheduleArg(s) {
  const type = s && s.type;
  if (!Object.hasOwn(SCHED_KEYS, type)) throw new OpError('bad_args', `schedule.type ${type == null ? '没填' : `「${type}」不认识`}，只能是 ${Object.keys(SCHED_KEYS).join(' / ')}`, { hint: SCHEDULE_DESC });
  const keys = SCHED_KEYS[type];
  const hint = `${type} 的字段：${keys.filter((k) => k !== 'weekday').join('、') || '（没有）'}。例：${JSON.stringify(SCHED_EXAMPLE[type])}`;
  const bad = (msg) => { throw new OpError('bad_args', `schedule（${type}）${msg}`, { hint }); };
  const extra = Object.keys(s).filter((k) => k !== 'type' && !keys.includes(k));
  if (extra.length) bad(`不认识字段「${extra.join('」「')}」`);
  // 整数且在范围内（数字字符串也认）；越界报错，不夹紧
  const int = (what, v, lo, hi) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (!Number.isInteger(n) || n < lo || n > hi) bad(`的 ${what} 要是 ${lo}-${hi} 的整数，收到 ${JSON.stringify(v)}`);
    return n;
  };
  const out = { type };
  if (keys.includes('hour') && s.hour != null) out.hour = int('hour', s.hour, 0, 23);
  if (keys.includes('minute') && s.minute != null) out.minute = int('minute', s.minute, 0, 59);
  if (type === 'weekly') {
    if (s.days != null) {
      if (!Array.isArray(s.days) || !s.days.length) bad('的 days 要是非空数组，如 [1,3]（0=周日…6=周六）');
      out.days = s.days.map((d) => int('days', d, 0, 6));
    } else if (s.weekday != null) out.weekday = int('weekday', s.weekday, 0, 6);
    else bad('要带 days（星期几的数组，0=周日…6=周六）');
  }
  if (type === 'once') {
    const v = s.at;
    // 只写到日 / 月的 ISO 串 Date.parse 按 UTC 零点算（别的不带时区的写法都按本地），会静默差出时区那几个小时
    if (typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(v.trim())) bad(`的 at 要写到几点几分（如 2026-12-01T09:00），只写日期会按 UTC 零点算，收到 ${JSON.stringify(v)}`);
    const at = typeof v === 'number' ? v : typeof v !== 'string' ? NaN : /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v);
    if (!Number.isFinite(at)) bad(`的 at 要是毫秒时间戳或 ISO 时间串（如 2026-12-01T09:00），收到 ${JSON.stringify(v)}`);
    out.at = at;
  }
  if (type === 'cron') {
    if (typeof s.cron !== 'string' || !s.cron.trim()) bad('要带 cron 表达式字符串，如 "0 9 * * 1-5"');
    out.cron = s.cron;
  }
  return out;
}
const ENGINE = {
  model: { type: 'string', desc: '模型 id；不填用服务器默认' },
  effort: { type: 'string', desc: '思考强度（不支持 ultracode）' },
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
  ...(args.model !== undefined ? { model: args.model } : {}),
  ...(args.effort !== undefined ? { effort: args.effort } : {}),
});
const view = (r) => ({
  id: r.id, name: r.name, prompt: r.prompt, engine: 'claude',
  ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}),
  ...(r.retired === 'gemini' ? { retired: 'Gemini 引擎已下线，这条已停用；改用 Claude 要先编辑它' } : {}),
  ...(r.description ? { description: r.description } : {}),
  cwd: r.cwd || null, worktree: !!r.worktree, ...(r.branch ? { branch: r.branch } : {}), permissionMode: r.permissionMode || null, fast: !!r.fast, sessionMode: r.sessionMode || 'new',
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
  desc: '到点无人值守地跑 prompt。成员启用中的条数有上限。结果进会话列表。返回的 schedule 是规范化后的、nextRun 是下次运行时间（毫秒时间戳），建好后核对一眼是不是想要的时间。',
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
    const r = await internalRequest(env.identity, 'POST', '/api/routines', { name: args.name || '', prompt: args.prompt, schedule: scheduleArg(args.schedule), enabled: args.enabled, ...engineBody(args), ...codeBody(args) });
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
    for (const k of ['prompt', 'name', 'schedule', 'enabled']) if (args[k] !== undefined) body[k] = k === 'schedule' ? scheduleArg(args[k]) : args[k];
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

