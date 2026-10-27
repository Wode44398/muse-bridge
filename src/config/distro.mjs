// 发行版声明：同一套服务端 + 前端给不同发行版用（bridge 本体、Muse Bridge…），差别只经这里声明，
// 不在代码里散落「是不是 Muse」的判断。config.json 的 distro 对象逐项覆盖；没配 = bridge 本体。
// 叫 distro 不叫 edition：edition 在本体里另有两个意思——老配置的 edition:"host"|"server"（deploy-profile 推「给谁用」的默认值）
// 与构建渠道 BRIDGE_EDITION / bridge-build.json 的 edition（public | private，modules/registry.mjs）。
//   id           发行版标识：'bridge' | 'muse' | 其他小写字母数字（桌面客户端经 /api/app/caps 读，只用来显示品牌）
//   brand        界面里的产品名：前端把文案里的「The Bridge」整体换成它（中英文一起），页面标题、PWA 清单跟着换
//   langDefault  没存过语言偏好时的界面语言：'zh'（本体默认，维护者的 Windows 是英文界面，不能跟系统）| 'browser'（跟浏览器）
// 前端经 HTML 壳里注入的 window.__DISTRO__ 读（启动前就要知道：i18n 在任何请求之前定死），见 web/src/lib/distro.js；
// 注入点与 overlay 同一处（runtime/overlay-web.mjs，覆盖 /、/app/*.html、/w/、/c/ 全部 HTML 壳）。
import { config } from './index.mjs';

const DEFAULTS = Object.freeze({ id: 'bridge', brand: 'The Bridge', langDefault: 'zh' });

export function resolveDistro(raw) {
  const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = typeof e.id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(e.id) ? e.id : DEFAULTS.id;
  const brand = typeof e.brand === 'string' && e.brand.trim() && e.brand.length <= 40 ? e.brand.trim() : DEFAULTS.brand;
  const langDefault = e.langDefault === 'browser' ? 'browser' : DEFAULTS.langDefault;
  return Object.freeze({ id, brand, langDefault });
}

export const DISTRO = resolveDistro(config.distro);

// </head> 前那一行。JSON 里的 < 转义掉，品牌名里写了 </script> 也跳不出标签
export function distroHeadTag(ed = DISTRO) {
  return `<script>window.__DISTRO__=${JSON.stringify(ed).replace(/</g, '\\u003c')};</script>`;
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// HTML 壳里写死的品牌（<title>The Bridge</title>、iOS 主屏名 Bridge）换成发行版的；本体原样返回
export function brandHtml(html, ed = DISTRO) {
  if (ed.brand === DEFAULTS.brand) return html;
  const b = escHtml(ed.brand);
  return html
    .replace(/<title>The Bridge<\/title>/, `<title>${b}</title>`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${b}$2`);
}

// PWA 清单（web/public/manifest.webmanifest）的名字跟着发行版走；解析不了原样返回
export function brandManifest(text, ed = DISTRO) {
  if (ed.brand === DEFAULTS.brand) return text;
  try {
    const m = JSON.parse(text);
    m.name = ed.brand;
    m.short_name = ed.brand;
    if (typeof m.description === 'string') m.description = ed.brand;
    return JSON.stringify(m, null, 2);
  } catch { return text; }
}
