<script lang="ts">
  // 空态首屏：标志出场（绕出整圆 → 竖线贯穿 → 转过 90° 躺平成水面）、宋体的时段问候。
  // 以前问候下面还有一行「项目 · 厂商 · 型号」——顶栏已经写着项目、输入框的型号胶囊已经写着型号（换厂商在它菜单的最后一项），
  // 同一屏各出现两遍（09-26：碎片化、冗余），去掉了。
  // 提示按优先级只出一条：连不上 > App 太旧 > 服务端太旧 > 没填 Key。
  // 换了厂商（dimensio-pulse）标志重演一遍入场——空间本身在应答。
  import { onMount } from "svelte";
  import { app, vendorId, vendorInfo } from "../../lib/state.svelte.ts";
  import { greeting } from "../../lib/theme.ts";
  import { rise } from "../../lib/motion.ts";
  import { t } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";
  import Mark from "../brand/Mark.svelte";

  const vid = $derived(vendorId());
  const vendor = $derived(vendorInfo(vid));
  const hasKey = $derived(Boolean(app.config?.hasKey));

  let replay = $state(0);
  onMount(() => {
    const on = () => replay++;
    window.addEventListener("dimensio-pulse", on);
    return () => window.removeEventListener("dimensio-pulse", on);
  });
</script>

<div class="hero">
  <div class="stack">
    {#key replay}
      <div class="mark"><Mark size={100} intro /></div>
    {/key}
    <h1 in:rise={{ y: 10, delay: 120 }}>{greeting()}</h1>
    {#if !app.config && !app.connError}
      <p class="connecting" in:rise={{ y: 8, delay: 200 }}>{t("正在连接…")}</p>
    {/if}

    {#if app.connError}
      <button class="note err" in:rise={{ y: 6, delay: 260 }} onclick={() => (app.sheet = "settings")}>
        <Icon name="wifiOff" size={15} />
        <span>{t("连不上服务器，检查连接设置")}</span>
        <Icon name="chevronR" size={14} />
      </button>
    {:else if app.compat?.clientTooOld}
      <p class="note err" role="alert" in:rise={{ y: 6, delay: 260 }}><Icon name="alert" size={15} /><span>{t("App 版本过旧，服务端已不再支持，请更新到最新版")}</span></p>
    {:else if app.compat?.serverTooOld}
      <p class="note" role="status" in:rise={{ y: 6, delay: 260 }}><Icon name="info" size={15} /><span>{t("服务端版本较旧，部分功能可能用不了，请更新服务端")}</span></p>
    {:else if app.config && !hasKey}
      <button class="note" in:rise={{ y: 6, delay: 260 }} onclick={() => (app.sheet = "settings")}>
        <Icon name="key" size={15} />
        <span>{t("先在设置里填 {name} 的 API Key", { name: vendor?.name ?? "" })}</span>
        <Icon name="chevronR" size={14} />
      </button>
    {/if}
  </div>
</div>

<style>
  .hero {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 12px 24px 7vh;
    overflow-y: auto;
  }
  .stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    width: 100%;
    max-width: 520px;
  }
  .mark {
    color: var(--text);
    margin-bottom: 18px;
  }
  /* 问候用宋体（与 bridge 官网标题同一款字）：展示文字，只此一处 */
  h1 {
    margin: 0;
    font-family: var(--font-serif);
    font-size: var(--fs-3xl);
    font-weight: 600;
    letter-spacing: 0.06em;
    line-height: 1.2;
    color: var(--text);
  }
  /* 英文问候：宋体字距是给汉字留的，拉丁字母不加字距 */
  h1:lang(en) {
    letter-spacing: normal;
  }
  .connecting {
    margin: 12px 0 0;
    font-size: var(--fs-md);
    color: var(--text3);
  }
  .note {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 22px 0 0;
    padding: 9px 14px;
    border-radius: 12px;
    font-size: var(--fs-md);
    line-height: 1.5;
    color: var(--text2);
    background: var(--surface2);
    text-align: left;
  }
  .note.err {
    color: var(--err);
    background: color-mix(in srgb, var(--err) 9%, transparent);
  }
  @media (hover: hover) {
    button.note:hover {
      background: var(--surface3);
    }
    button.note.err:hover {
      background: color-mix(in srgb, var(--err) 14%, transparent);
    }
  }
  @media (max-width: 699px) {
    .hero {
      padding-bottom: 4vh;
    }
    h1 {
      font-size: 28px;
    }
  }
</style>
