<script lang="ts">
  // 型号菜单（输入框右下的型号胶囊呼出）：当前厂商的模型（单选）、思考深度（档位用官方原文 off / low / medium / high / max，
  // 跟 catalog 里逐个模型的支持面走），以及「切换模型服务…」——顶栏已经没有厂商按钮，换厂商的入口就在这里。
  // 选模型 / 选档位不关菜单（可以先挑模型再挑档位）；两者都只写全局配置（POST /api/config，后发的赢）。
  import { app, modelEfforts, providerModels, setEffort, setModel, vendorId, vendorInfo } from "../../lib/state.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import Popover from "../ui/Popover.svelte";
  import MenuItem from "../ui/MenuItem.svelte";
  import MenuLabel from "../ui/MenuLabel.svelte";
  import MenuSep from "../ui/MenuSep.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import VendorLogo from "../brand/VendorLogo.svelte";
  import { usePane } from "../../lib/pane.ts";
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
  const vendorName = $derived(vendorInfo(vid).name);

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
    {#each models as m (m.id)}
      <MenuItem label={tr(m.label)} description={m.note ? tr(m.note) : undefined} checked={m.id === app.config?.model} onclick={() => pickModel(m.id)} />
    {/each}
  {/if}

  {#if efforts.length > 1}
    {#if models.length}<MenuSep />{/if}
    <MenuLabel text={t("思考深度")} />
    <div class="eff">
      <Segmented size="sm" full label={t("思考深度")} options={effortOptions} value={app.config?.thinking ?? "off"} onchange={pickEffort} />
    </div>
  {/if}

  {#if models.length || efforts.length > 1}<MenuSep />{/if}
  <MenuItem
    label={t("切换模型服务…")}
    description={pane.chat.running ? t("当前任务转入后台继续跑；切换后开启新对话") : t("切换后开启新对话，历史会话保留各自的服务归属")}
    onclick={openVendors}
  >
    {#snippet leading()}<VendorLogo skin={vid} size={17} />{/snippet}
  </MenuItem>
</Popover>

<style>
  .eff {
    padding: 2px 8px 8px;
  }
</style>
