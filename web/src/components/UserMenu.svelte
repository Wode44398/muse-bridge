<script>
  // 侧栏底部账户卡的弹出菜单（claude.ai 左下角用户菜单同款：顶部一行身份，下面「设置 / 语言 / 帮助…
  // 退出」；官方实测 272px 宽、圆角 12、内边距 4、行高 32 / 圆角 8 / 图标 20px、1px 描边 + 双层投影）。
  // 单 agent 模式的条目：设置、关于与更新（有新版时带标）、工作空间、扫一扫（手机）；没登录时多一条「登录」。
  // 常规模式（传了 onhome）：主页、设置、工作空间、扫一扫。
  // 账户不单列：从「设置」进（顶部账户卡）；退出登录 / 切换账号也都在设置 › 账户（要先确认，免误触）。
  // 由 ClaudePage 在页面级只挂一份（侧栏在中屏会同时渲染常驻列与隐藏抽屉两份，菜单不能跟着各挂一份）。
  import { onMount } from 'svelte';
  import { ui, me } from '../lib/state.svelte.js';
  import { openSettings } from '../lib/settingsNav.svelte.js';
  import { updateInfo } from '../lib/updateStore.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { isOffline } from '../lib/server.js';
  import { t } from '../lib/i18n.js';

  // anchor：账户卡按钮的 DOMRect；onclose：点空白 / Esc / 返回键；onpick：选了某一项（侧栏抽屉跟着收起）；
  // onhome：常规模式回主页（单 agent 模式不传——没有主页）
  let { anchor, onclose, onpick, onhome = null } = $props();

  const canScan = (() => { try { return isOffline() || matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  const roleLabel = $derived(me.kind === 'admin' ? t('管理员') : me.kind === 'user' ? (me.tier === 'pro' || me.tier === 'full' ? t('完全信任用户') : t('普通用户')) : t('未登录'));
  const shownName = $derived(me.user || (me.kind === 'admin' ? 'admin' : ''));

  const W = Math.min(272, window.innerWidth - 16);
  const left = $derived(Math.max(8, Math.min(anchor.left, window.innerWidth - W - 8)));
  const bottom = $derived(Math.max(8, window.innerHeight - anchor.top + 6));

  let el = $state();
  $effect(() => pushBackLayer(onclose));   // 安卓返回键 / 浏览器后退先关菜单
  onMount(() => { el?.querySelector('.um-i')?.focus({ preventScroll: true }); });

  function pick(fn) { (onpick || onclose)?.(); fn(); }
  // 登录：常规模式进设置 › 账户（那一页没登录时就是登录页）；单 agent 模式弹压在页上的登录框（LoginDialog），
  // 不离开当前对话——它现在用的也是同一套设置，设置 › 账户同样能登录，两条路都通
  function login() { if (onhome) openSettings('account'); else ui.loginOpen = true; }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onclose?.(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = [...el.querySelectorAll('.um-i')];
    const i = items.indexOf(document.activeElement);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[n]?.focus();
  }
  const SCAN = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 7V5.2A2.2 2.2 0 0 1 5.2 3H7M13 3h1.8A2.2 2.2 0 0 1 17 5.2V7M17 13v1.8a2.2 2.2 0 0 1-2.2 2.2H13M7 17H5.2A2.2 2.2 0 0 1 3 14.8V13M4 10h12"/></svg>';
</script>

<button class="um-bd" aria-label={t('关闭菜单')} tabindex="-1" onclick={onclose}></button>
<div class="um" role="menu" tabindex="-1" aria-label={t('账户菜单')} bind:this={el} onkeydown={onKey}
  style:left="{left}px" style:bottom="{bottom}px" style:width="{W}px">
  <div class="um-h">{me.kind === 'none' ? t('未登录') : `${shownName} · ${roleLabel}`}</div>
  {#if onhome}
    <button class="um-i" role="menuitem" onclick={() => pick(onhome)}><span class="ic" aria-hidden="true">&#xe08a;</span><span class="um-l">{t('主页')}</span></button>
  {/if}
  <!-- 不指定分区：宽屏落在「通用」，手机落在设置首页的列表 -->
  <button class="um-i" role="menuitem" onclick={() => pick(() => openSettings())}><span class="ic" aria-hidden="true">&#xe0d6;</span><span class="um-l">{t('设置')}</span></button>
  {#if !onhome}
    <button class="um-i" role="menuitem" onclick={() => pick(() => openSettings('about'))}>
      <span class="ic" aria-hidden="true">&#xe08f;</span><span class="um-l">{t('关于与更新')}</span>
      {#if updateInfo.available}<span class="badge">{t('新版本')}</span>{/if}
    </button>
  {/if}
  <div class="um-sep" role="separator"></div>
  <button class="um-i" role="menuitem" onclick={() => pick(() => { ui.screen = 'files'; })}><span class="ic" aria-hidden="true">&#xe072;</span><span class="um-l">{t('工作空间')}</span></button>
  {#if canScan && me.kind !== 'none'}
    <button class="um-i" role="menuitem" onclick={() => pick(() => { ui.pairScan = { mode: 'scan' }; })}><span class="ic svg" aria-hidden="true">{@html SCAN}</span><span class="um-l">{t('扫一扫登录网页版')}</span></button>
  {/if}
  {#if me.kind === 'none'}
    <div class="um-sep" role="separator"></div>
    <button class="um-i" role="menuitem" onclick={() => pick(login)}><span class="ic" aria-hidden="true">&#xe105;</span><span class="um-l">{t('登录')}</span></button>
  {/if}
</div>

<style>
  .um-bd { position: fixed; inset: 0; z-index: 57; border: 0; background: transparent; cursor: default; }
  .um { position: fixed; z-index: 58; padding: 4px; border-radius: 12px; background: var(--st-menu); box-shadow: var(--st-menu-shadow);
    font-family: var(--sans); transform-origin: bottom left; animation: um-in .14s var(--ea-decel); outline: none; }
  @keyframes um-in { from { opacity: 0; transform: translateY(4px) scale(.98); } }
  .um-h { padding: 6px 10px 6px; font-size: 13px; line-height: 16px; color: var(--st-muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .um-i { width: 100%; height: 32px; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 0; border-radius: 8px;
    background: none; color: var(--text); font: inherit; font-size: 14px; text-align: left; cursor: pointer; outline: none; }
  .um-i:focus-visible, .um-i:active { background: var(--st-hover); }
  @media (hover: hover) { .um-i:hover { background: var(--st-hover); } }
  .ic { width: 20px; flex: none; font-family: var(--icons); font-size: 20px; font-weight: 433; line-height: 1; color: var(--text);
    display: inline-flex; align-items: center; justify-content: center; }
  .ic.svg :global(svg) { width: 18px; height: 18px; }
  .um-l { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .badge { flex: none; font-size: 11.5px; line-height: 18px; padding: 0 7px; border-radius: 999px; color: #fff; background: var(--st-accent); }
  .um-sep { height: 1px; margin: 4px 6px; background: var(--st-hair); }
  @media (pointer: coarse) {
    .um-i { height: 42px; font-size: 15px; }
  }
</style>
