// 高权限 agent（codex / dimensio）准入契约。
//
// 2026-09-23 维护者定：注册用户默认只能用 Claude 与 Gemini（Vertex）；2026-09-28 起管理员可在控制台按人勾选，
// 但勾选只在「这个 agent 支持多用户」时才生效（config/agents.mjs 的 multiUser）：
// - codex：进程内部工具调用、命令、改文件绕过 bridge 的 canUseTool 沙箱守卫，且共用主机上的登录与会话目录。
// - dimensio（harness 底座）：单实例是【单租户】的；2026-09-28 起注册用户各用各的 harness 进程（routes/harness.mjs
//   实例池，数据落在他自己的 .bridge/dimensio，harness 以 DIMENSIO_TENANT=1 锁在他的文件夹里），所以可以按人放行。
//   但【默认名单里没有它】（新账号默认只有 Claude + Gemini），要管理员在控制台单独勾。
// 这条测试防的就是有人日后顺手把 codex 挂回 pro 档、或把 dimensio 塞进默认名单。
// Antigravity（agy）已下线：users.json / config.json 里残留的 'agy' 不能再让任何身份拿到它。
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 数据根改道到临时目录（别在仓库根生成 config.json）。
if (!process.env.BRIDGE_DATA_ROOT) process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-access-'));
const { contextFor } = await import('./runtime/identity.mjs');
const { enabledAgents } = await import('./runtime/agent-status.mjs');
const { AGENT_BY_ID } = await import('./config/agents.mjs');

// 名单里故意留着已下线的 'agy'：老账号的 users.json 可能还有它。
const ALL = ['claude', 'gemini', 'agy', 'codex', 'dimensio'];
const proUser = { kind: 'user', user: 'somepro', tier: 'pro', agents: ALL };
const plainUser = { kind: 'user', user: 'someuser', tier: 'user', agents: ALL };

test('admin 拿到这台机器上全部已启用的 agent', () => {
  const admin = contextFor({ kind: 'admin', user: null });
  assert.deepEqual(admin.agents, enabledAgents());
  assert.equal(admin.allowCodex, enabledAgents().includes('codex'));
  assert.equal(admin.allowDimensio, enabledAgents().includes('dimensio'));
});

test('codex 不支持多用户：注册用户勾了也拿不到', () => {
  assert.equal(AGENT_BY_ID.codex.multiUser, false);
  for (const u of [proUser, plainUser]) {
    assert.equal(contextFor(u).allowCodex, false, `${u.tier} 不应有 codex`);
  }
});

test('Antigravity 已下线：agent 表里没有它，残留名单也拿不到', () => {
  assert.equal(AGENT_BY_ID.agy, undefined);
  for (const ctx of [contextFor({ kind: 'admin', user: null }), contextFor(proUser), contextFor(plainUser)]) {
    assert.equal(ctx.agents.includes('agy'), false);
    assert.equal('allowAgy' in ctx, false);
    assert.equal('agyHist' in ctx, false);
  }
});

test('dimensio 按人放行，但不在默认名单里', () => {
  for (const u of [proUser, plainUser]) {
    assert.equal(contextFor(u).allowDimensio, AGENT_BY_ID.dimensio.multiUser && enabledAgents().includes('dimensio'));
  }
  // 没被单独设置过名单的注册用户（老账号 / 默认）拿不到 dimensio
  assert.equal(contextFor({ kind: 'user', user: 'legacy', tier: 'pro' }).allowDimensio, false);
});

test('pro 档仍保留命令行，普通档没有（本次只收 agent 入口）', () => {
  assert.equal(contextFor(proUser).shell, true);
  assert.equal(contextFor(plainUser).shell, false);
});

test('公开分享/快照身份永远进不去', () => {
  // 这两种是公网可拿的能力 token（/w/、/c/ 链接），任何情况下都不能碰高权限 agent
  const share = contextFor({ kind: 'share', token: 'tok', dir: process.cwd() });
  const snap = contextFor({ kind: 'snap', token: 'tok', dir: process.cwd() });
  for (const ctx of [share, snap]) {
    assert.equal(ctx.allowCodex, false);
    assert.equal(ctx.allowDimensio, false);
    assert.equal(ctx.allowGemini, false);
    assert.equal(ctx.canSnapshot, false);
  }
  assert.equal(share.allowClaude, false, '只读分享不能跑 Claude');
});
