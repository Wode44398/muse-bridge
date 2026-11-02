// 定时任务页的数据与文案拼装（页面：components/RoutinesPage.svelte，服务端：src/routes/routines.mjs）。
//   rt.items      任务列表（服务端原样：schedule / cwd / worktree / permissionMode / runs[] …）
//   rt.running    正在跑的任务 id；rt.live[id] = { sessionId, waiting }（waiting = 停在审批卡 / 提问上等你）
//   rt.home       默认工作空间（任务没选文件夹时跑在这里）；rt.permissionModes 这个身份能选的权限模式；rt.tz 服务器时区
// 总线 'routine' 事件（routines-runner.mjs）：开跑 / 收尾时刷新列表；任务开了「跑完通知我」就在收尾时提醒。
import { api } from './api.js';
import { busOn } from './bus.js';
import { ui } from './state.svelte.js';
import { notifyKind } from './notify.js';
import { showToast } from './toast.svelte.js';
import { t } from './i18n.js';
export * from './routineText.js';

export const rt = $state({ items: [], running: [], live: {}, home: '', permissionModes: [], tz: null, loading: false, loaded: false, err: '' });

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
      if (d.tz) rt.tz = d.tz;
      rt.err = ''; rt.loaded = true;
    } catch { rt.err = 'load'; }
    rt.loading = false; inflight = null;
  })();
  return inflight;
}

busOn((ev) => {
  if (ev.type === 'question' && ui.routinesOpen && rt.running.length) { loadRoutines(); return; }
  if (ev.type !== 'routine') return;
  if (ui.routinesOpen || rt.loaded) loadRoutines();
  if (ev.state !== 'end' || !ev.notify || ev.status === 'skipped') return;
  const ok = ev.status === 'ok';
  const title = ok ? t('定时任务「{name}」已完成', { name: ev.name || '' }) : t('定时任务「{name}」没有跑成', { name: ev.name || '' });
  // 页面在后台：系统通知（跟「任务完成」那类通知开关走）；在前台：页内提示
  if (!notifyKind('done', { title, body: ev.preview || '', tag: 'rt:' + ev.id + ':' + (ev.sessionId || Date.now()) })) {
    if (typeof document !== 'undefined' && !document.hidden) showToast(title, ok ? 'ok' : 'err');
  }
});
