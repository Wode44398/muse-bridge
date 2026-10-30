// 发行版声明（服务端在 HTML 壳里注入的 window.__DISTRO__，见 src/config/distro.mjs）。
// 同一套前端给不同发行版用（bridge 本体、Muse Bridge…）：品牌名、默认语言这类差别只从这里读，别在代码里判断「是不是 Muse」。
// 没有注入（dev 直开 vite、桌面壳的本地页）= bridge 本体。启动前就要读，所以只能靠注入，不能等接口。
// 离线 apk 壳的页面不从服务器加载、也没有注入：用上一次连上时从 /api/app/caps 取来缓存的那份（syncDistro），
// 同一个 apk 连 bridge 本体是 The Bridge、连 Muse Bridge 的服务器就是 Muse Bridge。

import { storeGet, storeSet } from './store.js';

export const BRIDGE_BRAND = 'The Bridge';
const CACHE_KEY = 'bridge-distro';
const isApkPage = () => { try { return location.hostname === 'appassets.androidplatform.net'; } catch { return false; } };

// 反馈去向：本体默认「bridge 开发者」（界面文案逐字不变）；发行版在 config.json 的 distro.feedback 声明别的去向（服务端校验过再注入，
// 见 src/config/distro.mjs）。只在声明了时 DISTRO 才带 feedback，没声明 DISTRO 的形状不变。
export const FEEDBACK_DEFAULT = Object.freeze({ to: 'bridge 开发者', toEn: 'the Bridge developer', public: false }); // i18n-ignore：这是 t() 的参数值，模板在字典里（to 是中文去向，toEn 是英文去向）

/** 从注入的声明或 /api/feedback/upstream 回的 dest 读去向；不合规返回 null */
export function readFeedbackDest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const to = typeof raw.to === 'string' && raw.to.trim() ? raw.to.trim() : '';
  if (!to && raw.public !== true) return null;
  const toEn = typeof raw.toEn === 'string' && raw.toEn.trim() ? raw.toEn.trim() : '';
  return Object.freeze({ to: to || FEEDBACK_DEFAULT.to, toEn: toEn || (to || FEEDBACK_DEFAULT.toEn), public: raw.public === true });
}

export function readDistro(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const feedback = readFeedbackDest(e.feedback);
  return Object.freeze({
    id: typeof e.id === 'string' && e.id ? e.id : 'bridge',
    brand: typeof e.brand === 'string' && e.brand ? e.brand : BRIDGE_BRAND,
    langDefault: e.langDefault === 'browser' ? 'browser' : 'zh',
    ...(feedback ? { feedback } : {}),
  });
}

function cachedDistro() {
  try { return JSON.parse(storeGet(CACHE_KEY) || 'null'); } catch { return null; }
}

export const DISTRO = readDistro(typeof window === 'undefined' ? null : (window.__DISTRO__ ?? (isApkPage() ? cachedDistro() : null)));

/**
 * /api/app/caps 的回包 → 发行版声明原文（交给 readDistro）。新服务端带 distroInfo 全文；只有 distro id 的（Muse 早期版）
 * 至少认出 id；本体、没有这条路由的老服务端（notFound）= null，即 bridge 本体。认不出是不是 bridge 的回包返回 undefined（别动缓存）。
 */
export function distroFromCaps(j, notFound = false) {
  if (notFound) return null;
  if (!j || typeof j !== 'object' || j.app !== 'bridge') return undefined;
  if (j.distroInfo && typeof j.distroInfo === 'object' && !Array.isArray(j.distroInfo)) return j.distroInfo;
  return typeof j.distro === 'string' && j.distro && j.distro !== 'bridge' ? { id: j.distro } : null;
}

/**
 * 离线 apk：连上服务器后取一份它的发行版声明缓存下来，下次启动在任何模块求值前就用上（品牌、默认语言都在启动时定死）。
 * 和这次启动用的不一样（第一次连上发行版服务器、换了服务器、发行版改了品牌）就刷新一次页面；同一会话最多刷一次，防来回刷。
 * 网页 / 桌面壳有服务端注入，什么都不做。url = 当前线路上的 /api/app/caps。
 */
export async function syncDistro(url) {
  if (!isApkPage() || window.__DISTRO__) return false;
  let raw;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    raw = r.ok ? distroFromCaps(await r.json()) : distroFromCaps(null, r.status === 404);
  } catch { return false; }
  if (raw === undefined) return false;
  const next = readDistro(raw);
  storeSet(CACHE_KEY, raw ? JSON.stringify(next) : null);
  if (JSON.stringify(next) === JSON.stringify(DISTRO)) return false;
  try {
    if (sessionStorage.getItem(CACHE_KEY + ':reloaded')) return false;
    sessionStorage.setItem(CACHE_KEY + ':reloaded', '1');
  } catch {}
  location.reload();
  return true;
}

/**
 * 反馈去向。服务端回的 dest（/api/feedback/upstream，离线 apk 壳连发行版服务器时没有注入也能拿到）优先，
 * 其次注入的 DISTRO.feedback，都没有 = 本体默认。lang 为 'en' 时 to 取英文去向。
 */
export function feedbackDest(serverDest, lang = 'zh', distro = DISTRO) {
  const d = readFeedbackDest(serverDest) || distro.feedback || FEEDBACK_DEFAULT;
  return { to: lang === 'en' ? d.toEn : d.to, public: d.public };
}

/** 文案里的「The Bridge」换成发行版品牌（本体原样）。i18n 的 t / tc / tr 出口都过一遍，中英文一起生效。 */
export function brandText(s, brand = DISTRO.brand) {
  return brand !== BRIDGE_BRAND && typeof s === 'string' && s.includes(BRIDGE_BRAND) ? s.replaceAll(BRIDGE_BRAND, brand) : s;
}

/** 版本行去掉开头的品牌（「Muse Bridge · v6.70（483）」→「v6.70（483）」）；本体与别的发行版都认 */
export function stripBrand(s, brand = DISTRO.brand) {
  const str = String(s ?? '');
  for (const b of new Set([brand, BRIDGE_BRAND])) {
    if (str.startsWith(b)) return str.slice(b.length).replace(/^\s*·\s*/, '');
  }
  return str;
}

/** 品牌拆成大字标的两行（「THE / BRIDGE」→「MUSE / BRIDGE」）；只有一个词时第一行空着 */
export function brandWords(brand = DISTRO.brand) {
  const parts = String(brand).trim().toUpperCase().split(/\s+/);
  return parts.length > 1 ? [parts.slice(0, -1).join(' '), parts[parts.length - 1]] : ['', parts[0] || ''];
}
