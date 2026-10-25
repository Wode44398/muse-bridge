<script>
  // 设置 · 账户 · 管理员可见性（只有成员看得到）：成员自己决定管理员能不能看对话内容、代聊代答，
  // 并看到管理员做过什么。数据面 lib/adminAccess.js，后端 routes/admin-access.mjs。管理员本人拿到 { admin:true }，整块不出。
  import SSection from './SSection.svelte';
  import SRow from './SRow.svelte';
  import SToggle from './SToggle.svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { fetchAdminAccess, saveAdminAccess, accessItems, accessDisclosure, logLine, onAdminAccess } from '../../lib/adminAccess.js';

  let st = $state(null);      // { consents, log, service }
  let err = $state('');
  let busy = $state('');

  async function load() {
    try { const r = await fetchAdminAccess(); st = r && !r.admin ? r : null; err = ''; }
    catch (e) { err = tr(e?.body?.error || e?.message || String(e)); }
  }
  load();
  // 管理员刚看过 / 代操作过：服务端经总线推 admin.access（lib/adminAccess.js 统一接、顺带弹提示），记录当场刷新
  $effect(() => onAdminAccess(() => load()));

  async function toggle(key, on) {
    if (!st) return;
    busy = key; err = '';
    const prev = st.consents[key];
    st.consents[key] = on;
    try { const r = await saveAdminAccess({ [key]: on }); if (r?.consents) st.consents = r.consents; }
    catch (e) { st.consents[key] = prev; err = tr(e?.body?.error || e?.message || String(e)); }
    finally { busy = ''; }
  }
  const when = (ms) => new Date(ms).toLocaleString();
</script>

{#if st}
  <SSection title={t('管理员可见性')} foot={accessDisclosure()}>
    {#each accessItems() as it, i (it.key)}
      <SRow label={it.title} desc={it.sub} sid={i === 0 ? 'admin-access' : ''}>
        {#snippet trailing()}<SToggle checked={!!st.consents[it.key]} disabled={busy === it.key} onchange={(v) => toggle(it.key, v)} label={it.title} />{/snippet}
      </SRow>
    {/each}
    {#if err}<p class="err">{err}</p>{/if}
  </SSection>
  <SSection title={t('管理员的访问记录')}>
    {#if !st.log?.length}
      <SRow label={t('还没有记录')} />
    {:else}
      {#each st.log.slice(0, 20) as e, i (e.at + e.action + i)}
        <SRow label={logLine(e)} desc={when(e.at)} />
      {/each}
    {/if}
  </SSection>
{/if}

<style>
  .err { margin: 0 0 10px; font-size: 13px; color: var(--crit); }
</style>
