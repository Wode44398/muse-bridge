// 设备：让 bridge 上的 agent 操作你自己的电脑（桌面客户端）。
//
// 两类调用方，两套鉴权：
//   · 设备侧（设备令牌，Authorization: Bearer）——设备服务挂控制通道、回传结果、查客户端更新。原先这些在独立中继进程里（client/host/relay-server.mjs），现在由 bridge 自己承担；
//     老客户端认的 /d/<令牌>/control/* 等路径也原样挂着，把地址从中继换成 bridge 就能连。
//     远程协助（配对码 + 免安装被控端）已下线：/pair 与铸码接口都没了。
//   · 账号侧（登录态）——列出 / 登记 / 改名 / 吊销自己的设备；管理员看得见所有人的。
//
// 设备只给它的主人用（owner = 身份 key），工具侧的归属检查见 runtime/devices.mjs。

import { readBody } from '../runtime/body.mjs';
import { requireCtx, contextFor } from '../runtime/identity.mjs';
import {
  registerDevice,
  deviceTokenState, touchDevice, listDevices, deviceById, renameDevice, revokeDevice, deleteDevice,
  updateDeviceMeta, importRelayDevices,
} from '../runtime/device-registry.mjs';
import { deviceLoginState, setLifecycleAdminGen } from '../runtime/account-lifecycle.mjs';
import { sessionInfo } from '../users.mjs';
import {
  attachDevice, settleResult, abortDevice, parseClientInfo, deviceRuntime, deviceEvents, isDeviceOnline, DEVICE_MAX_BYTES,
} from '../runtime/device-control.mjs';
import { deviceAudit, readDeviceAudit } from '../runtime/device-audit.mjs';
import { deviceDispatch, devicesEnabled, publicDevice, ownDevices, resolveDevice, onServerMachine } from '../runtime/devices.mjs';
import {
  ensureDeviceTerm, deviceTerm, snapshotDeviceTerm, subscribeDeviceTerm, writeDeviceTerm, resizeDeviceTerm, killDeviceTerm,
} from '../runtime/device-term.mjs';
import { listForwards, createForward, removeForward, dropForwardsOfDevice } from '../runtime/device-forward.mjs';
import { clientReleaseFor, clientReleaseForAsync, streamClientFile, clientModuleFile } from '../runtime/client-release.mjs';
import { busPublish } from '../runtime/bus.mjs';
import { writeSseHeaders, sseWrite, startHeartbeat } from '../runtime/sse.mjs';
import { deviceLinkFor, setDeviceLink } from '../runtime/chat-prefs.mjs';
import { hostSecretOk, isLocalDirect, rotateHostSecret } from '../runtime/host-secret.mjs';
import { looksLikeAgentDeviceToken, agentDeviceTokenCtx } from '../runtime/agent-device-token.mjs';
import { agentDeviceLink, setAgentDeviceLink, AGENT_LINK_SESSION_RE } from '../runtime/agent-device-links.mjs';
import { PUBLIC_ORIGIN, PV_PUBLIC_DOMAIN } from '../config/index.mjs';

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1].trim() : '';
}

// 设备真实来源：经隧道进来时 socket 地址恒是 cloudflared，看 CF-Connecting-IP。
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').trim();
}
// 限频 / 未授权审计用的来源：只有 socket 对端是回环（本机 cloudflared 转进来的）才认 CF-Connecting-IP；
// 局域网 / 公网直连 8787 的请求头随便伪造，每次换一个值就能绕过限频（R9）。
const isLoopbackAddr = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
function trustedIp(req) {
  const sock = String(req.socket?.remoteAddress || '').trim();
  return isLoopbackAddr(sock) ? String(req.headers['cf-connecting-ip'] || sock).trim() : sock;
}

async function jsonBody(req, res, max = 64 * 1024) {
  try { return JSON.parse((await readBody(req, max)) || '{}'); }
  catch (e) { json(res, e?.message === 'body too large' ? 413 : 400, { error: e?.message === 'body too large' ? '请求体过大' : '请求体不是合法 JSON' }); return null; }
}

// 设备状态变化推给主人的所有在线页面（设备芯片、设置页、控制台）。
deviceEvents.on('online', (id) => { const d = deviceById(id); if (d) busPublish(d.owner, { type: 'devices', id, online: true }); });
deviceEvents.on('offline', (id) => { const d = deviceById(id); if (d) busPublish(d.owner, { type: 'devices', id, online: false }); });

// adminCredential / adminGen（可选，server.mjs 传）：管理员登记的设备绑到那张管理员会话 / 那把主令牌上（S2-4）。
export function registerDeviceRoutes(router, { identify, adminCredential = null, adminGen = '' }) {
  setLifecycleAdminGen(adminGen);
  // ── 设备侧 ──────────────────────────────────────────────────────────────

  // 未授权访问的审计按来源 IP 限频（每分钟一条）：/d/<任意 20+ 字符> 谁都能刷，每条都 appendFile 会被刷爆（R9）。
  // 来源用 trustedIp（伪造的 CF-Connecting-IP 不算数）；表有硬上限，满了最多每 10 秒扫一次过期条目，
  // 扫完还满就不再记新来源——被人换着来源刷时，审计与扫表开销都不跟着涨。
  const UNAUTH_MAX = 4096;
  const unauthSeen = new Map();   // ip -> 上次记的时间
  let unauthSweptAt = 0;
  const auditUnauth = (ev, req) => {
    const ip = trustedIp(req);
    const now = Date.now();
    const last = unauthSeen.get(ip);
    if (last && now - last < 60_000) return;
    if (!last && unauthSeen.size >= UNAUTH_MAX) {
      if (now - unauthSweptAt < 10_000) return;
      unauthSweptAt = now;
      for (const [k, t] of unauthSeen) if (now - t >= 60_000) unauthSeen.delete(k);
      if (unauthSeen.size >= UNAUTH_MAX) return;
    }
    unauthSeen.set(ip, now);
    deviceAudit({ ev, ip });
  };

  // 设备令牌鉴权：吊销的、不存在的、登记它的那次登录已经结束的一律 401；顺手记 lastSeen。
  // 401 带 reason，客户端据此决定要不要自动重新登记（S2-4，以前一律同一句话，吊销 5 秒后客户端就自己登记回来）：
  //   unknown    令牌不认识（服务端数据换过、同一台电脑重新登记过）→ 可以自动重新登记；
  //   signed-out 登记它的那次登录已退出 / 过期 → 可以重新登记（还没重新登录的话登记本身会被拒）；
  //   revoked    这台设备被吊销 / 删除 → 别自动登记回来；
  //   account    所属账号停用或删除 → 别自动登记回来。
  const deviceAuth = (req, res, token) => {
    const st = deviceTokenState(token);
    if (st.state !== 'ok') {
      auditUnauth('unauthorized', req);
      json(res, 401, st.state === 'revoked'
        ? { error: '这台设备已被吊销', reason: 'revoked' }
        : { error: '设备未登记或令牌已失效', reason: 'unknown' });
      return null;
    }
    const d = st.device;
    const login = deviceLoginState(d);
    if (login !== 'ok') {
      auditUnauth('unauthorized', req);
      json(res, 401, login === 'account'
        ? { error: '这台设备所属的账号已停用或删除', reason: 'account' }
        : { error: '登记这台设备的登录已退出或过期，重新登录后会自动重新登记', reason: 'signed-out' });
      return null;
    }
    touchDevice(d.id);
    return d;
  };

  const handleStream = (req, res, d) => {
    if (!devicesEnabled()) return json(res, 403, { error: '这台 bridge 关闭了设备通道（config.devices=false）' });
    const parsed = parseClientInfo(req.headers['x-bridge-client']);
    // local：本机直连挂上来的（服务端判的，不信设备自报）——服务端所在电脑上的客户端，更新分流与「服务端更新」靠它认（runtime/devices.mjs onServerMachine）
    const info = parsed ? { ...parsed, local: isLocalDirect(req) } : null;
    deviceAudit({ ev: 'attach', device: d.id, name: d.name, owner: d.owner, ip: clientIp(req), ...(info ? { version: info.version, tier: info.tier || (info.desktop ? 'control' : 'workspace') } : {}) });
    updateDeviceMeta(d.id, { lastOnlineAt: new Date().toISOString(), ...(info ? { client: { ...info, reportedAt: new Date().toISOString() } } : {}) });
    attachDevice(d.id, res, {
      info,
      onDetach: (ms) => {
        updateDeviceMeta(d.id, { lastOfflineAt: new Date().toISOString() });
        deviceAudit({ ev: 'detach', device: d.id, ms });
      },
    });
  };

  const handleResult = async (req, res, d) => {
    let body;
    try { body = JSON.parse((await readBody(req, DEVICE_MAX_BYTES)) || '{}'); }
    catch (e) { return json(res, 400, { error: e?.message || 'bad body' }); }
    // 流式 op 的一块可能要等访问方收走才回（端口转发的回压，见 settleResult）
    const ok = await settleResult(d.id, body);
    return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '无此在途 op（可能已超时）' });
  };

  // legacy：老客户端经 /d/<令牌>/client/version 来问，下载地址按「它的中继基址 + downloadPath」拼——
  // 得给它 /client/download（同在 /d/<令牌>/ 下），不能给新路径，否则老客户端永远升不上来。
  // 发哪一版看这台设备是不是服务端所在的电脑（runtime/client-release.mjs「谁拿哪一版」）：服主那台拿 GitHub 最新（连同服务端一起升），
  // 打包形态服务端的其它设备只拿与服务端同一次发布的。回包带 feed（上次查 GitHub 的结果），客户端设置页据此说「暂时查不到新版本」。
  const handleClientVersion = async (req, res, d, url, { legacy = false } = {}) => {
    const hosting = onServerMachine(d, req);
    const { release, feed } = await clientReleaseForAsync({ hosting });
    if (!release) return json(res, 404, { error: '这台 bridge 还没有可发的桌面客户端', ...(feed ? { feed } : {}) });
    const current = String(url.searchParams.get('current') || '').slice(0, 40);
    if (/^[\w.+-]+$/.test(current)) updateDeviceMeta(d.id, { client: { version: current, reportedAt: new Date().toISOString() } });
    deviceAudit({ ev: 'client_update_check', device: d.id, version: release.version, ...(current ? { current } : {}) });
    const { file, ...meta } = release;
    const out = { ...meta, ...(feed ? { feed } : {}), ...(hosting ? { hosting: true } : {}) };
    return json(res, 200, legacy && meta.downloadPath ? { ...out, downloadPath: '/client/download' } : out);
  };
  const releaseOf = (req, d) => clientReleaseFor({ hosting: onServerMachine(d, req) });

  router.on('GET', '/api/device/stream', (req, res) => {
    const d = deviceAuth(req, res, bearer(req));
    if (d) handleStream(req, res, d);
  });
  router.on('POST', '/api/device/result', async (req, res) => {
    const d = deviceAuth(req, res, bearer(req));
    if (d) await handleResult(req, res, d);
  });
  // 设备自查：我是谁、归谁（桌面客户端登录后核对令牌用）。
  router.on('GET', '/api/device/whoami', (req, res) => {
    const d = deviceAuth(req, res, bearer(req));
    if (d) json(res, 200, { device: { id: d.id, name: d.name, owner: d.owner, kind: d.kind } });
  });
  router.on('GET', '/api/device/client/version', async (req, res, url) => {
    const d = deviceAuth(req, res, bearer(req));
    if (d) await handleClientVersion(req, res, d, url);
  });
  router.on('GET', '/api/device/client/download', (req, res) => {
    const d = deviceAuth(req, res, bearer(req));
    if (!d) return;
    const release = releaseOf(req, d);
    if (!release) return json(res, 404, { error: '这台 bridge 还没有可发的桌面客户端' });
    deviceAudit({ ev: 'client_update_download', device: d.id, version: release.version });
    streamClientFile(req, res, release);
  });

  // 老中继的探活路径（老客户端的连通性探针打它）；什么都不泄露。
  router.on('GET', '/health', (req, res) => json(res, 200, { ok: true, service: 'bridge-devices', enabled: devicesEnabled() }));

  // 老中继的能力 URL：/d/<设备令牌>/<子路径>。被控端把令牌放在路径里（它们的 Authorization 头
  // 当年被 AI 上游凭据占着），这里照认。
  router.use(async (req, res, url) => {
    const m = /^\/d\/([A-Za-z0-9_-]{20,})(\/.*)?$/.exec(url.pathname);
    if (!m) return;
    const sub = m[2] || '/';
    const d = deviceAuth(req, res, m[1]);
    if (!d) return false;
    if (sub === '/control/stream' && req.method === 'GET') { handleStream(req, res, d); return false; }
    if (sub === '/control/result' && req.method === 'POST') { await handleResult(req, res, d); return false; }
    if (sub === '/client/version' && req.method === 'GET') { await handleClientVersion(req, res, d, url, { legacy: true }); return false; }
    if (sub === '/client/download' && req.method === 'GET') {
      const release = releaseOf(req, d);
      if (!release) json(res, 404, { error: '这台 bridge 还没有可发的桌面客户端' });
      else streamClientFile(req, res, release);
      return false;
    }
    if (sub === '/client/module' && req.method === 'GET') {
      const mod = clientModuleFile(url.searchParams.get('id'));
      if (!mod) json(res, 404, { error: '没有这个功能扩展的离线包' });
      else streamClientFile(req, res, mod);
      return false;
    }
    if (sub === '/bootstrap') {
      // 老客户端开机要这个；AI 上游已经不经这里出网了，只回设备身份。
      json(res, 200, { relayOrigin: PUBLIC_ORIGIN || '', upstreams: [], directProviders: {}, vertex: null, device: { id: d.id, name: d.name } });
      return false;
    }
    json(res, 410, { error: 'AI 请求不再经 bridge 中转——请把客户端更新到新版（Claude 现在直接跑在 bridge 上）。' });
    return false;
  });

  // 同机子进程（Codex 的 stdio MCP、dimensio 的 harness）操作设备，本机直连 + 两种凭据：
  //   · 主机密钥 → 管理员身份（管理员的 Codex / dimensio 实例），op 不设限（同原来）；
  //   · 按人设备令牌（runtime/agent-device-token.mjs，注册用户的 dimensio 实例）→ 那个用户自己，只能操作他名下的设备，
  //     op 限于 Claude 设备工具用得到的那几样（桌面 / 浏览器 / 命令 / 文件）。
  // 目标解析同 Claude 的设备工具：device 参数 > 会话连接的设备（带了 session 时按 <by>:<会话 id> 查）> 恰好一台在线。
  const SCOPED_OPS = /^(desktop|browser|shell|fs\.(read|write|list|glob|stat|mkdir|move|delete))$/;
  const internalCtx = (req, res) => {
    if (isLocalDirect(req)) {
      if (hostSecretOk(req)) return { ctx: contextFor({ kind: 'admin', user: null }), scoped: false };
      const tok = bearer(req);
      const hit = looksLikeAgentDeviceToken(tok) ? agentDeviceTokenCtx(tok) : null;
      if (hit) return { ctx: hit.ctx, scoped: true, agent: hit.agent };
    }
    json(res, 404, { error: 'not found' });
    return null;
  };
  const byOf = (v) => (/^[a-z]{2,16}$/.test(String(v || '')) ? String(v) : 'agent');
  const linkOfReq = (ctx, by, session) => (session ? agentDeviceLink(ctx, by, String(session)) || '' : '');
  const opDevice = (d) => ({ id: d.id, name: d.name, tier: d.client?.tier || '', caps: d.client?.caps || [] });
  router.on('GET', '/api/internal/devices', (req, res, url) => {
    const who = internalCtx(req, res);
    if (!who) return;
    const by = byOf(url.searchParams.get('by'));
    const session = String(url.searchParams.get('session') || '');
    json(res, 200, { enabled: devicesEnabled(), devices: ownDevices(who.ctx), link: linkOfReq(who.ctx, by, session) });
  });
  router.on('POST', '/api/internal/device-op', async (req, res) => {
    const who = internalCtx(req, res);
    if (!who) return;
    const body = await jsonBody(req, res, DEVICE_MAX_BYTES);
    if (!body) return;
    if (!devicesEnabled()) return json(res, 200, { ok: false, error: '这台 bridge 关掉了设备通道（config.json devices=false）。' });
    const by = byOf(body.by);
    const op = String(body.op || '');
    if (who.scoped && !SCOPED_OPS.test(op)) return json(res, 200, { ok: false, error: `不支持的设备操作：${op}` });
    const session = typeof body.session === 'string' ? body.session : '';
    const r = resolveDevice(who.ctx, { want: String(body.device || ''), linked: linkOfReq(who.ctx, by, session) });
    if (r.error) return json(res, 200, { ok: false, error: r.error });
    try {
      const result = await deviceDispatch(who.ctx, r.device.id, op, body.args || {}, {
        timeoutMs: Math.min(310_000, Math.max(1000, Number(body.timeoutMs) || 60_000)), by,
        session: session.slice(0, 64), title: typeof body.title === 'string' ? body.title : '',
      });
      json(res, 200, { ok: true, device: opDevice(r.device), result });
    } catch (e) { json(res, 200, { ok: false, error: String(e?.message || e) }); }
  });
  // 会话连接哪台设备（dimensio 的设备芯片 / DeviceInspect(use)）：link = 设备 id / 名字 / 'none' / ''（恢复自动）
  router.on('POST', '/api/internal/device-link', async (req, res) => {
    const who = internalCtx(req, res);
    if (!who) return;
    const body = await jsonBody(req, res);
    if (!body) return;
    const by = byOf(body.by);
    const session = String(body.session || '');
    if (!AGENT_LINK_SESSION_RE.test(session)) return json(res, 200, { ok: false, error: '缺会话 id' });
    let link = String(body.link || '');
    if (link && link !== 'none') {
      const mine = ownDevices(who.ctx);
      const hit = mine.find((d) => d.id === link) || mine.find((d) => d.name === link) || mine.find((d) => d.name.toLowerCase() === link.toLowerCase());
      if (!hit) return json(res, 200, { ok: false, error: `找不到设备「${link}」` });
      link = hit.id;
    }
    setAgentDeviceLink(who.ctx, by, session, link);
    json(res, 200, { ok: true, link: linkOfReq(who.ctx, by, session) });
  });
  // 端口转发（同 Claude 的 ports 工具）：action = list / open / close
  router.on('POST', '/api/internal/device-forward', async (req, res) => {
    const who = internalCtx(req, res);
    if (!who) return;
    const body = await jsonBody(req, res);
    if (!body) return;
    const ctx = who.ctx;
    const action = String(body.action || '');
    if (action === 'list') return json(res, 200, { ok: true, forwards: listForwards(ctx) });
    const by = byOf(body.by);
    const session = typeof body.session === 'string' ? body.session : '';
    const target = () => resolveDevice(ctx, { want: String(body.device || ''), linked: linkOfReq(ctx, by, session) });
    if (action === 'close') {
      let tok = String(body.token || '');
      if (!tok && body.port) {
        const r = target();
        if (r.error) return json(res, 200, { ok: false, error: r.error });
        tok = (listForwards(ctx).find((f) => f.deviceId === r.device.id && f.port === Number(body.port)) || {}).token || '';
      }
      if (!tok) return json(res, 200, { ok: false, error: 'close 要给 token，或给 port（加 device）' });
      const out = removeForward(ctx, tok);
      return json(res, 200, out.error ? { ok: false, error: out.error } : { ok: true });
    }
    if (action !== 'open') return json(res, 200, { ok: false, error: '未知动作：' + action });
    if (!devicesEnabled()) return json(res, 200, { ok: false, error: '这台 bridge 关掉了设备通道（config.json devices=false）。' });
    const r = target();
    if (r.error) return json(res, 200, { ok: false, error: r.error });
    if (!(r.device.client?.caps || []).includes('http')) return json(res, 200, { ok: false, error: `设备「${r.device.name}」的客户端版本较旧，还不支持端口转发——请对方更新客户端。` });
    const out = createForward(ctx, r.device.id, body.port, String(body.label || ''));
    json(res, 200, out.error ? { ok: false, error: out.error } : { ok: true, existed: !!out.existed, forward: out.forward });
  });

  // 老中继给同机工具（client/tools/rc.mjs）用的派发口：主机密钥（config.json remotePcSecret）+ 本机直连。
  // 中继域名并进 8787 之后这两个路径经隧道也到得了；唯一的调用方 rc.mjs 默认就连 127.0.0.1，所以收紧到同机，
  // 经隧道 / 局域网来的一律当不存在（R9，与下面 /control/device、/api/internal/* 同一道闸）。
  router.on('POST', '/control/dispatch', async (req, res) => {
    if (!isLocalDirect(req)) return json(res, 404, { error: 'not found' });
    if (!hostSecretOk(req)) { auditUnauth('control_unauth', req); return json(res, 401, { error: '主机密钥无效' }); }
    const body = await jsonBody(req, res, DEVICE_MAX_BYTES);
    if (!body) return;
    try {
      const result = await deviceDispatch({ kind: 'admin', key: 'admin' }, String(body.deviceId || ''), String(body.op || ''), body.args || {}, {
        timeoutMs: Math.min(310_000, Math.max(1000, Number(body.timeoutMs) || 60_000)), by: 'rc',
      });
      json(res, 200, { ok: true, result });
    } catch (e) { json(res, 200, { ok: false, error: String(e?.message || e) }); }
  });
  // /control/* 只认主机密钥（管理员身份），不认按人设备令牌；不满足一律当不存在。
  const internalOk = (req, res) => {
    if (isLocalDirect(req) && hostSecretOk(req)) return true;
    json(res, 404, { error: 'not found' });
    return false;
  };
  router.on('GET', '/control/devices', (req, res) => {
    if (!internalOk(req, res)) return;
    json(res, 200, { devices: listDevices().map(publicDevice) });
  });
  // 同机工具吊销 / 删除 / 断开（原中继 /admin/*）：主机密钥 + 本机直连，经隧道来的一律当不存在。
  router.on('POST', '/control/device', async (req, res) => {
    if (!internalOk(req, res)) return;
    const body = await jsonBody(req, res);
    if (!body) return;
    const d = deviceById(String(body.id || ''));
    if (!d) return json(res, 404, { error: '无此设备' });
    const act = String(body.action || '');
    let out;
    if (act === 'revoke') { out = revokeDevice(d.id); abortDevice(d.id, '设备已被吊销'); killDeviceTerm(d.id).catch(() => {}); }
    else if (act === 'delete') { if (!d.revoked) revokeDevice(d.id); abortDevice(d.id, '设备已被删除'); killDeviceTerm(d.id).catch(() => {}); out = deleteDevice(d.id); if (!out.error) dropForwardsOfDevice(d.id); }
    else if (act === 'kick') { abortDevice(d.id, '已断开'); out = { ok: true }; }
    else return json(res, 400, { error: '未知动作：' + act });
    deviceAudit({ ev: 'device_' + act, device: d.id, by: 'rc' });
    json(res, out.error ? 400 : 200, out);
  });

  // ── 账号侧 ──────────────────────────────────────────────────────────────

  const owned = (ctx, id) => {
    const d = id ? deviceById(String(id)) : null;
    if (!d) return null;
    if (ctx.kind !== 'admin' && d.owner !== ctx.key) return null;
    return d;
  };
  const accountCtx = (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return null;
    if (ctx.kind !== 'admin' && ctx.kind !== 'user') { json(res, 403, { error: '这个身份不能管理设备' }); return null; }
    return ctx;
  };

  router.on('GET', '/api/devices', (req, res, url) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    const all = ctx.kind === 'admin' && url.searchParams.get('all') === '1';
    const devices = listDevices({ owner: all ? null : ctx.key }).map(publicDevice);
    // 管理员（控制台「设备」页）顺带拿成员该装的那一版（打包形态 = 与服务端同一次发布），用来标「落后」与远程更新
    let release = null;
    if (all) { const r = clientReleaseFor({ hosting: false }); if (r) { const { file, ...meta } = r; release = meta; } }
    json(res, 200, { enabled: devicesEnabled(), devices, ...(all ? { release, origin: PUBLIC_ORIGIN || '' } : {}) });
  });

  // 控制台对设备的只读探查与远程更新（管理员）。只放这三种——控制台不是远程 shell，
  // 真正的远程操作归 Claude 的设备工具（有护栏、有提示词约束、设备侧按档位把关）。
  const PROBES = {
    sysinfo: ['sysinfo', {}, 20_000],
    screenshot: ['desktop', { action: 'screenshot' }, 30_000],
    update: ['client.update', {}, 30_000],
  };
  router.on('POST', '/api/devices/probe', async (req, res) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    if (ctx.kind !== 'admin') return json(res, 403, { error: '仅管理员' });
    const body = await jsonBody(req, res);
    if (!body) return;
    const p = PROBES[String(body.what || '')];
    if (!p) return json(res, 400, { error: '未知探查：' + body.what });
    try {
      const result = await deviceDispatch(ctx, String(body.id || ''), p[0], p[1], { timeoutMs: p[2], by: 'admin', anyOwner: true });
      json(res, 200, { ok: true, result });
    } catch (e) { json(res, 400, { error: String(e?.message || e) }); }
  });

  // 轮换主机密钥（同机工具 rc.mjs、Codex / dimensio 子进程操作设备用的那把，config.json remotePcSecret）。
  // 旧的立即失效；已起的 Codex / dimensio 进程要重启才拿到新的。
  router.on('POST', '/api/devices/rotate-host-secret', async (req, res) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    if (ctx.kind !== 'admin') return json(res, 403, { error: '仅管理员' });
    rotateHostSecret();
    deviceAudit({ ev: 'host_secret_rotate', by: ctx.key });
    json(res, 200, { ok: true, rotatedAt: Date.now() });
  });

  // 桌面客户端登录后登记自己（同机重登复用原设备 id）。令牌只在这里明文返回一次，客户端存本机。
  router.on('POST', '/api/devices/register', async (req, res) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    if (!devicesEnabled()) return json(res, 403, { error: '这台 bridge 关闭了设备通道' });
    const body = await jsonBody(req, res);
    if (!body) return;
    // 这次登记凭的是哪次登录（S2-4）：设备令牌跟着它走——那次登录退出 / 过期 / 被踢，令牌随之不认。
    // 账号：bridge_user 会话；管理员：管理员会话，或主令牌（换令牌即失效）；本机无鉴权实例不绑。
    let login = null, loginAt = 0;
    if (ctx.kind === 'user' && ctx.sid) { login = { kind: 'user', sid: ctx.sid }; loginAt = ctx.loginAt || 0; }
    else if (ctx.kind === 'admin' && adminCredential) {
      const cred = adminCredential(req);
      if (cred && cred.via === 'session') {
        const si = sessionInfo(cred.token);
        if (si) { login = { kind: 'admin', sid: si.sid }; loginAt = si.created || 0; }
      } else if (cred && cred.via === 'master' && adminGen) login = { kind: 'master', gen: adminGen };
    }
    const out = registerDevice({
      owner: ctx.key, name: body.name, platform: body.platform, hostname: body.hostname, machineId: body.machineId, kind: 'desktop', login, loginAt,
    });
    if (out.error) return json(res, out.code === 'revoked' ? 409 : 400, { error: out.error, ...(out.code ? { reason: out.code } : {}) });
    deviceAudit({ ev: 'register', device: out.device.id, owner: ctx.key, name: out.device.name, ip: clientIp(req) });
    json(res, 200, { token: out.token, device: publicDevice(out.device), origin: PUBLIC_ORIGIN || '' });
  });

  router.on('POST', '/api/devices/action', async (req, res) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    const body = await jsonBody(req, res);
    if (!body) return;
    const d = owned(ctx, body.id);
    if (!d) return json(res, 404, { error: '无此设备' });
    const act = String(body.action || '');
    let out;
    if (act === 'rename') out = renameDevice(d.id, body.name);
    else if (act === 'revoke') { out = revokeDevice(d.id); abortDevice(d.id, '设备已被吊销'); killDeviceTerm(d.id).catch(() => {}); }
    else if (act === 'delete') { out = deleteDevice(d.id); if (!out.error) dropForwardsOfDevice(d.id); }
    else if (act === 'kick' || act === 'stop') { abortDevice(d.id, act === 'stop' ? '已急停' : '已断开'); out = { ok: true }; }
    else return json(res, 400, { error: '未知动作：' + act });
    deviceAudit({ ev: 'device_' + act, device: d.id, by: ctx.key });
    if (out.error) return json(res, 400, out);
    json(res, 200, { ok: true, device: out.device ? publicDevice(out.device) : null });
  });

  // 管理员：直接派一条 op（排障与 rc.mjs 的登录态版本）。
  router.on('POST', '/api/devices/op', async (req, res) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    if (ctx.kind !== 'admin') return json(res, 403, { error: '仅管理员' });
    const body = await jsonBody(req, res, DEVICE_MAX_BYTES);
    if (!body) return;
    try {
      const result = await deviceDispatch(ctx, String(body.deviceId || ''), String(body.op || ''), body.args || {}, {
        timeoutMs: Math.min(310_000, Math.max(1000, Number(body.timeoutMs) || 60_000)), by: 'admin',
      });
      json(res, 200, { ok: true, result });
    } catch (e) { json(res, 200, { ok: false, error: String(e?.message || e) }); }
  });

  router.on('GET', '/api/devices/audit', async (req, res, url) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    if (ctx.kind !== 'admin') return json(res, 403, { error: '仅管理员' });
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 200));
    json(res, 200, { entries: await readDeviceAudit({ limit, deviceId: String(url.searchParams.get('device') || '') }) });
  });

  // 迁移：并入老中继的 devices.json（已配对的被控端不用重配）。
  router.on('POST', '/api/devices/import-relay', async (req, res) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    if (ctx.kind !== 'admin') return json(res, 403, { error: '仅管理员' });
    const body = await jsonBody(req, res);
    if (!body) return;
    const out = importRelayDevices(String(body.path || ''));
    json(res, out.error ? 400 : 200, out);
  });

  // 会话连接哪台设备（输入框下方的设备芯片）：sessionId + link（设备 id / 'none' / '' = 恢复自动）。
  // 改完立刻生效：工具每次调用现读；从「不连接」改成连某台时，下一轮会注入设备工具。
  router.on('POST', '/api/devices/link', async (req, res) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    const body = await jsonBody(req, res);
    if (!body) return;
    const sid = String(body.sessionId || '');
    if (!/^[0-9a-f-]{8,64}$/i.test(sid)) return json(res, 400, { error: '缺 sessionId' });
    const link = String(body.link || '');
    if (link && link !== 'none' && !owned(ctx, link)) return json(res, 404, { error: '无此设备' });
    setDeviceLink(ctx, sid, link || null);
    json(res, 200, { ok: true, sessionId: sid, link: deviceLinkFor(ctx, sid) || '' });
  });
  router.on('GET', '/api/devices/link', (req, res, url) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    const sid = String(url.searchParams.get('sessionId') || '');
    json(res, 200, { sessionId: sid, link: (sid && deviceLinkFor(ctx, sid)) || '' });
  });

  router.on('GET', '/api/devices/runtime', (req, res, url) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    const d = owned(ctx, url.searchParams.get('id'));
    if (!d) return json(res, 404, { error: '无此设备' });
    json(res, 200, { device: publicDevice(d), runtime: deviceRuntime(d.id) });
  });

  // ── 设备终端（终端面板切到「我的电脑」）：协议同 /api/claude/term/*，状态见 runtime/device-term.mjs ──
  // 只给设备主人自己用——管理员也不能开别人电脑的终端。
  const mine = (ctx, id) => {
    const d = id ? deviceById(String(id)) : null;
    return d && !d.revoked && d.owner === ctx.key ? d : null;
  };
  router.on('GET', '/api/devices/term/stream', (req, res, url) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    const d = mine(ctx, url.searchParams.get('id'));
    if (!d) return json(res, 404, { error: '无此设备' });
    const online = isDeviceOnline(d.id);
    if (!online && !deviceTerm(d.id)) return json(res, 409, { error: `「${d.name}」当前离线（桌面客户端没开，或档位是「关闭」）` });
    const caps = (deviceRuntime(d.id).info || {}).caps || [];
    if (online && !caps.includes('pty')) return json(res, 409, { error: `「${d.name}」上的客户端还不支持终端——更新客户端后再试` });
    const t = ensureDeviceTerm(ctx, d.id, { cols: url.searchParams.get('cols'), rows: url.searchParams.get('rows') });
    writeSseHeaders(res);
    sseWrite(res, { type: 'hello', cols: t.cols, rows: t.rows, exited: false, state: t.state, device: { id: d.id, name: d.name } });
    const snap = snapshotDeviceTerm(t);
    if (snap) sseWrite(res, { type: 'snapshot', d: snap });
    if (t.state === 'offline') sseWrite(res, { type: 'offline' });
    subscribeDeviceTerm(t, res);
    const hb = startHeartbeat(res);
    req.on('close', () => clearInterval(hb));
  });
  const termCall = (fn) => async (req, res) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    const body = await jsonBody(req, res, 256 * 1024);
    if (!body) return;
    const d = mine(ctx, body.id);
    if (!d) return json(res, 404, { error: '无此设备' });
    json(res, 200, { ok: await fn(d.id, body) });
  };
  router.on('POST', '/api/devices/term/input', termCall((id, b) => writeDeviceTerm(id, String(b.d ?? ''))));
  router.on('POST', '/api/devices/term/resize', termCall((id, b) => resizeDeviceTerm(id, b.cols, b.rows)));
  router.on('POST', '/api/devices/term/kill', termCall((id) => killDeviceTerm(id)));

  // ── 端口转发：把自己电脑上的本机端口接到 bridge（预览 dev server、接本机模型），见 runtime/device-forward.mjs ──
  router.on('GET', '/api/devices/forwards', (req, res, url) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    json(res, 200, { forwards: listForwards(ctx, { all: url.searchParams.get('all') === '1' }), previewDomain: Boolean(PV_PUBLIC_DOMAIN) });
  });
  router.on('POST', '/api/devices/forwards', async (req, res) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    if (!devicesEnabled()) return json(res, 403, { error: '这台 bridge 关闭了设备通道' });
    const body = await jsonBody(req, res);
    if (!body) return;
    const out = createForward(ctx, String(body.id || ''), body.port, body.label);
    json(res, out.error ? 400 : 200, out);
  });
  router.on('POST', '/api/devices/forwards/remove', async (req, res) => {
    const ctx = accountCtx(req, res);
    if (!ctx) return;
    const body = await jsonBody(req, res);
    if (!body) return;
    const out = removeForward(ctx, String(body.token || ''));
    json(res, out.error ? 404 : 200, out);
  });
}
