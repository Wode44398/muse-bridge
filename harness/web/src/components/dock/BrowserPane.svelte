<script lang="ts">
  // 工作区「浏览器」：标签条（网页标位 + 标题 + 关闭；＋新建 / ×关闭 / 点选切换，全部由服务端广播）+ 直播画面。
  // 同步模型：接口响应里就带最新列表（本地立即生效），直播流的 tabs 事件随后全量对账（多端同步）；
  // 旧后端没有这三个路由：切换静默失败，新建 / 关闭给提示。关掉最后一个标签 = 浏览器整个退出，面板留空态，
  // 地址栏或 ＋ 可以重新拉起。收起工作区的钮在工作区顶带上，这里不再重复一个。
  import { app, toast } from "../../lib/state.svelte.ts";
  import * as api from "../../lib/api.ts";
  import { haptic } from "../../lib/touch.ts";
  import { t } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import BrowserView from "./BrowserView.svelte";

  const coarse = matchMedia("(pointer: coarse)").matches; // 触屏：＋ 放大
  let tabBusy = $state(false);

  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  const tabLabel = (tb: { url: string; title: string }) => tb.title || host(tb.url) || t("新标签页");

  async function pickTab(id: string) {
    const tb = app.browserTabs.find((x) => x.id === id);
    if (tabBusy || !tb || tb.active) return;
    tabBusy = true;
    try {
      const r = await api.browserTabActivate(id);
      app.browserTabs = r.tabs;
    } catch {
      /* 旧后端 / 标签刚没了：直播流会对账 */
    }
    tabBusy = false;
  }

  async function newTab() {
    if (tabBusy) return;
    tabBusy = true;
    haptic("light");
    try {
      const r = await api.browserTabNew();
      app.browserTabs = r.tabs;
    } catch {
      toast(t("新建标签页失败")); // 走 toast()：以前直接写 app.toast，没有定时收起、还可能带着上一条的动作钮（§17-4）
    }
    tabBusy = false;
  }

  async function closeTab(id: string) {
    if (tabBusy) return;
    tabBusy = true;
    haptic("light");
    try {
      const r = await api.browserTabClose(id);
      app.browserTabs = r.tabs;
    } catch {
      toast(t("关闭标签页失败"));
    }
    tabBusy = false;
  }

  // 标签键盘：左右键在标签间移动焦点（回车 / 空格切换，按钮原生就有）
  let strip: HTMLDivElement | undefined = $state();
  function onKey(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const btns = [...(strip?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    btns[(i + (e.key === "ArrowRight" ? 1 : btns.length - 1)) % btns.length]?.focus();
  }
</script>

<div class="bp">
  <div class="strip">
    {#if app.browserTabs.length}
      <div class="tabs" bind:this={strip} role="tablist" aria-label={t("Agent 浏览器")} tabindex="-1" onkeydown={onKey}>
        {#each app.browserTabs as tab (tab.id)}
          <div class="tab" class:active={tab.active}>
            <!-- 标签本体与关闭钮是兄弟，不套按钮（以前 div[role=tab] 里嵌 button，空格也按不动，§17-15） -->
            <button
              class="tab-main"
              role="tab"
              aria-selected={tab.active}
              tabindex={tab.active ? 0 : -1}
              title={tab.url || t("新标签页")}
              onclick={() => pickTab(tab.id)}
            >
              <span class="fav"><Icon name="globe" size={13} /></span>
              <span class="t">{tabLabel(tab)}</span>
            </button>
            <button class="tab-x" aria-label={t("关闭标签页")} title={t("关闭标签页")} onclick={() => closeTab(tab.id)}>
              <Icon name="close" size={12} stroke={2} />
            </button>
          </div>
        {/each}
      </div>
    {:else}
      <!-- 浏览器没跑：一个静态的「Agent 浏览器」占位标签 -->
      <div class="tabs">
        <div class="tab active static">
          <span class="tab-main">
            <span class="fav"><Icon name="globe" size={13} /></span>
            <span class="t">{t("Agent 浏览器")}</span>
          </span>
        </div>
      </div>
    {/if}
    <IconButton icon="plus" label={t("新标签页")} size={coarse ? 40 : 30} iconSize={16} onclick={newTab} />
  </div>
  <BrowserView />
</div>

<style>
  .bp {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .strip {
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    height: 40px;
    padding: 0 calc(8px + var(--hx-pane-r, 0px)) 0 8px;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tabs:focus-visible {
    outline: none;
  }
  .tab {
    position: relative;
    flex: 0 1 172px;
    min-width: 88px;
    display: flex;
    align-items: center;
    height: 32px;
    border-radius: 10px;
    color: var(--text2);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  /* 当前标签像一张纸片（浮起一层 + 细描边），与工作区顶带那排「选中底块」的工具标签区分开 */
  .tab.active {
    background: var(--dk-card, var(--surface));
    color: var(--text);
    box-shadow:
      0 0 0 1px var(--border),
      0 1px 2px color-mix(in srgb, var(--text) 5%, transparent);
  }
  .tab.static {
    flex: none;
    min-width: 0;
  }
  .tab-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    height: 100%;
    padding: 0 4px 0 10px;
    border-radius: 10px;
    font-size: var(--fs-sm);
    font-weight: 500;
    text-align: left;
  }
  .static .tab-main {
    padding-right: 12px;
  }
  .fav {
    flex: none;
    display: inline-flex;
    color: var(--text3);
  }
  .active .fav {
    color: var(--text2);
  }
  .t {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* 关闭钮：当前标签常显；其余桌面上悬停才浮现（只动透明度，占位不变），触屏常显；键盘聚焦时也显 */
  .tab-x {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin-right: 5px;
    border-radius: 6px;
    color: var(--text3);
    transition:
      opacity var(--t-fast) var(--ease),
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .tab-x:focus-visible {
    opacity: 1;
  }
  @media (hover: hover) {
    .tab:not(.active):hover {
      background: color-mix(in srgb, var(--text) 4%, transparent);
      color: var(--text);
    }
    .tab-x:hover {
      background: color-mix(in srgb, var(--text) 8%, transparent);
      color: var(--text);
    }
  }
  @media (hover: hover) and (pointer: fine) {
    .tab:not(.active) .tab-x {
      opacity: 0;
    }
    .tab:not(.active):hover .tab-x,
    .tab:not(.active):focus-within .tab-x {
      opacity: 1;
    }
  }
  .tab-x:active {
    background: color-mix(in srgb, var(--text) 12%, transparent);
  }
  @media (pointer: coarse) {
    .strip {
      height: 44px;
    }
    .tab {
      height: 38px;
    }
    .tab-x {
      width: 30px;
      height: 30px;
      margin-right: 3px;
    }
  }
</style>
