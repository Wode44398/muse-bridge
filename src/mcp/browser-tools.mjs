// In-process MCP：给 Claude 分页的 agent 一双「浏览器手眼」。驱动 claude-browser.mjs
// 里按工作空间隔离的 headless CDP 实例——与右侧栏浏览器面板同一实例，agent 操作时
// 面板 screencast 实时同屏，用户也能随手接管。单工具 action 枚举（少占提示词）。
// ctx.shell 身份（admin/Pro）拿全量；聊天快照（公开 /c/ 链接）拿【带缰绳的版本】：
// 只准去公网或快照桶内的文件，eval 关掉——见下面 snapGuard。
// claude.mjs 里按 run 闭包 getGen 路由事件。

import path from 'node:path';
import { realpathSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getCurrentGen, genEmit } from '../runtime/gen.mjs';

import { runBrowserAction, browserParams, BROWSER_DESCRIPTION } from '../runtime/browser-actions.mjs';
import { poolRef } from '../runtime/principal.mjs';


// 快照模式追加的说明：访客那边是【只读直播】，只有你能开页面。
const SNAP_DESC = `
【快照限制】这是一个公开聊天快照里的浏览器：访客只能观看直播画面、动不了鼠标键盘，页面全由你打开。允许的去处只有两种——① 公网站点（https/http）；② 你自己工作空间里的文件（file:// 绝对路径，必须在工作空间目录内，用来把你做的网页/图表当场展示给访客看）。本机地址（localhost / 127.x / 内网 IP）与工作空间外的文件一律被服务端拒绝，eval 也不可用。`;

// —— 快照浏览器的去处白名单 ——
// 公开链接的匿名访客能让 Claude 开任意网址 = 直接绕开「cwd 锁死在桶内」的沙箱：
// file:///C:/… 能读本机文件、127.0.0.1 能打 bridge 自己/QQBot launcher(5710)/内网路由器
// 后台。所以这里在【服务端】硬拦，不靠提示词自觉。
const LOCAL_SUFFIX = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/i;

// v4 字面量：私网/回环/链路本地/CGNAT/多播等一律不放行。
function v4Private(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [+m[1], +m[2]];
  if (m.slice(1).some((x) => +x > 255)) return true;   // 畸形 → 当私网拒掉
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}

// v6 解析结果判私网：回环/未指定/链路本地 fe80::/10、ULA fc00::/7、v4 映射（点分与
// 十六进制两种形态）统统拒；其余公网 v6 放行。
function v6Private(addr) {
  const s = String(addr).toLowerCase();
  if (s === '::' || s === '::1') return true;
  if (/^fe[89ab]/.test(s)) return true;
  if (/^f[cd]/.test(s)) return true;
  if (s.startsWith('::ffff:')) {
    const tail = s.slice(7);
    return tail.includes(':') ? true : v4Private(tail);   // 十六进制形态直接拒（公网站点不会这样解析）
  }
  return false;
}

async function hostBlocked(hostRaw) {
  const h = String(hostRaw || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return true;
  if (LOCAL_SUFFIX.test(h)) return true;
  if (v4Private(h)) return true;
  // IPv6 字面量一律拒。逐段判私网太容易漏（WHATWG URL 会把 ::ffff:127.0.0.1 归一成
  // ::ffff:7f00:1，纯文本匹配就骗过去了），而「开公网页面」根本用不着裸 IPv6——按主机名走。
  if (h.includes(':')) return true;
  if (!h.includes('.')) return true;                      // 裸主机名（router / nas …）= 内网
  // S5：字面量检查挡不住通配 DNS（127.0.0.1.nip.io 这类解析到内网的公网域名）。真解析
  // 一次，任一结果落在私网/回环即拒；解析失败同样拒（fail-closed，正经公网站点不会解析
  // 失败）。注：这挡住「域名直指内网」一整类；TTL 级 DNS rebinding 要代理层才彻底，
  // 快照沙箱先到这一档。
  try {
    const addrs = await lookup(h, { all: true, verbatim: true });
    if (!addrs.length) return true;
    return addrs.some(({ address, family }) => (family === 4 ? v4Private(address) : v6Private(address)));
  } catch { return true; }
}

// 返回拒绝原因字符串；null = 放行。ws 为快照桶绝对路径。（异步：主机名要真解析 DNS）
export async function snapUrlDenied(raw, ws) {
  const u = String(raw || '').trim();
  if (!u || u === 'about:blank') return null;
  let parsed;
  try { parsed = new URL(u); } catch { return '这不是一个有效的网址'; }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme === 'file:') {
    let p;
    try { p = fileURLToPath(parsed); } catch { return '本地文件路径无法解析'; }
    let target = path.resolve(p);
    try { target = realpathSync.native ? realpathSync.native(target) : realpathSync(target); } catch { /* 文件还不存在也按原路径判 */ }
    let root = path.resolve(ws || '');
    try { root = realpathSync.native ? realpathSync.native(root) : realpathSync(root); } catch {}
    const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    const [t, r] = [fold(target), fold(root)];
    if (!r || (t !== r && !t.startsWith(r + path.sep))) return '只能打开你自己工作空间目录里的文件';
    return null;
  }
  if (scheme !== 'http:' && scheme !== 'https:') return `不支持 ${scheme} 协议——只能开公网页面或工作空间内的文件`;
  if (await hostBlocked(parsed.hostname)) return '不能访问本机与内网地址（只能开公网站点）';
  return null;
}

// roots：upload 允许取文件的目录（沙箱身份=其私有目录/媒体目录；admin 传 null 不限）。
// owner：浏览器池的属主（principal.scopeOf(ctx)）；池按（属主, 工作空间）键控，与右侧面板同一把键。
// 动作本身全在 runtime/browser-actions.mjs（与 Codex / 远程客户端共用一套）；这里只管
// 参数表、事件路由与快照缰绳。
export const makeBrowserMcp = ({ getGen, ws, owner = '', snap = false, roots = null } = {}) => createSdkMcpServer({
  name: 'browser',
  version: '1.0.0',
  tools: [
    tool('browser', BROWSER_DESCRIPTION + (snap ? SNAP_DESC : ''), browserParams(z), async (args) => {
      const gen = (getGen && getGen()) || getCurrentGen();
      const onActivity = ({ action, url }) => { if (gen) genEmit(gen, { type: 'browser', url: url || '', action }); };
      return runBrowserAction(poolRef(owner, ws), args, onActivity, snap
        ? { urlDenied: (u) => snapUrlDenied(u, ws), snap: true, roots }
        : { roots });
    }),
  ],
});
