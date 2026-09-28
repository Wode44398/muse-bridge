<script lang="ts">
  // 量度条：一根细线，已走过的一段加粗着色，走到哪儿就有一粒点停在哪儿（官网插图里「光点沿线走」的同一个母题）。
  // 用在：卡片的剩余时间（从满往空缩，朱 = 正在流逝）、上下文用量、计划进度、上传进度。
  // tone：accent = 墨（默认）· live = 朱（倒计时这类「正在发生」）· warn / err = 告急 · ink = 退一档的墨（冷掉的缓存）
  let {
    value,
    tone = "accent",
    label,
    thick = false,
  }: { value: number; tone?: "accent" | "live" | "warn" | "err" | "ink"; label?: string; thick?: boolean } = $props();

  const v = $derived(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)));
</script>

<div
  class="ms {tone}"
  class:thick
  style="--v:{v}"
  role={label ? "progressbar" : undefined}
  aria-label={label}
  aria-valuemin={label ? 0 : undefined}
  aria-valuemax={label ? 100 : undefined}
  aria-valuenow={label ? Math.round(v * 100) : undefined}
>
  <span class="rail"></span>
  <span class="fill"></span>
  <span class="head" class:on={v > 0}></span>
</div>

<style>
  .ms {
    --c: var(--accent);
    position: relative;
    height: 7px;
    min-width: 40px;
  }
  .live {
    --c: var(--live);
  }
  .warn {
    --c: var(--warn);
  }
  .err {
    --c: var(--err);
  }
  .ink {
    --c: var(--text3);
  }
  .rail,
  .fill {
    position: absolute;
    top: 3px;
    left: 3px;
    right: 3px;
    height: 1px;
    background: var(--border2);
  }
  .fill {
    right: auto;
    width: calc((100% - 6px) * var(--v));
    height: 1.5px;
    top: 2.75px;
    background: var(--c);
    transition: width var(--t-slow) var(--ease-out);
  }
  .thick .rail {
    height: 2px;
    top: 2.5px;
    border-radius: 1px;
  }
  .thick .fill {
    height: 3px;
    top: 2px;
    border-radius: 2px;
  }
  /* 走到哪儿停哪儿：一粒点跟着已走过那段的末端 */
  .head {
    position: absolute;
    top: 0.5px;
    left: calc((100% - 6px) * var(--v));
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--c);
    opacity: 0;
    transform: scale(0.4);
    transition:
      left var(--t-slow) var(--ease-out),
      opacity var(--t-med) var(--ease),
      transform var(--t-med) var(--ease-out);
  }
  .head.on {
    opacity: 1;
    transform: none;
  }
</style>
