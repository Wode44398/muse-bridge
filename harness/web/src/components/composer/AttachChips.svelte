<script lang="ts">
  // 输入框里的附件（文本上方一排，与 Claude 分页输入栏同一种读法）：
  //  · 图片 / 视频 = 60 见方的小图（视频取第 0.1 秒那一帧，左下角一枚 ▶ + 时长）；点一下进预览（宿主的统一查看器，
  //    画廊只含输入框里这几张图 / 视频，从点的那张开始；独立运行时图片进灯箱、视频新标签页）
  //  · 其它文件 = 同高的两行卡：类型小标（扩展名）· 名字 · 副行（类型 · 大小）；能预览的（pdf / 文档 / 音频）点开同样进查看器
  //  · 文件夹、引用的对话 = 同一种卡，换图标与副行；不能点开
  //  · 正在上传的：散文件各一张占位（图片 / 视频先用本机那份画出来、压暗 + 转圈），文件夹一张（已传 / 总数）
  // chat.attachments 是对外契约——宿主（bridge 的全局拖放）会整体赋值 app.chat 的，这里只按路径渲染、只删不改。文件夹以 / 结尾。
  // 缩略图优先用本机那份 blob（attachLocal：这台设备刚传的），没有就走 dock 文件接口；画不出来（格式不支持、取不到）退回文件卡。
  // 进场浮起、挪位 flip、退场淡出；删除 × 桌面上悬停才浮现，触屏常显，键盘也能到。
  import { flip } from "svelte/animate";
  import { attachLocal, attachUp, chatKey, dropLocal } from "../../lib/attach.svelte.ts";
  import { attachKind, extLabel, fmtBytes, previewable } from "../../lib/attach-kind.ts";
  import { openMedia, type HostMediaItem } from "../../lib/open-media.ts";
  import * as api from "../../lib/api.ts";
  import { haptic } from "../../lib/touch.ts";
  import { fade, reducedMotion, rise, SPRING_SOFT } from "../../lib/motion.ts";
  import type { IconName } from "../../lib/icons.ts";
  import Icon from "../ui/Icon.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t, tr } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  // 宿主整体赋值时不保证去重；keyed each 遇到重复 key 会直接抛错
  const paths = $derived([...new Set(pane.chat.attachments)]);
  const pending = $derived(attachUp.items.filter((x) => x.chat === chatKey(pane.chat)));

  let broken = $state<string[]>([]);
  let dur = $state<Record<string, string>>({});

  const baseName = (p: string) => p.replace(/\/$/, "").split("/").pop() || p;
  const srcOf = (p: string) => attachLocal[p]?.url ?? api.dockFileUrl(pane.chat.id ? { chatId: pane.chat.id } : {}, p);
  const thumbOf = (p: string) => (broken.includes(p) ? null : previewable(p));
  function iconOf(p: string): IconName {
    const k = attachKind(p);
    return k === "folder" ? "folder" : k === "audio" ? "audio" : k === "image" ? "camera" : "file";
  }
  function subOf(p: string): string {
    const k = attachKind(p);
    if (k === "folder") return t("文件夹");
    const size = attachLocal[p]?.size;
    const kind = extLabel(p) || t("文件");
    return size != null ? `${kind} · ${fmtBytes(size)}` : kind;
  }
  function fmtDur(s: number): string {
    if (!isFinite(s) || s <= 0) return "";
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
  }
  function onMeta(p: string, e: Event) {
    const v = e.currentTarget as HTMLVideoElement;
    dur = { ...dur, [p]: fmtDur(v.duration) };
  }
  function onBroken(p: string) {
    if (!broken.includes(p)) broken = [...broken, p];
  }

  function remove(p: string) {
    haptic("light");
    pane.chat.attachments = pane.chat.attachments.filter((x) => x !== p);
    dropLocal(p);
  }
  // 预览：小图 / 视频按输入框里的顺序成一个画廊；文件单独开
  function mediaOf(p: string): HostMediaItem {
    const k = attachKind(p);
    return { key: "att:" + p, src: srcOf(p), name: baseName(p), kind: k === "image" || k === "video" || k === "audio" ? k : "file" };
  }
  function preview(p: string, el: Element | null) {
    haptic("light");
    if (thumbOf(p)) {
      const list = paths.filter((x) => thumbOf(x));
      openMedia(list.map(mediaOf), Math.max(0, list.indexOf(p)), el);
    } else openMedia([mediaOf(p)], 0, el);
  }

  // 引用会话的卡（把会话块拖进输入框）：标题太长截尾，全称在悬停提示里
  const shortTitle = (s: string) => (s.length > 22 ? `${s.slice(0, 21)}…` : s) || t("（空会话）");
  function removeRef(id: string) {
    haptic("light");
    pane.chat.refs = pane.chat.refs.filter((r) => r.id !== id);
  }
  const moveMs = reducedMotion() ? 0 : 300;
</script>

<div class="chips">
  {#each paths as p (p)}
    {@const th = thumbOf(p)}
    <div
      class="att"
      class:tile={th}
      title={p}
      animate:flip={{ duration: moveMs, easing: SPRING_SOFT.ease }}
      in:rise={{ y: 4, scale: 0.96 }}
      out:fade={{ duration: 140 }}
    >
      {#if th}
        <button class="hit" aria-label={t("预览 {name}", { name: baseName(p) })} onclick={(e) => preview(p, e.currentTarget.firstElementChild)}>
          {#if th === "image"}
            <img src={srcOf(p)} alt="" decoding="async" draggable="false" onerror={() => onBroken(p)} />
          {:else}
            <video src={`${srcOf(p)}#t=0.1`} muted playsinline preload="metadata" onloadedmetadata={(e) => onMeta(p, e)} onerror={() => onBroken(p)}></video>
            <span class="vbadge"><Icon name="play" size={9} stroke={0} />{#if dur[p]}<span>{dur[p]}</span>{/if}</span>
          {/if}
        </button>
      {:else}
        {@const k = attachKind(p)}
        {@const ext = k === "folder" ? "" : extLabel(p)}
        <button class="hit row" disabled={k === "folder"} aria-label={k === "folder" ? baseName(p) : t("预览 {name}", { name: baseName(p) })} onclick={(e) => preview(p, e.currentTarget)}>
          <span class="ico" class:ext={Boolean(ext)}>{#if ext}{ext}{:else}<Icon name={iconOf(p)} size={17} />{/if}</span>
          <span class="col">
            <span class="name">{baseName(p)}</span>
            <span class="sub">{subOf(p)}</span>
          </span>
        </button>
      {/if}
      <button class="x" aria-label={t("移除附件")} title={t("移除")} onclick={() => remove(p)}>
        <Icon name="close" size={10} stroke={2.4} />
      </button>
    </div>
  {/each}
  {#each pane.chat.refs as r (r.id)}
    <div
      class="att"
      title={t("引用对话：{title}", { title: tr(r.title) })}
      animate:flip={{ duration: moveMs, easing: SPRING_SOFT.ease }}
      in:rise={{ y: 4, scale: 0.96 }}
      out:fade={{ duration: 140 }}
    >
      <span class="hit row">
        <span class="ico"><Icon name="message" size={17} /></span>
        <span class="col">
          <span class="name ui">{shortTitle(tr(r.title))}</span>
          <span class="sub">{t("引用对话")}</span>
        </span>
      </span>
      <button class="x" aria-label={t("移除引用")} title={t("移除")} onclick={() => removeRef(r.id)}>
        <Icon name="close" size={10} stroke={2.4} />
      </button>
    </div>
  {/each}
  {#each pending as u (u.id)}
    <div class="att up" class:tile={Boolean(u.url)} role="status" in:rise={{ y: 4, scale: 0.96 }} out:fade={{ duration: 120 }}>
      {#if u.url}
        <span class="hit">
          {#if u.kind === "video"}<video src={`${u.url}#t=0.1`} muted playsinline preload="metadata"></video>{:else}<img src={u.url} alt="" draggable="false" />{/if}
          <span class="spin" aria-label={t("上传中…")}></span>
        </span>
      {:else}
        <span class="hit row">
          <span class="ico"><span class="spin small"></span></span>
          <span class="col">
            <span class="name">{u.name}</span>
            <span class="sub">{u.kind === "folder" ? t("上传中 {done}/{total}", { done: u.done, total: u.total }) : t("上传中…")}</span>
          </span>
        </span>
      {/if}
    </div>
  {/each}
</div>

<style>
  .chips {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 4px 2px 10px;
  }
  /* 手机：一行横着滑（多了不往上堆高输入框），滑到边上按项对齐；两头不留滚动条 */
  @media (max-width: 599px) {
    .chips {
      flex-wrap: nowrap;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scroll-snap-type: x proximity;
      scrollbar-width: none;
      margin: 0 -10px 0 -10px;
      padding: 4px 10px 10px;
    }
    .chips::-webkit-scrollbar {
      display: none;
    }
    .att {
      scroll-snap-align: start;
      scroll-margin-left: 10px;
    }
  }
  /* 一项：小图是 60 见方，其它是同高的两行卡（最宽 240） */
  .att {
    position: relative;
    flex: none;
    height: 60px;
    max-width: min(240px, 100%);
    border-radius: 12px;
    background: var(--surface2);
    box-shadow: inset 0 0 0 1px var(--border);
    color: var(--text);
  }
  .att.tile {
    width: 60px;
    overflow: hidden;
  }
  .hit {
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border-radius: inherit;
    text-align: left;
    color: inherit;
  }
  button.hit {
    cursor: zoom-in;
  }
  button.hit.row {
    cursor: pointer;
  }
  button.hit:disabled {
    cursor: default;
  }
  .hit:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .tile img,
  .tile video {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    pointer-events: none;
    -webkit-touch-callout: none;
  }
  /* 小图上压一圈内描线：浅色图片的边不会化进卡底 */
  .tile::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent);
    pointer-events: none;
  }
  .vbadge {
    position: absolute;
    left: 5px;
    bottom: 5px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 16px;
    padding: 0 5px 0 4px;
    border-radius: 8px;
    background: rgba(18, 16, 14, 0.58);
    color: #fff;
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .vbadge :global(svg) {
    fill: currentColor;
  }

  /* 两行卡：类型小标 + 名字 / 副行 */
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 30px 0 10px;
    box-sizing: border-box;
  }
  .ico {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 9px;
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--border);
    color: var(--text2);
  }
  .ico.ext {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--text2);
  }
  .col {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
    line-height: 1.3;
    color: var(--text);
  }
  .sub {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-xs);
    line-height: 1.3;
    color: var(--text3);
    font-variant-numeric: tabular-nums;
  }
  @media (hover: hover) {
    button.hit.row:not(:disabled):hover .name {
      text-decoration: underline;
      text-decoration-color: var(--border2);
      text-underline-offset: 3px;
    }
    button.hit:not(.row):hover img,
    button.hit:not(.row):hover video {
      filter: brightness(0.94);
    }
  }

  /* 删除：右上角一枚小圆钮（小图上是压在图上的深色圆点，卡上是淡底） */
  .x {
    position: absolute;
    top: 5px;
    right: 5px;
    z-index: 1;
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    color: var(--text2);
    background: color-mix(in srgb, var(--text) 9%, transparent);
    transition:
      opacity var(--t-fast) var(--ease),
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .tile .x {
    color: #fff;
    background: rgba(18, 16, 14, 0.6);
  }
  .x::after {
    content: "";
    position: absolute;
    inset: -7px;
  }
  @media (hover: hover) {
    .x {
      opacity: 0;
    }
    .att:hover .x,
    .att:focus-within .x {
      opacity: 1;
    }
    .x:hover {
      color: var(--text);
      background: color-mix(in srgb, var(--text) 16%, transparent);
    }
    .tile .x:hover {
      color: #fff;
      background: rgba(18, 16, 14, 0.82);
    }
  }

  /* 引用的对话不是文件：名字用正文字体（文件名本来也是正文字体，这里只为与以后的等宽区分留口） */
  .name.ui {
    font-family: var(--font-ui);
  }

  /* 上传中：小图压暗、中间一枚转圈；卡的类型位换成转圈 */
  .up .hit {
    cursor: default;
  }
  .up.tile img,
  .up.tile video {
    opacity: 0.5;
  }
  .spin {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 18px;
    height: 18px;
    margin: -9px 0 0 -9px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: #fff;
    animation: att-spin 0.8s linear infinite;
  }
  .spin.small {
    position: static;
    width: 14px;
    height: 14px;
    margin: 0;
    border-color: var(--border2);
    border-top-color: var(--text2);
  }
  @keyframes att-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation-duration: 2.4s;
    }
  }
</style>
