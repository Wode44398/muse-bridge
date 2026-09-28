// Boot config: load config.json (auto-generating one with a fresh token on first
// run), resolve all env overrides, set up OAUTH for the spawned Claude engine,
// and export the resulting runtime constants. Capability tables (model enums /
// defaults / per-model maps) live in ./capabilities.mjs — keep them separate.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { DATA_ROOT, PROGRAM_ROOT } from '../runtime/paths.mjs';
import { CLAUDE_MODEL_DEFAULT } from './capabilities.mjs';

// Mutable data lives under the data root (BRIDGE_DATA_ROOT; the deploy scripts point it
// outside the program tree so versions can be swapped). ROOT is the historical public
// name for it; static assets always resolve from PROGRAM_ROOT.
export const ROOT = DATA_ROOT;
export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const PUBLIC_DIR = path.join(PROGRAM_ROOT, 'public');
export const UPLOADS = path.join(ROOT, 'uploads');
export const MEDIA = path.join(ROOT, 'media');

mkdirSync(UPLOADS, { recursive: true });
mkdirSync(MEDIA, { recursive: true });

// 默认都落在数据根里（BRIDGE_DATA_ROOT，没设就是程序目录）：任何人拿到代码都能直接起。
const DEFAULT_VAULT = path.join(ROOT, 'workspace');
const DEFAULT_USERS_ROOT = path.join(ROOT, 'users');

function loadConfigFile() {
  if (!existsSync(CONFIG_PATH)) {
    const cfg = {
      port: 8787,
      token: randomBytes(24).toString('base64url'),
      vaultPath: DEFAULT_VAULT,
      usersRoot: DEFAULT_USERS_ROOT,
      model: '',
      oauthToken: '',
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    // 完整令牌不打进日志（S6：stdout 常被重定向落盘）；告诉人去哪取。
    console.log('首次启动：已生成 ' + CONFIG_PATH + '（含访问令牌）。');
    console.log('  查看令牌：在程序目录运行 `npm run -s show-token`');
    return cfg;
  }
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { console.error('Refusing to start: config.json exists but is not valid JSON. Fix it (or delete it to regenerate). ' + ((e && e.message) || e)); process.exit(1); }
}

const config = loadConfigFile();

// 形态（edition）：server = Linux 上的服务端（Muse Bridge 的唯一部署形态）；host = 单人本机调试。
// 没写就按平台猜：Windows → host，其余 → server。形态只决定各项功能的【默认值】，config.json 的
// features.<名> 可以逐项覆盖——例如部署时选了「只自己用」就写 features.multiUser:false。
const EDITION_RAW = String(process.env.BRIDGE_EDITION || config.edition || '').trim().toLowerCase();
export const EDITION = EDITION_RAW === 'host' || EDITION_RAW === 'server' ? EDITION_RAW : (process.platform === 'win32' ? 'host' : 'server');
const FEATURE_DEFAULTS = {
  // multiUser：注册、邀请码、普通账号登录。关着时只有管理员与「服务账号」（程序用的账号）能登录。
  // remoteAdmin：服务端控制台（/api/admin/*）对管理员身份远程开放；关着时只认本机直连。
  host: { multiUser: false, remoteAdmin: false },
  server: { multiUser: true, remoteAdmin: true },
};
const featureOverrides = (config.features && typeof config.features === 'object') ? config.features : {};
export const FEATURES = Object.freeze(Object.fromEntries(Object.entries(FEATURE_DEFAULTS[EDITION]).map(([k, v]) => [k, typeof featureOverrides[k] === 'boolean' ? featureOverrides[k] : v])));

export const PORT = Number(process.env.PORT || config.port || 8787);
export const TOKEN = process.env.BRIDGE_TOKEN || config.token || '';
// 服务端形态可以只存主令牌的 SHA-256（config.tokenHash，`npm run gen-token -- --hash` 生成）：
// config.json 被读到也拿不到能登录的东西。有明文 token 时以明文为准。
export const TOKEN_HASH = TOKEN ? '' : (/^[0-9a-f]{64}$/i.test(String(config.tokenHash || '')) ? String(config.tokenHash).toLowerCase() : '');
export const VAULT = process.env.VAULT_PATH || config.vaultPath || DEFAULT_VAULT;
// 默认工作空间不存在就建出来（Claude 的 cwd 必须存在）；用户自己指的路径不替他建，缺了照常报错。
if (VAULT === DEFAULT_VAULT) mkdirSync(VAULT, { recursive: true });
// 「客户端没带 model」这一档的回落。config.json 的 model 留空即走 capabilities 的单一
// 真相（CLAUDE_MODEL_DEFAULT）——别再往 config.json 里钉死具体版本号，那正是前端芯片
// 显示 Opus 5、后端却跑 Opus 4.8 的成因。
export const MODEL = process.env.BRIDGE_MODEL || config.model || CLAUDE_MODEL_DEFAULT;

if ((!TOKEN || TOKEN.length < 16) && !TOKEN_HASH) {
  console.error('Refusing to start: access token is missing or too short (config.json token / tokenHash). Fix config.json.');
  process.exit(1);
}

// Auth for the spawned Claude engine: a long-lived subscription token from
// `claude setup-token`. The query subprocess inherits process.env, so setting
// it here is enough. An empty ANTHROPIC_API_KEY in the environment confuses
// auth resolution, so drop it.
export const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN || config.oauthToken || '';
if (OAUTH) process.env.CLAUDE_CODE_OAUTH_TOKEN = OAUTH;
if (process.env.ANTHROPIC_API_KEY === '') delete process.env.ANTHROPIC_API_KEY;
// 禁掉 spawn 出的 claude 子进程的自动更新。实测坑（2026-07-12）：自更新中途被打断会把
// node_modules 里 SDK 内置的 claude.exe 改名成 .old.<ts> 且新档没落地 → 之后所有 Claude
// 调用统统 "Native CLI binary not found"。binary 版本升级由我们手动控制（npm update）。
process.env.DISABLE_AUTOUPDATER = '1';

// Multi-user (Phase 1). Account/password users are sandboxed to their own folder
// under NATIVE_ROOT/<username>; system data (accounts, invite codes, auth sessions,
// usage — including password hashes) lives under NATIVE_ROOT/_system and must NEVER
// sit inside a user folder. admin (the access token) is unaffected and keeps using
// the host (VAULT + ~/.claude + ROOT) exactly as before.
export const NATIVE_ROOT = process.env.BRIDGE_USERS_ROOT || config.usersRoot || DEFAULT_USERS_ROOT;
export const SYSTEM_DIR = path.join(NATIVE_ROOT, '_system');
try { mkdirSync(SYSTEM_DIR, { recursive: true }); } catch {}
export const userRoot = (name) => path.join(NATIVE_ROOT, name);

// 稳定公网 origin（自己域名的固定隧道），用于生成可分享的完整链接（/s/<token>）。
// 空 = 用的是临时地址，/api/share 只回相对路径 /s/<token>，由前端按当前地址拼。
export const PUBLIC_ORIGIN = (process.env.BRIDGE_PUBLIC_ORIGIN || config.publicOrigin || '').replace(/\/+$/, '');

// Local debugging only: BRIDGE_NO_AUTH=1 binds the instance to 127.0.0.1 with no
// token. The deployed server never sets this, so it stays token-protected.
export const NO_AUTH = process.env.BRIDGE_NO_AUTH === '1';

// Re-export the original loaded config object so callers that need the verbatim
// shape can read it without another fs hit.
export { config };
