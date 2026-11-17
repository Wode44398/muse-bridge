<script lang="ts">
  // 从锚点按钮里「长」出来的面板：iOS 26 下拉按钮的展开 / 收起（按钮先融进一滴、液滴沿 J 形路径长成面板、内容从 0.7 放大淡入；
  // 收起时缩回按钮、按钮被「撞」一下），动作本体复用 bridge 的 ios27/MorphMenu（自定义内容模式），这里只管材质与接线。
  //  · 材质：iOS 27 液态玻璃（对页面实时折射；WebKit / Firefox 退回 CSS 磨砂），电脑与触屏一致；圆角触屏用 iOS 菜单的 34，
  //    电脑收到 24（鼠标场景的面板更紧凑）。
  //  · 一直挂着、只切 open：收起动画才放得完；调用方在第一次打开时再挂它即可。
  //  · 挂到 .hxroot：与 Popover 同一个挂载点（三栏各自是层叠上下文，挂在栏里会被兄弟栏盖住；玻璃要平铺在页面之上才采得到底）。
  //  · 返回键经浮层栈先关它；Esc 由 MorphMenu 自己接。
  import type { Component, Snippet } from "svelte";
  import { onMount, setContext } from "svelte";
  // MorphMenu 是 bridge 的组件（JS）：相对引用同一份源码，嵌进 bridge 时与 bridge 自己用的是同一个模块。
  // @ts-ignore —— JS 组件、没有类型声明；下面按用到的参数收窄
  import MorphMenuRaw from "../../../../../web/src/components/ios27/MorphMenu.svelte";
  const MorphMenu = MorphMenuRaw as unknown as Component<{
    open: boolean;
    anchor: HTMLElement | null | undefined;
    width: number;
    flat: boolean;
    radius: number;
    drift: number;
    title: string;
    class: string;
    onclose: () => void;
    children: Snippet;
  }, { refit: () => void }>;
  import { pushLayer } from "../../lib/layers.ts";
  import { app } from "../../lib/state.svelte.ts";

  let {
    open,
    anchor,
    onclose,
    width = 300,
    label = "",
    children,
  }: {
    open: boolean;
    anchor: HTMLElement | null | undefined;
    onclose: () => void;
    width?: number;
    label?: string;
    children: Snippet;
  } = $props();

  // 明暗：MorphMenu 从 ios27 上下文读 dark（玻璃配方、退路底色分明暗）。跟系统档时自己盯着系统切换
  const mq = matchMedia("(prefers-color-scheme: dark)");
  let sysDark = $state(mq.matches);
  $effect(() => {
    const on = () => (sysDark = mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  });
  const dark = $derived(app.appearance === "dark" || (app.appearance === "auto" && sysDark));
  // ink：面板里的 ios27 开关用墨色（开＝墨 / 深色档象牙，不用 iOS 绿）
  setContext("ios27", {
    get dark() {
      return dark;
    },
    ink: true,
  });

  // 内容换了（面板里切到另一页、列表变长变短）：按新的自然高度用弹簧改尺寸，菜单原地长高 / 缩短
  let menu: { refit?: () => void } | undefined = $state();
  export function refit() {
    menu?.refit?.();
  }

  // 交接给更大的窗口（型号菜单「添加服务」→ 模型中心）：rect() 给出面板此刻在屏幕上的矩形与圆角，让新窗口从这里长出来；
  // vanish() 把整块面板（玻璃、投影、内容）在新窗口盖上来的同时淡掉，随后照常收起——收起动画在看不见的状态下放完，
  // 胶囊照旧交接回来。下次打开时撤掉这层淡出。
  export function rect(): { x: number; y: number; w: number; h: number; r: number } | null {
    const clip = host?.querySelector<HTMLElement>(".mm-clip");
    const b = clip?.getBoundingClientRect();
    if (!b || !b.width || !b.height) return null;
    return { x: b.left, y: b.top, w: b.width, h: b.height, r: parseFloat(clip!.style.borderRadius) || (fine ? 24 : 34) };
  }
  let fadeAnim: Animation | null = null;
  export function vanish(ms = 140) {
    const root = host?.querySelector<HTMLElement>(".mm");
    if (!root?.animate) return;
    fadeAnim?.cancel();
    fadeAnim = root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" });
  }
  $effect(() => {
    if (!open) return;
    fadeAnim?.cancel();
    fadeAnim = null;
  });

  // 混合设备（触屏笔记本）按「有没有精确指针」判，与全站 hover 规则同口径
  const fine = matchMedia("(pointer: fine)").matches;

  let host: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!open) return;
    const release = pushLayer(onclose, { escape: false });
    return () => {
      release();
      // 焦点在面板里时收起（Esc、选完一项）：交还给锚点按钮，键盘用户不会掉到页面最顶上
      if (host && host.contains(document.activeElement)) anchor?.focus({ preventScroll: true });
    };
  });

  // 第一次挂上就要展开时（调用方在点开那一刻才挂它），MorphMenu 量尺寸、取可用范围必须在挪到 .hxroot 之后——
  // 挪之前它还在调用方的 DOM 里，量出来的高度与范围都是错的（第一次打开矮一截、朝错的方向长）。挂好、挪好再放行。
  let ready = $state(false);
  onMount(() => {
    const id = requestAnimationFrame(() => (ready = true));
    return () => cancelAnimationFrame(id);
  });

  function portal(node: HTMLElement) {
    const root = anchor?.closest(".hxroot") ?? document.querySelector(".hxroot");
    if (root && node.parentElement !== root) root.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

<div class="mp" class:dark bind:this={host} use:portal>
  <MorphMenu bind:this={menu} open={open && ready} {anchor} width={fine ? width : Math.min(width + 28, innerWidth - 24)} flat={false} radius={fine ? 24 : 0} drift={0} title={label} class="hx-mp" {onclose}>
    {@render children()}
  </MorphMenu>
</div>

<style>
  /* 不产生盒子：MorphMenu 的几层各带 z-index 平铺进宿主的层叠上下文（玻璃要采得到底下的页面） */
  .mp {
    display: contents;
    /* 自定义内容的字色：MorphMenu 读 --i-label；ios27 开关读 --i-accent（开）/ --i-fill1（关），都给纯色值（开关按颜色插值） */
    --i-label: var(--text);
    --i-accent: var(--accent);
    --i-fill1: var(--border2);
  }
  .mp :global(.hx-mp .mm-body) {
    font-family: var(--font-ui);
    font-size: var(--fs-base);
    line-height: var(--lh-ui);
  }
</style>
