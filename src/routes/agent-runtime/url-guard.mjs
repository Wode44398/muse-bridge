// dimensio 经内部接口驱动的浏览器能去哪（runBrowserAction 的 urlDenied，动作前后都验，越界即刻退回空白页）。
// bridge 自己的非快照浏览器对去处不设限；dimensio 本地那套有两道（harness 的 controlPlaneUrlBlock / fileUrlBlock），
// 转到这边不能丢——实例那边在转发前仍先拦一遍，这里是 bridge 侧的同一道闸（页面自己跳过去的，只有这边看得见）：
//   · 控制面：回环地址上 bridge 自己、各个 dimensio 实例、harness 开发页、桌面壳（调试端口 + broker）的端口，外加实例报来的端口
//     （只能加、不能减）。浏览器开着主机的持久配置档，这些页面上挂着已登录的界面与令牌；
//   · file://：管理员（本就有整机命令行）不在这里限；成员只许工作空间与他自己的空间之内。
//   · 只放行 http(s) / file / about / data，javascript: 之类一律拒。
// 写成字面量以外的主机名（解析到回环的公网域名）也按解析结果判，解析失败不拦（公网照常开）。
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { PORT as BRIDGE_PORT } from '../../config/index.mjs';
import { getModule } from '../../modules/registry.mjs';
import { desktopHostInfo } from '../../runtime/desktop-host.mjs';
import { allowedRoots } from '../../runtime/principal.mjs';

const DEV_UI_PORT = 5178;   // harness 的开发页（harness/server/control-plane.ts DEV_UI_PORT）

const portOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0; };

export function controlPorts(extra = []) {
  const ports = new Set([DEV_UI_PORT]);
  const add = (v) => { const n = portOf(v); if (n) ports.add(n); };
  add(BRIDGE_PORT);
  add(process.env.HARNESS_PORT || 8799);
  try { for (const e of getModule('dimensio')?.harnessEndpoints?.() || []) add(e?.port); } catch { /* 扩展没装 */ }
  try {
    const h = desktopHostInfo();
    if (h) { add(h.cdpPort); try { add(new URL(h.brokerUrl).port); } catch {} }
  } catch { /* 没有桌面壳 */ }
  for (const p of Array.isArray(extra) ? extra.slice(0, 64) : []) add(p);
  return ports;
}

export function loopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(h);
}

const dnsCache = new Map();   // host → { loop, at }
async function resolvesToLoopback(host) {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.loop;
  let loop = false;
  try { loop = (await lookup(host, { all: true, verbatim: true })).some((a) => loopbackHost(a.address)); } catch { loop = false; }
  dnsCache.set(host, { loop, at: Date.now() });
  if (dnsCache.size > 200) dnsCache.delete(dnsCache.keys().next().value);
  return loop;
}

const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
const realOr = (p) => { try { return realpathSync.native ? realpathSync.native(p) : realpathSync(p); } catch { return path.resolve(p); } };
function insideAny(file, roots) {
  const t = fold(realOr(path.resolve(file)));
  return roots.some((r) => {
    const root = fold(realOr(path.resolve(r)));
    return t === root || t.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

/** 给 runBrowserAction 的 urlDenied：返回拒绝原因（中文，给模型看）或 null。 */
export function agentUrlGuard(ctx, ws, { extraPorts = [] } = {}) {
  const ports = controlPorts(extraPorts);
  const fileRoots = allowedRoots(ctx) === null ? null : [ws, ...(allowedRoots(ctx) || [])];
  return async (raw) => {
    const u = String(raw || '').trim();
    if (!u || u === 'about:blank') return null;
    let parsed;
    try { parsed = new URL(u); } catch { return null; }   // 写法不对的交给导航自己报错
    const scheme = parsed.protocol.toLowerCase();
    if (scheme === 'about:' || scheme === 'data:') return null;
    if (scheme === 'file:') {
      if (!fileRoots) return null;
      let p;
      try { p = fileURLToPath(parsed); } catch { return '本地文件路径无法解析'; }
      return insideAny(p, fileRoots) ? null : '只能打开你自己工作空间里的文件';
    }
    if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'ws:' && scheme !== 'wss:') return `不支持 ${scheme} 协议`;
    const port = portOf(parsed.port) || (scheme === 'https:' || scheme === 'wss:' ? 443 : 80);
    if (!ports.has(port)) return null;
    const host = parsed.hostname;
    const loop = loopbackHost(host) || (!/^[\d.]+$/.test(host) && !host.includes(':') && await resolvesToLoopback(host));
    return loop ? `${parsed.host} 是 bridge / dimensio 自己的控制面（服务端、开发页或桌面壳），agent 的浏览器不能去；要改设置请告诉用户在界面里改` : null;
  };
}
