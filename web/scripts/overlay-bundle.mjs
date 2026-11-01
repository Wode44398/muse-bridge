// 将完整前端视觉资源打进产物的 _ov/，三个 HTML 壳首屏同步挂载清单。
// 发行树的 frontend-assets 对普通网页、桌面 staging 与 apk 都生效；
// 未携带发行快照的本机源码仍只在私有 apk 构建时内置私有覆盖层。
// 只取 web/：chatgpt 由独立插件处理，lg-ref 开发页不进入产品。
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildManifest, headTags, injectHead, OV_PREFIX } from '../../src/runtime/overlay-manifest.mjs';
import { isPublicEdition, frontendOverlayDir, bundledVisualsDir } from './chatgpt-overlay.mjs';

// 不进包的顶层目录：Codex 分页的页面另有插件拷到 <outDir>/chatgpt；玻璃对比开发页不需要
const SKIP_TOP = ['chatgpt/', 'lg-ref/'];
export const bundleSkip = (rel) => SKIP_TOP.some((d) => rel === d || rel.startsWith(d));
const SHELLS = ['index.html', 'quick.html', 'solo.html'];

/** 要不要把 overlay 打进这次构建：返回 <overlay>/web 或 null。 */
export function apkOverlayWeb(env = process.env, options = {}) {
  // 发行树的资源对网页、桌面 staging 和 apk 都内置；本机覆盖层沿用原有的 apk 打包规则。
  const bundled = bundledVisualsDir(options.repo);
  if (!bundled && (!env.BRIDGE_APK_OUT || isPublicEdition(env))) return null;
  const dir = frontendOverlayDir(env, options);
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
