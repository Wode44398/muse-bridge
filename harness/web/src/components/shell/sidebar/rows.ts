// 会话行读写的共享状态与动作（状态由侧栏持有，行只经这个对象读写），以及会话行的左滑手势。
import type { SessionMeta } from "../../../lib/state.svelte.ts";
import { isDragging, type DragPayload } from "../../../lib/dnd.svelte.ts";

export interface SessionRows {
  swiped: string | null; // 手机上左滑开着的那条
  readonly armed: string | null; // 两步删除：已经点过一次、等第二次的那条
  readonly sessMenuOk: boolean;
  pick(id: string): void;
  arm(id: string, e: Event): void;
  del(id: string, e?: Event): Promise<void>;
  openSessMenu(s: SessionMeta, e: MouseEvent, viaCtx: boolean): void;
  sessionDrag(s: { id: string; title?: string; provider?: string; workspace?: string }): { key: string; payload: () => DragPayload; disabled: boolean; onStart: () => void };
  titleOf(s: { title?: string }): string;
}

// ── 手机左滑露出「删除」：同一时刻只开一条；点别处 / 滚动就收 ─────────────────────────
export function createSwipe(rows: SessionRows) {
  return function swipe(node: HTMLElement, id: string) {
    let cur = id;
    let pid = -1;
    let x0 = 0;
    let y0 = 0;
    let decided = false;
    let active = false;
    let base = 0;
    let dx = 0;
    const W = rows.sessMenuOk ? 144 : 72; // 会话管理：左滑露出「更多」+「删除」
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      pid = e.pointerId;
      x0 = e.clientX;
      y0 = e.clientY;
      decided = false;
      active = true;
      base = rows.swiped === cur ? -W : 0;
      dx = base;
    };
    const move = (e: PointerEvent) => {
      if (!active || e.pointerId !== pid) return;
      // 长按已经把这一行拎起来了：左滑让路（拖拽接管这根手指）
      if (isDragging()) {
        active = false;
        return;
      }
      const mx = e.clientX - x0;
      const my = e.clientY - y0;
      if (!decided) {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
        if (Math.abs(my) > Math.abs(mx)) {
          active = false;
          return;
        }
        decided = true;
        node.setPointerCapture?.(pid);
        node.parentElement?.classList.add("revealing");
      }
      let x = base + mx;
      if (x > 0) x = Math.pow(x, 0.6);
      if (x < -W) x = -W - Math.pow(-x - W, 0.6);
      dx = x;
      node.style.transition = "none";
      node.style.transform = `translateX(${x}px)`;
      e.preventDefault();
    };
    const up = (e: PointerEvent) => {
      if (!active || e.pointerId !== pid) return;
      active = false;
      if (!decided) return;
      node.style.transition = "";
      node.style.transform = "";
      rows.swiped = dx < -W * 0.45 ? cur : rows.swiped === cur ? null : rows.swiped;
      if (rows.swiped !== cur) node.parentElement?.classList.remove("revealing");
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
    return {
      update(next: string) {
        cur = next;
      },
      destroy() {
        node.removeEventListener("pointerdown", down);
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", up);
      },
    };
  }
}
