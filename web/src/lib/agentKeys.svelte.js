// 设置「Agent 接入」的数据面：给别的 agent（Claude Code、Codex、脚本…）用的密钥。手机 Settings 与桌面
// SettingsDesktop 共用这一份状态。后端 /api/agent-keys（list / create / revoke）；变更后服务端在总线发
// { type:'agent.keys' }——有面板开着（watchAgentKeys 计数 > 0）就重拉。
// 明文密钥只在 create 的响应里出现一次：放在 agentKeys.fresh 里给面板醒目展示，关掉面板 / 再生成就丢掉，不落任何存储。
import { api } from './api.js';
import { busOn } from './bus.js';
import { locale } from './i18n.js';

export const agentKeys = $state({
  loaded: false,
  loading: false,
  err: '',
  keys: [],            // [{ id, label, created, seen, expiresAt }]（毫秒；seen=0 没用过）
  origin: '',
  agentUrl: '',
  manualUrl: '',
  busy: '',            // 'create' | 'revoke:<id>'
  fresh: null,         // { id, label, key, prompt, expiresAt }：刚生成的那把（只此一次）
});

const errText = (e) => {
  const b = e && e.body;
  if (b && typeof b === 'object' && b.error) return String(b.error);
  if (typeof b === 'string' && b) return b;
  return String((e && e.message) || e || '');
};

export async function loadAgentKeys() {
  if (agentKeys.loading) return;
  agentKeys.loading = true;
  try {
    const r = await api.get('/api/agent-keys');
    agentKeys.keys = Array.isArray(r?.keys) ? r.keys : [];
    agentKeys.origin = r?.origin || '';
    agentKeys.agentUrl = r?.agentUrl || '';
    agentKeys.manualUrl = r?.manualUrl || '';
    agentKeys.err = '';
    agentKeys.loaded = true;
  } catch (e) { agentKeys.err = errText(e); }
  finally { agentKeys.loading = false; }
}

/** 生成一把。成功返回 true（明文在 agentKeys.fresh）；失败把原因放进 agentKeys.err。 */
export async function createAgentKey(label) {
  agentKeys.busy = 'create'; agentKeys.err = '';
  try {
    const r = await api.post('/api/agent-keys/create', { label: String(label || '').trim() });
    if (!r || r.error || !r.key) throw Object.assign(new Error(r?.error || 'create failed'), { body: r });
    agentKeys.fresh = { id: r.id, label: r.label || label, key: r.key, prompt: r.prompt || '', expiresAt: r.expiresAt || 0 };
    loadAgentKeys();
    return true;
  } catch (e) { agentKeys.err = errText(e); return false; }
  finally { agentKeys.busy = ''; }
}

export async function revokeAgentKey(id) {
  agentKeys.busy = 'revoke:' + id; agentKeys.err = '';
  try {
    await api.post('/api/agent-keys/revoke', { id });
    agentKeys.keys = agentKeys.keys.filter((k) => k.id !== id);
    if (agentKeys.fresh && agentKeys.fresh.id === id) agentKeys.fresh = null;
    loadAgentKeys();
    return true;
  } catch (e) { agentKeys.err = errText(e); return false; }
  finally { agentKeys.busy = ''; }
}

export function dismissFresh() { agentKeys.fresh = null; }

// 面板开着期间调用：先拉一次，返回的函数在面板关掉时调（同时丢掉没看完的明文密钥）。
let watchers = 0;
export function watchAgentKeys() {
  watchers += 1;
  loadAgentKeys();
  return () => { watchers = Math.max(0, watchers - 1); if (!watchers) agentKeys.fresh = null; };
}
busOn((ev) => { if (ev && ev.type === 'agent.keys' && watchers > 0) loadAgentKeys(); });

// 日期（创建 / 到期 / 最近使用）：中文「2026年10月23日」，英文「Oct 23, 2026」
export function fmtKeyDay(ms) {
  if (!ms) return '';
  try { return new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(ms)); }
  catch { return new Date(ms).toISOString().slice(0, 10); }
}

// 复制：剪贴板 API 在非安全上下文（局域网 http://192.168…）不可用，退回隐藏 textarea + execCommand
export async function copyText(text) {
  const s = String(text || '');
  try { await navigator.clipboard.writeText(s); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = s; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch { return false; }
}
