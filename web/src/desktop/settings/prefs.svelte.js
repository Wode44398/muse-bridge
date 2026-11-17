// 桌面设置：通用 / 外观的开关、Claude 设置里的绕过确认与分支前缀、全局快捷键、壁纸。外壳 SettingsDesktop.svelte 按原来的先后创建。
import { ui, prefs, savePrefs, setHomeMode, applyFollowSys, setTheme } from '../../lib/state.svelte.js';
import { t, tr } from '../../lib/i18n.js';
import { np } from '../../lib/notices.svelte.js';
import { cs } from '../../lib/claudeSettings.svelte.js';
import { setVal, errText } from '../../lib/claudeSettingsView.js';
import { branchPrefixError } from '../../../../src/config/claude-settings.mjs';
import { wp, setWp, addUpload, splitWpFiles } from '../../lib/wallpaper.svelte.js';
import { MARKS, compressImage } from '../../lib/settings/common.js';
import { createBypass } from '../../lib/settings/common.svelte.js';

export function createDeskGeneral(D) {
  // ═══ 通用 ═══
  // 通知总开关（bridge-notify）：与 通用 › 通知、手机设置页、notices.svelte.js 同一份
  const notifyOn = $derived(np.on);   // 开关本身在 NotifySection（onMaster 顺带同步桌面壳的系统通知总开关）
  // 开机自启（壳注册表 Run 键 + --hidden 静默到托盘）：真相在主进程，进设置拉一次。
  // 附着形态/旧壳/开发模式没有这个桥或 supported=false，行自然隐藏。
  let autoStart = $state({ supported: false, enabled: false });
  if (D.asCtl) D.asCtl.state().then((s) => { if (s) autoStart = s; }).catch(() => {});
  async function onAutoStart(v) {
    if (!D.asCtl) return;
    try {
      const r = await D.asCtl.set(v);
      if (r) autoStart = { supported: r.supported ?? autoStart.supported, enabled: r.enabled ?? v };
    } catch { /* 保持原状 */ }
  }

  function onFollowSys(v) { prefs.followSys = v; savePrefs(); if (v) applyFollowSys(); }
  // 外观三选一：手动选明暗＝关掉跟随系统；明暗全局统一，主页与各分页一起换
  const themeNow = $derived(prefs.followSys ? 'auto' : ui.theme === 'light' ? 'light' : 'dark');
  function pickTheme(v) {
    if (v === 'auto') { onFollowSys(true); return; }
    if (prefs.followSys) { prefs.followSys = false; savePrefs(); }
    setTheme(v);
  }
  function onNoAnim(v) { prefs.noEnterAnim = v; savePrefs(); }
  function onFullRes(v) { prefs.fullResMedia = v; savePrefs(); }
  function onClaudeMark(v) { prefs.claudeMark = v; savePrefs(); }
  // 「思考动画」三套原版动画（MARKS 两套外壳共用）
  const markOpts = $derived(MARKS.map((m) => ({ value: m.value, label: m.label() })));
  return {
    get notifyOn() { return notifyOn; }, get autoStart() { return autoStart; }, onAutoStart, onFollowSys, get themeNow() { return themeNow; }, pickTheme,
    onNoAnim, onFullRes, onClaudeMark, get markOpts() { return markOpts; },
  };
}

export function createDeskClaudePrefs() {
  // —— Claude 设置（ag-claude 分区）——
  const clErr = $derived(errText(cs.err));
  // 允许绕过权限模式打开前确认（解释只放在确认框里）：状态与确认的动作两套外壳共用（lib/settings/common.svelte.js）
  const bypass = createBypass();
  // 分支前缀：失焦 / 回车保存，本地先按注册表校验（官方 220px 输入框同款）
  let prefixErr = $state('');
  async function savePrefix(v) {
    prefixErr = '';
    const bad = branchPrefixError(v);
    if (bad) { prefixErr = tr(bad); return; }
    if (!(await setVal('branchPrefix', String(v || '').trim() || null))) { prefixErr = errText() || t('分支前缀没保存上，请重试'); cs.err = ''; }
  }
  return {
    get clErr() { return clErr; }, toggleCs: bypass.setCs, get bypassAsk() { return bypass.bypassAsk; }, set bypassAsk(v) { bypass.bypassAsk = v; },
    confirmBypass: bypass.confirmBypass, get prefixErr() { return prefixErr; }, set prefixErr(v) { prefixErr = v; }, savePrefix,
  };
}

export function createDeskShortcuts(D) {
  // ═══ 全局快捷键 ═══（桌面壳独有；主进程是唯一真相，这里只读它给的清单）
  let scState = $state({ groups: [], items: [], duplicates: [] });
  let scError = $state('');
  const scItemsOf = (group) => scState.items.filter((i) => i.group === group);
  // 组脚注：把「被占用 / 撞车 / 配置写坏了」三种失效摊开说，别只留一个不响的键。
  function scSub(item) {
    // 标签 / 说明 / 失败原因都来自桌面壳主进程（中文），显示处过 tr()
    if (item.failure) return t('{failure}——换一个组合键', { failure: tr(item.failure) });
    if (item.duplicate) return t('和另一条撞在同一个键上，只有一条能生效');
    if (item.invalid) return t('配置里的「{key}」认不出来，已退回默认', { key: item.invalid });
    if (!item.enabled) return t('已关闭');
    return tr(item.hint);
  }
  async function scRefresh() {
    if (!D.scCtl) return;
    try { scState = await D.scCtl.state(); } catch {}
  }
  async function scSet(id, accelerator) {
    if (!D.scCtl) return;
    scError = '';
    try {
      const r = await D.scCtl.set(id, accelerator);
      if (r?.state) scState = r.state;
      if (r && !r.ok) scError = tr(r.error) || t('改键失败');
    } catch (e) { scError = tr(e?.message) || t('改键失败'); }
  }
  async function scReset() {
    if (!D.scCtl) return;
    scError = '';
    try { scState = await D.scCtl.reset(); } catch (e) { scError = tr(e?.message) || t('恢复默认失败'); }
  }
  return { get scState() { return scState; }, set scState(v) { scState = v; }, get scError() { return scError; }, scItemsOf, scSub, scRefresh, scSet, scReset };
}

export function createDeskWallpaper() {
  // ═══ 壁纸 ═══
  const gridOf = (ids) => [...ids, ...wp.uploads.map((u) => u.id)];
  // bgStyle 两套外壳共用（lib/settings/common.js）
  function pick(slot, id) { setWp(slot, id); setHomeMode(slot === 'light' ? 'B' : 'A'); }
  let wpErr = $state('');
  let upInputL = $state(), upInputD = $state();
  // 上传前降采样：compressImage（lib/settings/common.js，两套外壳共用）
  async function onUpload(slot, e) {
    const files = [...(e.target?.files || [])];
    e.target.value = '';
    if (!files.length) return;
    wpErr = '';
    const pair = splitWpFiles(files);   // 单张 = 普通壁纸；原图 + 深度图 = 空间壁纸
    if (!pair) { wpErr = t('要做空间壁纸，请只选原图和深度图两张，深度图文件名带 depth'); return; }
    try {
      const f = await compressImage(pair.image);
      const d = pair.depth && await compressImage(pair.depth);
      const id = await addUpload(f, slot, d);
      pick(slot, id);
    } catch { wpErr = t('壁纸上传失败，重试'); }
  }
  return {
    gridOf, pick, get wpErr() { return wpErr; }, get upInputL() { return upInputL; }, set upInputL(v) { upInputL = v; },
    get upInputD() { return upInputD; }, set upInputD(v) { upInputD = v; }, onUpload,
  };
}
