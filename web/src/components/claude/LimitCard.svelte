<script>
  // 限额卡——官方 Claude Code Desktop 2.42304 /code 页撞限额时的时间线告警卡（cb1a6e506 的告警卡 +
  // c96d752d0 的限额分支），2026-10-20 照原件移植：
  //   头行（5% 底）：用量仪表图标（UsageGaugeHigh，text-danger）+ 标题「Session limit reached」/「Weekly limit
  //   reached」/「{model} limit reached」；正文：重置时刻那句（勾着自动继续时换成「Auto-resuming at {time}」）+
  //   勾选框「Auto-continue when limits reset」（只有 5 小时限额、且是会话最后一条时才有）；底栏：View details
  //   （CLI 原话）+ Try again。
  // 吃 m.limit = { type, resetsAt(ms), text }；自动续跑状态在 chat 内核 limitResume（服务端 limit-resume.mjs 持有）。
  import { session } from '../../lib/state.svelte.js';
  import { limitResume, fetchLimitResume, setLimitAutoContinue } from '../../lib/chat.svelte.js';
  import { t, tc, isEn, locale } from '../../lib/i18n.js';
  import { ovData } from '../../lib/overlay.svelte.js';

  let { m, last = false, sid = '', onRetry } = $props();

  const lim = $derived(m.limit || {});
  const MODEL_OF = { seven_day_opus: 'Opus', seven_day_sonnet: 'Sonnet', seven_day_overage_included: 'Fable' };
  const kind = $derived(lim.type === 'five_hour' ? 'session' : lim.type === 'seven_day' ? 'weekly' : MODEL_OF[lim.type] ? 'model' : 'generic');
  const model = $derived(MODEL_OF[lim.type] || '');

  // 重置时刻一过，提示要跟着变——只有末条卡片需要走表
  let now = $state(Date.now());
  $effect(() => {
    if (!last) return;
    const id = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(id);
  });

  const st = $derived(sid ? limitResume.bySession[sid] : undefined);
  // 历史里重开的会话：卡片挂上时问一次服务端还有没有在等的续跑
  $effect(() => {
    if (last && sid && lim.type === 'five_hour' && st === undefined) fetchLimitResume(sid);
  });

  // 「几点」：当天只说时刻，跨天带星期（官方 sessionAt / sessionOn 两套句式）。英文把介词一起拼进去。
  function when(ms) {
    const d = new Date(ms);
    const time = d.toLocaleTimeString(locale(), isEn() ? { hour: 'numeric', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', hour12: false });
    const sameDay = d.toDateString() === new Date(now).toDateString();
    if (sameDay) return isEn() ? 'at ' + time : time;
    const day = d.toLocaleDateString(locale(), { weekday: isEn() ? 'long' : 'short' });
    return isEn() ? day + ' at ' + time : day + ' ' + time;
  }

  const headline = $derived(kind === 'session' ? t('已达到 5 小时限额')
    : kind === 'weekly' ? t('已达到每周限额')
      : kind === 'model' ? t('已达到 {model} 限额', { model })
        : t('已达到用量限额'));

  const canRetry = $derived(last && !session.busy && typeof onRetry === 'function');
  const showToggle = $derived(last && !session.busy && lim.type === 'five_hour' && !!st && !!st.type
    && st.attempt < 3 && st.resetsAt + 6 * 3600_000 > now);
  const armed = $derived(showToggle && !!st.armed);

  const hint = $derived.by(() => {
    if (last && st && st.firing) return t('限额已重置，正在继续会话…');
    if (armed && st.fireAt) return t('将于 {when} 自动继续', { when: when(st.fireAt) });
    const r = lim.resetsAt || 0;
    if (r && r <= now) return t('限额已重置，可以继续了。');
    if (!r) return kind === 'model' ? t('换个模型继续，或等 {model} 限额重置。', { model }) : t('等限额重置后再试。');
    const w = when(r);
    if (kind === 'session') return t('5 小时限额将于 {when} 重置，届时再试。', { when: w });
    if (kind === 'weekly') return t('每周限额将于 {when} 重置，届时再试。', { when: w });
    if (kind === 'model') return t('换个模型继续，或等到 {when} {model} 限额重置。', { when: w, model });
    return t('用量限额将于 {when} 重置，届时再试。', { when: w });
  });

  const details = $derived(String(lim.text || '').trim());
  let open = $state(false);
  let copied = $state(false);
  async function copy() {
    try { await navigator.clipboard.writeText(details); copied = true; setTimeout(() => { copied = false; }, 1400); } catch {}
  }

  // 用量仪表图标：公开版用 Lucide 的 gauge（ISC，描边）；维护者的私有 overlay 在清单 data.glyphs.usageGauge 里带了
  // 原版字形（{ viewBox, transform?, d }，填充轮廓）时换成原版。
  const ovGauge = $derived.by(() => {
    const g = ovData('glyphs')?.usageGauge;
    return g && typeof g.d === 'string' && typeof g.viewBox === 'string' ? g : null;
  });
</script>

<div class="lc sel-text" data-limit={lim.type || 'unknown'}>
  <div class="lc-head">
    {#if ovGauge}
      <svg class="lc-ic" viewBox={ovGauge.viewBox} aria-hidden="true"><path transform={ovGauge.transform || undefined} d={ovGauge.d} /></svg>
    {:else}
      <svg class="lc-ic lc-ic-line" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></svg>
    {/if}
    <span class="lc-title">{headline}</span>
  </div>
  <div class="lc-body">
    <span class="lc-hint" aria-live="polite">{hint}</span>
    {#if showToggle}
      <label class="lc-opt">
        <input type="checkbox" checked={armed} onchange={(e) => setLimitAutoContinue(sid, e.currentTarget.checked)} />
        <span class="lc-box" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.5 6.5 11.5 12.5 4.75" /></svg></span>
        <span class="lc-optl">{t('限额重置后自动继续')}</span>
      </label>
    {/if}
  </div>
  {#if details || canRetry}
    <div class="lc-foot">
      {#if details}
        <button class="lc-more" aria-expanded={open} onclick={() => (open = !open)}>
          {t('查看详情')}<svg viewBox="0 0 16 16" aria-hidden="true"><path d={open ? 'M3.25 10 8 5.25 12.75 10' : 'M3.25 6 8 10.75 12.75 6'} /></svg>
        </button>
      {/if}
      {#if canRetry}<button class="lc-btn" onclick={onRetry}>{tc('claude', '重试')}</button>{/if}
    </div>
    {#if open && details}
      <div class="lc-details">
        <span class="lc-dtext">{details}</span>
        <button class="lc-copy" aria-label={t('复制')} onclick={copy}>
          {#if copied}<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>{:else}<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>{/if}
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  /* 官方告警卡：w-fit、min-w min(480px,100%)、rounded-card、1px 描边层；头行 bg-alpha-1（5%）px-lg py-md；
     正文 px-lg pt-lg pb-md、gap-md；底栏 View details 居左、操作钮居右 */
  .lc { display: flex; flex-direction: column; width: fit-content; min-width: min(480px, 100%); max-width: 100%;
    box-sizing: border-box; overflow: clip; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--divider);
    margin: 6px 0; font-size: 14px; line-height: 20px; color: var(--text); overflow-wrap: anywhere; }
  .lc-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: color-mix(in srgb, var(--text) 5%, transparent); }
  .lc-ic { flex: none; width: 16px; height: 16px; fill: var(--crit); }
  .lc-ic-line { fill: none; stroke: var(--crit); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .lc-title { min-width: 0; flex: 1; color: var(--text); }
  .lc-body { display: flex; flex-direction: column; gap: 10px; padding: 12px 12px 8px; }
  .lc-body:last-child { padding-bottom: 12px; }
  .lc-hint { color: var(--serif); white-space: pre-line; }

  /* CDS Checkbox size xs：14px 方框 r4，勾上=主文字色实底 + 底色对勾 */
  .lc-opt { display: inline-flex; align-items: center; gap: 6px; width: fit-content; cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent; }
  .lc-opt input { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; }
  .lc-box { flex: none; width: 14px; height: 14px; border-radius: 4px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 35%, transparent); background: transparent;
    transition: background-color 80ms ease-out, box-shadow 80ms ease-out; }
  .lc-box svg { width: 12px; height: 12px; fill: none; stroke: var(--bg); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; opacity: 0; transition: opacity 80ms ease-out; }
  .lc-opt input:checked + .lc-box { background: var(--text); box-shadow: inset 0 0 0 1px var(--text); }
  .lc-opt input:checked + .lc-box svg { opacity: 1; }
  .lc-opt input:focus-visible + .lc-box { outline: 2px solid color-mix(in srgb, var(--text) 40%, transparent); outline-offset: 2px; }
  .lc-optl { font-size: 13px; line-height: 18px; color: var(--serif); }
  @media (hover: hover) { .lc-opt:hover .lc-box { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 55%, transparent); } }

  .lc-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 4px 12px 12px; }
  .lc-more { display: inline-flex; align-items: center; gap: 2px; padding: 0; border: 0; background: none; cursor: pointer;
    font: inherit; font-size: 12px; line-height: 17px; color: var(--muted); white-space: nowrap; }
  .lc-more svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  @media (hover: hover) { .lc-more:hover { color: var(--text); } }
  /* 唯一操作钮 = primary（官方 B==="retry" → primary）：主文字色实底 */
  .lc-btn { margin-inline-start: auto; display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border: 0; border-radius: 7px; cursor: pointer;
    font: inherit; font-size: 13px; line-height: 18px; color: var(--bg); background: var(--text); transition: opacity 80ms ease-out, transform 80ms ease-out; }
  @media (hover: hover) { .lc-btn:hover { opacity: .88; } }
  .lc-btn:active { transform: scale(.975); }

  .lc-details { position: relative; margin: 0 12px 12px; padding: 8px 36px 8px 10px; border-radius: 8px;
    background: color-mix(in srgb, var(--text) 5%, transparent); font-size: 12px; line-height: 17px; color: var(--serif); }
  .lc-dtext { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .lc-copy { position: absolute; top: 4px; inset-inline-end: 4px; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
    border: 0; border-radius: 6px; background: none; color: var(--muted); cursor: pointer; }
  .lc-copy svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  @media (hover: hover) { .lc-copy:hover { background: var(--hover); color: var(--text); } }
</style>
