// 侧边工作区（侧列形态）的宽度规则：四个分页（Claude / Codex / Antigravity / dimensio）同一套。
// 外壳 Workbench 自己管宽度时用它；dimensio 的宽度归它自己的 App 管，也照这里的数抄一份
// （harness/web/src/App.svelte 的分栏把手，改这里要同步改那边）。
//
// 「这一行」= 工作区所在的那一横排：对话 + 工作区，外加 aside（这一行里别的常驻列，例如 Codex 的线程列表）。
// 左侧栏不在这一行里的分页（Claude / Antigravity）aside = 0。

// 给对话留的最窄宽度：折叠屏展开 / 竖屏平板（medium）横向本就紧，留 300；桌面留 360
export const chatMin = (mid) => (mid ? 300 : 360);
// 工作区自己的最窄宽度：一列 = medium 300 / 桌面 360；两列 = 每列至少 ~276
export const dockMin = (two, mid) => (two ? 560 : mid ? 300 : 360);
// 摆得下两列：这一行扣掉 aside 还有 ≥ 1020（两列 560 + 对话 360 + 缝与余量）
export const TWO_ROW_MIN = 1020;
export const twoFits = (hostW, aside = 0) => hostW - aside >= TWO_ROW_MIN;

// 左缘把手拖动时的上下限（px）。reserve = 这一行里要留给别人的宽度（aside + 对话下限）；
// overlay（分屏的窄格里盖在正文上）只给正文露 48px 的边。
export function dragBounds({ hostW, two = false, mid = false, overlay = false, reserve = 0 }) {
  const lo = overlay ? 360 : dockMin(two, mid);
  const hi = overlay ? hostW - 48 : hostW - reserve;
  return { lo, hi: Math.max(lo, hi) };
}
