// Antigravity 设置响应式数据面（Svelte 5 runes）：桌面设置分区、手机 iOS 设置子页与 Antigravity 分页同源共享。

import { caps, me } from '../state.svelte.js';
import { showToast } from '../toast.svelte.js';
import { t } from '../i18n.js';
import { agyApi } from './api.js';
import { recall, remember } from '../lastKnown.js';
import {
  groupModels,
  extractThoughtOptions,
  extractModeOptions,
} from './catalog.js';
import {
  createInitialAgyPrefsState,
  createAgySettingsController,
} from './settings-logic.js';

// 上次看到的设置与运行状态（lib/lastKnown）：冷开设置推进 Antigravity 页时第一帧就是完整的各组，不先出「读取中…」。
// 只放进 snap 标记、不动 loaded：loaded 仍表示「这次真拉到过」，ensureAgySettingsLoaded 与各处补拉据它判断
function seedFromSnap(st) {
  const o = recall('agyPrefs');
  if (!o || typeof o !== 'object' || !o.settings) return st;
  Object.assign(st.settings, o.settings);
  if (o.defaults) Object.assign(st.defaults, o.defaults);
  if (o.status) st.status = o.status;
  if (Array.isArray(o.projects)) st.projects = o.projects;
  if (typeof o.hiddenCount === 'number') st.hiddenCount = o.hiddenCount;
  if (typeof o.phonePluginOn === 'boolean') st.phonePluginOn = o.phonePluginOn;
  if (Array.isArray(o.mcp)) st.mcp.items = o.mcp;
  if (Array.isArray(o.plugins)) st.plugins.items = o.plugins;
  st.snap = true;
  return st;
}
export const agyPrefs = $state(seedFromSnap({ ...createInitialAgyPrefsState(), snap: false }));

// 控制器（settings-logic，纯逻辑、要能单测）在很多处写状态：这里统一盯着，真拉到过之后有变化就记一份（remember 自带去抖与去重）
$effect.root(() => {
  $effect(() => {
    if (!agyPrefs.loaded) return;
    remember('agyPrefs', {
      settings: $state.snapshot(agyPrefs.settings),
      defaults: $state.snapshot(agyPrefs.defaults),
      status: $state.snapshot(agyPrefs.status),
      projects: $state.snapshot(agyPrefs.projects),
      hiddenCount: agyPrefs.hiddenCount,
      phonePluginOn: agyPrefs.phonePluginOn,
      mcp: $state.snapshot(agyPrefs.mcp.items),
      plugins: $state.snapshot(agyPrefs.plugins.items),
    });
  });
});

let syncChatDefaultsHook = null;
export function registerAgyChatDefaultsHook(fn) {
  syncChatDefaultsHook = fn;
}

const ctl = createAgySettingsController({
  state: agyPrefs,
  api: agyApi,
  onError: (msg) => {
    if (msg) showToast(msg, 'err');
  },
  onSyncDefaults: (nextSettings) => {
    syncChatDefaultsHook?.(nextSettings);
  },
});

export const {
  loadAll: loadAgySettingsAll,
  refreshStatus: refreshAgyRuntimeStatus,
  loadMcp: loadAgyMcp,
  loadPlugins: loadAgyPlugins,
  patchSettings: patchAgySettings,
  addExtraDir: addAgyExtraDir,
  removeExtraDir: removeAgyExtraDir,
  resetSystemPrompt: resetAgySystemPrompt,
  toggleMcp: toggleAgyMcp,
  addMcp: addAgyMcp,
  removeMcp: removeAgyMcp,
  togglePlugin: toggleAgyPlugin,
  installPlugin: installAgyPlugin,
  uninstallPlugin: uninstallAgyPlugin,
  logout: logoutAgyAccount,
  restartDaemon: restartAgyDaemon,
  checkUpdate: checkAgyUpdate,
  restoreAllHidden: restoreAllHiddenFromSettings,
  setErr: setAgySettingsErr,
} = ctl;

let bootLoadPromise = null;
export function ensureAgySettingsLoaded() {
  if (agyPrefs.loaded) return Promise.resolve();
  bootLoadPromise ||= agyApi.getSettings().then((res) => {
    if (res?.defaults) Object.assign(agyPrefs.defaults, res.defaults);
    if (res?.settings) {
      Object.assign(agyPrefs.settings, res.settings);
      syncChatDefaultsHook?.(agyPrefs.settings);
    }
    if (typeof res?.hiddenCount === 'number') agyPrefs.hiddenCount = res.hiddenCount;
    if (typeof res?.phonePluginOn === 'boolean') agyPrefs.phonePluginOn = res.phonePluginOn;
    agyPrefs.loaded = true;
  }).catch(() => {}).finally(() => {
    bootLoadPromise = null;
  });
  return bootLoadPromise;
}

export function settingsFallbackCaps() {
  return agyPrefs.status?.fallbackCapabilities || caps.data?.agy || {
    models: [],
    modes: [],
    efforts: [],
    defaults: { model: 'gemini-4-neon', effort: 'medium', mode: 'default' },
  };
}

export function settingsModelCatalog() {
  const fb = settingsFallbackCaps();
  const cfgOpts = agyPrefs.status?.catalog?.configOptions || [];
  return groupModels(cfgOpts, fb.models);
}

export function settingsThoughtCatalog(forModelId = agyPrefs.settings.defaultModel) {
  const fb = settingsFallbackCaps();
  const cfgOpts = agyPrefs.status?.catalog?.configOptions || [];
  // 设置里选的是指定默认模型的思考档位：当目录来自其它模型的在线 configOptions 时，按模型能力表裁剪
  const liveCurrentModel = cfgOpts.find((c) => c?.id === 'model')?.currentValue;
  const useLive = cfgOpts.length > 0 && liveCurrentModel === forModelId;
  return extractThoughtOptions(useLive ? cfgOpts : [], fb.efforts, forModelId, fb.models);
}

export function settingsModeCatalog() {
  const fb = settingsFallbackCaps();
  const cfgOpts = agyPrefs.status?.catalog?.configOptions || [];
  const liveModes = agyPrefs.status?.catalog?.modes || null;
  return extractModeOptions(cfgOpts, liveModes, fb.modes);
}

// 调试模式（服务端只认主机管理员，见 modules/agy/server/debug-mode.mjs）：设置页也只给管理员看，桌面与手机共用一句说明
export const agyDebugVisible = () => me.kind === 'admin';
// 账号登录、agy 的全局 MCP 服务与插件、进程重启与 CLI 升级都是主机上那个 agy 的事：只有主机管理员能动，
// 注册成员（用自己单独的 agy 进程）看不到这几块
export const agyHostAdmin = () => me.kind === 'admin';
export function agyDebugDesc() {
  return t('让 Antigravity 批判性地使用 harness：工具报错先查是不是工具的锅，遇到冗余设计、缺的功能、不得不绕的路都记成反馈，存进服务端根目录的 harness-feedback 文件夹。用来改进 harness，开着时任务本身排第二；改动在常驻进程空闲时自动重启一次后生效');
}

export function agyThemeOptions() {
  return [
    { value: 'system', label: t('跟随 Bridge') },
    { value: 'azure', label: t('Azure（深色）') },
    { value: 'daylight', label: t('Daylight（浅色）') },
  ];
}

export function agyFontSizeOptions() {
  return [
    { value: 'sm', label: t('小') },
    { value: 'md', label: t('标准') },
    { value: 'lg', label: t('大') },
  ];
}

export function authMethodLabel(methodId = '') {
  switch (String(methodId || '').toLowerCase()) {
    case 'consumer':
    case 'oauth-personal':
      return t('Google 个人账号（OAuth）');
    case 'oauth-business':
      return t('Gemini Enterprise 企业账号');
    case 'gemini-api-key':
      return t('Gemini API Key');
    case 'agent-platform':
      return t('Vertex AI / 默认应用凭据（ADC）');
    default:
      return methodId || t('本机凭据');
  }
}

export function daemonStateText(st) {
  if (!st) return t('未连接');
  if (st.stoppedAfterCrashes) return t('连续异常退出（已封顶停止）');
  if (st.running) return t('运行中');
  if (st.state === 'starting') return t('正在启动…');
  return t('空闲待命');
}
