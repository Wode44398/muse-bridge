<script>
  // 「一键导入 Vertex」卡（管理员，设置 › Media Studio 最上面）：把这台服务器上现有的 Vertex 配置——Google 云凭据、
  // Gemini API Key、OpenRouter Key、本机图像模型——一次性变成 Studio 的服务（POST /api/studio/providers/import-vertex）。
  //   没导入过：四样各一行（可导入 / 未配置），一枚主按钮；Google 云凭据那一行点进去配凭据（onOpenGoogle）；
  //   导入过：缩成一行——标题、导入时间、「重新导入」（幂等：就地更新）；Google 云凭据还没配的，下面留那一行可点
  //   （只导了 Gemini / OpenRouter Key 时，这是配 Vertex 凭据的入口之一，缩起来就找不到了）；
  //   刚点完：逐项回显成了哪几项、缺了哪几项和原因，「完成」收起；Google 那项缺着的照样点得进凭据页。
  // 不写解释句（2026-11-06 维护者：设置页小字太多、像 AI 生成）。导入后 Google 云凭据在 Vertex 服务编辑器的「连接」区。
  // 两套外壳都放：颜色读外层 StudioSettings 根上统一好的 --c-*。
  import { sp, importVertex, importedProviders, lastImportAt, IMPORT_ITEMS, importStatusText, trErr } from '../../../modules/studio/settings.svelte.js';
  import { providerLogo } from '../../../lib/providerLogos.js';
  import { agentMark } from '../../../lib/settingsIcons.js';
  import { ui } from '../../../lib/state.svelte.js';
  import { t } from '../../../lib/i18n.js';

  // onOpenProvider：老接口，外壳还在传（导入出来的服务就列在下面「媒体服务」里）
  let { onOpenProvider = () => {}, onOpenGoogle = () => {} } = $props();

  const LOGO = { google: 'vertex', gemini: 'gemini', openrouter: 'openrouter', local: 'local-image' };
  const logo = (id) => providerLogo({ preset: LOGO[id] });
  const avail = $derived(sp.vertexImport?.available || {});
  const GOOGLE = IMPORT_ITEMS.find((x) => x.id === 'google');
  const anyAvail = $derived(IMPORT_ITEMS.some((x) => avail[x.id]));
  // 导入出来的服务按四项来源的顺序排（上次导入的逐项记录里有 provider id）
  const imported = $derived.by(() => {
    const order = (sp.vertexImport?.last?.items || []).map((x) => x.provider).filter(Boolean);
    const rank = (p) => { const i = order.indexOf(p.id); return i < 0 ? 99 : i; };
    return importedProviders().slice().sort((a, b) => rank(a) - rank(b));
  });
  const at = $derived(lastImportAt());
  // 已导入 = 还有导入出来的服务在（导入后又全删了，就回到「没导入」的样子，免得写着「已导入」却一个服务都没有）
  const done = $derived(imported.length > 0);
  // 逐项结果只在刚点完时摊开（成了哪几项、缺的为什么）；平时导入过就缩成一行（标题 + 时间 + 重新导入）
  const res = $derived(sp.importResult);
  const fresh = $derived(!!sp.importResult);
  const fmt = (ms) => {
    if (!ms) return '';
    const d = new Date(ms), now = new Date();
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return t('今天 {hm}', { hm });
    return (d.getFullYear() !== now.getFullYear() ? d.getFullYear() + '-' : '') + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + hm;
  };

  // 头上的「Vertex → Studio」：左边 Vertex AI 的标，右边 Studio 的品牌标（明暗两版跟界面走）
  const studioMark = $derived(agentMark('studio', ui.theme !== 'light'));
  async function run() { await importVertex(); }
</script>

{#snippet chev()}
  <svg class="chev" viewBox="0 0 8 14" width="7" height="12" aria-hidden="true"><path d="M1.2 1.2 6.6 7l-5.4 5.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
{/snippet}

<section class="ivc" class:done class:compact={done && !fresh} aria-label={t('一键导入 Vertex')}>
  <div class="ivc-hd">
    {#if !(done && !fresh)}<div class="flow" aria-hidden="true">
      <span class="ft">{@html logo('google')}</span>
      <svg class="arr" viewBox="0 0 28 12"><path d="M1 6h24M20 1.5 25.5 6 20 10.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="ft studio">{#if studioMark}<img src={studioMark} alt="" draggable="false" />{/if}</span>
    </div>{/if}
    <div class="ivc-tt">
      <h3>{t('一键导入 Vertex')}</h3>
      {#if done && at}<p class="src"><span class="num">{fmt(at)}</span></p>{/if}
    </div>
    {#if done && !fresh}
      <button type="button" class="btn sm" disabled={sp.importing || !anyAvail} onclick={run}>{#if sp.importing}<span class="spin"></span>{/if}{t('重新导入')}</button>
    {/if}
  </div>

  {#if done && !fresh && !avail.google && GOOGLE}
    <ul class="items">
      <li class="it tap">
        <button type="button" class="hit" aria-label={t('Google 云凭据')} onclick={onOpenGoogle}></button>
        <span class="ilogo">{@html logo('google')}</span>
        <span class="itx"><span class="iname">{GOOGLE.name()}</span></span>
        <span class="st miss">{t('未配置')}{@render chev()}</span>
      </li>
    </ul>
  {/if}

  {#if !done || fresh}
    <ul class="items">
      {#each IMPORT_ITEMS as it (it.id)}
        {@const r = fresh ? res?.items?.find((x) => x.id === it.id) : null}
        {@const ok = avail[it.id]}
        {@const tap = it.id === 'google' && (!r || r.status === 'missing')}
        <li class="it" class:tap>
          {#if tap}<button type="button" class="hit" aria-label={t('Google 云凭据')} onclick={onOpenGoogle}></button>{/if}
          <span class="ilogo">{@html logo(it.id)}</span>
          <span class="itx"><span class="iname">{it.name()}</span></span>
          {#if r}
            <span class="st" class:ok={r.ok} class:miss={!r.ok}>{#if r.ok}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.4 2.9 2.9 6.1-6.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>{/if}{importStatusText(r.status)}{#if tap}{@render chev()}{/if}</span>
          {:else}
            <span class="st" class:ok class:miss={!ok}>{ok ? t('可导入') : t('未配置')}{#if tap}{@render chev()}{/if}</span>
          {/if}
          {#if r && !r.ok && r.reason}<span class="why">{trErr(r.reason)}</span>{/if}
        </li>
      {/each}
    </ul>
    {#if res?.error && fresh}<p class="err">{res.error}</p>{/if}
    <div class="act">
      {#if fresh}
        <button type="button" class="btn" onclick={() => (sp.importResult = null)}>{t('完成')}</button>
      {:else}
        <button type="button" class="btn primary" disabled={sp.importing || !anyAvail} onclick={run}>
          {#if sp.importing}<span class="spin"></span>{t('正在导入…')}{:else}{t('一键导入')}{/if}
        </button>
      {/if}
    </div>
  {/if}
</section>

<style>
  .ivc {
    position: relative; overflow: hidden; margin: 0 0 26px; padding: 18px 18px 16px; border-radius: 22px;
    background: var(--c-card);   /* 平的卡面（方案 §5.2：不用渐变托底） */
    box-shadow: inset 0 0 0 1px var(--c-line);
    color: var(--c-ink);
    container-type: inline-size;
  }
  .ivc-hd { display: flex; align-items: center; gap: 14px; }
  /* 「Vertex → Studio」：两枚方格一支箭头，说清楚是从哪儿搬到哪儿 */
  .flow { flex: none; display: flex; align-items: center; gap: 6px; color: var(--c-ink3); }
  .ft { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 12px; background: var(--c-card); box-shadow: inset 0 0 0 1px var(--c-line); color: var(--c-ink); }
  .ft :global(svg) { width: 22px; height: 22px; display: block; }
  /* Studio 标是不带底的线稿（同 dimensio / ChatGPT 的标），放进和左边一样的格子里 */
  .ft.studio img { width: 24px; height: 24px; display: block; }
  /* 服务品牌标统一灰度（方案 §5.2）；Media Studio 自己的标（.ft.studio）不动 */
  .ft:not(.studio), .ilogo { filter: grayscale(1); opacity: .85; }
  :global(.sst.dark) .ft:not(.studio), :global(.sst.dark) .ilogo { filter: grayscale(1) brightness(1.8); }
  .arr { width: 22px; height: 10px; }
  .ivc-tt { flex: 1; min-width: 0; }
  h3 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; letter-spacing: -.01em; }   /* 中文标题不用衬线（§5.0） */
  .src { margin: 2px 0 0; font-size: 13px; line-height: 18px; color: var(--c-ink2); }
  .num { font-variant-numeric: tabular-nums; }
  .items { list-style: none; margin: 14px 0 0; padding: 0; border-radius: 14px; background: var(--c-sunk); }
  .it { position: relative; display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; column-gap: 10px; padding: 10px 12px; }
  .it:first-child { border-radius: 14px 14px 0 0; }
  .it:last-child { border-radius: 0 0 14px 14px; }
  .it.tap { cursor: pointer; }
  .it.tap:active { background: var(--c-press); }
  .hit { position: absolute; inset: 0; border: 0; padding: 0; background: transparent; border-radius: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .st .chev { width: 7px; height: 12px; margin-left: 6px; color: var(--c-ink3); }
  .it + .it::before { content: ''; position: absolute; top: 0; left: 52px; right: 0; height: 1px; background: var(--c-line); }
  .ilogo { width: 30px; height: 30px; display: grid; place-items: center; color: var(--c-ink); }   /* 品牌标裸放、灰度，不套白方块 */
  .ilogo :global(svg) { width: 20px; height: 20px; display: block; }
  .itx { min-width: 0; display: flex; flex-direction: column; }
  .iname { font-size: 14.5px; line-height: 20px; font-weight: 500; }
  .st { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 500; white-space: nowrap; color: var(--c-ink3); }   /* 行尾纯文字，不做胶囊 */
  .st.ok { color: var(--c-ink2); }
  .st.ok svg { color: var(--c-ok); }
  .st.miss { color: var(--c-ink3); }
  .st svg { width: 13px; height: 13px; }
  .why { grid-column: 2 / -1; font-size: 12.5px; line-height: 17px; color: var(--c-red); margin-top: 2px; }
  .err { margin: 10px 2px 0; font-size: 13px; color: var(--c-red); }
  .act { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; margin-top: 14px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 34px; padding: 0 16px; border-radius: 8px; border: 0;
    background: transparent; box-shadow: inset 0 0 0 1px var(--c-line); color: var(--c-ink); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; flex: none;
    transition: transform .12s ease, opacity .12s ease; }
  .btn.sm { height: 30px; padding: 0 12px; font-size: 13px; }
  @media (pointer: coarse) { .btn.sm { position: relative; } .btn.sm::after { content: ''; position: absolute; inset: -3px 0; } }
  .btn.primary { background: var(--c-accent); color: var(--c-on); box-shadow: none; }
  .btn:active:not(:disabled) { transform: scale(.97); }
  .btn:disabled { opacity: .5; cursor: default; }
  .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: sp .7s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  /* 导入过：缩成一行（标题 + 时间 + 重新导入），不占半屏，也不再画「Vertex → Studio」流向 */
  .ivc.compact { padding: 12px 16px; margin-bottom: 26px; }
  .ivc.compact h3 { font-size: 15.5px; line-height: 21px; }
  .ivc.compact .src { margin: 0; font-size: 12.5px; line-height: 17px; }
  .ivc.compact .items { margin-top: 10px; }   /* 缩起后只剩「Google 云凭据 未配置 ›」那一行 */
  /* 卡片窄（手机设置页、平板上 440 宽的设置面板）：展开的卡里流向图放到标题上面；缩成一行的卡不变 */
  @container (max-width: 520px) {
    .ivc:not(.compact) .ivc-hd { flex-direction: column; align-items: flex-start; gap: 12px; }
  }
</style>
