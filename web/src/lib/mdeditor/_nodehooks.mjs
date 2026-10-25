// node --test 专用的模块加载钩子（mdeditor.test.js 里 register）：让 Node 能直接 import 编辑器源码。
//   *.css → 空模块；*.svelte.js → 桩（mdState 等 rune 模块 Node 里跑不了）；
//   dompurify → 桩（Node 没有 DOM，它的 addHook/sanitize 不可用；状态层测试也用不到净化）
// 只在单测里用，应用代码不 import 它（vite 不会打进包）。
const STUB = 'bridge-test-stub:';
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css')) return { url: STUB + 'css', shortCircuit: true };
  if (specifier.endsWith('.svelte.js')) return { url: STUB + 'svelte', shortCircuit: true };
  if (specifier === 'dompurify') return { url: STUB + 'dompurify', shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url === STUB + 'css') return { format: 'module', source: 'export default {};', shortCircuit: true };
  if (url === STUB + 'svelte') return { format: 'module', source: 'export const mdState = { epoch: 0 }; export const preview = {}; export default {};', shortCircuit: true };
  if (url === STUB + 'dompurify') {
    return { format: 'module', source: 'export default { addHook() {}, removeHook() {}, sanitize: (s) => String(s), isSupported: false };', shortCircuit: true };
  }
  return next(url, context);
}
