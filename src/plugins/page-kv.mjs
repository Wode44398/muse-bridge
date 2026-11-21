// 插件页面的键值存储（SDK 的 bridge.kv.get / set / delete / list）：
//   GET  /api/plugin/<id>/_bridge/kv?key=<k>   → { value }（没有为 null）
//   GET  /api/plugin/<id>/_bridge/kv            → { keys: [...] }
//   POST /api/plugin/<id>/_bridge/kv { key, value }  → { ok: true }；value 为 null 即删除
//
// 按「插件 × 使用者」分文件：plugin-data/<id>/kv/<host | u-<账号 id 安全形式>>.json。
// 和 ctx.store（插件服务端自己那份 store.json）不是一回事：这份是页面替【使用者】记的东西（计数、草稿、偏好），
// 成员之间互相看不见，插件服务端也不经手。
// 写入：读整份 → 改 → 先写同目录临时文件再改名（断电 / 崩溃不会留下写了一半的 JSON），同一文件的写入排队。

import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { DATA_ROOT } from '../runtime/paths.mjs';

export const KV_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const KV_VALUE_MAX = 256 * 1024;
export const KV_TOTAL_MAX = 10 * 1024 * 1024;

const err = (status, message) => Object.assign(new Error(message), { status });

export const pluginDataDir = (pluginId) => path.join(DATA_ROOT, 'plugin-data', pluginId);

// ownerKey → 文件名里的那一截：主机 'host'；成员 'u-' + 账号 id，id 里除字母数字连字符以外的字符一律写成 _<十六进制>
// （中文账号名、点号之类都能落成合法文件名，且不同 id 不会撞成同一个名字；_ 自己也转写，转写结果不会有歧义）。
// 太长的（极少见）用哈希，免得撞上路径长度上限。
export function ownerSlug(ownerKey) {
  const k = String(ownerKey || '');
  if (k === 'admin') return 'host';
  const id = k.startsWith('u:') ? k.slice(2) : k;
  const safe = [...id].map((ch) => (/^[A-Za-z0-9-]$/.test(ch) ? ch : '_' + ch.codePointAt(0).toString(16))).join('');
  return 'u-' + (safe.length <= 80 ? safe : crypto.createHash('sha256').update(id).digest('hex').slice(0, 40));
}

const kvFile = (pluginId, ownerKey) => path.join(pluginDataDir(pluginId), 'kv', ownerSlug(ownerKey) + '.json');

// 整份读出来放进 Map：键可能是 __proto__ 之类（键规则允许下划线），普通对象下标赋值会改原型，Map 没这个坑。
async function load(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch { return new Map(); }
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' && !Array.isArray(j) ? new Map(Object.entries(j)) : new Map();
  } catch { return new Map(); }
}

// 写临时文件再改名。Windows 上目标正被别的进程短暂占着（杀毒、索引）时改名会 EPERM / EBUSY，稍等重试几次。
export async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  await writeFile(tmp, data);
  for (let i = 0; ; i++) {
    try { await rename(tmp, file); return; } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) { await unlink(tmp).catch(() => {}); throw e; }
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
}

// 同一文件的读改写排成一队（两个标签页同时点计数器，不会互相覆盖）
const queues = new Map();
function serial(file, fn) {
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(file, tail);
  tail.then(() => { if (queues.get(file) === tail) queues.delete(file); });
  return next;
}

const checkKey = (key) => {
  const k = String(key ?? '');
  if (!KV_KEY_RE.test(k)) throw err(400, 'key 不对：1～128 个字符，只用字母、数字和 . _ : -');
  return k;
};

export async function kvGet(pluginId, ownerKey, key) {
  const k = checkKey(key);
  const m = await load(kvFile(pluginId, ownerKey));
  return m.has(k) ? m.get(k) : null;
}

export async function kvList(pluginId, ownerKey) {
  return [...(await load(kvFile(pluginId, ownerKey))).keys()];
}

// value 为 null 即删除。单值（JSON 序列化后）≤ 256KB，整份 ≤ 10MB，超了 413。
export async function kvSet(pluginId, ownerKey, key, value) {
  const k = checkKey(key);
  if (value === undefined) throw err(400, '要 value（删除请传 null）');
  let json = null;
  if (value !== null) {
    try { json = JSON.stringify(value); } catch { throw err(400, 'value 要能存成 JSON'); }
    if (json === undefined) throw err(400, 'value 要能存成 JSON');
    if (Buffer.byteLength(json) > KV_VALUE_MAX) throw err(413, `这个值太大了（单个值上限 ${KV_VALUE_MAX / 1024}KB）`);
  }
  const file = kvFile(pluginId, ownerKey);
  return serial(file, async () => {
    const m = await load(file);
    if (value === null) {
      if (!m.has(k)) return;
      m.delete(k);
    } else {
      m.set(k, JSON.parse(json));
    }
    const out = JSON.stringify(Object.fromEntries(m));
    if (value !== null && Buffer.byteLength(out) > KV_TOTAL_MAX) throw err(413, `存的东西太多了（每个插件每人上限 ${KV_TOTAL_MAX / 1024 / 1024}MB），先删掉一些`);
    await writeAtomic(file, out);
  });
}
