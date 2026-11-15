// 定时任务页的数据与文案拼装（页面：components/RoutinesPage.svelte，服务端：src/routes/routines.mjs）。
//   rt.items      任务列表（服务端原样：schedule / cwd / worktree / permissionMode / runs[] …）
//   rt.running    正在跑的任务 id；rt.live[id] = { sessionId, waiting }（waiting = 停在审批卡 / 提问上等你）
//   rt.home       默认工作空间（任务没选文件夹时跑在这里）；rt.permissionModes 这个身份能选的权限模式；rt.tz 服务器时区
// 总线 'routine' 事件（routines-runner.mjs）：开跑 / 收尾时刷新列表；任务开了「跑完通知我」就在收尾时提醒。
//   rt.engines    这个身份能选的引擎（claude / dimensio）；rt.dimModes 能选的 dimensio 运行档位（全权档只给主机身份）
//   rt.dim        dimensio 的型号目录与默认设置（/api/harness/api/info + config），选 dimensio 时才拉——打 /api/harness 会把没在跑的
//                 harness 拉起来，不在打开定时任务页时就打
import { api } from './api.js';
import { busOn } from './bus.js';
import { ui } from './state.svelte.js';
import { notifyKind } from './notify.js';
import { noticesLive } from './notices.svelte.js';
import { showToast } from './toast.svelte.js';
import { vendorName, effortText as dimEffortText } from './dimensioSettings.svelte.js';
import { t, tr } from './i18n.js';
export * from './routineText.js';

export const rt = $state({
  items: [], running: [], live: {}, home: '', permissionModes: [], tz: null, loading: false, loaded: false, err: '',
  engines: ['claude'], dimModes: [],
  dim: { phase: 'idle', info: null, config: null, why: '' },   // phase: idle | loading | ready | down
});

let inflight = null;
export function loadRoutines() {
  if (inflight) return inflight;
  rt.loading = true;
  inflight = (async () => {
    try {
      const d = await api.routines();
      rt.items = d.routines || []; rt.running = d.running || []; rt.live = d.live || {};
      if (typeof d.home === 'string') rt.home = d.home;
      if (Array.isArray(d.permissionModes)) rt.permissionModes = d.permissionModes;
      if (Array.isArray(d.engines)) rt.engines = d.engines;
      if (Array.isArray(d.dimModes)) rt.dimModes = d.dimModes;
      if (d.tz) rt.tz = d.tz;
      rt.err = ''; rt.loaded = true;
    } catch { rt.err = 'load'; }
    rt.loading = false; inflight = null;
  })();
  return inflight;
}

// —— dimensio 引擎（11-14）——
const H = '/api/harness/api';
let dimInflight = null;
/** dimensio 的型号目录与默认设置。拉过就不再拉（force 重试）；起不来 phase = 'down'、why 是给人看的原因。 */
export function loadDimCatalog({ force = false } = {}) {
  if (dimInflight) return dimInflight;
  if (!force && (rt.dim.phase === 'ready' || rt.dim.phase === 'loading')) return Promise.resolve();
  rt.dim.phase = 'loading';
  dimInflight = (async () => {
    try {
      const [info, config] = await Promise.all([api.get(H + '/info'), api.get(H + '/config')]);
      rt.dim = { phase: 'ready', info, config, why: '' };
    } catch (e) {
      const raw = typeof e?.body === 'object' ? e?.body?.error : '';
      rt.dim = { phase: 'down', info: null, config: null, why: tr(raw) || (e?.status === 403 ? t('你的账号不能用 dimensio') : t('dimensio 服务没起来，稍后再试')) };
    }
    dimInflight = null;
  })();
  return dimInflight;
}
// 菜单里列哪几家：有 Key 的内置厂商、本机、自定义服务（同 dimensio 自己的型号菜单只列能用的）
export function dimProviders() {
  const info = rt.dim.info;
  const list = Array.isArray(info?.catalog) ? info.catalog : [];
  return list.filter((p) => p && (p.custom || p.id === 'local' || info.providers?.[p.id]) && (p.models || []).length);
}
const dimSpec = (provider, model) => {
  const p = (rt.dim.info?.catalog || []).find((x) => x.id === provider);
  return { p, m: p?.models?.find((x) => x.id === model || (x.aliases || []).includes(model)) || null };
};
/** 「厂商 · 型号」的显示名；目录没拉到 / 认不出就用 id。 */
export function dimModelText(provider, model) {
  if (!provider) return '';
  const { p, m } = dimSpec(provider, model);
  return `${p ? vendorName(p) : provider} · ${m ? tr(m.label || m.id) : (model || '')}`.replace(/ · $/, '');
}
// 档位按 harness 的规则收到这个型号支持的（catalog.ts clampEffort 的通用分支：不超过要的那档里最高的，没有就最低的）
const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function clampLv(efforts, lv) {
  if (!efforts.length || efforts.includes(lv)) return lv;
  const want = EFFORT_ORDER.indexOf(lv);
  const below = efforts.filter((e) => EFFORT_ORDER.indexOf(e) <= want);
  return below.length ? below.reduce((a, b) => (EFFORT_ORDER.indexOf(b) > EFFORT_ORDER.indexOf(a) ? b : a)) : [...efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))[0];
}
/** 这个型号能选的思考深度 [{ id, name }]（没选型号 = dimensio 设置里的默认型号）。 */
export function dimEfforts(provider, model) {
  const cfg = rt.dim.config;
  const { m } = provider ? dimSpec(provider, model) : dimSpec(cfg?.provider, cfg?.model);
  const labels = m?.effortLabels || {};
  return (m?.efforts || []).map((lv) => ({ id: lv, name: labels[lv] !== undefined ? dimEffortText(labels[lv]) : lv }));
}
/** 没定思考深度时实际会用哪一档（dimensio 设置里的默认深度，收到这个型号支持的）。 */
export function dimDefaultEffort(provider, model) {
  const lv = rt.dim.config?.thinking;
  const list = dimEfforts(provider, model).map((e) => e.id);
  return lv ? clampLv(list, lv) : list[0] || '';
}
// dimensio 的运行档位（文案与 设置 › dimensio 同一套）
const DIM_MODE_TEXT = {
  auto: () => [t('自主执行'), t('直接执行。规则可把个别高危调用改成每次问我。')],
  'read-only': () => [t('只读'), t('只放行读取类工具，写文件与执行命令一律拒绝。')],
  plan: () => [t('先出计划'), t('只读研究 → 提交计划 → 你批准后当场转自主并开工。')],
  bypass: () => [t('全权'), t('所有工具调用直接执行、不弹卡，整机可读写，连密钥守卫都关掉。谨慎使用。')],
};
export const dimModeLabel = (m) => (DIM_MODE_TEXT[m] ? DIM_MODE_TEXT[m]()[0] : m || '');
export const dimModeDesc = (m) => (DIM_MODE_TEXT[m] ? DIM_MODE_TEXT[m]()[1] : '');

/** 打开某次运行的会话：dimensio 的去 dimensio 页（sessionFamily 的深链），其余在 Claude 页打开。 */
export async function openRoutineSession(id, agent) {
  if (!id) return;
  ui.routinesOpen = false;
  if (agent === 'dimensio') {
    const { openDimensioSession } = await import('./sessionFamily.svelte.js');
    await openDimensioSession(String(id));
    return;
  }
  const { openSession } = await import('./chat.svelte.js');
  openSession(String(id));
}

busOn((ev) => {
  if (ev.type === 'question' && ui.routinesOpen && rt.running.length) { loadRoutines(); return; }
  if (ev.type !== 'routine') return;
  if (ui.routinesOpen || rt.loaded) loadRoutines();
  if (ev.state !== 'end' || !ev.notify || ev.status === 'skipped') return;
  if (noticesLive()) return;   // 服务端会话消息通知接手（lib/notices.svelte.js：横幅 / 系统通知 / 铃声）
  const ok = ev.status === 'ok';
  const title = ok ? t('定时任务「{name}」已完成', { name: ev.name || '' }) : t('定时任务「{name}」没有跑成', { name: ev.name || '' });
  // 页面在后台：系统通知（跟「任务完成」那类通知开关走）；在前台：页内提示
  if (!notifyKind('done', { title, body: ev.preview || '', tag: 'rt:' + ev.id + ':' + (ev.sessionId || Date.now()) })) {
    if (typeof document !== 'undefined' && !document.hidden) showToast(title, ok ? 'ok' : 'err');
  }
});
