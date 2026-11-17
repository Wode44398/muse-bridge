// 文字换内容时的过渡（官方 /code 页工具组头 / 工具行同款：新文字 180ms 从下方 3px 浮上来、淡入；第一次挂载不动）。
// 只动 transform / opacity；减弱动态效果时不动。key 变了才播——同一句话里数字在走（计时）不算换内容。
//   <span use:morphText={key}>…</span>
//
// reveal：首次展开后保持挂载、只切 hidden 的区块（工具组展开卡、工具行详情、思考正文）——
// 收着时 display:none，展开那一下没有 Svelte 过渡可用，这里补一个淡入下落。
import { reducedMotion } from "./motion.ts";

// WAAPI 不解析 CSS 变量：这里就是 --ease-out 的值
const EASE_OUT = "cubic-bezier(.16,1,.3,1)";

export function morphText(node: HTMLElement, key: unknown) {
  let last = key;
  return {
    update(next: unknown) {
      if (next === last) return;
      last = next;
      if (reducedMotion() || typeof node.animate !== "function") return;
      node.animate([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: EASE_OUT });
    },
  };
}

export function reveal(node: HTMLElement, open: boolean) {
  let was = open;
  const play = () => {
    if (reducedMotion() || typeof node.animate !== "function") return;
    node.animate([{ opacity: 0, transform: "translateY(-3px)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: EASE_OUT });
  };
  // 第一次展开时区块才挂上：挂上那一刻就是展开
  if (open) play();
  return {
    update(next: boolean) {
      if (next === was) return;
      was = next;
      if (next) play();
    },
  };
}
