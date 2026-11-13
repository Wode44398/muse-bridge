<script>
  // 模型中心的浮层层：App 根上第一次要开浮层时懒加载、之后常驻；无 props，按 hubUi.sheet 渲染。
  //   service → HubService（流 U，自带外框）；studio → Studio 的 MediaProviderManager（自带外框，经 loadPage 懒加载，没装扩展就降级）；
  //   vertex / claude / dkey / builtin（Studio 的本机图像模型，HubBuiltin）→ 这里的外框：宽屏居中对话框（.ov-scrim / .ov-panel），窄屏整页从右推入；
  //   sheet 变空后外框先放退场动画再卸载，所以画的是本地的 shown，不直接画 hubUi.sheet。
  // 任一浮层关掉（sheet 由非空变空）后重拉总览与 Claude 服务：首页那几行要跟上刚才的改动。
  import { untrack, tick } from 'svelte';
  import HubService from './HubService.svelte';
  import HubVertex from './HubVertex.svelte';
  import HubBuiltin from './HubBuiltin.svelte';
  import BrandLogo from './BrandLogo.svelte';
  import ProviderEditor from '../claude/providers/ProviderEditor.svelte';
  import { hub, hubUi, loadHub, closeHubSheet, PROTO_NAME } from '../../lib/modelHub.svelte.js';
  import { cp, loadProviders, canUseCustomApi } from '../../lib/claudeProviders.svelte.js';
  import { ds, setVendorKey, errOf, setErr } from '../../lib/dimensioSettings.svelte.js';
  import { loadPage } from '../../modules/pages.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { uiConfirm, uiAlert } from '../../lib/dialogs.js';
  import { activeRequest } from '../../lib/dialogState.svelte.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { DUR, reduced } from '../../lib/motion.js';
  import { providerOf, providerInfo } from '../../../../src/model-knowledge/brands.mjs';
  import { t } from '../../lib/i18n.js';

  const MINE = new Set(['vertex', 'claude', 'dkey', 'builtin']);

  let shown = $state(null);         // 外框正在画的浮层（退场动画期间 hubUi.sheet 已空，它还在）
  let closing = $state(false);
  let dirty = $state(false);        // 当前编辑器有没保存的改动（编辑器经 dirtyOut 报上来）
  // Claude：presets 预设网格 | edit 编辑器 | wait 正在找这份服务
  let view = $state('');
  let cEditing = $state(null);      // 已存的服务 / 预设草稿
  let fromPresets = $state(false);  // 编辑器是从预设网格进来的：返回回网格，而不是关掉
  let editorKey = $state(0);
  let keyInput = $state('');
  let vxLoading = $state(false);
  let cLoading = $state(false);
  let panel = $state(null);

  let prevSheet = null;
  let exitTimer = 0;
  let seq = 0;                      // 异步回来时浮层已换 / 已关：作废那次结果
  let returnTo = null;              // 关掉后把焦点还给打开它的那颗按钮
  let asking = false;

  const NARROW = '(max-width: 699px)';
  let narrow = $state(typeof window !== 'undefined' && !!window.matchMedia?.(NARROW).matches);
  $effect(() => {
    const mq = window.matchMedia?.(NARROW);
    if (!mq) return;
    const on = () => { narrow = mq.matches; };
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  });

  const keyOf = (s) => (s ? s.type + ':' + (s.id || (s.presets ? 'presets' : '') || s.vendor?.id || '') : '');

  $effect(() => {
    const s = hubUi.sheet;
    untrack(() => sync(s));
  });

  function sync(s) {
    const had = prevSheet;
    prevSheet = s;
    if (s && MINE.has(s.type)) {
      // 退场动画还没放完又被打开（连点）：接着用这一层，但内容按新开处理——退场时作废了在途的读取
      const reopen = closing;
      clearTimeout(exitTimer);
      if (!shown && !closing) returnTo = document.activeElement;
      closing = false;
      if (reopen || keyOf(shown) !== keyOf(s)) begin(s);
      shown = s;
    } else if (shown) {
      // 关掉了，或换成了自带外框的 service / studio：这一层放退场
      leave(!s);
    }
    if (had && !s) refresh();
  }

  function begin(s) {
    seq++;
    dirty = false; keyInput = ''; cEditing = null; fromPresets = false; view = ''; asking = false; vxLoading = false; cLoading = false;
    if (s.type === 'claude') {
      if (s.id) openExisting(s.id);
      else { view = 'presets'; if (!cp.ok) reloadClaude(); }
    } else if (s.type === 'vertex') {
      if (!hub.vertex) reloadVertex();
    } else if (s.type === 'dkey') {
      // 上次没存上的报错别带进这一次（只清这一家的，dimensio 设置页上别的报错不动）
      const tag = 'key:' + (s.vendor?.id || '');
      if (ds.errAt === tag) setErr(tag, '');
    }
  }

  function leave(restore) {
    seq++;
    if (closing) return;
    closing = true;
    clearTimeout(exitTimer);
    exitTimer = setTimeout(() => {
      shown = null; closing = false; view = ''; cEditing = null; dirty = false; keyInput = '';
      if (restore && !hubUi.sheet && returnTo?.isConnected) { try { returnTo.focus({ preventScroll: true }); } catch {} }
      returnTo = null;
    }, reduced() ? 0 : DUR.quick + 40);
  }

  function refresh() {
    loadHub(true);
    if (canUseCustomApi()) loadProviders(true);
  }

  function reloadVertex() {
    const my = seq;
    vxLoading = true;
    loadHub(true).finally(() => { if (my === seq) vxLoading = false; });
  }
  function reloadClaude() {
    const my = seq;
    cLoading = true;
    loadProviders(true).finally(() => { if (my === seq) cLoading = false; });
  }

  // 总览里的 Claude 服务只是摘要，编辑器要 cp 里完整的那份；缓存里没有（刚建的、别处删了）就重拉一次再判
  async function openExisting(id) {
    const my = seq;
    let p = cp.providers.find((x) => x.id === id);
    if (!p) {
      view = 'wait';
      cLoading = true;
      await loadProviders(true);
      if (my !== seq) return;
      cLoading = false;
      p = cp.providers.find((x) => x.id === id);
    }
    if (p) { edit(p, false); return; }
    const why = cp.err || t('这个模型服务已被删除');
    closeHubSheet();
    uiAlert(why, { type: 'error' });
  }
  function edit(src, viaPresets) { cEditing = src; fromPresets = viaPresets; editorKey++; dirty = false; view = 'edit'; }
  function pickPreset(pr) {
    edit(pr ? { name: pr.name, note: pr.note || '', preset: pr.id, protocol: pr.protocol, baseUrl: pr.baseUrl, authStyle: pr.authStyle, compat: pr.compat || {}, models: [] }
      : { name: '', protocol: 'anthropic', baseUrl: '', models: [] }, true);
  }

  // 还有上一级可回（从预设网格进的、还没存过的草稿）：返回回网格；否则返回 = 关掉
  const canStepBack = $derived(shown?.type === 'claude' && view === 'edit' && fromPresets && !cEditing?.id);
  function stepBack() { view = 'presets'; cEditing = null; dirty = false; }

  async function okToLeave() {
    if (!dirty) return true;
    if (asking) return false;
    asking = true;
    try { return await uiConfirm(t('有改动没保存，确定放弃？')); }
    finally { asking = false; }
  }
  // 返回键 / Esc / 点遮罩 / 左上角返回：有上一级先回上一级
  async function back() {
    const s = shown;
    if (!s || closing) return;
    if (!(await okToLeave()) || shown !== s || closing) return;
    if (canStepBack) stepBack();
    else closeHubSheet();
  }
  // 右上角关闭：不管在第几级都整个关掉
  async function closeAll() {
    const s = shown;
    if (!s || closing) return;
    if (!(await okToLeave()) || shown !== s || closing) return;
    closeHubSheet();
  }
  // 编辑器自己的「关闭 / 放弃」按钮：它已经表明了要丢掉改动，不再问
  function editorClose() {
    if (canStepBack) stepBack();
    else { dirty = false; closeHubSheet(); }
  }
  function editorDeleted() {
    dirty = false;
    closeHubSheet();
    showToast(t('已删除'));
  }

  // —— dimensio 内置厂商的 Key ——
  const vendor = $derived(shown?.type === 'dkey' ? shown.vendor || null : null);
  const keyTag = $derived(vendor ? 'key:' + vendor.id : '');
  const keyBusy = $derived(!!keyTag && ds.busy === keyTag);
  $effect(() => { if (shown?.type === 'dkey') dirty = !!keyInput.trim(); });
  async function saveKey() {
    const v = vendor;
    if (!v || !keyInput.trim() || keyBusy) return;
    if (await setVendorKey(v.id, keyInput)) {
      if (shown?.vendor?.id !== v.id) return;
      keyInput = '';
      dirty = false;
      showToast(t('已保存'));
      closeHubSheet();
    }
  }

  // —— 关闭的几条路：系统返回、Esc、点遮罩 ——
  $effect(() => {
    if (!shown || closing) return;
    return pushBackLayer(back);
  });
  $effect(() => {
    if (!shown || closing) return;
    // 冒泡阶段、看 defaultPrevented：编辑器里的下拉 / 输入法 / 应用内对话框先接 Esc，它们没要才轮到外框
    const key = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || activeRequest()) return;
      e.preventDefault();
      back();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  // 在框里按下、拖到遮罩上松开（选字时常见）不算点遮罩
  let downOnScrim = false;
  function scrimDown(e) { downOnScrim = e.target === e.currentTarget; }
  function scrimClick(e) {
    const hit = downOnScrim && e.target === e.currentTarget;
    downOnScrim = false;
    if (hit) back();
  }
  // 开出来把焦点挪进框里（读屏从标题读起、Tab 不会落在被盖住的页面上）；Key 表单的输入框自己 autofocus
  $effect(() => {
    if (!panel || !shown || closing) return;
    untrack(() => tick().then(() => { if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true }); }));
  });

  // —— 标题 ——
  const title = $derived(
    !shown ? ''
    : shown.type === 'vertex' ? 'Vertex AI'
    : shown.type === 'builtin' ? builtinOf(shown.id)?.name || t('本机图像模型')
    : shown.type === 'dkey' ? t('{name} 的 API Key', { name: shown.vendor?.name || '' })
    : view === 'edit' && cEditing?.id ? cEditing.name || t('未命名服务')
    : view === 'wait' ? ''
    : t('添加服务'));

  // Studio 的内置媒体服务（总览里带着明细）；找不到 = 已经没了（别处删了 / Studio 关了）
  function builtinOf(id) { return (hub.builtins || []).find((b) => b.id === id) || null; }

  // 预设的品牌标：先按预设 id 认（中转站的域名可能认不出），再按地址认
  function presetLogo(pr) {
    try { return providerInfo(pr.id)?.logo || providerOf(pr.baseUrl)?.logo || ''; } catch { return ''; }
  }
  function hostOf(u) { try { return new URL(u).host; } catch { return u || ''; } }

  // —— Studio 的服务管理器：扩展的组件，只经 loadPage 动态取 ——
  let StudioComp = $state(null);
  $effect(() => {
    if (hubUi.sheet?.type !== 'studio' || StudioComp) return;
    loadPage.studioProviders().then((m) => { StudioComp = m.default; }).catch(() => {
      if (hubUi.sheet?.type !== 'studio') return;
      closeHubSheet();
      uiAlert(t('这台服务器没装 Media Studio'), { type: 'error' });
    });
  });
  const studioKey = $derived(hubUi.sheet?.type === 'studio' ? JSON.stringify(hubUi.sheet.initial || null) : '');
</script>

{#snippet msg(err, retry)}
  <div class="scroll">
    <div class="msg" role={err ? 'alert' : 'status'}>
      <span class="msg-tx">{err || t('正在读取…')}</span>
      {#if err}<button type="button" class="btn" onclick={retry}>{t('重试')}</button>{/if}
    </div>
  </div>
{/snippet}

{#if hubUi.sheet?.type === 'service'}
  <HubService sheet={hubUi.sheet} onClose={closeHubSheet} />
{/if}

{#if hubUi.sheet?.type === 'studio' && StudioComp}
  {#key studioKey}
    <StudioComp onClose={closeHubSheet} initial={hubUi.sheet.initial || null} />
  {/key}
{/if}

{#if shown}
  {@const s = shown}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="hov" class:narrow class:ov-scrim={!narrow} class:closing role="presentation" onpointerdown={scrimDown} onclick={scrimClick}>
    <div class="panel {s.type}" class:ov-panel={!narrow} class:push={narrow} class:closing bind:this={panel}
      role="dialog" aria-modal="true" aria-label={title || t('模型中心')} tabindex="-1">
      <header class="top">
        {#if narrow || canStepBack}
          <button type="button" class="hbtn" aria-label={canStepBack ? t('返回') : t('关闭')} onclick={back}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" /></svg>
          </button>
        {/if}
        <h2 class="t1">{title}</h2>
        {#if narrow}
          <span class="hbtn ghost" aria-hidden="true"></span>
        {:else}
          <button type="button" class="hbtn" aria-label={t('关闭')} onclick={closeAll}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" /></svg>
          </button>
        {/if}
      </header>

      {#if s.type === 'vertex'}
        {#if hub.vertex}
          <!-- HubVertex 打开时取一次快照：等总览里有了 Vertex 才挂它 -->
          <div class="edwrap"><HubVertex onClose={closeHubSheet} bind:dirtyOut={dirty} /></div>
        {:else}
          {@render msg(vxLoading ? '' : hub.err || t('读不到 Vertex 的设置'), reloadVertex)}
        {/if}

      {:else if s.type === 'builtin'}
        {@const b = builtinOf(s.id)}
        {#if b}
          {#key s.id}<div class="edwrap"><HubBuiltin builtin={b} onClose={closeHubSheet} bind:dirtyOut={dirty} /></div>{/key}
        {:else}
          {@render msg(hub.loading ? '' : hub.err || t('这个媒体服务已经不在了'), () => loadHub(true))}
        {/if}

      {:else if s.type === 'claude'}
        {#if view === 'edit' && cEditing}
          <!-- ProviderEditor 自己排版（左侧分区导航 + 右侧正文 + 底栏），这里只给它一块满高的地方 -->
          <div class="edwrap plain">
            {#key editorKey}
              <ProviderEditor source={cEditing} onClose={editorClose} onSaved={(p) => { cEditing = p; dirty = false; }} onDeleted={editorDeleted} bind:dirtyOut={dirty} />
            {/key}
          </div>
        {:else if view === 'presets' && cp.ok}
          <div class="scroll">
            <div class="pgrid">
              <button type="button" class="ptile blank" onclick={() => pickPreset(null)}>
                <span class="av plain" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M10 4.5v11M4.5 10h11" /></svg></span>
                <span class="pn">{t('从头配置')}</span><span class="pu">{t('任意兼容端点')}</span>
              </button>
              {#each cp.presets as pr (pr.id)}
                <button type="button" class="ptile" onclick={() => pickPreset(pr)}>
                  <span class="av"><BrandLogo logo={presetLogo(pr)} name={pr.name} size={34} /></span>
                  <span class="pn">{pr.name}</span>
                  <span class="pu">{pr.note || hostOf(pr.baseUrl)}</span>
                  <span class="tag">{PROTO_NAME[pr.protocol] || pr.protocol || 'Anthropic'}</span>
                </button>
              {/each}
            </div>
          </div>
        {:else}
          {@render msg(cLoading || view === 'wait' ? '' : cp.err || t('读不到模型服务'), reloadClaude)}
        {/if}

      {:else if s.type === 'dkey'}
        <div class="scroll kscroll">
          <div class="keyform">
            <label class="fl" for="hub-vkey">API Key</label>
            <!-- svelte-ignore a11y_autofocus -->
            <input id="hub-vkey" class="in mono" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" autofocus bind:value={keyInput}
              placeholder={vendor?.hasKey ? t('••••••••（留空保持不变）') : t('粘贴 {name} API Key', { name: vendor?.name || '' })}
              onkeydown={(e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveKey(); } }} />
            {#if keyTag && errOf(keyTag)}<div class="err" role="alert">{errOf(keyTag)}</div>{/if}
            <div class="acts">
              <button type="button" class="btn" onclick={back}>{t('取消')}</button>
              <!-- busy：保存中虽然点不了，但不是「不可用」——保持墨色，别跟着禁用态变灰 -->
              <button type="button" class="btn primary" class:busy={keyBusy} disabled={!keyInput.trim() || keyBusy} onclick={saveKey}>{keyBusy ? t('保存中…') : t('保存')}</button>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* 墨与象牙（契约 §8）：HubVertex / ProviderEditor / SToggle 读这组；宽屏对话框与窄屏整页共用。
     --i-* 是窄屏 SToggle（ios27 Toggle 的墨色开关）要的轨道与钮色——这一层挂在 App 根上，不在设置的 .ios 里，得自己补 */
  .hov {
    --pm-bg: #100f0d; --st-surface: #1a1917; --text: #f1ece2;
    --st-text2: rgba(241, 236, 226, .74); --st-muted: rgba(241, 236, 226, .5);
    --st-line: rgba(241, 236, 226, .1); --st-hair: rgba(241, 236, 226, .065);
    --st-sel: rgba(241, 236, 226, .1); --st-hover: rgba(241, 236, 226, .05); --pm-press: rgba(241, 236, 226, .06);
    --st-field: rgba(241, 236, 226, .06); --st-seg: rgba(241, 236, 226, .07); --st-thumb: rgba(241, 236, 226, .2);
    --st-accent: #ebe5d8; --st-primary: #ebe5d8; --st-primary-ink: #151412; --pm-knob-on: #151412;
    --pm-warn: #d9a441; --pm-red: #e2725f;
    --st-backdrop: rgba(0, 0, 0, .5); --st-menu-shadow: 0 24px 70px rgba(0, 0, 0, .45), 0 0 0 1px rgba(241, 236, 226, .08);
    --i-fill1: rgba(241, 236, 226, .19); --i-accent: #ebe5d8; --i-knob: #f1ece2; --i-knob-on: #151412;
    position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; padding: 24px;
    background: var(--st-backdrop);
    color: var(--text);
    font-family: var(--font-brand-sans), -apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  :global(html[data-theme="light"]) .hov {
    --pm-bg: #f2f0eb; --st-surface: #fcfbf8; --text: #1d1b18;
    --st-text2: rgba(29, 27, 24, .72); --st-muted: rgba(29, 27, 24, .5);
    --st-line: rgba(29, 27, 24, .1); --st-hair: rgba(29, 27, 24, .075);
    --st-sel: rgba(29, 27, 24, .08); --st-hover: rgba(29, 27, 24, .04); --pm-press: rgba(29, 27, 24, .055);
    --st-field: rgba(29, 27, 24, .045); --st-seg: rgba(29, 27, 24, .06); --st-thumb: #fff;
    --st-accent: #1d1b18; --st-primary: #1d1b18; --st-primary-ink: #f6f3ec; --pm-knob-on: #fff;
    --pm-warn: #b0741c; --pm-red: #c4473b;
    --st-backdrop: rgba(24, 21, 17, .3); --st-menu-shadow: 0 24px 70px rgba(24, 21, 17, .2), 0 0 0 1px rgba(29, 27, 24, .07);
    --i-fill1: rgba(29, 27, 24, .15); --i-accent: #1d1b18; --i-knob: #fff; --i-knob-on: #fff;
  }

  /* —— 宽屏：居中对话框（进出场动画是全局的 .ov-scrim / .ov-panel，挂 .closing 即出场） —— */
  .panel { display: flex; flex-direction: column; overflow: hidden; overflow: clip; width: min(860px, 100%); height: min(780px, 100%);
    background: var(--st-surface); color: var(--text); border-radius: 22px; box-shadow: var(--st-menu-shadow); outline: none; }
  .panel.claude { width: min(1000px, 100%); }
  /* Key 只有一个输入框：小一号、高度随内容 */
  .panel.dkey { width: min(560px, 100%); height: auto; max-height: 100%; }
  /* Vertex 的内容只有三小节：高度随内容（到 780 封顶、超出在正文里滚），保存栏紧跟内容，不孤零零贴在一大片空白的底边 */
  .panel.vertex { height: auto; max-height: min(780px, 100%); }
  .panel.vertex .edwrap { flex: 0 1 auto; }
  .hov.closing { pointer-events: none; }

  /* 顶栏与服务浮层（HubService）同高同款：在几种浮层之间来回切时标题不上下跳 */
  .top { flex: none; display: flex; align-items: center; gap: 8px; height: 60px; padding: 0 12px 0 18px; box-sizing: border-box; border-bottom: 1px solid var(--st-hair); }
  .top > .hbtn:first-child { margin-left: -8px; }
  .t1 { flex: 1; min-width: 0; margin: 0; font-family: var(--font-brand-serif), Georgia, serif; font-size: 19px; font-weight: 500; letter-spacing: -.01em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hbtn { position: relative; width: 34px; height: 34px; flex: none; display: grid; place-items: center; border: 0; border-radius: 9px; background: transparent; color: var(--st-text2); cursor: pointer;
    transition: background-color var(--mo-micro, 140ms) var(--ea-fade, ease), color var(--mo-micro, 140ms) var(--ea-fade, ease), transform var(--mo-tap, 90ms) var(--ea-std, ease); }
  .hbtn svg { width: 18px; height: 18px; }
  @media (hover: hover) { .hbtn:hover { background: var(--st-hover); color: var(--text); } }
  .hbtn:active { transform: scale(.96); }
  .hbtn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--text) 35%, transparent); }
  /* 宽屏但是触屏（横放的平板）：34 的按钮命中区四周各扩 5px 到 44 */
  @media (pointer: coarse) { .hbtn::after { content: ''; position: absolute; inset: -5px; } }

  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 28px 32px; }
  .kscroll { padding: 22px 24px 22px; }
  .edwrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .edwrap.plain { display: block; }   /* ProviderEditor 的根是 height:100% 的网格，自己排版 */

  .msg { display: flex; align-items: center; gap: 12px; min-height: 44px; font-size: 13.5px; color: var(--st-text2); }
  .msg-tx { flex: 1; min-width: 0; overflow-wrap: anywhere; }

  /* Claude 专用服务的预设网格（同原来的自定义 API 面板） */
  .pgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(196px, 100%), 1fr)); gap: 10px; }
  .ptile { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 14px; border: 1px solid var(--st-line); border-radius: 13px;
    background: var(--st-surface); color: var(--text); font: inherit; text-align: left; cursor: pointer;
    transition: border-color var(--mo-micro, 140ms) var(--ea-fade, ease), background-color var(--mo-micro, 140ms) var(--ea-fade, ease), transform var(--mo-tap, 90ms) var(--ea-std, ease); }
  @media (hover: hover) { .ptile:hover { border-color: color-mix(in srgb, var(--text) 25%, transparent); background: var(--st-hover); } }
  .ptile:active { transform: scale(.98); }
  .ptile:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--text) 35%, transparent); }
  .ptile.blank { border-style: dashed; }
  .av { display: flex; margin-bottom: 8px; }
  .av.plain { width: 34px; height: 34px; place-items: center; justify-content: center; align-items: center; border-radius: 10px; background: var(--st-seg); color: var(--st-text2); }
  .av.plain svg { width: 18px; height: 18px; }
  .pn { max-width: 100%; font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pu { max-width: 100%; font-size: 12px; color: var(--st-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tag { display: inline-flex; align-items: center; height: 20px; margin-top: 6px; padding: 0 7px; border-radius: 6px; background: var(--st-seg); color: var(--st-text2);
    font-size: 11px; font-weight: 500; white-space: nowrap; }

  /* dimensio 内置厂商的 Key（字段标签与服务浮层的连接面板 HsConn 同款：12.5 / 600 / 次要色） */
  .fl { display: block; margin: 0 0 7px 2px; font-size: 12.5px; font-weight: 600; color: var(--st-text2); }
  .in { width: 100%; min-width: 0; height: 38px; padding: 0 12px; border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-field); color: var(--text);
    font: inherit; font-size: 14px; outline: none; transition: border-color var(--mo-micro, 140ms) var(--ea-fade, ease); }
  .in:focus { border-color: color-mix(in srgb, var(--text) 45%, transparent); }
  .in::placeholder { color: var(--st-muted); }
  .in.mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 13px; }
  .err { margin-top: 12px; padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere;
    background: color-mix(in srgb, var(--pm-red) 12%, transparent); color: var(--text); }
  .acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }

  /* 按钮与另外两处同一套：次要钮 = 服务浮层（HubService / HsConn）的透明底 + 内描线；
     表单底部「取消 / 保存」那一对 = 应用内对话框（DialogHost .dh-btn）的实底、14 / 500、最窄 76 */
  .btn { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; padding: 0 16px; border: 0; border-radius: 10px;
    background: transparent; color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line); font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: transform var(--mo-tap, 90ms) var(--ea-std, ease), background-color var(--mo-micro, 140ms) var(--ea-fade, ease), color var(--mo-micro, 140ms) var(--ea-fade, ease),
      opacity var(--mo-micro, 140ms) var(--ea-fade, ease); }
  @media (hover: hover) { .btn:hover:not(:disabled) { background: var(--st-hover); } }
  .btn:active:not(:disabled) { transform: scale(.96); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--text) 35%, transparent); }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); box-shadow: none; }
  @media (hover: hover) { .btn.primary:hover:not(:disabled) { background: var(--st-primary); opacity: .88; } }
  /* 禁用的主按钮：中性底 + 次要字。墨色（暗色下是米色）实心打透明度会发浑，暗色和手机上反而成了全屏最重的一块。
     保存中（.busy）不算禁用：保持墨色，只略淡 */
  .btn.primary:disabled { opacity: 1; background: var(--st-seg); color: var(--st-muted); }
  .btn.primary.busy:disabled { background: var(--st-primary); color: var(--st-primary-ink); opacity: .72; }
  .btn.primary:focus-visible { box-shadow: 0 0 0 2px var(--st-surface), 0 0 0 4px color-mix(in srgb, var(--text) 55%, transparent); }
  .acts .btn { min-width: 76px; font-size: 14px; }
  .acts .btn:not(.primary) { background: var(--st-seg); box-shadow: none; }
  @media (hover: hover) { .acts .btn:not(.primary):hover:not(:disabled) { background: var(--st-sel); } }
  .acts .btn:not(.primary):focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--text) 35%, transparent); }

  /* —— 窄屏：整页，从右推入（设置子页的推入同一节奏），顶部让出状态栏 —— */
  .hov.narrow { padding: 0; align-items: stretch; background: transparent; }
  .narrow .panel, .narrow .panel.claude, .narrow .panel.dkey, .narrow .panel.vertex { width: 100%; height: 100%; max-height: none; border-radius: 0; box-shadow: none; background: var(--pm-bg);
    padding-top: var(--sat, 0px); }
  /* 整页时 Vertex 的保存栏回到页面底边（拇指位） */
  .narrow .panel.vertex .edwrap { flex: 1 1 auto; }
  .panel.push { animation: hov-push var(--mo-page, 420ms) var(--ea-decel, ease-out) both;
    transition: transform var(--mo-quick, 200ms) var(--ea-accel, ease-in), opacity var(--mo-quick, 200ms) var(--ea-fade, ease); }
  .panel.push.closing { transform: translateX(28%); opacity: 0; }
  @keyframes hov-push { from { transform: translateX(28%); opacity: 0; } }
  .narrow .top { display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; gap: 4px; height: 56px; padding: 0 6px; border-bottom: 0; }
  .narrow .top > .hbtn:first-child { margin-left: 0; }
  .narrow .hbtn { width: 44px; height: 44px; border-radius: 50%; color: var(--text); }
  .narrow .hbtn:hover { background: transparent; }
  .narrow .hbtn:active { background: var(--pm-press); transform: none; }
  .narrow .hbtn::after { content: none; }
  .narrow .hbtn.ghost { pointer-events: none; }
  .narrow .hbtn svg { width: 22px; height: 22px; }
  .narrow .t1 { text-align: center; font-family: inherit; font-size: 17px; font-weight: 600; letter-spacing: -.2px; }
  .narrow .scroll { padding: 8px 16px calc(var(--sab, 0px) + 28px); overflow-x: hidden; overscroll-behavior: contain; }
  .narrow .msg { font-size: 15px; padding: 0 4px; }
  .narrow .ptile { border: 0; border-radius: 16px; padding: 16px; }
  .narrow .pgrid { grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr)); }
  .narrow .fl { margin: 0 4px 8px; font-size: 13px; }
  .narrow .in { height: 46px; border: 0; border-radius: 14px; background: var(--st-surface); font-size: 16px; }
  .narrow .in.mono { font-size: 15px; }
  .narrow .err { border-radius: 14px; }
  .narrow .btn { height: 44px; border-radius: 14px; font-size: 15px; }
  .narrow .acts .btn { flex: 1 1 0; min-width: 0; font-size: 15px; }
  .narrow .btn.primary:focus-visible { box-shadow: 0 0 0 2px var(--pm-bg), 0 0 0 4px color-mix(in srgb, var(--text) 55%, transparent); }

  @media (prefers-reduced-motion: reduce) {
    .panel.push { animation: none; transition: none; }
    .hbtn, .ptile, .btn, .in { transition: none; }
    .hbtn:active, .ptile:active, .btn:active:not(:disabled) { transform: none; }
  }
</style>
