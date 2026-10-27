// claude-bridge 反馈收件箱（/v1/cb/*）：内存 KV（带 list / delete / 过期时间记录），不联网、不碰 GitHub。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/worker.mjs';
import { cleanCbReport, CB_MAX_IMAGE_BYTES } from '../../deploy/muse/feedback/cb-schema.mjs';

function memKV() {
  const m = new Map();
  const ttl = new Map();
  const kv = {
    m, ttl, writes: 0,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v, o = {}) => { kv.writes++; m.set(k, String(v)); if (o.expirationTtl) ttl.set(k, o.expirationTtl); },
    delete: async (k) => { m.delete(k); ttl.delete(k); },
    list: async ({ prefix = '', limit = 1000 } = {}) => {
      const names = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { keys: names.slice(0, limit).map((name) => ({ name })), list_complete: names.length <= limit };
    },
  };
  return kv;
}

const TOKEN = 'test-inbox-token-0123456789';
// GitHub 一调就算失败：这条路不该碰 GitHub
const noGitHub = async () => { throw new Error('github must not be called'); };
const env = (kv, extra = {}) => ({ FEEDBACK_KV: kv, INBOX_TOKEN: TOKEN, ...extra });
const post = (path, body, headers = {}) => new Request('https://w.test' + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (path, headers = {}) => new Request('https://w.test' + path, { headers });
const auth = { Authorization: `Bearer ${TOKEN}` };

// 最小的合法 PNG 文件头 + 填充；以及一个伪装成 png 的 exe
const png = (extra = 16) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 1)]).toString('base64');
const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]).toString('base64');
const exe = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(30, 0)]).toString('base64');
const base = (o = {}) => ({
  install: 'cb-install-aaaa-1111', text: '设置页切换主题会闪一下', screen: 'settings-desktop',
  version: '6.51 (464)', platform: 'linux', arch: 'x64', node: 'v24.22.1', os: 'Linux 6.8.0', role: 'user', ...o,
});

test('收件箱没配（无 INBOX_TOKEN）：收件接口 404，推送 503（对方留着补发）', async () => {
  const handle = createHandler({ fetch: noGitHub });
  const e = { FEEDBACK_KV: memKV() };
  assert.equal((await handle(get('/v1/cb/inbox', auth), e)).status, 404);
  assert.equal((await handle(post('/v1/cb/inbox/ack', { ids: [] }, auth), e)).status, 404);
  assert.equal((await handle(post('/v1/cb/report', base()), e)).status, 503);
});

test('推送 → 白名单 + 脱敏后进 KV（30 天过期），不碰 GitHub；令牌不对 401；取件、确认后清掉', async () => {
  const kv = memKV();
  const handle = createHandler({ fetch: noGitHub, now: () => 1_792_000_000_000 });
  const r = await handle(post('/v1/cb/report', base({
    text: '我的 key sk-ant-api03-ABCDEFGHIJKLMNOPQRST123 用不了，路径 C:\\Users\\张三\\x.txt',
    user: '张三', host: 'my-box.example.com', chats: ['不该出现'],
    attachments: [{ name: '身份证.png', type: 'image/png', data: png() }, { name: 'a.png', type: 'image/png', data: exe() }],
  })), env(kv));
  assert.equal(r.status, 200);
  const { id } = await r.json();
  assert.match(id, /^\d{13}-[0-9a-f]{8}$/);
  assert.equal(kv.ttl.get(`cbi:${id}`), 30 * 86400);

  assert.equal((await handle(get('/v1/cb/inbox'), env(kv))).status, 401);
  assert.equal((await handle(get('/v1/cb/inbox', { Authorization: 'Bearer wrong' }), env(kv))).status, 401);

  const j = await (await handle(get('/v1/cb/inbox', auth), env(kv))).json();
  assert.equal(j.items.length, 1);
  assert.equal(j.more, false);
  const it = j.items[0];
  assert.equal(it.id, id);
  const rep = it.report;
  assert.ok(!JSON.stringify(rep).includes('ABCDEFGHIJ'), '令牌被抹掉');
  assert.ok(!JSON.stringify(rep).includes('张三'), '用户名 / 路径不出现');
  assert.ok(!('user' in rep) && !('host' in rep) && !('chats' in rep), '白名单外的字段不存');
  assert.equal(rep.attachments.length, 1, '伪装的 exe 被丢掉');
  assert.equal(rep.attachments[0].name, 'image-1.png', '文件名重起');
  assert.equal(rep.attachments[0].type, 'image/png');
  assert.equal(rep.omitted, 1);
  assert.equal(rep.version, '6.51 (464)');
  assert.equal(rep.platform, 'linux');

  const a = await (await handle(post('/v1/cb/inbox/ack', { ids: [id, '../../etc', 'cfg:paused'] }, auth), env(kv))).json();
  assert.deepEqual(a, { ok: true, acked: 1 });
  assert.equal(kv.m.has(`cbi:${id}`), false);
  const j2 = await (await handle(get('/v1/cb/inbox', auth), env(kv))).json();
  assert.equal(j2.items.length, 0);
});

test('分页：limit 之外还有就回 more:true；按到达顺序取', async () => {
  const kv = memKV();
  let t = 1_792_000_000_000;
  const handle = createHandler({ fetch: noGitHub, now: () => t });
  for (let i = 0; i < 3; i++) { t += 1000; assert.equal((await handle(post('/v1/cb/report', base({ text: `第 ${i} 条` })), env(kv))).status, 200); }
  const j = await (await handle(get('/v1/cb/inbox?limit=2', auth), env(kv))).json();
  assert.equal(j.items.length, 2);
  assert.equal(j.more, true);
  assert.deepEqual(j.items.map((x) => x.report.text), ['第 0 条', '第 1 条']);
});

test('图片：最多 3 张、每张 ≤2MB、只认四种文件头', () => {
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(CB_MAX_IMAGE_BYTES, 0)]).toString('base64');
  const r = cleanCbReport(base({ attachments: [{ data: png() }, { data: big }, { data: jpg() }, { data: 'not base64!' }, { data: png().replace(/^(.{8})./, '$1=') }, { data: png() }, { data: png() }] }));
  assert.deepEqual(r.attachments.map((a) => a.type), ['image/png', 'image/jpeg', 'image/png']);
  assert.equal(r.omitted, 4);
  // 只有图片、没有文字也收；既没文字也没合格图片就拒
  assert.equal(cleanCbReport(base({ text: '', attachments: [{ data: png() }] })).attachments.length, 1);
  assert.throws(() => cleanCbReport(base({ text: '', attachments: [{ data: exe() }] })), /empty report/);
  assert.throws(() => cleanCbReport(base({ install: 'x' })), /bad install id/);
});

test('坏请求、超大、限流、停收', async () => {
  const kv = memKV();
  const handle = createHandler({ fetch: noGitHub });
  assert.equal((await handle(post('/v1/cb/report', { text: 'no install' }), env(kv))).status, 400);
  assert.equal((await handle(post('/v1/cb/report', 'not json'), env(kv))).status, 400);
  assert.equal((await handle(post('/v1/cb/report', 'x'.repeat(9 * 1024 * 1024 + 1)), env(kv))).status, 413);
  assert.equal((await handle(get('/v1/cb/report'), env(kv))).status, 405);
  assert.equal((await handle(post('/v1/cb/inbox', {}, auth), env(kv))).status, 405);
  assert.equal((await handle(get('/v1/cb/nope', auth), env(kv))).status, 404);
  const e = env(kv, { CB_PER_INSTALL_DAILY: '2' });
  for (let i = 0; i < 2; i++) assert.equal((await handle(post('/v1/cb/report', base({ text: `问题 ${i}` })), e)).status, 200);
  assert.equal((await handle(post('/v1/cb/report', base({ text: '第三份' })), e)).status, 429);
  // 限流跟 Muse 分开计数：Muse 那边的计数键没被动过
  assert.ok(![...kv.m.keys()].some((k) => /^rl:[0-9-]+:(all|i:)/.test(k)));
  // 全局每天的体积上限（这里压到约 100 字节）：第一份带图的收，第二份超了 429
  const small = env(memKV(), { CB_DAILY_MB: '0.0001' });
  // 每份 60 字节图 + 1 个字（按 3 字节计）= 63
  assert.equal((await handle(post('/v1/cb/report', base({ text: '图', attachments: [{ data: png(52) }] })), small)).status, 200);
  assert.equal((await handle(post('/v1/cb/report', base({ text: '图', attachments: [{ data: png(52) }] })), small)).status, 429);
  assert.equal((await handle(post('/v1/cb/report', base()), env(memKV(), { PAUSED: '1' }))).status, 503);
  const kv2 = memKV(); await kv2.put('cfg:paused', '1');
  assert.equal((await handle(post('/v1/cb/report', base()), env(kv2))).status, 503);
});

test('KV 写入省着用（免费档整个账号每天 1000 次，跟 Muse 共用）：收一份写 3 次，被拒的一次不写；默认全局每天 50 份', async () => {
  const kv = memKV();
  const handle = createHandler({ fetch: noGitHub });
  assert.equal((await handle(post('/v1/cb/report', base()), env(kv))).status, 200);
  assert.equal(kv.writes, 3);
  const e = env(kv, { CB_PER_INSTALL_DAILY: '1' });
  assert.equal((await handle(post('/v1/cb/report', base({ text: '同一台第二份' })), e)).status, 429);
  assert.equal(kv.writes, 3, '被拒不写');
  // 默认上限：随机装机编号刷满 50 份后，第 51 份 429，且同样不写
  const kv3 = memKV();
  for (let i = 0; i < 50; i++) assert.equal((await handle(post('/v1/cb/report', base({ install: `spam-install-${String(i).padStart(4, '0')}` })), env(kv3))).status, 200);
  const w = kv3.writes;
  assert.equal((await handle(post('/v1/cb/report', base({ install: 'spam-install-9999' })), env(kv3))).status, 429);
  assert.equal(kv3.writes, w);
});
