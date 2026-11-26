<script>
  // 权限菜单（托盘右边那颗盾牌）：三档写成人话，只列这个身份能选的；「完全访问」用官方警示色。
  // 选了先让勾落到新的那行，稍停再收起，看得见自己选中了什么。
  import { t } from '../../lib/i18n.js';
  import { codex, allowedPerms, permOf } from '../../lib/codex/store.svelte.js';
  import { closePop } from '../../lib/codex/ui.svelte.js';
  import { haptic } from '../../lib/codex/feedback.js';
  import Popover from './Popover.svelte';
  import Icon from './Icon.svelte';

  const MODES = [
    { k: 'ask', icon: 'shield', name: () => t('每次询问'), desc: () => t('只读；改文件、跑命令之前都先问你') },
    { k: 'auto', icon: 'shield', name: () => t('工作区内自动'), desc: () => t('在项目里随便改、随便跑；联网或越出项目才问') },
    { k: 'full', icon: 'shield-warn', name: () => t('完全访问'), desc: () => t('不再询问，也不限网络') },
  ];

  const allowed = $derived(allowedPerms());
  const cur = $derived(permOf());
  const list = $derived(MODES.filter((m) => allowed.includes(m.k)));

  let closing = 0;
  function pick(k) {
    if (k !== cur) { codex.perm = k; haptic('tick'); }
    clearTimeout(closing);
    closing = setTimeout(() => closePop('perm'), 140);
  }
</script>

<Popover id="perm" side="top" align="end" width={320} class="cx-menu" label={t('权限')}>
  <div class="pop-sec">
    {#each list as m (m.k)}
      <button
        type="button"
        class="mi tall"
        class:warn={m.k === 'full'}
        role="menuitemradio"
        aria-checked={cur === m.k}
        onclick={() => pick(m.k)}
      >
        <Icon name={m.icon} class="mi-ico" />
        <span class="lb"><span>{m.name()}</span><span class="desc">{m.desc()}</span></span>
        <Icon name="check" class="ck" />
      </button>
    {/each}
  </div>
</Popover>

<style>
  .mi :global(.ck) { transition: opacity calc(var(--k, 1) * 150ms) ease; }
  :global(.cx .pop.cx-menu) { max-width: calc(100% - 16px); }
</style>
