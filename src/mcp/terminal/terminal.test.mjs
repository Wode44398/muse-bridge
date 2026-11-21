// 共享终端 MCP：读屏拼折行、等待判据、尺寸占用，以及在真 PTY 上跑一遍 run / write / wait / resize。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ansiToLines } from './screen.mjs';
import { toMatcher, screenHints } from './wait.mjs';
import { runTerminalAction } from './actions.mjs';
import * as svc from '../../runtime/claude-term.mjs';

const txt = (r) => r.content.map((c) => c.text).join('\n');

test('读屏把软折行拼回一行，硬换行照旧分开', async () => {
  const lines = await ansiToLines('A'.repeat(30) + 'END\r\nnext', 20, 5);
  assert.deepEqual(lines, ['A'.repeat(30) + 'END', 'next']);
});

test('until：字面按原样匹配，/…/ 按正则', () => {
  assert.ok(toMatcher('a.b').test('xa.b'));
  assert.ok(!toMatcher('a.b').test('axb'));
  const re = toMatcher('/done|ok/i');
  re.lastIndex = 0;
  assert.ok(re.test('All OK'));
  assert.equal(toMatcher(''), null);
});

test('屏幕末尾像等确认 / 像出错时给提示', () => {
  const h = screenHints({ rows: ['build log', 'Do you want to proceed?', '> 1. Yes', '  2. No', ''] });
  assert.match(h.attention, /Yes|proceed/);
  const e = screenHints({ rows: ['connecting…', 'Error: model unavailable (503)'] });
  assert.match(e.error, /unavailable/);
  assert.deepEqual(screenHints({ rows: ['PS C:\\> '] }), { attention: null, error: null });
  // agy 的常驻状态行不是在等确认
  assert.equal(screenHints({ rows: ['> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)'] }).attention, null);
});

// 事件去向：别的 agent 经内部路由调时给 emit，不能落回「admin 最新一轮 Claude」
test('emit 注入：给了就只走它（null = 不发），不给仍按 Claude 的轮发', async () => {
  const fakeTerm = { cols: 100, rows: 30, subs: new Set(), exited: false };
  const fake = {
    getTerm: () => fakeTerm, ensureTerm: () => fakeTerm, termLock: () => null, touchTermLock() {},
    lockTermSize: () => fakeTerm, unlockTermSize: () => false, killTerm() {}, writeTerm() {},
    tapTerm: () => () => {}, snapshotTerm: () => '', serializeTerm: async () => '',
  };
  const seen = [];
  const r = await runTerminalAction({ ws: 'x', svc: fake, emit: (ev) => seen.push(ev) }, { action: 'resize', cols: 120, rows: 40 });
  assert.equal(r.isError, undefined, txt(r));
  assert.deepEqual(seen.map((e) => [e.type, e.action]), [['term', 'resize']]);
  // emit:null：静默（没有当前轮也不报错）
  const r2 = await runTerminalAction({ ws: 'x', svc: fake, emit: null }, { action: 'resize', cols: 120, rows: 40 });
  assert.equal(r2.isError, undefined, txt(r2));
  // 不给 emit：老行为，事件发进 getGen 给的那一轮
  const gen = { events: [], subscribers: new Set() };
  const r3 = await runTerminalAction({ ws: 'x', svc: fake, getGen: () => gen }, { action: 'resize', cols: 120, rows: 40 });
  assert.equal(r3.isError, undefined, txt(r3));
  assert.deepEqual(gen.events.map((e) => [e.type, e.action]), [['term', 'resize']]);
});

// —— 真 PTY ——
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-term-'));
const act = (args) => runTerminalAction({ ws, svc }, args);
after(() => { svc.killTerm(ws); try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* PTY 还占着目录 */ } });

test('真 PTY：run / write+enter / wait / 尺寸占用', { timeout: 90000 }, async () => {
  const r1 = await act({ action: 'run', command: 'echo hello-term', waitSec: 15 });
  assert.match(txt(r1), /hello-term/);

  // wait：开始前屏幕上已有的提示符不算「出现」，安静即返回
  const w0 = await act({ action: 'wait', until: 'hello-term', quietSec: 1, waitSec: 10 });
  assert.match(txt(w0), /秒/);
  assert.doesNotMatch(txt(w0), /出现了目标/);

  // write+enter：正文与回车分开发，回车后报告已提交；之后等到新输出出现
  const cmd = process.platform === 'win32' ? 'Start-Sleep -Milliseconds 1500; echo "DONE-①"' : 'sleep 1.5; echo "DONE-①"';
  const r2 = await act({ action: 'write', text: cmd, enter: true });
  assert.doesNotMatch(txt(r2), /找不到你输入的这些字符/);
  const w1 = await act({ action: 'wait', until: '/DONE-①$/m', quietSec: 0, waitSec: 20 });
  assert.match(txt(w1), /出现了目标：DONE-①/);

  // 尺寸占用：面板的 resize 被忽略并回占用尺寸；交还后面板又能改
  const t = svc.getTerm(ws);
  assert.equal(svc.resizeTerm(ws, 40, 20), true);
  const r3 = await act({ action: 'resize', cols: 120, rows: 30 });
  assert.match(txt(r3), /已占住尺寸 120×30/);
  assert.deepEqual(svc.resizeTerm(ws, 40, 20), { lock: { cols: 120, rows: 30 } });
  assert.equal(t.cols, 120);
  assert.deepEqual(svc.termLock(t), { cols: 120, rows: 30 });
  assert.match(txt(await act({ action: 'status' })), /尺寸由你占用中/);
  assert.match(txt(await act({ action: 'resize', release: true })), /已交还/);
  assert.equal(svc.resizeTerm(ws, 40, 20), true);
  assert.equal(t.cols, 40);
  assert.match(txt(await act({ action: 'status' })), /只有 40 列/);
});
