// 给 agent 用的 HTTP 接口。任何 agent 拿到服务器地址 + 一把 agent 密钥就能操作 bridge，不用开浏览器模拟点击：
//
//   GET  /agent、/llms.txt          入口说明（markdown；?format=json 给机器读的目录）——不用登录
//   GET  /agent/manual[/<章>][?q=]  项目手册：目录 / 整章 / 关键词检索——不用登录（带密钥时按身份标出能不能用）
//   GET  /agent/v1                  操作目录（JSON，含参数 schema）
//   GET|POST /agent/v1/<操作名>     执行一个操作；GET 用查询串传参，POST 用 JSON 体
//   /api/agent-keys*                设置页「Agent 接入」：列出 / 生成 / 吊销密钥（普通登录态，给界面用）
//
// 鉴权只认请求头：Authorization: Bearer <密钥>（或 X-Bridge-Key）。cookie 一律不认——所以 /agent/* 可以放开跨域，
// 别的网站在用户浏览器里也借不到他的登录态（没有 CSRF 面）。密钥之外，主令牌、管理员会话、账号登录令牌照样认。
// 回应统一 { ok:true, op, data } / { ok:false, error:{ code, message, hint? } }。慢操作（等对话、生成视频）先回 200 再
// 每 10 秒写一个空白保活（JSON 前面的空白合法），这种情况下出错也是 200 + ok:false——调用方一律看 ok。

import { randomUUID } from 'node:crypto';
import { readBody } from '../runtime/body.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { PUBLIC_ORIGIN, NO_AUTH } from '../config/index.mjs';
import { createAgentKey, listAgentKeys, revokeAgentKey, touchAgentKey } from '../users.mjs';
import { busPublish } from '../runtime/bus.mjs';
import { callOp, catalog, getOp, apiAllowed, OpError } from './registry.mjs';
import { setInternalRouter } from './internal.mjs';
import { setAdminGen, keyOwnerOf } from './ops/keys.mjs';
import { manualChapter, manualSearch, tocMarkdown, searchMarkdown, manualToc } from './manual.mjs';
import { instanceCaller } from './instance-auth.mjs';
import './ops/index.mjs';

const HEARTBEAT_MS = 10_000;
const SLOW_GRACE_MS = 4_000;     // 慢操作这么久还没结果才先回 200 开始保活（快的照常带真实状态码）

function originOf(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  if (host && !/^(127\.|localhost|\[::1\])/.test(host)) return proto + '://' + host;
  return PUBLIC_ORIGIN || (host ? proto + '://' + host : '');
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bridge-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Referrer-Policy', 'no-referrer');
}
const sendJson = (res, code, obj) => {
  if (res.writableEnded) return;
  if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const sendMd = (res, code, text) => { res.writeHead(code, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text); };
const errBody = (e) => ({ ok: false, error: { code: e.code || 'failed', message: e.message || String(e), ...(e.hint ? { hint: e.hint } : {}), ...(e.data ? { data: e.data } : {}) } });

// 只认请求头里的凭据：把 cookie 剥掉再交给 identify。没带任何凭据 → null（NO_AUTH 的本机调试实例除外）。
function credentialOf(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return (m ? m[1].trim() : '') || String(req.headers['x-bridge-key'] || '').trim();
}
function resolveCaller(req, identify) {
  const tok = credentialOf(req);
  const inst = instanceCaller(req, tok);   // 同机 agent 实例（dimensio）的主机密钥 / 按人令牌，见 instance-auth.mjs
  if (inst !== undefined) return inst;
  if (!tok && !NO_AUTH) return null;
  const headers = { ...req.headers, cookie: '', authorization: tok ? 'Bearer ' + tok : '' };
  delete headers['x-share-token']; delete headers['x-csnap-token'];
  const u = new URL(req.url, 'http://x');
  const id = identify({ method: req.method, url: u.pathname, headers, socket: req.socket });
  if (!id || (id.kind !== 'admin' && id.kind !== 'user')) return null;
  const key = tok ? touchAgentKey(tok) : null;
  return { identity: id, ctx: contextFor(id), key };
}

function quickstartMd(ctx, origin) {
  const api = manualChapter('api', ctx, origin);
  const head = [
    `<!-- 这是 bridge 服务器给 agent 的入口说明。完整手册：${origin}/agent/manual -->`,
  ];
  return head.join('\n') + '\n' + (api ? api.markdown : '# bridge agent 接口\n\n手册缺失：见 ' + origin + '/agent/manual');
}

export function registerAgentApiRoutes(router, { identify, adminGen }) {
  setInternalRouter(router);
  setAdminGen(adminGen);

  router.use(async (req, res, url) => {
    const p = url.pathname;
    const isAgent = p === '/agent' || p.startsWith('/agent/') || p === '/llms.txt';
    if (!isAgent) return;
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return false; }
    if (req.method !== 'GET' && req.method !== 'POST') { sendJson(res, 405, errBody(new OpError('bad_args', '只收 GET / POST'))); return false; }
    const origin = originOf(req);
    const caller = resolveCaller(req, identify);
    const ctx = caller ? caller.ctx : null;
    const wantJson = url.searchParams.get('format') === 'json' || /application\/json/.test(String(req.headers.accept || '')) && !/text\/markdown/.test(String(req.headers.accept || ''));

    // —— 入口说明 ——
    if (p === '/agent' || p === '/agent/' || p === '/llms.txt') {
      if (wantJson) {
        sendJson(res, 200, {
          ok: true, name: 'bridge', origin, authenticated: !!ctx,
          auth: 'Authorization: Bearer <agent 密钥>（设置 › Agent 接入里生成）',
          call: 'GET|POST ' + origin + '/agent/v1/<op>', manual: origin + '/agent/manual',
          ops: catalog(ctx), chapters: manualToc(ctx, origin).map(({ id, title, summary }) => ({ id, title, summary })),
        });
      } else sendMd(res, 200, quickstartMd(ctx, origin));
      return false;
    }

    // —— 手册 ——
    if (p === '/agent/manual' || p === '/agent/manual/' || p.startsWith('/agent/manual/')) {
      const topic = decodeURIComponent(p.slice('/agent/manual/'.length).replace(/\/+$/, ''));
      const q = url.searchParams.get('q') || '';
      if (topic) {
        const c = manualChapter(topic, ctx, origin);
        if (!c) { wantJson ? sendJson(res, 404, errBody(new OpError('not_found', '没有这一章：' + topic))) : sendMd(res, 404, `# 没有这一章：${topic}\n\n目录见 ${origin}/agent/manual`); return false; }
        wantJson ? sendJson(res, 200, { ok: true, ...c }) : sendMd(res, 200, c.markdown);
      } else if (q) {
        const results = manualSearch(q, ctx, origin, { limit: Math.min(10, Number(url.searchParams.get('limit')) || 5) });
        wantJson ? sendJson(res, 200, { ok: true, q, results }) : sendMd(res, 200, searchMarkdown(q, results));
      } else {
        wantJson ? sendJson(res, 200, { ok: true, chapters: manualToc(ctx, origin) }) : sendMd(res, 200, tocMarkdown(ctx, origin));
      }
      return false;
    }

    // —— 操作目录 ——
    if (p === '/agent/v1' || p === '/agent/v1/') {
      if (!ctx) { sendJson(res, 401, errBody(new OpError('unauthorized', '要带 agent 密钥', { hint: 'Authorization: Bearer <密钥>；不带密钥也能看 GET /agent 与 /agent/manual' }))); return false; }
      sendJson(res, 200, { ok: true, ops: catalog(ctx) });
      return false;
    }

    // —— 执行操作 ——
    if (p.startsWith('/agent/v1/')) {
      const name = decodeURIComponent(p.slice('/agent/v1/'.length));
      await runOp(req, res, url, { name, caller, origin });
      return false;
    }

    sendJson(res, 404, errBody(new OpError('not_found', '没有这个地址', { hint: '入口说明见 GET /agent' })));
    return false;
  });

  // —— 设置页「Agent 接入」用（普通登录态） ——
  const uiCtx = (req, res) => {
    const id = identify(req);
    if (!id || (id.kind !== 'admin' && id.kind !== 'user')) { sendJson(res, 401, { error: 'unauthorized' }); return null; }
    return contextFor(id);
  };
  router.on('GET', '/api/agent-keys', (req, res) => {
    const ctx = uiCtx(req, res); if (!ctx) return;
    const origin = originOf(req);
    sendJson(res, 200, { keys: listAgentKeys(keyOwnerOf(ctx)), origin, agentUrl: origin + '/agent', manualUrl: origin + '/agent/manual' });
  });
  router.on('POST', '/api/agent-keys/create', async (req, res) => {
    const ctx = uiCtx(req, res); if (!ctx) return;
    let b = {}; try { b = JSON.parse(await readBody(req)) || {}; } catch { return sendJson(res, 400, { error: 'bad json' }); }
    let k;
    try { k = createAgentKey(keyOwnerOf(ctx), { label: String(b.label || '') }); }
    catch (e) { return sendJson(res, e.status || 500, { error: e.message || '生成失败' }); }
    busPublish(ctx.key, { type: 'agent.keys' });
    const origin = originOf(req);
    sendJson(res, 200, { key: k.token, id: k.id, label: k.label, created: k.created, expiresAt: k.expiresAt, prompt: handoffPrompt(origin, k.token) });
  });
  router.on('POST', '/api/agent-keys/revoke', async (req, res) => {
    const ctx = uiCtx(req, res); if (!ctx) return;
    let b = {}; try { b = JSON.parse(await readBody(req)) || {}; } catch { return sendJson(res, 400, { error: 'bad json' }); }
    const n = revokeAgentKey(keyOwnerOf(ctx), String(b.id || ''));
    if (n) busPublish(ctx.key, { type: 'agent.keys' });
    sendJson(res, n ? 200 : 404, n ? { ok: true, revoked: n } : { error: '没有这把密钥' });
  });
}

// 交给 agent 的一段话：地址、密钥、从哪开始。
export function handoffPrompt(origin, key) {
  return [
    `你可以直接操作我的 bridge 服务器（${origin}）：用 HTTP 调它给 agent 准备的接口，不需要打开浏览器。`,
    `- 密钥：${key}（每个请求带请求头 Authorization: Bearer <密钥>）`,
    `- 先读入口说明：GET ${origin}/agent（markdown，讲清了怎么调、有哪些操作）`,
    `- 项目手册：GET ${origin}/agent/manual（目录），GET ${origin}/agent/manual?q=关键词（检索）`,
    `- 调用：POST ${origin}/agent/v1/<操作名>，JSON 体传参；先调 whoami 看看你能做什么。`,
    '删除、花钱、发消息一类不可撤回的操作，先问我。',
  ].join('\n');
}

async function runOp(req, res, url, { name, caller, origin }) {
  const t0 = Date.now();
  const op = getOp(name);
  if (!op) return sendJson(res, 404, errBody(new OpError('not_found', `没有操作「${name}」`, { hint: '操作目录见 GET /agent/v1（要带密钥）或 GET /agent' })));
  if (!caller || !apiAllowed(caller.ctx)) {
    return sendJson(res, 401, errBody(new OpError('unauthorized', '要带 agent 密钥', { hint: '请求头 Authorization: Bearer <密钥>；密钥在 bridge 的 设置 › Agent 接入 里生成' })));
  }
  let args = {};
  if (req.method === 'POST') {
    let raw = '';
    try { raw = await readBody(req, 6_000_000); } catch { return sendJson(res, 413, errBody(new OpError('bad_args', '请求体太大（上限 6MB）'))); }
    if (raw.trim()) {
      try { args = JSON.parse(raw); } catch { return sendJson(res, 400, errBody(new OpError('bad_args', '请求体不是合法 JSON'))); }
    }
  } else {
    for (const [k, v] of url.searchParams) if (k !== 'format') args[k] = v;
  }
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const env = {
    via: 'http', origin, identity: caller.identity, signal: ac.signal, requestId: randomUUID(),
    ...(caller.key ? { keyId: caller.key.id, keyLabel: caller.key.label } : {}),
    ...(caller.instance ? { instance: caller.instance } : {}),   // 同机 agent 实例（如 'dimensio'），操作可据此标来源
  };

  // 慢操作：过了宽限期还没结果，先回 200 再定期写空白保活（隧道 / 代理对 100 秒没字节的响应会掐）
  let hb = null, grace = null;
  if (op.slow) {
    grace = setTimeout(() => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.write(' ');
      hb = setInterval(() => { if (!res.writableEnded) res.write('\n'); }, HEARTBEAT_MS);
    }, SLOW_GRACE_MS);
  }
  let status = 200, code = 'ok';
  try {
    const data = await callOp(caller.ctx, name, args, env);
    sendJson(res, 200, { ok: true, op: name, data });
  } catch (e) {
    const err = e instanceof OpError ? e : new OpError('failed', String(e?.message || e));
    if (!(e instanceof OpError)) console.error('[agent-api] ' + name + ' 出错：', e);
    status = err.status; code = err.code;
    sendJson(res, err.status, errBody(err));
  } finally {
    clearTimeout(grace); clearInterval(hb);
  }
  const who = caller.ctx.kind === 'admin' ? 'admin' : (caller.ctx.name || caller.ctx.user);
  console.log(`[agent-api] ${who}${caller.key ? '（' + caller.key.label + '）' : caller.instance ? '（' + caller.instance + ' 实例）' : ''} ${name} → ${code === 'ok' ? 200 : status + ' ' + code} ${Date.now() - t0}ms`);
}
