<script lang="ts">
  // 侧栏底部「已隐藏的项目」：隐藏项目唯一的回收入口。展开与否由外面持有（列表清空后再出现时保持上次的开合）。
  import { setProjectFlags, type ProjectMeta } from "../../../lib/state.svelte.ts";
  import { haptic } from "../../../lib/touch.ts";
  import { collapse } from "../../../lib/motion.ts";
  import Icon from "../../ui/Icon.svelte";
  import { t, tc } from "../../../lib/i18n.ts";

  let { projects, open = $bindable() }: { projects: ProjectMeta[]; open: boolean } = $props();

  async function restoreProject(project: ProjectMeta) {
    haptic("light");
    await setProjectFlags(project, { hidden: false });
  }
</script>

<div class="hidden">
  <button class="hidden-head" onclick={() => (open = !open)} aria-expanded={open}>
    <Icon name="eyeOff" size={15} />
    <span>{t("已隐藏的项目")}</span>
    <span class="pcount">{projects.length}</span>
    <span class="chev" class:open><Icon name="chevronD" size={13} /></span>
  </button>
  {#if open}
    <div transition:collapse>
      {#each projects as project (project.id)}
        <div class="hidden-row">
          <span class="hidden-name" title={project.path}>{project.name}</span>
          <button class="restore" onclick={() => restoreProject(project)}>{tc("dimensio", "恢复")}</button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .pcount {
    flex: none;
    font-size: var(--fs-xs);
    color: var(--text3);
    font-variant-numeric: tabular-nums;
    transition: opacity var(--t-fast) var(--ease);
  }
  .hidden-head .pcount {
    margin-left: auto;
  }
  .hidden {
    margin-top: 14px;
  }
  .hidden-head {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    height: 32px;
    padding: 0 10px;
    border-radius: 10px;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .chev {
    display: inline-flex;
    transform: rotate(-90deg);
    transition: transform var(--t-med) var(--ease-out);
  }
  .chev.open {
    transform: none;
  }
  .hidden-row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 6px 0 35px;
  }
  .hidden-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-md);
    color: var(--text2);
  }
  .restore {
    flex: none;
    padding: 4px 10px;
    border-radius: var(--r-pill);
    font-size: var(--fs-sm);
    color: var(--accent);
    background: var(--accent-soft);
  }

  @media (hover: hover) and (pointer: fine) {
    .hidden-head:hover {
      background: color-mix(in srgb, var(--text) 5%, transparent);
    }
    .restore:hover {
      background: color-mix(in srgb, var(--accent) 18%, transparent);
    }
  }
</style>
