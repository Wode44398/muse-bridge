// 给 agent 用的接口：操作注册表（单一真相）。
//
// 每个能力登记成一条「操作」：名字、说明、参数、权限、处理函数。三处都从这一张表出：
//   ① HTTP：GET|POST /agent/v1/<操作名>（agent-api/http.mjs）；
//   ② 手册：接口参考与 /agent 首页的操作目录（agent-api/manual.mjs 现场渲染）；
//   ③ Muse Bridge 自己的 Claude 会话：进程内 MCP 的 mcp__bridge__call 工具（mcp/bridge-tools.mjs）。
// 所以加一个能力只写一处，说明不会和实现脱节。处理函数只做薄封装，业务逻辑留在原模块里。
//
// 操作定义：
//   name      'group.verb'，URL 里原样出现
//   title     一句话（目录里显示）
//   desc      详细说明（何时用、注意什么、返回什么）——写给 agent 看
//   params    { 参数名: { type, required?, default?, enum?, min?, max?, desc } }
//             type ∈ string | integer | number | boolean | object | array | any
//   access    'read' 只读 | 'write' 会改东西 | 'danger' 删除/花钱/不可撤回——调用方应先征得用户同意
//   need      额外要求：能力名（principal.mjs 的 can()，如 'workspace.shell'）或 'agent:<id>'（该 agent 对调用者开着）
//   slow      可能跑很久（等对话）：HTTP 层会先回 200 再定期写空白保活
//   handler   async (ctx, args, env) => 数据（普通 JSON 对象）；出错抛 OpError
//   example   可选：一组示例参数（手册里展示）

import { can } from '../runtime/principal.mjs';

const OPS = new Map();
const GROUPS = new Map();   // group -> { title, desc }

export class OpError extends Error {
  // code：bad_args | unauthorized | forbidden | not_found | conflict | quota | unavailable | timeout | failed
  constructor(code, message, { hint = '', status = 0, data = null } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status || STATUS[code] || 500;
    this.data = data;
  }
}
const STATUS = { bad_args: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, quota: 429, unavailable: 503, timeout: 504, failed: 500 };

export function defineGroup(id, title, desc = '') { GROUPS.set(id, { id, title, desc }); }

export function defineOp(spec) {
  if (!spec || !/^[a-z]+(\.[a-z_]+)*$/.test(spec.name || '')) throw new Error('bad op name: ' + (spec && spec.name));
  if (OPS.has(spec.name)) throw new Error('duplicate op: ' + spec.name);
  if (typeof spec.handler !== 'function') throw new Error('op without handler: ' + spec.name);
  const op = {
    group: spec.name.includes('.') ? spec.name.split('.')[0] : 'core',
    access: 'read', need: [], params: {}, slow: false,
    ...spec,
  };
  OPS.set(op.name, op);
  return op;
}

// 目录里各组的先后（ops/index.mjs 定）；同组内按登记先后。没排进来的组垫底。
let groupOrder = [];
export function setGroupOrder(ids) { groupOrder = [...ids]; }
const rank = (g) => { const i = groupOrder.indexOf(g); return i < 0 ? 999 : i; };

export const getOp = (name) => OPS.get(name) || null;
export const allOps = () => [...OPS.values()].map((op, i) => [op, i]).sort((a, b) => rank(a[0].group) - rank(b[0].group) || a[1] - b[1]).map(([op]) => op);
export const allGroups = () => [...GROUPS.values()].sort((a, b) => rank(a.id) - rank(b.id));

// 只有登录身份（主机 / 账号）能用这套接口；分享与快照访客一律不行。
export const apiAllowed = (ctx) => !!ctx && (ctx.kind === 'admin' || ctx.kind === 'user');

// 这个调用者能不能用某个操作：返回 null（能）或一句原因。
export function whyNot(ctx, op) {
  if (!apiAllowed(ctx)) return '需要登录身份（主机或账号）';
  for (const n of op.need || []) {
    if (n.startsWith('agent:')) {
      const id = n.slice(6);
      if (!(ctx.agents || []).includes(id)) return `「${id}」对你没开（没装、被关了，或管理员没给你勾）`;
    } else if (!can(ctx, n)) {
      return NEED_LABEL[n] || `需要能力 ${n}`;
    }
  }
  return null;
}
const NEED_LABEL = {
  'workspace.shell': '需要有命令行权限的身份（主机或完全信任档）',
  'server.manage': '只有服务器主机能用',
  'users.manage': '只有服务器主机能用',
  'fs.anyPath': '只有服务器主机能用',
};

// ---- 参数校验与类型转换 ----
// GET 的查询串全是字符串：按声明的类型转。未声明的参数直接拒（打错名字比静默忽略好排查）。
function coerce(name, spec, v) {
  const bad = (msg) => { throw new OpError('bad_args', `参数 ${name}：${msg}`); };
  switch (spec.type) {
    case 'string':
      if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
      if (typeof v !== 'string') bad('应为字符串');
      if (spec.max != null && v.length > spec.max) bad(`太长（上限 ${spec.max} 字符）`);
      break;
    case 'integer':
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) bad('应为数字');
      if (spec.type === 'integer' && !Number.isInteger(n)) bad('应为整数');
      if (spec.min != null && n < spec.min) bad(`不能小于 ${spec.min}`);
      if (spec.max != null && n > spec.max) bad(`不能大于 ${spec.max}`);
      v = n;
      break;
    }
    case 'boolean':
      if (v === 'true' || v === '1' || v === 1) v = true;
      else if (v === 'false' || v === '0' || v === 0 || v === '') v = false;
      if (typeof v !== 'boolean') bad('应为 true / false');
      break;
    case 'object':
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { bad('应为 JSON 对象'); } }
      if (!v || typeof v !== 'object' || Array.isArray(v)) bad('应为对象');
      break;
    case 'array':
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = v.split(',').map((s) => s.trim()).filter(Boolean); } }
      if (!Array.isArray(v)) bad('应为数组');
      break;
    default: break;   // any
  }
  if (spec.enum && !spec.enum.includes(v)) bad(`只能是 ${spec.enum.join(' / ')} 之一`);
  return v;
}

export function validateArgs(op, raw) {
  const args = {};
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const k of Object.keys(input)) {
    if (!op.params[k]) throw new OpError('bad_args', `${op.name} 没有参数「${k}」`, { hint: '可用参数：' + (Object.keys(op.params).join('、') || '（无）') });
  }
  for (const [k, spec] of Object.entries(op.params)) {
    const v = input[k];
    if (v === undefined || v === null || (v === '' && spec.type !== 'string')) {
      if (spec.required) throw new OpError('bad_args', `缺少必填参数「${k}」`, { hint: spec.desc || '' });
      if (spec.default !== undefined) args[k] = spec.default;
      continue;
    }
    args[k] = coerce(k, spec, v);
  }
  return args;
}

// 执行一个操作。ctx = contextFor(身份)；env = { via:'http'|'mcp', origin, signal, sessionId? }。
export async function callOp(ctx, name, rawArgs, env = {}) {
  const op = getOp(name);
  if (!op) throw new OpError('not_found', `没有操作「${name}」`, { hint: '操作目录见 GET /agent；手册见 manual 操作' });
  const why = whyNot(ctx, op);
  if (why) throw new OpError(apiAllowed(ctx) ? 'forbidden' : 'unauthorized', why);
  const args = validateArgs(op, rawArgs);
  const data = await op.handler(ctx, args, env);
  return data === undefined ? {} : data;
}

// ---- 目录（给 JSON 消费者与手册） ----
export function paramSchema(op) {
  const properties = {};
  const required = [];
  for (const [k, s] of Object.entries(op.params)) {
    const p = { type: s.type === 'any' ? undefined : s.type, description: s.desc || undefined };
    if (s.enum) p.enum = s.enum;
    if (s.default !== undefined) p.default = s.default;
    if (s.min != null) p[s.type === 'string' ? 'minLength' : 'minimum'] = s.min;
    if (s.max != null) p[s.type === 'string' ? 'maxLength' : 'maximum'] = s.max;
    properties[k] = JSON.parse(JSON.stringify(p));
    if (s.required) required.push(k);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

export function catalog(ctx) {
  return allOps().map((op) => {
    const why = ctx ? whyNot(ctx, op) : null;
    return {
      name: op.name, group: op.group, title: op.title, description: op.desc || '',
      access: op.access, slow: !!op.slow,
      params: paramSchema(op),
      ...(op.returns ? { returns: op.returns } : {}),
      ...(op.example ? { example: op.example } : {}),
      ...(ctx ? { available: !why, ...(why ? { unavailableReason: why } : {}) } : {}),
    };
  });
}
