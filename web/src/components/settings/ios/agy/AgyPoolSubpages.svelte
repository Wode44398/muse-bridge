<script>
  // 手机 / 网页设置（iOS 外壳）› Antigravity 号池子页：
  //   · agy:acct:<id>      单账号详情、4 桶用量、切号、调序、删除/登出
  //   · agy:acct-add       添加 Google 账号（OAuth 一键链接 + 粘贴回调 URL/code + 手动 Refresh Token）
  //   · agy:acct-edit:<id> 编辑备注名 / 套餐 / 重新授权 Google / 更换 Refresh Token
  import { untrack } from 'svelte';
  import Sym from '../../../ios27/Sym.svelte';
  import Segmented from '../../../ios27/Segmented.svelte';
  import { uiConfirm } from '../../../../lib/dialogs.js';
  import { SI } from '../../../../lib/settingsIcons.js';
  import { t, tr } from '../../../../lib/i18n.js';
  import { logoutAgyAccount, refreshAgyRuntimeStatus } from '../../../../lib/agy/settings.svelte.js';
  import {
    agyPool,
    loadAgyPool,
    loadAgyPoolUsage,
    activateAgyAccount,
    moveAgyAccount,
    addAgyAccountManual,
    updateAgyAccount,
    deleteAgyAccount,
    startAgyOAuth,
    pollAgyOAuth,
    finishAgyOAuth,
    cancelAgyOAuth,
    accLabel,
    agyPlanPill,
    planChoices,
    agyUsageTone,
    poolResetIn,
    smartRouting,
    runningOn,
    acctById,
  } from '../../../../lib/agy/pool.svelte.js';

  let { pid = '', push, pop } = $props();

  const svgOf = (name, w = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;

  const isDetail = $derived(pid.startsWith('agy:acct:'));
  const isAdd = $derived(pid === 'agy:acct-add');
  const isEdit = $derived(pid.startsWith('agy:acct-edit:'));
  const detailId = $derived(isDetail ? pid.slice('agy:acct:'.length) : isEdit ? pid.slice('agy:acct-edit:'.length) : '');
  const account = $derived(detailId ? acctById(detailId) : null);

  let formLabel = $state('');
  let formPlan = $state('');
  let formToken = $state('');
  let showManual = $state(false);
  let busy = $state(false);
  let formErr = $state('');
  let copiedUrl = $state(false);

  let oauthFlowId = $state('');
  let oauthUrl = $state('');
  let oauthMode = $state('oauth');
  let oauthStatus = $state('');
  let oauthInput = $state('');
  let pollTimer = null;

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function resetOAuth({ cancelServer = false } = {}) {
    stopPoll();
    if (cancelServer && oauthFlowId && oauthStatus === 'pending') cancelAgyOAuth(oauthFlowId);
    oauthFlowId = '';
    oauthUrl = '';
    oauthMode = agyPool.authMode || 'oauth';
    oauthStatus = '';
    oauthInput = '';
    copiedUrl = false;
  }

  $effect(() => {
    void pid;
    untrack(() => {
      resetOAuth({ cancelServer: true });
      formErr = '';
      formToken = '';
      showManual = false;
      busy = false;
      if (isEdit && account) {
        formLabel = account.label || '';
        formPlan = account.plan || '';
      } else if (isAdd) {
        formLabel = '';
        formPlan = '';
      }
      if (!agyPool.loaded) loadAgyPool({ usage: true });
    });
    return () => resetOAuth({ cancelServer: true });
  });

  async function beginGoogleOAuth() {
    if (busy) return;
    resetOAuth({ cancelServer: true });
    formErr = '';
    busy = true;
    const res = await startAgyOAuth({
      label: formLabel.trim(),
      accountId: isEdit && account ? account.id : '',
      plan: formPlan,
    });
    busy = false;
    if (!res.ok) { formErr = res.error || t('无法发起 Google 授权'); return; }
    oauthFlowId = res.flowId;
    oauthUrl = res.url;
    oauthMode = res.mode || agyPool.authMode || 'oauth';
    oauthStatus = 'pending';
    try { window.open(res.url, '_blank', 'noopener'); } catch {}

    stopPoll();
    if (oauthMode !== 'cli') {
      pollTimer = setInterval(async () => {
        if (!oauthFlowId) { stopPoll(); return; }
        const st = await pollAgyOAuth(oauthFlowId);
        if (st?.status === 'done') {
          stopPoll();
          oauthStatus = 'done';
          refreshAgyRuntimeStatus({ ensure: false, probe: false });
          pop?.();
        } else if (st?.status === 'error' || st?.status === 'expired') {
          stopPoll();
          oauthStatus = st.status;
          formErr = tr(st.error) || t('授权未完成，请重试');
        }
      }, 1500);
    }
  }

  async function copyOAuthUrl() {
    if (!oauthUrl) return;
    try {
      await navigator.clipboard.writeText(oauthUrl);
      copiedUrl = true;
      setTimeout(() => { copiedUrl = false; }, 1800);
    } catch {}
  }

  async function submitOAuthFinish() {
    if (!oauthFlowId || !oauthInput.trim() || busy) return;
    busy = true;
    formErr = '';
    const res = await finishAgyOAuth({
      flowId: oauthFlowId,
      input: oauthInput.trim(),
      label: formLabel.trim(),
      plan: formPlan,
    });
    busy = false;
    if (!res.ok) { formErr = res.error || t('完成授权失败'); return; }
    oauthStatus = 'done';
    refreshAgyRuntimeStatus({ ensure: false, probe: false });
    pop?.();
  }

  async function submitManualOrEdit() {
    if (busy) return;
    formErr = '';
    busy = true;
    if (isAdd) {
      if (!formToken.trim()) {
        busy = false;
        formErr = t('请先填写 Refresh Token，或点击上方通过 Google 浏览器授权');
        return;
      }
      const res = await addAgyAccountManual({ label: formLabel, refreshToken: formToken, plan: formPlan });
      busy = false;
      if (!res.ok) { formErr = res.error; return; }
      refreshAgyRuntimeStatus({ ensure: false, probe: false });
      pop?.();
      return;
    }
    if (!account) { busy = false; return; }
    const res = await updateAgyAccount(account.id, {
      label: formLabel,
      ...(formToken.trim() ? { refreshToken: formToken } : {}),
      plan: formPlan,
    });
    busy = false;
    if (!res.ok) { formErr = res.error; return; }
    refreshAgyRuntimeStatus({ ensure: false, probe: false });
    pop?.();
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
      if (done) {
        refreshAgyRuntimeStatus({ ensure: false, probe: false });
        pop?.();
      }
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
    }
  }
</script>

{#snippet chev()}<Sym name="chevron.right" weight={600} size={13} class="chev" />{/snippet}

{#snippet detailMeter(name, b)}
  <div class="u">
    <div class="u-top">
      <span class="u-l">{name}</span>
      <span class="u-v" class:hot={b && agyUsageTone(b) === 'red'}>
        {b ? t('{pct}% 已用', { pct: Math.round(b.usedPct) }) : '—'}
      </span>
    </div>
    <span class="bar-u">
      {#if b}
        <i
          style:width="{Math.min(100, b.usedPct)}%"
          class:hot={agyUsageTone(b) === 'red'}
          class:warm={agyUsageTone(b) === 'amber'}
        ></i>
      {/if}
    </span>
    {#if b?.resetAt}
      <span class="u-r">{b.usedPct >= 100 ? t('已达上限') + ' · ' : ''}{poolResetIn(b.resetAt)}</span>
    {/if}
  </div>
{/snippet}

{#if isDetail && account}
  {@const u = agyPool.usage[account.id]}
  {@const idx = agyPool.accounts.findIndex((x) => x.id === account.id)}
  {@const planTag = agyPlanPill(u?.plan || account.effectivePlan)}
  {@const hasAnyBucket = !!(u && (u.gemini_5h || u.gemini_weekly || u.tp_5h || u.tp_weekly))}
  <div class="hero">
    <span class="av big" aria-hidden="true">{(accLabel(account.label) || '?').trim().charAt(0).toUpperCase()}</span>
    <div class="hero-name">{accLabel(account.label)}</div>
    <div class="hero-sub">
      {smartRouting()
        ? (runningOn(account.id) ? t('在跑 {n} 个任务', { n: runningOn(account.id) }) : t('空闲'))
        : account.active ? t('当前在用') : t('待用')}{planTag ? ' · ' + planTag : ''}{account.source === 'local' ? ' · ' + t('本机') : ''}
    </div>
    {#if account.email || u?.email}
      <div class="hero-sub">{account.email || u.email}</div>
    {/if}
  </div>

  <div class="ghead-row">
    <h2 class="ghead">{t('用量')}</h2>
    <button
      class="gh-ico"
      class:busy={agyPool.usageBusy}
      type="button"
      onclick={() => loadAgyPoolUsage(true)}
      disabled={agyPool.usageBusy}
      aria-label={t('刷新用量')}
    >{@html svgOf('refresh', 1.8)}</button>
  </div>
  <div class="ig usage">
    {#if u?.error && !hasAnyBucket}
      <span class="u-r" class:err={account.source !== 'local'}>{tr(u.error)}</span>
    {:else}
      {@render detailMeter(t('Gemini · 5 小时'), u?.gemini_5h)}
      {@render detailMeter(t('Gemini · 每周'), u?.gemini_weekly)}
      {@render detailMeter(t('Claude / GPT · 5 小时'), u?.tp_5h)}
      {@render detailMeter(t('Claude / GPT · 每周'), u?.tp_weekly)}
    {/if}
  </div>

  <div class="ig">
    {#if !account.active && !smartRouting()}
      <button class="r" type="button" onclick={() => activateAgyAccount(account)}>
        <span class="r-main"><span class="r-tx accent">{t('切到此号')}</span></span>
      </button>
    {/if}
    <button class="r" type="button" onclick={() => push?.('agy:acct-edit:' + account.id, t('编辑账号'))}>
      <span class="r-main"><span class="r-tx">{t('编辑账号')}</span>{@render chev()}</span>
    </button>
    {#if agyPool.accounts.length > 1}
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{t('顺序')}</span>
          <span class="r-d num">{idx + 1} / {agyPool.accounts.length}</span>
          <span class="steps">
            <button type="button" disabled={idx <= 0} onclick={() => moveAgyAccount(account, -1)} aria-label={t('上移')}>{@html svgOf('up', 1.8)}</button>
            <button type="button" disabled={idx >= agyPool.accounts.length - 1} onclick={() => moveAgyAccount(account, 1)} aria-label={t('下移')}>{@html svgOf('down', 1.8)}</button>
          </span>
        </span>
      </div>
    {/if}
  </div>

  {#if agyPool.err}<p class="gfoot err">{agyPool.err}</p>{/if}

  {#if agyPool.accounts.length > 1 || (account.source === 'local' && agyPool.localAuthed)}
    <div class="ig">
      {#if account.source === 'local' && agyPool.localAuthed}
        <button class="r" type="button" onclick={askLogoutLocal}>
          <span class="r-main center"><span class="r-tx red">{t('退出本机登录')}</span></span>
        </button>
      {/if}
      {#if agyPool.accounts.length > 1}
        <button class="r" type="button" onclick={() => askDelete(account)}>
          <span class="r-main center"><span class="r-tx red">{t('删除账号')}</span></span>
        </button>
      {/if}
    </div>
  {/if}

{:else if isAdd || (isEdit && account)}
  <h2 class="ghead">{t('账号信息')}</h2>
  <div class="ig">
    <div class="r">
      <span class="r-main">
        <input
          class="dv-in"
          bind:value={formLabel}
          placeholder={t('备注名（留空自动取邮箱前缀）')}
        />
      </span>
    </div>
    <div class="r">
      <span class="r-main">
        <span class="r-tx">{t('套餐')}</span>
        <span class="plan-seg">
          <Segmented
            size="small"
            options={planChoices()}
            value={formPlan}
            onchange={(v) => { formPlan = v; }}
            label={t('套餐')}
          />
        </span>
      </span>
    </div>
  </div>

  {#if isAdd || account?.source !== 'local'}
    <h2 class="ghead">{t('Google 账号授权')}</h2>
    <div class="ig">
      {#if oauthStatus !== 'pending'}
        <button class="r" type="button" disabled={busy} onclick={beginGoogleOAuth}>
          <span class="r-main center">
            <span class="r-tx accent">
              {isAdd ? t('使用 Google 账号授权登录') : t('重新授权 Google 账号')}
            </span>
          </span>
        </button>
      {:else}
        <div class="r">
          <span class="r-main">
            <span class="spin"></span>
            <span class="r-tx">
              {oauthMode === 'cli' ? t('等待粘贴 Google 授权码…') : t('等待浏览器完成 Google 授权…')}
              <span class="r-sub">
                {oauthMode === 'cli'
                  ? t('请在浏览器中完成授权（添加其他号可在页面切号或用无痕窗口打开），复制页面给出的授权码或链接贴到下方完成入池。')
                  : t('在手机上授权后，页面会跳转到 localhost，请复制地址栏里的完整链接贴到下方完成入池。')}
              </span>
            </span>
          </span>
        </div>
        <button class="r" type="button" onclick={() => window.open(oauthUrl, '_blank', 'noopener')}>
          <span class="r-main"><span class="r-tx accent">{t('重新打开授权页')}</span></span>
        </button>
        <button class="r" type="button" onclick={copyOAuthUrl}>
          <span class="r-main"><span class="r-tx">{copiedUrl ? t('已复制授权链接') : t('复制授权链接')}</span></span>
        </button>
        <div class="r">
          <span class="r-main">
            <input
              class="dv-in"
              bind:value={oauthInput}
              placeholder={oauthMode === 'cli' ? t('粘贴授权码或回调链接') : t('粘贴跳转后的完整链接或授权码')}
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
            />
          </span>
        </div>
        <button class="r" type="button" disabled={!oauthInput.trim() || busy} onclick={submitOAuthFinish}>
          <span class="r-main center"><span class="r-tx accent">{busy ? t('提交中…') : t('完成授权')}</span></span>
        </button>
      {/if}
    </div>
    <p class="gfoot">
      {agyPool.authMode === 'cli'
        ? t('通过本机 agy 在独立目录完成 Google 授权，不覆盖系统钥匙串里的默认登录。')
        : t('授权后仅把刷新令牌保存在 Bridge 本地号池中，不覆盖本机 Antigravity 客户端登录。')}
    </p>
  {/if}

  {#if agyPool.manualTokenSupported}
    <div class="ig">
      <button class="r" type="button" onclick={() => { showManual = !showManual; }}>
        <span class="r-main">
          <span class="r-tx">{isAdd ? t('或手动填写 Refresh Token') : t('更换 Refresh Token（可选）')}</span>
          <span class="r-d">{showManual ? t('收起') : t('展开')}</span>
        </span>
      </button>
      {#if showManual}
        <div class="r">
          <span class="r-main">
            <input
              class="dv-in"
              bind:value={formToken}
              placeholder={t('粘贴 Google OAuth Refresh Token（1//…）')}
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
            />
          </span>
        </div>
        {#if isAdd}
          <button class="r" type="button" disabled={!formToken.trim() || busy} onclick={submitManualOrEdit}>
            <span class="r-main center"><span class="r-tx accent">{busy ? t('验证中…') : t('验证并添加')}</span></span>
          </button>
        {/if}
      {/if}
    </div>
  {/if}

  {#if formErr}<p class="gfoot err">{formErr}</p>{/if}

  {#if isEdit}
    <div class="lg-form">
      <button class="lg-go" type="button" disabled={busy} onclick={submitManualOrEdit}>
        {busy ? t('保存中…') : t('保存')}
      </button>
    </div>
  {/if}
{/if}

<style>
  @import '../kit.css';
  .plan-seg { width: 196px; flex: none; }
</style>
