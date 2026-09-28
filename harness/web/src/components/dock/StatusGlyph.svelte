<script module lang="ts">
  export type Glyph = "running" | "done" | "failed" | "stalled" | "stopped";
</script>

<script lang="ts">
  // 任务列表行首的状态记号（14px 一格，行与行对齐）：
  //   running = 标志在权衡（Mark weigh）· done = 标志静止（墨色、不上色——成功是默认）·
  //   failed = err 小点 · stalled = warn 小点（久无动静，轻呼吸）· stopped = 空心小圈（中断，不是出错）。
  // 状态修饰用 class: 指令逐个写（模板插值拼的类配 scoped 规则会被编译器剪掉）。
  import Mark from "../brand/Mark.svelte";

  let { kind, label }: { kind: Glyph; label: string } = $props();
</script>

<span class="g" class:run={kind === "running"} role="img" aria-label={label} title={label}>
  {#if kind === "running"}
    <Mark size={14} live />
  {:else if kind === "done"}
    <Mark size={14} />
  {:else}
    <span class="d" class:bad={kind === "failed"} class:warn={kind === "stalled"} class:off={kind === "stopped"}></span>
  {/if}
</span>

<style>
  .g {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    color: var(--text3);
  }
  .g.run {
    color: var(--text2);
  }
  .d {
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }
  .d.bad {
    background: var(--err);
  }
  .d.warn {
    background: var(--warn);
    animation: hx-breathe 1.8s var(--ease-in-out) infinite;
  }
  .d.off {
    box-shadow: inset 0 0 0 1.5px var(--text3);
  }
  @media (prefers-reduced-motion: reduce) {
    .d.warn {
      animation: none;
    }
  }
</style>
