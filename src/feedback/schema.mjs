// 反馈报告的格式：只认这些字段，每个字段都有长度上限。服务端拼报告、Worker 收报告都过这一道——
// 白名单的意思是：这里没列的东西，不管客户端塞了什么，一律到不了 GitHub。
import { scrub, clip, isPublicHost } from './scrub.mjs';

// docs = 说明书（deploy/muse/guide）没写到或写错了：Muse 答不上用户的问题时，经用户同意报上来，好补说明书
export const KINDS = ['bug', 'crash', 'update_failed', 'idea', 'security', 'docs'];
export const SOURCES = ['web', 'muse', 'auto'];
export const SERVICE_NAMES = ['bridge', 'cf-relay-api', 'cf-relay-edge', 'muse-tunnel', 'local_health', 'public_health'];
const AGENTS = ['claude', 'dimensio'];
const WHERE = ['server', 'client', 'harness'];

const str = (v, max) => clip(scrub(typeof v === 'string' ? v : ''), max).trim();
const tok = (v, re, max = 40) => { const s = String(v ?? '').trim(); return s.length <= max && re.test(s) ? s : ''; };
const oneOf = (v, list, dflt = '') => (list.includes(v) ? v : dflt);
const int = (v, max = 1e9) => (Number.isFinite(+v) && +v >= 0 ? Math.min(Math.floor(+v), max) : 0);
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

/**
 * 把任意输入整理成一份干净的报告；缺了必需项就抛错（Worker 回 400）。
 * opts.literals：额外要抹掉的字面值（服务端知道的公网主机名等）。
 */
export function cleanReport(input, opts = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const S = (v, max) => clip(scrub(typeof v === 'string' ? v : '', opts), max).trim();
  const kind = oneOf(i.kind, KINDS);
  if (!kind) throw new Error('bad kind');
  const install = tok(i.install, /^[A-Za-z0-9-]{8,64}$/, 64);
  if (!install) throw new Error('bad install id');
  const e = i.env && typeof i.env === 'object' ? i.env : {};
  const out = {
    v: 1,
    install,
    kind,
    source: oneOf(i.source, SOURCES, 'web'),
    lang: oneOf(i.lang, ['zh', 'en'], 'en'),
    title: S(i.title, 120),
    description: S(i.description, 4000),
    fp: tok(i.fp, /^[0-9a-f]{12}$/, 12),
    env: {
      version: str(e.version, 60),
      agents: arr(e.agents, 4).filter((a) => AGENTS.includes(a)),
      users: oneOf(e.users, ['solo', 'multi']),
      tunnel: oneOf(e.tunnel, ['quick', 'named']),
      node: tok(e.node, /^v?[0-9.]+$/, 20),
      os: tok(e.os, /^[A-Za-z_]+(?: [0-9.]+)?$/, 40),   // 「Linux 6.10.14」：只认这个形状，不走脱敏（版本号会被当成 IP）
      arch: tok(e.arch, /^[a-z0-9_]+$/, 12),
      uptimeMin: int(e.uptimeMin, 1e7) || undefined,
      autoUpdate: e.autoUpdate === true ? true : e.autoUpdate === false ? false : undefined,
      browser: str(e.browser, 60),
      uiLang: oneOf(e.uiLang, ['zh', 'en']),
      page: tok(e.page, /^[a-z0-9_-]+$/, 30),
    },
    services: {},
    sites: [],
    errors: [],
    trail: arr(i.trail, 30).map((t) => S(t, 100)).filter(Boolean),
    logs: arr(i.logs, 25).map((t) => S(t, 200)).filter(Boolean),
  };
  if (i.services && typeof i.services === 'object') {
    for (const n of SERVICE_NAMES) {
      const v = tok(i.services[n], /^[a-z0-9_ -]+$/i, 16);
      if (v) out.services[n] = v;
    }
  }
  for (const s of arr(i.sites, 16)) {
    const host = String(s?.host || '').toLowerCase();
    const state = oneOf(s?.state, ['ok', 'denied', 'pending']);
    if (state) out.sites.push({ host: isPublicHost(host) ? host : 'custom', state });
  }
  for (const er of arr(i.errors, 8)) {
    if (!er || typeof er !== 'object') continue;
    out.errors.push({
      fp: tok(er.fp, /^[0-9a-f]{12}$/, 12),
      where: oneOf(er.where, WHERE, 'server'),
      type: tok(er.type, /^[A-Za-z0-9_.$]+$/, 40) || 'Error',
      message: S(er.message, 300),
      frames: arr(er.frames, 6).map((f) => S(f, 120)).filter(Boolean),
      count: int(er.count, 1e6) || 1,
      last: tok(er.last, /^[0-9T:.Z-]+$/, 30),
    });
  }
  for (const k of Object.keys(out.env)) if (out.env[k] === '' || out.env[k] === undefined || (Array.isArray(out.env[k]) && !out.env[k].length)) delete out.env[k];
  if (!out.title) out.title = defaultTitle(out);
  if (!out.fp && out.errors[0]?.fp) out.fp = out.errors[0].fp;
  if (!out.description && !out.errors.length && !out.logs.length && kind !== 'update_failed') throw new Error('empty report');
  return out;
}

export function defaultTitle(r) {
  const er = r.errors?.[0];
  if (er) return clip(`${er.type}: ${er.message}`, 120);
  if (r.kind === 'update_failed') return clip(`Update to ${r.env?.version || 'new version'} failed`, 120);
  const first = String(r.description || '').split('\n').find((l) => l.trim()) || '';
  return clip(first.trim() || 'Problem report', 120);
}
