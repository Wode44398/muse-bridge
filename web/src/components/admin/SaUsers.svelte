<script>
  // 用户管理：账号列表（档位 / 状态 / 可用 agent / 用量 / 花费）+ 按人授权（能用哪些 agent、能否铸快照、
  // 是不是服务账号）+ 直接建账号 + 邀请码。
  // 主机形态（多用户关着）没有注册与邀请：这页只管「服务账号」——QQ 机器人这类程序用的账号。
  import { api } from '../../lib/api.js';
  import { sa, loadUsers, saToast, saConfirm, fmtNum, fmtAgo } from '../../lib/serverAdmin.svelte.js';
  import { t, tc, tr } from '../../lib/i18n.js';
  import SaAdminSessions from './SaAdminSessions.svelte';
  import SaAccess from './SaAccess.svelte';

  $effect(() => { sa.tick; loadUsers(); });

  // —— 弹窗态 ——（按人的接口 name 字段传账号 id：登录名能改，id 不变；老账号 id = 用户名）
  let inviteModal = $state(null);   // { code, tier, expiresAt }
  let resetModal = $state(null);    // { name, id, pw }
  let delModal = $state(null);      // { name, id, mode: 'purge' | 'archive' }
  let createModal = $state(null);   // { name, pw, tier, service }
  let renameModal = $state(null);   // { name, id, next }
  let open = $state('');            // 展开了「权限」面板的那个用户
  let busy = $state(false);

  const AGENT_LABEL = { claude: 'Claude', dimensio: 'dimensio' };
  // 某个 agent 对这个人实际生效没有：他被勾了 + 全局开着 + 支持多用户
  const agentState = (id) => sa.agentStatus.find((a) => a.id === id) || null;
  const effective = (u) => (u.agents || []).filter((id) => { const a = agentState(id); return !a || (a.enabled && a.multiUser); });

  // Pro = 等同管理员（L1 逻辑隔离下命令行没有可靠边界）：发码 / 建号 / 升档前都先说清楚再确认（服务端要 ack）。
  const FULL_WHAT = () => t('Pro 档有命令行和终端，跑在服务端同一个系统账户下：能读到服务器上所有人的对话、文件和全部凭据（Claude 登录凭据、各家 API Key），等同管理员。只给你完全信任的人。');
  const confirmFull = (title) => saConfirm(title, FULL_WHAT(), { yes: t('我了解，给 Pro'), danger: true });
  async function genInvite(tier) {
    if (busy) return;
    if (tier === 'pro' && !(await confirmFull(t('发 Pro 邀请码？')))) return;
    busy = true;
    try { const r = await api.post('/api/admin/invite', { tier, ...(tier === 'pro' ? { ack: true } : {}) }); inviteModal = { code: r.code, tier: r.tier, expiresAt: r.expiresAt || null }; loadUsers(); }
    catch (e) { saToast(tc('admin', '生成失败：{reason}', { reason: tr(String(e?.body?.error || e?.message || e)) }), true); }
    busy = false;
  }
  const revokeInvite = (i) => post('/api/admin/invite/revoke', { code: i.code }, t('已作废'));
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString() : '');
  function copyText(text, msg = t('已复制')) { navigator.clipboard?.writeText(text).then(() => saToast(msg)).catch(() => {}); }

  async function post(path, body, okMsg) {
    try { const r = await api.post(path, body); if (r?.error) throw new Error(r.error); if (okMsg) saToast(okMsg); loadUsers(); return true; }
    catch (e) { saToast(tr(e?.body?.error || e?.message) || t('失败'), true); return false; }
  }
  const uid = (u) => u.id || u.name;
  async function setTier(u) {
    if (u.tier === 'user') {
      if (!(await confirmFull(t('把 {name} 升为 Pro？', { name: u.name })))) return;
      post('/api/admin/user/tier', { name: uid(u), tier: 'pro', ack: true }, t('{name} 已升为 Pro', { name: u.name }));
    } else {
      // 降档当场生效（runtime/account-lifecycle.mjs setAccountTier）：在跑的轮是带着命令行开的，得中止
      if (!(await saConfirm(t('把 {name} 降为普通？', { name: u.name }), t('马上收回命令行：他正在跑的对话会中止，侧栏终端关掉。账号、对话和文件都保留，以后可以再升回来。'), { yes: t('降为普通') }))) return;
      post('/api/admin/user/tier', { name: uid(u), tier: 'user' }, t('{name} 已降为普通', { name: u.name }));
    }
  }
  async function ackTrust(u) {
    if (!(await confirmFull(t('确认 {name} 保留 Pro？', { name: u.name })))) return;
    post('/api/admin/user/trust-ack', { name: uid(u) }, t('已确认'));
  }
  async function setDisabled(u) {
    if (!u.disabled && !(await saConfirm(t('停用 {name}？', { name: u.name }), t('他会立刻被登出、在跑的对话会中止，他发出去的聊天快照链接也会关掉；数据都保留，重新启用后就能照常登录。'), { yes: t('停用'), danger: true }))) return;
    post('/api/admin/user/disable', { name: uid(u), disabled: !u.disabled }, u.disabled ? t('已启用') : t('已禁用'));
  }
  async function doRename() {
    const m = renameModal || {};
    if (!m.next) { saToast(t('新登录名不能为空'), true); return; }
    if (await post('/api/admin/user/rename', { name: m.id, newName: m.next }, t('已改名为 {name}', { name: m.next }))) renameModal = null;
  }
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
  // 成员允许了管理员什么（后端 runtime/admin-access.mjs）：只读展示，开关在成员自己的设置里
  const ACCESS_LABELS = () => [['view', t('看对话内容')], ['assist', t('代聊与代答')]];
  const accessLine = (u) => {
    const a = u.adminAccess || {};
    const on = ACCESS_LABELS().filter(([k]) => a[k]).map(([, l]) => l);
    return on.length ? t('已允许：{list}', { list: on.join(' · ') }) : t('只看得到元数据（会话标题、时间、用量）');
  };
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
  // 删号联动清理：登录、在跑的对话、聊天快照、邀请记录、用量一并收掉；数据默认一起删，或归档。
  async function doDelete() {
    const { name, id, mode } = delModal || {};
    delModal = null;
    try {
      const r = await api.post('/api/admin/user/delete', { name: id || name, mode: mode === 'archive' ? 'archive' : 'purge' });
      if (r?.error) throw new Error(r.error);
      if (r?.dataError) saToast(t('已删除 {name}，但数据没处理完：{reason}', { name, reason: tr(r.dataError) }), true);
      // 他还有页面连着（手机切后台之类）：目录等连接断开后自动处理（account-lifecycle finishPendingData）
      else if (r?.data === 'pending') saToast(r.want === 'archive' ? t('已删除 {name}；他还有页面开着，断开后数据自动归档', { name }) : t('已删除 {name}；他还有页面开着，断开后数据自动删除', { name }));
      else saToast(r?.data === 'archived' ? t('已删除 {name}，数据已归档', { name }) : t('已删除 {name}', { name }));
    } catch (e) { saToast(tr(e?.body?.error || e?.message) || t('失败'), true); }
    loadUsers();
  }
  async function doCreate() {
    const c = createModal || {};
    if (!c.name || !c.pw) { saToast(t('用户名和密码都要填'), true); return; }
    if (c.tier === 'pro' && !(await confirmFull(t('建一个 Pro 账号？')))) return;
    if (await post('/api/admin/user/create', { name: c.name, password: c.pw, tier: c.tier, ...(c.tier === 'pro' ? { ack: true } : {}), service: c.service || !sa.multiUser }, t('已建账号 {name}', { name: c.name }))) createModal = null;
  }
</script>

{#snippet tierBadge(tier)}
  {#if tier === 'user'}<span class="sa-badge green">{t('普通')}</span>
  {:else if tier === 'admin'}<span class="sa-badge blue">admin</span>
  {:else}<span class="sa-badge amber">Pro</span>{/if}
{/snippet}

{#snippet check(on, dis)}
  <span class="ack" class:on class:dis aria-hidden="true">
    {#if on}<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>{/if}
  </span>
{/snippet}

<SaAccess />

<div class="sa-card">
  <div class="sa-card-h uhead">
    <span class="uhead-t">{sa.multiUser ? tc('admin', '账号') : tc('admin', '服务账号')}</span>
    <span class="sa-sp"></span>
    <span class="uhead-acts">
      <button class="sa-btn sm" onclick={() => { createModal = { name: '', pw: '', tier: 'user', service: !sa.multiUser }; }}>{sa.multiUser ? t('＋ 新建账号') : t('＋ 新建服务账号')}</button>
      {#if sa.multiUser}
        <button class="sa-btn sm pri" onclick={() => genInvite('user')} disabled={busy}>{t('＋ 普通邀请码')}</button>
        <button class="sa-btn sm" onclick={() => genInvite('pro')} disabled={busy}>{t('＋ Pro 邀请码')}</button>
      {/if}
    </span>
  </div>
  {#if !sa.users.length}
    <div class="sa-empty">{sa.multiUser ? t('还没有账号——生成邀请码给对方注册，或直接新建') : t('没有服务账号')}</div>
  {:else}
    <div class="sa-thead ucols"><span>{t('用户名')}</span><span>{tc('admin', '档位')}</span><span>{t('状态')}</span><span>{t('能用的 agent')}</span><span>{t('用量')}</span><span></span></div>
    {#each sa.users as u (u.id || u.name)}
      {@const offBySwitch = !sa.multiUser && !u.service}
      <div class="sa-tr ucols">
        <b class="sa-trunc" title={u.id && u.id !== u.name ? t('账号 id：{id}', { id: u.id }) : ''}>{u.name}{#if u.service}<span class="svc">{t('服务')}</span>{/if}</b>
        <span>{@render tierBadge(u.tier)}{#if u.trustPending}<span class="pend" title={t('升级前开的 Pro 账号，等你确认')}>{t('待确认')}</span>{/if}</span>
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
            {#if u.trustPending}<button class="sa-btn sm pri" onclick={() => ackTrust(u)}>{t('确认保留 Pro')}</button>{/if}
            <button class="sa-btn sm" onclick={() => setTier(u)}>{u.tier === 'user' ? t('升为 Pro（给命令行）') : t('降为普通（收回命令行）')}</button>
            <button class="sa-btn sm" onclick={() => { resetModal = { name: u.name, pw: '' }; }}>{t('改密码')}</button>
            <button class="sa-btn sm" onclick={() => { renameModal = { name: u.name, id: uid(u), next: u.name }; }}>{t('改登录名')}</button>
            <button class="sa-btn sm" onclick={() => setDisabled(u)}>{u.disabled ? t('启用账号') : t('停用账号')}</button>
            <button class="sa-btn sm dgr" onclick={() => { delModal = { name: u.name, id: uid(u), mode: 'purge' }; }}>{t('删除')}</button>
          </div>
          {#if u.tier !== 'user'}<div class="trust-note">{FULL_WHAT()}</div>{/if}
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
          <div class="perm-h">{t('他允许管理员做什么')}</div>
          <div class="perm-acts"><span class="qnow">{accessLine(u)}</span></div>
          <div class="qhint">{t('由成员在自己的「设置 › 账户 › 管理员可见性」里决定；你每次查看内容或代聊代答，他那边都有记录。服务账号默认全允许。')}</div>
          <div class="perm-h">{t('额度')}{#if u.quota}<span class="own">{t('单独设过')}</span>{/if}</div>
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
          <span class="sa-hrow"><span class="sa-mono">{i.code}</span>{#if !i.used && !i.expired}<button class="sa-btn sm ghost" onclick={() => copyText(i.code)}>{t('复制')}</button>{/if}{#if !i.used}<button class="sa-btn sm ghost" onclick={() => revokeInvite(i)}>{t('作废')}</button>{/if}</span>
          <span>{@render tierBadge(i.tier)}</span>
          <span class="istat">{#if i.used}<span class="sa-badge gray">{t('已用')}{i.usedBy ? ' · ' + i.usedBy : ''}</span>{:else if i.expired}<span class="sa-badge gray">{t('已过期')}</span>{:else}<span class="sa-badge green" title={i.expiresAt ? t('{date} 到期', { date: fmtDate(i.expiresAt) }) : t('老邀请码，不会过期')}>{t('未使用')}</span>{#if i.legacyFull}<span class="pend" title={t('升级前发的 Pro 码：不过期，用它注册立刻就有命令行、等同管理员。不再需要就作废。')}>{t('老码·不过期·等同管理员')}</span>{/if}{/if}</span>
          <span class="sa-dim">{fmtAgo(i.created)}</span>
        </div>
      {/each}
      <div style="height:8px"></div>
    {/if}
  </div>
  <div class="sa-foot">{t('普通（user）档没有命令行；能用哪些 agent 在「权限」里按人勾选（新账号默认只有 Claude，dimensio 按人放行）。邀请码一次性。')}<br />{t('邀请码 7 天内有效，没用的可以作废；Pro 码要你确认后才发，默认只发普通档。删掉的账号 id 不再复用：同名的人重新注册拿不到旧人的任何东西。')}</div>
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
    <p>{inviteModal.tier === 'pro' ? t('Pro（有命令行）单次邀请码，注册时填入：') : t('普通（无命令行）单次邀请码，注册时填入：')}{#if inviteModal.expiresAt}<br /><small class="sa-dim">{t('{date} 前有效', { date: fmtDate(inviteModal.expiresAt) })}</small>{/if}</p>
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

<!-- 删除：登录、在跑的对话、聊天快照、邀请记录、用量一并收掉；数据默认一起删，可改成归档 -->
{#if delModal}
  <button class="sa-mask" aria-label={t('关闭')} onclick={() => (delModal = null)}></button>
  <div class="sa-modal">
    <h3>{t('删除账号 {name}？', { name: delModal.name })}</h3>
    <p>{t('他会立刻被登出；在跑的对话中止，他铸的聊天快照、用过的邀请记录和用量一并删除。这个账号 id 以后不再使用：同名的人重新注册，拿不到他的任何东西。')}</p>
    <label class="purge">
      <input type="radio" name="del-mode" value="purge" bind:group={delModal.mode} />
      {t('连对话、文件、媒体一起删（不可恢复）')}
    </label>
    <label class="purge keep">
      <input type="radio" name="del-mode" value="archive" bind:group={delModal.mode} />
      {t('数据归档：整个目录挪进用户根下的 _archive 文件夹，只有你能找回')}
    </label>
    <div class="acts">
      <button class="sa-btn" onclick={() => (delModal = null)}>{t('取消')}</button>
      <button class="sa-btn dgr" onclick={doDelete}>{delModal.mode === 'archive' ? t('删除并归档') : t('删除')}</button>
    </div>
  </div>
{/if}

<!-- 改登录名：账号 id、目录、对话都不动 -->
{#if renameModal}
  <button class="sa-mask" aria-label={t('关闭')} onclick={() => (renameModal = null)}></button>
  <div class="sa-modal">
    <h3>{t('改 {name} 的登录名', { name: renameModal.name })}</h3>
    <p>{t('只改登录用的名字：他的对话、文件、用量都跟着账号走，不受影响。他下次登录要用新名字。')}</p>
    <input class="sa-in" type="text" placeholder={t('新登录名（字母 / 数字 / _ -）')} bind:value={renameModal.next}
      onkeydown={(e) => { if (e.key === 'Enter') doRename(); }} />
    <div class="acts">
      <button class="sa-btn" onclick={() => (renameModal = null)}>{t('取消')}</button>
      <button class="sa-btn pri" onclick={doRename}>{t('改名')}</button>
    </div>
  </div>
{/if}

<style>
  /* 档位列：「Pro」徽章 + 「待确认」小签，放不下就折行 */
  :global(.sa-root) .ucols { grid-template-columns: minmax(90px, 1fr) 96px 76px minmax(120px, 1.2fr) minmax(110px, .9fr) auto; }
  /* 英文「状态」徽章（Can’t sign in / Disabled，等宽字）比 76px 宽：只在英文界面放宽这一列，中文不变 */
  :global(.sa-root) .ucols:lang(en) { grid-template-columns: minmax(90px, 1fr) 104px 112px minmax(120px, 1.2fr) minmax(110px, .9fr) auto; }
  :global(.sa-root) .icols { grid-template-columns: minmax(180px, 1.4fr) 96px minmax(100px, 1fr) 90px; }
  :global(.sa-root) .ucols > :nth-child(2) { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
  :global(.sa-root) .ucols > :nth-child(2) .pend { margin-left: 0; }
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
  .purge.keep input { accent-color: var(--sa-blue); }
  .pend { margin-left: 6px; font-size: 10px; font-weight: 650; padding: 1px 6px; border-radius: 20px; background: rgba(255, 179, 64, .2); color: #ffb340; vertical-align: 1px; white-space: nowrap; }
  .trust-note { font-size: 11.5px; line-height: 1.5; color: #ffb340; margin: -2px 2px 8px; }
  /* 邀请码状态列：「未使用」+「老码·不过期·等同管理员」放不下就折行 */
  .istat { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
  .istat .pend { margin-left: 0; white-space: normal; }
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
    :global(.sa-root) .ucols { grid-template-columns: minmax(80px, 1fr) 84px 70px auto; }
    :global(.sa-root) .ucols:lang(en) { grid-template-columns: minmax(80px, 1fr) 92px 108px auto; }
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
