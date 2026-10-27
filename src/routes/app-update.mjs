// 「获取更新」与「连接」后端：版本检查 + apk 下发 + 服务器身份 / 地址。
//   GET /api/app/version     —— 无 auth（要在登录前也能查版本）。只认这台服务端自己能发的包，版本对齐策略见
//                               runtime/apk-source.mjs 文件头（≤ 服务端、优先同一次构建；没有就 available:false + 发布页）
//   GET /api/app/download    —— 需登录（Bearer / cookie / ?token=）：本机文件流式 + Range；镜像 / 发布页 302 过去
//   GET /download/android    —— 手机浏览器扫码下载 App 的入口（完成页、设置「连接与更新」的二维码指向它）：单人服务器免登录
//                               （apk 里只有前端，和 / 下发的页面是同一份公开内容），多人服务器要登录；没有包时回一页人话
//   GET /api/app/hello       —— 无 auth：服务器 id + 对随机数的 ECDSA 签名。设备换候选地址（局域网 / 上一个公网地址 / 新推来的地址）
//                               之前先验明正身，再把凭据发过去（见 runtime/server-address.mjs）
//   GET /api/app/server-info —— 需登录：公网地址、地址簿（id / 公钥 / 地址类型；局域网候选只给管理员）、多用户开关、运行时长、
//                               是否正等着空闲重启 / 装更新（restart，S1-5）。
//                               不含任何凭据。单 agent 模式设置里的「连接」分区、App 的地址自愈（web/src/lib/serverAddress.js）用
//   GET /api/app/caps        —— 无 auth：这台服务端支持哪些桌面客户端能力（SERVER_CAPS）。客户端登录前就要知道——
//                               窗口要不要 frameless 只能在建窗时定。没有这条路由的服务端（Muse 现行版等）客户端按纯网页窗口处理
//                               （client/desktop/server-caps.cjs）
import { streamFile } from '../runtime/http-file.mjs';
import { getSession } from '../users.mjs';
import { existsSync } from 'node:fs';
import { PUBLIC_ORIGIN, FEATURES, PORT, LISTEN_HOST } from '../config/index.mjs';
import { APP_VERSION_CODE, APP_VERSION_NAME } from '../config/versions.mjs';
import { appVersionInfo, apkStatus, currentApk, releasePage, warmApkFeed } from '../runtime/apk-source.mjs';
import { serverAddress } from '../runtime/server-address.mjs';
import { restartState } from '../runtime/service-control.mjs';
import { pageLang } from './share-gate.mjs';
import { DISTRO } from '../config/distro.mjs';

const STARTED_AT = Date.now();

// 控制台「服务控制」看安装包从哪来：本地出的包 / 发布页缓存 / OSS 镜像 / 公开发布页 / 都没有。
export function apkInfo() { return apkStatus(); }

// server-info 里给所有登录身份看的那份「要重启 / 装更新了吗」（与总线 {type:'server.restart'} 同一口径，没有挂起时为 null）
export function publicRestart() {
  const r = restartState();
  if (!r.pending && !r.going) return null;
  return { phase: r.going ? 'going' : 'pending', reason: r.reason, version: r.version, live: r.live, since: r.since, deadline: r.deadline };
}

// 桌面客户端能力声明：只说「这台服务端的前端 / 接口有没有」，不含任何状态与凭据。
//   wco           —— 前端会自绘标题栏（右上窗控避让 + 拖拽区，web/src/desktop/chrome）；没有就让客户端用系统标题栏
//   quick         —— 有快问浮窗页（/app/quick.html）
//   devices       —— 设备通道（/api/devices/register、/api/device/*）：这台电脑登记成设备、agent 操作电脑
//   pair          —— 扫码 / 配对码登录（/api/pair/connect*）
//   clientUpdates —— 经设备通道下发客户端更新（/d/<令牌>/client/version、/client/module）
//   addressFollow —— 地址自愈（/api/app/hello 验签 + server-info 地址簿）
//   desktopUi     —— 桌面专属界面（桌面设置、桌面主页）
// 移植到别的服务端（Muse 等）时，搬齐一项再在那边声明一项；distro（发行版 id）只给客户端显示品牌用，功能判断一律看 caps。
export const SERVER_CAPS = Object.freeze({
  wco: true, quick: true, devices: true, pair: true, clientUpdates: true, addressFollow: true, desktopUi: true,
});

const json = (res, status, obj, extra = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
};

// 局域网候选（地址簿、设置里「手机扫码下载 App」的局域网二维码用）。只给手机在同一个 Wi-Fi 里真连得上的：
//   · 服务端只听回环（默认取实际监听地址 config 的 LISTEN_HOST：BRIDGE_HOST > config.json 的 bindHost > 部署形态默认，
//     NO_AUTH 的本机实例恒为回环；桌面本机服务端关了「允许局域网」、只听本机的新装 Linux 服务器都在此列）→ 一个都不给；
//   · 听的是某个具体地址 → 只给它；
//   · 跑在容器里 → 不给（容器的网卡地址手机路由不到，与 server.mjs 启动日志同一口径）；
//   · 只给私网地址（VPS 的公网网卡不是「局域网」，明文 http 把令牌发过去更不行）。
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
export function lanCandidates(lanIPs, { bind = null, port = PORT, inContainer = null } = {}) {
  const host = bind != null ? String(bind) : String(LISTEN_HOST || '0.0.0.0');
  if (/^(127\.|localhost$|::1$|\[::1\]$)/i.test(host)) return [];
  const docker = inContainer != null ? inContainer : (existsSync('/.dockerenv') || process.env.container === 'docker');
  if (docker) return [];
  let ips = [];
  if (host !== '0.0.0.0' && host !== '::' && /^\d+\.\d+\.\d+\.\d+$/.test(host)) ips = [host];
  else { try { ips = lanIPs() || []; } catch { ips = []; } }
  return ips.filter((ip) => PRIVATE_V4.test(String(ip))).slice(0, 6).map((ip) => 'http://' + ip + ':' + port);
}

function sessionFromQuery(req) {
  try { const qt = new URL(req.url, 'http://x').searchParams.get('token'); return !!(qt && getSession(qt)); } catch { return false; }
}

// 发一份 apk：本机文件流式（带 Range，DownloadManager 断点续传要它），镜像 / 发布页 302（同样支持 Range）。
function sendApk(req, res, a, downloadName) {
  if (a.kind === 'redirect') { res.writeHead(302, { Location: a.url, 'Cache-Control': 'no-store' }); res.end(); return; }
  streamFile(req, res, a.file, {
    stat: a.stat,
    contentType: 'application/vnd.android.package-archive',
    disposition: `attachment; filename="${downloadName}"`,
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function noApkPage(req, res) {
  const en = pageLang(req) === 'en';
  const rel = releasePage();
  const body = '<!doctype html><html lang="' + (en ? 'en' : 'zh-CN') + '"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + (en ? 'The Bridge app' : 'The Bridge 手机 App') + '</title>'
    + '<style>html{background:#12110f;color:#f2f0eb;font:16px/1.65 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}'
    + 'body{max-width:30em;margin:0 auto;padding:18vh 20px}h1{font-size:20px;margin:0 0 10px}p{margin:0 0 12px;color:#c9c5bc}a{color:#d97757}</style>'
    + '<h1>' + (en ? 'This server has no app build to hand out' : '这台服务器没有可发的 App 版本') + '</h1>'
    + '<p>' + (en ? 'The phone app is served by your bridge server itself. This one doesn’t have a build for its version yet.'
      : '手机 App 由你的 bridge 服务器自己发，这台服务器上还没有和它版本对应的安装包。') + '</p>'
    + (rel ? '<p><a href="' + esc(rel) + '" rel="noopener noreferrer">' + (en ? 'Download it from the release page' : '去发布页下载') + '</a></p>' : '')
    + '</html>';
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export function registerAppUpdateRoutes(router, { authOk, identify, lanIPs = null }) {
  warmApkFeed();

  router.on('GET', '/api/app/version', (req, res) => {
    json(res, 200, appVersionInfo());
  });

  router.on('GET', '/api/app/download', (req, res) => {
    // 任何已登录身份都可下载更新：admin（authOk：Bearer/cookie/?token= admin）或 user。
    // user 的 apk DownloadManager 用 ?token=<session> 取包（也兼容 Bearer/cookie）。之前只认
    // authOk(admin)，user 账号在 apk 里更新永远 401 ＝「获取更新失败」。
    const ok = authOk(req) || identify(req).kind !== 'none' || sessionFromQuery(req);
    if (!ok) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const a = currentApk();
    if (!a) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('apk not built yet'); return; }
    sendApk(req, res, a, 'ClaudeBridge.apk');
  });

  // 手机浏览器扫码下载（没装 App 的那一步）。多人服务器上它也要登录：别让任何人拿着公网地址刷流量。
  router.on('GET', '/download/android', (req, res) => {
    if (FEATURES.multiUser) {
      const kind = identify(req).kind;
      const ok = authOk(req) || kind === 'admin' || kind === 'user' || sessionFromQuery(req);
      if (!ok) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(pageLang(req) === 'en' ? 'Sign in first' : '请先登录'); return; }
    }
    const a = currentApk();
    if (!a) { noApkPage(req, res); return; }
    sendApk(req, res, a, `ClaudeBridge-${String(a.name || a.code).replace(/[^\w.-]+/g, '_')}.apk`);
  });

  router.on('GET', '/api/app/hello', (req, res) => {
    let n = '';
    try { n = new URL(req.url, 'http://x').searchParams.get('n') || ''; } catch {}
    // 签名绑上这次请求的 Host（见 runtime/server-address.mjs 文件头：经别的地址转发过来的验不过）
    json(res, 200, serverAddress().hello(n, req.headers.host || ''));
  });

  router.on('GET', '/api/app/caps', (_req, res) => {
    json(res, 200, { app: 'bridge', distro: DISTRO.id, v: 1, caps: SERVER_CAPS });
  });

  router.on('GET', '/api/app/server-info', (req, res) => {
    const kind = identify(req).kind;
    if (kind !== 'admin' && kind !== 'user') { json(res, 401, { error: 'unauthorized' }); return; }
    // 局域网候选只给管理员（暴露内网拓扑，与 /api/lan 同一口径）；手机根本连不上的不给（见 lanCandidates）
    let lan = null;
    if (kind === 'admin' && typeof lanIPs === 'function') lan = lanCandidates(lanIPs);
    json(res, 200, {
      app: { code: APP_VERSION_CODE, name: APP_VERSION_NAME },
      multiUser: FEATURES.multiUser,
      publicOrigin: PUBLIC_ORIGIN || '',
      address: serverAddress().snapshot({ publicOrigin: PUBLIC_ORIGIN || '', lan }),
      server: { uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), node: process.version, version: APP_VERSION_NAME },
      // 服务器是不是正等着空闲重启 / 装更新（S1-5）：总线推送之外，晚到的设备（刚打开 App）也知道
      restart: publicRestart(),
    });
  });
}
