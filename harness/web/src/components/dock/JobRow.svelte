<script lang="ts">
  // U11：任务列表里的一条 Bash 后台命令：命令（等宽，最多两行，在跑 = 微光）+ 用时；
  // 第二行「后台命令 · 状态 · job id」，在跑时行尾有「停止」。点开就地展开尾行输出（服务端给的最后 12 行，已脱敏）。
  // 用时 = 服务端算好的 elapsedMs + 拉到列表之后本机流逝的时间（不拿两台机器的时钟相减）。
  // 停止会杀掉进程、不可找回：两步确认（点一下变「确认停止」，3 秒内再点才停）。
  import { onDestroy } from "svelte";
  import { fmtDur } from "../../lib/tasks.ts";
  import { jobs, stopJob, type JobInfo } from "../../lib/jobs.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import { press } from "../../lib/motion.ts";
  import { t, tc } from "../../lib/i18n.ts";
  import TaskLine from "./TaskLine.svelte";
  import type { Glyph } from "./StatusGlyph.svelte";

  let { job }: { job: JobInfo } = $props();

  const running = $derived(job.state === "running");
  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    now = Date.now();
    const id = setInterval(() => {
      if (!document.hidden) now = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });
  const elapsed = $derived(running ? job.elapsedMs + Math.max(0, now - jobs.fetchedAt) : job.elapsedMs);
  const status = $derived(
    running
      ? t("运行中")
      : job.state === "timeout"
        ? t("超时被停")
        : job.state === "killed"
          ? t("已停止")
          : job.exitCode === 0
            ? t("完成")
            : t("退出码 {code}", { code: job.exitCode ?? "?" }),
  );
  const bad = $derived(job.state === "timeout" || (job.state === "exited" && job.exitCode !== 0));
  const glyph = $derived<Glyph>(running ? "running" : bad ? "failed" : job.state === "killed" ? "stopped" : "done");

  let open = $state(false);
  let stopping = $state(false);
  let armed = $state(false);
  let armTimer = 0;
  onDestroy(() => clearTimeout(armTimer));

  async function stop() {
    if (stopping) return;
    if (!armed) {
      haptic("light");
      armed = true;
      clearTimeout(armTimer);
      armTimer = window.setTimeout(() => (armed = false), 3000);
      return;
    }
    clearTimeout(armTimer);
    armed = false;
    stopping = true;
    haptic("medium");
    try {
      await stopJob(job.id);
    } finally {
      stopping = false;
    }
  }
</script>

<TaskLine
  {glyph}
  glyphLabel={status}
  title={job.command}
  mono
  {running}
  time={fmtDur(elapsed)}
  open={job.tail ? open : undefined}
  onclick={() => {
    if (job.tail) open = !open;
  }}
  aside={running ? stopBtn : undefined}
>
  {#snippet meta()}
    <span>{t("后台命令")}</span>
    <span class:bad>{status}</span>
    <span class="num">{job.id}</span>
  {/snippet}
  {#snippet children()}
    <pre class="tail">{job.tail}</pre>
  {/snippet}
</TaskLine>

{#snippet stopBtn()}
  <button class="stop" class:armed disabled={stopping} use:press={{ scale: 0.95 }} onclick={stop}>
    {stopping ? t("停止中…") : armed ? tc("dimensio", "确认停止") : t("停止")}
  </button>
{/snippet}

<style>
  .bad {
    color: var(--err);
  }
  .num {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
  }
  .tail {
    margin: 0 0 0 22px;
    max-height: 220px;
    overflow: auto;
    padding: 9px 11px;
    border-radius: var(--r-sm);
    background: var(--code-bg);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.55;
    color: var(--text2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .stop {
    height: 22px;
    padding: 0 10px;
    border-radius: var(--r-pill);
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--err);
    background: color-mix(in srgb, var(--err) 10%, transparent);
    white-space: nowrap;
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .stop.armed {
    color: var(--on-accent);
    background: var(--err);
  }
  .stop:disabled {
    opacity: 0.6;
  }
  @media (hover: hover) {
    .stop:not(.armed):not(:disabled):hover {
      background: color-mix(in srgb, var(--err) 16%, transparent);
    }
  }
  /* 触屏：外扩一圈点按区（不改版面——按钮叠在第二行右端，长高会压到第一行的用时） */
  @media (pointer: coarse) {
    .stop {
      position: relative;
    }
    .stop::after {
      content: "";
      position: absolute;
      inset: -9px -6px;
    }
  }
</style>
