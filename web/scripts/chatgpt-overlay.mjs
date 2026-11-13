// Codex 页面与原版前端资源共用一套构建入口。前端只有一套视觉（原版），每次构建都要找到它：
// 发布树自带 frontend-assets/web，BRIDGE_EDITION=public 只读取该固定快照；
// 私有源码树依次找 BRIDGE_OVERLAY_DIR → 数据根 config.json 的 overlayDir → 主工作树 config.json 的 overlayDir
// （测试服等 git worktree 的数据根在别处，和正式服共用同一份私有资源）→ frontend-assets。
// 页面拷入 chatgpt/ 并对脚本和样式做内容哈希；离线包按扩展归属收集。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  return (!isPublicEdition(env) && overlayDir(env, { repo })) || bundledVisualsDir(repo);
}

function configOverlay(root) {
  try {
    const raw = readFileSync(path.join(root, 'config.json'), 'utf8');
    const od = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).overlayDir;
    if (od) return path.resolve(root, String(od));
  } catch {}
  return null;
}

// repo 是某个 git worktree 时，主工作树的根目录；repo 自己就是主工作树 / 不在 git 里 → null
export function mainWorktreeRoot(repo = REPO) {
  try {
    const common = execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    if (!common || path.basename(common) !== '.git') return null;
    const root = path.dirname(path.resolve(common));
    return path.relative(root, path.resolve(repo)) === '' ? null : root;
  } catch { return null; }
}

export function overlayDir(env = process.env, { repo = REPO } = {}) {
  const dataRoot = env.BRIDGE_DATA_ROOT ? path.resolve(env.BRIDGE_DATA_ROOT) : repo;
  const fromEnv = String(env.BRIDGE_OVERLAY_DIR || '').trim();
  if (fromEnv) return path.resolve(dataRoot, fromEnv);
  const own = configOverlay(dataRoot);
  if (own) return own;
  const main = mainWorktreeRoot(repo);
  return main ? configOverlay(main) : null;
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
        throw new Error('[chatgpt] 没找到 Codex 分页的界面（私有 overlay 的 web/chatgpt/）：环境变量 BRIDGE_OVERLAY_DIR、'
          + '数据根或主工作树 config.json 的 overlayDir 都没指到它。前端只有一套完整版，配好再构建');
      }
      const dir = path.join(outDir, 'chatgpt');
      // 点开头的（overlay 仓库里的 .gitattributes 之类）不进产物，同服务端 overlay-web 的规矩
      cpSync(ov.page, dir, { recursive: true, force: true, filter: (src) => !path.basename(src).startsWith('.') });
      await stampChatgptDir(dir);
      log('[chatgpt] Codex 分页的界面取自 overlay：' + ov.page);
    },
  };
}
