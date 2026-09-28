import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { DATA_ROOT } from './runtime/paths.mjs';

// 跟服务端同一个数据根（BRIDGE_DATA_ROOT，没设就是程序目录）。
const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');
// --hash：config.json 只存主令牌的 SHA-256（tokenHash），明文只在这里打印一次、请自行存好。
// 服务端形态（VPS）推荐：config.json 被读到也拿不到能登录的东西。代价是忘了就只能重新生成。
// 需要从 config.json 读回明文令牌的场景（本机调试）才别用 --hash。
const HASH_ONLY = process.argv.includes('--hash');

let cfg = {};
if (existsSync(CONFIG_PATH)) {
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch { console.error('config.json 解析失败（JSON 损坏）。请先修好它再运行——拒绝覆盖以免丢失其它配置。'); process.exit(1); }
}
cfg.port ??= 8787;
cfg.vaultPath ??= path.join(DATA_ROOT, 'workspace');
cfg.model ??= '';
const token = randomBytes(24).toString('base64url');
if (HASH_ONLY) {
  delete cfg.token;
  cfg.tokenHash = createHash('sha256').update(token).digest('hex');
} else {
  cfg.token = token;
  delete cfg.tokenHash;
}
writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));

console.log(HASH_ONLY
  ? 'New access token (config.json only keeps its SHA-256 — save this now, it will not be shown again):'
  : 'New access token written to config.json:');
console.log(token);
console.log('All existing admin logins (web / phone / scan-login) are signed out by a new token.');
