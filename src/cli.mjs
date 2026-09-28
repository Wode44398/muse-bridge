// 服务器上的运维小命令（在程序目录里跑：`npm run -s <命令>`）。
//
//   npm run -s show-token            打印 admin 访问令牌（网页 / App「用访问令牌登录」填它）
//   npm run -s invite [-- user|pro]  生成一次性邀请码给朋友注册；pro 档多一个命令行（默认 user）
//   npm run -s users                 列出已注册账号与未用的邀请码
//
// 邀请与账号管理走服务端的 /api/admin/*——那组接口只认「本机回环 + admin 令牌 + 没有代理头」，
// 所以这些命令必须在服务器本机上跑，隧道 / 局域网上的请求一律 404（设计如此）。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './runtime/paths.mjs';

const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error('找不到 ' + CONFIG_PATH + '——先启动一次服务端，它会自动生成。');
    process.exit(1);
  }
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch { console.error(CONFIG_PATH + ' 不是合法 JSON。'); process.exit(1); }
}

// config.json 只存了令牌哈希（`npm run token -- --hash`）时，明文只在生成那一刻显示过——
// 这些命令要从环境变量 BRIDGE_TOKEN 拿。
const HASH_ONLY_HINT = 'config.json 只存了访问令牌的哈希（tokenHash），明文只在生成时显示过一次：'
  + '用 BRIDGE_TOKEN=<令牌> npm run -s … 调用；忘了就 npm run token -- --hash 重新生成（所有管理员登录会下线）。';
async function admin(cfg, method, route, body) {
  const token = process.env.BRIDGE_TOKEN || cfg.token;
  if (!token) { console.error(HASH_ONLY_HINT); process.exit(1); }
  const port = Number(process.env.PORT || cfg.port || 8787);
  let r;
  try {
    r = await fetch('http://127.0.0.1:' + port + route, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    console.error('连不上 http://127.0.0.1:' + port + '——服务端在跑吗？');
    process.exit(1);
  }
  if (!r.ok) { console.error(route + ' → HTTP ' + r.status + '：' + (await r.text()).slice(0, 200)); process.exit(1); }
  return r.json();
}

const [cmd, arg] = process.argv.slice(2);
const cfg = loadConfig();

if (cmd === 'show-token') {
  const t = process.env.BRIDGE_TOKEN || cfg.token;
  if (!t) { console.error(HASH_ONLY_HINT); process.exit(1); }
  console.log(t);
} else if (cmd === 'invite') {
  const tier = arg === 'pro' ? 'pro' : 'user';
  const { code } = await admin(cfg, 'POST', '/api/admin/invite', { tier });
  console.log(code);
  console.error('（一次性邀请码，档位 ' + tier + '。对方在登录页选「注册」填它。）');
} else if (cmd === 'users') {
  const { users = [], invites = [] } = await admin(cfg, 'GET', '/api/admin/users');
  if (!users.length) console.log('还没有注册账号。');
  for (const u of users) console.log(`${u.name}\t${u.tier || ''}${u.disabled ? '\t(已停用)' : ''}`);
  const open = invites.filter((i) => !i.usedBy && !i.used);
  if (open.length) console.log('\n未使用的邀请码：\n' + open.map((i) => `${i.code}\t${i.tier || ''}`).join('\n'));
} else {
  console.error('用法：npm run -s show-token | invite [-- user|pro] | users');
  process.exit(1);
}
