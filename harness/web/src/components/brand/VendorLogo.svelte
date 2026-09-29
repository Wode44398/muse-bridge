<script lang="ts">
  // 厂商品牌标（身份识别）。官方矢量 / 官方配色原样保留，颜色常量在 lib/theme.ts（VENDORS / LOGO_COLORS）。
  // mono = 单色，跟随 currentColor（会话列表小标、连接页）。未知 skin 退回 dimensio 标志。
  import { LOGO_CLAUDE, LOGO_DEEPSEEK, LOGO_GEMINI, LOGO_GLM, LOGO_KIMI, LOGO_KIMI_DOT, LOGO_QWEN } from "../../lib/icons.ts";
  import { LOGO_COLORS, VENDORS } from "../../lib/theme.ts";
  import Mark from "./Mark.svelte";
  import Icon from "../ui/Icon.svelte";
  import { isCustomVendor, vendorInfo } from "../../lib/state.svelte.ts";
  // Official favicon, vendored from https://mimo.mi.com/favicon.png (2026-09-21).
  import mimoLogo from "../../assets/mimo.png";
  import { t } from "../../lib/i18n.ts";

  let { skin, size = 24, mono = false }: { skin: string; size?: number; mono?: boolean } = $props();

  const uid = `vl${Math.random().toString(36).slice(2, 8)}`;
  const C = LOGO_COLORS;
  const tint = (id: string) => (mono ? "currentColor" : (VENDORS[id]?.color ?? "currentColor"));
  // 自定义服务没有官方标：用备注的第一个字做字块（墨底纸字，深色档自动反相）；删掉了的只剩一枚插头
  const custom = $derived(isCustomVendor(skin) ? vendorInfo(skin) : null);
  // 「已删除」是 vendorInfo 给的占位公司名（这里只拿来比较）；vendorInfo 用 t() 出这个值，英文界面下比较的是译文
  const deleted = (c: string) => c === "已删除" || c === t("已删除"); // i18n-ignore
  const initial = $derived(custom && !deleted(custom.company) ? (Array.from(custom.name.trim())[0] ?? "").toUpperCase() : "");
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
    {#if mono}
      <svg viewBox="4.5 4.5 21 21" width={size} height={size}><path d={LOGO_GLM} fill="currentColor" /></svg>
    {:else}
      <!-- 官方形象：#2D2D2D 圆角底 + 白 Z；细内描边防融入深色背景 -->
      <svg viewBox="1.49 1.49 27.02 27.02" width={size} height={size}>
        <rect x="1.49" y="1.49" width="27.02" height="27.02" rx="4" fill={C.zhipuTile} />
        <path d={LOGO_GLM} fill={C.white} />
        <rect x="1.8" y="1.8" width="26.4" height="26.4" rx="3.7" fill="none" stroke={C.white} stroke-opacity=".16" stroke-width="0.6" />
      </svg>
    {/if}
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
  {:else if custom}
    {#if initial}
      <svg viewBox="0 0 24 24" width={size} height={size} class="mono-glyph" class:mono>
        {#if mono}
          <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="5" fill="none" stroke="currentColor" stroke-width="1.7" />
        {:else}
          <rect x="0" y="0" width="24" height="24" rx="5.6" class="tile" />
        {/if}
        <text x="12" y="12.6" text-anchor="middle" dominant-baseline="central">{initial}</text>
      </svg>
    {:else}
      <Icon name="plug" size={Math.round(size * 0.86)} />
    {/if}
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
  .mono-glyph text {
    font-family: var(--font-ui);
    font-size: 12.5px;
    font-weight: 600;
    fill: var(--bg);
  }
  .mono-glyph.mono text {
    font-size: 11px;
    fill: currentColor;
  }
  .mono-glyph .tile {
    fill: var(--text);
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
