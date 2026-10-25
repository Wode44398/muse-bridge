// /api/session 的增量解析缓存（readSessionHistory，2026-10-21）：与整份重建 readSessionMessages 对拍。
// 正常追加只读新增部分（extends 计数涨）；回滚分叉、安全栅门撤回、新主链经过旧内容里的条目（插话挂在旧的附件链上）、
// 改写 / 变短、半行、手动 /compact 扣着——这些要么整份重建、要么续读，但结果都必须与整份重建逐字段一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-hist-cache-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const { readSessionMessages, readSessionHistory, _historyStats } = await import('./sessions.mjs');

const PAD = 'x'.repeat(4000);   // 让 transcript 过 1MB 的缓存门槛
function writer(name) {
  const file = path.join(tmp, name + '.jsonl');
  let n = 0, prev = null;
  const ts = (k) => new Date(Date.UTC(2026, 9, 21, 9, 0, 0, k)).toISOString();
  const w = {
    file,
    lines: [],
    rec(o, { parent } = {}) {
      o.uuid = o.uuid || name + '-r' + (++n);
      if (!('parentUuid' in o)) o.parentUuid = parent !== undefined ? parent : prev;
      prev = o.uuid;
      o.timestamp = o.timestamp || ts(n);
      w.lines.push(JSON.stringify(o));
      return o.uuid;
    },
    user: (text, opt) => w.rec({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }, opt),
    asst: (text, opt) => w.rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }, opt),
    setPrev: (u) => { prev = u; },
    flush() { appendFileSync(file, w.lines.map((l) => l + '\n').join('')); w.lines = []; },
  };
  writeFileSync(file, '');
  return w;
}
function bulk(w, turns) { for (let i = 0; i < turns; i++) { w.user('问题 ' + i + ' ' + PAD); w.asst('回答 ' + i + ' ' + PAD); } }
const same = async (file, label) => {
  const full = await readSessionMessages(file);
  const inc = await readSessionHistory(file, { key: 'admin' });
  assert.deepEqual(JSON.parse(JSON.stringify(inc)), JSON.parse(JSON.stringify(full)), label);
  return inc;
};

test('正常追加：只读新增部分，结果与整份重建一致；没变就直接命中', async () => {
  const w = writer('grow');
  bulk(w, 140); w.flush();
  const s0 = _historyStats();
  await same(w.file, '首次整份建');
  assert.equal(_historyStats().builds, s0.builds + 1);
  await same(w.file, '没变');
  assert.equal(_historyStats().hits, s0.hits + 1);
  w.user('新问题'); w.asst('新回答'); w.flush();
  const msgs = await same(w.file, '追加一轮');
  assert.equal(_historyStats().extends, s0.extends + 1, '走了增量续读');
  assert.equal(msgs[msgs.length - 1].text, '新回答');
  // 半行：CLI 正在写的那一行还没换行——先不算，补齐后接上
  appendFileSync(w.file, JSON.stringify({ type: 'user', uuid: 'grow-half', parentUuid: msgs.length ? undefined : null }).slice(0, 20));
  await readSessionHistory(w.file, { key: 'admin' });
});

test('半行补齐、压缩边界（logicalParentUuid 接链）续读后仍一致', async () => {
  const w = writer('half');
  bulk(w, 140); w.flush();
  await same(w.file, '首次');
  const last = w.asst('半截那条', {});
  const line = w.lines.pop();
  appendFileSync(w.file, line.slice(0, 30));
  await same(w.file, '半行不算');
  appendFileSync(w.file, line.slice(30) + '\n');
  await same(w.file, '补齐');
  // 自动压缩：边界 parentUuid=null、logicalParentUuid 指回压缩前
  w.rec({ type: 'system', subtype: 'compact_boundary', parentUuid: null, logicalParentUuid: last, compactMetadata: { trigger: 'auto', preTokens: 1000 } });
  w.rec({ type: 'user', isCompactSummary: true, message: { role: 'user', content: [{ type: 'text', text: '压缩摘要' }] } });
  w.user('压缩后的问题'); w.asst('压缩后的回答'); w.flush();
  const s0 = _historyStats();
  await same(w.file, '压缩后续读');
  assert.equal(_historyStats().extends, s0.extends + 1);
});

test('最后一行是完整 JSON 但没写换行：照样算一行；之后补上换行再长，续读不重复', async () => {
  const w = writer('noeol');
  bulk(w, 140); w.flush();
  await same(w.file, '首次');
  w.user('没换行的这句');
  appendFileSync(w.file, w.lines.pop());   // 不带 \n
  const a = await same(w.file, '末行无换行');
  assert.ok(JSON.stringify(a).includes('没换行的这句'));
  appendFileSync(w.file, '\n');
  w.asst('接着的回答'); w.flush();
  const s0 = _historyStats();
  const b = await same(w.file, '补换行后续读');
  assert.equal(_historyStats().extends, s0.extends + 1);
  assert.equal(JSON.stringify(b).split('没换行的这句').length, 2, '那句只出现一次');
});

test('回滚分叉：新叶子沿链走不到旧叶子 → 整份重建，被回滚的轮不再出现', async () => {
  const w = writer('fork');
  bulk(w, 140);
  const anchor = w.user('分叉点');
  w.asst('分叉点的回答');
  w.user('会被回滚的问题'); w.asst('会被回滚的回答'); w.flush();
  await same(w.file, '首次');
  w.setPrev(anchor);
  w.asst('重新回答（分叉）'); w.flush();
  const s0 = _historyStats();
  const msgs = await same(w.file, '分叉后');
  assert.equal(_historyStats().builds, s0.builds + 1, '整份重建');
  assert.ok(!JSON.stringify(msgs).includes('会被回滚的回答'));
});

test('安全栅门撤回旧帧 → 整份重建，撤回的那条消失', async () => {
  const w = writer('retract');
  bulk(w, 140);
  w.user('问一句');
  const bad = w.asst('要被撤回的半截');
  w.flush();
  await same(w.file, '首次');
  w.rec({ type: 'system', subtype: 'model_refusal_fallback', retractedMessageUuids: [bad] });
  w.asst('换模型后的回答'); w.flush();
  const s0 = _historyStats();
  const msgs = await same(w.file, '撤回后');
  assert.equal(_historyStats().builds, s0.builds + 1);
  assert.ok(!JSON.stringify(msgs).includes('要被撤回的半截'));
});

test('新主链经过旧内容里的条目（插话挂在旧的附件链上）→ 整份重建，插话段不丢', async () => {
  const w = writer('steer');
  bulk(w, 140);
  const u = w.user('开始干活');
  const a1 = w.rec({ type: 'attachment', attachment: { type: 'hook_additional_context', content: 'x' } }, { parent: u });
  w.rec({ type: 'attachment', attachment: { type: 'queued_command', prompt: '顺便把测试也跑了' } }, { parent: a1 });
  w.flush();
  const first = await same(w.file, '插话还没被主链认领');
  assert.ok(!JSON.stringify(first).includes('顺便把测试也跑了'), '此刻整份重建也不显示它');
  w.asst('好，连测试一起'); w.flush();
  const s0 = _historyStats();
  const msgs = await same(w.file, '主链经过旧的附件');
  assert.equal(_historyStats().builds, s0.builds + 1);
  assert.ok(JSON.stringify(msgs).includes('顺便把测试也跑了'));
});

test('改写（同长 / 变短 / 末尾被改）→ 整份重建', async () => {
  const w = writer('rewrite');
  bulk(w, 140); w.flush();
  await same(w.file, '首次');
  // 整份换成更短的内容
  writeFileSync(w.file, '');
  bulk(w, 130); w.flush();
  await same(w.file, '变短');
  // 末尾改写后再变长：已消化部分的尾巴对不上
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(w.file, 'utf8');
  writeFileSync(w.file, raw.slice(0, -40) + raw.slice(-40).replace(/回答/g, '改了') + '');
  w.user('又一轮'); w.asst('又一轮的回答'); w.flush();
  await same(w.file, '末尾被改写');
});

test('手动 /compact 扣着（命令记录还没到）：这一份不留，命令记录到了与整份重建一致', async () => {
  const w = writer('manual');
  bulk(w, 140);
  const last = w.asst('压缩前最后一句');
  w.rec({ type: 'system', subtype: 'compact_boundary', parentUuid: null, logicalParentUuid: last, compactMetadata: { trigger: 'manual', preTokens: 2000 } });
  w.rec({ type: 'user', isCompactSummary: true, message: { role: 'user', content: [{ type: 'text', text: '手动压缩摘要' }] } });
  w.flush();
  await same(w.file, '扣着');
  w.user('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>');
  w.flush();
  await same(w.file, '命令记录到了');
  w.user('接着聊'); w.asst('好的'); w.flush();
  await same(w.file, '之后续读');
});

test('回滚锚点待生效：不走缓存，按锚点截断', async () => {
  const w = writer('cut');
  bulk(w, 140);
  const anchor = w.user('截到这里');
  w.asst('这句之后被截掉'); w.flush();
  const full = await readSessionMessages(w.file, { cutAfterUuid: anchor });
  const got = await readSessionHistory(w.file, { key: 'admin', cutAfterUuid: anchor });
  assert.deepEqual(JSON.parse(JSON.stringify(got)), JSON.parse(JSON.stringify(full)));
  assert.ok(!JSON.stringify(got).includes('这句之后被截掉'));
});
