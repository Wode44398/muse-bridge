// Who is this request, and what execution/storage context do they get?
//
// admin  = the access token (Bearer/bridge_auth cookie), OR any request to the
//          NO_AUTH loopback console — full host access, unchanged behavior.
// user   = a bridge_user cookie mapping to a live account session — sandboxed to
//          their own folder under NATIVE_ROOT/<user>.
// none   = not authenticated (show the login page).
//
// contextFor(identity) is the single source of per-identity cwd + storage paths;
// every handler derives its file locations from it instead of the old globals.

import path from 'node:path';
import { getSession, getUser, userGrants, normTier, accountId } from '../users.mjs';
import { VAULT, ROOT, UPLOADS, MEDIA, FEATURES, userRoot } from '../config/index.mjs';
import { AGENT_BY_ID, USER_DEFAULT_AGENTS, normAgentList } from '../config/agents.mjs';
import { enabledAgents } from './agent-status.mjs';
import { withPrincipal, ownerKey, parseOwnerKey, HOST_OWNER } from './principal.mjs';
// owner 键只经这一对函数生成与解析（principal.mjs，开源路线 C2）；新代码不再手拼 'u:' + 名字、不再 key.slice(2)。
export { ownerKey, parseOwnerKey } from './principal.mjs';

// 这个身份能用哪些 agent：全局开关（agent-status 的 enabled）∩ 身份名单。
//   admin：全部已启用的。
//   user ：管理员给这个人勾的名单（没勾过 = 默认 Claude + Gemini），且只留支持多用户的 agent。
//   snap ：只有 Claude（QQ 群快照就是个 Claude 对话框）。share：一个都没有。
export function agentsFor(identity) {
  const on = enabledAgents();
  const kind = identity && identity.kind;
  if (kind === 'share') return [];
  if (kind === 'snap') return on.filter((id) => id === 'claude');
  if (kind !== 'user') return on;
  const granted = Array.isArray(identity.agents) ? normAgentList(identity.agents) : [...USER_DEFAULT_AGENTS];
  return on.filter((id) => granted.includes(id) && AGENT_BY_ID[id].multiUser);
}

function agentFlags(identity) {
  const agents = agentsFor(identity);
  return {
    agents,
    allowClaude: agents.includes('claude'),
    allowGemini: agents.includes('gemini'),
    allowCodex: agents.includes('codex'),
    allowDimensio: agents.includes('dimensio'),
  };
}

// 进程内身份覆盖：给 agent 接口（src/agent-api/）在进程里调现有 /api/* 路由用——身份已经认好了，
// 挂在假请求的这个 Symbol 属性上，路由照常走 identify。Symbol 属性来不了网络：HTTP 客户端伪造不了它。
// 只认 identify 的路由生效；直接拿 authOk / adminCredential 判身份的（控制台 /api/admin/* 等）不认它。
export const INTERNAL_IDENTITY = Symbol('bridge.internalIdentity');

// 服务端重放（排队消息、额度重置后自动续跑、会话间消息、PR 叫醒，见 runtime/claude-queue.mjs）靠记下的身份头重发
// /api/chat。进程内身份没有身份头，就在重放头里记一个标记：值是 owner 键（'admin' / 'u:<账号 id>'），重放时现查账号
// （停用了就不给身份）。这个标记只由 replayHeadersOf 从 Symbol 写入、绝不从网络请求头抄——客户端带同名头不起作用。
export const REPLAY_AS_HEADER = 'x-bridge-replay-as';
export const REPLAY_HEADERS = ['authorization', 'cookie', 'user-agent', 'x-bridge-device', 'x-bridge-client'];
export function replayHeadersOf(req) {
  const h = req && req.headers ? req.headers : {};
  const out = Object.fromEntries(REPLAY_HEADERS.filter((k) => h[k]).map((k) => [k, h[k]]));
  const id = req && req[INTERNAL_IDENTITY];
  if (id && id.kind === 'admin') out[REPLAY_AS_HEADER] = ownerKey('admin');
  else if (id && id.kind === 'user' && id.user) out[REPLAY_AS_HEADER] = ownerKey('user', id.user);
  return out;
}
export function identityFromReplayTag(tag) {
  const p = parseOwnerKey(tag);
  if (!p) return null;
  if (p.kind === 'admin') return { kind: 'admin', user: null };
  if (p.kind === 'user') return userIdentity(p.id);
  return null;
}

export function makeIdentify({ authOk, getCookie, bearerToken, queryToken, resolveShare, resolveSnap }) {
  return function identify(req) {
    if (req && req[INTERNAL_IDENTITY]) return req[INTERNAL_IDENTITY];
    // 【显式能力 token 优先于环境登录态】——/c/ 快照页与 /w/ 分享页的每个请求都自带
    // ?ct= / ?st=。若访客浏览器恰好登着 bridge（维护者自己点开群里的链接是典型场景），
    // cookie/Bearer 抢先解析会把请求接管成 admin/user：快照会话解析到错误 cwd
    // （历史 404 → 前端变欢迎页、SDK resume 报「No conversation found」），share 页
    // 则会浏览到登录者自己的工作空间。能力 token 只会【降权】（snap/share 沙箱 ⊂
    // 任何登录态），先判无提权风险；token 已死（过期/关停）也不回落环境身份——按
    // none 处理，前端凭 /api/csnap/meta 显示过期页，比顶着错误身份跑出怪错误清楚得多。
    //
    // 聊天快照：?ct=<token> 或 x-csnap-token 头 → kind:'snap'——【可写】但 cwd 锁死快照桶、
    // 无 shell 的沙箱身份。只有 server.mjs 显式拿到 resolveSnap 的路由模块（chat/upload/
    // overview/sessions）认识它；其余模块（vertex/媒体…）用不带 resolveSnap 的
    // identify，snap token 解析成 none → 401，烧钱端点碰不到。
    if (resolveSnap) {
      let ct = '';
      try { ct = new URL(req.url, 'http://x').searchParams.get('ct') || ''; } catch {}
      if (!ct) ct = req.headers['x-csnap-token'] || '';
      if (ct) {
        const sn = resolveSnap(ct);
        return sn ? { kind: 'snap', user: null, token: sn.token, dir: sn.dir } : { kind: 'none', user: null };
      }
    }
    // 公开分享桶：?st=<token> 或 x-share-token 头。解析成一个只读、cwd 锁死在桶内的 share 身份。
    // 仅读接口（requireReadCtx）接受它；写接口/聊天/媒体走 requireCtx，对 share 一律 401。
    if (resolveShare) {
      let st = '';
      try { st = new URL(req.url, 'http://x').searchParams.get('st') || ''; } catch {}
      if (!st) st = req.headers['x-share-token'] || '';
      if (st) {
        const sh = resolveShare(st);
        return sh ? { kind: 'share', user: null, token: sh.token, dir: sh.dir } : { kind: 'none', user: null };
      }
    }
    // authOk already returns true under NO_AUTH (the loopback admin console) and
    // for a valid token, so both resolve to admin here.
    if (authOk(req)) return { kind: 'admin', user: null };
    // user session token: bridge_user cookie (同源/在线壳) OR Authorization: Bearer.
    // 离线 apk 前端跑在 appassets 源、API 跨源到隧道，credentials:'same-origin' 不带
    // cookie——user 只能靠 Bearer 携带 session token（admin 早就这么走）。authOk 已先
    // 判过 admin，所以走到这里的 Bearer 必然不是 admin token：getSession 命中才是 user，
    // 否则 none，绝不会把任意 Bearer 提权成 admin。
    const tok = getCookie(req, 'bridge_user') || (bearerToken ? bearerToken(req) : '') || (queryToken ? queryToken(req) : '');
    const s = tok ? getSession(tok) : null;
    // 多用户关着（主机形态）：普通账号的会话一律不认，只剩服务账号（QQ 机器人这类）。
    // user = 账号 id（目录 / owner 键 / 账本都认它，老账号 = 用户名），name = 登录名（显示用，可改），
    // sid / loginAt = 这次登录（设备登记据此绑到这次登录上，见 routes/devices.mjs）。
    if (s && (FEATURES.multiUser || s.service)) return { kind: 'user', user: s.id || s.user, name: s.user, sid: s.sid || '', loginAt: s.since || 0, tier: s.tier, agents: s.agents, snapshot: s.snapshot, service: s.service };
    return { kind: 'none', user: null };
  };
}

// 从账号库现拼一个 user 身份——给「没有请求」的入口用（定时任务、控制台代聊 / 查看某人数据）。
// ref = 登录名或账号 id。账号不存在 → null；已停用 → null（allowDisabled 时照给，控制台查看停用账号的数据要用）。
export function userIdentity(ref, { allowDisabled = false } = {}) {
  const u = getUser(ref);
  if (!u || (u.disabled && !allowDisabled)) return null;
  return { kind: 'user', user: accountId(u), name: u.name, tier: normTier(u.tier), ...userGrants(u) };
}

export const isAdmin = (id) => !!id && id.kind === 'admin';
export const isUser = (id) => !!id && id.kind === 'user';

// Per-identity route guard, shared by every per-caller endpoint: resolve the caller
// to a context, or send 401 and return null. Handlers do:
//   const ctx = requireCtx(identify, req, res); if (!ctx) return;
export function requireCtx(identify, req, res) {
  const id = identify(req);
  // share = 公开只读身份，只能过 requireReadCtx；在这里（写/聊天/媒体等）等同未授权。
  if (!id || id.kind === 'none' || id.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return null; }
  return contextFor(id);
}

// 只读版：user/admin 照常，另放行公开 share 身份（cwd 锁桶内、readOnly）。仅供文件【读】接口用。
export function requireReadCtx(identify, req, res) {
  const id = identify(req);
  if (!id || id.kind === 'none') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return null; }
  return contextFor(id);
}

// Per-identity execution + storage context. The ONLY place that maps an identity
// to where its Claude runs and where its data lives.
// 出口统一补 actor / scope / groups（principal.withPrincipal）：今天 scope = actor = key，组为空；
// 管理员代聊时 identity 带 actor:'admin'，ctx.actor 记下是谁发起的（开源路线 C1）。
export function contextFor(identity) {
  return withPrincipal(contextBase(identity), identity);
}
function contextBase(identity) {
  // 公开只读分享身份：cwd 锁死在桶目录，readOnly。必须【先于】下面的 admin 兜底判断——
  // 否则 kind!=='user' 会把 share 误当 admin 放到 host，天大的洞。
  if (identity && identity.kind === 'share') {
    const dir = identity.dir;
    const sys = path.join(dir, '.bridge');   // 占位；写/媒体接口对 share 走 requireCtx 已 401，用不到
    return {
      kind: 'share', user: null, sandbox: true, readOnly: true, ...agentFlags(identity), canSnapshot: false, key: ownerKey('share', identity.token),
      tier: 'user', shell: false,
      cwd: dir,
      configDir: path.join(sys, 'claude'),
      dataDir: sys,
      uploads: path.join(sys, 'uploads'),
      media: path.join(sys, 'media'),
      vertexHist: path.join(sys, 'vertex-history'),
      codexHist: path.join(sys, 'codex-history'),
      codexProjects: path.join(sys, 'codex-projects.json'),
      claudeProjects: path.join(sys, 'claude-projects.json'),
    };
  }
  // 聊天快照身份：与 share 同样【必须先于】admin 兜底判断，但可写（readOnly 不设）——
  // Claude 在桶里真读真写，交付走附件卡。无 shell、无 codex；key 按 token 隔离，
  // 每个快照的 gen/会话/上传互不相干。ctx.snap 供 chat.mjs / claude.mjs 走快照专属分支。
  if (identity && identity.kind === 'snap') {
    const dir = identity.dir;
    const sys = path.join(dir, '.bridge');
    return {
      kind: 'snap', user: null, sandbox: true, ...agentFlags(identity), canSnapshot: false, key: ownerKey('snap', identity.token),
      tier: 'user', shell: false, snap: { token: identity.token },
      cwd: dir,
      configDir: path.join(sys, 'claude'),
      dataDir: sys,
      uploads: path.join(sys, 'uploads'),
      media: path.join(sys, 'media'),
      vertexHist: path.join(sys, 'vertex-history'),
      codexHist: path.join(sys, 'codex-history'),
      codexProjects: path.join(sys, 'codex-projects.json'),
      claudeProjects: path.join(sys, 'claude-projects.json'),
    };
  }
  if (!identity || identity.kind !== 'user') {
    // admin / fallback: the host, exactly as the single-tenant bridge always was.
    return {
      kind: 'admin', user: null, sandbox: false, ...agentFlags({ kind: 'admin' }), canSnapshot: true, key: HOST_OWNER,
      tier: 'admin', shell: true,
      cwd: VAULT,
      configDir: null,          // null -> SDK default (~/.claude)
      dataDir: ROOT,
      uploads: UPLOADS,
      media: MEDIA,
      vertexHist: path.join(ROOT, 'vertex-history'),
      codexHist: path.join(ROOT, 'codex-history'),
      codexProjects: path.join(ROOT, 'codex-projects.json'),
      claudeProjects: path.join(ROOT, 'claude-projects.json'),
    };
  }
  const base = userRoot(identity.user);
  const sys = path.join(base, '.bridge');
  const tier = identity.tier === 'user' ? 'user' : 'pro';
  return {
    // 能用哪些 agent 由管理员按人勾（users.json 的 agents；没勾过 = 默认 Claude + Gemini，
    // 2026-09-23 维护者定的规则），再与全局开关、「该 agent 是否支持多用户」取交集（agentsFor）。
    // codex 不支持多用户：进程内部的工具调用、命令、改文件都绕过 bridge 的 canUseTool
    // 沙箱守卫，且共用主机上的登录与会话目录——所以注册用户恒拿不到，勾了也不生效。
    kind: 'user', user: identity.user, sandbox: true, ...agentFlags(identity),
    // user 是账号 id；name 是登录名（只用来显示，可改）。sid / loginAt：这次登录（定时任务等无请求入口为空）。
    name: identity.name || identity.user, sid: identity.sid || '', loginAt: identity.loginAt || 0,
    // 能不能铸公开聊天快照（QQ 机器人这类服务账号要）；老账号没写 = 保留。
    canSnapshot: identity.snapshot !== false,
    service: identity.service === true,
    key: ownerKey('user', identity.user),     // 'u:<账号 id>'——owner 键只经 principal.ownerKey 生成（C2）
    // tier 'pro' = full (shell allowed); 'user' = restricted (no command line).
    tier, shell: tier !== 'user',
    cwd: base,                                // Claude works *inside* the user's folder
    configDir: path.join(sys, 'claude'),      // CLAUDE_CONFIG_DIR -> their sessions land here
    dataDir: sys,
    uploads: path.join(sys, 'uploads'),
    media: path.join(sys, 'media'),
    vertexHist: path.join(sys, 'vertex-history'),
    codexHist: path.join(sys, 'codex-history'),
    codexProjects: path.join(sys, 'codex-projects.json'),
    claudeProjects: path.join(sys, 'claude-projects.json'),
  };
}
