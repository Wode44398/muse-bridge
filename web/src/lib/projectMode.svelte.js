// 项目对话的概览数据（运行档位 › 项目；服务端 src/routes/project-mode.mjs）：项目说明、暂停、项目记忆、上限。
// 讨论串列表本身走会话信息面板那份（/api/claude/session-rail 的 family，项目对话里带 waiting / resolved / at）。
// 变化经总线 {type:'project', sessionId} 推来，看过的项目重拉一次（别的设备改了说明 / 协调者写了记忆）。
import { api } from './api.js';
import { busOn } from './bus.js';
import { showToast as toast } from './toast.svelte.js';
import { t, tr } from './i18n.js';

export const proj = $state({ views: {} });   // 项目对话 id -> { instructions, paused, memory:[{name,size,at}], limits } | null（不是项目对话）

const enc = encodeURIComponent;
const errText = (e, fallback) => { const d = e && e.body && (e.body.error || e.body); return typeof d === 'string' && d && !/^HTTP \d+$/.test(d) ? tr(d) : fallback; };

export async function loadProject(sid) {
  if (!sid) return null;
  try { const v = await api.get('/api/claude/project?session=' + enc(sid)); proj.views[sid] = v; return v; }
  catch (e) { if (e && e.status === 404) proj.views[sid] = null; return null; }
}
/** 改项目说明 / 暂停。返回 true = 成功。 */
export async function saveProject(sid, patch) {
  try { const v = await api.post('/api/claude/project', { session: sid, ...patch }); proj.views[sid] = v; return true; }
  catch (e) { toast(errText(e, t('没能保存，可以重试。')), 'err'); return false; }
}
export async function resolveThread(sid, thread, resolved) {
  try { await api.post('/api/claude/project/resolve', { session: sid, thread, resolved }); return true; }
  catch (e) { toast(errText(e, t('没能保存，可以重试。')), 'err'); return false; }
}
export async function stopThread(thread) {
  try { await api.post('/api/stop', { sessionId: thread }); return true; } catch { return false; }
}
export async function readMemory(sid, name) {
  try { const r = await api.get('/api/claude/project/memory?session=' + enc(sid) + '&name=' + enc(name)); return r && typeof r.content === 'string' ? r.content : ''; }
  catch (e) { toast(errText(e, t('没能读到这一篇。')), 'err'); return null; }
}
/** 写一篇（content 为 null = 删掉）。 */
export async function writeMemory(sid, name, content) {
  try {
    const r = await api.post('/api/claude/project/memory', { session: sid, name, content });
    if (proj.views[sid] && r && Array.isArray(r.memory)) proj.views[sid].memory = r.memory;
    return true;
  } catch (e) { toast(errText(e, t('没能保存，可以重试。')), 'err'); return false; }
}

busOn((ev) => { if (ev && ev.type === 'project' && ev.sessionId && proj.views[ev.sessionId] !== undefined) loadProject(ev.sessionId); });
