// 安卓 app 下载。发版时 GitHub Actions 把 MuseBridge.apk 和 android.json 放进安装包的 downloads/，
// 这里由服务器自己提供下载：手机走的就是打开网页的同一个网址（经隧道），不需要能访问 GitHub。
//   GET /api/app/android         → { available, versionName, versionCode, size, github }
//   GET /download/MuseBridge.apk → apk 本体
// 两个都不用登录：apk 里没有任何密钥或服务器信息，登录页上也可以放下载入口。
// 从源码直接跑（没有 downloads/）时 available=false，设置页退回 GitHub 的下载链接。

import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { PROGRAM_ROOT } from '../runtime/paths.mjs';
import { streamFile } from '../runtime/http-file.mjs';

export const APK_NAME = 'MuseBridge.apk';
export const APK_PATH = `/download/${APK_NAME}`;
export const GITHUB_APK = `https://github.com/Wode44398/muse-bridge/releases/latest/download/${APK_NAME}`;
const DOWNLOADS = path.join(PROGRAM_ROOT, 'downloads');

// android.json 由发版流程写：{ versionName, versionCode, sha256 }
export function androidInfo(dir = DOWNLOADS) {
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

export function registerAndroidAppRoutes(router, { dir = DOWNLOADS } = {}) {
  router.on('GET', '/api/app/android', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(androidInfo(dir)));
  });
  router.on(['GET', 'HEAD'], APK_PATH, (req, res) => {
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
  });
}
