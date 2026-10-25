// 身份抽象层：owner 键、actor / scope、组、角色与能力、路径边界、终端 / 浏览器池的键、会话引用。
//
// 背景（开源路线第五节「场景三：现在要遵守的约束与最小预留」）：今天的多用户模型是
// 「一个身份 = 一个目录 = 一把 owner 键 = 一个记账人 = 一道单根围栏」。将来的团队形态要把这个等式拆开
// （组、共享空间、查看与接手别人的会话、按组分配凭据），难改的是那些正在扩散成数据与接口契约的假设。
// 所以现在先把这些概念收口到这里——【只是约定，今天的行为一字不变】：
//   · owner 键只在这里生成与解析：'admin'（主机身份）/ 'u:<账号>' / 's:<分享令牌>' / 'c:<快照令牌>'，
//     'g:<组 id>' 预留给组（事件总线、台账里的组分区都用这个前缀）；
//   · ctx 上分开 actor（谁做的）与 scope（数据和池归谁）；今天两者都等于 ctx.key，
//     只有管理员代聊时 actor 是 'admin'、scope 是被代的那个人。记谁的账不看 scope，以 quota.billingUser 为准
//     （快照访客那一轮 scope 是 'c:<令牌>'，账记给铸快照的人）；
//   · 一个身份可以属于若干组（ctx.groups）；今天恒为空；
//   · 管理权按能力判断（can），不再新增 kind === 'admin' 分支；
//   · 路径边界统一走 allowedRoots(ctx)，返回一组根（今天沙箱身份只有 [ctx.cwd]）；
//   · 终端与无头浏览器的池子按（属主, 工作空间）键控；
//   · 持久化的会话引用写成（属主, sessionId）。
// 纯函数，只依赖 node:path 的语义（不读配置、不碰磁盘），任何模块都能放心 import。
// 约束全文见 docs/ARCHITECTURE.md「贡献者必须遵守的约束」。

// ── owner 键 ────────────────────────────────────────────────────────────────
export const HOST_OWNER = 'admin';
const PREFIX_BY_KIND = Object.freeze({ user: 'u', share: 's', snap: 'c', group: 'g' });
const KIND_BY_PREFIX = Object.freeze({ u: 'user', s: 'share', c: 'snap', g: 'group' });
export const OWNER_KINDS = Object.freeze(['admin', ...Object.keys(PREFIX_BY_KIND)]);

// 生成 owner 键。kind ∈ OWNER_KINDS；除 admin 外都要非空 id。
export function ownerKey(kind, id = '') {
  if (kind === 'admin') return HOST_OWNER;
  const p = PREFIX_BY_KIND[kind];
  if (!p) throw new TypeError(`未知的 owner 种类：${kind}`);
  const s = String(id ?? '');
  if (!s) throw new TypeError(`owner 键缺少 id（${kind}）`);
  return `${p}:${s}`;
}

// 解析 owner 键 → { kind, id }；认不出返回 null。
export function parseOwnerKey(key) {
  const k = String(key ?? '');
  if (k === HOST_OWNER) return { kind: 'admin', id: '' };
  if (k.length < 3 || k[1] !== ':') return null;
  const kind = KIND_BY_PREFIX[k[0]];
  return kind ? { kind, id: k.slice(2) } : null;
}

// 给人看的属主名：主机 = 'admin'，其余 = id（账号名 / 令牌 / 组 id）。认不出的键按以前各处手写的
// key.slice(2) 处理，输出与改动前逐字一致。
export function ownerLabel(key) {
  const p = parseOwnerKey(key);
  if (!p) return String(key ?? '').slice(2);
  return p.kind === 'admin' ? HOST_OWNER : p.id;
}

// 组的 owner 键（预留）：事件总线的 'g:<组>' 分区、将来组台账的属主都用它。
export const groupKey = (id) => ownerKey('group', id);

// ── actor / scope / groups ─────────────────────────────────────────────────
const NO_GROUPS = Object.freeze([]);

// 谁做的（审计、代发标记用）。没有 actor 字段的老 ctx 回落到 key。
export function actorOf(ctx) { return String((ctx && (ctx.actor || ctx.key)) || ''); }
// 数据归谁、终端 / 浏览器池按谁分。没有 scope 字段的老 ctx 回落到 key。
// 不等于计费人：快照访客的 scope 是 'c:<令牌>'，那一轮的账记给铸快照的人（quota.billingUser）。
export function scopeOf(ctx) { return String((ctx && (ctx.scope || ctx.key)) || ''); }
// 这个身份属于哪些组（组 id 数组）。今天恒为空。
export function groupsOf(ctx) { return ctx && Array.isArray(ctx.groups) ? ctx.groups : NO_GROUPS; }

// contextFor 的出口：给 ctx 补 actor / scope / groups。scope 恒等于 key；actor 默认等于 key，
// 只有「没有本人请求」的入口（管理员代聊）在 identity 上带 actor，把「是谁发起的」留下来。
// identity.actor 只由服务端代码设置（identify() 从不读请求里的这个字段）。
export function withPrincipal(ctx, identity) {
  if (!ctx) return ctx;
  ctx.scope = ctx.key;
  ctx.actor = (identity && typeof identity.actor === 'string' && identity.actor) || ctx.key;
  ctx.groups = NO_GROUPS;
  return ctx;
}

// ── 角色与能力 ──────────────────────────────────────────────────────────────
// 角色（预留）：对标 Team / Enterprise 的分级。owner = 服主（今天就是主机身份），admin = 将来的管理员账号，
// member = 普通成员，guest = 分享 / 快照访客。users.json 的 role 字段预留，今天不读也不写——
// 缺省一律 member，能力判断今天也不看角色（见 can），手改 users.json 不会提权。
export const ROLES = Object.freeze(['owner', 'admin', 'member', 'guest']);
export function roleOf(ctx) {
  if (!ctx) return 'guest';
  if (ctx.kind === 'admin') return 'owner';
  if (ctx.kind === 'user') return 'member';
  return 'guest';
}

// 能力表。今天每一项都等价于改动前的判断：主机身份拥有全部管理能力；workspace.shell = 有命令行（完全信任档，存储值仍是 'pro'）。
// 新代码判断管理权写 can(ctx, 'server.manage') 这类，不再新增 kind === 'admin' 分支；
// 将来按角色 / 组策略算，只改这里。未知能力一律拒绝。
const HOST_ONLY = new Set([
  'server.manage',     // 服务控制、公网访问、扩展与模块
  'users.manage',      // 账号、邀请、档位、额度
  'pool.manage',       // 号池与换号
  'data.viewOthers',   // 查看别人的会话与数据（要写审计）
  'chat.asOthers',     // 代别人聊天 / 答审批（要写审计）
  'devices.manageAll', // 管理所有人的设备
  'fs.anyPath',        // 选择任意本地目录做项目
]);
export const CAPABILITIES = Object.freeze([...HOST_ONLY, 'workspace.shell']);
export function can(ctx, cap) {
  if (!ctx) return false;
  if (cap === 'workspace.shell') return !!ctx.shell;
  if (HOST_ONLY.has(cap)) return ctx.kind === 'admin';
  return false;
}

// ── 路径边界 ────────────────────────────────────────────────────────────────
// 这个身份能触及的根目录：null = 不设边界（主机身份，本就有整机命令行）；否则落在任意一个根之内即可。
// 今天沙箱身份只有一个根 ctx.cwd（自己的空间，或这一轮选的项目目录）。将来的组空间
// （<usersRoot>/_groups/<组 id>/，对所有成员同一个绝对路径，不软链进个人目录）追加在这里，调用方不用改。
export function allowedRoots(ctx) {
  if (!ctx) return [];
  if (ctx.kind === 'admin') return null;
  return ctx.cwd ? [ctx.cwd] : [];
}

// 多根围栏：check(root) 对单个根给出拒绝原因（字符串）或 null。任意一个根放行即放行；都拒绝时回第一个原因。
// roots 为 null（不设边界）直接放行；空数组（没有 cwd 的异常 ctx）交给 check(undefined)，与改动前传 ctx.cwd 的结果一致。
// 命令行这类「一条命令引用多处路径」的检查也按单根判：所有引用都落在同一个根里才放行（比并集更严，不会放宽）。
export function fenceViolation(roots, check) {
  if (roots == null) return null;
  const list = roots.length ? roots : [undefined];
  let first = null;
  for (const r of list) {
    const v = check(r);
    if (!v) return null;
    if (first == null) first = v;
  }
  return first;
}

// ── 终端 / 无头浏览器池的键 ─────────────────────────────────────────────────
// 池子按（属主, 工作空间）键控：两个人进了同一个目录（将来的共享空间），也接不到对方的 shell 和网站登录态。
// 池函数的 ws 参数可以是路径（老调用方），也可以是 poolRef(ctx, 路径)。属主取 scope（数据归谁）。
export function poolRef(ctxOrOwner, ws) {
  const owner = typeof ctxOrOwner === 'string' ? ctxOrOwner : scopeOf(ctxOrOwner);
  return { ws, owner };
}
export const refPath = (ref) => (ref && typeof ref === 'object' ? ref.ws : ref);
export const refOwner = (ref) => (ref && typeof ref === 'object' ? String(ref.owner || '') : '');
// fold = 池自己的路径规范化（resolve + Windows 小写）。主机身份与只给路径的老调用方（Codex 的浏览器通道等）
// 仍是「只按路径」——主机这边的键与改动前逐字一致；其他身份加属主前缀（\0 不会出现在路径里）。
export function poolKey(ref, fold) {
  const key = fold(refPath(ref));
  const owner = refOwner(ref);
  return !owner || owner === HOST_OWNER ? key : `${owner}\u0000${key}`;
}

// ── 会话引用与可见性 ────────────────────────────────────────────────────────
// 新持久化的会话引用一律写成（属主, sessionId）：将来「只读可见」「接手 = 复制到我名下续聊」都要跨属主找会话，
// 光一个 sessionId 不够。读老数据时裸 sessionId 按存放它的那个身份（fallbackOwner）补齐。
export function sessionRef(owner, sessionId) {
  return { owner: String(owner || ''), sessionId: String(sessionId || '') };
}
export function parseSessionRef(v, fallbackOwner = '') {
  if (typeof v === 'string') return v ? { owner: String(fallbackOwner || ''), sessionId: v } : null;
  if (v && typeof v === 'object' && v.sessionId) return { owner: String(v.owner || fallbackOwner || ''), sessionId: String(v.sessionId) };
  return null;
}

// 会话可见性（预留）。存放在 _system/session-visibility.json，经 runtime/session-visibility.mjs 读写——它是授权数据，
// 不放属主工作空间的 .bridge/（agent 改得到）。今天只有 private 生效，也没有入口能改；
// 其余取值是将来的「指定成员 / 组 / 全组织只读可见」。认不出的一律当 private。
export const SESSION_VISIBILITY = Object.freeze(['private', 'members', 'group', 'org']);
export const normVisibility = (v) => (SESSION_VISIBILITY.includes(v) ? v : 'private');

// ── 保留名 ──────────────────────────────────────────────────────────────────
// 用户根（usersRoot）下以 _ 开头的名字留给系统：账号名本就不许以 _ 开头（users.mjs validName）。
//   _system/  账号、邀请、登录会话、用量、数据布局版本、审计——服务进程独占，不在任何人的工作空间里；
//   _groups/  将来的组空间（<usersRoot>/_groups/<组 id>/），今天不创建。
export const RESERVED_DIR_PREFIX = '_';
export const SYSTEM_DIR_NAME = '_system';
export const GROUPS_DIR_NAME = '_groups';
export const validGroupId = (id) => /^[a-z0-9][a-z0-9_-]{1,31}$/.test(String(id ?? ''));
