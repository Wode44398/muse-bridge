// 全局返回层级拦截（浏览器返回 / 手机侧滑返回 → 逐级关层，永不误离开页面）。
//
// 做法：垫「哨兵」history entry，系统返回消费哨兵触发 popstate，popstate 里关层再补回哨兵。
//
// 层级模型（从顶到底）：
//   转场播放中 → 吞掉返回，动画不被打断
//   瞬态层栈 pushBackLayer（灯箱/弹出菜单等「开着才挂载」的组件，后开先关）
//   沉浸查看器 preview > 设置 > 登录 > 定时 > claude 抽屉
//   dimensio 分页自带的层级（sheet / 抽屉 / 预览，window.__harnessBack）
//   非根 screen（files / harness / claude 各自分派带动画的 closer）
//   主页根 → 原地不动；单 agent 模式的根页（rootScreen）同理
//
// 关键好处：不改各组件现有的 UI 关闭逻辑（返回按钮/手势照旧直接关），只在这里集中拦系统返回。
// 带关闭动画的层（设置页收场、claude 整页收回入口）由组件用 registerCloser 注册其带动画的关闭
// 函数；其余层直接置 false（关闭动画走各自 CSS/transition）。
import { ui, rootScreen } from './state.svelte.js';
import { preview, closePreview } from './preview.svelte.js';
import { closePage } from './pageMorph.js';

const closers = {};
// 组件注册带动画的关闭函数；返回反注册器（配合 $effect 的 cleanup 使用）。
export function registerCloser(key, fn) {
  closers[key] = fn;
  return () => { if (closers[key] === fn) delete closers[key]; };
}

// —— 瞬态层栈：灯箱/弹出菜单这类「开着才挂载」的浮层，一行接入系统返回 ——
// 组件在 $effect 里 push 自己的关闭函数（卸载时 cleanup 自动弹出）；返回时后开先关。
//   $effect(() => pushBackLayer(onClose));
const layerStack = [];
export function pushBackLayer(fn) {
  layerStack.push(fn);
  return () => { const i = layerStack.indexOf(fn); if (i >= 0) layerStack.splice(i, 1); };
}

// 关闭当前最顶层。返回 true=消费了这次返回；false=已在最底(根页)无层可关。顺序＝从最上层到最下层。
function closeTopLayer() {
  // 页面转场播放中：吞掉返回（<1s 的动画，不打断演出）。
  if (ui.morphing) return true;
  // 瞬态层（灯箱/弹出菜单）：最新打开的视为最顶，先关它。
  const top = layerStack[layerStack.length - 1];
  if (top) { try { top(); } catch {} return true; }
  // 沉浸式文件查看器盖在一切之上——系统返回最先关它。
  if (preview.open) { closePreview(); return true; }
  // 任务详情（Agent 子转录 / Workflow 阶段面板）住在右侧工作台里，工作台自己注册返回层（ClaudeDock）。
  if (ui.settingsOpen) { closers.settings ? closers.settings() : (ui.settingsOpen = false); return true; }
  if (ui.loginOpen) { ui.loginOpen = false; return true; }
  if (ui.routinesOpen) { closers.routines ? closers.routines() : (ui.routinesOpen = false); return true; }
  if (ui.drawerOpen) { ui.drawerOpen = false; return true; }
  // dimensio 分页自带完整层级返回（整页/灯箱/sheet/预览/抽屉）：先让它关自己的层——
  // 单 agent 模式下它就是根页，也得先关掉它的抽屉与弹层，才轮到「到底了」。
  if (ui.screen === 'harness') {
    try { if (window.__harnessBack && window.__harnessBack()) return true; } catch {}
  }
  // 单 agent 模式：根页就是「主页」——到这儿无层可关
  if (ui.screen !== rootScreen()) {
    // 按当前分页分派各自的返回逻辑；回主页一律走 closePage：这一页收回它在主页上的入口（lib/pageMorph.js）。
    if (ui.screen === 'files') { closers.files ? closers.files() : closePage('files'); return true; }
    if (ui.screen === 'claude') { closers.claudeSlide ? closers.claudeSlide() : closePage('claude'); return true; }
    closePage(ui.screen); return true;
  }
  return false;
}

let inited = false;
export function initNav() {
  if (inited || typeof window === 'undefined') return;
  inited = true;
  // 垫哨兵，之后任意系统返回都先落到这次 pushState 上、被 popstate 拦截。
  try { history.pushState({ navSentinel: 1 }, ''); } catch {}
  window.addEventListener('popstate', () => {
    closeTopLayer();
    // 补回哨兵——下次系统返回仍被拦，永不直接离开页面。
    try { history.pushState({ navSentinel: 1 }, ''); } catch {}
  });
}
