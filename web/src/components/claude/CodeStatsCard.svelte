<script module>
  // 新对话空态的用量卡 = Claude 桌面端 /code 落地页「概览 / 模型」卡原件（ion-dist ca80fca8d：
  // 外壳 vW/oW、分段签 hW+shared-10 Tabs、六格 yW/SW、热力图 CW、彩蛋句 xW/bW、模型页 jW、
  // 堆叠柱 MW/kW/AW、提示 PW；取数口径见服务端 runtime/code-stats.mjs）。尺寸与配色是把官方 CSS
  // 原样起在本机、套源码 class 量出来的 computed 值（暗/亮各一套），不是目测。
  //
  // 数据跨挂载缓存（官方 react-query staleTime 5 分钟、gcTime ∞）：回到空态先给上次的结果，
  // 过期才后台再拉一次，卡片不会每次都从骨架闪起。
  import { api } from '../../lib/api.js';
  import { me } from '../../lib/state.svelte.js';

  const STALE_MS = 5 * 60 * 1000;
  const FAIL_QUIET_MS = 60 * 1000;   // 失败后这段时间内挂载不再自动拉，交给「重试」按钮
  const store = $state({ stats: null, at: 0, failed: false, loading: false });
  let failedAt = 0;                  // 不进响应式：只给自动拉取做冷却判断
  let owner = null;                  // 缓存属于哪个身份（kind:user，同 ClaudePage 的 who）
  let gen = 0;                       // 换了身份就 +1：旧身份晚到的回包丢掉
  const whoNow = () => (me.kind === 'none' ? '' : me.kind + ':' + (me.user || ''));

  // 挂载时（非 force）调用：失败不自动重试——401（单页模式未登录停在落地页）/ 403（快照、客户端身份）/
  // 500 / 断网都会失败，以前 effect 依赖了这里读写的 store，失败后 loading 复位就重跑，假后端 3 分钟打了 2.2 万次。
  // 身份变了（登录框里登上、退出、换号）旧数据和冷却一起作废：不然登录前那次 401 会让卡片停在「重试」，
  // 换号后 5 分钟内还显示上一个账号的用量。
  export function loadCodeStats(force = false) {
    const who = whoNow();
    if (who !== owner) {
      owner = who; gen++; failedAt = 0;
      store.stats = null; store.at = 0; store.failed = false; store.loading = false;
    }
    if (store.loading) return;
    if (!force && store.stats && Date.now() - store.at < STALE_MS) return;
    if (!force && store.failed && Date.now() - failedAt < FAIL_QUIET_MS) return;
    const g = gen;
    store.loading = true;
    store.failed = false;
    const fail = () => { failedAt = Date.now(); if (!store.stats) store.failed = true; };
    api.get('/api/claude/code-stats' + (force ? '?force=1' : ''))
      .then((s) => {
        if (g !== gen) return;
        if (s && Array.isArray(s.dailyActivity)) { store.stats = s; store.at = Date.now(); } else fail();
      })
      .catch(() => { if (g === gen) fail(); })
      .finally(() => { if (g === gen) store.loading = false; });
  }
</script>

<script>
  import { untrack } from 'svelte';
  import { t, tc, locale } from '../../lib/i18n.js';
  import { modelLabel } from '../../lib/toolVerbs.js';

  const RANGE_DAYS = { all: null, '30d': 30, '7d': 7 };
  const HUE = 217;
  const MODEL_ROWS = 6;            // 官方 wW：多于 6 个模型时折叠
  const HEAT_DAYS = 182;           // 26 周
  // 官方 bW：按 token 量找一本「你用掉的 token 抵得上几本」的书（书名照官方用英文原名）
  const BOOKS = [
    { name: 'The Little Prince', tokens: 22e3 },
    { name: 'Animal Farm', tokens: 39e3 },
    { name: 'The Great Gatsby', tokens: 62e3 },
    { name: "Harry Potter and the Philosopher's Stone", tokens: 103e3 },
    { name: 'The Hobbit', tokens: 123e3 },
    { name: 'Pride and Prejudice', tokens: 156e3 },
    { name: 'Dune', tokens: 244e3 },
    { name: 'Moby-Dick', tokens: 268e3 },
    { name: 'The Lord of the Rings', tokens: 576e3 },
    { name: 'War and Peace', tokens: 73e4 },
  ];

  let tab = $state('overview');
  let range = $state('all');
  const pick = Math.random();      // 官方 useState(Math.random)：一次挂载选定一本，切范围不换

  // 挂载时拉一次，之后只跟登录身份（登录 / 退出 / 换号才变，不会自转）：loadCodeStats 同步读写 store，
  // 不隔开的话 effect 会依赖上它，失败后 loading 复位就无限重拉
  $effect(() => { me.kind; me.user; untrack(() => loadCodeStats()); });

  const loc = locale();
  const nf = new Intl.NumberFormat(loc);
  const fmtDay = new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const fmtHour = new Intl.DateTimeFormat(loc, { hour: 'numeric' });

  const pad2 = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const dayLabel = (k) => fmtDay.format(new Date(`${k}T00:00:00Z`));
  // 官方 shared-8 xF：1.2k / 3.4M / 65.4B，整数去掉 .0
  function fd(n) {
    const trim = (s) => (s.endsWith('.0') ? s.slice(0, -2) : s);
    if (n >= 1e9) return trim((n / 1e9).toFixed(1)) + 'B';
    if (n >= 1e6) { const v = Number((n / 1e6).toFixed(1)); return v >= 1e3 ? trim((n / 1e9).toFixed(1)) + 'B' : trim(v.toFixed(1)) + 'M'; }
    if (n >= 1e3) { const v = Number((n / 1e3).toFixed(1)); return v >= 1e3 ? trim((n / 1e6).toFixed(1)) + 'M' : trim(v.toFixed(1)) + 'k'; }
    return String(n);
  }
  const modelColor = (i) => `hsl(${HUE} 70% ${Math.min(88, 58 + i * 7)}%)`;

  const stats = $derived(store.stats);
  const today = $derived.by(() => { void store.at; return keyOf(new Date()); });

  // 官方 aW：按范围汇总（热力图与高峰时段不随范围变，照官方）
  const ranged = $derived.by(() => {
    const s = stats;
    if (!s) return null;
    const days = RANGE_DAYS[range];
    let from = null;
    if (days) { const d = parseKey(today); d.setDate(d.getDate() - (days - 1)); from = keyOf(d); }
    const inRange = (k) => !from || k >= from;
    let sessions = 0, messages = 0;
    for (const d of s.dailyActivity) if (inRange(d.date)) { sessions += d.sessionCount || 0; messages += d.messageCount || 0; }
    const chartDays = s.dailyModelTokens.filter((d) => inRange(d.date));
    const per = new Map();
    for (const d of chartDays) for (const [m, n] of Object.entries(d.tokensByModel)) per.set(m, (per.get(m) || 0) + n);
    const all = [...per.entries()].map(([model, tokens]) => ({
      model, tokens,
      usage: s.modelUsage[model] || { inputTokens: 0, outputTokens: 0 },
    })).sort((a, b) => b.tokens - a.tokens);
    const total = all.reduce((a, m) => a + m.tokens, 0);
    const modelTotals = all.filter((m) => m.tokens >= total * 5e-4);
    return {
      sessions, messages, total, chartDays, modelTotals,
      activeDays: s.dailyActivity.filter((d) => inRange(d.date)).length,
      modelKeys: modelTotals.map((m) => m.model),
    };
  });

  const peakHour = $derived(stats && stats.peakActivityHour != null ? fmtHour.format(new Date(2000, 0, 1, stats.peakActivityHour)) : '—');
  const favModel = $derived(ranged?.modelTotals[0] ? modelLabel(ranged.modelTotals[0].model) : '—');
  const tiles = $derived(ranged ? [
    { label: t('会话'), value: nf.format(ranged.sessions) },
    { label: t('消息'), value: nf.format(ranged.messages) },
    { label: t('Token 总数'), value: fd(ranged.total) },
    { label: t('活跃天数'), value: String(ranged.activeDays) },
    { label: t('高峰时段'), value: peakHour },
    { label: t('收藏的模型'), value: favModel, small: true },
  ] : []);

  // 官方 CW：截至本周六的 26 周，每列一周（周日在上）；颜色按当天消息数 / 最大值分四档
  const heat = $derived.by(() => {
    if (!stats) return [];
    const counts = new Map(stats.dailyActivity.map((d) => [d.date, d.messageCount || 0]));
    const end = parseKey(today);
    end.setDate(end.getDate() + (6 - end.getDay()));
    const start = new Date(end);
    start.setDate(end.getDate() - HEAT_DAYS + 1);
    const cells = [];
    let max = 0;
    for (let i = 0; i < HEAT_DAYS; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const k = keyOf(d);
      const c = counts.get(k) ?? 0;
      max = Math.max(max, c);
      cells.push({ date: k, count: c, future: k > today });
    }
    for (const c of cells) {
      const r = max === 0 ? 0 : c.count / max;
      c.color = r === 0 ? null : `hsl(${HUE} 70% ${80 - Math.ceil(r * 4) * 8}%)`;
    }
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  });

  const book = $derived.by(() => {
    if (!ranged) return null;
    const ok = BOOKS.filter((b) => ranged.total >= b.tokens);
    if (!ok.length) return null;
    const b = ok[Math.floor(pick * ok.length)];
    return { name: b.name, times: Math.floor(ranged.total / b.tokens) };
  });

  // —— 模型页 ——
  let showAll = $state(false);
  const modelRows = $derived(ranged ? (showAll ? ranged.modelTotals : ranged.modelTotals.slice(0, MODEL_ROWS)) : []);
  const hiddenRows = $derived(ranged ? ranged.modelTotals.length - modelRows.length : 0);

  // 官方 kW：≤6 格、步长取 1/2/5×10^n，总高最贴合、并列时取最接近 4 格的
  function ticksFor(max) {
    if (max <= 0) return [];
    const mag = 10 ** Math.floor(Math.log10(max / 6));
    const best = [1, 2, 5, 10, 20, 50]
      .map((m) => { const step = Math.max(1, m * mag); return { step, steps: Math.ceil(max / step) }; })
      .filter((o) => o.steps <= 6)
      .reduce((a, b) => {
        const nb = b.step * b.steps, na = a.step * a.steps;
        return nb < na || (nb === na && Math.abs(b.steps - 4) < Math.abs(a.steps - 4)) ? b : a;
      });
    return Array.from({ length: best.steps + 1 }, (_, i) => i * best.step);
  }
  // 官方 AW：每天按模型顺序（=颜色序）堆叠
  const chart = $derived.by(() => {
    if (!ranged) return { days: [], ticks: [] };
    let max = 0;
    const days = ranged.chartDays.map((d) => {
      let sum = 0;
      const segments = [];
      ranged.modelKeys.forEach((m, i) => {
        const n = d.tokensByModel[m] ?? 0;
        if (n > 0) { segments.push({ model: m, tokens: n, color: modelColor(i) }); sum += n; }
      });
      max = Math.max(max, sum);
      return { date: d.date, segments };
    });
    return { days, ticks: ticksFor(max) };
  });
  const top = $derived(chart.ticks.at(-1) || 1);
  // 官方 NW：横轴标签按「最宽日期标签 + 8px」能摆几个来抽稀
  let barsW = $state(0);
  let probeW = $state(0);
  const every = $derived(Math.max(1, Math.ceil(chart.days.length / Math.max(2, Math.floor(barsW / (probeW + 8 || 1))))));

  // —— 悬停提示（官方 Tooltip：热力图「日期 — 条数」、柱子「日期 + 各模型 token」）——
  let tip = $state(null);
  function showTip(e, content) {
    if (e.pointerType === 'touch') return;
    const r = e.currentTarget.getBoundingClientRect();
    tip = { x: r.left + r.width / 2, y: r.top, content };
  }
  const hideTip = () => { tip = null; };
</script>

{#if stats && ranged}
  <div class="cs" data-testid="code-stats-card" role="group" aria-label={t('用量统计')}>
    <div class="head">
      <div class="seg" role="tablist" aria-label={t('统计视图')}>
        {#each [['overview', t('概览')], ['models', tc('用量卡', '模型')]] as [v, label]}
          <button type="button" role="tab" class="tab" class:on={tab === v} aria-selected={tab === v} onclick={() => { tab = v; }}>
            <span>{label}</span>
          </button>
        {/each}
      </div>
      <span class="grow"></span>
      <div class="seg" role="tablist" aria-label={t('日期范围')}>
        {#each [['all', t('全部')], ['30d', t('30 天')], ['7d', t('7 天')]] as [v, label]}
          <button type="button" role="tab" class="tab" class:on={range === v} aria-selected={range === v} onclick={() => { range = v; }}>
            <span>{label}</span>
          </button>
        {/each}
      </div>
    </div>

    {#if tab === 'overview'}
      <div class="ov">
        <div class="grid">
          {#each tiles as tl}
            <div class="tile">
              <span class="tl">{tl.label}</span>
              <span class="tv" class:small={tl.small}>{tl.value}</span>
            </div>
          {/each}
        </div>
        <div class="heat" role="img" aria-label={t('每日活跃热力图')} onpointerleave={hideTip}>
          {#each heat as week}
            <div class="wk">
              {#each week as c (c.date)}
                {#if c.future}
                  <div class="cell future"></div>
                {:else}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div class="cell" style:background-color={c.color}
                    onpointerenter={(e) => showTip(e, { kind: 'heat', text: `${dayLabel(c.date)} — ${nf.format(c.count)}` })}></div>
                {/if}
              {/each}
            </div>
          {/each}
        </div>
        {#if book}
          <span class="fun">{book.times >= 2
            ? t('您使用的 token 数约为《{book}》的 {times} 倍。', { book: book.name, times: book.times })
            : t('您使用的 token 数与《{book}》相当。', { book: book.name })}</span>
        {/if}
      </div>
    {:else}
      <div class="md">
        <div class="chart" role="img" aria-label={t('每日各模型 token 用量')}>
          <div class="yax" aria-hidden="true">
            {#each chart.ticks as tk (tk)}<span>{fd(tk)}</span>{/each}
          </div>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="bars" bind:clientWidth={barsW} onpointerleave={hideTip}>
            {#each chart.days as d (d.date)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="day" onpointerenter={(e) => showTip(e, { kind: 'day', day: d })}>
                {#each d.segments as sg (sg.model)}
                  <div class="sg" style:height="{(sg.tokens / top) * 100}%" style:background-color={sg.color}></div>
                {/each}
              </div>
            {/each}
          </div>
          <div class="xax" aria-hidden="true">
            <span class="probe"><span bind:clientWidth={probeW}>{dayLabel('2000-09-30')}</span></span>
            {#each chart.days as d, i (d.date)}<span class="xl">{i % every === 0 ? dayLabel(d.date) : ''}</span>{/each}
          </div>
        </div>
        <div class="rows">
          {#each modelRows as m, i (m.model)}
            <div class="mrow">
              <span class="sw" style:background-color={modelColor(i)} aria-hidden="true"></span>
              <span class="mn">{modelLabel(m.model)}</span>
              <span class="mio">{t('{inTokens} 输入 · {outTokens} 输出', { inTokens: fd(m.usage.inputTokens || 0), outTokens: fd(m.usage.outputTokens || 0) })}</span>
              <span class="pct">{((m.tokens / (ranged.total || 1)) * 100).toFixed(1)}%</span>
            </div>
          {/each}
          {#if !ranged.modelTotals.length}
            <span class="none">{t('这段时间没有模型用量')}</span>
          {/if}
          {#if ranged.modelTotals.length > MODEL_ROWS}
            <button type="button" class="more" aria-expanded={showAll} onclick={() => { showAll = !showAll; }}>
              {showAll ? tc('用量卡', '收起') : t('再显示 {count} 个', { count: hiddenRows })}
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{:else if store.failed}
  <div class="cs fail">
    <span>{t('无法加载用量统计')}</span>
    <button type="button" class="retry" onclick={() => loadCodeStats(true)}>{t('重试')}</button>
  </div>
{:else}
  <!-- 官方 gW：骨架（分段签半透明 + 六格 44px + 120px 热力图 + 一行字） -->
  <div class="cs skel" aria-busy="true">
    <div class="head dim">
      <div class="seg"><span class="tab on"><span>{t('概览')}</span></span><span class="tab"><span>{tc('用量卡', '模型')}</span></span></div>
      <span class="grow"></span>
      <div class="seg"><span class="tab on"><span>{t('全部')}</span></span><span class="tab"><span>{t('30 天')}</span></span><span class="tab"><span>{t('7 天')}</span></span></div>
    </div>
    <div class="ov">
      <div class="grid">{#each Array(6) as _}<div class="sk" style="height:44px;border-radius:6px"></div>{/each}</div>
      <div class="sk" style="height:120px;border-radius:2px"></div>
      <div class="sk" style="height:12px;width:240px;max-width:100%;border-radius:4px;margin-top:4px"></div>
    </div>
  </div>
{/if}

{#if tip}
  <div class="cs-tip" style:left="{tip.x}px" style:top="{tip.y}px" role="tooltip">
    {#if tip.content.kind === 'heat'}
      {tip.content.text}
    {:else}
      <span class="tt-day">{dayLabel(tip.content.day.date)}</span>
      {#each tip.content.day.segments as sg (sg.model)}
        <span class="tt-row"><span class="dot" style:background-color={sg.color}></span>{t('{model}：{tokens}', { model: modelLabel(sg.model), tokens: fd(sg.tokens) })}</span>
      {/each}
    {/if}
  </div>
{/if}

<style>
  /* 官方 computed（comfortable 密度，暗色）：卡 bg 白 5%、圆角 8、内边距 8/12/12、纵向间距 20、最宽 480；
     格子/热力图底 白 10%、圆角 5（格）/2（热力格）；分段签高 28、左右 10、14px/500，选中底 白 7.5%、圆角 7；
     格子标签 13/17 muted，数值 14/20 半粗（wght 540），小号 13/17；彩蛋句 12/17 muted、上 4。 */
  .cs {
    --cs-fill: rgba(255, 255, 255, .05);
    --cs-tile: rgba(255, 255, 255, .10);
    --cs-ghost: rgba(255, 255, 255, .075);
    --cs-sec: #c3c2b7;
    --cs-muted: var(--muted);
    display: flex; flex-direction: column; gap: 20px; width: 100%; max-width: 480px; box-sizing: border-box;
    padding: 8px 12px 12px; border-radius: 8px; background: var(--cs-fill); color: var(--text);
    font-family: var(--sans); font-size: 14px; line-height: 20px; text-align: left;
  }
  :global(html[data-theme="light"]) .cs {
    --cs-fill: rgba(11, 11, 11, .05); --cs-tile: rgba(11, 11, 11, .10); --cs-ghost: rgba(11, 11, 11, .05); --cs-sec: #52514e;
  }
  .head { display: flex; align-items: center; gap: 5px; min-width: 0; }
  .head.dim { opacity: .5; }
  .grow { flex: 1; }
  .seg { display: flex; align-items: center; }
  .tab {
    position: relative; isolation: isolate; display: inline-flex; flex: none; align-items: center; justify-content: center;
    height: 28px; padding: 0 10px; margin: 0; border: 0; border-radius: 0; background: transparent; cursor: pointer;
    font: inherit; font-size: 14px; line-height: 20px; font-weight: 500; white-space: nowrap; user-select: none;
    color: var(--cs-muted); outline: none; -webkit-tap-highlight-color: transparent;
    transition: color var(--mo-quick, .2s) var(--ea-fade, ease);
  }
  /* 官方：底色是 ::before（inset-y-0 inset-x-px，首尾两颗贴边），选中常亮、未选中悬停才亮 */
  .tab::before { content: ''; position: absolute; top: 0; bottom: 0; left: 1px; right: 1px; border-radius: 7px; z-index: -1; transition: box-shadow .15s ease; }
  .tab:first-child::before { left: 0; }
  .tab:last-child::before { right: 0; }
  .tab.on { color: var(--text); }
  .tab.on::before { background: var(--cs-ghost); }
  @media (hover: hover) {
    .tab:not(.on):hover { color: var(--cs-sec); }
    .tab:not(.on):hover::before { background: var(--cs-ghost); }
  }
  .tab:focus-visible::before { box-shadow: 0 0 0 2px color-mix(in srgb, var(--text) 35%, transparent); }
  .tab span { position: relative; }

  .ov { display: flex; flex-direction: column; gap: 8px; }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
  .tile { display: flex; flex-direction: column; gap: 2px; padding: 6px; border-radius: 5px; background: var(--cs-tile); min-width: 0; }
  .tl, .tv { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl { font-size: 13px; line-height: 17px; color: var(--cs-muted); }
  .tv { font-size: 14px; line-height: 20px; font-weight: 580; font-variant-numeric: tabular-nums; color: var(--text); }
  .tv.small { font-size: 13px; line-height: 17px; font-weight: 400; margin-top: 1px; margin-bottom: 2px; }

  .heat { display: flex; gap: 3px; width: 100%; }
  .wk { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
  .cell { aspect-ratio: 1; border-radius: 2px; background: var(--cs-tile); }
  .cell.future { background: transparent; }
  .fun { font-size: 12px; line-height: 17px; color: var(--cs-muted); padding-top: 4px; }

  .md { display: flex; flex-direction: column; gap: 5px; }
  .chart {
    display: grid; height: 160px; box-sizing: border-box; grid-template-columns: auto minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto;
    column-gap: 11px; row-gap: 16px; padding: 8px 10px 5px 3px; font-size: 12px; line-height: 1; color: var(--cs-sec);
  }
  .yax { display: flex; flex-direction: column-reverse; align-items: flex-end; justify-content: space-between; }
  .yax span { display: flex; height: 0; align-items: center; white-space: nowrap; }
  .bars { display: flex; min-height: 0; min-width: 0; }
  .day { display: flex; flex: 1; min-width: 0; height: 100%; flex-direction: column-reverse; align-items: center; }
  .sg { width: 72%; flex: none; }
  .sg:last-child { border-radius: 2px 2px 0 0; }
  @media (hover: hover) { .day:hover .sg { filter: brightness(.9); } }
  .xax { grid-column-start: 2; display: flex; min-width: 0; }
  .probe { visibility: hidden; width: 0; flex: none; overflow: visible; }
  .probe span { display: inline-block; white-space: nowrap; }   /* 行内盒 clientWidth 恒 0，量不到宽 */
  .xl { display: flex; flex: 1; min-width: 0; justify-content: center; white-space: nowrap; }
  .rows { display: flex; flex-direction: column; gap: 3px; }
  .mrow { display: flex; align-items: center; gap: 4px; font-size: 13px; line-height: 17px; }
  .sw { width: 8px; height: 8px; border-radius: 2px; flex: none; }
  .mn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
  .mio { flex: none; color: var(--cs-muted); font-variant-numeric: tabular-nums; }
  .pct { flex: none; width: 56px; text-align: right; color: var(--text); font-variant-numeric: tabular-nums; }
  .none { font-size: 13px; line-height: 17px; color: var(--cs-muted); }
  .more { align-self: flex-start; padding: 0; border: 0; background: none; cursor: pointer; font: inherit; font-size: 13px; line-height: 17px; color: var(--cs-muted); transition: color .2s ease; }
  @media (hover: hover) { .more:hover { color: var(--text); } }

  .fail { flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; }
  .retry { flex: none; height: 28px; padding: 0 10px; border: 0; border-radius: 7px; cursor: pointer; font: inherit; font-size: 13px;
    background: var(--cs-tile); color: var(--text); transition: background-color .15s ease; }
  @media (hover: hover) { .retry:hover { color: var(--cs-sec); } }

  .sk { background: var(--cs-tile); animation: cs-pulse 1.6s ease-in-out infinite; }
  @keyframes cs-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }

  .cs-tip {
    position: fixed; z-index: 1000; transform: translate(-50%, calc(-100% - 6px)); pointer-events: none;
    display: flex; flex-direction: column; gap: 3px; max-width: 260px; padding: 5px 8px; border-radius: 6px;
    background: var(--q-card); box-shadow: var(--q-shadow); color: var(--text);
    font-family: var(--sans); font-size: 13px; line-height: 17px; white-space: nowrap; font-variant-numeric: tabular-nums;
  }
  .tt-day { font-weight: 600; }
  .tt-row { display: flex; align-items: center; gap: 4px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
</style>
