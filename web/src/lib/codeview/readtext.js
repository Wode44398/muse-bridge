// 文本文件按字节读，带上限：超过上限只取前 cap 字节（流式读到够就掐断，不把 50MB 日志整个拉进内存），
// 返回 { bytes, total, truncated }。total 取 Content-Range / Content-Length（压缩传输时可能拿不到，回落调用方给的 size）。
//
// 首包超时 firstByteMs（切后台回来的半开 socket 会让 fetch 永挂），正文 bodyMs 兜底；超时 / 断网 / 非 2xx 抛错。

/** 查看上限：电脑 10 MiB、触屏 4 MiB（手机 WebView 内存紧，CM 建索引也慢） */
export const capFor = (touch) => (touch ? 4 : 10) * 1024 * 1024;
/** 服务端 /api/file/save 的正文上限（src/routes/file-core.mjs，5,000,000 字节）：超过的文件不给编辑 */
export const SAVE_MAX = 5_000_000;

export async function readCapped(url, { cap = capFor(false), size = null, signal, firstByteMs = 12000, bodyMs = 120000, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer = setTimeout(() => ctrl.abort(), firstByteMs);
  try {
    // no-store：/api/file 回 Cache-Control: max-age=30，保存走另一个 URL 不会让它失效（同 DocViewer.load 的老注释）
    const r = await fetchImpl(url, { cache: 'no-store', credentials: 'same-origin', signal: ctrl.signal });
    if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), bodyMs);
    let total = null;
    const cr = r.headers.get('content-range');
    const m = cr && /\/(\d+)\s*$/.exec(cr);
    if (m) total = +m[1];
    else if (!r.headers.get('content-encoding') && r.headers.get('content-length') != null) total = +r.headers.get('content-length');
    if (!Number.isFinite(total)) total = Number.isFinite(size) ? size : null;

    if (!r.body?.getReader) {   // 老 WebView 没有可读流：整篇读完再切
      const buf = new Uint8Array(await r.arrayBuffer());
      if (total == null) total = buf.length;
      return { bytes: buf.length > cap ? buf.slice(0, cap) : buf, total, truncated: buf.length > cap };
    }
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0, truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (got >= cap) {
        // 读过上限＝截断（多读的那一点丢掉）；正好停在上限：有总长按总长判，没有就再读一拍看是不是到头了
        if (got > cap) truncated = true;
        else if (total != null) truncated = total > cap;
        else truncated = !(await reader.read()).done;
        try { await reader.cancel(); } catch {}
        break;
      }
    }
    const n = Math.min(got, cap);
    const bytes = new Uint8Array(n);
    let off = 0;
    for (const c of chunks) {
      if (off >= n) break;
      const take = Math.min(c.length, n - off);
      bytes.set(take === c.length ? c : c.subarray(0, take), off);
      off += take;
    }
    if (total == null) total = truncated ? null : n;
    return { bytes, total, truncated };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
