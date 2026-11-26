<script>
  // 手机 / 网页设置（iOS 外壳）› Antigravity 订阅号池与智能换号分区（嵌入在 ag-agy 主页顶部）。
  import { untrack } from 'svelte';
  import Sym from '../../../ios27/Sym.svelte';
  import Toggle from '../../../ios27/Toggle.svelte';
  import { SI } from '../../../../lib/settingsIcons.js';
  import { t, tr } from '../../../../lib/i18n.js';
  import { grow } from '../../../../lib/arrive.js';
  import {
    agyPool,
    loadAgyPool,
    loadAgyPoolUsage,
    setAgyRouter,
    accLabel,
    agyPlanPill,
    agyUsageTone,
    agyHhmm,
    poolResetAt,
    routeStrategies,
    routerStrategy,
    routerEnabled,
    smartRouting,
    runningOn,
    acctById,
    whyText,
    routeLogTitle,
    routeLogSub,
  } from '../../../../lib/agy/pool.svelte.js';

  let { push } = $props();

  const svgOf = (name, w = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;

  $effect(() => {
    untrack(() => loadAgyPool({ usage: true }));
  });
</script>

{#snippet chev()}<Sym name="chevron.right" weight={600} size={13} class="chev" />{/snippet}
{#snippet check()}<Sym name="checkmark" weight={600} size={15} class="ck" />{/snippet}

<!-- 1. 订阅号池 -->
<div class="ghead-row">
  <h2 class="ghead">{t('订阅号池')}</h2>
  <button
    class="gh-ico"
    class:busy={agyPool.usageBusy}
    type="button"
    onclick={() => loadAgyPoolUsage(true)}
    disabled={agyPool.usageBusy}
    aria-label={agyPool.usageBusy ? t('刷新中…') : t('刷新用量')}
  >{@html svgOf('refresh', 1.8)}</button>
</div>

<div class="ig">
  {#each agyPool.accounts as acc (acc.id)}
    {@const u = agyPool.usage[acc.id]}
    {@const planTag = agyPlanPill(u?.plan || acc.effectivePlan)}
    {@const pend = !u && (agyPool.usageBusy || !agyPool.usageLoaded)}
    {@const hasAnyBucket = !!(u && (u.gemini_5h || u.gemini_weekly || u.tp_5h || u.tp_weekly))}
    <!-- 第一次用时账号行晚到：从 0 长出来把下面平滑推开；有快照时跟着页面一起出现，不播 -->
    <button class="r acct-r" type="button" transition:grow onclick={() => push?.('agy:acct:' + acc.id, accLabel(acc.label))}>
      <span class="r-main">
        <span class="r-tx">
          <span class="acct-name">
            <span>{accLabel(acc.label)}</span>
            {#if planTag}<span class="pill">{planTag}</span>{/if}
            {#if acc.source === 'local'}<span class="pill">{t('本机')}</span>{/if}
            {#if smartRouting()}
              {#if runningOn(acc.id)}<span class="cur">{t('在跑 {n} 个任务', { n: runningOn(acc.id) })}</span>{/if}
            {:else if acc.active}
              <span class="cur">{t('使用中')}</span>
            {/if}
          </span>
          {#if acc.email || u?.email}
            <span class="r-sub agy-mail">{acc.email || u.email}</span>
          {/if}
          <span class="mini agy-mini">
            {#if !u && !pend}
              <span class="mini-na">{(acc.source === 'slot' ? t('本机 agy 托管登录') : acc.hasToken ? '…' + (acc.tokenTail || '') : t('沿用本机 agy 登录态'))}</span>
            {:else if u?.error && !hasAnyBucket}
              <span class="mini-na" class:err={acc.source !== 'local'}>{tr(u.error)}</span>
            {:else}
              <!-- 用量还在路上（pend）也先按到齐后的样子占好四格、同样的行高：回来只是数字原地填进去，账号行不会被撑高一截 -->
              {#each [
                ['gemini_5h', t('Gemini 5h')],
                ['gemini_weekly', t('Gemini 每周')],
                ['tp_5h', t('Claude/GPT 5h')],
                ['tp_weekly', t('Claude/GPT 每周')],
              ] as [k, name] (k)}
                {@const b = u?.[k]}
                <span class="mini-m" class:pend aria-hidden={pend || undefined}>
                  <span class="mini-h">{name}<b class={b ? agyUsageTone(b) : ''}>{b ? Math.round(b.usedPct) + '%' : '—'}</b></span>
                  <span class="mini-bar"><i class={b ? agyUsageTone(b) : ''} style:width="{b ? Math.min(100, b.usedPct) : 0}%"></i></span>
                  <span class="mini-r">{b ? poolResetAt(b.resetAt) : ''}</span>
                </span>
              {/each}
            {/if}
          </span>
        </span>
        {@render chev()}
      </span>
    </button>
  {/each}

  <button class="r add" type="button" onclick={() => push?.('agy:acct-add', t('添加 Google 账号'))}>
    <span class="r-main"><span class="r-tx accent">{t('添加 Google 账号')}</span></span>
  </button>
</div>
{#if agyPool.err}<p class="gfoot err">{agyPool.err}</p>{/if}
<!-- 脚注始终在、只换字：插进 / 撤掉一段脚注时 .ig:has(+ .gfoot) 会让卡的 26px 下外边距一帧内跳没。
     号池还不知道时（第一次用、快照也没有）先写通用那句，别先画「去授权」再改口 -->
<p class="gfoot">{(agyPool.loaded || agyPool.snap) && agyPool.accounts.length <= 1 && !agyPool.localAuthed && !agyPool.accounts.some((a) => a.hasToken)
  ? t('可直接点击「添加 Google 账号」在线授权入池，或在电脑终端执行一次 agy 完成本机登录。')
  : t('通过本机上游代理零重启切号；Gemini 与 Claude / GPT 额度相互独立，不改动系统钥匙串。')}</p>

<!-- 2. 撞上限额时 -->
<h2 class="ghead">{t('撞上限额时')}</h2>
<div class="ig">
  <div class="r">
    <span class="r-main">
      <span class="r-tx">
        {t('额度用尽自动换号')}
        {#if agyPool.accounts.length < 2}<span class="r-sub">{t('号池里至少要有两个账号才用得上')}</span>{/if}
      </span>
      <Toggle
        checked={routerEnabled()}
        disabled={!agyPool.router || agyPool.routerBusy}
        onchange={() => setAgyRouter({ enabled: !routerEnabled() })}
        label={t('额度用尽自动换号')}
      />
    </span>
  </div>

  {#if routerEnabled()}
    {#each routeStrategies() as o (o.value)}
      <button
        class="r ind"
        type="button"
        disabled={agyPool.routerBusy}
        onclick={() => { if (routerStrategy() !== o.value) setAgyRouter({ strategy: o.value }); }}
      >
        <span class="r-main">
          <span class="r-tx">{o.label}<span class="r-sub">{o.desc}</span></span>
          {#if routerStrategy() === o.value}{@render check()}{/if}
        </span>
      </button>
    {/each}
    <div class="r ind">
      <span class="r-main">
        <span class="r-tx">
          {t('会话中无缝换号')}
          <span class="r-sub">
            {smartRouting()
              ? t('任务跑到一半、所在的号快用满或撞墙时，在两步之间把它换到别的号，对话不中断')
              : t('快用满或撞 429 时原地切号重发，进行中的对话不中断')}
          </span>
        </span>
        <Toggle
          checked={!!agyPool.router?.settings?.seamless}
          disabled={agyPool.routerBusy}
          onchange={() => setAgyRouter({ seamless: !agyPool.router?.settings?.seamless })}
          label={t('会话中无缝换号')}
        />
      </span>
    </div>
  {/if}
</div>

{#if routerEnabled() && agyPool.router?.log?.length}
  <div class="grp" transition:grow>
  <h2 class="ghead">{smartRouting() ? t('最近的分派') : t('最近的自动切换')}</h2>
  <div class="ig">
    {#each agyPool.router.log as item, idx (item.at + ':' + idx)}
      {#if item.kind}
        <div class="r">
          <span class="r-main">
            <span class="r-tx">
              {routeLogTitle(item)}
              <span class="r-sub">{routeLogSub(item, (rid, fb) => accLabel(acctById(rid)?.label || fb))}</span>
            </span>
            <span class="r-d num">{agyHhmm(item.at)}</span>
          </span>
        </div>
      {:else}
        <div class="r">
          <span class="r-main">
            <span class="r-tx">
              {accLabel(acctById(item.from)?.label || item.fromLabel)} → {accLabel(acctById(item.to)?.label || item.toLabel)}
              <span class="r-sub">{whyText(item.reason)}</span>
            </span>
            <span class="r-d num">{agyHhmm(item.at)}</span>
          </span>
        </div>
      {/if}
    {/each}
  </div>
  </div>
{/if}

<style>
  @import '../kit.css';
  .agy-mail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mini.agy-mini {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 14px;
  }
</style>
