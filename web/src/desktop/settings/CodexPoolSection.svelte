<script>
  // 桌面设置 › Codex 的号池（只给管理员）：一号一行（套餐、状态、额度条）、排序 / 切号 / 编辑 / 删除，
  // 加号走 ChatGPT 设备码登录（备选 API 密钥），以及「撞上限额时」的自动换号。数据与动作全在 lib/codex/settings.svelte.js。
  // 样式沿用 kit.css 的号池语言（.pool .prow .pmain .pname .pacts .tools .addrow / .mm .mh .mb .mr）与弹窗写法。
  import { untrack } from 'svelte';
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import DSelect from '../kit/DSelect.svelte';
  import DButton from '../kit/DButton.svelte';
  import DField from '../kit/DField.svelte';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { SI } from '../../lib/settingsIcons.js';
  import { t, tr } from '../../lib/i18n.js';
  import {
    cx,
    loadCodexPool,
    accountById,
    routerOn,
    activateAccount,
    updateAccount,
    restartAccount,
    deleteAccount,
    moveAccount,
    useResetCredit,
    setRouter,
    startDeviceLogin,
    pollDeviceLogin,
    cancelDeviceLogin,
    addApiKeyAccount,
  } from '../../lib/codex/settings.svelte.js';
  import {
    accLabel,
    kindLabel,
    planLabel,
    hostStateText,
    flowStateText,
    usageRows,
    usageTone,
    resetText,
    coolingText,
    routeStrategies,
  } from '../../lib/codex/settings-logic.js';

  const { fl = () => false } = $props();

  const svgOf = (name, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;

  const accounts = $derived(cx.pool?.accounts || []);
  const strategy = $derived(cx.pool?.router?.strategy || 'smart');
  const isBusy = (id, op) => cx.busy === 'acct:' + id + ':' + op;

  // ── 弹窗：edit（编辑号）/ add（加号：设备码，备选 API 密钥）/ login（重新登录已有的号）──
  let modal = $state(null);        // null | { mode: 'edit' | 'add' | 'login', id?: string }
  let formLabel = $state('');
  let formShared = $state(false);
  let formDisabled = $state(false);
  let apiKey = $state('');
  let showApiKey = $state(false);
  let flowId = $state('');
  let copied = $state('');         // '' | 'code' | 'url'
  let now = $state(Date.now());
  let notice = $state('');         // 弹窗关掉后在号池下面留一句（例如「这个账号已经在号池里了」）
  let noticeTimer = null;
  let copyTimer = null;

  // 弹窗里的号跟着总线 / 轮询更新（重置卡张数、进程状态）
  const modalAcc = $derived(modal?.id ? accountById(modal.id) : null);
  const flow = $derived(flowId ? cx.flows[flowId] || null : null);
  const flowLive = $derived(!!flow && (flow.state === 'pending' || flow.state === 'finishing'));
  const flowEnded = $derived(!!flow && ['failed', 'expired', 'cancelled'].includes(flow.state));
  const loginBusy = $derived(cx.busy === 'login');
  const keyBusy = $derived(cx.busy === 'apikey');

  const clearLoginErr = () => { if (cx.errors.login) cx.errors = { ...cx.errors, login: '' }; };

  function showNotice(text) {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = ''; }, 6000);
  }

  function dropFlow() {
    // 关弹窗 / 换流程时还在等就告诉服务端取消，免得那边一直挂着
    if (flowId && cx.flows[flowId]?.state === 'pending') cancelDeviceLogin(flowId);
    flowId = '';
    copied = '';
  }

  function closeModal() {
    dropFlow();
    modal = null;
    apiKey = '';
    showApiKey = false;
  }

  function openAdd() {
    dropFlow();
    clearLoginErr();
    formLabel = '';
    apiKey = '';
    showApiKey = false;
    modal = { mode: 'add' };
  }

  function openEdit(acc) {
    dropFlow();
    formLabel = accLabel(acc);
    formShared = !!acc.shared;
    formDisabled = !!acc.disabled;
    modal = { mode: 'edit', id: acc.id };
  }

  async function beginLogin() {
    if (loginBusy) return;
    dropFlow();
    clearLoginErr();
    const relogin = modal?.mode === 'login';
    const f = await startDeviceLogin(relogin ? { accountId: modal.id } : { label: formLabel });
    if (!f) return;
    if (modal) flowId = f.flowId;
    else cancelDeviceLogin(f.flowId);   // 等服务端回话时弹窗已经关了
  }

  function reloginFromEdit() {
    if (!modalAcc) return;
    modal = { mode: 'login', id: modalAcc.id };
    beginLogin();
  }

  async function submitApiKey(ev) {
    ev?.preventDefault?.();
    if (!apiKey.trim() || keyBusy) return;
    clearLoginErr();
    if (await addApiKeyAccount({ apiKey, label: formLabel })) closeModal();
  }

  async function saveEdit() {
    const acc = modalAcc;
    if (!acc) { closeModal(); return; }
    const patch = {};
    const label = formLabel.trim();
    if (label && label !== accLabel(acc)) patch.label = label;
    if (formShared !== !!acc.shared) patch.shared = formShared;
    if (formDisabled !== !!acc.disabled) patch.disabled = formDisabled;
    if (!Object.keys(patch).length) { closeModal(); return; }
    if (await updateAccount(acc.id, patch)) closeModal();
  }

  async function askResetCredit() {
    const acc = modalAcc;
    if (!acc) return;
    const ok = await uiConfirm(t('给「{name}」用一张重置卡？', { name: accLabel(acc) }), {
      detail: t('这个号的额度会立刻重置，用掉的卡不能撤回。'),
      okLabel: t('使用'),
    });
    if (ok) await useResetCredit(acc.id);
  }

  async function askDelete(acc) {
    const ok = await uiConfirm(t('删除账号「{name}」？', { name: accLabel(acc) }), {
      detail: t('会登出这个号，并删掉它在这台服务器上的 Codex 目录。'),
      okLabel: t('删除'),
      danger: true,
    });
    if (ok) await deleteAccount(acc.id);
  }

  async function copy(text, which) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copied = which;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = ''; }, 1800);
    } catch {}
  }

  function mmss(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // 设备码流程：每 2 秒轮询一次（总线也会推，以 cx.flows 为准），倒计时每秒走
  $effect(() => {
    if (!flowId || !flowLive) return;
    const id = flowId;
    const poll = setInterval(() => pollDeviceLogin(id), 2000);
    const tick = setInterval(() => { now = Date.now(); }, 1000);
    now = Date.now();
    return () => { clearInterval(poll); clearInterval(tick); };
  });

  // 登录成功 / 号已经在池里：关弹窗（后者在号池下面留一句）
  $effect(() => {
    const s = flow?.state;
    if (s !== 'done' && s !== 'duplicate') return;
    untrack(() => {
      if (s === 'duplicate') showNotice(flowStateText('duplicate'));
      flowId = '';
      closeModal();
    });
  });

  // 弹窗开着：系统返回与 Esc 只关弹窗（桌面设置在冒泡阶段听 Esc 关整页，这里在捕获阶段先拦）
  $effect(() => {
    if (!modal) return;
    const unlayer = pushBackLayer(() => closeModal());
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeModal();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      unlayer();
    };
  });

  // 离开分区时：没走完的登录取消掉，计时器收掉
  $effect(() => () => {
    untrack(() => dropFlow());
    clearTimeout(noticeTimer);
    clearTimeout(copyTimer);
  });

  const dlgTitle = $derived(
    !modal ? '' : modal.mode === 'edit' ? t('编辑账号') : modal.mode === 'login' ? t('重新登录') : t('添加 ChatGPT 账号')
  );
</script>

{#snippet meter(r)}
  <span class="mm">
    <span class="mh">{r.name}<b class={usageTone(r.usedPercent)}>{Number.isFinite(Number(r.usedPercent)) ? Math.round(r.usedPercent) + '%' : '—'}</b></span>
    <span class="mb"><i class={usageTone(r.usedPercent)} style:width="{Math.min(100, Math.max(0, Number(r.usedPercent) || 0))}%"></i></span>
    <span class="mr">{resetText(r.resetsAt)}</span>
  </span>
{/snippet}

<div class="ghd">
  <h3>{t('Codex 账号')}</h3>
  <button
    type="button"
    class="ico-btn"
    class:busy={cx.usageBusy}
    onclick={() => loadCodexPool({ usage: true, force: true })}
    disabled={cx.usageBusy}
    title={cx.usageBusy ? t('刷新中…') : t('刷新用量')}
    aria-label={cx.usageBusy ? t('刷新中…') : t('刷新用量')}
  >{@html svgOf('refresh', 1.8)}</button>
</div>

<DGroup>
  <div class="pool" class:hl-line={fl('cx-pool')}>
    {#if !cx.pool}
      <div class="drow"><span class="mna">{cx.usageBusy || cx.poolLoading ? t('读取中…') : '—'}</span></div>
    {/if}
    {#each accounts as acc, i (acc.id)}
      {@const rows = usageRows(acc.limits)}
      {@const cool = coolingText(acc.cooling)}
      {@const sub = acc.email || acc.workspaceName}
      {@const acctErr = cx.errors['acct:' + acc.id]}
      <div class="drow prow" class:off={acc.disabled}>
        <div class="pmain">
          <div class="pname">
            <b>{accLabel(acc)}</b>
            {#if acc.kind === 'local' || acc.kind === 'apikey'}<span class="pill">{kindLabel(acc.kind)}</span>{/if}
            {#if planLabel(acc.plan)}<span class="pill">{planLabel(acc.plan)}</span>{/if}
            {#if routerOn()}
              {#if acc.host?.activeTurns > 0}<span class="cur">{t('在跑 {n} 轮', { n: acc.host.activeTurns })}</span>{/if}
            {:else if acc.id === cx.pool?.activeId}
              <span class="cur">{t('使用中')}</span>
            {/if}
            {#if acc.pending}<span class="st">{t('登录中')}</span>
            {:else if !acc.loggedIn}<span class="st">{t('未登录')}</span>{/if}
            {#if acc.disabled}<span class="st">{t('已停用')}</span>{/if}
            {#if acc.shared}<span class="st">{t('已共享')}</span>{/if}
          </div>
          {#if sub}<div class="pemail">{sub}</div>{/if}
          {#if cool}<div class="pnote">{cool}</div>{/if}
          {#if acc.host?.state === 'error'}
            <div class="pnote bad">{hostStateText(acc.host)}{acc.host.lastError ? ' · ' + tr(acc.host.lastError) : ''}</div>
          {/if}
          {#if acctErr}<div class="pnote bad">{acctErr}</div>{/if}
          {#if rows.length}
            <div class="cx-mini">
              {#each rows as r (r.key)}{@render meter(r)}{/each}
              {#if acc.limits?.stale}<span class="mstale">{t('上次读到的')}</span>{/if}
            </div>
          {:else if acc.limits === undefined && cx.usageBusy}
            <div class="cx-mini"><span class="mna">{t('读取用量…')}</span></div>
          {:else if acc.limits?.reason === 'not-running'}
            <div class="cx-mini"><span class="mna">{t('进程没在跑，用过一次才有额度数据')}</span></div>
          {/if}
        </div>
        <div class="pacts">
          {#if !routerOn() && acc.id !== cx.pool?.activeId && !acc.disabled && acc.loggedIn}
            <DButton size="sm" disabled={isBusy(acc.id, 'active')} onclick={() => activateAccount(acc.id)}>{t('切到此号')}</DButton>
          {/if}
          <span class="tools">
            {#if accounts.length > 1}
              <button type="button" class="ico-btn" disabled={i === 0 || isBusy(acc.id, 'move')} onclick={() => moveAccount(acc.id, -1)} title={t('上移')} aria-label={t('上移')}>{@html svgOf('up', 1.8)}</button>
              <button type="button" class="ico-btn" disabled={i === accounts.length - 1 || isBusy(acc.id, 'move')} onclick={() => moveAccount(acc.id, 1)} title={t('下移')} aria-label={t('下移')}>{@html svgOf('down', 1.8)}</button>
            {/if}
            <button type="button" class="ico-btn" onclick={() => openEdit(acc)} title={t('编辑账号')} aria-label={t('编辑账号')}>{@html svgOf('edit', 1.7)}</button>
            {#if acc.kind !== 'local'}
              <button type="button" class="ico-btn danger" disabled={isBusy(acc.id, 'delete')} onclick={() => askDelete(acc)} title={t('删除账号')} aria-label={t('删除账号')}>{@html svgOf('trash', 1.7)}</button>
            {/if}
          </span>
        </div>
      </div>
    {/each}
    <button type="button" class="drow addrow" onclick={openAdd}>{@html svgOf('plus', 1.8)}{t('添加 ChatGPT 账号')}</button>
  </div>
</DGroup>
{#if cx.errors.pool}<p class="err">{cx.errors.pool}</p>{/if}
{#if notice}<p class="note pool-note">{notice}</p>{/if}

<!-- 撞上限额时：自动换号与分派方式 -->
<DGroup label={t('撞上限额时')}>
  <DRow
    title={t('额度用尽自动换号')}
    highlight={fl('cx-router')}
  >
    {#snippet trailing()}
      <DSwitch checked={routerOn()} disabled={!cx.pool?.router || cx.busy === 'router'} onchange={(v) => setRouter({ enabled: v })} />
    {/snippet}
  </DRow>
  {#if routerOn()}
    <div class="drow cr ind">
      <span class="cr-tx">
        <span class="cr-t">{t('分派方式')}</span>
        <span class="cr-s">{routeStrategies().find((o) => o.value === strategy)?.desc}</span>
      </span>
      <span class="cr-tr">
        <DSelect
          options={routeStrategies().map((o) => ({ value: o.value, label: o.label }))}
          value={strategy}
          onchange={(v) => setRouter({ strategy: v })}
          width="160px"
        />
      </span>
    </div>
    <div class="drow cr ind">
      <span class="cr-tx"><span class="cr-t">{t('会话中无缝换号')}</span></span>
      <span class="cr-tr">
        <DSwitch checked={cx.pool?.router?.seamless !== false} disabled={cx.busy === 'router'} onchange={(v) => setRouter({ seamless: v })} />
      </span>
    </div>
  {/if}
</DGroup>
{#if cx.errors.router}<p class="err">{cx.errors.router}</p>{/if}

{#if modal}
  <div class="ag-dlg-root" role="dialog" aria-modal="true" aria-label={dlgTitle}>
    <button type="button" class="dlg-dim" aria-label={t('关闭')} onclick={closeModal}></button>
    <div class="dlg ag-dlg">
      <h3>{dlgTitle}</h3>

      {#if modal.mode === 'edit'}
        {#if modalAcc}
          {@const acctErr = cx.errors['acct:' + modalAcc.id]}
          {#if modalAcc.email || modalAcc.workspaceName}<p>{modalAcc.email || modalAcc.workspaceName}</p>{/if}
          <DField value={formLabel} placeholder={t('备注名')} oninput={(v) => { formLabel = v; }} onchange={(v) => { formLabel = v; }} />
          <div class="dsw">
            <div class="dsw-row"><span>{t('共享给成员')}</span><DSwitch checked={formShared} onchange={(v) => { formShared = v; }} /></div>
            <div class="dsw-row"><span>{t('停用')}</span><DSwitch checked={formDisabled} onchange={(v) => { formDisabled = v; }} /></div>
          </div>
          <div class="dops">
            {#if modalAcc.kind === 'chatgpt'}
              <DButton size="sm" disabled={loginBusy} onclick={reloginFromEdit}>{t('重新登录')}</DButton>
            {/if}
            <DButton size="sm" disabled={isBusy(modalAcc.id, 'restart')} onclick={() => restartAccount(modalAcc.id)}>
              {isBusy(modalAcc.id, 'restart') ? t('重启中…') : t('重启进程')}
            </DButton>
            {#if modalAcc.resetCredits > 0}
              <DButton size="sm" disabled={isBusy(modalAcc.id, 'reset')} onclick={askResetCredit}>
                {t('使用重置卡（剩 {n} 张）', { n: modalAcc.resetCredits })}
              </DButton>
            {/if}
          </div>
          {#if acctErr}<p class="err">{acctErr}</p>{/if}
          <div class="dacts">
            <DButton onclick={closeModal}>{t('取消')}</DButton>
            <DButton variant="primary" disabled={isBusy(modalAcc.id, 'update')} onclick={saveEdit}>
              {isBusy(modalAcc.id, 'update') ? t('保存中…') : t('保存')}
            </DButton>
          </div>
        {:else}
          <p>{t('账号不存在')}</p>
          <div class="dacts"><DButton onclick={closeModal}>{t('关闭')}</DButton></div>
        {/if}
      {:else}
        <!-- 设备码登录（add：新号；login：重新登录已有的号） -->
        {#if modal.mode === 'login' && modalAcc}<p>{accLabel(modalAcc)}{modalAcc.email ? ' · ' + modalAcc.email : ''}</p>{/if}
        <p class="hint">{t('先在 ChatGPT 网页「设置 › 安全」里打开设备码登录')}</p>

        {#if flow && !flowEnded}
          <div class="dcode">
            {#if flow.userCode}
              <button type="button" class="ucode" onclick={() => copy(flow.userCode, 'code')} title={t('复制')}>{flow.userCode}</button>
              <span class="ucap">{copied === 'code' ? t('已复制') : t('点验证码复制')}</span>
            {/if}
            {#if flow.verificationUrl}
              <div class="vurl">
                <a href={flow.verificationUrl} target="_blank" rel="noopener noreferrer">{flow.verificationUrl}</a>
                <button type="button" class="ico-btn" onclick={() => copy(flow.verificationUrl, 'url')} title={copied === 'url' ? t('已复制') : t('复制链接')} aria-label={t('复制链接')}>
                  {#if copied === 'url'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
                  {:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3"/></svg>{/if}
                </button>
              </div>
            {/if}
            <div class="fstate">
              {#if flowLive}<span class="spin"></span>{/if}
              <span>{flowStateText(flow.state)}</span>
              {#if flow.state === 'pending' && flow.expiresAt}<span class="num">{t('{time} 后过期', { time: mmss(flow.expiresAt - now) })}</span>{/if}
            </div>
          </div>
        {:else if flowEnded}
          <div class="dcode">
            <p class="err">{flowStateText(flow.state)}{flow.error && flow.state !== 'cancelled' ? ' · ' + tr(flow.error) : ''}</p>
          </div>
        {:else if modal.mode === 'add'}
          <DField value={formLabel} placeholder={t('备注名（可不填）')} oninput={(v) => { formLabel = v; }} onchange={(v) => { formLabel = v; }} />
        {/if}

        {#if !flow || flowEnded}
          <div class="dstart">
            <DButton variant="primary" disabled={loginBusy} onclick={beginLogin}>
              {loginBusy ? t('正在发起…') : flowEnded ? t('重新开始') : t('开始登录')}
            </DButton>
          </div>
        {/if}

        {#if modal.mode === 'add' && !flowLive}
          <details class="manual-wrap" bind:open={showApiKey}>
            <summary>{t('改用 API 密钥')}</summary>
            <form class="manual-form" onsubmit={submitApiKey}>
              <DField type="password" value={apiKey} placeholder={t('OpenAI API 密钥（sk-…）')} oninput={(v) => { apiKey = v; }} onchange={(v) => { apiKey = v; }} />
              <DButton size="sm" variant="primary" type="submit" disabled={!apiKey.trim() || keyBusy}>
                {keyBusy ? t('验证中…') : t('验证并添加')}
              </DButton>
            </form>
          </details>
        {/if}

        {#if cx.errors.login}<p class="err">{cx.errors.login}</p>{/if}
        <div class="dacts">
          <DButton onclick={closeModal}>{flowLive ? t('取消登录') : t('关闭')}</DButton>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  @import './kit.css';

  .prow.off .pname b { color: var(--dsk-ink-3); }
  .st { font-size: var(--dsk-fs-sm); color: var(--dsk-ink-3); }
  .pemail, .pnote {
    margin-top: 2px;
    font-size: var(--dsk-fs-sm);
    color: var(--dsk-ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pnote.bad { color: var(--dsk-crit); white-space: normal; }
  .cx-mini { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 18px; margin-top: 9px; }
  .cx-mini .mm { width: 116px; }
  .mstale { padding-bottom: 1px; font-size: var(--dsk-fs-caption); color: var(--dsk-ink-3); white-space: nowrap; }
  .pool-note { margin-top: var(--dsk-s2); }

  .ag-dlg-root {
    position: fixed;
    inset: 0;
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
  .dlg p.err { margin: 0; }
  .dsw { display: flex; flex-direction: column; border-radius: 10px; background: var(--dsk-panel); box-shadow: inset 0 0 0 1px var(--dsk-line); }
  .dsw-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 12px; font-size: var(--dsk-fs-ui); color: var(--dsk-ink); }
  .dsw-row + .dsw-row { border-top: 1px solid var(--dsk-line); }
  .dops { display: flex; flex-wrap: wrap; gap: 8px; }
  .dstart { display: flex; }

  /* 设备码：验证码大字等宽、点了复制；链接一行可点 + 复制 */
  .dcode {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 16px 14px 14px;
    border-radius: 10px;
    background: var(--dsk-panel);
    box-shadow: inset 0 0 0 1px var(--dsk-line);
    text-align: center;
  }
  .ucode {
    padding: 2px 10px;
    border-radius: 8px;
    font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace);
    font-size: 26px;
    font-weight: 600;
    letter-spacing: .14em;
    color: var(--dsk-ink);
    user-select: all;
    transition: background var(--dsk-t-fast) ease;
  }
  .ucode:hover { background: var(--dsk-hover); }
  .ucap { margin-top: -6px; font-size: var(--dsk-fs-caption); color: var(--dsk-ink-3); }
  .vurl { display: flex; align-items: center; gap: 4px; max-width: 100%; }
  .vurl a {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--dsk-fs-ui);
    color: var(--dsk-ink);
    text-decoration: underline;
    text-decoration-color: var(--dsk-line-strong);
    text-underline-offset: 3px;
  }
  .vurl a:hover { text-decoration-color: currentColor; }
  .fstate { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; font-size: var(--dsk-fs-sm); color: var(--dsk-ink-2); }

  .manual-wrap { font-size: var(--dsk-fs-sm); color: var(--dsk-ink-3); }
  .manual-wrap summary { cursor: pointer; user-select: none; list-style: none; }
  .manual-wrap summary:hover { color: var(--dsk-ink-2); }
  .manual-form { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin-top: 8px; }
  .manual-form :global(.fld) { width: 100%; }
</style>
