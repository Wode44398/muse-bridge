// 一键导入 Vertex（方案 §3.1 / §3.6）：把主机上现有的 Google 云凭据、Gemini API Key、OpenRouter Key、本机图像模型
// 变成 Studio 的服务（主机管理员那份），现有能力一个不丢。可以重复点：按 importedFrom + 预设就地更新（幂等）。
//
//   google     → 「Google Vertex AI」：credMode 'adc'（沿用主机的 Google 凭据链：设置页上传的 > 环境变量 > gcloud ADC），项目 / 区域照抄
//   gemini     → 「Gemini API」：config 的 geminiApiKey 复制进加密存储（Omni、lyria-3 系列、2.1 的真 2K/4K）
//   openrouter → 「OpenRouter」：config 的 openrouterApiKey（GPT Image 2.5 Sunburst）
//   local      → 「本机图像模型」：本机装了 Qwen Image 2.1 才导
// 导入的服务都标 shared：成员保持升级前的使用权（以前成员生成媒体用的就是主机的 Vertex，计成员额度，现在照旧）。
// 首次启动迁移：主机一个 Studio 服务都没有、但上面任一项可导时自动导一次（startup 钩子）。

import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { readJson, writeJson } from '@bridge/core/jsonfile.mjs';
import { VERTEX_PROJECT, VERTEX_LOCATION, VERTEX_MEDIA_LOCATION, GEMINI_API_KEY, OPENROUTER_API_KEY } from '@bridge/core/config/index.mjs';
import { vertexCredentials } from '@bridge/core/runtime/vertex-credentials.mjs';
import { studioOwnerDir } from '@bridge/core/runtime/studio-settings.mjs';
import { hostProviders, createProvider, updateProvider, isManaged, HOST_OWNER } from './providers.mjs';
import { PRESET_BY_ID } from './presets.mjs';
import { viaRelay } from '@bridge/core/runtime/google-clients.mjs';
import { localImageStatus } from './adapters/local-image.mjs';

const IMPORT_FILE = () => path.join(studioOwnerDir(HOST_OWNER), 'import.json');
const gcloudAdc = () => (process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json')
  : path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json'));

function googleReady() {
  if (!VERTEX_PROJECT) return false;
  if (viaRelay.vertex || vertexCredentials()) return true;
  const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return (!!sa && existsSync(sa)) || existsSync(gcloudAdc());
}
async function localReady() { try { return !!(await localImageStatus()).installed; } catch { return false; } }

/** 主机上现在各有没有东西可导。 */
export async function importAvailable() {
  return { google: googleReady(), gemini: !!GEMINI_API_KEY || viaRelay.gemini, openrouter: !!OPENROUTER_API_KEY, local: await localReady() };
}
export function lastImport() {
  const j = readJson(IMPORT_FILE(), null);
  return j && j.at ? { at: j.at, items: Array.isArray(j.items) ? j.items : [] } : null;
}

const builtinModels = (preset) => PRESET_BY_ID[preset].models.map((m) => ({ ...m, enabled: true, source: 'builtin' }));
// 再导一次：补上新的内置模型，已有模型的开关 / 名字 / 默认参数照用户改过的留着
function mergeModels(existing, builtin) {
  const have = new Map(existing.map((m) => [m.id, m]));
  const out = [...existing];
  for (const b of builtin) if (!have.has(b.id)) out.push(b);
  return out;
}

const SPECS = {
  google: { preset: 'vertex', what: 'Google 云凭据',
    missing: () => (VERTEX_PROJECT ? '没找到 Google 凭据（上传服务账号 JSON，或在这台机器上 gcloud auth application-default login）' : '还没配 Google 项目 ID'),
    build: () => ({ google: { project: VERTEX_PROJECT, location: VERTEX_LOCATION || 'global', mediaLocation: VERTEX_MEDIA_LOCATION || 'us-central1', credMode: 'adc' } }) },
  gemini: { preset: 'gemini', what: 'Gemini API Key', missing: () => '还没配 Gemini API Key',
    build: () => ({ baseUrl: PRESET_BY_ID.gemini.baseUrl }), key: () => GEMINI_API_KEY },
  openrouter: { preset: 'openrouter', what: 'OpenRouter Key', missing: () => '还没配 OpenRouter API Key',
    build: () => ({ baseUrl: PRESET_BY_ID.openrouter.baseUrl }), key: () => OPENROUTER_API_KEY },
  local: { preset: 'local', what: '本机图像模型', missing: () => '这台机器上没装本机图像模型', build: () => ({}) },
};

// 这一项上次导入出来的服务：没托管的按预设认；已收编进模型中心的按方言认（模型中心可能把地址改成了中转站，预设变成 custom）
function importedFor(spec) {
  const mine = hostProviders().filter((p) => p.importedFrom === 'vertex');
  const dialect = PRESET_BY_ID[spec.preset].dialect;
  return mine.find((p) => !isManaged(p) && p.preset === spec.preset)
    || mine.find((p) => isManaged(p) && (p.preset === spec.preset || p.dialect === dialect)) || null;
}

/**
 * 一键导入（幂等）。回 { items: [{ id, ok, status, reason?, provider?, models? }], importedAt }。
 * 已收编进模型中心的服务（managedBy 'hub'）整项跳过（status 'skipped'）：Key 与模型清单归模型中心管，这里不写。
 */
export async function importVertex() {
  const avail = await importAvailable();
  const items = [];
  for (const [id, spec] of Object.entries(SPECS)) {
    const existing = importedFor(spec);
    if (existing && isManaged(existing)) {
      items.push({ id, ok: true, status: 'skipped', reason: '由模型中心管理', provider: existing.id, models: existing.models.length });
      continue;
    }
    if (!avail[id]) { items.push({ id, ok: false, status: 'missing', reason: spec.missing() }); continue; }
    try {
      const key = spec.key ? spec.key() : undefined;
      const base = { ...spec.build(), importedFrom: 'vertex', importedAt: Date.now(), ...(key ? { apiKey: key } : {}) };
      let p, status;
      if (existing) {
        p = updateProvider(existing.id, { ...base, models: mergeModels(existing.models, builtinModels(spec.preset)) }, HOST_OWNER);
        status = 'updated';
      } else {
        p = createProvider({ name: PRESET_BY_ID[spec.preset].name, preset: spec.preset, dialect: PRESET_BY_ID[spec.preset].dialect, enabled: true, shared: true, models: builtinModels(spec.preset), ...base }, HOST_OWNER);
        status = 'created';
      }
      items.push({ id, ok: true, status, provider: p.id, models: p.models.length });
    } catch (e) {
      items.push({ id, ok: false, status: 'error', reason: (e && e.message) || String(e) });
    }
  }
  const importedAt = Date.now();
  try { writeJson(IMPORT_FILE(), { at: importedAt, items }, 2); } catch {}
  return { items, importedAt };
}

/** 首次启动迁移：主机一个 Studio 服务都没有、但有东西可导时导一次。回导入结果或 null。 */
export async function autoImportIfEmpty() {
  if (hostProviders().length) return null;
  const avail = await importAvailable();
  if (!Object.values(avail).some(Boolean)) return null;
  const r = await importVertex();
  console.log('[studio] 首次启动：已从 Vertex 配置导入 ' + r.items.filter((x) => x.ok).map((x) => x.id).join('、') + ' 为 Media Studio 服务');
  return r;
}
