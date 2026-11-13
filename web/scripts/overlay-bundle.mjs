// 将完整前端视觉资源打进产物的 _ov/，三个 HTML 壳首屏同步挂载清单。
// 前端只有一套视觉（原版）：网页、桌面 staging、apk 每次构建都内置，找不到资源直接让构建失败。
// 来源见 chatgpt-overlay.mjs 的 frontendOverlayDir（发行树 = frontend-assets，私有源码树 = 私有 overlay）。
// 只取 web/：chatgpt 由独立插件处理，lg-ref 开发页不进入产品。
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildManifest, headTags, injectHead, OV_PREFIX } from '../../src/runtime/overlay-manifest.mjs';
import { frontendOverlayDir } from './chatgpt-overlay.mjs';

// 不进包的顶层目录：Codex 分页的页面另有插件拷到 <outDir>/chatgpt；玻璃对比开发页不需要
const SKIP_TOP = ['chatgpt/', 'lg-ref/'];
export const bundleSkip = (rel) => SKIP_TOP.some((d) => rel === d || rel.startsWith(d));
const SHELLS = ['index.html', 'quick.html', 'solo.html'];

/** 这次构建打进去的视觉资源：<overlay>/web；找不到 → null（构建会因此失败）。 */
export function visualsWeb(env = process.env, options = {}) {
  const dir = frontendOverlayDir(env, options);
  if (!dir) return null;
  const web = path.join(dir, 'web');
  return existsSync(path.join(web, 'overlay.json')) ? web : null;
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
      const web = visualsWeb();
      if (!web) {
        throw new Error('[overlay] 没找到原版视觉资源（私有 overlay 的 web/overlay.json）：环境变量 BRIDGE_OVERLAY_DIR、'
          + '数据根或主工作树 config.json 的 overlayDir、发行树的 frontend-assets 都没有。前端只有一套完整版，配好再构建');
      }
      const m = bundleOverlay(web, outDir);
      log(`[overlay] 原版视觉资源打进产物：${m.files.length} 个文件（${web}）`);
    },
  };
}
