// 「宽」= 侧栏 | 对话 | 工作区 分栏形态的门槛，与 bridge 本体 web/src/lib/layout.svelte.js 同口径：
// 宽度 ≥ 700；或宽度 ≥ 600 且【屏幕】宽高比 ≥ 0.7（近方屏 = 折叠屏内屏）。
// 有的折叠屏展开后 CSS 宽不到 700（系统缩放调大一档 dpr 就到 3.3+，Z Fold 内屏只剩 ~650；
// OPPO Find N 系出厂 ~683）。device-aspect-ratio 看的是 screen，不受 adjustResize 弹键盘
// 压矮 innerHeight 的影响——竖屏 7 寸平板（600×960）打字时不会被误判。
// CSS 里没法 import，照抄这两条字面量（搜 device-aspect-ratio 能全找到）。
export const WIDE_MQ = "(min-width: 700px), (min-width: 600px) and (min-device-aspect-ratio: 7/10)";
export const NARROW_MQ = "(max-width: 599px), (max-width: 699px) and (max-device-aspect-ratio: 699/1000)";
