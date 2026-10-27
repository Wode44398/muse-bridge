// apk 出包时把私有 overlay 打进离线壳（开源路线 2.1 / 2.5）。
//
// 网页和桌面壳的页面由服务端发，overlay 由服务端在运行时叠上去（src/runtime/overlay-web.mjs）。apk 的离线壳不一样：
// 页面在包里（https://appassets.androidplatform.net/app/…），如果再到所连的服务器去取 overlay，
//   · 每次冷启动先显示公开版外观、取到清单才换回原版，断网时一直是公开版；
//   · 还等于让服务器能往手机里推可执行代码（离线壳这个源挂着读写本地文件夹、下载安装的原生桥）。
// 所以维护者自己出 apk 时，overlay 在构建期就打进包里：
//   <outDir>/_ov/<路径>   overlay 的 web/ 拷进来（chatgpt/ 归 Codex 分页的构建插件、lg-ref/ 是开发页，不拷）
//   <outDir>/_ov/manifest.json
//   index.html / quick.html / solo.html   </head> 前写入与服务端完全相同的标签（window.__OVERLAY__ + 样式表 + url 变量）
// 离线壳本地读这些文件，首帧就是原版，不碰网络。
//
// 只在 apk 出包（环境变量 BRIDGE_APK_OUT，build-apk.ps1 设）、找得到 overlay、且不是公开版出包（BRIDGE_EDITION=public）时生效；
// 生产 public/app 的构建什么都不做（服务端运行时叠加）。overlay 的位置同服务端：BRIDGE_OVERLAY_DIR > 数据根 config.json 的 overlayDir。
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildManifest, headTags, injectHead, OV_PREFIX } from '../../src/runtime/overlay-manifest.mjs';
import { isPublicEdition, overlayDir } from './chatgpt-overlay.mjs';

// 不进包的顶层目录：Codex 分页的页面另有插件拷到 <outDir>/chatgpt；玻璃对比开发页不需要
const SKIP_TOP = ['chatgpt/', 'lg-ref/'];
export const bundleSkip = (rel) => SKIP_TOP.some((d) => rel === d || rel.startsWith(d));
const SHELLS = ['index.html', 'quick.html', 'solo.html'];

/** 要不要把 overlay 打进这次构建：返回 <overlay>/web 或 null。 */
export function apkOverlayWeb(env = process.env) {
  if (!env.BRIDGE_APK_OUT || isPublicEdition(env)) return null;
  const dir = overlayDir(env);
  if (!dir) return null;
  const web = path.join(dir, 'web');
  return existsSync(web) ? web : null;
}

/** 把 overlay web/ 打进 outDir（apk 的 www/app）。返回清单（测试用）。 */
export function bundleOverlay(web, outDir) {
  const { manifest } = buildManifest(web, { prefix: OV_PREFIX, skip: bundleSkip });
  const dst = path.join(outDir, '_ov');
  mkdirSync(dst, { recursive: true });
  for (const rel of manifest.files) {
    const to = path.join(dst, ...rel.split('/'));
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(path.join(web, ...rel.split('/')), to, { force: true });
  }
  writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(manifest));
  const tags = headTags(manifest, OV_PREFIX);
  for (const f of SHELLS) {
    const p = path.join(outDir, f);
    if (!existsSync(p)) continue;
    const html = readFileSync(p, 'utf8');
    if (html.includes('window.__OVERLAY__=')) continue;   // 重复跑不重复插
    writeFileSync(p, injectHead(html, tags));
  }
  return manifest;
}

export function overlayBundle({ log = console.log } = {}) {
  let outDir = '', isBuild = false;
  return {
    name: 'bridge-overlay-bundle',
    config(_c, { command }) { isBuild = command === 'build'; },
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    closeBundle() {
      if (!isBuild) return;
      const web = apkOverlayWeb();
      if (!web) return;
      const m = bundleOverlay(web, outDir);
      log(`[overlay] 私有 overlay 打进 apk：${m.files.length} 个文件（${web}）`);
    },
  };
}
