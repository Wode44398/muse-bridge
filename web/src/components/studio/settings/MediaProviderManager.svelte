<script>
  // 设置 › Media Studio › 媒体服务的管理面板（以 claude/providers/ProviderManager 为蓝本另做的媒体版，那一份不动）。
  // 两套设置外壳共用，盖在设置页上面：宽屏是居中大对话框，手机（< 700px）是推入的整页（墨与象牙分组列表）。
  // 视图：服务列表 → 选预设 → 编辑器；另有「Google 云凭据」一页（主机凭据卡，一键导入 Vertex 导入的就是它）。
  // 多用户服务器：管理员标了「共享给成员」的卡上带「已共享」；成员的列表下面多一组「管理员共享」的只读卡（点不进编辑器，
  // 看不到地址和 Key）。返回键 / Esc 逐层后退：编辑器 → 列表 → 关闭（编辑器有未保存改动时先问）。
  // 头部出口只有两个：「‹」返回上一层（宽屏只在有上一层时出；手机常驻，到顶就是关）、「×」关整个面板（只宽屏）；
  // 编辑器页脚不再放「关闭」（复核 11-06：桌面上「‹」「×」「关闭」三个出口）。标题两端都用衬线。
  // 模型中心托管的服务（方案 §3.8，managed）：行 / 卡标「模型中心」、不出启用开关；点开不进本地编辑器，关掉面板、打开模型中心的那个服务
  // （连接、Key、模型清单都归模型中心，在这里改了下次同步会被盖掉）。从别处直接要求编辑它（initial.view 'edit'）同样转过去。
  import { onMount, untrack } from 'svelte';
  import SToggle from '../../settings/SToggle.svelte';
  import MediaProviderEditor from './MediaProviderEditor.svelte';
  import VertexCredentials from '../../modelhub/VertexCredentials.svelte';
  import { sp, loadProviders, updateProvider, providerLog, providerKinds, providerSummary, lacksCredential, kindName, kindSvg, logoFor, logOk, logBad, enabledModels, hasNewModels, syncFailed } from '../../../modules/studio/settings.svelte.js';
  import { pushBackLayer } from '../../../lib/nav.js';
  import { uiConfirm, uiAlert } from '../../../lib/dialogs.js';
  import { t, tc, tr } from '../../../lib/i18n.js';
  import { openHubSheet } from '../../../lib/modelHub.svelte.js';

  // initial：{ view: 'list' | 'presets' | 'edit' | 'google', id?, only? }——设置页上点某个服务直接进它的编辑器；
  // only 是预设 id 白名单（模型中心接管「地址 + Key」类服务后，设置页只从这里加 Vertex / 本机，不出「从头配置」）
  let { onClose, initial = null } = $props();

  const init = untrack(() => initial) || {};
  let view = $state(init.view === 'edit' && !init.id ? 'list' : init.view || 'list');   // list | presets | edit | google
  // 直接要编辑的服务已在缓存里（设置页列着它）：托管的一帧都不画、挂上就转去模型中心；普通的先用缓存开编辑器，拉完再换新
  const cached = init.view === 'edit' && init.id ? untrack(() => sp.providers.find((x) => x.id === init.id)) || null : null;
  const redirecting = !!cached?.managed;
  let editing = $state(cached && !cached.managed ? cached : null);
  let editorKey = $state(0);
  let health = $state({});            // 服务 id → 'ok' | 'bad' | ''（最近一条请求）
  let toggling = $state({});
  // 直接从设置页进编辑器 / 凭据页的，后退一步就关面板（不先落到列表）
  const directEntry = init.view === 'edit' || init.view === 'google' || init.view === 'presets';

  const NARROW = '(max-width: 699px)';
  let narrow = $state(typeof window !== 'undefined' && window.matchMedia?.(NARROW).matches);

  onMount(() => {
    if (redirecting) { openHub(cached); return; }
    loadProviders(true).then(() => {
      refreshHealth();
      if (init.view === 'edit' && init.id && view === 'edit') {
        const p = sp.providers.find((x) => x.id === init.id);
        if (p?.managed) openHub(p);
        else if (p) { if (!editorDirty) openEdit(p); }   // 先用缓存开的编辑器已经在改了：不拿新数据盖掉
        else view = 'list';
      }
    });
    const off = pushBackLayer(back);
    const key = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); back(); } };
    window.addEventListener('keydown', key);
    const mq = window.matchMedia?.(NARROW);
    const onMq = () => { narrow = mq.matches; };
    mq?.addEventListener?.('change', onMq);
    return () => { off(); window.removeEventListener('keydown', key); mq?.removeEventListener?.('change', onMq); };
  });

  async function refreshHealth() {
    const out = {};
    await Promise.all(sp.providers.map(async (p) => {
      try { const l = await providerLog(p.id); out[p.id] = l.length ? (logOk(l[0]) ? 'ok' : logBad(l[0]) ? 'bad' : '') : ''; } catch { out[p.id] = ''; }
    }));
    health = out;
  }

  let editorDirty = $state(false);
  let asking = false;
  async function back() {
    if (view === 'edit') {
      if (editorDirty) {
        if (asking) return;
        asking = true;
        const ok = await uiConfirm(t('有改动没保存，确定放弃？')).finally(() => { asking = false; });
        if (!ok) return;
      }
      editing = null; editorDirty = false;
      if (directEntry) { onClose?.(); return; }
      view = 'list'; refreshHealth();
      return;
    }
    if ((view === 'presets' || view === 'google') && !directEntry) { view = 'list'; return; }
    onClose?.();
  }
  // 「×」：关整个面板（编辑器有没保存的改动先问）
  async function closeAll() {
    if (view === 'edit' && editorDirty) {
      if (asking) return;
      asking = true;
      const ok = await uiConfirm(t('有改动没保存，确定放弃？')).finally(() => { asking = false; });
      if (!ok) return;
    }
    editing = null; editorDirty = false;
    onClose?.();
  }
  // 宽屏的「‹」只在有上一层时出（直接从设置页进来的、列表页没有上一层，只留「×」）
  const canBack = $derived(view !== 'list' && !directEntry);
  function openEdit(src) { editing = src; editorKey++; view = 'edit'; editorDirty = false; }
  // 托管服务：先关面板（两层盖在一起返回键会乱），再打开模型中心的那个服务
  function openHub(p) { onClose?.(); openHubSheet({ type: 'service', id: p.hubRef }); }
  const openRow = (p) => (p.managed ? openHub(p) : openEdit(p));
  function pickPreset(pr) {
    openEdit(pr
      ? { name: tr(pr.name), preset: pr.id, dialect: pr.dialect, baseUrl: pr.baseUrl || '', authStyle: pr.authStyle || 'bearer',
          models: (pr.models || []).map((m) => ({ id: m.id, label: m.label || m.id, kind: m.kind, enabled: true, source: 'builtin', card: m.card || '', defaults: {} })) }
      : { name: '', preset: 'custom', dialect: 'openai', baseUrl: '', authStyle: 'bearer', models: [] });
  }
  async function toggleEnabled(p, v) {
    toggling = { ...toggling, [p.id]: true };
    try { await updateProvider(p.id, { enabled: v }); } catch (e) { uiAlert(e.message || String(e), { type: 'error' }); }
    toggling = { ...toggling, [p.id]: false };
  }

  const hue = (s) => { let h = 0; for (const c of String(s || '?')) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
  const firstChar = (s) => (String(s || '?').trim().match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
  const host = (u) => { try { return new URL(u).host; } catch { return u || ''; } };
  const logoOf = logoFor;
  // 服务的第二行：导入的写「导入自 Vertex」，Google 系写项目，其余写地址
  const subOf = (p) => (p.dialect === 'vertex' ? (p.google?.project || (p.google?.credMode === 'adc' ? t('沿用主机的 Google 凭据') : p.saProject || '')) : host(p.baseUrl));
  const DIALECT = { vertex: 'Vertex AI', gemini: 'Gemini API', openai: 'OpenAI', openrouter: 'OpenRouter', fal: 'fal', replicate: 'Replicate', elevenlabs: 'ElevenLabs', minimax: 'MiniMax', ark: () => t('火山方舟'), local: () => t('本机') };
  const dialectName = (d) => { const v = DIALECT[d]; return typeof v === 'function' ? v() : v || d || ''; };
  const title = $derived(view === 'edit' ? (!editing ? t('媒体服务') : editing.id ? tr(editing.name) : t('添加媒体服务')) : view === 'presets' ? t('添加媒体服务') : view === 'google' ? t('Google 云凭据') : t('媒体服务'));
  const sum = $derived(providerSummary());
  const modelCount = (p) => enabledModels(p).length;
  const only = Array.isArray(init.only) && init.only.length ? init.only : null;
  const presets = $derived(only ? sp.presets.filter((x) => only.includes(x.id)) : sp.presets);
  const hasCustomPreset = $derived(presets.some((x) => x.id === 'custom'));
</script>

{#snippet avatar(p)}
  {#if logoOf(p)}<span class="av logo">{@html logoOf(p)}</span>{:else}<span class="av" style:--h={hue(p.name)}>{firstChar(p.name)}</span>{/if}
{/snippet}
{#snippet chev()}
  <svg class="chev" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg>
{/snippet}
{#snippet kinds(list)}
  <span class="kinds">{#each list as k (k)}<span class="kd" data-k={k}>{@html kindSvg(k)}{kindName(k)}</span>{/each}</span>
{/snippet}

<!-- 要编辑的是托管服务、缓存里就认得出：整块不画（挂上就关面板转去模型中心），免得闪一帧本地编辑器 -->
{#if !redirecting}
<div class="ov" class:narrow role="presentation" onclick={(e) => { if (e.target === e.currentTarget && view !== 'edit') onClose?.(); }}>
  <div class="dlg" role="dialog" aria-modal="true" aria-label={title}>
    <header class="top">
      {#if canBack || narrow}
        <button type="button" class="hbtn" aria-label={canBack ? t('返回') : t('关闭')} onclick={back}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg></button>
      {/if}
      <div class="ttl">
        <div class="t1">{title}</div>
      </div>
      {#if narrow}
        <span class="hbtn ghost" aria-hidden="true"></span>
      {:else}
        <button type="button" class="hbtn" aria-label={t('关闭')} onclick={closeAll}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 5l10 10M15 5 5 15"/></svg></button>
      {/if}
    </header>

    {#if view === 'list' && narrow}
      <div class="scroll">
        {#if sp.err}<div class="note warn">{sp.err}</div>{/if}
        {#if sp.providers.length}<div class="ghead">{t('{p} 个服务 · {m} 个模型', { p: sum.p, m: sum.m })}</div>{/if}
        <div class="ig">
          {#each sp.providers as p (p.id)}
            <div class="row" class:dis={p.enabled === false}>
              <button type="button" class="row-hit" aria-label={p.managed ? t('在模型中心打开 {name}', { name: tr(p.name) }) : t('编辑 {name}', { name: tr(p.name) })} onclick={() => openRow(p)}></button>
              {@render avatar(p)}
              <div class="rtx">
                <div class="n1"><span class="nm">{tr(p.name)}</span>{#if !p.managed && hasNewModels(p)}<span class="nw" title={t('有新模型')}>{t('新')}</span>{/if}{#if health[p.id]}<span class="hdot" class:ok={health[p.id] === 'ok'} class:bad={health[p.id] === 'bad'}></span>{/if}</div>
                <div class="n2">
                  {@render kinds(providerKinds(p))}
                  {#if p.managed}<span class="flag hub">{t('模型中心')}</span>{/if}
                  {#if lacksCredential(p)}<span class="flag warn">{t('缺 Key')}</span>{/if}
                  {#if !p.managed && syncFailed(p)}<span class="flag bad">{tc('巡检', '检查失败')}</span>{/if}
                  {#if p.shared && sp.canShare}<span class="flag">{t('已共享')}</span>{/if}
                </div>
              </div>
              <!-- 托管服务的启停在模型中心：这里换成去那边的箭头 -->
              {#if p.managed}{@render chev()}{:else}<div class="c-sw"><SToggle checked={p.enabled !== false} disabled={!!toggling[p.id]} onchange={(v) => toggleEnabled(p, v)} label={t('启用 {name}', { name: tr(p.name) })} /></div>{/if}
            </div>
          {/each}
          <button type="button" class="row add" onclick={() => (view = 'presets')}>
            <span class="av plain"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M10 4.5v11M4.5 10h11"/></svg></span>
            <span class="add-tx">{t('添加服务')}</span>
          </button>
        </div>
        {#if sp.shared.length}
          <div class="ghead">{t('管理员共享给你的服务')}</div>
          <div class="ig">
            {#each sp.shared as p (p.id)}
              <div class="row ro" class:dis={p.enabled === false}>
                {@render avatar(p)}
                <div class="rtx">
                  <div class="n1"><span class="nm">{tr(p.name)}</span></div>
                  <div class="n2">{@render kinds(providerKinds(p))}<span class="num">{t('{n} 个模型', { n: (p.models || []).length })}</span></div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

    {:else if view === 'presets' && narrow}
      <div class="scroll">
        {#if !hasCustomPreset && !only}
          <div class="ig">
            <button type="button" class="row" onclick={() => pickPreset(null)}>
              <span class="av plain"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg></span>
              <span class="rtx"><span class="n1"><span class="nm">{t('从头配置')}</span></span></span>
              {@render chev()}
            </button>
          </div>
        {/if}
        <div class="ig">
          {#each presets as pr (pr.id)}
            <button type="button" class="row" onclick={() => pickPreset(pr)}>
              {@render avatar({ preset: pr.id, dialect: pr.dialect, name: pr.name })}
              <span class="rtx"><span class="n1"><span class="nm">{tr(pr.name)}</span></span></span>
              {@render chev()}
            </button>
          {/each}
        </div>
      </div>

    {:else if view === 'list'}
      <div class="scroll">
        <div class="intro">
          <div class="intro-tx">{#if sp.providers.length}<span class="meta">{t('{p} 个服务 · {m} 个模型', { p: sum.p, m: sum.m })}</span>{/if}</div>
          <button type="button" class="btn primary" onclick={() => (view = 'presets')}>＋ {t('添加服务')}</button>
        </div>
        {#if sp.err}<div class="note warn">{sp.err}</div>{/if}
        {#if sp.providers.length}
          <div class="grid">
            {#each sp.providers as p (p.id)}
              <div class="card" class:dis={p.enabled === false}>
                <button type="button" class="card-hit" aria-label={p.managed ? t('在模型中心打开 {name}', { name: tr(p.name) }) : t('编辑 {name}', { name: tr(p.name) })} onclick={() => openRow(p)}></button>
                <div class="c-top">
                  {@render avatar(p)}
                  <div class="c-name">
                    <div class="n1">{tr(p.name)}{#if !p.managed && hasNewModels(p)}<span class="nw" title={t('有新模型')}>{t('新')}</span>{/if}{#if health[p.id]}<span class="hdot" class:ok={health[p.id] === 'ok'} class:bad={health[p.id] === 'bad'} title={health[p.id] === 'ok' ? t('最近一次请求成功') : t('最近一次请求失败')}></span>{/if}</div>
                    <div class="n2">{subOf(p)}</div>
                  </div>
                  <!-- 托管服务的启停、Key、模型都在模型中心改；这里只留去那边的箭头，免得两头开关打架 -->
                  {#if p.managed}<span class="c-go">{@render chev()}</span>{:else}<div class="c-sw" title={t('启用：关掉后它的模型不再出现在 Media Studio 里')}><SToggle checked={p.enabled !== false} disabled={!!toggling[p.id]} onchange={(v) => toggleEnabled(p, v)} label={t('启用 {name}', { name: tr(p.name) })} /></div>{/if}
                </div>
                <!-- 卡上只留模型数和要处理的状态；方言、种类、导入来源、共享这些在编辑器里（复核 11-06：每张卡六七个胶囊太像模板） -->
                <div class="c-tags">
                  <span class="tag">{t('{n} 个模型', { n: modelCount(p) })}</span>
                  {#if p.managed}<span class="tag hub" title={t('这个服务由模型中心管理，请到 设置 › 模型中心 里改')}>{t('模型中心')}</span>{/if}
                  {#if lacksCredential(p)}<span class="tag warn">{t('缺 Key')}</span>{/if}
                  {#if !p.managed && syncFailed(p)}<span class="tag bad">{tc('巡检', '检查失败')}</span>{/if}
                </div>
              </div>
            {/each}
          </div>
        {:else if !sp.shared.length}
          <div class="empty">
            <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="13" width="46" height="38" rx="9"/><circle cx="22" cy="40" r="3.2"/><circle cx="32" cy="27" r="3.2"/><circle cx="42" cy="36" r="3.2"/><path d="M24.4 37.6 29.6 29.6M34.6 28.9l5 5"/></svg>
            <div class="e1">{t('还没有接入任何媒体服务')}</div>
            <button type="button" class="btn primary" onclick={() => (view = 'presets')}>＋ {t('添加服务')}</button>
          </div>
        {/if}
        {#if sp.shared.length}
          <div class="meta">{t('管理员共享给你的服务')}</div>
          <div class="grid shared">
            {#each sp.shared as p (p.id)}
              <div class="card ro" class:dis={p.enabled === false}>
                <div class="c-top">
                  {@render avatar(p)}
                  <div class="c-name"><div class="n1">{tr(p.name)}</div><div class="n2">{dialectName(p.dialect)}</div></div>
                </div>
                <div class="c-tags">
                  <span class="tag">{t('{n} 个模型', { n: (p.models || []).length })}</span>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

    {:else if view === 'presets'}
      <div class="scroll">
        <div class="pgrid">
          {#if !hasCustomPreset && !only}
            <button type="button" class="ptile blank" onclick={() => pickPreset(null)}>
              <span class="av plain"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg></span>
              <span class="pn">{t('从头配置')}</span>
            </button>
          {/if}
          {#each presets as pr (pr.id)}
            <button type="button" class="ptile" onclick={() => pickPreset(pr)}>
              {@render avatar({ preset: pr.id, dialect: pr.dialect, name: pr.name })}
              <span class="pn">{tr(pr.name)}</span>
            </button>
          {/each}
        </div>
      </div>

    {:else if view === 'google'}
      <div class="scroll gscroll">
        <div class="vxwrap"><VertexCredentials onchange={() => loadProviders(true)} /></div>
      </div>

    {:else if editing}
      <div class="edwrap">
        {#key editorKey}
          <MediaProviderEditor source={editing}
            onClose={() => { editing = null; editorDirty = false; if (directEntry) onClose?.(); else { view = 'list'; refreshHealth(); } }}
            onSaved={(p) => { editing = p; editorDirty = false; }}
            onDeleted={() => { editing = null; editorDirty = false; if (directEntry) onClose?.(); else view = 'list'; }}
            bind:dirtyOut={editorDirty} />
        {/key}
      </div>
    {:else}
      <!-- 直接要编辑、缓存里还没有：等列表拉回来再定（普通的开编辑器、托管的转模型中心、没了回列表），不先画一张空白的「添加」表单 -->
      <div class="edwrap"></div>
    {/if}
  </div>
</div>
{/if}

<style>
  /* 墨与象牙（同设置页 .ios / 方案 §5.1 的 --sd-*）：宽屏对话框与窄屏整页都用这一组，编辑器、开关、分段跟着换。
     暗色是默认 :root，亮色是 html[data-theme="light"]。种类不着色（§5.2）：种类只靠线稿字形和文字区分。 */
  .ov {
    --pm-bg: #100f0d; --st-surface: #1a1917; --text: #f1ece2;
    --st-text2: rgba(241, 236, 226, .74); --st-muted: rgba(241, 236, 226, .5);
    --st-line: rgba(241, 236, 226, .1); --st-hair: rgba(241, 236, 226, .065);
    --st-sel: rgba(241, 236, 226, .1); --st-hover: rgba(241, 236, 226, .05); --pm-press: rgba(241, 236, 226, .06);
    --st-field: rgba(241, 236, 226, .06); --st-seg: rgba(241, 236, 226, .07); --st-thumb: rgba(241, 236, 226, .2);
    --st-accent: #ebe5d8; --st-primary: #ebe5d8; --st-primary-ink: #151412; --pm-knob-on: #151412; --pm-warn: #d9a441;
    --st-backdrop: rgba(0, 0, 0, .5); --st-menu-shadow: 0 24px 70px rgba(0, 0, 0, .45), 0 0 0 1px rgba(241, 236, 226, .08);
    position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; padding: 24px;
    background: var(--st-backdrop); animation: fade .16s ease;
    font-family: var(--font-brand-sans), -apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased; color: var(--text);
    --i-knob-on: var(--pm-knob-on);   /* 墨色开关开着时的钮：暗色轨道是浅米色，钮要深（原来只有窄屏那条规则管，桌面暗色是白钮压浅轨看不见） */
  }
  :global(html[data-theme="light"]) .ov {
    --pm-bg: #f2f0eb; --st-surface: #fcfbf8; --text: #1d1b18;
    --st-text2: rgba(29, 27, 24, .72); --st-muted: rgba(29, 27, 24, .5);
    --st-line: rgba(29, 27, 24, .1); --st-hair: rgba(29, 27, 24, .075);
    --st-sel: rgba(29, 27, 24, .08); --st-hover: rgba(29, 27, 24, .04); --pm-press: rgba(29, 27, 24, .055);
    --st-field: rgba(29, 27, 24, .045); --st-seg: rgba(29, 27, 24, .06); --st-thumb: #fff;
    --st-accent: #1d1b18; --st-primary: #1d1b18; --st-primary-ink: #f6f3ec; --pm-knob-on: #fff; --pm-warn: #b0741c;
    --st-backdrop: rgba(24, 21, 17, .3); --st-menu-shadow: 0 24px 70px rgba(24, 21, 17, .2), 0 0 0 1px rgba(29, 27, 24, .07);
  }
  @keyframes fade { from { opacity: 0; } }
  .dlg { width: min(1000px, 100%); height: min(780px, 100%); display: flex; flex-direction: column; overflow: hidden;
    background: var(--st-surface); color: var(--text); border-radius: 22px; box-shadow: var(--st-menu-shadow);
    animation: pop .22s cubic-bezier(.2, .9, .3, 1.08); }
  @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.985); } }
  .top { flex: none; display: flex; align-items: center; gap: 8px; height: 58px; padding: 0 12px 0 18px; border-bottom: 1px solid var(--st-hair); }
  .ttl { flex: 1; min-width: 0; }
  .t1 { font-family: var(--font-brand-serif), Georgia, serif; font-size: 19px; font-weight: 500; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hbtn { width: 34px; height: 34px; flex: none; display: grid; place-items: center; border: 0; border-radius: 9px; background: transparent; color: var(--st-text2); cursor: pointer; }
  .hbtn:hover { background: var(--st-hover); color: var(--text); }
  .hbtn svg { width: 18px; height: 18px; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 24px 28px 32px; }
  .edwrap { flex: 1; min-height: 0; }
  .intro { display: flex; align-items: center; gap: 24px; }   /* 标题 + 添加服务，不再配一段介绍（2026-11-06） */
  .intro-tx { flex: 1; min-width: 0; }
  .note { margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: var(--st-seg); font-size: 13px; color: var(--st-text2); line-height: 1.55; }
  .note.warn { background: color-mix(in srgb, var(--pm-warn) 16%, transparent); color: var(--text); }
  .meta { margin: 22px 0 10px; font-size: 12.5px; color: var(--st-muted); }
  .intro .meta { display: block; margin: 0; font-size: 13px; }
  .intro + .grid { margin-top: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(290px, 100%), 1fr)); gap: 12px; }
  .card { min-width: 0; position: relative; padding: 16px; border: 1px solid var(--st-line); border-radius: 14px; background: var(--st-surface); transition: border-color .15s, background-color .15s; }
  .card:hover { border-color: color-mix(in srgb, var(--text) 24%, transparent); background: color-mix(in srgb, var(--st-seg) 40%, var(--st-surface)); }
  .card.ro:hover { border-color: var(--st-line); background: var(--st-surface); }
  .card.dis .c-name, .card.dis .c-tags, .card.dis .av { opacity: .5; }
  .card-hit { position: absolute; inset: 0; border: 0; background: transparent; border-radius: inherit; cursor: pointer; }
  .c-top { position: relative; display: flex; align-items: center; gap: 12px; pointer-events: none; }
  .c-sw { pointer-events: auto; }
  .av { --h: 20; width: 38px; height: 38px; flex: none; display: grid; place-items: center; border-radius: 11px; font-weight: 600; font-size: 16px;
    color: var(--st-text2); background: var(--st-seg); }   /* 没有品牌标的服务：中性首字方块（不按名字取色，方案 §5.2） */
    .av.plain { color: var(--st-text2); background: var(--st-seg); }
  /* 品牌标统一灰度（方案 §5.2）；首字头像（无品牌标的 .av）按名字取色，不算 */
  .av.logo { color: var(--text); background: var(--st-seg); box-shadow: inset 0 0 0 1px var(--st-hair); filter: grayscale(1); opacity: .85; }
  .av.logo :global(svg) { width: 58%; height: 58%; display: block; }
  .av.logo { filter: grayscale(1) brightness(1.8); }   /* 暗色（默认）：彩色品牌标去色后太暗，提亮 */
  :global(html[data-theme="light"]) .av.logo { color: var(--text); filter: grayscale(1); }
  :global(html[data-theme="light"]) .av.plain { color: var(--st-text2); }
  .av.plain svg { width: 18px; height: 18px; }
  .c-name { flex: 1; min-width: 0; }
  .n1 { display: flex; align-items: center; gap: 7px; font-size: 14.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .n2 { margin-top: 2px; font-size: 12px; color: var(--st-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hdot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--st-muted); }
  .hdot.ok { background: #3fa46a; box-shadow: 0 0 0 3px color-mix(in srgb, #3fa46a 18%, transparent); }
  .hdot.bad { background: #d9534f; box-shadow: 0 0 0 3px color-mix(in srgb, #d9534f 18%, transparent); }
  .c-tags { position: relative; display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; pointer-events: none; }
  .tag { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 7px; background: var(--st-seg); color: var(--st-text2); font-size: 11.5px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tag.warn { background: color-mix(in srgb, var(--pm-warn) 18%, transparent); color: var(--pm-warn); }
  .tag.bad { background: color-mix(in srgb, #d9534f 14%, transparent); color: #d9534f; }
  /* 模型中心托管：墨色描线小签（不是状态色，只说明「归谁管」）；卡右上角换成去模型中心的箭头 */
  .tag.hub { background: transparent; box-shadow: inset 0 0 0 1px var(--st-line); color: var(--text); }
  .c-go { flex: none; display: flex; align-items: center; }
  /* 有 7 天内新发现的模型：墨色小字「新」（朱色只留给「正在发生」，这里没有） */
  .nw { flex: none; display: inline-flex; align-items: center; height: 15px; padding: 0 4px; border-radius: 4px; font-size: 10.5px; font-weight: 500; line-height: 1; letter-spacing: .02em; color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line); }
  /* 种类字形：12px 线稿，颜色跟文字（方案 §5.2：种类不着色） */
  .kd :global(svg) { width: 12px; height: 12px; flex: none; }
  .kinds { display: inline-flex; flex-wrap: wrap; gap: 4px 10px; min-width: 0; }
  .kinds .kd { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--st-muted); white-space: nowrap; }
  .grid.shared { margin-bottom: 8px; }
  .empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 56px 20px 24px; color: var(--st-muted); }
  .empty svg { width: 64px; height: 64px; opacity: .55; margin-bottom: 14px; }
  .e1 { font-size: 15px; color: var(--text); font-weight: 500; }
  .pgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr)); gap: 10px; }
  .ptile { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 14px; border: 1px solid var(--st-line); border-radius: 14px; background: var(--st-surface); color: var(--text); font: inherit; text-align: left; cursor: pointer; transition: border-color .15s, background-color .15s; }
  .ptile:hover { border-color: color-mix(in srgb, var(--text) 25%, transparent); background: var(--st-hover); }
  .ptile .av { margin-bottom: 8px; width: 34px; height: 34px; font-size: 15px; border-radius: 10px; }
  .ptile.blank { border-style: dashed; }
  .pn { font-size: 14px; font-weight: 600; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 16px; border: 1px solid var(--st-line); border-radius: 999px; background: var(--st-surface); color: var(--text); font: inherit; font-size: 13.5px; cursor: pointer; white-space: nowrap; flex: none; }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); border-color: transparent; }
  .btn.primary:hover { opacity: .88; }
  /* 凭据卡读 --i-*：在这里映射到面板的墨与象牙 */
  .vxwrap { max-width: 640px; --i-card: var(--st-seg); --i-label: var(--text); --i-label2: var(--st-muted); --i-label3: var(--st-muted);
    --i-sep: var(--st-line); --i-accent: var(--st-accent); --i-on-accent: var(--st-primary-ink); --i-fill3: var(--st-seg); --i-bg: var(--st-field);
    --i-ok: #3fa46a; --i-red: #d9534f; }

  /* ── 窄屏（手机 / 窄窗口）：设置页同款整页 ── */
  .ov.narrow { padding: 0; align-items: stretch; background: transparent; animation: none; }
  .ov.narrow .dlg { width: 100%; height: 100%; border-radius: 0; box-shadow: none; background: var(--pm-bg);
    padding-top: var(--sat, 0px); animation: push .34s cubic-bezier(.2, .95, .25, 1) both; }
  @keyframes push { from { transform: translateX(28%); opacity: 0; } }
  .ov.narrow :global(.tg) { width: 46px; height: 28px; }
  .ov.narrow :global(.tg .knob) { width: 24px; height: 24px; }
  .ov.narrow :global(.tg.on .knob) { transform: translateX(18px); background: var(--pm-knob-on); }
  .ov.narrow .top { display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; gap: 4px; height: 52px; padding: 0 6px; border-bottom: 0; }
  .ov.narrow .hbtn { width: 44px; height: 44px; border-radius: 50%; color: var(--text); }
  .ov.narrow .hbtn:hover { background: transparent; }
  .ov.narrow .hbtn:active { background: var(--pm-press); }
  .ov.narrow .hbtn.ghost { pointer-events: none; }
  .ov.narrow .hbtn svg { width: 22px; height: 22px; }
  .ov.narrow .ttl { text-align: center; }
  .ov.narrow .t1 { font-size: 18px; }   /* 手机同样用衬线（和宽屏一致），只是小一号 */
  .ov.narrow .scroll { padding: 6px 16px calc(var(--sab, 0px) + 28px); overflow-x: hidden; overscroll-behavior: contain; }
  .ov.narrow .note { margin: 0 0 14px; }
  .ov.narrow .vxwrap { --i-card: var(--st-surface); }
  .ghead { padding: 10px 16px 8px; font-size: 13px; line-height: 18px; font-weight: 500; color: var(--st-muted); }
  .ig { background: var(--st-surface); border-radius: 18px; overflow: hidden; }
  .ig + .ig, .ig + .ghead { margin-top: 22px; }
  .e1 + .btn { margin-top: 18px; }
  .row { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 64px; padding: 10px 14px;
    border: 0; background: transparent; color: var(--text); font: inherit; text-align: left; -webkit-tap-highlight-color: transparent; }
  button.row { cursor: pointer; }
  button.row:active, .row-hit:active { background: var(--pm-press); }
  .row + .row::before { content: ''; position: absolute; top: 0; left: 62px; right: 0; height: 1px; background: var(--st-hair); }
  .row-hit { position: absolute; inset: 0; border: 0; padding: 0; background: transparent; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .row .av { width: 36px; height: 36px; border-radius: 10px; font-size: 15px; }
  .rtx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .ov.narrow .n1 { font-size: 16px; line-height: 21px; font-weight: 500; letter-spacing: -.1px; }
  .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ov.narrow .n2 { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; font-size: 13px; line-height: 18px; overflow: hidden; }
  .n2 .flag { flex: none; font-size: 12.5px; color: var(--st-muted); }
  .n2 .num { flex: none; font-size: 12.5px; color: var(--st-muted); }
  .flag.warn { color: var(--pm-warn); }
  .flag.bad { color: #d9534f; }
  .flag.hub { color: var(--st-text2); }
  .row .c-sw { position: relative; z-index: 1; flex: none; display: flex; }
  .row.dis .av, .row.dis .rtx { opacity: .45; }
  .row.add { min-height: 56px; }
  .add-tx { font-size: 16px; font-weight: 500; }
  .chev { flex: none; width: 16px; height: 16px; color: var(--st-muted); opacity: .7; }
</style>
