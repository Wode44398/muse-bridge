<script>
  // 插件页面权限的授权框（界面层；数据与入口在 lib/grantDialog.svelte.js 的 askGrant）。
  //
  // bridge 自己画、插件伪造不了：画在主界面最上层（z 3600：盖过插件应用页 40–42、选择器 3400），
  // iframe 里的页面够不着这一层的 DOM，也合成不了这里的可信点击。
  // 应用内弹窗（DialogHost 3500）有一条在显示时 activeGrant() 回 null，这里整个收起、等它答完再出来（理由见 grantDialog.svelte.js 文件头）。
  // 插件给的应用名 / 插件名已在入队时去掉双向控制符，拼进句子时再用 bidiIsolate 隔开。
  // 两种外观，口径同 DialogHost：鼠标 / 触控板 → 墨与象牙扁平卡片；触屏（pointer: coarse）→ iOS 27 玻璃警告框（ios27/Alert）。
  //
  // 文案：「{应用}」想要{权限说明} / 来自插件「{插件}」/ 随时可以在 设置 › 页面权限 里撤销。
  // 按钮「不允许」「允许」，默认焦点给「不允许」（一路回车不会误授权）；Esc / 系统返回 = 不允许；点框外不关。
  //
  // 防误触（比 DialogHost 更严）：框出现后 GRANT_GUARD_MS 内的按下一律不算，连击的第二下起不算——
  // 插件可以先诱导用户在「允许」将出现的位置连点，再发起授权；这两道把那几下吞掉。
  // 键盘同一个时间窗：回车 / 空格 / Tab / 左右方向键在窗里按下的不算（按住不放的一直不算到松开），
  // 窗口结束时焦点要是不在「不允许」上就拉回来。
  import { onDestroy, setContext, untrack } from 'svelte';
  import Alert from '../ios27/Alert.svelte';
  import '../ios27/ink.css';
  import {
    grantState, grantHost, grantHooks, activeGrant, allowGrant, denyGrant, permText, GRANT_GUARD_MS,
  } from '../../lib/grantDialog.svelte.js';
  import { eventAt, bidiIsolate } from '../../lib/selfMount.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { pushNativeOverlay } from '../../lib/nativeDesktop.js';
  import { pressable } from '../../lib/motion.js';
  import { t } from '../../lib/i18n.js';

  // —— 认领：只有第一个实例干活 ——
  const self = {};
  const owner = !grantHost.owner;
  if (owner) {
    grantHost.owner = self;
    grantHost.ready = true;
    grantHooks.key = onKey;
    grantHooks.keyUp = onKeyUp;
  }
  onDestroy(() => {
    if (grantHost.owner !== self) return;
    grantHost.owner = null;
    grantHost.ready = false;
    grantHooks.key = null;
    grantHooks.keyUp = null;
  });

  const uid = $props.id();

  // —— 环境：触屏与否、明暗（读 <html data-theme>，同 DialogHost）——
  const mqCoarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
  let coarse = $state(!!mqCoarse?.matches);
  const readDark = () => typeof document === 'undefined' || document.documentElement.dataset.theme !== 'light';
  let dark = $state(readDark());
  $effect(() => {
    const onMq = () => { coarse = !!mqCoarse?.matches; };
    mqCoarse?.addEventListener?.('change', onMq);
    let mo = null;
    try {
      mo = new MutationObserver(() => { dark = readDark(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch {}
    return () => { mqCoarse?.removeEventListener?.('change', onMq); mo?.disconnect(); };
  });
  setContext('ios27', { get dark() { return dark; }, ink: true });

  const cur = $derived(owner ? activeGrant() : null);
  const shown = $derived(owner ? grantState.queue.filter((r) => r.closing || r === cur) : []);
  const open = $derived(owner && grantState.queue.length > 0);

  let rootEl = $state(null);

  // —— 按钮：视觉顺序 [不允许, 允许]（两种外观都是「不允许」在左）——
  const ORDER = ['deny', 'allow'];
  function buttons() {
    if (!rootEl || !cur) return [];
    const card = rootEl.querySelector(`[data-grant-id="${cur.id}"]`);
    if (!card) return [];
    const out = [];
    for (const role of ORDER) {
      const b = card.querySelector(`[data-act="${role}"]`);
      if (b && !b.disabled) out.push(b);
    }
    return out;
  }
  function focusRole(role) {
    const list = buttons();
    const b = list.find((x) => x.dataset.act === role) || list[0];
    try { b?.focus({ preventScroll: true }); } catch {}
    return !!b;
  }
  function focusedRole() {
    const a = typeof document !== 'undefined' ? document.activeElement : null;
    const b = a?.closest?.('[data-act]');
    return b && buttons().includes(b) ? b.dataset.act : null;
  }

  // 框都答完了：焦点还给打开前的地方（选择器里的行、应用页里的按钮）。不还的话按钮一拆焦点就掉到 body，
  // 叠在选择器上的那种场景里键盘用户得从头 Tab。必须写在下面「默认焦点给不允许」之前——同一轮里它先跑，
  // 这里才记得到打开前的焦点，而不是刚挪过去的「不允许」。
  const active = $derived(!!cur);
  $effect(() => {
    if (!active) return;
    const prev = untrack(() => document.activeElement);
    return () => {
      if (!(prev instanceof HTMLElement) || prev === document.body || !prev.isConnected) return;
      requestAnimationFrame(() => {
        const a = document.activeElement;
        // 关的这一下焦点已经被别处接走（换了页、别的弹层）就不抢
        if (a && a !== document.body && !rootEl?.contains(a)) return;
        if (prev.isConnected && !prev.closest('[inert]')) try { prev.focus({ preventScroll: true }); } catch {}
      });
    };
  });

  // 每换一条：默认焦点给「不允许」，记下出现时刻（防误触时间窗从这里起算）
  $effect(() => {
    const r = cur;
    void coarse;
    if (!r) return;
    let timer = 0;
    untrack(() => {
      downIn = false; swallow = false;
      // 上一条（或框出现之前）按下的键都不认：松开时一并吞掉，见 onKeyUp
      keyState.clear();
      shownAt = performance.now();
      if (!focusRole('deny')) requestAnimationFrame(() => { if (cur === r) focusRole('deny'); });
      // 时间窗结束时焦点必须在「不允许」上：窗里挪焦点的路都堵了，这里再兜一道——
      // 万一被什么挪到了「允许」，窗后的第一下回车 / 空格也只会落在「不允许」上
      timer = setTimeout(() => { if (cur === r && focusedRole() === 'allow') focusRole('deny'); }, GRANT_GUARD_MS);
    });
    return () => clearTimeout(timer);
  });

  // 系统返回 = 不允许；授权框最后压栈，排在选择器、应用页之前被关
  $effect(() => {
    const r = cur;
    if (!r) return;
    const id = r.id;
    return pushBackLayer(() => { denyGrant(id); });
  });

  // 桌面壳的内嵌原生浏览器视图盖在网页之上，框开着时让它让位
  $effect(() => { if (open) return pushNativeOverlay(); });

  let kbd = $state(false);
  $effect(() => { if (!open) kbd = false; });

  // 焦点困在框里：被程序挪走（比如 iframe 里的页面抢焦点）时拉回「不允许」。
  // 授权框是最上层，不给谁让路；应用内弹窗开着时 cur 为 null（授权框已收起），这里自然不拉。
  // pulling 防重入：拉回那一下 focus() 会同步嵌套触发 focusin，万一以后再冒出别的不让路的陷阱，也不会互相拉到递归
  $effect(() => {
    if (!open) return;
    let pulling = false;
    const onIn = (e) => {
      if (pulling || !cur || !rootEl) return;
      if (e.target instanceof Node && rootEl.contains(e.target)) return;
      pulling = true;
      try { focusRole('deny'); } finally { pulling = false; }
    };
    document.addEventListener('focusin', onIn, true);
    // iframe 抢到焦点时主文档收不到 focusin，只会收到 window 的 blur：下一帧看焦点是不是落在了框外的 iframe 上
    const onBlur = () => requestAnimationFrame(() => {
      const a = document.activeElement;
      if (cur && rootEl && a && a.tagName === 'IFRAME' && !rootEl.contains(a)) focusRole('deny');
    });
    window.addEventListener('blur', onBlur);
    return () => { document.removeEventListener('focusin', onIn, true); window.removeEventListener('blur', onBlur); };
  });

  // —— 键盘防误触：和指针同一个时间窗 ——
  // 框是插件请求出来的，插件能挑用户正连着敲键的时候发（表单里习惯性的 Tab→回车、小游戏里的 →→回车）：
  // 框一出，焦点从 iframe 拉到「不允许」上，用户后面那几下全进了框——Tab / 方向键把焦点挪到「允许」，
  // 紧跟着的回车或空格（按钮的原生 click，detail = 0，指针那几道防护管不着）就成了同意。
  // 所以窗里按下的这几个键一律 preventDefault 并忽略；按住不放的，自动重复一直不算，松开那一下也吞（空格的 click 发在松开时）。
  // Esc 不在其列：它只会是「不允许」，窗里也照认。
  const GUARD_KEYS = new Set(['Enter', ' ', 'Spacebar', 'Tab', 'ArrowLeft', 'ArrowRight']);
  // 这一条显示期间看到的按下：key → 'ok'（照常处理了）| 'swallowed'（窗里按下、吞掉了）
  const keyState = new Map();
  const inGuard = (e) => Number.isFinite(shownAt) && eventAt(e) - shownAt < GRANT_GUARD_MS;
  function guardKey(e) {
    const k = e.key;
    if (!GUARD_KEYS.has(k)) return false;
    const st = keyState.get(k);
    if (e.repeat) {
      // 自动重复：按下那一下吞了的、或按下发生在框出现之前（没有记录）的，一直吞到松开
      if (st !== 'ok') { keyState.set(k, 'swallowed'); return true; }
      return false;
    }
    if (inGuard(e)) { keyState.set(k, 'swallowed'); return true; }
    keyState.set(k, 'ok');
    return false;
  }
  // 由 grantDialog.svelte.js 的全局 keyup 捕获监听转进来；回 true = 吞掉了
  function onKeyUp(e) {
    const k = e.key;
    if (!GUARD_KEYS.has(k)) return false;
    const st = keyState.get(k);
    keyState.delete(k);
    // 吞掉的那一下；或框开着、却没见过它按下（按下时焦点还在 iframe 里 / 框出现之前就按着）——松开都不能替按钮点
    if (st === 'swallowed' || (!st && cur)) { e.preventDefault(); return true; }
    return false;
  }

  // —— 键盘（由 grantDialog.svelte.js 的全局捕获监听转进来，已挡住底下的快捷键）——
  function onKey(e) {
    const r = cur;
    if (!r) return;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      if (!e.repeat) denyGrant(r.id);
      return;
    }
    if (guardKey(e)) { e.preventDefault(); return; }
    if (k === 'Enter') {
      e.preventDefault();
      if (e.repeat || e.isComposing) return;
      const role = focusedRole() || 'deny';
      if (role === 'allow') allowGrant(r.id); else denyGrant(r.id);
      return;
    }
    if (k === 'Tab' || k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      kbd = true;
      const list = buttons();
      if (!list.length) return;
      const dir = k === 'ArrowLeft' || (k === 'Tab' && e.shiftKey) ? -1 : 1;
      const at = list.indexOf(document.activeElement?.closest?.('[data-act]'));
      const n = list.length;
      const next = at < 0 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n;
      try { list[next]?.focus({ preventScroll: true }); } catch {}
    }
    // 空格：时间窗之后是按钮的原生行为（松开时 click，detail = 0），不拦；窗里按下的已在 guardKey / onKeyUp 吞掉
  }

  // —— 指针防误触：时间窗 + 连击 + 「按下也在框里」——
  let downIn = false;
  let shownAt = -Infinity;
  let swallow = false;
  function onRootDown(e) {
    if (Number.isFinite(shownAt) && eventAt(e) - shownAt < GRANT_GUARD_MS) {
      downIn = false; swallow = true;
      e.stopPropagation();
      return;
    }
    swallow = false;
    const el = e.target instanceof Element ? e.target : null;
    downIn = !!(cur && el?.closest(`[data-grant-id="${cur.id}"]`));
  }
  // 被挡掉的那一下：兼容 mousedown 的默认行为会把焦点挪到按下的按钮上（挪到「允许」上再按回车就成了同意）
  function onRootMouseDown(e) {
    if (!swallow) return;
    e.preventDefault();
    e.stopPropagation();
  }
  function onRootClick(e) {
    const d = Number(e.detail) || 0;
    // detail = 0 的点击（键盘 / 辅助技术触发）在时间窗里也不认：按键那边已经挡了，这里兜底，两种外观都管得到
    // （玻璃外观的按钮直接调 allowGrant，不经 act()，只能在根上的捕获阶段拦）
    if (!((d === 0 && inGuard(e)) || d > 1 || (swallow && d > 0))) return;
    e.preventDefault();
    e.stopPropagation();
  }
  function act(e, r, role) {
    if (e.detail > 0 && !downIn) return;
    if (role === 'allow') allowGrant(r.id); else denyGrant(r.id);
  }

  const headline = (r) => t('「{app}」想要{what}', { app: bidiIsolate(r.appTitle), what: permText(r.perm) });
  const fromLine = (r) => t('来自插件「{plugin}」', { plugin: bidiIsolate(r.pluginName) });
  const revokeLine = () => t('随时可以在 设置 › 页面权限 里撤销。');

  // 玻璃外观的按钮：[允许, 不允许]（Alert 并排时 row-reverse，「不允许」在左）
  function glassActions(r) {
    return [
      { label: r.busy ? t('正在保存…') : t('允许'), role: 'default', act: 'allow', disabled: r.busy, onclick: () => allowGrant(r.id) },
      { label: t('不允许'), role: 'cancel', act: 'deny', onclick: () => denyGrant(r.id) },
    ];
  }
</script>

{#if open}
  <!-- 三个捕获监听都是指针防误触；键盘走 grantDialog.svelte.js 的全局监听。遮罩只挡指针，点了不关 -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="gd-root i27ink"
    class:dark
    class:glass={coarse}
    class:idle={!cur}
    class:kbd
    data-grant-host
    role="presentation"
    bind:this={rootEl}
    onpointerdowncapture={onRootDown}
    onmousedowncapture={onRootMouseDown}
    onclickcapture={onRootClick}
  >
    <div class="gd-scrim" class:closing={!cur}></div>

    {#each shown as r (r.id)}
      {#if coarse}
        <div class="gd-glass" data-grant-id={r.id} inert={r.closing}>
          <Alert
            dim={false}
            closing={r.closing}
            title={headline(r)}
            message={fromLine(r)}
            detail={revokeLine()}
            error={r.error}
            actions={glassActions(r)}
          />
        </div>
      {:else}
        <div
          class="gd-card"
          class:closing={r.closing}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="{uid}-h{r.id}"
          aria-describedby="{uid}-f{r.id} {uid}-r{r.id}"
          data-grant-id={r.id}
          inert={r.closing}
        >
          <div class="gd-body">
            <div class="gd-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3.2 5.2 5.8v5.6c0 4.3 2.9 7.7 6.8 9.4 3.9-1.7 6.8-5.1 6.8-9.4V5.8L12 3.2Z" />
                <path d="m9.2 12.1 2 2 3.8-4" />
              </svg>
            </div>
            <p class="gd-head" id="{uid}-h{r.id}">{headline(r)}</p>
            <p class="gd-from" id="{uid}-f{r.id}">{fromLine(r)}</p>
            <p class="gd-note" id="{uid}-r{r.id}">{revokeLine()}</p>
            {#if r.error}<p class="gd-err" role="alert">{r.error}</p>{/if}
          </div>
          <div class="gd-acts">
            <button type="button" class="gd-btn" data-act="deny" use:pressable onclick={(e) => act(e, r, 'deny')}>{t('不允许')}</button>
            <button type="button" class="gd-btn primary" class:busy={r.busy} data-act="allow" disabled={r.busy} use:pressable
              onclick={(e) => act(e, r, 'allow')}>{r.busy ? t('正在保存…') : t('允许')}</button>
          </div>
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  /* 「墨与象牙」令牌：挂在 body 上、不在任何设置外壳里，自己带齐（与 DialogHost 同值） */
  .gd-root {
    --st-surface: #fcfbf8; --text: #1d1b18;
    --st-text2: rgba(29, 27, 24, .72); --st-muted: rgba(29, 27, 24, .5);
    --st-line: rgba(29, 27, 24, .1); --st-sel: rgba(29, 27, 24, .08); --st-seg: rgba(29, 27, 24, .06);
    --st-primary: #1d1b18; --st-primary-ink: #f6f3ec; --pm-red: #c4473b;
    --gd-shadow: 0 24px 70px rgba(24, 21, 17, .2), 0 2px 8px rgba(24, 21, 17, .08);

    position: fixed; inset: 0; z-index: 3600;
    display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); place-items: center;
    padding: calc(var(--sat, 0px) + 24px) 24px calc(var(--sab, 0px) + 24px);
    font-family: var(--sans, system-ui, sans-serif); color: var(--text);
    -webkit-tap-highlight-color: transparent;
  }
  .gd-root.dark {
    --st-surface: #1a1917; --text: #f1ece2;
    --st-text2: rgba(241, 236, 226, .74); --st-muted: rgba(241, 236, 226, .5);
    --st-line: rgba(241, 236, 226, .1); --st-sel: rgba(241, 236, 226, .1); --st-seg: rgba(241, 236, 226, .07);
    --st-primary: #ebe5d8; --st-primary-ink: #151412; --pm-red: #e2725f;
    --gd-shadow: 0 24px 70px rgba(0, 0, 0, .45), 0 2px 8px rgba(0, 0, 0, .25);
  }
  .gd-root.idle { pointer-events: none; }

  .gd-scrim {
    position: absolute; inset: 0; background: rgba(0, 0, 0, .42); touch-action: none;
    animation: gd-fade var(--mo-quick, 200ms) var(--ea-fade, ease) both;
    transition: opacity var(--mo-quick, 200ms) var(--ea-fade, ease);
  }
  .gd-scrim.closing { opacity: 0; }
  .gd-root.glass .gd-scrim { background: var(--i-dim); }

  /* —— 扁平卡片 —— */
  .gd-card {
    grid-area: 1 / 1; position: relative;
    display: flex; flex-direction: column;
    width: min(360px, 100%); max-height: min(70vh, 100%); box-sizing: border-box;
    background: var(--st-surface); border: 1px solid var(--st-line); border-radius: 16px;
    box-shadow: var(--gd-shadow);
    animation: gd-pop var(--mo-base, 280ms) var(--ea-decel, cubic-bezier(.2, .8, .2, 1)) both;
    transition: opacity var(--mo-quick, 200ms) var(--ea-fade, ease), transform var(--mo-quick, 200ms) var(--ea-accel, ease-in);
  }
  .gd-card.closing { opacity: 0; transform: scale(.97); pointer-events: none; }
  .gd-body {
    min-height: 0; overflow-y: auto; overscroll-behavior: contain;
    padding: 20px 22px 4px; display: flex; flex-direction: column;
  }
  .gd-mark {
    width: 36px; height: 36px; margin-bottom: 14px; border-radius: 10px;
    display: grid; place-items: center; color: var(--text); background: var(--st-seg);
  }
  .gd-head {
    margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; color: var(--text);
    overflow-wrap: anywhere; text-wrap: balance;
  }
  .gd-from { margin: 6px 0 0; font-size: 13px; line-height: 19px; color: var(--st-text2); overflow-wrap: anywhere; }
  .gd-note { margin: 10px 0 0; padding-top: 10px; border-top: 1px solid var(--st-line); font-size: 12.5px; line-height: 18px; color: var(--st-muted); text-wrap: pretty; }
  .gd-err { margin: 10px 0 0; font-size: 13px; line-height: 19px; color: var(--pm-red); overflow-wrap: anywhere; }
  .gd-acts { flex-shrink: 0; display: flex; justify-content: flex-end; gap: 8px; padding: 18px 22px 20px; }
  .gd-btn {
    min-width: 84px; height: 34px; padding: 0 16px; border: 0; border-radius: 10px; cursor: pointer;
    font: inherit; font-size: 14px; line-height: 20px; font-weight: 500; white-space: nowrap;
    color: var(--text); background: var(--st-seg);
    transform: scale(var(--press-s, 1));
    transition: background-color var(--mo-micro, 120ms) var(--ea-fade, ease), opacity var(--mo-micro, 120ms) var(--ea-fade, ease);
  }
  .gd-btn:hover { background: var(--st-sel); }
  .gd-btn.primary { color: var(--st-primary-ink); background: var(--st-primary); }
  .gd-btn.primary:hover { opacity: .9; }
  .gd-btn:disabled { cursor: default; opacity: .55; }
  .gd-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--text) 55%, transparent); outline-offset: 2px; }

  @media (max-width: 699px) {
    .gd-card { width: 100%; }
    .gd-body { padding: 20px 20px 4px; }
    .gd-acts { padding: 16px 20px 20px; }
    .gd-btn { flex: 1 1 0; min-width: 0; height: 44px; border-radius: 12px; font-size: 15px; }
  }

  /* —— 玻璃外观：Alert 自带 fixed 根与动画，这一层只是给查找按钮用的容器 —— */
  .gd-glass { display: contents; }
  .gd-glass :global(.al-tm h3) { text-wrap: balance; }
  .gd-glass :global(.al-tm p) { text-wrap: pretty; }
  .gd-glass :global(.al-btn:focus-visible) { outline: none; }
  .gd-root.kbd .gd-glass :global(.al-btn:focus-visible) { outline: 2px solid color-mix(in srgb, var(--i-label) 55%, transparent); outline-offset: 2px; }
  @media (hover: hover) {
    .gd-glass :global(.al-btn:focus-visible) { outline: 2px solid color-mix(in srgb, var(--i-label) 55%, transparent); outline-offset: 2px; }
  }

  @keyframes gd-fade { from { opacity: 0; } }
  @keyframes gd-pop { from { opacity: 0; transform: scale(.96); } }
</style>
