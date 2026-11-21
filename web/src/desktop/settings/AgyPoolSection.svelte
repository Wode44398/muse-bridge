<script>
  // 桌面设置 › Antigravity 订阅号池与智能换号分区：复用桌面设置 kit.css 的墨与象牙控件语言，
  // 支持本机默认号 + 多个 Google OAuth 号并存、逐号 4 桶实时额度展示、零重启切号与智能/填满/首选路由。
  import { untrack } from 'svelte';
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import DSelect from '../kit/DSelect.svelte';
  import DSegmented from '../kit/DSegmented.svelte';
  import DButton from '../kit/DButton.svelte';
  import DField from '../kit/DField.svelte';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { registerCloser } from '../../lib/nav.js';
  import { SI } from '../../lib/settingsIcons.js';
  import { t, tr } from '../../lib/i18n.js';
  import { logoutAgyAccount, refreshAgyRuntimeStatus } from '../../lib/agy/settings.svelte.js';
  import {
    agyPool,
    loadAgyPool,
    loadAgyPoolUsage,
    activateAgyAccount,
    moveAgyAccount,
    addAgyAccountManual,
    updateAgyAccount,
    deleteAgyAccount,
    setAgyRouter,
    startAgyOAuth,
    pollAgyOAuth,
    finishAgyOAuth,
    cancelAgyOAuth,
    accLabel,
    agyPlanPill,
    planChoices,
    agyUsageTone,
    agyHhmm,
    poolResetAt,
    poolResetIn,
    routeStrategies,
    routerStrategy,
    routerEnabled,
    smartRouting,
    runningOn,
    acctById,
    whyText,
    routeLogTitle,
    routeLogSub,
  } from '../../lib/agy/pool.svelte.js';

  const { fl = () => false } = $props();

  const svgOf = (name, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;

  $effect(() => {
    untrack(() => loadAgyPool({ usage: true }));
  });

  // 添加 / 编辑 / 授权弹窗状态
  let modal = $state(null); // null | { mode: 'add' | 'edit', acc?: object }
  let formLabel = $state('');
  let formPlan = $state('');
  let formToken = $state('');
  let showManual = $state(false);
  let formBusy = $state(false);
  let formErr = $state('');
  let copiedUrl = $state(false);

  // Google OAuth 交互流状态
  let oauthFlowId = $state('');
  let oauthUrl = $state('');
  let oauthStatus = $state(''); // '' | 'pending' | 'done' | 'error' | 'expired'
  let oauthInput = $state('');
  let pollTimer = null;

  function stopOAuthPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function resetOAuthState({ cancelServer = false } = {}) {
    stopOAuthPoll();
    if (cancelServer && oauthFlowId && oauthStatus === 'pending') {
      cancelAgyOAuth(oauthFlowId);
    }
    oauthFlowId = '';
    oauthUrl = '';
    oauthStatus = '';
    oauthInput = '';
    copiedUrl = false;
  }

  function closeModal() {
    resetOAuthState({ cancelServer: true });
    modal = null;
    formErr = '';
    formBusy = false;
  }

  $effect(() => {
    if (!modal) return;
    const unregister = registerCloser(() => {
      closeModal();
      return true;
    });
    // 桌面设置在冒泡阶段监听 Escape 关闭整页：弹窗打开时在捕获阶段先拦截，只关弹窗不退设置页。
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeModal();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      unregister();
    };
  });

  $effect(() => () => resetOAuthState({ cancelServer: true }));

  function openAdd() {
    resetOAuthState({ cancelServer: true });
    formLabel = '';
    formPlan = '';
    formToken = '';
    showManual = false;
    formErr = '';
    formBusy = false;
    modal = { mode: 'add' };
  }

  function openEdit(acc) {
    resetOAuthState({ cancelServer: true });
    formLabel = acc.label || '';
    formPlan = acc.plan || '';
    formToken = '';
    showManual = false;
    formErr = '';
    formBusy = false;
    modal = { mode: 'edit', acc };
  }

  async function beginGoogleOAuth() {
    if (formBusy) return;
    resetOAuthState({ cancelServer: true });
    formErr = '';
    formBusy = true;
    const res = await startAgyOAuth({
      label: formLabel.trim(),
      accountId: modal?.mode === 'edit' ? modal.acc.id : '',
      plan: formPlan,
    });
    formBusy = false;
    if (!res.ok) {
      formErr = res.error || t('无法发起 Google 授权');
      return;
    }
    oauthFlowId = res.flowId;
    oauthUrl = res.url;
    oauthStatus = 'pending';
    try { window.open(res.url, '_blank', 'noopener'); } catch {}

    stopOAuthPoll();
    pollTimer = setInterval(async () => {
      if (!oauthFlowId) { stopOAuthPoll(); return; }
      const st = await pollAgyOAuth(oauthFlowId);
      if (st?.status === 'done') {
        stopOAuthPoll();
        oauthStatus = 'done';
        refreshAgyRuntimeStatus({ ensure: false, probe: false });
        closeModal();
      } else if (st?.status === 'error' || st?.status === 'expired') {
        stopOAuthPoll();
        oauthStatus = st.status;
        formErr = tr(st.error) || t('授权未完成，请重试');
      }
    }, 1500);
  }

  async function copyOAuthUrl() {
    if (!oauthUrl) return;
    try {
      await navigator.clipboard.writeText(oauthUrl);
      copiedUrl = true;
      setTimeout(() => { copiedUrl = false; }, 1800);
    } catch {}
  }

  async function submitOAuthFinish(ev) {
    ev?.preventDefault?.();
    if (!oauthFlowId || !oauthInput.trim() || formBusy) return;
    formBusy = true;
    formErr = '';
    const res = await finishAgyOAuth({
      flowId: oauthFlowId,
      input: oauthInput.trim(),
      label: formLabel.trim(),
      plan: formPlan,
    });
    formBusy = false;
    if (!res.ok) {
      formErr = res.error || t('完成授权失败');
      return;
    }
    oauthStatus = 'done';
    refreshAgyRuntimeStatus({ ensure: false, probe: false });
    closeModal();
  }

  async function submitManualOrEdit(ev) {
    ev?.preventDefault?.();
    if (formBusy) return;
    formErr = '';
    formBusy = true;
    if (modal?.mode === 'add') {
      if (!formToken.trim()) {
        formBusy = false;
        formErr = t('请先填写 Refresh Token，或点击上方通过 Google 浏览器授权');
        return;
      }
      const res = await addAgyAccountManual({
        label: formLabel,
        refreshToken: formToken,
        plan: formPlan,
      });
      formBusy = false;
      if (!res.ok) { formErr = res.error; return; }
      refreshAgyRuntimeStatus({ ensure: false, probe: false });
      closeModal();
      return;
    }

    const res = await updateAgyAccount(modal.acc.id, {
      label: formLabel,
      ...(formToken.trim() ? { refreshToken: formToken } : {}),
      plan: formPlan,
    });
    formBusy = false;
    if (!res.ok) { formErr = res.error; return; }
    refreshAgyRuntimeStatus({ ensure: false, probe: false });
    closeModal();
  }

  async function askDelete(acc) {
    const ok = await uiConfirm(t('删除账号「{name}」？', { name: accLabel(acc.label) }), {
      detail: acc.source === 'local'
        ? t('仅从号池列表中移除该条目，不会退出本机系统里的 agy 登录。')
        : t('将移除该账号在 Bridge 号池中保存的授权令牌，不会影响本机其他应用。'),
      okLabel: t('删除'),
      danger: true,
    });
    if (ok) {
      const done = await deleteAgyAccount(acc.id);
      if (done) refreshAgyRuntimeStatus({ ensure: false, probe: false });
    }
  }

  async function askLogoutLocal() {
    const ok = await uiConfirm(t('退出当前 Antigravity 账号？'), {
      detail: t('登出后需在服务器终端运行 agy 重新完成账号登录，进行中的对话将无法继续。'),
      okLabel: t('退出登录'),
      danger: true,
    });
    if (ok) {
      await logoutAgyAccount();
      await loadAgyPool({ usage: true });
      closeModal();
    }
  }

  const poolFoot = $derived.by(() => {
    if (agyPool.accounts.length <= 1 && !agyPool.localAuthed && !agyPool.accounts.some((a) => a.hasToken)) {
      return t('可直接点击「添加 Google 账号」在线授权入池，或在电脑终端执行一次 agy 完成本机登录。');
    }
    return t('通过本机上游代理零重启切号；Gemini 与 Claude / GPT 额度相互独立，不改动系统钥匙串。');
  });
</script>

{#snippet meter(name, b)}
  <span class="mm">
    <span class="mh">{name}<b class={b ? agyUsageTone(b) : ''}>{b ? Math.round(b.usedPct) + '%' : '—'}</b></span>
    <span class="mb"><i class={b ? agyUsageTone(b) : ''} style:width="{b ? Math.min(100, b.usedPct) : 0}%"></i></span>
    <span class="mr" title={b ? poolResetIn(b.resetAt) : ''}>{b ? poolResetAt(b.resetAt) : ''}</span>
  </span>
{/snippet}

<div class="ghd">
  <h3>{t('订阅号池')}</h3>
  <button
    type="button"
    class="ico-btn"
    class:busy={agyPool.usageBusy}
    onclick={() => loadAgyPoolUsage(true)}
    disabled={agyPool.usageBusy}
    title={agyPool.usageBusy ? t('刷新中…') : t('刷新用量')}
    aria-label={agyPool.usageBusy ? t('刷新中…') : t('刷新用量')}
  >{@html svgOf('refresh', 1.8)}</button>
</div>

<DGroup foot={poolFoot}>
  <div class="pool" class:hl-line={fl('ag-pool') || fl('ag-acct')}>
    {#each agyPool.accounts as acc, i (acc.id)}
      {@const u = agyPool.usage[acc.id]}
      {@const planTag = agyPlanPill(u?.plan || acc.effectivePlan)}
      {@const hasAnyBucket = !!(u && (u.gemini_5h || u.gemini_weekly || u.tp_5h || u.tp_weekly))}
      <div class="drow prow">
        <div class="pmain">
          <div class="pname">
            <b>{accLabel(acc.label)}</b>
            {#if planTag}<span class="pill">{planTag}</span>{/if}
            {#if acc.source === 'local'}<span class="pill">{t('本机')}</span>{/if}
            {#if smartRouting()}
              {#if runningOn(acc.id)}<span class="cur">{t('在跑 {n} 个任务', { n: runningOn(acc.id) })}</span>{/if}
            {:else if acc.active}
              <span class="cur">{t('使用中')}</span>
            {/if}
          </div>
          {#if acc.email || u?.email}
            <div class="pemail">{acc.email || u.email}</div>
          {/if}
          <div class="mini agy-mini">
            {#if !u}
              <span class="mna">{agyPool.usageBusy ? t('读取用量…') : (acc.hasToken ? '…' + (acc.tokenTail || '') : t('沿用本机 agy 登录态'))}</span>
            {:else if u.error && !hasAnyBucket}
              <span class="mna" class:bad={acc.source !== 'local'}>{tr(u.error)}</span>
            {:else}
              {@render meter(t('Gemini 5h'), u.gemini_5h)}
              {@render meter(t('Gemini 每周'), u.gemini_weekly)}
              {@render meter(t('Claude/GPT 5h'), u.tp_5h)}
              {@render meter(t('Claude/GPT 每周'), u.tp_weekly)}
            {/if}
          </div>
        </div>
        <div class="pacts">
          {#if !acc.active && !smartRouting()}
            <DButton size="sm" onclick={() => activateAgyAccount(acc)}>{t('切到此号')}</DButton>
          {/if}
          <span class="tools">
            {#if agyPool.accounts.length > 1}
              <button type="button" class="ico-btn" disabled={i === 0} onclick={() => moveAgyAccount(acc, -1)} title={t('上移')}>{@html svgOf('up', 1.8)}</button>
              <button type="button" class="ico-btn" disabled={i === agyPool.accounts.length - 1} onclick={() => moveAgyAccount(acc, 1)} title={t('下移')}>{@html svgOf('down', 1.8)}</button>
            {/if}
            <button type="button" class="ico-btn" onclick={() => openEdit(acc)} title={t('编辑账号')}>{@html svgOf('edit', 1.7)}</button>
            {#if agyPool.accounts.length > 1}
              <button type="button" class="ico-btn danger" onclick={() => askDelete(acc)} title={t('删除账号')}>{@html svgOf('trash', 1.7)}</button>
            {/if}
          </span>
        </div>
      </div>
    {/each}
    <button type="button" class="drow addrow" onclick={openAdd}>{@html svgOf('plus', 1.8)}{t('添加 Google 账号')}</button>
  </div>
</DGroup>
{#if agyPool.err}<p class="err">{agyPool.err}</p>{/if}

<!-- 撞上限额时：自动换号与分派策略 -->
<DGroup label={t('撞上限额时')}>
  <DRow
    title={t('额度用尽自动换号')}
    sub={agyPool.accounts.length < 2 ? t('号池里至少要有两个账号才用得上') : ''}
    highlight={fl('ag-router')}
  >
    {#snippet trailing()}
      <DSwitch
        checked={routerEnabled()}
        disabled={!agyPool.router || agyPool.routerBusy}
        onchange={(v) => setAgyRouter({ enabled: v })}
      />
    {/snippet}
  </DRow>

  {#if routerEnabled()}
    <div class="drow cr ind">
      <span class="cr-tx">
        <span class="cr-t">{t('分派方式')}</span>
        <span class="cr-s">{routeStrategies().find((o) => o.value === routerStrategy())?.desc}</span>
      </span>
      <span class="cr-tr">
        <DSelect
          options={routeStrategies().map((o) => ({ value: o.value, label: o.label }))}
          value={routerStrategy()}
          onchange={(v) => setAgyRouter({ strategy: v })}
          width="160px"
        />
      </span>
    </div>

    <div class="drow cr ind">
      <span class="cr-tx">
        <span class="cr-t">{t('会话中无缝换号')}</span>
        <span class="cr-s">
          {smartRouting()
            ? t('任务跑到一半、所在的号快用满或撞墙时，在两步之间把它换到别的号，对话不中断')
            : t('快用满或撞 429 时原地切号重发，进行中的对话不中断')}
        </span>
      </span>
      <span class="cr-tr">
        <DSwitch
          checked={!!agyPool.router?.settings?.seamless}
          disabled={agyPool.routerBusy}
          onchange={(v) => setAgyRouter({ seamless: v })}
        />
      </span>
    </div>
  {/if}
</DGroup>

{#if routerEnabled() && agyPool.router?.log?.length}
  <DGroup label={smartRouting() ? t('最近的分派') : t('最近的自动切换')}>
    {#each agyPool.router.log as item, idx (item.at + ':' + idx)}
      {#if item.kind}
        <DRow title={routeLogTitle(item)} sub={routeLogSub(item, (rid, fb) => accLabel(acctById(rid)?.label || fb))}>
          {#snippet trailing()}<span class="num">{agyHhmm(item.at)}</span>{/snippet}
        </DRow>
      {:else}
        <DRow
          title="{accLabel(acctById(item.from)?.label || item.fromLabel)} → {accLabel(acctById(item.to)?.label || item.toLabel)}"
          sub={whyText(item.reason)}
        >
          {#snippet trailing()}<span class="num">{agyHhmm(item.at)}</span>{/snippet}
        </DRow>
      {/if}
    {/each}
  </DGroup>
{/if}

{#if modal}
  <div class="ag-dlg-root" role="dialog" aria-modal="true" aria-label={modal.mode === 'add' ? t('添加 Google 账号') : t('编辑账号')}>
    <button type="button" class="dlg-dim" aria-label={t('关闭')} onclick={closeModal}></button>
    <div class="dlg ag-dlg">
      <h3>{modal.mode === 'add' ? t('添加 Google 账号') : t('编辑账号')}</h3>
      <p>
        {modal.mode === 'add'
          ? t('授权后仅把刷新令牌保存在 Bridge 本地号池中，不覆盖本机 Antigravity 客户端登录。')
          : (modal.acc.email || (modal.acc.source === 'local' ? t('本机默认账号，沿用当前电脑上 agy 的登录态。') : t('更新备注名、套餐标识或重新授权 Google 账号。')))}
      </p>

      <div class="ag-form-block">
        <DField
          value={formLabel}
          placeholder={t('备注名（留空自动取邮箱前缀）')}
          onchange={(v) => { formLabel = v; }}
          oninput={(v) => { formLabel = v; }}
        />
        <div class="plan-pick">
          <span>{t('套餐')}</span>
          <DSegmented options={planChoices()} value={formPlan} onchange={(v) => { formPlan = v; }} />
        </div>
      </div>

      <!-- 主路径：Google OAuth 一键授权 -->
      {#if modal.mode === 'add' || modal.acc.source === 'oauth'}
        <div class="oauth-box">
          {#if oauthStatus !== 'pending'}
            <DButton variant="primary" disabled={formBusy} onclick={beginGoogleOAuth}>
              {modal.mode === 'add' ? t('使用 Google 账号授权登录') : t('重新授权 Google 账号')}
            </DButton>
          {:else}
            <div class="oauth-wait">
              <span class="spin"></span>
              <span>{t('等待浏览器完成 Google 授权…')}</span>
            </div>
            <div class="oauth-links">
              <DButton size="sm" onclick={() => window.open(oauthUrl, '_blank', 'noopener')}>{t('重新打开授权页')}</DButton>
              <DButton size="sm" onclick={copyOAuthUrl}>{copiedUrl ? t('已复制') : t('复制授权链接')}</DButton>
            </div>
            <form class="oauth-paste" onsubmit={submitOAuthFinish}>
              <p class="hint">{t('如果是在手机或另一台电脑完成授权，请把跳转后地址栏里的完整链接或授权码贴到这里：')}</p>
              <div class="oauth-paste-row">
                <DField
                  value={oauthInput}
                  placeholder={t('粘贴 http://localhost:…/oauth-callback?code=…')}
                  onchange={(v) => { oauthInput = v; }}
                  oninput={(v) => { oauthInput = v; }}
                />
                <DButton size="sm" variant="primary" type="submit" disabled={!oauthInput.trim() || formBusy}>
                  {t('完成')}
                </DButton>
              </div>
            </form>
          {/if}
        </div>
      {/if}

      <!-- 备用路径：手动填写 Refresh Token -->
      <details class="manual-wrap" bind:open={showManual}>
        <summary>{modal.mode === 'add' ? t('或手动填写 Refresh Token') : t('更换 Refresh Token（可选）')}</summary>
        <form class="manual-form" onsubmit={submitManualOrEdit}>
          <DField
            value={formToken}
            placeholder={t('粘贴 Google OAuth Refresh Token（1//…）')}
            onchange={(v) => { formToken = v; }}
            oninput={(v) => { formToken = v; }}
          />
          {#if modal.mode === 'add'}
            <DButton size="sm" variant="primary" type="submit" disabled={!formToken.trim() || formBusy}>
              {formBusy ? t('验证中…') : t('验证并添加')}
            </DButton>
          {/if}
        </form>
      </details>

      {#if formErr}<p class="err">{formErr}</p>{/if}

      <div class="dacts">
        {#if modal.mode === 'edit' && modal.acc.source === 'local' && agyPool.localAuthed}
          <DButton size="sm" variant="danger" onclick={askLogoutLocal}>{t('退出本机登录')}</DButton>
          <span class="sp"></span>
        {/if}
        <DButton onclick={closeModal}>{t('取消')}</DButton>
        {#if modal.mode === 'edit'}
          <DButton variant="primary" disabled={formBusy} onclick={submitManualOrEdit}>
            {formBusy ? t('保存中…') : t('保存')}
          </DButton>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  @import './kit.css';

  .pemail {
    margin-top: 2px;
    font-size: var(--dsk-fs-sm);
    color: var(--dsk-ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mini.agy-mini {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 18px;
    max-width: 410px;
    margin-top: 9px;
  }
  .ag-dlg-root {
    position: fixed;
    inset: 0;
    max-width: none !important;
    width: auto !important;
    margin: 0 !important;
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-left: 232px;
  }
  @media (max-width: 760px) {
    .ag-dlg-root { padding-left: 0; }
  }
  .ag-dlg {
    width: min(430px, calc(100% - 40px));
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .ag-dlg h3, .ag-dlg p { margin: 0; }
  .ag-form-block {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .oauth-box {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border-radius: 10px;
    background: var(--dsk-panel);
    box-shadow: inset 0 0 0 1px var(--dsk-line);
  }
  .oauth-wait {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--dsk-fs-ui);
    color: var(--dsk-ink-2);
  }
  .oauth-links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .oauth-paste {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 8px;
    border-top: 1px solid var(--dsk-line);
  }
  .oauth-paste-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .oauth-paste-row :global(.fld) {
    flex: 1;
    min-width: 0;
  }
  .manual-wrap {
    font-size: var(--dsk-fs-sm);
    color: var(--dsk-ink-3);
  }
  .manual-wrap summary {
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .manual-wrap summary:hover {
    color: var(--dsk-ink-2);
  }
  .manual-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
  }
</style>
