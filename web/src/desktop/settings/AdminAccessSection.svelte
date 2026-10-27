<script>
  // 设置 · 账户 · 管理员可见性（桌面壳）：成员自己决定管理员能不能看对话内容、代聊代答、看他的电脑，
  // 并看到管理员做过什么。数据面 lib/adminAccess.js（手机 / 网页的 iOS 风设置共用），后端 routes/admin-access.mjs。
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { fetchAdminAccess, saveAdminAccess, accessItems, accessDisclosure, logLine, onAdminAccess } from '../../lib/adminAccess.js';

  let { highlight = false } = $props();   // 设置搜索跳到这里时闪一下第一行（SettingsDesktop 的 fl('admin-access')）
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
  <DGroup label={t('管理员可见性')} foot={accessDisclosure()}>
    {#each accessItems() as it, i (it.key)}
      <DRow title={it.title} sub={it.sub} highlight={highlight && i === 0}>
        {#snippet trailing()}<DSwitch checked={!!st.consents[it.key]} disabled={busy === it.key} onchange={(v) => toggle(it.key, v)} />{/snippet}
      </DRow>
    {/each}
  </DGroup>
  {#if err}<p class="err">{err}</p>{/if}
  <DGroup label={t('管理员的访问记录')}>
    {#if !st.log?.length}
      <DRow title={t('还没有记录')} />
    {:else}
      {#each st.log.slice(0, 20) as e, i (e.at + e.action + i)}
        <DRow title={logLine(e)} sub={when(e.at)} />
      {/each}
    {/if}
  </DGroup>
{/if}

<style>
  .err { margin: -6px 4px 12px; font-size: 12px; color: var(--dsk-danger, #e5484d); }
</style>
