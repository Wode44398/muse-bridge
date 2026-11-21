#!/usr/bin/env node
// Antigravity 的 Bridge stdio MCP 服务（服务名 bridge）：由 ACP 会话按需拉起，
// 持同机实例主机密钥经本机回环回调 Bridge 的 /agent/v1/* 与 /api/agy/internal/* 接口。
//
// 两类工具：
//   · 本地定义（agy-bridge-tools.mjs）：媒体生成、界面协同、手机授权文件。
//   · 中枢工具（服务端 mcp/hub.mjs）：浏览器、共享终端、工作区协同、bridge 手册与操作、用户的电脑、内嵌图表——
//     清单在 tools/list 时现取（按当前设置），执行时整包转给服务端，由它按归属轮实例化 Claude 同款工具去跑。
// 用低层 Server 而不是 McpServer：中枢工具的参数表是服务端给的 JSON Schema，要原样转交。

import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import https from 'node:https';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { buildAgyBridgeToolDefs } from './agy-bridge-tools.mjs';

const API_BASE = String(process.env.BRIDGE_API_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const SECRET = String(process.env.BRIDGE_HOST_SECRET || '').trim();
// 开了哪几类工具：现在不写进环境变量（环境变量一变 agy 就另起一个子进程并把工具改名成 mcp_bridge_<哈希>_*），
// 而是 tools/list 时向服务端现取。BRIDGE_AGY_TOOLS 只为兼容仍带着它的旧挂载：给了就按它来、不再问服务端要类别。
const ENV_CATEGORIES = String(process.env.BRIDGE_AGY_TOOLS || '').trim();
const FIXED = ENV_CATEGORIES !== '';
const LOCAL_CATEGORIES = ['media', 'ui', 'phone'];
const DEFAULT_CATEGORIES = ['media', 'ui'];   // 服务端一次都没问到时的退路
const envSet = new Set(ENV_CATEGORIES.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean));
const HUB_ON = FIXED ? envSet.has('hub') : true;

// 这次调用属于哪个 agy 会话：agy 在每个 tools/call 的 _meta 里带着会话 id（11-19 探针实测）。子进程跨会话复用，
// 所以按调用取、经 AsyncLocalStorage 交给 callInternal，随请求体发给服务端精确认领（不再靠「唯一在跑的那一轮」猜）。
// 子代理（agy 的 subagent）调用时 conversation_id 是子会话，root_conversation_id 才是 bridge 那一轮的会话，两个都带上。
const callScope = new AsyncLocalStorage();
function conversationOf(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const pick = (k) => (typeof m[k] === 'string' ? m[k].trim() : '');
  return {
    conversationId: pick('antigravity.google/conversation_id'),
    rootConversationId: pick('antigravity.google/root_conversation_id'),
  };
}

// 用 node:http 而不是全局 fetch：fetch（undici）对「迟迟不回响应头」的请求约 300 秒就自己断（UND_ERR_HEADERS_TIMEOUT，
// 11-19 实测 307 秒），调用方设多长的超时都没用——终端 wait 超过 5 分钟、慢的视频 / 音乐生成会在这头报失败，
// 服务端却照常做完。node:http 的客户端没有这道默认超时，等多久只由 timeoutMs 决定。
// （眼下更早触发的是 agy 自己的上限：每次工具调用 180 秒硬超时、进度通知不续期，所以会等很久的工具另外做了分段——
//  终端等待夹到 150 秒、视频 / 音乐发起后交出任务 id 由 media_result 取。这里不设默认超时是为了不再多一道更隐蔽的。）
function postLoopbackJson(pathname, body = {}, { timeoutMs = 60_000, signal = null } = {}) {
  if (!SECRET) return Promise.reject(new Error('缺少同机实例凭据（BRIDGE_HOST_SECRET）'));
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(API_BASE + pathname); } catch (e) { reject(e); return; }
    const payload = Buffer.from(JSON.stringify(body));
    let settled = false;
    let timer = null;
    const onAbort = () => { req.destroy(new Error('调用已取消')); };
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(v);
    };
    const req = (url.protocol === 'https:' ? https : http).request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Authorization: `Bearer ${SECRET}`,
        'X-Bridge-Agent': 'agy',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', (e) => done(reject, e));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw.trim() ? JSON.parse(raw.trim()) : null; } catch {}
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok || !parsed || parsed.ok === false) {
          const msg = parsed?.error?.message
            || (typeof parsed?.error === 'string' ? parsed.error : '')
            || raw.trim().slice(0, 300)
            || `HTTP ${res.statusCode}`;
          done(reject, new Error(msg));
          return;
        }
        done(resolve, parsed);
      });
    });
    req.on('error', (e) => done(reject, e));
    timer = setTimeout(() => { req.destroy(new Error(`等 bridge 应答超时（${Math.round(timeoutMs / 1000)} 秒）`)); }, timeoutMs);
    timer.unref?.();
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end(payload);
  });
}

async function callAgentOp(opName, args = {}, opts = {}) {
  const res = await postLoopbackJson(`/agent/v1/${encodeURIComponent(opName)}`, args, opts);
  return res.data;
}

async function callInternal(pathname, body = {}, opts = {}) {
  const conv = callScope.getStore();
  return postLoopbackJson(pathname, conv ? { ...conv, ...body } : body, opts);
}

// 本地工具三类全建好；列不列出来看当前类别（tools/list 时定），真正执行前各工具还会回服务端复核开关
const localDefs = buildAgyBridgeToolDefs({
  categories: FIXED ? ENV_CATEGORIES : LOCAL_CATEGORIES.join(','),
  phonePluginOn: true,
  callAgentOp,
  callInternal,
});
const localByName = new Map(localDefs.map((d) => [d.name, d]));

const jsonSchemaOf = (shape) => {
  const schema = z.toJSONSchema(z.object(shape || {}), { io: 'input', unrepresentable: 'any' });
  delete schema.$schema;
  return schema;
};
const localTools = localDefs.map((d) => ({ name: d.name, description: d.description, inputSchema: jsonSchemaOf(d.schema) }));

const categoryOf = (name) => String(name).split('_')[0];   // media_image → media、ui_view → ui、phone_list → phone

// 中枢清单与当前类别：tools/list 时向服务端现取；取不到（bridge 正在重启）就沿用上一份，免得工具整组消失。
// 注意 agy 对同一份配置只在子进程启动时取一次 tools/list——之后开关变了要靠服务端让 agy 常驻进程重启（client.mjs noteTooling）。
let lastHubTools = [];
let lastCategories = null;
async function refreshCatalog() {
  if (FIXED && !HUB_ON) return;
  try {
    const r = await callInternal('/api/agy/internal/hub/tools', {}, { timeoutMs: 15_000 });
    lastHubTools = HUB_ON && Array.isArray(r.tools) ? r.tools.filter((t) => t && t.name && !localByName.has(t.name)) : [];
    if (Array.isArray(r.categories)) lastCategories = r.categories.map((c) => String(c).toLowerCase());
  } catch (err) {
    process.stderr.write(`[agy-bridge] 取工具清单失败：${err?.message || err}\n`);
  }
}
function listedLocalTools() {
  if (FIXED) return localTools;   // 旧挂载：本地工具已按环境变量里的类别建好
  const cats = new Set(lastCategories || DEFAULT_CATEGORIES);
  return localTools.filter((t) => cats.has(categoryOf(t.name)));
}

const server = new Server({ name: 'bridge', version: '1.2.0' }, { capabilities: { tools: { listChanged: false } } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await refreshCatalog();
  return { tools: [...listedLocalTools(), ...lastHubTools] };
});

server.setRequestHandler(CallToolRequestSchema, (req, extra) => callScope.run(conversationOf(req.params?._meta), () => handleCall(req, extra)));

// 给步骤记录用的返回文字（图片等只留占位；服务端再截到它的上限）
function resultText(result) {
  const parts = [];
  for (const c of (Array.isArray(result?.content) ? result.content : [])) {
    if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c?.type === 'image') parts.push('[图片]');
    else if (c?.type === 'audio') parts.push('[音频]');
  }
  return parts.join('\n').trim().slice(0, 6000);
}

// 本地工具的返回内容报给服务端，补进这一轮的步骤记录（agy 自己的工具事件不带 MCP 返回）。
// 等它落定再把结果交给 agy：这样返回内容一定先于 agy 的「完成」事件到前端；报不上就算了，不影响工具结果。
async function reportLocalResult(name, args, result) {
  const text = resultText(result);
  if (!text) return;
  try {
    await callInternal('/api/agy/internal/tool-result', { name, args, text, isError: result?.isError === true }, { timeoutMs: 3_000 });
  } catch {}
}

async function handleCall(req, extra) {
  const name = String(req.params?.name || '');
  const args = req.params?.arguments && typeof req.params.arguments === 'object' ? req.params.arguments : {};
  const local = localByName.get(name);
  if (local) {
    const parsed = z.object(local.schema || {}).safeParse(args);
    if (!parsed.success) {
      const bad = { content: [{ type: 'text', text: `参数不合法：${parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'} ${i.message}`).join('；')}` }], isError: true };
      await reportLocalResult(name, args, bad);
      return bad;
    }
    const result = await local.handler(parsed.data, extra);
    await reportLocalResult(name, args, result);
    return result;
  }
  if (!HUB_ON) return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
  try {
    const r = await callInternal('/api/agy/internal/hub/call', { name, args }, { timeoutMs: 21 * 60_000, signal: extra?.signal });
    return r.result && Array.isArray(r.result.content) ? r.result : { content: [{ type: 'text', text: JSON.stringify(r.result ?? null) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `${name} 调用失败：${String(err?.message || err).slice(0, 800)}` }], isError: true };
  }
}

// 父进程断开标准输入时主动退出，防止脱离 ACP 生命周期残留无主 node 子进程
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

await server.connect(new StdioServerTransport());
