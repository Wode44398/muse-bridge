<script>
  // 设置 · 反馈：报告问题（一句话 + 一键发送）、出错时自动上报（管理员开关）、发过的报告。
  // 报告经项目方的反馈服务提交到 GitHub（见服务端 src/feedback/），这台服务器上没有任何 GitHub 凭据。
  import { api } from '../../lib/api.js';
  import { openReport } from '../../lib/feedback.svelte.js';
  import SSection from './SSection.svelte';
  import SRow from './SRow.svelte';
  import SButton from './SButton.svelte';
  import SToggle from './SToggle.svelte';
  import { t, locale } from '../../lib/i18n.js';
  import { showToast } from '../../lib/toast.svelte.js';

  let info = $state(null);
  let saving = $state(false);
  const load = () => api.get('/api/feedback').then((r) => { info = r; }).catch(() => { info = { sent: [], auto: null, canToggle: false }; });
  load();

  async function setAuto(on) {
    saving = true;
    try { const r = await api.post('/api/feedback/auto', { on }); info = { ...info, auto: r.auto }; }
    catch { showToast(t('没改成，稍后再试'), 'err'); }
    finally { saving = false; }
  }
  const when = (iso) => { try { return new Date(iso).toLocaleDateString(locale(), { month: 'short', day: 'numeric' }); } catch { return ''; } };
  function open(u) { if (u) window.open(u, '_blank', 'noopener'); }
</script>

<SSection title={t('报告问题')}
  foot={t('报告会提交到项目公开的 GitHub Issues（github.com/Wode44398/muse-bridge），安全问题私下发给维护者。只附版本、服务状态和程序自己的报错位置，不含对话、文件、key 和地址；发送前可以先看内容。')}>
  <SRow label={t('报告问题或提建议')} desc={t('一句话就行，不用 GitHub 账号')} sid="feedback-report">
    {#snippet trailing()}<SButton variant="primary" onclick={() => openReport()}>{t('报告')}</SButton>{/snippet}
  </SRow>
  {#if info?.canToggle}
    <SRow label={t('出错时自动发送错误报告')} desc={t('服务崩溃、接口出错、更新失败时自动报给开发者，不用你动手。同一个错误每个版本只报一次。')} sid="feedback-auto">
      {#snippet trailing()}<SToggle checked={info.auto === true} disabled={saving} label={t('出错时自动发送错误报告')} onchange={setAuto} />{/snippet}
    </SRow>
  {/if}
</SSection>

{#if info?.sent?.length || info?.pending}
  <SSection title={t('发过的报告')}>
    {#if info.pending}
      <SRow label={t('{n} 份在等联网补发', { n: info.pending })} desc={t('反馈服务暂时连不上，恢复后会自动发出')} />
    {/if}
    {#each info.sent as s (s.id)}
      <SRow label={s.title} sid={'fb-' + s.id}
        desc={[when(s.at), s.private ? t('私下报告') : s.issue ? '#' + s.issue.number : '', s.duplicate ? t('已有人报过，已 +1') : '', s.source === 'auto' ? t('自动') : ''].filter(Boolean).join(' · ')}
        onclick={s.issue?.url ? () => open(s.issue.url) : null} />
    {/each}
  </SSection>
{/if}
