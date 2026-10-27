// 发行版声明（服务端在 HTML 壳里注入的 window.__DISTRO__，见 src/config/distro.mjs）。
// 同一套前端给不同发行版用（bridge 本体、Muse Bridge…）：品牌名、默认语言这类差别只从这里读，别在代码里判断「是不是 Muse」。
// 没有注入（离线 apk 壳、dev 直开 vite、桌面壳的本地页）= bridge 本体。启动前就要读，所以只能靠注入，不能等接口。

export const BRIDGE_BRAND = 'The Bridge';

export function readDistro(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  return Object.freeze({
    id: typeof e.id === 'string' && e.id ? e.id : 'bridge',
    brand: typeof e.brand === 'string' && e.brand ? e.brand : BRIDGE_BRAND,
    langDefault: e.langDefault === 'browser' ? 'browser' : 'zh',
  });
}

export const DISTRO = readDistro(typeof window !== 'undefined' ? window.__DISTRO__ : null);

/** 文案里的「The Bridge」换成发行版品牌（本体原样）。i18n 的 t / tc / tr 出口都过一遍，中英文一起生效。 */
export function brandText(s, brand = DISTRO.brand) {
  return brand !== BRIDGE_BRAND && typeof s === 'string' && s.includes(BRIDGE_BRAND) ? s.replaceAll(BRIDGE_BRAND, brand) : s;
}

/** 品牌拆成大字标的两行（「THE / BRIDGE」→「MUSE / BRIDGE」）；只有一个词时第一行空着 */
export function brandWords(brand = DISTRO.brand) {
  const parts = String(brand).trim().toUpperCase().split(/\s+/);
  return parts.length > 1 ? [parts.slice(0, -1).join(' '), parts[parts.length - 1]] : ['', parts[0] || ''];
}
