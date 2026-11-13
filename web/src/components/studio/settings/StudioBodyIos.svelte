<script>
  // 设置 › Media Studio 的手机 / 网页正文（iOS 27 设置 App 那套，墨与象牙；StudioSettings 按 shell='ios' 挂）。
  // 外壳的分组卡 / 行样式是 Settings.svelte 的 scoped 样式够不着，这里照它的尺寸另写一份（.ig / .r / .ghead / .gfoot），
  // 颜色读 StudioSettings 根上统一好的 --c-*。行下面不写解释小字、组后不写脚注，只留状态值（已关闭 / 缺 Key / 模型名 / 路径；2026-11-06 维护者：小字太多、像 AI 生成）。四种页：
  //   'studio'          一键导入 Vertex（管理员）→ 媒体服务 → 默认模型 → 存储 →（管理员）「高级」
  //   'st:adv'          （管理员）别的 agent 能不能生成 / agent 能生成什么 / 内容安全过滤
  //   'st:def:<种类>'    这个种类的默认模型：按服务分组列出目录里的模型，选中打勾；成员多一行「跟随管理员」
  //   'st:ch:<键>'       枚举项单选（视频最高分辨率、安全阈值）：选中打勾，改过才出「恢复默认」
  import Toggle from '../../ios27/Toggle.svelte';
  import ImportVertexCard from './ImportVertexCard.svelte';
  import {
    sp, ss, KINDS, kindName, kindSvg, lacksCredential, hasNewModels, syncFailed, STUDIO_SETTING_GROUPS, STUDIO_SETTING_BY_KEY,
    groupKeys, groupLabel, settingLabel, settingOptions, settingValueLabel, valueOf, changedOf, setSetting,
    defaultOf, defaultMine, setDefault, catalogGroups, resolvePick, logoFor, cat, safetyApplies, providerSummary,
  } from '../../../modules/studio/settings.svelte.js';
  import { t, tc, tr } from '../../../lib/i18n.js';
  // 模型中心（2026-11-10 起是「模型从哪来」的唯一入口）：管理员拿到 v2 服务端的总览（hub.ok && hub.v2）、且 Studio 的服务
  // 读得出（没有 hub.studioErr）时，媒体服务组换成三行——「模型中心」、「Google 云凭据」（打开模型中心的 Vertex 卡）。
  // 2026-11-13 起 Vertex / 本机服务也归模型中心（Vertex 卡加上与开关媒体模型、本机图像模型单独一张卡），不再有「添加 Vertex / 本机服务…」。成员、没有总览的老服务端、v1 服务端（总览里没有 Studio 的服务）、
  // Studio 列表读失败时，照旧在这里管自己的媒体服务。引的是核心 lib，不违反「核心不静态引扩展」。
  import { hub, loadHub, openHubSheet } from '../../../lib/modelHub.svelte.js';
  import { openSettings } from '../../../lib/settingsNav.svelte.js';

  let { page = 'studio', push = null, agentIds = null, openMgr = () => {}, openFolder = () => {} } = $props();

  // 设置外壳打开时已经拉过；这一页单独挂起来也补一次，同一时刻只发一个请求
  if (!hub.ok) loadHub();
  const viaHub = $derived(hub.ok && !!hub.v2 && !hub.studioErr);
  // 行尾状态：只数 Studio 自己的服务与启用的模型（同服务管理器顶上那句），没有服务就不写
  const svcSum = $derived.by(() => {
    if (!sp.providers.length) return '';
    const s = providerSummary();
    return t('{p} 个服务 · {m} 个模型', { p: s.p, m: s.m });
  });
  // 外壳给了 push 就推入一页（模型中心是外壳自己认的页，返回回到 Media Studio）；没给（别处挂这份正文）走通用的直达分区
  function openHub() {
    if (push) push('model-hub', t('模型中心'));
    else openSettings('model-hub');
  }

  const kindOf = $derived(page.startsWith('st:def:') ? page.slice(7) : '');
  const keyOf = $derived(page.startsWith('st:ch:') ? page.slice(6) : '');
  const LIMIT = 6;
  const logoOf = logoFor;
  const hue = (s) => { let h = 0; for (const c of String(s || '?')) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
  const firstChar = (s) => (String(s || '?').trim().match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();

  // 默认模型行尾：选了且还在目录里 = 模型名；选了但停用 / 删了 = 提示；没选 = 目录给的自动值
  function defLine(k) {
    const pick = defaultOf(k);
    const r = resolvePick(k, pick);
    if (r) return { text: r.label };
    if (pick) return { text: t('已停用'), warn: true };
    const a = resolvePick(k, cat.kinds?.[k]?.defaults);
    return a ? { text: a.label } : { text: t('没有可用模型'), dim: true };
  }
  const pickTitle = (k) => t('默认{kind}模型', { kind: kindName(k) });
  const isSel = (k, provider, model) => { const p = defaultOf(k); return !!p && p.provider === provider && p.model === model; };
  async function choose(k, pick) { await setDefault(k, pick); }
  // 主机级的几组（让别的 agent 生成媒体、agent 能生成什么、内容安全过滤）：只有管理员有，收在「高级」子页
  const hostGroups = $derived(STUDIO_SETTING_GROUPS.filter((g) => g.id !== 'defaults' && g.id !== 'storage' && groupKeys(g.id, agentIds).length));
</script>

{#snippet chev()}<svg class="chev" viewBox="0 0 8 14" width="8" height="14" aria-hidden="true"><path d="M1.2 1.2 6.6 7l-5.4 5.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>{/snippet}
{#snippet check()}<svg class="ck" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m3 8.6 3.2 3.1L13 4.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>{/snippet}
{#snippet logo(p)}
  {#if logoOf(p)}<span class="lg">{@html logoOf(p)}</span>{:else}<span class="lg mono" style:--h={hue(p.name)}>{firstChar(p.name)}</span>{/if}
{/snippet}
{#snippet chgDot(key)}{#if changedOf(key)}<span class="chg" aria-label={t('已改过')}></span>{/if}{/snippet}

{#if page === 'studio'}
  {#if sp.vertexImport && !viaHub}
    <ImportVertexCard onOpenProvider={(id) => openMgr({ view: 'edit', id })} onOpenGoogle={() => openMgr({ view: 'google' })} />
  {/if}

  {#if viaHub}
    <!-- 管理员：地址 + Key 类的媒体服务在模型中心统一管（与 Claude、dimensio 共用一份），行尾是 Studio 现有服务的状态；
         Vertex、本机服务也在模型中心 -->
    <h4 class="ghead">{t('媒体服务')}</h4>
    <div class="ig">
      <button class="r" type="button" onclick={openHub}>
        <span class="r-main">
          <span class="r-tx">{t('模型中心')}</span>
          {#if svcSum}<span class="r-d"><span class="r-dt">{svcSum}</span></span>{/if}
          {@render chev()}
        </span>
      </button>
      <button class="r" type="button" onclick={() => openHubSheet({ type: 'vertex' })}>
        <span class="r-main"><span class="r-tx">{t('Google 云凭据')}</span>{@render chev()}</span>
      </button>
    </div>
  {:else}
    <!-- 媒体服务 -->
    <h4 class="ghead">{t('媒体服务')}</h4>
    <div class="ig">
      {#each sp.providers.slice(0, LIMIT) as p (p.id)}
        <button class="r" type="button" onclick={() => openMgr({ view: 'edit', id: p.id })}>
          {@render logo(p)}
          <span class="r-main" class:dim={p.enabled === false}>
            <span class="r-tx"><span class="r-lbl">{tr(p.name)}{#if hasNewModels(p)}<span class="nw" title={t('有新模型')}>{t('新')}</span>{/if}</span></span>
            {#if p.enabled === false}<span class="r-d">{t('已关闭')}</span>{:else if lacksCredential(p)}<span class="r-d warn">{t('缺 Key')}</span>{:else if syncFailed(p)}<span class="r-d bad">{tc('巡检', '检查失败')}</span>{/if}
            {@render chev()}
          </span>
        </button>
      {/each}
      {#if sp.providers.length > LIMIT}
        <button class="r" type="button" onclick={() => openMgr({ view: 'list' })}>
          <span class="r-main"><span class="r-tx">{t('全部 {n} 个服务', { n: sp.providers.length })}</span>{@render chev()}</span>
        </button>
      {/if}
      <button class="r" type="button" onclick={() => openMgr({ view: 'presets' })}>
        <span class="r-main"><span class="r-tx accent">{t('添加服务…')}</span></span>
      </button>
    </div>
  {/if}
  {#if sp.err}<p class="gfoot err">{sp.err}</p>{/if}

  {#if sp.shared.length}
    <h4 class="ghead">{t('管理员共享给你的服务')}</h4>
    <div class="ig">
      {#each sp.shared as p (p.id)}
        <div class="r">
          {@render logo(p)}
          <span class="r-main" class:dim={p.enabled === false}><span class="r-tx"><span class="r-lbl">{tr(p.name)}</span></span></span>
        </div>
      {/each}
    </div>
  {/if}

  <!-- 默认模型 -->
  <h4 class="ghead">{t('默认模型')}</h4>
  <div class="ig">
    {#each KINDS as k (k)}
      {@const d = defLine(k)}
      <button class="r" type="button" onclick={() => push?.('st:def:' + k, pickTitle(k))}>
        <span class="tile" data-k={k}>{@html kindSvg(k)}</span>
        <span class="r-main">
          <span class="r-tx"><span class="r-lbl">{kindName(k)}{#if defaultMine(k)}<span class="pill">{t('我的')}</span>{/if}</span></span>
          <span class="r-d" class:warn={d.warn} class:faint={d.dim}><span class="r-dt">{d.text}</span></span>
          {@render chev()}
        </span>
      </button>
    {/each}
  </div>

  <!-- 存储 -->
  <h4 class="ghead">{t('存储')}</h4>
  <div class="ig">
    <div class="r">
      <span class="r-main"><span class="r-tx"><span class="r-lbl">{settingLabel('autoSave')}{@render chgDot('autoSave')}</span></span>
        <Toggle checked={!!valueOf('autoSave')} disabled={ss.busy === 'autoSave'} onchange={() => setSetting('autoSave', !valueOf('autoSave'))} label={settingLabel('autoSave')} /></span>
    </div>
    {#if valueOf('autoSave')}
      <button class="r ind" type="button" onclick={openFolder}>
        <span class="r-main"><span class="r-tx"><span class="r-lbl">{settingLabel('saveDir')}{@render chgDot('saveDir')}</span></span>
          <span class="r-d path">{valueOf('saveDir') || t('工作空间根目录')}</span>{@render chev()}</span>
      </button>
    {/if}
  </div>

  <!-- 管理员：主机级的那几组（哪些 agent 能生成、能生成什么、内容安全）不常动，收进「高级」子页 -->
  {#if hostGroups.length}
    <div class="ig">
      <button class="r" type="button" onclick={() => push?.('st:adv', t('高级'))}>
        <span class="r-main"><span class="r-tx">{t('高级')}</span>{@render chev()}</span>
      </button>
    </div>
  {/if}
  {#if ss.err}<p class="gfoot err">{ss.err}</p>{/if}

{:else if page === 'st:adv'}
  {#each hostGroups as g (g.id)}
    {@const keys = groupKeys(g.id, agentIds)}
    {#if keys.length}
      <h4 class="ghead">{groupLabel(g)}{#if g.id === 'safety' && !safetyApplies()}<span class="pill warn">{t('当前服务不适用')}</span>{/if}</h4>
      <div class="ig">
        {#each keys as key (key)}
          {#if STUDIO_SETTING_BY_KEY[key].type === 'bool'}
            <div class="r" class:ind={!!STUDIO_SETTING_BY_KEY[key].dependsOn}>
              <span class="r-main"><span class="r-tx"><span class="r-lbl">{settingLabel(key)}{@render chgDot(key)}</span></span>
                <Toggle checked={!!valueOf(key)} disabled={ss.busy === key} onchange={() => setSetting(key, !valueOf(key))} label={settingLabel(key)} /></span>
            </div>
          {:else if STUDIO_SETTING_BY_KEY[key].type === 'enum'}
            <button class="r" class:ind={!!STUDIO_SETTING_BY_KEY[key].dependsOn} type="button" onclick={() => push?.('st:ch:' + key, settingLabel(key))}>
              <span class="r-main"><span class="r-tx"><span class="r-lbl">{settingLabel(key)}{@render chgDot(key)}</span></span>
                <span class="r-d">{settingValueLabel(key)}</span>{@render chev()}</span>
            </button>
          {/if}
        {/each}
      </div>
    {/if}
  {/each}
  {#if ss.err}<p class="gfoot err">{ss.err}</p>{/if}

{:else if kindOf}
  {@const groups = catalogGroups(kindOf)}
  {#if !ss.canEditHost}
    <div class="ig">
      <button class="r" type="button" disabled={ss.busy === 'defaults'} onclick={() => choose(kindOf, null)}>
        <span class="r-main"><span class="r-tx"><span class="r-lbl">{t('跟随管理员的默认')}</span></span>{#if !defaultMine(kindOf)}{@render check()}{/if}</span>
      </button>
    </div>
  {:else if groups.length}
    <!-- 没选过默认时也看得出现在用的是哪个：「自动（目录给的那个）」打勾；选了别的，点它就改回自动 -->
    {@const auto = resolvePick(kindOf, cat.kinds?.[kindOf]?.defaults)}
    <div class="ig">
      <button class="r" type="button" disabled={ss.busy === 'defaults'} onclick={() => choose(kindOf, null)}>
        <span class="r-main"><span class="r-tx"><span class="r-lbl">{auto ? t('自动（{model}）', { model: auto.label }) : t('自动')}</span></span>{#if !defaultOf(kindOf)}{@render check()}{/if}</span>
      </button>
    </div>
  {/if}
  {#each groups as g (g.provider.id)}
    <h4 class="ghead grp">{@render logo(g.provider)}<span>{tr(g.provider.name)}</span>{#if g.provider.mine && sp.member}<span class="pill">{t('我的')}</span>{/if}</h4>
    <div class="ig">
      {#each g.models as m (m.key || m.id)}
        <button class="r" type="button" disabled={ss.busy === 'defaults'} onclick={() => choose(kindOf, { provider: g.provider.id, model: m.id })}>
          <span class="r-main"><span class="r-tx"><span class="r-lbl">{m.label || m.id}</span></span>
            {#if (ss.canEditHost || defaultMine(kindOf)) && isSel(kindOf, g.provider.id, m.id)}{@render check()}{/if}</span>
        </button>
      {/each}
    </div>
  {:else}
    <p class="gfoot">{cat.loaded ? t('没有可用模型') : t('载入中…')}</p>
  {/each}
  {#if ss.err}<p class="gfoot err">{ss.err}</p>{/if}

{:else if keyOf && STUDIO_SETTING_BY_KEY[keyOf]}
  <div class="ig">
    {#each settingOptions(keyOf) as o (o.value)}
      <button class="r" type="button" disabled={ss.busy === keyOf} onclick={() => setSetting(keyOf, o.value)}>
        <span class="r-main"><span class="r-tx">{o.label}</span>{#if valueOf(keyOf) === o.value}{@render check()}{/if}</span>
      </button>
    {/each}
  </div>
  {#if changedOf(keyOf)}
    <div class="ig"><button class="r" type="button" onclick={() => setSetting(keyOf, null)}><span class="r-main center"><span class="r-tx accent">{t('恢复默认')}</span></span></button></div>
  {/if}
  {#if ss.err}<p class="gfoot err">{ss.err}</p>{/if}
{/if}

<style>
  /* 尺寸照 Settings.svelte：组圆角 18、行 50 高、左右 16、分隔线从正文起；17/22 正文、13/18 副文与脚注 */
  .ig { position: relative; background: var(--c-card); border-radius: 18px; overflow: hidden; margin-bottom: 26px; box-shadow: inset 0 0 0 .5px var(--c-line); }
  .ig:has(+ .gfoot) { margin-bottom: 0; }
  .ghead { display: flex; align-items: center; gap: 8px; margin: 0; padding: 0 16px 8px; font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: .2px; color: var(--c-ink2); }
  .ghead.grp { padding-top: 2px; }
  .ghead .lg { width: 20px; height: 20px; border-radius: 6px; }
  .ghead .lg :global(svg) { width: 13px; height: 13px; }
  .gfoot { margin: 0; padding: 8px 16px 24px; font-size: 12.5px; line-height: 18px; color: var(--c-ink2); }
  .gfoot.err { color: var(--c-red); padding-bottom: 10px; }
  .r { position: relative; display: flex; align-items: center; gap: 14px; width: 100%; min-height: 50px; padding: 0 16px;
    border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent;
    transition: background-color 260ms ease; }
  div.r { cursor: default; }
  button.r:active:not(:disabled) { background: var(--c-press); transition-duration: 60ms; }
  .r:disabled { cursor: default; }
  .r.ind { padding-left: 32px; }
  .r-main { position: relative; flex: 1; min-width: 0; align-self: stretch; display: flex; align-items: center; gap: 10px; min-height: 50px; padding: 12px 0; }
  .r + .r .r-main::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 1px; background: var(--c-line); }
  .r-main.center { justify-content: center; }
  .r-main.dim .r-tx { opacity: .45; }
  .r-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 16px; line-height: 22px; letter-spacing: -.1px; }
  .r-main.center .r-tx { flex: none; }
  .r-tx.accent { color: var(--c-accent); font-weight: 600; }
  .r-lbl { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
  .r-d { flex: 0 1 auto; max-width: 62%; font-size: 15px; line-height: 20px; color: var(--c-ink2); display: flex; flex-direction: column; align-items: flex-end; text-align: right; overflow: hidden; }
  /* 模型名放不下就折成两行（窄屏 + 大字号），别省略掉「Pro」「Flash TTS」这种区分型号的后半截 */
  .r-dt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; max-width: 100%; overflow: hidden; overflow-wrap: anywhere; }
  .r-d.warn { color: var(--c-warn); }
  .r-d.bad { color: var(--c-red); }
  .nw { flex: none; display: inline-flex; align-items: center; height: 15px; padding: 0 4px; border-radius: 4px; font-size: 10.5px; font-weight: 500; line-height: 1; letter-spacing: .02em; color: var(--c-ink); box-shadow: inset 0 0 0 1px var(--c-line); }   /* 有 7 天内新发现的模型：墨色细线框小标签（朱色只留给「正在发生」） */
  .r-d.faint { color: var(--c-ink3); }
  .r-d.path { display: block; font-size: 14.5px; overflow: hidden; }
  .chev { flex: none; color: var(--c-ink3); margin-left: 2px; }
  .ck { flex: none; color: var(--c-accent); }
  .chg { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--c-accent); }
  .pill { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px; font-size: 11.5px; font-weight: 500; letter-spacing: 0; background: var(--c-tile); color: var(--c-ink2); }
  .pill.warn { color: var(--c-warn); background: color-mix(in srgb, var(--c-warn) 12%, transparent); }
  /* 服务的品牌标：30px 中性底方格（同设置页行首图标） */
  .lg { flex: none; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; background: var(--c-tile); color: var(--c-ink); }
  .lg :global(svg) { width: 18px; height: 18px; display: block; }
  /* 首字头像只用墨色（墨与象牙，不按名字取色）。原先这里是改墨色时没删干净的 hsl 残参，整条声明作废、svelte-check 报错 */
  .lg.mono { --h: 20; font-size: 14px; font-weight: 600; color: var(--c-ink2); }
  /* 品牌标统一灰度（方案 §5.2）；首字头像（.mono）不算品牌标 */
  .lg:not(.mono) { filter: grayscale(1); opacity: .85; }
  :global(.sst.dark) .lg:not(.mono) { filter: grayscale(1) brightness(1.8); }
  /* 种类方格：中性底 + 线稿字形，种类不着色（方案 §5.2） */
  .tile { position: relative; flex: none; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; background: var(--c-tile); color: var(--c-ink); }
  .tile :global(svg) { width: 18px; height: 18px; display: block; }
</style>
