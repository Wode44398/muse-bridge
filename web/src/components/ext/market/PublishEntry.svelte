<script>
  // 插件详情里的「发布到社区」一组：入口一行 + 有投稿记录时的状态一行（两行都点开发布面板）。
  // 状态要问 GitHub，所以只在进详情、关掉发布面板（seq 变）时查一次，不在这里轮询。
  import { untrack } from 'svelte';
  import { api } from '../../../lib/api.js';
  import { t } from '../../../lib/i18n.js';
  import { SUB_TEXT } from './community.js';

  let { id, seq = 0, onOpen = () => {} } = $props();

  let sub = $state(null);
  let my = 0;
  $effect(() => {
    const pid = id;
    seq;
    untrack(() => {
      const n = ++my;
      sub = null;
      api.get('/api/plugins/community/submission?id=' + encodeURIComponent(pid))
        .then((r) => { if (n === my) sub = r; })
        .catch(() => {});   // 老服务端没有这个接口 / 没权限：不出状态行就是了
    });
  });
  const has = $derived(!!sub && sub.status && sub.status !== 'none');
</script>

<div class="cz-list pp-gap">
  <button class="cz-li act" onclick={onOpen}><span class="cz-li-tx"><span>{t('发布到社区')}</span><small>{t('用你的 GitHub 账号投稿到社区插件市场，自动检查通过后所有 bridge 用户都能装')}</small></span></button>
  {#if has}
    <button class="cz-li act" onclick={onOpen}><span class="cz-li-tx"><span>{t('社区投稿 v{v} · {status}', { v: sub.version || '?', status: SUB_TEXT[sub.status] || sub.status })}</span>{#if sub.number}<small>{t('拉取请求 #{n}', { n: sub.number })}</small>{/if}</span></button>
  {/if}
</div>

<style>
  .pp-gap { margin-top: 16px; }
</style>
