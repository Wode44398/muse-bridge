<script>
  // 侧栏底部账户卡（claude.ai 左下角用户行同款：头像 + 名字 · 角色 + ⌄），点开是账户菜单（UserMenu）。
  // Claude 分页（侧栏 .d-foot）与单 agent 模式下的 dimensio 分页（harness 侧栏底部的 sidebarFoot）共用。
  //
  // 配色只用 --text / --bg 两个令牌（bridge 与 dimensio 都定义了它们）按比例混出来：卡片放进 dimensio
  // 侧栏时，跟随的是 dimensio 自己的明暗档，而不是 bridge 的全局主题。
  // 菜单经 portal 挂到 <body>：侧栏常在带 transform 的抽屉里，fixed 定位的菜单留在原地会被抽屉的
  // 包含块吃掉。中屏时同一页的侧栏会渲染两份（常驻列 + 隐藏抽屉），每份各管自己的菜单。
  import { me } from '../lib/state.svelte.js';
  import UserMenu from './UserMenu.svelte';
  import { t } from '../lib/i18n.js';

  // onpick：选了菜单里某一项（侧栏抽屉跟着收起）；onhome：回主页（单 agent 模式传 null——没有主页）
  let { onpick = null, onhome = null } = $props();

  let anchor = $state(null);
  function toggle(e) { anchor = anchor ? null : e.currentTarget.getBoundingClientRect(); }
  const name = $derived(me.kind === 'none' ? t('未登录') : (me.user || (me.kind === 'admin' ? 'admin' : '')));
  const role = $derived(me.kind === 'admin' ? t('管理员') : me.kind === 'user' ? (me.tier === 'pro' ? 'Pro' : t('用户')) : '');
  const initial = $derived(me.kind === 'none' ? '?' : (name || '?').trim().charAt(0).toUpperCase());

  function portal(node) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }
</script>

<button class="acct" class:open={!!anchor} onclick={toggle} aria-haspopup="menu" aria-expanded={!!anchor} title={t('设置与账户')}>
  <span class="av">{initial}</span>
  <span class="n">{name}{#if role}<span class="r">{` · ${role}`}</span>{/if}</span>
  <span class="chev" aria-hidden="true">&#xe027;</span>
</button>

{#if anchor}
  <div class="acct-portal" use:portal>
    <UserMenu {anchor} onclose={() => (anchor = null)} onpick={() => { anchor = null; onpick?.(); }} {onhome} />
  </div>
{/if}

<style>
  .acct { width: 100%; height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 4px; border: 0; border-radius: 8px;
    background: none; color: color-mix(in srgb, var(--text) 78%, transparent); font: inherit; font-family: var(--sans); font-size: 14px;
    text-align: left; cursor: pointer; transition: background-color .12s ease, color .12s ease; }
  .acct.open { background: color-mix(in srgb, var(--text) 10%, transparent); color: var(--text); }
  .acct:active { background: color-mix(in srgb, var(--text) 7%, transparent); }
  @media (hover: hover) { .acct:hover { background: color-mix(in srgb, var(--text) 7%, transparent); color: var(--text); } }
  .av { width: 26px; height: 26px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--text) 20%, var(--bg)); color: var(--text); font-size: 12px; font-weight: 560; }
  .n { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .r { color: color-mix(in srgb, var(--text) 55%, transparent); }
  .chev { flex: none; font-family: var(--icons); font-size: 16px; line-height: 1; color: color-mix(in srgb, var(--text) 55%, transparent);
    transition: transform .15s ease; }
  .acct.open .chev { transform: rotate(180deg); }
  .acct-portal { display: contents; }
  @media (pointer: coarse) { .acct { height: 44px; } .av { width: 30px; height: 30px; font-size: 13px; } }
</style>
