<script lang="ts">
  // 型号菜单（输入框右下的型号胶囊呼出）：当前厂商的模型（单选）、思考深度（档位用官方原文 off / low / medium / high / max，
  // 跟 catalog 里逐个模型的支持面走），以及「切换模型服务…」——顶栏已经没有厂商按钮，换厂商的入口就在这里。
  // 选模型 / 选档位不关菜单（可以先挑模型再挑档位）；两者都只写全局配置（POST /api/config，后发的赢）。
  // 自定义服务：目录里只有启用的对话型号（asr / tts 这类不进来）；型号多了（> 8）顶上出搜索框，id 带 vendor/ 前缀的（OpenRouter
  // 那种）按前缀分组；没有说明文字的型号给一行能力摘要「1M · 视觉 · 会思考」。
  import { app, modelEfforts, modelSupportsFast, providerModels, setEffort, setFast, setModel, vendorId, vendorInfo, vendorSwitchNote } from "../../lib/state.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import Popover from "../ui/Popover.svelte";
  import MenuItem from "../ui/MenuItem.svelte";
  import MenuLabel from "../ui/MenuLabel.svelte";
  import MenuSep from "../ui/MenuSep.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import Switch from "../ui/Switch.svelte";
  import VendorLogo from "../brand/VendorLogo.svelte";
  import TextField from "../ui/TextField.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { fmtTokens } from "../../lib/model-knowledge.ts";
  import { t, tc, tr } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { anchor, onclose }: { anchor: HTMLElement; onclose: () => void } = $props();

  const models = $derived(app.info ? providerModels() : []);
  const efforts = $derived(app.info ? modelEfforts() : []);
  const effortLabels = $derived<Record<string, string>>(models.find((m: any) => m.id === app.config?.model)?.effortLabels ?? {});
  // effortLabels 来自服务端 catalog：开关式档位写「关闭 / 开启」——那是开关的值（Off / On），不能走 tr() 的普通键（关闭 = Close）
  function effortText(label: string): string {
    if (label === "开启") return tc("开关", "开启"); // i18n-ignore（左边比对服务端数据）
    if (label === "关闭") return tc("开关", "关闭"); // i18n-ignore（左边比对服务端数据）
    return tr(label);
  }
  const effortOptions = $derived(efforts.map((lv) => ({ value: lv, label: effortLabels[lv] !== undefined ? effortText(effortLabels[lv]) : lv })));
  const vid = $derived(vendorId());
  // fast mode（参照 bridge 本体 Claude 分页）：只有支持的型号才露出开关；开关状态粘性——切去不支持的型号不清除，
  // 只是不显示、服务端也不发，切回来照旧开着。
  const fastOk = $derived(modelSupportsFast(app.config?.provider, app.config?.model));
  const fastOn = $derived(app.config?.fast === true);
  const vendorName = $derived(vendorInfo(vid).name);

  // 型号多了才有搜索；按 id 的 vendor/ 前缀分组（不带前缀的归在一起、排最前）
  let q = $state("");
  const searchable = $derived(models.length > 8);
  const shown = $derived(
    !q.trim() ? models : models.filter((m: any) => `${m.id} ${m.label ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const groups = $derived.by(() => {
    const out: { key: string; items: any[] }[] = [];
    for (const m of shown) {
      const key = typeof m.group === "string" ? m.group : "";
      let g = out.find((x) => x.key === key);
      if (!g) out.push((g = { key, items: [] }));
      g.items.push(m);
    }
    return out.sort((a, b) => (a.key ? 1 : 0) - (b.key ? 1 : 0));
  });
  // 去掉 vendor/ 前缀的显示名（分组标题已经写了是哪家）
  const shortLabel = (m: any) => {
    const label = String(m.label ?? m.id);
    return m.group && label.startsWith(m.group + "/") ? label.slice(m.group.length + 1) : label;
  };
  // 没有说明文字的型号（自定义服务的）：能力摘要
  function capsLine(m: any): string | undefined {
    if (m.note) return tr(m.note);
    const parts: string[] = [];
    if (m.ctx) parts.push(fmtTokens(m.ctx));
    if (m.image) parts.push(t("视觉"));
    if (m.alwaysThinks || (Array.isArray(m.efforts) && m.efforts.some((e: string) => e !== "off"))) parts.push(t("会思考"));
    return parts.length ? parts.join(" · ") : undefined;
  }

  function pickModel(id: string) {
    haptic("light");
    void setModel(id);
  }
  function pickEffort(lv: string) {
    haptic("light");
    void setEffort(lv);
  }
  function openVendors() {
    haptic("light");
    onclose();
    app.vendorMenu = true;
  }
</script>

<Popover {anchor} {onclose} align="end" minWidth={264} label={t("模型与思考深度")}>
  {#if models.length}
    <MenuLabel text={t("模型")} aside={vendorName} />
    {#if searchable}
      <div class="search"><TextField bind:value={q} size="sm" icon="search" label={t("搜索型号")} placeholder={t("搜索型号")} /></div>
    {/if}
    {#each groups as g (g.key)}
      {#if g.key}<div class="grp">{g.key}</div>{/if}
      {#each g.items as m (m.id)}
        <MenuItem label={tr(shortLabel(m))} description={capsLine(m)} checked={m.id === app.config?.model} onclick={() => pickModel(m.id)} />
      {/each}
    {:else}
      <p class="none">{t("没有匹配的型号")}</p>
    {/each}
  {/if}

  {#if efforts.length > 1}
    {#if models.length}<MenuSep />{/if}
    <MenuLabel text={t("思考深度")} />
    <div class="eff">
      <Segmented size="sm" full label={t("思考深度")} options={effortOptions} value={app.config?.thinking ?? "off"} onchange={pickEffort} />
    </div>
  {/if}

  {#if fastOk}
    <MenuSep />
    <div class="fast">
      <span class="fast-body">
        <span class="fast-label">Fast mode</span>
        <span class="fast-desc">{t("输出更快，按更高单价计费")}</span>
      </span>
      <Switch checked={fastOn} label="Fast mode" onchange={(v) => void setFast(v)} />
    </div>
  {/if}

  {#if models.length || efforts.length > 1}<MenuSep />{/if}
  <MenuItem
    label={t("切换模型服务…")}
    description={vendorSwitchNote(pane.chat)}
    onclick={openVendors}
  >
    {#snippet leading()}<VendorLogo skin={vid} size={17} />{/snippet}
  </MenuItem>
</Popover>

<style>
  .search {
    padding: 2px 8px 6px;
  }
  .grp {
    padding: 8px 12px 2px;
    font-size: var(--fs-xs);
    color: var(--text3);
    font-family: var(--font-mono);
  }
  .none {
    margin: 4px 12px 8px;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .eff {
    padding: 2px 8px 8px;
  }
  /* 与 MenuItem 两行版同一套尺寸：内边距 / 字号 / 说明行配色 */
  .fast {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
  }
  .fast-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .fast-label {
    color: var(--text);
    font-size: var(--fs-base);
    line-height: 1.35;
  }
  .fast-desc {
    color: var(--text3);
    font-size: var(--fs-sm);
    line-height: 1.35;
  }
</style>
