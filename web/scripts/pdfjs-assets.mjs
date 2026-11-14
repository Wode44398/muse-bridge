// 构建插件：把 PDF.js 运行时要按需拉取的数据文件随包带上，离线 apk / 内网 / 桌面壳都不再去 CDN 找。
//
//   cmaps/          CJK 等字体的字符映射（.bcmap，169 个，中文 PDF 不嵌字体时缺它就丢字）
//   standard_fonts/ 14 种标准字体的替身（未嵌入字体的 PDF 照样渲染出字形）
//   wasm/           JBIG2 / JPEG2000 解码与 ICC 色彩管理（扫描件、印刷稿常见）
//   iccs/           CMYK 回落用的色彩配置
//
// 产物放在 <outDir>/assets/pdfjs-<版本>/ 下：assets/ 由 static.mjs 按一年 immutable 缓存，路径里带版本，
// 升级 pdfjs-dist 自动换目录；目录名不以「.」或「_」开头（安卓 aapt 会静默丢掉这两类资源）。
// 走 emitFile 进 bundle，bridge-module-chunks 的归属清单能看到它们（算核心）。
// 开发态由中间件直接从 node_modules 读，不拷贝。前端按 BASE_URL + 'assets/pdfjs-' + pdfjsLib.version 拼地址（components/preview/pdf/pdfjs.js）。

import { readdir, readFile } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
const TYPES = { '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream', '.bcmap': 'application/octet-stream', '.icc': 'application/vnd.iccprofile' };

export function pdfjsAssets({ webRoot }) {
  const root = path.join(webRoot, 'node_modules', 'pdfjs-dist');
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const prefix = `assets/pdfjs-${version}/`;
  return {
    name: 'bridge-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        const at = url.indexOf('/' + prefix);
        if (at < 0) return next();
        const rel = decodeURIComponent(url.slice(at + prefix.length + 1));
        const [dir] = rel.split('/');
        const file = path.join(root, rel);
        // 只放行四个数据目录，防 ../ 穿越到 node_modules 别处
        if (!DIRS.includes(dir) || !file.startsWith(path.join(root, dir) + path.sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
    async generateBundle() {
      for (const dir of DIRS) {
        let names = [];
        try { names = await readdir(path.join(root, dir)); } catch { continue; }
        for (const n of names) {
          if (n.startsWith('.') || n.startsWith('_') || /\.(md|txt)$/i.test(n)) continue;
          const src = path.join(root, dir, n);
          if (!statSync(src).isFile()) continue;
          this.emitFile({ type: 'asset', fileName: prefix + dir + '/' + n, source: await readFile(src) });
        }
      }
    },
  };
}
