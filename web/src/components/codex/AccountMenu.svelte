<script>
  // 账号菜单（窄栏最底下的头像；手机上在抽屉里）：
  //   你是谁（bridge 身份）→ Codex 用哪个号（管理员能切；开了智能分派就写明按额度自动挑，不给切）
  //   → Codex 设置 → 回到 bridge 主页。切号失败就写在那一行下面，不弹提示条。
  import { t } from '../../lib/i18n.js';
  import { me } from '../../lib/state.svelte.js';
  import { roleLabelOf } from '../../lib/settings/common.js';
  import { codex, isAdmin, switchAccount, activeAccount, errText } from '../../lib/codex/store.svelte.js';
  import { cxPop, closePop } from '../../lib/codex/ui.svelte.js';
  import { haptic } from '../../lib/codex/feedback.js';
  import { accLabel, planLabel } from '../../lib/codex/settings-logic.js';
  import { fiveHourLeft } from '../../lib/codex/picker/format.js';
  import { openSettingsFromChat, canOpenSettingsFromChat } from '../../lib/settingsNav.svelte.js';
  import { closePage } from '../../lib/pageMorph.js';
  import { isPageWindow, focusMainWindow } from '../../lib/windowPage.svelte.js';
  import Popover from './Popover.svelte';
  import Icon from './Icon.svelte';

  const open = $derived(cxPop.id === 'acct');
  const admin = $derived(isAdmin());
  const name = $derived(me.user || (admin ? 'Admin' : t('访客')));
  const initial = $derived((String(name).trim().charAt(0) || '·').toUpperCase());
  const pool = $derived(codex.pool);
  const all = $derived(Array.isArray(pool?.accounts) ? pool.accounts : []);
  const activeId = $derived(pool?.activeId || all[0]?.id || '');
  const routing = $derived(!!pool?.router?.enabled);
  // 停用的号不列，除非它正是当前号
  const list = $derived(all.filter((a) => !a.disabled || a.id === activeId));
  const cur = $derived(activeAccount());

  let busy = $state('');
  let err = $state('');

  $effect(() => { if (open) { err = ''; } });

  const usable = (a) => !a.disabled && !a.pending && a.loggedIn !== false;
  const leftOf = (a) => {
    if (a.id === codex.usageAccount && codex.usage?.available) return fiveHourLeft(codex.usage);
    return a.limits ? fiveHourLeft(a.limits) : null;
  };
  const mark = (a) => (String(accLabel(a)).trim().replace(/^[^\p{L}\p{N}]+/u, '').charAt(0) || '·').toUpperCase();

  async function pick(a) {
    if (busy || routing || a.id === activeId || !usable(a)) return;
    busy = a.id;
    err = '';
    haptic('tick');
    try {
      await switchAccount(a.id);
      setTimeout(() => closePop('acct'), 160);
    } catch (e) {
      err = errText(e, t('切换失败'));
    } finally {
      busy = '';
    }
  }

  function settings() {
    closePop('acct');
    openSettingsFromChat('ag-codex');
  }

  function home() {
    closePop('acct');
    if (isPageWindow()) focusMainWindow();
    else closePage('chatgpt');
  }
</script>

<Popover id="acct" side="right" align="start" width={290} class="cx-menu" label={t('账号')}>
  <div class="pop-who">
    <span class="avatar">{initial}</span>
    <div class="who"><b>{name}</b><span>{roleLabelOf(me)}</span></div>
  </div>

  {#if list.length}
    <div class="pop-sep"></div>
    <div class="pop-cap">{t('ChatGPT 账号')}</div>
    <div class="pop-sec" style="padding-top:2px">
      {#if admin && routing}
        <div class="mi tall static">
          <Icon name="swap" class="mi-ico" />
          <span class="lb"><span>{t('智能分派')}</span><span class="desc">{t('每一轮按各号剩余额度自动挑号，这里不用手动切。在 Codex 设置里可以关掉。')}</span></span>
        </div>
      {/if}
      {#if admin}
        {#each list as a (a.id)}
          {@const left = leftOf(a)}
          {#if routing}
            <div class="mi static">
              <span class="avatar sm">{mark(a)}</span>
              <span class="lb nm">{accLabel(a)}{#if planLabel(a.plan)}<span class="desc">{planLabel(a.plan)}</span>{/if}</span>
              {#if left != null}<span class="sub">{t('5 小时剩 {n}%', { n: left })}</span>{/if}
            </div>
          {:else}
            <button
              type="button"
              class="mi"
              role="menuitemradio"
              aria-checked={a.id === activeId}
              disabled={!usable(a) && a.id !== activeId}
              onclick={() => pick(a)}
            >
              <span class="avatar sm">{mark(a)}</span>
              <span class="lb nm">{accLabel(a)}{#if planLabel(a.plan)}<span class="desc">{planLabel(a.plan)}</span>{/if}</span>
              {#if busy === a.id}
                <svg class="spin" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.2" /></svg>
              {:else if !usable(a)}
                <span class="sub">{a.pending ? t('登录中') : a.disabled ? t('已停用') : t('未登录')}</span>
              {:else if left != null}
                <span class="sub">{t('5 小时剩 {n}%', { n: left })}</span>
              {/if}
              <Icon name="check" class="ck" />
            </button>
          {/if}
        {/each}
      {:else if cur}
        <!-- 成员：只看在用的是哪个号，换号是管理员的事 -->
        <div class="mi static">
          <span class="avatar sm">{mark(cur)}</span>
          <span class="lb nm">{accLabel(cur)}{#if planLabel(cur.plan)}<span class="desc">{planLabel(cur.plan)}</span>{/if}</span>
          {#if leftOf(cur) != null}<span class="sub">{t('5 小时剩 {n}%', { n: leftOf(cur) })}</span>{/if}
        </div>
      {/if}
      {#if err}<p class="ac-err">{err}</p>{/if}
    </div>
  {/if}

  <div class="pop-sep"></div>
  <div class="pop-sec">
    {#if canOpenSettingsFromChat}
      <button type="button" class="mi" onclick={settings}>
        <Icon name="sliders" class="mi-ico" />
        <span class="lb">{t('Codex 设置')}</span>
      </button>
    {/if}
    <button type="button" class="mi" onclick={home}>
      <Icon name="bridge" class="mi-ico" />
      <span class="lb">{t('回到 bridge 主页')}</span>
    </button>
  </div>
</Popover>

<style>
  .who { min-width: 0; }
  .who b, .who span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .avatar.sm { width: 22px; height: 22px; font-size: 10px; background: var(--fill4); color: var(--fg); }
  .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mi.static { cursor: default; }
  .mi.static:hover { background: none; }
  .mi .spin { margin-left: auto; flex: none; }
  .mi :global(.ck) { transition: opacity calc(var(--k, 1) * 150ms) ease; }
  .ac-err { margin: 4px 10px 2px; font-size: 12px; line-height: 1.45; color: var(--warn); }
</style>
