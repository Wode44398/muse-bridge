import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './runtime/paths.mjs';

// 跟服务端同一个数据根（BRIDGE_DATA_ROOT，没设就是程序目录）。
const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');

const token = (process.argv[2] || '').trim();
if (!token) {
  console.error('Usage: npm run set-auth -- <oauth-token-from-claude-setup-token>');
  process.exit(1);
}

let cfg = {};
if (existsSync(CONFIG_PATH)) {
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch { console.error('config.json 解析失败（JSON 损坏）。请先修好它再运行——拒绝覆盖以免丢失其它配置。'); process.exit(1); }
}
cfg.oauthToken = token;
writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
console.log('Saved oauthToken to config.json (length=' + token.length + '). Restart the server.');
