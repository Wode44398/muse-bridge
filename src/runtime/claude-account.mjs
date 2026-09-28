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
import { CONFIG_PATH, OAUTH } from '../config/index.mjs';

let accounts = [];   // [{ id, label, token }]
let activeId = '';

function loadRaw() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
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
      .map((a) => ({ id: String(a.id || newId()), label: String(a.label || ''), token: String(a.token || '') }));
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

// 当前激活账号的 token（空串 = 不覆盖，沿用环境/登录态）。
export function activeToken() { const a = getActiveAccount(); return a ? a.token : ''; }

// 给前端的安全视图：不外泄完整 token，只给尾 6 位供辨认。
export function listAccounts() {
  return accounts.map((a) => ({
    id: a.id, label: a.label, active: a.id === activeId,
    hasToken: !!a.token, tokenTail: a.token ? a.token.slice(-6) : '',
  }));
}

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
  persist();
  return { ok: true, id };
}

export function updateAccount(id, { label, token } = {}) {
  const a = accounts.find((x) => x.id === id);
  if (!a) return { error: '无此账号' };
  if (typeof label === 'string' && label.trim()) a.label = label.trim();
  if (typeof token === 'string' && token.trim()) a.token = token.trim();
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

// 每次跑 Claude query() 时构造子进程 env：叠加当前激活账号 token + 沙箱 configDir。
// 返回 null 表示无需覆盖（configDir 为空且激活账号无 token）——此时让子进程直接继承
// process.env（含 boot 时设的默认 token），行为与切换功能上线前一致。
export function claudeEngineEnv(ctx) {
  let touched = false;
  const env = { ...process.env };
  if (ctx && ctx.configDir) { env.CLAUDE_CONFIG_DIR = ctx.configDir; touched = true; }
  const tok = activeToken();
  if (tok) { env.CLAUDE_CODE_OAUTH_TOKEN = tok; touched = true; }
  return touched ? env : null;
}
