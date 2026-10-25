// 按人记账不重复累计（开源路线 S2-6）的契约：CLI 的 total_cost_usd 是进程 / 会话累计值，
// bridge 按「同一个 CLI 进程上一次的值」取差；续聊的起点是 transcript 里该会话最后一条 cost-state。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCostMeter, sessionCostBaseline } from './runtime/usage-ledger.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-ledger-'));
const SID = '98b37003-a88e-4cd4-82df-7718c7c3f85b';
const line = (o) => JSON.stringify(o) + '\n';
// CLI 实际写出的 cost-state 形状（2.1.299 buildCostStateMessage）
const cs = (sessionId, totalCostUSD) => ({
  type: 'cost-state', sessionId, totalCostUSD, totalAPIDuration: 1200, totalAPIDurationWithoutRetries: 1100, totalToolDuration: 30,
  totalLinesAdded: 3, totalLinesRemoved: 1, totalDuration: 5000, startTime: 1792567237566,
  modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: totalCostUSD } },
});

test('同一个 CLI 连跑几轮：每轮只记新增的那一截', () => {
  const m = makeCostMeter(0);
  assert.equal(m.turnCost(0.5), 0.5);
  assert.equal(m.turnCost(1.2), 0.7);
  assert.equal(m.turnCost(1.5), 0.3);
  assert.equal(m.turnCost(1.5), 0, '没花钱的一轮记 0');
});

test('续聊：从恢复的会话累计值起算（实测数据：$15.84 → $19.07 这一轮只记 $3.23）', () => {
  const m = makeCostMeter(15.837455);
  assert.equal(m.turnCost(19.0727484), 3.235293);
});

test('累计值比起点还小（换了会话、CLI 没恢复）：当从零算起；坏值记 0', () => {
  const m = makeCostMeter(10);
  assert.equal(m.turnCost(0.4), 0.4);
  assert.equal(m.turnCost(0.9), 0.5);
  assert.equal(m.turnCost(undefined), 0);
  assert.equal(m.turnCost('x'), 0);
  assert.equal(makeCostMeter(-3).turnCost(1), 1, '负起点按 0');
});

test('读起点：最后一条、属于这个会话的 cost-state；跨块、带多字节字符也读得对', async () => {
  const f = path.join(tmp, SID + '.jsonl');
  let s = line({ type: 'user', message: { role: 'user', content: '你好' } });
  s += line(cs(SID, 1.25));
  s += line(cs('other-session-id', 99));
  s += line(cs(SID, 2.5));
  // 之后再写 ~700KB 的对话（多字节），让 cost-state 落在倒数第三块之前
  const filler = line({ type: 'assistant', message: { content: [{ type: 'text', text: '汉字'.repeat(2000) }] } });
  for (let i = 0; i < 60; i++) s += filler;
  s += line(cs('other-session-id', 7));
  writeFileSync(f, s);
  assert.equal(await sessionCostBaseline(f, SID), 2.5);
  assert.equal(await sessionCostBaseline(f, 'other-session-id'), 7);
  assert.equal(await sessionCostBaseline(f, ''), 7, '不限会话 = 最后一条');
});

test('没有 cost-state、文件不存在、行是坏的：起点 0', async () => {
  const f = path.join(tmp, 'none.jsonl');
  writeFileSync(f, line({ type: 'user', message: { content: 'hi' } }) + '{"type":"cost-state",broken\n');
  assert.equal(await sessionCostBaseline(f, SID), 0);
  assert.equal(await sessionCostBaseline(path.join(tmp, 'missing.jsonl'), SID), 0);
  assert.equal(await sessionCostBaseline('', SID), 0);
});

test('文件第一行就是 cost-state（整个文件只有一块）', async () => {
  const f = path.join(tmp, 'first.jsonl');
  writeFileSync(f, JSON.stringify(cs(SID, 0.75)));   // 没有结尾换行
  assert.equal(await sessionCostBaseline(f, SID), 0.75);
});

test('只认 CLI 自己也认的行：没有会话 id、缺字段、金额离谱的都跳过（防手改 transcript 把这一轮记少）', async () => {
  const f = path.join(tmp, 'forged.jsonl');
  let s = line(cs(SID, 1.5));
  s += line({ ...cs(SID, 50), sessionId: undefined });                    // 没有会话 id：CLI 不恢复它
  s += line({ type: 'cost-state', sessionId: SID, totalCostUSD: 40 });    // 缺字段：CLI 的 schema 不过
  s += line({ ...cs(SID, 30), modelUsage: null });
  s += line({ ...cs(SID, 2e9) });                                         // 超过 CLI 的上限
  s += line({ ...cs(SID, 20), totalCostUSD: '20' });                      // 字符串不算数
  writeFileSync(f, s);
  assert.equal(await sessionCostBaseline(f, SID), 1.5);
});
