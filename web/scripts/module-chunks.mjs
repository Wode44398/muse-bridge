// 构建插件：把产物按「核心 / 各功能扩展」归属，写进 <outDir>/bridge-modules.json。
//
// 功能扩展（Vertex / Codex / dimensio）的前端都从一个【懒加载入口】进来（MODULE_ENTRIES）。
// 归属规则只看 chunk 图：
//   核心 = 从 html 入口出发、沿静态 / 动态 import 能走到、但【不穿过任何扩展入口】的 chunk；
//   扩展 X = 从 X 的入口出发能走到、且不在核心里的 chunk（几个扩展共用的 chunk 各算一份）。
// CSS 跟着引用它的 chunk 走；CSS 里 url() 引到的字体 / 图片跟着那份 CSS 走；public/ 里原样拷贝的
// 目录按 MODULE_PUBLIC_DIRS 归属。没被任何 chunk 认领的产物一律算核心（宁可多带，不能漏带）。
//
// 用处：① 验收——核心里不该再出现扩展的源码（扩展源码混进核心 = 有核心文件还在静态 import 它，
//   清单的 leaks 一栏列出来）；② 模块化 P4 打包——基础版排除扩展文件，各扩展的离线包按清单收。

import path from 'node:path';

// 扩展的前端入口（相对 web/）。
export const MODULE_ENTRIES = {
  vertex: ['src/components/VertexPage.svelte', 'src/modules/vertex/api.js'],
  codex: ['src/components/ChatGPTPage.svelte'],
  dimensio: ['src/components/HarnessPage.svelte', '../harness/web/src/i18n/en/index.ts'],
};

// public/ 下原样拷贝、属于某个扩展的目录。
export const MODULE_PUBLIC_DIRS = { codex: ['chatgpt'] };

// 判「扩展源码漏进核心」用的路径特征（相对 web/，正斜杠）。只用于报告，不影响归属。
const MODULE_SOURCES = {
  vertex: [/^src\/components\/(VertexPage|VImagePanel|VVideoPanel|VVoicePanel|VMusicPanel|VMaterialPicker|VAttachMenu|VParamDropdown|GeminiSparkle|LocalImageSettings|LocalImageDeployment)\.svelte$/, /^src\/components\/neo\//, /^src\/gemini\//, /^src\/lib\/(vertex\.svelte|vertexMedia\.svelte|neoUi|neoSheet)\.js$/, /^src\/modules\/vertex\//],
  codex: [/^src\/components\/ChatGPTPage\.svelte$/, /^src\/components\/dock\/CodexWorkspace\.svelte$/],
  dimensio: [/^src\/components\/HarnessPage\.svelte$/, /^src\/components\/dock\/HxFilesEmbed\.svelte$/, /^\.\.\/harness\/web\/src\//],
};

export function bridgeModuleChunks({ webRoot }) {
  const rel = (id) => path.relative(webRoot, String(id).split('?')[0]).split(path.sep).join('/');
  return {
    name: 'bridge-module-chunks',
    apply: 'build',
    async generateBundle(_opts, bundle) {
      const chunks = Object.values(bundle).filter((o) => o.type === 'chunk');
      const byFile = new Map(chunks.map((c) => [c.fileName, c]));
      const entryOf = new Map();   // chunk fileName -> 扩展 id（扩展入口 chunk）
      for (const c of chunks) {
        if (!c.facadeModuleId) continue;
        const r = rel(c.facadeModuleId);
        for (const [id, list] of Object.entries(MODULE_ENTRIES)) if (list.includes(r)) entryOf.set(c.fileName, id);
      }
      const walk = (starts, stop) => {
        const seen = new Set();
        const stack = [...starts];
        while (stack.length) {
          const f = stack.pop();
          if (seen.has(f) || stop(f)) continue;
          seen.add(f);
          const c = byFile.get(f);
          if (c) for (const n of [...(c.imports || []), ...(c.dynamicImports || [])]) stack.push(n);
        }
        return seen;
      };
      const core = walk(chunks.filter((c) => c.isEntry).map((c) => c.fileName), (f) => entryOf.has(f));
      const mods = {};
      for (const id of Object.keys(MODULE_ENTRIES)) {
        const starts = [...entryOf].filter(([, m]) => m === id).map(([f]) => f);
        // 走到别的扩展的入口就停（某扩展懒加载另一个扩展时，后者的 chunk 归后者，不重复算进前者）
        mods[id] = [...walk(starts, (f) => core.has(f) || (entryOf.has(f) && entryOf.get(f) !== id))];
      }
      // CSS 跟 chunk；字体 / 图片跟 CSS
      const cssOf = (f) => [...(byFile.get(f)?.viteMetadata?.importedCss || [])];
      const assetsOf = (f) => [...(byFile.get(f)?.viteMetadata?.importedAssets || [])];
      const cssRefs = (cssFile) => {
        const o = bundle[cssFile];
        const src = o && o.type === 'asset' ? String(o.source) : '';
        const out = [];
        for (const m of src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
          const name = m[1].split('?')[0].split('#')[0].split('/').pop();
          const hit = Object.keys(bundle).find((k) => k.split('/').pop() === name);
          if (hit) out.push(hit);
        }
        return out;
      };
      const expand = (files) => {
        const set = new Set(files);
        for (const f of files) {
          for (const a of assetsOf(f)) set.add(a);
          for (const css of cssOf(f)) { set.add(css); for (const a of cssRefs(css)) set.add(a); }
        }
        return set;
      };
      const coreFiles = expand([...core]);
      const modules = {};
      for (const [id, files] of Object.entries(mods)) {
        modules[id] = { files: [...expand(files)].filter((f) => !coreFiles.has(f)).sort(), publicDirs: MODULE_PUBLIC_DIRS[id] || [] };
      }
      // 漏报：扩展的源码出现在核心 chunk 里
      const leaks = {};
      for (const f of core) {
        for (const mid of byFile.get(f)?.moduleIds || []) {
          const r = rel(mid);
          for (const [id, pats] of Object.entries(MODULE_SOURCES)) {
            if (pats.some((p) => p.test(r))) (leaks[id] ||= new Set()).add(r);
          }
        }
      }
      const report = {
        generated: new Date().toISOString(),
        modules,
        leaks: Object.fromEntries(Object.entries(leaks).map(([k, v]) => [k, [...v].sort()])),
      };
      this.emitFile({ type: 'asset', fileName: 'bridge-modules.json', source: JSON.stringify(report, null, 2) });
      const n = Object.values(report.leaks).reduce((a, v) => a + v.length, 0);
      const summary = Object.entries(modules).map(([id, m]) => id + ' ' + m.files.length).join(' / ');
      this.info?.('[bridge-module-chunks] 扩展文件：' + summary + (n ? '；⚠ 核心里混着 ' + n + ' 个扩展源码，见 bridge-modules.json leaks' : '；核心里无扩展源码'));
    },
  };
}
