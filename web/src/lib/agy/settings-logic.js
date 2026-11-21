// Antigravity 设置纯逻辑与乐观更新回滚控制器：与 Svelte runes 解耦以便 Node 单测直接驱动，
// 桌面端与手机端设置页通过 settings.svelte.js 共享同一个响应式实例。

import { t, tr } from '../i18n.js';

export function createInitialAgyPrefsState() {
  return {
    loaded: false,
    loading: false,
    busy: '',
    errors: {},
    settings: {
      defaultModel: 'gemini-4-neon',
      defaultThoughtLevel: 'medium',
      defaultMode: 'default',
      defaultCwd: '',
      defaultProjectId: '',
      additionalDirectories: [],
      systemPromptAppend: '',
      bridgeTools: { enabled: true, media: true, ui: true, phoneFiles: true, bridgeOps: true, browser: true, terminal: true, workspace: true, device: true, visualize: true, sessions: true, phoneControl: true, pr: true, projectMemory: true, pluginTools: true, remoteConnectors: true },
      theme: 'system',
      particles: true,
      fontSize: 'md',
      fontScale: 100,
      debugMode: false,
    },
    defaults: {
      defaultModel: 'gemini-4-neon',
      defaultThoughtLevel: 'medium',
      defaultMode: 'default',
      defaultCwd: '',
      defaultProjectId: '',
      additionalDirectories: [],
      systemPromptAppend: '',
      bridgeTools: { enabled: true, media: true, ui: true, phoneFiles: true, bridgeOps: true, browser: true, terminal: true, workspace: true, device: true, visualize: true, sessions: true, phoneControl: true, pr: true, projectMemory: true, pluginTools: true, remoteConnectors: true },
      theme: 'system',
      particles: true,
      fontSize: 'md',
      fontScale: 100,
      debugMode: false,
    },
    status: null,
    projects: [],
    hiddenCount: 0,
    phonePluginOn: false,
    mcp: { loading: false, items: [], parseError: false, rawOutput: '' },
    plugins: { loading: false, items: [], parseError: false, rawOutput: '' },
    update: { busy: false, result: null },
  };
}

function cloneBridgeTools(src) {
  const b = src && typeof src === 'object' ? src : {};
  return {
    enabled: b.enabled !== false,
    media: b.media !== false,
    ui: b.ui !== false,
    phoneFiles: b.phoneFiles !== false,
    bridgeOps: b.bridgeOps !== false,
    browser: b.browser !== false,
    terminal: b.terminal !== false,
    workspace: b.workspace !== false,
    device: b.device !== false,
    visualize: b.visualize !== false,
    sessions: b.sessions !== false,
    phoneControl: b.phoneControl !== false,
    pr: b.pr !== false,
    projectMemory: b.projectMemory !== false,
    pluginTools: b.pluginTools !== false,
    remoteConnectors: b.remoteConnectors !== false,
  };
}

function cloneSettings(src) {
  return {
    ...src,
    additionalDirectories: Array.isArray(src?.additionalDirectories) ? [...src.additionalDirectories] : [],
    bridgeTools: cloneBridgeTools(src?.bridgeTools),
  };
}

function errMsgOf(err, fallback) {
  const raw = err?.body?.error || err?.message || '';
  return raw ? tr(String(raw)) : fallback;
}

export function splitCommandArgs(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return [];
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function parseEnvLines(raw = '') {
  const env = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      throw new Error(t('环境变量格式应为 KEY=VALUE：{line}', { line: trimmed }));
    }
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(t('环境变量名不合法：{key}', { key }));
    }
    env[key] = val;
  }
  return env;
}

export function createAgySettingsController({
  state,
  api,
  onError = null,
  onSyncDefaults = null,
}) {
  const setErr = (tag, msg) => {
    if (!msg) delete state.errors[tag];
    else state.errors[tag] = msg;
    if (msg) onError?.(msg, tag);
  };

  async function refreshStatus({ ensure = false, probe = false } = {}) {
    try {
      const st = await api.status(ensure, probe);
      state.status = st;
      if (typeof st?.hiddenCount === 'number') state.hiddenCount = st.hiddenCount;
      setErr('status', '');
      return st;
    } catch (err) {
      setErr('status', errMsgOf(err, t('读取运行状态失败')));
      return null;
    }
  }

  async function loadMcp() {
    state.mcp.loading = true;
    try {
      const res = await api.listMcp();
      state.mcp.items = Array.isArray(res?.items) ? res.items : [];
      state.mcp.parseError = Boolean(res?.parseError);
      state.mcp.rawOutput = String(res?.rawOutput || '');
      setErr('mcp', '');
    } catch (err) {
      setErr('mcp', errMsgOf(err, t('读取 MCP 列表失败')));
    } finally {
      state.mcp.loading = false;
    }
  }

  async function loadPlugins() {
    state.plugins.loading = true;
    try {
      const res = await api.listPlugins();
      state.plugins.items = Array.isArray(res?.items) ? res.items : [];
      state.plugins.parseError = Boolean(res?.parseError);
      state.plugins.rawOutput = String(res?.rawOutput || '');
      setErr('plugins', '');
    } catch (err) {
      setErr('plugins', errMsgOf(err, t('读取插件列表失败')));
    } finally {
      state.plugins.loading = false;
    }
  }

  async function loadAll({ probe = true, quiet = false } = {}) {
    if (!quiet) state.loading = true;
    try {
      const [cfgRes, stRes, projRes] = await Promise.all([
        api.getSettings().catch((e) => { setErr('load', errMsgOf(e, t('读取设置失败'))); return null; }),
        api.status(true, probe).catch(() => null),
        api.listProjects().catch(() => null),
      ]);
      if (cfgRes?.defaults) Object.assign(state.defaults, cloneSettings(cfgRes.defaults));
      if (cfgRes?.settings) {
        Object.assign(state.settings, cloneSettings(cfgRes.settings));
        onSyncDefaults?.(state.settings);
      }
      if (typeof cfgRes?.hiddenCount === 'number') state.hiddenCount = cfgRes.hiddenCount;
      if (typeof cfgRes?.phonePluginOn === 'boolean') state.phonePluginOn = cfgRes.phonePluginOn;
      if (stRes) {
        state.status = stRes;
        if (typeof stRes.hiddenCount === 'number') state.hiddenCount = stRes.hiddenCount;
      }
      if (Array.isArray(projRes?.projects)) state.projects = projRes.projects;
      state.loaded = true;
      await Promise.all([loadMcp(), loadPlugins()]);
    } finally {
      state.loading = false;
    }
  }

  // 乐观更新设置项：界面即时响应，接口报错时完整回滚到上一份快照并暴露错误信息
  async function patchSettings(patch = {}, tag = 'settings') {
    const snapshot = cloneSettings(state.settings);
    const mergedPatch = { ...patch };
    if (mergedPatch.bridgeTools && typeof mergedPatch.bridgeTools === 'object') {
      mergedPatch.bridgeTools = { ...cloneBridgeTools(state.settings.bridgeTools), ...mergedPatch.bridgeTools };
    }
    const optimistic = cloneSettings({ ...state.settings, ...mergedPatch });
    Object.assign(state.settings, optimistic);
    onSyncDefaults?.(state.settings);
    setErr(tag, '');
    state.busy = tag;
    try {
      const res = await api.saveSettings(mergedPatch);
      if (res?.settings) {
        Object.assign(state.settings, cloneSettings(res.settings));
        onSyncDefaults?.(state.settings);
      }
      if (typeof res?.phonePluginOn === 'boolean') state.phonePluginOn = res.phonePluginOn;
      return true;
    } catch (err) {
      Object.assign(state.settings, snapshot);
      onSyncDefaults?.(state.settings);
      setErr(tag, errMsgOf(err, t('保存设置失败')));
      return false;
    } finally {
      if (state.busy === tag) state.busy = '';
    }
  }

  async function addExtraDir(dirPath) {
    const clean = String(dirPath || '').trim();
    if (!clean) return false;
    const cur = Array.isArray(state.settings.additionalDirectories) ? state.settings.additionalDirectories : [];
    if (cur.some((d) => d.toLowerCase() === clean.toLowerCase())) return true;
    return patchSettings({ additionalDirectories: [...cur, clean] }, 'dirs');
  }

  async function removeExtraDir(dirPath) {
    const cur = Array.isArray(state.settings.additionalDirectories) ? state.settings.additionalDirectories : [];
    return patchSettings({ additionalDirectories: cur.filter((d) => d !== dirPath) }, 'dirs');
  }

  async function resetSystemPrompt() {
    return patchSettings({ systemPromptAppend: state.defaults.systemPromptAppend }, 'prompt');
  }

  async function toggleMcp(name, enabled) {
    const idx = state.mcp.items.findIndex((x) => x.name === name);
    const prev = idx >= 0 ? state.mcp.items[idx].enabled : !enabled;
    if (idx >= 0) state.mcp.items[idx].enabled = enabled;
    setErr('mcp', '');
    state.busy = `mcp:${name}`;
    try {
      const res = await api.toggleMcp(name, enabled);
      state.mcp.items = Array.isArray(res?.items) ? res.items : state.mcp.items;
      state.mcp.parseError = Boolean(res?.parseError);
      state.mcp.rawOutput = String(res?.rawOutput || '');
      return true;
    } catch (err) {
      if (idx >= 0 && state.mcp.items[idx]) state.mcp.items[idx].enabled = prev;
      setErr('mcp', errMsgOf(err, t('切换 MCP 状态失败')));
      return false;
    } finally {
      if (state.busy === `mcp:${name}`) state.busy = '';
    }
  }

  async function addMcp({ name, command, argsText = '', envText = '' }) {
    setErr('mcpAdd', '');
    let env = {};
    try {
      env = parseEnvLines(envText);
    } catch (err) {
      setErr('mcpAdd', err.message);
      return false;
    }
    const isHttp = /^https?:\/\//i.test(String(command || '').trim());
    const args = isHttp ? [] : splitCommandArgs(argsText);
    state.busy = 'mcp:add';
    try {
      const res = await api.addMcp({
        name: String(name || '').trim(),
        type: isHttp ? 'http' : 'stdio',
        command: String(command || '').trim(),
        args,
        env,
      });
      state.mcp.items = Array.isArray(res?.items) ? res.items : [];
      state.mcp.parseError = Boolean(res?.parseError);
      state.mcp.rawOutput = String(res?.rawOutput || '');
      return true;
    } catch (err) {
      setErr('mcpAdd', errMsgOf(err, t('添加 MCP 服务失败')));
      return false;
    } finally {
      if (state.busy === 'mcp:add') state.busy = '';
    }
  }

  async function removeMcp(name) {
    const prevItems = [...state.mcp.items];
    state.mcp.items = state.mcp.items.filter((x) => x.name !== name);
    setErr('mcp', '');
    state.busy = `mcp:${name}`;
    try {
      const res = await api.removeMcp(name);
      state.mcp.items = Array.isArray(res?.items) ? res.items : [];
      state.mcp.parseError = Boolean(res?.parseError);
      state.mcp.rawOutput = String(res?.rawOutput || '');
      return true;
    } catch (err) {
      state.mcp.items = prevItems;
      setErr('mcp', errMsgOf(err, t('删除 MCP 服务失败')));
      return false;
    } finally {
      if (state.busy === `mcp:${name}`) state.busy = '';
    }
  }

  async function togglePlugin(name, enabled) {
    const idx = state.plugins.items.findIndex((x) => x.name === name);
    const prev = idx >= 0 ? state.plugins.items[idx].enabled : !enabled;
    if (idx >= 0) state.plugins.items[idx].enabled = enabled;
    setErr('plugins', '');
    state.busy = `plg:${name}`;
    try {
      const res = await api.togglePlugin(name, enabled);
      state.plugins.items = Array.isArray(res?.items) ? res.items : state.plugins.items;
      state.plugins.parseError = Boolean(res?.parseError);
      state.plugins.rawOutput = String(res?.rawOutput || '');
      return true;
    } catch (err) {
      if (idx >= 0 && state.plugins.items[idx]) state.plugins.items[idx].enabled = prev;
      setErr('plugins', errMsgOf(err, t('切换插件状态失败')));
      return false;
    } finally {
      if (state.busy === `plg:${name}`) state.busy = '';
    }
  }

  async function installPlugin(target) {
    setErr('plugins', '');
    state.busy = 'plg:install';
    try {
      const res = await api.installPlugin(String(target || '').trim());
      state.plugins.items = Array.isArray(res?.items) ? res.items : [];
      state.plugins.parseError = Boolean(res?.parseError);
      state.plugins.rawOutput = String(res?.rawOutput || '');
      return true;
    } catch (err) {
      setErr('plugins', errMsgOf(err, t('安装插件失败')));
      return false;
    } finally {
      if (state.busy === 'plg:install') state.busy = '';
    }
  }

  async function uninstallPlugin(name) {
    const prevItems = [...state.plugins.items];
    state.plugins.items = state.plugins.items.filter((x) => x.name !== name);
    setErr('plugins', '');
    state.busy = `plg:${name}`;
    try {
      const res = await api.uninstallPlugin(name);
      state.plugins.items = Array.isArray(res?.items) ? res.items : [];
      state.plugins.parseError = Boolean(res?.parseError);
      state.plugins.rawOutput = String(res?.rawOutput || '');
      return true;
    } catch (err) {
      state.plugins.items = prevItems;
      setErr('plugins', errMsgOf(err, t('卸载插件失败')));
      return false;
    } finally {
      if (state.busy === `plg:${name}`) state.busy = '';
    }
  }

  async function logout() {
    setErr('account', '');
    state.busy = 'logout';
    try {
      await api.logout();
      await refreshStatus({ ensure: false, probe: false });
      return true;
    } catch (err) {
      setErr('account', errMsgOf(err, t('登出失败')));
      return false;
    } finally {
      if (state.busy === 'logout') state.busy = '';
    }
  }

  async function restartDaemon() {
    setErr('runtime', '');
    state.busy = 'restart';
    try {
      await api.restart();
      await refreshStatus({ ensure: true, probe: true });
      return true;
    } catch (err) {
      setErr('runtime', errMsgOf(err, t('重启常驻进程失败')));
      return false;
    } finally {
      if (state.busy === 'restart') state.busy = '';
    }
  }

  async function checkUpdate() {
    setErr('update', '');
    state.update.busy = true;
    try {
      const res = await api.checkUpdate();
      state.update.result = res;
      await refreshStatus({ ensure: false, probe: false });
      return res;
    } catch (err) {
      setErr('update', errMsgOf(err, t('检查更新失败')));
      return null;
    } finally {
      state.update.busy = false;
    }
  }

  async function restoreAllHidden() {
    setErr('sessions', '');
    state.busy = 'restoreHidden';
    const prevCount = state.hiddenCount;
    state.hiddenCount = 0;
    try {
      await api.restoreAllSessions();
      return true;
    } catch (err) {
      state.hiddenCount = prevCount;
      setErr('sessions', errMsgOf(err, t('恢复隐藏会话失败')));
      return false;
    } finally {
      if (state.busy === 'restoreHidden') state.busy = '';
    }
  }

  return {
    state,
    setErr,
    loadAll,
    refreshStatus,
    loadMcp,
    loadPlugins,
    patchSettings,
    addExtraDir,
    removeExtraDir,
    resetSystemPrompt,
    toggleMcp,
    addMcp,
    removeMcp,
    togglePlugin,
    installPlugin,
    uninstallPlugin,
    logout,
    restartDaemon,
    checkUpdate,
    restoreAllHidden,
  };
}
