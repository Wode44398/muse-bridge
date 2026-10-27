// 手机 App 内置下载（「下载到本地」）。
//
// 文件由 apk 原生下载器（MainActivity 的 window.BridgeDownload → DownloadService）直接下到手机的
// 「下载」文件夹：带鉴权头、断网自动重试 + 断点续传、退到后台照样下完（通知栏有进度）。以前这里是
// <a download> 跨源链接 → 被壳当外链扔给系统浏览器，app 里既看不到进度也管不了。
//
// 这里把原生任务表汇总成一份【全站共享】的状态：工作空间顶栏的传输环和「传输」面板读它——不管下载
// 是从工作空间、文件预览还是助手发起的，都在同一个面板里看进度、取消、下完点开。原生任务表是进程级的：
// WebView 重载后模块加载时 sync() 一次，还在下的任务就接回来了。
//
// 只有安卓离线壳有原生桥：网页 / 桌面壳 / 旧 apk 上 hasNativeDownload()=false，调用方照走原来的路。

import { tunnelAlt } from './server.js';
import { authHeaders } from './api.js';
import { t, tr } from './i18n.js';

const N = () => (typeof window !== 'undefined' ? window.BridgeDownload : null);
export function hasNativeDownload() { const n = N(); return !!(n && typeof n.start === 'function'); }

// list：传输面板的行模型（与上传行同一口径）——
//   { id, name, status: 'up'|'done'|'error'|'cancelled', sent, total, bps, error, at, retry, dl: true, native: true }
// retry：失败行能不能「重试」（本页发起、记得原始地址的才行；壳侧兜底发起的没有）。
// 原生的 queued / running 都算 'up'（进度环、角标、取消按钮跟上传一样处理）。
export const downloads = $state({ list: [] });

const seen = new Map();   // id → 上次看到的原生状态：只对「状态变了」弹提示，重载接回来的旧任务不重复提示
const meta = new Map();   // id → { url, name }：本页发起的任务记下原始参数，失败了能原样重试
let timer = 0;

// toast 住在助手模块里（体量大、依赖多），动态取避免和 save.js 等底层模块形成静态循环引用。
function toast(text, kind) { import('./toast.svelte.js').then((m) => m.showToast(text, kind)).catch(() => {}); }

const STATUS = { queued: 'up', running: 'up', done: 'done', error: 'error', cancelled: 'cancelled' };

// 原生报错是 "HTTP 404" 这类裸状态码（或已按界面语言给好的「网络中断」）：常见的翻成人话。
function reasonText(e) {
  if (/^HTTP 40[13]$/.test(e)) return t('没有权限');
  if (e === 'HTTP 404') return t('文件不存在');
  return tr(e);
}

function sync() {
  const n = N();
  if (!n) return;
  let arr = [];
  try { arr = JSON.parse(n.list()) || []; } catch { arr = []; }
  const next = [];
  for (const x of arr) {
    const status = STATUS[x.status] || 'error';
    const prev = seen.get(x.id);
    if (prev && prev !== status) {
      if (status === 'done') toast(t('已保存到「下载」：{name}', { name: x.name }));
      else if (status === 'error') toast(t('下载失败：{reason}', { reason: reasonText(x.error || '') || x.name }), 'err');
    }
    seen.set(x.id, status);
    next.push({
      id: x.id, name: x.name || '', status,
      sent: Math.max(0, Number(x.sent) || 0), total: Number(x.total) > 0 ? Number(x.total) : 0,
      bps: Number(x.bps) || 0, error: x.error || '', at: Number(x.at) || 0, retry: meta.has(x.id), dl: true, native: true,
    });
  }
  next.sort((a, b) => b.at - a.at);   // 新的在上，和上传行一样
  downloads.list = next;
  clearTimeout(timer);
  // 有在下的就 400ms 一拍地追进度；全停了就不轮询（新任务由 start 或原生 __bridgeDlKick 叫醒）
  if (next.some((x) => x.status === 'up')) timer = setTimeout(sync, 400);
}

/** 交给原生下载。url 可以是 apiUrl() 的结果（带 ?token 也行，原生另带 Bearer 头）。
    返回 false = 没有原生桥 / 地址不是 http(s)（blob:、data: 原生取不到）——调用方走原来的路。
    quiet：调用方自己给「开始下载」的反馈（工作空间有自己的 toast），这里就不再弹全局提示。 */
export function startDownload({ url, name = '', quiet = false } = {}) {
  const n = N();
  if (!n || !url) return false;
  let abs;
  try { abs = new URL(url, location.href).href; } catch { return false; }
  if (!/^https?:/i.test(abs)) return false;
  const urls = [abs];
  const alt = tunnelAlt(abs);   // 正走局域网直连：附上隧道地址当备用线路
  if (alt) urls.push(alt);
  const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  let got = '';
  try { got = n.start(id, JSON.stringify(urls), name || '', JSON.stringify(authHeaders())); } catch { got = ''; }
  if (!got) return false;
  seen.set(got, 'up');
  meta.set(got, { url, name });
  sync();
  if (!quiet) toast(name ? t('开始下载 {name}，可在工作空间「传输」里看进度', { name }) : t('开始下载，可在工作空间「传输」里看进度'));
  return true;
}

/** 失败的下载原样再来一次（换新任务，旧的失败行清掉）。 */
export function retryDownload(id) {
  const m = meta.get(id);
  if (!m) return false;
  try { N()?.forget(id); } catch {}
  seen.delete(id); meta.delete(id);
  return startDownload({ url: m.url, name: m.name, quiet: true });
}

export function cancelDownload(id) {
  try { N()?.cancel(id); } catch {}
  sync();
}

/** 用别的 app 打开下好的文件（系统「打开方式」）。返回 false = 打不开（任务没了 / 还没下完）。 */
export function openDownload(id) {
  try { return !!N()?.open(id); } catch { return false; }
}

/** 清掉已结束的下载行（下好的文件留在「下载」文件夹里不动）。 */
export function clearFinishedDownloads() {
  const n = N();
  if (!n) return;
  for (const x of downloads.list) if (x.status !== 'up') { try { n.forget(x.id); } catch {} seen.delete(x.id); meta.delete(x.id); }
  sync();
}

if (typeof window !== 'undefined' && hasNativeDownload()) {
  window.__bridgeDlKick = sync;   // 原生在任务开始/结束（含壳侧兜底发起的下载）时叫醒
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  sync();
}
