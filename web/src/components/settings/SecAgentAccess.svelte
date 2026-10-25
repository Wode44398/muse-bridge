<script>
  // 设置 · Agent 接入：给别的 agent（部署它的 Muse、Claude Code、脚本…）用的地址与密钥。
  // 数据面 lib/agentKeys.svelte.js，后端 /api/agent-keys（src/agent-api/http.mjs）。每个登录身份各管各的密钥。
  // 明文密钥只在生成那一下展示（agentKeys.fresh），离开这一节就丢掉。无 props、自包含。
  import { untrack } from 'svelte';
  import SSection from './SSection.svelte';
  import SRow from './SRow.svelte';
  import SButton from './SButton.svelte';
  import SField from './SField.svelte';
  import { t } from '../../lib/i18n.js';
  import { relTime } from '../../lib/format.js';
  import { me } from '../../lib/state.svelte.js';
  import { agentKeys, watchAgentKeys, createAgentKey, revokeAgentKey, dismissFresh, fmtKeyDay, copyText } from '../../lib/agentKeys.svelte.js';

  const signedIn = $derived(me.kind === 'admin' || me.kind === 'user');
  // 只在登录后拉列表、听总线；离开这一节（组件卸载）时 watchAgentKeys 的返回值丢掉没看完的明文
  // （untrack：watchAgentKeys 里同步读写 agentKeys 的状态，不隔开会让这个 effect 自己触发自己）
  $effect(() => { if (signedIn) return untrack(() => watchAgentKeys()); });

  let label = $state('');
  let askId = $state('');      // 正在确认吊销的那一把
  let note = $state('');
  let noteTimer = 0;
  function flash(text) { note = text; clearTimeout(noteTimer); noteTimer = setTimeout(() => { note = ''; }, 1800); }
  async function copy(text, okText = t('已复制')) { flash((await copyText(text)) ? okText : t('复制失败')); }

  async function create() {
    if (!label.trim() || agentKeys.busy) return;
    if (await createAgentKey(label)) label = '';
  }
  function onLabelKey(e) { if (e.key === 'Enter') { e.preventDefault(); create(); } }
  async function revoke(id) {
    askId = '';
    if (await revokeAgentKey(id)) flash(t('已吊销，用这把密钥的 agent 立刻失去访问'));
  }
  const keyMeta = (k) => [
    t('创建于 {date}', { date: fmtKeyDay(k.created) }),
    k.seen ? t('最近使用 {when}', { when: relTime(k.seen) }) : t('还没用过'),
    k.expiresAt ? t('{date} 到期', { date: fmtKeyDay(k.expiresAt) }) : '',
  ].filter(Boolean).join(' · ');
  const footInvalidate = $derived(me.kind === 'user'
    ? t('改密码会让你的全部密钥立即失效。')
    : t('重置访问令牌会让全部密钥立即失效。'));
  const openManual = () => { if (agentKeys.manualUrl) window.open(agentKeys.manualUrl, '_blank', 'noopener'); };
</script>

<p class="ak-intro">{t('让别的 agent（比如部署它的 Muse、Claude Code、脚本）直接调用这台 Muse Bridge：读项目手册、给 Claude 派活、管文件和定时任务、看谁在跑，不用开浏览器模拟点击。')}</p>

{#if !signedIn}
  <SSection>
    <SRow label={t('登录后才能生成 agent 密钥')} />
  </SSection>
{:else}
  {#if agentKeys.err}<p class="ak-msg err sel-text">{agentKeys.err}</p>{:else if note}<p class="ak-msg">{note}</p>{/if}

  {#if agentKeys.fresh}
    <section class="ak-fresh">
      <div class="ak-fresh-h">{t('新密钥：{name}', { name: agentKeys.fresh.label })}</div>
      <code class="ak-key sel-text">{agentKeys.fresh.key}</code>
      <div class="ak-row">
        <SButton variant="primary" onclick={() => copy(agentKeys.fresh.prompt || agentKeys.fresh.key, t('已复制给 agent 的说明'))}>{t('复制给 agent 的说明')}</SButton>
        <SButton onclick={() => copy(agentKeys.fresh.key, t('密钥已复制'))}>{t('复制密钥')}</SButton>
        <span class="ak-sp"></span>
        <SButton variant="ghost" onclick={dismissFresh}>{t('我已保存好')}</SButton>
      </div>
      <p class="ak-warn">{t('关掉之后就再也看不到这把密钥了。丢了就吊销它，再生成一把新的。')}</p>
    </section>
  {/if}

  <SSection title={t('地址')}>
    <SRow label={t('Agent 入口')} desc={agentKeys.agentUrl || (agentKeys.loaded ? '—' : t('正在读取…'))} sid="ak-url">
      {#snippet trailing()}
        {#if agentKeys.agentUrl}<SButton variant="ghost" onclick={() => copy(agentKeys.agentUrl)}>{t('复制')}</SButton>{/if}
      {/snippet}
    </SRow>
    <SRow label={t('项目手册')} desc={agentKeys.manualUrl || '—'} sid="ak-manual">
      {#snippet trailing()}
        {#if agentKeys.manualUrl}
          <SButton variant="ghost" onclick={openManual}>{t('打开')}</SButton>
          <SButton variant="ghost" onclick={() => copy(agentKeys.manualUrl)}>{t('复制')}</SButton>
        {/if}
      {/snippet}
    </SRow>
  </SSection>

  <SSection title={t('生成密钥')} foot={t('给每个 agent 单独一把，名字写清是谁在用，方便以后吊销。')}>
    <SRow label={t('名字')} sid="ak-new" stack>
      {#snippet trailing()}
        <span class="ak-inline">
          <SField bind:value={label} placeholder={t('例如「我的 Muse」')} width="220px" onkeydown={onLabelKey} />
          <SButton variant="primary" disabled={!label.trim() || agentKeys.busy === 'create'} onclick={create}>{t('生成')}</SButton>
        </span>
      {/snippet}
    </SRow>
  </SSection>

  <SSection title={t('密钥')} foot={t('密钥等同你的登录：拿到它的 agent 能做你能做的一切。每把 90 天后过期。') + ' ' + footInvalidate}>
    {#if !agentKeys.loaded}
      <SRow label={t('正在读取…')} />
    {:else if !agentKeys.keys.length}
      <SRow label={t('还没有密钥')} desc={t('生成一把，交给要接入的 agent')} />
    {:else}
      {#each agentKeys.keys as k (k.id)}
        <SRow label={k.label || k.id} desc={keyMeta(k)} sid="ak-list">
          {#snippet trailing()}
            {#if askId === k.id}
              <SButton variant="ghost" onclick={() => (askId = '')}>{t('取消')}</SButton>
              <SButton variant="danger" disabled={agentKeys.busy === 'revoke:' + k.id} onclick={() => revoke(k.id)}>{t('确认吊销')}</SButton>
            {:else}
              <SButton variant="danger" onclick={() => (askId = k.id)}>{t('吊销')}</SButton>
            {/if}
          {/snippet}
        </SRow>
      {/each}
    {/if}
  </SSection>
{/if}

<style>
  .ak-intro { margin: 0 0 24px; font-size: 14px; line-height: 20px; color: var(--st-muted); }
  .ak-inline { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ak-msg { margin: 0 0 12px; font-size: 13px; line-height: 18px; color: var(--st-muted); }
  .ak-msg.err { color: var(--crit); }
  .ak-fresh { margin: 0 0 32px; padding: 14px 16px; border-radius: 12px;
    background: var(--st-surface, transparent); box-shadow: inset 0 0 0 1px var(--st-accent); }
  .ak-fresh-h { font-size: 14px; font-weight: 580; line-height: 20px; color: var(--text); margin-bottom: 8px; }
  .ak-key { display: block; padding: 9px 11px; border-radius: 8px; background: var(--st-field);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12.5px; line-height: 18px;
    color: var(--text); word-break: break-all; user-select: text; -webkit-user-select: text; }
  .ak-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .ak-sp { flex: 1; }
  .ak-warn { margin: 10px 0 0; font-size: 12.5px; line-height: 17px; color: var(--warn, var(--st-muted)); }
</style>
