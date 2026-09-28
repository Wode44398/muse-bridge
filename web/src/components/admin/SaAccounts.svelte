<script>
  // Claude 账号切换（failover / 额度池）：整个 bridge 的 Claude Agent SDK 用哪个订阅。
  // 切换即时全局生效；两号共享会话（都落 ~/.claude），切号可无缝续同一条对话。
  import { api } from '../../lib/api.js';
  import { sa, loadAccounts, saToast, saConfirm } from '../../lib/serverAdmin.svelte.js';

  $effect(() => { sa.tick; loadAccounts(); });

  let editModal = $state(null);   // { id?, label, token, isNew }
  let busy = $state(false);

  async function activate(a) {
    try { const r = await api.post('/api/admin/claude-account/active', { id: a.id }); if (r?.error) throw new Error(r.error); saToast('已切换到 ' + a.label); loadAccounts(); }
    catch (e) { saToast(e?.message || '切换失败', true); }
  }
  function openAdd() { editModal = { label: '', token: '', isNew: true }; }
  function openEdit(a) { editModal = { id: a.id, label: a.label, token: '', isNew: false, hasToken: a.hasToken, tokenTail: a.tokenTail }; }
  async function saveModal() {
    if (busy) return;
    const m = editModal;
    if (m.isNew && !m.token.trim()) { saToast('token 不能为空', true); return; }
    busy = true;
    try {
      const r = m.isNew
        ? await api.post('/api/admin/claude-account/add', { label: m.label.trim(), token: m.token.trim() })
        : await api.post('/api/admin/claude-account/update', { id: m.id, label: m.label.trim(), token: m.token.trim() });
      if (r?.error) throw new Error(r.error);
      editModal = null; saToast(m.isNew ? '已添加' : '已保存'); loadAccounts();
    } catch (e) { saToast(e?.message || '失败', true); }
    busy = false;
  }
  async function del(a) {
    if (!(await saConfirm(`删除账号 ${a.label}？`, '只从切换列表移除；若删的是当前账号，会自动切到另一个。', { yes: '删除', danger: true }))) return;
    try { const r = await api.post('/api/admin/claude-account/delete', { id: a.id }); if (r?.error) throw new Error(r.error); saToast('已删除'); loadAccounts(); }
    catch (e) { saToast(e?.message || '失败', true); }
  }
</script>

<div class="sa-card">
  <div class="sa-card-h">Claude 订阅账号
    <span class="sa-sp"></span>
    <button class="sa-btn sm pri" onclick={openAdd}>＋ 添加账号</button>
  </div>
  {#if !sa.accounts.length}
    <div class="sa-empty">还没有账号</div>
  {:else}
    <div class="sa-rows">
      {#each sa.accounts as a (a.id)}
        <div class="sa-row">
          <span style="width:74px;flex:none">
            {#if a.active}<span class="sa-badge green">● 当前</span>{:else}<span class="sa-badge gray">待用</span>{/if}
          </span>
          <span class="sa-row-tx">
            <span style="font-weight:650">{a.label}</span>
            <small class="sa-mono">{a.hasToken ? '…' + (a.tokenTail || '') : '用本机登录态（~/.claude）'}</small>
          </span>
          {#if !a.active}<button class="sa-btn sm pri" onclick={() => activate(a)}>切到此号</button>{/if}
          <button class="sa-btn sm" onclick={() => openEdit(a)}>编辑</button>
          {#if sa.accounts.length > 1}
            <button class="sa-btn sm dgr" onclick={() => del(a)}>删除</button>
          {/if}
        </div>
      {/each}
    </div>
    <div style="height:8px"></div>
  {/if}
</div>
<div class="sa-foot" style="line-height:1.7">
  切换<b style="color:rgba(255,255,255,.7)">即时全局生效</b>：admin 对话、用户沙箱、定时路由的下一次生成都会用新账号的额度（正在跑的那一轮不受影响）。<br />
  两个账号<b style="color:rgba(255,255,255,.7)">共享会话</b>（都落 ~/.claude）——一条对话可以在切号后无缝续聊，适合把两个订阅当额度池：一号限流了切另一号接着聊。<br />
  添加账号的 token：在<b style="color:rgba(255,255,255,.7)">对应账号</b>登录状态下运行 <code class="sa-mono">claude setup-token</code>，把返回的长期 token 粘进来；留空 token = 用本机 ~/.claude 已登录凭证。
</div>

{#if editModal}
  <button class="sa-mask" aria-label="关闭" onclick={() => (editModal = null)}></button>
  <div class="sa-modal">
    <h3>{editModal.isNew ? '添加 Claude 账号' : '编辑账号'}</h3>
    {#if editModal.isNew}
      <p>在目标账号下运行 <code class="sa-mono">claude setup-token</code> 拿到长期 token 后粘贴到这里。</p>
    {/if}
    <div class="sa-lab">名称</div>
    <input class="sa-in" placeholder="如：主号 / 备用号" bind:value={editModal.label} />
    <div class="sa-lab">Token</div>
    <input class="sa-in sa-mono" style="font-size:12.5px"
      placeholder={editModal.isNew ? 'sk-ant-oat…' : (editModal.hasToken ? '留空＝不改，当前 …' + (editModal.tokenTail || '') : '留空＝用本机登录态')}
      bind:value={editModal.token} />
    <div class="acts">
      <button class="sa-btn" onclick={() => (editModal = null)}>取消</button>
      <button class="sa-btn pri" onclick={saveModal} disabled={busy}>{editModal.isNew ? '添加' : '保存'}</button>
    </div>
  </div>
{/if}
