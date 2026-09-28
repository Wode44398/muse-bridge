// /api/session 对账短路的指纹。
//
// Claude 分页每收到一个 session.touch 总线事件就重拉一次整份 transcript；CLI / 桌面
// Claude Code 在跑时那个 jsonl 一直在长，实测手机端约每 8 秒拉一次整份记录（长会话
// 几百 KB），而绝大多数时候内容跟手里的一模一样。指纹一致就只回几十字节。
//
// 指纹的正确性要求是【单向严格】的：内容变了指纹【必须】变（漏变 = 前端永远看不到
// 新消息，比不优化坏得多）；内容没变时最好别变（变了只是少省一次，无害）。
// 所以下面每一条"会变"的用例都是必须项。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionFingerprint } from './sessions.mjs';
import { recordChatPrefs, dropChatPrefs } from '../runtime/chat-prefs.mjs';
import { setPendingRewind, clearPendingRewind } from '../agents/claude-rewind.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-fp-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, '{"type":"user"}\n', 'utf8');
  return { dir, file, ctx: { dataDir: dir } };
}
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

test('同样的输入给同样的指纹', () => {
  const { dir, file, ctx } = fixture();
  try {
    const a = sessionFingerprint(file, 's1', ctx);
    assert.ok(a, '正常情况必须给得出指纹');
    assert.equal(sessionFingerprint(file, 's1', ctx), a);
  } finally { clean(dir); }
});

test('transcript 一长，指纹必须变（否则新消息永远送不到前端）', () => {
  const { dir, file, ctx } = fixture();
  try {
    const before = sessionFingerprint(file, 's1', ctx);
    fs.appendFileSync(file, '{"type":"assistant"}\n', 'utf8');
    assert.notEqual(sessionFingerprint(file, 's1', ctx), before);
  } finally { clean(dir); }
});

test('长度不变但内容变了也要变（size 之外还看 mtime）', () => {
  const { dir, file, ctx } = fixture();
  try {
    const before = sessionFingerprint(file, 's1', ctx);
    const st = fs.statSync(file);
    fs.writeFileSync(file, '{"type":"USER"}\n', 'utf8');   // 同样字节数
    assert.equal(fs.statSync(file).size, st.size, '前提：字节数确实没变');
    fs.utimesSync(file, new Date(), new Date(st.mtimeMs + 5000));
    assert.notEqual(sessionFingerprint(file, 's1', ctx), before);
  } finally { clean(dir); }
});

test('回滚锚点变了要变——视图要按锚点截断', () => {
  const { dir, file, ctx } = fixture();
  try {
    const before = sessionFingerprint(file, 'sess-rewind', ctx);
    setPendingRewind('sess-rewind', 'uuid-anchor-1');
    try {
      assert.notEqual(sessionFingerprint(file, 'sess-rewind', ctx), before);
    } finally { clearPendingRewind('sess-rewind'); }
    assert.equal(sessionFingerprint(file, 'sess-rewind', ctx), before, '清掉锚点应当回到原指纹');
  } finally { clean(dir); }
});

test('prefs sidecar 变了要变——前端靠它恢复模型/Effort 选择器', () => {
  const { dir, file, ctx } = fixture();
  try {
    const before = sessionFingerprint(file, 's1', ctx);
    recordChatPrefs(ctx, 's1', { model: 'claude-opus-5', effort: 'high', fast: false });
    const after = sessionFingerprint(file, 's1', ctx);
    assert.notEqual(after, before);
    recordChatPrefs(ctx, 's1', { model: 'claude-opus-5', effort: 'low', fast: false });
    assert.notEqual(sessionFingerprint(file, 's1', ctx), after);
    dropChatPrefs(ctx, 's1');
  } finally { clean(dir); }
});

test('不同会话互不串味', () => {
  const { dir, file, ctx } = fixture();
  try {
    recordChatPrefs(ctx, 'a', { model: 'x', effort: 'high', fast: false });
    assert.notEqual(sessionFingerprint(file, 'a', ctx), sessionFingerprint(file, 'b', ctx));
    dropChatPrefs(ctx, 'a');
  } finally { clean(dir); }
});

test('文件不存在时返回 null = 不短路，绝不给出错误的 unchanged', () => {
  const { dir, ctx } = fixture();
  try {
    assert.equal(sessionFingerprint(path.join(dir, 'nope.jsonl'), 's1', ctx), null);
  } finally { clean(dir); }
});
