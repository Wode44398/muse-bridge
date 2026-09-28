// 视口形态的【单一来源】——各分页别再各自写 matchMedia('(min-width: 1024px)')。
//
// 起因：折叠屏展开态实测 ~752×835 CSS px（大内屏 dpr 3），卡在 1024 之下，
// 于是整台大屏仍按手机版渲染：侧栏是抽屉、工作台是底部 sheet，浪费了一半横向空间。
// 现在分三档：
//   compact  < 700   真手机（含折叠屏【折叠态】外屏）
//   medium   700–1099 折叠屏展开 / 小平板 —— 侧栏与工作台都能以【侧列】形态存在，
//                    但塞不下两根：谁在场由 side-yield 规则决定（见下）
//   expanded ≥ 1100  桌面/大平板 —— 侧栏常驻 + 工作台并排，同时在场
//
// 1100 而非 1024：1024 上两栏并排后正文只剩 ~370px，比 medium 单栏还挤。
// 竖屏平板（如 iPad 768×1024）落在 medium，行为与折叠屏展开一致。
//
// 用法：`import { layout } from './layout.svelte.js'` 后直接读 layout.side / layout.expanded，
// 它是 $state，模板里用即响应。SSR/无 window 环境给一份保守默认值（compact）。

const MEDIUM_MIN = 700;
const EXPANDED_MIN = 1100;

function read() {
  if (typeof window === 'undefined') return { w: 390, h: 844 };
  return { w: window.innerWidth || 390, h: window.innerHeight || 844 };
}

const init = read();

export const layout = $state({
  w: init.w,
  h: init.h,
  // 派生位一并存进对象（而不是 $derived 导出）：$derived 只能在组件/effect 作用域里创建，
  // 这里是模块顶层。改一处 sync() 全站同步，读起来也直白。
  compact: init.w < MEDIUM_MIN,
  medium: init.w >= MEDIUM_MIN && init.w < EXPANDED_MIN,
  expanded: init.w >= EXPANDED_MIN,
  // side = 能不能用「侧列」形态摆侧栏/工作台（medium 与 expanded 都能）。
  // 各分页判断「工作台是侧列还是底部 sheet」用它，别再用 expanded。
  side: init.w >= MEDIUM_MIN,
});

function sync() {
  const { w, h } = read();
  layout.w = w;
  layout.h = h;
  layout.compact = w < MEDIUM_MIN;
  layout.medium = w >= MEDIUM_MIN && w < EXPANDED_MIN;
  layout.expanded = w >= EXPANDED_MIN;
  layout.side = w >= MEDIUM_MIN;
}

if (typeof window !== 'undefined') {
  // resize 一个就够：折叠屏展开/合上、分屏拖动、旋转都会触发它，
  // 且 matchMedia 在某些 WebView 里对「折叠瞬间」的补帧不如 resize 及时。
  window.addEventListener('resize', sync);
  // 折叠动作期间 innerWidth 会连续变几帧，orientationchange 后再对一次账。
  window.addEventListener('orientationchange', () => setTimeout(sync, 60));
  sync();
}

// —— 指针精度（电脑 vs 触屏）——
// 断点只说「有多宽」，说不了「用什么指」。工作空间在这两者下本来就是两套东西：
// 鼠标/触控板 = Explorer 级密度 + 右键 + 键盘（FilesDesktop）；手指 = iOS 文件 app（FilesPanel）。
// 折叠屏展开是 700+ 的"宽"，但仍然是手指，所以宽度判断必须配上这个才不会选错。
export const pointer = $state({
  fine: typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(hover: hover) and (pointer: fine)').matches
    : false,
});
if (typeof window !== 'undefined' && window.matchMedia) {
  // 外接鼠标插拔 / 平板接键盘保护套都会翻这个媒体查询，跟着变即可。
  const mq = window.matchMedia('(hover: hover) and (pointer: fine)');
  const onChange = () => { pointer.fine = mq.matches; };
  mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
}

// —— 侧列让位（medium 档专用）——
// medium 只塞得下【一根】侧列：侧栏常驻 + 工作台并排会把正文压到 ~150px。
// 于是：工作台一开 → 侧栏自动收起并记下「本来是常驻的」；工作台一关 → 侧栏自己回来。
// expanded 档两根并存，不走这套。各分页把自己的 pinned 存取函数注册进来即可复用。
export function makeSideYield(getPinned, setPinned) {
  let stashed = false;
  return {
    // 工作台开合时调用：open=true 收起侧栏（记账）、false 还原。
    apply(dockOpen) {
      if (!layout.medium) { stashed = false; return; }
      if (dockOpen) {
        if (getPinned()) { stashed = true; setPinned(false); }
      } else if (stashed) {
        stashed = false;
        setPinned(true);
      }
    },
    // 用户在工作台开着时手动点了常驻：那就是他要侧栏、不要还原了。
    forget() { stashed = false; },
  };
}
