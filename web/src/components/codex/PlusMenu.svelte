<script>
  // 「+」：添加文件或图片（真的文件选择框，选完就开始传）、计划模式开关（也可 Shift+Tab）、命令（往输入框里放一个 /）。
  import { t } from '../../lib/i18n.js';
  import Icon from './Icon.svelte';
  import Popover from './Popover.svelte';
  import { codex } from '../../lib/codex/store.svelte.js';
  import { closePop } from '../../lib/codex/ui.svelte.js';

  let { touch = false, onfiles = null, onslash = null } = $props();

  let picker = $state(null);

  function pickFiles() {
    // 选择框要在这次点击里同步打开（异步了浏览器会拦）
    picker?.click();
    closePop('plus');
  }
  function onPicked(e) {
    const files = [...(e.currentTarget.files || [])];
    e.currentTarget.value = '';
    if (files.length) onfiles?.(files);
  }
  function togglePlan() {
    codex.plan = !codex.plan;
    // 开关先动完再收（让人看见它切过去了）
    setTimeout(() => closePop('plus'), 320);
  }
  function slash() {
    closePop('plus');
    onslash?.();
  }
</script>

<input bind:this={picker} type="file" multiple hidden onchange={onPicked} />

<Popover id="plus" side="top" align="start" width={300} label={t('添加')}>
  <div class="pop-sec">
    <button type="button" class="mi" role="menuitem" onclick={pickFiles}>
      <Icon name="clip" class="mi-ico" /><span class="lb">{t('添加文件或图片')}</span>
    </button>
    <button type="button" class="mi tall" role="menuitemcheckbox" aria-checked={codex.plan} onclick={togglePlan}>
      <Icon name="plan" class="mi-ico" />
      <span class="lb"><span>{t('计划模式')}</span><span class="desc">{touch ? t('先出计划，你点头再动手') : t('先出计划，你点头再动手 · Shift+Tab')}</span></span>
      <span class="sw" aria-hidden="true" data-on={codex.plan ? 'true' : 'false'}></span>
    </button>
    <button type="button" class="mi" role="menuitem" onclick={slash}>
      <Icon name="slash" class="mi-ico" /><span class="lb">{t('命令')}</span>{#if !touch}<kbd>/</kbd>{/if}
    </button>
  </div>
</Popover>
