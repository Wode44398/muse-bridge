// 核心经这里拿功能扩展的前端控制器，而不是静态 import——
// 静态 import 会把扩展代码编进主包，基础版就剥不干净。
//
//   ensureModule(agent) → Promise<模块 | null>：这个 agent 开着才动态加载（同一个 promise 复用）；
//                         没开 / 没装一律 null，绝不去取不存在的 chunk——取不到会触发 vite:preloadError，
//                         staleGuard 会当成「构建漂移」整页刷新。
//   mods[agent]        已加载的模块（响应式，$derived 里读得到加载完成）；没加载是 null。
//   onModule(agent, fn) 模块加载后回调一次（已加载则立即），给需要订阅扩展事件的核心代码用。

import { agentOn } from '../lib/state.svelte.js';

// 2026-11-04 起 Gemini 对话下线，原来唯一的一项（gemini → modules/vertex/api.js）随之删除；Media Studio 的页面走
// pages.js 的 loadPage.studio，核心给它的东西经 lib/state.svelte.js 的 studioInbox 传，不需要控制器。机制留着给以后的扩展。
const LOADERS = {};

export const mods = $state({});

const pending = {};
const hooks = {};

export function onModule(agent, fn) {
  if (mods[agent]) { try { fn(mods[agent]); } catch {} return; }
  (hooks[agent] ||= []).push(fn);
}

export function ensureModule(agent) {
  if (mods[agent]) return Promise.resolve(mods[agent]);
  if (!LOADERS[agent] || !agentOn(agent)) return Promise.resolve(null);
  return (pending[agent] ||= LOADERS[agent]().then((m) => {
    mods[agent] = m;
    for (const fn of (hooks[agent] || []).splice(0)) { try { fn(m); } catch {} }
    return m;
  }).catch((e) => {
    delete pending[agent];
    console.warn('[modules] ' + agent + ' 前端加载失败', e);
    return null;
  }));
}
