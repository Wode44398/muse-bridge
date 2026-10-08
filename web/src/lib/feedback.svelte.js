// 问题反馈（前端）：
//   · 操作轨迹：最近 30 步「到了哪一页 / 哪个接口失败了」，只记页面名、接口路径（不带参数）和状态码，不记任何内容；
//   · 页面报错：没接住的异常记到服务端（POST /api/feedback/client-error，服务端归一、脱敏），这里只留指纹；
//   · 报告对话框的开关（ReportDialog.svelte 渲染）：从设置、出错提示上的「报告」按钮打开。
// 报告怎么出草稿、怎么发，见服务端 src/feedback/。
import { api } from './api.js';

const MAX_TRAIL = 30;
const trail = [];          // { t, ev }
const errorFps = [];       // 最近的页面报错指纹（新的在后）
const t0 = Date.now();
let lastFault = null;      // 最近一次「服务出错」：{ at, ev } —— toast 据此决定要不要带「报告」按钮

export const reportDialog = $state({ open: false, preset: null });

export function noteTrail(ev) {
  trail.push({ t: Math.round((Date.now() - t0) / 1000), ev: String(ev).slice(0, 90) });
  if (trail.length > MAX_TRAIL) trail.splice(0, trail.length - MAX_TRAIL);
}
/** api.js 每个失败的请求都报到这里（路径不带查询参数） */
export function noteApiFailure(method, path, status) {
  if (String(path).startsWith('/api/feedback')) return;
  const ev = `api ${method} ${String(path).split('?')[0]} → ${status || 'network error'}`;
  noteTrail(ev);
  if (!status || status >= 500) lastFault = { at: Date.now(), ev };
}
/** 刚刚（几秒内）有没有服务端出错：有的话，错误提示上给一个「报告」按钮 */
export function recentFault(ms = 4000) { return lastFault && Date.now() - lastFault.at < ms ? lastFault : null; }

export function trailLines() { return trail.map((x) => `+${x.t}s ${x.ev}`); }
export function recentErrorFps() { return errorFps.slice(-5); }

export function openReport(preset = null) {
  reportDialog.preset = preset;
  reportDialog.open = true;
}

/** 浏览器摘要：只到「哪个浏览器、哪个大版本、什么系统」 */
export function browserSummary() {
  const ua = navigator.userAgent || '';
  const hit = [['Edge', /Edg\/(\d+)/], ['Chrome', /Chrome\/(\d+)/], ['Firefox', /Firefox\/(\d+)/], ['Safari', /Version\/(\d+).*Safari/]]
    .map(([n, re]) => { const m = re.exec(ua); return m ? `${n} ${m[1]}` : ''; }).find(Boolean);
  const b = hit || 'other';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  const app = typeof window !== 'undefined' && window.MuseBridgeApp ? ' (Android app)' : '';
  return `${b}${os ? ' / ' + os : ''}${app}`;
}

// —— 页面报错：只收我们自己打包的代码（/app/assets/）抛的，浏览器插件之类的不算 ——
let budget = { t: 0, n: 0 };
async function sendClientError(name, message, stack) {
  const now = Date.now();
  if (now - budget.t > 60_000) budget = { t: now, n: 0 };
  if (++budget.n > 5) return;
  try {
    const r = await api.post('/api/feedback/client-error', { name, message: String(message || '').slice(0, 500), stack: String(stack || '').slice(0, 4000) });
    if (r?.fp && !errorFps.includes(r.fp)) { errorFps.push(r.fp); if (errorFps.length > 10) errorFps.shift(); }
  } catch {}
}
const ours = (stack, file) => /\/app\/assets\//.test(String(stack || '') + ' ' + String(file || ''));

let installed = false;
export function installFeedbackCapture() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    const err = e.error;
    if (!ours(err?.stack, e.filename)) return;
    noteTrail(`error ${err?.name || 'Error'}`);
    sendClientError(err?.name || 'Error', err?.message || e.message, err?.stack || '');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const err = e.reason;
    if (!(err instanceof Error) || !ours(err.stack)) return;
    // api.js 抛的 HTTP 错误已经记在轨迹里了，不算页面 bug
    if (err.status) return;
    noteTrail(`unhandled ${err.name}`);
    sendClientError(err.name, err.message, err.stack);
  });
}
