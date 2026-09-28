// 「按着的那一项」（会滑的选中块用：按下就先滑过去，见 lib/slide.ts）。
//  · 松手不管松在哪都算（被下拉关闭、拖拽抢了指针捕获，按钮自己收不到 pointerup）：之后 400ms 没等来 click
//    （手指滑走了、被拖走了）就清掉；等来了 click 由调用方 settle()。
//  · 被浏览器拿去滚动（pointercancel）立刻清；鼠标移出按钮立刻清。
//  · 触屏上 pointerleave 在 pointerup 之后、click 之前——不能拿它清，块会往回闪一下。
export function pressHold<T>(set: (v: T | null) => void, get: () => T | null) {
  let timer = 0;
  let unlisten: (() => void) | null = null;
  const stop = () => {
    unlisten?.();
    unlisten = null;
  };
  return {
    down(v: T) {
      clearTimeout(timer);
      stop();
      set(v);
      const end = (e: PointerEvent) => {
        stop();
        if (e.type === "pointercancel") {
          if (get() === v) set(null);
          return;
        }
        timer = window.setTimeout(() => {
          if (get() === v) set(null);
        }, 400);
      };
      window.addEventListener("pointerup", end, true);
      window.addEventListener("pointercancel", end, true);
      unlisten = () => {
        window.removeEventListener("pointerup", end, true);
        window.removeEventListener("pointercancel", end, true);
      };
    },
    leave(e: PointerEvent) {
      if (e.pointerType === "mouse") set(null);
    },
    settle() {
      clearTimeout(timer);
      stop();
      set(null);
    },
  };
}
