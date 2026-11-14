// 服务端 Office → PDF 的等待：轮询 office-pdf?status=1（不等转换、立刻回 JSON），把排队 / 转换进度报给界面，
// 转好了再让 PdfView 去取 PDF。服务端见 src/routes/file-preview.mjs。
//   · 老服务端不认 status=1：会直接（转完后）回 PDF 字节——带 Range: bytes=0-0 只取 1 个字节，不是 JSON 就当已就绪；
//   · failed / unavailable（没装 LibreOffice、转换出错或超时）→ 交给调用方回落客户端渲染；
//   · busy（服务端排队已满，还没收下这份）→ 当「排队中」报给界面，隔 retryMs 再问，收下了就正常排；
//   · 前端自己也设时限（转换中超过服务端超时 + 20 秒、或总共 10 分钟），防止状态卡住无限转圈。

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const id = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(id); reject(signal.reason || new DOMException('aborted', 'AbortError')); }, { once: true });
});

/**
 * @param {string} url  item.officePdfUrl
 * @param {{ signal?: AbortSignal, onstate?: (s: { state: 'queued'|'converting', ms: number, ahead: number, at: number }) => void, retry?: boolean }} [o]
 * @returns {Promise<{ ok: true } | { ok: false, state: string, error: string }>}
 */
export async function waitOfficePdf(url, { signal, onstate, retry = false } = {}) {
  const t0 = Date.now();
  let first = true;
  for (;;) {
    const q = url + (url.includes('?') ? '&' : '?') + 'status=1' + (retry && first ? '&retry=1' : '');
    first = false;
    let r;
    try { r = await fetch(q, { headers: { Range: 'bytes=0-0' }, credentials: 'same-origin', cache: 'no-store', signal }); }
    catch (e) {
      if (signal?.aborted) throw e;
      return { ok: false, state: 'network', error: String(e?.message || e) };
    }
    if (!r.ok && r.status !== 206) return { ok: false, state: 'http', error: 'HTTP ' + r.status };
    if (!/json/i.test(r.headers.get('content-type') || '')) { try { await r.body?.cancel(); } catch {} return { ok: true }; }
    let j;
    try { j = await r.json(); } catch { return { ok: false, state: 'http', error: 'bad status' }; }   // i18n-ignore
    if (j.state === 'ready') return { ok: true };
    if (j.state === 'failed' || j.state === 'unavailable') return { ok: false, state: j.state, error: String(j.error || '') };
    if (j.state === 'busy') {
      onstate?.({ state: 'queued', ms: Date.now() - t0, ahead: +j.ahead || 0, at: Date.now() });
      if (Date.now() - t0 > 600_000) return { ok: false, state: 'timeout', error: 'timeout' };   // i18n-ignore
      await sleep(Math.max(1000, Math.min(10_000, +j.retryMs || 3000)), signal);
      continue;
    }
    const conv = j.state !== 'queued', ms = +j.ms || 0;
    onstate?.({ state: conv ? 'converting' : 'queued', ms, ahead: +j.ahead || 0, at: Date.now() });
    // 转换中超过服务端时限 20 秒还没结论、或者总共等了 10 分钟（排长队）：不再等
    if ((conv && ms > (+j.timeoutMs || 90_000) + 20_000) || Date.now() - t0 > 600_000) return { ok: false, state: 'timeout', error: 'timeout' };   // i18n-ignore
    await sleep(Date.now() - t0 < 3000 ? 500 : 1000, signal);
  }
}
