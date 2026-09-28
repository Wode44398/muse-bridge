// dimensio 准入契约。
//
// 注册用户默认只能用 Claude；管理员可在控制台按人勾选 dimensio。dimensio 单实例是【单租户】的，所以注册用户
// 各用各的 harness 进程（routes/harness.mjs 实例池，数据落在他自己的 .bridge/dimensio，harness 以
// DIMENSIO_TENANT=1 锁在他的文件夹里），因此可以按人放行——但【默认名单里没有它】，要管理员单独勾。
// 这条测试防的就是有人日后顺手把 dimensio 塞进默认名单、或让公开链接身份碰到它。
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

const ALL = ['claude', 'dimensio'];
const proUser = { kind: 'user', user: 'somepro', tier: 'pro', agents: ALL };
const plainUser = { kind: 'user', user: 'someuser', tier: 'user', agents: ALL };

test('admin 拿到这台机器上全部已启用的 agent', () => {
  const admin = contextFor({ kind: 'admin', user: null });
  assert.deepEqual(admin.agents, enabledAgents());
  assert.equal(admin.allowDimensio, enabledAgents().includes('dimensio'));
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
    assert.equal(ctx.allowDimensio, false);
    assert.equal(ctx.canSnapshot, false);
  }
  assert.equal(share.allowClaude, false, '只读分享不能跑 Claude');
});
