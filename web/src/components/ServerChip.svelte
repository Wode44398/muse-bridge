<script>
  // 主页左上标题下的服务器胶囊：手机 App 存了不止一台服务器时出现，写着现在连的是哪台，点开切换面板。
  // 只有一台时不占地方（入口在设置「关于 › 服务器」和长按标题）。
  import { ui } from '../lib/state.svelte.js';
  import { activeProfile, listProfiles, canSwitchServers } from '../lib/serverProfiles.js';
  import { pressable } from '../lib/motion.js';
  import { t } from '../lib/i18n.js';

  // 档案只在启动后、切换（整页重载）时变；面板里删了 / 改名后关面板时重读一次
  const cur = $derived((ui.serverSwitcherOpen, canSwitchServers() ? activeProfile() : null));
  const many = $derived((ui.serverSwitcherOpen, canSwitchServers() && listProfiles().filter((p) => !p.pending).length > 1));
  const visible = $derived(!!cur && many && ui.booted && ui.screen === 'home' && !ui.settingsOpen && !ui.serverSwitching);
</script>

{#if cur && many}
  <button class="chip" class:show={visible} class:light={ui.glassMode === 'B'} type="button" style:--c={cur.color}
    use:pressable={{ scale: 0.94 }} onclick={() => { ui.serverSwitcherOpen = true; }}
    aria-label={t('当前服务器：{name}，点按切换', { name: cur.name })} tabindex={visible ? 0 : -1}>
    <i class="dot" class:off={ui.offline}></i>
    <span class="nm">{cur.name}</span>
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>
{/if}

<style>
  .chip {
    position: fixed; z-index: 11; top: calc(max(16px, var(--sat, 0px)) + 42px); left: 14px;
    display: flex; align-items: center; gap: 7px; height: 28px; max-width: 46vw; padding: 0 10px 0 9px; border-radius: 14px;
    font-size: 12.5px; font-weight: 600; letter-spacing: .01em; color: #fff;
    background: rgba(0, 0, 0, .26); box-shadow: inset 0 0 0 .5px rgba(255, 255, 255, .22);
    opacity: 0; pointer-events: none; transform: scale(var(--press-s, 1));
    transition: opacity var(--mo-base) var(--ea-fade);
  }
  .chip.show { opacity: 1; pointer-events: auto; }
  .chip.light { color: #0a0a0a; background: rgba(255, 255, 255, .42); box-shadow: inset 0 0 0 .5px rgba(0, 0, 0, .12); }
  .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--c); box-shadow: 0 0 8px var(--c); }
  .dot.off { background: #ef6b5b; box-shadow: none; }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  svg { flex: none; opacity: .7; }
</style>
