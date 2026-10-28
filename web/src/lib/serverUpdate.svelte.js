// 设置里的「服务端更新」（管理员）：手机 / 网页「关于」页与桌面「连接与更新」共用，状态与文案在这里，两边只管摆行。
// 10-28 维护者：「服主在设置里直接查 GitHub 上的版本、一键更新」。接口 /api/admin/server-update（routes/admin.mjs →
// src/runtime/server-update.mjs）：{ form, current, latest, newer, notes, page, feed, oneClick, how, device, job, script, restart }。
// 不是管理员 / 老服务端没有这条 → 404，load() 把 st 置空，这一组不出现。
// 「等对话跑完再装 / 正在装」以总线 server.restart 为准（updateInfo.serverRestart，appUpdate.js 末尾），比接口里的 restart 更及时。
import { api } from './api.js';
import { updateInfo } from './updateStore.svelte.js';
import { t, tr } from './i18n.js';

const errText = (e) => tr(String((e && e.body && (e.body.error || (typeof e.body === 'string' ? e.body : ''))) || (e && e.message) || ''));

/**
 * 这一行怎么说：{ sub, action: 'update' | 'check' | 'script' | null, label, tone: '' | 'warn', how }。
 * action：update = 一键更新；check = 去 GitHub 重新查；script = 跑更新脚本（git 部署：有没有新代码跑了才知道）。
 */
export function serverUpdateView(st, live = updateInfo.serverRestart) {
  if (!st) return null;
  const cur = st.current || st.app || '';
  const rs = live || st.restart;
  if (rs && rs.reason === 'update') {
    if (rs.phase === 'going') return { sub: t('服务器正在更新，一两分钟后自动重连'), action: null, label: '', tone: '', how: '' };
    const n = Number(rs.live) || 0;
    return { sub: n ? t('等 {n} 个对话跑完后更新并重启', { n }) : t('等服务器空闲后更新并重启…'), action: null, label: '', tone: '', how: '' };
  }
  if (st.form === 'desktop') {
    const job = st.job && st.job.via === 'desktop' ? st.job : null;
    // 交给客户端去下了：服务端看不到客户端那头的下载进度，下载失败也只有客户端知道——留着「重试」（客户端正在下 / 正等着装会回 busy，不会下两遍）
    if (job && job.result && job.result.status === 'downloading' && st.newer) {
      return { sub: t('已交给 {name} 下载 v{v}：下好后等所有对话跑完自动安装，服务端会重启一次', { name: (st.device && st.device.name) || t('桌面客户端'), v: job.version || st.latest }), action: st.oneClick ? 'update' : null, label: t('重试'), tone: '', how: st.oneClick ? '' : tr(st.how || '') };
    }
    if (st.newer) {
      return {
        sub: t('GitHub 上有新版 v{v}（现在是 v{cur}）', { v: st.latest, cur }),
        action: st.oneClick ? 'update' : null, label: t('一键更新'), tone: '', how: st.oneClick ? '' : tr(st.how || ''),
      };
    }
    if (st.feed && st.feed.ok === false && st.feed.checkedAt) {
      return { sub: t('v{cur} · 暂时查不到 GitHub 上的新版本（{error}）', { cur, error: tr(st.feed.error || '') }), action: 'check', label: t('重试'), tone: 'warn', how: '' };
    }
    return { sub: t('v{cur} · 已是最新', { cur }), action: 'check', label: t('检查更新'), tone: '', how: '' };
  }
  if (st.form === 'script') {
    const u = st.script || {};
    if (u.running) return { sub: t('正在更新：拉代码、装依赖、重建前端…'), action: null, label: '', tone: '', how: '' };
    if (u.exitCode != null && u.exitCode !== 0) return { sub: t('上次更新失败（退出码 {code}），看服务端控制台的最近日志', { code: u.exitCode }), action: 'script', label: t('检查并更新'), tone: 'warn', how: '' };
    if (u.result === 'updated') return { sub: t('新代码已就位'), action: null, label: '', tone: '', how: '' };
    if (u.result === 'unchanged') return { sub: t('已经是最新'), action: 'script', label: t('检查并更新'), tone: '', how: '' };
    return { sub: t('从 git 仓库拉最新代码、装依赖、重建前端，完成后空闲时重启'), action: 'script', label: t('检查并更新'), tone: '', how: '' };
  }
  return { sub: cur ? 'v' + cur : '', action: null, label: '', tone: '', how: tr(st.how || '') };
}

// 点完「一键更新」那一句（服务端回 { via, result | update }；result 是桌面客户端的回答，见 runtime/server-update.mjs）
function resultNote(r, st) {
  if (!r) return '';
  if (r.via === 'script') return t('已开始更新，完成后空闲时重启');
  const res = r.result || {};
  if (res.status === 'downloading') return t('已开始：{name} 正在下载 v{v}，下好后等所有对话跑完自动安装', { name: (r.device && r.device.name) || t('桌面客户端'), v: r.latest || (st && st.latest) || '' });
  if (res.status === 'latest') return t('已是最新版本');
  return tr(res.reason || '');
}

/** 一组状态 + 动作。st 为 null = 不是管理员 / 老服务端，不出这一组。 */
export function createServerUpdate() {
  const s = $state({ st: null, loading: false, busy: false, err: '', note: '' });
  async function load(refresh = false) {
    s.loading = true;
    try { s.st = await api.get('/api/admin/server-update' + (refresh ? '?refresh=1' : '')); s.err = ''; }
    catch (e) {
      if (e && (e.status === 404 || e.status === 401 || e.status === 403)) s.st = null;
      else s.err = errText(e) || t('检查更新失败');
    } finally { s.loading = false; }
  }
  async function act(action) {
    if (s.busy || s.loading) return;
    if (action === 'check') { s.note = ''; await load(true); return; }
    s.busy = true; s.err = ''; s.note = '';
    try {
      const r = await api.post('/api/admin/server-update', {});
      s.note = resultNote(r, s.st);
      await load();
    } catch (e) { s.err = errText(e) || t('更新没能开始'); }
    finally { s.busy = false; }
  }
  return {
    get st() { return s.st; },
    get loading() { return s.loading; },
    get busy() { return s.busy; },
    get err() { return s.err; },
    get note() { return s.note; },
    get view() { return serverUpdateView(s.st); },
    load, act,
  };
}
