<script lang="ts">
  // 快照的操作菜单（右键快照那一块 / 行尾 ⋯）：存为工作空间、新建快照。
  import type { SessionMeta } from "../../../lib/state.svelte.ts";
  import Popover from "../../ui/Popover.svelte";
  import MenuItem from "../../ui/MenuItem.svelte";
  import MenuSep from "../../ui/MenuSep.svelte";
  import { t } from "../../../lib/i18n.ts";

  let {
    anchor,
    quickSession,
    quickBusy,
    onclose,
    onsave,
    onnew,
  }: {
    anchor: HTMLElement;
    quickSession: SessionMeta | null;
    quickBusy: boolean;
    onclose: () => void;
    onsave: () => void;
    onnew: () => void;
  } = $props();
</script>

<Popover {anchor} {onclose} prefer="down" align="end" minWidth={232}>
  <MenuItem
    icon="folderPlus"
    label={t("存为工作空间")}
    description={quickSession ? t("变成普通项目，不再被新快照替换") : t("先在快照里聊几句再存")}
    disabled={!quickSession || quickBusy}
    onclick={onsave}
  />
  <MenuSep />
  <MenuItem icon="plus" label={t("新建快照")} disabled={quickBusy} onclick={onnew} />
</Popover>
