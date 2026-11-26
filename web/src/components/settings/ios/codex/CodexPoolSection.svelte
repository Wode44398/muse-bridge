<script>
  // 手机 / 网页设置（iOS 外壳）› Codex 的号池与撞线换号（嵌在 'ag-codex' 主页顶部，只给管理员）。
  import Sym from '../../../ios27/Sym.svelte';
  import Toggle from '../../../ios27/Toggle.svelte';
  import { SI } from '../../../../lib/settingsIcons.js';
  import { t } from '../../../../lib/i18n.js';
  import { grow } from '../../../../lib/arrive.js';
  import { cx, loadCodexPool, setRouter, routerOn } from '../../../../lib/codex/settings.svelte.js';
  import {
    accLabel,
    planLabel,
    kindLabel,
    coolingText,
    usageRows,
    usageTone,
    routeStrategies,
    optionLabel,
  } from '../../../../lib/codex/settings-logic.js';

  let { push } = $props();

  const svgOf = (name, w = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;

  const accounts = $derived(cx.pool?.accounts || []);
  const router = $derived(cx.pool?.router || null);

  // 行尾的短状态：当前号写「使用中」，否则按 停用 > 登录中 > 未登录 > 撞线冷却 > 进程出错 取第一条
  function rowStatus(acc) {
    if (acc.id === cx.pool?.activeId && !routerOn()) return { text: t('使用中'), tone: '' };
    if (acc.disabled) return { text: t('已停用'), tone: '' };
    if (acc.pending) return { text: t('登录中'), tone: '' };
    if (!acc.loggedIn) return { text: t('未登录'), tone: 'warn' };
    const c = coolingText(acc.cooling);
    if (c) return { text: c, tone: 'warn' };
    if (acc.host?.state === 'error' || acc.host?.state === 'backoff') return { text: t('进程出错'), tone: 'err' };
    return null;
  }
  // 行下那一条用量：取用得最多的窗口（单窗口的号就是第一条）
  function tightest(acc) {
    const rows = usageRows(acc.limits);
    if (!rows.length) return null;
    return rows.reduce((m, r) => ((Number(r.usedPercent) || 0) > (Number(m.usedPercent) || 0) ? r : m), rows[0]);
  }
  const pct = (v) => Math.max(0, Math.round(Number(v) || 0));
</script>

{#snippet chev()}<Sym name="chevron.right" weight={600} size={13} class="chev" />{/snippet}

<!-- 1. Codex 账号 -->
<div class="ghead-row">
  <h2 class="ghead">{t('Codex 账号')}</h2>
  <button
    class="gh-ico"
    class:busy={cx.usageBusy}
    type="button"
    onclick={() => loadCodexPool({ usage: true, force: true })}
    disabled={cx.usageBusy}
    aria-label={cx.usageBusy ? t('刷新中…') : t('刷新用量')}
  >{@html svgOf('refresh', 1.8)}</button>
</div>

<div class="ig">
  {#each accounts as acc (acc.id)}
    {@const st = rowStatus(acc)}
    {@const u = tightest(acc)}
    {@const plan = planLabel(acc.plan)}
    <!-- 第一次用时账号行晚到：从 0 长出来把下面平滑推开；有快照时跟着页面一起出现，不播 -->
    <button class="r acct-r" type="button" transition:grow onclick={() => push?.('cx:acct:' + acc.id, accLabel(acc))}>
      <span class="r-main">
        <span class="r-tx">
          <span class="acct-name">
            <span>{accLabel(acc)}</span>
            {#if plan}<span class="pill">{plan}</span>{/if}
            {#if acc.kind && acc.kind !== 'chatgpt' && kindLabel(acc.kind)}<span class="pill">{kindLabel(acc.kind)}</span>{/if}
          </span>
          {#if !u && acc.limits === undefined && cx.usageBusy}
            <!-- 额度还在路上（总线推来的号池不带额度）：先按到齐后的样子占一格，回来只是数字填进去，行高不变 -->
            <span class="mini cx-mini" aria-hidden="true">
              <span class="mini-m pend"><span class="mini-h">&nbsp;<b>—</b></span><span class="mini-bar"><i style:width="0%"></i></span></span>
            </span>
          {:else if u}
            {@const tone = usageTone(u.usedPercent)}
            <span class="mini cx-mini">
              <span class="mini-m">
                <span class="mini-h">{u.name}<b class={tone}>{pct(u.usedPercent)}%</b></span>
                <span class="mini-bar"><i class={tone} style:width="{Math.min(100, pct(u.usedPercent))}%"></i></span>
              </span>
            </span>
          {/if}
        </span>
        {#if st}<span class="r-d" class:warn={st.tone === 'warn'} class:err={st.tone === 'err'}>{st.text}</span>{/if}
        {@render chev()}
      </span>
    </button>
  {/each}

  <button class="r" type="button" onclick={() => push?.('cx:add', t('添加 ChatGPT 账号'))}>
    <span class="r-main"><span class="r-tx accent">{t('添加 ChatGPT 账号')}</span></span>
  </button>
</div>
{#if cx.errors.pool}<p class="gfoot err">{cx.errors.pool}</p>{/if}

<!-- 2. 撞上限额时（号池晚到时整组长出来） -->
{#if cx.pool}
  <div class="grp" transition:grow>
  <h2 class="ghead">{t('撞上限额时')}</h2>
  <div class="ig">
    <div class="r">
      <span class="r-main">
        <span class="r-tx">{t('额度用尽自动换号')}</span>
        <Toggle
          checked={routerOn()}
          disabled={!router || cx.busy === 'router'}
          onchange={() => setRouter({ enabled: !routerOn() })}
          label={t('额度用尽自动换号')}
        />
      </span>
    </div>
    {#if routerOn()}
      <button class="r ind" type="button" onclick={() => push?.('cx:strategy', t('分派方式'))}>
        <span class="r-main">
          <span class="r-tx">{t('分派方式')}</span>
          <span class="r-d">{optionLabel(routeStrategies(), router?.strategy || 'smart')}</span>
          {@render chev()}
        </span>
      </button>
      <div class="r ind">
        <span class="r-main">
          <span class="r-tx">{t('会话中无缝换号')}</span>
          <Toggle
            checked={router?.seamless !== false}
            disabled={cx.busy === 'router'}
            onchange={() => setRouter({ seamless: router?.seamless === false })}
            label={t('会话中无缝换号')}
          />
        </span>
      </div>
    {/if}
  </div>
  {#if cx.errors.router}<p class="gfoot err">{cx.errors.router}</p>{/if}
  </div>
{/if}

<style>
  @import '../kit.css';
  .mini.cx-mini {
    grid-template-columns: minmax(0, 1fr);
    max-width: 220px;
  }
</style>
