<script>
  // 连接器详情 = 官方 Claude 桌面「自定义 › 连接器 › <某个>」控制面板：
  //   头部 = 名字 + 状态（已连接 · N 个工具 / 需要登录 / 连接失败）+「连接 / 断开连接」+ ⋯ 菜单；
  //   授权进行中的提示条（新标签页里登录；只认 localhost 的粘地址；claude.ai 代理类点「我已完成」）；
  //   工具权限 = 按「交互 / 只读 / 写入与删除」分组，每组一个总开关，每个工具三档（总是允许 / 需要批准 / 禁止）。
  // 数据：状态与工具清单来自 /api/mcp-oauth/connectors（服务端起短命 CLI 探，见 runtime/mcp-probe.mjs）；
  // 权限存在注册表 connector.tools，会话注入时作为 CLI 原生的 tools[].permission_policy 带上（只对远程连接器有效）。
  // 下面「生效 Agent / 连接配置 / 管理」几节还是 Customize 自己画，经 children 传进来。
  import { ic } from './icons.js';
  import { t, tr } from '../../lib/i18n.js';
  import OAuthAppSetup from './OAuthAppSetup.svelte';   // 授权服务器不开放动态注册时：服主自备 OAuth 应用

  let {
    it, st = null, loading = false, flow = null,
    onConnect, onDisconnect, onCancelAuth, onReopen, onSubmitUrl, onConfirmWeb,
    onRefresh, onPolicy, onEdit, onToggle, onUninstall, children,
    app = null,   // OAuthAppSetup 的回调：{ onSaved, onToast, onConfirm }
  } = $props();

  const remote = $derived(it.connector?.transport && it.connector.transport !== 'stdio');
  const status = $derived(st?.status || '');
  const authing = $derived(!!flow && ['starting', 'waiting'].includes(flow.status));
  // 要自备 OAuth 应用的连接器（状态表标了 oauthApp，或刚点连接被服务端回「先配置应用」）
  const appNeeded = $derived(!!st?.oauthApp || !!flow?.needsApp);
  const appMissing = $derived(!authing && ((st?.oauthApp && !st.oauthApp.configured) || (flow?.needsApp && flow.status === 'error')));
  const toApp = () => document.getElementById('oauth-app-' + it.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const tools = $derived((st?.tools || []).map((x) => ({
    name: x.name, description: x.description || '',
    readOnly: x.readOnly ?? !!x.annotations?.readOnly,
    ui: x.ui ?? !!(x._meta && (x._meta.ui || x._meta['ui/resourceUri'])),
  })));
  const GROUPS = [
    { k: 'ui', label: t('交互工具'), test: (x) => x.ui },
    { k: 'read', label: t('只读工具'), test: (x) => !x.ui && x.readOnly },
    { k: 'write', label: t('写入与删除工具'), test: (x) => !x.ui && !x.readOnly },
  ];
  const groups = $derived(GROUPS.map((g) => ({ ...g, list: tools.filter(g.test) })).filter((g) => g.list.length));
  const LEVELS = [
    { v: 'always_allow', label: t('总是允许'), icon: 'allow' },
    { v: 'always_ask', label: t('需要批准'), icon: 'hand' },
    { v: 'always_deny', label: t('禁止'), icon: 'deny' },
  ];
  const pol = (name) => it.connector?.tools?.[name] || 'always_ask';
  const groupPol = (list) => { const s = new Set(list.map((x) => pol(x.name))); return s.size === 1 ? [...s][0] : 'mixed'; };
  const lvl = (v) => LEVELS.find((l) => l.v === v);

  let folded = $state({});
  let menu = $state('');   // '' | more | g:<组>
  let pasted = $state('');
  function setGroup(list, v) { menu = ''; onPolicy(Object.fromEntries(list.map((x) => [x.name, v]))); }
  function onWinDown(e) { if (menu && !e.target.closest?.('.cd-pop, .cd-popbtn')) menu = ''; }

  const statusLine = $derived.by(() => {
    if (!it.enabled) return { tone: 'mute', text: t('已停用') };
    if (!remote) return { tone: 'mute', text: t('本地连接器 · 在对话里启动') };
    if (flow?.status === 'starting') return { tone: 'busy', text: t('正在准备授权…') };
    if (flow?.status === 'waiting') return { tone: 'warn', text: t('等待你在授权页完成登录') };
    if (appMissing && status !== 'connected') return { tone: 'warn', text: t('需要配置 OAuth 应用') };
    if (!st) return loading ? { tone: 'busy', text: t('正在检测…') } : { tone: 'mute', text: t('状态未知') };
    if (status === 'connected') return { tone: 'ok', text: tools.length ? t('已连接 · {n} 个工具', { n: tools.length }) : t('已连接') };
    if (status === 'needs-auth') return { tone: 'warn', text: t('需要登录') };
    if (status === 'failed') return { tone: 'crit', text: t('连接失败') };
    if (status === 'pending') return { tone: 'busy', text: t('连接中…') };
    return { tone: 'mute', text: t('状态未知') };
  });
</script>

<svelte:window onpointerdown={onWinDown} />

<div class="cz-dh">
  <span class="cz-tile lg">{@html ic('connector')}</span>
  <div class="cz-dh-tx">
    <h2>{it.name}</h2>
    <p class="cd-st tone-{statusLine.tone}">{#if statusLine.tone === 'busy'}<span class="cz-spin"></span>{:else}<i></i>{/if}<span>{statusLine.text}</span>{#if remote}<span class="cd-badge">{t('远程')}</span>{/if}</p>
  </div>
  <div class="cd-acts">
    {#if remote && it.enabled}
      {#if authing}
        <button class="cz-btn" disabled><span class="cz-spin"></span>{t('连接中…')}</button>
      {:else if appMissing && status !== 'connected'}
        <button class="cz-btn pri" onclick={toApp}>{t('配置 OAuth 应用')}</button>
      {:else if status === 'connected' && st?.oauth}
        <button class="cz-btn" onclick={onDisconnect}>{t('断开连接')}</button>
      {:else if status && status !== 'connected' && status !== 'pending'}
        <button class="cz-btn pri" onclick={onConnect}>{status === 'failed' ? t('重试') : t('连接')}</button>
      {/if}
    {/if}
    <button class="cz-ibtn cd-popbtn" class:on={menu === 'more'} title={t('更多')} aria-label={t('更多')} onclick={() => { menu = menu === 'more' ? '' : 'more'; }}>{@html ic('more', 2)}</button>
    {#if menu === 'more'}
      <div class="cz-pop cd-pop narrow">
        {#if remote}<button class="cz-mi" onclick={() => { menu = ''; onRefresh(); }}>{@html ic('refresh')}{t('重新检测')}</button>{/if}
        <button class="cz-mi" onclick={() => { menu = ''; onEdit(); }}>{@html ic('connector')}{t('编辑配置')}</button>
        <button class="cz-mi" onclick={() => { menu = ''; onToggle(); }}>{@html ic(it.enabled ? 'deny' : 'allow')}{it.enabled ? t('停用') : t('启用')}</button>
        <div class="cz-pop-sep"></div>
        <button class="cz-mi danger" onclick={() => { menu = ''; onUninstall(); }}>{@html ic('x')}{t('卸载')}</button>
      </div>
    {/if}
  </div>
</div>
{#if it.description}<p class="cz-lead sel-text">{it.description}</p>{/if}

{#if flow?.status === 'waiting'}
  <div class="cd-auth">
    {#if flow.scheme === 'localhost'}
      <p>{t('已在新标签页打开授权页。这个服务只接受本机回调：授权后跳转的页面会打不开，把那个页面地址栏里的完整地址（http://localhost 开头、带 code=）粘到这里。')}</p>
      <div class="cz-inrow">
        <input class="cz-in mono" placeholder="http://localhost:…/callback?code=…" bind:value={pasted} onkeydown={(e) => { if (e.key === 'Enter' && pasted.trim()) onSubmitUrl(pasted); }} />
        <button class="cz-btn pri" disabled={!pasted.trim() || flow.busy} onclick={() => onSubmitUrl(pasted)}>{t('提交')}</button>
      </div>
    {:else if flow.scheme === 'web'}
      <p>{t('已在新标签页打开授权页。在那边授权完，回来点「我已完成」。')}</p>
    {:else}
      <p>{t('已在新标签页打开授权页。登录并同意后会自动回到这里。')}</p>
    {/if}
    <div class="cd-auth-acts">
      {#if flow.authUrl}<button class="cz-btn sm" onclick={onReopen}>{@html ic('link')}{t('打开授权页')}</button>{/if}
      {#if flow.scheme === 'web'}<button class="cz-btn sm pri" disabled={flow.busy} onclick={onConfirmWeb}>{t('我已完成')}</button>{/if}
      <span class="cz-grow"></span>
      <button class="cz-btn sm" onclick={onCancelAuth}>{t('取消')}</button>
    </div>
    {#if flow.error}<div class="cz-err">{tr(flow.error)}</div>{/if}
  </div>
{:else if appMissing}
  <!-- 下面「OAuth 应用」一节就是解法，不再重复报「不支持动态注册」 -->
{:else if flow && ['error', 'expired'].includes(flow.status) && flow.error}
  <div class="cz-diag err">{tr(flow.error)}</div>
{:else if status === 'failed' && st?.error}
  <div class="cz-diag err">{tr(st.error)}</div>
{/if}

{#if remote && appNeeded}
  <OAuthAppSetup id={it.id} onSaved={app?.onSaved} onToast={app?.onToast} onConfirm={app?.onConfirm} />
{/if}

{#if remote}
  <div class="cz-sec">{t('工具权限')}</div>
  <p class="cd-hint">{t('选择 Claude 什么时候可以用这些工具。「需要批准」照会话的权限模式处理；改动从下一条消息起生效。')}</p>
  {#if status === 'connected' && groups.length}
    <div class="cz-list cd-tools">
      {#each groups as g (g.k)}
        {@const gp = groupPol(g.list)}
        <div class="cd-gh">
          <button class="cd-fold" aria-expanded={!folded[g.k]} onclick={() => { folded = { ...folded, [g.k]: !folded[g.k] }; }}>
            <span class="cd-chev" class:shut={folded[g.k]}>{@html ic('chevDown', 2)}</span>
            <span>{g.label}</span><span class="cd-n">{g.list.length}</span>
          </button>
          <span class="cz-grow"></span>
          <div class="cd-gsel">
            <button class="cz-btn sm cd-popbtn" onclick={() => { menu = menu === 'g:' + g.k ? '' : 'g:' + g.k; }}>
              {#if gp !== 'mixed'}{@html ic(lvl(gp).icon)}{lvl(gp).label}{:else}{t('自定义')}{/if}{@html ic('chevDown', 2)}
            </button>
            {#if menu === 'g:' + g.k}
              <div class="cz-pop cd-pop narrow">
                {#each LEVELS as l (l.v)}<button class="cz-mi" onclick={() => setGroup(g.list, l.v)}>{@html ic(l.icon)}{l.label}{#if gp === l.v}<span class="ck">{@html ic('check', 2)}</span>{/if}</button>{/each}
              </div>
            {/if}
          </div>
        </div>
        {#if !folded[g.k]}
          {#each g.list as x (x.name)}
            {@const p = pol(x.name)}
            <div class="cd-tool">
              <span class="cd-tool-tx"><span class="mono">{x.name}</span>{#if x.description}<small title={x.description}>{x.description}</small>{/if}</span>
              <span class="cd-tri" role="radiogroup" aria-label={x.name}>
                {#each LEVELS as l (l.v)}
                  <button role="radio" aria-checked={p === l.v} class:on={p === l.v} class="lv-{l.v}" title={l.label} aria-label={l.label}
                    onclick={() => { if (p !== l.v) onPolicy({ [x.name]: l.v }); }}>{@html ic(l.icon)}</button>
                {/each}
              </span>
            </div>
          {/each}
        {/if}
      {/each}
    </div>
  {:else if status === 'connected'}
    <div class="cz-empty">{t('这个连接器没有提供工具。')}</div>
  {:else if loading && !st}
    <div class="cz-empty"><span class="cz-spin"></span> {t('正在读取工具清单…')}</div>
  {:else}
    <div class="cz-empty">{status === 'needs-auth' || authing ? t('连接后这里会列出它提供的工具。') : t('连上以后这里会列出它提供的工具。')}</div>
  {/if}
{/if}

{@render children?.()}

<style>
  .cd-st { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .cd-st > i { width: 7px; height: 7px; border-radius: 50%; background: var(--cz-ink3); flex: none; }
  .cd-st.tone-ok > i { background: var(--cz-ok); }
  .cd-st.tone-warn > i { background: var(--cz-warn); }
  .cd-st.tone-crit > i { background: var(--cz-crit); }
  .cd-st.tone-warn { color: var(--cz-warn); }
  .cd-st.tone-crit { color: var(--cz-crit); }
  .cd-st :global(.cz-spin) { width: 12px; height: 12px; }
  .cd-badge { padding: 1px 8px; border-radius: 999px; box-shadow: inset 0 0 0 1px var(--cz-line2); color: var(--cz-ink2); font-size: 12px; }
  .cd-acts { position: relative; display: flex; align-items: center; gap: 6px; flex: none; align-self: flex-start; margin-top: 4px; }
  .cd-acts :global(.cz-ibtn svg) { width: 18px; height: 18px; }
  :global(.cz-mi.danger) { color: var(--cz-crit); }
  :global(.cz-mi.danger svg) { color: var(--cz-crit); }
  .cd-auth { margin: 6px 0 4px; padding: 14px 16px; border-radius: 12px; background: var(--cz-card); box-shadow: inset 0 0 0 1px var(--cz-line2); }
  .cd-auth p { margin: 0 0 10px; font-size: 13.5px; line-height: 1.6; color: var(--cz-ink2); }
  .cd-auth .cz-inrow { margin-bottom: 10px; }
  .cd-auth-acts { display: flex; align-items: center; gap: 8px; }
  .cd-hint { margin: -4px 2px 12px; font-size: 13px; color: var(--cz-ink3); line-height: 1.55; }
  .cd-tools { overflow: visible; }
  .cd-gh { position: relative; display: flex; align-items: center; gap: 8px; min-height: 50px; padding: 6px 12px 6px 10px; }
  .cd-gh:not(:first-child) { border-top: 1px solid var(--cz-line); }
  .cd-fold { display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 6px; border-radius: 8px; font-size: 15px; font-weight: 500; }
  .cd-fold:hover { background: var(--cz-hover); }
  .cd-chev { display: inline-flex; color: var(--cz-ink3); transition: transform .16s ease; }
  .cd-chev :global(svg) { width: 16px; height: 16px; }
  .cd-chev.shut { transform: rotate(-90deg); }
  .cd-n { min-width: 22px; height: 20px; padding: 0 6px; border-radius: 10px; box-shadow: inset 0 0 0 1px var(--cz-line2); color: var(--cz-ink2); font-size: 12px; line-height: 20px; text-align: center; font-variant-numeric: tabular-nums; }
  .cd-gsel { position: relative; }
  .cd-gsel :global(.cz-btn svg) { width: 15px; height: 15px; }
  .cd-tool { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 7px 14px 7px 42px; }
  .cd-tool:hover { background: var(--cz-hover); }
  .cd-tool-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; font-size: 14px; }
  .cd-tool-tx small { font-size: 12.5px; color: var(--cz-ink3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cd-tri { display: inline-flex; padding: 2px; gap: 1px; border-radius: 9px; box-shadow: inset 0 0 0 1px var(--cz-line2); flex: none; }
  .cd-tri button { width: 30px; height: 26px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; color: var(--cz-ink3); transition: background .12s ease, color .12s ease; }
  .cd-tri button :global(svg) { width: 17px; height: 17px; }
  .cd-tri button:hover { color: var(--cz-ink); }
  .cd-tri button.on { background: var(--cz-sel); color: var(--cz-ink); }
  .cd-tri button.on.lv-always_allow { color: var(--cz-ok); }
  .cd-tri button.on.lv-always_deny { color: var(--cz-crit); }
  @container (max-width: 520px) {
    .cd-tool { padding-left: 16px; }
    .cd-tool-tx small { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  }
</style>
