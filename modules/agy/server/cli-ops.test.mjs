import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseMcpListOutput,
  buildMcpAddArgs,
  parsePluginListOutput,
  extractAccountFromLogText,
  readAgyAccountInfo,
} from './cli-ops.mjs';

test('parseMcpListOutput：解析录制的真实 agy mcp list 表格与空态输出', () => {
  const emptyRes = parseMcpListOutput('No MCP servers configured.\n');
  assert.equal(emptyRes.ok, true);
  assert.equal(emptyRes.parseError, false);
  assert.deepEqual(emptyRes.items, []);

  // 来自真实 agy 1.5.10 执行 agy mcp list 录制的表格样本
  const realTable = [
    'NAME            TYPE    STATUS    COMMAND/URL',
    'demo-fs         stdio   enabled   npx -y @modelcontextprotocol/server-filesystem E:\\work',
    'remote-gateway  http    disabled  https://mcp.example.com/v1/sse',
  ].join('\n');

  const sidecar = {
    'demo-fs': {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'E:\\work'],
      env: { API_TOKEN: 'secret-123', WORKSPACE_ROOT: 'E:\\work' },
    },
    'remote-gateway': {
      serverUrl: 'https://mcp.example.com/v1/sse',
      headers: { Authorization: 'Bearer xxx' },
    },
  };

  const parsed = parseMcpListOutput(realTable, sidecar);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.parseError, false);
  assert.equal(parsed.items.length, 2);

  assert.equal(parsed.items[0].name, 'demo-fs');
  assert.equal(parsed.items[0].type, 'stdio');
  assert.equal(parsed.items[0].enabled, true);
  assert.equal(parsed.items[0].command, 'npx');
  assert.deepEqual(parsed.items[0].args, ['-y', '@modelcontextprotocol/server-filesystem', 'E:\\work']);
  // 仅暴露环境变量键名，不向前端泄露密钥值
  assert.deepEqual(parsed.items[0].envKeys, ['API_TOKEN', 'WORKSPACE_ROOT']);

  assert.equal(parsed.items[1].name, 'remote-gateway');
  assert.equal(parsed.items[1].type, 'http');
  assert.equal(parsed.items[1].enabled, false);
  assert.equal(parsed.items[1].url, 'https://mcp.example.com/v1/sse');
  assert.deepEqual(parsed.items[1].headerKeys, ['Authorization']);
});

test('parseMcpListOutput：未来 CLI 输出格式未知时保留原文降级展示', () => {
  const futureFormat = '┌── servers (v2) ──┐\n│ demo-fs: active │\n└──────────────────┘';
  const res = parseMcpListOutput(futureFormat);
  assert.equal(res.ok, false);
  assert.equal(res.parseError, true);
  assert.deepEqual(res.items, []);
  assert.equal(res.rawOutput, futureFormat);
});

test('buildMcpAddArgs：严格把选项排在 <name> 之前并用 -- 分隔子命令参数', () => {
  const stdioArgs = buildMcpAddArgs({
    name: 'demo-fs',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'E:\\work'],
    env: { API_KEY: 'abc123' },
  });
  const nameIdx = stdioArgs.indexOf('demo-fs');
  const envIdx = stdioArgs.indexOf('--env');
  const dashDashIdx = stdioArgs.indexOf('--');
  assert.ok(envIdx > 0 && envIdx < nameIdx, '--env 必须排在 <name> 前面');
  assert.equal(dashDashIdx, nameIdx + 1, '<name> 后必须紧跟 -- 分隔符');
  assert.deepEqual(stdioArgs.slice(dashDashIdx + 1), [
    'npx',
    '-y',
    '@modelcontextprotocol/server-filesystem',
    'E:\\work',
  ]);

  const httpArgs = buildMcpAddArgs({
    name: 'remote-api',
    command: 'https://mcp.example.com/sse',
  });
  assert.deepEqual(httpArgs, ['mcp', 'add', '--type', 'http', 'remote-api', 'https://mcp.example.com/sse']);

  assert.throws(() => buildMcpAddArgs({ name: '../bad', command: 'npx' }), /MCP 名称/);
  assert.throws(() => buildMcpAddArgs({ name: 'valid', command: '' }), /启动命令/);
  assert.throws(() => buildMcpAddArgs({ name: 'valid', command: 'npx', env: { 'BAD-KEY': '1' } }), /环境变量名不合法/);
});

test('parsePluginListOutput：解析 JSON 数组、文本回退列表与未知格式降级', () => {
  assert.deepEqual(parsePluginListOutput('[]'), {
    ok: true,
    parseError: false,
    items: [],
    rawOutput: '[]',
  });

  const jsonOut = JSON.stringify([
    { name: 'code-review', enabled: true, version: '1.4.2', source: 'local', path: 'C:\\plugins\\code-review' },
    { name: 'linter-pack', enabled: false, version: '0.9.0', source: 'marketplace', path: '' },
  ]);
  const resJson = parsePluginListOutput(jsonOut);
  assert.equal(resJson.ok, true);
  assert.equal(resJson.parseError, false);
  assert.equal(resJson.items.length, 2);
  assert.equal(resJson.items[0].name, 'code-review');
  assert.equal(resJson.items[0].enabled, true);
  assert.equal(resJson.items[1].enabled, false);

  const textOut = [
    'Installed plugins:',
    '- alpha-helper (enabled, 2.0.1)',
    '- beta-tools (disabled, 0.3.0)',
  ].join('\n');
  const resText = parsePluginListOutput(textOut);
  assert.equal(resText.ok, true);
  assert.equal(resText.items.length, 2);
  assert.equal(resText.items[0].version, '2.0.1');
  assert.equal(resText.items[1].enabled, false);

  const unknownOut = 'Plugin registry v9: <xml/>';
  const resUnknown = parsePluginListOutput(unknownOut);
  assert.equal(resUnknown.parseError, true);
  assert.equal(resUnknown.rawOutput, unknownOut);
});

test('extractAccountFromLogText：从真实 ACP 日志提取最新登录邮箱与认证方式', () => {
  const sampleLog = [
    '2026-11-17T10:00:01Z [INFO] OAuth: authenticated successfully as first@example.com',
    '2026-11-17T10:05:12Z [INFO] applyAuthResult: email=architect@corp.dev, authMethod=oauth-business',
  ].join('\n');
  const info = extractAccountFromLogText(sampleLog);
  assert.deepEqual(info, {
    email: 'architect@corp.dev',
    authMethod: 'oauth-business',
  });
});

test('readAgyAccountInfo：--process-per-session 模式下可从派生 worker 日志提取登录邮箱', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-cliops-acct-'));
  const frontLog = path.join(dir, 'acp.log');
  const workerLog = `${frontLog}.20480`;
  try {
    writeFileSync(frontLog, 'I1 Starting ACP front (pid 9001, isJetski=false)\nI2 front: started worker 1 (pid 20480)\n');
    writeFileSync(workerLog, 'I1 applyAuthResult: email=worker-user@example.com, authMethod=consumer\n');
    const fakeClient = {
      logFile: frontLog,
      status: () => ({ authState: 'authed', tier: { name: 'Google AI Ultra' }, authMethods: [] }),
    };
    const acct = readAgyAccountInfo(fakeClient);
    assert.equal(acct.authed, true);
    assert.equal(acct.email, 'worker-user@example.com');
    assert.equal(acct.authMethod, 'consumer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
