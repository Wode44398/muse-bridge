// 命令行写 Claude 订阅令牌：npm run set-auth -- <claude setup-token 生成的令牌>
//
// 号池（claudeAccounts）上线后，config.oauthToken 只在第一次启动时播种一次号池，之后服务端只认号池里的激活号
// （runtime/claude-account.mjs 的 claudeEngineEnv）——只改 oauthToken 等于没改（S4）。所以这里直接写号池：
//   · 还没有号池：建一个「默认账号」放这个令牌并激活；
//   · 令牌已在池里：把那个号设为激活号；
//   · 激活号还没有令牌（向导里跳过了 Claude）：填进激活号；
//   · 否则追加一个新号并激活。
// oauthToken 也同步写上（老版本服务端认它，号池播种也是同一个口径）。
// 服务端在跑时要重启才生效：它只在启动时读号池，跑着的进程之后改号池会按内存里的那份写回。
// 别的工具（桌面客户端的服务端向导）可以 import { applyClaudeToken } 复用：纯变换，不读写文件。

import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 把令牌写进配置对象的号池（就地改 cfg）。返回 { cfg, action, id }，action：created | activated | filled | added。 */
export function applyClaudeToken(cfg, token) {
  const t = String(token || '').trim();
  if (!t) throw new Error('令牌不能为空');
  const newId = () => 'a-' + randomBytes(4).toString('hex');
  cfg.oauthToken = t;
  const list = Array.isArray(cfg.claudeAccounts)
    ? cfg.claudeAccounts.filter((a) => a && typeof a === 'object').map((a) => ({ ...a, id: String(a.id || newId()), label: String(a.label || ''), token: String(a.token || '') }))
    : [];
  if (!list.length) {
    const id = newId();
    cfg.claudeAccounts = [{ id, label: '默认账号', token: t }];
    cfg.claudeActiveAccount = id;
    return { cfg, action: 'created', id };
  }
  const active = list.find((a) => a.id === cfg.claudeActiveAccount) || list[0];
  let action, id;
  const same = list.find((a) => a.token === t);
  if (same) { id = same.id; action = 'activated'; }
  else if (!active.token) { active.token = t; id = active.id; action = 'filled'; }
  else { id = newId(); list.push({ id, label: '账号 ' + (list.length + 1), token: t }); action = 'added'; }
  cfg.claudeAccounts = list;
  cfg.claudeActiveAccount = id;
  return { cfg, action, id };
}

// 直接运行（node src/set-auth.mjs / npm run set-auth）才动文件；被 import 时只导出纯函数。Windows 盘符大小写可能不一，按不分大小写比。
// 两边都先解析软链 / 目录联接再比：Node 对入口脚本做 realpath（import.meta.url 是真实路径），argv[1] 却只是绝对化——
// 经软链的程序根（/opt/bridge → 某个版本目录、bridge-releases/current）跑时不解析就会判成「被 import」，什么都不写还退出 0。
const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const norm = (p) => (p && process.platform === 'win32' ? p.toLowerCase() : p);
const isMain = (() => {
  if (!process.argv[1]) return false;
  const a = real(path.resolve(process.argv[1]));
  const b = real(fileURLToPath(import.meta.url));
  return !!a && !!b && norm(a) === norm(b);
})();
if (isMain) {
  // 跟服务端同一个数据根（BRIDGE_DATA_ROOT，没设就是程序目录）。
  const { DATA_ROOT } = await import('./runtime/paths.mjs');
  const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');

  // 参数写 - 就从标准输入读（脚本里用：令牌不出现在进程参数里，ps 看不到）
  let token = (process.argv[2] || '').trim();
  if (token === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    token = Buffer.concat(chunks).toString('utf8').trim();
  }
  if (!token) {
    console.error('Usage: npm run set-auth -- <oauth-token-from-claude-setup-token>   （或 echo <令牌> | node src/set-auth.mjs -）');
    process.exit(1);
  }

  let cfg = {};
  if (existsSync(CONFIG_PATH)) {
    try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')); }
    catch { console.error('config.json 解析失败（JSON 损坏）。请先修好它再运行——拒绝覆盖以免丢失其它配置。'); process.exit(1); }
  }
  const { action } = applyClaudeToken(cfg, token);
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  const what = { created: '建了号池并激活', activated: '池里已有这个令牌，已把那个账号设为激活', filled: '填进了当前激活的账号', added: '追加为新账号并激活' }[action];
  console.log(`已写入 Claude 号池（${what}，令牌长度 ${token.length}）。重启服务端后生效。`);
}
