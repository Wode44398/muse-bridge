// Muse Bridge 插件：Muse 与 bridge 本体的专属差别里，需要代码的那部分都在这里（其余经 config.json 的 edition、
// 环境变量、plugins.json 声明，见 deploy/muse/sync/README.md）。
//
// 1. 安卓 App 下载。发版时 GitHub Actions 把 MuseBridge.apk 和 android.json 放进发布包的 downloads/，
//    由服务器自己提供下载：手机走的就是打开网页的同一个网址（经隧道），不需要能访问 GitHub。
//      GET /api/app/android         → { available, versionName, versionCode, size, url, github }（免登录，旧版 App 与登录页在用）
//      GET /download/MuseBridge.apk → apk 本体（免登录：apk 里没有任何密钥或服务器信息）
//      GET /api/plugin/muse/android → 上面那份 + 下载页的二维码（设置里「安卓 App」面板用，要登录）
//    从源码直接跑（没有 downloads/）时 available=false，面板退回 GitHub 的下载链接。
// 2. 项目手册的「Muse 部署」一章（manual/），bridge 里的 Claude 和外部 agent 查手册时能看到。

import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { streamFile } from '@bridge/core/runtime/http-file.mjs';
import { qrSvg } from '@bridge/core/runtime/qr.mjs';
import { PUBLIC_ORIGIN } from '@bridge/core/config/index.mjs';

export const APK_NAME = 'MuseBridge.apk';
export const APK_PATH = `/download/${APK_NAME}`;
export const GITHUB_APK = `https://github.com/Wode44398/muse-bridge/releases/latest/download/${APK_NAME}`;

// android.json 由发版流程写：{ versionName, versionCode, sha256 }
export function androidInfo(dir) {
  let size = 0;
  try { const st = statSync(path.join(dir, APK_NAME)); if (st.isFile()) size = st.size; } catch {}
  let meta = {};
  try { meta = JSON.parse(readFileSync(path.join(dir, 'android.json'), 'utf8')) || {}; } catch {}
  return {
    available: size > 0,
    versionName: typeof meta.versionName === 'string' ? meta.versionName : '',
    versionCode: Number.isInteger(meta.versionCode) ? meta.versionCode : 0,
    size,
    url: size > 0 ? APK_PATH : '',
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

export function apply(ctx) {
  const dir = path.join(ctx.runtime.programRoot, 'downloads');

  ctx.route('GET', '/api/app/android', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(androidInfo(dir)));
  });

  const sendApk = (req, res) => {
    try {
      streamFile(req, res, path.join(dir, APK_NAME), {
        contentType: 'application/vnd.android.package-archive',
        cacheControl: 'no-cache',
        downloadName: APK_NAME,
        download: true,
      });
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('This install has no Android app package. Download it from ' + GITHUB_APK);
    }
  };
  ctx.route('GET', APK_PATH, sendApk);
  ctx.route('HEAD', APK_PATH, sendApk);

  // 面板用：带下载页二维码（电脑上打开设置，用手机扫）与「在 App 里打开」的服务器地址
  ctx.route('GET', '/api/plugin/muse/android', (req, res) => {
    if (!ctx.http.user(req, res)) return;
    const info = androidInfo(dir);
    const origin = publicOrigin(req);
    const download = info.available && origin ? origin + APK_PATH : GITHUB_APK;
    ctx.http.json(res, 200, { ...info, origin, download, qr: qrSvg(download, { margin: 2 }) });
  });

  // 「在 App 里打开」的跳转页（插件页只能开 http(s) 地址）：跳 intent://，装了 App 就把这台服务器的地址带进去，
  // 没装就照 fallback 去下载。地址只用服务端自己算的，不收参数（不做任意跳转）。免登录：页面里只有本服务器的公开地址。
  ctx.route('GET', '/muse/open-app', (req, res) => {
    const origin = publicOrigin(req);
    const info = androidInfo(dir);
    const fb = info.available && origin ? origin + APK_PATH : GITHUB_APK;
    const intent = `intent://open?server=${encodeURIComponent(origin)}#Intent;scheme=musebridge;package=com.musebridge.app;S.browser_fallback_url=${encodeURIComponent(fb)};end`;
    const href = intent.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Muse Bridge</title>'
      + '<style>html{background:#1f1f1e;color:#f8f8f6;font:16px/1.6 system-ui,sans-serif}body{max-width:28em;margin:0 auto;padding:22vh 20px;text-align:center}'
      + 'a{display:inline-block;margin-top:14px;padding:10px 22px;border-radius:999px;background:#d97757;color:#fff;text-decoration:none}</style>'
      + `<p>Muse Bridge</p><a href="${href}">打开 App / Open the app</a>`
      + `<script>location.href=${JSON.stringify(intent).replace(/</g, '\\u003c')};</script>`);
  });

  ctx.manual('manual');
}
