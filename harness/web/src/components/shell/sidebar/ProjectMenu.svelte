<script lang="ts">
  // 项目行的操作菜单（行尾 ⋯ / 桌面右键）。动作由外面给：它们要改侧栏自己的状态（就地改名、收起菜单）。
  import { app, canRenameProject, type ProjectMeta } from "../../../lib/state.svelte.ts";
  import Popover from "../../ui/Popover.svelte";
  import MenuItem from "../../ui/MenuItem.svelte";
  import MenuSep from "../../ui/MenuSep.svelte";
  import { t } from "../../../lib/i18n.ts";

  let {
    anchor,
    target,
    onclose,
    onnew,
    onrename,
    ontogglepin,
    onmemory,
    onhide,
  }: {
    anchor: HTMLElement;
    target: ProjectMeta;
    onclose: () => void;
    onnew: () => void;
    onrename: () => void;
    ontogglepin: () => void;
    onmemory: () => void;
    onhide: () => void;
  } = $props();
</script>

<Popover {anchor} {onclose} prefer="down" align="end" minWidth={216}>
  <MenuItem icon="edit" label={t("在这个项目里新建对话")} disabled={!target.exists} onclick={onnew} />
  {#if canRenameProject()}
    <MenuItem icon="rename" label={t("重命名")} onclick={onrename} />
  {/if}
  <MenuItem icon={target.pinned ? "pinOff" : "pin"} label={target.pinned ? t("取消置顶") : t("置顶项目")} onclick={ontogglepin} />
  {#if app.compat?.caps?.includes("memory")}
    <MenuItem icon="memory" label={t("项目记忆")} onclick={onmemory} />
  {/if}
  <MenuSep />
  <MenuItem icon="eyeOff" label={t("隐藏项目")} description={t("只是不在侧栏显示，文件夹和历史对话都不会删除")} onclick={onhide} />
</Popover>
