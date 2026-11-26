// agy 的 stdio MCP 子进程（agy-bridge-server.mjs）：真起子进程、配一个假 bridge 回环接口，
// 看它按服务端算好的清单列工具（本地工具也用服务端给的精简 / 合并版），合并工具 phone_files 按 action 落到原工具。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CORE_REGISTER_URL } from '@bridge/core/modules/core-resolve.mjs';
import { localToolCatalog } from './agy-bridge-tools.mjs';
import { mergeFamilies, compactAgyTool } from './catalog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const calls = [];
const local = mergeFamilies(localToolCatalog(['media', 'ui', 'phone'])).map(({ _members, ...t }) => compactAgyTool(t))
  .filter((t) => t.name !== 'media_music');   // 假装份额让出了一样：子进程就不该列它
const backend = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url, body });
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, ...o })); };
    if (req.url === '/api/agy/internal/hub/tools') return send({ tools: [{ name: 'browser', description: 'b', inputSchema: { type: 'object', properties: {} } }], local, categories: ['media', 'ui', 'phone', 'hub'] });
    if (req.url === '/api/agy/internal/phone') return send({ entries: [{ name: 'DCIM', isDir: true }] });
    if (req.url === '/api/agy/internal/tool-result') return send({ recorded: true });
    return send({});
  });
});
await new Promise((r) => backend.listen(0, '127.0.0.1', r));
const client = new Client({ name: 'agy-bridge-server-test', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ['--import', CORE_REGISTER_URL, path.join(HERE, 'agy-bridge-server.mjs')],
  env: { ...process.env, BRIDGE_API_URL: `http://127.0.0.1:${backend.address().port}`, BRIDGE_HOST_SECRET: 'test-secret', BRIDGE_AGY_TOOLS: '' },
}));
after(async () => { try { await client.close(); } catch {} backend.close(); });

test('子进程按服务端算好的清单列工具：本地工具用精简 / 合并版，被让出的不列，原名不重复出现', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('phone_files'), names.join(' '));
  assert.ok(names.includes('browser'));
  assert.ok(names.includes('media_image'));
  for (const gone of ['phone_list', 'phone_delete', 'media_music']) assert.equal(names.includes(gone), false, gone);
});

test('合并工具 phone_files：按 action 落到原工具，参数照原工具校验；步骤记录按 agy 看到的名字报', async () => {
  calls.length = 0;
  const r = await client.callTool({ name: 'phone_files', arguments: { action: 'list', path: '@r1' }, _meta: { 'antigravity.google/conversation_id': 'conv-1' } });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.match(r.content[0].text, /DCIM/);
  const phone = calls.find((c) => c.path === '/api/agy/internal/phone');
  assert.equal(phone.body.op, 'list');
  assert.equal(phone.body.args.path, '@r1');
  assert.equal(phone.body.conversationId, 'conv-1');
  const rec = calls.find((c) => c.path === '/api/agy/internal/tool-result');
  assert.equal(rec.body.name, 'phone_files');
  assert.equal(rec.body.args.action, 'list');

  // 原工具的必填项照样校验（read 要 path）
  const bad = await client.callTool({ name: 'phone_files', arguments: { action: 'read' } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /参数不合法/);
  // 不认识的 action：不落到任何工具上
  const nuke = await client.callTool({ name: 'phone_files', arguments: { action: 'pull', path: 'x' } });
  assert.equal(nuke.isError, true);
  assert.match(nuke.content[0].text, /list \/ read \/ write \/ scan \/ delete/);
  assert.equal(calls.filter((c) => c.path === '/api/agy/internal/phone').length, 1, '只有第一次真的问了手机');
});
