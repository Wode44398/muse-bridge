<script lang="ts">
  // 发送键：34px 墨色圆钮。空闲 = 发送（↑）；运行中有字 = 插话（↵：插进正在跑的这一轮，下一步读到）；
  // 这段话要落到停着的卡上 = 回应卡片（↑，卡在上面）。两枚图形叠放，↑ 往左转成 ↵（弹簧，只动 transform / opacity，不闪）。
  // 空的时候变淡、不能点；按下缩一点、松手弹回。停止键不在这里（U1：挪到了对话流的活动行——以前插话一发出，
  // 这个键原位变成停止键，多点一下整轮就没了）。
  // 按下反馈用自己的 pointer 状态而不是 press 动作：press 松手后会把行内 transition 换成只剩 transform，
  // 这颗钮的变淡 / 回弹过渡就都没了。
  import Icon from "../ui/Icon.svelte";

  let {
    kind,
    disabled,
    label,
    title,
    onclick,
  }: {
    kind: "send" | "steer" | "reply";
    disabled: boolean;
    label: string;
    title?: string;
    onclick: () => void;
  } = $props();

  let down = $state(false);
  const release = () => (down = false);
</script>

<button
  class="send"
  class:steer={kind === "steer"}
  class:down
  {disabled}
  aria-label={label}
  {title}
  onclick={() => onclick()}
  onpointerdown={(e) => {
    if (e.button <= 0 && !disabled) down = true;
  }}
  onpointerup={release}
  onpointerleave={release}
  onpointercancel={release}
>
  <span class="disc" aria-hidden="true">
    <span class="g up"><Icon name="send" size={17} stroke={2.2} /></span>
    <span class="g ret">
      <!-- ↵（corner-down-left，Lucide 同款几何）：icons.ts 里还没有这枚，先就地画 -->
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 4v7a4 4 0 0 1-4 4H4M9 10l-5 5 5 5" />
      </svg>
    </span>
  </span>
</button>

<style>
  .send {
    position: relative;
    flex: none;
    width: 34px;
    height: 34px;
    border-radius: 50%;
  }
  .disc {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: var(--primary);
    color: var(--on-primary);
    transition:
      opacity var(--t-med) var(--ease),
      transform var(--t-spring-pop, 560ms) var(--spring-pop, var(--ease-out)),
      background-color var(--t-fast) var(--ease);
  }
  /* 空 / 冷却中：变淡、略缩；一有字就弹回原样（弹簧） */
  .send:disabled .disc {
    opacity: 0.26;
    transform: scale(0.9);
    transition:
      opacity var(--t-med) var(--ease),
      transform var(--t-med) var(--ease-out);
  }
  .down .disc {
    transform: scale(0.88);
    transition: transform 90ms var(--ease);
  }
  @media (hover: hover) {
    .send:not(:disabled):hover .disc {
      background: color-mix(in srgb, var(--primary) 86%, var(--bg));
    }
  }

  .g {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition:
      transform var(--t-spring, 500ms) var(--spring, var(--ease-out)),
      opacity var(--t-fast) var(--ease);
  }
  .g svg {
    display: block;
  }
  /* ↑ 往左转 90° 退隐，↵ 从「朝上」的位置转回来：看上去是同一支箭头拐了个弯 */
  .ret {
    opacity: 0;
    transform: rotate(90deg) scale(0.7);
  }
  .steer .up {
    opacity: 0;
    transform: rotate(-90deg) scale(0.7);
  }
  .steer .ret {
    opacity: 1;
    transform: none;
  }

  /* 触屏：看着 34，点得到 42 */
  @media (pointer: coarse) {
    .send::after {
      content: "";
      position: absolute;
      inset: -4px;
      border-radius: 50%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .disc,
    .send:disabled .disc,
    .down .disc {
      transform: none;
      transition: opacity 1ms linear;
    }
    .g,
    .ret,
    .steer .up {
      transform: none;
      transition: opacity 1ms linear;
    }
  }
</style>
