// Gemini · Vertex 设置——2026-11-04 起只是兼容出口（老的 import 路径与 /api/vertex/settings 照旧能用）。
//
// 这几组（让别的 agent 生成、agent 能生成什么、内容安全过滤）搬进了 Media Studio：存储与判定都在
// src/runtime/studio-settings.mjs（config.json 的 studioHost；还没写过时照抄老的 vertexHost）。这里读写的是同一份。

import { VERTEX_SETTINGS, VERTEX_SETTING_BY_KEY } from '../config/vertex-settings.mjs';
import {
  getStudioHostSettings, setStudioHostSettings, studioHostSnapshot,
  agentMediaDeny, capVideoResolution, videoResolutionCap, studioSafetySettings, safetyBlockNote,
} from './studio-settings.mjs';

export { agentMediaDeny, capVideoResolution, videoResolutionCap, safetyBlockNote, VERTEX_SETTINGS };
/** Google generateContent 的 safetySettings（Nano Banana）；没改过 = undefined。 */
export const vertexSafetySettings = studioSafetySettings;

const pick = (o) => Object.fromEntries(VERTEX_SETTINGS.map((s) => [s.key, o[s.key]]));

/** 完整取值（老形状：只有原来那几组的键）。 */
export function getVertexSettings() { return pick(getStudioHostSettings()); }

/** 给老设置页 / 老 agent 接口的快照：values + 改过的键。 */
export function vertexSettingsSnapshot() {
  return { values: getVertexSettings(), changed: studioHostSnapshot().changed.filter((k) => VERTEX_SETTING_BY_KEY[k]) };
}

/** patch = { key: 值 | null }，null = 恢复默认。只认原来那几组的键；任一项不合法整批不改。 */
export function setVertexSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: '参数应为 { 设置项: 值 }' };
  for (const k of Object.keys(patch)) if (!VERTEX_SETTING_BY_KEY[k]) return { ok: false, error: '未知设置项：' + k };
  const r = setStudioHostSettings(patch);
  if (!r.ok) return r;
  return { ok: true, ...vertexSettingsSnapshot() };
}
