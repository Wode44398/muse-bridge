// 反馈汇总通道：主动同意（默认关、没配中继就没有通道、提交人勾选）、推送、补发（指数退避 / 放弃 / 拒收）、管理员开关、
// 汇总端拉取写库与 ack、反馈库位置，外加 /api/feedback* 路由。
// 中继全用假的（内存里模拟 Worker 的 /v1/cb/*），不联网；数据根、反馈库都在临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-fbup-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');

const { createFeedbackUpstream, sniffImage, instanceAllowed, resolveFeedbackDir, channelRelay, normalizeRelay } = await import('./feedback-upstream.mjs');
const { registerFeedbackRoutes } = await import('../routes/feedback.mjs');

const INBOX = 'inbox-token-0123456789abcdef';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(40, 1)]);

let seq = 0;
function sandbox(cfg = {}) {
  const root = path.join(tmp, 'sb' + ++seq);
  mkdirSync(root, { recursive: true });
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ port: 1, token: 'x', ...cfg }, null, 2));
  return { root, configPath, feedbackDir: path.join(root, 'vault', '用户反馈') };
}
// 管理员已在设置里打开「把用户反馈同时发给 bridge 开发者」的服务器
const pushBox = (cfg = {}) => sandbox({ feedbackUpstream: true, ...cfg });

function fakeRelay() {
  const r = { reports: [], inbox: new Map(), calls: [], down: false, force: 0 };
  r.fetch = async (url, init = {}) => {
    if (r.down) throw new Error('connect ECONNREFUSED');
    const u = new URL(url);
    const method = init.method || 'GET';
    r.calls.push({ method, path: u.pathname + u.search, auth: init.headers?.Authorization || '' });
    const res = (code, o) => new Response(JSON.stringify(o), { status: code, headers: { 'Content-Type': 'application/json' } });
    if (r.force) return res(r.force, { error: 'forced' });
    if (u.pathname === '/v1/cb/report' && method === 'POST') { r.reports.push(JSON.parse(init.body)); return res(200, { ok: true, id: '1792000000000-aaaaaaaa' }); }
    const isInbox = u.pathname === '/v1/cb/inbox', isAck = u.pathname === '/v1/cb/inbox/ack';
    if (isInbox || isAck) {
      if (init.headers?.Authorization !== `Bearer ${INBOX}`) return res(401, { error: 'unauthorized' });
      if (isInbox) {
        const limit = Number(u.searchParams.get('limit')) || 10;
        const keys = [...r.inbox.keys()].sort();
        return res(200, { ok: true, items: keys.slice(0, limit).map((k) => r.inbox.get(k)), more: keys.length > limit });
      }
      const { ids } = JSON.parse(init.body);
      for (const id of ids) r.inbox.delete(id);
      return res(200, { ok: true, acked: ids.length });
    }
    return res(404, { error: 'not found' });
  };
  return r;
}

const mk = (sb, relay, o = {}) => {
  let t = o.t0 || 1_792_000_000_000;
  const logs = [];
  const up = createFeedbackUpstream({
    dataRoot: sb.root, configPath: sb.configPath, feedbackDir: sb.feedbackDir, relayUrl: o.relayUrl ?? 'https://relay.test',
    buildRelay: () => o.buildRelay || '',
    fetch: relay.fetch, now: () => t, random: () => 0.5, instanceOk: o.instanceOk ?? true,
    literals: () => ['my-box.example.com', 'DESKTOP-SECRET1'], log: (s) => logs.push(String(s)), appVersion: '6.51 (464)',
  });
  return { up, logs, tick: (ms) => { t += ms; }, now: () => t };
};
const outbox = (sb) => { try { return readdirSync(path.join(sb.root, 'feedback', 'outbox')); } catch { return []; } };
// 退避状态在文件名里：<id>~<次数>~<下次时间>.json
const backoffOf = (f) => { const m = /^\d{13}-[0-9a-f]{8}~(\d+)~(\d{13})\.json$/.exec(f); return m ? { tries: Number(m[1]), nextAt: Number(m[2]) } : null; };
// 中继请求卡住，直到手动放行（模拟慢上传 / 发送中途）
function gated(relay) {
  let release;
  const gate = new Promise((r) => { release = r; });
  return { fetch: async (...a) => { await gate; return relay.fetch(...a); }, release: () => release() };
}

test('推送：白名单字段 + 本机字面值抹掉；图片带上、视频只计数；发完队列清空', async () => {
  const sb = pushBox();
  const relay = fakeRelay();
  const { up } = mk(sb, relay);
  const img = path.join(sb.root, 'a.png'), vid = path.join(sb.root, 'b.mp4');
  writeFileSync(img, PNG); writeFileSync(vid, MP4);
  assert.equal(up.mode(), 'push');
  const r = up.submit({ text: '在 my-box.example.com 上，DESKTOP-SECRET1 里 zhangsan 点设置卡死', screen: 'settings-desktop', role: 'user', user: 'zhangsan', files: [img, vid], consent: true });
  assert.equal(r, 'queued');
  await up.flush();
  assert.equal(relay.reports.length, 1);
  const p = relay.reports[0];
  assert.match(p.install, /^[0-9a-f-]{36}$/);
  assert.equal(p.install, up.installId(), '装机编号固定');
  assert.ok(!/my-box|DESKTOP-SECRET1|zhangsan/i.test(JSON.stringify(p)), '主机名 / 域名 / 用户名都不出去');
  assert.ok(!('user' in p));
  assert.equal(p.version, '6.51 (464)');
  assert.equal(p.platform, process.platform);
  assert.equal(p.role, 'user');
  assert.equal(p.attachments.length, 1);
  assert.equal(p.attachments[0].type, 'image/png');
  assert.equal(Buffer.from(p.attachments[0].data, 'base64').equals(PNG), true);
  assert.equal(p.omitted, 1);
  assert.deepEqual(outbox(sb), []);
  assert.ok(up.state({ admin: true }).lastOkAt > 0);
});

test('补发：断网 / 中继还没部署新版（404）→ 指数退避留在队列；到点再发；拒收（400）就丢', async () => {
  const sb = pushBox();
  const relay = fakeRelay();
  const { up, tick } = mk(sb, relay);
  relay.down = true;
  up.submit({ text: '第一条', consent: true });
  await up.flush();
  let files = outbox(sb);
  assert.equal(files.length, 1);
  let e = backoffOf(files[0]);
  assert.ok(e, '退避状态记在文件名里');
  assert.equal(e.tries, 1);
  assert.equal(e.nextAt - 1_792_000_000_000, 60_000, '第一次退避 1 分钟（抖动取中值）');
  assert.match(up.state({ admin: true }).lastError, /network/);
  // 文件内容就是请求体，退避只改名、不重写
  assert.equal(JSON.parse(readFileSync(path.join(sb.root, 'feedback', 'outbox', files[0]), 'utf8')).text, '第一条');

  // 没到点：不发
  relay.down = false;
  const before = relay.calls.length;
  tick(30_000); await up.flush();
  assert.equal(relay.calls.length, before);

  // 到点了但中继是老版本（/v1/cb/* 404）：还是留着，退避翻倍
  relay.force = 404;
  tick(31_000); await up.flush();
  e = backoffOf(outbox(sb)[0]);
  assert.equal(e.tries, 2);
  assert.equal(e.nextAt - (1_792_000_000_000 + 61_000), 120_000);

  // 中继好了：发出去、队列清空
  relay.force = 0;
  tick(120_000); await up.flush();
  assert.equal(relay.reports.length, 1);
  assert.deepEqual(outbox(sb), []);

  // 400（报告本身不合格）：不补发，直接丢
  relay.force = 400;
  up.submit({ text: '第二条', consent: true });
  await up.flush();
  assert.deepEqual(outbox(sb), []);
  assert.match(up.state({ admin: true }).lastError, /relay 400/);
});

test('补发：超过 14 天就放弃；进程死在半路的认领文件 10 分钟后放回队列', async () => {
  const sb = pushBox();
  const relay = fakeRelay();
  const { up, tick } = mk(sb, relay);
  relay.down = true;
  up.submit({ text: '老的', consent: true });
  await up.flush();
  relay.down = false;
  tick(15 * 86400_000);
  await up.flush();
  assert.deepEqual(outbox(sb), []);
  assert.equal(relay.reports.length, 0);

  // 认领文件（另一个进程发到一半死了）
  const dir = path.join(sb.root, 'feedback', 'outbox');
  const id = String(Date.now()) + '-0badf00d';
  writeFileSync(path.join(dir, `${id}.json.99999.sending`), JSON.stringify({ v: 1, text: '半路' }));
  // mtime 是真实时间，假时钟拨到 20 分钟后才算「过期」
  const { up: up2 } = mk(sb, relay, { t0: Date.now() + 20 * 60_000 });
  await up2.flush();
  assert.equal(relay.reports.at(-1)?.text, '半路');
  assert.deepEqual(outbox(sb), []);
});

test('认领：正在发的那份（排队早于 10 分钟）不会被同一数据根上的另一个进程抢回去重发', async () => {
  const sb = pushBox();
  const relay = fakeRelay();
  const slow = gated(relay);
  // 文件是一小时前写的（真实 mtime），两个实例的时钟都在一小时后：认领时不刷 mtime 的话，B 会当它是死进程留下的
  const T = Date.now() + 60 * 60_000;
  const A = mk(sb, slow, { t0: T });
  const B = mk(sb, relay, { t0: T });
  A.up.submit({ text: '只该发一次', consent: true });
  assert.ok(outbox(sb).some((f) => f.endsWith('.sending')), 'A 已认领、正在发');
  await B.up.flush();
  assert.equal(relay.reports.length, 0, 'B 没把 A 正在发的放回队列重发');
  slow.release();
  await A.up.flush();
  assert.equal(relay.reports.length, 1);
  assert.deepEqual(outbox(sb), []);
});

test('上传超时按体积放宽：小报告 30 秒起，带大图的更长，最多 5 分钟', async () => {
  const sb = pushBox();
  const seen = [];
  // 拦下 setTimeout 记下超时时长（只认 ≥30 秒的，别的定时器不算）
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => { if (ms >= 30_000) seen.push(ms); return realSet(fn, ms, ...a); };
  try {
    const relay = fakeRelay();
    const { up } = mk(sb, relay);
    up.submit({ text: '小的', consent: true });
    await up.flush();
    const big = path.join(sb.root, 'big.png');
    writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 - PNG.length - 1, 3)]));
    up.submit({ text: '带三张大图', files: [big, big, big], consent: true });
    await up.flush();
  } finally { globalThis.setTimeout = realSet; }
  assert.ok(seen[0] >= 30_000 && seen[0] < 32_000, `小报告 ${seen[0]}`);
  assert.ok(seen[1] > 150_000 && seen[1] <= 300_000, `8MB 报告 ${seen[1]}`);
});

test('管理员开关：关掉 → 不推、待发的清掉；非正式实例一律 off', async () => {
  const sb = pushBox();
  const relay = fakeRelay();
  const { up } = mk(sb, relay);
  relay.down = true;
  up.submit({ text: '还没发出去', consent: true });
  await up.flush();
  assert.equal(outbox(sb).length, 1);
  const s = up.setPush(false);
  assert.equal(s.mode, 'off');
  assert.equal(s.cleared, 1);
  assert.deepEqual(outbox(sb), []);
  assert.equal(JSON.parse(readFileSync(sb.configPath, 'utf8')).feedbackUpstream, false);
  assert.equal(JSON.parse(readFileSync(sb.configPath, 'utf8')).token, 'x', '其余字段保全');
  assert.equal(up.submit({ text: 'x', consent: true }), 'off');
  assert.deepEqual(outbox(sb), []);
  assert.equal(up.setPush(true).mode, 'push');

  const { up: test2 } = mk(sandbox(), relay, { instanceOk: false });
  assert.equal(test2.mode(), 'off');
  assert.equal(test2.state().reason, 'instance');
  assert.equal(test2.submit({ text: 'x', consent: true }), 'off');
});

test('默认关：没显式打开（feedbackUpstream 没写 / 不是 true）就不推，开关显示关着；显式打开才推', async () => {
  const relay = fakeRelay();
  for (const cfg of [{}, { feedbackUpstream: false }, { feedbackUpstream: 'true' }, { feedbackUpstream: 1 }]) {
    const sb = sandbox(cfg);
    const { up } = mk(sb, relay);
    assert.equal(up.mode(), 'off', JSON.stringify(cfg));
    assert.equal(up.state().enabled, false, '设置页的开关显示关着');
    assert.equal(up.submit({ text: '提交人勾了也不推', consent: true }), 'off');
    await up.flush();
    assert.deepEqual(outbox(sb), []);
  }
  assert.equal(relay.reports.length, 0);
  const sb = sandbox();
  const { up } = mk(sb, relay);
  assert.equal(up.setPush(true).mode, 'push', '管理员显式打开才推');
  assert.equal(JSON.parse(readFileSync(sb.configPath, 'utf8')).feedbackUpstream, true);
  // 写了收件令牌就是汇总端（bridge 开发者自己那台），不推
  writeFileSync(sb.configPath, JSON.stringify({ port: 1, token: 'x', feedbackUpstream: true, feedbackInbox: { token: INBOX } }, null, 2));
  assert.equal(up.mode(), 'inbox');
});

test('没配中继地址：整条通道不存在——开关打不开（400）、不推、状态写明原因；构建期渠道 / config / 环境变量都能配', async () => {
  const relay = fakeRelay();
  const sb = pushBox();
  const { up } = mk(sb, relay, { relayUrl: '' });
  const prevEnv = process.env.BRIDGE_FEEDBACK_RELAY;
  delete process.env.BRIDGE_FEEDBACK_RELAY;
  try {
    assert.equal(up.mode(), 'off', '管理员开过也没用');
    const st = up.state({ admin: true });
    assert.equal(st.reason, 'no-relay');
    assert.equal(st.relayHost, '');
    assert.equal(st.libraryDir, sb.feedbackDir, '管理员能看到反馈库在服务器上的位置');
    assert.equal(up.state().libraryDir, undefined, '普通用户看不到服务器路径');
    assert.equal(up.submit({ text: 'x', consent: true }), 'off');
    assert.throws(() => up.setPush(true), (e) => e.status === 400);
    assert.equal(up.setPush(false).mode, 'off', '关总是能关');

    // 构建期渠道（程序根 bridge-build.json 的 feedbackRelay）
    const { up: chan } = mk(pushBox(), relay, { relayUrl: '', buildRelay: 'https://chan.example.net' });
    assert.equal(chan.mode(), 'push');
    assert.equal(chan.state({ admin: true }).relayHost, 'chan.example.net');
    assert.equal(chan.state().relayHost, undefined, '普通用户看不到中继地址');
    // config.feedbackRelay 压过构建期渠道；写错的地址当没配
    const { up: viaCfg } = mk(pushBox({ feedbackRelay: 'https://cfg.example.net/' }), relay, { relayUrl: '', buildRelay: 'https://chan.example.net' });
    assert.equal(viaCfg.state({ admin: true }).relayHost, 'cfg.example.net');
    const { up: bad } = mk(pushBox({ feedbackRelay: 'not a url' }), relay, { relayUrl: '' });
    assert.equal(bad.mode(), 'off');
    // 环境变量压过 config
    process.env.BRIDGE_FEEDBACK_RELAY = 'https://env.example.net';
    assert.equal(viaCfg.state({ admin: true }).relayHost, 'env.example.net');
  } finally {
    if (prevEnv === undefined) delete process.env.BRIDGE_FEEDBACK_RELAY; else process.env.BRIDGE_FEEDBACK_RELAY = prevEnv;
  }
  assert.equal(relay.reports.length, 0);
});

test('构建期渠道：读程序根 bridge-build.json 的 feedbackRelay；没有文件 / 没这个字段 / 不是网址都是空', () => {
  const pr = path.join(tmp, 'prog-chan');
  mkdirSync(pr, { recursive: true });
  assert.equal(channelRelay(pr), '');
  writeFileSync(path.join(pr, 'bridge-build.json'), JSON.stringify({ buildId: '2026.10.22.1200+abc' }));
  assert.equal(channelRelay(pr), '');
  writeFileSync(path.join(pr, 'bridge-build.json'), JSON.stringify({ buildId: 'x', feedbackRelay: 'https://relay.example.org/' }));
  assert.equal(channelRelay(pr), 'https://relay.example.org');
  writeFileSync(path.join(pr, 'bridge-build.json'), JSON.stringify({ feedbackRelay: 'javascript:alert(1)' }));
  assert.equal(channelRelay(pr), '');
  assert.equal(normalizeRelay(' http://127.0.0.1:8788// '), 'http://127.0.0.1:8788');
  assert.equal(normalizeRelay('ftp://x'), '');
});

test('反馈库位置：config.feedbackDir > 早期默认位置（已有就沿用）> 数据根 feedback/reports', () => {
  const sb = sandbox();
  const vault = path.join(sb.root, 'vault');
  const dataRoot = path.join(sb.root, 'data');
  const legacy = path.join(vault, 'bridge构建', '用户反馈');
  const at = () => resolveFeedbackDir({ configPath: sb.configPath, vault, dataRoot });
  assert.equal(at(), path.join(dataRoot, 'feedback', 'reports'), '新装机：数据根里带命名空间的 reports/，不进工作空间');
  mkdirSync(path.join(vault, 'feedback'), { recursive: true });
  assert.equal(at(), path.join(dataRoot, 'feedback', 'reports'), '工作空间里恰好有个 feedback/ 也不往里写');
  mkdirSync(legacy, { recursive: true });
  assert.equal(at(), legacy, '老部署：反馈不换地方');
  writeFileSync(sb.configPath, JSON.stringify({ feedbackDir: '反馈' }));
  assert.equal(at(), path.join(vault, '反馈'), '相对路径按工作空间算');
  const abs = path.join(sb.root, 'elsewhere');
  writeFileSync(sb.configPath, JSON.stringify({ feedbackDir: abs }));
  assert.equal(at(), abs);
});

test('提交人没勾「这条也发给 bridge 开发者」（含旧版界面）：只留本机，不进待发队列', async () => {
  const sb = pushBox();
  const relay = fakeRelay();
  const { up } = mk(sb, relay);
  assert.equal(up.mode(), 'push');
  assert.equal(up.submit({ text: '没勾的' }), 'off');
  assert.equal(up.submit({ text: '不是严格 true 的', consent: 'yes' }), 'off');
  await up.flush();
  assert.deepEqual(outbox(sb), []);
  assert.equal(relay.reports.length, 0);
});

test('管理员开关：关掉时正在发的那份发失败了也不放回队列，再打开也不会被发出去', async () => {
  const sb = pushBox();
  const relay = fakeRelay();
  relay.down = true;
  const slow = gated(relay);
  const { up } = mk(sb, slow);
  up.submit({ text: '已取消的', consent: true });
  assert.ok(outbox(sb).some((f) => f.endsWith('.sending')));
  const s = up.setPush(false);
  assert.equal(s.cleared, 1, '认领文件一起清掉');
  slow.release();
  await up.flush();
  assert.deepEqual(outbox(sb), [], '发失败后没写回队列');
  up.setPush(true);
  relay.down = false;
  await mk(sb, relay).up.flush();
  assert.equal(relay.reports.length, 0);
});

test('不再推送时（改成汇总端 / 手改 config 关掉）巡检把待发队列清掉', async () => {
  const sb = pushBox();
  const relay = fakeRelay();
  const { up, logs } = mk(sb, relay);
  relay.down = true;
  up.submit({ text: '留在队列里', consent: true });
  await up.flush();
  assert.equal(outbox(sb).length, 1);
  writeFileSync(sb.configPath, JSON.stringify({ port: 1, token: 'x', feedbackInbox: { token: INBOX } }, null, 2));
  await up.tick();
  assert.deepEqual(outbox(sb), []);
  assert.ok(logs.some((l) => /汇总端，清掉 1 份/.test(l)));
  assert.equal(relay.reports.length, 0);
});

test('只附了视频、没写字：补一句占位文字，免得中继当空报告拒收', async () => {
  const sb = pushBox();
  const relay = fakeRelay();
  const { up } = mk(sb, relay);
  const vid = path.join(sb.root, 'rec.mp4');
  writeFileSync(vid, MP4);
  up.submit({ text: '', files: [vid], consent: true });
  await up.flush();
  assert.equal(relay.reports.length, 1);
  const p = relay.reports[0];
  assert.ok(p.text.length > 0);
  assert.equal(p.omitted, 1);
  assert.deepEqual(p.attachments, []);
});

test('正式实例判定：本机控制台、测试实例、测试服、临时目录数据根、node --test 都不推不拉；环境变量能强开强关', () => {
  const tmpDir = path.join(path.sep === '\\' ? 'C:\\' : '/', 'tmp-x');
  const prod = path.join(path.sep === '\\' ? 'D:\\' : '/', 'srv', 'bridge');
  const ok = (env, dataRoot = prod) => instanceAllowed({ env, dataRoot, tmpDir });
  assert.equal(ok({}), true);
  assert.equal(ok({ BRIDGE_NO_AUTH: '1' }), false);
  assert.equal(ok({ BRIDGE_NO_ROUTINES: '1' }), false);
  assert.equal(ok({ BRIDGE_ENV: 'test' }), false);
  assert.equal(ok({ NODE_TEST_CONTEXT: 'child-v8' }), false);
  assert.equal(ok({}, path.join(tmpDir, 'claude', 'scratch', 'data')), false);
  assert.equal(ok({}, tmpDir), false);
  assert.equal(ok({}, tmpDir + '-other'), true, '只是名字前缀相同不算');
  assert.equal(ok({ BRIDGE_ENV: 'test', BRIDGE_FEEDBACK_UPSTREAM: '1' }), true);
  assert.equal(ok({ BRIDGE_FEEDBACK_UPSTREAM: '0' }), false);
});

test('汇总端：不往外推；拉收件箱写库（附件进 attachments/、frontmatter 标来源），写完 ack；重复拉到不重复写', async () => {
  const sb = sandbox({ feedbackInbox: { token: INBOX } });
  const relay = fakeRelay();
  const { up } = mk(sb, relay);
  assert.equal(up.mode(), 'inbox');
  assert.equal(up.submit({ text: '本机的', consent: true }), 'inbox');
  assert.equal(relay.reports.length, 0);

  const item = (id, report) => ({ id, at: '2026-10-21T06:03:12.000Z', report });
  relay.inbox.set('1792000000001-aaaaaaaa', item('1792000000001-aaaaaaaa', {
    v: 1, install: 'f00dbabe-1111-2222-3333-444455556666', text: '外部服务器上切主题会闪', screen: 'settings',
    version: '6.51 (464)', platform: 'linux', arch: 'x64', os: 'Linux 6.8.0', node: 'v24.22.1', role: 'admin',
    omitted: 1, attachments: [{ name: 'image-1.png', type: 'image/png', size: PNG.length, data: PNG.toString('base64') }],
  }));
  relay.inbox.set('1792000000002-bbbbbbbb', item('1792000000002-bbbbbbbb', { v: 1, install: 'cafe0000-aaaa', text: '第二条' }));
  const r = await up.pullInbox();
  assert.equal(r.pulled, 2);
  assert.equal(relay.inbox.size, 0, '都 ack 掉了');
  assert.ok(relay.calls.filter((c) => c.path.startsWith('/v1/cb/inbox')).every((c) => c.auth === `Bearer ${INBOX}`));

  const mds = readdirSync(sb.feedbackDir).filter((f) => f.endsWith('.md')).sort();
  assert.equal(mds.length, 2);
  const md = readFileSync(path.join(sb.feedbackDir, mds.find((f) => f.includes('f00dbabe'))), 'utf8');
  assert.match(md, /^---\ntype: feedback\n/);
  assert.match(md, /\nsource: external\n/);
  assert.match(md, /\ninstall: "f00dbabe-1111-2222-3333-444455556666"\n/);
  assert.match(md, /\napp: "v6\.51 \(464\)"\n/);
  assert.match(md, /\nplatform: "linux · x64 · Linux 6\.8\.0 · Node v24\.22\.1"\n/);
  assert.match(md, /\nrole: admin\n/);
  assert.match(md, /外部服务器上切主题会闪/);
  assert.match(md, /另有 1 个附件/);
  const embed = /!\[\[attachments\/([^\]]+)\]\]/.exec(md);
  assert.ok(embed, '图片嵌入');
  assert.equal(readFileSync(path.join(sb.feedbackDir, 'attachments', embed[1])).equals(PNG), true);

  // KV 最终一致：确认过的又被列出来一次 → 不重复写，照样 ack
  relay.inbox.set('1792000000001-aaaaaaaa', item('1792000000001-aaaaaaaa', { v: 1, install: 'f00dbabe-1111', text: '重复' }));
  const r2 = await up.pullInbox();
  assert.equal(r2.pulled, 0);
  assert.equal(relay.inbox.size, 0);
  assert.equal(readdirSync(sb.feedbackDir).filter((f) => f.endsWith('.md')).length, 2);
});

test('汇总端：中继出错时不 ack、记下错误；令牌太短不算配了', async () => {
  const sb = sandbox({ feedbackInbox: { token: INBOX } });
  const relay = fakeRelay();
  const { up } = mk(sb, relay);
  relay.force = 503;
  const r = await up.pullInbox();
  assert.match(r.error, /relay 503/);
  assert.ok(up.state({ admin: true }).lastPullAt > 0);
  const { up: weak } = mk(sandbox({ feedbackInbox: { token: 'short' } }), relay);
  assert.equal(weak.mode(), 'off', '令牌太短不算汇总端；也没打开推送 → off');
  const { up: weakPush } = mk(pushBox({ feedbackInbox: { token: 'short' } }), relay);
  assert.equal(weakPush.mode(), 'push');
});

test('汇总端：没配中继地址时拉取明确报错（不悄悄失败）', async () => {
  const sb = sandbox({ feedbackInbox: { token: INBOX } });
  const relay = fakeRelay();
  const prevEnv = process.env.BRIDGE_FEEDBACK_RELAY;
  delete process.env.BRIDGE_FEEDBACK_RELAY;
  try {
    const { up, logs } = mk(sb, relay, { relayUrl: '' });
    assert.equal(up.mode(), 'inbox');
    const r = await up.pullInbox();
    assert.equal(r.error, 'no relay');
    assert.equal(up.state({ admin: true }).lastPullError, 'no relay');
    assert.ok(logs.some((l) => /没配中继地址/.test(l)));
    assert.equal(relay.calls.length, 0);
  } finally {
    if (prevEnv === undefined) delete process.env.BRIDGE_FEEDBACK_RELAY; else process.env.BRIDGE_FEEDBACK_RELAY = prevEnv;
  }
});

test('汇总端：拉取失败看得见——日志按状态变化记一行，管理员状态里有出错原因；恢复后也记一行', async () => {
  const sb = sandbox({ feedbackInbox: { token: INBOX } });
  const relay = fakeRelay();
  const { up, logs, tick } = mk(sb, relay);
  relay.force = 401;
  await up.pullInbox();
  let s = up.state({ admin: true });
  assert.equal(s.mode, 'inbox');
  assert.match(s.lastPullError, /relay 401/);
  assert.equal(s.lastPullOkAt, 0);
  assert.equal(logs.filter((l) => /拉外部反馈失败.*INBOX_TOKEN 对不上/.test(l)).length, 1);
  assert.ok(!logs.some((l) => l.includes(INBOX)), '日志不带令牌');
  tick(5 * 60_000); await up.pullInbox();
  assert.equal(logs.filter((l) => /拉外部反馈失败/.test(l)).length, 1, '同一个错不重复刷');
  relay.force = 0;
  tick(5 * 60_000); await up.pullInbox();
  s = up.state({ admin: true });
  assert.equal(s.lastPullError, '');
  assert.ok(s.lastPullOkAt > 0);
  assert.ok(logs.some((l) => /恢复正常/.test(l)));
  // 普通用户看不到这些
  assert.ok(!('lastPullError' in up.state()));
});

test('汇总端：同一台装机同一秒到的两份带图反馈，附件各归各、互不覆盖', async () => {
  const sb = sandbox({ feedbackInbox: { token: INBOX } });
  const relay = fakeRelay();
  const { up } = mk(sb, relay);
  const png = (fill) => Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(40, fill)]);
  const A = png(1), B = png(2);
  const install = 'f00dbabe-1111-2222-3333-444455556666';
  const att = (b) => [{ name: 'image-1.png', type: 'image/png', size: b.length, data: b.toString('base64') }];
  relay.inbox.set('1792000000001-aaaaaaaa', { id: '1792000000001-aaaaaaaa', at: '2026-10-21T06:03:12.100Z', report: { v: 1, install, text: '第一份', attachments: att(A) } });
  relay.inbox.set('1792000000002-bbbbbbbb', { id: '1792000000002-bbbbbbbb', at: '2026-10-21T06:03:12.600Z', report: { v: 1, install, text: '第二份', attachments: att(B) } });
  assert.equal((await up.pullInbox()).pulled, 2);
  const mds = readdirSync(sb.feedbackDir).filter((f) => f.endsWith('.md'));
  assert.equal(mds.length, 2);
  for (const f of mds) {
    const md = readFileSync(path.join(sb.feedbackDir, f), 'utf8');
    const emb = /!\[\[attachments\/([^\]]+)\]\]/.exec(md)[1];
    const buf = readFileSync(path.join(sb.feedbackDir, 'attachments', emb));
    assert.equal(buf.equals(md.includes('第一份') ? A : B), true, `${f} 嵌入的是自己那张图`);
  }
  assert.equal(readdirSync(path.join(sb.feedbackDir, 'attachments', 'external')).length, 2);
});

test('sniffImage：只认四种文件头', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a\0\0\0\0\0\0')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(MP4), '');
  assert.equal(sniffImage(Buffer.from('MZ')), '');
});

// —— 路由 ——
function routes(kind, upstream, feedbackDir) {
  const h = {};
  const router = { on: (method, p, fn) => { h[method + ' ' + p] = fn; } };
  registerFeedbackRoutes(router, { identify: () => ({ kind, user: kind === 'user' ? 'alice' : null, tier: kind === 'user' ? 'pro' : undefined }), upstream, feedbackDir });
  return async (method, p, body) => {
    let status = 0, out = '';
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.headers = {}; req.url = p; req.method = method;
    const res = { writeHead(s) { status = s; }, end(chunk) { out = chunk || ''; } };
    await h[method + ' ' + p](req, res, new URL('http://x' + p));
    let json = null; try { json = JSON.parse(out); } catch {}
    return { status, json };
  };
}

test('路由：提交先落本机 md，再把校验过的附件交给推送（带提交人的勾选）；状态与开关只给管理员改', async () => {
  const sb = sandbox();
  const calls = [];
  let enabled = true, noRelay = false;
  const fake = {
    submit: (o) => { calls.push(o); return 'queued'; },
    state: ({ admin }) => ({ mode: enabled ? 'push' : 'off', enabled, ...(admin ? { pending: 0 } : {}) }),
    setPush: (on) => {
      if (on && noRelay) { const e = new Error('这台服务器没配反馈中继地址，开不了'); e.status = 400; throw e; }
      enabled = on; return { mode: on ? 'push' : 'off', enabled: on, cleared: 0 };
    },
  };
  // admin 的 uploads = 数据根 uploads（config/index.mjs 已建好）
  const up = path.join(tmp, 'uploads');
  mkdirSync(up, { recursive: true });
  writeFileSync(path.join(up, 'shot.png'), PNG);

  const admin = routes('admin', fake, sb.feedbackDir);
  const r = await admin('POST', '/api/feedback', { text: '截图里那个按钮没反应', screen: 'claude', shareWithDeveloper: true, attachments: [{ path: path.join(up, 'shot.png'), name: 'shot.png' }, { path: path.join(tmp, 'config.json'), name: 'steal.json' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, upstream: 'queued' });
  const mds = readdirSync(sb.feedbackDir).filter((f) => f.endsWith('.md'));
  assert.equal(mds.length, 1);
  assert.match(readFileSync(path.join(sb.feedbackDir, mds[0]), 'utf8'), /截图里那个按钮没反应/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].files, [path.join(up, 'shot.png')], 'uploads 之外的路径不交出去');
  assert.equal(calls[0].role, 'admin');
  assert.equal(calls[0].consent, true);
  assert.equal(readdirSync(path.join(sb.feedbackDir, 'attachments')).length, 1);
  // 没勾 / 旧版界面：不带 shareWithDeveloper；旧字段 upstreamNotice 只是「写了去向」，不算同意；非严格 true 也不算
  await admin('POST', '/api/feedback', { text: '旧 apk 提交的' });
  await admin('POST', '/api/feedback', { text: '上一版界面提交的', upstreamNotice: true });
  await admin('POST', '/api/feedback', { text: '字符串 true', shareWithDeveloper: 'true' });
  assert.deepEqual(calls.slice(1).map((c) => c.consent), [false, false, false]);

  const user = routes('user', fake, sb.feedbackDir);
  const s = await user('GET', '/api/feedback/upstream');
  assert.equal(s.status, 200);
  assert.equal(s.json.mode, 'push');
  assert.equal(s.json.admin, false);
  assert.ok(!('pending' in s.json), '普通用户看不到队列细节');
  assert.equal((await user('POST', '/api/feedback/upstream', { enabled: false })).status, 403);
  assert.equal(enabled, true);

  const a = await admin('GET', '/api/feedback/upstream');
  assert.equal(a.json.admin, true);
  assert.equal(a.json.pending, 0);
  assert.equal((await admin('POST', '/api/feedback/upstream', { enabled: 'no' })).status, 400);
  const off = await admin('POST', '/api/feedback/upstream', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.mode, 'off');
  assert.equal(enabled, false);
  // 没配中继地址：打开回 400（带原因），开关不变
  noRelay = true;
  const nr = await admin('POST', '/api/feedback/upstream', { enabled: true });
  assert.equal(nr.status, 400);
  assert.match(nr.json.error, /中继/);
  assert.equal(enabled, false);

  assert.equal((await routes('share', fake, sb.feedbackDir)('GET', '/api/feedback/upstream')).status, 401);
  assert.equal((await routes('none', fake, sb.feedbackDir)('POST', '/api/feedback', { text: 'x' })).status, 401);
  assert.ok(!existsSync(path.join(tmp, 'feedback', 'outbox')), '路由测试没碰真推送');
});
