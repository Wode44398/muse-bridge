// 工作区人机协同 · 前端侧三件事：
// ① 视图上报 reportUi(patch)：防抖 POST /api/ui/state——「用户此刻在看什么」（所在页面/
//    dock 状态/文件面板路径/预览文件与页码编辑态），agent 的 mcp__workspace__ view 靠它。
// ② wsx 指令入站 handleWsx(ev)：chat.svelte.js 的 SSE case 'wsx' 转来——agent 让文件面板
//    刷新(fs)/导航(goto)、把文件推进用户预览(preview)、请求截图(capture)/草稿(draft)。
//    gen 事件会被 /api/attach 重放：按 id 去重 + 60s 时效窗，旧指令不再执行（fs 刷新无害放行）。
// ③ 截图/草稿提供者注册：页内按类型 canvas 截图（PDF / 图片预览）。
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
const clientKind = () => 'web';

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

// —— 截图执行链：页内按类型 canvas（网页端能截的只有 PDF 与图片预览）——
async function captureNow() {
  for (const fn of capProviders) {
    try { const r = await fn(); if (r && r.image) return r; } catch {}
  }
  throw new Error('网页端只能截 PDF 与图片预览；请先在预览里打开要看的文件');   // i18n-ignore 回传给 agent 的工具结果（AI 读，服务端拼进中文工具文案）
}
