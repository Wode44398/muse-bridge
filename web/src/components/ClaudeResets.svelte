<script>
  // 订阅号的「重置卡」面板：Anthropic 偶尔发给订阅号的限额重置（官方在 claude.ai 设置 › 用量 › Resets 里用）。
  // 手机设置的账号页、桌面设置号池的弹窗、控制台账号页共用；颜色字号跟宿主走（skin 把宿主的令牌接到 --rc-*）。
  // 三种状态：没登录（引导做一次完整登录：开登录页 → 回贴授权码）/ 有卡（逐张「使用」，二次确认）/ 没卡。
  // 数据面在 lib/agentSettings.svelte.js（loadResets / useResetCard / resetsLogin*），服务端 runtime/limit-resets.mjs。
  import { ags, loadResets, useResetCard, resetsLoginStart, resetsLoginFinish, resetsLoginClear,
    liveGrants, grantTitle, grantClears, grantExpiry, accLabel } from '../lib/agentSettings.svelte.js';
  import { openAuthPage } from '../lib/mcpAuth.svelte.js';
  import { t } from '../lib/i18n.js';

  let { account, skin = 'ios' } = $props();   // skin: 'ios' 手机设置 | 'dsk' 桌面设置 | 'sa' 控制台

  const view = $derived(ags.resets[account.id] || null);
  const live = $derived(liveGrants(view));
  const spent = $derived((view?.grants || []).length - live.length);

  let flow = $state(null);      // 登录进行中：{ url, code, busy }
  let confirmId = $state('');   // 正在二次确认的那张卡
  let busy = $state('');        // 'login' | 'use' | 'refresh' | 'clear'
  let err = $state('');
  let done = $state('');        // 刚用掉一张卡后的结果句

  async function startLogin() {
    if (busy) return;
    busy = 'login'; err = '';
    const r = await resetsLoginStart(account.id);
    busy = '';
    if (r.error || !r.url) { err = r.error || t('失败'); return; }
    flow = { url: r.url, code: '', busy: false };
    openAuthPage(r.url);
  }
  async function finishLogin(e) {
    e?.preventDefault?.();
    if (!flow || flow.busy || !flow.code.trim()) return;
    flow.busy = true; err = '';
    const r = await resetsLoginFinish(account.id, flow.code);
    if (r.error) { err = r.error; if (flow) flow.busy = false; return; }
    flow = null;
  }
  async function refresh() {
    if (busy) return;
    busy = 'refresh'; err = ''; done = '';
    await loadResets({ force: true, id: account.id });
    busy = '';
  }
  async function useCard(g) {
    if (busy) return;
    busy = 'use'; err = ''; done = '';
    const r = await useResetCard(account.id, g.id);
    busy = ''; confirmId = '';
    if (r.error) { err = r.error; return; }
    const names = (r.cleared || []).length ? grantClears({ clears: r.cleared }) : grantClears(g);
    done = t('已重置：{what} 的用量已清零。', { what: names.join(' · ') });
  }
  async function logout() {
    if (busy) return;
    busy = 'clear'; err = ''; done = '';
    const r = await resetsLoginClear(account.id);
    busy = '';
    if (r.error) err = r.error;
  }
  // 这张卡现在各项限额用了多少（决定值不值得现在用）：「5 小时 100% · 每周 14%」
  const usedNow = (g) => (g.clears || []).map((k) => {
    const name = grantClears({ clears: [k] })[0];
    const v = g.percentUsed?.[k];
    return name && typeof v === 'number' ? name + ' ' + v + '%' : '';
  }).filter(Boolean).join(' · ');
  // 脚注：登录身份 + 已用完的张数（拼成一句，模板里的空白会被吃掉）
  const who = $derived([view?.login?.source === 'local' ? t('用的是本机登录态') : view?.login?.email ? t('已登录 {email}', { email: view.login.email }) : t('已登录'),
    spent > 0 ? t('另有 {n} 张已用完或过期', { n: spent }) : ''].filter(Boolean).join(' · '));
  const whyNot = (g) => (g.requiresLimit && !view?.atLimit ? t('撞到限额后才能用') : view?.cooldownUntil > Date.now() ? t('刚用过一张，冷却中') : t('现在用不了'));
</script>

<div class="rc {skin}">
  {#if !view}
    <p class="rc-note">{ags.resetsBusy ? t('读取中…') : t('还没读到重置卡信息。')}</p>
  {:else if view.needLogin}
    <p class="rc-note">{t('查看和使用重置卡，要先用这个订阅的 Claude 账号登录一次。号池里的令牌只能跑对话，读不了账号信息。')}</p>
    {#if view.error && !flow}<p class="rc-err">{view.error}</p>{/if}
    {#if !flow}
      <div class="rc-acts"><button class="rc-btn primary" type="button" disabled={busy === 'login'} onclick={startLogin}>{t('登录此账号')}</button></div>
    {:else}
      <form class="rc-login" onsubmit={finishLogin}>
        <p class="rc-step"><b>1</b><span>{t('在刚打开的页面里，用「{name}」对应的 Claude 账号登录并授权。', { name: accLabel(account.label) })}
          <button class="rc-link" type="button" onclick={() => openAuthPage(flow.url)}>{t('重新打开登录页')}</button></span></p>
        <p class="rc-step"><b>2</b><span>{t('把页面上显示的授权码粘贴到下面。')}</span></p>
        <input class="rc-in" bind:value={flow.code} placeholder={t('授权码')} autocomplete="off" autocapitalize="off" spellcheck="false" />
        {#if err}<p class="rc-err">{err}</p>{/if}
        <div class="rc-acts">
          <button class="rc-btn" type="button" onclick={() => { flow = null; err = ''; }}>{t('取消')}</button>
          <button class="rc-btn primary" type="submit" disabled={flow.busy || !flow.code.trim()}>{flow.busy ? t('登录中…') : t('完成登录')}</button>
        </div>
      </form>
    {/if}
  {:else}
    {#each live as g (g.id)}
      <div class="rc-card">
        <div class="rc-head">
          <span class="rc-name">{grantTitle(g)}</span>
          {#if g.left > 1}<span class="rc-n">× {g.left}</span>{/if}
          <span class="rc-exp">{grantExpiry(g)}</span>
        </div>
        <p class="rc-meta">{t('清零 {what} 的用量', { what: grantClears(g).join(' · ') })}{#if usedNow(g)}<span class="rc-used">{t('现在已用 {used}', { used: usedNow(g) })}</span>{/if}</p>
        {#if g.label}<p class="rc-src">{g.label}</p>{/if}
        {#if confirmId === g.id}
          <p class="rc-ask">{view.atLimit ? t('现在使用这张卡？用掉后不能撤回。') : t('这个号现在还没撞到限额。仍然现在使用？用掉后不能撤回。')}</p>
          <div class="rc-acts">
            <button class="rc-btn" type="button" disabled={busy === 'use'} onclick={() => { confirmId = ''; }}>{t('取消')}</button>
            <button class="rc-btn primary" type="button" disabled={busy === 'use'} onclick={() => useCard(g)}>{busy === 'use' ? t('重置中…') : t('确认使用')}</button>
          </div>
        {:else}
          <div class="rc-acts">
            {#if !g.usable}<span class="rc-why">{whyNot(g)}</span>{/if}
            <button class="rc-btn primary" type="button" disabled={!g.usable || !!busy} onclick={() => { confirmId = g.id; err = ''; done = ''; }}>{t('使用')}</button>
          </div>
        {/if}
      </div>
    {:else}
      <p class="rc-note">{view.eligible === false && !view.error ? t('这个号的套餐现在没有重置卡。') : t('这个号现在没有可用的重置卡。')}</p>
    {/each}
    {#if done}<p class="rc-ok">{done}</p>{/if}
    {#if view.error}<p class="rc-err">{view.error}</p>{/if}
    <div class="rc-foot">
      <span class="rc-who">{who}</span>
      <button class="rc-link" type="button" disabled={!!busy} onclick={refresh}>{busy === 'refresh' ? t('刷新中…') : t('刷新')}</button>
      {#if view.login?.source !== 'local'}<button class="rc-link" type="button" disabled={!!busy} onclick={logout}>{t('移除登录')}</button>{/if}
    </div>
  {/if}
  {#if err && !flow}<p class="rc-err">{err}</p>{/if}
</div>

<style>
  /* 宿主令牌 → 本组件的 --rc-*：手机设置（--i-*）、桌面设置（--dsk-*）、控制台（--sa-*，没有就退到通用色） */
  .rc.ios { --rc-ink: var(--i-label); --rc-ink2: var(--i-label2); --rc-ink3: var(--i-label3); --rc-line: var(--i-sep); --rc-fill: var(--i-fill4);
    --rc-accent: var(--i-accent); --rc-on-accent: var(--i-on-accent); --rc-red: var(--i-red); --rc-ok: var(--i-ok);
    --rc-fs: 16px; --rc-fs2: 13px; --rc-pad: 14px 16px; --rc-btn-h: 34px; --rc-r: 10px; }
  .rc.dsk { --rc-ink: var(--dsk-ink); --rc-ink2: var(--dsk-ink-2); --rc-ink3: var(--dsk-ink-3); --rc-line: var(--dsk-line); --rc-fill: var(--dsk-hover);
    --rc-accent: var(--dsk-accent); --rc-on-accent: var(--dsk-accent-ink); --rc-red: var(--dsk-crit); --rc-ok: var(--dsk-ok);
    --rc-fs: 13px; --rc-fs2: 12px; --rc-pad: 0; --rc-btn-h: 28px; --rc-r: 9px; }
  .rc.sa { --rc-ink: var(--sa-tx); --rc-ink2: var(--sa-tx2); --rc-ink3: var(--sa-tx3); --rc-line: var(--sa-hair); --rc-fill: var(--sa-fill);
    --rc-accent: var(--sa-accent); --rc-on-accent: var(--sa-on-accent, #fff); --rc-red: var(--sa-red); --rc-ok: var(--sa-green, var(--sa-tx));
    --rc-fs: 13.5px; --rc-fs2: 12px; --rc-pad: 0; --rc-btn-h: 28px; --rc-r: 9px; }

  .rc { display: flex; flex-direction: column; gap: 10px; padding: var(--rc-pad); color: var(--rc-ink); font-size: var(--rc-fs); line-height: 1.45; text-align: left; }
  .rc p { margin: 0; }
  .rc-note { color: var(--rc-ink2); font-size: var(--rc-fs2); line-height: 1.5; }
  .rc-err { color: var(--rc-red); font-size: var(--rc-fs2); }
  .rc-ok { color: var(--rc-ok); font-size: var(--rc-fs2); }

  .rc-card { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: var(--rc-r); background: var(--rc-fill); }
  .rc-head { display: flex; align-items: baseline; gap: 8px; }
  .rc-name { font-weight: 600; }
  .rc-n { font-variant-numeric: tabular-nums; color: var(--rc-ink2); }
  .rc-exp { margin-left: auto; font-size: var(--rc-fs2); color: var(--rc-ink2); white-space: nowrap; }
  .rc-meta { font-size: var(--rc-fs2); color: var(--rc-ink2); }
  .rc-used { display: block; font-variant-numeric: tabular-nums; }
  .rc-src { font-size: var(--rc-fs2); color: var(--rc-ink3); overflow-wrap: anywhere; }
  .rc-ask { margin-top: 6px !important; font-size: var(--rc-fs2); }
  .rc-why { margin-right: auto; align-self: center; font-size: var(--rc-fs2); color: var(--rc-ink2); }

  .rc-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
  .rc-btn { height: var(--rc-btn-h); padding: 0 14px; border-radius: calc(var(--rc-btn-h) / 2); font: inherit; font-size: var(--rc-fs2); font-weight: 600; color: var(--rc-ink);
    background: transparent; box-shadow: inset 0 0 0 1px var(--rc-line); cursor: pointer; white-space: nowrap; transition: opacity .15s ease, transform .15s ease; }
  .rc-btn.primary { background: var(--rc-accent); color: var(--rc-on-accent); box-shadow: none; }
  .rc-btn:active:not(:disabled) { transform: scale(.97); }
  .rc-btn:disabled { opacity: .38; cursor: default; }
  .rc-link { padding: 0; font: inherit; font-size: var(--rc-fs2); color: var(--rc-ink); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: var(--rc-ink3); background: none; cursor: pointer; white-space: nowrap; }
  .rc-link:disabled { opacity: .4; cursor: default; }

  .rc-login { display: flex; flex-direction: column; gap: 8px; }
  .rc-step { display: flex; gap: 10px; font-size: var(--rc-fs2); color: var(--rc-ink2); line-height: 1.5; }
  .rc-step b { flex: none; width: 18px; height: 18px; border-radius: 50%; box-shadow: inset 0 0 0 1px var(--rc-ink3); font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; color: var(--rc-ink2); }
  .rc-in { height: calc(var(--rc-btn-h) + 4px); padding: 0 12px; border-radius: var(--rc-r); border: 0; outline: 0; font: inherit; font-size: var(--rc-fs2); color: var(--rc-ink);
    background: var(--rc-fill); box-shadow: inset 0 0 0 1px var(--rc-line); min-width: 0; }
  .rc-in:focus { box-shadow: inset 0 0 0 1px var(--rc-ink3); }

  .rc-foot { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 14px; margin-top: 2px; }
  .rc-who { flex: 1 1 100%; font-size: var(--rc-fs2); color: var(--rc-ink3); overflow-wrap: anywhere; }
</style>
