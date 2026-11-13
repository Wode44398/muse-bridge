// 功能扩展（Media Studio / Codex / dimensio）的前端懒加载入口。
//
// 核心（App 与各共用组件）不许静态 import 扩展的页面与控制器——静态 import 会把扩展代码编进主包，
// 基础版就剥不干净。一律经这里的动态 import 进来：构建时各自成独立 chunk，
// web/scripts/module-chunks.mjs 据入口文件把它们归到对应扩展（bridge-modules.json）。
// 同一个 promise 复用：keep-alive 挂载闩、预挂载、转场各处调用只真加载一次。

import { isEn, addDict } from '../lib/i18n.js';

const cache = {};
const once = (key, load) => () => (cache[key] ||= load());

// 设置 › Media Studio 的正文由 studio-settings 那边维护；用 glob 引，文件还没进来时这里只是空表，
// 构建照常过（不会因为缺文件把整个主包拖垮）。核心的 Settings 页只经 loadPage.studioSettings 取它。
const studioSettingsMods = import.meta.glob('../components/studio/settings/StudioSettings.svelte');
// 模型中心（核心）的「媒体去向」要打开 Studio 的媒体服务面板（<MediaProviderManager onClose initial={{ view: 'edit', id }} />）：
// 同样只经这里取，没装 studio 扩展的构建里就是空表、调用方收到 reject 自己降级（方案 §3.8）。
const studioProvidersMods = import.meta.glob('../components/studio/settings/MediaProviderManager.svelte');
const missing = (what) => Promise.reject(new Error(what + ' is not in this build'));

export const loadPage = {
  chatgpt: once('chatgpt', () => import('../components/ChatGPTPage.svelte')),
  studio: once('studio', () => import('../components/studio/StudioPage.svelte')),
  studioSettings: once('studioSettings', () => {
    const load = Object.values(studioSettingsMods)[0];
    return load ? load() : missing('StudioSettings.svelte');
  }),
  studioProviders: once('studioProviders', () => {
    const load = Object.values(studioProvidersMods)[0];
    return load ? load() : missing('MediaProviderManager.svelte');
  }),
  // dimensio 的英文字典随页面一起来（它的组件 t() 读同一份全局字典），渲染前就并好。
  harness: once('harness', async () => {
    const [page, dict] = await Promise.all([
      import('../components/HarnessPage.svelte'),
      isEn() ? import('@hx/i18n/en/index.ts').catch(() => null) : null,
    ]);
    if (dict?.default) addDict(dict.default);
    return page;
  }),
  // 工作台「记忆」卡里点开的一条 dimensio 记忆：它引 dimensio 的文案与翻译层，归 dimensio 扩展
  dimensioMemoryNote: once('dimensioMemoryNote', () => import('../components/dock/DimensioMemoryNote.svelte')),
};
