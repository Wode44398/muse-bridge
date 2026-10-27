<script>
  // Claude 账号切换（failover / 额度池）：整个 bridge 的 Claude Agent SDK 用哪个订阅。
  // 切换即时全局生效；两号共享会话（都落 ~/.claude），切号可无缝续同一条对话。
  import { api } from '../../lib/api.js';
  import { sa, loadAccounts, saToast, saConfirm } from '../../lib/serverAdmin.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  $effect(() => { sa.tick; loadAccounts(); });

  // 逐号用量：5 小时 / 每周 / Fable 周限额（Pro 没有 Fable 额度）。服务端 5 分钟缓存，「刷新」强刷。
  let usage = $state({});
  let usageBusy = $state(false);
  async function loadUsage(force = false) {
    usageBusy = true;
    try { usage = (await api.get('/api/admin/claude-accounts/usage' + (force ? '?force=1' : '')))?.usage || {}; } catch {}
    usageBusy = false;
  }
  $effect(() => { sa.tick; loadUsage(); });
  const resetIn = (ms) => {
    const d = (ms || 0) - Date.now();
    if (d <= 0) return '';
    const m = Math.round(d / 60000);
    if (m < 60) return t('{n} 分钟后重置', { n: Math.max(1, m) });
    if (m < 48 * 60) return t('{n} 小时后重置', { n: Math.round(m / 60) });
    return t('{n} 天后重置', { n: Math.round(m / 1440) });
  };
  const tone = (b) => (b.status === 'rejected' || b.pct >= 100 ? 'red' : b.pct >= 80 ? 'amber' : 'ok');

  // 智能路由（可选，默认关）：某号额度用尽时自动换到号池里的可用号（src/runtime/account-router.mjs）。
  let rt = $state(null);   // { settings:{enabled,returnToPrimary}, blocks:{[id]:{until,type}}, log:[…] }
  let rtBusy = $state(false);
  async function loadRouter() { try { rt = await api.get('/api/admin/claude-accounts/router'); } catch {} }
  $effect(() => { sa.tick; loadRouter(); });
  async function setRouter(patch) {
    if (rtBusy) return;
    rtBusy = true;
    try { const r = await api.post('/api/admin/claude-account/router', patch); if (r?.error) throw new Error(r.error); await loadRouter(); }
    catch (e) { saToast(tr(e?.message) || t('失败'), true); }
    rtBusy = false;
  }
  async function move(a, delta) {
    try { const r = await api.post('/api/admin/claude-account/move', { id: a.id, delta }); if (r?.error) throw new Error(r.error); loadAccounts(); }
    catch (e) { saToast(tr(e?.message) || t('失败'), true); }
  }
  const BLOCK_WHY = { five_hour: () => t('5 小时额度已满'), seven_day: () => t('本周额度已满'), seven_day_opus: () => t('Opus 周额度已满'), seven_day_sonnet: () => t('Sonnet 周额度已满'), seven_day_overage_included: () => t('Fable 周额度已满'), auth: () => t('token 失效'), primary_back: () => t('首选号额度已恢复'),
    // 会话中无缝换号：还没真用满、提前让位（account-router 的 near:<桶>）
    'near:five_hour': () => t('5 小时额度快满了'), 'near:seven_day': () => t('本周额度快满了'), 'near:seven_day_opus': () => t('Opus 周额度快满了'), 'near:seven_day_sonnet': () => t('Sonnet 周额度快满了'), 'near:seven_day_overage_included': () => t('Fable 周额度快满了') };
  const whyText = (k) => (BLOCK_WHY[k] || (() => t('额度已满')))();
  const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const labelById = (id, fallback) => { const a = sa.accounts.find((x) => x.id === id); return accLabel(a ? a.label : fallback); };

  let editModal = $state(null);   // { id?, label, token, isNew }
  let busy = $state(false);

  // 脚注整句一个键：键里用 **加粗**、`代码` 标出行内的 <b> / <code>，渲染时切段（中文 DOM 与原来一致）
  const rich = (s) => s.split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean);
  // 服务端自动起的账号名（claude-account.mjs 的「默认账号」「账号 N」）跟着界面语言显示；管理员自己起的名字原样
  const AUTO_LABEL = /^(?:默认账号|账号 (\d+))$/;   // i18n-ignore 匹配服务端数据
  const accLabel = (l) => {
    const m = AUTO_LABEL.exec(l || '');
    return !m ? l : m[1] ? t('账号 {n}', { n: m[1] }) : t('默认账号');
  };

  async function activate(a) {
    try { const r = await api.post('/api/admin/claude-account/active', { id: a.id }); if (r?.error) throw new Error(r.error); saToast(t('已切换到 {name}', { name: accLabel(a.label) })); loadAccounts(); loadRouter(); }
    catch (e) { saToast(tr(e?.message) || t('切换失败'), true); }
  }
  function openAdd() { editModal = { label: '', token: '', isNew: true }; }
  function openEdit(a) { editModal = { id: a.id, label: a.label, token: '', isNew: false, hasToken: a.hasToken, tokenTail: a.tokenTail }; }
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
    <button class="sa-btn sm" onclick={() => loadUsage(true)} disabled={usageBusy}>{usageBusy ? t('刷新中…') : t('刷新用量')}</button>
    <button class="sa-btn sm pri" onclick={openAdd}>{t('＋ 添加账号')}</button>
  </div>
  {#if !sa.accounts.length}
    <div class="sa-empty">{t('还没有账号')}</div>
  {:else}
    <div class="sa-rows">
      {#each sa.accounts as a, ai (a.id)}
        {@const u = usage[a.id]}
        <div class="sa-row acct">
          <span style="width:74px;flex:none">
            {#if a.active}<span class="sa-badge green">{t('● 当前')}</span>{:else}<span class="sa-badge gray">{t('待用')}</span>{/if}
          </span>
          <span class="sa-row-tx">
            <span style="font-weight:650">{accLabel(a.label)}
              {#if u?.plan === 'max'}<span class="sa-badge purple plan">Max</span>{:else if u?.plan === 'pro'}<span class="sa-badge blue plan">Pro</span>{/if}
            </span>
            <small class="sa-mono">{a.hasToken ? '…' + (a.tokenTail || '') : t('用本机登录态（~/.claude）')}</small>
          </span>
          {#if rt?.settings?.enabled && sa.accounts.length > 1}
            <span class="ord">
              <button class="sa-btn sm" disabled={ai === 0} onclick={() => move(a, -1)} aria-label={t('上移')}>↑</button>
              <button class="sa-btn sm" disabled={ai === sa.accounts.length - 1} onclick={() => move(a, 1)} aria-label={t('下移')}>↓</button>
            </span>
          {/if}
          {#if !a.active}<button class="sa-btn sm pri" onclick={() => activate(a)}>{t('切到此号')}</button>{/if}
          <button class="sa-btn sm" onclick={() => openEdit(a)}>{t('编辑')}</button>
          {#if sa.accounts.length > 1}
            <button class="sa-btn sm dgr" onclick={() => del(a)}>{t('删除')}</button>
          {/if}
        </div>
        <div class="meters">
          {#if !u}
            <span class="m-note">{usageBusy ? t('读取用量…') : '—'}</span>
          {:else if u.error && !u.five_hour && !u.seven_day}
            <span class="m-note err">{tr(u.error)}</span>
          {:else}
            {#each [['five_hour', t('5 小时')], ['seven_day', t('每周')], ['fable', 'Fable']] as [k, name] (k)}
              {@const b = u[k]}
              <div class="m">
                <div class="m-h"><span>{name}</span>
                  {#if b}<b class={tone(b)}>{b.pct}%</b>{:else}<span class="m-na">—</span>{/if}
                </div>
                <div class="m-bar"><i class={b ? tone(b) : ''} style="width:{b ? Math.min(100, b.pct) : 0}%"></i></div>
                <small>{b ? (b.status === 'rejected' ? t('已达上限') + ' · ' : '') + resetIn(b.resetsAt) : (k === 'fable' && u.plan === 'pro' ? t('Pro 无此额度') : '')}</small>
              </div>
            {/each}
          {/if}
        </div>
      {/each}
    </div>
    <div style="height:8px"></div>
  {/if}
</div>
<!-- 服务端标 source:'last-use' 时，用量是各号上次使用时的，说一句免得以为是实时的（同两套设置页） -->
{#if Object.values(usage || {}).some((u) => u?.source === 'last-use')}
  <div class="sa-foot" style="line-height:1.7">{t('闲置的号显示它上次使用时的额度；还没用过的号要用过一次才有数据。')}</div>
{/if}
<div class="sa-foot" style="line-height:1.7">
  {@render richLine(t('切换**即时全局生效**：admin 对话、用户沙箱、定时路由的下一次生成都会用新账号的额度（正在跑的那一轮不受影响）。'))}<br />
  {@render richLine(t('两个账号**共享会话**（都落 ~/.claude）——一条对话可以在切号后无缝续聊，适合把两个订阅当额度池：一号限流了切另一号接着聊。'))}<br />
  {@render richLine(t('添加账号的 token：在**对应账号**登录状态下运行 `claude setup-token`，把返回的长期 token 粘进来；留空 token = 用本机 ~/.claude 已登录凭证。'))}
</div>

<div class="sa-card" style="margin-top:14px">
  <div class="sa-card-h">{t('智能路由')}</div>
  <div class="sa-rows">
    <div class="sa-row">
      <span class="sa-row-tx">
        <span>{t('额度用尽自动换号')}</span>
        <small>{sa.accounts.length < 2 ? t('号池里至少要有两个账号才用得上') : rt?.settings?.enabled ? t('当前号某项额度用满（或 token 失效）时，自动换到号池里还有余量的账号') : t('已关闭：额度用满时照旧报错，由你手动切号')}</small>
      </span>
      <button class="sa-sw" class:on={rt?.settings?.enabled} disabled={!rt || rtBusy} onclick={() => setRouter({ enabled: !rt.settings.enabled })} role="switch" aria-checked={!!rt?.settings?.enabled} aria-label={t('额度用尽自动换号')}><span class="sa-sw-knob"></span></button>
    </div>
    {#if rt?.settings?.enabled}
      <div class="sa-row">
        <span class="sa-row-tx">
          <span>{t('额度恢复后回到首选号')}</span>
          <small>{rt.settings.returnToPrimary ? t('每轮都用列表里最靠前的可用号：主号一恢复就切回，备用号只在主号用满时顶上') : t('用满再换：当前号能用就一直用它，用满才换到余量最多的号')}</small>
        </span>
        <button class="sa-sw" class:on={rt.settings.returnToPrimary} disabled={rtBusy} onclick={() => setRouter({ returnToPrimary: !rt.settings.returnToPrimary })} role="switch" aria-checked={rt.settings.returnToPrimary} aria-label={t('额度恢复后回到首选号')}><span class="sa-sw-knob"></span></button>
      </div>
      <div class="sa-row">
        <span class="sa-row-tx">
          <span>{t('会话中无缝换号')}</span>
          <small>{rt.settings.seamless ? t('模型请求经本机代理逐个选号：当前号快用满（98%）或撞墙时，在两步之间换到下一个号接着跑，对话不中断、不用重发') : t('已关闭：撞墙后这一轮先停下，再换号重发或接着做')}</small>
        </span>
        <button class="sa-sw" class:on={rt.settings.seamless} disabled={rtBusy} onclick={() => setRouter({ seamless: !rt.settings.seamless })} role="switch" aria-checked={!!rt.settings.seamless} aria-label={t('会话中无缝换号')}><span class="sa-sw-knob"></span></button>
      </div>
      {#if rt.log?.length}
        <div class="rt-log">
          <div class="rt-log-h">{t('最近的自动切换')}</div>
          {#each rt.log as l (l.at)}
            <div class="rt-log-r"><span class="sa-mono">{hhmm(l.at)}</span> {labelById(l.from, l.fromLabel)} → {labelById(l.to, l.toLabel)} <small>{whyText(l.reason)}</small></div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>
<div class="sa-foot" style="line-height:1.7">
  {@render richLine(t('开跑前先看当前号：已知用满就**现探**其余各号此刻的余量，换到能用的号再开跑；跑到一半撞墙，则给该号记冷却到重置时刻并立刻换号——新版 App 会**自动用新号重发**这条消息（已经干了一半的就让它接着做），不用你动手。'))}<br />
  {@render richLine(t('额度按本轮模型判断：Opus 用满不影响 Fable 余量的判断，反之亦然；Pro 号没有 Fable 额度，Fable 对话不会切到 Pro 号。列表顺序就是「回到首选号」的优先级，用 ↑↓ 调整。'))}
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
  /* 逐号用量条：缩进对齐账号名（徽章列 74px + 行间距 12px），三列等分 */
  .sa-row.acct { padding-bottom: 4px; }
  .meters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; padding: 0 0 13px 86px; }
  .plan { margin-left: 6px; padding: 1px 7px; font-size: 10.5px; vertical-align: 1px; }
  .m { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .m-h { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; font-size: 12px; color: var(--sa-tx2); }
  .m-h b { font: 650 12.5px var(--sa-mono); color: var(--sa-tx); }
  .m-h b.amber { color: #ffb340; } .m-h b.red { color: #ff6961; }
  .m-na { font-size: 11.5px; color: var(--sa-tx3); }
  .m-bar { height: 5px; border-radius: 3px; background: rgba(255,255,255,.09); overflow: hidden; }
  .m-bar i { display: block; height: 100%; border-radius: 3px; background: var(--sa-green); transition: width .4s ease; }
  .m-bar i.amber { background: var(--sa-amber); } .m-bar i.red { background: var(--sa-red); }
  .m small { font-size: 11px; color: var(--sa-tx3); min-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .m-note { grid-column: 1 / -1; font-size: 12px; color: var(--sa-tx3); }
  .ord { display: inline-flex; gap: 4px; flex: none; }
  .ord .sa-btn { min-width: 30px; padding-left: 0; padding-right: 0; }
  .ord .sa-btn:disabled { opacity: .35; }
  .rt-log { padding: 4px 0 12px; display: flex; flex-direction: column; gap: 5px; }
  .rt-log-h { font-size: 12px; color: var(--sa-tx3); margin-bottom: 2px; }
  .rt-log-r { font-size: 12.5px; color: var(--sa-tx2); }
  .rt-log-r .sa-mono { color: var(--sa-tx3); margin-right: 6px; }
  .rt-log-r small { color: var(--sa-tx3); margin-left: 6px; }
  .m-note.err { color: #ff6961; }
  /* 窄屏：徽章 + 账号名占一行、按钮换到下一行（中英文都要——加了套餐徽章后中文名也会被挤成竖排） */
  @media (max-width: 560px) {
    .sa-row.acct { flex-wrap: wrap; row-gap: 8px; }
    .sa-row.acct .sa-row-tx { flex-basis: calc(100% - 86px); }
    .meters { padding-left: 0; gap: 10px; }
  }

  /* 英文「Switch to this account」按钮宽得多：窄屏上徽章 + 账号名占一行、按钮换到下一行（只在 :lang(en) 下，中文不变） */
  @media (max-width: 560px) {
    .sa-row:lang(en) { flex-wrap: wrap; row-gap: 8px; }
    .sa-row:lang(en) .sa-row-tx { flex-basis: calc(100% - 86px); }
  }
</style>
