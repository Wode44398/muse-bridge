<script>
  // 切换服务器面板（手机 App 多服务器档案）：主页长按标题 / 标题下的服务器胶囊、设置「关于 › 服务器」、离线提示条都开这里。
  // 点一台 = 整段切换演出（lib/serverSwitch.js）；「添加服务器」= 建一份空档案后落到「连接你的 bridge 服务器」，扫码或填地址连上。
  // 编辑态里改名、删掉不在用的档案。每台都探一下 /healthz 标出延迟，连不上的照样能切（进去看本地缓存，恢复后自动重连）。
  import { onMount } from 'svelte';
  import { ui } from '../lib/state.svelte.js';
  import { listProfiles, renameProfile, removeProfile, monogram, hostLabel } from '../lib/serverProfiles.js';
  import { switchServer } from '../lib/serverSwitch.js';
  import { swipeDismiss, pressable } from '../lib/motion.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { t } from '../lib/i18n.js';

  let list = $state(listProfiles().filter((p) => !p.pending));
  let editing = $state(false);
  let picked = $state('');
  let confirmDel = $state('');
  let lat = $state({});            // id → 毫秒；-1 = 连不上；没有 = 检测中
  let leaving = $state(false), dy = $state(0), dragging = $state(false);

  const refresh = () => { list = listProfiles().filter((p) => !p.pending); };
  function close() {
    if (leaving || picked) return;
    leaving = true;
    setTimeout(() => { ui.serverSwitcherOpen = false; }, 260);
  }

  // 局域网候选与公网地址各探一次，取先通的那条的耗时
  function measure(p) {
    const one = (b) => new Promise((res) => {
      const ctl = new AbortController(), t0 = performance.now();
      const timer = setTimeout(() => { ctl.abort(); res(-1); }, 4000);
      fetch(b + '/healthz', { cache: 'no-store', signal: ctl.signal, credentials: 'omit' })
        .then((r) => res(r.ok ? Math.round(performance.now() - t0) : -1), () => res(-1))
        .finally(() => clearTimeout(timer));
    });
    const bases = [p.lan, p.base].filter(Boolean);
    Promise.all(bases.map(one)).then((ms) => {
      const ok = ms.filter((m) => m >= 0);
      lat = { ...lat, [p.id]: ok.length ? Math.min(...ok) : -1 };
    });
  }
  onMount(() => { for (const p of list) if (!p.active) measure(p); });
  // 安卓返回键 / 侧滑：先关面板
  $effect(() => pushBackLayer(() => close()));

  function pick(p) {
    if (editing || picked) return;
    if (p.active) { close(); return; }
    picked = p.id;
    try { navigator.vibrate?.(10); } catch {}
    setTimeout(() => switchServer(p.id), 170);
  }
  function add() {
    if (picked) return;
    picked = 'new';
    setTimeout(() => switchServer(null), 140);
  }
  function commitName(p, v) { renameProfile(p.id, v); refresh(); }
  function del(p) {
    if (confirmDel !== p.id) { confirmDel = p.id; return; }
    removeProfile(p.id);
    confirmDel = '';
    refresh();
  }

  const drag = (node) => swipeDismiss(node, {
    axis: 'y', dir: 1, threshold: 0.3,
    size: () => node.closest('.ss')?.offsetHeight || 400,
    guard: (e) => !picked && !e.target.closest('button, input'),
    base: () => dy, cur: () => dy,
    onStart: () => { dragging = true; },
    onMove: (y) => (dy = y),
    onSettle: (go) => { dragging = false; if (!go) dy = 0; },
    onDismiss: () => { leaving = true; ui.serverSwitcherOpen = false; },
  });

  function sub(p) {
    if (p.active) {
      if (ui.offline) return t('使用中 · 连不上');
      return ui.connMode === 'lan' ? t('使用中 · 局域网直连') : t('使用中');
    }
    const ms = lat[p.id];
    if (ms == null) return t('检测中…');
    if (ms < 0) return t('暂时连不上');
    return t('{ms} 毫秒', { ms });
  }
  const health = (p) => {
    if (p.active) return ui.offline ? 'bad' : 'good';
    const ms = lat[p.id];
    return ms == null ? 'wait' : ms < 0 ? 'bad' : ms < 400 ? 'good' : 'slow';
  };
</script>

<div class="ss-root" class:leaving role="presentation">
  <button class="ss-dim" type="button" tabindex="-1" aria-label={t('关闭')} onclick={close}></button>
  <div class="ss" class:dragging role="dialog" aria-modal="true" aria-label={t('切换服务器')}
    style:transform={dy > 0 ? `translateY(${dy}px)` : null}>
    <div class="ss-top" use:drag>
      <span class="grab"></span>
      <div class="ss-bar">
        <span class="ss-title">{t('切换服务器')}</span>
        {#if list.length > 1}
          <button class="ss-edit" type="button" onclick={() => { editing = !editing; confirmDel = ''; }}>{editing ? t('完成') : t('编辑')}</button>
        {/if}
      </div>
    </div>

    <div class="ss-list">
      {#each list as p, i (p.id)}
        <div class="card" class:active={p.active} class:picked={picked === p.id} class:dim={picked && picked !== p.id}
             style:--c={p.color} style:--i={i}>
          <button class="card-hit" type="button" use:pressable={{ scale: 0.97, disabled: editing }} onclick={() => pick(p)} disabled={editing}
                  aria-label={p.active ? t('{name}（使用中）', { name: p.name }) : t('切换到 {name}', { name: p.name })}>
            <span class="orb"><span class="mono">{monogram(p.name)}</span></span>
            <span class="txt">
              {#if editing}
                <input class="nm-in" value={p.name} maxlength="24" placeholder={hostLabel(p.base)}
                  onclick={(e) => e.stopPropagation()}
                  onchange={(e) => commitName(p, e.currentTarget.value)}
                  onkeydown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
              {:else}
                <span class="nm">{p.name}</span>
              {/if}
              <span class="meta"><i class="hd {health(p)}"></i>{sub(p)}<span class="host">{hostLabel(p.base)}</span></span>
            </span>
            {#if !editing}
              {#if p.active}
                <span class="tick" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
              {:else}
                <span class="go" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
              {/if}
            {/if}
          </button>
          {#if editing && !p.active}
            <button class="del" class:sure={confirmDel === p.id} type="button" onclick={() => del(p)}
                    aria-label={t('删除 {name}', { name: p.name })}>
              {#if confirmDel === p.id}{t('删除')}{:else}<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 12h12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>{/if}
            </button>
          {/if}
        </div>
      {/each}

      {#if !editing}
        <button class="card add" type="button" style:--i={list.length} class:dim={picked && picked !== 'new'} use:pressable={{ scale: 0.97 }} onclick={add}>
          <span class="orb plus"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></span>
          <span class="txt">
            <span class="nm">{t('添加服务器')}</span>
            <span class="meta">{t('扫码或填地址，连上另一台 bridge')}</span>
          </span>
        </button>
      {/if}
    </div>
    <p class="ss-foot">{editing ? t('改名只在这台手机上生效；删掉的服务器会在那边退出登录。') : t('每台服务器的登录和本地缓存各自保存，切换不用重新登录。')}</p>
  </div>
</div>

<style>
  .ss-root { position: fixed; inset: 0; z-index: 450; }
  .ss-dim { position: absolute; inset: 0; border: 0; padding: 0; background: rgba(0, 0, 0, .46); cursor: default;
    animation: ss-fade 260ms cubic-bezier(.4, 0, .6, 1) both; transition: opacity 240ms linear; }
  .ss {
    position: absolute; left: 50%; bottom: calc(max(8px, var(--sab, 0px)) + 4px); width: min(calc(100% - 16px), 520px);
    max-height: calc(100% - var(--sat, 0px) - 24px); display: flex; flex-direction: column;
    margin-left: calc(min(calc(100% - 16px), 520px) / -2);
    border-radius: 32px; color: #f4f4f5; isolation: isolate;
    background: linear-gradient(180deg, rgba(44, 44, 48, .86), rgba(26, 26, 29, .9));
    -webkit-backdrop-filter: blur(28px) saturate(1.5); backdrop-filter: blur(28px) saturate(1.5);
    box-shadow: inset 0 .5px 0 rgba(255, 255, 255, .16), 0 0 0 .5px rgba(255, 255, 255, .08), 0 24px 70px rgba(0, 0, 0, .5);
    animation: ss-in 520ms cubic-bezier(.2, .95, .25, 1) both;
    transition: transform 380ms cubic-bezier(.2, .95, .25, 1);
  }
  .ss.dragging { transition: none; }
  .leaving .ss-dim { opacity: 0; }
  .leaving .ss { animation: ss-out 260ms cubic-bezier(.3, 0, .8, .15) both; }
  @keyframes ss-fade { from { opacity: 0; } }
  @keyframes ss-in { from { transform: translateY(calc(100% + 24px)); } }
  @keyframes ss-out { to { transform: translateY(calc(100% + 24px)); } }

  .ss-top { padding: 8px 18px 4px; touch-action: none; }
  .grab { display: block; width: 36px; height: 5px; border-radius: 3px; margin: 0 auto 10px; background: rgba(255, 255, 255, .22); }
  .ss-bar { display: flex; align-items: center; justify-content: space-between; min-height: 30px; }
  .ss-title { font-size: 19px; font-weight: 700; letter-spacing: -.01em; }
  .ss-edit { font-size: 15px; font-weight: 600; color: #8fb2ff; background: none; padding: 6px 2px; }

  .ss-list { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 4px; overflow-y: auto; }
  .card {
    position: relative; display: flex; align-items: center; border-radius: 22px;
    background: rgba(255, 255, 255, .055); box-shadow: inset 0 0 0 .5px rgba(255, 255, 255, .07);
    animation: card-in 460ms cubic-bezier(.05, .7, .1, 1) both; animation-delay: calc(80ms + var(--i, 0) * 45ms);
    transition: opacity 220ms ease, box-shadow 260ms ease, background 260ms ease;
  }
  @keyframes card-in { from { opacity: 0; transform: translateY(14px); } }
  .card.active {
    background: linear-gradient(110deg, color-mix(in srgb, var(--c) 22%, transparent), rgba(255, 255, 255, .04) 70%);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 55%, transparent);
  }
  .card.picked { box-shadow: inset 0 0 0 1.5px var(--c), 0 0 28px color-mix(in srgb, var(--c) 45%, transparent);
    background: color-mix(in srgb, var(--c) 18%, rgba(255, 255, 255, .04)); }
  .card.dim { opacity: .38; }
  .card-hit, .card.add {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 13px; padding: 12px 14px; text-align: left;
    background: none; color: inherit; transform: scale(var(--press-s, 1));
  }
  .card.add { flex: none; width: 100%; }
  .orb {
    flex: none; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; position: relative;
    background: radial-gradient(circle at 32% 26%, color-mix(in srgb, var(--c) 45%, #fff), var(--c) 58%, color-mix(in srgb, var(--c) 70%, #000));
    box-shadow: inset 0 1px 1px rgba(255, 255, 255, .35), 0 4px 14px color-mix(in srgb, var(--c) 40%, transparent);
  }
  .card.picked .orb { animation: orb-pulse 900ms ease-in-out infinite; }
  @keyframes orb-pulse { 50% { box-shadow: inset 0 1px 1px rgba(255, 255, 255, .35), 0 0 0 7px color-mix(in srgb, var(--c) 22%, transparent), 0 4px 22px var(--c); } }
  .mono { font-size: 18px; font-weight: 700; color: #fff; text-shadow: 0 1px 2px rgba(0, 0, 0, .25); }
  .orb.plus { --c: #3a3a3f; background: rgba(255, 255, 255, .06); box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, .22); color: rgba(255, 255, 255, .8);
    border: 0; }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .nm { font-size: 16.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: rgba(255, 255, 255, .56); white-space: nowrap; overflow: hidden; }
  .host { overflow: hidden; text-overflow: ellipsis; opacity: .7; }
  .host::before { content: '·'; margin-right: 6px; }
  .hd { flex: none; width: 7px; height: 7px; border-radius: 50%; background: rgba(255, 255, 255, .3); }
  .hd.good { background: #3fd08b; box-shadow: 0 0 8px rgba(63, 208, 139, .7); }
  .hd.slow { background: #f0b545; }
  .hd.bad { background: #ef6b5b; }
  .hd.wait { animation: hd-wait 1s ease-in-out infinite; }
  @keyframes hd-wait { 50% { opacity: .35; } }
  .nm-in { width: 100%; height: 30px; margin: -3px 0 0; padding: 0 10px; border: 0; outline: 0; border-radius: 9px;
    background: rgba(255, 255, 255, .1); color: #fff; font-size: 15.5px; font-weight: 600; }
  .tick { flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: #fff;
    background: var(--c); box-shadow: 0 2px 10px color-mix(in srgb, var(--c) 55%, transparent); }
  .go { flex: none; color: rgba(255, 255, 255, .42); transition: transform 200ms ease, color 200ms ease; }
  .card.picked .go { color: var(--c); transform: translateX(3px); }
  .del { flex: none; height: 32px; min-width: 32px; margin-right: 12px; padding: 0 8px; border-radius: 16px; display: grid; place-items: center;
    background: #ef4b3c; color: #fff; font-size: 14px; font-weight: 650; transition: min-width 200ms ease; }
  .del.sure { min-width: 64px; }
  .ss-foot { margin: 8px 22px 16px; font-size: 12.5px; line-height: 1.5; color: rgba(255, 255, 255, .42); }
</style>
