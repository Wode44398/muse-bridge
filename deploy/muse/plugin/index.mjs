// Muse Bridge 插件：Muse 与 bridge 本体的专属差别里，需要代码的那部分都在这里（其余经 config.json 的 distro、
// 环境变量、plugins.json 声明，见 deploy/muse/sync/）。
//
// 1. 安卓 App。Muse 用的就是 bridge 的安卓 App（同一个 apk：界面打包在 App 里，连上 Muse 后经 /api/app/caps 认出发行版、
//    显示 Muse Bridge 的品牌）。包由本体发：发版时 GitHub Actions 把与服务端同版本的 bridge 公开版 apk 放进发布包的程序目录
//    （ClaudeBridge-offline-<版本号>.apk），本体的 /download/android、/api/app/version 自己找到它；没有就去 bridge 公开 Release 取。
//    App 内更新只问所连的这台服务器，所以 App 永远跟着这台 Muse 的版本走（见 src/runtime/apk-source.mjs 文件头）。
//    这里只剩：
//      GET /api/plugin/muse/android → 版本 + 下载地址 + 下载页二维码（设置里「安卓 App」面板用，要登录）
//      GET /api/app/android         → 旧接口（免登录），内容改由本体的 apk 信息算
//      GET /download/MuseBridge.apk → 302 到 /download/android（旧链接、旧说明书）
//    以及旧版 Muse App（com.musebridge.app，在线 WebView 壳，0.3.x 及以前）的迁移：它打开首页时先给一页「换装新版 App」的说明。
//    两个包名不同，不能覆盖升级，只能装新的、卸旧的。
// 2. 项目手册的「Muse 部署」一章（manual/），bridge 里的 Claude 和外部 agent 查手册时能看到。

import { qrSvg } from '@bridge/core/runtime/qr.mjs';
import { PUBLIC_ORIGIN } from '@bridge/core/config/index.mjs';
import { appVersionInfo } from '@bridge/core/runtime/apk-source.mjs';

export const PAGE_PATH = '/download/android';
export const LEGACY_APK_PATH = '/download/MuseBridge.apk';
export const GITHUB_APK = 'https://github.com/Wode44398/muse-bridge/releases/latest/download/MuseBridge.apk';
// 旧版 Muse App 的 User-Agent 尾巴：「MuseBridgeApp/<版本> (<版本号>)」（新 App 没有）
export const LEGACY_UA = /\bMuseBridgeApp\/\S+/;
const LEGACY_SKIP_COOKIE = 'mb_legacy_ok';
const LEGACY_SKIP_DAYS = 7;

// 本体的 apk 信息（/api/app/version 同一份）→ 面板与旧接口用的形状
export function androidInfo(v = appVersionInfo()) {
  const available = !!(v && v.available !== false && v.code);
  return {
    available,
    versionName: available ? String(v.name || v.code) : '',
    versionCode: available ? v.code : 0,
    size: available ? v.size || 0 : 0,
    url: available ? PAGE_PATH : '',
    github: GITHUB_APK,
  };
}

// 这台服务器对外的地址：配好的公网地址优先，其次这次请求的 Host（经隧道来的就是公网域名；X-Forwarded-* 不认，谁都能塞）
export function publicOrigin(req, configured = PUBLIC_ORIGIN) {
  const fixed = String(configured || '').replace(/\/+$/, '');
  if (fixed) return fixed;
  const host = String(req.headers.host || '').trim();
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return '';
  return `${/^(localhost|127\.)/i.test(host) ? 'http' : 'https'}://${host}`;
}

const isLegacyApp = (req) => LEGACY_UA.test(String(req.headers['user-agent'] || ''));
const hasCookie = (req, name) => String(req.headers.cookie || '').split(/;\s*/).some((c) => c === name + '=1');

/** 这次请求要不要给旧版 App 的迁移页：只拦旧 App 打开首页（GET /），用户选过「先继续用旧版」的 7 天内不再拦。 */
export function wantsLegacyPage(req, url) {
  if (req.method !== 'GET' || url.pathname !== '/' || !isLegacyApp(req)) return false;
  return !hasCookie(req, LEGACY_SKIP_COOKIE) && url.searchParams.get('legacy') !== '1';
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 旧版 App 的迁移页（中英双语，跟着 Accept-Language）。download = 新 App 的下载地址（同源相对地址也行）。 */
export function legacyPage({ en = false, download = PAGE_PATH, available = true } = {}) {
  const T = en ? {
    title: 'Get the new Muse Bridge app',
    lead: 'This app has been replaced by a new one and will not get updates any more.',
    why: 'The new app keeps the interface on your phone, so it opens instantly even on a slow connection, and it updates itself to match your server. When a temporary address changes it usually finds the new one by itself, without signing in again.',
    steps: ['Tap “Download the new app” and install it (your phone may ask you to allow installing apps from this source).', 'Open the new app (its icon says The Bridge), paste this address and sign in.', 'Once it works, uninstall this old app.'],
    dl: 'Download the new app', later: 'Keep using this one for now', none: 'This server has no app package yet. Download it from GitHub:',
  } : {
    title: '请换装新版 Muse Bridge App',
    lead: '这个 App 已经换成了新版，旧版以后不再更新。',
    why: '新版把界面装在手机里，网速慢也能秒开，并且自动跟着服务器的版本更新；临时地址变了，多数时候它自己就能找回来，不用重新登录。',
    steps: ['点「下载新版 App」并安装（手机可能会问是否允许从这里安装应用，选允许）。', '打开新 App（图标上写着 The Bridge），粘贴这个网址并登录。', '新 App 能用了，就把这个旧 App 卸载掉。'],
    dl: '下载新版 App', later: '先继续用旧版', none: '这台服务器上还没有 App 安装包，请从 GitHub 下载：',
  };
  const btn = available
    ? `<a class="btn" href="${esc(download)}">${esc(T.dl)}</a>`
    : `<p class="muted">${esc(T.none)}</p><a class="btn" href="${esc(GITHUB_APK)}">${esc(T.dl)}</a>`;
  return '<!doctype html><html lang="' + (en ? 'en' : 'zh-CN') + '"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#1f1f1e"><title>Muse Bridge</title>'
    + '<style>html{background:#1f1f1e;color:#f2f2f0;font:15px/1.65 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}'
    + 'body{max-width:30em;margin:0 auto;padding:14vh 22px 40px}h1{font-size:22px;line-height:1.35;margin:0 0 10px}'
    + 'p{margin:0 0 12px}.muted{color:#a3a39e;font-size:14px}ol{padding-left:20px;margin:6px 0 22px;color:#d6d6d2}li{margin:4px 0}'
    + '.btn{display:block;text-align:center;padding:12px 18px;border-radius:999px;background:#d97757;color:#fff;text-decoration:none;font-weight:600}'
    + '.later{display:block;text-align:center;margin-top:14px;color:#a3a39e;font-size:14px}</style>'
    + `<h1>${esc(T.title)}</h1><p>${esc(T.lead)}</p><p class="muted">${esc(T.why)}</p>`
    + `<ol>${T.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>${btn}`
    + `<a class="later" href="/?legacy=1">${esc(T.later)}</a></html>`;
}

export function apply(ctx) {
  // 旧版 Muse App 打开首页 → 迁移页。首页是核心的精确路由，中间件都在路由之前跑；order 放前面，抢在核心的 HTML 改写之前
  ctx.router.use((req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/' || !isLegacyApp(req)) return;
    if (url.searchParams.get('legacy') === '1') {
      // 「先继续用旧版」：记 7 天，回首页（不带参数，免得刷新又落到这里）
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `${LEGACY_SKIP_COOKIE}=1; Max-Age=${LEGACY_SKIP_DAYS * 86400}; Path=/; SameSite=Lax`,
        'Cache-Control': 'no-store',
      });
      res.end();
      return false;
    }
    if (!wantsLegacyPage(req, url)) return;
    const en = !/^zh/i.test(String(req.headers['accept-language'] || ''));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(legacyPage({ en, available: androidInfo().available }));
    return false;
  }, { order: -10 });

  ctx.route('GET', '/api/app/android', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(androidInfo()));
  });

  const toPage = (_req, res) => { res.writeHead(302, { Location: PAGE_PATH, 'Cache-Control': 'no-store' }); res.end(); };
  ctx.route('GET', LEGACY_APK_PATH, toPage);
  ctx.route('HEAD', LEGACY_APK_PATH, toPage);

  // 面板用：版本、下载地址与下载页二维码（电脑上打开设置，用手机扫）
  ctx.route('GET', '/api/plugin/muse/android', (req, res) => {
    if (!ctx.http.user(req, res)) return;
    const info = androidInfo();
    const origin = publicOrigin(req);
    const download = info.available && origin ? origin + PAGE_PATH : GITHUB_APK;
    ctx.http.json(res, 200, { ...info, origin, download, qr: qrSvg(download, { margin: 2 }) });
  });

  ctx.manual('manual');
}
