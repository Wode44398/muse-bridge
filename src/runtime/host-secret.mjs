// 主机密钥（config.json remotePcSecret）：同机进程之间的凭据。
//
// 用途：bridge 起的子进程（Codex 的 stdio MCP、dimensio 的 harness）和同机工具（client/tools/rc.mjs）
// 经 bridge 的内部接口操作设备时出示它。密钥只在本机：经 env 传给子进程、不进日志、不下发给任何前端。
// 原先它是 bridge 与独立中继进程之间的共享密钥（remote-control-host.mjs），中继并进 bridge 后只剩这一个用途。

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CONFIG_PATH } from '../config/index.mjs';

let cached = '';

/** 现读 / 首用生成主机密钥并落回 config.json（保全其余字段）。 */
export function ensureHostSecret() {
  if (cached) return cached;
  let raw = {};
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  if (typeof raw.remotePcSecret === 'string' && raw.remotePcSecret.length >= 20) { cached = raw.remotePcSecret; return cached; }
  cached = randomBytes(32).toString('base64url');
  raw.remotePcSecret = cached;
  try { writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2)); }
  catch (e) { console.error('[devices] 写 remotePcSecret 失败（同机工具将无法操作设备）：' + ((e && e.message) || e)); }
  return cached;
}

/** 换一把新密钥（旧的立即失效；已起的子进程要重启才拿到新的）。 */
export function rotateHostSecret() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  const next = randomBytes(32).toString('base64url');
  raw.remotePcSecret = next;
  writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
  cached = next;
  return next;
}

/** 恒定时间比对请求里的 Bearer 是不是主机密钥。 */
export function hostSecretOk(req) {
  const want = ensureHostSecret();
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const got = m ? m[1].trim() : '';
  if (!want || !got || got.length !== want.length) return false;
  try { return timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch { return false; }
}

/** 本机直连：socket 是回环、且不带任何代理 / 隧道转发头（经 cloudflared 进来的一律不算）。 */
const PROXY_MARKS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded'];
export function isLocalDirect(req) {
  const a = String(req.socket?.remoteAddress || '');
  const loop = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  return loop && !PROXY_MARKS.some((h) => req.headers[h] != null);
}
