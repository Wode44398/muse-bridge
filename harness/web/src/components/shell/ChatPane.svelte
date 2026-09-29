<script lang="ts">
  // 一格对话：顶栏 · 对话流（空对话 = 问候）· 输入框。没分屏时整个正文列就是一格；分屏时左右两格并排（App 排版）。
  // 这一格给子树提供「这一格的会话」（lib/pane.ts）；点进来、焦点落进来（捕获阶段，先于格里任何按钮）就把焦点挪到这一格——
  // 之后格里的按钮、输入框作用的就是它（state 里的动作都作用于 app.chat）。
  //
  // 空态居中：桌面上新对话时输入框坐在问候语下面；发出第一条消息，它从当前位置滑到底部（FLIP），新建对话时再滑回来。
  // 手机不居中（键盘在底下，输入框就该贴着它）。
  import { focusPane, type ArtifactItem, type Chat } from "../../lib/state.svelte.ts";
  import { providePane } from "../../lib/pane.ts";
  import { reducedMotion, SPRING_SOFT, springEasing } from "../../lib/motion.ts";
  import { t, tr } from "../../lib/i18n.ts";
  import TopBar from "./TopBar.svelte";
  import Hero from "./Hero.svelte";
  import Feed from "../feed/Feed.svelte";
  import Above from "../composer/Above.svelte";
  import Composer from "../composer/Composer.svelte";

  let {
    chat,
    index = 0,
    split = false,
    focused = true,
    wide = false,
    onMenu,
    menuVisible = true,
    showDock = true,
    onclose = null,
    onOpenArtifact = null,
  }: {
    chat: Chat;
    index?: number;
    split?: boolean;
    focused?: boolean;
    wide?: boolean;
    onMenu: () => void;
    menuVisible?: boolean;
    showDock?: boolean;
    onclose?: (() => void) | null;
    onOpenArtifact?: ((artifact: ArtifactItem, sessionId: string) => void) | null;
  } = $props();

  providePane({
    get chat() {
      return chat;
    },
    get focused() {
      return focused;
    },
    get split() {
      return split;
    },
    get index() {
      return index;
    },
  });

  // 分屏里没焦点的这一格被点到 / 焦点落进来：先把它变成 app.chat，再让事件往下走
  function claim() {
    if (split && !focused) focusPane(chat);
  }

  const empty = $derived(chat.timeline.length === 0);
  const centered = $derived(empty && wide);
  let bottomEl: HTMLDivElement | undefined = $state();
  let bottomTop = 0;
  $effect.pre(() => {
    void centered;
    if (bottomEl) bottomTop = bottomEl.getBoundingClientRect().top;
  });
  $effect(() => {
    void centered;
    const el = bottomEl;
    if (!el || reducedMotion()) return;
    const now = el.getBoundingClientRect().top;
    const dy = bottomTop - now;
    bottomTop = now;
    if (Math.abs(dy) < 4) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
      duration: SPRING_SOFT.ms + 120,
      easing: springEasing(SPRING_SOFT),
    });
  });
</script>

<section
  class="pane"
  class:split
  class:focused
  class:centered
  data-pane={index}
  aria-label={split
    ? focused
      ? t("第 {n} 格：{title}（当前）", { n: index + 1, title: tr(chat.title?.trim() ?? "") || t("新对话") })
      : t("第 {n} 格：{title}", { n: index + 1, title: tr(chat.title?.trim() ?? "") || t("新对话") })
    : undefined}
  onpointerdowncapture={claim}
  onfocusincapture={claim}
>
  <TopBar {onMenu} {menuVisible} {showDock} {onclose} />
  <div class="stage">
    {#if empty}
      <Hero />
    {:else}
      <Feed {onOpenArtifact} />
    {/if}
  </div>
  <div class="bottom" bind:this={bottomEl}>
    <Above />
    <Composer />
  </div>
</section>

<style>
  .pane {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .bottom {
    flex: none;
    position: relative;
    z-index: 2;
  }
  /* 空态居中（桌面）：问候 + 输入框作为一组坐在视觉中线略上 */
  .pane.centered .stage {
    flex: 0 0 auto;
    margin-top: auto;
  }
  .pane.centered .bottom {
    margin-bottom: auto;
    padding-bottom: 10vh;
  }
  .pane.centered .stage :global(.hero) {
    padding-bottom: 30px;
  }
  /* 分屏：有焦点的那一格顶上一道墨线；另一格的顶栏字退一档（它照常在跑、照常能点） */
  .pane.split.focused::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 3;
    height: 2px;
    background: var(--accent);
    pointer-events: none;
  }
  .pane.split:not(.focused) :global(.tb .where) {
    color: var(--text3);
  }
</style>
