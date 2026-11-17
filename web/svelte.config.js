import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// 两套设置页的整套样式（components/settings/ios/kit.css、desktop/settings/kit.css）由各自的外壳与分区组件 @import 进自己的 <style>
// （vitePreprocess 编译前内联，每个组件得到带自己作用域的一份）。每个组件只用到其中一部分，其余的 Svelte 报「没用到的选择器」并剪掉——
// 剪掉是要的，报出来只是噪音。只滤这两份文件里写着的选择器，而且只在 @import 了它们的组件里滤，别处的照报。
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const KITS = ['src/components/settings/ios/kit.css', 'src/desktop/settings/kit.css'];
let kitSelectors = null;
function selectorsOfKits() {
  if (kitSelectors) return kitSelectors;
  kitSelectors = new Set();
  for (const rel of KITS) {
    let css = '';
    try { css = readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{/g)) {
      const head = m[1].trim();
      if (!head || head.startsWith('@')) continue;
      for (const sel of head.split(',')) kitSelectors.add(sel.replace(/\s+/g, ' ').trim());
    }
  }
  return kitSelectors;
}
const importsKit = new Map();
function fromKit(w) {
  if (w.code !== 'css_unused_selector' || !w.filename) return false;
  const file = path.resolve(ROOT, w.filename);
  if (!importsKit.has(file)) {
    let src = '';
    try { src = readFileSync(file, 'utf8'); } catch {}
    importsKit.set(file, /@import\s+['"][^'"]*kit\.css['"]/.test(src));
  }
  if (!importsKit.get(file)) return false;
  const m = /Unused CSS selector "([\s\S]*?)"/.exec(w.message || '');
  return !!m && selectorsOfKits().has(m[1].replace(/\s+/g, ' ').trim());
}

export default {
  preprocess: vitePreprocess(),
  onwarn(warning, defaultHandler) {
    if (fromKit(warning)) return;
    defaultHandler(warning);
  },
};
