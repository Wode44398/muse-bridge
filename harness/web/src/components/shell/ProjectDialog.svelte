<script lang="ts">
  // 新建项目（兜底目录选择器）：只在独立运行时出现——嵌进 bridge 时选择器由宿主接管（桌面壳 = 系统原生对话框；
  // 网页 / 手机 = 工作空间文件管理器 + 底部拖入栏），见侧栏的 addProject。只有「选一个现有文件夹当工作空间」
  // 这一种形态（「新建空白项目」已取消），项目名取文件夹名。
  // 目录挂载时只加载一次，失败给「重试」（以前接口一直失败时会无限重试）。
  import { app, importProject, toast } from "../../lib/state.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import { t, tr } from "../../lib/i18n.ts";
  import Sheet from "../ui/Sheet.svelte";
  import Group from "../ui/Group.svelte";
  import Button from "../ui/Button.svelte";
  import DirBrowser from "../sheets/DirBrowser.svelte";

  let { onclose }: { onclose: () => void } = $props();

  const start = app.config?.workspace ?? "";
  let path = $state("");
  let loading = $state(false);
  let saving = $state(false);

  async function useFolder() {
    if (!path || saving) return;
    saving = true;
    try {
      await importProject(path); // 成功会收起对话框，并在新项目里开一个新对话
      haptic("light");
    } catch (e: any) {
      toast(t("导入失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    }
    saving = false;
  }
</script>

<Sheet title={t("新建项目")} subtitle={t("选择一个文件夹作为项目工作空间")} {onclose} size="md">
  <Group>
    <DirBrowser {start} bind:path bind:loading emptyText={t("此文件夹内没有子文件夹")} listHeight="min(330px, 42vh)" fixed />
  </Group>

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>{t("取消")}</Button>
    <Button variant="primary" loading={saving} disabled={!path || loading} onclick={useFolder}>
      {saving ? t("创建中…") : t("使用此文件夹")}
    </Button>
  {/snippet}
</Sheet>
