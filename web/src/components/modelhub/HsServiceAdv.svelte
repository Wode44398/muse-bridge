<script>
  // 服务的「高级设置」（2026-11-15）：兼容项、输出上限字段名、超时、失败重试、鉴权方式、自定义请求头——都按服务算（一个服务的所有模型共用）。
  // 兼容项是覆盖：「自动」= 按上游定（官方 Anthropic 一套、其余一套，自动值写在段里）。保存 = POST /update（compat / retries 给 null = 恢复自动）。
  // 连接面板里的名字 / 地址 / Key 不在这里，各存各的。
  import HsSheet from './HsSheet.svelte';
  import HsSeg from './HsSeg.svelte';
  import { G, svg, svcAdvDraft, svcAdvPayload, svcAdvProblem } from './HsKit.js';
  import { hubPost, AGENT_NAME, PROTO_NAME } from '../../lib/modelHub.svelte.js';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  let { svc, narrow = false, onclosed, onsaved } = $props();

  // svelte-ignore state_referenced_locally
  let draft = $state(svcAdvDraft(svc));
  // svelte-ignore state_referenced_locally
  const base = JSON.stringify(svcAdvPayload(svcAdvDraft(svc)));
  const payload = $derived(svcAdvPayload(draft));
  const dirty = $derived(JSON.stringify(payload) !== base);
  const problem = $derived(svcAdvProblem(draft));
  const auto = $derived(svc?.compatAuto || {});
  const proto = $derived(svc?.kind || 'openai');
  let saving = $state(false);
  let err = $state('');
  let sheet = $state();

  const onOff = (v) => (v ? t('开') : t('关'));
  const tri = (k) => [
    { value: 'auto', label: t('自动') + ' · ' + onOff(auto[k]) },
    { value: 'on', label: t('开') },
    { value: 'off', label: t('关') },
  ];
  // 每项：对谁生效、在什么协议下才有意义（不相干的协议下置灰说明）
  const COMPAT = $derived([
    { k: 'promptCaching', name: t('提示缓存'), code: 'cache_control', who: ['claude', 'dimensio'], only: 'anthropic',
      hint: t('给请求打缓存标记，重复的前缀按缓存价计费、首字更快；不认这个字段的第三方开了可能 400') },
    { k: 'stripBetas', name: t('去掉 beta 请求头'), code: 'anthropic-beta', who: ['claude'], only: 'anthropic',
      hint: t('第三方多半不认官方的 beta 功能，带着会 400；连同只在 beta 下才有的字段一起去掉') },
    { k: 'slimBody', name: t('精简请求'), code: '', who: ['claude'], only: '',
      hint: t('去掉官方专属的字段（上下文管理、服务端工具、output_config 等）；第三方端点建议开着') },
    { k: 'stripThinkingHistory', name: t('去掉历史思考块'), code: 'thinking', who: ['claude'], only: '',
      hint: t('发给上游前删掉历史轮里的思考内容；换过模型、上游不认别家的思考块时打开') },
    { k: 'replayReasoning', name: t('回传推理内容'), code: 'reasoning_content', who: ['claude', 'dimensio'], only: 'openai',
      hint: t('工具续轮把上一轮的思考原文带回去；DeepSeek、Kimi 一类思考模式下不带就 400') },
  ]);
  const fieldOpts = $derived([
    { value: 'auto', label: t('自动') + ' · ' + (auto.maxTokensField || 'max_tokens') },
    { value: 'max_tokens', label: 'max_tokens' },
    { value: 'max_completion_tokens', label: 'max_completion_tokens' },
  ]);
  const AUTH = $derived([
    { value: 'bearer', label: 'Bearer' }, { value: 'x-api-key', label: 'x-api-key' },
    { value: 'goog', label: 'x-goog-api-key' }, { value: 'none', label: t('不鉴权') },
  ]);

  function addHeader() { if (draft.headers.length < 20) draft.headers = [...draft.headers, { name: '', value: '' }]; }
  function removeHeader(i) { draft.headers = draft.headers.filter((_, j) => j !== i); }
  function resetAll() {
    draft = { ...draft, compat: Object.fromEntries(Object.keys(draft.compat).map((k) => [k, 'auto'])), field: 'auto', retries: '', timeout: '' };
  }
  async function save() {
    if (saving || !dirty || problem) return;
    saving = true; err = '';
    try {
      const r = await hubPost('update', { id: svc.id, patch: payload });
      onsaved?.(r.service || null, r.warnings || []);
      showToast(t('已保存'), 'ok');
      sheet?.dismiss();
    } catch (e) { err = tr(e.message); }
    finally { saving = false; }
  }
  async function onclose() {
    if (!dirty || saving) return !saving;
    return uiConfirm(t('有改动没保存，确定放弃？'), { danger: true, okLabel: t('放弃') });
  }
  const num = (s) => { const x = String(s ?? '').trim(); if (!x) return ''; const n = Number(x); return Number.isFinite(n) ? Math.round(n) : x; };
</script>

{#snippet who(list)}
  <span class="who">{#each list as a (a)}<span class="wt">{AGENT_NAME[a] || a}</span>{/each}</span>
{/snippet}

{#snippet foot()}
  <button type="button" class="lnk" onclick={resetAll} disabled={saving}>{t('兼容项全部恢复自动')}</button>
  <span class="spx"></span>
  {#if err || problem}<span class="ferr" role="alert" title={err || problem}>{err || problem}</span>{/if}
  <button type="button" class="btn" onclick={() => sheet?.dismiss()} disabled={saving}>{t('取消')}</button>
  <button type="button" class="btn primary" class:busy={saving} disabled={!dirty || !!problem || saving} onclick={save}>{t('保存')}</button>
{/snippet}

<HsSheet bind:this={sheet} title={t('{name} 的高级设置', { name: svc.name })} sub={`${svc.host || ''} · ${PROTO_NAME[proto] || proto}`} {narrow} {onclose} {onclosed} {foot} width={700}>
  <p class="lead">{t('这里的设置对这个服务的所有模型生效；单个模型的上下文、思考写法和调用参数在模型行的「调用配置」里改。')}</p>

  <section class="sec">
    <div class="sh"><h4>{t('兼容')}</h4></div>
    {#each COMPAT as c (c.k)}
      {@const off = c.only && c.only !== proto}
      <div class="row" class:dim={off}>
        <div class="lab">
          <div class="nm">{c.name}{#if c.code}<code>{c.code}</code>{/if}{@render who(c.who)}</div>
          <div class="hint">{off ? t('只对 {p} 协议有意义，这个服务用不上', { p: PROTO_NAME[c.only] }) : c.hint}</div>
        </div>
        <div class="ctl"><HsSeg label={c.name} options={tri(c.k)} value={draft.compat[c.k]} onchange={(v) => (draft.compat[c.k] = v)} /></div>
      </div>
    {/each}
    <div class="row" class:dim={proto !== 'openai'}>
      <div class="lab">
        <div class="nm">{t('输出上限字段')}{@render who(['claude', 'dimensio'])}</div>
        <div class="hint">{proto !== 'openai' ? t('只对 {p} 协议有意义，这个服务用不上', { p: PROTO_NAME.openai }) : t('OpenAI 自家的推理模型只认 max_completion_tokens')}</div>
      </div>
      <div class="ctl"><select class="sel mono" bind:value={draft.field} aria-label={t('输出上限字段')}>
        {#each fieldOpts as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
      </select></div>
    </div>
  </section>

  <section class="sec">
    <div class="sh"><h4>{t('请求')}</h4></div>
    <div class="row">
      <div class="lab"><div class="nm">{t('超时')}{@render who(['claude', 'dimensio'])}</div><div class="hint">{t('一次请求最多等多久（含流式输出的全程）；本机慢模型可以调长')}</div></div>
      <div class="ctl"><div class="numf"><input type="number" min="10" max="1800" placeholder="600" value={draft.timeout} oninput={(e) => (draft.timeout = num(e.currentTarget.value))} aria-label={t('超时')} /><span class="unit">{t('秒')}</span></div></div>
    </div>
    <div class="row">
      <div class="lab"><div class="nm">{t('失败重试')}{@render who(['claude'])}</div><div class="hint">{t('连不上、5xx、限流时 Claude 的代理原样重发几次；多把 Key 的服务另外会自动换下一把')}</div></div>
      <div class="ctl"><div class="numf sm"><input type="number" min="0" max="5" placeholder={t('自动 · {v}', { v: 1 })} value={draft.retries} oninput={(e) => (draft.retries = num(e.currentTarget.value))} aria-label={t('失败重试')} /><span class="unit">{t('次')}</span></div></div>
    </div>
    <div class="row">
      <div class="lab"><div class="nm">{t('鉴权方式')}{@render who(['claude', 'dimensio'])}</div><div class="hint">{t('Key 放在哪个请求头里发给上游')}</div></div>
      <div class="ctl"><select class="sel" bind:value={draft.authStyle} aria-label={t('鉴权方式')}>
        {#each AUTH as a (a.value)}<option value={a.value}>{a.label}</option>{/each}
      </select></div>
    </div>
    <div class="row col">
      <div class="lab"><div class="nm">{t('自定义请求头')}{@render who(['claude', 'dimensio'])}</div><div class="hint">{t('每个请求都带上；鉴权头、Host 这类由 bridge 自己管，不能自定义')}</div></div>
      <div class="hdrs">
        {#each draft.headers as h, i (i)}
          <div class="hr">
            <input class="in mono" placeholder="X-Header" spellcheck="false" autocomplete="off" bind:value={h.name} aria-label={t('请求头名')} />
            <input class="in mono" placeholder={t('值')} spellcheck="false" autocomplete="off" bind:value={h.value} aria-label={t('请求头的值')} />
            <button type="button" class="ib" aria-label={t('移除')} title={t('移除')} onclick={() => removeHeader(i)}>{@html svg(G.trash)}</button>
          </div>
        {/each}
        {#if draft.headers.length < 20}<button type="button" class="add" onclick={addHeader}>{@html svg(G.plus)}{t('添加请求头')}</button>{/if}
      </div>
    </div>
  </section>
  {#if narrow && (err || problem)}<p class="berr" role="alert">{err || problem}</p>{/if}
</HsSheet>

<style>
  .lead { margin: 14px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--st-muted); }
  .sec { padding-top: 18px; }
  .sec + .sec { margin-top: 10px; border-top: 1px solid var(--st-hair); }
  .sh { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .sh h4 { margin: 0; font-size: 12.5px; font-weight: 600; letter-spacing: .02em; color: var(--st-text2); }
  .who { display: inline-flex; gap: 4px; margin-left: 2px; }
  .wt { height: 18px; padding: 0 6px; border-radius: 5px; background: var(--st-seg); color: var(--st-muted); font-size: 11px; line-height: 18px; font-weight: 400; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 24px; align-items: center; padding: 12px 0; }
  .row + .row { border-top: 1px solid var(--st-hair); }
  .row.col { grid-template-columns: 1fr; }
  .row.dim .nm, .row.dim .ctl { opacity: .55; }
  .nm { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 14px; color: var(--text); }
  .nm code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11.5px; color: var(--st-muted); background: var(--st-seg); padding: 1px 6px; border-radius: 5px; }
  .hint { margin-top: 3px; font-size: 12.5px; line-height: 1.45; color: var(--st-muted); }
  .ctl { display: flex; align-items: center; justify-content: flex-end; min-width: 0; }
  .numf { display: flex; align-items: center; height: 34px; width: 160px; border-radius: 9px; background: var(--st-field); box-shadow: inset 0 0 0 1px var(--st-line); overflow: hidden; }
  .numf.sm { width: 140px; }
  .numf:focus-within { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 55%, transparent); }
  .numf input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 13.5px; padding: 0 10px; font-variant-numeric: tabular-nums; }
  .numf input::placeholder { color: var(--st-muted); }
  .unit { padding: 0 10px 0 4px; font-size: 12px; color: var(--st-muted); }
  .sel, .in { height: 34px; box-sizing: border-box; padding: 0 10px; border: 0; border-radius: 9px; background: var(--st-field); color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line);
    font: inherit; font-size: 13.5px; outline: none; min-width: 0; }
  .sel { min-width: 180px; }
  .sel.mono { font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 12.5px; min-width: 220px; }
  .sel:focus, .in:focus { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 55%, transparent); }
  .in.mono { font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 12.5px; }
  .hdrs { display: flex; flex-direction: column; gap: 6px; }
  .hr { display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.4fr) 34px; gap: 6px; align-items: center; }
  .ib { width: 34px; height: 34px; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--st-muted); cursor: pointer; }
  .ib :global(svg) { width: 16px; height: 16px; }
  @media (hover: hover) { .ib:hover { background: var(--st-hover); color: var(--text); } }
  .add { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px 0 8px; border: 0; border-radius: 8px; background: transparent;
    color: var(--st-muted); font: inherit; font-size: 13px; cursor: pointer; }
  .add :global(svg) { width: 15px; height: 15px; }
  @media (hover: hover) { .add:hover { background: var(--st-hover); color: var(--text); } }
  .berr { margin: 12px 0 0; font-size: 13px; color: var(--pm-red); }

  .spx { flex: 1; }
  .ferr { min-width: 0; max-width: 46%; font-size: 12.5px; color: var(--pm-red); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lnk { height: 32px; padding: 0 8px; margin-left: -8px; border: 0; border-radius: 8px; background: transparent; color: var(--st-muted); font: inherit; font-size: 13px; cursor: pointer; }
  @media (hover: hover) { .lnk:hover:not(:disabled) { background: var(--st-hover); color: var(--text); } }
  .btn { height: 34px; padding: 0 14px; border: 0; border-radius: 9px; background: var(--st-seg); color: var(--text); font: inherit; font-size: 13.5px; font-weight: 500; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  @media (hover: hover) { .btn:hover:not(:disabled) { background: var(--st-sel); } }
  .btn:active:not(:disabled) { transform: scale(.96); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); }
  .btn.busy { opacity: .7; }
  .btn:focus-visible, .lnk:focus-visible, .add:focus-visible, .ib:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  @media (max-width: 699px) {
    .row { grid-template-columns: 1fr; gap: 10px; }
    .ctl { justify-content: flex-start; overflow-x: auto; }
    .numf, .numf.sm, .sel { width: 100%; }
    .hr { grid-template-columns: minmax(0, 1fr) 44px; }
    .hr .in:nth-child(2) { grid-column: 1; grid-row: 2; }
    .hr .ib { grid-row: 1 / span 2; grid-column: 2; }
    .btn { height: 44px; padding: 0 18px; font-size: 15px; border-radius: 12px; }
    .ferr { display: none; }
  }
</style>
