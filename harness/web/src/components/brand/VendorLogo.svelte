<script lang="ts">
  // 厂商品牌标（身份识别）。官方矢量 / 官方配色原样保留，颜色常量在 lib/theme.ts（VENDORS / LOGO_COLORS）。
  // mono = 单色，跟随 currentColor（会话列表小标、连接页）。未知 skin 退回 dimensio 标志。
  import { LOGO_CLAUDE, LOGO_DEEPSEEK, LOGO_GEMINI, LOGO_KIMI, LOGO_KIMI_DOT, LOGO_QWEN } from "../../lib/icons.ts";
  import { LOGO_COLORS, VENDORS } from "../../lib/theme.ts";
  import Mark from "./Mark.svelte";
  // Official favicon, vendored from https://mimo.mi.com/favicon.png (2026-09-21).
  import mimoLogo from "../../assets/mimo.png";

  let { skin, size = 24, mono = false }: { skin: string; size?: number; mono?: boolean } = $props();

  const uid = `vl${Math.random().toString(36).slice(2, 8)}`;
  const C = LOGO_COLORS;
  const tint = (id: string) => (mono ? "currentColor" : (VENDORS[id]?.color ?? "currentColor"));
</script>

<span class="vlogo" style="width:{size}px;height:{size}px" aria-hidden="true">
  {#if skin === "anthropic"}
    <svg viewBox="0 0 208 208" width={size} height={size}><path d={LOGO_CLAUDE} fill={tint("anthropic")} /></svg>
  {:else if skin === "openai"}
    <svg viewBox="0 0 24 24" width={size} height={size}><path d={LOGO_DEEPSEEK} fill={tint("openai")} /></svg>
  {:else if skin === "qwen"}
    <svg viewBox="0 0 24 24" width={size} height={size}>
      {#if mono}
        <path d={LOGO_QWEN} fill="currentColor" />
      {:else}
        <defs>
          <linearGradient id="{uid}-q" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
            <stop stop-color={C.qwen[0]} />
            <stop offset="1" stop-color={C.qwen[1]} />
          </linearGradient>
        </defs>
        <path d={LOGO_QWEN} fill="url(#{uid}-q)" />
      {/if}
    </svg>
  {:else if skin === "zhipu"}
    <svg viewBox="0 0 24 24" width={size} height={size}>
      {#if mono}
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6" />
        <path d="M4.6 15.2C8 12.4 14.4 9.4 21 10.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
      {:else}
        <defs>
          <linearGradient id="{uid}-z" x1="3" y1="20" x2="21" y2="4" gradientUnits="userSpaceOnUse">
            <stop stop-color={C.zhipu[0]} />
            <stop offset="1" stop-color={C.zhipu[1]} />
          </linearGradient>
        </defs>
        <circle cx="12" cy="12" r="10" fill="url(#{uid}-z)" />
        <path d="M2.6 14.6C7 11.2 15 8.2 21.4 9.9" fill="none" stroke={C.white} stroke-width="2.3" stroke-linecap="round" />
        <circle cx="12" cy="12" r="10" fill="none" stroke={C.white} stroke-opacity=".18" stroke-width="0.6" />
      {/if}
    </svg>
  {:else if skin === "kimi"}
    <svg viewBox="0 0 24 24" width={size} height={size}>
      {#if mono}
        <path d={LOGO_KIMI} fill="currentColor" />
        <path d={LOGO_KIMI_DOT} fill="currentColor" />
      {:else}
        <!-- 官方形象：黑圆角底 + 白 K + 蓝点；细内描边防融入深色背景 -->
        <rect x="0" y="0" width="24" height="24" rx="5.6" fill={C.kimiTile} />
        <g transform="translate(3.05 3.05) scale(0.746)">
          <path d={LOGO_KIMI} fill={C.white} />
          <path d={LOGO_KIMI_DOT} fill={C.kimiDot} />
        </g>
        <rect x="0.3" y="0.3" width="23.4" height="23.4" rx="5.4" fill="none" stroke={C.white} stroke-opacity=".16" stroke-width="0.6" />
      {/if}
    </svg>
  {:else if skin === "mimo"}
    <img src={mimoLogo} width={size} height={size} alt="" class="mimo" class:mono />
  {:else if skin === "gemini"}
    <svg viewBox="0 0 24 24" width={size} height={size}>
      {#if mono}
        <path d={LOGO_GEMINI} fill="currentColor" />
      {:else}
        <defs>
          <linearGradient id="{uid}-0" gradientUnits="userSpaceOnUse" x1="7" x2="11" y1="15.5" y2="12">
            <stop stop-color={C.geminiStops[0]} /><stop offset="1" stop-color={C.geminiStops[0]} stop-opacity="0" />
          </linearGradient>
          <linearGradient id="{uid}-1" gradientUnits="userSpaceOnUse" x1="8" x2="11.5" y1="5.5" y2="11">
            <stop stop-color={C.geminiStops[1]} /><stop offset="1" stop-color={C.geminiStops[1]} stop-opacity="0" />
          </linearGradient>
          <linearGradient id="{uid}-2" gradientUnits="userSpaceOnUse" x1="3.5" x2="17.5" y1="13.5" y2="12">
            <stop stop-color={C.geminiStops[2]} /><stop offset=".46" stop-color={C.geminiStops[2]} stop-opacity="0" />
          </linearGradient>
        </defs>
        <path d={LOGO_GEMINI} fill={tint("gemini")} />
        <path d={LOGO_GEMINI} fill="url(#{uid}-0)" />
        <path d={LOGO_GEMINI} fill="url(#{uid}-1)" />
        <path d={LOGO_GEMINI} fill="url(#{uid}-2)" />
      {/if}
    </svg>
  {:else}
    <Mark {size} />
  {/if}
</span>

<style>
  .vlogo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .vlogo svg {
    display: block;
  }
  .mimo {
    display: block;
    border-radius: 22%;
    box-shadow: 0 0 0 0.5px color-mix(in srgb, white 16%, transparent);
  }
  .mimo.mono {
    opacity: 0.8;
    filter: grayscale(1);
  }
</style>
