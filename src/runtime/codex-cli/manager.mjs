// Codex 运行组件的查找与按需下载（见 ../codex-cli.mjs 的说明）。
// 参数都可选（测试注入）：dataRoot、programRoot、env、config()、fetch、sources（URL 模板数组，整个替换默认源）、
// release（{ version, assets }）、platform / arch（决定下哪个目标）、probeVersion(file)（自检；null = 不自检）、log、
// 以及 connectTimeoutMs / stallTimeoutMs / slowWindowMs / slowRate / slowRemainS、rename（换目录用的 renameSync）、
// swapRetryMs（换目录遇到占用时每次重试前等多久的数组）。

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DATA_ROOT, PROGRAM_ROOT } from '../paths.mjs';
import { APP_SERVER_ARGS, CODEX_CLI_ASSETS, CODEX_CLI_VERSION, DEFAULT_SOURCES, codexTarget, entrypointOf } from './release.mjs';
import { DlError, MB, STALL_TIMEOUT, fetchAndUnpack, fileResponse, hostOf, humanError, probeVersion } from './install.mjs';

const readJson = (f) => { const raw = readFileSync(f, 'utf8'); return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); };
const STAGING = '.staging-';
const OLD = '.old-';
const STALE_STAGING = 6 * 3600_000;   // 别的进程留下、这么久没动的临时目录才清（同一数据根上可能有另一个实例正在下）
const SWAP_RETRY = [100, 300, 1000];  // Windows 上杀毒软件扫新 exe 时改名会短暂 EPERM / EBUSY
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// installed() 是同步的，重认也只能同步读；只在 mtime 对不上时走这条，每个目录每种状态只读一次（见 verifiedCache）。
function hashFileSync(f) {
  const h = createHash('sha256');
  const fd = openSync(f, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return h.digest('hex');
}

export function createCodexCli(opts = {}) {
  const env = opts.env || process.env;
  const dataRoot = opts.dataRoot || DATA_ROOT;
  const programRoot = opts.programRoot === undefined ? PROGRAM_ROOT : opts.programRoot;
  const readConfig = opts.config || (() => { try { return readJson(path.join(dataRoot, 'config.json')); } catch { return {}; } });
  const netFetch = opts.fetch || ((...a) => fetch(...a));
  const fetchImpl = (url, init) => (url.startsWith('file:') ? Promise.resolve(fileResponse(fileURLToPath(url), init?.signal)) : netFetch(url, init));
  const rename = opts.rename || renameSync;
  const swapRetry = opts.swapRetryMs || SWAP_RETRY;
  const log = opts.log || ((m) => console.log('[codex-cli] ' + m));
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  let release = opts.release || { version: CODEX_CLI_VERSION, assets: CODEX_CLI_ASSETS };
  let sourceOverride = opts.sources || null;

  const target = codexTarget(platform, arch);
  const entrypoint = target ? entrypointOf(target) : null;
  // 自检只在包确实能在本机跑时做（测试里冒充 Linux 目标就跑不了）
  const runnable = target && target === codexTarget(process.platform, process.arch);
  const probe = opts.probeVersion !== undefined ? opts.probeVersion : (runnable ? probeVersion : null);

  const expect = () => (target ? release.assets?.[target] || null : null);
  const baseOf = (root) => path.join(root, '.bin', 'codex');
  const dirOf = (root) => path.join(baseOf(root), `${release.version}-${target}`);
  const cfg = () => { try { return readConfig() || {}; } catch { return {}; } };
  const downloadEnabled = () => env.BRIDGE_CODEX_CLI_DOWNLOAD !== '0' && cfg().codexCliDownload !== false;
  // 自定义源（环境变量逗号分隔的 URL 模板）排最前；opts.sources / _setSourcesForTest 整个替换
  const sources = () => {
    if (sourceOverride) return sourceOverride;
    const custom = String(env.BRIDGE_CODEX_CLI_SOURCES || '').split(',').map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
    return [...new Set([...custom, ...DEFAULT_SOURCES])];
  };
  const urlOf = (tpl, ex) => tpl.replaceAll('{version}', release.version).replaceAll('{asset}', ex.asset);

  // 重认的结果按「目录 + 各文件当前 mtime」记住：同一状态不再重读几百 MB，文件再被动过签名就变了、会重认。
  const verifiedCache = new Map();

  // 某个根下装好的那份：install.json 每一项都要和固定的发行信息对得上，清单里的文件都在、大小一致。
  // 文件的 mtime 也和记录一致才直接认；对不上（镜像层把 mtime 截到整秒、整目录拷进数据卷）就按记录的
  // 每文件 sha256 重算一遍，全对就认并把新 mtime 写回 install.json（写不了也没事，结果记在内存里）。
  // 有一项对不上 → null（下次 ensure 重新下）。
  function installedIn(root) {
    const ex = expect();
    if (!ex || !root) return null;
    const dir = dirOf(root);
    const stampFile = path.join(dir, 'install.json');
    let stamp;
    try { stamp = readJson(stampFile); } catch { return null; }
    if (!stamp || typeof stamp !== 'object') return null;
    if (stamp.version !== release.version || stamp.target !== target || stamp.asset !== ex.asset
      || stamp.sha256 !== ex.sha256 || stamp.size !== ex.size || stamp.entrypoint !== entrypoint || !Array.isArray(stamp.files)) return null;
    let entry = null;
    const moved = [];
    const sig = [dir];
    for (const f of stamp.files) {
      if (!f || typeof f.path !== 'string' || !(f.size >= 0) || !/^[0-9a-f]{64}$/.test(String(f.sha256 || ''))) return null;
      const abs = path.join(dir, ...f.path.split('/'));
      let st;
      try { st = statSync(abs); } catch { return null; }
      if (!st.isFile() || st.size !== f.size) return null;
      if (Math.abs(Number(f.mtimeMs) - st.mtimeMs) >= 2) moved.push({ f, abs, mtimeMs: st.mtimeMs });
      sig.push(st.mtimeMs);
      if (f.path === entrypoint) entry = abs;
    }
    if (!entry || !moved.length) return entry;
    const key = sig.join('|');
    if (verifiedCache.has(key)) return verifiedCache.get(key) ? entry : null;
    let ok = true;
    try { ok = moved.every((m) => hashFileSync(m.abs) === m.f.sha256); } catch { ok = false; }
    verifiedCache.set(key, ok);
    if (!ok) return null;
    for (const m of moved) m.f.mtimeMs = m.mtimeMs;
    try { writeFileSync(stampFile, JSON.stringify(stamp, null, 2)); } catch {}
    log(`Codex ${release.version} 的文件时间变了（拷贝或镜像打包），按记录的哈希重新核对通过：${dir}`);
    return entry;
  }

  // 数据根优先；镜像构建时预装（WITH_CODEX_CLI=1）的那份在程序目录里。
  function installed() {
    if (!target) return null;
    return installedIn(dataRoot) || (programRoot && path.resolve(programRoot) !== path.resolve(dataRoot) ? installedIn(programRoot) : null);
  }

  // 离线部署放进数据卷的官方压缩包：<数据根>/.bin/codex/<包名>，大小对得上才当一个源（照样按 sha256 校验）。
  function localPackage() {
    const ex = expect();
    if (!ex) return null;
    const f = path.join(baseOf(dataRoot), ex.asset);
    try { return statSync(f).size === ex.size ? f : null; } catch { return null; }
  }

  let job = null;             // 进行中的下载：{ promise, ac, waiters:Set, progress }
  let lastErr = null;
  let attempts = [];

  // 收尾：清掉别的版本与早就没人管的临时目录（正在用的被锁着删不掉就算了，下次再清）。
  function cleanupOld(keepDir) {
    const base = path.dirname(keepDir);
    let names = [];
    try { names = readdirSync(base); } catch { return; }
    for (const n of names) {
      const p = path.join(base, n);
      if (p === keepDir) continue;
      if (n.startsWith(STAGING)) {
        try { if (Date.now() - statSync(p).mtimeMs < STALE_STAGING) continue; } catch { continue; }
      }
      try { rmSync(p, { recursive: true, force: true }); } catch {}
    }
  }

  // 换进正式目录：旧的先挪到 .old-*（失败就原样挪回去），新的再改名进来；占用导致的失败短暂重试几次。
  // 不先删旧目录：删到一半失败会留下残缺的正式目录。.old-* 由 cleanupOld 清（还被占着就下次再清）。
  async function swapIn(staging, finalDir) {
    const tryRename = async (a, b) => {
      for (let i = 0; ; i++) {
        try { rename(a, b); return; } catch (e) {
          if (!BUSY.has(e?.code) || i >= swapRetry.length) throw e;
          await sleep(swapRetry[i]);
        }
      }
    };
    const old = existsSync(finalDir) ? path.join(path.dirname(finalDir), `${OLD}${path.basename(finalDir)}-${process.pid}-${randomBytes(4).toString('hex')}`) : null;
    if (old) await tryRename(finalDir, old);
    try { await tryRename(staging, finalDir); } catch (e) {
      if (old) { try { rename(old, finalDir); } catch {} }
      throw e;
    }
  }

  async function obtain(ac, setProgress) {
    const ex = expect();
    const finalDir = dirOf(dataRoot);
    const t = {
      connectTimeoutMs: opts.connectTimeoutMs, stallTimeoutMs: opts.stallTimeoutMs, slowWindowMs: opts.slowWindowMs,
      slowRate: opts.slowRate, slowRemainS: opts.slowRemainS,
    };
    attempts = [];
    const local = localPackage();
    if (local) log(`用数据卷里的 Codex 压缩包 ${local}（按固定的 sha256 校验）`);
    else log(`本机没有 Codex ${release.version}（${target}），从官方源下载运行组件（约 ${MB(ex.size)} MB，只需一次）`);
    const slow = [];
    let fatal = false;
    let lastError = null;
    const attempt = async (tpl, skipIfSlow) => {
      const url = urlOf(tpl, ex);
      const host = url.startsWith('file:') ? '本地压缩包' : hostOf(url);
      const staging = path.join(baseOf(dataRoot), `${STAGING}${release.version}-${target}-${process.pid}-${randomBytes(4).toString('hex')}`);
      try {
        setProgress({ done: 0, total: ex.size, host });
        await fetchAndUnpack({
          url, staging, release, target, expect: ex, entrypoint, fetch: fetchImpl, signal: ac.signal, skipIfSlow, timeouts: t, probe,
          onProgress: (p) => setProgress(url.startsWith('file:') ? { ...p, host } : p), log,
        });
        try { await swapIn(staging, finalDir); } catch (e) {
          try { rmSync(staging, { recursive: true, force: true }); } catch {}
          fatal = true;   // 换个源下也一样换不进去
          throw new DlError('swap', { detail: finalDir, cause: e });
        }
        attempts.push({ host, error: null });
        cleanupOld(finalDir);
        const bin = installedIn(dataRoot);
        if (!bin) throw new DlError('layout', { detail: '装好后校验记录对不上' });
        log(`已下载并校验 Codex ${release.version}（${host}）→ ${bin}`);
        return bin;
      } catch (e) {
        if (ac.signal.aborted && !(ac.signal.reason instanceof DlError)) throw e;   // 调用方都不等了：不算失败、不再换源
        const msg = humanError(e, { host, dir: baseOf(dataRoot), size: ex.size, stallMs: opts.stallTimeoutMs || STALL_TIMEOUT });
        attempts.push({ host, error: msg });
        lastError = msg;
        const isSlow = e instanceof DlError && e.kind === 'slow';
        if (isSlow) slow.push({ tpl, rate: e.rate || 0 });
        const why = e && !(e instanceof DlError) ? e.message : e?.cause?.message;
        log((isSlow ? '换源：' : '下载失败：') + msg + (why ? '（' + why + '）' : ''));
        if (e && (e.code === 'ENOSPC' || e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS')) fatal = true;
        return null;
      }
    };
    // 本地压缩包排最前；关了自动下载时只认它
    const list = [...(local ? [pathToFileURL(local).href] : []), ...(downloadEnabled() ? sources() : [])];
    // 只对「后面还有源」的嫌慢；最后一个源不嫌慢，下完为止
    for (let i = 0; i < list.length && !fatal; i++) {
      const bin = await attempt(list[i], i < list.length - 1);
      if (bin) return bin;
    }
    if (!fatal && slow.length) {
      const best = slow.sort((a, b) => b.rate - a.rate)[0];
      log(`别的下载源都不行，回到最快的 ${hostOf(best.tpl)} 下完`);
      const bin = await attempt(best.tpl, false);
      if (bin) return bin;
    }
    const err = new Error(lastError || '下载失败');
    err.code = 'CODEX_CLI_DOWNLOAD_FAILED';
    err.attempts = attempts.slice();
    throw err;
  }

  function startJob() {
    const ac = new AbortController();
    const j = { ac, waiters: new Set(), promise: null, progress: null };
    const setProgress = (p) => {
      j.progress = p;
      for (const w of j.waiters) { try { w.onProgress?.({ ...p }); } catch {} }
    };
    j.promise = (async () => {
      try {
        const bin = await obtain(ac, setProgress);
        lastErr = null;
        return bin;
      } catch (e) {
        if (!(ac.signal.aborted && !(ac.signal.reason instanceof DlError))) lastErr = e.message;
        throw e;
      } finally {
        j.progress = null;
        if (job === j) job = null;
      }
    })();
    j.promise.catch(() => {});
    return j;
  }

  // 已装 → 绝对路径；不支持的平台 / 关了自动下载（且数据卷里没放压缩包）→ null；否则下载（同一时间只一份，后来的共享它）。
  // signal 只撤销自己的等待；所有等待的人都撤了才真的停下载。失败抛错（code = CODEX_CLI_DOWNLOAD_FAILED，message 是人话）。
  function ensure({ onProgress, signal } = {}) {
    if (!target || !expect()) return Promise.resolve(null);
    const have = installed();
    if (have) return Promise.resolve(have);
    if (!downloadEnabled() && !localPackage()) return Promise.resolve(null);
    if (signal?.aborted) return Promise.reject(signal.reason);
    // 已被撤销、还在收尾的那份不能再挂上去（会拿到别人的 AbortError）：另起一份，两份的临时目录互不相干
    if (!job || job.ac.signal.aborted) job = startJob();
    const j = job;
    const w = { onProgress };
    j.waiters.add(w);
    if (j.progress && onProgress) { try { onProgress({ ...j.progress }); } catch {} }
    return new Promise((resolve, reject) => {
      const leave = () => {
        j.waiters.delete(w);
        signal?.removeEventListener?.('abort', onAbort);
      };
      const onAbort = () => {
        leave();
        if (!j.waiters.size) j.ac.abort(signal.reason);
        reject(signal.reason);
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      j.promise.then((v) => { leave(); resolve(v); }, (e) => { leave(); reject(e); });
    });
  }

  function status() {
    const ex = expect();
    const p = installed();
    return {
      supported: !!(target && ex),
      target,
      version: release.version,
      installed: !!p,
      path: p,
      downloading: !!job,
      progress: job?.progress ? { ...job.progress } : null,
      error: p || job ? null : lastErr,   // 重下期间不挂上一次的失败原因
      enabled: downloadEnabled(),
      asset: ex?.asset || null,
      size: ex?.size || null,
      entrypoint,
      args: [...APP_SERVER_ARGS],
      attempts: attempts.slice(-4),
    };
  }

  // 给 spawn 用：{ file, args, version, target }；args 要排在其余参数前面（独立 app-server 不认 `app-server` 子命令）。
  function appServer() {
    const file = installed();
    return file ? { file, args: [...APP_SERVER_ARGS], version: release.version, target } : null;
  }

  return {
    installed, ensure, status, appServer,
    _setSources(list) { sourceOverride = list ? [...list] : null; },
    _setRelease(r) { release = r || { version: CODEX_CLI_VERSION, assets: CODEX_CLI_ASSETS }; },
  };
}
