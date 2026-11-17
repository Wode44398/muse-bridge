// 设置 › Claude 页（iOS 外壳）：注册表驱动的设置行、分支前缀、思考动画、订阅号池（逐号用量、账号表单）。
// 外壳 components/Settings.svelte 按原来的先后顺序调用这里的 create*（effect 与请求的次序不变）；S 是外壳的设置上下文（导航等）。
import { untrack } from 'svelte';
import { prefs, savePrefs } from '../../../lib/state.svelte.js';
import { t, tr } from '../../../lib/i18n.js';
import { cs } from '../../../lib/claudeSettings.svelte.js';
import { S as CS, val, setVal, errText } from '../../../lib/claudeSettingsView.js';
import { branchPrefixError } from '../../../../../src/config/claude-settings.mjs';
import { ags, loadUsage, loadResets, deleteAccount } from '../../../lib/agentSettings.svelte.js';
import { MARKS } from '../../../lib/settings/common.js';
import { createAcctForm, createBypass } from '../../../lib/settings/common.svelte.js';

// —— 设置 › Claude（2026-10-20 对齐官方 Desktop「Settings → Claude Code」）——
// 注册表 src/config/claude-settings.mjs、数据面 lib/claudeSettings.svelte.js、取值与文案 lib/claudeSettingsView.js（两套外壳共用）。
// Claude 页只放常用组（撞上限额时 / 服务意外重启时 / 新会话默认 / 对话 / 会话协作 / 安全），Git 与拉取请求、会话管理、通知、这台电脑、
// 扩展与记忆折成推入行；枚举项推入单选子页（cl-<键>，每项一行说明）。输入建议、自动压缩点 10-20 起存服务端。
// 「自动压缩点」在对话页用量弹层上拖；这里只给一个恢复默认（CLI 自定）的出口
export const CL_CHOICE = { 'cl-perm': 'permissionMode', 'cl-style': 'outputStyle', 'cl-qto': 'questionTimeout', 'cl-lang': 'replyLanguage', 'cl-cache': 'cacheExpiry',
  'cl-newsess': 'newSessionPolicy', 'cl-inbound': 'crossSessionInbound', 'cl-base': 'worktreeBaseRef', 'cl-attrib': 'attribution', 'cl-archive': 'autoArchiveDays', 'cl-quick': 'quickRetention',
  'cl-pmax': 'projectMaxLive', 'cl-pdaily': 'projectDailyThreads', 'cl-pmodel': 'projectThreadModel', 'cl-peffort': 'projectThreadEffort' };
export const CL_GROUP = { 'cl-git': () => t('Git 与拉取请求'), 'cl-sessions': () => t('会话管理'), 'cl-notify': () => t('通知'), 'cl-host': () => t('这台电脑'), 'cl-ext': () => t('扩展与记忆') };

export function createClaudePrefs() {
  const clErr = $derived(errText(cs.err));
  const GIT_KEYS = ['branchPrefix', 'worktreeBaseRef', 'autoFixPullRequests', 'autoArchiveOnPrClose', 'attribution'];
  // 允许绕过权限模式：打开前先确认（危险操作的解释放在确认框里，页面上不写；状态与确认框的动作两套外壳共用，lib/settings/common.svelte.js）
  const bypass = createBypass();
  function toggleCs(key) { bypass.setCs(key, !val(key)); }
  // 分支前缀：警告框 + 文本框（同服务器地址那种），本地先按注册表校验，服务端再校验一次
  let prefixEdit = $state(null);   // null | { value, err, busy }
  function openPrefix() { cs.err = ''; prefixEdit = { value: val('branchPrefix') === CS.branchPrefix.default ? '' : val('branchPrefix'), err: '', busy: false }; }
  async function savePrefix() {
    const e = prefixEdit;
    if (!e || e.busy) return;
    const bad = branchPrefixError(e.value);
    if (bad) { e.err = tr(bad); return; }
    e.busy = true;
    if (await setVal('branchPrefix', e.value.trim() || null)) prefixEdit = null;
    else { e.err = errText() || t('分支前缀没保存上，请重试'); cs.err = ''; e.busy = false; }
  }
  // 「思考动画」三套（MARKS 两套外壳共用，lib/settings/common.js）
  const markLabel = $derived((MARKS.find((x) => x.value === prefs.claudeMark) || MARKS[0]).label());
  function setMark(v) { prefs.claudeMark = v; savePrefs(); }
  return {
    get clErr() { return clErr; }, GIT_KEYS, toggleCs,
    get bypassAsk() { return bypass.bypassAsk; }, set bypassAsk(v) { bypass.bypassAsk = v; }, confirmBypass: bypass.confirmBypass,
    get prefixEdit() { return prefixEdit; }, set prefixEdit(v) { prefixEdit = v; }, openPrefix, savePrefix,
    MARKS, get markLabel() { return markLabel; }, setMark,
  };
}

export function createClaudePool(S) {
  // Claude 页：进页才拉逐号用量（服务端 5 分钟缓存；每号一次 max_tokens:1 探针，别在根页就打）
  const claudeOpen = $derived(S.nav.stack.includes('ag-claude'));
  $effect(() => { if (claudeOpen && ags.poolOk) untrack(() => { loadUsage(); loadResets(); }); });
  const routerOn = $derived(!!ags.router?.settings?.enabled);
  const acctById = (id) => ags.accounts.find((x) => x.id === id) || null;
  // 添加 / 编辑账号（表单页）、删除账号（警告框）：表单状态两套外壳共用（lib/settings/common.svelte.js）
  const form = createAcctForm();
  async function confirmAcctDel() {
    const a = form.acctDel; form.acctDel = null;
    if (a && await deleteAccount(a.id) && S.nav.stack[S.nav.stack.length - 1] === 'acct:' + a.id) S.nav.pop();
  }
  return {
    get routerOn() { return routerOn; }, acctById,
    get acctForm() { return form.acctForm; }, set acctForm(v) { form.acctForm = v; },
    get acctDel() { return form.acctDel; }, set acctDel(v) { form.acctDel = v; },
    openAddAcct: form.openAddAcct, openEditAcct: form.openEditAcct, saveAcctForm: () => form.saveAcctForm(), confirmAcctDel,
  };
}
