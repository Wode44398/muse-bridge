// 服务器上的运维小命令（在程序目录里跑：node src/cli.mjs <命令>；show-token / invite / users 也有 npm run -s 别名）。
//
//   show-token                打印管理员访问令牌（网页 / App「用访问令牌登录」填它）
//   token [--hash|--plain]    换一个新的访问令牌（旧的作废、管理员登录全部下线；重启服务端后生效）。
//                             默认沿用现在的存法：只存哈希的仍只存哈希；--hash / --plain 显式改
//   invite [user] [--days=N]  生成一次性普通档邀请码给朋友注册（要先打开多用户；默认 7 天有效）
//   invite full --ack         完全信任档（旧名 pro）：有命令行，等同管理员——要加 --ack 表示看过这句说明
//   users                     列出已注册账号与未用的邀请码
//
// 凭据：环境变量 BRIDGE_TOKEN，或 --token-stdin 从标准输入读，否则读 config.json 的明文 token。
// 邀请与账号管理走服务端的 /api/admin/*——那组接口只认「本机回环 + admin 令牌 + 没有代理头」，
// 所以这些命令必须在服务器本机上跑，隧道 / 局域网上的请求一律 404（设计如此）。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './runtime/paths.mjs';

const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');
const CLI = String(process.env.BRIDGE_CLI || '').trim() || 'node src/cli.mjs';
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, ''));

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error('找不到 ' + CONFIG_PATH + '——先启动一次服务端，它会自动生成。'
      + (process.env.BRIDGE_DATA_ROOT ? '' : '\n（数据不在程序目录的话，先设 BRIDGE_DATA_ROOT=<数据目录>。）'));
    process.exit(1);
  }
  try { return readJson(CONFIG_PATH); }
  catch { console.error(CONFIG_PATH + ' 不是合法 JSON。'); process.exit(1); }
}
// 不退出的版本：没有 / 读不了 / 坏 JSON 都回 null（token 看现在的存法）
function readConfigSoft() {
  try { return existsSync(CONFIG_PATH) ? readJson(CONFIG_PATH) : null; } catch { return null; }
}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const [cmd, arg] = argv.filter((a) => !a.startsWith('--'));
const flagValue = (name) => { const a = argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : ''; };

// 档位的显示名：存储值 user / pro；pro 现在叫「完全信任」，管理员还没确认过的标「待确认」
const tierLabel = (r) => (r && r.tier === 'user' ? '普通' : '完全信任' + (r && r.trustPending ? '（待确认）' : ''));
const fmtTime = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

// config.json 只存了令牌哈希（tokenHash）时，明文只在生成那一刻显示过——这些命令要从环境变量 / 标准输入拿。
const HASH_ONLY_HINT = 'config.json 只存了访问令牌的哈希（tokenHash），明文只在生成时显示过一次：'
  + '用 BRIDGE_TOKEN=<令牌> 调用，或 --token-stdin 从标准输入给；忘了就 ' + CLI + ' token --hash 重新生成（所有管理员登录会下线，重启服务端后生效）。';

// 只有要读配置的命令才去读（help、token、认不出的命令不该先报「找不到 config.json」）。
const NEEDS_CONFIG = new Set(['show-token', 'invite', 'users']);
const cfg = NEEDS_CONFIG.has(cmd) ? loadConfig() : null;
const PORT = Number(process.env.PORT || (cfg && cfg.port) || 8787);
const STDIN_TOKEN = flags.has('--token-stdin') ? await readStdin() : '';
const adminToken = () => process.env.BRIDGE_TOKEN || STDIN_TOKEN || (cfg && cfg.token) || '';

async function admin(method, route, body) {
  const token = adminToken();
  if (!token) { console.error(HASH_ONLY_HINT); process.exit(1); }
  let r;
  try {
    r = await fetch('http://127.0.0.1:' + PORT + route, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    console.error('连不上 http://127.0.0.1:' + PORT + '——服务端在跑吗？');
    process.exit(1);
  }
  if (!r.ok) {
    const text = (await r.text()).slice(0, 300);
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch {}
    console.error(route + ' → HTTP ' + r.status + '：' + msg);
    process.exit(1);
  }
  return r.json();
}

if (cmd === 'show-token') {
  const t = adminToken();
  if (!t) { console.error(HASH_ONLY_HINT); process.exit(1); }
  console.log(t);
} else if (cmd === 'token') {
  // 同 npm run token（src/gen-token.mjs：--hash 只存哈希）；它在导入时就干活。
  // 默认沿用现在的存法：config.json 只存哈希的（install.sh 装的）换完仍只存哈希——忘了加 --hash 不能悄悄把明文写回去；
  // 要改存明文显式加 --plain。
  const now = readConfigSoft() || {};
  const hashOnly = !!now.tokenHash && !now.token;
  if (flags.has('--hash') && flags.has('--plain')) { console.error('--hash 和 --plain 只能选一个。'); process.exit(1); }
  const hash = flags.has('--hash') || (hashOnly && !flags.has('--plain'));
  if (hash && !process.argv.includes('--hash')) process.argv.push('--hash');
  await import('./gen-token.mjs');
  console.error(hash
    ? '（config.json 只存这个令牌的哈希' + (flags.has('--hash') ? '' : '，沿用原来的存法') + '：上面的明文只显示这一次，请当场存好。）'
    : '（明文令牌写在 config.json 的 "token"；以后 ' + CLI + ' show-token 能再查到。）');
  console.error('新令牌在服务端重启后生效。');
} else if (cmd === 'invite') {
  // 档位：普通 = 没有命令行；完全信任（存储值仍是 pro）= 有命令行和终端，等同管理员——
  // 服务端要 ack:true 才发，这里要人显式加 --ack。
  const want = String(arg || 'user').toLowerCase();
  const full = want === 'full' || want === 'pro';
  if (!full && want !== 'user') { console.error('档位只有 user（普通，默认）和 full（完全信任，旧名 pro）。'); process.exit(1); }
  if (full && !flags.has('--ack')) {
    console.error('完全信任等同管理员：有命令行，能读到服务器上所有人的对话、文件和全部凭据。\n确认要发就加 --ack：' + CLI + ' invite full --ack');
    process.exit(1);
  }
  const days = Number(flagValue('days')) || 0;
  if (flagValue('days') && !(days > 0 && days <= 90)) { console.error('--days 要是 1 到 90 之间的天数。'); process.exit(1); }
  const r = await admin('POST', '/api/admin/invite', { tier: full ? 'pro' : 'user', ...(full ? { ack: true } : {}), ...(days ? { days } : {}) });
  console.log(r.code);
  console.error('（一次性邀请码，' + (full ? '完全信任档（等同管理员）' : '普通档（没有命令行）')
    + (r.expiresAt ? '，' + fmtTime(r.expiresAt) + ' 前有效' : '') + '。对方在登录页选「注册」填它。）');
} else if (cmd === 'users') {
  const { users = [], invites = [], multiUser } = await admin('GET', '/api/admin/users');
  if (multiUser === false) console.error('（多用户关着：只有管理员与服务账号能登录。）');
  if (!users.length) console.log('还没有注册账号。');
  for (const u of users) console.log(`${u.name}\t${tierLabel(u)}${u.disabled ? '\t(已停用)' : ''}`);
  const open = invites.filter((i) => !i.usedBy && !i.used && !i.expired);
  if (open.length) {
    console.log('\n未使用的邀请码：\n' + open.map((i) => `${i.code}\t${tierLabel(i)}${i.expiresAt ? '\t' + fmtTime(i.expiresAt) + ' 前有效' : ''}`).join('\n'));
  }
} else {
  console.error([
    '用法：' + CLI + ' <命令>',
    '  show-token                 打印管理员访问令牌',
    '  token [--hash|--plain]     换一个新的访问令牌（重启服务端后生效；默认沿用现在的存法，只存哈希的仍只存哈希）',
    '  invite [user] [--days=N]   一次性普通档邀请码（要先打开多用户；默认 7 天有效）',
    '  invite full --ack          完全信任档（旧名 pro）：有命令行，等同管理员',
    '  users                      已注册账号与未用的邀请码',
  ].join('\n'));
  process.exit(cmd && cmd !== 'help' ? 1 : 0);
}
