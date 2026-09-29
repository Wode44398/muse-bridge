<script>
  // 设置 · Agent（管理员）：这台服务器上各个 agent 开不开、能不能跑、认证了没有（/api/agents，admin 门）。
  // 关掉的 agent 所有客户端都不再显示它的分页；只剩一个时就是单页模式，再开一个就回到主页模式。
  import { ui } from '../../lib/state.svelte.js';
  import { api } from '../../lib/api.js';
  import { sa, saPing } from '../../lib/serverAdmin.svelte.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import SSection from './SSection.svelte';
  import SRow from './SRow.svelte';
  import SToggle from './SToggle.svelte';
  import SButton from './SButton.svelte';
  import { t, tc, tr } from '../../lib/i18n.js';

  let data = $state(null);      // { edition, features, agents:[{id,label,multiUser,switch,runnable,authed,enabled,note}] }
  let err = $state('');
  let busy = $state('');
  api.get('/api/agents').then((r) => { data = r; }).catch((e) => {
    err = e?.status === 403 || e?.status === 401 ? t('只有管理员能改这里') : t('读取失败：{reason}', { reason: tr(e?.message) || e });
  });
  // 控制台可达才给「去配置」直达
  let consoleOk = $state(false);
  saPing().then(() => { consoleOk = true; }).catch(() => {});

  async function toggle(a, next) {
    if (!a.runnable || busy) return;
    if (!next && data.agents.filter((x) => x.enabled).length <= 1
      && !confirm(t('这是最后一个开着的 agent，关掉后所有客户端都没有可用的分页。确定吗？'))) return;
    busy = a.id;
    try {
      const r = await api.post('/api/agents', { id: a.id, enabled: next });
      data = { ...data, agents: r.agents };
      showToast(next ? t('{name} 已开启', { name: a.label }) : t('{name} 已关闭', { name: a.label }));
    } catch (e) { showToast(tr(e?.body?.error || e?.message) || t('操作失败'), 'err'); }
    busy = '';
  }

  const statusText = (a) => {
    if (!a.runnable) return tr(a.note) || t('这台机器上不可用');
    if (!a.switch) return t('已关闭：所有客户端都不显示');
    const bits = [a.authed ? t('可用') : t('还没配认证')];
    if (!a.multiUser) bits.push(t('仅管理员（尚不支持多用户）'));
    return bits.join(' · ');
  };
  const AUTH_HINT = {
    claude: t('在「服务端控制台 → Claude 账号」里添加 claude setup-token 生成的长期 token，或在服务器环境里配 ANTHROPIC_API_KEY。'),
    dimensio: t('在 dimensio 的 .env 里填至少一家厂商的 API key。'),
  };
  const editionLine = $derived(!data ? '' : (data.edition === 'host' ? t('主机端') : tc('settings', '服务端')) + ' · ' + (data.features?.multiUser ? t('多用户') : t('单人')));
  const pending = $derived(data ? data.agents.filter((a) => a.runnable && a.switch && !a.authed) : []);
  const foot = $derived(data?.features?.multiUser
    ? t('关掉的 agent，所有人都不再看到它的分页。只开一个时打开网页直接就是那一页；注册用户能用哪些，另在「服务端控制台 → 用户」里按人勾选。')
    : t('关掉的 agent，所有人都不再看到它的分页。只开一个时打开网页直接就是那一页；再开一个就回到主页。'));
</script>

{#if err}
  <SSection title="Agent"><SRow label={err} /></SSection>
{:else if !data}
  <SSection title="Agent"><SRow label={t('载入中…')} /></SSection>
{:else}
  <SSection title={'Agent' + (editionLine ? ' · ' + editionLine : '')} {foot}>
    {#each data.agents as a (a.id)}
      <SRow label={a.label} desc={statusText(a)} sid={'agent-' + a.id}>
        {#snippet trailing()}
          <SToggle checked={a.switch && a.runnable} disabled={!a.runnable || busy === a.id}
            onchange={(v) => toggle(a, v)} label={t('启用 {name}', { name: a.label })} />
        {/snippet}
      </SRow>
    {/each}
  </SSection>
  {#if pending.length}
    <SSection title={t('还没配认证')}>
      {#each pending as a (a.id)}
        <SRow label={a.label} desc={AUTH_HINT[a.id] || ''}>
          {#snippet trailing()}
            {#if a.id === 'claude' && consoleOk}
              <SButton onclick={() => { sa.page = 'accounts'; ui.serverAdminOpen = true; }}>{t('去配置')}</SButton>
            {/if}
          {/snippet}
        </SRow>
      {/each}
    </SSection>
  {/if}
{/if}
