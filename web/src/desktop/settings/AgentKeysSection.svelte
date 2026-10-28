<script>
  // 设置 · Agent 接入（桌面壳）：给别的 agent（Claude Code、Codex、脚本…）用的地址与密钥。
  // 数据面 lib/agentKeys.svelte.js（手机 Settings 的同名子页共用），后端 /api/agent-keys。
  // 明文密钥只在生成那一下展示（agentKeys.fresh），离开这一页就丢掉。
  import { untrack } from 'svelte';
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DButton from '../kit/DButton.svelte';
  import DField from '../kit/DField.svelte';
  import { t } from '../../lib/i18n.js';
  import { relTime } from '../../lib/format.js';
  import { me } from '../../lib/state.svelte.js';
  import { agentKeys, watchAgentKeys, createAgentKey, revokeAgentKey, dismissFresh, fmtKeyDay, copyText } from '../../lib/agentKeys.svelte.js';

  let { fl = () => false } = $props();   // 设置搜索跳转后的高亮

  // 必须 untrack：watchAgentKeys 里同步读了 agentKeys.loading，不隔离的话生成后重拉列表会让 effect 重跑，
  // 清理函数顺手把 agentKeys.fresh 清空——刚生成的明文密钥一闪就没了
  $effect(() => untrack(() => watchAgentKeys()));

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
    : t('换访问令牌会让全部密钥立即失效。'));
</script>

{#if agentKeys.err}<p class="ak-msg err sel-text">{agentKeys.err}</p>{:else if note}<p class="ak-msg">{note}</p>{/if}

{#if agentKeys.fresh}
  <section class="ak-fresh">
    <div class="ak-fresh-h">{t('新密钥：{name}', { name: agentKeys.fresh.label })}</div>
    <code class="ak-key sel-text">{agentKeys.fresh.key}</code>
    <div class="ak-row">
      <DButton size="sm" variant="primary" onclick={() => copy(agentKeys.fresh.prompt || agentKeys.fresh.key, t('已复制给 agent 的说明'))}>{t('复制给 agent 的说明')}</DButton>
      <DButton size="sm" onclick={() => copy(agentKeys.fresh.key, t('密钥已复制'))}>{t('复制密钥')}</DButton>
      <span class="ak-sp"></span>
      <DButton size="sm" variant="ghost" onclick={dismissFresh}>{t('我已保存好')}</DButton>
    </div>
    <p class="ak-warn">{t('关掉之后就再也看不到这把密钥了。丢了就吊销它，再生成一把新的。')}</p>
  </section>
{/if}

<DGroup label={t('地址')}>
  <DRow title={t('Agent 入口')} sub={agentKeys.agentUrl || (agentKeys.loaded ? '—' : t('正在读取…'))} subSelectable highlight={fl('ak-url')}>
    {#snippet trailing()}
      {#if agentKeys.agentUrl}<DButton size="sm" variant="ghost" onclick={() => copy(agentKeys.agentUrl)}>{t('复制')}</DButton>{/if}
    {/snippet}
  </DRow>
  <DRow title={t('项目手册')} sub={agentKeys.manualUrl || '—'} subSelectable>
    {#snippet trailing()}
      {#if agentKeys.manualUrl}
        <span class="ak-inline">
          <DButton size="sm" variant="ghost" onclick={() => copy(agentKeys.manualUrl)}>{t('复制')}</DButton>
          <DButton size="sm" variant="ghost" onclick={() => window.open(agentKeys.manualUrl, '_blank', 'noopener')}>{t('打开')}</DButton>
        </span>
      {/if}
    {/snippet}
  </DRow>
</DGroup>

<DGroup label={t('生成密钥')} foot={t('给每个 agent 单独一把，名字写清是谁在用，方便以后吊销。')}>
  <DRow title={t('名字')} highlight={fl('ak-new')}>
    {#snippet trailing()}
      <span class="ak-inline">
        <DField bind:value={label} placeholder={t('例如「家里的 Codex」')} width="200px" />
        <DButton size="sm" variant="primary" disabled={!label.trim() || agentKeys.busy === 'create'} onclick={create}>{t('生成')}</DButton>
      </span>
    {/snippet}
  </DRow>
</DGroup>

<DGroup label={t('密钥')} foot={t('密钥等同你的登录：拿到它的 agent 能做你能做的一切。每把 90 天后过期。') + ' ' + footInvalidate}>
  {#if !agentKeys.loaded}
    <DRow title={t('正在读取…')} />
  {:else if !agentKeys.keys.length}
    <DRow title={t('还没有密钥')} sub={t('生成一把，交给要接入的 agent')} />
  {:else}
    {#each agentKeys.keys as k (k.id)}
      <DRow title={k.label || k.id} sub={keyMeta(k)} highlight={fl('ak-list')}>
        {#snippet trailing()}
          <span class="ak-inline">
            {#if askId === k.id}
              <DButton size="sm" variant="ghost" onclick={() => (askId = '')}>{t('取消')}</DButton>
              <DButton size="sm" variant="danger" disabled={agentKeys.busy === 'revoke:' + k.id} onclick={() => revoke(k.id)}>{t('确认吊销')}</DButton>
            {:else}
              <DButton size="sm" variant="danger" onclick={() => (askId = k.id)}>{t('吊销')}</DButton>
            {/if}
          </span>
        {/snippet}
      </DRow>
    {/each}
  {/if}
</DGroup>

<style>
  .ak-inline { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .ak-msg { margin: 0 0 10px; font-size: 12.5px; color: var(--dsk-ink-2); }
  .ak-msg.err { color: var(--dsk-crit); }
  .ak-fresh {
    margin: 0 0 22px; padding: 14px 16px; border-radius: 12px;
    background: var(--dsk-panel);
    box-shadow: inset 0 0 0 1px var(--dsk-accent);
  }
  .ak-fresh-h { font-size: var(--dsk-fs-body); font-weight: 600; margin-bottom: 8px; }
  .ak-key {
    display: block; padding: 9px 11px; border-radius: 8px; background: var(--dsk-bg);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12.5px; line-height: 18px;
    word-break: break-all; user-select: text;
  }
  .ak-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .ak-sp { flex: 1; }
  .ak-warn { margin: 10px 0 0; font-size: 12px; line-height: 17px; color: var(--dsk-warn); }
</style>
