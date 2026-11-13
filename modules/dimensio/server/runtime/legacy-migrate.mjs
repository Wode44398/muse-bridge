// dimensio 自建的模型服务（管理员实例 custom-providers/providers.json 里的 custom-<hex>）一次性并进模型中心（2026-11-13）。
// 核心那半在 src/runtime/model-hub/legacy-migrate.mjs（Claude、Media Studio 的）；这里只有 dimensio 扩展读得到 harness 的文件。
//
// 做法同核心：地址、协议、型号、Key 照抄成模型中心服务（同一个服务已经在模型中心里就并进去），记迁移台账；
// 原件不删，在 providers.json 的那一条上记 hubRef——harness 从「模型服务」面板和子 agent 候选里藏掉它，
// 但会话里、默认服务里记着的 custom-<hex> 照常解析得到（不用重新选模型）。
// 扩展 register 时跑（harness 进程还没起来，直接改文件不会和它抢写）；读不出 Key 存储就整个不迁，下次启动再试。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { readSecrets } from '@bridge/core/extension-secrets.mjs';
import { writeJson } from '@bridge/core/jsonfile.mjs';
import { migratedOf, markMigrated, backupHubFile } from '@bridge/core/runtime/model-hub/registry.mjs';
import { adoptTextService } from '@bridge/core/runtime/model-hub/legacy-migrate.mjs';

const HUB_REF_RE = /^h-[0-9a-f]{8}$/;
const listOf = (raw) => (Array.isArray(raw?.providers) ? raw.providers : Array.isArray(raw) ? raw : []);
function readProviders(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, 'providers.json'), 'utf8')); } catch { return null; }
}

/**
 * 一个自定义服务连 Key 读出来（「改为共用」照抄、自动迁移共用）→ { name, protocol, baseUrl, authStyle, headers, models, defaultModel, key, shared, keyOk } | null。
 * secrets：已读出的密文表（批量时只解一次）；不给就现读。keyOk:false = Key 存储解不开（不是没填）。
 */
export function exportDimensioProvider(dir, id, secrets) {
  const p = listOf(readProviders(dir)).find((x) => x && x.id === id);
  if (!p) return null;
  let key = '', keyOk = true;
  try {
    const sec = secrets || readSecrets(dir);
    const k = sec?.[id]?.headers?.apiKey;
    if (typeof k === 'string') key = k;
  } catch (e) { keyOk = false; console.error('[dimensio] 自定义服务的 Key 解不开：', e?.message || e); }
  // providers.json v2：models 是型号 id 的字符串数组（给老 harness 看的），完整规格在 modelSpecs；v1 只有前者
  const specs = Array.isArray(p.modelSpecs) && p.modelSpecs.length ? p.modelSpecs : (Array.isArray(p.models) ? p.models : []).map((m) => (typeof m === 'string' ? { id: m } : m));
  const pick = (m) => ({ id: String(m.id), ...(m.label && m.label !== m.id ? { label: m.label } : {}), contextWindow: m.contextWindow, maxOutput: m.maxOutput, vision: m.vision });
  return {
    name: String(p.name || p.note || id), protocol: p.protocol || 'openai', baseUrl: String(p.baseUrl || ''), authStyle: p.authStyle,
    headers: Array.isArray(p.headers) ? p.headers : [], defaultModel: p.defaultModel, key, keyOk, shared: p.shared === true,
    hubRef: HUB_REF_RE.test(String(p.hubRef || '')) ? p.hubRef : '',
    models: specs.filter((m) => m && m.id && m.enabled !== false && m.kind !== 'other').map(pick),
    parked: specs.filter((m) => m && m.id && m.enabled === false && m.kind !== 'other').map(pick),
  };
}

// 在 providers.json 的那一条上记 hubRef（保留文件里别的字段原样；harness 读盘时认这个字段）
function stampHubRef(dir, marks) {
  const file = path.join(dir, 'providers.json');
  const raw = readProviders(dir);
  if (!raw) return;
  const list = listOf(raw);
  let n = 0;
  for (const p of list) if (p && marks[p.id] && p.hubRef !== marks[p.id]) { p.hubRef = marks[p.id]; n++; }
  if (!n) return;
  writeJson(file, Array.isArray(raw) ? list : { ...raw, providers: list }, 2);
}

/** 做一次 → { done: [名字], skipped: [原因] }。已经记过台账的只补记 hubRef（文件被老版 harness 重写过时会丢）。 */
export function migrateDimensioServices(dir) {
  const out = { done: [], skipped: [] };
  if (!dir || !existsSync(path.join(dir, 'providers.json'))) return out;
  const list = listOf(readProviders(dir)).filter((p) => p && typeof p.id === 'string' && p.id.startsWith('custom-'));
  if (!list.length) return out;
  const ledger = migratedOf('dimensio');
  const marks = {};
  for (const p of list) if (ledger[p.id] && p.hubRef !== ledger[p.id]) marks[p.id] = ledger[p.id];
  const todo = list.filter((p) => !ledger[p.id] && !HUB_REF_RE.test(String(p.hubRef || '')));
  let secrets = null;
  if (todo.length) {
    try { secrets = existsSync(path.join(dir, 'connector-secrets.json')) ? readSecrets(dir) : {}; }
    catch (e) {
      console.error('[dimensio] 自定义服务的 Key 存储读不出来，这次不并进模型中心（下次启动再试）：', e?.message || e);
      if (Object.keys(marks).length) stampHubRef(dir, marks);
      return { done: [], skipped: ['Key 存储读不出来'] };
    }
    backupHubFile('services.pre-unify.bak.json');
  }
  for (const p of todo) {
    const src = exportDimensioProvider(dir, p.id, secrets);
    if (!src || !src.baseUrl) { out.skipped.push(`${p.name || p.id}：读不出地址`); continue; }
    try {
      const r = adoptTextService({ ...src, members: src.shared }, { auto: true, tag: 'dimensio' });
      markMigrated('dimensio', p.id, r.service.id);
      marks[p.id] = r.service.id;
      out.done.push(`${src.name} → ${r.service.name}${r.merged ? '（并进已有服务）' : ''}`);
    } catch (e) { out.skipped.push(`${src.name}：${e?.message || e}`); }
  }
  if (Object.keys(marks).length) {
    try { stampHubRef(dir, marks); } catch (e) { console.error('[dimensio] providers.json 没记上 hubRef：', e?.message || e); }
  }
  if (out.done.length || out.skipped.length) {
    console.log(`[dimensio] 自建的模型服务并进模型中心：${out.done.length} 个${out.done.length ? `（${out.done.join('、')}）` : ''}`
      + (out.skipped.length ? `；没并成（下次启动再试）：${out.skipped.join('；')}` : ''));
  }
  return out;
}
