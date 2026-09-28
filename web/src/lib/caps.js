// Capability catalog (Claude models / efforts). Fetched once on boot from
// /api/capabilities — the server's single source of truth (src/config/capabilities.mjs).
// Falls back to a server-injected window.__CAPS__ if present.
import { api } from './api.js';
// 编译期兜底：直接 import 后端那份单一真相（同一个 capabilities.mjs）。fetch /api/capabilities
// 万一失败（网络抖动 / 任意原因）也有一份完整列表，不至于整个模型 UI 空白。零漂移——和后端同一文件。
import { CAPABILITIES, claudeDefaultEffort } from '../../../src/config/capabilities.mjs';

export async function loadCaps() {
  if (typeof window !== 'undefined' && window.__CAPS__) return window.__CAPS__;
  try { return await api.capabilities(); }
  catch { return CAPABILITIES; }
}

// 「没选模型」这一档显示/高亮哪个：一律读后端 capabilities 的 defaults.model（单一真相），
// caps 还没到位时退回编译期那份同源 CAPABILITIES。以前这里各处写死字面量，跟后端 MODEL
// 的回落各走各的，加了 Opus 5 后就出现「芯片写 Opus 5、实际跑 Opus 4.8」。
export function claudeDefaultModel(capsData) {
  return capsData?.claude?.defaults?.model || CAPABILITIES.claude.defaults.model;
}

// 「没选 effort」这一档显示/高亮哪个：按当前模型取 API 实际默认（Opus 5.5 = medium，其余 high），
// 读后端 capabilities 的 effortDefaults（caps 未到位或旧后端没这张表时退回编译期同源那份）。
export function claudeEffortFallback(capsData, model) {
  return claudeDefaultEffort(model || claudeDefaultModel(capsData), capsData?.claude?.effortDefaults ? capsData : CAPABILITIES);
}

// Claude model list split for the picker: a short primary list + the rest behind
// "More models" (mirrors the claude.ai picker in the design). Primary = the first
// of each family we want surfaced; everything else (1M variants, older, legacy)
// goes under "more". 2026-09-01 对齐官方 claude.ai/code 实测：主列表 Fable 5.1 / Opus 5 /
// Sonnet 5 / Haiku 4.5，Fable 5 退进 More models。2026-09-22 Opus 5.5 接棒 Opus 位（CLI 2.1.280
// 的 opus 别名与 /model 主项同日切换，Opus 5 标为 previous），Opus 5 退进 More models。
const PRIMARY_IDS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'];

export function splitClaudeModels(capsData) {
  const all = capsData?.claude?.models || [];
  const primary = PRIMARY_IDS.map((id) => all.find((m) => m.id === id)).filter(Boolean);
  const rest = all.filter((m) => !PRIMARY_IDS.includes(m.id));
  return { primary, rest };
}
