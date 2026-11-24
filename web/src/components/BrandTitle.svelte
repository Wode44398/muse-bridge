<script>
  // 持久的「THE BRIDGE」品牌标题——全程只此一个，固定在主页左上。
  // 开机时它不再从中央飞过来：门出画之前藏着（html[data-boot]），之后在自己的位置上逐字显影、
  // 跟着同一台相机落位（lib/boot/landing.js 按 .bl / .ch 找字）。分页里与主题换场时隐藏。
  import { onMount } from 'svelte';
  import { ui } from '../lib/state.svelte.js';
  import { switchHomeTheme } from '../lib/homeTheme.js';
  import { t } from '../lib/i18n.js';
  import { brandWords } from '../lib/distro.js';
  import { canSwitchServers } from '../lib/serverProfiles.js';
  // 两行字随发行版品牌走（本体「THE / BRIDGE」，Muse Bridge 是「MUSE / BRIDGE」）
  const LINES = brandWords().map((w) => [...w]);

  let mounted = $state(false);
  let rootEl;
  // 标题颜色 = 当前主题色：flux(A)=白 / 风景(B)=黑。换场时新旧两种颜色分别在新旧快照里，由转场本身过渡。
  const titleColor = $derived(ui.glassMode === 'B' ? '#0a0a0a' : '#ffffff');
  // 切换服务器的转场里，标题由转场封面里的那一份接手（lib/serverSwitch.js）
  const visible = $derived(mounted && ui.screen === 'home' && !ui.settingsOpen && !ui.serverSwitching);
  // 长按标题 = 切换服务器（手机 App 的多服务器档案）；长按触发后吞掉随之而来的那次点击，不换壁纸
  let lpTimer = 0, lpFired = false, lpX = 0, lpY = 0;
  function lpDown(e) {
    lpFired = false;
    if (!canSwitchServers() || !ui.booted) return;
    lpX = e.clientX; lpY = e.clientY;
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => { lpFired = true; try { navigator.vibrate?.(12); } catch {} ui.serverSwitcherOpen = true; }, 480);
  }
  const lpCancel = () => clearTimeout(lpTimer);
  const lpMove = (e) => { if (Math.hypot(e.clientX - lpX, e.clientY - lpY) > 10) clearTimeout(lpTimer); };
  const toggle = () => { if (lpFired) { lpFired = false; return; } switchHomeTheme(rootEl); };
  onMount(() => { mounted = true; });
</script>

<div class="brand" class:show={visible} class:tappable={visible && ui.booted} bind:this={rootEl}
     style:color={titleColor}
     onclick={toggle}
     onpointerdown={lpDown} onpointerup={lpCancel} onpointercancel={lpCancel} onpointerleave={lpCancel} onpointermove={lpMove}
     oncontextmenu={(e) => { if (canSwitchServers()) e.preventDefault(); }}
     onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
     role="button" tabindex="0" aria-label={t('切换壁纸主题')}
     title={t('点击切换壁纸 / 玻璃方案')}>
  {#each LINES as chars}<span class="bl">{#each chars as c}<span class="ch">{c}</span>{/each}</span>{/each}
</div>

<style>
  .brand {
    position: fixed; z-index: 210; pointer-events: none; color: #fff; opacity: 0;
    top: max(16px, var(--sat)); left: 18px;
    font-family: var(--serif-stack); font-weight: 300; display: flex; flex-direction: column; align-items: flex-start;
    font-size: 14px; line-height: 1.16; letter-spacing: .14em;
    text-shadow: 0 1px 10px rgba(0,0,0,.5);
    transition: opacity var(--mo-base) var(--ea-fade), color var(--mo-hero) var(--ea-fade);
  }
  .brand.show { opacity: 1; }
  /* 开机：门出画之前藏着（它浮在入场层上面；藏法用 visibility，不碰 opacity——那条过渡会和落位的逐字显影叠成两次淡入） */
  :global(html[data-boot]) .brand { visibility: hidden; }
  .bl { display: block; white-space: nowrap; }
  .ch { display: inline-block; }
  .brand.tappable { pointer-events: auto; cursor: pointer; }
  /* 桌面：可点的标题得有悬停反馈，否则鼠标划过完全看不出这里能按 */
  @media (hover: hover) {
    .brand.tappable:hover { text-shadow: 0 1px 14px rgba(255,255,255,.5), 0 1px 10px rgba(0,0,0,.5); }
  }
</style>
