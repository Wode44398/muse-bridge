// 端口转发：把用户电脑上的一个本机端口（dev server、本机模型的接口）接到 bridge 上。
// 请求经设备通道的 http.request op 到那台电脑，由设备服务去打 127.0.0.1:<端口>，响应流式回传。
//
// 一条转发 = 一个不可猜的令牌 → {设备, 端口}，持久化在 DATA_ROOT/device-forwards.json（重启不丢，
// 本机模型接口这类配进别处的地址才能长期有效）。两种入口：
//   · 预览子域 pv-<令牌>.<PV_PUBLIC_DOMAIN>：网页应用（根路径资源、前端路由）用这个，独立源；
//   · 路径 /fwd/<令牌>/...：接口（OpenAI 兼容的本机模型等）、没配预览域名时用这个。它和 bridge 同源，
//     所以响应一律加 CSP sandbox（页面被关进不透明源，读不到 bridge 的存储与 Cookie）、丢掉 Set-Cookie，
//     请求里 bridge 自己的 Cookie 也不转过去。
// 都是能力 URL：持有令牌即可访问，与服务器上的预览同一安全模型；删掉转发即失效。
// WebSocket（vite 热更新等）暂不转：页面照常能用，只是没有热更新。

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { DATA_ROOT } from './paths.mjs';
import { PV_PUBLIC_DOMAIN, PUBLIC_ORIGIN, PORT } from '../config/index.mjs';
import { deviceById } from './device-registry.mjs';
import { deviceDispatch } from './devices.mjs';
import { deviceAudit } from './device-audit.mjs';

export const FORWARDS_PATH = path.join(DATA_ROOT, 'device-forwards.json');
const MAX_PER_OWNER = 20;
const BODY_MAX = 8 * 1024 * 1024;
// 预览子域那条正则是 [a-z0-9]{8,40}；这里固定 26 位、以 d 开头，和 harness 预览的令牌一眼可分
export const FORWARD_TOKEN_RE = /^d[a-z0-9]{25}$/;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length']);
const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';

let memo = null;
function load() {
  if (memo) return memo;
  let list = [];
  if (existsSync(FORWARDS_PATH)) {
    try {
      const j = JSON.parse(readFileSync(FORWARDS_PATH, 'utf8').replace(/^﻿/, ''));
      if (Array.isArray(j.forwards)) list = j.forwards.filter((f) => f && FORWARD_TOKEN_RE.test(f.token) && f.deviceId && f.port);
    } catch { /* 坏文件当空表，下次保存覆盖 */ }
  }
  memo = list;
  return memo;
}

function save(list) {
  const tmp = FORWARDS_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify({ forwards: list }, null, 2), { mode: 0o600 });
  renameSync(tmp, FORWARDS_PATH);
  memo = list;
}

function newToken() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(25);
  let s = 'd';
  for (const b of bytes) s += alphabet[b % 36];
  return s;
}

/** 一条转发的各个访问地址：local 给同机的 agent / 工具，path 与 preview 给浏览器与手机。 */
export function forwardUrls(f) {
  const base = String(PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  return {
    local: `http://127.0.0.1:${PORT}/fwd/${f.token}/`,
    path: base ? `${base}/fwd/${f.token}/` : `/fwd/${f.token}/`,
    preview: PV_PUBLIC_DOMAIN ? `https://pv-${f.token}.${PV_PUBLIC_DOMAIN}/` : '',
  };
}

export function publicForward(f) {
  const d = deviceById(f.deviceId);
  return { token: f.token, deviceId: f.deviceId, deviceName: d ? d.name : '', port: f.port, label: f.label || '', createdAt: f.createdAt, urls: forwardUrls(f) };
}

/** 这个身份的转发（管理员 all=true 看全部）。 */
export function listForwards(ctx, { all = false } = {}) {
  return load().filter((f) => (all && ctx.kind === 'admin') || f.owner === ctx.key).map(publicForward);
}

/** 建一条转发。同一设备同一端口已有就直接返回那条。 */
export function createForward(ctx, deviceId, port, label = '') {
  const d = deviceById(String(deviceId || ''));
  if (!d || d.revoked) return { error: '设备不存在或已被吊销' };
  if (d.owner !== ctx.key) return { error: '这台设备不属于你' };
  const p = Math.floor(Number(port));
  if (!(p >= 1 && p <= 65535)) return { error: '端口要在 1-65535 之间' };
  const list = load();
  const hit = list.find((f) => f.owner === ctx.key && f.deviceId === d.id && f.port === p);
  if (hit) return { forward: publicForward(hit), existed: true };
  if (list.filter((f) => f.owner === ctx.key).length >= MAX_PER_OWNER) return { error: `转发最多 ${MAX_PER_OWNER} 条，先删掉不用的` };
  const f = { token: newToken(), owner: ctx.key, deviceId: d.id, port: p, label: String(label || '').slice(0, 60), createdAt: new Date().toISOString() };
  save([...list, f]);
  deviceAudit({ ev: 'forward_create', device: d.id, port: p, by: ctx.key });
  return { forward: publicForward(f) };
}

export function removeForward(ctx, token) {
  const list = load();
  const f = list.find((x) => x.token === token);
  if (!f) return { error: '没有这条转发' };
  if (f.owner !== ctx.key && ctx.kind !== 'admin') return { error: '这条转发不属于你' };
  save(list.filter((x) => x !== f));
  deviceAudit({ ev: 'forward_remove', device: f.deviceId, port: f.port, by: ctx.key });
  return { ok: true };
}

/** 设备被删除时连带删它的转发。 */
export function dropForwardsOfDevice(deviceId) {
  const list = load();
  const keep = list.filter((f) => f.deviceId !== deviceId);
  if (keep.length !== list.length) save(keep);
}

/** 账号删除时连带删它建的全部转发（runtime/account-lifecycle.mjs）。返回删了几条。 */
export function dropForwardsOfOwner(owner) {
  if (!owner) return 0;
  const list = load();
  const keep = list.filter((f) => f.owner !== owner);
  if (keep.length !== list.length) save(keep);
  return list.length - keep.length;
}

export function forwardByToken(token) {
  if (!FORWARD_TOKEN_RE.test(String(token || ''))) return null;
  return load().find((f) => f.token === token) || null;
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; } parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts, n)));
    req.on('error', reject);
  });
}

function plain(res, status, text) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/**
 * 把一个请求经设备转到它的本机端口。mode: 'path'（/fwd/<令牌>/…，与 bridge 同源，要隔离）| 'host'（预览子域）。
 * reqPath 是转给本机服务的路径（含查询串）。
 */
export async function proxyForward(req, res, f, reqPath, { mode = 'path' } = {}) {
  const d = deviceById(f.deviceId);
  if (!d || d.revoked) return plain(res, 404, '这条转发对应的设备已不存在');
  const ctx = { kind: f.owner === 'admin' ? 'admin' : 'user', key: f.owner };
  let body = null;
  if (!['GET', 'HEAD'].includes(req.method)) {
    try { body = await readRaw(req, BODY_MAX); } catch (e) { return plain(res, e.status || 400, e.message); }
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k)) continue;
    // 同源入口：bridge 自己的 Cookie 与登录头不能交给电脑上的随便哪个服务
    if (mode === 'path' && (k === 'cookie' || k.startsWith('x-bridge-'))) continue;
    headers[k] = v;
  }
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = String(req.headers.host || '');
  const ac = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) ac.abort(); });
  try {
    await deviceDispatch(ctx, d.id, 'http.request', {
      port: f.port, method: req.method, path: reqPath, headers, ...(body && body.length ? { body: body.toString('base64') } : {}),
    }, {
      channel: 'forward', timeoutMs: 300_000, signal: ac.signal, by: 'user', session: 'forward:' + f.token, title: `端口 ${f.port}`, audit: false,
      onChunk: (c) => {
        if (!c || res.destroyed) return;
        if (c.type === 'head' && !res.headersSent) {
          const out = {};
          for (const [k, v] of Object.entries(c.headers || {})) {
            const name = String(k).toLowerCase();
            if (HOP.has(name) && name !== 'content-length') continue;
            if (mode === 'path' && name === 'set-cookie') continue;
            out[name] = v;
          }
          if (mode === 'path') { out['content-security-policy'] = SANDBOX_CSP; out['x-content-type-options'] = 'nosniff'; }
          res.writeHead(Number(c.status) || 502, out);
          return;
        }
        if (c.type === 'body' && c.b64) {
          // 回压：访问方收得慢时，晚一点回复设备的这一块（设备逐块串行回传），别在内存里越攒越多
          if (!res.write(Buffer.from(c.b64, 'base64'))) {
            return new Promise((resolve) => { const done = () => { res.off('drain', done); res.off('close', done); resolve(); }; res.on('drain', done); res.on('close', done); });
          }
        }
      },
    });
    finished = true;
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end();
  } catch (e) {
    finished = true;
    if (ac.signal.aborted) return;
    const msg = String(e?.message || e);
    plain(res, /离线|已断开/.test(msg) ? 503 : 502, `转发到「${d.name}」的 ${f.port} 端口失败：${msg}`);
  }
}

// 测试用
export function _resetForwards() { memo = null; }
