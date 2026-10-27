// Codex 分页的界面（ChatGPT 页面）从私有 overlay 接进前端构建。
//
// 这套页面不在本仓库，也不随公开版发布：维护者的部署由私有 overlay 提供——
//   <overlay>/web/chatgpt/      页面本体（overlay 的网页层：服务端 runtime/overlay-web.mjs 在主构建里没有时按
//                               /app/chatgpt/* 回落到这里，所以公开构建 + overlay 的部署不重新构建也能用）
//   <overlay>/assets/chatgpt/   页面自己的构建输入；若带 prebuild.mjs，前端构建 / dev 之前由 overlay-prebuild.mjs 调用
// overlay 位置与服务端同一套（runtime/overlay-hooks.mjs）：环境变量 BRIDGE_OVERLAY_DIR > 数据根 config.json 的 overlayDir
// （数据根 = BRIDGE_DATA_ROOT，没设就是仓库根；相对路径按数据根解析）。公开版出包（BRIDGE_EDITION=public）一律当作没有。
//
// 有 overlay：构建结束把 web/chatgpt/ 拷进 <outDir>/chatgpt/，给 index.html 引用的同目录脚本 / 样式打内容哈希（Cloudflare 对
//   扩展名像静态资源的文件给 4 小时浏览器缓存，不带哈希会让旧 app.js 在部署后还活着）；dev 服务器直接从 overlay 发 /chatgpt/*。
//   apk 出包（离线壳从本地读）、Codex 离线包（bridge-modules.json 的 publicDirs = chatgpt）照旧从产物里收。
// 没有 overlay（公开版、没配的 worktree）：什么都不拷——产物里没有 chatgpt/，Codex 分页打开时提示「此版本未包含」
//   （ChatGPTPage.svelte 先探 chatgpt/index.html）。生产 public/app 不清空，上一次构建留下的 chatgpt/ 照常可用。
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(WEB, '..');

export const isPublicEdition = (env = process.env) => env.BRIDGE_EDITION === 'public';

export function overlayDir(env = process.env) {
  const dataRoot = env.BRIDGE_DATA_ROOT ? path.resolve(env.BRIDGE_DATA_ROOT) : REPO;
  const fromEnv = String(env.BRIDGE_OVERLAY_DIR || '').trim();
  if (fromEnv) return path.resolve(dataRoot, fromEnv);
  try {
    const raw = readFileSync(path.join(dataRoot, 'config.json'), 'utf8');
    const od = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).overlayDir;
    if (od) return path.resolve(dataRoot, String(od));
  } catch {}
  return null;
}

// overlay 里的 ChatGPT 页面；公开版出包、没有 overlay、或 overlay 里没有页面 → null
export function chatgptOverlay(env = process.env) {
  if (isPublicEdition(env)) return null;
  const dir = overlayDir(env);
  if (!dir) return null;
  const root = path.join(dir, 'assets', 'chatgpt');
  const page = path.join(dir, 'web', 'chatgpt');
  if (!existsSync(path.join(page, 'index.html'))) return null;
  return { overlay: dir, root, page, pickerSrc: path.join(root, 'picker-src'), vendor: path.join(root, 'vendor') };
}

// index.html 里以 src= / href= 引用的同目录 .js / .css：按内容哈希改写 ?v=（重复跑结果不变；找不到的文件不动）
const LOCAL_REF = /(\b(?:src|href)\s*=\s*["'])([A-Za-z0-9_.-]+\.(?:js|css))(?:\?v=[^"']*)?(["'])/g;
export async function stampChatgptDir(dir) {
  const indexPath = path.join(dir, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  const hashes = new Map();
  for (const m of html.matchAll(LOCAL_REF)) {
    if (hashes.has(m[2])) continue;
    try { hashes.set(m[2], createHash('sha256').update(await readFile(path.join(dir, m[2]))).digest('hex').slice(0, 12)); } catch {}
  }
  await writeFile(indexPath, html.replace(LOCAL_REF, (all, pre, name, post) => (hashes.has(name) ? `${pre}${name}?v=${hashes.get(name)}${post}` : all)));
}

const DEV_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8',
};

export function chatgptPage({ log = console.log } = {}) {
  const ov = chatgptOverlay();
  let outDir = '', isBuild = false;
  return {
    name: 'bridge-chatgpt-page',
    config(_c, { command }) { isBuild = command === 'build'; },
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    configureServer(server) {
      if (!ov) return;
      server.middlewares.use('/chatgpt', (req, res, next) => {
        let rel;
        try { rel = decodeURIComponent(String(req.url || '/').split('?')[0]); } catch { return next(); }
        rel = rel.replace(/^\/+/, '') || 'index.html';
        const file = path.resolve(ov.page, rel);
        if (!file.startsWith(ov.page + path.sep)) return next();
        try { if (!statSync(file).isFile()) return next(); } catch { return next(); }
        res.setHeader('Content-Type', DEV_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(readFileSync(file));
      });
    },
    async closeBundle() {
      if (!isBuild) return;
      if (!ov) {
        if (isPublicEdition()) log('[chatgpt] 公开版（BRIDGE_EDITION=public）：这次构建不带 Codex 分页的界面');
        // 源码里带着 Codex 扩展（维护者的私有仓 / 部署）却没接上 overlay：产物里就没有页面，Codex 分页只会提示「此版本未包含」
        else if (existsSync(path.join(REPO, 'modules', 'codex', 'bridge-module.json'))) {
          log('\n⚠ [chatgpt] 这份源码带 Codex 扩展，但没找到私有 overlay（环境变量 BRIDGE_OVERLAY_DIR，或数据根 config.json 的 overlayDir）：'
            + '\n  产物里没有 Codex 分页的界面，打开 Codex 会显示「此版本未包含」。维护者的部署请先配好 overlay 再构建。\n');
        } else log('[chatgpt] 没有私有 overlay：这次构建不带 Codex 分页的界面');
        return;
      }
      const dir = path.join(outDir, 'chatgpt');
      // 点开头的（overlay 仓库里的 .gitattributes 之类）不进产物，同服务端 overlay-web 的规矩
      cpSync(ov.page, dir, { recursive: true, force: true, filter: (src) => !path.basename(src).startsWith('.') });
      await stampChatgptDir(dir);
      log('[chatgpt] Codex 分页的界面取自 overlay：' + ov.page);
    },
  };
}
