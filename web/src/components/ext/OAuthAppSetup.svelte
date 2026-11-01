<script>
  // 连接器控制面板里的「OAuth 应用」一节：授权服务器不开放动态注册（Google、Zoom……）的连接器，要服主自己去平台后台
  // 注册一个 OAuth 应用，把客户端 ID / 密钥填回来（服务端 routes/mcp-oauth.mjs 的 /api/mcp-oauth/app，按授权服务器存，
  // 同一平台的连接器共用一个）。这里给分步指引：Google、Zoom 有精确步骤，其它平台给通用说明；
  // 回调地址与权限清单直接从这台服务器与连接器的元数据里来，一键复制。密钥只写不读（服务端只回「有没有」）。
  import { api } from '../../lib/api.js';
  import { copyText } from '../../lib/agentKeys.svelte.js';
  import { t, tr } from '../../lib/i18n.js';
  import { ic } from './icons.js';

  let { id, onSaved, onToast, onConfirm } = $props();

  let info = $state(null);
  let loadErr = $state('');
  let clientId = $state('');
  let clientSecret = $state('');
  let redirectUri = $state('');
  let busy = $state(false);
  let err = $state('');
  let guideOpen = $state(false);

  async function load() {
    loadErr = '';
    try {
      const v = await api.get('/api/mcp-oauth/app?connector=' + encodeURIComponent(id));
      info = v;
      clientId = v.app?.clientId || '';
      clientSecret = '';
      redirectUri = v.app?.redirectUri || v.suggestedRedirectUri || '';
      guideOpen = !v.app;
    } catch (e) { loadErr = (e?.body && e.body.error) || String(e?.message || e); }
  }
  $effect(() => { id; info = null; err = ''; load(); });

  const P = $derived(info?.providerName || '');
  // 每个平台的注册步骤：{ text, link? }。文案里的 {p} 是平台名
  const GUIDES = {
    google: [
      { text: t('打开 Google Cloud 控制台，新建一个项目（或选一个现有的）。'), link: 'https://console.cloud.google.com/projectcreate' },
      { text: t('启用两个 API：Gmail API 和 Gmail MCP API（打开链接，确认项目后点「启用」）。用 Drive、Calendar 等其它 Google 连接器时，换成对应的 API 和 MCP API。'), link: 'https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,gmailmcp.googleapis.com' },
      { text: t('进入「Google Auth Platform」：「品牌塑造」填应用名称和支持邮箱；「目标对象」选「外部」，并在「测试用户」里加上每个要连接的 Google 账号（项目属于 Google Workspace 组织时可以选「内部」，就不用加测试用户）。'), link: 'https://console.cloud.google.com/auth/overview' },
      { text: t('在「数据访问」里点「添加或移除范围」，把下面列出的全部权限范围粘贴到「手动添加范围」，加入后保存。'), link: 'https://console.cloud.google.com/auth/scopes' },
      { text: t('在「客户端」里创建 OAuth 客户端：应用类型选「Web 应用」，勾选「Use this client for an AI-powered agent」，「已获授权的重定向 URI」填下面的回调地址。'), link: 'https://console.cloud.google.com/auth/clients/create' },
      { text: t('把生成的客户端 ID 和客户端密钥填到下面，保存后点「连接」。') },
    ],
    zoom: [
      { text: t('用 Zoom 账号登录 App Marketplace，选「Develop › Build App」，应用类型选「General App」。账号要是所有者、管理员，或有「Zoom for developers」角色。'), link: 'https://marketplace.zoom.us/develop/create' },
      { text: t('「Basic Information」里管理方式选「User-managed」（每个人授权自己的 Zoom 账号）。') },
      { text: t('在「OAuth Information」里，把下面的回调地址同时填进「OAuth Redirect URL」和「OAuth Allow List」。') },
      { text: t('在「Scopes」里点「Add Scopes」，按下面的清单逐项勾选，并给每项填一句用途说明。') },
      { text: t('在「App Credentials」里复制 Client ID 和 Client Secret（用 Development 那一组即可），填到下面，保存后点「连接」。') },
    ],
  };
  const NOTES = {
    google: t('Gmail 等 Google 的 MCP 服务还在预览期，Google 文档要求先加入 Google Workspace 开发者预览计划（约两天审核）。测试模式下最多 100 个测试用户，登录 7 天后失效，要回来重新连接；授权时提示「Google 尚未验证此应用」，点「继续」即可。'),
    zoom: t('应用不用发布到 Marketplace，但没发布的应用只有你这个 Zoom 账号下的成员能授权；Zoom 还要求连接 MCP 的账号有管理员或开发者权限。'),
  };
  // 回调地址：Google 只认 https 域名（localhost 例外，不认裸 IP）；其它平台也建议 https
  const ruWarn = $derived.by(() => {
    let u;
    try { u = new URL(redirectUri.trim()); } catch { return redirectUri.trim() ? t('回调地址不是完整的网址') : ''; }
    const ip = /^[\d.]+$|^\[/.test(u.hostname), local = u.hostname === 'localhost';
    if (info?.provider === 'google' && (ip || (u.protocol !== 'https:' && !local))) return t('Google 只接受 https 域名的回调地址（localhost 例外，不能用 IP）。请改成你从外网访问 bridge 的域名，例如 https://你的域名/api/mcp-oauth/callback');
    if (u.protocol !== 'https:' && !local) return t('建议用 https 域名的回调地址，很多平台不接受 http 或 IP');
    return '';
  });
  const steps = $derived(info ? GUIDES[info.provider] || [
    { text: t('到 {p} 的开发者后台注册一个 OAuth 应用，客户端类型选「Web 应用」或「服务端应用」。', { p: P }) },
    { text: t('回调（重定向）地址填下面这个，权限（scope）加上下面列出的全部。') },
    { text: t('把客户端 ID 和客户端密钥填到下面，保存后点「连接」。') },
  ] : []);

  async function copy(s, what) {
    const ok = await copyText(s);
    onToast?.(ok ? t('已复制{what}', { what }) : t('复制失败，请手动选中复制'), !ok);
  }

  async function save() {
    if (busy) return;
    err = '';
    if (!clientId.trim()) { err = t('请填写客户端 ID'); return; }
    if (!info?.app?.hasSecret && !clientSecret.trim()) { err = t('请填写客户端密钥'); return; }
    busy = true;
    try {
      await api.post('/api/mcp-oauth/app', { connector: id, clientId: clientId.trim(), clientSecret: clientSecret.trim(), redirectUri: redirectUri.trim() });
      await load();
      onToast?.(t('OAuth 应用已保存'));
      onSaved?.();
    } catch (e) { err = tr((e?.body && e.body.error) || String(e?.message || e)); }
    finally { busy = false; }
  }

  async function remove() {
    if (busy) return;
    const yes = await onConfirm?.({ title: t('删除这个 OAuth 应用？'), desc: t('用它的连接器之后要重新配置才能连接；已经连上的暂时不受影响。'), yes: t('删除'), danger: true });
    if (!yes) return;
    busy = true; err = '';
    try { await api.post('/api/mcp-oauth/app/remove', { connector: id }); await load(); onSaved?.(); }
    catch (e) { err = tr((e?.body && e.body.error) || String(e?.message || e)); }
    finally { busy = false; }
  }
</script>

{#if loadErr}
  <div class="cz-sec">{t('OAuth 应用')}</div>
  <div class="cz-diag err">{tr(loadErr)} <button class="cz-inl" onclick={load}>{t('重试')}</button></div>
{:else if info && info.oauth && (info.needed || info.app)}
  <div class="cz-sec" id="oauth-app-{id}">{t('OAuth 应用')}<span class="cz-grow"></span>
    {#if info.app}<span class="oa-chip ok">{t('已配置')}</span>{:else}<span class="oa-chip">{t('未配置')}</span>{/if}
  </div>
  <p class="oa-lead">
    {t('{p} 不支持自动注册客户端，需要服主在 {p} 后台注册一个 OAuth 应用，把客户端 ID 和密钥填在这里。全服配一次就行，每个人连接时登录的仍是自己的账号。', { p: P })}
    {#if info.shared?.length}{t('同一个应用也给 {names} 用。', { names: info.shared.join(t('、')) })}{/if}
  </p>

  <div class="oa-card">
    <button class="oa-gh" aria-expanded={guideOpen} onclick={() => { guideOpen = !guideOpen; }}>
      <span class="oa-chev" class:shut={!guideOpen}>{@html ic('chevDown', 2)}</span>
      <span>{t('注册步骤')}</span>
    </button>
    {#if guideOpen}
      <ol class="oa-steps">
        {#each steps as s, i (i)}
          <li><span>{s.text}</span>{#if s.link}<a class="oa-lnk" href={s.link} target="_blank" rel="noopener noreferrer">{t('打开')}{@html ic('link')}</a>{/if}</li>
        {/each}
      </ol>
      {#if NOTES[info.provider]}<p class="oa-note">{NOTES[info.provider]}</p>{/if}
    {/if}

    <label class="cz-lab" for="oa-ru-{id}">{t('回调地址')}</label>
    <div class="cz-inrow">
      <input id="oa-ru-{id}" class="cz-in mono" bind:value={redirectUri} spellcheck="false" />
      <button class="cz-btn" onclick={() => copy(redirectUri, t('回调地址'))}>{t('复制')}</button>
    </div>
    {#if ruWarn}<div class="cz-diag oa-warn">{ruWarn}</div>{/if}
    <p class="oa-hint">{t('按你现在访问 bridge 的地址生成。以后换了域名，要回平台后台同步改，并在这里重新保存。')}</p>

    {#if info.scopes?.length}
      <div class="cz-lab oa-labrow">{t('权限范围（{n} 项）', { n: info.scopes.length })}<span class="cz-grow"></span>
        <button class="cz-btn sm" onclick={() => copy(info.scopes.join(' '), t('权限清单'))}>{t('全部复制')}</button>
      </div>
      <div class="oa-scopes mono sel-text">{#each info.scopes as s (s)}<span>{s}</span>{/each}</div>
    {/if}

    <label class="cz-lab" for="oa-id-{id}">{t('客户端 ID')}</label>
    <input id="oa-id-{id}" class="cz-in mono" bind:value={clientId} spellcheck="false" autocomplete="off" />
    <label class="cz-lab" for="oa-sec-{id}">{t('客户端密钥')}</label>
    <input id="oa-sec-{id}" class="cz-in mono" type="password" bind:value={clientSecret} autocomplete="new-password"
      placeholder={info.app?.hasSecret ? t('已保存，不改就留空') : ''} />

    {#if err}<div class="cz-err">{err}</div>{/if}
    <div class="oa-acts">
      {#if info.app}<button class="cz-btn danger-tx" disabled={busy} onclick={remove}>{t('删除应用')}</button>{/if}
      <span class="cz-grow"></span>
      <button class="cz-btn pri" disabled={busy} onclick={save}>{#if busy}<span class="cz-spin"></span>{/if}{t('保存')}</button>
    </div>
  </div>
{/if}

<style>
  .oa-chip { padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--cz-warn); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--cz-warn) 45%, transparent); }
  .oa-chip.ok { color: var(--cz-ok); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--cz-ok) 45%, transparent); }
  .oa-lead { margin: -2px 2px 12px; font-size: 13.5px; line-height: 1.65; color: var(--cz-ink2); }
  .oa-card { padding: 6px 16px 16px; border-radius: 12px; background: var(--cz-card); box-shadow: inset 0 0 0 1px var(--cz-line2); }
  .oa-gh { display: inline-flex; align-items: center; gap: 8px; height: 38px; margin: 0 -6px; padding: 0 6px; border-radius: 8px; font-size: 14.5px; font-weight: 500; }
  .oa-gh:hover { background: var(--cz-hover); }
  .oa-chev { display: inline-flex; color: var(--cz-ink3); transition: transform .16s ease; }
  .oa-chev :global(svg) { width: 16px; height: 16px; }
  .oa-chev.shut { transform: rotate(-90deg); }
  .oa-steps { margin: 4px 0 0; padding-left: 22px; display: flex; flex-direction: column; gap: 8px; font-size: 13.5px; line-height: 1.6; color: var(--cz-ink2); }
  .oa-steps li::marker { color: var(--cz-ink3); font-variant-numeric: tabular-nums; }
  .oa-lnk { display: inline-flex; align-items: center; gap: 3px; margin-left: 6px; color: var(--cz-ink); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); white-space: nowrap; }
  .oa-lnk :global(svg) { width: 13px; height: 13px; }
  .oa-note { margin: 10px 0 0; padding: 9px 12px; border-radius: 9px; font-size: 13px; line-height: 1.6; color: var(--cz-ink2); background: var(--cz-hover); }
  .oa-warn { margin: 8px 0 0; }
  .oa-hint { margin: 6px 2px 0; font-size: 12.5px; line-height: 1.55; color: var(--cz-ink3); }
  .oa-labrow { display: flex; align-items: center; gap: 8px; }
  .oa-scopes { display: flex; flex-wrap: wrap; gap: 4px 6px; max-height: 132px; overflow: auto; padding: 8px 10px; border-radius: 9px; background: var(--cz-field); font-size: 12px; line-height: 1.6; color: var(--cz-ink2); }
  .oa-scopes span { overflow-wrap: anywhere; }
  .oa-scopes span:not(:last-child)::after { content: ','; color: var(--cz-ink3); }
  .oa-acts { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
  .danger-tx { color: var(--cz-crit); }
</style>
