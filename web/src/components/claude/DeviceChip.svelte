<script>
  // 输入框上方归属栏最左边的「电脑」芯片（官方 Claude Desktop 那颗运行环境芯片的 bridge 版）：
  // 这个会话连着你哪台电脑——Claude 跑在服务端，连上的那台电脑经 mcp__device__* 让它看屏幕、在你允许时操作。
  //   · 新对话：选的是草稿，随第一条消息带上；不选＝自动（从哪台桌面客户端发起就连哪台）。
  //   · 进行中的会话：改选立刻生效（POST /api/devices/link）。
  // 没有任何设备、也不在桌面客户端里时整颗不出现（网页 / 手机用户不被打扰）。
  import { untrack } from 'svelte';
  import { session } from '../../lib/state.svelte.js';
  import { openSettingsFromChat, canOpenSettingsFromChat } from '../../lib/settingsNav.svelte.js';
  import { devices, loadDevices, loadLink, setLink, effectiveDevice, thisDeviceId } from '../../lib/devices.svelte.js';
  import { isNativeDesktop } from '../../lib/nativeDesktop.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { clampX } from '../../lib/clampx.js';
  import { t } from '../../lib/i18n.js';

  let open = $state(false), btn = $state(), dir = $state('up'), err = $state('');

  $effect(() => { if (!devices.loaded) loadDevices(); });
  // 只跟着会话 id 走：loadLink 同步读写 devices.link，不隔开的话 effect 会依赖上自己写的状态，切一次会话跑三四遍
  $effect(() => { const sid = session.id; untrack(() => loadLink(sid || '')); });
  $effect(() => { if (open) return pushBackLayer(() => { open = false; }); });

  const cur = $derived(effectiveDevice(session.id));
  const show = $derived(devices.enabled && (devices.list.length > 0 || isNativeDesktop()));
  const label = $derived(
    !cur ? t('选电脑')
      : cur.none ? t('不连电脑')
        : cur.missing ? t('设备已不在')
          : cur.id && cur.id === thisDeviceId() ? t('这台电脑')
            : cur.name || t('电脑'));
  const tone = $derived(cur && !cur.none && !cur.missing && cur.id ? (cur.online ? 'on' : 'off') : 'idle');
  const selected = $derived(session.id ? (devices.link.value || 'auto') : devices.draft);

  function toggle() {
    if (!open && btn) { const r = btn.getBoundingClientRect(); dir = (window.innerHeight - r.bottom) >= r.top ? 'down' : 'up'; }
    open = !open;
    err = '';
    if (open) loadDevices(true);
  }
  async function choose(v) {
    err = '';
    if (!session.id) { devices.draft = v; open = false; return; }
    try { await setLink(session.id, v === 'auto' ? '' : v); open = false; }
    catch (e) { err = String(e?.message || e); }
  }
  function manage() {
    open = false;
    openSettingsFromChat('devices');
  }
  const tierText = (d) => {
    const tier = d.client?.tier || '';
    if (!d.online) return d.lastOnlineAt ? t('离线') : t('还没连上过');
    if (tier === 'control') return t('在线 · 可操作');
    if (tier === 'observe') return t('在线 · 只看，动手前问你');
    if (tier === 'workspace') return t('在线 · 老客户端');
    return t('在线');
  };
</script>

{#if show}
  <div class="dvc">
    <button type="button" class="chip" bind:this={btn} aria-haspopup="menu" aria-expanded={open}
      title={cur && cur.id ? (cur.online ? t('Claude 可以使用这台电脑') : t('这台电脑现在离线')) : t('Claude 要用哪台电脑')}
      onclick={toggle}>
      <svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2" y="3" width="12" height="8" rx="1.3" /><path d="M6 13.5h4M8 11v2.5" />
      </svg>
      <span class="lbl">{label}</span>
      <span class="dot {tone}" aria-hidden="true"></span>
    </button>

    {#if open}
      <button class="backdrop" aria-label={t('关闭')} onclick={() => (open = false)}></button>
      <div class="menu" class:down={dir === 'down'} role="menu" use:clampX={{ anchor: 'left' }}>
        <div class="mh">{session.id ? t('这个会话连哪台电脑') : t('新对话连哪台电脑')}</div>
        <button type="button" class="mi" role="menuitemradio" aria-checked={selected === 'auto'} onclick={() => choose('auto')}>
          <span class="txt">
            <span class="nm">{t('自动')}</span>
            <span class="ds">{thisDeviceId() ? t('连发消息的这台电脑') : t('只有一台在线时就用它')}</span>
          </span>
          {#if selected === 'auto'}<svg class="ck" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>{/if}
        </button>
        {#each devices.list as d (d.id)}
          <button type="button" class="mi" role="menuitemradio" aria-checked={selected === d.id} onclick={() => choose(d.id)}>
            <span class="dot {d.online ? 'on' : 'off'}" aria-hidden="true"></span>
            <span class="txt">
              <span class="nm">{d.name}{#if d.id === thisDeviceId()}<span class="badge">{t('这台')}</span>{/if}</span>
              <span class="ds">{tierText(d)}</span>
            </span>
            {#if selected === d.id}<svg class="ck" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>{/if}
          </button>
        {/each}
        <button type="button" class="mi" role="menuitemradio" aria-checked={selected === 'none'} onclick={() => choose('none')}>
          <span class="txt">
            <span class="nm">{t('不连电脑')}</span>
            <span class="ds">{t('Claude 只在服务器上干活')}</span>
          </span>
          {#if selected === 'none'}<svg class="ck" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>{/if}
        </button>
        {#if err}<div class="er">{err}</div>{/if}
        {#if !devices.list.length}
          <div class="mf">{isNativeDesktop() ? t('登录后这台电脑会自动出现在这里') : t('在电脑上装 bridge 桌面客户端并登录同一个账号，它就会出现在这里')}</div>
        {/if}
        {#if canOpenSettingsFromChat}<button type="button" class="mf link" onclick={manage}>{t('管理设备…')}</button>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .dvc { position: relative; display: flex; flex: none; min-width: 0; }
  /* 形制同归属栏的目录芯片（WorkspaceChips .chip）：高 24 / 圆角 6 / 字 13 */
  .chip {
    display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 7px 0 6px; border: 0; border-radius: 6px;
    font-size: 13px; line-height: 19px; color: var(--serif); min-width: 0; max-width: 220px;
    background-color: var(--bg); background-image: linear-gradient(var(--hover), var(--hover));
    box-shadow: var(--wc-ring, none);
    transition: background-color var(--mo-micro) var(--ea-std), color var(--mo-micro) var(--ea-std);
  }
  .chip:active { background: var(--hover-strong); color: var(--text); }
  @media (hover: hover) { .chip:hover { background: var(--hover-strong); color: var(--text); } }
  .ic { flex: none; width: 15px; height: 15px; }
  .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--muted); opacity: .5; }
  .dot.on { background: #2e9d5b; opacity: 1; }
  .dot.off { background: var(--muted); opacity: .55; }
  .dot.idle { display: none; }

  .backdrop { position: fixed; inset: 0; z-index: 60; }
  .menu { position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 61; width: max-content; min-width: 240px; max-width: min(340px, 92vw);
    padding: 6px 0; background: var(--q-card); border-radius: 12px; box-shadow: var(--q-shadow); max-height: 70vh; overflow-y: auto;
    animation: dvcPop var(--mo-quick, .16s) var(--ea-decel, ease-out); cursor: default; }
  .menu.down { bottom: auto; top: calc(100% + 8px); }
  @keyframes dvcPop { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: none; } }
  .mh { padding: 4px 12px; font-size: 12px; color: var(--muted); }
  .mi { width: 100%; display: flex; align-items: flex-start; gap: 10px; padding: 7px 12px; text-align: left; color: var(--text); }
  .mi .dot { margin-top: 7px; }
  .mi:active { background: var(--hover); }
  @media (hover: hover) { .mi:hover { background: var(--hover); } }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .nm { display: flex; align-items: center; gap: 6px; font-size: 13.5px; line-height: 19px; }
  .ds { font-size: 12px; line-height: 16px; color: var(--muted); }
  .badge { padding: 0 5px; border-radius: 4px; font-size: 10.5px; line-height: 15px; color: var(--muted); background: var(--hover-strong, var(--hover)); }
  .ck { flex: none; width: 15px; height: 15px; margin-top: 2px; color: var(--text); }
  .er { padding: 4px 12px; font-size: 12px; color: var(--crit, #d9534f); }
  .mf { display: block; width: 100%; text-align: left; padding: 6px 12px 2px; margin-top: 4px; border-top: 1px solid var(--divider); font-size: 11.5px; color: var(--muted); }
  .mf.link { color: var(--text); padding-bottom: 4px; }
  @media (hover: hover) { .mf.link:hover { background: var(--hover); } }
</style>
