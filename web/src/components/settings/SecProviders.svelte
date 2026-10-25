<script>
  // 设置 · 模型服务（管理员）：给 Claude Code 页接自定义的模型服务（Anthropic / OpenAI 兼容端点，如 DeepSeek、Kimi、
  // OpenRouter、自己部署的模型）。列表、预设、编辑器都在 components/claude/providers/ProviderManager（盖在设置页上面）。
  // 数据面 lib/claudeProviders.svelte.js，后端 /api/claude/providers（src/routes/claude-providers.mjs）。
  // Muse 只能经出站代理访问外网，服务地址要能从代理出去（编辑器里没有「不走代理」的开关）。
  import { cp, loadProviders, cpSummaryText } from '../../lib/claudeProviders.svelte.js';
  import ProviderManager from '../claude/providers/ProviderManager.svelte';
  import SSection from './SSection.svelte';
  import SRow from './SRow.svelte';
  import SButton from './SButton.svelte';
  import { t } from '../../lib/i18n.js';

  loadProviders();
  let open = $state(false);
  const summary = $derived(cpSummaryText() || t('接 DeepSeek、Kimi、OpenRouter、本机模型等兼容 API'));
</script>

<SSection title={t('模型服务')} foot={t('加好的模型出现在 Claude 页的模型菜单里，和官方模型并列；每个服务可以单独停用或从菜单里隐藏。')}>
  {#if cp.ok}
    <SRow label={t('自定义 API')} desc={summary} sid="providers" onclick={() => (open = true)} />
  {:else}
    <SRow label={cp.err ? t('读不到模型服务') : t('读取中…')} desc={cp.err ? t('只有管理员能管理模型服务') : ''}>
      {#snippet trailing()}{#if cp.err}<SButton onclick={() => loadProviders(true)}>{t('重试')}</SButton>{/if}{/snippet}
    </SRow>
  {/if}
</SSection>

{#if open}<ProviderManager onClose={() => (open = false)} />{/if}
