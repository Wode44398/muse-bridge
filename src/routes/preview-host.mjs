// 公网预览 Host 路由：pv-<token>.<PV_PUBLIC_DOMAIN> → 本机 dev server 端口。
//
// 链路：手机浏览器 → Cloudflare edge（*.根域 通配 DNS + 隧道 wildcard ingress）
//   → bridge(8787) → 本文件按 Host 头识别 pv- 子域 → 查 harness 服务注册表
//   （token→port，短缓存）→ 反代到 localhost:<port>。
//
// 安全模型 = 能力 URL：token 是 ~82bit 不可猜随机串，且只在服务存活期间可解析
// （注册表实时来自 harness，Preview stop / harness 重启后即 404）。这条路径
// 【故意】绕过 bridge 鉴权——手机外部浏览器带不上 apk 的 Bearer 头，dev server
// 本身也是临时的演示品；除 pv- 精确匹配外的任何 Host 一律不走这里。

import http from 'node:http';
import net from 'node:net';
import { PV_PUBLIC_DOMAIN } from '../config/index.mjs';
import { getModule } from '../modules/registry.mjs';
import { forwardByToken, proxyForward } from '../runtime/device-forward.mjs';

// 实例注册表由 dimensio 扩展提供；没装 dimensio = 没有预览子域可反代。
const harnessEndpoints = () => getModule('dimensio')?.harnessEndpoints?.() || [];
import { pageLang } from './share-gate.mjs';

const HARNESS_HOST = '127.0.0.1';
const TOKEN_RE = /^pv-([a-z0-9]{8,40})$/;
const CACHE_MS = 5000;

// token → port 的注册表快照。miss 时强刷一次（新起的服务 5s 缓存窗口内也能开）。
let cache = { at: 0, map: new Map() };

function fetchServices(ep) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      // harness 的 API 只认令牌（S1），这里带上该实例那把。
      { host: ep.host, port: ep.port, path: '/api/preview/services', method: 'GET', timeout: 2000, headers: ep.headers },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      },
    );
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

// 多用户后每个用户有自己的 harness 实例（routes/harness.mjs 的实例池），预览服务分散在各实例的注册表里：挨个问、合并。
async function serviceMap(force = false) {
  if (!force && Date.now() - cache.at < CACHE_MS) return cache.map;
  const map = new Map();
  let anyOk = false;
  for (const ep of harnessEndpoints()) {
    try {
      const list = await fetchServices(ep);
      anyOk = true;
      if (Array.isArray(list)) {
        for (const s of list) {
          if (s && s.publicToken && s.status !== 'exited') map.set(String(s.publicToken), Number(s.port));
        }
      }
    } catch { /* 这个实例不可达（重启间隙等）：跳过 */ }
  }
  // 全都不可达：保留旧表但盖时间戳，避免每个请求都打超时。
  cache = { at: Date.now(), map: anyOk ? map : cache.map };
  return cache.map;
}

// Host 头 → token；非 pv- 子域（含 bridge 自己的域名/裸 IP/LAN 访问）返回 null。
export function pvTokenFromHost(hostHeader) {
  if (!PV_PUBLIC_DOMAIN) return null;
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  if (!host.endsWith('.' + PV_PUBLIC_DOMAIN)) return null;
  const sub = host.slice(0, -(PV_PUBLIC_DOMAIN.length + 1));
  const m = sub.match(TOKEN_RE);
  return m ? m[1] : null;
}

async function resolvePort(token) {
  let map = await serviceMap();
  if (!map.has(token)) map = await serviceMap(true);
  return map.get(token) ?? null;
}

function proxyHttp(req, res, port) {
  const headers = { ...req.headers };
  delete headers.connection;
  // dev server 眼里这就是本机访问；X-Forwarded-* 留给讲究的框架自己用。
  headers.host = `localhost:${port}`;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = String(req.headers.host || '');
  const upstream = http.request(
    { host: HARNESS_HOST, port, path: req.url, method: req.method, headers },
    (ures) => {
      res.writeHead(ures.statusCode || 502, ures.headers);
      ures.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(pageLang({ headers: req.headers }) === 'en' ? 'Can’t reach the preview server. It may have just restarted or exited.' : '预览服务不可达（可能刚重启或已退出）');
    } else { try { res.end(); } catch { /* ignore */ } }
  });
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}

const gone = (res) => {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  // 访客页语言见 share-gate.mjs pageLang（默认中文；浏览器语言里没有中文才出英文）。中文页原样不动。
  // 只看请求头：地址是被预览的 dev app 自己的，它的 ?lang= 不归我们管。
  if (pageLang({ headers: res.req?.headers }) === 'en') {
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;color:#555"><div style="text-align:center"><h2 style="color:#222">This preview has ended</h2><p>The dev server stopped or the link expired.<br>Go back to the chat and ask the agent to start the preview again.</p></div>');
    return;
  }
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;color:#555"><div style="text-align:center"><h2 style="color:#222">这个预览已经结束</h2><p>dev server 已停止或链接已失效。<br>回到对话里让 agent 重新启动预览即可。</p></div>');
};

// 设备端口转发的路径入口：/fwd/<令牌>[/路径][?查询]。没带斜杠就补上（相对地址才解析得对）。
const FWD_RE = /^\/fwd\/([a-z0-9]{8,40})(.*)$/;

// 注册为【第一个】中间件：pv- 子域的请求与 bridge 自身的路由/鉴权完全隔离。
// 设备端口转发（runtime/device-forward.mjs）同样是能力 URL：/fwd/<令牌>/… 路径入口，以及令牌落在 pv- 子域上。
export function registerPreviewHostRoutes(router) {
  router.use(async (req, res) => {
    if (req.url.startsWith('/fwd/')) {
      const m = FWD_RE.exec(req.url);
      const f = m && forwardByToken(m[1]);
      if (!f) { gone(res); return false; }
      let rest = m[2] || '';
      if (!rest.startsWith('/')) {
        if (req.method === 'GET' || req.method === 'HEAD') { res.writeHead(302, { Location: `/fwd/${m[1]}/${rest}` }); res.end(); return false; }
        rest = '/' + rest;
      }
      proxyForward(req, res, f, rest, { mode: 'path' });
      return false;
    }
    const token = pvTokenFromHost(req.headers.host);
    if (!token) return; // 不是预览子域 → 继续正常分派
    const fwd = forwardByToken(token);
    if (fwd) { proxyForward(req, res, fwd, req.url, { mode: 'host' }); return false; }
    const port = await resolvePort(token);
    if (!port) { gone(res); return false; }
    proxyHttp(req, res, port);
    return false;
  });
}

// WebSocket（vite HMR 等）：upgrade 不走 router.dispatch，单独挂在 server 上。
// 对目标端口建裸 TCP，原样重放请求行+头，然后双向管道。
// 返回撤销函数（插件停用时摘掉监听）。
export function attachPreviewHostUpgrade(server) {
  const onUpgrade = async (req, socket, head) => {
    const token = pvTokenFromHost(req.headers.host);
    if (!token) { socket.destroy(); return; } // bridge 自身无 ws 端点
    // 设备端口转发暂不转 WebSocket（vite 热更新连不上，页面照常可用）
    if (forwardByToken(token)) { socket.destroy(); return; }
    const port = await resolvePort(token);
    if (!port) { socket.destroy(); return; }
    const up = net.connect(port, HARNESS_HOST, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        const v = k.toLowerCase() === 'host' ? `localhost:${port}` : req.rawHeaders[i + 1];
        raw += `${k}: ${v}\r\n`;
      }
      raw += '\r\n';
      up.write(raw);
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  };
  server.on('upgrade', onUpgrade);
  return () => server.off('upgrade', onUpgrade);
}
