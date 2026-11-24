<script>
  // 服务的「高级设置」：兼容项、输出上限字段名、超时、失败重试、鉴权方式、Responses 接口、自定义请求头——都按服务算（一个服务的所有模型共用）。
  // 兼容项是覆盖：「自动」= 按上游定（官方 Anthropic 一套、其余一套）；自动时实际是开是关写在控件下面一行，不塞进分段里
  // （塞进去的长字会把控件撑宽、把左边的说明挤成一字一行）。保存 = POST /update（compat / retries 给 null = 恢复自动）。
  // 对这个服务的协议没意义的项默认收起（例如 OpenAI 协议的服务用不上 cache_control），改过的除外；底下一行可以展开看。
  // 连接面板里的名字 / 地址 / Key 不在这里，各存各的。
  import HsSheet from './HsSheet.svelte';
  import HsSeg from './HsSeg.svelte';
  import { G, svg, svcAdvDraft, svcAdvPayload, svcAdvProblem } from './HsKit.js';
  import { hub, hubPost, AGENT_NAME, PROTO_NAME } from '../../lib/modelHub.svelte.js';
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
  let showIdle = $state(false);

  const onOff = (v) => (v ? t('开') : t('关'));
  // 自动时实际的值；某个 agent 的自动值和 Claude 不同（compatAuto.agents）时分开写：「Claude 关 · dimensio 开」
  const autoText = (k, who) => {
    const diff = (who || []).filter((a) => a !== 'claude' && typeof auto.agents?.[a]?.[k] === 'boolean' && auto.agents[a][k] !== !!auto[k]);
    if (!diff.length) return onOff(auto[k]);
    return [(who.includes('claude') ? AGENT_NAME.claude + ' ' : '') + onOff(auto[k]), ...diff.map((a) => (AGENT_NAME[a] || a) + ' ' + onOff(auto.agents[a][k]))].join(' · ');
  };
  const TRI = $derived([{ value: 'auto', label: t('自动') }, { value: 'on', label: t('开') }, { value: 'off', label: t('关') }]);
  // 每项：对谁生效、在什么协议下才有意义
  const COMPAT = $derived([
    { k: 'slimBody', name: t('精简请求'), code: '', who: ['claude'], only: '',
      hint: t('去掉官方专属的字段（上下文管理、服务端工具、output_config 等）；第三方端点建议开着') },
    { k: 'stripThinkingHistory', name: t('去掉历史思考块'), code: 'thinking', who: ['claude'], only: '',
      hint: t('发给上游前删掉历史轮里的思考内容；换过模型、上游不认别家的思考块时打开') },
    { k: 'replayReasoning', name: t('回传推理内容'), code: 'reasoning_content', who: ['claude', 'dimensio'], only: 'openai',
      hint: t('工具续轮把上一轮的思考原文带回去；DeepSeek、Kimi 一类思考模式下不带就 400') },
    { k: 'promptCaching', name: t('提示缓存'), code: 'cache_control', who: ['claude', 'dimensio'], only: 'anthropic',
      hint: t('给请求打缓存标记，重复的前缀按缓存价计费、首字更快；不认这个字段的第三方开了可能 400') },
    { k: 'stripBetas', name: t('去掉 beta 请求头'), code: 'anthropic-beta', who: ['claude'], only: 'anthropic',
      hint: t('第三方多半不认官方的 beta 功能，带着会 400；连同只在 beta 下才有的字段一起去掉') },
  ]);
  // 协议用不上、也没改过的收起来；改过的照常显示（好改回来）
  const idle = (c) => !!c.only && c.only !== proto && draft.compat[c.k] === 'auto';
  const compatShown = $derived(COMPAT.filter((c) => showIdle || !idle(c)));
  const idleN = $derived(COMPAT.filter(idle).length + (proto !== 'openai' && draft.field === 'auto' ? 1 : 0));
  const fieldShown = $derived(proto === 'openai' || draft.field !== 'auto' || showIdle);
  const idleProtos = $derived([...new Set([...COMPAT.filter(idle).map((c) => c.only), ...(proto !== 'openai' && draft.field === 'auto' ? ['openai'] : [])])].map((p) => PROTO_NAME[p] || p).join(t('、')));

  const fieldOpts = $derived([
    { value: 'auto', label: t('自动') + ' · ' + (auto.maxTokensField || 'max_tokens') },
    { value: 'max_tokens', label: 'max_tokens' },
    { value: 'max_completion_tokens', label: 'max_completion_tokens' },
  ]);
  // 只有 OpenAI 协议的服务可能自带 Responses 接口；别的协议网关一律转换
  const respNative = $derived(proto === 'openai');
  const respName = (v) => (v === 'native' ? t('透传') : t('转换'));
  const respOpts = $derived([
    { value: 'auto', label: t('自动') },
    { value: 'native', label: t('透传'), disabled: !respNative, title: respNative ? '' : t('只有 OpenAI 协议的服务能透传') },
    { value: 'translate', label: t('转换') },
  ]);
  const AUTH = $derived([
    { value: 'bearer', label: 'Bearer' }, { value: 'x-api-key', label: 'x-api-key' },
    { value: 'goog', label: 'x-goog-api-key' }, { value: 'none', label: t('不鉴权') },
  ]);
  const whoText = (list) => list.map((a) => AGENT_NAME[a] || a).join(' · ');

  function addHeader() { if (draft.headers.length < 20) draft.headers = [...draft.headers, { name: '', value: '' }]; }
  function removeHeader(i) { draft.headers = draft.headers.filter((_, j) => j !== i); }
  function resetAll() {
    draft = { ...draft, compat: Object.fromEntries(Object.keys(draft.compat).map((k) => [k, 'auto'])), field: 'auto', retries: '', timeout: '',
      ...('responses' in draft ? { responses: 'auto' } : {}) };
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

<!-- 一行：左边名字 + 说明，右边定宽的控件（控件不随文字变宽，左栏才不会被挤）；under = 控件下面的小字（自动时的实际值） -->
{#snippet row(name, code, hint, who, ctl, under = '', dim = false)}
  <div class="row" class:dim>
    <div class="lab">
      <div class="nm"><span class="nt">{name}</span>{#if code}<code>{code}</code>{/if}</div>
      {#if hint}<p class="hint">{hint}</p>{/if}
      {#if who?.length}<p class="who">{t('用于 {list}', { list: whoText(who) })}</p>{/if}
    </div>
    <div class="ctl">
      {@render ctl()}
      {#if under}<span class="under">{under}</span>{/if}
    </div>
  </div>
{/snippet}

{#snippet foot()}
  <button type="button" class="lnk" onclick={resetAll} disabled={saving}>{t('全部恢复自动')}</button>
  <span class="spx"></span>
  {#if err || problem}<span class="ferr" role="alert" title={err || problem}>{err || problem}</span>{/if}
  <button type="button" class="btn" onclick={() => sheet?.dismiss()} disabled={saving}>{t('取消')}</button>
  <button type="button" class="btn primary" class:busy={saving} disabled={!dirty || !!problem || saving} onclick={save}>{t('保存')}</button>
{/snippet}

<HsSheet bind:this={sheet} title={t('{name} 的高级设置', { name: svc.name })} sub={`${svc.host || ''} · ${PROTO_NAME[proto] || proto}`} {narrow} {onclose} {onclosed} {foot} width={680}>
  <p class="lead">{t('对这个服务的所有模型生效。单个模型的上下文、思考写法和调用参数，在模型行的「调用配置」里改。')}</p>

  <section class="grp">
    <h4 class="gt">{t('兼容')}</h4>
    <div class="card">
      {#each compatShown as c (c.k)}
        {@const off = !!c.only && c.only !== proto}
        {#snippet seg()}<div class="segw"><HsSeg label={c.name} options={TRI} value={draft.compat[c.k]} onchange={(v) => (draft.compat[c.k] = v)} /></div>{/snippet}
        {@render row(c.name, c.code, off ? t('只对 {p} 协议有意义，这个服务用不上', { p: PROTO_NAME[c.only] }) : c.hint, c.who, seg,
          draft.compat[c.k] === 'auto' ? t('自动时：{v}', { v: autoText(c.k, c.who) }) : '', off)}
      {/each}
      {#if fieldShown}
        {#snippet fsel()}<select class="sel mono" bind:value={draft.field} aria-label={t('输出上限字段')}>
          {#each fieldOpts as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
        </select>{/snippet}
        {@render row(t('输出上限字段'), '', proto !== 'openai' ? t('只对 {p} 协议有意义，这个服务用不上', { p: PROTO_NAME.openai }) : t('OpenAI 自家的推理模型只认 max_completion_tokens'),
          ['claude', 'dimensio'], fsel, '', proto !== 'openai')}
      {/if}
      {#if 'responses' in draft && hub.codexHub}
        {#snippet rseg()}<div class="segw"><HsSeg label={t('Responses 接口')} options={respOpts} value={draft.responses} onchange={(v) => (draft.responses = v)} /></div>{/snippet}
        {@render row(t('Responses 接口'), '/responses',
          respNative ? t('透传：上游自己有 Responses 接口（OpenAI、OpenRouter）；转换：bridge 把 Codex 的请求转成 Chat Completions 再把结果转回来') : t('这个服务不是 OpenAI 协议，bridge 把 Codex 的请求转成它的接口再转回来'),
          ['codex'], rseg, draft.responses === 'auto' ? t('自动时：{v}', { v: respName(respNative ? svc?.responsesAuto : 'translate') }) : '')}
      {/if}
      {#if idleN > 0}
        <button type="button" class="more" aria-expanded={showIdle} onclick={() => (showIdle = !showIdle)}>
          <span>{showIdle ? t('收起用不上的 {n} 项', { n: idleN }) : t('另有 {n} 项只对 {p} 协议有意义，这个服务用不上', { n: idleN, p: idleProtos })}</span>
          <span class="chev" class:up={showIdle} aria-hidden="true">{@html svg(G.chev, 1.8)}</span>
        </button>
      {/if}
    </div>
  </section>

  <section class="grp">
    <h4 class="gt">{t('请求')}</h4>
    <div class="card">
      {#snippet tmo()}<div class="numf"><input type="number" min="10" max="1800" placeholder="600" value={draft.timeout} oninput={(e) => (draft.timeout = num(e.currentTarget.value))} aria-label={t('超时')} /><span class="unit">{t('秒')}</span></div>{/snippet}
      {@render row(t('超时'), '', t('一次请求最多等多久（含流式输出的全程）；本机慢模型可以调长'), ['claude', 'dimensio'], tmo, draft.timeout === '' ? t('默认 600 秒') : '')}
      {#snippet rtr()}<div class="numf"><input type="number" min="0" max="5" placeholder="1" value={draft.retries} oninput={(e) => (draft.retries = num(e.currentTarget.value))} aria-label={t('失败重试')} /><span class="unit">{t('次')}</span></div>{/snippet}
      {@render row(t('失败重试'), '', t('连不上、5xx、限流时 Claude 的代理原样重发几次；多把 Key 的服务另外会自动换下一把'), ['claude'], rtr, draft.retries === '' ? t('自动时：{v}', { v: 1 }) : '')}
      {#snippet ath()}<select class="sel" bind:value={draft.authStyle} aria-label={t('鉴权方式')}>
        {#each AUTH as a (a.value)}<option value={a.value}>{a.label}</option>{/each}
      </select>{/snippet}
      {@render row(t('鉴权方式'), '', t('Key 放在哪个请求头里发给上游'), ['claude', 'dimensio'], ath)}
    </div>
  </section>

  <section class="grp">
    <h4 class="gt">{t('自定义请求头')}</h4>
    <div class="card hcard">
      <p class="hint hlead">{t('每个请求都带上；鉴权头、Host 这类由 bridge 自己管，不能自定义')}</p>
      {#each draft.headers as h, i (i)}
        <div class="hr">
          <input class="in mono" placeholder="X-Header" spellcheck="false" autocomplete="off" bind:value={h.name} aria-label={t('请求头名')} />
          <input class="in mono" placeholder={t('值')} spellcheck="false" autocomplete="off" bind:value={h.value} aria-label={t('请求头的值')} />
          <button type="button" class="ib" aria-label={t('移除')} title={t('移除')} onclick={() => removeHeader(i)}>{@html svg(G.trash)}</button>
        </div>
      {/each}
      {#if draft.headers.length < 20}<button type="button" class="add" onclick={addHeader}>{@html svg(G.plus)}{t('添加请求头')}</button>{/if}
    </div>
  </section>
  {#if narrow && (err || problem)}<p class="berr" role="alert">{err || problem}</p>{/if}
</HsSheet>

<style>
  .lead { margin: 14px 2px 0; font-size: 13px; line-height: 1.6; color: var(--st-muted); }
  .grp { margin-top: 22px; }
  .gt { margin: 0 0 8px 4px; font-size: 12px; font-weight: 600; letter-spacing: .04em; color: var(--st-muted); }
  .card { border-radius: 14px; box-shadow: inset 0 0 0 1px var(--st-line); padding: 0 18px; }
  :global(.narrow) .card { background: var(--st-surface); box-shadow: none; border-radius: 16px; padding: 0 16px; }

  /* 一行 = 左栏（名字、说明）+ 右栏定宽控件；左栏至少 220 宽，再窄就上下排（见下面的 media） */
  .row { display: grid; grid-template-columns: minmax(220px, 1fr) var(--ctl-w, 212px); gap: 6px 28px; align-items: center; padding: 14px 0; }
  .row + .row { border-top: 1px solid var(--st-hair); }
  .row.dim .lab { opacity: .6; }
  .nm { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; }
  .nt { font-size: 14px; font-weight: 500; color: var(--text); }
  .nm code { font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 11.5px; color: var(--st-muted); }
  .hint { margin: 4px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--st-muted); text-wrap: pretty; }
  .who { margin: 3px 0 0; font-size: 11.5px; color: color-mix(in srgb, var(--st-muted) 80%, transparent); }
  .ctl { display: flex; flex-direction: column; align-items: stretch; gap: 5px; min-width: 0; }
  .segw { width: 100%; }
  .under { font-size: 11.5px; line-height: 1.4; color: var(--st-muted); text-align: right; font-variant-numeric: tabular-nums; }

  .numf { display: flex; align-items: center; height: 34px; border-radius: 9px; background: var(--st-field); box-shadow: inset 0 0 0 1px var(--st-line); overflow: hidden; }
  .numf:focus-within { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 55%, transparent); }
  .numf input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 13.5px; padding: 0 10px; text-align: right; font-variant-numeric: tabular-nums; }
  .numf input::placeholder { color: var(--st-muted); }
  .unit { padding: 0 12px 0 2px; font-size: 12.5px; color: var(--st-muted); }
  .sel, .in { height: 34px; box-sizing: border-box; padding: 0 10px; border: 0; border-radius: 9px; background: var(--st-field); color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line);
    font: inherit; font-size: 13.5px; outline: none; min-width: 0; width: 100%; }
  .sel.mono, .in.mono { font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 12.5px; }
  .sel:focus, .in:focus { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 55%, transparent); }

  .more { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: calc(100% + 36px); margin: 0 -18px; padding: 11px 18px; box-sizing: border-box;
    border: 0; border-top: 1px solid var(--st-hair); border-radius: 0 0 14px 14px; background: transparent; color: var(--st-muted); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer; }
  @media (hover: hover) { .more:hover { color: var(--text); background: var(--st-hover); } }
  .chev { display: grid; place-items: center; width: 16px; height: 16px; transition: transform var(--mo-quick) var(--ea-std); }
  .chev :global(svg) { width: 14px; height: 14px; }
  .chev.up { transform: rotate(180deg); }

  .hcard { padding-top: 12px; padding-bottom: 12px; display: flex; flex-direction: column; gap: 8px; }
  .hlead { margin: 0 0 2px; }
  .hr { display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.4fr) 34px; gap: 6px; align-items: center; }
  .ib { width: 34px; height: 34px; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--st-muted); cursor: pointer; }
  .ib :global(svg) { width: 16px; height: 16px; }
  @media (hover: hover) { .ib:hover { background: var(--st-hover); color: var(--text); } }
  .add { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px 0 8px; margin-left: -8px; border: 0; border-radius: 8px; background: transparent;
    color: var(--st-text2); font: inherit; font-size: 13px; cursor: pointer; }
  .add :global(svg) { width: 15px; height: 15px; }
  @media (hover: hover) { .add:hover { background: var(--st-hover); color: var(--text); } }
  .berr { margin: 12px 0 0; font-size: 13px; color: var(--pm-red); }

  .spx { flex: 1; }
  .ferr { min-width: 0; max-width: 46%; font-size: 12.5px; color: var(--pm-red); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lnk { height: 32px; padding: 0 8px; margin-left: -8px; border: 0; border-radius: 8px; background: transparent; color: var(--st-muted); font: inherit; font-size: 13px; cursor: pointer; }
  @media (hover: hover) { .lnk:hover:not(:disabled) { background: var(--st-hover); color: var(--text); } }
  .btn { height: 34px; padding: 0 16px; border: 0; border-radius: 9px; background: var(--st-seg); color: var(--text); font: inherit; font-size: 13.5px; font-weight: 500; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  @media (hover: hover) { .btn:hover:not(:disabled) { background: var(--st-sel); } }
  .btn:active:not(:disabled) { transform: scale(.96); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); }
  .btn.busy { opacity: .7; }
  .btn:focus-visible, .lnk:focus-visible, .add:focus-visible, .ib:focus-visible, .more:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }

  /* 窄：上下排，控件整行宽；自动时的实际值靠左 */
  @media (max-width: 699px) {
    .row { grid-template-columns: minmax(0, 1fr); gap: 10px; }
    .under { text-align: left; }
    .hr { grid-template-columns: minmax(0, 1fr) 44px; }
    .hr .in:nth-child(2) { grid-column: 1; grid-row: 2; }
    .hr .ib { grid-row: 1 / span 2; grid-column: 2; }
    .btn { height: 44px; padding: 0 18px; font-size: 15px; border-radius: 12px; }
    .numf, .sel, .in { height: 44px; border-radius: 12px; font-size: 15px; }
    .ferr { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
</style>
