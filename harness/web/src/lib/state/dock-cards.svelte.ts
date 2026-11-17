// 宽屏工作区的卡片：开着哪几张、两列各怎么排、卡片高度比例、哪张放大、刚聚焦了哪张。
// 一起存一份 localStorage（harness.dockCards），收起再展开、刷新页面都还是原样。
// 手机 / 窄屏一次一张，只认 app.dockTool，不读这里。
import { WIDE_MQ } from "../breakpoints.ts";
import { DEFAULT_COLS, normCols, normOpen, normWeights, type CardTool, type Cols, type Weights } from "../dock-cards.ts";

export const DOCK_CARDS_KEY = "harness.dockCards";

function read(): { open: CardTool[]; cols: Cols; weights: Weights } {
  try {
    const raw = JSON.parse(localStorage.getItem(DOCK_CARDS_KEY) ?? "null");
    if (raw && typeof raw === "object") return { open: normOpen(raw.open), cols: normCols(raw.cols), weights: normWeights(raw.weights) };
  } catch {
    /* 坏值按默认 */
  }
  return { open: [], cols: normCols(DEFAULT_COLS), weights: {} };
}

const init = read();
export const dockCards = $state({
  open: init.open, // 按打开先后
  cols: init.cols,
  weights: init.weights,
  max: "" as CardTool | "", // 放大铺满整栏的那张
  // 已经开着的卡被别处点名（预览、任务定位、快捷键）：seq 递增，卡片据此闪一下
  focus: null as null | { tool: CardTool; seq: number },
});

export function saveDockCards() {
  try {
    localStorage.setItem(DOCK_CARDS_KEY, JSON.stringify({ open: dockCards.open, cols: dockCards.cols, weights: dockCards.weights }));
  } catch {
    /* 存不下就只在本次有效 */
  }
}

// 多卡只给宽屏（与 App 的分栏门槛同一条线）
export function dockMulti(): boolean {
  return typeof matchMedia === "function" && matchMedia(WIDE_MQ).matches;
}
