<script lang="ts">
  // P7：卡片右上角的剩余时间——一根从满往空缩的尺寸线 + 等宽小字（剩 20% 以内转警示色）。
  // 到点不在这里做任何事：服务端按各自的方式落定（*_cancelled reason:"timeout"），卡片随之收走、时间线留回执。
  // 只有停着的那张卡会挂它（一次一张），所以一秒一跳的钟只有一个。
  // at = 服务端时钟的截止时刻；本机「现在」按这一轮的时钟偏差换算过去（RunClock.skew = 服务端 − 本机）。
  // total = 满格代表多长（card-kit 的 cardWindowMs）；挂上时实测的剩余比它还长，就以实测为准。
  import { untrack } from "svelte";
  import Measure from "../ui/Measure.svelte";
  import { fmtLeft, leftLabel } from "./card-kit.ts";
  import { usePane } from "../../lib/pane.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { at, total }: { at: number; total: number } = $props();

  const serverNow = () => Date.now() + (pane.chat.clock?.skew ?? 0);
  let now = $state(serverNow());
  // 挂上那一刻的剩余（只取一次：满格的长度不跟着时钟变）
  const firstLeft = untrack(() => Math.max(0, at - serverNow()));

  $effect(() => {
    const t = setInterval(() => (now = serverNow()), 1000);
    return () => clearInterval(t);
  });

  const left = $derived(Math.max(0, at - now));
  const span = $derived(Math.max(total, firstLeft, 1));
  const frac = $derived(left / span);
  const low = $derived(frac <= 0.2);
</script>

<div class="dl" class:low role="timer" aria-label={leftLabel(left)}>
  <span class="line" aria-hidden="true"><Measure value={frac} tone={low ? "warn" : "live"} /></span>
  <span class="t" aria-hidden="true">{fmtLeft(left)}</span>
</div>

<style>
  .dl {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .line {
    display: block;
    width: 52px;
  }
  .t {
    min-width: 4ch;
    text-align: right;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    color: var(--text3);
    transition: color var(--t-med) var(--ease);
  }
  .low .t {
    color: var(--warn);
  }
</style>
