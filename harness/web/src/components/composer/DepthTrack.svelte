<script lang="ts">
  // 思考深度：iOS 26 带刻度的滑块（bridge 的 ios27/Slider，steps 分档）——白色胶囊圆钮，按住化成液态玻璃透镜、拖动跟手并按速度拉伸，
  // 跨过一档轻震一下，松手由同一根弹簧吸到最近一档才提交（拖的途中不写配置：每写一次都是一次 POST，后发的赢）。
  // 档名写在刻度正下方：点档名直接跳过去；拖动时跟手高亮最近那一档。
  import type { Component } from "svelte";
  import { setContext } from "svelte";
  // @ts-ignore —— bridge 的 JS 组件、没有类型声明；下面按用到的参数收窄
  import SliderRaw from "../../../../../web/src/components/ios27/Slider.svelte";
  import { app } from "../../lib/state.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import { t } from "../../lib/i18n.ts";

  const Slider = SliderRaw as unknown as Component<{
    value: number;
    steps: number;
    label: string;
    oninput?: (v: number) => void;
    onchange?: (v: number) => void;
  }>;

  let {
    options,
    value,
    onchange,
    label = t("思考深度"),
  }: {
    options: readonly { value: string; label: string }[];
    value: string;
    onchange: (v: string) => void;
    label?: string;
  } = $props();

  const n = $derived(options.length);
  const idx = $derived(Math.max(0, options.findIndex((o) => o.value === value)));
  const pos = $derived(n > 1 ? idx / (n - 1) : 0);
  // 拖动中跟手的那一档（档名高亮跟着它走，松手后回到真值）
  let live = $state<number | null>(null);
  const shown = $derived(live ?? idx);

  // 滑块的玻璃配方分明暗：从 ios27 上下文读 dark
  const mq = matchMedia("(prefers-color-scheme: dark)");
  let sysDark = $state(mq.matches);
  $effect(() => {
    const on = () => (sysDark = mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  });
  const dark = $derived(app.appearance === "dark" || (app.appearance === "auto" && sysDark));
  setContext("ios27", {
    get dark() {
      return dark;
    },
  });

  function commit(i: number) {
    live = null;
    const o = options[Math.max(0, Math.min(n - 1, i))];
    if (!o || o.value === value) return;
    onchange(o.value);
  }
  function pick(i: number) {
    haptic("light");
    commit(i);
  }
</script>

<!-- data-no-stretch：在这一块里按下（拖滑块、点档名）时，外面的液态面板不跟着放大拉伸 -->
<div class="dt" style="--n:{n}" data-no-stretch>
  <Slider
    value={pos}
    steps={n}
    {label}
    oninput={(v) => (live = Math.round(v * (n - 1)))}
    onchange={(v) => commit(Math.round(v * (n - 1)))}
  />
  <div class="labels">
    {#each options as o, i (o.value)}
      <button
        type="button"
        class="lb"
        class:on={i === shown}
        class:first={i === 0}
        class:last={i === n - 1}
        style:left="calc(19px + (100% - 38px) * {n > 1 ? i / (n - 1) : 0})"
        tabindex="-1"
        onclick={() => pick(i)}>{o.label}</button
      >
    {/each}
  </div>
</div>

<style>
  /* 滑块读 ios27 的颜色变量：轨道 = 墨的淡灰、填充 = 墨（深色档是象牙）；刻度点在轨道上 / 填充上各一种颜色 */
  .dt {
    --i-fill1: color-mix(in srgb, var(--text) 13%, transparent);
    --i-accent: var(--accent);
    --i-tick: color-mix(in srgb, var(--text) 30%, transparent);
    --i-tick-on: color-mix(in srgb, var(--on-accent) 85%, transparent);
    margin: -6px 0 0;
    user-select: none;
    -webkit-user-select: none;
  }
  /* 档名：每个正对自己的刻度（与滑块同一套几何：圆钮半宽 19 起，到右侧圆钮半宽止），两端的贴边对齐免得出界 */
  .labels {
    position: relative;
    height: 20px;
    margin-top: -4px;
  }
  .lb {
    position: absolute;
    top: 0;
    transform: translateX(-50%);
    padding: 1px 4px 3px;
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.4;
    color: var(--text3);
    white-space: nowrap;
    transition: color var(--t-fast) var(--ease);
  }
  .lb.first {
    transform: translateX(-19px);
  }
  .lb.last {
    transform: translateX(calc(-100% + 19px));
  }
  .lb.on {
    color: var(--text);
    font-weight: 600;
  }
  @media (hover: hover) {
    .lb:not(.on):hover {
      color: var(--text2);
    }
  }
  @media (pointer: coarse) {
    .lb {
      font-size: var(--fs-sm);
    }
  }
</style>
