// Claude 分页设置的服务端存储（注册表见 src/config/claude-settings.mjs）。
//
//   scope 'user' → 按身份数据目录落 claude-settings.json：{ rev, values:{只存显式值} }，同账号多设备同步
//                  （与 session-library.mjs 同一范式：rev 单调递增，前端据此丢弃乐观更新之后才到的旧快照）。
//   scope 'host' → config.json 的 claudeHost 键（只改这一个键，同 account-router.mjs），仅管理员。
//
// 读：getClaudeSettings(ctx) 回「默认值 ⊕ 显式值」的完整 values（含 host 键：主机级开关对所有身份生效，服务端判定用真实值）。
//     给前端的快照 claudeSettingsSnapshot 里，非管理员拿到的 host 键恒为默认值（主机配置状态不外露；可选模式已在服务端裁好）。
// 写：setClaudeSettings(ctx, patch) 逐键校验；admin / shell 门不过直接 403。调用方负责 busPublish。
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { readJson, writeJson } from '../jsonfile.mjs';
import { CONFIG_PATH } from '../config/index.mjs';
import {
  CLAUDE_SETTINGS, CLAUDE_SETTING_BY_KEY, claudeSettingDefaults, normalizeClaudeSetting,
  PERMISSION_MODES, PERMISSION_MODES_SANDBOX, BUILTIN_OUTPUT_STYLES, unsupportedClaudeSettings,
} from '../config/claude-settings.mjs';
import { desktopSessionsDirs } from './desktop-lineage.mjs';

const cache = new Map();   // file -> { rev, values }
const fileFor = (ctx) => path.join(ctx.dataDir, 'claude-settings.json');
const isAdmin = (ctx) => ctx?.kind === 'admin';

function loadUser(ctx) {
  const file = fileFor(ctx);
  if (cache.has(file)) return cache.get(file);
  const raw = readJson(file, {});
  const values = {};
  const src = raw.values && typeof raw.values === 'object' ? raw.values : {};
  for (const [k, v] of Object.entries(src)) {
    const s = CLAUDE_SETTING_BY_KEY[k];
    if (!s || s.scope !== 'user') continue;
    const n = normalizeClaudeSetting(k, v, { dynamicOptions: null });
    if (n.ok) values[k] = n.value;
  }
  const d = { rev: Number.isFinite(raw.rev) ? raw.rev : 0, values };
  cache.set(file, d);
  return d;
}

function loadConfigRaw() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}
let host = null;   // 主机级显式值（内存为准）
function loadHost() {
  if (host) return host;
  const raw = loadConfigRaw().claudeHost;
  host = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const s = CLAUDE_SETTING_BY_KEY[k];
      if (!s || s.scope !== 'host') continue;
      const n = normalizeClaudeSetting(k, v);
      if (n.ok) host[k] = n.value;
    }
  }
  return host;
}
// 主机级版本号：进程起来时取当前时间，之后每改一次至少 +1——只增不减，重启也不倒退。以前在内存里从 0 数，一重启就归零，
// 前端缓存里更大的 rev 会把重启之后的主机级改动当成旧快照丢掉。时间基的值不必落盘；快照 rev = 用户 rev×1000 + 它，
// 两路各自单调，合成值也单调（先生成的快照合成值不会更大），老前端照旧按一个数比较。
let hostRev = Date.now();

const hostListeners = new Set();
/** 主机级设置变了（保持唤醒等据此起停）。回调拿到完整 host values。 */
export function onClaudeHostSettings(fn) { hostListeners.add(fn); return () => hostListeners.delete(fn); }
export function claudeHostSettings() { return { ...claudeSettingDefaults({ scope: 'host' }), ...loadHost() }; }

// 本身份的设置变了（scope user 的键，2026-10-21 会话协作追加，向后兼容）：回调 (ctx, changedKeys)。
// 「改了要当场作用到已经在跑 / 停放着的 CLI」的项据此下发——跨会话入站闸 crossSessionInbound（session-peers.mjs）。
const userListeners = new Set();
export function onClaudeSettings(fn) { userListeners.add(fn); return () => userListeners.delete(fn); }

/** 完整取值：默认 ⊕ 本身份显式值 ⊕（管理员）主机显式值。快照访客 / 无数据目录 → 全默认。 */
export function getClaudeSettings(ctx) {
  const values = claudeSettingDefaults();
  if (ctx?.dataDir && !ctx.snap) Object.assign(values, loadUser(ctx).values);
  Object.assign(values, loadHost());   // 主机级对所有身份生效（如 allowBypass 关着，谁都绕不过）
  return values;
}
/** 单键便捷读。 */
export const claudeSetting = (ctx, key) => getClaudeSettings(ctx)[key];

/** 这个身份在会话里能选的权限模式（已按主机安全开关裁剪）。 */
export function permissionModesFor(ctx) {
  const v = getClaudeSettings(ctx);
  const base = isAdmin(ctx) ? PERMISSION_MODES : PERMISSION_MODES_SANDBOX;
  return base.filter((m) => (m !== 'bypassPermissions' || v.allowBypass) && (m !== 'auto' || v.allowAutoMode));
}
/** 新会话的默认权限模式（夹紧到可选范围：不可选的 auto → acceptEdits，其余 → 第一个）。 */
export function defaultPermissionModeFor(ctx) {
  const modes = permissionModesFor(ctx);
  const want = getClaudeSettings(ctx).permissionMode;
  if (modes.includes(want)) return want;
  if (modes.includes('acceptEdits')) return 'acceptEdits';
  return modes[0] || 'default';
}

// 运行期输出风格清单（按身份缓存；claude.mjs 在 init 帧拿到 available_output_styles 时 noteOutputStyles）。
const outputStyles = new Map();   // ctx.key -> string[]
export function noteOutputStyles(ctx, list) {
  if (!ctx?.key || !Array.isArray(list) || !list.length) return;
  outputStyles.set(ctx.key, [...new Set(['default', ...list.map(String)])]);
}
export function outputStylesFor(ctx) {
  return outputStyles.get(ctx?.key) || [...BUILTIN_OUTPUT_STYLES];
}

// 这台机器做不到的项（快照的 unsupported，前端据此不显示；规则见 config/claude-settings.mjs 的 unsupportedClaudeSettings）。
// 保持唤醒能不能起作用由保持唤醒插件挂上来（plugins/catalog.mjs 的 keep-awake → setKeepAwakeCapability）：插件没开 / 这台
// 机器不可用就从没挂过 = 做不到。探 Desktop 数据目录要碰文件系统，快照又随 /api/sessions、总线 hello 频繁出，所以一分钟探一次
//（同 desktop-lineage 的重探周期，装上 / 卸掉 Desktop 不用重启）。_setClaudeHostProbe 给单测换探针。
const PROBE_MS = 60_000;
let keepAwakeCap = () => false;
export function setKeepAwakeCapability(fn) { keepAwakeCap = typeof fn === 'function' ? fn : () => false; unsup = null; }
const defaultProbe = () => ({ keepAwake: !!keepAwakeCap(), desktop: desktopSessionsDirs().length > 0 });
let probe = defaultProbe;
let unsup = null, unsupAt = 0;
export function unsupportedClaudeSettingsNow() {
  const now = Date.now();
  if (!unsup || now - unsupAt > PROBE_MS) {
    let caps; try { caps = probe(); } catch { caps = { keepAwake: false, desktop: false }; }
    unsup = unsupportedClaudeSettings(caps); unsupAt = now;
  }
  return [...unsup];
}
export function _setClaudeHostProbe(fn) { probe = typeof fn === 'function' ? fn : defaultProbe; unsup = null; }

/** 给前端的快照（GET /api/claude/settings、总线 hello、/api/sessions 附带）。 */
export function claudeSettingsSnapshot(ctx) {
  const admin = isAdmin(ctx);
  const rev = ctx?.dataDir && !ctx.snap ? loadUser(ctx).rev : 0;
  const values = getClaudeSettings(ctx);
  if (!admin) Object.assign(values, claudeSettingDefaults({ scope: 'host' }));   // 主机级真实值只给管理员看
  return {
    rev: rev * 1000 + hostRev,   // 两路合成一个单调值（host 改动也让前端采纳新快照）
    values,
    admin,
    shell: !!ctx?.shell,
    permissionModes: permissionModesFor(ctx),
    outputStyles: outputStylesFor(ctx),
    unsupported: unsupportedClaudeSettingsNow(),
  };
}

const err = (status, message) => Object.assign(new Error(message), { status });

/**
 * 写入：patch = { key: value|null, … }（null = 恢复默认）。
 * 返回 { settings: 快照, changed: bool, hostChanged: bool }。任一键不合法 → 整批不写、抛 400/403。
 */
export function setClaudeSettings(ctx, patch) {
  if (!ctx?.dataDir || ctx.snap) throw err(403, 'not allowed');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw err(400, 'bad patch');
  const admin = isAdmin(ctx);
  const user = loadUser(ctx);
  const h = loadHost();
  const nextUser = { ...user.values }, nextHost = { ...h };
  for (const [k, v] of Object.entries(patch)) {
    const s = CLAUDE_SETTING_BY_KEY[k];
    if (!s || s.scope === 'device') throw err(400, 'unknown setting: ' + k);
    if ((s.admin || s.scope === 'host') && !admin) throw err(403, 'admin only: ' + k);
    if (s.shell && !ctx.shell) throw err(403, 'not available: ' + k);
    const dyn = s.options === 'dynamic' ? outputStylesFor(ctx) : null;
    if (k === 'permissionMode' && v != null && !(admin ? PERMISSION_MODES : PERMISSION_MODES_SANDBOX).includes(String(v))) throw err(400, 'mode not available');
    const n = normalizeClaudeSetting(k, v, { dynamicOptions: dyn });
    if (!n.ok) throw err(400, n.error);
    const target = s.scope === 'host' ? nextHost : nextUser;
    if (v === null || n.value === s.default) delete target[k]; else target[k] = n.value;
  }
  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const changed = !same(nextUser, user.values);
  const hostChanged = !same(nextHost, h);
  if (changed) {
    const keys = [...new Set([...Object.keys(nextUser), ...Object.keys(user.values)])].filter((k) => JSON.stringify(nextUser[k]) !== JSON.stringify(user.values[k]));
    user.values = nextUser; user.rev += 1;
    writeJson(fileFor(ctx), { rev: user.rev, values: user.values }, 2);
    for (const fn of userListeners) { try { fn(ctx, keys); } catch {} }
  }
  if (hostChanged) {
    host = nextHost; hostRev = Math.max(Date.now(), hostRev + 1);
    const raw = loadConfigRaw();
    raw.claudeHost = { ...host };
    try { writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2)); } catch (e) { throw err(500, '保存失败：' + ((e && e.message) || e)); }
    const full = claudeHostSettings();
    for (const fn of hostListeners) { try { fn(full); } catch {} }
  }
  return { settings: claudeSettingsSnapshot(ctx), changed, hostChanged };
}

// 测试用：清内存缓存（单测换数据目录后重读；也当「重启」用——主机级版本号照重启那样按当前时间重取）。
export function _resetClaudeSettingsCache() { cache.clear(); host = null; hostRev = Date.now(); }
export { CLAUDE_SETTINGS };
