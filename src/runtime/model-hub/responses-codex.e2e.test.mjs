// 端到端（只在 BRIDGE_CODEX_IT=1 时跑）：真的 codex app-server → 模型中心网关的 Responses 段 → 翻译成 Chat Completions → 本机假上游。
// 假上游第一次回一个 exec_command 调用（Codex 真的去跑 echo），第二次回正文；验工具真跑了、这一轮正常结束、第二次请求带着工具输出。
// Codex 用临时 CODEX_HOME（不碰 %USERPROFILE%\.codex、不要登录），数据根是临时目录；子进程只杀自己起的那棵树，用完删临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUN = process.env.BRIDGE_CODEX_IT === '1';
const TOTAL_MS = 240_000;

// Codex 桌面版装的 codex.exe 里最新的那个；CODEX_BIN 可能指着被更新删掉的旧目录，不存在就不信
function codexExe() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  let best = null;
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const f = path.join(root, d, 'codex.exe');
    try { const m = fs.statSync(f).mtimeMs; if (!best || m > best.m) best = { f, m }; } catch {}
  }
  if (!best) throw new Error('找不到 codex.exe（%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\*\\codex.exe）');
  return best.f;
}
function killTree(pid) {
  if (!pid) return;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}

/** 最小的 app-server JSON-RPC 客户端：请求 / 通知 / 服务端来的请求（审批一律放行）。 */
function appServer(home, cwd) {
  const proc = spawn(codexExe(), ['app-server'], { cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map(), listeners = new Set(), notes = [], stderr = [];
  let next = 1;
  const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
  createInterface({ input: proc.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id != null && !m.method) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } return; }
    if (m.id != null && m.method) {
      // 审批：这一轮只跑一条 echo，放行
      send(/requestApproval|approval/i.test(m.method) ? { id: m.id, result: { decision: 'accept' } } : { id: m.id, error: { code: -32601, message: 'unhandled' } });
      return;
    }
    notes.push(m);
    for (const fn of listeners) fn(m);
  });
  proc.stderr.on('data', (d) => { stderr.push(String(d)); if (stderr.length > 100) stderr.shift(); });
  proc.once('exit', () => { for (const p of pending.values()) p.reject(new Error('app-server 退出了：' + stderr.join('').slice(-800))); pending.clear(); });
  return {
    proc, notes, stderr,
    request(method, params, ms = 60_000) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, ms);
        pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
        send({ id, method, params });
      });
    },
    notify(method, params = {}) { send({ method, params }); },
    waitFor(pred, ms, what) {
      return new Promise((resolve, reject) => {
        const hit = notes.find(pred);
        if (hit) return resolve(hit);
        const fn = (m) => { if (pred(m)) { clearTimeout(t); listeners.delete(fn); resolve(m); } };
        const t = setTimeout(() => { listeners.delete(fn); reject(new Error(`等 ${what} 超时；stderr：${stderr.join('').slice(-800)}`)); }, ms);
        listeners.add(fn);
      });
    },
  };
}

test('Codex app-server 经网关的 Responses 段（翻译成 Chat）跑通一轮工具调用', { skip: !RUN && '设 BRIDGE_CODEX_IT=1 才跑', timeout: TOTAL_MS }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-e2e-'));
  const home = path.join(tmp, 'codex-home'), work = path.join(tmp, 'work'), data = path.join(tmp, 'data');
  for (const d of [home, work, data]) fs.mkdirSync(d, { recursive: true });
  process.env.BRIDGE_DATA_ROOT = data;
  process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
  delete process.env.VERTEX_PROJECT;
  let srv = null, cx = null, G = null;
  // 整体超时：到点先收子进程（test 的 timeout 只让测试失败，不会替我们杀进程）
  const guard = setTimeout(() => { if (cx) killTree(cx.proc.pid); }, TOTAL_MS - 5_000);
  try {
    // —— 假 Chat 上游 ——
    const chats = [];
    srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
        const body = JSON.parse(raw);
        chats.push(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (j) => res.write(`data: ${JSON.stringify(j)}\n\n`);
        if (chats.length === 1) {
          send({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'run it' } }] });
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_e2e_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":' } }] } }] });
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"echo hub-e2e-ok"}' } }] } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          send({ choices: [{ index: 0, delta: { role: 'assistant', content: 'all ' } }] });
          send({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] });
        }
        send({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } });
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const UP = `http://127.0.0.1:${srv.address().port}/v1`;

    // —— 网关（进程内）+ 一个勾给 codex 的 OpenAI 协议服务 ——
    const R = await import('./registry.mjs');
    G = await import('./gateway.mjs');
    const S = await import('../model-services.mjs');
    R._resetHubForTests(path.join(data, 'hub'));
    await R.initModelHub();
    const sid = R.createHubFromDetect({ baseUrl: UP, kind: 'openai', useProxy: false, key: 'k-e2e', catalog: [{ id: 'hub-m', kind: 'text' }], assign: [{ id: 'hub-m', agents: ['codex'] }] }).service.id;
    const pub = S.modelServices('codex').find((x) => x.sid === sid);
    assert.ok(pub?.responsesUrl, '发布给 codex 的服务带 Responses 地址');

    // —— 临时 CODEX_HOME：provider 指到网关 ——
    fs.writeFileSync(path.join(home, 'config.toml'), [
      'model = "hub-m"',
      'model_provider = "hubtest"',
      '',
      '[model_providers.hubtest]',
      'name = "Hub test"',
      `base_url = "${pub.responsesUrl}"`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'supports_websockets = false',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      'stream_idle_timeout_ms = 60000',
      '',
    ].join('\n'));

    cx = appServer(home, work);
    await cx.request('initialize', { clientInfo: { name: 'bridge_hub_e2e', title: 'Bridge hub e2e', version: '0.0.1' }, capabilities: { experimentalApi: true } });
    cx.notify('initialized');
    // 沙箱档用 danger-full-access：本机没装 Windows 沙箱时 workspace-write 会把命令拦掉（blocked by policy），这里只跑一条 echo、cwd 是临时目录
    const th = await cx.request('thread/start', { cwd: work, sandbox: 'danger-full-access', approvalPolicy: 'never' });
    const threadId = th.thread.id;
    const done = cx.waitFor((m) => m.method === 'turn/completed' && m.params?.threadId === threadId, 150_000, 'turn/completed');
    await cx.request('turn/start', { threadId, input: [{ type: 'text', text: 'run the echo command' }] });
    const completed = await done;

    assert.equal(completed.params.turn?.status, 'completed', '这一轮正常结束：' + JSON.stringify(completed.params.turn?.error || null));
    const cmd = cx.notes.find((m) => m.method === 'item/completed' && m.params?.item?.type === 'commandExecution');
    assert.ok(cmd, 'Codex 真的跑了命令');
    assert.match(String(cmd.params.item.aggregatedOutput || ''), /hub-e2e-ok/);
    assert.equal(chats.length, 2, '上游被打了两次：调用一次、带结果再一次');
    const tool = chats[1].messages.find((m) => m.role === 'tool');
    assert.equal(tool?.tool_call_id, 'call_e2e_1');
    assert.match(String(tool.content), /hub-e2e-ok/, '第二次请求带着工具输出');
    const asst = chats[1].messages.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.equal(asst.tool_calls[0].function.name, 'exec_command');
    assert.ok(chats[0].tools.some((t) => t.function.name === 'exec_command'), '工具表翻成了 Chat 的函数');
    const msg = cx.notes.find((m) => m.method === 'item/completed' && m.params?.item?.type === 'agentMessage');
    assert.equal(msg?.params.item.text, 'all done');
  } finally {
    clearTimeout(guard);
    if (cx) { try { cx.proc.stdin.end(); } catch {} killTree(cx.proc.pid); await new Promise((r) => (cx.proc.exitCode !== null ? r() : cx.proc.once('exit', r))); }
    if (srv) { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
    if (G) await G._stopGatewayForTests();
    // Codex 刚退出时还可能占着文件：删不掉就稍等再删
    for (let i = 0; i < 5; i++) { try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  }
});
