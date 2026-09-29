<script lang="ts">
  // 附件芯片（输入框里、文本上方一排）：chat.attachments 是对外契约——宿主（bridge 的全局拖放）会整体赋值 app.chat 的，
  // 这里只按路径渲染、只删不改。文件夹以 / 结尾。名字太长时截中间（保住扩展名），全路径放在悬停提示里。
  // 进场浮起、挪位 flip、退场淡出；删除 × 桌面上悬停才浮现（占位不变、不跳），触屏常显，键盘也能到。
  import { flip } from "svelte/animate";
  import { attachUp } from "../../lib/attach.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import { fade, reducedMotion, rise, SPRING_SOFT } from "../../lib/motion.ts";
  import type { IconName } from "../../lib/icons.ts";
  import Icon from "../ui/Icon.svelte";
  import Mark from "../brand/Mark.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t, tr } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  // 宿主整体赋值时不保证去重；keyed each 遇到重复 key 会直接抛错
  const paths = $derived([...new Set(pane.chat.attachments)]);

  const IMG = /\.(?:png|jpe?g|webp|gif|heic|heif)$/i;
  function iconOf(p: string): IconName {
    if (p.endsWith("/")) return "folder";
    return IMG.test(p) ? "camera" : "file";
  }
  function shortName(p: string): string {
    const name = p.replace(/\/$/, "").split("/").pop() || p;
    if (name.length <= 24) return name;
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
    const stem = name.slice(0, name.length - ext.length);
    return `${stem.slice(0, 12)}…${stem.slice(-5)}${ext}`;
  }
  function remove(p: string) {
    haptic("light");
    pane.chat.attachments = pane.chat.attachments.filter((x) => x !== p);
  }
  // 引用会话的芯片（把会话块拖进输入框）：标题太长截尾，全称在悬停提示里
  const shortTitle = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s) || t("（空会话）");
  function removeRef(id: string) {
    haptic("light");
    pane.chat.refs = pane.chat.refs.filter((r) => r.id !== id);
  }
  const moveMs = reducedMotion() ? 0 : 300;
</script>

<div class="chips">
  {#each paths as p (p)}
    <span
      class="chip"
      title={p}
      animate:flip={{ duration: moveMs, easing: SPRING_SOFT.ease }}
      in:rise={{ y: 4, scale: 0.96 }}
      out:fade={{ duration: 140 }}
    >
      <span class="ic"><Icon name={iconOf(p)} size={14} /></span>
      <span class="name">{shortName(p)}</span>
      <button class="x" aria-label={t("移除附件")} title={t("移除")} onclick={() => remove(p)}>
        <Icon name="close" size={12} stroke={2} />
      </button>
    </span>
  {/each}
  {#each pane.chat.refs as r (r.id)}
    <span
      class="chip ref"
      title={t("引用对话：{title}", { title: tr(r.title) })}
      animate:flip={{ duration: moveMs, easing: SPRING_SOFT.ease }}
      in:rise={{ y: 4, scale: 0.96 }}
      out:fade={{ duration: 140 }}
    >
      <span class="ic"><Icon name="message" size={14} /></span>
      <span class="name">{shortTitle(tr(r.title))}</span>
      <button class="x" aria-label={t("移除引用")} title={t("移除")} onclick={() => removeRef(r.id)}>
        <Icon name="close" size={12} stroke={2} />
      </button>
    </span>
  {/each}
  {#if attachUp.active && pane.focused}
    <!-- 整句一个键；数字仍放进 .num（在译文里找到它的位置再拆开） -->
    {@const upN = String(attachUp.active)}
    {@const upText = t("上传中 {n} 个…", { n: attachUp.active })}
    {@const upAt = upText.indexOf(upN)}
    <span class="chip up" role="status" in:rise={{ y: 4 }} out:fade={{ duration: 140 }}>
      <Mark size={14} live />
      <span class="name">{upText.slice(0, upAt)}<span class="num">{upN}</span>{upText.slice(upAt + upN.length)}</span>
    </span>
  {/if}
</div>

<style>
  .chips {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 2px 2px 8px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    max-width: 100%;
    padding: 0 4px 0 10px;
    border-radius: 10px;
    background: var(--surface2);
    color: var(--text2);
    font-size: var(--fs-sm);
  }
  .ic {
    display: inline-flex;
    flex: none;
    color: var(--text3);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    color: var(--text);
  }
  .x {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 7px;
    color: var(--text3);
    transition:
      opacity var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      background-color var(--t-fast) var(--ease);
  }
  .x:active {
    background: var(--surface3);
  }
  @media (hover: hover) {
    .x {
      opacity: 0;
    }
    .chip:hover .x,
    .x:focus-visible {
      opacity: 1;
    }
    .x:hover {
      color: var(--text);
      background: var(--surface3);
    }
  }
  @media (pointer: coarse) {
    .x::after {
      content: "";
      position: absolute;
      inset: -6px;
    }
  }
  /* 引用的对话不是文件：名字用正文字体 */
  .ref .name {
    font-family: var(--font-ui);
  }
  .up {
    padding-right: 12px;
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--border2);
  }
  .up .name {
    font-family: var(--font-ui);
    color: var(--text3);
  }
  .num {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
</style>
