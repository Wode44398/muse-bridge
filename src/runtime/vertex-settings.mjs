// Gemini · Vertex 设置的服务端存储与判定（注册表见 src/config/vertex-settings.mjs）。
//
// 主机级：config.json 的 vertexHost 键，只存与默认不同的显式值（只改这一个键，同 claude-settings 的 claudeHost）。
// 判定都在这里，各调用处只问一句：
//   agentMediaDeny(caller, kind)  这个调用方能不能生成这种媒体（Claude 的媒体工具、agent 接口的 media.* 操作）
//   capVideoResolution(res)       agent 要的视频分辨率按上限降档
//   vertexSafetySettings()        Gemini 对话 / Gemini 图像请求带的 safetySettings（没改过 = 不带，跟 Google 默认）
// 你在 Vertex 页里手动生成不过这里——那条路只受 Gemini 开关、按人授权和成员额度管。

import { readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_PATH } from '../config/index.mjs';
import {
  VERTEX_SETTINGS, VERTEX_SETTING_BY_KEY, vertexSettingDefaults, normalizeVertexSetting,
  VERTEX_KIND_KEY, VERTEX_CALLER_KEY, SAFETY_THRESHOLD, SAFETY_CATEGORY,
} from '../config/vertex-settings.mjs';

let host = null;   // 显式值（内存为准）
function loadHost() {
  if (host) return host;
  host = {};
  let raw;
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')).vertexHost; } catch {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const n = normalizeVertexSetting(k, v);
      if (n.ok) host[k] = n.value;
    }
  }
  return host;
}

/** 完整取值：默认 ⊕ 显式值。 */
export function getVertexSettings() { return { ...vertexSettingDefaults(), ...loadHost() }; }

/** 给设置页 / agent 接口的快照：values + 改过的键。 */
export function vertexSettingsSnapshot() {
  return { values: getVertexSettings(), changed: Object.keys(loadHost()) };
}

/** patch = { key: 值 | null }，null = 恢复默认。任一项不合法整批不改：{ ok:false, error }。 */
export function setVertexSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: '参数应为 { 设置项: 值 }' };
  const next = { ...loadHost() };
  for (const [k, v] of Object.entries(patch)) {
    if (!VERTEX_SETTING_BY_KEY[k]) return { ok: false, error: '未知设置项：' + k };
    if (v === null) { delete next[k]; continue; }
    const n = normalizeVertexSetting(k, v);
    if (!n.ok) return { ok: false, error: n.error };
    if (n.value === VERTEX_SETTING_BY_KEY[k].default) delete next[k];
    else next[k] = n.value;
  }
  let raw = {};
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')); } catch (e) { return { ok: false, error: '读不了 config.json：' + ((e && e.message) || e) }; }
  if (Object.keys(next).length) raw.vertexHost = next; else delete raw.vertexHost;
  try { writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), { mode: 0o600 }); } catch (e) { return { ok: false, error: '保存失败：' + ((e && e.message) || e) }; }
  host = next;
  return { ok: true, ...vertexSettingsSnapshot() };
}

// 拼进「没让…生成媒体」：西文名两边带空格，「外部 agent」只在后面带
const CALLER_NAME = { claude: ' Claude ', dimensio: ' dimensio ', codex: ' Codex ', api: '外部 agent ' };
const KIND_NAME = { image: '图片', speech: '语音', music: '音乐', video: '视频' };

/**
 * 这个调用方能不能生成这种媒体：null = 能；否则一句原因。
 * caller：'claude' | 'dimensio' | 'codex' | 'api'；不认识的同机实例一律不给。
 */
export function agentMediaDeny(caller, kind) {
  const v = getVertexSettings();
  const ck = VERTEX_CALLER_KEY[caller];
  if (!ck) return '这个调用方不能生成媒体';
  if (!v[ck]) return `管理员没让${CALLER_NAME[caller]}生成媒体（设置 › Agent › Gemini）`;
  const kk = VERTEX_KIND_KEY[kind];
  if (kk && !v[kk]) return `管理员关掉了 agent 生成${KIND_NAME[kind]}（设置 › Agent › Gemini）`;
  return null;
}

const RES_ORDER = ['360p', '720p', '1080p', '4k'];
/** agent 要的视频分辨率按上限降档（没给 / 不认识的原样返回，交给驱动按模型夹紧）。 */
export function capVideoResolution(res) {
  const cap = getVertexSettings().agentVideoMaxRes;
  const r = String(res || '').toLowerCase();
  const i = RES_ORDER.indexOf(r), c = RES_ORDER.indexOf(cap);
  if (i < 0 || c < 0) return res;
  return i > c ? cap : r;
}
/** 上限这一档（给工具说明用）。 */
export const videoResolutionCap = () => getVertexSettings().agentVideoMaxRes;

/** Gemini generateContent 的 safetySettings；四类都是「Google 默认」时返回 undefined（不带这个键）。 */
export function vertexSafetySettings() {
  const v = getVertexSettings();
  const out = [];
  for (const [key, category] of Object.entries(SAFETY_CATEGORY)) {
    const th = SAFETY_THRESHOLD[v[key]];
    if (th) out.push({ category, threshold: th });
  }
  return out.length ? out : undefined;
}

// 被 Google 的安全过滤拦下时给人看的一句话（对话、出图共用）。finishReason / promptFeedback.blockReason 认得的几种。
const BLOCK_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'OTHER_BLOCKED']);
export function safetyBlockNote(reason) {
  if (!reason || !BLOCK_REASONS.has(String(reason))) return '';
  return `被 Google 的内容安全过滤拦下了（${reason}）。换个说法再试；管理员可以在 设置 › Agent › Gemini › 内容安全过滤 里调整。`;
}

export { VERTEX_SETTINGS };
