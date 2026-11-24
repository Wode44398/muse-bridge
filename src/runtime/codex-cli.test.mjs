// Codex 运行组件下载器（codex-cli.mjs）：本机 http 假源 + 现场做的小 tar.gz 与 SHA256SUMS，不连外网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  CODEX_CLI_ASSETS, CODEX_CLI_VERSION, _resetForTest, _setReleaseForTest, _setSourcesForTest, codexCliStatus, codexTarget,
  createCodexCli, ensureCodexCli, installedCodexAppServer, installedCodexCli, safeRel,
} from './codex-cli.mjs';

const VER = CODEX_CLI_VERSION;
const TARGET = 'x86_64-unknown-linux-musl';
const ASSET = `codex-app-server-package-${TARGET}.tar.gz`;

function header(name, size, type, mode = '0000644') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write(mode + '\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
const paxRec = (k, v) => { const body = ` ${k}=${v}
`; let len = body.length + 1; while (String(len).length + body.length !== len) len = String(len).length + body.length; return Buffer.from(len + body); };
// pax：仿上游 Python tarfile.PAX_FORMAT——每个条目前一个 'x' 头（带小数的 mtime 与 path），整个归档补齐到 10240 字节
function makeTar(entries, { pax = false } = {}) {
  const parts = [];
  const paxHead = (name) => {
    if (!pax) return;
    const rec = Buffer.concat([paxRec('mtime', '1795130305.123456'), paxRec('path', name)]);
    parts.push(header('././@PaxHeader', rec.length, 'x'), rec, pad(rec.length));
  };
  for (const e of entries) {
    paxHead(e.name);
    if (e.dir) { parts.push(header(e.name, 0, '5', '0000755')); continue; }
    const data = Buffer.from(e.data);
    parts.push(header(e.name, data.length, '0', e.mode || '0000644'), data, pad(data.length));
  }
  parts.push(Buffer.alloc(1024));
  const tar = Buffer.concat(parts);
  return pax ? Buffer.concat([tar, Buffer.alloc((10240 - (tar.length % 10240)) % 10240)]) : tar;
}

// 假程序：真包里是 musl 静态 ELF，这里只要内容可辨认（测试里冒充 Linux 目标，不会去执行它）。
// 带一段随机字节压不小，慢源、挂起的源才真的要分好几块传
const FAKE_BIN = Buffer.concat([Buffer.from('\x7fELF fake codex-app-server ', 'latin1'), randomBytes(20000)]);
const goodEntries = () => [
  { name: 'bin/', dir: true },
  { name: 'bin/codex-app-server', data: FAKE_BIN, mode: '0000755' },
  { name: 'bin/codex-exec-server', data: 'exec-server', mode: '0000755' },
  { name: 'codex-path/', dir: true },
  { name: 'codex-path/rg', data: 'rg', mode: '0000755' },
  { name: 'codex-resources/bwrap', data: 'bwrap', mode: '0000755' },
  { name: 'codex-package.json', data: JSON.stringify({ layoutVersion: 1, version: VER, target: TARGET, variant: 'app-server', entrypoint: 'bin/codex-app-server' }) },
];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const GOOD = gzipSync(makeTar(goodEntries()));
// 现场做一份 SHA256SUMS，期望值从这里解析出来（模仿 release.mjs 从发行方的清单抄录）
const SUMS = `${sha(GOOD)}  ${ASSET}\n${'0'.repeat(64)}  codex-package-${TARGET}.tar.gz\n`;
function releaseFromSums(text, body = GOOD) {
  const line = text.split('\n').find((l) => l.endsWith('  ' + ASSET));
  return { version: VER, assets: { [TARGET]: { asset: ASSET, sha256: line.split(/\s+/)[0], size: body.length } } };
}

// 假源：/<源名>/<版本>/<包名>。behave[源名] = 'ok' | 404 | 500 | 'trickle' | 'hang' | 'nohead'（不回应答头）
// | 'endless'（不报长度、一直往下发）| 'now'（应答头和内容一起发）| Buffer（换成这份内容）。behave 每次请求现读，测试里可以中途改。
async function fakeServer(behave) {
  const hits = [];
  const timers = new Set();
  const server = http.createServer((req, res) => {
    const [, src, ver, asset] = req.url.split('/');
    hits.push(src);
    const b = behave[src];
    if (asset === 'SHA256SUMS') { res.end(SUMS); return; }
    if (ver !== VER || asset !== ASSET || b === 404) { res.statusCode = 404; res.end(); return; }
    if (b === 500) { res.statusCode = 500; res.end(); return; }
    if (b === 'nohead') return;
    if (b === 'endless') {
      res.write(GOOD);
      const t = setInterval(() => { if (res.destroyed) { clearInterval(t); timers.delete(t); return; } res.write(Buffer.alloc(4096)); }, 5);
      timers.add(t);
      return;
    }
    const body = Buffer.isBuffer(b) ? b : GOOD;
    res.setHeader('content-length', body.length);
    if (b === 'trickle' || b === 'hang') {
      res.write(body.subarray(0, 600));
      if (b === 'hang') return;
      let i = 600;
      const t = setInterval(() => {
        if (res.destroyed) { clearInterval(t); timers.delete(t); return; }
        res.write(body.subarray(i, i + 1000)); i += 1000;
        if (i >= body.length) { clearInterval(t); timers.delete(t); res.end(); }
      }, 40);
      timers.add(t);
      return;
    }
    if (b === 'now') { res.end(body); return; }
    setTimeout(() => res.end(body), 30);   // 稍慢一点，让并发的两次调用真的撞在同一次下载上
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    hits, src: (name) => `${base}/${name}/{version}/{asset}`, base,
    close: async () => { for (const t of timers) clearInterval(t); server.closeAllConnections?.(); server.close(); await once(server, 'close').catch(() => {}); },
  };
}

async function withEnv(fn, { behave = { a: 'ok' }, srcs = ['a'], release = releaseFromSums(SUMS), ...extra } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-cli-test-'));
  const srv = await fakeServer(behave);
  const logs = [];
  try {
    const mk = (more = {}) => createCodexCli({
      dataRoot: root, programRoot: null, env: {}, config: () => ({}), platform: 'linux', arch: 'x64',
      sources: srcs.map(srv.src), release, probeVersion: async () => VER, log: (m) => logs.push(m), ...extra, ...more,
    });
    await fn({ root, srv, mk, logs, base: path.join(root, '.bin', 'codex'), dir: path.join(root, '.bin', 'codex', `${VER}-${TARGET}`) });
  } finally {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('目标识别：Linux x64 / arm64 用 musl 包，Windows x64 用 msvc 包，其余平台 null', () => {
  assert.equal(codexTarget('linux', 'x64'), 'x86_64-unknown-linux-musl');
  assert.equal(codexTarget('linux', 'arm64'), 'aarch64-unknown-linux-musl');
  assert.equal(codexTarget('win32', 'x64'), 'x86_64-pc-windows-msvc');
  for (const [p, a] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'arm64'], ['linux', 'ia32'], ['freebsd', 'x64']]) assert.equal(codexTarget(p, a), null);
  // 固定的三个目标都有包名、64 位十六进制哈希与大小，用的都是 app-server 包
  for (const t of ['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl', 'x86_64-pc-windows-msvc']) {
    const a = CODEX_CLI_ASSETS[t];
    assert.equal(a.asset, `codex-app-server-package-${t}.tar.gz`);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.ok(a.size > 100e6);
  }
});

test('不支持的平台：ensure 返回 null、不报错也不发请求，状态写明不支持', async () => {
  await withEnv(async ({ mk, srv }) => {
    const c = mk({ platform: 'darwin', arch: 'arm64' });
    assert.equal(await c.ensure(), null);
    assert.equal(c.installed(), null);
    const st = c.status();
    assert.equal(st.supported, false);
    assert.equal(st.target, null);
    assert.equal(st.error, null);
    assert.equal(srv.hits.length, 0);
  });
});

test('下载 → 校验 → 解包 → 写 install.json；之后同步查找直接认', async () => {
  await withEnv(async ({ mk, dir, srv }) => {
    const c = mk();
    const seen = [];
    const p = await c.ensure({ onProgress: (x) => seen.push(x) });
    assert.equal(p, path.join(dir, 'bin', 'codex-app-server'));
    assert.ok(readFileSync(p).equals(FAKE_BIN));
    assert.equal(readFileSync(path.join(dir, 'codex-resources', 'bwrap'), 'utf8'), 'bwrap');
    assert.equal(readFileSync(path.join(dir, 'codex-path', 'rg'), 'utf8'), 'rg');
    const stamp = JSON.parse(readFileSync(path.join(dir, 'install.json'), 'utf8'));
    assert.equal(stamp.version, VER);
    assert.equal(stamp.target, TARGET);
    assert.equal(stamp.asset, ASSET);
    assert.equal(stamp.sha256, sha(GOOD));
    assert.equal(stamp.size, GOOD.length);
    assert.equal(stamp.entrypoint, 'bin/codex-app-server');
    assert.deepEqual(stamp.files.map((f) => f.path), ['bin/codex-app-server', 'bin/codex-exec-server', 'codex-package.json', 'codex-path/rg', 'codex-resources/bwrap']);
    assert.ok(stamp.files.every((f) => f.size > 0 && f.mtimeMs > 0));
    assert.ok(seen.length >= 2);
    assert.deepEqual(seen.at(-1), { done: GOOD.length, total: GOOD.length, host: new URL(srv.base).host });
    // 正式目录旁边不留临时目录
    assert.deepEqual(readdirSync(path.dirname(dir)), [path.basename(dir)]);

    const again = mk();   // 新实例（相当于重启）：同步就找得到，不再下载
    assert.equal(again.installed(), p);
    assert.equal(await again.ensure(), p);
    assert.equal(srv.hits.filter((h) => h === 'a').length, 1);
    assert.deepEqual(again.appServer(), { file: p, args: [], version: VER, target: TARGET });
    const st = again.status();
    assert.equal(st.installed, true);
    assert.equal(st.path, p);
    assert.equal(st.downloading, false);
    assert.deepEqual(st.args, []);
  });
});

test('校验不通过：拒装、不留任何文件，报人话错误', async () => {
  const bad = releaseFromSums(SUMS);
  bad.assets[TARGET].sha256 = 'f'.repeat(64);
  await withEnv(async ({ mk, base }) => {
    const c = mk();
    await assert.rejects(c.ensure(), (e) => e.code === 'CODEX_CLI_DOWNLOAD_FAILED' && /校验不通过/.test(e.message));
    assert.equal(c.installed(), null);
    assert.deepEqual(readdirSync(base), []);
    const st = c.status();
    assert.match(st.error, /校验不通过/);
    assert.equal(st.installed, false);
    assert.equal(st.attempts.length, 1);
  }, { release: bad });
});

test('自检版本对不上、包里有越界路径：一样整包作废', async () => {
  await withEnv(async ({ mk, base }) => {
    await assert.rejects(mk({ probeVersion: async () => '0.1.0' }).ensure(), /跑不起来/);
    assert.deepEqual(readdirSync(base), []);
  });
  const evil = gzipSync(makeTar([...goodEntries(), { name: '../escape', data: 'x' }]));
  await withEnv(async ({ mk, base, root }) => {
    await assert.rejects(mk().ensure(), /不安全的路径/);
    assert.deepEqual(readdirSync(base), []);
    assert.equal(existsSync(path.join(root, '.bin', 'escape')), false);
  }, { behave: { a: evil }, release: releaseFromSums(`${sha(evil)}  ${ASSET}\n`, evil) });
  assert.throws(() => safeRel('/etc/passwd'));
  assert.throws(() => safeRel('C:/x'));
  assert.throws(() => safeRel('a/../../b'));
  assert.equal(safeRel('./bin/codex'), 'bin/codex');
});

test('第一个源不通就用第二个；404 与 500 都换', async () => {
  for (const code of [404, 500]) {
    await withEnv(async ({ mk, dir, srv }) => {
      const c = mk();
      assert.equal(await c.ensure(), path.join(dir, 'bin', 'codex-app-server'));
      assert.deepEqual(srv.hits, ['a', 'b']);
      const st = c.status();
      assert.equal(st.attempts.length, 2);
      assert.ok(st.attempts[0].error);
      assert.equal(st.attempts[1].error, null);
      assert.equal(st.error, null);
    }, { behave: { a: code, b: 'ok' }, srcs: ['a', 'b'] });
  }
});

test('嫌慢换源：前面的源太慢就换下一个', async () => {
  await withEnv(async ({ mk, dir, logs }) => {
    assert.equal(await mk().ensure(), path.join(dir, 'bin', 'codex-app-server'));
    assert.ok(logs.some((m) => m.startsWith('换源：') && /太慢/.test(m)));
  }, { behave: { a: 'trickle', b: 'ok' }, srcs: ['a', 'b'], slowWindowMs: 60, slowRate: 1e9, slowRemainS: 0 });
});

test('并发调用只下载一次，大家拿到同一个结果', async () => {
  await withEnv(async ({ mk, srv }) => {
    const c = mk();
    const [x, y, z] = await Promise.all([c.ensure(), c.ensure(), c.ensure({ onProgress: () => {} })]);
    assert.ok(x);
    assert.equal(x, y);
    assert.equal(x, z);
    assert.equal(srv.hits.length, 1);
  });
});

test('撤销：一个人撤只撤自己；所有人都撤了才停下载，临时目录删掉', async () => {
  await withEnv(async ({ mk, base }) => {
    const c = mk();
    const a1 = new AbortController(), a2 = new AbortController();
    const p1 = c.ensure({ signal: a1.signal });
    const p2 = c.ensure({ signal: a2.signal });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(c.status().downloading, true);
    a1.abort();
    await assert.rejects(p1, { name: 'AbortError' });
    assert.equal(c.status().downloading, true);
    a2.abort();
    await assert.rejects(p2, { name: 'AbortError' });
    for (let i = 0; i < 50 && c.status().downloading; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(c.status().downloading, false);
    assert.equal(c.status().error, null);   // 撤销不算失败
    assert.deepEqual(readdirSync(base), []);
  }, { behave: { a: 'hang' } });
});

test('BRIDGE_CODEX_CLI_DOWNLOAD=0 / codexCliDownload:false：ensure 返回 null、不发请求', async () => {
  await withEnv(async ({ mk, srv }) => {
    for (const c of [mk({ env: { BRIDGE_CODEX_CLI_DOWNLOAD: '0' } }), mk({ config: () => ({ codexCliDownload: false }) })]) {
      assert.equal(await c.ensure(), null);
      assert.equal(c.status().enabled, false);
      assert.equal(c.status().installed, false);
    }
    assert.equal(srv.hits.length, 0);
  });
});

test('install.json 坏了、文件被换过：installedCodexCli 返回 null，再 ensure 会重新下', async () => {
  await withEnv(async ({ mk, dir, srv }) => {
    const c = mk();
    const p = await c.ensure();
    const stampFile = path.join(dir, 'install.json');
    const good = readFileSync(stampFile, 'utf8');
    for (const bad of ['{ not json', '[]', 'null', JSON.stringify({ ...JSON.parse(good), sha256: 'e'.repeat(64) }), JSON.stringify({ ...JSON.parse(good), files: 'x' })]) {
      writeFileSync(stampFile, bad);
      assert.equal(c.installed(), null, bad.slice(0, 20));
    }
    rmSync(stampFile);
    assert.equal(c.installed(), null);
    writeFileSync(stampFile, good);
    assert.equal(c.installed(), p);
    writeFileSync(path.join(dir, 'codex-path', 'rg'), 'rg-but-longer');
    assert.equal(c.installed(), null);
    assert.equal(await c.ensure(), p);   // 重新下了一份
    assert.equal(srv.hits.length, 2);
    assert.equal(readFileSync(path.join(dir, 'codex-path', 'rg'), 'utf8'), 'rg');
  });
});

test('进程级导出：注入源与发行信息后走同一套流程', async () => {
  await withEnv(async ({ root, srv, dir }) => {
    _resetForTest({ dataRoot: root, programRoot: null, env: {}, config: () => ({}), platform: 'linux', arch: 'x64', probeVersion: async () => VER, log: () => {} });
    try {
      _setSourcesForTest([srv.src('a')]);
      _setReleaseForTest(releaseFromSums(SUMS));
      assert.equal(installedCodexCli(), null);
      assert.equal(codexCliStatus().installed, false);
      const p = await ensureCodexCli();
      assert.equal(p, path.join(dir, 'bin', 'codex-app-server'));
      assert.equal(installedCodexCli(), p);
      assert.deepEqual(installedCodexAppServer(), { file: p, args: [], version: VER, target: TARGET });
      assert.equal(codexCliStatus().path, p);
    } finally { _resetForTest(); }
  });
});

const ENTRY = 'bin/codex-app-server';
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const ls = (d) => (existsSync(d) ? readdirSync(d) : []);

test('程序目录里预装的那份：mtime 被截到整秒（镜像层）或整目录拷过来也认，按每文件哈希重认；内容被换就不认', async () => {
  await withEnv(async ({ mk, root, logs }) => {
    await mk().ensure();
    const prog = path.join(root, 'prog'), data2 = path.join(root, 'data2');
    cpSync(path.join(root, '.bin'), path.join(prog, '.bin'), { recursive: true });   // 不保留时间：相当于拷贝
    const pdir = path.join(prog, '.bin', 'codex', `${VER}-${TARGET}`);
    const entry = path.join(pdir, ...ENTRY.split('/'));
    const sec = Math.floor(statSync(entry).mtimeMs / 1000);
    utimesSync(entry, sec - 7, sec - 7);   // 截到整秒
    const stamp0 = JSON.parse(readFileSync(path.join(pdir, 'install.json'), 'utf8'));
    assert.notEqual(stamp0.files.find((f) => f.path === ENTRY).mtimeMs, (sec - 7) * 1000);

    const c = mk({ dataRoot: data2, programRoot: prog, env: { BRIDGE_CODEX_CLI_DOWNLOAD: '0' } });
    assert.equal(c.installed(), entry);
    assert.ok(logs.some((m) => /重新核对通过/.test(m)));
    assert.equal(await c.ensure(), entry);   // 关了自动下载也照样能用
    // 重认通过后把新 mtime 写回了 install.json：下一个实例直接认，不再读全文件
    const stamp1 = JSON.parse(readFileSync(path.join(pdir, 'install.json'), 'utf8'));
    assert.equal(stamp1.files.find((f) => f.path === ENTRY).mtimeMs, statSync(entry).mtimeMs);
    const n = logs.length;
    assert.equal(mk({ dataRoot: data2, programRoot: prog }).installed(), entry);
    assert.equal(logs.length, n);

    // 同样大小、不同内容（mtime 也变了）：哈希对不上 → 不认
    const rg = path.join(pdir, 'codex-path', 'rg');
    writeFileSync(rg, 'gr');
    utimesSync(rg, sec - 100, sec - 100);
    const c2 = mk({ dataRoot: data2, programRoot: prog, env: { BRIDGE_CODEX_CLI_DOWNLOAD: '0' } });
    assert.equal(c2.installed(), null);
    assert.equal(await c2.ensure(), null);
    // 没有每文件哈希的旧记录：没法重认，不认
    writeFileSync(rg, 'rg');
    const legacy = JSON.parse(readFileSync(path.join(pdir, 'install.json'), 'utf8'));
    for (const f of legacy.files) delete f.sha256;
    writeFileSync(path.join(pdir, 'install.json'), JSON.stringify(legacy));
    assert.equal(mk({ dataRoot: data2, programRoot: prog }).installed(), null);
  });
});

test('离线：数据卷里放了官方压缩包就用它（关了自动下载也认），不发请求，装好后压缩包清掉；放错了就不装', async () => {
  await withEnv(async ({ mk, base, dir, srv }) => {
    mkdirSync(base, { recursive: true });
    const pkg = path.join(base, ASSET);
    writeFileSync(pkg, Buffer.alloc(GOOD.length, 1));   // 大小对、内容不对
    const off = { env: { BRIDGE_CODEX_CLI_DOWNLOAD: '0' } };
    await assert.rejects(mk(off).ensure(), /已损坏|校验不通过/);
    assert.equal(existsSync(dir), false);
    writeFileSync(pkg, Buffer.alloc(GOOD.length - 1));   // 大小都不对：不当一个源
    assert.equal(await mk(off).ensure(), null);
    writeFileSync(pkg, GOOD);
    const c = mk(off);
    assert.equal(await c.ensure(), path.join(dir, ...ENTRY.split('/')));
    assert.equal(srv.hits.length, 0);
    assert.equal(c.status().attempts[0].host, '本地压缩包');
    assert.deepEqual(ls(base), [path.basename(dir)]);
  });
  // 开着自动下载时本地那份坏了，接着走下载源
  await withEnv(async ({ mk, base, dir, srv }) => {
    mkdirSync(base, { recursive: true });
    writeFileSync(path.join(base, ASSET), Buffer.alloc(GOOD.length, 2));
    assert.equal(await mk().ensure(), path.join(dir, ...ENTRY.split('/')));
    assert.deepEqual(srv.hits, ['a']);
  });
});

test('撤销后立刻重试：另起一份下载，不会拿到上一份的 AbortError', async () => {
  const behave = { a: 'hang' };
  await withEnv(async ({ mk, dir, base }) => {
    const c = mk();
    const ac = new AbortController();
    const p1 = c.ensure({ signal: ac.signal });
    await tick(150);
    ac.abort();
    behave.a = 'ok';
    const p2 = c.ensure();   // 旧的那份还在收尾
    await assert.rejects(p1, { name: 'AbortError' });
    assert.equal(await p2, path.join(dir, ...ENTRY.split('/')));
    for (let i = 0; i < 50 && c.status().downloading; i++) await tick(20);
    assert.equal(c.status().error, null);
    assert.deepEqual(ls(base), [path.basename(dir)]);
  }, { behave });
});

test('重下期间状态不挂上一次的失败原因', async () => {
  const behave = { a: 500 };
  await withEnv(async ({ mk }) => {
    const c = mk();
    await assert.rejects(c.ensure(), /HTTP 500/);
    assert.match(c.status().error, /HTTP 500/);
    behave.a = 'hang';
    const ac = new AbortController();
    const p = c.ensure({ signal: ac.signal });
    for (let i = 0; i < 150 && !(c.status().progress?.done > 0); i++) await tick(20);
    const st = c.status();
    assert.equal(st.downloading, true);
    assert.equal(st.error, null);
    assert.ok(st.progress && st.progress.done > 0);
    ac.abort();
    await assert.rejects(p, { name: 'AbortError' });
  }, { behave });
});

test('嫌慢换走以后别的源都不行：回到嫌慢里最快的那个下完', async () => {
  await withEnv(async ({ mk, dir, srv, logs }) => {
    assert.equal(await mk().ensure(), path.join(dir, ...ENTRY.split('/')));
    assert.deepEqual(srv.hits, ['a', 'b', 'a']);
    assert.ok(logs.some((m) => /回到最快的/.test(m)));
  }, { behave: { a: 'trickle', b: 500 }, srcs: ['a', 'b'], slowWindowMs: 60, slowRate: 1e9, slowRemainS: 0 });
});

test('连接超时与下载停住：报人话、换源，不留临时目录', async () => {
  await withEnv(async ({ mk, base }) => {
    await assert.rejects(mk().ensure(), /连接下载源超时/);
    assert.deepEqual(ls(base), []);
  }, { behave: { a: 'nohead' }, connectTimeoutMs: 150 });
  await withEnv(async ({ mk, base }) => {
    await assert.rejects(mk().ensure(), /停住了/);
    assert.deepEqual(ls(base), []);
  }, { behave: { a: 'hang' }, stallTimeoutMs: 150 });
  await withEnv(async ({ mk, dir, srv }) => {
    assert.equal(await mk().ensure(), path.join(dir, ...ENTRY.split('/')));
    assert.deepEqual(srv.hits, ['a', 'b']);
  }, { behave: { a: 'hang', b: 'now' }, srcs: ['a', 'b'], stallTimeoutMs: 400 });   // b 的内容随应答头一起到，机器再忙也不会被判停住
});

test('大小上限：报的长度不对直接拒；不报长度一直发的，超过固定大小当场停；解开后大得离谱（gzip 炸弹）也停', async () => {
  await withEnv(async ({ mk, base, srv }) => {
    await assert.rejects(mk().ensure(), /校验不通过/);
    assert.deepEqual(ls(base), []);
    assert.equal(srv.hits.length, 1);
  }, { behave: { a: Buffer.concat([GOOD, Buffer.alloc(10)]) } });
  await withEnv(async ({ mk, base }) => {
    await assert.rejects(mk().ensure(), /校验不通过/);   // 没有这道上限会一直收下去，测试会卡死
    assert.deepEqual(ls(base), []);
  }, { behave: { a: 'endless' } });
  const bomb = gzipSync(makeTar([{ name: 'bin/', dir: true }, { name: ENTRY, data: Buffer.alloc(4 << 20), mode: '0000755' }]));
  await withEnv(async ({ mk, base }) => {
    await assert.rejects(mk().ensure(), /大得不正常/);
    assert.deepEqual(ls(base), []);
  }, { behave: { a: bomb }, release: releaseFromSums(`${sha(bomb)}  ${ASSET}\n`, bomb) });
});

test('上游 PAX 格式的包（每个条目带扩展头、补齐到 10240 字节）照样装得上', async () => {
  const paxPkg = gzipSync(makeTar(goodEntries(), { pax: true }));
  await withEnv(async ({ mk, dir }) => {
    const p = await mk().ensure();
    assert.equal(p, path.join(dir, ...ENTRY.split('/')));
    assert.ok(readFileSync(p).equals(FAKE_BIN));
    const stamp = JSON.parse(readFileSync(path.join(dir, 'install.json'), 'utf8'));
    assert.deepEqual(stamp.files.map((f) => f.path), ['bin/codex-app-server', 'bin/codex-exec-server', 'codex-package.json', 'codex-path/rg', 'codex-resources/bwrap']);
    assert.ok(stamp.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
    assert.equal(stamp.files.find((f) => f.path === 'codex-path/rg').sha256, sha(Buffer.from('rg')));
  }, { behave: { a: paxPkg }, release: releaseFromSums(`${sha(paxPkg)}  ${ASSET}\n`, paxPkg) });
});

test('换进正式目录失败（旧的那份被占着）：旧安装原样留着、临时目录删掉、不再换源；短暂占用会重试过去', async () => {
  await withEnv(async ({ mk, base, dir, srv }) => {
    await mk().ensure();
    const rg = path.join(dir, 'codex-path', 'rg');
    writeFileSync(rg, 'rg-changed');   // 让它重下
    const busy = (times) => {
      let n = 0;
      return (a, b) => {
        if (path.basename(a).startsWith('.staging-') && n++ < times) throw Object.assign(new Error('busy'), { code: 'EPERM' });
        renameSync(a, b);
      };
    };
    await assert.rejects(mk({ rename: busy(Infinity), swapRetryMs: [0, 0] }).ensure(), /换不进/);
    assert.deepEqual(ls(base), [path.basename(dir)]);
    assert.equal(readFileSync(rg, 'utf8'), 'rg-changed');
    assert.equal(srv.hits.length, 2);   // 失败一次就停，没有拿别的源再下一遍

    const c = mk({ rename: busy(2), swapRetryMs: [0, 0] });
    assert.equal(await c.ensure(), path.join(dir, ...ENTRY.split('/')));
    assert.equal(readFileSync(rg, 'utf8'), 'rg');
    assert.deepEqual(ls(base), [path.basename(dir)]);   // .old-* 也清了
  }, { behave: { a: 'ok', b: 'ok' }, srcs: ['a', 'b'] });
});

test('自检：用临时 CODEX_HOME（用完删），撤销时立刻停', async () => {
  let seen = null;
  await withEnv(async ({ mk, base }) => {
    await mk({ probeVersion: async (file, o) => { seen = { file, home: o.env.CODEX_HOME, exists: existsSync(o.env.CODEX_HOME), signal: o.signal }; return VER; } }).ensure();
    assert.ok(seen.exists);
    assert.ok(seen.signal instanceof AbortSignal);
    assert.notEqual(seen.home, process.env.CODEX_HOME);
    assert.equal(existsSync(seen.home), false);
    assert.equal(path.dirname(seen.home), base);
    assert.ok(!seen.home.startsWith(path.dirname(path.dirname(seen.file)) + path.sep));   // 不在要挪进正式目录的那份里面
  });
  await withEnv(async ({ mk, base }) => {
    const ac = new AbortController();
    let started = false;
    const c = mk({ probeVersion: (file, o) => new Promise((resolve, reject) => { started = true; o.signal.addEventListener('abort', () => reject(o.signal.reason)); }) });
    const p = c.ensure({ signal: ac.signal });
    for (let i = 0; i < 100 && !started; i++) await tick(10);
    assert.ok(started);
    ac.abort();
    await assert.rejects(p, { name: 'AbortError' });
    for (let i = 0; i < 50 && c.status().downloading; i++) await tick(20);
    assert.deepEqual(ls(base), []);
  });
});

test('Linux 上解开的可执行文件是 0755、其余不带执行位', { skip: process.platform === 'win32' && 'Windows 没有 Unix 权限位' }, async () => {
  await withEnv(async ({ mk, dir }) => {
    await mk().ensure();
    const mode = (rel) => statSync(path.join(dir, ...rel.split('/'))).mode & 0o777;
    assert.equal(mode(ENTRY), 0o755);
    assert.equal(mode('codex-path/rg'), 0o755);
    assert.equal(mode('codex-resources/bwrap'), 0o755);
    assert.equal(mode('codex-package.json') & 0o111, 0);
  });
});

// 真实下载：从官方源把本机目标的包整个下下来、解开、跑 --version 自检。要连外网（约 150～180MB），BRIDGE_CODEX_IT=1 才跑；
// 走代理时同时设 NODE_USE_ENV_PROXY=1 与 HTTPS_PROXY。
test('集成：真实下载并自检本机目标的发行包', { skip: process.env.BRIDGE_CODEX_IT !== '1' && '设 BRIDGE_CODEX_IT=1 才跑', timeout: 15 * 60_000 }, async () => {
  if (!codexTarget()) return;
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-cli-test-'));
  try {
    const c = createCodexCli({ dataRoot: root, programRoot: null, env: {}, config: () => ({}), log: (m) => console.log('[it] ' + m) });
    const p = await c.ensure();
    assert.ok(p && existsSync(p));
    const dir = path.dirname(path.dirname(p));
    console.log('[it] codex-package.json', readFileSync(path.join(dir, 'codex-package.json'), 'utf8'));
    const stamp = JSON.parse(readFileSync(path.join(dir, 'install.json'), 'utf8'));
    console.log('[it] 解开后', stamp.files.length, '个文件，共', stamp.files.reduce((a, f) => a + f.size, 0), '字节');
    for (const f of stamp.files) console.log('[it]  ', f.path, f.size);
    assert.equal(createCodexCli({ dataRoot: root, programRoot: null, env: {}, config: () => ({}) }).installed(), p);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
