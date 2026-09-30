// 服务端控制台（ServerAdmin）的共享状态 + 数据层。
//
// 数据面 = bridge 的 /api/admin/*（admin 凭据可达，见 src/routes/admin.mjs）。
// fetch 全部同源直发。轮询只在控制台打开时跑（组件 $effect 管生命周期）。
import { api } from './api.js';
import { t, locale } from './i18n.js';

// 服务端自动起的 Claude 账号名（claude-account.mjs 的「默认账号」「账号 N」）跟着界面语言显示；管理员自己起的名字原样
const AUTO_LABEL = /^(?:默认账号|账号 (\d+))$/;   // i18n-ignore 匹配服务端数据
export function accLabel(l) {
  const m = AUTO_LABEL.exec(l || '');
  return !m ? l : m[1] ? t('账号 {n}', { n: m[1] }) : t('默认账号');
}

export const sa = $state({
  page: 'overview',      // overview|active|users|policy|sessions|routines|accounts|control
  tick: 0,               // 手动刷新脉冲：页面本地数据在 $effect 里依赖它重拉
  ok: true,              // 最近一次 overview 拉取是否成功（连接指示灯）
  scriptAvailable: false,// 后端的主机管理脚本是否在位（在位时服务控制页多一套进程 / 自启操作）
  remote: false,         // 本次是远程管理进来的（非本机直连）
  overview: null,        // /api/admin/overview
  limits: null,          // /api/status 的 limits（5h/7d 用量）
  gens: [],              // /api/admin/active 的活跃生成
  users: [], invites: [],
  agentStatus: [],       // /api/admin/users 附带的 agent 全局状态（按人勾选时把「全局已关 / 不支持多用户」置灰）
  multiUser: true,       // 服务器开没开多用户（主机形态关着：没有注册 / 邀请，只剩服务账号）
  supervisor: null,      // 谁在托管这个进程（systemd / docker / pm2；null = 没有）：服务控制页的「重启」据此可用
  accounts: [],
});

// —— 探针：设置页入口按钮据此显隐（旧后端 404 → 不显示）——
export async function saPing() {
  const r = await api.get('/api/admin/ping');
  if (!r || r.ok !== true) throw new Error('bad ping');
  sa.scriptAvailable = !!r.scriptAvailable;
  sa.remote = !!r.remote;           // 经远程管理进来的：只摆远程能用的页
  sa.multiUser = r.multiUser !== false;
  sa.supervisor = r.supervisor || null;
  return r;
}

// —— 格式化 ——（与旧控制台口径一致）
export const fmtNum = (n) => (n || 0).toLocaleString(locale());
export const fmtAgo = (ms) => { if (!ms) return '—'; const s = Math.round((Date.now() - ms) / 1000); if (s < 60) return t('{n} 秒前', { n: s }); if (s < 3600) return t('{n} 分前', { n: Math.round(s / 60) }); if (s < 86400) return t('{n} 时前', { n: Math.round(s / 3600) }); return t('{n} 天前', { n: Math.round(s / 86400) }); };
export const fmtDur = (ms) => { const s = Math.round((ms || 0) / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); return m + 'm' + (s % 60) + 's'; };
export const fmtUptime = (s) => { if (!s) return '—'; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h${m}m` : `${m}m`; };

// —— 数据装载 ——
export async function loadOverview() {
  try {
    sa.overview = await api.get('/api/admin/overview');
    sa.ok = true;
  } catch { sa.ok = false; }
}
export async function loadLimits() {
  try { const s = await api.get('/api/status'); sa.limits = s?.limits || null; } catch {}
}
export async function loadActive() {
  try { sa.gens = (await api.get('/api/admin/active'))?.gens || []; } catch {}
}
export async function loadUsers() {
  try {
    const d = await api.get('/api/admin/users');
    sa.users = d?.users || []; sa.invites = d?.invites || [];
    sa.agentStatus = d?.agents || []; sa.multiUser = d?.multiUser !== false;
  } catch {}
}
export async function loadAccounts() {
  try { sa.accounts = (await api.get('/api/admin/claude-accounts'))?.accounts || []; } catch {}
}

// 活跃生成里"没跑完"的那部分（总览徽标 + 活跃页共用口径）
export const liveGens = (gens) => (gens || []).filter((g) => !g.done);

// —— toast ——
export const saToastState = $state({ msg: '', err: false, on: false });
let toastT = null;
export function saToast(msg, err = false) {
  saToastState.msg = msg; saToastState.err = !!err; saToastState.on = true;
  clearTimeout(toastT); toastT = setTimeout(() => { saToastState.on = false; }, 2600);
}

// —— 通用确认弹窗（Promise 化；宿主在 ServerAdmin.svelte 渲染）——
export const saConfirmState = $state({ open: false, title: '', desc: '', yes: t('确认'), danger: false, _resolve: null });
export function saConfirm(title, desc, { yes = t('确认'), danger = false } = {}) {
  return new Promise((resolve) => {
    saConfirmState.title = title; saConfirmState.desc = desc; saConfirmState.yes = yes; saConfirmState.danger = danger;
    saConfirmState.open = true; saConfirmState._resolve = resolve;
  });
}
export function saConfirmSettle(v) {
  saConfirmState.open = false;
  const r = saConfirmState._resolve; saConfirmState._resolve = null;
  if (r) r(v);
}

// —— SSE 泵（续聊直播流；与 sse.js 的 chat 控制器解耦，控制台自用轻量版）——
export async function pumpSSE(res, onEv) {
  if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      let data = '';
      for (const ln of frame.split('\n')) if (ln.startsWith('data:')) data += ln.slice(5).replace(/^ /, '');
      if (data) { try { onEv(JSON.parse(data)); } catch {} }
    }
  }
}
