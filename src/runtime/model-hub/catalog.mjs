// 模型中心 v2：每个服务「识别出的模型目录」（契约 §5.1）。
//
// 目录 ≠ 已添加：识别一次 OpenRouter 能列出几百个模型，用户只勾其中几个。已添加的存在 services.json 的 service.models 里
// （带去向），这里存的是可供勾选的全集，单独一份文件，免得 services.json 动辄几百 KB、每次改个名字都整份重写。
//   <数据根>/model-hub/catalog/<服务 id>.json = { at, models:[CatalogModel], media? }
//   CatalogModel = { id, label, kind（text|image|video|voice|music|other）, vendor（模型厂键或 ''）, contextWindow?, maxOutput?, vision?,
//                    source:'api'|'catalog'|'name'|'manual' }
//   media = { dialect, kinds:[模型中心种类] }：识别时 Studio 说这个地址的媒体接口是什么方言、能做哪几类（只在服务端用，算 ServiceView.media）。
// 写盘一律原子（jsonfile.writeJson：tmp + rename）；内存里按服务缓存一份，总览每次 GET 不用重读文件。
import { rmSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from '../../jsonfile.mjs';
import { classifyModality, vendorOf, guessModel, MODALITIES } from '../../model-knowledge/index.mjs';

export const CATALOG_MAX = 3000;
const CAT_KINDS = [...MODALITIES, 'other'];
const SOURCES = ['api', 'catalog', 'name', 'manual'];
const SID_RE = /^h-[0-9a-f]{8}$/;
const MODEL_ID_RE = /^[^\s\u0000-\u001f]{1,200}$/;
const VENDOR_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DIALECT_RE = /^[a-z0-9-]{1,30}$/;

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '');
const posInt = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : undefined);

// 目录放在注册表的数据目录下：registry 启动时注入（测试换数据根时跟着走，这里不自己猜路径）
let rootOf = () => '';
export function setCatalogRoot(fn) { rootOf = typeof fn === 'function' ? fn : () => ''; cache.clear(); }
const fileOf = (sid) => {
  if (!SID_RE.test(String(sid))) throw bad('服务 id 不合法');   // 防路径穿越：id 直接拼进文件名
  return path.join(rootOf(), 'catalog', sid + '.json');
};

const cache = new Map();   // 服务 id → { at, models, media }
export function _resetCatalogCacheForTests() { cache.clear(); }

/** 一条目录项的规范化（读盘、识别结果、手动添加都过这里）；不合法回 null。 */
export function cleanCatalogModel(m, dfltSource = 'api') {
  const o = m && typeof m === 'object' ? m : { id: m };
  const id = str(o.id, 200);
  if (!MODEL_ID_RE.test(id)) return null;
  let kind = CAT_KINDS.includes(o.kind) ? o.kind : classifyModality(id);
  if (!CAT_KINDS.includes(kind)) kind = 'other';
  const vendor = typeof o.vendor === 'string' && (o.vendor === '' || VENDOR_RE.test(o.vendor)) ? o.vendor : vendorOf(id) || '';
  const ctx = posInt(o.contextWindow, 1024, 4_000_000), out = posInt(o.maxOutput, 256, 1_000_000);
  return {
    id, label: str(o.label, 80) || id, kind, vendor,
    ...(ctx ? { contextWindow: ctx } : {}), ...(out ? { maxOutput: out } : {}),
    ...(typeof o.vision === 'boolean' ? { vision: o.vision } : {}),
    source: SOURCES.includes(o.source) ? o.source : dfltSource,
  };
}

function cleanMedia(v) {
  if (!v || typeof v !== 'object' || !DIALECT_RE.test(String(v.dialect || ''))) return null;
  const kinds = (Array.isArray(v.kinds) ? v.kinds : []).map((k) => (k === 'speech' ? 'voice' : k)).filter((k) => MODALITIES.includes(k) && k !== 'text');
  return { dialect: v.dialect, kinds: [...new Set(kinds)] };
}

function cleanList(list, dfltSource) {
  const seen = new Set(), out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const c = cleanCatalogModel(m, dfltSource);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= CATALOG_MAX) break;
  }
  return out;
}

/** 读一个服务的目录 → { at, models, media }（没有文件 = 空目录）。返回的是缓存，别改。 */
export function readCatalog(sid) {
  const hit = cache.get(sid);
  if (hit) return hit;
  const raw = readJson(fileOf(sid), null);
  const v = { at: Number.isFinite(raw?.at) ? raw.at : 0, models: cleanList(raw?.models, 'api'), media: cleanMedia(raw?.media) };
  cache.set(sid, v);
  return v;
}

/** 整份写目录（新建服务时把识别结果落盘用）。 */
export function writeCatalog(sid, { at = Date.now(), models = [], media = null } = {}) {
  const v = { at, models: cleanList(models, 'api'), media: cleanMedia(media) };
  writeJson(fileOf(sid), { at: v.at, models: v.models, ...(v.media ? { media: v.media } : {}) }, 0);
  cache.set(sid, v);
  return v;
}

/**
 * 重新识别后合并：同 id 以新识别的为准（种类、上下文跟着上游走）；旧目录里有、这次没识别到的，只留手动加的
 * （上游下架的模型不该一直挂在目录里，用户手动敲的 ID 上游本来就不列，不能因为重识别就丢）。
 * media 不传 = 保留原来的。
 */
export function mergeCatalog(sid, models, { at = Date.now(), media } = {}) {
  const cur = readCatalog(sid);
  const fresh = cleanList(models, 'api');
  const ids = new Set(fresh.map((m) => m.id));
  const manual = cur.models.filter((m) => m.source === 'manual' && !ids.has(m.id));
  // 超上限时先让手动加的留下（那是用户亲手敲的），新识别的截尾
  const room = Math.max(0, CATALOG_MAX - manual.length);
  return writeCatalog(sid, { at, models: [...fresh.slice(0, room), ...manual], media: media === undefined ? cur.media : media });
}

/**
 * 手动加一个模型 ID 进目录（上游列不出、或者用户知道一个目录里没有的新模型）→ 规范化后的目录项。
 * kind 必填其一：text / image / video / voice / music（other 加了也用不了）；不给按名字认，认不出算文本。
 * 已在目录里的同 id 改成手动项（以用户给的种类、显示名为准），重识别时也不会被冲掉。
 */
export function addCatalogModel(sid, model, { protocol = 'openai' } = {}) {
  const o = model && typeof model === 'object' ? model : {};
  const id = str(o.id, 200);
  if (!MODEL_ID_RE.test(id)) throw bad(id ? `模型 ID「${id.slice(0, 40)}」不合法（不能有空白）` : '要填模型 ID');
  let kind = o.kind;
  if (kind === 'speech') kind = 'voice';
  if (kind !== undefined && kind !== null && kind !== '' && !MODALITIES.includes(kind)) throw bad('种类只能是 文本 / 图像 / 视频 / 配音 / 音乐');
  if (!kind) { kind = classifyModality(id); if (kind === 'other') kind = 'text'; }
  const cur = readCatalog(sid);
  const old = cur.models.find((m) => m.id === id);
  // 文本模型按型号表补上下文 / 识图（只收表里查得到的，兜底默认值不写进目录，免得界面上显示一个瞎猜的数）
  let caps = {};
  if (kind === 'text') {
    const g = guessModel(id, { protocol });
    caps = {
      ...(g.source.contextWindow === 'table' ? { contextWindow: g.contextWindow } : {}),
      ...(g.source.maxOutput === 'table' ? { maxOutput: g.maxOutput } : {}),
      ...(g.source.vision !== 'default' ? { vision: g.vision } : {}),
    };
  }
  const entry = cleanCatalogModel({ ...(old && old.kind === kind ? old : {}), ...caps, id, kind, label: str(o.label, 80) || old?.label || id, vendor: vendorOf(id) || '', source: 'manual' }, 'manual');
  const rest = cur.models.filter((m) => m.id !== id);
  if (rest.length >= CATALOG_MAX) throw bad(`目录最多 ${CATALOG_MAX} 个模型`);
  writeCatalog(sid, { at: cur.at || Date.now(), models: [...rest, entry], media: cur.media });
  return entry;
}

/** 删服务时一起删目录。 */
export function removeCatalog(sid) {
  cache.delete(sid);
  try { rmSync(fileOf(sid), { force: true }); } catch (e) { console.error('[model-hub] 目录文件删不掉：', e?.message || e); }
}

/** 总览用的摘要：{ size, at, media }。 */
export function catalogMeta(sid) {
  try { const c = readCatalog(sid); return { size: c.models.length, at: c.at, media: c.media }; }
  catch { return { size: 0, at: 0, media: null }; }
}
