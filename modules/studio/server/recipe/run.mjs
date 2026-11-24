// 配方适配器：照配方拼请求、提交、轮询、取结果。和别的方言一样的 run(req, provider, ctx) 接口（见 adapters/index.mjs）。
// 地址与 Key 用服务自己的；请求只发到服务的域名下（path 接在服务地址后，url 要同源）；结果下载地址可以是 CDN，但只有同源才带 Key。

import { AdapterError, authHeaders, joinUrl, http, download, poll, isTransient, longWaitMs, guessMime } from '../adapters/http.mjs';
import { previewBody, scrubSecrets } from '../adapters/trace.mjs';
import { renderString, renderValue, DROP } from './template.mjs';
import { getPath } from './path.mjs';

const FALLBACK_MIME = { image: 'image/png', video: 'video/mp4', speech: 'audio/mpeg', music: 'audio/mpeg' };
const MAX_RESULTS = 16;

const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };

function stepUrl(step, tctx, provider, recipe, key) {
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new AdapterError('这个服务没有接口地址，配方用不了');
  let url;
  if (step.path) url = joinUrl(base, renderString(step.path, tctx, { enc: encodeURIComponent }));
  else {
    const u = renderString(step.url, tctx);
    if (u === DROP || typeof u !== 'string') throw new AdapterError(`配方的 url 没取到地址（${step.url}）`);
    url = u;
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw new AdapterError(`配方拼出来的地址不合法：${url.slice(0, 200)}`); }
  // 只发到服务自己的域名：配方是 AI 也能写的，不能拿服务的 Key 去打别的地方
  if (parsed.origin !== originOf(base)) throw new AdapterError(`配方里的地址不在服务的域名下（${parsed.origin}，服务是 ${originOf(base)}）`);
  if (step.query) {
    for (const [k, v] of Object.entries(renderValue(step.query, tctx))) {
      if (v === DROP || v === undefined || v === null) continue;
      parsed.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }
  if (recipe.auth?.query && key) parsed.searchParams.set(recipe.auth.query, key);
  return parsed.toString();
}

function stepHeaders(step, tctx, provider, recipe, key) {
  const extra = {};
  for (const [k, v] of Object.entries(step.headers || {})) {
    const r = renderString(v, tctx);
    if (r !== DROP && r !== undefined) extra[k] = typeof r === 'object' ? JSON.stringify(r) : String(r);
  }
  if (!recipe.auth) return authHeaders(provider, key, extra);
  const h = { ...(provider.headers || {}), ...extra };
  if (recipe.auth.header && key) h[recipe.auth.header] = (recipe.auth.prefix || '') + key;
  return h;
}

function toBlob(x) {
  return new Blob([x.data], { type: x.mime || 'application/octet-stream' });
}
function multipartBody(tpl, tctx) {
  const fd = new FormData();
  const put = (k, v) => {
    if (v === DROP || v === undefined || v === null) return;
    if (Array.isArray(v)) { for (const x of v) put(k, x); return; }
    if (v && v.__file) { fd.append(k, toBlob(v), v.name); return; }
    fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  };
  for (const [k, t] of Object.entries(tpl)) put(k, renderValue(t, tctx));
  if (tctx.params?.extra && typeof tctx.params.extra === 'object') for (const [k, v] of Object.entries(tctx.params.extra)) put(k, v);
  return fd;
}
function jsonBody(tpl, tctx) {
  let body = tpl === undefined ? undefined : renderValue(tpl, tctx);
  if (body === DROP) body = undefined;
  const extra = tctx.params?.extra;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    if (body === undefined) body = { ...extra };
    else if (body && typeof body === 'object' && !Array.isArray(body)) body = { ...body, ...extra };
  }
  return body;
}

/** 一步请求 → { method, url, headers, body }（body 已渲染：对象 / FormData / undefined）。 */
export function buildStep(name, step, tctx, provider, recipe, key) {
  const url = stepUrl(step, tctx, provider, recipe, key);
  const headers = stepHeaders(step, tctx, provider, recipe, key);
  let body;
  if (step.method !== 'GET') body = name === 'submit' && recipe.submit.bodyType === 'multipart' ? multipartBody(step.body || {}, tctx) : (name === 'submit' ? jsonBody(step.body, tctx) : (step.body === undefined ? undefined : renderValue(step.body, tctx)));
  if (body === DROP) body = undefined;
  return { method: step.method, url, headers, body };
}

const templateCtx = (req) => ({
  prompt: req.prompt || '', negative: req.negative || '', model: req.model, kind: req.kind,
  params: req.params || {}, inputs: req.inputs || [],
});

/** 预演：只拼提交请求，不发。Key 抹成尾号。回 { submit: { method, url, headers, body }, poll?, result }。 */
export function previewRecipe(recipe, req, provider, key) {
  const tctx = templateCtx(req);
  const s = buildStep('submit', recipe.submit, tctx, provider, recipe, key);
  const secrets = key ? [key] : [];
  const mask = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, /^(authorization|x-api-key|x-goog-api-key|xi-api-key)$/i.test(k) || (recipe.auth?.header && k === recipe.auth.header) ? scrubSecrets(v, secrets).replace(/\S{24,}/g, '…') : scrubSecrets(v, secrets)]));
  return {
    submit: { method: s.method, url: scrubSecrets(s.url, secrets), headers: mask(s.headers), body: scrubSecrets(previewBody(s.body), secrets) },
    ...(recipe.poll ? { poll: { method: recipe.poll.method, ...(recipe.poll.path ? { path: recipe.poll.path } : { url: recipe.poll.url }), status: recipe.poll.status, done: recipe.poll.done, ...(recipe.poll.failed ? { failed: recipe.poll.failed } : {}) } } : {}),
    result: recipe.result,
  };
}

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v.flat() : [v]);
const brief = (j) => { try { return JSON.stringify(j).slice(0, 300); } catch { return String(j).slice(0, 300); } };

/** 跑一次配方 → { assets: [{ bytes, mime }] }。 */
export async function runRecipe(recipe, req, provider, ctx) {
  const key = ctx.secret?.key || '';
  const tctx = templateCtx(req);
  const signal = ctx.signal;
  const dispatcher = ctx.dispatcher;
  const base = String(provider.baseUrl || '');
  const s = buildStep('submit', recipe.submit, tctx, provider, recipe, key);
  const binary = !!recipe.result.binary;
  const timeoutMs = (recipe.submit.timeoutSec || 300) * 1000;
  const submitted = await http(s.url, { method: s.method, headers: s.headers, body: s.body, timeoutMs, signal, dispatcher, raw: binary, label: '提交' });
  ctx.submitted?.();
  if (binary) {
    const bytes = Buffer.from(await submitted.arrayBuffer());
    const type = (submitted.headers.get('content-type') || '').split(';')[0].trim();
    if (!bytes.length) throw new AdapterError('服务回了空文件');
    if (/json|text\/html/.test(type)) throw new AdapterError(`服务回的不是文件（${type}）：${bytes.toString('utf8').slice(0, 300)}`);
    return { assets: [{ bytes, mime: type && !/octet-stream/.test(type) ? type : recipe.result.mime || FALLBACK_MIME[req.kind] }] };
  }
  tctx.submit = submitted;

  if (recipe.poll) {
    const p = recipe.poll;
    const hasDone = (st) => p.done.some((d) => String(d) === String(st));
    const hasFail = (st) => (p.failed || []).some((d) => String(d) === String(st));
    tctx.poll = await poll(async () => {
      const q = buildStep('poll', p, tctx, provider, recipe, key);
      let j;
      try { j = await http(q.url, { method: q.method, headers: q.headers, body: q.body, timeoutMs: 60_000, signal, dispatcher, label: '查询进度' }); }
      catch (e) { if (isTransient(e)) return {}; throw e; }
      const st = getPath(j, p.status);
      if (hasDone(st)) return { done: true, value: j };
      if (hasFail(st)) return { failed: true, error: String((p.error && getPath(j, p.error)) ?? st).slice(0, 400) };
      let pr = p.progress ? Number(getPath(j, p.progress)) : NaN;
      if (Number.isFinite(pr) && pr > 1) pr /= 100;
      return { progress: Number.isFinite(pr) ? pr : undefined };
    }, {
      intervalMs: ctx.pollMs ?? (p.intervalSec || 5) * 1000,   // pollMs：单测用
      timeoutMs: Math.min((p.timeoutMin || 30) * 60_000, longWaitMs(provider) * 4),
      signal, label: '生成任务',
      onTick: ({ elapsed, progress }) => ctx.progress?.({ elapsed, ...(typeof progress === 'number' ? { progress } : {}) }),
    });
  }

  const res = recipe.result;
  const src = res.from === 'poll' ? tctx.poll : tctx.submit;
  const fallbackMime = res.mime || FALLBACK_MIME[req.kind];
  const assets = [];
  if (res.download) {
    const d = buildStep('download', res.download, tctx, provider, recipe, key);
    const r = await http(d.url, { method: d.method, headers: d.headers, body: d.body, timeoutMs: 300_000, signal, dispatcher, raw: true, label: '下载结果' });
    const bytes = Buffer.from(await r.arrayBuffer());
    const type = (r.headers.get('content-type') || '').split(';')[0].trim();
    assets.push({ bytes, mime: type && !/octet-stream|json/.test(type) ? type : fallbackMime });
  } else if (res.url) {
    const urls = asList(getPath(src, res.url)).filter((u) => typeof u === 'string' && u).slice(0, MAX_RESULTS);
    if (!urls.length) throw new AdapterError(`结果里没找到 ${res.url}（${res.from === 'poll' ? '轮询' : '提交'}的响应：${brief(src)}）`);
    for (const u of urls) {
      if (!/^(https?:|data:)/i.test(u)) throw new AdapterError(`结果地址不是 http(s) 或 data URL：${u.slice(0, 120)}`);
      // 同源（服务自己的文件接口）才带 Key；CDN 签名地址不带，免得把 Key 发给第三方
      const same = !/^data:/i.test(u) && originOf(u) === originOf(base);
      const got = await download(u, { headers: same ? stepHeaders({}, tctx, provider, recipe, key) : {}, signal, dispatcher });
      assets.push({ bytes: got.bytes, mime: got.mime && !/octet-stream/.test(got.mime) ? got.mime : (guessMime(u) !== 'application/octet-stream' ? guessMime(u) : fallbackMime) });
    }
  } else if (res.b64) {
    const list = asList(getPath(src, res.b64)).filter((x) => typeof x === 'string' && x).slice(0, MAX_RESULTS);
    if (!list.length) throw new AdapterError(`结果里没找到 ${res.b64}（${res.from === 'poll' ? '轮询' : '提交'}的响应：${brief(src)}）`);
    for (const x of list) {
      const m = /^data:([^;,]+)?;base64,(.*)$/s.exec(x);
      assets.push({ bytes: Buffer.from(m ? m[2] : x, 'base64'), mime: (m && m[1]) || fallbackMime });
    }
  }
  if (!assets.length || assets.some((a) => !a.bytes?.length)) throw new AdapterError('服务没有返回结果文件');
  return { assets };
}

export const recipeAdapter = {
  dialect: 'recipe',
  kinds: ['image', 'video', 'speech', 'music'],
  run: (req, provider, ctx) => {
    const recipe = req.card?.recipe;
    if (!recipe) throw new AdapterError('这个模型没有配方');
    return runRecipe(recipe, req, provider, ctx);
  },
};
