// JSON 默认格式化：只对「压成一行 / 几乎没换行」的 JSON 做（已经排好版的原样显示，不白花一次整篇解析）。
// 大文件交给 Worker（jsonfmt.worker.js），主线程不卡；解析失败（截断的、带注释的 jsonc）返回 null，按原文显示。
//
//   looksMinified(text) → boolean
//   formatJson(text)    → string | null（同步）
//   formatJsonAsync(text, { signal }) → Promise<string | null>（> 512KB 走 Worker）

export function looksMinified(text) {
  const s = String(text);
  if (!/^\s*[[{]/.test(s)) return false;
  const head = s.slice(0, 65536);
  const lines = head.trimEnd().split('\n').length;
  if (lines === 1) return /[,:]/.test(head);   // 一行装下整篇（或开头 64KB）＝压过；只有一个值的 [1] / {} 不必排
  // 平均行长 > 400 字符就算压缩过（排好版的 JSON 平均一行几十个字符）
  return head.length / lines > 400;
}

export function formatJson(text, indent = 2) {
  try { return JSON.stringify(JSON.parse(text), null, indent); } catch { return null; }
}

const WORKER_MIN = 512 * 1024;
export function formatJsonAsync(text, { signal } = {}) {
  if (String(text).length < WORKER_MIN || typeof Worker === 'undefined') return Promise.resolve(formatJson(text));
  return new Promise((resolve) => {
    let w;
    try { w = new Worker(new URL('./jsonfmt.worker.js', import.meta.url), { type: 'module' }); }
    catch { resolve(formatJson(text)); return; }
    const done = (v) => { try { w.terminate(); } catch {} resolve(v); };
    signal?.addEventListener('abort', () => done(null), { once: true });
    w.onmessage = (e) => done(typeof e.data === 'string' ? e.data : null);
    w.onerror = () => done(null);
    w.postMessage(text);
  });
}
