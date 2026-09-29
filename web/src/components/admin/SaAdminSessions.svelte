<script>
  // 管理员登录（三端拆分 P4）：「用访问令牌登录」与扫码确认铸出的管理员会话。以前这两条路把主令牌
  // 本身写进浏览器，丢了一台设备只能换令牌、全部重登；现在每台设备一张会话，在这里单独吊销。
  // 吊销「本机」这一张 = 把自己登出（问一句）。换主令牌（npm run token）会让这里的全部作废。
  import { api } from '../../lib/api.js';
  import { sa, saToast, saConfirm, fmtAgo } from '../../lib/serverAdmin.svelte.js';
  import { t, tc, tr } from '../../lib/i18n.js';

  let list = $state(null);      // [{ id, label, ip, created, seen }]
  let current = $state(null);   // 本请求用的那一张（用主令牌直接访问时为 null）
  async function load() {
    try { const r = await api.get('/api/admin/admin-sessions'); list = r.sessions || []; current = r.current || null; }
    catch { list = null; }
  }
  $effect(() => { sa.tick; load(); });

  async function revoke(s) {
    const self = s.id === current;
    if (self && !(await saConfirm(t('吊销本机的管理员登录？'), t('这台设备会立刻退出管理员身份，需要重新用访问令牌或扫码登录。'), { yes: t('吊销并退出'), danger: true }))) return;
    try {
      await api.post('/api/admin/admin-sessions/revoke', { id: s.id });
      saToast(t('已吊销 {name}', { name: tr(s.label) || s.id }));
      if (self) { location.reload(); return; }
      load();
    } catch (e) { saToast(tr(e?.body?.error || e?.message) || t('失败'), true); }
  }
  async function revokeOthers() {
    const others = (list || []).filter((s) => s.id !== current);
    if (!others.length) return;
    if (!(await saConfirm(t('吊销其它 {n} 台设备的管理员登录？', { n: others.length }), t('它们会立刻退出管理员身份；本机不受影响。'), { yes: t('全部吊销'), danger: true }))) return;
    try {
      for (const s of others) await api.post('/api/admin/admin-sessions/revoke', { id: s.id });
      saToast(t('已吊销 {n} 台', { n: others.length }));
      load();
    } catch (e) { saToast(tr(e?.body?.error || e?.message) || t('失败'), true); load(); }
  }
</script>

{#if list}
  <div class="sa-card" style="margin-top:12px">
    <div class="sa-card-h uhead">
      <span>{t('管理员登录')}</span>
      <span class="sa-sp"></span>
      {#if list.some((s) => s.id !== current)}
        <button class="sa-btn sm dgr" onclick={revokeOthers}>{t('吊销其它设备')}</button>
      {/if}
    </div>
    {#if !list.length}
      <div class="sa-empty">{t('还没有用访问令牌或扫码登录过的设备')}</div>
    {:else}
      <div class="sa-thead acols"><span>{t('设备')}</span><span>{t('来源')}</span><span>{tc('admin', '登录')}</span><span>{t('最近使用')}</span><span></span></div>
      {#each list as s (s.id)}
        <div class="sa-tr acols">
          <b class="sa-trunc">{tr(s.label) || t('未知设备')}{#if s.id === current}<span class="me">{tc('admin', '本机')}</span>{/if}</b>
          <span class="sa-mono sa-dim sa-trunc">{s.ip || '—'}</span>
          <span class="sa-dim">{fmtAgo(s.created)}</span>
          <span class="sa-dim">{fmtAgo(s.seen)}</span>
          <span class="acts"><button class="sa-btn sm dgr" onclick={() => revoke(s)}>{t('吊销')}</button></span>
        </div>
      {/each}
      <div style="height:8px"></div>
    {/if}
  </div>
  <div class="sa-foot">{t('每次用访问令牌登录、或在手机上确认扫码登录，都会给那台设备发一张独立的管理员登录，浏览器里存的是它而不是访问令牌本身。怀疑哪台设备丢了就单独吊销；重新生成访问令牌会让这里全部作废。')}</div>
{/if}

<style>
  .acols { grid-template-columns: minmax(0, 2fr) minmax(0, 1.2fr) 90px 90px 70px; }
  .me { margin-left: 8px; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 6px; color: #0a84ff; background: rgba(10, 132, 255, .14); }
  .acts { display: flex; justify-content: flex-end; }
  .uhead { display: flex; align-items: center; gap: 8px; }
  @media (max-width: 720px) {
    .acols { grid-template-columns: minmax(0, 1fr) 76px 64px; }
    .acols > :nth-child(2), .acols > :nth-child(3) { display: none; }
  }
</style>
