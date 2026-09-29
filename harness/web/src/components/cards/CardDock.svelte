<script lang="ts">
  // P10（ZCode E1）：等你处理的卡停在输入框上方（规则见 lib/card-dock.ts）。
  //  · 交互态的卡只在这里渲染一份：从停进来到落定不移位、不重挂载（问答卡选了一半的选项不会丢）；时间线原位留占位行
  //  · 一次只停一张（最早的那张）；正在打字就等输入停下 1 秒；停进来 400ms 内的点击不算（CardGuard）
  //  · 进场：卡片从下方 12px 浮起、淡入（弹簧；刚好落在 CardGuard 的 400ms 里，浮起途中点不中任何按钮）；
  //    落定：往下沉一点、淡出（短促 ease-in）。没送达、在退场途中又停回来的那张，重新浮起（不重挂载，选了的还在）。
  //  · 换卡（这张落定、下一张马上停进来）：退场的那张立刻脱离排版、贴底叠在原处淡出，新的一张占位浮起——
  //    外框只从旧卡的高度长 / 缩到新卡的高度一次，不会先撑高再缩回。
  // 版式归宿主（composer/Above.svelte）：列宽与内边距、与输入框之间的间距、以及「随内容平滑长高、内容贴底、
  // 从上沿露出来」的外框（smoothHeight）。这里只管停哪张卡、卡片自己的进退场；自身不加宽度约束和内外边距。
  import { untrack } from "svelte";
  import { nextDocked, pendingCards } from "../../lib/card-dock.ts";
  import { rise } from "../../lib/motion.ts";
  import AskCard from "./AskCard.svelte";
  import CardGuard from "./CardGuard.svelte";
  import PermissionCard from "./PermissionCard.svelte";
  import PlanCard from "./PlanCard.svelte";
  import { markSettling } from "./card-actions.ts";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  const chat = $derived(pane.chat);
  const pending = $derived(pendingCards(chat.timeline, chat.running));

  // 同一个会话里刚退出等待的卡（落定 / 失效 / 这一轮结束）：时间线马上会把它的占位行换成回执，
  // 记一笔让回执从占位行的高度长出来（card-actions 的 settleIn）。必须在渲染阶段记（$effect.pre）：
  // 回执的挂载动作是普通 effect，排在所有渲染阶段之后，读得到这一笔。
  let prevIds: string[] = [];
  let prevChat: unknown = null;
  $effect.pre(() => {
    const ids = pending.map((c) => c.id);
    const c = chat;
    untrack(() => {
      if (c === prevChat) for (const id of prevIds) if (!ids.includes(id)) markSettling(id);
      prevIds = ids;
      prevChat = c;
    });
  });

  // 输入框的时刻不是响应式的（每个按键都触发重算不值得）：还没停够就定个时再看一次
  let recheck = $state(0);
  $effect(() => {
    void recheck;
    const c = chat;
    const list = pending;
    const current = untrack(() => c.dockedCardId); // 这个 effect 自己写它：读的时候不订阅
    const next = nextDocked(list, current, Date.now() - c.lastInputAt);
    if (next.id !== current) c.dockedCardId = next.id;
    if (next.wait <= 0) return;
    const timer = setTimeout(() => recheck++, next.wait + 20);
    return () => clearTimeout(timer);
  });

  const docked = $derived(pending.find((c) => c.id === chat.dockedCardId) ?? null);
  const more = $derived(docked ? pending.length - 1 : 0);
  // 按卡片 id 分项的单元素列表：换卡 = 旧的一项退场、新的一项进场。退场中的那一项留着它自己的卡片
  // （不会被换成下一张；Svelte 在退场期间把它设成 inert，点不到），里面的组件也不重挂载。
  const shown = $derived(docked ? [docked] : []);

  // 退场：脱离排版、贴底叠在原处（外框的高度立刻按剩下的内容走），再照 rise 的退场沉下去、淡出。
  // 在过渡函数里同步做（outrostart 要晚一帧，那一帧新旧两张会同时占位）；outrostart 再补一次——
  // 退场被打断又进场、再退场时 Svelte 复用上一次的过渡参数，不会再调过渡函数。进场（含被打断后重新浮起）回到排版里。
  function lift(n: HTMLElement) {
    n.style.position = "absolute";
    n.style.left = "0";
    n.style.right = "0";
    n.style.bottom = "0";
  }
  function sink(node: Element, params: { y?: number; out?: number }, opts: { direction?: "in" | "out" | "both" }) {
    lift(node as HTMLElement);
    return rise(node, params, opts);
  }
  const leave = (e: Event) => lift(e.currentTarget as HTMLElement);
  function stay(e: Event) {
    const n = e.currentTarget as HTMLElement;
    n.style.position = n.style.left = n.style.right = n.style.bottom = "";
  }
</script>

<div class="dock" role={docked ? "region" : undefined} aria-label={docked ? t("等你处理的卡片") : undefined}>
  {#each shown as card (card.id)}
    <div class="slot" in:rise|global={{ y: 12 }} out:sink|global={{ y: 10, out: 200 }} onoutrostart={leave} onintrostart={stay}>
      <CardGuard>
        {#if card.kind === "permission"}
          <PermissionCard item={card} />
        {:else if card.kind === "ask"}
          <AskCard item={card} />
        {:else}
          <PlanCard item={card} />
        {/if}
      </CardGuard>
      {#if more > 0}<p class="more">{t("还有 {n} 张在排队，处理完这张就轮到下一张", { n: more })}</p>{/if}
    </div>
  {/each}
</div>

<style>
  /* 退场的那张绝对定位时以它为参照；定位元素按文档顺序画在时间线之后，卡片的阴影叠在时间线尾巴上 */
  .dock {
    position: relative;
    width: 100%;
    min-width: 0;
  }
  .slot {
    min-width: 0;
  }
  .more {
    margin: 0;
    padding: 7px 16px 0;
    font-size: var(--fs-xs);
    line-height: var(--lh-ui);
    color: var(--text3);
  }
  @media (max-width: 699px) {
    .more {
      padding: 7px 14px 0;
    }
  }
</style>
