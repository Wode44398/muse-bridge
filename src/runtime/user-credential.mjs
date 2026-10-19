// 注册用户自带的 Claude 凭据：每个人填自己的订阅令牌（claude setup-token）或 API Key，
// 跑 Claude 时只注入他自己的那一份，花的是他自己的额度，不再落到服务器共用的「Claude 账号」上。
//
// 存在 SYSTEM_DIR/claude-credentials.json（跟 users.json 同处，绝不放进用户文件夹——沙箱里的
// Claude 能读到用户文件夹）。形状：{ <name>: { kind: 'oauth' | 'apikey', token, baseUrl, updated } }。
// 对外（接口 / 前端）只给 publicView：有没有配、哪种、尾 4 位，完整令牌永不回传。
import { chmodSync } from 'node:fs';
import path from 'node:path';
import { SYSTEM_DIR } from '../config/index.mjs';
import { readJson, writeJson } from '../jsonfile.mjs';

const FILE = path.join(SYSTEM_DIR, 'claude-credentials.json');
const KINDS = new Set(['oauth', 'apikey']);

const norm = (name) => String(name || '').trim().toLowerCase();

function save(all) {
  writeJson(FILE, all, 2);
  try { chmodSync(FILE, 0o600); } catch {}
}

// 订阅令牌以 sk-ant-oat 开头，其余一律按 API Key 处理（含兼容 Anthropic 接口的第三方中转）。
export function guessKind(token) { return /^sk-ant-oat/i.test(String(token || '').trim()) ? 'oauth' : 'apikey'; }

// 自定义接口地址：只收 https，且不许指向本机 / 内网字面地址——Claude 子进程跑在服务器上，
// 填 http://127.0.0.1:… 就等于让用户借服务器去打内网服务。
export function validBaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: true, value: '' };
  let u;
  try { u = new URL(s); } catch { return { error: '接口地址不是合法网址' }; }
  if (u.protocol !== 'https:') return { error: '接口地址必须以 https:// 开头' };
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
    || /^[\d.]+$/.test(h) || h.includes(':')) {
    return { error: '接口地址要填域名，不能是本机、内网或 IP 地址' };
  }
  return { ok: true, value: u.origin + u.pathname.replace(/\/+$/, '') };
}

export function getCredential(name) {
  const rec = readJson(FILE, {})[norm(name)];
  if (!rec || !rec.token || !KINDS.has(rec.kind)) return null;
  return { kind: rec.kind, token: String(rec.token), baseUrl: String(rec.baseUrl || '') };
}

export function hasCredential(name) { return !!getCredential(name); }

export function setCredential(name, { kind, token, baseUrl } = {}) {
  const n = norm(name);
  if (!n) return { error: '用户不存在' };
  const tok = String(token || '').trim();
  if (!tok) return { error: '令牌 / API Key 不能为空' };
  if (/\s/.test(tok) || tok.length < 20 || tok.length > 400) return { error: '令牌 / API Key 格式不对，请完整粘贴' };
  const k = KINDS.has(kind) ? kind : guessKind(tok);
  // 订阅令牌只能打官方接口，自定义地址只对 API Key 有意义。
  const b = k === 'apikey' ? validBaseUrl(baseUrl) : { ok: true, value: '' };
  if (b.error) return { error: b.error };
  const all = readJson(FILE, {});
  all[n] = { kind: k, token: tok, baseUrl: b.value, updated: Date.now() };
  save(all);
  return { ok: true, credential: publicView(n) };
}

export function clearCredential(name) {
  const n = norm(name);
  const all = readJson(FILE, {});
  if (!(n in all)) return { ok: true };
  delete all[n];
  save(all);
  return { ok: true };
}

export function publicView(name) {
  const rec = readJson(FILE, {})[norm(name)];
  if (!rec || !rec.token || !KINDS.has(rec.kind)) return { configured: false };
  return { configured: true, kind: rec.kind, tail: String(rec.token).slice(-4), baseUrl: rec.baseUrl || '', updated: rec.updated || 0 };
}

// 给子进程 env 叠上这个人的凭据：先把服务器自己的认证变量全部摘掉，再只放他那一份——
// 绝不能让共用的订阅令牌 / API Key 漏进注册用户的进程。没配凭据时同样摘干净（返回 false）。
const AUTH_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
export function applyUserCredential(env, name) {
  for (const k of AUTH_VARS) delete env[k];
  const c = getCredential(name);
  if (!c) return false;
  if (c.kind === 'oauth') env.CLAUDE_CODE_OAUTH_TOKEN = c.token;
  else {
    env.ANTHROPIC_API_KEY = c.token;
    if (c.baseUrl) env.ANTHROPIC_BASE_URL = c.baseUrl;
  }
  return true;
}
