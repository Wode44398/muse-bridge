// Gemini · Vertex 设置注册表——2026-11-04 起只是兼容出口。
//
// Gemini 对话同日下线，原来 设置 › Agent › Gemini 上的三组（让别的 agent 生成媒体、agent 能生成什么、内容安全过滤）
// 全部搬进 Media Studio：注册表 src/config/studio-settings.mjs，存储 config.json 的 studioHost（老的 vertexHost 首次照抄）。
// 这里按原来的形状转出同一份数据，给还没改完的老前端代码与老接口 /api/vertex/settings 用。别再往这里加新项。
//
// 纯数据、无 node 依赖（前端编译期直接 import）。
import {
  STUDIO_SETTING_GROUPS, STUDIO_SETTINGS, STUDIO_KIND_KEY, STUDIO_CALLER_KEY, SAFETY_THRESHOLD, SAFETY_CATEGORY,
  normalizeStudioSetting,
} from './studio-settings.mjs';

const LEGACY_GROUPS = ['agents', 'kinds', 'safety'];

export const VERTEX_SETTING_GROUPS = Object.freeze(STUDIO_SETTING_GROUPS.filter((g) => LEGACY_GROUPS.includes(g.id)));
// 去掉 Studio 才有的字段（scope），其余照旧
export const VERTEX_SETTINGS = Object.freeze(STUDIO_SETTINGS.filter((s) => LEGACY_GROUPS.includes(s.group)).map(({ scope, ...s }) => Object.freeze(s)));
export const VERTEX_SETTING_BY_KEY = Object.freeze(Object.fromEntries(VERTEX_SETTINGS.map((s) => [s.key, s])));

/** 默认值表。 */
export function vertexSettingDefaults() {
  return Object.fromEntries(VERTEX_SETTINGS.map((s) => [s.key, s.default]));
}

/** 校验单个值：{ ok:true, value } | { ok:false, error }。 */
export function normalizeVertexSetting(key, v) {
  if (!VERTEX_SETTING_BY_KEY[key]) return { ok: false, error: '未知设置项：' + key };
  return normalizeStudioSetting(key, v);
}

/** 设置页上这一项显不显示：主项关着的依赖项、这台服务器上没有的 agent 那一行都不显示。 */
export function vertexSettingVisible(key, values, agentIds) {
  const s = VERTEX_SETTING_BY_KEY[key];
  if (!s) return false;
  if (s.dependsOn && !values[s.dependsOn]) return false;
  if (s.agent && Array.isArray(agentIds) && !agentIds.includes(s.agent)) return false;
  return true;
}

export const VERTEX_KIND_KEY = STUDIO_KIND_KEY;
export const VERTEX_CALLER_KEY = STUDIO_CALLER_KEY;
export { SAFETY_THRESHOLD, SAFETY_CATEGORY };
