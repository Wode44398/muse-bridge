<script>
  // 设置 › Media Studio 的桌面正文（desktop/settings/SettingsDesktop 那套 macOS 系统设置风；StudioSettings 按 shell='desk' 挂）。
  // 分组卡 / 行用桌面 kit（DGroup / DRow / DSwitch / DSelect / DButton），服务行要放品牌标，kit 的 DRow 只有彩色方块位，
  // 这里另写一种行（类名也叫 drow，DGroup 的分隔线照样画）。fl(id) 为真 = 搜索刚跳到这一行，闪一下。
  // 内容与手机那份一一对应：一键导入 Vertex → 媒体服务 → 默认模型 → 存储 →（管理员）「高级」（别的 agent / 能生成什么 / 内容安全过滤，
  // 默认收着，搜索跳到其中一组时自动展开）。行下面不写解释小字、组后不写脚注，只留状态值（2026-11-06 维护者：小字太多、像 AI 生成）。
  import DGroup from '../../../desktop/kit/DGroup.svelte';
  import DRow from '../../../desktop/kit/DRow.svelte';
  import DSwitch from '../../../desktop/kit/DSwitch.svelte';
  import DSelect from '../../../desktop/kit/DSelect.svelte';
  import DButton from '../../../desktop/kit/DButton.svelte';
  import ImportVertexCard from './ImportVertexCard.svelte';
  import {
    sp, ss, cat, KINDS, kindName, kindSvg, lacksCredential, hasNewModels, syncFailed, STUDIO_SETTING_GROUPS, STUDIO_SETTING_BY_KEY,
    groupKeys, groupLabel, settingLabel, settingOptions, valueOf, setSetting,
    defaultOf, defaultMine, setDefault, catalogGroups, resolvePick, logoFor, safetyApplies, providerSummary,
  } from '../../../modules/studio/settings.svelte.js';
  import { t, tc, tr } from '../../../lib/i18n.js';
  // 模型中心（2026-11-10 起是「模型从哪来」的唯一入口）：管理员拿到 v2 服务端的总览（hub.ok && hub.v2）、且 Studio 的服务
  // 读得出（没有 hub.studioErr）时，媒体服务组换成三行——「模型中心」、「Google 云凭据」（打开模型中心的 Vertex 卡）。
  // 2026-11-13 起 Vertex / 本机服务也归模型中心（Vertex 卡加上与开关媒体模型、本机图像模型单独一张卡），不再有「添加 Vertex / 本机服务…」。成员、没有总览的老服务端、v1 服务端（总览里没有 Studio 的服务）、
  // Studio 列表读失败时，照旧在这里管自己的媒体服务。引的是核心 lib，不违反「核心不静态引扩展」。
  import { hub, loadHub, openHubSheet } from '../../../lib/modelHub.svelte.js';
  import { openSettings } from '../../../lib/settingsNav.svelte.js';

  let { fl = () => false, agentIds = null, openMgr = () => {}, openFolder = () => {} } = $props();

  // 设置外壳打开时已经拉过；这一页单独挂起来（直达 Studio 分区、外壳先挂后到）也补一次，同一时刻只发一个请求
  if (!hub.ok) loadHub();
  const viaHub = $derived(hub.ok && !!hub.v2 && !hub.studioErr);
  // 行尾状态：只数 Studio 自己的服务与启用的模型（同服务管理器顶上那句），没有服务就不写
  const svcSum = $derived.by(() => {
    if (!sp.providers.length) return '';
    const s = providerSummary();
    return t('{p} 个服务 · {m} 个模型', { p: s.p, m: s.m });
  });

  const logoOf = logoFor;
  const hue = (s) => { let h = 0; for (const c of String(s || '?')) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
  const firstChar = (s) => (String(s || '?').trim().match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
  const hostGroups = $derived(STUDIO_SETTING_GROUPS.filter((g) => g.id !== 'defaults' && g.id !== 'storage' && groupKeys(g.id, agentIds).length));
  let advOpen = $state(false);
  const advShown = $derived(advOpen || hostGroups.some((g) => fl('st-' + g.id)));

  // 默认模型下拉：值 = '<服务>/<模型>'；第一项 = 不指定（管理员：自动用第一个可用的；成员：跟随管理员）
  const SEP = '\u0001';
  function defOptions(k) {
    const auto = resolvePick(k, cat.kinds?.[k]?.defaults);
    const head = ss.canEditHost
      ? { value: '', label: auto ? t('自动（{model}）', { model: auto.label }) : t('自动') }
      : { value: '', label: t('跟随管理员的默认') };
    const groups = catalogGroups(k);
    const many = groups.length > 1;
    const opts = [head];
    for (const g of groups) for (const m of g.models) opts.push({ value: g.provider.id + SEP + m.id, label: many ? (m.label || m.id) + ' — ' + tr(g.provider.name) : (m.label || m.id) });
    const pick = defaultOf(k);
    if (pick && !resolvePick(k, pick) && (ss.canEditHost || defaultMine(k))) opts.push({ value: pick.provider + SEP + pick.model, label: t('{model}（已停用）', { model: pick.model }) });
    return opts;
  }
  // 搜索跳过来的那一组滚到视野中间（Studio 这一页长，命中的行常在首屏以下，光闪一下看不见）
  function reveal(node, on) {
    const go = (v) => { if (v) setTimeout(() => node.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80); };
    go(on);
    return { update: go };
  }
  const defValue = (k) => { const p = defaultOf(k); return p && (ss.canEditHost || defaultMine(k)) ? p.provider + SEP + p.model : ''; };
  function onDef(k, v) {
    if (!v) { setDefault(k, null); return; }
    const [provider, model] = v.split(SEP);
    setDefault(k, { provider, model });
  }
</script>

{#snippet plogo(p)}
  {#if logoOf(p)}<span class="lg">{@html logoOf(p)}</span>{:else}<span class="lg mono" style:--h={hue(p.name)}>{firstChar(p.name)}</span>{/if}
{/snippet}

<div class="stk">
  {#if sp.vertexImport && !viaHub}
    <!-- 搜「Google 云凭据」：走模型中心时亮下面媒体服务组里那一行，否则亮这张卡（卡里有 Google 那一行） -->
    <div class:hl={fl('st-import') || (fl('st-google') && !viaHub)} use:reveal={fl('st-import') || (fl('st-google') && !viaHub)}>
      <ImportVertexCard onOpenProvider={(id) => openMgr({ view: 'edit', id })} onOpenGoogle={() => openMgr({ view: 'google' })} />
    </div>
  {/if}

  <div class="anchor" use:reveal={fl('st-providers') || (fl('st-google') && viaHub)}></div>
  {#if viaHub}
    <!-- 管理员：地址 + Key 类的媒体服务在模型中心统一管（与 Claude、dimensio 共用一份），行尾是 Studio 现有服务的状态；
         Vertex、本机服务也在模型中心 -->
    <DGroup label={t('媒体服务')} foot={sp.err || ''}>
      <DRow title={t('模型中心')} sub={svcSum} highlight={fl('st-providers')} onclick={() => openSettings('model-hub')} />
      <DRow title={t('Google 云凭据')} highlight={fl('st-google')} onclick={() => openHubSheet({ type: 'vertex' })} />
    </DGroup>
  {:else}
    <DGroup label={t('媒体服务')} foot={sp.err || ''}>
      {#each sp.providers as p (p.id)}
        <button class="drow prow" class:hl={fl('st-providers') && p === sp.providers[0]} onclick={() => openMgr({ view: 'edit', id: p.id })}>
          {@render plogo(p)}
          <span class="txt" class:dim={p.enabled === false}><span class="tt">{tr(p.name)}{#if hasNewModels(p)}<span class="nw" title={t('有新模型')}>{t('新')}</span>{/if}</span></span>
          {#if p.enabled === false}<span class="tag">{t('已关闭')}</span>{:else if lacksCredential(p)}<span class="tag warn">{t('缺 Key')}</span>{:else if syncFailed(p)}<span class="tag bad">{tc('巡检', '检查失败')}</span>{/if}
          <svg class="chev" viewBox="0 0 6 10" width="6" height="10" aria-hidden="true"><path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      {/each}
      <DRow title={t('添加服务…')} highlight={fl('st-providers') && !sp.providers.length} onclick={() => openMgr({ view: 'presets' })} />
      {#if sp.providers.length}<DRow title={t('管理全部服务')} onclick={() => openMgr({ view: 'list' })} />{/if}
    </DGroup>
  {/if}

  {#if sp.shared.length}
    <DGroup label={t('管理员共享给你的服务')}>
      {#each sp.shared as p (p.id)}
        <div class="drow prow ro">{@render plogo(p)}<span class="txt" class:dim={p.enabled === false}><span class="tt">{tr(p.name)}</span></span></div>
      {/each}
    </DGroup>
  {/if}

  <div class="anchor" use:reveal={fl('st-def')}></div>
  <DGroup label={t('默认模型')}>
    {#each KINDS as k (k)}
      <div class="drow prow" class:hl={fl('st-def')}>
        <span class="tile" data-k={k}>{@html kindSvg(k)}</span>
        <span class="txt"><span class="tt">{kindName(k)}{#if defaultMine(k)}<span class="pill">{t('我的')}</span>{/if}</span></span>
        {#if catalogGroups(k).length}
          <DSelect options={defOptions(k)} value={defValue(k)} disabled={ss.busy === 'defaults'} onchange={(v) => onDef(k, v)} width="min(300px, 34vw)" />
        {:else}<span class="ts">{cat.loaded ? t('没有可用模型') : t('载入中…')}</span>{/if}
      </div>
    {/each}
  </DGroup>

  <div class="anchor" use:reveal={fl('st-autosave') || fl('st-savedir')}></div>
  <DGroup label={t('存储')}>
    <DRow title={settingLabel('autoSave')} highlight={fl('st-autosave')}>
      {#snippet trailing()}<DSwitch checked={!!valueOf('autoSave')} disabled={ss.busy === 'autoSave'} onchange={(v) => setSetting('autoSave', v)} />{/snippet}
    </DRow>
    {#if valueOf('autoSave')}
      <DRow title={settingLabel('saveDir')} sub={valueOf('saveDir') || t('工作空间根目录')} subSelectable highlight={fl('st-savedir')}>
        {#snippet trailing()}<DButton size="sm" onclick={openFolder}>{t('更改…')}</DButton>{/snippet}
      </DRow>
    {/if}
  </DGroup>

  {#if hostGroups.length}
    <DGroup>
      <button class="drow prow adv" class:open={advShown} aria-expanded={advShown} onclick={() => (advOpen = !advShown)}>
        <span class="txt"><span class="tt">{t('高级')}</span></span>
        <svg class="chev" viewBox="0 0 6 10" width="6" height="10" aria-hidden="true"><path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </DGroup>
  {/if}
  {#each advShown ? hostGroups : [] as g (g.id)}
    {@const keys = groupKeys(g.id, agentIds)}
    {#if keys.length}
      <div class="grpwrap" use:reveal={fl('st-' + g.id)}>
        {#if g.id === 'safety' && !safetyApplies()}<span class="na">{t('当前服务不适用')}</span>{/if}
        <DGroup label={groupLabel(g)}>
          {#each keys as key (key)}
            <DRow title={settingLabel(key)} highlight={fl('st-' + g.id)}>
              {#snippet trailing()}
                {#if STUDIO_SETTING_BY_KEY[key].type === 'bool'}
                  <DSwitch checked={!!valueOf(key)} disabled={ss.busy === key} onchange={(v) => setSetting(key, v)} />
                {:else}
                  <DSelect options={settingOptions(key)} value={valueOf(key)} disabled={ss.busy === key} onchange={(v) => setSetting(key, v)} width="170px" />
                {/if}
              {/snippet}
            </DRow>
          {/each}
        </DGroup>
      </div>
    {/if}
  {/each}
  {#if ss.err}<p class="err">{ss.err}</p>{/if}
</div>

<style>
  .stk { display: flex; flex-direction: column; gap: var(--dsk-s6, 24px); }
  .stk > :global(div) > :global(.ivc) { margin: 0; }
  .hl { animation: flash 1.5s var(--dsk-ease) 1; border-radius: 22px; }
  @keyframes flash { 0%, 70% { box-shadow: 0 0 0 3px var(--dsk-sel); } 100% { box-shadow: 0 0 0 3px transparent; } }
  /* 服务行 / 默认模型行：比 DRow 多一个行首方格（品牌标或种类字形），其余尺寸照 DRow */
  .prow { display: flex; align-items: center; gap: var(--dsk-s3); width: 100%; min-height: var(--dsk-row-h); padding: var(--dsk-s2) var(--dsk-s3);
    border: 0; background: none; font-family: var(--dsk-font); font-size: var(--dsk-fs-ui); text-align: left; color: var(--dsk-ink); }
  button.prow { cursor: pointer; transition: background var(--dsk-t-fast) var(--dsk-ease); }
  button.prow:hover { background: var(--dsk-hover); }
  button.prow:active { background: var(--dsk-active); }
  .prow.hl { animation: rowflash 1.5s var(--dsk-ease) 1; box-shadow: none; }
  @keyframes rowflash { 0%, 70% { background: var(--dsk-sel); } 100% { background: transparent; } }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .txt.dim { opacity: .5; }
  .tt { display: inline-flex; align-items: center; gap: 6px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ts { font-size: var(--dsk-fs-sm); line-height: 1.35; color: var(--dsk-ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tag { flex: none; font-size: var(--dsk-fs-sm); color: var(--dsk-ink-3); }
  .tag.warn { color: var(--dsk-warn); }
  .tag.bad { color: var(--dsk-crit); }
  .nw { flex: none; display: inline-flex; align-items: center; height: 15px; padding: 0 4px; border-radius: 4px; font-size: 10.5px; font-weight: 500; line-height: 1; letter-spacing: .02em; color: var(--dsk-ink); box-shadow: inset 0 0 0 1px var(--dsk-line-strong, var(--dsk-line)); }   /* 有 7 天内新发现的模型：墨色细线框小标签（朱色只留给「正在发生」） */
  .chev { flex: none; color: var(--dsk-ink-3); transition: transform var(--dsk-t-fast) var(--dsk-ease); }
  .adv.open .chev { transform: rotate(90deg); }
  .pill { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 999px; font-size: 11px; background: var(--c-tile); color: var(--dsk-ink-2); }
  .lg { flex: none; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 6.5px; background: var(--c-tile); color: var(--dsk-ink); }
  .lg :global(svg) { width: 15px; height: 15px; display: block; }
  /* 首字头像只用墨色（墨与象牙，不按名字取色）。原先这里是改墨色时没删干净的 hsl 残参，整条声明作废、svelte-check 报错 */
  .lg.mono { --h: 20; font-size: 12px; font-weight: 600; color: var(--c-ink2); }
  /* 品牌标统一灰度（方案 §5.2）；首字头像（.mono）不算品牌标 */
  .lg:not(.mono) { filter: grayscale(1); opacity: .85; }
  :global(.sst.dark) .lg:not(.mono) { filter: grayscale(1) brightness(1.8); }
  .tile { position: relative; flex: none; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 6.5px; background: var(--c-tile); color: var(--dsk-ink); }
  .tile :global(svg) { width: 16px; height: 16px; display: block; }
  .grpwrap { position: relative; }
  /* 滚动锚点：贴在组标签上方，不占位（外层 gap 不受影响） */
  .anchor { height: 0; margin-bottom: calc(-1 * var(--dsk-s6, 24px)); }
  .na { position: absolute; right: var(--dsk-s3); top: 0; font-size: var(--dsk-fs-sm); color: var(--dsk-warn); }
  .err { margin: 0; font-size: var(--dsk-fs-sm); color: var(--dsk-crit); }
</style>
