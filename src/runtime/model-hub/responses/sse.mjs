// SSE 的读与写：上游（Chat Completions / Anthropic Messages）的流拆成一条条事件，转出去的 Responses 事件编成文本。

/** Responses 流的一条事件（Codex 的解析器按 data 里的 type 分派，event 行只是照官方格式带上）。 */
export const sseEvent = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

/**
 * 字节流 → 异步迭代 { event, data }（data 是原文，多行 data 用换行拼起来）。
 * 注释行与空事件跳过；流断在半截时，最后一段没有空行收尾的也交出去（有的上游不补结尾空行）。
 * signal 断开：取消上游的流（读的一方拿着锁，别人 cancel 不了它，只能在这里关）并抛 AbortError。
 * 没读完就退出的（调用方 break / 抛错）同样先取消再放锁：不然上游连接一直开着、接着生成。
 */
export async function* readSse(stream, signal) {
  const reader = stream.getReader();
  let ended = false;
  const onAbort = () => { reader.cancel(signal.reason).catch(() => {}); };
  if (signal) {
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  }
  const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
  const dec = new TextDecoder();
  let buf = '';
  let event = '', data = [];
  const flush = () => {
    if (!data.length && !event) return null;
    const out = { event, data: data.join('\n') };
    event = ''; data = [];
    return out;
  };
  const line = (l) => {
    if (l === '') return flush();
    if (l.startsWith(':')) return null;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    return null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw aborted();
      if (done) { ended = true; break; }
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
        if (buf[nl] === '\r' && nl === buf.length - 1) break;   // \r\n 可能被拆在两块里：等下一块再断行
        const l = buf.slice(0, nl);
        buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
        const ev = line(l);
        if (ev) yield ev;
      }
    }
    buf += dec.decode();
    if (buf) { const ev = line(buf); if (ev) yield ev; }
    const last = flush();
    if (last) yield last;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!ended) await reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch {}
  }
}
