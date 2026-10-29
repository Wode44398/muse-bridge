// 设置 › Agent › Gemini 上「Google 云凭据」下面那几组（管理员）：别的 agent 能不能生成媒体、能生成什么、内容安全过滤。
// 注册表 src/config/vertex-settings.mjs（两套外壳都按它渲染，取值、显示名、可见性从这里拿）；
// 服务端 GET / POST /api/vertex/settings（modules/vertex/server/routes/settings.mjs）。
// 主机级、只有管理员能改，不进总线同步：打开 Gemini 页时拉一次，改了就用服务端回来的快照。
import { api } from './api.js';
import { t, tr } from './i18n.js';
import {
  VERTEX_SETTINGS, VERTEX_SETTING_GROUPS, VERTEX_SETTING_BY_KEY, vertexSettingDefaults, vertexSettingVisible,
} from '../../../src/config/vertex-settings.mjs';

export const vx = $state({ values: vertexSettingDefaults(), changed: [], loaded: false, busy: '', err: '' });
export { VERTEX_SETTINGS, VERTEX_SETTING_GROUPS };
export const VX = VERTEX_SETTING_BY_KEY;

function adopt(r) {
  vx.values = { ...vertexSettingDefaults(), ...(r.values || {}) };
  vx.changed = r.changed || [];
  vx.loaded = true;
}

/** 拉一次（非管理员、老服务端、没装 Vertex 扩展：拿不到就整块不出现）。 */
export async function loadVertexSettings() {
  try { adopt(await api.get('/api/vertex/settings')); vx.err = ''; } catch { vx.loaded = false; }
}

/** 改一项；value = null 恢复默认。乐观更新，失败回滚并显示原因。 */
export async function setVertexSetting(key, value) {
  if (vx.busy) return;
  const prev = vx.values[key];
  vx.values = { ...vx.values, [key]: value === null ? VX[key].default : value };
  vx.busy = key; vx.err = '';
  try { adopt(await api.post('/api/vertex/settings', { values: { [key]: value } })); }
  catch (e) { vx.values = { ...vx.values, [key]: prev }; vx.err = tr(e?.body?.error || e?.message) || t('保存失败'); }
  vx.busy = '';
}

/** 这一行显不显示：主项关着的依赖项、这台服务器上没有的 agent（agentIds：设置页 Agent 列表里的 id）。 */
export const vxVisible = (key, agentIds) => vertexSettingVisible(key, vx.values, agentIds);
export const vxChanged = (key) => vx.changed.includes(key);
export const vxLabel = (key) => tr(VX[key].label);
export const vxDesc = (key) => (VX[key].desc ? tr(VX[key].desc) : '');
/** enum 的选项（界面文字已过 t()）。 */
export const vxOptions = (key) => (VX[key].options || []).map((v, i) => ({ value: v, label: tr((VX[key].optionLabels || [])[i] || v) }));
export const vxValueLabel = (key) => vxOptions(key).find((o) => o.value === vx.values[key])?.label || String(vx.values[key] ?? '');
/** 分组标题与组尾说明（注册表里的中文原文过 tr()）。 */
export const vxGroupLabel = (g) => tr(g.label);
export const vxGroupFoot = (g) => (g.foot ? tr(g.foot) : '');
/** 某一组里要显示的键。 */
export const vxGroupKeys = (gid, agentIds) => VERTEX_SETTINGS.filter((s) => s.group === gid && vxVisible(s.key, agentIds)).map((s) => s.key);
