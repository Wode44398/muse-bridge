// 设置 › 壁纸 / 流体壁纸（iOS 外壳）：明暗两套壁纸、上传与长按删除、实景舞台的状态；流体壁纸滑柱。
// 舞台的液态分段指示器（要它自己的 DOM 节点）在 WallpaperStage.svelte 里。
import { ui, setHomeMode, fluxParams, saveFlux } from '../../../lib/state.svelte.js';
import { t } from '../../../lib/i18n.js';
import { wp, wpDef, setWp, addUpload, deleteUpload, splitWpFiles, spatial, setSpatialOn, wpIsUpload } from '../../../lib/wallpaper.svelte.js';
import { compressImage } from '../../../lib/settings/common.js';

export function createWallpaper(S) {
  let stage = $state(null);       // null | 'light' | 'dark' 壁纸实景舞台（设置页退开、主页即预览；外壳读它决定退不退开、返回键先关它）
  // —— 流体壁纸参数（仅暗主题 glassMode A 装载该壁纸时显示）——
  function fluxFmt(s, v) { return s.step ? (Math.round(v / s.step) * s.step).toFixed(s.step < 0.1 ? 2 : 1) : Math.round(v); }
  // pow2 的参数（流体尺寸）滑条按指数走：32/64/128/256/512 均分整条
  function fluxFrac(s) {
    const v = fluxParams[s.key] ?? s.min;
    const f = s.pow2 ? (Math.log2(v) - Math.log2(s.min)) / (Math.log2(s.max) - Math.log2(s.min)) : (v - s.min) / (s.max - s.min);
    return Math.max(0, Math.min(1, f));
  }
  function fluxInput(s, f) {
    if (s.pow2) { const a = Math.log2(s.min), b = Math.log2(s.max); fluxParams[s.key] = 2 ** Math.round(a + f * (b - a)); return; }
    const raw = s.min + f * (s.max - s.min);
    fluxParams[s.key] = s.step ? Math.round(raw / s.step) * s.step : Math.round(raw);
  }
  function fluxDown(s) { S.shell.sliding = 'flux-' + s.key; ui.settingsPreview = true; }
  function fluxUp() { S.shell.sliding = null; ui.settingsPreview = false; saveFlux(); }
  function pickColor(cm) { fluxParams.colormode = cm; saveFlux(); }

  // —— 壁纸 ——
  const homeSys = $derived(ui.glassMode === 'B' ? 'light' : 'dark');
  const gridItems = (slot, ids) => [...ids, ...wp.uploads.map((u) => u.id)];
  function pickGrid(slot, id) {
    setWp(slot, id);
    setHomeMode(slot === 'light' ? 'B' : 'A');   // 点谁就实时预览谁的系统
  }
  function enterStage(sys) { setHomeMode(sys === 'light' ? 'B' : 'A'); stage = sys; ui.wpStage = true; }
  function stageSwap(sys) { setHomeMode(sys === 'light' ? 'B' : 'A'); stage = sys; }
  function exitStage() { stage = null; ui.wpStage = false; }
  async function onUpload(slot, e) {
    const files = [...(e.target?.files || [])];
    e.target.value = '';
    if (!files.length) return;
    const s = slot || stage || homeSys;
    wpErr = '';
    const pair = splitWpFiles(files);                     // 单张 = 普通壁纸；原图 + 深度图 = 空间壁纸
    if (!pair) { wpErr = t('要做空间壁纸，请只选原图和深度图两张，深度图文件名带 depth'); return; }
    try {
      const f = await compressImage(pair.image);          // 降采样到 ≤1600 再传，省工作空间体积
      const d = pair.depth && await compressImage(pair.depth);
      const id = await addUpload(f, s, d);                // POST 到工作空间「壁纸」文件夹
      setWp(s, id);
      if (!stage) setHomeMode(s === 'light' ? 'B' : 'A');
    } catch { wpErr = t('壁纸上传失败，重试'); }
  }

  // —— 上传壁纸管理（长按/右键 → 删除菜单）——
  let wpMenu = $state(null);
  let wpPressTimer = null, wpPressXY = null, wpSuppressClick = false;
  let wpErr = $state('');

  function wpPressDown(e, id) {
    if (!wpIsUpload(id)) return;
    wpPressXY = { x: e.clientX, y: e.clientY };
    wpPressTimer = setTimeout(() => openWpMenu(e, id), 450);
  }
  function wpPressMove(e) {
    if (!wpPressTimer || !wpPressXY) return;
    if (Math.hypot(e.clientX - wpPressXY.x, e.clientY - wpPressXY.y) > 9) { clearTimeout(wpPressTimer); wpPressTimer = null; }
  }
  function wpPressUp() { if (wpPressTimer) { clearTimeout(wpPressTimer); wpPressTimer = null; } }
  // 菜单从按压点弹出（ios27/MorphMenu 长按形态：自己避让屏幕边缘；手指不松开直接滑到「删除」上松手也算）
  function openWpMenu(e, id) {
    if (!wpIsUpload(id)) return;
    wpPressTimer = null; wpSuppressClick = true;
    try { navigator.vibrate?.(8); } catch {}
    wpMenu = { id, x: e.clientX, y: e.clientY, name: wpDef(id)?.name || '' };
  }
  function closeWpMenu() { wpMenu = null; }
  async function wpMenuDelete(id) {
    wpMenu = null;
    await deleteUpload(id);
  }
  const wpMenuItems = $derived(wpMenu ? [{ label: t('删除壁纸'), symbol: 'trash', destructive: true, onclick: ((id) => () => wpMenuDelete(id))(wpMenu.id) }] : []);
  function consumeLongPress() { if (wpSuppressClick) { wpSuppressClick = false; return true; } return false; }
  function wpCardClick(slot, id) { if (consumeLongPress()) return; pickGrid(slot, id); }

  function onSpatialToggle() { setSpatialOn(stage, !spatial[stage].on); }
  return {
    get stage() { return stage; }, fluxFmt, fluxFrac, fluxInput, fluxDown, fluxUp, pickColor,
    get homeSys() { return homeSys; }, gridItems, pickGrid, enterStage, stageSwap, exitStage, onUpload,
    get wpMenu() { return wpMenu; }, set wpMenu(v) { wpMenu = v; }, get wpErr() { return wpErr; },
    wpPressDown, wpPressMove, wpPressUp, openWpMenu, closeWpMenu, get wpMenuItems() { return wpMenuItems; }, wpCardClick, onSpatialToggle,
  };
}
