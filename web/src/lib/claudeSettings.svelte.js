// Claude 分页设置（按身份存服务端、同账号多设备同步）。注册表：src/config/claude-settings.mjs；
// 服务端：src/runtime/claude-settings.mjs + GET/POST /api/claude/settings。
// 下行三条路（同 library.svelte.js）：GET 接口、总线 hello 的 claudeSettings、总线 {type:'claude.settings'} 推送。
// 总线订阅放在模块里（全局），不挂在 ClaudePage 上——从主页直接打开设置时 Claude 页可能没挂载。
// device 级设置（通知分类等）只在本机 localStorage：cs.device。
import { api } from './api.js';
import { busOn } from './bus.js';
import { CLAUDE_SETTINGS, CLAUDE_SETTING_BY_KEY, claudeSettingDefaults, BUILTIN_OUTPUT_STYLES, PERMISSION_MODES_SANDBOX } from '../../../src/config/claude-settings.mjs';
import { untrack } from 'svelte';
import { prefs, me } from './state.svelte.js';
import { IS_CSNAP } from './csnap.js';

const LS_CACHE = 'bridge-claude-settings';
const LS_DEVICE = 'bridge-claude-device';
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

// 缓存与 rev 都是【某一个身份】的：同一台设备换了人（管理员退出、注册用户登录），上一个人的快照
// （admin:true、更大的 rev）不能留着——否则新身份的快照因 rev 更小被当成旧的丢掉，设置页照旧露出
// 管理员项和上一个人的取值。缓存里记下是谁的，对不上就不认；登录态一变就清掉重拉（2026-10-20 审查后补）。
const whoNow = () => (me.kind === 'none' ? '' : me.kind + ':' + (me.user || ''));
const rawCache = load(LS_CACHE, null);
const cached = rawCache && (rawCache.who === undefined || rawCache.who === whoNow()) ? rawCache : null;
const deviceDefaults = Object.fromEntries(CLAUDE_SETTINGS.filter((s) => s.scope === 'device').map((s) => [s.key, s.default]));

export const cs = $state({
  ok: !!cached,                      // 拿到过服务端快照（或有缓存）
  values: { ...claudeSettingDefaults(), ...(cached?.values || {}) },
  admin: !!cached?.admin,
  shell: cached?.shell ?? true,
  permissionModes: cached?.permissionModes || [...PERMISSION_MODES_SANDBOX],
  outputStyles: cached?.outputStyles || [...BUILTIN_OUTPUT_STYLES],
  unsupported: Array.isArray(cached?.unsupported) ? cached.unsupported : [],   // 这台服务端做不到的项（老服务端不给 = 都做得到）
  device: { ...deviceDefaults, ...load(LS_DEVICE, {}) },
  busy: false,
  err: '',
});
let rev = Number.isFinite(cached?.rev) ? cached.rev : -1;
let inflight = 0;

const saveCache = () => {
  try { localStorage.setItem(LS_CACHE, JSON.stringify({ who: whoNow(), rev, values: cs.values, admin: cs.admin, shell: cs.shell, permissionModes: cs.permissionModes, outputStyles: cs.outputStyles, unsupported: cs.unsupported })); } catch {}
};

function adopt(s) {
  cs.values = { ...claudeSettingDefaults(), ...(s.values || {}) };
  cs.admin = !!s.admin;
  cs.shell = !!s.shell;
  if (Array.isArray(s.permissionModes)) cs.permissionModes = s.permissionModes;
  if (Array.isArray(s.outputStyles) && s.outputStyles.length) cs.outputStyles = s.outputStyles;
  cs.unsupported = Array.isArray(s.unsupported) ? s.unsupported : [];
  cs.ok = true;
  rev = Number.isFinite(s.rev) ? s.rev : 0;
  saveCache();
}

/** 服务端快照到达。旧于已采纳版本、或本机还有写在路上时忽略。 */
export function applyServerClaudeSettings(s) {
  if (!s || typeof s !== 'object') return;
  if (inflight) return;
  if (Number.isFinite(s.rev) && s.rev < rev) return;
  adopt(s);
  migrateLegacy();
}

// —— 一次性迁移（2026-10-20，设置页那一路追加）：输入建议 / 自动压缩点原先存在每台设备的 bridge-prefs 里，
// 随每条消息上送。首次拿到服务端快照时，本机改过的（关掉的建议、拖过的压缩点）而服务端还是默认值 → 一次性写上去，
// 之后两项都以服务端为准（照 library.svelte.js 的 migrateLegacy）。快照页不迁。
const LS_MIGRATED = 'bridge-claude-settings-migrated';
let migrating = false;
function migrateLegacy() {
  if (migrating || IS_CSNAP) return;
  try { if (localStorage.getItem(LS_MIGRATED)) return; } catch { return; }
  migrating = true;
  const done = () => { try { localStorage.setItem(LS_MIGRATED, '1'); } catch {} };
  const patch = {};
  if (prefs.promptSuggest === false && cs.values.promptSuggestions !== false) patch.promptSuggestions = false;
  const f = prefs.compactFrac;
  if (typeof f === 'number' && f > 0 && f < 1 && !cs.values.compactFrac) patch.compactFrac = f;
  if (!Object.keys(patch).length) { done(); return; }
  setClaudeSettings(patch).then(done, () => { migrating = false; });
}

busOn((ev) => {
  if (!ev) return;
  if (ev.type === 'claude.settings' && ev.settings) applyServerClaudeSettings(ev.settings);
  else if (ev.type === 'hello' && ev.claudeSettings) applyServerClaudeSettings(ev.claudeSettings);
});

/** 拉一次（设置页打开时兜底）。 */
export async function loadClaudeSettings() {
  try { const r = await api.get('/api/claude/settings'); if (r?.settings) applyServerClaudeSettings(r.settings); }
  catch (e) { cs.err = (e && e.body && (e.body.error || e.body)) || ''; }
}

/** 乐观写一批：{ key: value|null }（null = 恢复默认）。失败回滚并把错误抛给调用方提示。 */
export async function setClaudeSettings(patch) {
  const prev = cs.values;
  const next = { ...prev };
  for (const [k, v] of Object.entries(patch)) next[k] = v === null ? CLAUDE_SETTING_BY_KEY[k]?.default : v;
  cs.values = next;
  inflight++; cs.busy = true; cs.err = '';
  try {
    const r = await api.post('/api/claude/settings', { patch });
    if (inflight === 1 && r?.settings) adopt(r.settings);
    else if (r?.settings) rev = Math.max(rev, r.settings.rev);
  } catch (e) {
    cs.values = prev;
    cs.err = (e && e.body && (e.body.error || e.body)) || String(e?.message || e);
    saveCache();
    throw e;
  } finally {
    inflight--; cs.busy = inflight > 0;
  }
}
export const setClaudeSetting = (key, value) => setClaudeSettings({ [key]: value });

/** 本机设置（通知分类等）。 */
export function setClaudeDeviceSetting(key, value) {
  cs.device = { ...cs.device, [key]: value };
  try { localStorage.setItem(LS_DEVICE, JSON.stringify(cs.device)); } catch {}
}

/** 与默认值不同（「已改过」小点 / 「恢复默认」按钮用）。 */
export function isClaudeSettingChanged(key) {
  const s = CLAUDE_SETTING_BY_KEY[key];
  if (!s) return false;
  const v = s.scope === 'device' ? cs.device[key] : cs.values[key];
  return v !== s.default;
}

/** 换人 / 退出：清掉上一个人的缓存（服务端那份不动）。 */
export function resetClaudeSettings() {
  cs.values = claudeSettingDefaults(); cs.ok = false; cs.admin = false; rev = -1;
  try { localStorage.removeItem(LS_CACHE); } catch {}
}

// 登录态变了（退出 / 另一个账号登录 / 过期）：清掉上一个人的，新身份立刻拉一份自己的。
// 快照页（IS_CSNAP）的身份不会变，不挂。
if (!IS_CSNAP) {
  $effect.root(() => {
    let last = untrack(whoNow);
    $effect(() => {
      const w = whoNow();
      if (w === last) return;
      last = w;
      untrack(() => {
        resetClaudeSettings();
        cs.shell = true; cs.permissionModes = [...PERMISSION_MODES_SANDBOX];
        if (w) loadClaudeSettings();
      });
    });
  });
}
