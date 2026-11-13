// 子 agent 调用策略的数据层（runtime/dispatch-policy.mjs）：迁移（旧备注 subagentDispatch）、只读默认与 403、
// 总开关 / 范围 / 生效策略的补丁校验、策略的新建 / 复制 / 修改 / 删除与各项上限、rev 与变更通知、
// owner → 身份的登记、按 mtime 重读、写失败抛出来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-dispatch-policy-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const D = await import('./dispatch-policy.mjs');
const CS = await import('./claude-settings.mjs');
const { ROOT } = await import('../config/index.mjs');
const { HOST_OWNER } = await import('./principal.mjs');

let n = 0;
// 每条用例一个独立的数据目录
const dir = () => { const d = path.join(tmp, 'd' + (++n)); mkdirSync(d, { recursive: true }); return d; };
const admin = (dataDir = dir()) => ({ kind: 'admin', shell: true, dataDir, key: 'admin' });
const member = (dataDir = dir(), shell = true) => ({ kind: 'user', key: 'u:' + n, shell, dataDir });
const fileOf = (ctx) => path.join(ctx.dataDir, 'dispatch-policy.json');
const status = (code, re) => (e) => { assert.equal(e.status, code, e.message); if (re) assert.match(e.message, re); return true; };

test('迁移：旧设置里有 subagentDispatch → 第一次读就落盘一套「默认」，备注就是旧值', () => {
  D._resetPolicyForTests();
  const ctx = admin();
  writeFileSync(path.join(ctx.dataDir, 'claude-settings.json'), JSON.stringify({ values: { subagentDispatch: '  轻活一律给 haiku\n别派 opus  ', other: 1 } }));
  const p = D.policyFor(ctx);
  assert.deepEqual([p.v, p.enabled, p.allowThirdParty, p.rev, p.activeId], [1, true, true, 0, 's-00000000']);
  assert.deepEqual(p.scope, { workflow: true, subagent: true, session: false });
  assert.equal(p.strategies.length, 1);
  const s = p.strategies[0];
  assert.deepEqual([s.id, s.name, s.note], ['s-00000000', '默认', '轻活一律给 haiku\n别派 opus']);
  assert.deepEqual(s.floors, { top: null, hard: null, normal: null, light: null });
  assert.deepEqual(s.overrides, { top: null, hard: null, normal: null, light: null });
  assert.ok(existsSync(fileOf(ctx)));                                   // 旧值非空：第一次读就落盘（设置写回会冲掉旧键）
  assert.equal(JSON.parse(readFileSync(fileOf(ctx), 'utf8')).strategies[0].note, '轻活一律给 haiku\n别派 opus');
  // 落盘之后旧设置再变也不影响（迁移只做一次）
  writeFileSync(path.join(ctx.dataDir, 'claude-settings.json'), JSON.stringify({ values: { subagentDispatch: '新的' } }));
  D._resetPolicyForTests();
  assert.equal(D.policyFor(ctx).strategies[0].note, '轻活一律给 haiku\n别派 opus');
  assert.deepEqual(D.activeStrategy(D.policyFor(ctx)).id, 's-00000000');
});

// 迁移之前先写了一次别的 Claude 设置（老 apk / agent 接口 settings.claude_set / 拖压缩点）：旧备注不能被设置写回冲掉
function legacySurvivesSettingsWrite(ctx, { migrates }) {
  const sf = path.join(ctx.dataDir, 'claude-settings.json');
  const OLD = '轻活一律给 haiku\n别派 opus';
  rmSync(fileOf(ctx), { force: true });
  writeFileSync(sf, JSON.stringify({ rev: 3, values: { subagentDispatch: OLD, inlineVisualizations: false } }));
  CS._resetClaudeSettingsCache();
  D._resetPolicyForTests();
  try {
    assert.equal(CS.setClaudeSettings(ctx, { promptSuggestions: false }).changed, true);   // 第一次写：冷读盘
    let disk = JSON.parse(readFileSync(sf, 'utf8'));
    assert.deepEqual(disk, { rev: 4, values: { subagentDispatch: OLD, inlineVisualizations: false, promptSuggestions: false } });
    assert.equal(CS.setClaudeSettings(ctx, { promptSuggestions: null }).changed, true);    // 第二次写：走缓存
    disk = JSON.parse(readFileSync(sf, 'utf8'));
    assert.deepEqual(disk, { rev: 5, values: { subagentDispatch: OLD, inlineVisualizations: false } });
    assert.equal('subagentDispatch' in CS.getClaudeSettings(ctx), false);                 // 读侧照旧不认这个键
    assert.equal(existsSync(fileOf(ctx)), false);                                         // 还没迁
    const p = D.policyFor(ctx);
    if (migrates) {
      assert.equal(p.strategies[0].note, OLD);
      assert.equal(JSON.parse(readFileSync(fileOf(ctx), 'utf8')).strategies[0].note, OLD);
    } else {
      assert.deepEqual([p.enabled, p.strategies[0].note, existsSync(fileOf(ctx))], [false, '', false]);   // 没权限：不迁，但盘上的旧值留着
    }
  } finally {
    CS._resetClaudeSettingsCache();
    D._resetPolicyForTests();
  }
}

test('迁移窗口（管理员，数据根）：迁移前任何 Claude 设置写入都带回 subagentDispatch，之后第一次读策略照样迁成备注', () => {
  const host = { kind: 'admin', shell: true, dataDir: ROOT, key: 'admin' };
  try { legacySurvivesSettingsWrite(host, { migrates: true }); } finally {
    rmSync(fileOf(host), { force: true });
    rmSync(path.join(ROOT, 'claude-settings.json'), { force: true });
  }
});

test('迁移窗口（成员，自己的 dataDir）：有命令行的照样迁；没命令行的不迁，但设置写入也不抹掉盘上的旧值', () => {
  legacySurvivesSettingsWrite(member(), { migrates: true });
  legacySurvivesSettingsWrite(member(dir(), false), { migrates: false });
});

test('迁移：没有旧备注 → 只在内存里造，第一次写才落盘；policyFor 回的是副本', () => {
  D._resetPolicyForTests();
  const ctx = admin();
  const p = D.policyFor(ctx);
  assert.equal(p.strategies[0].note, '');
  assert.equal(existsSync(fileOf(ctx)), false);
  p.enabled = false; p.strategies.length = 0;                          // 改副本不影响缓存
  assert.equal(D.policyFor(ctx).enabled, true);
  assert.equal(D.policyFor(ctx).strategies.length, 1);
  assert.equal(existsSync(fileOf(ctx)), false);
  const q = D.updatePolicy(ctx, { enabled: false });
  assert.deepEqual([q.enabled, q.rev], [false, 1]);
  assert.ok(existsSync(fileOf(ctx)));
  assert.equal(JSON.parse(readFileSync(fileOf(ctx), 'utf8')).rev, 1);
});

test('权限：没命令行的成员 / 快照访客 / 分享 / 没 dataDir → 只读默认（enabled:false），写一律 403、不落盘', () => {
  D._resetPolicyForTests();
  const plain = member(dir(), false);
  writeFileSync(path.join(plain.dataDir, 'claude-settings.json'), JSON.stringify({ values: { subagentDispatch: '有旧值也不迁' } }));
  const snap = { kind: 'snap', shell: false, snap: { token: 't' }, dataDir: dir() };
  const share = { kind: 'share', shell: false, dataDir: dir() };
  for (const ctx of [plain, snap, share, { kind: 'admin', shell: true }, null, undefined]) {
    assert.equal(D.canEditPolicy(ctx), false);
    const p = D.policyFor(ctx);
    assert.equal(p.enabled, false);
    assert.equal(p.strategies.length, 1);
    assert.equal(p.strategies[0].note, '');
    assert.throws(() => D.updatePolicy(ctx, { enabled: true }), status(403, /不能修改/));
    assert.throws(() => D.saveStrategy(ctx, { name: 'x' }), status(403));
    assert.throws(() => D.deleteStrategy(ctx, 's-00000000'), status(403));
  }
  for (const ctx of [plain, snap, share]) assert.equal(existsSync(fileOf(ctx)), false);
  assert.equal(D.canEditPolicy(member()), true);                       // 有命令行的成员可以写
  assert.equal(D.canEditPolicy({ kind: 'admin', shell: false, dataDir: dir() }), true);
});

test('updatePolicy：不认识的字段 / 类型不对 → 400；范围按键合并；activeId 不存在 → 404；没变化不写不加 rev', () => {
  D._resetPolicyForTests();
  const ctx = admin();
  const bad = [
    [{ foo: 1 }, /不认识的字段/], [{ strategies: [] }, /不认识的字段/], [{ enabled: 'yes' }, /enabled/],
    [{ allowThirdParty: 1 }, /allowThirdParty/], [{ scope: [] }, /scope/], [{ scope: { chat: true } }, /生效范围里没有/],
    [{ scope: { session: 1 } }, /生效范围「session」/], [{ activeId: 3 }, /activeId/], [null, /patch/], ['x', /patch/],
  ];
  for (const [patch, re] of bad) assert.throws(() => D.updatePolicy(ctx, patch), status(400, re));
  assert.throws(() => D.updatePolicy(ctx, { activeId: 's-12345678' }), status(404, /没有这套策略/));
  assert.equal(existsSync(fileOf(ctx)), false);                         // 校验失败不落盘

  const seen = [];
  const off = D.onPolicyChange((c, p) => seen.push([c, p.rev]));
  try {
    const p1 = D.updatePolicy(ctx, { scope: { session: true } });
    assert.deepEqual(p1.scope, { workflow: true, subagent: true, session: true });
    assert.equal(p1.rev, 1);
    const p2 = D.updatePolicy(ctx, { scope: { workflow: false }, allowThirdParty: false });
    assert.deepEqual(p2.scope, { workflow: false, subagent: true, session: true });
    assert.deepEqual([p2.allowThirdParty, p2.rev], [false, 2]);
    const p3 = D.updatePolicy(ctx, { scope: { workflow: false }, enabled: true });   // 都是原值
    assert.equal(p3.rev, 2);
    assert.equal(JSON.parse(readFileSync(fileOf(ctx), 'utf8')).rev, 2);
    assert.deepEqual(seen.map((x) => x[1]), [1, 2]);
    assert.equal(seen[0][0], ctx);
  } finally { off(); }
  D.updatePolicy(ctx, { enabled: false });
  assert.equal(seen.length, 2);                                         // 取消订阅后不再收到
});

test('updatePolicy：scope 键名按自有属性认——constructor / toString / hasOwnProperty / __proto__ 一律 400，不加 rev、不落垃圾键', () => {
  D._resetPolicyForTests();
  const ctx = admin();
  const p0 = D.updatePolicy(ctx, { scope: { session: true } });
  const disk0 = readFileSync(fileOf(ctx), 'utf8');
  const bad = [{ constructor: true }, { toString: true }, { hasOwnProperty: true }, { valueOf: false }, JSON.parse('{"__proto__":true}'),
    { session: false, constructor: true }];
  for (const scope of bad) assert.throws(() => D.updatePolicy(ctx, { scope }), status(400, /生效范围里没有/));
  const p = D.policyFor(ctx);
  assert.equal(p.rev, p0.rev);
  assert.deepEqual(Object.keys(p.scope).sort(), ['session', 'subagent', 'workflow']);
  assert.equal(p.scope.session, true);                                  // 混着坏键的那次整个不生效
  assert.equal(readFileSync(fileOf(ctx), 'utf8'), disk0);
});

test('saveStrategy：新建空白 / 复制 / 按字段改（floors、overrides 按档合并），没变化不加 rev', () => {
  D._resetPolicyForTests();
  const ctx = admin();
  const r1 = D.saveStrategy(ctx, { floors: { top: 50.26 }, overrides: { light: { model: 'haiku', effort: 'low' } } });
  assert.match(r1.strategy.id, /^s-[0-9a-f]{8}$/);
  assert.equal(r1.strategy.name, '新策略');
  assert.deepEqual(r1.strategy.floors, { top: 50.3, hard: null, normal: null, light: null });   // 一位小数
  assert.deepEqual(r1.strategy.overrides.light, { model: 'haiku', effort: 'low' });
  assert.equal(r1.policy.rev, 1);
  assert.equal(r1.policy.strategies.length, 2);
  assert.equal(r1.policy.activeId, 's-00000000');                      // 新建不改生效的那套
  assert.ok(r1.strategy.createdAt > 0 && r1.strategy.updatedAt === r1.strategy.createdAt);

  const r2 = D.saveStrategy(ctx, { copyOf: r1.strategy.id });
  assert.equal(r2.strategy.name, '新策略 副本');
  assert.notEqual(r2.strategy.id, r1.strategy.id);
  assert.deepEqual(r2.strategy.floors, r1.strategy.floors);
  assert.deepEqual(r2.strategy.overrides, r1.strategy.overrides);
  const r3 = D.saveStrategy(ctx, { name: '  省钱  ' }, { copyOf: 's-00000000' });
  assert.equal(r3.strategy.name, '省钱');                               // 去首尾空白；复制时给了名字就用它

  const r4 = D.saveStrategy(ctx, { id: r1.strategy.id, floors: { hard: 40, top: null }, overrides: { top: { model: 'custom:p-1a2b3c4d:kimi-k3', effort: '' } } });
  assert.deepEqual(r4.strategy.floors, { top: null, hard: 40, normal: null, light: null });
  assert.deepEqual(r4.strategy.overrides.light, { model: 'haiku', effort: 'low' });   // 没给的档不动
  assert.deepEqual(r4.strategy.overrides.top, { model: 'custom:p-1a2b3c4d:kimi-k3', effort: '' });
  assert.equal(r4.strategy.createdAt, r1.strategy.createdAt);
  assert.equal(r4.policy.rev, 4);
  const r5 = D.saveStrategy(ctx, { id: r1.strategy.id, floors: { hard: 40 }, overrides: { top: { model: 'custom:p-1a2b3c4d:kimi-k3' } } });
  assert.equal(r5.policy.rev, 4);                                       // 什么都没改
  assert.equal(r5.strategy.id, r1.strategy.id);
  const r6 = D.saveStrategy(ctx, { id: r1.strategy.id, overrides: { light: null, top: { model: '' } }, note: '多用 sonnet' });
  assert.deepEqual(r6.strategy.overrides, { top: null, hard: null, normal: null, light: null });
  assert.equal(r6.strategy.note, '多用 sonnet');
  assert.equal(r6.policy.rev, 5);
  const r7 = D.saveStrategy(ctx, { id: r3.strategy.id, name: '新策略' });   // 重名允许
  assert.equal(r7.strategy.name, '新策略');
  assert.equal(JSON.parse(readFileSync(fileOf(ctx), 'utf8')).rev, 6);
});

test('saveStrategy 校验：判定线单调、范围、档名、模型写法、推理强度、名字与备注长度、id / copyOf 不存在', () => {
  D._resetPolicyForTests();
  const ctx = admin();
  const id = D.saveStrategy(ctx, { floors: { top: 60, hard: 50, normal: 30, light: 20 } }).strategy.id;
  const bad = [
    [{ id, floors: { hard: 61 } }, /判定线要从高到低：「top」60 不能低于「hard」61/],
    [{ id, floors: { top: null, hard: 50, normal: 55 } }, /从高到低/],    // null 跳过，有值的照样比
    [{ id, floors: { light: 31 } }, /从高到低/],
    [{ id, floors: { top: 101 } }, /0–100/], [{ id, floors: { top: -1 } }, /0–100/], [{ id, floors: { top: '50' } }, /0–100/],
    [{ id, floors: { max: 50 } }, /没有「max」这一档/], [{ id, floors: [50] }, /形状/],
    [{ id, overrides: { top: { model: 'gpt-6' } } }, /写法不对/],
    [{ id, overrides: { top: { model: 'custom:p-xyz:m' } } }, /写法不对/],
    [{ id, overrides: { top: { model: 'opus', effort: 'BAD!' } } }, /推理强度/],
    [{ id, overrides: { top: { model: 'opus', effort: 3 } } }, /推理强度/],
    [{ id, overrides: { top: 'opus' } }, /model, effort/],
    [{ id, name: '   ' }, /不能为空/], [{ id, name: 'あ'.repeat(25) }, /最多 24 个字/], [{ id, name: 3 }, /字符串/],
    [{ id, note: 'x'.repeat(2001) }, /最多 2000 字/], [{ id, note: 1 }, /字符串/],
    [{ id: 5 }, /id/], [{ copyOf: 5 }, /copyOf/], ['x', /strategy/],
  ];
  const rev = D.policyFor(ctx).rev;
  for (const [s, re] of bad) assert.throws(() => D.saveStrategy(ctx, s), status(400, re), JSON.stringify(s).slice(0, 80));
  assert.throws(() => D.saveStrategy(ctx, { id: 's-ffffffff', name: 'x' }), status(404, /没有这套策略/));
  assert.throws(() => D.saveStrategy(ctx, {}, { copyOf: 's-ffffffff' }), status(404, /要复制的那套策略不存在/));
  assert.throws(() => D.saveStrategy(ctx, { floors: { hard: 70, top: 60 } }), status(400, /从高到低/));   // 新建也校验
  assert.equal(D.policyFor(ctx).rev, rev);                              // 全部没落盘
  assert.equal(D.policyFor(ctx).strategies.length, 2);
  // 边界值可以
  const ok = D.saveStrategy(ctx, { id, name: 'あ'.repeat(24), note: 'x'.repeat(2000), floors: { top: 100, hard: 100, normal: 0, light: 0 }, overrides: { hard: { model: 'fable', effort: 'xhigh' } } });
  assert.equal([...ok.strategy.name].length, 24);
  assert.equal(ok.strategy.note.length, 2000);
  assert.deepEqual(ok.strategy.floors, { top: 100, hard: 100, normal: 0, light: 0 });
});

test('上限 12 套；删除：生效中的 → 400，不存在 → 404，切换后才能删', () => {
  D._resetPolicyForTests();
  const ctx = admin();
  for (let i = 0; i < 11; i++) D.saveStrategy(ctx, { name: '第' + i + '套' });
  assert.equal(D.policyFor(ctx).strategies.length, 12);
  assert.throws(() => D.saveStrategy(ctx, { name: '第 13 套' }), status(400, /最多 12 套/));
  assert.throws(() => D.saveStrategy(ctx, {}, { copyOf: 's-00000000' }), status(400, /最多 12 套/));
  assert.throws(() => D.deleteStrategy(ctx, 's-00000000'), status(400, /生效中的策略不能删/));
  assert.throws(() => D.deleteStrategy(ctx, 's-ffffffff'), status(404));
  assert.throws(() => D.deleteStrategy(ctx, ''), status(400));
  const other = D.policyFor(ctx).strategies[3].id;
  const p1 = D.updatePolicy(ctx, { activeId: other });
  assert.equal(D.activeStrategy(p1).id, other);
  const p2 = D.deleteStrategy(ctx, 's-00000000');
  assert.equal(p2.strategies.length, 11);
  assert.ok(!p2.strategies.some((s) => s.id === 's-00000000'));
  assert.equal(p2.rev, p1.rev + 1);
  assert.equal(D.saveStrategy(ctx, { name: '又能建了' }).policy.strategies.length, 12);
});

test('owner 登记：主机没登记过读数据根；成员没登记过 → null；登记后按它的身份（没权限的 = 只读默认）', () => {
  D._resetPolicyForTests();
  assert.equal(D.policyOfOwner(''), null);
  assert.equal(D.policyOfOwner('u:nobody'), null);
  const host = { kind: 'admin', shell: true, dataDir: ROOT, key: 'admin' };
  D.updatePolicy(host, { allowThirdParty: false });
  assert.equal(D.policyOfOwner(HOST_OWNER).allowThirdParty, false);    // 没登记也读数据根
  const m = member();
  D.updatePolicy(m, { scope: { session: true } });
  assert.equal(D.policyOfOwner(m.key), null);
  D.notePolicyOwner(m.key, m);
  assert.equal(D.policyOfOwner(m.key).scope.session, true);
  D.notePolicyOwner(m.key, { ...m, shell: false });                    // 降权后再登记：只读默认
  assert.equal(D.policyOfOwner(m.key).enabled, false);
  D.notePolicyOwner('u:x', null); D.notePolicyOwner('', m); D.notePolicyOwner('u:y', { kind: 'user' });   // 不合规的登记忽略
  assert.equal(D.policyOfOwner('u:x'), null);
  assert.equal(D.policyOfOwner('u:y'), null);
});

test('按 mtime 重读：文件被外部改了照新的来；坏文件 → 默认且不覆盖；存盘内容宽松规范化', () => {
  D._resetPolicyForTests();
  const ctx = admin();
  D.updatePolicy(ctx, { enabled: false });
  assert.equal(D.policyFor(ctx).enabled, false);
  const raw = {
    v: 1, enabled: true, scope: { workflow: false, chat: true }, activeId: 's-gone',
    strategies: [
      { id: 'bad-id', name: 'x' },
      { id: 's-aaaaaaaa', name: '  手 写  ', floors: { top: 'x', hard: 40.04, normal: 120 }, overrides: { top: { model: 'gpt' }, hard: { model: 'opus', effort: 'BAD!' } } },
      { id: 's-aaaaaaaa', name: '重复的 id' },
      { id: 's-bbbbbbbb' },
    ],
    rev: 9,
  };
  writeFileSync(fileOf(ctx), JSON.stringify(raw));
  const t = Date.now() / 1000 + 5; utimesSync(fileOf(ctx), t, t);
  const p = D.policyFor(ctx);
  assert.deepEqual([p.enabled, p.rev, p.activeId, p.allowThirdParty], [true, 9, 's-aaaaaaaa', true]);   // activeId 对不上 → 第一套
  assert.deepEqual(p.scope, { workflow: false, subagent: true, session: false });
  assert.deepEqual(p.strategies.map((s) => [s.id, s.name]), [['s-aaaaaaaa', '手 写'], ['s-bbbbbbbb', '默认']]);
  assert.deepEqual(p.strategies[0].floors, { top: null, hard: 40, normal: null, light: null });
  assert.deepEqual(p.strategies[0].overrides, { top: null, hard: { model: 'opus', effort: '' }, normal: null, light: null });
  assert.equal(D.updatePolicy(ctx, { enabled: false }).rev, 10);        // 接着外部的 rev 往上加

  writeFileSync(fileOf(ctx), '{ 坏了');
  const t2 = Date.now() / 1000 + 10; utimesSync(fileOf(ctx), t2, t2);
  const q = D.policyFor(ctx);
  assert.deepEqual([q.enabled, q.rev, q.strategies[0].id], [true, 0, 's-00000000']);
  assert.equal(readFileSync(fileOf(ctx), 'utf8'), '{ 坏了');             // 读的时候不覆盖
});

test('写失败要抛出来：数据目录是个文件 → 500，缓存不变', () => {
  D._resetPolicyForTests();
  const f = path.join(dir(), 'not-a-dir');
  writeFileSync(f, 'x');
  const ctx = admin(f);
  const err = console.error; console.error = () => {};                 // jsonfile 的失败日志不打到测试输出
  try {
    assert.throws(() => D.updatePolicy(ctx, { enabled: false }), status(500, /没能写进磁盘/));
    assert.throws(() => D.saveStrategy(ctx, { name: 'x' }), status(500));
  } finally { console.error = err; }
  const p = D.policyFor(ctx);
  assert.deepEqual([p.enabled, p.rev, p.strategies.length], [true, 0, 1]);
});

test('sanitizeStrategy / activeStrategy：预览用的宽松规范化不抛；生效策略对不上取第一套', () => {
  const s = D.sanitizeStrategy({ id: 'x', name: '', floors: { top: 55.55, hard: 'a' }, overrides: { normal: { model: 'sonnet', effort: 'high' }, light: { model: 'nope' } }, note: 5 });
  assert.equal(s.id, 'draft');
  assert.equal(s.name, '默认');
  assert.deepEqual(s.floors, { top: 55.6, hard: null, normal: null, light: null });
  assert.deepEqual(s.overrides, { top: null, hard: null, normal: { model: 'sonnet', effort: 'high' }, light: null });
  assert.equal(s.note, '');
  assert.deepEqual(D.sanitizeStrategy(null).floors, { top: null, hard: null, normal: null, light: null });
  assert.equal(D.activeStrategy({ activeId: 'zz', strategies: [{ id: 'a' }, { id: 'b' }] }).id, 'a');
  assert.equal(D.activeStrategy({ activeId: 'b', strategies: [{ id: 'a' }, { id: 'b' }] }).id, 'b');
  assert.equal(D.activeStrategy(null), null);
  assert.deepEqual(D.TIER_KEYS, ['top', 'hard', 'normal', 'light']);
});
