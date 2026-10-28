<script>
  // 设置 › Claude › 模型服务（自定义 API）的管理面板：两套设置外壳共用这一份，盖在设置页上面——
  // 宽屏是居中大对话框，手机（< 700px）是从底部滑上来的整页。视图：服务列表 → 选预设 → 编辑器。
  // 多用户服务器：管理员标了「共享给成员」的卡上带「已共享」；成员的列表下面多一组「管理员共享」的只读卡（点不进编辑器）。
  // 返回键 / Esc 逐层后退：编辑器 → 列表 → 关闭（编辑器有未保存改动时先问）。
  import { onMount } from 'svelte';
  import SToggle from '../../settings/SToggle.svelte';
  import ProviderEditor from './ProviderEditor.svelte';
  import { cp, loadProviders, updateProvider, providerLog, cpSummary } from '../../../lib/claudeProviders.svelte.js';
  import { pushBackLayer } from '../../../lib/nav.js';
  import { uiConfirm, uiAlert } from '../../../lib/dialogs.js';   // 桌面壳走系统对话框；安卓 WebView 原生 confirm 没接，统一走这里
  import { providerLogo } from '../../../lib/providerLogos.js';   // 官方品牌标；对不上的退回首字头像
  import { t } from '../../../lib/i18n.js';

  let { onClose } = $props();

  let view = $state('list');          // list | presets | edit
  let editing = $state(null);         // 编辑器的来源（已存的服务 / 预设草稿）
  let editorKey = $state(0);
  let health = $state({});            // 服务 id → 'ok' | 'bad' | ''（最近一条请求）
  let toggling = $state({});

  onMount(() => {
    loadProviders(true).then(refreshHealth);
    const off = pushBackLayer(back);
    const key = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); back(); } };
    window.addEventListener('keydown', key);
    return () => { off(); window.removeEventListener('keydown', key); };
  });

  async function refreshHealth() {
    const out = {};
    await Promise.all(cp.providers.map(async (p) => {
      try { const l = await providerLog(p.id); out[p.id] = l.length ? (l[0].status >= 200 && l[0].status < 300 ? 'ok' : l[0].status === 499 ? '' : 'bad') : ''; } catch { out[p.id] = ''; }
    }));
    health = out;
  }

  // 编辑器里有没有没保存的改动：编辑器自己知道，这里在后退时问一句
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
      view = 'list'; editing = null; editorDirty = false; refreshHealth();
      return;
    }
    if (view === 'presets') { view = 'list'; return; }
    onClose?.();
  }
  function openEdit(src) { editing = src; editorKey++; view = 'edit'; editorDirty = false; }
  function pickPreset(pr) {
    openEdit(pr ? { name: pr.name, note: pr.note || '', preset: pr.id, protocol: pr.protocol, baseUrl: pr.baseUrl, authStyle: pr.authStyle, compat: pr.compat || {}, models: [] } : { name: '', protocol: 'anthropic', baseUrl: '', models: [] });
  }
  async function toggleField(p, patch) {
    toggling = { ...toggling, [p.id]: true };
    try { await updateProvider(p.id, patch); } catch (e) { uiAlert(e.message || String(e), { type: 'error' }); }
    toggling = { ...toggling, [p.id]: false };
  }
  const toggleEnabled = (p, v) => toggleField(p, { enabled: v });
  const toggleShown = (p) => toggleField(p, { showInPicker: p.showInPicker === false });

  // 首字头像：按名字取一个色相，低饱和，明暗主题都耐看
  const hue = (s) => { let h = 0; for (const c of String(s || '?')) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
  const initial = (s) => (String(s || '?').trim().match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
  const host = (u) => { try { return new URL(u).host; } catch { return u || ''; } };
  const title = $derived(view === 'edit' ? (editing && editing.id ? editing.name : t('添加模型服务')) : view === 'presets' ? t('添加模型服务') : t('模型服务'));
  // 只数启用服务里启用的对话模型（语音 / 向量这类不进菜单，不算「可用」）
  const sum = $derived(cpSummary());
  const chatCount = (p) => p.models.filter((m) => m.enabled && m.kind !== 'other').length;
</script>

<div class="ov" role="presentation" onclick={(e) => { if (e.target === e.currentTarget && view !== 'edit') onClose?.(); }}>
  <div class="dlg" role="dialog" aria-modal="true" aria-label={title}>
    <header class="top">
      {#if view !== 'list'}
        <button type="button" class="hbtn" aria-label={t('返回')} onclick={back}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg></button>
      {/if}
      <div class="ttl">
        <div class="t1">{title}</div>
        {#if view === 'list'}<div class="t2">{t('Claude · 自定义 API')}</div>{/if}
      </div>
      <button type="button" class="hbtn" aria-label={t('关闭')} onclick={() => (view === 'edit' ? back() : onClose?.())}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 5l10 10M15 5 5 15"/></svg></button>
    </header>

    {#if view === 'list'}
      <div class="scroll">
        <div class="intro">
          <div class="intro-tx">
            <h2>{t('接入你自己的模型')}</h2>
            <p>{cp.member ? t('用你自己的 API Key 接入兼容 Anthropic 或 OpenAI 接口的服务：DeepSeek、Kimi、GLM、小米 MiMo、百炼、OpenRouter……接好后在输入框模型菜单的 More models 里按服务分组选用，Claude Code 的工具、子 agent、工作区照常可用。') : t('兼容 Anthropic 或 OpenAI 接口的服务都能接：DeepSeek、Kimi、GLM、小米 MiMo、百炼、OpenRouter、本机 Ollama……接好后在输入框模型菜单的 More models 里按服务分组选用，Claude Code 的工具、子 agent、工作区照常可用。')}</p>
          </div>
          <button type="button" class="btn primary" onclick={() => (view = 'presets')}>＋ {t('添加服务')}</button>
        </div>
        {#if cp.member}<div class="note">{t('这里的服务只有你自己能用：API Key 加密存在服务器上，不会显示给任何人，费用走你自己的账户、不占用本站额度。接口地址只能是公网地址（不能接本机或局域网服务）。')}</div>{/if}
        {#if cp.err}<div class="note warn">{cp.err}</div>{/if}
        {#if cp.providers.length}
          <div class="meta">{t('{p} 个服务 · {m} 个可用模型', { p: sum.p, m: sum.m })}{#if sum.h}{t('（{h} 个已隐藏）', { h: sum.h })}{/if}</div>
          <div class="grid">
            {#each cp.providers as p (p.id)}
              {@const h = hue(p.name)}
              <div class="card" class:dis={!p.enabled}>
                <button type="button" class="card-hit" aria-label={t('编辑 {name}', { name: p.name })} onclick={() => openEdit(p)}></button>
                <div class="c-top">
                  {#if providerLogo(p)}<span class="av logo">{@html providerLogo(p)}</span>{:else}<span class="av" style:--h={h}>{initial(p.name)}</span>{/if}
                  <div class="c-name">
                    <div class="n1">{p.name}{#if health[p.id]}<span class="hdot" class:ok={health[p.id] === 'ok'} class:bad={health[p.id] === 'bad'} title={health[p.id] === 'ok' ? t('最近一次请求成功') : t('最近一次请求失败')}></span>{/if}</div>
                    <div class="n2">{p.note || host(p.baseUrl)}</div>
                  </div>
                  <!-- 眼睛 = 显示在模型列表（关掉只是不进菜单，会话照常能跑）；开关 = 启用（关掉是硬停） -->
                  <button type="button" class="c-eye" class:off={p.showInPicker === false} disabled={!!toggling[p.id]} onclick={() => toggleShown(p)}
                    title={p.showInPicker === false ? t('已从模型菜单隐藏（正在用它的会话照常能跑）——点一下显示') : t('显示在模型菜单里——点一下隐藏（只是不出现在菜单里；要硬停用请关右边的开关）')}
                    aria-label={t('显示在模型列表')} aria-pressed={p.showInPicker !== false}>
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">{#if p.showInPicker === false}<path d="M3 3l14 14M8.5 8.6a2 2 0 0 0 2.9 2.8M6.2 6.3C4.6 7.3 3.4 8.6 2.8 10c1.3 3 4 5 7.2 5 1.4 0 2.7-.4 3.8-1.1M9 5.1c.3 0 .7-.1 1-.1 3.2 0 5.9 2 7.2 5-.4.9-.9 1.7-1.6 2.4"/>{:else}<path d="M2.8 10C4.1 7 6.8 5 10 5s5.9 2 7.2 5c-1.3 3-4 5-7.2 5s-5.9-2-7.2-5z"/><circle cx="10" cy="10" r="2.2"/>{/if}</svg>
                  </button>
                  <div class="c-sw" title={t('启用：关掉后用它的会话会报「已被删除或停用」')}><SToggle checked={p.enabled} disabled={!!toggling[p.id]} onchange={(v) => toggleEnabled(p, v)} label={t('启用 {name}', { name: p.name })} /></div>
                </div>
                <div class="c-tags">
                  <span class="tag">{p.protocol === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
                  <span class="tag">{t('{n} 个模型', { n: chatCount(p) })}</span>
                  {#if p.showInPicker === false}<span class="tag">{t('已隐藏')}</span>{/if}
                  {#if p.shared && cp.canShare}<span class="tag share">{t('已共享给成员')}</span>{/if}
                  {#if !p.hasKey && p.authStyle !== 'none'}<span class="tag warn">{t('缺 Key')}</span>{/if}
                  {#if p.defaultModel}<span class="tag mono">{p.models.find((m) => m.id === p.defaultModel)?.label || p.defaultModel}</span>{/if}
                </div>
              </div>
            {/each}
          </div>
        {:else if !cp.shared.length}
          <div class="empty">
            <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="14" width="44" height="14" rx="4"/><rect x="10" y="36" width="44" height="14" rx="4"/><circle cx="18" cy="21" r="1.6" fill="currentColor"/><circle cx="18" cy="43" r="1.6" fill="currentColor"/><path d="M26 21h12M26 43h8"/></svg>
            <div class="e1">{t('还没有接入任何模型服务')}</div>
            <div class="e2">{t('从常用厂商预设开始，填上 API Key、拉取模型就能用。')}</div>
            <button type="button" class="btn primary" onclick={() => (view = 'presets')}>＋ {t('添加服务')}</button>
          </div>
        {/if}
        {#if cp.shared.length}
          <!-- 成员：管理员共享给他的服务（只读：地址和 Key 不下发，点不进编辑器） -->
          <div class="meta">{t('管理员共享给你的服务')}</div>
          <div class="note">{t('这些服务由管理员接入，在输入框模型菜单的 More models 里直接选用。用的是管理员的 API Key，计入本站额度；地址和 Key 你看不到，也改不了，有问题请联系管理员。')}</div>
          <div class="grid shared">
            {#each cp.shared as p (p.id)}
              <div class="card ro" class:dis={!p.enabled}>
                <div class="c-top">
                  {#if providerLogo(p)}<span class="av logo">{@html providerLogo(p)}</span>{:else}<span class="av" style:--h={hue(p.name)}>{initial(p.name)}</span>{/if}
                  <div class="c-name">
                    <div class="n1">{p.name}</div>
                    <div class="n2">{p.note || p.models.find((m) => m.id === p.defaultModel)?.label || p.defaultModel}</div>
                  </div>
                </div>
                <div class="c-tags">
                  <span class="tag">{p.protocol === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
                  <span class="tag">{t('{n} 个模型', { n: p.models.length })}</span>
                  <span class="tag share">{t('管理员共享')}</span>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

    {:else if view === 'presets'}
      <div class="scroll">
        <p class="sub">{t('预设只填好地址与协议，型号以拉取到的为准，所有项都能再改。')}</p>
        <div class="pgrid">
          <button type="button" class="ptile blank" onclick={() => pickPreset(null)}>
            <span class="av plain"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg></span>
            <span class="pn">{t('从头配置')}</span><span class="pu">{t('任意兼容端点')}</span>
          </button>
          {#each cp.presets as pr (pr.id)}
            <button type="button" class="ptile" onclick={() => pickPreset(pr)}>
              {#if providerLogo({ preset: pr.id })}<span class="av logo">{@html providerLogo({ preset: pr.id })}</span>{:else}<span class="av" style:--h={hue(pr.name)}>{initial(pr.name)}</span>{/if}
              <span class="pn">{pr.name}</span>
              <span class="pu">{pr.note || host(pr.baseUrl)}</span>
              <span class="tag">{pr.protocol === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
            </button>
          {/each}
        </div>
      </div>

    {:else}
      <div class="edwrap">
        {#key editorKey}
          <ProviderEditor source={editing}
            onClose={() => { view = 'list'; editing = null; editorDirty = false; refreshHealth(); }}
            onSaved={(p) => { editing = p; editorDirty = false; }}
            onDeleted={() => { view = 'list'; editing = null; editorDirty = false; }}
            bind:dirtyOut={editorDirty} />
        {/key}
      </div>
    {/if}
  </div>
</div>

<style>
  .ov { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; padding: 24px;
    background: var(--st-backdrop); backdrop-filter: blur(2px); animation: fade .16s ease; }
  @keyframes fade { from { opacity: 0; } }
  .dlg { width: min(1000px, 100%); height: min(780px, 100%); display: flex; flex-direction: column; overflow: hidden;
    background: var(--st-surface); color: var(--text); border-radius: 18px; box-shadow: var(--st-menu-shadow);
    animation: pop .22s cubic-bezier(.2, .9, .3, 1.08); }
  @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.985); } }
  .top { flex: none; display: flex; align-items: center; gap: 8px; height: 58px; padding: 0 12px 0 18px; border-bottom: 1px solid var(--st-hair); }
  .ttl { flex: 1; min-width: 0; }
  .t1 { font-family: var(--font-brand-serif), Georgia, serif; font-size: 19px; font-weight: 500; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .t2 { font-size: 12px; color: var(--st-muted); margin-top: 1px; }
  .hbtn { width: 34px; height: 34px; flex: none; display: grid; place-items: center; border: 0; border-radius: 9px; background: transparent; color: var(--st-text2); cursor: pointer; }
  .hbtn:hover { background: var(--st-hover); color: var(--text); }
  .hbtn svg { width: 18px; height: 18px; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 24px 28px 32px; }
  .edwrap { flex: 1; min-height: 0; }
  .intro { display: flex; align-items: flex-start; gap: 24px; padding: 20px 22px; border-radius: 14px;
    background: linear-gradient(135deg, color-mix(in srgb, #d97757 9%, transparent), color-mix(in srgb, var(--st-seg) 80%, transparent)); border: 1px solid var(--st-hair); }
  .intro-tx { flex: 1; min-width: 0; }
  .note { margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: var(--st-seg); font-size: 13px; color: var(--st-text2); line-height: 1.55; }
  .note.warn { background: color-mix(in srgb, #e0a43b 14%, transparent); color: var(--text); }
  .intro h2 { margin: 0 0 6px; font-family: var(--font-brand-serif), Georgia, serif; font-size: 22px; font-weight: 500; letter-spacing: -.01em; }
  .intro p { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--st-text2); max-width: 600px; }
  .meta { margin: 22px 0 10px; font-size: 12.5px; color: var(--st-muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .card { position: relative; padding: 16px; border: 1px solid var(--st-line); border-radius: 14px; background: var(--st-surface); transition: border-color .15s, box-shadow .15s, transform .15s; }
  .card:hover { border-color: color-mix(in srgb, var(--text) 22%, transparent); box-shadow: 0 6px 22px rgba(0, 0, 0, .08); transform: translateY(-1px); }
  .card.ro:hover { border-color: var(--st-line); box-shadow: none; transform: none; }
  .card.dis .c-top .c-name, .card.dis .c-tags, .card.dis .av { opacity: .5; }
  .card-hit { position: absolute; inset: 0; border: 0; background: transparent; border-radius: inherit; cursor: pointer; }
  .c-top { position: relative; display: flex; align-items: center; gap: 12px; pointer-events: none; }
  .c-sw { pointer-events: auto; }
  .c-eye { pointer-events: auto; width: 30px; height: 30px; flex: none; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--st-text2); cursor: pointer; }
  .c-eye:hover:not(:disabled) { background: var(--st-hover); color: var(--text); }
  .c-eye.off { color: var(--st-muted); }
  .c-eye:disabled { opacity: .45; cursor: default; }
  .c-eye svg { width: 17px; height: 17px; }
  .av { --h: 20; width: 38px; height: 38px; flex: none; display: grid; place-items: center; border-radius: 11px; font-weight: 600; font-size: 16px;
    color: hsl(var(--h) 45% 72%); background: hsl(var(--h) 45% 55% / .16); }
  :global(html[data-theme="light"]) .av { color: hsl(var(--h) 38% 40%); }
  .av.plain { color: var(--st-text2); background: var(--st-seg); }
  /* 官方品牌标：中性底色方块，彩色标保留原色，单色标跟随文字色 */
  .av.logo { color: var(--text); background: var(--st-seg); box-shadow: inset 0 0 0 1px var(--st-hair); }
  .av.logo :global(svg) { width: 58%; height: 58%; display: block; }
  :global(html[data-theme="light"]) .av.logo { color: var(--text); }
  :global(html[data-theme="light"]) .av.plain { color: var(--st-text2); }
  .av.plain svg { width: 18px; height: 18px; }
  .c-name { flex: 1; min-width: 0; }
  .n1 { display: flex; align-items: center; gap: 7px; font-size: 14.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .n2 { margin-top: 2px; font-size: 12px; color: var(--st-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hdot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--st-muted); }
  .hdot.ok { background: #3fa46a; box-shadow: 0 0 0 3px color-mix(in srgb, #3fa46a 18%, transparent); }
  .hdot.bad { background: #d9534f; box-shadow: 0 0 0 3px color-mix(in srgb, #d9534f 18%, transparent); }
  .c-tags { position: relative; display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; pointer-events: none; }
  .tag { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 7px; background: var(--st-seg); color: var(--st-text2); font-size: 11.5px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tag.warn { background: color-mix(in srgb, #e0a43b 18%, transparent); color: #b7791f; }
  .tag.share { background: color-mix(in srgb, var(--st-primary) 12%, transparent); color: var(--st-text2); }
  .grid.shared { margin-bottom: 8px; }
  .tag.mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px; }
  .empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 56px 20px 24px; color: var(--st-muted); }
  .empty svg { width: 64px; height: 64px; opacity: .55; margin-bottom: 14px; }
  .e1 { font-size: 15px; color: var(--text); font-weight: 500; }
  .e2 { margin: 6px 0 18px; font-size: 13px; }
  .sub { margin: 0 0 16px; font-size: 13px; color: var(--st-muted); }
  .pgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); gap: 10px; }
  .ptile { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 14px; border: 1px solid var(--st-line); border-radius: 13px; background: var(--st-surface); color: var(--text); font: inherit; text-align: left; cursor: pointer; transition: border-color .15s, background-color .15s, transform .15s; }
  .ptile:hover { border-color: color-mix(in srgb, var(--text) 25%, transparent); background: var(--st-hover); transform: translateY(-1px); }
  .ptile .av { margin-bottom: 8px; width: 34px; height: 34px; font-size: 15px; border-radius: 10px; }
  .ptile.blank { border-style: dashed; }
  .pn { font-size: 14px; font-weight: 600; }
  .pu { font-size: 12px; color: var(--st-muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ptile .tag { margin-top: 6px; height: 20px; font-size: 11px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 16px; border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-surface); color: var(--text); font: inherit; font-size: 13.5px; cursor: pointer; white-space: nowrap; flex: none; }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); border-color: transparent; }
  .btn.primary:hover { opacity: .88; }
  .note { padding: 10px 12px; border-radius: 10px; margin-top: 14px; font-size: 13px; }
  .note.warn { background: color-mix(in srgb, #d9534f 10%, transparent); }

  @media (max-width: 699px) {
    .ov { padding: 0; align-items: stretch; }
    .dlg { width: 100%; height: 100%; border-radius: 0; animation: up .26s cubic-bezier(.2, .9, .3, 1); padding-top: env(safe-area-inset-top); }
    @keyframes up { from { transform: translateY(24px); opacity: 0; } }
    .scroll { padding: 16px 16px 28px; }
    .intro { flex-direction: column; gap: 14px; padding: 16px; }
    .intro h2 { font-size: 19px; }
    .grid { grid-template-columns: 1fr; }
    .pgrid { grid-template-columns: 1fr 1fr; }
  }
</style>
