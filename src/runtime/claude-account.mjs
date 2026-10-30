// Claude 账号切换（failover / 额度池）。
//
// 整个 bridge 的 Claude Agent SDK 用哪个订阅账号，取决于注入子进程的
// CLAUDE_CODE_OAUTH_TOKEN。这里维护一个「账号注册表 + 当前激活账号」，持久化到
// config.json，并提供 claudeEngineEnv(ctx)——每次跑 query() 时按【当前激活账号】现取
// token 注进 env。切换是即时的、全局的（admin 对话 / 用户沙箱 / 定时路由都跟随），
// 因为它们都计费到本机这套订阅池。
//
// 会话【共享】：所有账号仍用 ~/.claude（configDir 保持 null），切账号只换 token——
// 一条对话可在切换后无缝续聊（A 号限流了切到 B 号接着聊同一个会话）。
//
// config.json 形状：
//   claudeAccounts: [{ id, label, token }]
//   claudeActiveAccount: <id>
// 迁移：若无 claudeAccounts 但有旧的 oauthToken，自动播种一个「默认账号」。

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_PATH, OAUTH, API_KEY_FROM_CONFIG, API_KEY_SOURCE } from '../config/index.mjs';
import { memberEngineBase } from './member-boundary.mjs';

let accounts = [];   // [{ id, label, token }]
let activeId = '';

function loadRaw() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}

// 只改这两个字段落盘，其余配置原样保留（别覆写 token/port 等）。
function persist() {
  const raw = loadRaw();
  raw.claudeAccounts = accounts;
  raw.claudeActiveAccount = activeId;
  try { writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2)); } catch (e) { console.error('[claude-account] persist failed:', (e && e.message) || e); }
}

function newId() { return 'a-' + randomBytes(4).toString('hex'); }

function init() {
  const raw = loadRaw();
  if (Array.isArray(raw.claudeAccounts) && raw.claudeAccounts.length) {
    accounts = raw.claudeAccounts
      .filter((a) => a && typeof a === 'object')
      // 认不出的字段原样留着、落盘时照写回去（开源路线 C14：新版本加的字段，装回旧版本也不丢）。
      // 其中 groups（[组 id]，缺省 = 所有人可用）是给将来「按组分配号」预留的，今天不参与选号（run-as.mjs accountGroups）。
      .map((a) => ({ ...a, id: String(a.id || newId()), label: String(a.label || ''), token: String(a.token || '') }));
    activeId = (raw.claudeActiveAccount && accounts.some((a) => a.id === raw.claudeActiveAccount))
      ? raw.claudeActiveAccount : accounts[0].id;
  } else {
    // 从旧的 config.oauthToken 播种一个默认账号（token 可能为空——那就代表「用 ~/.claude
    // 里已登录的凭证」，不注入覆盖，行为与迁移前完全一致）。
    accounts = [{ id: newId(), label: '默认账号', token: OAUTH || '' }];
    activeId = accounts[0].id;
    persist();
  }
}
init();

export function getActiveAccount() { return accounts.find((a) => a.id === activeId) || null; }

// 当前激活账号 id——额度快照按号分槽（status.mjs），每轮 query 启动时取一次随事件记账。
export function activeAccountId() { return activeId; }

// 当前激活账号的 token（空串 = 不覆盖，沿用环境/登录态）。
export function activeToken() { const a = getActiveAccount(); return a ? a.token : ''; }

// 给前端的安全视图：不外泄完整 token，只给尾 6 位供辨认。
export function listAccounts() {
  return accounts.map((a) => ({
    id: a.id, label: a.label, active: a.id === activeId,
    hasToken: !!a.token, tokenTail: a.token ? a.token.slice(-6) : '',
  }));
}

// 服务端内部用（号池逐号用量，account-usage.mjs；配了 overlay 用量来源时交给它）：带完整 token，绝不直接回给前端。
export function listAccountsWithTokens() { return accounts.map((a) => ({ id: a.id, token: a.token })); }

// token 属于哪个号（无缝换号时 CLI env 里固定的那个号：它直连官方的 OAuth 接口按这个号算）。
export function accountIdForToken(tok) { const a = tok ? accounts.find((x) => x.token === tok) : null; return a ? a.id : ''; }

export function setActive(id) {
  if (!accounts.some((a) => a.id === id)) return { error: '无此账号' };
  activeId = id; persist();
  return { ok: true, active: activeId };
}

export function addAccount({ label, token } = {}) {
  const t = String(token || '').trim();
  if (!t) return { error: 'token 不能为空（在该账号下跑 claude setup-token 获取）' };
  const l = String(label || '').trim() || ('账号 ' + (accounts.length + 1));
  const id = newId();
  accounts.push({ id, label: l, token: t });
  // S4：当前激活的号没有 token（向导里跳过了 Claude、播种出来的空「默认账号」），加了号却不激活，
  // Claude 照样没有认证——这时直接把新号设为激活号。
  // 但留空令牌的号 = 沿用本机登录态（~/.claude 凭据，见文件头的播种与 claudeEngineEnv）：本机真 claude login 过，
  // 空令牌也是在用订阅，加第二个号多半是为了自动换号，别把全局激活号静默切走（计费跟着换号）。
  // 例外：此刻在用 config 里的按量 key（apiKeyMode 'config'）——加订阅号就是要改用订阅，照旧激活。
  const act = getActiveAccount();
  const activated = !act || (!act.token && (!localLoginToken() || apiKeyMode() === 'config'));
  if (activated) activeId = id;
  persist();
  return { ok: true, id, ...(activated ? { active: id } : {}) };
}

export function updateAccount(id, { label, token } = {}) {
  const a = accounts.find((x) => x.id === id);
  if (!a) return { error: '无此账号' };
  if (typeof label === 'string' && label.trim()) a.label = label.trim();
  if (typeof token === 'string' && token.trim()) a.token = token.trim();
  persist();
  return { ok: true };
}

// 列表顺序 = 智能路由「回到首选号」的优先级（account-router.mjs）。delta：-1 上移、1 下移。
export function moveAccount(id, delta) {
  const i = accounts.findIndex((a) => a.id === id);
  if (i < 0) return { error: '无此账号' };
  const j = i + (delta < 0 ? -1 : 1);
  if (!delta || j < 0 || j >= accounts.length) return { ok: true };
  [accounts[i], accounts[j]] = [accounts[j], accounts[i]];
  persist();
  return { ok: true };
}

export function deleteAccount(id) {
  const i = accounts.findIndex((a) => a.id === id);
  if (i < 0) return { error: '无此账号' };
  if (accounts.length <= 1) return { error: '至少保留一个账号' };
  const wasActive = activeId === id;
  accounts.splice(i, 1);
  if (wasActive) activeId = accounts[0].id;
  persist();
  return { ok: true, active: activeId };
}

// 本机 claude login 留下的凭据（同 account-usage.loginToken；那边 import 了本模块，这里不反向 import 免得成环）。
// macOS 的凭据在钥匙串里、读不到，按「没登录」算（加号照旧自动激活，同改动前）。
function localLoginToken() {
  const dir = String(process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude');
  try { return JSON.parse(readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken || ''; } catch { return ''; }
}

// Claude 现在是不是走按量 API Key（给设置「订阅号池」页一句提示、报错卡片挑说法；来源见 config/index.mjs API_KEY_SOURCE）：
//   'env'           环境变量给的 ANTHROPIC_API_KEY——CLI 见到它就不用 OAuth，号池里的令牌都不生效；
//   'desktop'       桌面安装包的本机服务端、向导里选了 API Key——同上，号池令牌不生效；改用订阅号要去托盘「本机服务端 › 重新配置…」；
//   'config'        config.json 的 anthropicApiKey（启动时号池没有令牌才注入）且激活号没有令牌——在用 key，号池里加了令牌就改用订阅号；
//   'config-unused' config.json 里写了 anthropicApiKey 但没在用：号池里有令牌（启动时就有、没注入，或运行中激活号有了令牌）；
//   ''              没走 API Key（用号池 / 本机登录态）。
export function apiKeyMode() {
  if (API_KEY_SOURCE === 'unused') return 'config-unused';
  if (!process.env.ANTHROPIC_API_KEY) return '';
  if (API_KEY_SOURCE === 'config') return activeToken() ? 'config-unused' : 'config';
  return API_KEY_SOURCE === 'desktop' ? 'desktop' : API_KEY_SOURCE === 'env' ? 'env' : '';
}

// 号池「会话中无缝换号」的上游代理（claude-upstream.mjs 启动时注册；不反向 import，免得成环）。
let upstreamHook = null;
export function setEngineUpstream(fn) { upstreamHook = fn; }

// 每次跑 Claude query() 时构造子进程 env：叠加当前激活账号 token + 沙箱 configDir。
// 返回 null 表示无需覆盖（configDir 为空且激活账号无 token）——此时让子进程直接继承
// process.env（含 boot 时设的默认 token），行为与切换功能上线前一致。
// 无缝换号开着时改让 CLI 的模型请求走本机代理：token 由代理逐请求现换，env 里放一个固定的号。
// 成员身份（ctx.sandbox：注册用户、聊天快照）不再继承服务进程的全部环境：没有命令行的走白名单（家目录 / 临时目录
// 指到他自己的目录），有命令行的按名字剔掉凭据；CLI 认证要的那一份单独带上（runtime/member-boundary.mjs，开源路线 S2-5）。
// route = providerRouteToken(owner)：这一轮的子 agent 要能派第三方模型，CLI 也走本机代理（地址里带令牌，见 claude-upstream.mjs）。
export function claudeEngineEnv(ctx, { route } = {}) {
  let touched = false;
  const env = ctx && ctx.sandbox ? memberEngineBase(ctx) : { ...process.env };
  if (ctx && ctx.sandbox) touched = true;
  if (ctx && ctx.configDir) { env.CLAUDE_CONFIG_DIR = ctx.configDir; touched = true; }
  const up = upstreamHook ? upstreamHook({ route }) : null;
  const tok = up && up.token !== undefined ? up.token : activeToken();
  if (tok) { env.CLAUDE_CODE_OAUTH_TOKEN = tok; touched = true; }
  // config.json 的 anthropicApiKey 只在启动时号池没有令牌才注入（config/index.mjs）；之后号池里有了激活号的令牌，
  // 就别再把它带给 CLI——CLI 见到 ANTHROPIC_API_KEY 会关掉 OAuth，订阅号白加、照样按量计费。
  if (tok && API_KEY_FROM_CONFIG && env.ANTHROPIC_API_KEY) { delete env.ANTHROPIC_API_KEY; touched = true; }
  if (up) {
    env.ANTHROPIC_BASE_URL = up.baseUrl;
    env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1';
    // 出站代理（net-proxy.mjs）开着时，CLI 到本机代理这一跳不能再绕去 Clash。
    for (const k of ['NO_PROXY', 'no_proxy']) if (!/(^|,)\s*127\.0\.0\.1\s*(,|$)/.test(env[k] || '')) env[k] = (env[k] ? env[k] + ',' : '') + '127.0.0.1';
    touched = true;
  }
  return touched ? env : null;
}
