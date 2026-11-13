<script lang="ts">
  // 会话行的菜单（会话管理）：重命名、归档 / 取消归档。桌面右键会话行、触屏左滑露出的「更多」打开。
  // 重命名在菜单里就地换成输入框：回车 / 「保存」存，Esc 放弃。改过名的对话 AI 不再给它起标题。
  import type { SessionMeta } from "../../lib/state.svelte.ts";
  import { canArchive, canRename, renameSession, setArchived } from "../../lib/sessmgmt.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import { t, tr } from "../../lib/i18n.ts";
  import Popover from "../ui/Popover.svelte";
  import MenuItem from "../ui/MenuItem.svelte";
  import TextField from "../ui/TextField.svelte";
  import Button from "../ui/Button.svelte";

  let {
    session,
    archived = false,
    anchor,
    onclose,
  }: { session: SessionMeta; archived?: boolean; anchor: HTMLElement | null; onclose: () => void } = $props();

  let editing = $state(false);
  let draft = $state("");
  let saving = $state(false);

  function startRename() {
    haptic("light");
    draft = tr(session.title?.trim() ?? "");
    editing = true;
  }
  async function save() {
    if (saving) return;
    const next = draft.trim();
    if (!next || next === session.title) {
      onclose();
      return;
    }
    saving = true;
    const ok = await renameSession(session.id, next); // 菜单还开着，session 有值
    saving = false;
    if (ok) onclose();
  }
  function key(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      editing = false;
    }
  }
  async function archive() {
    // 先取值再关菜单：关掉之后父组件把 session 置空，props 就读不到了
    const id = session.id;
    const on = !archived;
    haptic("medium");
    onclose();
    await setArchived(id, on);
  }
</script>

<Popover {anchor} {onclose} prefer="down" align="end" minWidth={232} role={editing ? "dialog" : "menu"} label={t("对话操作")}>
  {#if editing}
    <div class="ren">
      <TextField bind:value={draft} size="sm" maxlength={80} autofocus label={t("对话标题")} placeholder={t("对话标题")} enterkeyhint="done" onkeydown={key} />
      <div class="acts">
        <Button size="sm" variant="ghost" onclick={() => (editing = false)}>{t("取消")}</Button>
        <Button size="sm" variant="primary" loading={saving} disabled={!draft.trim()} onclick={save}>{t("保存")}</Button>
      </div>
    </div>
  {:else}
    {#if canRename()}
      <MenuItem icon="rename" label={t("重命名")} onclick={startRename} />
    {/if}
    {#if canArchive()}
      <MenuItem
        icon="archive"
        label={archived ? t("取消归档") : t("归档")}
        description={archived ? t("放回项目列表") : t("不在列表里显示，可在侧栏底部「已归档」里找回")}
        onclick={archive}
      />
    {/if}
  {/if}
</Popover>

<style>
  .ren {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
  }
  .acts {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
</style>
