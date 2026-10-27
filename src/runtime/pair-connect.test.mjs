// 扫码配对票仓：一次性、过期、作废、撤销、限流、出示方失效、二维码内容与地址选择。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-pairc-'));
process.env.BRIDGE_DATA_ROOT = tmp;
const { createConnectStore, connectUrl, pickOrigin, normCode, fmtCode, pairAudit, readPairAudit, CONNECT_TTL, KEEP_DONE } = await import('./pair-connect.mjs');

function mkStore() {
  let clock = 1_000_000;
  const log = [];
  const s = createConnectStore({ now: () => clock, audit: (e) => log.push(e) });
  let n = 0;
  const issue = (owner) => ({ kind: owner.kind, user: owner.user || null, token: 'tok' + (++n), sessionRef: { kind: owner.kind, n } });
  return { s, log, issue, tick: (ms) => { clock += ms; }, now: () => clock };
}
const ADMIN = { kind: 'admin', gen: 'g1' };
const ALICE = { kind: 'user', user: 'alice' };

test('扫码兑换：一次性，第二次 410；secret 不对 404', () => {
  const { s, issue, log } = mkStore();
  const tk = s.mint(ADMIN, { ip: '1.1.1.1' });
  assert.ok(tk.id && tk.secret && /^\d{8}$/.test(tk.code));
  assert.equal(s.redeem({ id: tk.id, secret: 'wrong' }, { ip: '2.2.2.2', issue }).status, 404);
  const r = s.redeem({ id: tk.id, secret: tk.secret }, { ip: '2.2.2.2', device: 'Android · The Bridge App', issue });
  assert.equal(r.ok, true);
  assert.equal(r.cred.kind, 'admin');
  assert.equal(r.cred.token, 'tok1');
  assert.equal(s.redeem({ id: tk.id, secret: tk.secret }, { ip: '2.2.2.2', issue }).status, 410);
  // 数字码同一张票，也跟着作废
  assert.equal(s.redeem({ code: tk.code }, { ip: '3.3.3.3', issue }).status, 404);
  assert.ok(log.some((e) => e.ev === 'redeem' && e.device === 'Android · The Bridge App'));
  // 审计里没有 secret / 数字码 / 令牌
  const flat = JSON.stringify(log);
  assert.ok(!flat.includes(tk.secret) && !flat.includes(tk.code) && !flat.includes('tok1'));
});

test('数字码兑换：容忍空格；普通账号只换他自己的会话', () => {
  const { s, issue } = mkStore();
  const tk = s.mint(ALICE);
  const r = s.redeem({ code: fmtCode(tk.code) }, { ip: '9.9.9.9', issue });
  assert.equal(r.ok, true);
  assert.deepEqual([r.cred.kind, r.cred.user], ['user', 'alice']);
});

test('3 分钟过期；出示方作废后兑换不了', () => {
  const { s, issue, tick } = mkStore();
  const a = s.mint(ADMIN);
  tick(CONNECT_TTL + 1);
  assert.equal(s.redeem({ id: a.id, secret: a.secret }, { issue }).status, 410);
  const b = s.mint(ADMIN);
  assert.equal(s.cancel(b.id, ALICE), false, '别人作废不了');
  assert.equal(s.cancel(b.id, ADMIN), true);
  assert.equal(s.redeem({ id: b.id, secret: b.secret }, { issue }).status, 410);
});

test('出示方失效（主令牌换了 / 账号停用）：票作废、不发会话', () => {
  const { s, issue } = mkStore();
  const tk = s.mint(ADMIN);
  let issued = 0;
  const r = s.redeem({ id: tk.id, secret: tk.secret }, { validate: (o) => o.gen === 'g2', issue: (o) => { issued++; return issue(o); } });
  assert.equal(r.status, 410);
  assert.equal(issued, 0);
});

test('撤销：兑换后出示方能收回会话，过了保留期就不行', () => {
  const { s, issue, tick } = mkStore();
  const tk = s.mint(ADMIN);
  s.redeem({ id: tk.id, secret: tk.secret }, { issue });
  const revoked = [];
  assert.equal(s.revoke(tk.id, ALICE, (r) => revoked.push(r)), false);
  assert.equal(s.view(tk.id, ADMIN).revocable, true);
  assert.equal(s.revoke(tk.id, ADMIN, (r) => revoked.push(r)), true);
  assert.equal(revoked.length, 1);
  assert.equal(s.view(tk.id, ADMIN).status, 'revoked');
  assert.equal(s.revoke(tk.id, ADMIN, (r) => revoked.push(r)), false, '撤销一次就够了');
  const t2 = s.mint(ADMIN);
  s.redeem({ id: t2.id, secret: t2.secret }, { issue });
  tick(KEEP_DONE + 20_000);
  s.mint(ADMIN);   // 触发清理
  assert.equal(s.revoke(t2.id, ADMIN, () => {}), false);
});

test('同一出示方最多 4 张活票：多了作废最旧的', () => {
  const { s, issue } = mkStore();
  const all = [1, 2, 3, 4, 5].map(() => s.mint(ADMIN));
  assert.equal(s.redeem({ id: all[0].id, secret: all[0].secret }, { issue }).status, 410);
  assert.equal(s.redeem({ id: all[4].id, secret: all[4].secret }, { issue }).ok, true);
});

test('限流：同一 IP 失败 10 次封 15 分钟；数字码全服失败 30 次暂停', () => {
  const { s, issue, tick, log } = mkStore();
  const tk = s.mint(ADMIN);
  for (let i = 0; i < 10; i++) s.redeem({ id: 'nope', secret: 'x' }, { ip: '6.6.6.6', issue });
  assert.equal(s.redeem({ id: tk.id, secret: tk.secret }, { ip: '6.6.6.6', issue }).status, 429, '封了以后连对的也不行');
  assert.ok(log.some((e) => e.ev === 'lock' && e.why === 'ip'));
  tick(15 * 60 * 1000 + 1);
  const t2 = s.mint(ADMIN);
  assert.equal(s.redeem({ id: t2.id, secret: t2.secret }, { ip: '6.6.6.6', issue }).ok, true);

  const t3 = s.mint(ADMIN);
  for (let i = 0; i < 30; i++) s.redeem({ code: '0000000' + (i % 10) }, { ip: '10.0.0.' + i, issue });
  assert.equal(s.redeem({ code: t3.code }, { ip: '7.7.7.7', issue }).status, 429, '数字码暂停');
  assert.equal(s.redeem({ id: t3.id, secret: t3.secret }, { ip: '7.7.7.7', issue }).ok, true, '扫码那条不受影响');
});

test('领票频率：10 分钟 40 张', () => {
  const { s } = mkStore();
  for (let i = 0; i < 40; i++) assert.ok(s.mint(ALICE).id);
  assert.equal(s.mint(ALICE).status, 429);
  assert.ok(s.mint(ADMIN).id, '别人不受影响');
  assert.equal(s.mint({ kind: 'share' }).status, 401);
});

test('长轮询：兑换即醒、拿到设备；不是自己的票回 null', async () => {
  const { s, issue } = mkStore();
  const tk = s.mint(ALICE);
  assert.equal(await s.wait(tk.id, ADMIN), null);
  const w = s.wait(tk.id, ALICE, 'pending', { hold: 5000 });
  s.redeem({ id: tk.id, secret: tk.secret }, { ip: '5.5.5.5', device: 'iPhone · Safari', issue });
  const v = await w;
  assert.equal(v.status, 'redeemed');
  assert.equal(v.device, 'iPhone · Safari');
  assert.equal(v.ip, '5.5.5.5');
});

test('换着 IP 刷错码：失败表有上限，失败审计每分钟最多逐条 30 行、多的补一行计数', () => {
  const { s, issue, tick, log } = mkStore();
  for (let i = 0; i < 2600; i++) s.redeem({ id: 'nope', secret: 'x' }, { ip: '198.51.' + (i >> 8) + '.' + (i & 255), issue });
  assert.ok(s._ipTableSize() <= 2000, '失败表没有无限长：' + s._ipTableSize());
  const fails = log.filter((e) => e.ev === 'fail');
  assert.equal(fails.length, 30, '一分钟里只逐条记 30 行');
  tick(61 * 1000);
  s.redeem({ id: 'nope', secret: 'x' }, { ip: '203.0.113.1', issue });
  const sup = log.find((e) => e.why === 'suppressed');
  assert.ok(sup, '补一行「另有 N 次」');
  assert.equal(sup.n, 2570);
  assert.equal(log.at(-1).ip, '203.0.113.1', '之后照常逐条记');
});

test('长轮询挂到票过期那一刻就醒，回 expired（出码页倒计时到 0 立刻换码）', async () => {
  const { s, tick } = mkStore();
  const tk = s.mint(ADMIN);
  tick(CONNECT_TTL - 100);
  const t0 = Date.now();
  const w = s.wait(tk.id, ADMIN, 'pending', { hold: 20000 });
  tick(200);   // 假时钟走过过期点；真计时器 ~150ms 后醒
  const v = await w;
  assert.equal(v.status, 'expired');
  assert.ok(Date.now() - t0 < 5000, '没有挂满 20 秒');
});

test('数字码规范化', () => {
  assert.equal(normCode('1234 5678'), '12345678');
  assert.equal(normCode('１２３４-５６７８'), '12345678');
  assert.equal(normCode('1234567'), '');
  assert.equal(normCode('abcdefgh'), '');
  assert.equal(fmtCode('12345678'), '1234 5678');
});

test('地址选择：公网 > 出示方页面 > 局域网 > 回环（不可达）', () => {
  assert.deepEqual(pickOrigin({ publicOrigin: 'https://a.trycloudflare.com/', preferred: 'http://192.168.1.5:8787', lan: ['http://192.168.1.5:8787'] }),
    { origin: 'https://a.trycloudflare.com', reachable: true, via: 'public' });
  assert.equal(pickOrigin({ preferred: 'https://my.example.com/app/', lan: ['http://10.0.0.2:8787'] }).origin, 'https://my.example.com');
  assert.equal(pickOrigin({ preferred: 'http://127.0.0.1:8787', lan: ['http://10.0.0.2:8787'] }).origin, 'http://10.0.0.2:8787');
  assert.equal(pickOrigin({ preferred: 'https://appassets.androidplatform.net', lan: [] , fallback: 'http://127.0.0.1:8787' }).reachable, false);
});

test('二维码内容：不含主令牌，局域网候选去掉与 origin 相同的，sid 只认合法格式', () => {
  const u = connectUrl({ origin: 'http://192.168.1.5:8787', id: 'ID', secret: 'SEC', lan: ['http://192.168.1.5:8787', 'http://10.0.0.3:8787'], sid: 'srv_0123456789abcdef0123' });
  assert.equal(u, 'http://192.168.1.5:8787/?connect=ID.SEC&lan=10.0.0.3:8787&sid=srv_0123456789abcdef0123');
  assert.equal(connectUrl({ origin: 'https://x.example', id: 'a', secret: 'b', sid: 'evil&x=1' }), 'https://x.example/?connect=a.b');
});

test('审计落盘与读取（新的在前）', async () => {
  const dir = path.join(tmp, 'audit');
  await pairAudit({ ev: 'mint', by: 'admin' }, dir);
  await pairAudit({ ev: 'redeem', by: 'admin', device: 'X' }, dir);
  const r = await readPairAudit({ dir });
  assert.equal(r.length, 2);
  assert.equal(r[0].ev, 'redeem');
});
