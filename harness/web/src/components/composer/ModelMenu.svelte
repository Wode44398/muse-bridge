<script lang="ts">
  // 型号菜单（输入框右下的型号胶囊呼出）：当前厂商的模型（单选）、思考深度（档位用官方原文 off / low / medium / high / max，
  // 跟 catalog 里逐个模型的支持面走），以及「切换模型服务…」——顶栏已经没有厂商按钮，换厂商的入口就在这里。
  // 选模型 / 选档位不关菜单（可以先挑模型再挑档位）；两者都只写全局配置（POST /api/config，后发的赢）。
  import { app, modelEfforts, providerModels, setEffort, setModel, vendorId } from "../../lib/state.svelte.ts";
  import { VENDORS } from "../../lib/theme.ts";
  import { haptic } from "../../lib/touch.ts";
  import Popover from "../ui/Popover.svelte";
  import MenuItem from "../ui/MenuItem.svelte";
  import MenuLabel from "../ui/MenuLabel.svelte";
  import MenuSep from "../ui/MenuSep.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import VendorLogo from "../brand/VendorLogo.svelte";
  import { usePane } from "../../lib/pane.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { anchor, onclose }: { anchor: HTMLElement; onclose: () => void } = $props();

  const models = $derived(app.info ? providerModels() : []);
  const efforts = $derived(app.info ? modelEfforts() : []);
  const effortLabels = $derived<Record<string, string>>(models.find((m: any) => m.id === app.config?.model)?.effortLabels ?? {});
  const effortOptions = $derived(efforts.map((lv) => ({ value: lv, label: effortLabels[lv] ?? lv })));
  const vid = $derived(vendorId());
  const vendorName = $derived(VENDORS[vid]?.name ?? "");

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

<Popover {anchor} {onclose} align="end" minWidth={264} label="模型与思考深度">
  {#if models.length}
    <MenuLabel text="模型" aside={vendorName} />
    {#each models as m (m.id)}
      <MenuItem label={m.label} description={m.note || undefined} checked={m.id === app.config?.model} onclick={() => pickModel(m.id)} />
    {/each}
  {/if}

  {#if efforts.length > 1}
    {#if models.length}<MenuSep />{/if}
    <MenuLabel text="思考深度" />
    <div class="eff">
      <Segmented size="sm" full label="思考深度" options={effortOptions} value={app.config?.thinking ?? "off"} onchange={pickEffort} />
    </div>
  {/if}

  {#if models.length || efforts.length > 1}<MenuSep />{/if}
  <MenuItem
    label="切换模型服务…"
    description={pane.chat.running ? "当前任务转入后台继续跑；切换后开启新对话" : "切换后开启新对话，历史会话保留各自的服务归属"}
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
