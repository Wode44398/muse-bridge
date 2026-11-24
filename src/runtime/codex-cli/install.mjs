// 从一个下载源拉一份发行包：边收边算 sha256、边 gunzip 边解到临时目录，校验、自检都过了才由调用方挪到正式位置。
// 失败一律删掉临时目录，不留半截安装。

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { walkTar } from '../tar-stream.mjs';

export const CONNECT_TIMEOUT = 20_000;   // 等响应头
export const STALL_TIMEOUT = 60_000;     // 下载中这么久没有新数据就换源
export const SLOW_WINDOW = 15_000;       // 嫌慢换源：每这么久量一次最近这段的速度
export const SLOW_RATE = 300 * 1024;     //   低于这个速度（字节 / 秒）……
export const SLOW_REMAIN = 120;          //   ……且照这速度还要下这么多秒以上，就换下一个源
// 解开后的总字节上限 = 压缩包大小 × 这个倍数。真包里是 Rust 程序，gzip 压缩比在 2～3 倍；超出说明源给的不是那个包
// （或是 gzip 炸弹），不等收完做哈希就先停下，免得把磁盘写满。
export const UNPACK_RATIO = 8;

export const MB = (n) => Math.round((n || 0) / 1048576);
export const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u || ''); } };

export class DlError extends Error {
  constructor(kind, info = {}) { super(kind); this.kind = kind; Object.assign(this, info); }
}

// 下载出错 → 人话。
export function humanError(e, { host = '', dir = '', size = 0, stallMs = STALL_TIMEOUT } = {}) {
  const kind = e instanceof DlError ? e.kind : '';
  const code = e && (e.code || e.cause?.code);
  if (kind === 'connect-timeout' || (e && e.name === 'TimeoutError')) return `连接下载源超时（${host}）`;
  if (kind === 'stall') return `下载停住了：${Math.round(stallMs / 1000)} 秒没有收到新数据（${host}）`;
  if (kind === 'slow') return `下载太慢（约 ${Math.round((e.rate || 0) / 1024)} KB/s，${host}），已换下一个下载源`;
  if (kind === 'not-found') return `下载源上没有 Codex 运行组件 ${e.asset || ''}（${host}）`.replace(/  +/g, ' ');
  if (kind === 'http') return `下载源回了 HTTP ${e.status}（${host}）`;
  if (kind === 'checksum') return '下载的 Codex 运行组件校验不通过（可能不完整或被改动过），已丢弃';
  if (kind === 'too-big') return `下载的 Codex 运行组件解开后大得不正常（超过 ${MB(size * UNPACK_RATIO)} MB），已丢弃`;
  if (kind === 'swap') return `新下的 Codex 运行组件换不进 ${e.detail || dir}（旧的那份可能正在运行），稍后再试`;
  if (kind === 'layout') return `下载的包里缺少 Codex 程序（${e.detail || ''}）`.replace('（）', '');
  if (kind === 'bad-entry') return `下载的包里有不安全的路径（${e.detail || ''}），已丢弃`;
  if (kind === 'selfcheck') return `Codex 运行组件在本机跑不起来（${e.detail || '自检没有输出版本号'}）`;
  if (code === 'Z_BUF_ERROR' || code === 'Z_DATA_ERROR') return '下载的 Codex 运行组件不完整或已损坏，已丢弃';
  if (code === 'ENOSPC') return `磁盘空间不够：Codex 运行组件需要约 ${MB(size * 3) || 500} MB`;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return `没有权限写入 ${dir}`;
  if (code && /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|CERT_|UNABLE_TO|SELF_SIGNED)/.test(code)) return `连不上下载源（${host}）`;
  if (e && /fetch failed|network|socket/i.test(String(e.message || ''))) return `连不上下载源（${host}）`;
  return `下载失败：${String((e && e.message) || e || '').slice(0, 200)}`;
}

// 包里的路径 → 相对路径（'/' 分隔）；越出解包目录的（绝对路径、..、盘符、反斜杠）一律拒收，整包作废。
export function safeRel(name) {
  let n = String(name || '');
  while (n.startsWith('./')) n = n.slice(2);
  n = n.replace(/\/+$/, '');
  if (!n || n === '.') return '';
  if (n.startsWith('/') || n.includes('\\') || /^[A-Za-z]:/.test(n) || n.includes('\0')) throw new DlError('bad-entry', { detail: name });
  const parts = n.split('/');
  if (parts.some((p) => p === '..' || p === '' || p === '.')) throw new DlError('bad-entry', { detail: name });
  return parts.join('/');
}

function waitDrain(ws) {
  return new Promise((resolve, reject) => {
    const done = (err) => { ws.off('drain', ok); ws.off('error', done); err ? reject(err) : resolve(); };
    const ok = () => done();
    ws.on('drain', ok);
    ws.on('error', done);
  });
}

// `<程序> --version`：带超时，超时或 signal 撤销都由 execFile 结束子进程。env 由调用方给（自检用临时 CODEX_HOME）。
export function probeVersion(file, { signal, env } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true, signal, env: env || process.env }, (err, stdout, stderr) => {
        const out = String(stdout || '') + String(stderr || '');
        const m = /(\d+\.\d+\.\d+)/.exec(out);
        resolve(m ? m[1] : null);
      });
    } catch { resolve(null); }
  });
}

// 本地压缩包（离线部署放进数据卷的那份）当成一个下载源：返回和 fetch 一样形状的应答，后面同一套校验。
export function fileResponse(file, signal) {
  const rs = createReadStream(file, { signal });
  return { status: 200, ok: true, headers: new Headers({ 'content-length': String(statSync(file).size) }), body: Readable.toWeb(rs) };
}

// 一次下载 + 解包 + 校验 + 自检。成功返回 { files, from }（文件已在 staging 里、install.json 已写好）；失败抛错并删掉 staging。
// ctx：{ url, staging, release, target, expect, entrypoint, fetch, signal, skipIfSlow, timeouts, probe, onProgress, log }
export async function fetchAndUnpack(ctx) {
  const { url, staging, expect, entrypoint, target, release } = ctx;
  const t = ctx.timeouts || {};
  const host = hostOf(url);
  const ac = new AbortController();
  const outer = ctx.signal;
  const onOuter = () => ac.abort(outer.reason);
  if (outer) { if (outer.aborted) onOuter(); else outer.addEventListener('abort', onOuter, { once: true }); }
  let timer = setTimeout(() => ac.abort(new DlError('connect-timeout')), t.connectTimeoutMs || CONNECT_TIMEOUT);
  let slowTimer = null;
  let body = null, gunzipRef = null;
  const open = new Set();   // 还没关的写入流：出错时关掉再删目录（Windows 上开着的文件删不掉）
  try {
    const res = await ctx.fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (res.status === 404) throw new DlError('not-found', { asset: expect.asset });
    if (!res.ok || !res.body) throw new DlError('http', { status: res.status });
    // 源报的长度和固定大小对不上：不是那个包，不必下完再发现（带 content-encoding 时长度是编码后的，不比）
    const len = Number(res.headers?.get?.('content-length'));
    if (!res.headers?.get?.('content-encoding') && len > 0 && len !== expect.size) throw new DlError('checksum', { got: len });
    let got = 0, nextLog = 0.1;
    const report = () => {
      const p = { done: Math.min(got, expect.size), total: expect.size, host };
      ctx.onProgress?.(p);
      const f = p.done / p.total;
      if (f >= nextLog) {
        ctx.log?.(`下载中 ${Math.floor(f * 100)}%（${MB(p.done)} / ${MB(p.total)} MB，${host}）`);
        nextLog = Math.floor(f * 10) / 10 + 0.1;
      }
    };
    report();
    const stall = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(new DlError('stall')), t.stallTimeoutMs || STALL_TIMEOUT); };
    stall();
    if (ctx.skipIfSlow) {
      const minRate = t.slowRate || SLOW_RATE;
      let markAt = Date.now(), markGot = 0;
      slowTimer = setInterval(() => {
        const now = Date.now();
        const rate = ((got - markGot) * 1000) / Math.max(1, now - markAt);
        markAt = now;
        markGot = got;
        if (rate < minRate && (expect.size - got) / Math.max(rate, 1) > (t.slowRemainS ?? SLOW_REMAIN)) ac.abort(new DlError('slow', { rate }));
      }, t.slowWindowMs || SLOW_WINDOW);
      slowTimer.unref?.();
    }
    mkdirSync(staging, { recursive: true });
    const hash = createHash('sha256');
    body = Readable.fromWeb(res.body);
    const gunzip = (gunzipRef = createGunzip());
    // 数解开后的字节：超过上限就停，连归档结尾之后被读干的尾巴也算在内
    const limit = expect.size * UNPACK_RATIO;
    let unpacked = 0;
    const counter = new Transform({
      transform(c, _enc, cb) { unpacked += c.length; if (unpacked > limit) cb(new DlError('too-big', { unpacked })); else cb(null, c); },
    });
    gunzip.on('error', (e) => counter.destroy(e));   // 错误交给 walkTar 的 for await 接住；提前收尾后迟到的错误别成了未处理事件
    counter.on('error', () => {});
    body.on('data', (c) => {
      got += c.length;
      // 比固定大小多：源给的不是那个包，马上停（不然一个坏源能一直往临时目录里写）
      if (got > expect.size) { ac.abort(new DlError('checksum', { got })); return; }
      hash.update(c); stall(); report();
    });
    const bodyDone = finished(body);
    bodyDone.catch(() => {});
    body.on('end', () => clearInterval(slowTimer));   // 收完了，剩下的只是解包，不再嫌慢
    body.on('error', (e) => gunzip.destroy(ac.signal.aborted && ac.signal.reason ? ac.signal.reason : e));
    body.pipe(gunzip).pipe(counter);

    const files = new Map();   // rel → { size, exec, sha256 }
    await walkTar(counter, (e) => {
      const rel = safeRel(e.name);
      if (!rel) return null;
      const abs = path.join(staging, ...rel.split('/'));
      if (e.type === '5') { mkdirSync(abs, { recursive: true }); return null; }
      if (!(e.type === '0' || e.type === '7')) {   // 链接、设备等：发行包里没有，碰到就跳过
        if (e.type === '1' || e.type === '2') ctx.log?.(`跳过包里的链接 ${rel}`);
        return null;
      }
      mkdirSync(path.dirname(abs), { recursive: true });
      const exec = (e.mode & 0o111) !== 0 || rel === entrypoint;
      const ws = createWriteStream(abs, { mode: exec ? 0o755 : 0o644 });
      open.add(ws);
      let wsErr = null;
      ws.on('error', (err) => { wsErr = err; });
      let size = 0;
      const fh = createHash('sha256');   // 每个文件的哈希记进 install.json：mtime 变了（镜像层截到整秒、拷贝）时靠它重认
      return {
        data: async (b) => {
          if (wsErr) throw wsErr;
          size += b.length;
          fh.update(b);
          if (!ws.write(b)) await waitDrain(ws);
        },
        end: async () => {
          if (wsErr) throw wsErr;
          ws.end();
          await finished(ws);   // 等到文件句柄关掉：Windows 上开着的文件没法挪目录
          open.delete(ws);
          files.set(rel, { size, exec, sha256: fh.digest('hex') });
        },
      };
    }, { drain: true });
    await bodyDone;
    clearTimeout(timer);
    clearInterval(slowTimer);

    const sum = hash.digest('hex');
    if (got !== expect.size || sum !== expect.sha256) throw new DlError('checksum', { got, sum });
    if (!files.has(entrypoint)) throw new DlError('layout', { detail: entrypoint });
    // 包自带的布局说明：入口与目标对不上说明拿错了包
    const meta = files.has('codex-package.json') ? JSON.parse(readFileSync(path.join(staging, 'codex-package.json'), 'utf8')) : null;
    if (meta && ((meta.entrypoint && meta.entrypoint !== entrypoint) || (meta.target && meta.target !== target) || (meta.version && meta.version !== release.version))) {
      throw new DlError('layout', { detail: `codex-package.json: ${meta.entrypoint} / ${meta.target} / ${meta.version}` });
    }
    const entryAbs = path.join(staging, ...entrypoint.split('/'));
    if (process.platform !== 'win32') {
      for (const [rel, f] of files) if (f.exec) chmodSync(path.join(staging, ...rel.split('/')), 0o755);
    }
    if (ctx.probe) {
      // 自检也会先跑上游的 arg0 初始化（可能在 CODEX_HOME 下建临时文件）：给它一个用完就删的 home，
      // 不碰服务端用户自己的 ~/.codex。放在 staging 旁边而不是里面，免得跟着挪进正式目录。
      const home = staging + '.home';
      let v = null;
      try {
        mkdirSync(home, { recursive: true });
        v = await ctx.probe(entryAbs, { signal: ac.signal, env: { ...process.env, CODEX_HOME: home } });
      } catch (err) {
        if (ac.signal.aborted) throw ac.signal.reason;
        throw new DlError('selfcheck', { detail: String(err?.message || err).slice(0, 120) });
      } finally { rmSync(home, { recursive: true, force: true }); }
      if (ac.signal.aborted) throw ac.signal.reason;
      if (v !== release.version) throw new DlError('selfcheck', { detail: v ? `版本是 ${v}，应为 ${release.version}` : '' });
    }
    const list = [...files.keys()].sort().map((rel) => {
      const st = statSync(path.join(staging, ...rel.split('/')));
      return { path: rel, size: st.size, mtimeMs: st.mtimeMs, sha256: files.get(rel).sha256 };
    });
    writeFileSync(path.join(staging, 'install.json'), JSON.stringify({
      version: release.version, target, asset: expect.asset, sha256: sum, size: got, entrypoint, args: [],
      files: list, from: host, at: Date.now(),
    }, null, 2));
    return { files: list, from: host };
  } catch (e) {
    clearTimeout(timer);
    clearInterval(slowTimer);
    const err = ac.signal.aborted && ac.signal.reason !== undefined ? ac.signal.reason : e;
    if (!ac.signal.aborted) ac.abort(err);
    try { body?.destroy(); } catch {}
    try { gunzipRef?.destroy(); } catch {}
    for (const ws of open) { ws.destroy(); await finished(ws).catch(() => {}); }
    rmSync(staging, { recursive: true, force: true });
    throw err;
  } finally {
    outer?.removeEventListener?.('abort', onOuter);
  }
}
