// 设置 › dimensio 页（iOS 外壳）：数据面 lib/dimensioSettings.svelte.js（与桌面 desktop/settings/DimensioSection 共用）。
import { untrack } from 'svelte';
import { t } from '../../../lib/i18n.js';
import { agentById } from '../../../lib/agentSettings.svelte.js';
import {
  ds, loadDimensio, dimReady, errOf, setErr, setWorkspace, addRules,
  prefLabel, prefDesc, setPref, parsePrefNumber,
} from '../../../lib/dimensioSettings.svelte.js';

// —— dimensio 页（数据面 lib/dimensioSettings.svelte.js，与桌面 DimensioSection 共用）——
// 单选项推入 dm:<项> / dp:<偏好键> 子页；要敲字的（路径、数字 / 文本偏好）走一个警告框 + 文本框（dmEdit）。
// 模型（服务 / 型号 / 思考深度 / Fast）、各厂商 Key、本机模型 11-15 起不在这一页：前者 dimensio 输入框的型号胶囊写的就是同一份
// 新对话默认，Key 归模型中心，本机模型的启停与参数在 dimensio 自己的本机面板。
// 进这一页才拉（会把没在跑的 harness 拉起来）；管理员视角下开关关着 / 跑不起来时不拉。
export const DM_TITLE = { mode: () => t('默认运行档位'),
  access: () => t('访问范围'), allow: () => t('总是允许'), ask: () => t('每次问我'), deny: () => t('从不允许'), diag: () => t('导出诊断包') };

export function createDimensio(S) {
  const dimEnabled = $derived.by(() => { const a = agentById('dimensio'); return !a || (a.switch && a.runnable); });
  const dimOpen = $derived(S.nav.stack.includes('ag-dimensio'));
  $effect(() => { if (dimOpen && dimEnabled) untrack(() => loadDimensio({ quiet: true })); });
  // dimensio 读到了设置才取它那份调用策略（入口行的副标题要读）
  $effect(() => { if (dimOpen && dimEnabled && dimReady()) untrack(S.dp.ddpLoad); });
  let dmEdit = $state(null);   // null | { kind:'ws'|'num'|'text', id?, title, message, value, multiline?, placeholder?, busy, err }
  let dmPicking = $state(false);
  function openWsEdit() {
    dmEdit = { kind: 'ws', title: t('工作空间'), message: t('新对话从这个文件夹开始，已经开着的对话不受影响。'), value: ds.config?.workspace || '', busy: false, err: '' };
  }
  function openPrefEdit(p) {
    dmEdit = { kind: p.type === 'number' ? 'num' : 'text', id: p.key, title: prefLabel(p), message: prefDesc(p), value: String(p.value ?? ''),
      multiline: p.type === 'text', placeholder: p.type === 'number' ? String(p.default) : '', busy: false, err: '' };
  }
  async function saveDmEdit() {
    const e = dmEdit;
    if (!e || e.busy) return;
    let ok = false, tag = '';
    if (e.kind === 'ws') {
      const p = e.value.trim();
      if (!p || p === ds.config?.workspace) { dmEdit = null; return; }
      e.busy = true; tag = 'workspace'; ok = await setWorkspace(p);
    } else {
      const item = ds.prefs?.items?.find((x) => x.key === e.id);
      if (!item) { dmEdit = null; return; }
      let v = e.value;
      if (e.kind === 'num') { const r = parsePrefNumber(item, e.value); if (r.err) { e.err = r.err; return; } v = r.v; }
      else if (v === item.default) v = null;
      e.busy = true; tag = 'pref:' + e.id; ok = await setPref(e.id, v);
    }
    if (ok) dmEdit = null; else { e.err = errOf(tag) || t('保存失败'); setErr('', ''); e.busy = false; }
  }
  function pickDmFolder() { dmEdit = null; dmPicking = true; }
  function resetDmPref() { const k = dmEdit?.id; dmEdit = null; if (k) setPref(k, null); }
  // 规则子页的添加框
  let dmRule = $state('');
  async function addDmRule(kind) { if (await addRules(kind, dmRule)) dmRule = ''; }
  return {
    get dimEnabled() { return dimEnabled; },
    get dmEdit() { return dmEdit; }, set dmEdit(v) { dmEdit = v; }, get dmPicking() { return dmPicking; }, set dmPicking(v) { dmPicking = v; },
    openWsEdit, openPrefEdit, saveDmEdit, pickDmFolder, resetDmPref,
    get dmRule() { return dmRule; }, set dmRule(v) { dmRule = v; }, addDmRule,
  };
}
