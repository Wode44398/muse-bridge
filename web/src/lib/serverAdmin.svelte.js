// 服务端控制台（ServerAdmin）的共享状态 + 数据层。
//
// 数据面 = bridge 的 /api/admin/*（admin 凭据；远程管理关着时还要求本机直连，见 src/routes/admin.mjs）。
// 桌面壳窗口里 cookie 已由主进程种好，
// 这里的 fetch 全部同源直发即可。轮询只在控制台打开时跑（组件 $effect 管生命周期），
// 页面藏到后台（document.hidden）时各处轮询都跳过，回到前台补拉一次。
import { api, getToken } from './api.js';
import { apiUrl } from './server.js';
import { t, locale } from './i18n.js';
import { busOn } from './bus.js';

// 「由 X 托管」整句：服务端 supervisor() 回的是机器值（systemd / docker / pm2 / windows / desktop）。
// desktop = 桌面客户端托管的本机服务端（壳设 BRIDGE_SUPERVISED=desktop），windows = Windows 启动器（bridge-service.mjs）；
// 其余是通用工具名，原样显示。按托管方各出一句、不往同一个模板里塞名字：中文名前后不留空格（由桌面客户端托管），
// 英文工具名两侧留空格（由 systemd 托管），一个模板两头顾不全。
export function supervisedBy(s) {
  if (s === 'desktop') return t('由桌面客户端托管');
  if (s === 'windows') return t('由 Windows 启动器托管');
  return t('由 {name} 托管', { name: s });
}

export const sa = $state({
  page: 'overview',      // overview|active|users|sessions|routines|media|accounts|clients|control
  tick: 0,               // 手动刷新脉冲：页面本地数据在 $effect 里依赖它重拉
  ok: true,              // 最近一次 overview 拉取是否成功（连接指示灯）
  scriptAvailable: false,// 后端 admin.ps1 是否在位（附着/源码形态 true；打包桌面服务端 false→服务控制页走壳形态）
  remote: false,         // 本次是远程管理（手机 / 网页 / 经隧道）进来的——停服务、停隧道、开机自启这类会切断自己的按钮不摆
  overview: null,        // /api/admin/overview
  limits: null,          // /api/status 的 limits（5h/7d 用量）
  gens: [],              // /api/admin/active 的活跃生成
  users: [], invites: [],
  agentStatus: [],       // /api/admin/users 附带的 agent 全局状态（按人勾选时把「全局已关 / 不支持多用户」置灰）
  multiUser: true,       // 服务器开没开多用户（features.multiUser 关着：没有注册 / 邀请，只剩服务账号）
  supervisor: null,      // 谁在托管这个进程（systemd / docker / pm2；null = 没有）：服务控制页的「重启」据此可用
  accounts: [],
  devs: null,            // /api/devices?all=1：全部设备 + 客户端最新版（设备页）
  publicAccess: null,    // /api/admin/public-access：公网访问（内置隧道 / 自己的域名）的完整状态
});

// 页面在前台才轮询（控制台开着但切到别的标签 / 最小化时别白拉）
export const pageVisible = () => typeof document === 'undefined' || !document.hidden;

// —— 探针：设置页入口按钮据此显隐（旧后端 404 → 不显示）——
export async function saPing() {
  const r = await api.get('/api/admin/ping');
  if (!r || r.ok !== true) throw new Error('bad ping');
  sa.scriptAvailable = !!r.scriptAvailable;
  sa.remote = !!r.remote;           // 经远程管理进来的（手机 / 网页 / 经隧道）：不摆会切断自己连接的按钮
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

// —— 公网访问（runtime/public-access.mjs）——
export async function loadPublicAccess() {
  try { sa.publicAccess = await api.get('/api/admin/public-access'); } catch {}
}
// 应用 / 重启：失败时服务端回的也是完整状态（带 error），照样落进来；error 抛给调用方提示
async function paPost(path, body) {
  try { sa.publicAccess = await api.post(path, body); return sa.publicAccess; }
  catch (e) {
    const b = e?.body;
    if (b && typeof b === 'object' && b.mode) sa.publicAccess = b;
    throw new Error((b && b.error) || e?.message || String(e));
  }
}
export const applyPublicAccess = (body) => paPost('/api/admin/public-access', body);
export const restartPublicAccess = () => paPost('/api/admin/public-access/restart', {});
// 服务端在状态变化时经总线推 {type:'public-access'}（快速隧道换了地址、连上 / 断了）：收到就补拉完整状态。
// 返回取消订阅。
export function watchPublicAccess() {
  return busOn((ev) => {
    if (ev?.type !== 'public-access') return;
    if (sa.publicAccess) sa.publicAccess = { ...sa.publicAccess, mode: ev.mode, status: ev.status, url: ev.url };
    if (sa.overview?.publicAccess) sa.overview = { ...sa.overview, publicAccess: { ...sa.overview.publicAccess, mode: ev.mode, status: ev.status, url: ev.url } };
    loadPublicAccess();
  });
}

export async function loadDevs() {
  try { sa.devs = await api.get('/api/devices?all=1'); }
  catch (e) { sa.devs = { error: e?.body?.error || e?.message || String(e) }; }
}

// 活跃生成里"没跑完"的那部分（总览徽标 + 活跃页共用口径）
export const liveGens = (gens) => (gens || []).filter((g) => !g.done);

// —— 媒体 / 会话的 per-user 取数（页面内直接调）——
export const userMediaUrl = (user, id) => user === 'admin'
  ? apiUrl('/api/vertex/media?id=' + encodeURIComponent(id) + (getToken() ? '&token=' + encodeURIComponent(getToken()) : ''))
  : apiUrl('/api/admin/user/media-file?name=' + encodeURIComponent(user) + '&id=' + encodeURIComponent(id));

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
