<script lang="ts">
  // 用户消息：靠右的气泡（附件芯片在文字上方）。插话气泡上方多一行小标注「运行中插话」——
  // steer = 运行中插进去的一句，标一下，免得读历史时以为是新一轮任务（不整块改色）。
  //
  // U9：动作（复制、从这里改写）挂在气泡左侧、贴底，不占版面，不会让下面的内容跳。电脑悬停整行就亮；手机点一下气泡亮 /
  // 再点收（正在选字时不算点）。藏起来时只是透明 + 不接指针，照样在 Tab 顺序里——键盘聚焦到就亮（spec-A ⚠3：旧版用
  // visibility:hidden 藏，键盘根本到不了）。
  import { openSession, rewindAvailable, toast, type Item } from "../../lib/state.svelte.ts";
  import type { IconName } from "../../lib/icons.ts";
  import { fade, press } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import RecallChip from "./RecallChip.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t, tr } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  type UserItem = Extract<Item, { kind: "user" }>;

  let {
    item,
    actsOn = false,
    ontoggle,
    onrewind,
  }: { item: UserItem; actsOn?: boolean; ontoggle: () => void; onrewind: () => void } = $props();

  const text = $derived(item.text.trim());
  const canRewind = $derived(rewindAvailable() && Boolean(pane.chat.id) && !pane.chat.running && !item.steer);

  // 鼠标点气泡不切换（悬停已经亮了）；触屏 / 笔点一下切换
  let lastPointer = "";
  function onBubbleClick() {
    if (lastPointer === "mouse") return;
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    ontoggle();
  }
  function copy() {
    navigator.clipboard?.writeText(item.text).then(() => toast(t("已复制")));
  }
  const attIcon = (k: string): IconName => (k === "audio" ? "audio" : k === "image" ? "camera" : k === "folder" ? "folder" : "file");
  const attName = (p: string) => p.replace(/\/$/, "").split("/").pop() ?? p;
  // 引用的对话（把会话块拖进输入框发出的）：点一下打开那个对话；气泡本身的点按手势不跟着触发
  function openRef(e: MouseEvent, id: string) {
    e.stopPropagation();
    void openSession(id);
  }
</script>

<div class="user" class:on={actsOn}>
  {#if item.steer}
    <div class="steer"><span class="sdot" aria-hidden="true"></span>{t("运行中插话")}</div>
  {/if}
  <div class="bwrap">
    <!-- 气泡本身只是触屏的「点一下亮动作」手势；动作按钮本身键盘可达 -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="bubble" onpointerdown={(e) => (lastPointer = e.pointerType)} onclick={onBubbleClick}>
      {#if item.attachments?.length}
        <div class="atts">
          {#each item.attachments as a (a.path)}
            <span class="att" title={a.path}><Icon name={attIcon(a.kind)} size={13} /><span class="an">{attName(a.path)}</span></span>
          {/each}
        </div>
      {/if}
      {#if item.refs?.length}
        <div class="atts">
          {#each item.refs as r (r.id)}
            <button class="att ref" title={t("引用的对话：{title}（点开）", { title: tr(r.title) })} onclick={(e) => openRef(e, r.id)}>
              <Icon name="message" size={13} /><span class="an">{tr(r.title) || t("（空会话）")}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if text}<div class="text">{text}</div>{/if}
    </div>
    {#if text || canRewind}
      <div class="acts">
        {#if text}
          <button class="act" aria-label={t("复制")} title={t("复制")} onclick={copy} use:press={{ scale: 0.9 }}>
            <Icon name="copy" size={15} />
          </button>
        {/if}
        {#if canRewind}
          <button
            class="act"
            aria-label={t("从这里改写")}
            title={t("从这里改写：对话退回到这条消息之前，原话放回输入框，文件不动")}
            onclick={onrewind}
            use:press={{ scale: 0.9 }}
          >
            <Icon name="edit" size={15} />
          </button>
        {/if}
      </div>
    {/if}
  </div>
  <!-- N45：这一轮开跑时自动召回了哪些（直播里召回稍后才到，淡入） -->
  {#if item.recall?.length && !item.steer}
    <div in:fade><RecallChip items={item.recall} /></div>
  {/if}
</div>

<style>
  .user {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
  }
  .steer {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0 4px 5px 0;
    font-size: var(--fs-xs);
    line-height: 1.3;
    color: var(--text3);
  }
  .sdot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--live);
  }
  /* 气泡外包一层定位框：动作行挂在它左侧（right: 100%），宽度封顶 82% */
  .bwrap {
    position: relative;
    display: flex;
    min-width: 0;
    max-width: 82%;
  }
  .bubble {
    min-width: 0;
    max-width: 100%;
    padding: 10px 14px;
    border-radius: 18px;
    background: var(--user-bubble);
    color: var(--on-user-bubble);
    font-size: var(--fs-body);
    line-height: 1.6;
    overflow-wrap: break-word;
  }
  /* pre-wrap 只许挂在正文节点上——挂容器会把模板缩进的空白文本节点渲染成幽灵空行（气泡凭空厚一行的事故） */
  .text {
    white-space: pre-wrap;
  }
  .atts {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .atts + .text,
  .atts + .atts {
    margin-top: 8px;
  }
  .att {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 220px;
    padding: 3px 8px;
    border-radius: var(--r-sm);
    background: color-mix(in srgb, currentColor 8%, transparent);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.5;
  }
  /* 引用的对话：可以点开；标题用正文字体 */
  .ref {
    font-family: var(--font-ui);
    color: inherit;
    cursor: pointer;
    transition: background-color var(--t-fast) var(--ease);
  }
  .ref:active {
    background: color-mix(in srgb, currentColor 16%, transparent);
  }
  @media (hover: hover) {
    .ref:hover {
      background: color-mix(in srgb, currentColor 14%, transparent);
    }
  }
  .an {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .acts {
    position: absolute;
    right: 100%;
    bottom: 0;
    display: flex;
    gap: 2px;
    padding-right: 6px;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--t-fast) var(--ease);
  }
  .user.on .acts,
  .user:focus-within .acts {
    opacity: 1;
    pointer-events: auto;
  }
  .act {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    color: var(--text3);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .act:active {
    background: var(--surface3);
    color: var(--text);
  }
  @media (hover: hover) {
    .user:hover .acts {
      opacity: 1;
      pointer-events: auto;
    }
    .act:hover {
      background: var(--surface2);
      color: var(--text);
    }
  }
  @media (pointer: coarse) {
    /* 引用芯片只有一行字高：触屏上把可点区域上下各撑出 9px（凑够 40） */
    .ref {
      position: relative;
    }
    .ref::after {
      content: "";
      position: absolute;
      inset: -9px -2px;
    }
    .act {
      width: 40px;
      height: 40px;
      border-radius: 12px;
    }
    /* 手机上动作钮 40px：窄屏时给左侧留出两颗钮的位置，别被屏幕左缘裁掉 */
    .bwrap {
      max-width: min(82%, calc(100% - 92px));
    }
  }
</style>
