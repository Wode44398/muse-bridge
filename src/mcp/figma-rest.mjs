// Figma 只读连接器（stdio MCP 服务，扩展页「添加 Figma（个人访问令牌）」装的就是它）。
// 为什么有它：Figma 官方连接器（mcp.figma.com）只认 OAuth；Muse（Meta 的 agent 虚拟机）的出口代理拦 Figma 的
// 令牌端点（refresh_rejected），bridge 在那里换不了令牌。Figma 的 REST API 认个人访问令牌（X-Figma-Token），不走令牌端点。
//
// 令牌从哪来（启动时由连接器的环境变量决定）：
//   FIGMA_API_KEY            —— 直接给个人访问令牌（普通部署；值存在扩展的加密凭据里）。
//   FIGMA_TOKEN_CREDENTIAL   —— Muse：平台「API Key 型自定义连接器」的登记名（如 custom.figma_pat）。令牌由平台保管、不进虚拟机：
//                               每次请求前向本机凭据服务 authd 要一个替身（hsurr:…），放进 X-Figma-Token；平台出站时把它换成真令牌
//                               （只对登记过的主机 api.figma.com）。协议见 Muse 的 dynamic_credentials.py：
//                               POST /v1/credentials/surrogate {"name": 登记名} → {"credentials":[{"name","surrogate","placement"}]}。
// 出站：有 HTTPS_PROXY 就走（Muse 只能经出口代理出网）。
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = 'https://api.figma.com';
const MAX_CHARS = 60_000;
export const AUTHD_SOCKET = process.env.JARVIS_AUTHD_SOCK || '/run/hatch/auth/authd.sock';

// Figma 链接 / 文件 key → { key, nodeId }。链接里的 node-id 是 1-2，接口要 1:2。
export function parseFigmaRef(ref) {
  const s = String(ref || '').trim();
  if (!s) throw new Error('缺少 Figma 文件链接或文件 key');
  if (!/^https?:\/\//i.test(s)) return { key: s, nodeId: '' };
  let u;
  try { u = new URL(s); } catch { throw new Error('不是有效的 Figma 链接'); }
  const m = /^\/(?:file|design|board|proto|slides|buzz|make)\/([A-Za-z0-9]+)/.exec(u.pathname);
  if (!/(^|\.)figma\.com$/i.test(u.hostname) || !m) throw new Error('不是 Figma 文件链接（形如 https://www.figma.com/design/<key>/…）');
  const branch = /\/branch\/([A-Za-z0-9]+)/.exec(u.pathname);
  return { key: branch ? branch[1] : m[1], nodeId: (u.searchParams.get('node-id') || '').replace(/-/g, ':') };
}

// 向 authd 要替身。只拿替身，不碰真令牌。
export function fetchSurrogate(name, { socketPath = AUTHD_SOCKET, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name });
    const req = http.request({ socketPath, method: 'POST', path: '/v1/credentials/surrogate', headers: { Host: 'authd.local', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`平台凭据服务拒绝发替身令牌（HTTP ${res.statusCode}）：${raw.slice(0, 300)}`));
        let j;
        try { j = JSON.parse(raw); } catch { return reject(new Error('平台凭据服务的回包不是 JSON')); }
        const list = Array.isArray(j.credentials) ? j.credentials : [];
        const e = list.find((x) => x && x.name === 'access_token') || list[0];
        if (!e || typeof e.surrogate !== 'string' || !e.surrogate.startsWith('hsurr:')) return reject(new Error('平台凭据服务没有给出替身令牌'));
        resolve(e.surrogate);
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接平台凭据服务超时')));
    req.on('error', (e) => reject(new Error(`连不上平台凭据服务（${socketPath}）：${e.message}`)));
    req.end(body);
  });
}

// 这一次请求用的令牌
export async function figmaToken(env = process.env, opts = {}) {
  if (env.FIGMA_TOKEN_CREDENTIAL) return fetchSurrogate(env.FIGMA_TOKEN_CREDENTIAL, opts);
  if (env.FIGMA_API_KEY) return env.FIGMA_API_KEY;
  throw new Error('没有配置 Figma 令牌：在连接器的环境变量里填 FIGMA_API_KEY（Figma 设置 › Security › Personal access tokens 生成）');
}

export async function figmaGet(path, { env = process.env, fetchImpl = fetch, tokenOpts } = {}) {
  const token = await figmaToken(env, tokenOpts);
  const res = await fetchImpl(API + path, { headers: { 'X-Figma-Token': token, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 400);
    try { const j = JSON.parse(text); msg = j.err || j.message || j.error || msg; } catch {}
    if (res.status === 403 || res.status === 401) throw new Error(`Figma 拒绝了请求（HTTP ${res.status}）：${msg}。检查个人访问令牌是否有效、权限是否包含读取文件。`);
    throw new Error(`Figma 接口出错（HTTP ${res.status}）：${msg}`);
  }
  return text;
}

const out = (text) => {
  const s = String(text);
  return { content: [{ type: 'text', text: s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + `\n…（已截断，原文 ${s.length} 字符；用 node_ids 或较小的 depth 取局部）` : s }] };
};
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String((e && e.message) || e) }] });
const ids = (list, fallback) => [...new Set([...(list || []), ...(fallback ? [fallback] : [])].map((x) => String(x).replace(/-/g, ':')).filter(Boolean))];

export function buildServer({ env = process.env, fetchImpl } = {}) {
  const get = (p) => figmaGet(p, { env, fetchImpl });
  const server = new McpServer({ name: 'figma-rest', version: '1.0.0' });
  const ro = { readOnlyHint: true, openWorldHint: true };
  server.registerTool('whoami', {
    description: 'Return the Figma account this connector is signed in as (id, handle, email). Use it to check the connection works.',
    annotations: ro,
  }, async () => { try { return out(await get('/v1/me')); } catch (e) { return fail(e); } });
  server.registerTool('get_file', {
    description: 'Read a Figma file\'s document tree as JSON. Pass a Figma URL (design/file/board link; a node-id in the URL narrows it to that node) or a file key. Without node_ids it returns the whole document limited to `depth` levels (default 2); with node_ids (e.g. "1:2") it returns just those nodes and their subtrees. Large results are truncated — narrow with node_ids.',
    inputSchema: { file: z.string().describe('Figma file URL or file key'), node_ids: z.array(z.string()).optional(), depth: z.number().int().min(1).max(10).optional() },
    annotations: ro,
  }, async ({ file, node_ids, depth }) => {
    try {
      const { key, nodeId } = parseFigmaRef(file);
      const want = ids(node_ids, nodeId);
      if (want.length) return out(await get(`/v1/files/${encodeURIComponent(key)}/nodes?ids=${encodeURIComponent(want.join(','))}${depth ? `&depth=${depth}` : ''}`));
      return out(await get(`/v1/files/${encodeURIComponent(key)}?depth=${depth || 2}`));
    } catch (e) { return fail(e); }
  });
  server.registerTool('get_images', {
    description: 'Render nodes of a Figma file to images and return temporary download URLs (valid ~30 days). Pass a Figma URL or file key plus node ids (or a URL whose node-id is the node to render).',
    inputSchema: { file: z.string(), node_ids: z.array(z.string()).optional(), format: z.enum(['png', 'jpg', 'svg', 'pdf']).optional(), scale: z.number().min(0.01).max(4).optional() },
    annotations: ro,
  }, async ({ file, node_ids, format, scale }) => {
    try {
      const { key, nodeId } = parseFigmaRef(file);
      const want = ids(node_ids, nodeId);
      if (!want.length) throw new Error('要指定节点：node_ids，或带 node-id 的 Figma 链接');
      return out(await get(`/v1/images/${encodeURIComponent(key)}?ids=${encodeURIComponent(want.join(','))}&format=${format || 'png'}${scale ? `&scale=${scale}` : ''}`));
    } catch (e) { return fail(e); }
  });
  server.registerTool('get_comments', {
    description: 'List the comments on a Figma file (author, message, the node they are attached to, resolved state).',
    inputSchema: { file: z.string() },
    annotations: ro,
  }, async ({ file }) => {
    try { const { key } = parseFigmaRef(file); return out(await get(`/v1/files/${encodeURIComponent(key)}/comments`)); } catch (e) { return fail(e); }
  });
  server.registerTool('get_styles_and_components', {
    description: 'List the published components, component sets and styles of a Figma file (name, key, description, node id) — useful for mapping a design system to code.',
    inputSchema: { file: z.string() },
    annotations: ro,
  }, async ({ file }) => {
    try {
      const { key } = parseFigmaRef(file);
      const k = encodeURIComponent(key);
      const [c, cs, st] = await Promise.all([get(`/v1/files/${k}/components`), get(`/v1/files/${k}/component_sets`), get(`/v1/files/${k}/styles`)]);
      return out(JSON.stringify({ components: JSON.parse(c).meta, component_sets: JSON.parse(cs).meta, styles: JSON.parse(st).meta }));
    } catch (e) { return fail(e); }
  });
  return server;
}

async function main() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
  }
  await buildServer().connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
