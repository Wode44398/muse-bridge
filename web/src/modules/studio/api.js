// Media Studio 的接口（§3）。核心 lib/api.js 不认识 studio 的路由，这里自己发：同一套鉴权头与服务器地址。
//
// dev 下后端还没有 /api/studio（后端分支没合进来）时自动换成本地 fixture（./fixture.js，按 §3 契约造数据），
// 生产构建里 import.meta.env.DEV 为假，fixture 整个被摇掉。
import { authHeaders } from '../../lib/api.js';
import { apiUrl } from '../../lib/server.js';

let mock = null;          // dev fixture（探测到后端缺路由才装上）
let probing = null;

async function raw(method, path, body) {
  const headers = authHeaders();
  let payload;
  if (body != null) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(apiUrl(path), { method, headers, body: payload, credentials: 'same-origin' });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    try { const t = await res.text(); try { err.body = JSON.parse(t); } catch { err.body = t.slice(0, 200); } } catch {}
    if (err.body && typeof err.body === 'object' && err.body.error) err.message = err.body.error;
    throw err;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

async function ensureBackend() {
  if (!import.meta.env.DEV || mock) return;
  probing ||= (async () => {
    const forced = typeof location !== 'undefined' && new URLSearchParams(location.search).has('studioFixture');
    let missing = forced;
    if (!forced) {
      try { await raw('GET', '/api/studio/catalog'); } catch (e) { missing = e.status === 404; }
    }
    if (missing) {
      const m = await import('./fixture.js');
      mock = m.createFixture();
      console.info('[studio] 后端没有 /api/studio，改用 dev fixture');
    }
  })();
  await probing;
}

async function req(method, path, body) {
  await ensureBackend();
  if (mock) return mock.handle(method, path, body);
  return raw(method, path, body);
}

/** dev fixture 是否在用（界面上给一个小角标，免得把假数据当真） */
export const usingFixture = () => !!mock;
/** fixture 会经它推 studio.job 事件（真后端走总线） */
export function onFixtureEvent(fn) { if (mock) return mock.listen(fn); return () => {}; }

const q = (o) => {
  const s = Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  return s ? '?' + s : '';
};

export const studioApi = {
  ready: ensureBackend,
  catalog: () => req('GET', '/api/studio/catalog'),
  voices: (key) => req('GET', '/api/studio/voices' + q({ key })),
  jobs: () => req('GET', '/api/studio/jobs?active=1'),
  job: (id) => req('GET', '/api/studio/jobs/' + encodeURIComponent(id)),
  createJob: (body) => req('POST', '/api/studio/jobs', body),
  cancelJob: (id) => req('POST', '/api/studio/jobs/' + encodeURIComponent(id) + '/cancel', {}),
  assets: ({ kind, cursor, q: text, thread } = {}) => req('GET', '/api/studio/assets' + q({ kind, cursor, q: text, thread })),
  saveAsset: (id, dir) => req('POST', '/api/studio/assets/' + encodeURIComponent(id) + '/save', { dir }),
  deleteAsset: (id) => req('POST', '/api/studio/assets/' + encodeURIComponent(id) + '/delete', {}),
  settings: () => req('GET', '/api/studio/settings'),
  // 备选（shelf）模型的完整卡（§9.3：目录里只给轻条目，选了再取）
  resolve: (key) => req('GET', '/api/studio/models/resolve' + q({ key })),
};
