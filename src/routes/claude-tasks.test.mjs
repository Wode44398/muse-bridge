// 子 agent 转录读取：工作流 harness 框剥离、提示词取法、按字节偏移增量读（运行中打开的 agent 每 2s 拉一次）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readAgentTranscript, unframePrompt } from './claude-tasks.mjs';

const FRAME = '[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. The computed task text follows:';
const user = (content, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra }) + '\n';
const asst = (content, model = 'claude-haiku-4-5') => JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content } }) + '\n';

function tmpFile(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-tr-'));
  const f = path.join(dir, 'agent-a1.jsonl');
  writeFileSync(f, body);
  return { f, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('unframePrompt 剥掉 harness 首行并去两格缩进；没框原样返回', () => {
  assert.equal(unframePrompt(FRAME + '\n  line one\n    nested\n  line three'), 'line one\n  nested\nline three');
  assert.equal(unframePrompt('plain prompt\n  kept'), 'plain prompt\n  kept');
});

test('提示词 = 开头连续 user 记录的最后一条（剥框），不截 4000 字', () => {
  const long = 'x'.repeat(9000);
  const { f, done } = tmpFile(
    user('[Workflow harness — user request] relayed:\n  the user asked something')
    + user(FRAME + '\n  ' + long)
    + JSON.stringify({ type: 'attachment', attachment: {} }) + '\n'
    + asst([{ type: 'text', text: 'hi' }])
    + user([{ type: 'tool_result', tool_use_id: 't', content: 'r' }]));
  try {
    const r = readAgentTranscript(f);
    assert.equal(r.prompt, long);
    assert.equal(r.model, 'claude-haiku-4-5');
    assert.deepEqual(r.entries, [{ kind: 'text', text: 'hi' }]);
  } finally { done(); }
});

test('增量读：只解析 offset 之后的整行，半行留到下一拉；文件变短退回整读', () => {
  const head = user('do it') + asst([{ type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } }]);
  const { f, done } = tmpFile(head);
  try {
    const a = readAgentTranscript(f);
    assert.equal(a.delta, false);
    assert.equal(a.offset, Buffer.byteLength(head));
    assert.equal(a.entries.length, 1);

    // 没新内容：零解析
    const same = readAgentTranscript(f, { from: a.offset });
    assert.deepEqual([same.delta, same.entries.length, same.offset], [true, 0, a.offset]);

    // 追加一整行 + 半行（含中文，确认按字节切不会切坏）
    const line2 = asst([{ type: 'text', text: '中文结论' }]);
    const half = asst([{ type: 'text', text: 'tail' }]);
    appendFileSync(f, line2 + half.slice(0, 20));
    const b = readAgentTranscript(f, { from: a.offset });
    assert.equal(b.delta, true);
    assert.equal(b.prompt, '');
    assert.deepEqual(b.entries, [{ kind: 'text', text: '中文结论' }]);
    assert.equal(b.offset, a.offset + Buffer.byteLength(line2));

    appendFileSync(f, half.slice(20));
    const c = readAgentTranscript(f, { from: b.offset });
    assert.deepEqual(c.entries, [{ kind: 'text', text: 'tail' }]);

    // 文件被重写得更短 → from 越界 → 整读
    writeFileSync(f, user('again'));
    const d = readAgentTranscript(f, { from: c.offset });
    assert.equal(d.delta, false);
    assert.equal(d.prompt, 'again');
  } finally { done(); }
});
