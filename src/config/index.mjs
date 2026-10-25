// Boot config: load config.json (auto-generating one with a fresh token on first
// run), resolve all env overrides, set up OAUTH for the spawned Claude engine,
// and export the resulting runtime constants. Capability tables (model enums /
// defaults / per-model maps) live in ./capabilities.mjs — keep them separate.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { DATA_ROOT, PROGRAM_ROOT } from '../runtime/paths.mjs';
import { CLAUDE_MODEL_DEFAULT } from './capabilities.mjs';
import { resolveDeployProfile, DEFAULTS_VERSION } from './deploy-profile.mjs';

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

// 这次启动是不是刚生成的 config.json（server.mjs 据此在无界面形态的终端里打印首次接入说明）。
export let CONFIG_CREATED = false;

function loadConfigFile() {
  if (!existsSync(CONFIG_PATH)) {
    const cfg = {
      port: 8787,
      token: randomBytes(24).toString('base64url'),
      vaultPath: DEFAULT_VAULT,
      usersRoot: DEFAULT_USERS_ROOT,
      model: '',
      oauthToken: '',
      // 新生成的配置按部署形态定默认值（见 deploy-profile.mjs）；没有这个键的老配置照旧按老规矩，升级不变
      defaultsVersion: DEFAULTS_VERSION,
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    CONFIG_CREATED = true;
    // 完整令牌不打进日志（S6：stdout 常被重定向落盘）；告诉人去哪取。
    const cli = String(process.env.BRIDGE_CLI || '').trim() || 'node src/cli.mjs';
    console.log('首次启动：已生成 ' + CONFIG_PATH + '（含访问令牌）。');
    console.log('  查看令牌：' + cli + ' show-token');
    return cfg;
  }
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { console.error('Refusing to start: config.json exists but is not valid JSON. Fix it (or delete it to regenerate). ' + ((e && e.message) || e)); process.exit(1); }
}

const config = loadConfigFile();

// 部署形态：desktop / server / docker，默认值按它定，规则与新老部署的区别见 deploy-profile.mjs。
// server.mjs 的监听地址、下面的多用户默认值都从这里取。Muse 的部署脚本在服务单元里写 BRIDGE_EDITION=server、
// BRIDGE_SUPERVISED=systemd（→ 无界面服务器形态，多用户默认开），选了「只自己用」再写 features.multiUser:false。
export const DEPLOY = resolveDeployProfile({ env: process.env, platform: process.platform, config, exists: existsSync });

// 功能开关，config.json 的 features.<名> 逐项覆盖：
//   multiUser   注册、邀请码、普通账号登录。关着时只有管理员与「服务账号」（程序用的账号）能登录。
//               默认值 = 「给谁用」（DEPLOY.multiUserDefault）：环境变量 BRIDGE_AUDIENCE=shared|self、
//               BRIDGE_EDITION=server → 开、host → 关；都没写时按 deploy-profile.mjs 的新老规则。
//   remoteAdmin 服务端控制台（/api/admin/*）对管理员身份远程开放。默认开：服务端在 VM 上时根本没有
//               「本机直连」可用；管理员令牌本来就能让 Claude 在服务器上执行任意命令，远程管理没有多给权限。
const FEATURE_DEFAULTS = {
  multiUser: DEPLOY.multiUserDefault,
  remoteAdmin: true,
};
const featureOverrides = (config.features && typeof config.features === 'object') ? config.features : {};
export const FEATURES = Object.freeze(Object.fromEntries(Object.entries(FEATURE_DEFAULTS).map(([k, v]) => [k, typeof featureOverrides[k] === 'boolean' ? featureOverrides[k] : v])));

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
// 按量 API Key 也可以写在 config.json 的 anthropicApiKey（手改；不必再另配环境变量）。
// 但 Claude Code 非交互模式下只要有 ANTHROPIC_API_KEY 就整个关掉 OAuth（CLI utils/auth.ts isAnthropicAuthEnabled），
// 注进进程环境后号池里的订阅号全被它顶掉、悄悄改走按量计费。所以只在「没有任何订阅凭据」时注入：
// 环境变量没给 key、没有 CLAUDE_CODE_OAUTH_TOKEN / oauthToken、号池里没有带令牌的号（播种出来的空「默认账号」不算）。
// 运行中往号池加了号（激活号有令牌）：claudeEngineEnv 不再把这个 key 带给 CLI（runtime/claude-account.mjs）。
// 环境变量里显式给的 ANTHROPIC_API_KEY 是部署者自己定的，行为不变（照旧盖过号池）。
const CONFIG_API_KEY = String(config.anthropicApiKey || '').trim();
const ENV_API_KEY = String(process.env.ANTHROPIC_API_KEY || '').trim();
export const API_KEY_FROM_CONFIG = !!CONFIG_API_KEY && !ENV_API_KEY && !OAUTH
  && !(Array.isArray(config.claudeAccounts) && config.claudeAccounts.some((a) => a && String(a.token || '').trim()));
if (API_KEY_FROM_CONFIG) process.env.ANTHROPIC_API_KEY = CONFIG_API_KEY;
// API Key 是从哪来的（runtime/claude-account.mjs apiKeyMode 据此给设置页、报错卡片说对改法）：
//   'env'      部署者给的环境变量（盖过号池）；
//   'desktop'  桌面安装包的本机服务端：client/agent/server-run.mjs 把向导里选的 anthropicApiKey 原样经环境变量交过来
//              （与 config 里的同一个值）。用户在向导里明确选了 API Key，就照环境变量的规矩盖过号池——号池里留着的旧令牌
//              不能让它被静默忽略；改回订阅号在托盘「本机服务端 › 重新配置…」里改选订阅令牌（向导会删掉 anthropicApiKey）。
//              所以 server-run 的这份注入要留着，不能交给上面按号池决定；
//   'config'   上面按条件注入的 config.json anthropicApiKey；
//   'unused'   config.json 写了 anthropicApiKey，但号池里有令牌 / 有 oauthToken，没注入（Docker、Linux 手改配置的常见坑，设置页据此提示）；
//   ''         没有 API Key。
export const API_KEY_SOURCE = API_KEY_FROM_CONFIG ? 'config'
  : ENV_API_KEY ? (ENV_API_KEY === CONFIG_API_KEY && String(process.env.BRIDGE_SUPERVISED || '').trim() === 'desktop' ? 'desktop' : 'env')
  : CONFIG_API_KEY ? 'unused' : '';
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

// 服务端实际监听的地址（server.mjs 按它 listen）：NO_AUTH 的本机实例永远只听回环，其余按部署形态（DEPLOY.listenHost：
// BRIDGE_HOST > config.json 的 bindHost > 老配置的 0.0.0.0 / 新配置按形态）。要判断「手机能不能直连局域网地址」的地方
// （配对码、/api/app/server-info 的地址簿）认它，别只看 process.env.BRIDGE_HOST。
export const LISTEN_HOST = NO_AUTH ? '127.0.0.1' : DEPLOY.listenHost;

// Re-export the original loaded config object so callers that need the verbatim
// shape can read it without another fs hit.
export { config };
