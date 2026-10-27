// 桌面壳「原生浏览器宿主」注册通道（admin 专属）。
//
// 附着形态（主机台）：生产 bridge 由计划任务托管、早于壳启动，env 传不进来——壳连上
// bridge 后把自己的 Electron CDP 端口 + WebContentsView broker POST 进来（60s 心跳复注册，
// 覆盖 bridge 重启；壳退出时 remove）。客户端/服务端形态 spawn 时已走 env，本路由只是
// 等价兜底。落盘副本给 harness 子进程读（见 runtime/desktop-host.mjs 头注）。
//
// 只用 GET/POST（bridge 全家惯例，CORS/代理不碰 DELETE）：注销 = POST {remove:true}。

import { readBody } from '../runtime/body.mjs';
import { requireCtx } from '../runtime/identity.mjs';
import { registerDesktopHost, clearDesktopHost, desktopHostInfo } from '../runtime/desktop-host.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

export function registerDesktopHostRoutes(router, { identify }) {
  const admin = (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return null;
    if (ctx.kind !== 'admin') { json(res, 403, { error: '仅管理员可注册桌面浏览器宿主' }); return null; }
    return ctx;
  };

  router.on('POST', '/api/desktop/browser-host', async (req, res) => {
    if (!admin(req, res)) return;
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'bad body' }); }
    if (body?.remove) {
      clearDesktopHost();
      return json(res, 200, { ok: true, removed: true });
    }
    try {
      const info = registerDesktopHost({ cdpPort: body?.cdpPort, brokerUrl: body?.brokerUrl });
      json(res, 200, { ok: true, cdpPort: info.cdpPort });
    } catch (e) {
      json(res, 400, { error: e?.message || String(e) });
    }
  });

  // 排障用：当前 bridge 眼里的宿主（brokerUrl 含 secret，不外泄，只报有无与来源）。
  router.on('GET', '/api/desktop/browser-host', (req, res) => {
    if (!admin(req, res)) return;
    const info = desktopHostInfo();
    json(res, 200, info ? { present: true, source: info.source, cdpPort: info.cdpPort } : { present: false });
  });
}
