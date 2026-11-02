// 插件提供的外部登录（插件接口四期，服务端 src/plugins/auth-providers.mjs）：登录页多出「用 X 登录」按钮。
//   GET /api/auth/providers（不要登录）→ { providers: [{ key, label, icon }] }
//   点了整页跳 /api/auth/ext/start?p=<key>，服务端 302 去外部身份源，回调后发会话 cookie 回到首页。
// 手机 App（离线 apk 跨源、走不了浏览器跳转、也拿不到 cookie）不显示这些按钮。
// 登录页（LoginDialog / 主页登录卡 / 设置 › 登录 / 桌面设置）各自画按钮，共用这里的数据与跳转。
import { apiUrl, isOffline } from './server.js';
import { inAndroidApp } from './pluginPanels.svelte.js';

export const extAuth = $state({ list: [], loaded: false });

/** 这个环境能不能走外部登录（整页跳转 + cookie）：离线 apk / 安卓壳不行。 */
export const extAuthSupported = () => !isOffline() && !inAndroidApp();

let inflight = null;
let at = 0;
/** 拉一次登录方式（30 秒内不重拉）。登录页一打开就调。 */
export function loadAuthProviders(force = false) {
  if (!extAuthSupported()) return Promise.resolve([]);
  if (inflight) return inflight;
  if (!force && extAuth.loaded && Date.now() - at < 30_000) return Promise.resolve(extAuth.list);
  inflight = fetch(apiUrl('/api/auth/providers'), { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { providers: [] }))
    .then((j) => {
      extAuth.list = (Array.isArray(j?.providers) ? j.providers : [])
        .filter((p) => p && typeof p.key === 'string' && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(p.key))
        .map((p) => ({ key: p.key, label: String(p.label || p.key).slice(0, 40), icon: iconSrc(p.icon) }));
    })
    .catch(() => {})
    .finally(() => { extAuth.loaded = true; at = Date.now(); inflight = null; });
  return inflight;
}

// 图标：只认图片地址（http(s)、站内 /、data:image/），别的不画
function iconSrc(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/(?!\/)/.test(s)) return apiUrl(s);
  return '';
}

/** 「用 X 登录」：整页跳到服务端的起点，由它 302 去外部身份源。 */
export function startExtLogin(key) {
  location.assign(apiUrl('/api/auth/ext/start?p=' + encodeURIComponent(key)));
}
