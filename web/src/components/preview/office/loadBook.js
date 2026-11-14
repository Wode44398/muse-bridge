// 读表格：优先放进 Worker 解析（不卡主线程），Worker 起不来（老 WebView、CSP、构建漂移拿不到 worker 文件）就在主线程解析。
// 返回 sheet.js 的 book 模型；受密码保护的表格抛 code = 'password' 的错误。
let seq = 0;

function viaWorker(buf, ext) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./sheet.worker.js', import.meta.url), { type: 'module' }); }
    catch (e) { reject(Object.assign(new Error('worker'), { fallback: true })); return; }
    const id = ++seq;
    const done = (fn, v) => { try { w.terminate(); } catch {} fn(v); };
    w.onmessage = (e) => {
      const d = e.data || {};
      if (d.id !== id) return;
      if (d.error) done(reject, Object.assign(new Error(d.error), { code: d.code || '' }));
      else done(resolve, d.book);
    };
    // 脚本加载失败（404 / 语法不支持）走 error 事件：回落主线程
    w.onerror = (e) => { e.preventDefault?.(); done(reject, Object.assign(new Error('worker'), { fallback: true })); };
    w.postMessage({ id, buf, ext }, [buf]);
  });
}

async function inline(buf, ext) {
  const [XLSX, fflate, S] = await Promise.all([import('xlsx'), import('fflate'), import('./sheet.js')]);
  try { return S.parseBook(XLSX, fflate, buf, ext); }
  catch (err) {
    const msg = String(err?.message || err);
    throw Object.assign(new Error(msg), { code: /password|encrypt/i.test(msg) ? 'password' : '' });
  }
}

/** @param {ArrayBuffer} buf  @param {string} ext */
export async function loadBook(buf, ext) {
  const copy = buf.slice(0);   // 交给 Worker 时原件会被转移走，回落主线程要用副本
  try { return await viaWorker(buf, ext); }
  catch (e) {
    if (!e?.fallback) throw e;
    return inline(copy, ext);
  }
}
