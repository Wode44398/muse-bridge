<script lang="ts">
  // 输入框上方的状态区（App 把它挂在对话流与输入框之间）。与输入框同宽同中线，从上到下：
  //   计划条 + 预览胶囊（一行）· 目标条 · 待送达的插话 · 停靠的卡片 · 缓存变冷提示
  // 整块贴着输入框往上长：每一格出现 / 消失都是高度长出 / 收拢（Slot），它上面的格子和对话流平滑让位，下面的不动。
  // 停靠卡放在最贴近输入框的位置、插话托盘放在它上面：托盘里的插话随时会被读走（那一行收起），要是托盘在卡下面，
  // 卡就会在指尖下面挪位——P10 要求停靠区只往上长、按钮不滑到指尖下。
  // 停靠区的内容归 cards/CardDock（另一路），这里只给它一个随内容平滑长高的框；有卡时补上与输入框之间的间距。
  import { app } from "../../lib/state.svelte.ts";
  import { pendingCards } from "../../lib/card-dock.ts";
  import { smoothHeight } from "../../lib/motion.ts";
  import Slot from "./Slot.svelte";
  import TodoStrip from "./TodoStrip.svelte";
  import PreviewPill from "./PreviewPill.svelte";
  import GoalBar from "./GoalBar.svelte";
  import SteerTray from "./SteerTray.svelte";
  import ColdHint from "./ColdHint.svelte";
  import CardDock from "../cards/CardDock.svelte";
  import { usePane } from "../../lib/pane.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  // 工作区浏览器是全局的一个（跟着有焦点的那一格）：分屏时只在有焦点的那格给入口；这一格自己的预览照常给
  const pillVisible = $derived(Boolean(pane.chat.preview || (pane.focused && app.browser)) && !app.dockOpen);
  const stripVisible = $derived(pane.chat.todos.length > 0 || pillVisible);
  // 与 CardDock 同一个判定（纯函数）：此刻停着的那张还在等 → 停靠区有内容
  const docked = $derived(pendingCards(pane.chat.timeline, pane.chat.running).some((c) => c.id === pane.chat.dockedCardId));
</script>

<div class="above">
  {#if stripVisible}
    <Slot>
      <div class="striprow">
        {#if pane.chat.todos.length}<TodoStrip />{/if}
        {#if pillVisible}<PreviewPill />{/if}
      </div>
    </Slot>
  {/if}
  {#if pane.chat.goal}
    <Slot><GoalBar /></Slot>
  {/if}
  {#if pane.chat.pendingSteers.length}
    <Slot><SteerTray /></Slot>
  {/if}
  <div class="dock" use:smoothHeight>
    <div class="dockin" class:on={docked}>
      <CardDock />
    </div>
  </div>
  <ColdHint />
</div>

<style>
  .above {
    position: relative;
    flex: none;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    padding: 0 20px;
  }
  .striprow {
    display: flex;
    align-items: flex-end;
    justify-content: flex-end;
    gap: 8px;
    min-width: 0;
  }
  /* 停靠区：内容贴底（长高时从上沿露出来，卡的按钮始终在原位）；裁切外扩一圈，卡片的阴影不被切掉 */
  .dock {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    min-width: 0;
    overflow-clip-margin: 24px;
  }
  .dockin {
    flex: none;
    min-width: 0;
  }
  .dockin.on {
    padding-bottom: 8px;
  }
  @media (max-width: 699px) {
    .above {
      padding: 0 12px;
    }
  }
</style>
