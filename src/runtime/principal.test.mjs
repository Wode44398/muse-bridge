// 身份抽象层（开源路线第五节，场景三最小预留）的契约：今天的每个判断都与改动前逐字等价，
// 只是收口到一处；预留的组 / 多根 / 属主键在今天的数据上不改变任何结果。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  HOST_OWNER, ownerKey, parseOwnerKey, ownerLabel, groupKey, actorOf, scopeOf, groupsOf, withPrincipal,
  roleOf, can, CAPABILITIES, allowedRoots, fenceViolation, poolRef, refPath, refOwner, poolKey,
  sessionRef, parseSessionRef, normVisibility, validGroupId,
} from './principal.mjs';

test('owner 键：生成与解析互逆；格式与现有的 admin / u: / s: / c: 一致，g: 留给组', () => {
  assert.equal(ownerKey('admin'), 'admin');
  assert.equal(ownerKey('user', 'alice'), 'u:alice');
  assert.equal(ownerKey('share', 'tok'), 's:tok');
  assert.equal(ownerKey('snap', 'tok'), 'c:tok');
  assert.equal(groupKey('team-a'), 'g:team-a');
  for (const k of ['admin', 'u:alice', 's:x_y-z', 'c:AbC', 'g:team-a', 'u:a:b']) {
    const p = parseOwnerKey(k);
    assert.ok(p, k);
    assert.equal(ownerKey(p.kind, p.id), k);
  }
  assert.deepEqual(parseOwnerKey('u:a:b'), { kind: 'user', id: 'a:b' });
  for (const bad of ['', 'u:', 'x:alice', 'alice', 'uu:alice', null, undefined]) assert.equal(parseOwnerKey(bad), null, String(bad));
  assert.throws(() => ownerKey('user', ''));
  assert.throws(() => ownerKey('robot', 'x'));
});

test('ownerLabel 与各处以前手写的 key === admin ? admin : key.slice(2) 逐字一致', () => {
  const old = (k) => (k === 'admin' ? 'admin' : k.slice(2));
  for (const k of ['admin', 'u:alice', 'c:token', 's:t', 'g:x', 'weird', 'u:', '']) assert.equal(ownerLabel(k), old(k), k);
});

test('actor / scope / groups：老 ctx 回落到 key；withPrincipal 补字段，代聊时 actor 与 scope 分开', () => {
  assert.equal(actorOf({ key: 'u:a' }), 'u:a');
  assert.equal(scopeOf({ key: 'u:a' }), 'u:a');
  assert.deepEqual(groupsOf({ key: 'u:a' }), []);
  assert.equal(actorOf(null), '');
  const own = withPrincipal({ kind: 'user', key: 'u:a' }, { kind: 'user', user: 'a' });
  assert.equal(own.actor, 'u:a');
  assert.equal(own.scope, 'u:a');
  assert.deepEqual(own.groups, []);
  assert.ok(Object.isFrozen(own.groups), '组今天恒为空且不可被就地改');
  const asAdmin = withPrincipal({ kind: 'user', key: 'u:a' }, { kind: 'user', user: 'a', actor: HOST_OWNER });
  assert.equal(asAdmin.actor, 'admin');
  assert.equal(asAdmin.scope, 'u:a', '代聊：数据与记账仍归被代的人');
  assert.equal(scopeOf(asAdmin), 'u:a');
  assert.equal(withPrincipal(null, {}), null);
});

test('能力：今天与以前的 kind / shell 判断逐项等价；未知能力一律拒；角色不参与（手改 role 不会提权）', () => {
  const admin = { kind: 'admin', shell: true };
  const pro = { kind: 'user', shell: true, role: 'admin' };
  const regular = { kind: 'user', shell: false };
  const snap = { kind: 'snap', shell: false };
  const share = { kind: 'share', shell: false };
  for (const cap of CAPABILITIES) {
    if (cap === 'workspace.shell') continue;
    assert.equal(can(admin, cap), true, cap);
    for (const c of [pro, regular, snap, share]) assert.equal(can(c, cap), false, `${c.kind} ${cap}`);
  }
  assert.equal(can(admin, 'workspace.shell'), true);
  assert.equal(can(pro, 'workspace.shell'), true);
  assert.equal(can(regular, 'workspace.shell'), false);
  assert.equal(can(admin, 'no.such.cap'), false);
  assert.equal(can(null, 'server.manage'), false);
  assert.equal(roleOf(admin), 'owner');
  assert.equal(roleOf(pro), 'member', 'users.json 里的 role 今天不读');
  assert.equal(roleOf(snap), 'guest');
});

test('allowedRoots：主机不设边界；沙箱身份今天只有 [ctx.cwd]', () => {
  assert.equal(allowedRoots({ kind: 'admin', cwd: '/vault' }), null);
  assert.deepEqual(allowedRoots({ kind: 'user', cwd: '/u/a' }), ['/u/a']);
  assert.deepEqual(allowedRoots({ kind: 'snap', cwd: '/snap/x' }), ['/snap/x']);
  assert.deepEqual(allowedRoots({ kind: 'user' }), []);
  assert.deepEqual(allowedRoots(null), []);
});

test('fenceViolation：单根时结果与直接判单根逐字一致；多根任一放行即放行；都拒回第一个原因', () => {
  const check = (root) => (p) => (root && p.startsWith(root + '/') ? null : `出界:${root}`);
  for (const p of ['/u/a/x', '/u/b/x', '/etc/passwd']) {
    assert.equal(fenceViolation(['/u/a'], (r) => check(r)(p)), check('/u/a')(p), p);
  }
  assert.equal(fenceViolation(['/u/a', '/g/team'], (r) => check(r)('/g/team/doc')), null);
  assert.equal(fenceViolation(['/u/a', '/g/team'], (r) => check(r)('/u/b/doc')), '出界:/u/a');
  assert.equal(fenceViolation(null, () => '不该被调用'), null, '主机不设边界');
  // 空根（没有 cwd 的异常 ctx）：交给 check(undefined)，与以前把 ctx.cwd=undefined 直接传进去一致
  let seen = 'unset';
  assert.equal(fenceViolation([], (r) => { seen = r; return '拒'; }), '拒');
  assert.equal(seen, undefined);
});

test('池键：主机与只给路径的老调用方 = 以前的「只按路径」；其他身份带属主前缀，互不相撞', () => {
  const fold = (p) => path.resolve(p).toLowerCase();
  const ws = path.resolve('/data/shared');
  assert.equal(poolKey(ws, fold), fold(ws), '老调用方（Codex 通道等）键不变');
  assert.equal(poolKey(poolRef('admin', ws), fold), fold(ws), '主机身份键不变');
  assert.equal(poolKey(poolRef({ kind: 'admin', key: 'admin' }, ws), fold), fold(ws));
  const a = poolKey(poolRef({ key: 'u:alice' }, ws), fold);
  const b = poolKey(poolRef({ key: 'u:bob' }, ws), fold);
  assert.notEqual(a, b, '两个人进同一个目录拿到两份');
  assert.notEqual(a, fold(ws));
  assert.equal(poolKey(poolRef({ key: 'u:alice' }, ws.toUpperCase()), fold), a, '同一个人同一个目录仍是同一份（路径照旧规范化）');
  // 代聊：池子跟 scope（被代的人）走，不跟 actor
  const proxied = withPrincipal({ kind: 'user', key: 'u:alice' }, { actor: 'admin' });
  assert.equal(poolKey(poolRef(proxied, ws), fold), a);
  assert.equal(refPath(ws), ws);
  assert.equal(refOwner(ws), '');
  assert.equal(refPath(poolRef('u:x', ws)), ws);
});

test('会话引用（属主, sessionId）与可见性：老数据的裸 id 按存放处补属主；可见性认不出一律 private', () => {
  const sid = 'aaaaaaaa-1111-2222-3333-444444444444';
  assert.deepEqual(sessionRef('u:a', sid), { owner: 'u:a', sessionId: sid });
  assert.deepEqual(parseSessionRef(sid, 'u:a'), { owner: 'u:a', sessionId: sid });
  assert.deepEqual(parseSessionRef({ owner: 'u:b', sessionId: sid }, 'u:a'), { owner: 'u:b', sessionId: sid });
  assert.deepEqual(parseSessionRef({ sessionId: sid }, 'u:a'), { owner: 'u:a', sessionId: sid });
  assert.equal(parseSessionRef('', 'u:a'), null);
  assert.equal(parseSessionRef({}, 'u:a'), null);
  assert.equal(normVisibility(undefined), 'private');
  assert.equal(normVisibility('public'), 'private');
  assert.equal(normVisibility('org'), 'org');
  assert.equal(validGroupId('team-a'), true);
  assert.equal(validGroupId('_system'), false);
  assert.equal(validGroupId('../x'), false);
});
