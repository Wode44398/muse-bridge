// Codex 页面与原版前端资源共用一套构建入口。
// 发布树自带 frontend-assets/web，BRIDGE_EDITION=public 只读取该固定快照。
// 私有构建仍优先使用 BRIDGE_OVERLAY_DIR / config.json 的 overlayDir。
// 页面拷入 chatgpt/ 并对脚本和样式做内容哈希；离线包按扩展归属收集。
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(WEB, '..');

export const isPublicEdition = (env = process.env) => env.BRIDGE_EDITION === 'public';

// 发行树自带的固定前端资源，不依赖维护者电脑上的配置。
export function bundledVisualsDir(repo = REPO) {
  const dir = path.join(repo, 'frontend-assets');
  return existsSync(path.join(dir, 'web', 'overlay.json')) ? dir : null;
}

export function frontendOverlayDir(env = process.env, { repo = REPO } = {}) {
  // 发布构建只读发行树的已提交快照，不能混入本机另一份覆盖层。
  return (!isPublicEdition(env) && overlayDir(env)) || bundledVisualsDir(repo);
}

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
export function chatgptOverlay(env = process.env, options) {
  const dir = frontendOverlayDir(env, options);
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
        if (isPublicEdition()) throw new Error('发布构建缺少 frontend-assets 中的完整前端资源；请重新导出发布树');
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
