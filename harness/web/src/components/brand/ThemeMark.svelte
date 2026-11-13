<script lang="ts">
  // 可点的标志：点一下切明暗（首页大标志、侧栏品牌位）。与 bridge 里点 Claude 标志切明暗是同一个手势。
  //   悬停（精确指针）：月桥微微浮起、水面线舒展，整枚朝指针那侧倾几度——指针压在哪头哪头就沉；
  //   按下：整枚收紧、墨挤进线里；
  //   松开：沉进水面 → 线独自翻过半圈 → 在新的明暗里升起；压平那一刻换明暗，新纸色从标志涟漪般铺开。
  // 动作都在 lib/mark-motion.ts（Touch / simFlip），换场在 lib/motion.ts 的 themeReveal。
  // 不画底板、不加光圈：标志本身就是反馈。触屏只有按下与翻面（没有悬停）。
  import Mark from "./Mark.svelte";
  import { app, toggleAppearance } from "../../lib/state.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import { t } from "../../lib/i18n.ts";

  let { size = 24, intro = false }: { size?: number; intro?: boolean } = $props();

  let mark = $state<ReturnType<typeof Mark>>();
  let btn = $state<HTMLButtonElement>();
  // 跟系统档：matchMedia 不是响应式的，自己盯着系统深浅变化（否则标签停在挂载时的明暗）
  const mq = matchMedia("(prefers-color-scheme: dark)");
  let sysDark = $state(mq.matches);
  $effect(() => {
    const on = () => (sysDark = mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  });
  const dark = $derived(app.appearance === "auto" ? sysDark : app.appearance === "dark");
  const label = $derived(dark ? t("切换到浅色") : t("切换到深色"));

  // 指针相对标志中心的横向位置：-1 左缘 … 1 右缘
  const lean = (e: PointerEvent) => {
    const r = btn!.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * 2 - 1;
  };
  const fine = (e: PointerEvent) => e.pointerType === "mouse" || e.pointerType === "pen";

  function enter(e: PointerEvent) {
    if (fine(e)) mark?.hover(true, lean(e));
  }
  function move(e: PointerEvent) {
    if (fine(e)) mark?.hover(true, lean(e));
  }
  function leave() {
    mark?.hover(false);
    mark?.press(false);
  }
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    mark?.press(true);
  }
  function up() {
    mark?.press(false);
  }
  function go() {
    haptic();
    const run = () => toggleAppearance(btn ?? null);
    if (mark) mark.flip(run);
    else run();
  }
</script>

<button
  bind:this={btn}
  class="tm"
  type="button"
  aria-label={label}
  title={label}
  data-no-drag
  onpointerenter={enter}
  onpointermove={move}
  onpointerleave={leave}
  onpointerdown={down}
  onpointerup={up}
  onpointercancel={leave}
  onclick={go}
>
  <Mark bind:this={mark} {size} {intro} />
</button>

<style>
  .tm {
    display: inline-grid;
    place-items: center;
    flex: none;
    padding: 0;
    margin: 0;
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
    border-radius: 50%;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    -webkit-app-region: no-drag;
  }
</style>
