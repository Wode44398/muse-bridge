<script>
  // 上下文用量环 + 用量弹层——官方 claude.ai/code 同款（2026-09-01 逆向桌面包 shared-10-3
  // ChatContextRing / c2d611398 popover body / ce96f5751 breakdown）：
  // - 环：16px、r=(16-2)/2、描边 2、-90° 起笔、圆头；填充 = 正看会话的上下文占比（没有分布
  //   数据时退到 result 事件给的粗填充，再没有才退到额度桶峰值——官方 uI 同序）；
  //   色按官方阈值 ≥90 critical / ≥75 warning，normal 用本页星芒色（彩色只留星芒）。
  // - 弹层 360px：「Context window」行（摘要 + 展开箭头）→ 收起态 4px 进度条 / 展开态
  //   分段计量条与图例（ContextBreakdown）；分隔线；「Plan usage」各桶（4px 条）。
  //   没会话或没数据：「发一条消息后显示」；分布超过 5 分钟且没在跑：「更新于 …」。
  // 数据源：SSE ctx_usage（每轮 done 后 SDK getContextUsage 精确档）+ /api/status?session=
  //（刷新/换设备恢复）；30s 轮询 + 回前台立刷（后台标签页不空转）。
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { status, session, me } from '../lib/state.svelte.js';
  import { relTime } from '../lib/format.js';
  import { ctxSummary, ctxLevel, fmtResetAt } from '../lib/ctxUsage.js';
  import { clampX } from '../lib/clampx.js';
  import ContextBreakdown from './ContextBreakdown.svelte';
  import { t, tr } from '../lib/i18n.js';

  let open = $state(false);
  let expanded = $state(false);
  let ringBtn = $state();
  let dir = $state('up');
  function toggle() {
    if (!open && ringBtn) { const r = ringBtn.getBoundingClientRect(); dir = (window.innerHeight - r.bottom) >= r.top ? 'down' : 'up'; }
    open = !open;
    if (open) refresh();
  }

  // 官方行名（"5-hour limit" / "Weekly · all models" / "Weekly · Fable"…）的中文同构；
  // 按模型分桶的键（seven_day_fable / weekly_xxx）带 label 字段时直接用服务端给的显示名。
  // 桶名语义按 CLI 自己的文案表（claude.exe eF）：seven_day_overage_included = "Fable limit"——就是官方
  // 「Weekly · Fable」那一桶，之前误标成「含超额」；overage = 用量信用（usage credit）额度，官方弹层不摆。
  const LABELS = {
    five_hour: t('5 小时上限'), seven_day: t('每周 · 所有模型'),
    seven_day_overage_included: t('每周 · Fable'), seven_day_opus: t('每周 · Opus'), seven_day_sonnet: t('每周 · Sonnet'),
    seven_day_fable: t('每周 · Fable'), seven_day_oauth_apps: t('每周 · 连接的应用'),
    weekly: t('每周'), opus_weekly: t('每周 · Opus'), sonnet_weekly: t('每周 · Sonnet'),
  };
  const HIDDEN = new Set(['overage']);
  const label = (r) => r.label ? t('每周 · {label}', { label: tr(r.label) }) : (LABELS[r.key] || t('额度 · {key}', { key: String(r.key).replace(/_/g, ' ') }));
  // 桶排序照官方：5 小时 → 每周全模型 → 各模型周桶 → 其余。
  const ORDER = ['five_hour', 'seven_day'];
  const rank = (r) => { const i = ORDER.indexOf(r.key); return i < 0 ? 10 : i; };
  // 同一桶两个来源（SDK usage 的 model_scoped 带 label "Fable" / 事件的 seven_day_overage_included）只留一行：
  // 有服务端标好名的 model_ 桶就藏掉事件桶。
  function dedupe(list) {
    const hasModelFable = list.some((r) => r.key.startsWith('model_') && /fable/i.test(r.label || ''));
    return list.filter((r) => !HIDDEN.has(r.key) && !(hasModelFable && r.key === 'seven_day_overage_included'));
  }
  // 逐桶的取数时刻：比弹层整体的 updatedAt 老 1 小时以上就单独标出来——五小时桶每帧都刷，
  // Fable 周桶只在事件带上它时才刷，两边不同步时别让人以为都是「刚刚」。
  const STALE_MS = 3600_000;
  const rowStale = (r) => (r.at && status.updatedAt && status.updatedAt - r.at > STALE_MS ? r.at : null);

  async function refresh() {
    if (me.kind === 'none') return;   // 没登录（单 agent 模式下登录框压在 Claude 页上）：不白撞 401
    try {
      const d = await api.status(session.id);   // 带上正看的会话 → 后端回它自己的 context 填充
      status.limits = d.limits || null;
      status.context = d.context || null;
      if (d.context && d.context.sessionId) status.contexts[d.context.sessionId] = d.context;
      // 上下文分布 / 实际生效 effort（/api/status 随会话回）：刷新页面、换设备打开旧会话时恢复。
      if (session.id && d.contextUsage && d.contextUsage.max) status.usages[session.id] = d.contextUsage;
      if (session.id && d.effort && typeof d.effort === 'object') status.efforts[session.id] = { level: d.effort.level || null, at: d.effort.at || Date.now() };
      if ('plan' in d) status.plan = d.plan || null;
      status.updatedAt = d.updatedAt || Date.now();
    } catch {}
  }
  // 后台标签页不空转轮询（省电省流量），回前台立即刷一次补上。
  onMount(() => {
    refresh();
    const iv = setInterval(() => { if (!document.hidden) refresh(); }, 30000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  });

  const rows = $derived(dedupe(Object.entries(status.limits || {}).map(([key, v]) => ({ key, ...v }))).sort((a, b) => rank(a) - rank(b)));
  // 套餐名（"Max (20x)"）：/api/status 的 plan 字段有就摆进标题（官方「Plan usage limits · Max (20x)」）。
  const planLabel = $derived(status.plan ? ' · ' + status.plan : '');
  // 正看会话自己的上下文数据；旧 status.context 恰好属于本会话时兜底（多对话并发防串台）。
  const usage = $derived(session.id ? (status.usages[session.id] || null) : null);
  const ctxRow = $derived(session.id
    ? (status.contexts[session.id] || (status.context && status.context.sessionId === session.id ? status.context : null))
    : null);
  const ctx = $derived.by(() => {
    if (usage) return ctxSummary(usage.total, usage.max);
    if (ctxRow) return ctxSummary(ctxRow.used, ctxRow.total);
    return null;
  });
  const hasCtx = $derived(!!ctx);
  const tightest = $derived(rows.filter((r) => r.pct != null).sort((a, b) => b.pct - a.pct)[0] || null);
  const planPeak = $derived(tightest ? Math.round(tightest.pct) : null);
  // 官方 uI：有上下文数据 → 环画上下文占比；否则画额度桶峰值；都没有 → 空环。
  const pct = $derived(hasCtx ? (ctx.pct ?? 100) : (planPeak ?? 0));
  const level = $derived(ctxLevel(pct));
  const stale = $derived(usage && !session.busy && Date.now() - (usage.at || 0) > 300_000 ? usage.at : null);

  // 官方 eI：size 16 → r 7、周长 2πr、描边 2。
  const R = 7, C = 2 * Math.PI * R;
</script>

<div class="qr-wrap">
  <button class="qr-btn" bind:this={ringBtn} aria-label={[t('用量'), hasCtx ? 'Context ' + ctx.summary : '', planPeak != null ? 'Plan ' + planPeak + '%' : ''].filter(Boolean).join(' · ')} title={t('查看用量')} onclick={toggle}>
    <svg viewBox="0 0 16 16" class="qr {level}" aria-hidden="true">
      <circle cx="8" cy="8" r={R} class="track" />
      <circle cx="8" cy="8" r={R} class="arc" stroke-dasharray={C} stroke-dashoffset={C * (1 - Math.max(0, Math.min(100, pct)) / 100)} />
    </svg>
  </button>

  {#if open}
    <button class="qb-backdrop" aria-label={t('关闭')} onclick={() => (open = false)}></button>
    <!-- 左锚弹层：clampX 必须显式 anchor:'left'（见 clampx.js 顶部的坑） -->
    <div class="qb-panel" class:down={dir === 'down'} use:clampX={{ anchor: 'left' }}>
      <!-- Context window：只认「正看的这个会话」自己的数据；greeting 空态不摆底噪。
           官方：有分布时计量条常显，展开（›）只是多出图例与小节；没分布只有粗填充时是一根 4px 条。 -->
      <div class="qb-sec">
        <button class="qb-h" aria-expanded={usage ? expanded : undefined} disabled={!usage} onclick={() => (expanded = !expanded)}>
          <span class="qb-k">Context window</span>
          {#if hasCtx}<span class="qb-v">{ctx.summary}</span>{/if}
          {#if usage}<span class="qb-car" class:on={expanded}><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2l3 3-3 3"/></svg></span>{/if}
        </button>
        <div class="qb-body">
          {#if !hasCtx}
            <div class="qb-note">{t('发一条消息后显示上下文用量')}</div>
          {:else if usage}
            <ContextBreakdown {usage} compact={true} legend={expanded} />
          {:else}
            <div class="qb-bar" role="progressbar" aria-valuenow={ctx.pct ?? 0} aria-valuemin="0" aria-valuemax="100"><span class="qb-fill {level}" style="width:{Math.min(100, ctx.pct ?? 100)}%"></span></div>
          {/if}
        </div>
        {#if stale}<div class="qb-note">{t('更新于 {time} · 发消息后刷新', { time: relTime(stale) })}</div>{/if}
      </div>
      <div class="qb-div"></div>
      <!-- 官方「Plan usage limits · Max (20x)」+ 每桶：名字 / 重置时刻 + 百分比 / 4px 条 -->
      <div class="qb-sec">
        <div class="qb-h static"><span class="qb-k">Plan usage limits{planLabel}</span>{#if rows.length && status.updatedAt}<span class="qb-v">{relTime(status.updatedAt)}</span>{/if}</div>
        <div class="qb-body plan">
          {#if rows.length}
            {#each rows as r (r.key)}
              <div class="qb-row">
                <span class="qb-lbl">{label(r)}{#if rowStale(r)}<span class="qb-old"> · {t('更新于 {time}', { time: relTime(rowStale(r)) })}</span>{/if}</span>
                <span class="qb-v"><span class="qb-rs">{r.resetsAt ? fmtResetAt(r.resetsAt) : ''}</span><span class="qb-pct">{Math.round(r.pct || 0)}%</span></span>
                <span class="qb-bar"><span class="qb-fill {ctxLevel(r.pct || 0)}" style="width:{Math.min(100, r.pct || 0)}%"></span></span>
              </div>
            {/each}
          {:else}
            <div class="qb-note">{t('暂无额度数据')}</div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .qr-wrap { position: relative; display: flex; }
  .qr-btn { width: 38px; height: 38px; border-radius: 10px; display: flex; align-items: center; justify-content: center; }
  .qr-btn:active { background: var(--hover); }
  @media (hover: hover) { .qr-btn:hover { background: var(--hover); } }
  .qr { width: 16px; height: 16px; transform: rotate(-90deg); }
  .qr .track { fill: none; stroke: var(--divider); stroke-width: 2; }
  .qr .arc { fill: none; stroke: var(--coral); stroke-width: 2; stroke-linecap: round; transition: stroke-dashoffset .3s ease; }
  .qr.warning .arc { stroke: var(--warn); }
  .qr.critical .arc { stroke: var(--crit); }

  .qb-backdrop { position: fixed; inset: 0; z-index: 60; }
  /* 官方 Popup：w-360 / max-w calc(100vw-2rem) / padding none / 内层 py-sm；环在输入栏工具条
     【左侧】，面板从左边缘展开（沿用 right:0 会整块推到屏幕外） */
  .qb-panel {
    position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 61;
    width: min(360px, 100vw - 16px); padding: 8px 0;
    max-height: min(640px, 80vh); overflow-y: auto; overscroll-behavior: contain;
    background: var(--q-card); border-radius: 16px; box-shadow: var(--q-shadow);
  }
  .qb-panel.down { bottom: auto; top: calc(100% + 8px); }
  .qb-sec { display: flex; flex-direction: column; }
  /* 官方行：px-lg(16) py-xs(4) min-h 20，footnote 12px */
  .qb-h { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 20px; padding: 4px 16px; text-align: left; border-radius: 6px; }
  .qb-h:disabled { cursor: default; }
  .qb-h.static { cursor: default; }
  .qb-k { font-size: 12px; color: var(--muted); }
  .qb-v { margin-left: auto; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .qb-car { flex: none; width: 10px; height: 10px; display: flex; align-items: center; justify-content: center; color: var(--muted); }
  .qb-car svg { width: 10px; height: 10px; transition: transform var(--mo-micro, .12s) var(--ea-std, ease); }
  .qb-car.on svg { transform: rotate(90deg); }
  .qb-body { padding: 4px 16px 4px; }
  .qb-body.plan { display: flex; flex-direction: column; gap: 8px; }
  .qb-note { padding: 2px 16px 4px; font-size: 12px; color: var(--serif); }
  .qb-bar { display: block; height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--muted) 18%, transparent); overflow: hidden; }
  .qb-fill { display: block; height: 100%; background: var(--coral); border-radius: 999px; transition: width .3s ease; }
  .qb-fill.warning { background: var(--warn); } .qb-fill.critical { background: var(--crit); }
  .qb-row { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 4px 8px; }
  .qb-row .qb-bar { grid-column: 1 / -1; }
  .qb-lbl { font-size: 12px; color: var(--text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .qb-old { color: var(--muted); font-size: 11px; }
  .qb-rs { color: var(--muted); }
  .qb-pct { color: var(--text); margin-left: 6px; }
  .qb-div { height: 1px; background: var(--divider); margin: 4px 16px; }
</style>
