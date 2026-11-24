// 从作者本机的插件目录收集要投稿的文件，并合成这一版的 market.json（更新说明、英文名）。
// 略过的东西与市场仓库 CI 同一个口径（community-rules.mjs 的 skipForPublish）；剩下的照实交给规则检查，
// 不合规的文件（.exe、.log 以外的杂物……）在预检报告里点名，让作者自己清理，不偷偷丢掉。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { skipForPublish, LIMITS, MARKET_FILE } from '../community-rules.mjs';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function collectFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    if (out.length > LIMITS.files) return;
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (skipForPublish(r) || ent.isSymbolicLink()) continue;
      const p = path.join(abs, ent.name);
      if (ent.isDirectory()) { walk(p, r); continue; }
      if (!ent.isFile()) continue;
      const size = statSync(p).size;
      // 超限的文件只记大小（规则按 size 报「超过 2 MB」），不读进内存
      out.push({ path: r, size, data: size <= LIMITS.fileBytes ? readFileSync(p) : Buffer.alloc(0) });
      if (out.length > LIMITS.files) return;
    }
  };
  walk(dir, '');
  return out;
}

export function readLocalMarket(dir) {
  const f = path.join(dir, MARKET_FILE);
  if (!existsSync(f)) return null;
  try { const raw = readFileSync(f, 'utf8'); const v = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); return isObj(v) ? v : null; } catch { return null; }
}

// 合成顺序：仓库里上一版的 market.json < 作者目录里自己写的 < 这次发布面板里填的
export function composeMarket({ upstream = null, local = null, version, notes = '', nameEn = '', descriptionEn = '' }) {
  const m = { ...(isObj(upstream) ? upstream : {}), ...(isObj(local) ? local : {}) };
  const n = { ...(isObj(upstream?.notes) ? upstream.notes : {}), ...(isObj(local?.notes) ? local.notes : {}) };
  if (String(notes || '').trim()) n[version] = String(notes).trim();
  m.notes = n;
  if (String(nameEn || '').trim()) m.nameEn = String(nameEn).trim();
  if (String(descriptionEn || '').trim()) m.descriptionEn = String(descriptionEn).trim();
  delete m.builtin;
  return m;
}

export const marketFile = (m) => {
  const data = Buffer.from(JSON.stringify(m, null, 2) + '\n', 'utf8');
  return { path: MARKET_FILE, size: data.length, data };
};
