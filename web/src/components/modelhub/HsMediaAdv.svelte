<script>
  // 已添加给 Media Studio 的媒体模型的「调用配置」：Studio 模型配置层（modules/studio/server/model-config）的界面。
  //   调用方式：按服务方言（bridge 自带的适配）或调用配方（自己描述接口怎么调：提交 → 轮询 → 取结果）；
  //   参数：给选项型参数补取值、改默认值；额外请求体：垫在请求里的一层 JSON；
  //   预演与试跑：用当前草稿（不用先保存）拼请求看 / 真发一次看每一步的原始请求与响应。
  // 配置按「Studio 服务 id/模型 id」另存，模型中心同步模型清单不会冲掉。纯逻辑在 mediaAdv.js（有单测）。
  import { onMount } from 'svelte';
  import HsSheet from './HsSheet.svelte';
  import HsSeg from './HsSeg.svelte';
  import { G, svg } from './HsKit.js';
  import { baseParams, mediaDraft, mediaPayload, mediaProblem } from './mediaAdv.js';
  import { mediaConfigGet, mediaConfigSet, mediaTrial, mediaTrialResult } from '../../lib/modelHub.svelte.js';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  // svc：模型中心服务视图（media.providerId = 托管到 Studio 的服务 id）；model：服务视图里这个模型
  let { svc, model, narrow = false, onclosed, onsaved } = $props();

  // svelte-ignore state_referenced_locally
  const key = `${svc?.media?.providerId || ''}/${model?.id || ''}`;
  let cfg = $state(null);
  let loadErr = $state('');
  let draft = $state(null);
  let baseJson = '';
  let saving = $state(false);
  let err = $state('');
  let sheet = $state();
  let alive = true;

  const params = $derived(cfg ? baseParams(cfg) : []);
  const payload = $derived(draft ? mediaPayload(draft, params) : null);
  const dirty = $derived(!!payload && JSON.stringify(payload) !== baseJson);
  const problem = $derived(draft ? mediaProblem(draft, params) : '');
  const saved = $derived(!!(cfg && (cfg.over || cfg.recipe)));
  // 配方改了还没存：参数表还是旧卡的，补参数等存了再来
  const recipeChanged = $derived(!!draft && !!cfg && (draft.recipeOn !== !!cfg.recipe || (draft.recipeOn && JSON.stringify(payload?.recipe) !== JSON.stringify(cfg.recipe))));
  const hasExtra = $derived(!!cfg && (cfg.base?.hasExtra || draft?.recipeOn));
  const DIALECT = { openai: 'OpenAI', openrouter: 'OpenRouter', fal: 'fal', replicate: 'Replicate', gemini: 'Gemini', vertex: 'Vertex', elevenlabs: 'ElevenLabs', minimax: 'MiniMax', ark: '火山方舟' }; // i18n-ignore 方言名照原文

  async function load() {
    loadErr = '';
    try {
      const c = await mediaConfigGet(key);
      if (!alive) return;
      cfg = c;
      draft = mediaDraft(c);
      baseJson = JSON.stringify(mediaPayload(mediaDraft(c), baseParams(c)));
    } catch (e) { if (alive) loadErr = tr(e.message); }
  }
  onMount(() => { load(); return () => { alive = false; clearTimeout(pollTimer); }; });

  // —— 参数：补取值、默认值 ——
  let adding = $state('');      // 正在给哪个参数补取值
  let addText = $state('');
  function addOption(k) {
    const v = addText.trim();
    if (!v) { adding = ''; return; }
    const spec = params.find((s) => s.key === k);
    const have = new Set([...(spec?.options || []).map((o) => String(o.value)), ...(draft.options[k] || [])]);
    if (!have.has(v)) draft.options = { ...draft.options, [k]: [...(draft.options[k] || []), v] };
    addText = ''; adding = '';
  }
  function dropOption(k, v) {
    const left = (draft.options[k] || []).filter((x) => x !== v);
    const next = { ...draft.options };
    if (left.length) next[k] = left; else delete next[k];
    draft.options = next;
    if (draft.defaults[k] === v) draft.defaults = { ...draft.defaults, [k]: '' };
  }
  const cardDefault = (s) => (s.default === undefined || s.default === '' ? t('不传') : String((s.options || []).find((o) => o.value === s.default)?.label ?? s.default));

  // —— 配方 ——
  const modeOpts = $derived([{ value: 'dialect', label: t('按服务方言') }, { value: 'recipe', label: t('调用配方') }]);
  async function useExample(id) {
    const ex = (cfg?.examples || []).find((x) => x.id === id);
    if (!ex) return;
    if (draft.recipe.trim() && !(await uiConfirm(t('用示例换掉现在的配方？'), { okLabel: t('换掉') }))) return;
    draft.recipe = JSON.stringify(ex.recipe, null, 2);
  }
  // Tab 插两个空格（不跳出编辑框）；Shift+Tab 照常跳走
  function onTab(e) {
    if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const a = el.selectionStart, b = el.selectionEnd;
    el.setRangeText('  ', a, b, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // —— 预演与试跑 ——
  let prompt = $state('');
  let running = $state('');     // '' | 'dry' | 'real'
  let out = $state(null);       // { kind:'dry', ... } | { kind:'real', job, trace, done }
  let pollTimer = 0;
  const trialBody = (dry) => ({ key, dry, prompt: prompt.trim() || t('测试'), over: payload.over, recipe: draft.recipeOn ? payload.recipe : null });
  async function preview() {
    if (running || problem) return;
    running = 'dry'; out = null;
    try { const r = await mediaTrial(trialBody(true)); if (alive) out = { kind: 'dry', ...r }; }
    catch (e) { if (alive) out = { kind: 'err', error: tr(e.message) }; }
    finally { if (alive) running = ''; }
  }
  async function trial() {
    if (running || problem) return;
    const ok = await uiConfirm(t('真发一次请求试跑？'), {
      okLabel: t('试跑'), detail: t('会按这个模型的价格计费（视频按秒计）。用的是当前草稿，不用先保存；结果照常存进 Media Studio 的作品。'),
    });
    if (!ok || !alive) return;
    running = 'real'; out = null;
    try {
      const r = await mediaTrial(trialBody(false));
      if (!alive) return;
      out = { kind: 'real', job: r.job, trace: [], done: false };
      poll(r.job.id, Date.now());
    } catch (e) { if (alive) { out = { kind: 'err', error: tr(e.message) }; running = ''; } }
  }
  function poll(id, t0) {
    pollTimer = setTimeout(async () => {
      if (!alive) return;
      try {
        const r = await mediaTrialResult(id);
        if (!alive) return;
        out = { kind: 'real', ...r };
        if (r.done || Date.now() - t0 > 20 * 60_000) { running = ''; return; }
      } catch (e) { if (alive) { out = { ...(out || {}), kind: 'real', pollErr: tr(e.message) }; running = ''; return; } }
      poll(id, t0);
    }, 1500);
  }
  const stateText = (j) => (!j ? '' : j.state === 'done' ? t('完成，出了 {n} 件，已存进 Media Studio 的作品', { n: (j.result || []).length })
    : j.state === 'error' ? t('失败') : j.state === 'canceled' ? t('已取消') : t('进行中 · {s} 秒', { s: j.elapsed || 0 }));
  const sec = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : ms + ' ms');
  const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
  const headerLines = (h) => Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join('\n');

  // —— 保存 ——
  async function save() {
    if (saving || !dirty || problem) return;
    saving = true; err = '';
    try {
      const r = await mediaConfigSet({ key, ...payload });
      for (const w of r.warnings || []) showToast(tr(w), 'warn');
      onsaved?.(model.id, r.config || null);
      showToast(t('已保存'), 'ok');
      sheet?.dismiss();
    } catch (e) { err = tr(e.message); }
    finally { saving = false; }
  }
  async function clearAll() {
    if (saving) return;
    if (!(await uiConfirm(t('清除这个模型的全部调用配置？'), { danger: true, okLabel: t('清除'), detail: t('补的参数、额外请求体和调用配方都会删掉，恢复按服务方言调用。') }))) return;
    saving = true; err = '';
    try {
      const r = await mediaConfigSet({ key, over: null, recipe: null });
      onsaved?.(model.id, r.config || null);
      showToast(t('已清除'), 'ok');
      sheet?.dismiss();
    } catch (e) { err = tr(e.message); }
    finally { saving = false; }
  }
  async function onclose() {
    if (!dirty || saving) return !saving;
    return uiConfirm(t('有改动没保存，确定放弃？'), { danger: true, okLabel: t('放弃') });
  }
</script>

{#snippet foot()}
  {#if saved}<button type="button" class="lnk" onclick={clearAll} disabled={saving}>{t('清除配置')}</button>{/if}
  <span class="spx"></span>
  {#if err || problem}<span class="ferr" role="alert" title={err || problem}>{err || problem}</span>{/if}
  <button type="button" class="btn" onclick={() => sheet?.dismiss()} disabled={saving}>{t('取消')}</button>
  <button type="button" class="btn primary" class:busy={saving} disabled={!dirty || !!problem || saving} onclick={save}>{t('保存')}</button>
{/snippet}

<HsSheet bind:this={sheet} title={t('{model} 的调用配置', { model: model.label || model.id })} sub={`${svc.name} · ${model.id}`} {narrow} {onclose} {onclosed} {foot} width={720}>
  {#if !cfg}
    <div class="wait" role="status">
      {#if loadErr}<span class="ferr2">{loadErr}</span><button type="button" class="btn" onclick={load}>{t('重试')}</button>
      {:else}{t('正在读取…')}{/if}
    </div>
  {:else}
    <p class="lead">{t('只对这一个模型生效。补参数、改默认值，或者用调用配方自己描述接口怎么调；模型中心同步模型清单时不会冲掉这里的设置。')}</p>

    <section class="grp">
      <h4 class="gt">{t('调用方式')}</h4>
      <div class="card">
        <div class="row">
          <div class="lab">
            <div class="nm"><span class="nt">{draft.recipeOn ? t('照调用配方发请求') : t('按「{d}」方言发请求', { d: DIALECT[cfg.provider.dialect] || cfg.provider.dialect })}</span></div>
            <p class="hint">{draft.recipeOn ? t('提交、轮询、取结果都照下面的配方；地址和 Key 仍用这个服务的') : t('bridge 自带的适配；中转站的接口不标准、接不通时改用调用配方')}</p>
          </div>
          <div class="ctl"><HsSeg label={t('调用方式')} options={modeOpts} value={draft.recipeOn ? 'recipe' : 'dialect'}
            onchange={(v) => { draft.recipeOn = v === 'recipe'; if (draft.recipeOn && !draft.recipe.trim() && cfg.examples?.length) draft.recipe = JSON.stringify((cfg.examples.find((x) => x.kind === (cfg.kind || '')) || cfg.examples[0]).recipe, null, 2); }} /></div>
        </div>
        {#if draft.recipeOn}
          <div class="ed">
            <div class="edbar">
              <span class="edt">{t('配方')}<code>JSON</code></span>
              <span class="spx"></span>
              {#if cfg.examples?.length}
                <select class="sel sm" aria-label={t('从示例开始')} value="" onchange={(e) => { const v = e.currentTarget.value; e.currentTarget.value = ''; useExample(v); }}>
                  <option value="" disabled>{t('从示例开始…')}</option>
                  {#each cfg.examples as ex (ex.id)}<option value={ex.id}>{tr(ex.title)}</option>{/each}
                </select>
              {/if}
            </div>
            <textarea class="code" rows="16" wrap="off" spellcheck="false" autocomplete="off" autocapitalize="off" bind:value={draft.recipe} onkeydown={onTab} aria-label={t('配方')}></textarea>
            <p class="hint">{t('占位符：{{prompt}}、{{model}}、{{params.键}}、{{inputs.first.dataUrl}}、{{submit.$.id}}…；格式见手册「Media Studio › 单个模型的调用配置」。')}</p>
          </div>
        {/if}
      </div>
    </section>

    <section class="grp">
      <h4 class="gt">{t('参数')}</h4>
      <div class="card">
        {#if recipeChanged}
          <p class="note">{t('调用方式改了：先保存，参数表会按新的卡更新，再来补取值、改默认值。')}</p>
        {:else if !params.length}
          <p class="note">{t('这个模型没有能在这里调的参数。')}</p>
        {:else}
          {#each params as s (s.key)}
            {@const mine = draft.options[s.key] || []}
            <div class="row prow">
              <div class="lab">
                <div class="nm"><span class="nt">{tr(s.label || s.key)}</span><code>{s.key}</code></div>
                {#if s.type === 'enum'}
                  <div class="chips">
                    {#each mine as v (v)}
                      <span class="chip">{v}<button type="button" class="cx" aria-label={t('移除 {v}', { v })} title={t('移除')} onclick={() => dropOption(s.key, v)}>{@html svg(G.close, 2)}</button></span>
                    {/each}
                    {#if adding === s.key}
                      <!-- svelte-ignore a11y_autofocus -->
                      <input class="addin" bind:value={addText} placeholder={t('取值，回车添加')} autofocus spellcheck="false"
                        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOption(s.key); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); adding = ''; addText = ''; } }}
                        onblur={() => addOption(s.key)} aria-label={t('给「{name}」补取值', { name: tr(s.label || s.key) })} />
                    {:else}
                      <button type="button" class="addv" onclick={() => { adding = s.key; addText = ''; }}>{@html svg(G.plus, 1.8)}{t('补取值')}</button>
                    {/if}
                  </div>
                {/if}
              </div>
              <div class="ctl">
                {#if s.type === 'enum'}
                  <select class="sel" bind:value={draft.defaults[s.key]} aria-label={t('{name} 的默认值', { name: tr(s.label || s.key) })}>
                    <option value="">{t('默认 · {v}', { v: cardDefault(s) })}</option>
                    {#each s.options || [] as o (String(o.value))}<option value={String(o.value)}>{o.label ?? o.value}</option>{/each}
                    {#each mine as v (v)}<option value={v}>{v}</option>{/each}
                  </select>
                {:else if s.type === 'bool'}
                  <select class="sel" bind:value={draft.defaults[s.key]} aria-label={t('{name} 的默认值', { name: tr(s.label || s.key) })}>
                    <option value="">{t('默认 · {v}', { v: s.default === undefined ? t('不传') : s.default ? t('开') : t('关') })}</option>
                    <option value="true">{t('开')}</option><option value="false">{t('关')}</option>
                  </select>
                {:else}
                  <input class="in" class:num={s.type === 'number' || s.type === 'seed'} inputmode={s.type === 'number' || s.type === 'seed' ? 'decimal' : undefined}
                    bind:value={draft.defaults[s.key]} placeholder={t('默认 · {v}', { v: cardDefault(s) })} spellcheck="false" aria-label={t('{name} 的默认值', { name: tr(s.label || s.key) })} />
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>
    </section>

    {#if hasExtra}
      <section class="grp">
        <h4 class="gt">{t('额外请求体')}</h4>
        <div class="card pad">
          <textarea class="code sm" rows="4" wrap="off" spellcheck="false" autocomplete="off" bind:value={draft.extra} onkeydown={onTab} placeholder={'{ "moderation": "low" }'} aria-label={t('额外请求体')}></textarea>
          <p class="hint">{t('原样并进每次的请求体；调用时给的 extra 里同名的键压过这里。')}</p>
        </div>
      </section>
    {/if}

    <section class="grp">
      <h4 class="gt">{t('预演与试跑')}</h4>
      <div class="card pad">
        <div class="trow">
          <input class="in grow" bind:value={prompt} placeholder={t('试跑用的描述，例如「一只橘猫，水彩」')} aria-label={t('试跑用的描述')}
            onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); preview(); } }} />
          <button type="button" class="btn" disabled={!!running || !!problem} class:busy={running === 'dry'} onclick={preview}>{t('预演')}</button>
          <button type="button" class="btn" disabled={!!running || !!problem} class:busy={running === 'real'} onclick={trial}>{t('试跑…')}</button>
        </div>
        <p class="hint">{t('都用当前草稿，不用先保存。预演只拼出请求给你看、不花钱；试跑真发一次（会计费），记下每一步的原始请求与响应。要素材的模型请在 Media Studio 里试。')}</p>

        {#if out?.kind === 'err'}
          <p class="oerr" role="alert">{out.error}</p>
        {:else if out?.kind === 'dry'}
          <div class="out">
            {#if out.request}
              <div class="ohead"><span class="mth">{out.request.submit.method}</span><span class="url" title={out.request.submit.url}>{out.request.submit.url}</span></div>
              {#if Object.keys(out.request.submit.headers || {}).length}<pre class="pre">{headerLines(out.request.submit.headers)}</pre>{/if}
              {#if out.request.submit.body}<pre class="pre">{out.request.submit.body}</pre>{/if}
              {#if out.request.poll}<p class="ometa">{t('然后轮询 {p}，直到 {s} 是 {d}', { p: out.request.poll.path || out.request.poll.url, s: out.request.poll.status, d: (out.request.poll.done || []).join(' / ') })}</p>{/if}
            {:else}
              <p class="ometa">{out.note ? tr(out.note) : ''}</p>
            {/if}
            <p class="ometa">{t('实际发的参数')}</p>
            <pre class="pre">{JSON.stringify(out.params || {}, null, 2)}</pre>
            {#if out.warnings}
              <p class="owarn">{t('没照原样生效：{list}', { list: [...(out.warnings.ignored || []).map((x) => (typeof x === 'string' ? x : x.key)), ...(out.warnings.changed || []).map((x) => x.key)].join('、') })}</p>
            {/if}
          </div>
        {:else if out?.kind === 'real'}
          <div class="out">
            <p class="ostate" class:bad={out.job?.state === 'error'}>{stateText(out.job)}{#if !out.done && running}<span class="dots" aria-hidden="true"></span>{/if}</p>
            {#if out.job?.error}<pre class="pre err">{out.job.error}</pre>{/if}
            {#if out.pollErr}<p class="oerr">{out.pollErr}</p>{/if}
            {#each out.trace || [] as st, i (i)}
              <details class="step" open={i === (out.trace || []).length - 1 && out.job?.state === 'error'}>
                <summary>
                  <span class="sn">{tr(st.step)}</span><span class="mth">{st.method}</span><span class="url" title={st.url}>{pathOf(st.url)}</span>
                  <span class="spx"></span>
                  {#if st.response}<span class="code-st" class:bad={st.response.status >= 400}>{st.response.status}</span>{:else if st.error}<span class="code-st bad">{tr(st.error)}</span>{/if}
                  {#if st.ms != null}<span class="ms">{sec(st.ms)}</span>{/if}
                </summary>
                <p class="ometa">{t('请求')}</p>
                {#if Object.keys(st.request?.headers || {}).length}<pre class="pre">{headerLines(st.request.headers)}</pre>{/if}
                {#if st.request?.body}<pre class="pre">{st.request.body}</pre>{/if}
                {#if st.response}<p class="ometa">{t('响应')}{st.response.type ? ' · ' + st.response.type : ''}</p><pre class="pre">{st.response.body}</pre>{/if}
              </details>
            {/each}
          </div>
        {/if}
      </div>
    </section>
    {#if narrow && (err || problem)}<p class="berr" role="alert">{err || problem}</p>{/if}
  {/if}
</HsSheet>

<style>
  .wait { display: flex; align-items: center; gap: 12px; padding: 28px 2px; font-size: 13px; color: var(--st-muted); }
  .ferr2 { color: var(--pm-red); }
  .lead { margin: 14px 2px 0; font-size: 13px; line-height: 1.6; color: var(--st-muted); }
  .grp { margin-top: 22px; }
  .gt { margin: 0 0 8px 4px; font-size: 12px; font-weight: 600; letter-spacing: .04em; color: var(--st-muted); }
  .card { border-radius: 14px; box-shadow: inset 0 0 0 1px var(--st-line); padding: 0 18px; }
  .card.pad { padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
  :global(.narrow) .card { background: var(--st-surface); box-shadow: none; border-radius: 16px; padding-left: 16px; padding-right: 16px; }
  .note { margin: 0; padding: 16px 0; font-size: 12.5px; line-height: 1.55; color: var(--st-muted); }

  .row { display: grid; grid-template-columns: minmax(220px, 1fr) 232px; gap: 6px 28px; align-items: center; padding: 14px 0; }
  .row + .row { border-top: 1px solid var(--st-hair); }
  .prow { align-items: start; }
  .prow .ctl { padding-top: 1px; }
  .nm { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; }
  .nt { font-size: 14px; font-weight: 500; color: var(--text); }
  .nm code, .edt code { font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 11.5px; color: var(--st-muted); }
  .hint { margin: 4px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--st-muted); text-wrap: pretty; }
  .card.pad .hint { margin: 0; }
  .ctl { display: flex; flex-direction: column; align-items: stretch; min-width: 0; }

  .chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 2px; height: 24px; padding: 0 2px 0 9px; border-radius: 7px; background: var(--st-seg);
    font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 12px; color: var(--text); }
  .cx { display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--st-muted); cursor: pointer; }
  .cx :global(svg) { width: 11px; height: 11px; }
  @media (hover: hover) { .cx:hover { background: var(--st-hover); color: var(--text); } }
  .addv { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px 0 6px; border: 0; border-radius: 7px; background: transparent;
    color: var(--st-muted); font: inherit; font-size: 12.5px; cursor: pointer; box-shadow: inset 0 0 0 1px var(--st-hair); }
  .addv :global(svg) { width: 12px; height: 12px; }
  @media (hover: hover) { .addv:hover { color: var(--text); background: var(--st-hover); } }
  .addin { height: 24px; width: 140px; padding: 0 8px; border: 0; border-radius: 7px; background: var(--st-field); color: var(--text); box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 45%, transparent);
    font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 12px; outline: none; }

  .sel, .in { height: 34px; box-sizing: border-box; padding: 0 10px; border: 0; border-radius: 9px; background: var(--st-field); color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line);
    font: inherit; font-size: 13.5px; outline: none; min-width: 0; width: 100%; }
  .in.num { font-variant-numeric: tabular-nums; }
  .in::placeholder { color: var(--st-muted); }
  .sel.sm { flex: 0 1 auto; width: auto; max-width: 300px; height: 28px; font-size: 12.5px; padding: 0 8px; border-radius: 8px; }
  .sel:focus, .in:focus, .code:focus { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 55%, transparent); }

  .ed { display: flex; flex-direction: column; gap: 8px; padding: 2px 0 16px; border-top: 1px solid var(--st-hair); padding-top: 14px; }
  .edbar { display: flex; align-items: center; gap: 8px; }
  .edt { flex: none; display: inline-flex; align-items: baseline; gap: 6px; white-space: nowrap; font-size: 12.5px; font-weight: 600; color: var(--st-text2); }
  .code { display: block; width: 100%; box-sizing: border-box; min-height: 220px; padding: 12px 14px; border: 0; border-radius: 10px; resize: vertical;
    background: var(--st-field); color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line); outline: none; tab-size: 2;
    font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 12.5px; line-height: 1.6; white-space: pre; overflow-x: auto; }
  .code.sm { min-height: 86px; }
  .code::placeholder { color: var(--st-muted); }

  .trow { display: flex; align-items: center; gap: 8px; }
  .grow { flex: 1; width: auto; }
  .out { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--st-hair); }
  .ohead, .step summary { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .mth { flex: none; font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 11.5px; font-weight: 600; color: var(--st-text2); }
  .url { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 12px; color: var(--text); }
  .pre { margin: 0; max-height: 280px; overflow: auto; padding: 10px 12px; border-radius: 9px; background: var(--st-seg); color: var(--text);
    font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; }
  .pre.err { color: var(--pm-red); }
  .ometa { margin: 4px 0 0; font-size: 12px; color: var(--st-muted); }
  .owarn { margin: 0; font-size: 12.5px; color: var(--hh-warn, #c9a227); }
  .oerr { margin: 0; font-size: 12.5px; color: var(--pm-red); }
  .ostate { margin: 0; font-size: 13px; color: var(--text); font-variant-numeric: tabular-nums; }
  .ostate.bad { color: var(--pm-red); }
  .dots::after { content: '…'; display: inline-block; animation: ma-blink 1.2s steps(1) infinite; }
  @keyframes ma-blink { 50% { opacity: .2; } }
  .step { border-radius: 10px; box-shadow: inset 0 0 0 1px var(--st-hair); }
  .step summary { list-style: none; cursor: pointer; padding: 9px 12px; border-radius: 10px; }
  .step summary::-webkit-details-marker { display: none; }
  @media (hover: hover) { .step summary:hover { background: var(--st-hover); } }
  .step[open] { padding-bottom: 10px; }
  .step[open] > :not(summary) { margin-left: 12px; margin-right: 12px; }
  .sn { flex: none; font-size: 12.5px; font-weight: 500; color: var(--text); }
  .code-st { flex: none; font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 12px; color: var(--st-text2); }
  .code-st.bad { color: var(--pm-red); }
  .ms { flex: none; font-size: 11.5px; color: var(--st-muted); font-variant-numeric: tabular-nums; }
  .berr { margin: 12px 0 0; font-size: 13px; color: var(--pm-red); }

  .spx { flex: 1; }
  .ferr { min-width: 0; max-width: 46%; font-size: 12.5px; color: var(--pm-red); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lnk { height: 32px; padding: 0 8px; margin-left: -8px; border: 0; border-radius: 8px; background: transparent; color: var(--st-muted); font: inherit; font-size: 13px; cursor: pointer; }
  @media (hover: hover) { .lnk:hover:not(:disabled) { background: var(--st-hover); color: var(--pm-red); } }
  .btn { flex: none; height: 34px; padding: 0 16px; border: 0; border-radius: 9px; background: var(--st-seg); color: var(--text); font: inherit; font-size: 13.5px; font-weight: 500; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  @media (hover: hover) { .btn:hover:not(:disabled) { background: var(--st-sel); } }
  .btn:active:not(:disabled) { transform: scale(.96); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); }
  .btn.busy { opacity: .7; }
  .btn:focus-visible, .lnk:focus-visible, .addv:focus-visible, .cx:focus-visible, .step summary:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }

  @media (max-width: 699px) {
    .row { grid-template-columns: minmax(0, 1fr); gap: 10px; }
    .trow { flex-wrap: wrap; }
    .grow { flex-basis: 100%; }
    .trow .btn { flex: 1; }
    .btn { height: 44px; padding: 0 18px; font-size: 15px; border-radius: 12px; }
    .sel, .in { height: 44px; border-radius: 12px; font-size: 15px; }
    .sel.sm { height: 34px; font-size: 13px; }
    .code { font-size: 13px; }
    .ferr { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .dots::after { animation: none; } }
</style>
