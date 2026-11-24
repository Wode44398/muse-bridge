// 索引验签与规整：只认验过签的原始字节，再把字段裁成已知的形状（超长截断、不合规的版本丢掉），后面的代码只碰规整后的对象。
// 官方索引与社区索引各用各的钥匙（channel 里给），格式都是 format 1；社区条目多了作者、种类、能力与吊销名单。
import crypto from 'node:crypto';
import { PluginError } from '../discover.mjs';
import { compareVersions } from '../engines.mjs';

export const MAX_ZIP = 50 * 1024 * 1024;
export const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
const VER_RE = /^\d+\.\d+\.\d+$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const CAPS = new Set(['process', 'network', 'files', 'env', 'core']);

export function verifyIndexSignature(bytes, sigText, keys) {
  let sig;
  try { sig = JSON.parse(String(sigText)); } catch { throw new PluginError(502, '索引的签名文件坏了'); }
  const key = keys.find((k) => k.id === sig?.keyId);
  if (!key) throw new PluginError(502, `索引用的签名钥匙「${String(sig?.keyId || '').slice(0, 40)}」这台 bridge 不认识（可能要先升级 bridge）`);
  let ok = false;
  try {
    const pub = crypto.createPublicKey({ key: Buffer.from(key.spki, 'base64'), format: 'der', type: 'spki' });
    ok = crypto.verify(null, bytes, pub, Buffer.from(String(sig.sig || ''), 'base64'));
  } catch { ok = false; }
  if (!ok) throw new PluginError(502, '索引签名对不上，没采用');
}

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const https = (v) => (typeof v === 'string' && /^https:\/\//i.test(v) ? v.slice(0, 300) : '');
const strList = (v, n, len) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x && x.length <= len).slice(0, n) : []);

function baseVersions(p, extra = () => ({})) {
  return (Array.isArray(p.versions) ? p.versions : [])
    .filter((v) => v && VER_RE.test(v.version || '') && typeof v.url === 'string' && /^[0-9a-f]{64}$/i.test(v.sha256 || '')
      && Number.isInteger(v.size) && v.size > 0 && v.size <= MAX_ZIP)
    .map((v) => ({
      version: v.version,
      engines: v.engines && typeof v.engines === 'object' ? { ...(typeof v.engines.bridge === 'string' ? { bridge: v.engines.bridge } : {}), ...(v.engines.pluginApi != null ? { pluginApi: Number(v.engines.pluginApi) } : {}) } : {},
      restart: !!v.restart, url: v.url, sha256: v.sha256.toLowerCase(), size: v.size,
      date: str(v.date, 10), notes: str(v.notes, 2000),
      ...extra(v),
    }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

const baseEntry = (p, versions) => ({
  id: p.id, name: str(p.name, 60) || p.id, nameEn: str(p.nameEn, 60), description: str(p.description, 500), descriptionEn: str(p.descriptionEn, 500),
  category: str(p.category, 30) || 'third-party', author: str(p.author, 60), homepage: https(p.homepage), icon: https(p.icon), versions,
});

function head(o, market) {
  if (!o || typeof o !== 'object' || o.format !== 1 || !Array.isArray(o.plugins) || !Number.isInteger(o.seq)) throw new PluginError(502, '索引格式不认识（format 不是 1）');
  if (market && o.market !== market) throw new PluginError(502, `这不是${market === 'community' ? '社区' : ''}市场的索引`);
}

export function normalizeIndex(o) {
  head(o);
  const plugins = [];
  const seen = new Set();
  for (const p of o.plugins) {
    if (!p || !ID_RE.test(p.id || '') || seen.has(p.id)) continue;
    const versions = baseVersions(p);
    if (!versions.length) continue;
    seen.add(p.id);
    plugins.push({ ...baseEntry(p, versions), builtin: p.builtin === true });
  }
  return { format: 1, market: str(o.market, 40) || 'official', seq: o.seq, generatedAt: str(o.generatedAt, 40), plugins };
}

// 社区索引：作者（GitHub 登录名）是必填的权威身份；种类缺省按 server（更谨慎的那边）；永远不能盖内置功能。
// 不收作者给的远程图标：没人审过的图片地址能拿到每个打开市场页的人的 IP，社区卡片一律用分类线稿图标。
export function normalizeCommunityIndex(o) {
  head(o, 'community');
  const revoked = (Array.isArray(o.revoked) ? o.revoked : [])
    .filter((r) => r && ID_RE.test(r.id || ''))
    .map((r) => ({ id: r.id, versions: r.versions === '*' ? '*' : strList(r.versions, 200, 20).filter((v) => VER_RE.test(v)), reason: str(r.reason, 200) }))
    .slice(0, 5000);
  const plugins = [];
  const seen = new Set();
  for (const p of o.plugins) {
    if (!p || !ID_RE.test(p.id || '') || seen.has(p.id) || p.builtin === true || !LOGIN_RE.test(String(p.publisher || ''))) continue;
    const versions = baseVersions(p, (v) => ({
      kind: v.kind === 'page' ? 'page' : 'server',
      caps: strList(v.caps, 10, 20).filter((c) => CAPS.has(c)),
      permissions: strList(v.permissions, 40, 40),
      commit: /^[0-9a-f]{7,40}$/i.test(String(v.commit || '')) ? String(v.commit) : '',
      source: https(v.source),
    }));
    if (!versions.length) continue;
    seen.add(p.id);
    plugins.push({ ...baseEntry(p, versions), icon: '', builtin: false, publisher: p.publisher });
  }
  return { format: 1, market: 'community', seq: o.seq, generatedAt: str(o.generatedAt, 40), plugins, revoked };
}

// 某个版本在不在吊销名单里：返回原因（可能是空串）或 null
export function revokedReason(index, id, version) {
  for (const r of index?.revoked || []) {
    if (r.id !== id) continue;
    if (r.versions === '*' || (Array.isArray(r.versions) && r.versions.includes(version))) return r.reason || '';
  }
  return null;
}
