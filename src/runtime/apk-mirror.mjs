// 服务端发 apk（三端拆分 P5）：VPS 上不构建 apk——主机出包后把 apk 和清单 latest.json 传到 OSS 镜像，
// 服务端按 config.apkMirror（清单地址）每 30 分钟拉一次清单。程序目录里有本地 apk 时仍以本地为准。
//
// 清单：{ code, name, notes, sha256, size, url }，url 可以是绝对地址，或相对清单地址的文件名。
// 只认版本号不超过服务端自己的包：apk 里打着前端，比服务端新的前端可能要用服务端还没有的接口。
// 镜像不需要被信任：安卓壳装包前按清单里的 sha256 校验，还要求签名与已装的 app 一致。
import { config } from '../config/index.mjs';
import { APP_VERSION_CODE } from '../config/versions.mjs';

const MANIFEST = String(config.apkMirror || process.env.BRIDGE_APK_MIRROR || '').trim();
const REFRESH_MS = 30 * 60 * 1000;
let cached = null;
let lastErr = '';
let checkedAt = 0;

export function normManifest(m, base = MANIFEST) {
  if (!m || typeof m !== 'object') return null;
  const code = Number(m.code);
  if (!Number.isInteger(code) || code <= 0) return null;
  if (!/^[0-9a-f]{64}$/i.test(String(m.sha256 || ''))) return null;
  const size = Number(m.size);
  if (!(size > 0) || typeof m.url !== 'string' || !m.url) return null;
  let url;
  try { url = new URL(m.url, base || undefined).href; } catch { return null; }
  if (!/^https?:\/\//.test(url)) return null;
  return { code, name: String(m.name || code), notes: String(m.notes || ''), sha256: String(m.sha256).toLowerCase(), size, url };
}

export async function refreshApkMirror() {
  if (!MANIFEST) return null;
  try {
    const r = await fetch(MANIFEST, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = normManifest(await r.json());
    if (!m) throw new Error('清单缺字段或格式不对');
    cached = m;
    lastErr = '';
  } catch (e) { lastErr = String(e?.message || e); }
  checkedAt = Date.now();
  return cached;
}

// 能发给客户端的那一份：有清单、且版本号不超过服务端。
export function mirrorApk() { return cached && cached.code <= APP_VERSION_CODE ? cached : null; }

export function mirrorStatus() {
  return { configured: !!MANIFEST, latest: cached, usable: !!mirrorApk(), error: lastErr, checkedAt, serverCode: APP_VERSION_CODE };
}

if (MANIFEST) {
  void refreshApkMirror();
  const t = setInterval(() => { void refreshApkMirror(); }, REFRESH_MS);
  t.unref?.();
}
