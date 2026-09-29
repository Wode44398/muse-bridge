<script>
  // 用户管理：账号列表（档位 / 状态 / 可用 agent / 用量 / 花费）+ 按人授权（能用哪些 agent、能否铸快照、
  // 是不是服务账号）+ 直接建账号 + 邀请码。
  // 主机形态（多用户关着）没有注册与邀请：这页只管「服务账号」——QQ 机器人这类程序用的账号。
  import { api } from '../../lib/api.js';
  import { sa, loadUsers, saToast, saConfirm, fmtNum, fmtAgo } from '../../lib/serverAdmin.svelte.js';
  import { t, tc, tr } from '../../lib/i18n.js';
  import SaAdminSessions from './SaAdminSessions.svelte';

  $effect(() => { sa.tick; loadUsers(); });

  // —— 弹窗态 ——
  let inviteModal = $state(null);   // { code, tier }
  let resetModal = $state(null);    // { name, pw }
  let delModal = $state(null);      // { name, purge }
  let createModal = $state(null);   // { name, pw, tier, service }
  let open = $state('');            // 展开了「权限」面板的那个用户
  let busy = $state(false);

  const AGENT_LABEL = { claude: 'Claude', dimensio: 'dimensio' };
  // 某个 agent 对这个人实际生效没有：他被勾了 + 全局开着 + 支持多用户
  const agentState = (id) => sa.agentStatus.find((a) => a.id === id) || null;
  const effective = (u) => (u.agents || []).filter((id) => { const a = agentState(id); return !a || (a.enabled && a.multiUser); });

  async function genInvite(tier) {
    if (busy) return; busy = true;
    try { const r = await api.post('/api/admin/invite', { tier }); inviteModal = { code: r.code, tier: r.tier }; loadUsers(); }
    catch (e) { saToast(tc('admin', '生成失败：{reason}', { reason: tr(String(e?.body?.error || e?.message || e)) }), true); }
    busy = false;
  }
  function copyText(text, msg = t('已复制')) { navigator.clipboard?.writeText(text).then(() => saToast(msg)).catch(() => {}); }

  async function post(path, body, okMsg) {
    try { const r = await api.post(path, body); if (r?.error) throw new Error(r.error); if (okMsg) saToast(okMsg); loadUsers(); return true; }
    catch (e) { saToast(tr(e?.body?.error || e?.message) || t('失败'), true); return false; }
  }
  const setTier = (u) => post('/api/admin/user/tier', { name: u.name, tier: u.tier === 'user' ? 'pro' : 'user' }, `${u.name} → ${u.tier === 'user' ? 'pro' : 'user'}`);
  const setDisabled = (u) => post('/api/admin/user/disable', { name: u.name, disabled: !u.disabled }, u.disabled ? t('已启用') : t('已禁用'));
  function toggleAgent(u, id) {
    const a = agentState(id);
    if (a && !a.multiUser) return;
    const has = (u.agents || []).includes(id);
    const next = has ? u.agents.filter((x) => x !== id) : [...(u.agents || []), id];
    u.agents = next;   // 先乐观更新，loadUsers 回来再校正
    post('/api/admin/user/agents', { name: u.name, agents: next });
  }
  // —— 额度（三端拆分 P4）：个人覆盖。空 = 跟默认；0 = 对他不限；数字 = 他的上限 ——
  let defaults = $state({});          // 策略里的默认额度（输入框占位符显示用）
  $effect(() => { sa.tick; api.get('/api/admin/policy').then((r) => { defaults = r?.policy?.quota || {}; }).catch(() => {}); });
  let qEdit = $state(null);           // { name, dayTurns, weekTurns, dayCostUsd, weekCostUsd }
  const Q_FIELDS = [
    { k: 'dayTurns', label: t('每天轮数') }, { k: 'weekTurns', label: t('7 天轮数') },
    { k: 'dayCostUsd', label: t('每天美元') }, { k: 'weekCostUsd', label: t('7 天美元') },
  ];
  function editQuota(u) {
    const q = u.quota || {};
    qEdit = { name: u.name, ...Object.fromEntries(Q_FIELDS.map((f) => [f.k, q[f.k] ?? ''])) };
  }
  async function saveQuota(reset = false) {
    const q = reset ? null : Object.fromEntries(Q_FIELDS.map((f) => [f.k, qEdit[f.k]]));
    if (await post('/api/admin/user/quota', { name: qEdit.name, quota: q }, reset ? t('已恢复默认额度') : t('已保存额度'))) qEdit = null;
  }
  const phDefault = (k) => (defaults[k] ? t('默认 {value}', { value: defaults[k] }) : t('默认不限'));
  // 表格里「今天 3/20 · 7 天 9/100」：有上限才显示分母
  function quotaLine(u) {
    const n = u.quotaNow; if (!n) return '';
    const l = n.limits || {};
    return t('今天 {day} 轮 · 7 天 {week}', { day: n.today.turns + (l.dayTurns ? '/' + l.dayTurns : ''), week: n.week.turns + (l.weekTurns ? '/' + l.weekTurns : '') });
  }
  const quotaHot = (u) => { const n = u.quotaNow; const l = n?.limits || {}; return !!n && ((l.dayTurns && n.today.turns >= l.dayTurns) || (l.weekTurns && n.week.turns >= l.weekTurns) || (l.dayCostUsd && n.today.costUsd >= l.dayCostUsd) || (l.weekCostUsd && n.week.costUsd >= l.weekCostUsd)); };
  const toggleSnapshot = (u) => post('/api/admin/user/snapshot', { name: u.name, snapshot: !u.snapshot }, u.snapshot ? t('已收回铸快照权限') : t('已允许铸快照'));
  async function toggleService(u) {
    // 主机形态下取消服务账号 = 这个账号立刻登不上了，问一句。
    if (u.service && !sa.multiUser && !(await saConfirm(t('取消 {name} 的服务账号身份？', { name: u.name }), t('这台主机没开多用户，取消后它会被立即登出且无法再登录。'), { yes: t('取消服务账号'), danger: true }))) return;
    post('/api/admin/user/service', { name: u.name, service: !u.service }, u.service ? t('已取消服务账号') : t('已设为服务账号'));
  }
  async function doReset() {
    const { name, pw } = resetModal || {};
    if (!pw) { saToast(t('密码不能为空'), true); return; }
    if (await post('/api/admin/user/reset', { name, password: pw }, t('已重置密码'))) resetModal = null;
  }
  async function doDelete() {
    const { name, purge } = delModal || {};
    delModal = null;
    post('/api/admin/user/delete', { name, purge: !!purge }, t('已删除 {name}', { name }));
  }
  async function doCreate() {
    const c = createModal || {};
    if (!c.name || !c.pw) { saToast(t('用户名和密码都要填'), true); return; }
    if (await post('/api/admin/user/create', { name: c.name, password: c.pw, tier: c.tier, service: c.service || !sa.multiUser }, t('已建账号 {name}', { name: c.name }))) createModal = null;
  }
</script>

{#snippet tierBadge(tier)}
  {#if tier === 'user'}<span class="sa-badge amber">user</span>
  {:else if tier === 'admin'}<span class="sa-badge blue">admin</span>
  {:else}<span class="sa-badge green">pro</span>{/if}
{/snippet}

{#snippet check(on, dis)}
  <span class="ack" class:on class:dis aria-hidden="true">
    {#if on}<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>{/if}
  </span>
{/snippet}

<div class="sa-card">
  <div class="sa-card-h uhead">
    <span class="uhead-t">{sa.multiUser ? tc('admin', '账号') : tc('admin', '服务账号')}</span>
    <span class="sa-sp"></span>
    <span class="uhead-acts">
      <button class="sa-btn sm" onclick={() => { createModal = { name: '', pw: '', tier: 'user', service: !sa.multiUser }; }}>{sa.multiUser ? t('＋ 新建账号') : t('＋ 新建服务账号')}</button>
      {#if sa.multiUser}
        <button class="sa-btn sm" onclick={() => genInvite('user')} disabled={busy}>{t('＋ 普通邀请码')}</button>
        <button class="sa-btn sm pri" onclick={() => genInvite('pro')} disabled={busy}>{t('＋ Pro 邀请码')}</button>
      {/if}
    </span>
  </div>
  {#if !sa.users.length}
    <div class="sa-empty">{sa.multiUser ? t('还没有账号——生成邀请码给对方注册，或直接新建') : t('没有服务账号')}</div>
  {:else}
    <div class="sa-thead ucols"><span>{t('用户名')}</span><span>{tc('admin', '档位')}</span><span>{t('状态')}</span><span>{t('能用的 agent')}</span><span>{t('用量')}</span><span></span></div>
    {#each sa.users as u (u.name)}
      {@const offBySwitch = !sa.multiUser && !u.service}
      <div class="sa-tr ucols">
        <b class="sa-trunc">{u.name}{#if u.service}<span class="svc">{t('服务')}</span>{/if}</b>
        <span>{@render tierBadge(u.tier)}</span>
        <span>
          {#if u.disabled}<span class="sa-badge red">{t('已禁用')}</span>
          {:else if offBySwitch}<span class="sa-badge gray">{t('登不上')}</span>
          {:else}<span class="sa-badge green">{tc('admin', '正常')}</span>{/if}
        </span>
        <span class="agents sa-trunc">{effective(u).map((id) => AGENT_LABEL[id] || id).join(' · ') || '—'}</span>
        <span class="usecell" title={t('累计 {tokens} tokens · ${cost}', { tokens: fmtNum(u.usage?.tokens), cost: (u.usage?.costUsd || 0).toFixed(2) })}>
          <span class:hot={quotaHot(u)}>{quotaLine(u)}</span>
          <small class="sa-mono sa-dim">{t('累计 ${cost}', { cost: (u.usage?.costUsd || 0).toFixed(2) })}</small>
        </span>
        <span class="acts">
          <button class="sa-btn sm" class:pri={open === u.name} onclick={() => { open = open === u.name ? '' : u.name; }}>{open === u.name ? t('收起') : t('管理')}</button>
        </span>
      </div>
      {#if open === u.name}
        <div class="perm">
          <div class="perm-acts">
            <button class="sa-btn sm" onclick={() => setTier(u)}>{u.tier === 'user' ? t('升为 Pro（给命令行）') : t('降为普通（收回命令行）')}</button>
            <button class="sa-btn sm" onclick={() => { resetModal = { name: u.name, pw: '' }; }}>{t('改密码')}</button>
            <button class="sa-btn sm" onclick={() => setDisabled(u)}>{u.disabled ? t('启用账号') : t('停用账号')}</button>
            <button class="sa-btn sm dgr" onclick={() => { delModal = { name: u.name, purge: false }; }}>{t('删除')}</button>
          </div>
          <div class="perm-h">{t('能用的 agent')}</div>
          <div class="perm-grid">
            {#each sa.agentStatus as a (a.id)}
              {@const dis = !a.multiUser || !a.enabled}
              {@const on = (u.agents || []).includes(a.id) && a.multiUser}
              <button class="perm-it" class:dis disabled={!a.multiUser} onclick={() => toggleAgent(u, a.id)}>
                {@render check(on, dis)}
                <span class="perm-tx">
                  <span>{a.label}</span>
                  <small>{!a.multiUser ? t('仅管理员（尚不支持多用户）') : !a.enabled ? t('全局已关（勾了也暂不生效）') : on ? t('可用') : t('未授权')}</small>
                </span>
              </button>
            {/each}
          </div>
          <div class="perm-h">{t('其它')}</div>
          <div class="perm-grid">
            <button class="perm-it" onclick={() => toggleSnapshot(u)}>
              {@render check(u.snapshot, false)}
              <span class="perm-tx"><span>{t('铸聊天快照')}</span><small>{t('开公开的 /c/ 对话链接（QQ 机器人的 /chat 用），用主机额度跑 Claude')}</small></span>
            </button>
            <button class="perm-it" onclick={() => toggleService(u)}>
              {@render check(u.service, false)}
              <span class="perm-tx"><span>{t('服务账号')}</span><small>{t('给程序用的账号（QQ 机器人这类）；主机关掉多用户后仍能登录')}</small></span>
            </button>
          </div>
          <div class="perm-h">{t('额度（只算 Claude）')}{#if u.quota}<span class="own">{t('单独设过')}</span>{/if}</div>
          {#if qEdit?.name === u.name}
            <div class="qgrid">
              {#each Q_FIELDS as f (f.k)}
                <label class="qf"><span>{f.label}</span><input class="sa-in" type="number" min="0" placeholder={phDefault(f.k)} bind:value={qEdit[f.k]} /></label>
              {/each}
            </div>
            <div class="perm-acts">
              <button class="sa-btn sm pri" onclick={() => saveQuota(false)}>{t('保存')}</button>
              {#if u.quota}<button class="sa-btn sm" onclick={() => saveQuota(true)}>{t('恢复默认')}</button>{/if}
              <button class="sa-btn sm ghost" onclick={() => { qEdit = null; }}>{t('取消')}</button>
            </div>
            <div class="qhint">{t('空着 = 跟默认（「额度与注册」页）；填 0 = 对他不限。')}</div>
          {:else}
            <div class="perm-acts">
              <span class="qnow">{quotaLine(u)}{u.quotaNow?.today?.costUsd ? ' · ' + t('今天 ${cost}', { cost: u.quotaNow.today.costUsd.toFixed(2) }) : ''}</span>
              <button class="sa-btn sm" onclick={() => editQuota(u)}>{t('调整额度')}</button>
            </div>
          {/if}
        </div>
      {/if}
    {/each}
    <div style="height:8px"></div>
  {/if}
</div>

{#if sa.multiUser}
  <div class="sa-card" style="margin-top:12px">
    <div class="sa-card-h">{tc('admin', '邀请码')}</div>
    {#if !sa.invites.length}
      <div class="sa-empty">{t('无')}</div>
    {:else}
      <div class="sa-thead icols"><span>{t('邀请码')}</span><span>{tc('admin', '档位')}</span><span>{t('状态')}</span><span>{tc('名词', '创建')}</span></div>
      {#each sa.invites as i (i.code)}
        <div class="sa-tr icols">
          <span class="sa-hrow"><span class="sa-mono">{i.code}</span><button class="sa-btn sm ghost" onclick={() => copyText(i.code)}>{t('复制')}</button></span>
          <span>{@render tierBadge(i.tier)}</span>
          <span>{#if i.used}<span class="sa-badge gray">{t('已用')}{i.usedBy ? ' · ' + i.usedBy : ''}</span>{:else}<span class="sa-badge green">{t('未使用')}</span>{/if}</span>
          <span class="sa-dim">{fmtAgo(i.created)}</span>
        </div>
      {/each}
      <div style="height:8px"></div>
    {/if}
  </div>
  <div class="sa-foot">{t('普通（user）档没有命令行；能用哪些 agent 在「权限」里按人勾选（新账号默认只有 Claude，dimensio 按人放行）。邀请码一次性。')}<br />{t('Pro 档有命令行：隔离是「软」的（路径与命令守卫防误操作，不防存心使坏），有命令行的人仍可能读到服务器上共享的订阅凭据、绕过字符串守卫——只给完全信任的人，邀请默认发普通档。')}</div>
{:else}
  <div class="sa-foot">{t('这台主机没开多用户：注册与邀请码关闭，只有管理员（访问令牌 / 扫码）和服务账号能登录。')}</div>
{/if}

<SaAdminSessions />

<!-- 新建账号 -->
{#if createModal}
  <button class="sa-mask" aria-label={t('关闭')} onclick={() => (createModal = null)}></button>
  <div class="sa-modal">
    <h3>{sa.multiUser ? t('新建账号') : t('新建服务账号')}</h3>
    <input class="sa-in" type="text" placeholder={t('用户名（字母 / 数字 / _ -）')} bind:value={createModal.name} />
    <input class="sa-in" type="text" placeholder={t('密码（至少 8 位）')} bind:value={createModal.pw} onkeydown={(e) => { if (e.key === 'Enter') doCreate(); }} />
    <div class="sa-hrow">
      <button class="sa-chip-btn" class:on={createModal.tier === 'user'} onclick={() => { createModal.tier = 'user'; }}>{t('普通（无命令行）')}</button>
      <button class="sa-chip-btn" class:on={createModal.tier === 'pro'} onclick={() => { createModal.tier = 'pro'; }}>{t('Pro（有命令行）')}</button>
    </div>
    {#if sa.multiUser}
      <label class="purge"><input type="checkbox" bind:checked={createModal.service} />{t('服务账号（给程序用，例如 QQ 机器人）')}</label>
    {/if}
    <div class="acts">
      <button class="sa-btn" onclick={() => (createModal = null)}>{t('取消')}</button>
      <button class="sa-btn pri" onclick={doCreate}>{t('建账号')}</button>
    </div>
  </div>
{/if}

<!-- 邀请码结果 -->
{#if inviteModal}
  <button class="sa-mask" aria-label={t('关闭')} onclick={() => (inviteModal = null)}></button>
  <div class="sa-modal">
    <h3>{t('邀请码已生成')}</h3>
    <p>{inviteModal.tier === 'pro' ? t('Pro（有命令行）单次邀请码，注册时填入：') : t('普通（无命令行）单次邀请码，注册时填入：')}</p>
    <div class="sa-hrow">
      <code class="sa-mono invite-code">{inviteModal.code}</code>
      <button class="sa-btn pri" onclick={() => copyText(inviteModal.code)}>{t('复制')}</button>
    </div>
    <div class="acts"><button class="sa-btn" onclick={() => (inviteModal = null)}>{t('关闭')}</button></div>
  </div>
{/if}

<!-- 改密 -->
{#if resetModal}
  <button class="sa-mask" aria-label={t('关闭')} onclick={() => (resetModal = null)}></button>
  <div class="sa-modal">
    <h3>{t('给 {name} 设新密码', { name: resetModal.name })}</h3>
    <input class="sa-in" type="text" placeholder={t('新密码')} bind:value={resetModal.pw}
      onkeydown={(e) => { if (e.key === 'Enter') doReset(); }} />
    <div class="acts">
      <button class="sa-btn" onclick={() => (resetModal = null)}>{t('取消')}</button>
      <button class="sa-btn pri" onclick={doReset}>{tc('admin', '重置')}</button>
    </div>
  </div>
{/if}

<!-- 删除（可选连磁盘清） -->
{#if delModal}
  <button class="sa-mask" aria-label={t('关闭')} onclick={() => (delModal = null)}></button>
  <div class="sa-modal">
    <h3>{t('删除账号 {name}？', { name: delModal.name })}</h3>
    <p>{t('勾选「连磁盘一起删」会清空该用户全部对话/媒体/文件，不可恢复；不勾则只删账号记录。')}</p>
    <label class="purge">
      <input type="checkbox" bind:checked={delModal.purge} />
      {t('连磁盘文件夹一起删（彻底）')}
    </label>
    <div class="acts">
      <button class="sa-btn" onclick={() => (delModal = null)}>{t('取消')}</button>
      <button class="sa-btn dgr" onclick={doDelete}>{t('删除')}</button>
    </div>
  </div>
{/if}

<style>
  :global(.sa-root) .ucols { grid-template-columns: minmax(90px, 1fr) 64px 76px minmax(120px, 1.2fr) minmax(110px, .9fr) auto; }
  /* 英文「状态」徽章（Can’t sign in / Disabled，等宽字）比 76px 宽：只在英文界面放宽这一列，中文不变 */
  :global(.sa-root) .ucols:lang(en) { grid-template-columns: minmax(90px, 1fr) 64px 112px minmax(120px, 1.2fr) minmax(110px, .9fr) auto; }
  :global(.sa-root) .icols { grid-template-columns: minmax(180px, 1.4fr) 64px minmax(100px, 1fr) 90px; }
  /* 弹窗里的两颗档位芯片英文更长：英文界面窄屏允许折行（只在 :lang(en) 下，中文外观不变） */
  .sa-modal .sa-hrow:lang(en) { flex-wrap: wrap; }
  .acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  /* 标题栏：标题不许被按钮挤成竖排；按钮组窄屏时整组换到下一行 */
  .uhead { flex-wrap: wrap; row-gap: 8px; padding-bottom: 6px; }
  .uhead-t { white-space: nowrap; }
  .uhead-acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .perm-acts { display: flex; gap: 6px; flex-wrap: wrap; padding: 2px 0 8px; }
  .agents { font-size: 12.5px; color: var(--sa-tx2); }
  .svc { margin-left: 6px; font-size: 10px; font-weight: 650; padding: 1px 6px; border-radius: 20px; background: rgba(94,92,230,.22); color: #b3b1ff; vertical-align: 1px; }
  .invite-code { flex: 1; font-size: 17px; background: rgba(255,255,255,.07); padding: 11px 14px; border-radius: 12px;
    box-shadow: inset 0 0 0 .5px rgba(255,255,255,.14); letter-spacing: .5px; }
  .purge { display: flex; align-items: center; gap: 9px; font-size: 13.5px; color: #e8e8e8; cursor: pointer; }
  .purge input { width: 17px; height: 17px; accent-color: var(--sa-red); }
  /* 按人授权面板：挂在该用户那一行下面 */
  .perm { margin: 2px 18px 10px; padding: 10px 12px 12px; border-radius: 16px; background: rgba(255,255,255,.05); box-shadow: inset 0 0 0 .5px rgba(255,255,255,.1); }
  .perm-h { font-size: 12px; font-weight: 600; color: var(--sa-tx3); padding: 4px 2px 6px; }
  .perm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px; margin-bottom: 6px; }
  .perm-it { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px; border: 0; background: rgba(255,255,255,.04);
    color: var(--sa-tx); font: inherit; text-align: left; cursor: pointer; }
  .perm-it:hover:not(:disabled) { background: rgba(255,255,255,.09); }
  .perm-it:disabled { cursor: default; }
  .perm-it.dis .perm-tx { opacity: .45; }
  .perm-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; font-size: 13.5px; }
  .perm-tx small { font-size: 11.5px; line-height: 1.4; color: var(--sa-tx3); }
  .ack { width: 22px; height: 22px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
    box-shadow: inset 0 0 0 1.6px rgba(255,255,255,.28); }
  .ack.on { background: var(--sa-blue); box-shadow: inset 0 .5px .5px rgba(255,255,255,.4), 0 2px 8px rgba(10,132,255,.4); }
  .ack.on.dis { background: rgba(10,132,255,.4); }
  .ack :global(svg) { width: 12px; height: 12px; }
  @media (max-width: 1080px) {
    :global(.sa-root) .ucols { grid-template-columns: minmax(80px, 1fr) 60px 70px auto; }
    :global(.sa-root) .ucols:lang(en) { grid-template-columns: minmax(80px, 1fr) 60px 108px auto; }
    :global(.sa-root) .ucols > :nth-child(4), :global(.sa-root) .ucols > :nth-child(5) { display: none; }
  }
  .usecell { display: flex; flex-direction: column; gap: 1px; min-width: 0; font-size: 12px; color: var(--sa-tx2); }
  .usecell .hot { color: #ff8078; }
  .usecell small { font-size: 11px; }
  .own { margin-left: 8px; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 6px; color: #64d2ff; background: rgba(100, 210, 255, .14); }
  .qgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-bottom: 8px; }
  .qf { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--sa-tx2); }
  .qf .sa-in { height: 38px; }
  .qhint { font-size: 11.5px; color: var(--sa-tx3); margin: -2px 0 8px; }
  .qnow { flex: 1; min-width: 0; font-size: 12.5px; color: var(--sa-tx2); }
</style>
