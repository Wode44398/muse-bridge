// 工作区人机协同 · 前端侧三件事：
// ① 视图上报 reportUi(patch)：防抖 POST /api/ui/state——「用户此刻在看什么」（所在页面/
//    dock 状态/文件面板路径/预览文件与页码编辑态），agent 的 mcp__workspace__ view 靠它。
// ② wsx 指令入站 handleWsx(ev)：chat.svelte.js 的 SSE case 'wsx' 转来——agent 让文件面板
//    刷新(fs)/导航(goto)、把文件推进用户预览(preview)、请求截图(capture)/草稿(draft)。
//    gen 事件会被 /api/attach 重放：按 id 去重 + 60s 时效窗，旧指令不再执行（fs 刷新无害放行）。
// ③ 截图/草稿提供者注册：桌面壳 capturePage → 安卓壳原生截屏 → 页内按类型 canvas 兜底。
// 依赖纪律：本模块只静态 import api.js，其余应用模块一律动态 import——它被 preview/dock/
// FilesPanel 反向引用，静态引用会成环。

import { api } from './api.js';

const cid = (() => {
  try {
    let v = sessionStorage.getItem('bridge-uic');
    if (!v) { v = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); sessionStorage.setItem('bridge-uic', v); }
    return v;
  } catch { return 'c' + Math.random().toString(36).slice(2, 10); }
})();
// 本标签页的客户端 id（sessionStorage，刷新不变）：视图上报带它；agent 的界面指令（ui.cmd）按它点名「只让这一端执行」。
export const uiClientId = cid;
const clientKind = () => {
  try { return window.BridgeDesktop ? 'desktop' : window.AndroidStore ? 'apk' : 'web'; } catch { return 'web'; }
};

// —— ① 视图上报（防抖合并；登录前/离线失败静默）——
const view = { page: '', dock: null, files: null, preview: null };
let timer = 0;
export function reportUi(patch) {
  Object.assign(view, patch);
  clearTimeout(timer);
  timer = setTimeout(() => { api.uiState({ clientId: cid, client: clientKind(), state: view }).catch(() => {}); }, 400);
}

// —— ③ 提供者注册 ——
const capProviders = new Set();          // 页内按类型截图（PdfView/ImageView 挂载时注册）
export function registerCapture(fn) { capProviders.add(fn); return () => capProviders.delete(fn); }
let draftProvider = null;                // 编辑器草稿（DocViewer 挂载时注册）
export function registerDraft(fn) { draftProvider = fn; return () => { if (draftProvider === fn) draftProvider = null; }; }

// 文件面板订阅（agent fs 刷新 / goto 导航；面板挂载时注册）
const fsSubs = new Set();
export function onAgentFs(fn) { fsSubs.add(fn); return () => fsSubs.delete(fn); }
const gotoSubs = new Set();
export function onAgentGoto(fn) { gotoSubs.add(fn); return () => gotoSubs.delete(fn); }

// —— ② wsx 指令入站 ——
const seen = new Set();
export async function handleWsx(ev) {
  try {
    if (!ev || !ev.op) return;
    const key = ev.id || (ev.op + ':' + (ev.rel || '') + ':' + (ev.at || ''));
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 400) { const it = seen.values(); for (let i = 0; i < 150; i++) seen.delete(it.next().value); }
    if (ev.op !== 'fs' && ev.at && Math.abs(Date.now() - ev.at) > 60_000) return;   // attach 重放的陈旧指令
    switch (ev.op) {
      case 'fs':
        for (const fn of fsSubs) { try { fn(ev.rel || null); } catch {} }
        break;
      case 'goto': {
        const rootRel = await wsRelToRootRel(ev.rel || '', ev.ws || '');
        if (rootRel == null) return;   // 工作空间在文件根之外：面板去不了，静默放弃
        if (gotoSubs.size) { for (const fn of gotoSubs) { try { fn(rootRel); } catch {} } }
        else {
          // 面板没开：预置初始路径（独立文件分页下次挂载时消费），宽屏顺手拉开工作台文件视图
          // ——必须把路径当定位目标交给 dock，否则它自己那条「预置成工作空间根」的缺省会盖掉。
          const [{ ui }, dockMod] = await Promise.all([import('./state.svelte.js'), import('./dock.svelte.js')]);
          ui.filesPath = rootRel;
          try { if (window.innerWidth >= 1024 && ui.screen === 'claude') dockMod.openDockFiles({ rel: rootRel }); } catch {}
        }
        break;
      }
      case 'preview': {
        if (!ev.rel) return;
        const { openPreview } = await import('./preview.svelte.js');
        openPreview({ origin: 'cloud', rel: ev.rel, ws: ev.ws || '' }, 0, { host: 'app' });
        break;
      }
      case 'capture': {
        try { const r = await captureNow(); api.uiAnswer(ev.id, r).catch(() => {}); }
        catch (e) { api.uiAnswer(ev.id, { error: String(e?.message || e) }).catch(() => {}); }
        break;
      }
      case 'draft': {
        const d = draftProvider ? draftProvider() : null;
        api.uiAnswer(ev.id, d || { error: '用户端当前没有打开的编辑器' }).catch(() => {});   // i18n-ignore 回传给 agent 的工具结果（AI 读，服务端拼进中文工具文案）
        break;
      }
    }
  } catch { /* 协同指令绝不拖垮聊天流 */ }
}

// agent 传来的路径是【工作空间相对】；文件面板浏览的是【身份文件根】。经 dock/meta 的
// rel（工作空间相对文件根的前缀）换算；工作空间在根之外时返回 null。
async function wsRelToRootRel(rel, ws) {
  try {
    const { dock } = await import('./dock.svelte.js');
    let meta = dock.meta;
    if (!meta && (ws || dock.ws)) {
      try { meta = await api.get(`/api/claude/dock/meta?ws=${encodeURIComponent(ws || dock.ws)}`); } catch { meta = null; }
    }
    if (!meta || meta.rel == null) return null;
    return meta.rel ? (rel ? meta.rel + '/' + rel : meta.rel) : rel;
  } catch { return null; }
}

// —— 截图执行链：桌面壳整窗/区域像素 → 安卓壳原生截屏 → 页内按类型 canvas ——
async function captureNow() {
  const cap = window.BridgeDesktop?.app?.capture;
  if (cap) {
    // 预览开着就只截预览区域，否则截整窗（capturePage 的 rect 用 CSS 像素，与 BCR 同系）
    const el = document.querySelector('.mv-root') || document.querySelector('.dk-embed');
    const r = el?.getBoundingClientRect();
    const rect = r && r.width > 60 && r.height > 60
      ? { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.round(r.width), height: Math.round(r.height) }
      : null;
    const dataUrl = await cap(rect);
    if (dataUrl) return { image: dataUrl, note: rect ? '桌面端·预览区域' : '桌面端·整窗' };   // i18n-ignore 回传给 agent 的工具结果（AI 读，服务端拼进中文工具文案）
  }
  if (window.BridgeShot?.capture) {
    const dataUrl = await new Promise((resolve) => {
      const token = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const prev = window.__bridgeShotDone;
      window.__bridgeShotDone = (tk, url) => { if (tk === token) { window.__bridgeShotDone = prev; resolve(url || null); } else if (prev) prev(tk, url); };
      try { window.BridgeShot.capture(token); } catch { resolve(null); }
      setTimeout(() => resolve(null), 8000);
    });
    if (dataUrl) return { image: dataUrl, note: '手机端·整屏' };   // i18n-ignore 回传给 agent 的工具结果（AI 读，服务端拼进中文工具文案）
  }
  for (const fn of capProviders) {
    try { const r = await fn(); if (r && r.image) return r; } catch {}
  }
  throw new Error('该客户端环境不支持截图（桌面客户端/手机 App 支持整屏；网页端仅 PDF 与图片预览可截）');   // i18n-ignore 回传给 agent 的工具结果（AI 读，服务端拼进中文工具文案）
}
