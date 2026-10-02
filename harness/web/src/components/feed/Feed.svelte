<script lang="ts">
  // 时间线（对话流）：这一格会话（pane.chat；没分屏 = 前台会话 app.chat）的唯一视图。用户 = 靠右的气泡；助手 = 素文直排在画布上；
  // 思考 / 工具 / 工具组 / 子 agent 卡 / 轮次折叠串在一条「量线」上（节点 + 节点之间的细线）；截图 / 报错 / 提示 / 卡片占位与回执各自成行。
  // 显示分组全在纯函数 lib/feed-units.ts（工具组只收只读探索、做完的轮收成一行、最近这一轮不折），这里只负责渲染。
  //
  // 滚动：贴底（离底 < 72px）时内容长高就继续贴底——跟的是内容列本身的尺寸（ResizeObserver），所以工具行状态 / 结果行、
  // Bash 尾行增长、行展开、非末条长出产物卡都跟得上（spec-A ⚠4）；翻上去时自己发了一条消息也回到底（⚠4）。
  // 离底 > 320px 浮出「回到底部」。换会话无条件回到底部。键盘弹出 / 收起（视口变化）与时间线容器尺寸变化保持贴底。
  import { tick } from "svelte";
  import { app, rewindFrom, type ArtifactItem, type Item } from "../../lib/state.svelte.ts";
  import { feedUnits, type FeedUnit } from "../../lib/feed-units.ts";
  import { isPendingCard } from "../../lib/card-dock.ts";
  import { handleCopyClick } from "../../lib/copy-click.ts";
  import { fade, pop, reducedMotion, rise } from "../../lib/motion.ts";
  import { haptic } from "../../lib/touch.ts";
  import Icon from "../ui/Icon.svelte";
  import AskCard from "../cards/AskCard.svelte";
  import PermissionCard from "../cards/PermissionCard.svelte";
  import PlanCard from "../cards/PlanCard.svelte";
  import UserMessage from "./UserMessage.svelte";
  import AssistantText from "./AssistantText.svelte";
  import ThinkRow from "./ThinkRow.svelte";
  import ToolRow from "./ToolRow.svelte";
  import ToolGroup from "./ToolGroup.svelte";
  import AgentCard from "./AgentCard.svelte";
  import TurnFold from "./TurnFold.svelte";
  import CardSlot from "./CardSlot.svelte";
  import ErrorCard from "./ErrorCard.svelte";
  import Notice from "./Notice.svelte";
  import ScreenshotCard from "./ScreenshotCard.svelte";
  import ActivityLine from "./ActivityLine.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { onOpenArtifact = null }: { onOpenArtifact?: ((artifact: ArtifactItem, sessionId: string) => void) | null } = $props();

  // ── 滚动：贴底 ─────────────────────────────────────────────────────────────────────
  let scroller: HTMLElement | undefined = $state();
  let stick = true; // 普通变量——刻意不做成响应式
  let showJump = $state(false);
  // 「回到底部」的平滑滚动进行中：途中的滚动事件不算用户离底；自动跟随先让它滑完（强制的回底照样立刻到）
  let gliding = false;
  let glideTimer = 0;

  export function scrollToEnd(force = false) {
    if (!scroller) return;
    if (force) {
      stick = true;
      endGlide();
    }
    if (!stick || gliding) return;
    scroller.scrollTo({ top: scroller.scrollHeight });
    // 内容不够一屏时 scrollTo 不出滚动事件：到底了就顺手收起「回到底部」（切会话不带着上一个的按钮）
    showJump = false;
  }

  function onScroll() {
    if (!scroller) return;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (gliding) {
      stick = true;
      if (gap < 2) endGlide();
      return;
    }
    stick = gap < 72;
    showJump = gap > 320;
  }

  function endGlide() {
    gliding = false;
    clearTimeout(glideTimer);
  }
  function jumpToEnd() {
    if (!scroller) return;
    haptic("light");
    if (reducedMotion()) {
      scrollToEnd(true);
      return;
    }
    stick = true;
    showJump = false;
    gliding = true;
    clearTimeout(glideTimer);
    // 兜底：滑动途中内容又长了（目标是点下那一刻的底）或浏览器没报完滚动事件——到点直接落到真正的底
    glideTimer = window.setTimeout(() => {
      endGlide();
      scrollToEnd();
    }, 1200);
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }
  // 用户自己往上翻（滚轮 / 手指往下拖）：立刻松开贴底，别和手指抢（贴底容差内也一样）；平滑滚动途中被打断同理
  let touchY = 0;
  function onWheel(e: WheelEvent) {
    if (e.deltaY < 0) {
      stick = false;
      endGlide();
    }
  }
  function onTouchStart(e: TouchEvent) {
    touchY = e.touches[0]?.clientY ?? 0;
    endGlide();
  }
  function onTouchMove(e: TouchEvent) {
    if ((e.touches[0]?.clientY ?? 0) - touchY > 6) stick = false;
  }

  // 1. 跟内容：条数变了、末条的字变了（每 90ms 一批的流式落地）
  $effect(() => {
    const tl = pane.chat.timeline;
    void tl.length;
    const last = tl[tl.length - 1] as { text?: string } | undefined;
    if (last) void last.text;
    tick().then(() => scrollToEnd());
  });

  // 2. 切换会话（pane.chat 引用变化）：无条件回到底部 —— 旧会话的翻阅位置不该把 stick=false 带进新会话
  $effect(() => {
    void pane.chat;
    stick = true;
    tick().then(() => scrollToEnd(true));
  });

  // 3. 自己发了一条（时间线末尾新冒出一条用户消息、这一轮开跑了）：翻在上面也回到底部（spec-A ⚠4）
  let lastTail: Item | undefined;
  $effect(() => {
    const tl = pane.chat.timeline;
    const tail = tl[tl.length - 1];
    const sent = tail !== lastTail && tail?.kind === "user" && !tail.steer && pane.chat.running;
    lastTail = tail;
    if (sent) {
      stick = true;
      tick().then(() => scrollToEnd(true));
    }
  });

  // 4. P10：时间线容器自己的高度变了（输入框上方停进 / 收走一张卡、输入框长高）——原本贴着底就继续贴着
  $effect(() => {
    const el = scroller;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick) requestAnimationFrame(() => scrollToEnd());
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  // 5. 键盘弹出 / 收起（视口高度变化）时保持吸底——壳内 IME 收缩与手机浏览器都覆盖
  $effect(() => {
    const onResize = () => {
      if (stick) requestAnimationFrame(() => scrollToEnd(true));
    };
    window.visualViewport?.addEventListener("resize", onResize);
    window.addEventListener("resize", onResize);
    return () => {
      window.visualViewport?.removeEventListener("resize", onResize);
      window.removeEventListener("resize", onResize);
    };
  });

  // 6. 内容列本身长高 / 变矮（状态行、尾行输出、展开、产物卡……）：贴着底就继续贴着。RO 回调在布局之后、绘制之前，
  //    这一帧就画在底部，不闪。
  function followContent(node: HTMLElement) {
    if (typeof ResizeObserver === "undefined") return {};
    const ro = new ResizeObserver(() => {
      if (stick) scrollToEnd();
    });
    ro.observe(node);
    return { destroy: () => ro.disconnect() };
  }

  $effect(() => () => clearTimeout(glideTimer));

  // ── 显示单元 ───────────────────────────────────────────────────────────────────────
  // 工具组 / 轮次折叠的开合按 key 记（换会话时 key 不重复，不必清）
  let groupOpen = $state<Record<string, boolean>>({});
  let foldOpen = $state<Record<string, boolean>>({});
  // 精简（默认）：连续的工具调用收成一行、单独的工具行只留头行；设置里打开「显示全部工作过程」= 原来逐条平铺的样子
  const compact = $derived(!app.feedDetail);
  const units = $derived(feedUnits(pane.chat.timeline, pane.chat.running, foldOpen, compact));

  // 新条目浮起只给「直播时一条条追加」：一次冒出一大批（附着直播时服务端整批重放这一轮、对账合并补进一截尾巴）就直接出现，
  // 不让几十条一起动；用户自己点开一轮的处理过程除外（那是展开，浮起正合适）。
  let prevCount = 0;
  let burstAt = -1;
  let expanding = false;
  $effect.pre(() => {
    const n = units.length;
    if (n - prevCount > 3 && !expanding) burstAt = performance.now();
    prevCount = n;
    expanding = false;
  });
  const riseIn = () => (performance.now() - burstAt < 60 ? { duration: 0 } : { y: 8 });
  function toggleFold(key: string) {
    expanding = !foldOpen[key];
    foldOpen[key] = !foldOpen[key];
  }

  // 量线：思考 / 工具 / 工具组 / 折叠行是线上的节点，相邻的两行接起来（活动行接在最后）
  const onRail = (u: FeedUnit) => u.f || u.g || u.a || u.item.kind === "tool" || u.item.kind === "thinking";
  const rails = $derived(units.map(onRail));

  // U6：「接着做」只挂在时间线最后一条的失败上
  const lastItem = $derived(pane.chat.timeline[pane.chat.timeline.length - 1] ?? null);
  // 复制钮只跟最终回答
  const lastText = $derived.by(() => {
    const tl = pane.chat.timeline;
    for (let i = tl.length - 1; i >= 0; i--) if (tl[i].kind === "text") return tl[i];
    return null;
  });
  // spec-A ⚠6：历史重建把一条助手消息的产物清单挂到了它的每一段正文上——同一轮里清单一样的，只在最后那段显示
  const dupArtifacts = $derived.by(() => {
    const dup = new Set<Item>();
    const seen = new Map<string, Item>();
    for (const it of pane.chat.timeline) {
      if (it.kind === "user" && !it.steer) seen.clear();
      else if (it.kind === "text" && it.artifacts?.length) {
        const key = it.artifacts.map((a) => a.path).join("\n");
        const prev = seen.get(key);
        if (prev) dup.add(prev);
        seen.set(key, it);
      }
    }
    return dup;
  });

  // U9：用户气泡的动作行（手机点一下气泡亮 / 再点收；电脑悬停就亮）
  let actsFor = $state<Item | null>(null);
  let rewinding = false;
  async function rewind(item: Extract<Item, { kind: "user" }>) {
    if (rewinding) return;
    rewinding = true;
    actsFor = null;
    try {
      await rewindFrom(item);
    } finally {
      rewinding = false;
    }
  }
</script>

<div class="feed" in:fade|global={{ duration: 180 }}>
  <main
    class="scroller"
    bind:this={scroller}
    onscroll={onScroll}
    onwheel={onWheel}
    ontouchstart={onTouchStart}
    ontouchmove={onTouchMove}
  >
    <!-- 换会话整列重建：本地过渡只在它所在的块创建时播，重建时几百条不会一起浮起来（只有整列一层淡入）；
         之后直播追加的条目才各自浮起 -->
    {#key pane.chat}
      <!-- 点击委托：代码块的「复制」（lib/copy-click.ts），回执卡里的也算 -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="col" use:followContent onclick={handleCopyClick} in:fade={{ duration: 160 }}>
        {#each units as u, k (u.key)}
          {@const rail = rails[k]}
          {@const up = rail && k > 0 && rails[k - 1]}
          {@const down = rail && (k < units.length - 1 ? rails[k + 1] : pane.chat.running)}
          <!-- 新一轮 = 用户自己发的消息（运行中插话不算，不另起一段呼吸） -->
          <div class="u" class:rail class:user={!u.f && !u.g && !u.a && u.item.kind === "user" && !u.item.steer} in:rise={riseIn()}>
            {#if u.f}
              <TurnFold tools={u.tools} run={u.run} open={u.open} {up} {down} ontoggle={() => toggleFold(u.key)} />
            {:else if u.g}
              <ToolGroup items={u.items} live={u.live} {compact} open={groupOpen[u.key] ?? false} {up} {down} ontoggle={() => (groupOpen[u.key] = !groupOpen[u.key])} />
            {:else if u.a}
              <AgentCard items={u.items} {up} {down} />
            {:else}
              {@const item = u.item}
              {#if item.kind === "user"}
                <UserMessage
                  {item}
                  actsOn={actsFor === item}
                  ontoggle={() => (actsFor = actsFor === item ? null : item)}
                  onrewind={() => void rewind(item)}
                />
              {:else if item.kind === "text"}
                <AssistantText
                  {item}
                  final={item === lastText && !(item.live && pane.chat.running)}
                  artifacts={!dupArtifacts.has(item)}
                  {onOpenArtifact}
                />
              {:else if item.kind === "thinking"}
                <ThinkRow {item} {compact} {up} {down} />
              {:else if item.kind === "tool"}
                <ToolRow {item} {compact} {up} {down} />
              {:else if (item.kind === "ask" || item.kind === "permission" || item.kind === "plan") && isPendingCard(item, pane.chat.running)}
                <!-- P10（E1）：交互态的卡停在输入框上方（只渲染那一份），这里原位留一行；落定后照旧显示只读回执 -->
                <CardSlot {item} />
              {:else if item.kind === "ask"}
                <AskCard {item} />
              {:else if item.kind === "permission"}
                <PermissionCard {item} />
              {:else if item.kind === "plan"}
                <PlanCard {item} />
              {:else if item.kind === "error"}
                <ErrorCard {item} last={item === lastItem} />
              {:else if item.kind === "notice"}
                <Notice text={item.text} />
              {:else if item.kind === "screenshot"}
                <ScreenshotCard {item} />
              {/if}
            {/if}
          </div>
        {/each}

        {#if pane.chat.running}
          <div class="u rail" in:rise={{ y: 6 }} out:fade={{ duration: 140 }}>
            <ActivityLine up={rails[rails.length - 1] ?? false} />
          </div>
        {/if}
      </div>
    {/key}
  </main>

  {#if showJump}
    <button class="jump" onclick={jumpToEnd} aria-label={t("回到底部")} title={t("回到底部")} transition:pop={{ from: 0.7 }}>
      <Icon name="chevronD" size={18} stroke={2} />
    </button>
  {/if}
</div>

<style>
  .feed {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  /* 滚动容器：顶部内容滑到顶栏下面时柔和消失（不画分隔线），底部也留一点渐隐。
     scrollbar-gutter 两侧都留：有没有滚动条，正文列都和输入框同一条中线。 */
  .scroller {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable both-edges;
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 16px, black calc(100% - 14px), transparent 100%);
    mask-image: linear-gradient(to bottom, transparent 0, black 16px, black calc(100% - 14px), transparent 100%);
  }

  /* 正文列：最宽 760（含左右 20 内边距，手机 16），与输入框同宽同中线。
     量线的几何在这里定：节点列宽 / 节点中心 / 头行高 / 相邻两行的行距（上接线正好跨过它）。 */
  .col {
    --gutter: 22px;
    --rail-x: 6px;
    --row-h: 30px;
    --rail-gap: 4px;
    max-width: 760px;
    margin: 0 auto;
    padding: 20px 20px 28px;
    font-size: var(--fs-body);
    line-height: var(--lh-ui);
    color: var(--text);
  }
  @media (pointer: coarse) {
    .col {
      --row-h: 36px;
    }
  }
  @media (max-width: 699px) {
    .col {
      padding: 16px 16px 24px;
    }
  }

  /* 节奏：同一轮内 12px；量线上相邻两行 = 行距；新一轮（用户消息）前留足呼吸。
     块级排版（不是 flex 列）：流式时尾部长高不牵动整列重新排版。 */
  .u {
    display: flow-root;
    min-width: 0;
  }
  .u + .u {
    margin-top: 12px;
  }
  .u.rail + .u.rail {
    margin-top: var(--rail-gap);
  }
  .u.user:not(:first-child) {
    margin-top: 28px;
  }

  /* 回到底部：输入框上方正中一颗圆钮 */
  .jump {
    position: absolute;
    left: 50%;
    bottom: 14px;
    z-index: 3;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    translate: -50% 0;
    transform-origin: 50% 100%;
    background: var(--surface);
    color: var(--text2);
    box-shadow:
      var(--shadow-2),
      0 0 0 1px var(--border);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .jump:active {
    background: var(--surface2);
  }
  @media (hover: hover) {
    .jump:hover {
      background: var(--surface2);
      color: var(--text);
    }
  }
  @media (pointer: coarse) {
    .jump {
      width: 40px;
      height: 40px;
    }
  }
</style>
