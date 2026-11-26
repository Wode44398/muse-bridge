<script>
  // 斜杠命令菜单：在输入框里打「/」弹出，边打边筛；↑↓ 选、回车 / Tab 执行、Esc 收起（键盘由输入栏转过来）。
  // 「!命令」（管理员）也在这里写明白会发生什么。焦点一直留在输入框里。
  import { t } from '../../lib/i18n.js';
  import Popover from './Popover.svelte';

  let { items = [], idx = 0, onpick = null, onhover = null } = $props();
</script>

<Popover id="slash" side="top" align="start" width={360} label={t('命令')}>
  <div class="pop-sec">
    {#each items as it, i (it.cmd)}
      <button
        type="button"
        class="mi tall"
        class:kb={i === idx}
        role="menuitem"
        disabled={it.disabled}
        onmousedown={(e) => e.preventDefault()}
        onpointerenter={(e) => { if (e.pointerType !== 'touch') onhover?.(i); }}
        onclick={() => onpick?.(i)}
      >
        <span class="mono cmd">{it.cmd}</span>
        <span class="lb"><span>{it.name}</span><span class="desc">{it.desc}</span></span>
      </button>
    {/each}
  </div>
</Popover>

<style>
  .cmd { width: 74px; flex: none; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
