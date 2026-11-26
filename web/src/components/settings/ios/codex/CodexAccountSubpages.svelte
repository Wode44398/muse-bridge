<script>
  // 手机 / 网页设置（iOS 外壳）› Codex 号池子页：
  //   · cx:acct:<id>    单个号的详情：额度、状态、设置（备注名 / 共享 / 停用）、操作（切号、重新登录、重启、重置卡、调序、删除）
  //   · cx:rename:<id>  改备注名
  import { untrack } from 'svelte';
  import Sym from '../../../ios27/Sym.svelte';
  import Toggle from '../../../ios27/Toggle.svelte';
  import { uiConfirm } from '../../../../lib/dialogs.js';
  import { SI } from '../../../../lib/settingsIcons.js';
  import { t, tr } from '../../../../lib/i18n.js';
  import { ags } from '../../../../lib/agentSettings.svelte.js';
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
  } from '../../../../lib/codex/settings.svelte.js';
  import {
    accLabel,
    planLabel,
    kindLabel,
    hostStateText,
    coolingText,
    usageRows,
    usageTone,
    resetText,
  } from '../../../../lib/codex/settings-logic.js';

  let { pid = '', push, pop, onModal } = $props();

  const svgOf = (name, w = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;

  const isDetail = $derived(pid.startsWith('cx:acct:'));
  const isRename = $derived(pid.startsWith('cx:rename:'));
  const id = $derived(isDetail ? pid.slice('cx:acct:'.length) : isRename ? pid.slice('cx:rename:'.length) : '');
  // 删号成功后到页面退场之间，号已经不在快照里了：用删之前那一份撑住，别闪出「不在号池里」
  let leaving = $state.raw(null);
  const acc = $derived((id ? accountById(id) : null) || leaving);
  const accounts = $derived(cx.pool?.accounts || []);
  const idx = $derived(acc ? accounts.findIndex((a) => a.id === acc.id) : -1);
  const rows = $derived(acc ? usageRows(acc.limits) : []);
  const busyAcct = $derived(cx.busy.startsWith('acct:' + id + ':'));
  const cool = $derived(acc ? coolingText(acc.cooling) : '');
  const hostBad = $derived(acc?.host?.state === 'error' || acc?.host?.state === 'backoff');
  const isActive = $derived(!!acc && acc.id === cx.pool?.activeId);
  const pct = (v) => Math.max(0, Math.round(Number(v) || 0));

  // 改备注名：进页时拿一次当前名字（之后总线推来的快照不覆盖正在改的字）
  let nameDraft = $state('');
  $effect(() => {
    if (!isRename) return;
    const a = acc;
    untrack(() => { if (a && !nameDraft) nameDraft = accLabel(a); });
  });

  async function confirmModal(message, opts) {
    onModal?.(true);
    try { return await uiConfirm(message, opts); }
    finally { onModal?.(false); }
  }

  async function saveName() {
    if (!acc) return;
    const v = nameDraft.trim();
    if (!v || v === accLabel(acc)) { pop?.(); return; }
    if (await updateAccount(acc.id, { label: v })) pop?.();
  }

  async function askResetCredit() {
    if (!acc) return;
    const ok = await confirmModal(t('给「{name}」用一张重置卡？', { name: accLabel(acc) }), {
      detail: t('这个号的额度会立刻重置，用掉的卡不能撤回。'),
      okLabel: t('使用'),
      danger: true,
    });
    if (ok) await useResetCredit(acc.id);
  }

  async function askDelete() {
    if (!acc) return;
    const ok = await confirmModal(t('删除账号「{name}」？', { name: accLabel(acc) }), {
      detail: t('会登出这个号，并删掉它在这台服务器上的 Codex 目录。'),
      okLabel: t('删除'),
      danger: true,
    });
    if (!ok) return;
    const snap = $state.snapshot(acc);
    leaving = snap;
    if (await deleteAccount(snap.id)) pop?.();
    else leaving = null;
  }
</script>

{#snippet chev()}<Sym name="chevron.right" weight={600} size={13} class="chev" />{/snippet}

{#if isDetail && acc}
  {@const plan = planLabel(acc.plan)}
  {@const kind = kindLabel(acc.kind)}
  <div class="hero">
    <span class="av big" aria-hidden="true">{(accLabel(acc) || '?').trim().charAt(0).toUpperCase()}</span>
    <div class="hero-name">{accLabel(acc)}</div>
    {#if plan || kind}<div class="hero-sub">{[plan, kind].filter(Boolean).join(' · ')}</div>{/if}
    {#if acc.email}<div class="hero-sub">{acc.email}</div>{/if}
  </div>

  <!-- 额度 -->
  {#if rows.length || acc.kind !== 'apikey'}
    <div class="ghead-row">
      <h2 class="ghead">{t('额度')}</h2>
      <button
        class="gh-ico"
        class:busy={cx.usageBusy}
        type="button"
        onclick={() => loadCodexPool({ usage: true, force: true })}
        disabled={cx.usageBusy}
        aria-label={cx.usageBusy ? t('刷新中…') : t('刷新用量')}
      >{@html svgOf('refresh', 1.8)}</button>
    </div>
    {#if rows.length}
      <div class="ig usage">
        {#each rows as r (r.key)}
          {@const tone = usageTone(r.usedPercent)}
          {@const rs = resetText(r.resetsAt)}
          <div class="u">
            <div class="u-top">
              <span class="u-l">{r.name}</span>
              <span class="u-v num" class:hot={tone === 'red'}>{t('{pct}% 已用', { pct: pct(r.usedPercent) })}</span>
            </div>
            <span class="bar-u"><i style:width="{Math.min(100, pct(r.usedPercent))}%" class:hot={tone === 'red'} class:warm={tone === 'amber'}></i></span>
            {#if rs || tone === 'red'}<span class="u-r">{tone === 'red' ? t('已达上限') + (rs ? ' · ' : '') : ''}{rs}</span>{/if}
          </div>
        {/each}
      </div>
    {/if}
    {#if acc.limits?.reason === 'not-running'}
      <p class="gfoot">{t('进程没在跑，用过一次才有额度数据')}</p>
    {:else if acc.limits?.stale}
      <p class="gfoot">{t('显示的是上次读到的额度')}</p>
    {:else if !rows.length}
      <p class="gfoot">{cx.usageBusy ? t('读取用量…') : t('暂无额度数据')}</p>
    {/if}
  {/if}

  <!-- 状态 -->
  <h2 class="ghead">{t('状态')}</h2>
  <div class="ig">
    {#if acc.pending || !acc.loggedIn}
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('登录')}</span><span class="r-d warn">{acc.pending ? t('登录中') : t('未登录')}</span></span>
      </div>
    {/if}
    <div class="r">
      <span class="r-main">
        <span class="r-tx">{t('进程')}</span>
        <span class="r-d" class:err={hostBad}>{hostStateText(acc.host) || '—'}</span>
      </span>
    </div>
    {#if cool}
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('限额')}</span><span class="r-d warn">{cool}</span></span>
      </div>
    {/if}
  </div>
  {#if hostBad && acc.host?.lastError}<p class="gfoot err">{tr(acc.host.lastError)}</p>{/if}

  <!-- 设置 -->
  <h2 class="ghead">{t('设置')}</h2>
  <div class="ig">
    <button class="r" type="button" onclick={() => push?.('cx:rename:' + acc.id, t('备注名'))}>
      <span class="r-main">
        <span class="r-tx">{t('备注名')}</span>
        <span class="r-d">{accLabel(acc)}</span>
        {@render chev()}
      </span>
    </button>
    {#if ags.multiUser}
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{t('共享给成员')}</span>
          <Toggle checked={!!acc.shared} disabled={busyAcct} onchange={() => updateAccount(acc.id, { shared: !acc.shared })} label={t('共享给成员')} />
        </span>
      </div>
    {/if}
    <div class="r">
      <span class="r-main">
        <span class="r-tx">{t('停用')}</span>
        <Toggle checked={!!acc.disabled} disabled={busyAcct} onchange={() => updateAccount(acc.id, { disabled: !acc.disabled })} label={t('停用')} />
      </span>
    </div>
  </div>

  <!-- 操作 -->
  <div class="ig">
    {#if !routerOn() && !isActive && !acc.disabled && acc.loggedIn}
      <button class="r" type="button" disabled={busyAcct} onclick={() => activateAccount(acc.id)}>
        <span class="r-main"><span class="r-tx accent">{t('切到此号')}</span></span>
      </button>
    {/if}
    {#if acc.kind === 'chatgpt'}
      <button class="r" type="button" onclick={() => push?.('cx:login:' + acc.id, t('重新登录'))}>
        <span class="r-main"><span class="r-tx">{t('重新登录')}</span>{@render chev()}</span>
      </button>
    {/if}
    <button class="r" type="button" disabled={busyAcct} onclick={() => restartAccount(acc.id)}>
      <span class="r-main"><span class="r-tx">{cx.busy === 'acct:' + acc.id + ':restart' ? t('正在重启…') : t('重启进程')}</span></span>
    </button>
    {#if acc.resetCredits > 0}
      <button class="r" type="button" disabled={busyAcct} onclick={askResetCredit}>
        <span class="r-main"><span class="r-tx">{t('使用重置卡（剩 {n} 张）', { n: acc.resetCredits })}</span></span>
      </button>
    {/if}
    {#if accounts.length > 1}
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{t('顺序')}</span>
          <span class="r-d num">{idx + 1} / {accounts.length}</span>
          <span class="steps">
            <button type="button" disabled={idx <= 0 || busyAcct} onclick={() => moveAccount(acc.id, -1)} aria-label={t('上移')}>{@html svgOf('up', 1.8)}</button>
            <button type="button" disabled={idx >= accounts.length - 1 || busyAcct} onclick={() => moveAccount(acc.id, 1)} aria-label={t('下移')}>{@html svgOf('down', 1.8)}</button>
          </span>
        </span>
      </div>
    {/if}
  </div>
  {#if cx.errors['acct:' + acc.id]}<p class="gfoot err">{cx.errors['acct:' + acc.id]}</p>{/if}

  {#if acc.kind !== 'local'}
    <div class="ig">
      <button class="r" type="button" disabled={busyAcct} onclick={askDelete}>
        <span class="r-main center"><span class="r-tx red">{t('删除账号')}</span></span>
      </button>
    </div>
  {/if}

{:else if isRename && acc}
  <div class="ig">
    <div class="r">
      <span class="r-main">
        <input class="dv-in" bind:value={nameDraft} maxlength="40" placeholder={t('备注名')} />
      </span>
    </div>
  </div>
  {#if cx.errors['acct:' + acc.id]}<p class="gfoot err">{cx.errors['acct:' + acc.id]}</p>{/if}
  <div class="lg-form">
    <button class="lg-go" type="button" disabled={!nameDraft.trim() || busyAcct} onclick={saveName}>
      {busyAcct ? t('保存中…') : t('保存')}
    </button>
  </div>

{:else if cx.usageBusy || cx.poolLoading || (cx.loading && !cx.loaded)}
  <p class="gfoot">{t('读取中…')}</p>
{:else}
  <p class="gfoot">{t('账号不存在')}</p>
{/if}

<style>
  @import '../kit.css';
</style>
