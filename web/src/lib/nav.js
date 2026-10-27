// 全局返回层级拦截（安卓侧滑/返回键 → 逐级关层，永不误退 app）。
//
// 双通道：
//   ① apk 原生通道（主路径，无竞态）：MainActivity.onBackPressed() 总是拦下系统返回，
//      evaluateJavascript 调 window.__bridgeBack()——JS 关掉当前最顶层返回 true；已在主页
//      无层可关返回 false，原生 moveTaskToBack(true) 退后台（不杀进程，回来秒续）。
//      旧方案靠 WebView history 哨兵：连续快速侧滑时哨兵被消费、popstate 补哨兵还没跑完，
//      原生 canGoBack() 已是 false → 直接退出 app。原生通道不再依赖 history，竞态根除。
//   ② 浏览器通道（网页版兜底）：垫「哨兵」history entry，系统返回消费哨兵触发 popstate，
//      popstate 里关层再补回哨兵。浏览器拿不到返回事件只能如此；apk 里原生总是拦截，
//      WebView 收不到返回键，此通道自然休眠（哨兵无害）。
//
// 层级模型（从顶到底）：
//   转场播放中（入场/主题）→ 吞掉返回，动画不被打断
//   瞬态层栈 pushBackLayer（灯箱/弹出菜单等「开着才挂载」的组件，后开先关）
//   沉浸查看器 preview > 助手浮层 > 任务详情抽屉(TaskSheet) > 设置 > 登录 > 定时 > claude 抽屉
//   dimensio 分页自带的层级（sheet / 抽屉 / 灯箱 / 预览，window.__harnessBack；它当根页时也要先关这些）
//   非主页 screen（files/antigravity/vertex/claude 各自分派带动画的 closer）
//   主页根 → false（原生退后台；浏览器原地不动）；单 agent 模式的根页（rootScreen）同理
//
// 关键好处：不改各组件现有的 UI 关闭逻辑（返回按钮/手势照旧直接关），只在这里集中拦系统返回。
// 带关闭动画的层（设置页的「模糊→清晰」收场、claude/vertex 整页右滑出）由组件用 registerCloser
// 注册其带动画的关闭函数；其余层直接置 false（关闭动画走各自 CSS/transition）。
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

// 关闭当前最顶层。返回 true=消费了这次返回；false=已在最底(主页)无层可关。顺序＝从最上层到最下层。
function closeTopLayer() {
  // 页面转场 / 主题换场播放中：吞掉返回（<1s 的动画，不让侧滑把 app 切后台打断演出）。
  if (ui.morphing || ui.enterClaude || ui.enterVertex || ui.themeTransition) return true;
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
  // harness 分页自带完整层级返回（ds 整页/灯箱/sheet/预览/抽屉→切换页→onExit 回主页）。单 agent 模式下
  // 它就是根页（没传 onExit），也得先关掉它自己的层，到底了才轮到下面「无层可关」。
  const hxPage = ui.screen === 'harness' || ui.screen === 'antigravity';
  if (hxPage) {
    try { if (window.__harnessBack && window.__harnessBack()) return true; } catch {}
  }
  // 单 agent 模式：根页就是「主页」——到这儿无层可关，交给原生退后台
  if (ui.screen !== rootScreen()) {
    // 按当前分页分派各自的返回逻辑（此前 files/antigravity 也被派去 claudeSlide——
    // 隐藏的 ClaudePage 播滑出动画、工作空间的面包屑逐级返回被跳过）。
    // 回主页一律走 closePage：这一页收回它在主页上的入口（lib/pageMorph.js）。
    if (ui.screen === 'files') { closers.files ? closers.files() : closePage('files'); return true; }
    if (hxPage) { closePage(ui.screen); return true; }   // 它自己的层（含 onExit）上面已经问过了
    if (ui.screen === 'vertex') { closers.vertexSlide ? closers.vertexSlide() : closePage('vertex'); return true; }
    if (ui.screen === 'claude') { closers.claudeSlide ? closers.claudeSlide() : closePage('claude'); return true; }
    closePage(ui.screen); return true;   // ChatGPT、ComingSoon 等占位分页
  }
  return false;
}

let inited = false;
export function initNav() {
  if (inited || typeof window === 'undefined') return;
  inited = true;
  // ① 原生通道入口：apk 壳 onBackPressed 调它。true=JS 消费；false=原生退后台。
  window.__bridgeBack = () => { try { return !!closeTopLayer(); } catch { return false; } };
  // ② 浏览器通道：垫哨兵，之后任意系统返回都先落到这次 pushState 上、被 popstate 拦截。
  try { history.pushState({ navSentinel: 1 }, ''); } catch {}
  window.addEventListener('popstate', () => {
    closeTopLayer();
    // 补回哨兵——下次系统返回仍被拦，永不直接退出页面。
    try { history.pushState({ navSentinel: 1 }, ''); } catch {}
  });
}
