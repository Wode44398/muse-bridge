// 发行版声明（服务端在 HTML 壳里注入的 window.__DISTRO__，见 src/config/distro.mjs）。
// 同一套前端给不同发行版用（bridge 本体、Muse Bridge…）：品牌名、默认语言这类差别只从这里读，别在代码里判断「是不是 Muse」。
// 没有注入（离线 apk 壳、dev 直开 vite、桌面壳的本地页）= bridge 本体。启动前就要读，所以只能靠注入，不能等接口。

export const BRIDGE_BRAND = 'The Bridge';

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

export const DISTRO = readDistro(typeof window !== 'undefined' ? window.__DISTRO__ : null);

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
