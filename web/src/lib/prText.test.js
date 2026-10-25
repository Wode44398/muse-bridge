// 拉取请求的纯函数（prText.js）：「创建拉取请求」可不可点、基线分支、提示词、转录信封识别。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlocker, baseOf, compareUrl, createPrPrompt, syncConflictPrompt, prEnvelope } from './prText.js';

const view = (git) => ({ available: true, prs: [], git: { git: true, github: true, repo: 'o/r', host: 'github.com', branch: 'claude/x', defaultBranch: 'main', dirty: 0, unpushed: 0, ...git } });

test('创建拉取请求：没有改动看相对基线分支——整体推送过、还没开 PR 也能点；老服务端（没有 baseAhead）退回看未推送', () => {
  assert.equal(createBlocker(view({ unpushed: 0, baseAhead: 3, pushed: true })), '', '推送过但相对基线有 3 个提交');
  assert.equal(createBlocker(view({ unpushed: 0, baseAhead: 0 })), 'no_changes');
  assert.equal(createBlocker(view({ unpushed: 0, baseAhead: 0, dirty: 2 })), '');
  assert.equal(createBlocker(view({ unpushed: 2 })), '', '老服务端：有未推送提交');
  assert.equal(createBlocker(view({ unpushed: 0, baseAhead: -1 })), 'no_changes');
  assert.equal(createBlocker(view({ baseAhead: 3 }), true), 'busy');
  assert.equal(createBlocker(view({ onBase: true, baseAhead: 3 })), 'on_base');
  assert.equal(createBlocker(view({ github: false })), 'no_remote');
});

test('基线分支：worktree 切出时的分支优先；提示词与手动创建链接都用它', () => {
  const v = view({ base: 'dev', baseAhead: 1 });
  assert.equal(baseOf(v), 'dev');
  assert.equal(baseOf(view({})), 'main');
  assert.equal(compareUrl(v), 'https://github.com/o/r/compare/dev...claude%2Fx?expand=1');
  const p = createPrPrompt({ repo: 'o/r', branch: 'claude/x', base: baseOf(v) });
  assert.match(p, /基线分支：dev/);
  assert.equal(prEnvelope(p).kind, 'create');
});

test('转录信封：/create-pr 后面追加的会话间消息切进 rest；同步基线冲突折成一行；开启自动修复的说明认得出', () => {
  const create = createPrPrompt({ draft: true, repo: 'o/r', branch: 'b' });
  const tail = '<session-message from="x">别的会话发来的</session-message>';
  const e = prEnvelope(create + '\n\n' + tail);
  assert.deepEqual([e.kind, e.draft, e.rest], ['create', true, tail]);
  assert.ok(!e.raw.includes('session-message'));
  const sync = syncConflictPrompt({ base: 'main', files: ['a.txt', 'b.txt'], total: 3 });
  const s = prEnvelope(sync);
  assert.deepEqual([s.kind, s.base, s.files, s.rest], ['sync', 'main', 3, '']);
  assert.match(s.raw, /`a\.txt`、`b\.txt`/);
  assert.match(s.raw, /共 3 个/);
  const ci = prEnvelope('<ci-monitor-event>「自动修复拉取请求」正在盯 o/r PR #7，发现了下面的情况。</ci-monitor-event>');
  assert.deepEqual([ci.kind, ci.ref, ci.enabled], ['ci', 'o/r PR #7', false]);
  const on = prEnvelope('<ci-monitor-event>「自动修复拉取请求」刚为这个会话打开。现在不用做什么。</ci-monitor-event>');
  assert.deepEqual([on.kind, on.enabled], ['ci', true]);
  assert.equal(prEnvelope('普通的一句话'), null);
});
