// 功能扩展（Vertex / Codex / dimensio）的前端懒加载入口。
//
// 核心（App 与各共用组件）不许静态 import 扩展的页面与控制器——静态 import 会把扩展代码编进主包，
// 基础版就剥不干净。一律经这里的动态 import 进来：构建时各自成独立 chunk，
// web/scripts/module-chunks.mjs 据入口文件把它们归到对应扩展（bridge-modules.json）。
// 同一个 promise 复用：keep-alive 挂载闩、预挂载、转场各处调用只真加载一次。

import { isEn, addDict } from '../lib/i18n.js';

const cache = {};
const once = (key, load) => () => (cache[key] ||= load());

export const loadPage = {
  vertex: once('vertex', () => import('../components/VertexPage.svelte')),
  chatgpt: once('chatgpt', () => import('../components/ChatGPTPage.svelte')),
  // dimensio 的英文字典随页面一起来（它的组件 t() 读同一份全局字典），渲染前就并好。
  harness: once('harness', async () => {
    const [page, dict] = await Promise.all([
      import('../components/HarnessPage.svelte'),
      isEn() ? import('@hx/i18n/en/index.ts').catch(() => null) : null,
    ]);
    if (dict?.default) addDict(dict.default);
    return page;
  }),
};
