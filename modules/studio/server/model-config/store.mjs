// 模型配置层：按「服务 id/模型 id」给单个模型叠一层配置，不动服务记录本身。
//   <owner 目录>/model-config.json = { v: 1, models: { '<服务 id>/<模型 id>': { over?, recipe?, at, by? } } }
//   over   = 参数覆盖（overlay.mjs）：补选项、改默认值、垫一层额外请求体
//   recipe = 调用配方（recipe/normalize.mjs）：有它这个模型就照配方发请求，不走服务方言的适配器
// 单独存的原因：模型中心托管的服务每次同步都会整表重写模型清单，写在模型条目上的东西会被冲掉；这里按键存，同步不碰。
// 叶子模块：只依赖核心的 jsonfile 与 Studio 目录，cards / jobs 都能放心 import。

import path from 'node:path';
import { readJson, writeJson } from '@bridge/core/jsonfile.mjs';
import { studioOwnerDir } from '@bridge/core/runtime/studio-settings.mjs';
import { HOST_OWNER } from '@bridge/core/runtime/principal.mjs';

const KEY_RE = /^p-[0-9a-f]{6,12}\/[\w.:/@+-]{1,200}$/;
const MAX_ENTRIES = 500;

let rev = 0;
/** 变更计数：模型卡缓存、目录版本号据此失效。 */
export const modelConfigRev = () => rev;

const stores = new Map();   // owner → { models }
const fileOf = (owner) => path.join(studioOwnerDir(owner || HOST_OWNER), 'model-config.json');
function load(owner) {
  owner = owner || HOST_OWNER;
  let d = stores.get(owner);
  if (!d) {
    const raw = readJson(fileOf(owner), {});
    const models = {};
    if (raw && raw.models && typeof raw.models === 'object') {
      for (const [k, v] of Object.entries(raw.models)) if (KEY_RE.test(k) && v && typeof v === 'object') models[k] = v;
    }
    d = { models };
    stores.set(owner, d);
  }
  return d;
}
function save(owner) {
  writeJson(fileOf(owner), { v: 1, models: load(owner).models }, 2);
  rev += 1;
}

/** 这个模型的配置 { over?, recipe?, at } | null。存的是已经校验过的形状，读的人不用再校验。 */
export function getModelConfig(owner, pid, mid) {
  return load(owner).models[`${pid}/${mid}`] || null;
}
/** 这个人的全部配置（键 → 配置）。 */
export function listModelConfigs(owner) {
  return { ...load(owner).models };
}

/**
 * 写一个模型的配置。cfg 里给了的键才动：over / recipe 给 null = 删掉这一项；两项都没了整条删。回写入后的配置或 null。
 * 调用方负责校验（routes 里用 cleanOver / normalizeRecipe）。
 */
export function setModelConfig(owner, pid, mid, cfg, { by = '' } = {}) {
  owner = owner || HOST_OWNER;
  const d = load(owner);
  const k = `${pid}/${mid}`;
  if (!KEY_RE.test(k)) throw Object.assign(new Error('模型键不合法'), { status: 400 });
  const cur = { ...(d.models[k] || {}) };
  for (const f of ['over', 'recipe']) {
    if (!(f in cfg)) continue;
    if (cfg[f] === null || cfg[f] === undefined) delete cur[f]; else cur[f] = cfg[f];
  }
  if (!cur.over && !cur.recipe) delete d.models[k];
  else {
    if (!d.models[k] && Object.keys(d.models).length >= MAX_ENTRIES) throw Object.assign(new Error(`模型配置最多 ${MAX_ENTRIES} 条`), { status: 400 });
    d.models[k] = { ...cur, at: Date.now(), ...(by ? { by } : {}) };
  }
  save(owner);
  return d.models[k] || null;
}

/** 服务删了：它名下的配置一起删。 */
export function dropProviderConfigs(owner, pid) {
  const d = load(owner);
  let n = 0;
  for (const k of Object.keys(d.models)) if (k.startsWith(pid + '/')) { delete d.models[k]; n++; }
  if (n) save(owner);
  return n;
}

export function _resetModelConfigForTests() { stores.clear(); rev += 1; }
