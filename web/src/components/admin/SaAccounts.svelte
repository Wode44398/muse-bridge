<script>
  // Claude 账号切换（failover / 额度池）：整个 bridge 的 Claude Agent SDK 用哪个订阅。
  // 切换即时全局生效；两号共享会话（都落 ~/.claude），切号可无缝续同一条对话。
  import { api } from '../../lib/api.js';
  import { sa, loadAccounts, saToast, saConfirm, accLabel } from '../../lib/serverAdmin.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  $effect(() => { sa.tick; loadAccounts(); });

  let editModal = $state(null);   // { id?, label, token, isNew }
  let busy = $state(false);

  // 脚注整句一个键：键里用 **加粗**、`代码` 标出行内的 <b> / <code>，渲染时切段（中文 DOM 与原来一致）
  const rich = (s) => s.split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean);

  async function activate(a) {
    try { const r = await api.post('/api/admin/claude-account/active', { id: a.id }); if (r?.error) throw new Error(r.error); saToast(t('已切换到 {name}', { name: accLabel(a.label) })); loadAccounts(); }
    catch (e) { saToast(tr(e?.message) || t('切换失败'), true); }
  }
  function openAdd() { editModal = { label: '', token: '', isNew: true }; }
  function openEdit(a) { editModal = { id: a.id, label: accLabel(a.label), token: '', isNew: false, hasToken: a.hasToken, tokenTail: a.tokenTail }; }
  async function saveModal() {
    if (busy) return;
    const m = editModal;
    if (m.isNew && !m.token.trim()) { saToast(t('token 不能为空'), true); return; }
    busy = true;
    try {
      const r = m.isNew
        ? await api.post('/api/admin/claude-account/add', { label: m.label.trim(), token: m.token.trim() })
        : await api.post('/api/admin/claude-account/update', { id: m.id, label: m.label.trim(), token: m.token.trim() });
      if (r?.error) throw new Error(r.error);
      editModal = null; saToast(m.isNew ? t('已添加') : t('已保存')); loadAccounts();
    } catch (e) { saToast(tr(e?.message) || t('失败'), true); }
    busy = false;
  }
  async function del(a) {
    if (!(await saConfirm(t('删除账号 {name}？', { name: accLabel(a.label) }), t('只从切换列表移除；若删的是当前账号，会自动切到另一个。'), { yes: t('删除'), danger: true }))) return;
    try { const r = await api.post('/api/admin/claude-account/delete', { id: a.id }); if (r?.error) throw new Error(r.error); saToast(t('已删除')); loadAccounts(); }
    catch (e) { saToast(tr(e?.message) || t('失败'), true); }
  }
</script>

{#snippet richLine(s)}{#each rich(s) as seg}{#if seg.startsWith('**')}<b style="color:rgba(255,255,255,.7)">{seg.slice(2, -2)}</b>{:else if seg.startsWith('`')}<code class="sa-mono">{seg.slice(1, -1)}</code>{:else}{seg}{/if}{/each}{/snippet}

<div class="sa-card">
  <div class="sa-card-h">{t('Claude 订阅账号')}
    <span class="sa-sp"></span>
    <button class="sa-btn sm pri" onclick={openAdd}>{t('＋ 添加账号')}</button>
  </div>
  {#if !sa.accounts.length}
    <div class="sa-empty">{t('还没有账号')}</div>
  {:else}
    <div class="sa-rows">
      {#each sa.accounts as a (a.id)}
        <div class="sa-row">
          <span style="width:74px;flex:none">
            {#if a.active}<span class="sa-badge green">{t('● 当前')}</span>{:else}<span class="sa-badge gray">{t('待用')}</span>{/if}
          </span>
          <span class="sa-row-tx">
            <span style="font-weight:650">{accLabel(a.label)}</span>
            <small class="sa-mono">{a.hasToken ? '…' + (a.tokenTail || '') : t('用本机登录态（~/.claude）')}</small>
          </span>
          {#if !a.active}<button class="sa-btn sm pri" onclick={() => activate(a)}>{t('切到此号')}</button>{/if}
          <button class="sa-btn sm" onclick={() => openEdit(a)}>{t('编辑')}</button>
          {#if sa.accounts.length > 1}
            <button class="sa-btn sm dgr" onclick={() => del(a)}>{t('删除')}</button>
          {/if}
        </div>
      {/each}
    </div>
    <div style="height:8px"></div>
  {/if}
</div>
<div class="sa-foot" style="line-height:1.7">
  {@render richLine(t('切换**即时全局生效**：admin 对话、用户沙箱、定时路由的下一次生成都会用新账号的额度（正在跑的那一轮不受影响）。'))}<br />
  {@render richLine(t('两个账号**共享会话**（都落 ~/.claude）——一条对话可以在切号后无缝续聊，适合把两个订阅当额度池：一号限流了切另一号接着聊。'))}<br />
  {@render richLine(t('添加账号的 token：在**对应账号**登录状态下运行 `claude setup-token`，把返回的长期 token 粘进来；留空 token = 用本机 ~/.claude 已登录凭证。'))}
</div>

{#if editModal}
  <button class="sa-mask" aria-label={t('关闭')} onclick={() => (editModal = null)}></button>
  <div class="sa-modal">
    <h3>{editModal.isNew ? t('添加 Claude 账号') : t('编辑账号')}</h3>
    {#if editModal.isNew}
      <p>{@render richLine(t('在目标账号下运行 `claude setup-token` 拿到长期 token 后粘贴到这里。'))}</p>
    {/if}
    <div class="sa-lab">{t('名称')}</div>
    <input class="sa-in" placeholder={t('如：主号 / 备用号')} bind:value={editModal.label} />
    <div class="sa-lab">Token</div>
    <input class="sa-in sa-mono" style="font-size:12.5px"
      placeholder={editModal.isNew ? 'sk-ant-oat…' : (editModal.hasToken ? t('留空＝不改，当前 …{tail}', { tail: editModal.tokenTail || '' }) : t('留空＝用本机登录态'))}
      bind:value={editModal.token} />
    <div class="acts">
      <button class="sa-btn" onclick={() => (editModal = null)}>{t('取消')}</button>
      <button class="sa-btn pri" onclick={saveModal} disabled={busy}>{editModal.isNew ? t('添加') : t('保存')}</button>
    </div>
  </div>
{/if}

<style>
  /* 英文「Switch to this account」按钮宽得多：窄屏上徽章 + 账号名占一行、按钮换到下一行（只在 :lang(en) 下，中文不变） */
  @media (max-width: 560px) {
    .sa-row:lang(en) { flex-wrap: wrap; row-gap: 8px; }
    .sa-row:lang(en) .sa-row-tx { flex-basis: calc(100% - 86px); }
  }
</style>
