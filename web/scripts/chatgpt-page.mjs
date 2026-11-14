// Codex 分页的界面（ChatGPT 页面）是原版资源，放在 web/public/chatgpt/：vite 照常随 public 拷进产物的 chatgpt/，
// dev 下直接发 /chatgpt/*。本插件只在构建结束时给产物里的 index.html 引用的同目录脚本 / 样式打内容哈希
// （改了就换地址，CDN 缓存跟着失效）；产物里没有这套页面就让构建失败——前端只有一套完整版。
// 滑杆运行时 work-picker.runtime.js 由构建前步骤 build-work-picker.mjs 重新打包进 web/public/chatgpt/。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

export function chatgptPage({ log = console.log } = {}) {
  let outDir = '';
  return {
    name: 'bridge-chatgpt-page',
    apply: 'build',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    async closeBundle() {
      const dir = path.join(outDir, 'chatgpt');
      if (!existsSync(path.join(dir, 'index.html'))) {
        throw new Error('[chatgpt] 产物里没有 chatgpt/index.html：web/public/chatgpt/ 缺了 Codex 分页的界面。前端只有一套完整版');
      }
      await stampChatgptDir(dir);
      log('[chatgpt] Codex 分页的界面已打内容哈希：' + dir);
    },
  };
}
