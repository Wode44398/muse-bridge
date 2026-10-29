<script>
  // 一个连接器授权流程的进行中状态（lib/mcpAuth.svelte.js）：会话信息面板「连接器」卡的行下面、输入框上方的
  // 提示条里都用它。按 scheme 给不同的下一步：custom 等自动完成；localhost 要把地址栏整串粘回来；web 点「我已完成」。
  import { authFlow, submitAuthUrl, confirmAuth, cancelAuth, startAuth, openAuthPage } from '../../lib/mcpAuth.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  let { sid = '', server = '' } = $props();
  const f = $derived(authFlow(sid, server));
  let pasted = $state('');
  $effect(() => { sid; server; pasted = ''; });
</script>

{#if f}
  <div class="af">
    {#if f.status === 'starting'}
      <span class="af-msg">{t('正在打开授权页…')}</span>
    {:else if f.status === 'waiting'}
      {#if f.scheme === 'localhost'}
        <span class="af-msg">{t('这个服务只接受本机回调：授权后浏览器会打不开页面，把地址栏里的完整地址粘到这里。')}</span>
        <div class="af-row">
          <input type="url" placeholder="http://localhost:…/callback?code=…" bind:value={pasted} disabled={f.busy}
            onkeydown={(e) => { if (e.key === 'Enter' && pasted.trim()) submitAuthUrl(sid, server, pasted); }} />
          <button class="af-btn" disabled={f.busy || !pasted.trim()} onclick={() => submitAuthUrl(sid, server, pasted)}>{t('提交')}</button>
        </div>
      {:else if f.scheme === 'web'}
        <span class="af-msg">{t('在打开的页面里完成授权，然后回到这里。')}</span>
      {:else}
        <span class="af-msg">{t('在打开的页面里完成授权，完成后会自动连接。')}</span>
      {/if}
      <div class="af-acts">
        {#if f.scheme === 'web'}<button class="af-btn" disabled={f.busy} onclick={() => confirmAuth(sid, server)}>{t('我已完成')}</button>{/if}
        <button class="af-lnk" onclick={() => openAuthPage(f.authUrl)}>{t('打开授权页')}</button>
        <button class="af-lnk" onclick={() => cancelAuth(sid, server)}>{t('取消')}</button>
      </div>
    {:else if f.status === 'done'}
      <span class="af-msg ok">{t('已连接')}</span>
    {:else}
      <span class="af-msg err">{f.error ? tr(f.error) : t('授权没有完成')}</span>
      <div class="af-acts">
        <button class="af-lnk" onclick={() => startAuth(sid, server)}>{t('重试')}</button>
        <button class="af-lnk" onclick={() => cancelAuth(sid, server)}>{t('关闭')}</button>
      </div>
    {/if}
    {#if f.error && f.status === 'waiting'}<span class="af-msg err">{tr(f.error)}</span>{/if}
  </div>
{/if}

<style>
  .af { display: flex; flex-direction: column; gap: 6px; padding: 2px 4px 6px 32px; font-size: 12px; line-height: 17px; color: var(--muted); min-width: 0; }
  .af-msg { white-space: normal; overflow-wrap: anywhere; }
  .af-msg.ok { color: var(--text); }
  .af-msg.err { color: var(--r-danger, var(--danger, #c0583e)); }
  .af-row { display: flex; gap: 6px; }
  .af-row input { flex: 1; min-width: 0; font-size: 12px; padding: 4px 8px; border-radius: 7px; border: 0; background: var(--r-ghost, var(--hover)); color: var(--text);
    box-shadow: inset 0 0 0 1px var(--r-a2, var(--border)); outline: none; }
  .af-row input:focus { box-shadow: inset 0 0 0 1px var(--muted); }
  .af-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
  .af-btn { flex: none; font-size: 12px; padding: 3px 9px; border-radius: 7px; background: var(--r-a2, var(--hover)); color: var(--text); white-space: nowrap; }
  .af-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 15%, transparent); }
  .af-btn:disabled { opacity: .45; }
  .af-lnk { flex: none; padding: 0; font-size: 12px; color: var(--serif, var(--text)); text-decoration: underline; text-underline-offset: 3px;
    text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); }
  @media (hover: hover) { .af-lnk:hover { color: var(--text); } }
</style>
