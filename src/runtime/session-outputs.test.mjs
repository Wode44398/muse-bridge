import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { sessionOutputs } from './session-outputs.mjs';

test('输出内容：Write 成功 + 正文链接；Edit、失败的 Write、仓库内源码、.claude/、临时目录不算；最近的在前', async () => {
  const root = mkdtempSync(path.join(os.homedir(), '.so-test-'));
  try {
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(path.join(repo, '.claude'), { recursive: true });
    const other = path.join(root, 'other');
    mkdirSync(other, { recursive: true });
    const files = {
      report: path.join(repo, 'report.md'),        // 仓库内交付类 → 算
      code: path.join(repo, 'app.mjs'),            // 仓库内源码 → 不算
      cfg: path.join(repo, '.claude', 'x.md'),     // .claude/ → 不算
      ext: path.join(other, 'lib.mjs'),            // 会话文件夹外 → 算（官方实际表现）
      failed: path.join(repo, 'fail.md'),          // Write 失败 → 不算
      edited: path.join(repo, 'edited.md'),        // 只被 Edit → 不算
      linked: path.join(repo, 'chart.png'),        // 正文链接 → 算
      gone: path.join(repo, 'gone.md'),            // 写了又删 → 不列
    };
    for (const [k, f] of Object.entries(files)) if (k !== 'gone') writeFileSync(f, 'x');
    const tmp = path.join(os.tmpdir(), 'so-scratch-' + Date.now() + '.md');
    writeFileSync(tmp, 'x');
    const lines = [];
    const tu = (id, name, input) => lines.push({ type: 'assistant', cwd: repo, message: { content: [{ type: 'tool_use', id, name, input }] } });
    const tr = (id, isErr) => lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !!isErr, content: 'ok' }] } });
    tu('1', 'Write', { file_path: files.report }); tr('1');
    tu('2', 'Write', { file_path: files.code }); tr('2');
    tu('3', 'Write', { file_path: files.cfg }); tr('3');
    tu('4', 'Write', { file_path: files.failed }); tr('4', true);
    tu('5', 'Edit', { file_path: files.edited }); tr('5');
    tu('6', 'Write', { file_path: tmp }); tr('6');
    tu('7', 'Write', { file_path: files.gone }); tr('7');
    tu('8', 'Write', { file_path: files.ext }); tr('8');
    lines.push({ type: 'assistant', cwd: repo, message: { content: [{ type: 'text', text: '图在这里：[chart](chart.png)' }] } });
    const tf = path.join(root, 't.jsonl');
    writeFileSync(tf, lines.map((l) => JSON.stringify(l)).join('\n'));
    const out = await sessionOutputs(tf, { cwd: repo, linkRoots: [repo], anywhere: false });
    assert.deepEqual(out.map((o) => o.name), ['chart.png', 'lib.mjs', 'report.md']);
    rmSync(tmp, { force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 10-21 审查：增量缓存把「正文链接的目标当时不存在」定死了——先写出链接、随后才用 Bash 生成文件，中间拉过一次面板，
// 这个文件就再也不出现。现在这类链接每次请求重判，出现了按链接所在的位置补上（与整份重扫一致）。
test('输出内容：正文链接的文件后来才生成也能列出，位置按链接所在处；没生成的、后来是文件夹的不列', async () => {
  const root = mkdtempSync(path.join(os.homedir(), '.so-test-'));
  try {
    const ws = path.join(root, 'ws');
    mkdirSync(ws, { recursive: true });
    const tf = path.join(root, 't.jsonl');
    const rec = (o) => JSON.stringify(o) + '\n';
    const say = (text) => rec({ type: 'assistant', cwd: ws, message: { content: [{ type: 'text', text }] } });
    writeFileSync(path.join(ws, 'report.md'), 'x');
    writeFileSync(tf,
      say('图会生成到 [chart.png](chart.png)，数据见 [data.csv](out/data.csv)，目录 [dir.zip](dir.zip)，从不生成 [never.png](never.png)')
      + rec({ type: 'assistant', cwd: ws, message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: path.join(ws, 'report.md') } }] } })
      + rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] } }));
    const opts = { cwd: path.join(root, 'elsewhere'), linkRoots: [ws], anywhere: false };
    const names = async () => (await sessionOutputs(tf, opts)).map((o) => o.name);

    assert.deepEqual(await names(), ['report.md']);
    // transcript 没变，文件生成了：要出来，且排在后面写的 report.md 之后（链接在前）
    writeFileSync(path.join(ws, 'chart.png'), 'png');
    mkdirSync(path.join(ws, 'dir.zip'));   // 同名的是文件夹：不算
    assert.deepEqual(await names(), ['report.md', 'chart.png']);
    // transcript 又长了：续读新增行之后照样在
    appendFileSync(tf, say('好了'));
    mkdirSync(path.join(ws, 'out'));
    writeFileSync(path.join(ws, 'out', 'data.csv'), 'a,b');
    assert.deepEqual(await names(), ['report.md', 'data.csv', 'chart.png']);
    // 后面又提到 chart.png：按后面那次排到最前
    appendFileSync(tf, say('再看一眼 [chart.png](chart.png)'));
    assert.deepEqual(await names(), ['chart.png', 'report.md', 'data.csv']);
    // 同一时刻的几个请求（各端一起拉）结果一致
    appendFileSync(tf, say('收尾'));
    const all = await Promise.all([names(), names(), names()]);
    for (const r of all) assert.deepEqual(r, ['chart.png', 'report.md', 'data.csv']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
