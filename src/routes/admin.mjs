// Admin / process-management routes — the server-admin console surface.
//
// 闸门看 FEATURES.remoteAdmin（见 config/index.mjs；2026-10-21 版本合一后默认开）：
//   · NO_AUTH（loopback 调试台实例）：原样全开，行为不变；
//   · remoteAdmin 开（默认）：管理员身份（admin token 的 Bearer / cookie）远程可达，手机、网页上就能管
//     用户和 agent。这不扩大权限：admin 身份本就能经 Claude 在服务器上执行任意命令，控制台只是把这件事
//     做成了界面。写操作照旧受 server.mjs 的全局 Origin 闸保护。
//     但会把自己关在门外的动作远程一律拒绝（R2）：admin.ps1 的停服务 / 停隧道 / 装卸开机自启，
//     以及关掉、换掉正经由它连进来的那条公网隧道——这些只能在那台机器上（本机直连）做。
//   · remoteAdmin 关（config.json 显式 features.remoteAdmin:false）：仅放行「本机直连 + admin 凭据」的请求
//     （见 localAdmin），供桌面壳的「服务端设置」控制台使用；隧道 / 局域网来的请求一律 404。
//
// Also exposes /api/lan (LAN IPs + port, for the same-WiFi direct link) and
// /api/capabilities (the full capability snapshot the frontend uses, mirroring
// what's injected into index.html as window.__CAPS__).

import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { readBody } from '../runtime/body.mjs';
import { CAPABILITIES } from '../config/capabilities.mjs';
import { ROOT, PORT, NO_AUTH, FEATURES, DEPLOY, LISTEN_HOST, config, userRoot } from '../config/index.mjs';
import { PROGRAM_ROOT } from '../runtime/paths.mjs';
import { getModule } from '../modules/registry.mjs';
import * as users from '../users.mjs';
import { sessionsDir, sessionPaths } from '../runtime/paths.mjs';
import { readSessionTitle, readSessionMessages, trimTitle } from './sessions.mjs';
import { getLiveGens, listGens } from '../runtime/gen.mjs';
import { contextFor, userIdentity } from '../runtime/identity.mjs';
import { HOST_OWNER, ownerKey, parseOwnerKey } from '../runtime/principal.mjs';
import { appendAudit } from '../runtime/audit-log.mjs';
import { busPublish } from '../runtime/bus.mjs';
import * as claudeAccounts from '../runtime/claude-account.mjs';
import * as accountUsage from '../runtime/account-usage.mjs';
import * as accountRouter from '../runtime/account-router.mjs';
import { pendingQuestions, permAnswerFields } from '../runtime/questions.mjs';
import { getPolicy, setPolicy, registrationOpen } from '../runtime/policy.mjs';
import { quotaState, quotaBlock, billingUser, snapMinterIds } from '../runtime/quota.mjs';
import { consentsOf, accessAllowed, ownerAllows, logAccess, deniedMessage, PROXY_PREFIX, proxyOnlyConversation } from '../runtime/admin-access.mjs';
import { writeSseHeaders, sseWrite } from '../runtime/sse.mjs';
import { setAccountDisabled, setAccountTier, deleteAccount } from '../runtime/account-lifecycle.mjs';
import { accessState, registerAccountAdminRoutes } from './admin-accounts.mjs';
import { serviceInfo, requestRestart, supervisor, startUpdate } from '../runtime/service-control.mjs';
import { recentLogs } from '../runtime/log-ring.mjs';
import { publicAccess, NO_PROBE } from '../runtime/public-access.mjs';
import { serverUpdateInfo } from '../runtime/client-release.mjs';
import { apkInfo, lanCandidates } from './app-update.mjs';
import { CLAUDE_MODELS, CLAUDE_EFFORTS, VERTEX_MODELS, VERTEX_THINK_LEVELS } from '../config/capabilities.mjs';

const ADMIN_PS1 = path.join(PROGRAM_ROOT, 'admin.ps1');
// admin.ps1 只在 Windows 上能跑：Docker 镜像 / Linux 源码目录里也带着这个文件，以前据此以为「全功能」，
// 控制台一点就 spawn powershell 失败。
// 数据根不是程序目录的实例（agent 起的隔离测试实例、单独数据根的测试服）也不托管：admin.ps1 管的是程序目录那套
// 正式服（-Root 程序目录、-PhonePort 取的是这个实例自己 config 的 port，多半回落 8787），在这种实例的控制台里点
// 「全部重启」会杀掉正式服的隧道再按计划任务重拉正式服，「安装 / 移除自启」改的也是正式服的。按桌面壳那样降级。
const sameDir = (a, b) => { const x = path.resolve(a), y = path.resolve(b); return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y; };
const SCRIPT_OK = process.platform === 'win32' && existsSync(ADMIN_PS1) && sameDir(ROOT, PROGRAM_ROOT);
// 远程管理不许做的 admin.ps1 动作（R2）：做完就连不回来了，或改的是那台机器的开机自启。
const SELF_CUT_ACTIONS = new Set(['stop-server', 'stop-tunnel', 'remove', 'install']);
const PHONE_PORT = Number(config.port) || 8787;
const CF_LOG = path.join(ROOT, 'cloudflared.log');

// The PC's LAN IPv4 address(es), private ranges first. Used so the phone can be
// offered a direct http://<lan-ip>:PORT link to open when on the same WiFi —
// bypassing the Cloudflare tunnel entirely (full upload speed, lower latency).
function lanIPs() {
  const isPrivate = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const bogus = (ip) => /^(198\.1[89]\.|169\.254\.)/.test(ip); // cloudflared's 198.18/15, link-local
  // 虚拟网卡的 IP（Hyper-V vEthernet、VMware、VirtualBox、WSL、Docker、Tailscale/ZeroTier、
  // Clash/代理 TUN 等）手机根本路由不到——把它们排除，否则会被当 LAN 候选返回给手机白探一轮、
  // 甚至误选成直连地址（实测本机 192.168.176.1 就是 vEthernet (Default Switch)）。
  const virtualIface = (n) => /(vethernet|virtualbox|vmware|hyper-?v|loopback|wsl|docker|tailscale|zerotier|\btap\b|\btun\b|meta|clash|proxy|radmin|npcap)/i.test(n);
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (virtualIface(name)) continue;
    for (const ni of (ifaces[name] || [])) {
      if (ni.family === 'IPv4' && !ni.internal && !bogus(ni.address)) out.push(ni.address);
    }
  }
  out.sort((a, b) => (isPrivate(b) ? 1 : 0) - (isPrivate(a) ? 1 : 0));
  return out;
}

function tunnelUrlFromLog() {
  try {
    const m = readFileSync(CF_LOG, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
    return m && m.length ? m[m.length - 1] : null;
  } catch { return null; }
}

function runAdmin(action) {
  // 打包桌面服务端不带 admin.ps1（stage.ps1 刻意不复制）：进程/隧道/自启由桌面壳
  // 托管，这里直接报「不可用」，控制台按壳形态渲染，也省掉每次轮询白 spawn 一个 powershell。
  if (!SCRIPT_OK) return Promise.resolve({ unavailable: true });
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe',
      ['-NoProfile', '-File', ADMIN_PS1, '-Action', action, '-Root', PROGRAM_ROOT, '-PhonePort', String(PHONE_PORT)],
      { windowsHide: true });
    let out = '', err = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; });
    ps.on('error', () => resolve({ error: 'spawn failed' }));
    ps.on('close', (code) => {
      // 每个动作成功都会打一行 JSON；什么都没打 = 脚本在 try 外面就抛了（例如 Startup 文件夹解析为空时的 Join-Path），
      // 错误只在 stderr。以前当成 {} 解析，「查不到」被当成「全停了」进缓存，控制台显示「主服务 已停止」和「启动」按钮
      const t = out.trim();
      if (!t) { resolve({ error: code ? `admin.ps1 failed (exit ${code})` : 'admin.ps1 printed nothing', stderr: err.slice(0, 400) }); return; }
      try { resolve(JSON.parse(t)); }
      catch { resolve({ error: 'bad output', raw: out.slice(0, 400), stderr: err.slice(0, 400) }); }
    });
  });
}

// FR3 / S9：admin.ps1 status 每次冷起一个 PowerShell 再查 WMI（3–6 秒），控制台开着时以前每 8 秒一次、几乎
// 首尾相接，机器上一直挂着一个 PowerShell。现在：单飞（同时到的请求共用一次）+ 结果缓存 30 秒；缓存过期但手上
// 有旧值时先回旧值（带 stale:true）、后台刷新。启停动作之后清掉缓存并立刻重查，下一次拉到的就是新状态。
const STATUS_TTL = 30_000;
let statusCache = null, statusAt = 0, statusInflight = null;
// after：动作之后要在「正在跑的那次」后面再排一次（那次是动作之前起的，结果已经过时，不进缓存）。
function refreshAdminStatus(after = null) {
  if (statusInflight && !after) return statusInflight;
  const p = (after || Promise.resolve()).catch(() => {})
    .then(() => runAdmin('status'))
    // 出错的结果不进缓存：下一次请求重查，也不会被当旧值（stale）回给前端
    .then((r) => { if (statusInflight === p && !(r && r.error)) { statusCache = r; statusAt = Date.now(); } return r; })
    .finally(() => { if (statusInflight === p) statusInflight = null; });
  statusInflight = p;
  return p;
}
async function adminStatus() {
  if (!SCRIPT_OK) return { unavailable: true };
  if (statusCache && Date.now() - statusAt < STATUS_TTL) return { ...statusCache };
  if (statusCache && !statusCache.error) { refreshAdminStatus(); return { ...statusCache, stale: true }; }
  return { ...(await refreshAdminStatus()) };
}
function invalidateAdminStatus() {
  statusCache = null; statusAt = 0;
  if (SCRIPT_OK) refreshAdminStatus(statusInflight).catch(() => {});
}

// Re-exported so static.mjs can use it for /api/lan-style logic if needed.
export { lanIPs };

export function registerAdminRoutes(router, { authOk, adminCredential = null, adminGen = '' }) {
  // —— 本地管理员门 ——————————————————————————————————————————
  // 「本机直连」的判据（localAdmin），NO_AUTH 调试台恒真；三重硬条件缺一不可：
  //   ① TCP 对端是回环地址——LAN/0.0.0.0 直连的 socket 远端不是 127.0.0.1；
  //   ② 不带任何代理/转发痕迹头——经 cloudflared/反代来的请求必带
  //      cf-*/x-forwarded-*（公网攻击者无法让边缘替它摘头），本机直连天然没有；
  //   ③ authOk 过：admin token 的 Bearer/cookie；多用户 bridge_user 会话恒 false。
  // remoteAdmin 关时整个 admin 面只认它；remoteAdmin 开（默认）时 admin 面对管理员身份远程开放，
  // 只有会切断自己连接的动作还要求它（停服务 / 停隧道 / 开机自启、关掉正在用的公网隧道，见下）。
  const PROXY_MARKS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'forwarded'];
  const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  const localAdmin = (req) => {
    if (NO_AUTH) return true;
    if (!isLoopback(String((req.socket && req.socket.remoteAddress) || ''))) return false;
    for (const h of PROXY_MARKS) if (req.headers[h] != null) return false;
    return authOk(req);
  };
  // remoteAdmin 开（默认）：admin 身份即可，不论从哪来。
  const adminOk = (req) => (FEATURES.remoteAdmin && !NO_AUTH ? authOk(req) : localAdmin(req));
  const gate = (req, res) => {
    if (adminOk(req)) return true;
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
    return false;
  };

  // 探针：「服务端设置」入口据此决定是否显示（旧后端 404 → 按钮不出现）。
  // scriptAvailable 顺带告诉前端服务控制页该走 admin.ps1 全功能还是桌面壳降级形态；
  // remote 表示这是经远程管理进来的（手机 / 网页），前端据此只摆远程能用的页。
  // deploy：部署形态摘要（config/deploy-profile.mjs，S1-7）——控制台据此说清「这是哪种部署、默认值从哪来」；
  // ping 与「服务控制」的小卡片（SaService，读 /api/admin/service）共用。listenHost 是实际监听的地址。
  const deployInfo = Object.freeze({ profile: DEPLOY.profile, label: DEPLOY.label, source: DEPLOY.source, headless: DEPLOY.headless, listenHost: LISTEN_HOST });
  router.on('GET', '/api/admin/ping', (req, res) => {
    if (!gate(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, scriptAvailable: SCRIPT_OK, noAuth: NO_AUTH, multiUser: FEATURES.multiUser, remote: !localAdmin(req), supervisor: supervisor(),
      deploy: deployInfo }));
  });

  // ---- 服务控制（三端拆分 P4，任何形态都有）：进程 / 机器资源、最近日志、交给守护进程的重启 ----
  const drainAll = async () => { try { await getModule('dimensio')?.drainHarnesses?.(); } catch {} };
  // Windows 主机仍有 admin.ps1 那套（进程 + 隧道 + 开机自启）；Linux / Docker 上这是唯一的一套。
  router.on('GET', '/api/admin/service', async (req, res) => {
    if (!gate(req, res)) return;
    let harnessCount = 0;
    try { harnessCount = getModule('dimensio')?.harnessEndpoints?.().length || 0; } catch {}
    // serverUpdate：打包形态（桌面安装包里的本机服务端）自己有没有新版（上游发布清单，见 runtime/client-release.mjs）
    J(res, { ...serviceInfo({ dataRoot: ROOT, harnessCount }), apk: apkInfo(), serverUpdate: serverUpdateInfo(), deploy: deployInfo });
  });
  router.on('GET', '/api/admin/logs', (req, res, url) => {
    if (!gate(req, res)) return;
    const n = Number((url || new URL(req.url, 'http://x')).searchParams.get('n')) || 300;
    J(res, { lines: recentLogs(n) });
  });
  // 服务端重启（含更新完的自动重启）时 cloudflared 跟着收掉、新进程再申请——快速隧道的地址必变。远程经那个临时地址
  // 连着的管理员点了就再也连不回来（R2 的「重启会自己回来」对它不成立）→ 409 给人话。命名隧道 / 本机直连照常放行。
  const svcSelfCut = (req, res) => {
    const pa = publicAccess();
    const cut = pa ? pa.selfCutReason({}, { host: req.headers.host, local: localAdmin(req), server: true }) : '';
    if (!cut) return false;
    res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: cut }));
    return true;
  };
  // { mode: 'now' | 'idle' | 'cancel' }：now 立即（打断在跑的轮）、idle 等没有在跑的轮再重启（最多等 30 分钟）。
  router.on('POST', '/api/admin/service/restart', async (req, res) => {
    if (!gate(req, res)) return;
    let b = {}; try { b = JSON.parse(await readBody(req)) || {}; } catch {}
    const mode = b.mode === 'idle' || b.mode === 'cancel' ? b.mode : 'now';
    if (mode !== 'cancel' && svcSelfCut(req, res)) return;
    // reason:'update' + version：桌面客户端要装新版（S1-5，见 runtime/service-control.mjs 文件头）——只影响推给设备的提示
    const r = requestRestart(mode, { drain: drainAll, reason: b.reason === 'update' ? 'update' : 'restart', version: typeof b.version === 'string' ? b.version : '' });
    res.writeHead(r.error ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  });
  // 更新：git 部署 + 守护进程托管时，以服务用户跑 scripts/server/update.sh --no-restart，有新代码就等空闲重启
  router.on('POST', '/api/admin/service/update', (req, res) => {
    if (!gate(req, res)) return;
    if (svcSelfCut(req, res)) return;
    const r = startUpdate({ drain: drainAll });
    res.writeHead(r.error ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  });
  // 公开端点（无鉴权）：返回的是纯模型/能力枚举，零敏感信息，本就随 window.__CAPS__ 对
  // 所有访问 index.html 的人无条件注入。离线 apk 没有注入、退回 fetch 时，user 会话会被
  // authOk（只认 admin token）401 挡住 → 整个前端模型列表空。这里与 __CAPS__ 注入保持一致，
  // 不设防。注意 /api/lan 仍要鉴权（暴露内网拓扑），别一起放开。
  router.on('GET', '/api/capabilities', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(CAPABILITIES));
  });

  router.on('GET', '/api/lan', (req, res) => {
    if (!authOk(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // 同 server-info 的局域网候选：只听回环或跑在容器里时不给，只给私网地址（旧版 App 还靠这里学候选）
    const ips = lanCandidates(lanIPs).map((u) => { try { return new URL(u).hostname; } catch { return ''; } }).filter(Boolean);
    res.end(JSON.stringify({ ips, port: PORT }));
  });

  router.on('GET', '/api/admin/status', async (req, res) => {
    if (!gate(req, res)) return;
    const st = await adminStatus();
    st.tunnel = st.tunnel || {};
    st.tunnel.url = tunnelUrlFromLog();
    st.host = { name: os.hostname(), lan: lanIPs() };
    st.phonePort = PHONE_PORT;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(st));
  });

  router.on('POST', '/api/admin/action', async (req, res) => {
    if (!gate(req, res)) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const allowed = new Set(['restart-server', 'restart-tunnel', 'restart-both', 'stop-server', 'stop-tunnel', 'start-server', 'start-tunnel', 'install', 'remove']);
    if (!allowed.has(body && body.action)) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad action'); return; }
    // R2：经远程管理（手机 / 网页 / 隧道）进来的，不许做会把自己关在门外的事——停了服务 / 隧道就再也连不回来，
    // 动开机自启是改那台机器的常驻配置。重启类动作会自己回来，照常放行——经快速隧道临时地址连着的除外（svcSelfCut）。
    if (SELF_CUT_ACTIONS.has(body.action) && !localAdmin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '远程管理不能执行会切断自己连接的操作（停止服务 / 停止隧道 / 安装或移除开机自启），请在这台电脑上操作' }));
      return;
    }
    if ((body.action === 'restart-server' || body.action === 'restart-both') && svcSelfCut(req, res)) return;
    if (!SCRIPT_OK) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '这个实例不托管本机服务（没有 admin.ps1，或是数据根不在程序目录的测试实例）' }));
      return;
    }
    const r = await runAdmin(body.action);
    invalidateAdminStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  });

  // ---- 公网访问（内置托管 cloudflared：quick / token / manual / off，见 runtime/public-access.mjs）----
  // 契约（安装引导也调）：GET → {mode,status,url,lastProbe,cloudflared,log,hint,…}；POST {mode,token?,url?} → 应用后同结构；
  // POST /restart → 重启隧道（manual 模式 = 立刻重新探活）。令牌只存数据根 public-access.json，任何回包都不带。
  // 远程管理时，关掉 / 换掉「正经由它连进来」的那条隧道会把自己关在门外 → 409（本机直连不受限）。
  const paSelfCut = (req, b, restart = false) => {
    const pa = publicAccess();
    return pa ? pa.selfCutReason(b, { host: req.headers.host, local: localAdmin(req), restart }) : '';
  };
  const paReply = (res, r) => {
    const pa = publicAccess();
    const st = pa ? pa.status() : { mode: 'off', status: 'stopped', url: '', lastProbe: { ...NO_PROBE }, cloudflared: { available: false, version: '', path: '', downloading: false }, log: [], hint: '服务端还没准备好，稍后再试。', available: false };
    res.writeHead(r && r.error ? 400 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(r && r.error ? { ...st, error: r.error } : st));
  };
  router.on('GET', '/api/admin/public-access', (req, res) => {
    if (!gate(req, res)) return;
    paReply(res, null);
  });
  router.on('POST', '/api/admin/public-access', async (req, res) => {
    if (!gate(req, res)) return;
    let b = {}; try { b = JSON.parse(await readBody(req, 16 * 1024)) || {}; } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const cut = paSelfCut(req, b);
    if (cut) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: cut })); return; }
    const pa = publicAccess();
    paReply(res, pa ? await pa.apply(b) : { error: '服务端还没准备好，稍后再试' });
  });
  router.on('POST', '/api/admin/public-access/restart', async (req, res) => {
    if (!gate(req, res)) return;
    const cut = paSelfCut(req, {}, true);
    if (cut) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: cut })); return; }
    const pa = publicAccess();
    paReply(res, pa ? await pa.restart() : { error: '服务端还没准备好，稍后再试' });
  });

  // ---- Multi-user management（同上面的闸：remoteAdmin 关时只在本机，开着时管理员远程可用）。
  // 附带每个 agent 的全局状态，控制台据此把「全局已关 / 不支持多用户」的勾选框置灰。
  router.on('GET', '/api/admin/users', async (req, res) => {
    if (!gate(req, res)) return;
    // quotaNow：生效额度 + 今天 / 最近 7 天用量（控制台表格里「今天 3/20 轮」那一格）
    // adminAccess：这个成员允许了管理员什么（看内容 / 代聊代答 / 看他的电脑，runtime/admin-access.mjs），控制台据此置灰入口
    // snapMinter：手上有聊天快照的号（QQ 机器人这类）；还没标服务账号的，「改用推荐值」前控制台点名提醒
    const minters = snapMinterIds();
    const list = users.listUsers().map((u) => ({ ...u, usage: users.getUsage(u.name), quotaNow: quotaState(u.name), adminAccess: consentsOf(u.id || u.name), snapMinter: minters.has(u.id || u.name) }));
    const { agentStatusList } = await import('../runtime/agent-status.mjs');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // access：「给别人用」开关的已存 / 运行中取值、隔离等级与可放心发的档位（routes/admin-accounts.mjs）
    res.end(JSON.stringify({ users: list, invites: users.listInvites(), agents: agentStatusList(), multiUser: FEATURES.multiUser, registrationOpen: registrationOpen(), access: accessState() }));
  });

  router.on('POST', '/api/admin/invite', async (req, res) => {
    if (!gate(req, res)) return;
    // 多用户关着（features.multiUser=false）没有注册入口，发邀请码没有意义。
    if (!FEATURES.multiUser) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '这台主机没开多用户，不能注册；要给程序用的账号请直接「新建服务账号」' })); return; }
    let b = {}; try { b = JSON.parse(await readBody(req)); } catch {}
    const tier = users.normTier(b && b.tier); // 'pro' = 完全信任（有命令行，等同管理员）| 'user' = 普通（没有命令行）
    // 场景二默认只发普通档：完全信任的码要 ack:true（管理员看过「等同管理员」的说明并确认）。
    if (tier === users.TIER_FULL && b.ack !== true) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: users.FULL_TRUST_NEEDS_ACK, needAck: true })); return; }
    const days = Number(b.days);
    const code = users.createInvite(tier, { ack: b.ack === true, ...(days > 0 && days <= 90 ? { ttlMs: days * 86400000 } : {}) });
    const inv = users.listInvites().find((i) => i.code === code);
    audit(req, 'invite', { meta: { tier, code, ...(days > 0 && days <= 90 ? { days } : {}) } });   // code 只以哈希前缀进审计（codeHash），与作废那条对得上
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code, tier, expiresAt: inv ? inv.expiresAt : null }));
  });

  // 管理员直接建账号（不走邀请码）：服务端给朋友预建账号，或主机上建 QQ 机器人这类服务账号。
  // 主机关着多用户时只许建服务账号——普通账号建了也登不上。
  router.on('POST', '/api/admin/user/create', async (req, res) => {
    if (!gate(req, res)) return;
    let b = {}; try { b = JSON.parse(await readBody(req)); } catch {}
    const service = b.service === true || !FEATURES.multiUser;
    const wantTier = users.normTier(b.tier);
    // 直接建完全信任账号同样要 ack（见上面邀请码）。
    if (wantTier === users.TIER_FULL && b.ack !== true) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: users.FULL_TRUST_NEEDS_ACK, needAck: true })); return; }
    const r = await users.createUser(String(b.name || ''), String(b.password || ''), wantTier, { trustAck: wantTier === users.TIER_FULL ? Date.now() : 0 });
    if (!r.error && service) users.setService(r.name, true);
    if (!r.error && Array.isArray(b.agents)) users.setAgents(r.name, b.agents);
    if (!r.error) audit(req, 'user/create', { target: userKey(r.name), meta: { tier: r.tier, service } });
    res.writeHead(r.error ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.error ? r : { ...r, service }));
  });

  // 手机设置门（2026-10-18）：只开给「改了也断不了连接」的那一小撮配置——Claude 号池与智能换号、
  // 额度与注册。admin 身份（Bearer / cookie）即可、不论从哪来，同 /api/agents 与
  // /api/extensions；服务控制、隧道、客户端配对、管理员会话这些一改就可能把自己关在门外的，仍走上面的 gate。
  const settingsGate = (req, res) => {
    if (NO_AUTH || authOk(req) || adminOk(req)) return true;
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
    return false;
  };

  // 审计（开源路线 C12，runtime/audit-log.mjs）：建删账号、改档位 / 额度 / 授权、号池与策略改动、查看别人的数据、
  // 代聊、代答审批，一律落 _system/audit。actor 恒为主机身份；via = 哪一张凭据（'master' 主令牌 / 'noauth'
  // 本机调试台 / 管理员会话 id）。只记动作名与白名单字段（safeMeta），令牌、密码、对话内容不进审计。
  const adminVia = (req) => { const c = req && adminCredential ? adminCredential(req) : null; return !c ? '' : c.via === 'session' ? users.adminSessionIdOf(c.token) : c.via; };
  // 被操作的账号 → 它的 owner 键（与 contextFor 的 ctx.key 同一把：账号还在就按库里解析，删掉的按名字兜底）。
  const userKey = (name) => {
    const who = name ? userIdentity(String(name), { allowDisabled: true }) : null;
    if (who && who.user) return ownerKey('user', who.user);
    const n = users.normName(String(name || ''));
    return n ? ownerKey('user', n) : '';
  };
  const audit = (req, action, { target = '', meta } = {}) => { appendAudit({ actor: HOST_OWNER, via: adminVia(req), action, target, scope: target, meta }); };
  const routeAction = (req) => String((req && req.url) || '').split('?')[0].replace(/^\/api\/admin\//, '');

  // Shared wrapper for the {name,...}-body user mutations.
  const actionWith = (g) => (fn) => async (req, res) => {
    if (!g(req, res)) return;
    let b; try { b = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const target = b && b.name ? userKey(b.name) : String((b && b.key) || '');   // 先解析：删号之后就查不到了
    const r = (await fn(b || {})) || { ok: true };   // fn 可为 async（setPassword 走异步 scrypt）
    // id 由服务端生成的动作（号池加号）：请求体里没有 id，把结果里的补进审计，与之后 update / delete 的 meta.id 对得上
    if (!r.error) audit(req, routeAction(req), { target, meta: b && r.id && !b.id ? { ...b, id: r.id } : b });
    res.writeHead(r.error ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  };
  const userAction = actionWith(gate);
  const settingsAction = actionWith(settingsGate);
  // 改完按人的东西，推一条 me.changed 到该用户的总线：他在线的客户端当场刷新可用 agent 与权限。
  const touched = (b, r) => { if (!r.error) { const k = userKey(b.name); if (k) busPublish(k, { type: 'me.changed' }); } return r; };
  // 重置密码 = 这个人所有设备下线（密码多半是因为泄漏 / 忘了才重置的，旧登录不该还活着）。
  router.on('POST', '/api/admin/user/reset', userAction(async (b) => {
    const r = await users.setPassword(String(b.name || ''), String(b.password || ''));
    if (!r.error) users.deleteUserSessions(String(b.name || ''));
    return r;
  }));
  // 升为完全信任要 ack:true（管理员看过「等同管理员」的说明）；降为普通随时可以，且当场生效——
  // 在跑的轮、侧栏终端、无头浏览器、停放的 CLI 一并收掉（runtime/account-lifecycle.mjs setAccountTier）。
  router.on('POST', '/api/admin/user/tier', userAction(async (b) => touched(b, await setAccountTier(String(b.name || ''), String(b.tier || ''), { ack: b.ack === true }))));
  // 停用 = 登录失效 + 设备挂起 + 在跑的轮中止；启用即恢复（runtime/account-lifecycle.mjs）。
  router.on('POST', '/api/admin/user/disable', userAction((b) => touched(b, setAccountDisabled(String(b.name || ''), b.disabled !== false))));
  // 按人授权：agents = 统一 id 列表（claude/gemini/dimensio…）；snapshot = 能否铸公开聊天快照；
  // service = 服务账号（主机关掉多用户后仍能登录，QQ 机器人这类）。
  router.on('POST', '/api/admin/user/agents', userAction((b) => touched(b, users.setAgents(String(b.name || ''), Array.isArray(b.agents) ? b.agents : []))));
  router.on('POST', '/api/admin/user/snapshot', userAction((b) => touched(b, users.setSnapshotGrant(String(b.name || ''), b.snapshot === true))));
  router.on('POST', '/api/admin/user/service', userAction((b) => touched(b, users.setService(String(b.name || ''), b.service === true))));
  // 删号联动清理（S2-4）：会话、设备（留墓碑）、端口转发、在跑的轮、聊天快照、邀请记录、用量一并收掉；
  // 数据 mode:'purge'（连目录删，默认）| 'archive'（挪进 <usersRoot>/_archive/）。老界面传 purge:true/false → 删 / 归档。
  router.on('POST', '/api/admin/user/delete', userAction((b) => deleteAccount(String(b.name || ''), {
    mode: b.mode === 'archive' || (b.mode == null && b.purge === false) ? 'archive' : 'purge',
  })));
  // 「给别人用」开关、确认完全信任、改登录名、作废邀请码（routes/admin-accounts.mjs）
  registerAccountAdminRoutes(router, { gate, userAction, touched });

  // ---- 额度与注册（三端拆分 P4）：注册开关、注册用户默认额度、全服同时轮数上限、换日时区 ----
  router.on('GET', '/api/admin/policy', (req, res) => {
    if (!settingsGate(req, res)) return;
    J(res, { policy: getPolicy(), multiUser: FEATURES.multiUser, registrationOpen: registrationOpen() });
  });
  router.on('POST', '/api/admin/policy', settingsAction((b) => {
    const patch = {};
    if (typeof b.register === 'boolean') patch.register = b.register;
    if (b.quota && typeof b.quota === 'object') patch.quota = b.quota;
    if (b.maxUserTurns != null) patch.maxUserTurns = Number(b.maxUserTurns) || 0;
    // 开源路线 S2-6：每人并发、每人定时任务数、成员的高消耗功能开关、「改用推荐值」
    if (b.maxParallelPerUser != null) patch.maxParallelPerUser = Number(b.maxParallelPerUser) || 0;
    if (b.maxRoutinesPerUser != null) patch.maxRoutinesPerUser = Number(b.maxRoutinesPerUser) || 0;
    if (b.member && typeof b.member === 'object') patch.member = b.member;
    if (b.preset === 'recommended') patch.preset = 'recommended';
    if (typeof b.timezone === 'string' && b.timezone) patch.timezone = b.timezone.trim();
    const r = setPolicy(patch);
    return r.error ? r : { ...r, registrationOpen: registrationOpen() };
  }));
  // 个人额度覆盖：quota = { dayTurns, weekTurns, dayCostUsd, weekCostUsd }，写了的键覆盖默认、0 = 不限；null = 全跟默认。
  router.on('POST', '/api/admin/user/quota', userAction((b) => touched(b, users.setQuota(String(b.name || ''), b.quota && typeof b.quota === 'object' ? b.quota : null))));

  // ---- 管理员登录（三端拆分 P4）：「用访问令牌登录」与扫码确认铸出的管理员会话，能逐个吊销 ----
  // current = 发这个请求的那一张（前端据此标「本机」、吊销前提醒会把自己登出）。
  router.on('GET', '/api/admin/admin-sessions', (req, res) => {
    if (!gate(req, res)) return;
    const cur = adminCredential ? adminCredential(req) : null;
    J(res, {
      sessions: users.listAdminSessions(adminGen),
      current: cur && cur.via === 'session' ? users.adminSessionIdOf(cur.token) : null,
    });
  });
  router.on('POST', '/api/admin/admin-sessions/revoke', userAction((b) => ({
    ok: true, revoked: users.revokeAdminSessions(b.all === true ? 'all' : [String(b.id || '')]),
  })));

  // ---- 管理员可见性（开源路线 S2-7 / N13，runtime/admin-access.mjs）：默认只看元数据（会话标题、时间、用量）；
  // 看内容、代聊代答要成员自己在设置里允许，做了就在他那边记一笔。管理员自己（主机身份）的数据不经过这里。
  const consentDenied = (res, kind, why = kind) => { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: deniedMessage(why), code: 'consent', need: kind })); };
  // 在跑的轮：没允许看内容的成员，提问原文不给（只留 key / 会话 id / 时间这些元数据）
  const gensForAdmin = () => listGens().map((g) => (ownerAllows(g.key, 'view') ? g : { ...g, userText: '', hidden: true }));
  // 这段对话是不是从头到尾都是管理员代发的（找不到、读不了一律按「不是」，要「查看」才能接着聊）
  async function proxyOnlySession(vertex, sid, ctx) {
    try {
      if (vertex) {
        const conv = getModule('vertex')?.loadConversation?.(sid, ctx.vertexHist);
        return !!conv && proxyOnlyConversation(conv.messages);
      }
      const p = sessionPaths(sid, ctx.cwd, ctx.configDir);
      if (!p || !existsSync(p.file)) return false;
      return proxyOnlyConversation(await readSessionMessages(p.file));
    } catch { return false; }
  }

  // ---- Read-only oversight: list / read ANY user's sessions (admin console only) ----
  // 目录按账号 id（S2-4：老账号 id = 用户名，新账号是「名字-随机串」），参数传登录名或 id 都行。
  const acctRoot = (name) => userRoot(users.accountIdOf(name) || name);
  const userConfig = (name) => path.join(acctRoot(name), '.bridge', 'claude');
  router.on('GET', '/api/admin/user/sessions', async (req, res, url) => {
    if (!gate(req, res)) return;
    const name = users.normName(url.searchParams.get('name') || '');
    if (!users.getUser(name)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no such user'); return; }
    const dir = sessionsDir(acctRoot(name), userConfig(name));
    let entries = []; try { entries = readdirSync(dir, { withFileTypes: true }); } catch {}
    const files = entries.filter((d) => d.isFile() && d.name.endsWith('.jsonl')).map((d) => {
      const f = path.join(dir, d.name); let mtime = 0, size = 0;
      try { const st = statSync(f); mtime = st.mtimeMs; size = st.size; } catch {}
      return { id: d.name.slice(0, -6), file: f, mtime, size };
    }).sort((a, b) => b.mtime - a.mtime).slice(0, 40);
    const sessions = await Promise.all(files.map(async (f) => ({ id: f.id, mtime: f.mtime, size: f.size, title: trimTitle(await readSessionTitle(f.file)) || '(无标题)' })));
    audit(req, 'user/view', { target: userKey(name), meta: { what: 'sessions' } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user: name, sessions }));
  });
  router.on('GET', '/api/admin/user/session', async (req, res, url) => {
    if (!gate(req, res)) return;
    const name = users.normName(url.searchParams.get('name') || '');
    const id = url.searchParams.get('id') || '';
    if (!users.getUser(name)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no such user'); return; }
    if (!accessAllowed(name, 'view')) return consentDenied(res, 'view');
    const p = sessionPaths(id, acctRoot(name), userConfig(name));
    if (!p || !existsSync(p.file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    const all = await readSessionMessages(p.file);
    logAccess(name, { action: 'view_session', what: id });
    audit(req, 'user/view', { target: userKey(name), meta: { what: 'session', sessionId: id } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user: name, id, messages: all.slice(-120) }));
  });

  // ========== 调试台扩展：全局监控 + 中止任意 agent + 代任意用户续聊 ==========
  const J = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  // ---- Claude 账号切换（failover / 额度池）。手机设置也能管（settingsGate：号池改坏了也断不了连接）。
  // 切换即时全局生效：admin 对话 / 用户沙箱 / 定时路由的下一次 query() 都跟随激活账号的 token。
  router.on('GET', '/api/admin/claude-accounts', (req, res) => {
    if (!settingsGate(req, res)) return;
    // apiKeyMode：现在是不是走按量 API Key（'env' / 'desktop' 号池令牌不生效、'config' 号池里加了令牌就改用订阅号、
    // 'config-unused' config.json 里的 key 因号池有令牌没在用、'' 没走 key），见 claude-account.mjs
    J(res, { accounts: claudeAccounts.listAccounts(), apiKeyMode: claudeAccounts.apiKeyMode() });
  });
  // 逐号用量（5 小时 / 每周 / Fable 周限额）：来自 Claude Code 真实请求带回的额度信息，闲置的号是上次使用时的数据
  // （source:'last-use'）；配了 overlay 的用量来源就交给它（见 account-usage.mjs）。?force=1 强刷。
  router.on('GET', '/api/admin/claude-accounts/usage', async (req, res) => {
    if (!settingsGate(req, res)) return;
    const force = /[?&]force=1/.test(req.url || '');
    J(res, { usage: await accountUsage.poolUsage({ force }) });
  });
  // 号池智能路由（可选，默认关）：开关 + 各号是否被判不可用 + 最近的自动切换。
  router.on('GET', '/api/admin/claude-accounts/router', (req, res) => {
    if (!settingsGate(req, res)) return;
    J(res, accountRouter.routerStatus());
  });
  router.on('POST', '/api/admin/claude-account/router', settingsAction((b) => accountRouter.setRouterSettings({
    ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}),
    ...(typeof b.returnToPrimary === 'boolean' ? { returnToPrimary: b.returnToPrimary } : {}),
    ...(typeof b.seamless === 'boolean' ? { seamless: b.seamless } : {}),
  })));
  // 手动切号 = 管理员明确要用这个号：顺手清掉路由给它记的冷却。
  router.on('POST', '/api/admin/claude-account/active', settingsAction((b) => {
    const id = String(b.id || '');
    const r = claudeAccounts.setActive(id);
    if (r && r.ok) accountRouter.clearCooldown(id);
    return r;
  }));
  // 调整顺序（智能路由「回到首选号」按列表顺序定优先级）：delta=-1 上移 / 1 下移。
  router.on('POST', '/api/admin/claude-account/move', settingsAction((b) => claudeAccounts.moveAccount(String(b.id || ''), Number(b.delta) || 0)));
  router.on('POST', '/api/admin/claude-account/add', settingsAction((b) => claudeAccounts.addAccount({ label: b.label, token: b.token })));
  router.on('POST', '/api/admin/claude-account/update', settingsAction((b) => claudeAccounts.updateAccount(String(b.id || ''), { label: b.label, token: b.token })));
  router.on('POST', '/api/admin/claude-account/delete', settingsAction((b) => claudeAccounts.deleteAccount(String(b.id || ''))));

  // 聚合总览：服务/隧道 + 所有活跃 gen + routines 运行中 + 用户数。一个端点喂满总览面板。
  router.on('GET', '/api/admin/overview', async (req, res) => {
    if (!gate(req, res)) return;
    const st = await adminStatus(); st.tunnel = st.tunnel || {}; st.tunnel.url = tunnelUrlFromLog();
    let running = [];
    try { const rr = await import('../runtime/routines-runner.mjs'); running = [...(rr.routineRunning || [])]; } catch {}
    // 总览上的「公网访问」一行：只带摘要（完整状态与日志在 /api/admin/public-access）
    let pub = null;
    try { const s = publicAccess()?.status(); if (s) pub = { mode: s.mode, status: s.status, url: s.url, hint: s.hint, managedBy: s.managedBy, lastProbe: s.lastProbe, available: s.available }; } catch {}
    J(res, { service: st, host: { name: os.hostname(), lan: lanIPs() }, phonePort: PHONE_PORT, gens: gensForAdmin(), routinesRunning: running, userCount: users.listUsers().length, publicAccess: pub });
  });

  // 列所有 caller 的活跃 Claude 生成
  router.on('GET', '/api/admin/active', (req, res) => { if (!gate(req, res)) return; J(res, { gens: gensForAdmin() }); });

  // 按 key（'admin' / 'u:<name>'）中止任意用户的活跃生成（多对话并发：全停；
  // 可选 b.sessionId 只停某一轮）
  router.on('POST', '/api/admin/stop', userAction((b) => {
    const want = String(b.sessionId || '');
    const live = getLiveGens(String(b.key || '')).filter((g) => !want || g.sessionId === want);
    if (!live.length) return { ok: false, error: '该 key 无活跃生成' };
    for (const g of live) { try { g.abort.abort(); } catch {} }
    return { ok: true, stopped: live.length };
  }));

  // 代任意用户续聊（claude / vertex）——contextFor 注入目标用户上下文，会话落到该用户目录
  router.on('POST', '/api/admin/user/chat', async (req, res) => {
    if (!gate(req, res)) return;
    let b; try { b = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const name = users.normName(String(b.name || ''));
    const who = userIdentity(name, { allowDisabled: true });
    if (!who) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no such user'); return; }
    // 代聊要成员自己允许（S2-7）；代发的消息带「管理员代发」标记，他在自己的会话里看得见，这一轮也不挂他的电脑（claude.mjs deviceOk）。
    if (!accessAllowed(name, 'assist')) return consentDenied(res, 'assist');
    // actor = 主机身份、scope = 被代的这个人（开源路线 C1）：数据照旧落他的目录、记他的账，「是谁发的」留在 ctx.actor。
    const ctx = contextFor({ ...who, actor: HOST_OWNER });
    const raw = String(b.message || '').trim();
    if (!raw) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '消息是空的' })); return; }
    const message = PROXY_PREFIX + raw;
    const sessionId = b.sessionId ? String(b.sessionId) : undefined;
    const vertex = b.agent === 'vertex';
    // 代聊也守这个人的 agent 名单：代他用一个他本来用不了的 agent，会话就落进他目录里了。
    if (vertex ? !ctx.allowGemini : !ctx.allowClaude) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '该用户没有这个 agent 的权限，或它未启用' })); return;
    }
    const runVertexChat = vertex ? getModule('vertex')?.runVertexChat : null;
    if (vertex && !runVertexChat) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Gemini 扩展没装' })); return; }
    // 接着代聊一段已有的对话：回复带着那段对话的上下文流回控制台，等于读了它——还要成员允许「查看」。
    // 例外是从头到尾都是管理员代发的会话（管理员自己代聊开的，成员没在里面说过话）：只开「协助」也能接着聊。
    if (sessionId && !accessAllowed(name, 'view') && !(await proxyOnlySession(vertex, sessionId, ctx))) return consentDenied(res, 'view', 'continue');
    // 额度（S2-6）：代聊的轮算被代的人的，开跑前先查——Gemini 与 Claude 同一道闸、同一个账本。
    // Claude 的轮由 runClaudeChat 自己记（它里面还会再查一次）；Gemini 的在这里记，同 chat.mjs 扩展 agent 分支。
    const billTo = billingUser(ctx);
    const block = billTo ? quotaBlock(billTo) : null;
    if (block) { writeSseHeaders(res); sseWrite(res, { type: 'error', kind: 'quota', title: block.title, message: block.message }); res.end(); return; }
    audit(req, 'user/chat', { target: ctx.key, meta: { agent: vertex ? 'vertex' : 'claude', sessionId: sessionId || '' } });
    logAccess(name, { action: 'chat', what: sessionId || '', detail: vertex ? 'Gemini' : 'Claude' });
    if (vertex) {
      if (billTo) { try { users.noteTurnStart(billTo); } catch {} }
      return runVertexChat(req, res, { message, sessionId, vertexModel: VERTEX_MODELS.has(b.vertexModel) ? b.vertexModel : undefined, vertexSearch: b.vertexSearch === true, vertexThink: VERTEX_THINK_LEVELS.has(b.vertexThink) ? b.vertexThink : undefined, ctx });
    }
    const { runClaudeChat } = await import('../agents/claude.mjs');
    // 代聊按无人值守处理（permissionPolicy 'host'）：控制台没有审批卡，固定 default + 宿主放行（runtime/permissions.mjs）
    return runClaudeChat(req, res, { message, sessionId, model: CLAUDE_MODELS.has(b.model) ? b.model : undefined, effort: CLAUDE_EFFORTS.has(b.effort) ? b.effort : undefined, attachments: [], ctx, permissionPolicy: 'host', plain: true });   // plain：代聊页只渲染文本，不挂内嵌图表

  });

  // 代任意用户回答 AskUserQuestion（loopback 信任，直接 settle）
  router.on('POST', '/api/admin/user/answer', async (req, res) => {
    if (!gate(req, res)) return;
    let b; try { b = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const e = pendingQuestions.get(String(b.qid || ''));
    if (!e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no pending question'); return; }
    // 代答别人的提问 / 审批要那个成员允许（S2-7）；主机自己的、没有属主的老条目照旧。
    if (!ownerAllows(String(e.ownerKey || ''), 'assist')) return consentDenied(res, 'assist');
    // choice：sessions MCP 的 offer 卡（新会话 / 在这里做），同 /api/answer
    const choice = typeof b.choice === 'string' ? b.choice.slice(0, 40) : undefined;
    // 审批卡的 decision / mode / feedback 同 /api/answer 透传（questions.mjs permAnswerFields）
    e.settle(b.cancelled ? { cancelled: true } : { answers: Array.isArray(b.answers) ? b.answers : [], ...permAnswerFields(b), ...(choice ? { choice } : {}) });
    audit(req, 'user/answer', { target: String(e.ownerKey || ''), meta: { qid: String(b.qid || ''), kind: String(e.kind || '') } });
    if (parseOwnerKey(String(e.ownerKey || ''))?.kind === 'user') logAccess(String(e.ownerKey), { action: 'answer', what: String(e.kind || '') });
    J(res, { ok: true });
  });

  // 看任意用户的 routines / 媒体 / vertex 会话（复用 contextFor 派生其存储路径）。这里只解析身份；
  // 「查看了别人的数据」的审计由各路由在同意检查通过、真把数据交出去之后再写（viewed），被拒（403）的不记，
  // 带上 req 才知道是哪一张管理员凭据（via）。媒体文件是列表里的单张取图，跟着 media 那一条，不逐张记。
  const userCtx = (url) => {
    const name = users.normName(url.searchParams.get('name') || ''); const who = userIdentity(name, { allowDisabled: true });
    if (!who) return null;
    return { name, ctx: contextFor(who) };
  };
  const viewed = (req, uc, what, meta) => audit(req, 'user/view', { target: userKey(uc.name), meta: { what, ...(meta || {}) } });
  router.on('GET', '/api/admin/user/routines', async (req, res, url) => {
    if (!gate(req, res)) return; const uc = userCtx(url); if (!uc) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no user'); return; }
    let list = []; try { list = (await import('../routines.mjs')).list(uc.ctx.dataDir); } catch {}
    // 没允许看内容：只给名字、时间、状态这些元数据，提示词与结果预览不给（S2-7）
    const metaOnly = !accessAllowed(uc.name, 'view');
    if (metaOnly) list = list.map((r) => ({ ...r, prompt: '', lastPreview: '', hidden: true }));
    else if (list.length) logAccess(uc.name, { action: 'view_routines' });
    viewed(req, uc, 'routines', metaOnly ? { hidden: true } : null);
    J(res, { user: uc.name, routines: list });
  });
  router.on('GET', '/api/admin/user/media', async (req, res, url) => {
    if (!gate(req, res)) return; const uc = userCtx(url); if (!uc) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no user'); return; }
    if (!accessAllowed(uc.name, 'view')) return consentDenied(res, 'view');
    const kind = url.searchParams.get('kind') || 'image';
    logAccess(uc.name, { action: 'view_media', what: kind });
    viewed(req, uc, 'media', { kind });
    let list = []; try { list = (await import('../vertex-media.mjs')).list(kind, uc.ctx.media); } catch {}
    J(res, { user: uc.name, kind, media: list });
  });
  // 取任意用户的媒体文件（图片整发 / 视频音频 Range）——调试台媒体预览要从该用户目录读
  router.on('GET', '/api/admin/user/media-file', async (req, res, url) => {
    if (!gate(req, res)) return; const uc = userCtx(url); if (!uc) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no user'); return; }
    if (!accessAllowed(uc.name, 'view')) return consentDenied(res, 'view');
    let file = null, serve = null;
    try { file = (await import('../vertex-media.mjs')).fileFor(url.searchParams.get('id') || '', uc.ctx.media); serve = (await import('./media-file.mjs')).serveMediaFile; } catch {}
    if (!file || !serve) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    serve(req, res, file);
  });
  router.on('GET', '/api/admin/user/vertex', async (req, res, url) => {
    if (!gate(req, res)) return; const uc = userCtx(url); if (!uc) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no user'); return; }
    let list = []; try { list = getModule('vertex')?.listConversations?.(uc.ctx.vertexHist) || []; } catch {}
    viewed(req, uc, 'vertex');
    J(res, { user: uc.name, sessions: list });
  });
  router.on('GET', '/api/admin/user/vertex-session', async (req, res, url) => {
    if (!gate(req, res)) return; const uc = userCtx(url); if (!uc) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no user'); return; }
    if (!accessAllowed(uc.name, 'view')) return consentDenied(res, 'view');
    logAccess(uc.name, { action: 'view_gemini', what: url.searchParams.get('id') || '' });
    viewed(req, uc, 'vertex-session', { sessionId: url.searchParams.get('id') || '' });
    let data = null; try { data = getModule('vertex')?.loadConversation?.(url.searchParams.get('id') || '', uc.ctx.vertexHist) || null; } catch {}
    J(res, data || { messages: [] });
  });

  // 下游客户端配对 / 中继管理原先在这里（直通同机中继的 /admin/*）。中继并进 bridge 之后，
  // 设备、审计、探查都走 routes/devices.mjs 的 /api/devices/*（控制台「设备」页）。
}
