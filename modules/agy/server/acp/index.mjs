// ACP 常驻单例编排层：向路由与对话模块提供共享客户端实例，并在主进程退出时统一清理子进程树。

import path from 'node:path';
import { DATA_ROOT } from '@bridge/core/runtime/paths.mjs';
import { AcpClient } from './client.mjs';
import { agySessionStore, agyDataDir, agyDesktopDataDir, AGY_DESKTOP_APP_DATA_DIR } from './binary.mjs';
import { isAgyTenant, tenantClient, peekTenantClient, tenantDataDir, shutdownTenants } from '../tenants.mjs';

export { AcpClient } from './client.mjs';
export { locateAgy, agyInstalled, agyCredentialsPresent, agyDataDir, agyDesktopDataDir, agySessionStore, killProcessTree } from './binary.mjs';

let sharedClient = new AcpClient({ dataDir: agyDataDir() });

export function getAcpClient() {
  return sharedClient;
}

// ── 桌面版存储的第二个常驻进程 ─────────────────────────────────────────────────
// 在 Antigravity 桌面版里建的会话只存在 ~/.gemini/antigravity：主进程（antigravity-cli 存储）列得出、载不出
// （回放 0 条 → 前端骨架屏之后一片空白）。这类会话的载入 / 续聊 / 改配置 / 取消一律交给
// `agy acp --app-data-dir antigravity`，懒启动，没有在跑轮且闲置 IDLE_MS 后自动退出。
const DESKTOP_IDLE_MS = 10 * 60_000;
let desktopClient = null;
let desktopLastUse = 0;
let desktopIdleTimer = null;
let storeOverride = null;   // 测试用：(sessionId) => 'cli' | 'desktop'

function ensureDesktopClient() {
  if (!desktopClient) {
    desktopClient = new AcpClient({
      label: 'desktop',
      extraArgs: ['--app-data-dir', AGY_DESKTOP_APP_DATA_DIR],
      // 占位目录必须叫 daemon-cwd（prepareReadOnlyDaemonDir 只认这个名字），且不能和主进程共用：shutdown 会解锁它
      daemonCwd: path.join(DATA_ROOT, 'agy', 'desktop', 'daemon-cwd'),
      logFile: path.join(DATA_ROOT, 'agy', 'acp-desktop.log'),
      dataDir: agyDesktopDataDir(),
    });
  }
  desktopLastUse = Date.now();
  if (!desktopIdleTimer) {
    desktopIdleTimer = setInterval(() => {
      const c = desktopClient;
      if (!c) return;
      const busy = c.turns.size > 0 || c.preparingTurns > 0 || c.pendingPermissions.size > 0 || c.pendingQuestions.size > 0;
      if (busy) { desktopLastUse = Date.now(); return; }
      if (c.proc && Date.now() - desktopLastUse > DESKTOP_IDLE_MS) c.shutdown();
    }, 60_000);
    desktopIdleTimer.unref?.();
  }
  return desktopClient;
}

/** 会话所在存储对应的客户端：桌面版建的会话走桌面版存储进程，其余（含新会话）走主进程 */
export function getAcpClientFor(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return sharedClient;
  // 测试里主客户端指向假 agent（command 已设）时不分流，除非显式注入了判定函数
  if (!storeOverride && sharedClient.command) return sharedClient;
  const store = storeOverride ? storeOverride(id) : agySessionStore(id);
  return store === 'desktop' ? ensureDesktopClient() : sharedClient;
}

/** 现存的全部客户端（审批 / 提问按 requestId 应答时逐个试） */
export function allAcpClients() {
  return desktopClient ? [sharedClient, desktopClient] : [sharedClient];
}

// ── 按身份取 ───────────────────────────────────────────────────────────────────
// 注册用户各有各的 agy 进程与数据目录（tenants.mjs），管理员用主机上那两个（常驻 + 桌面版存储）。
// 凡是处理某个身份的请求，一律经下面这几个取——上面不带身份的那几个只该出现在「明确是管理员 / 主机」的地方
//（控制台状态、登出、agy 的全局 MCP 与插件管理）。

/** 处理这个身份的某个会话该用哪个进程 */
export function acpFor(ctx, sessionId = '') {
  return isAgyTenant(ctx) ? tenantClient(ctx) : getAcpClientFor(sessionId);
}
/** 这个身份的主进程（列会话、新建会话） */
export function acpPrimary(ctx) {
  return isAgyTenant(ctx) ? tenantClient(ctx) : sharedClient;
}
/** 这个身份名下此刻起着的全部进程（按 requestId 应答审批 / 提问时只在这里面找，答不到别人的） */
export function acpClientsOf(ctx) {
  if (isAgyTenant(ctx)) { const c = peekTenantClient(ctx); return c ? [c] : []; }
  return allAcpClients();
}
/** 这个身份的 agy 数据目录（会话库、文字记录、产物都在里面） */
export function agyDataDirsOf(ctx) {
  return isAgyTenant(ctx) ? [tenantDataDir(ctx)] : [agyDataDir(), agyDesktopDataDir()];
}

export function setDesktopClientForTest(client, storeFn = null) {
  if (desktopClient && desktopClient !== client) desktopClient.shutdown();
  desktopClient = client || null;
  storeOverride = storeFn;
  return desktopClient;
}

// 供测试替换为指向假 stdio agent 的隔离客户端实例
export function setAcpClientForTest(client) {
  if (sharedClient && sharedClient !== client) {
    sharedClient.shutdown();
  }
  sharedClient = client || new AcpClient();
  return sharedClient;
}

export async function warmupAgy() {
  await sharedClient.ensureStarted();
  return sharedClient.status();
}

export async function restartAgy(opts) {
  // 桌面版存储进程不跟着重启：下次用到时懒启动，按需重新挂载
  try { desktopClient?.shutdown(); } catch {}
  return sharedClient.restart(opts);
}

export function requestIdleRestartAgy(opts) {
  return sharedClient.requestIdleRestart(opts);
}

export function shutdownAgy() {
  sharedClient.shutdown();
  try { desktopClient?.shutdown(); } catch {}
  try { shutdownTenants(); } catch {}
}

export function getAgyDaemonStatus() {
  return sharedClient.status();
}

process.once('exit', () => {
  try { sharedClient?.shutdown(); } catch {}
  try { desktopClient?.shutdown(); } catch {}
});
