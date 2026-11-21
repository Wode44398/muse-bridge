<script>
  // Claude 输入栏右下角的发送 / 停止键。
  //   键上画的是「这一下会发生的事」：↑ 发出去；■ 停下；箭头顶上多一道横线 = 稍后发送（先放着，等这一轮结束）。
  //   空着时是淡键；有字，墨从键底漫上来；附件在传，墨停在进度的位置；发出去，墨汇成一点、开成星芒、收成方块。
  //   Claude 干活时又打了字：停止让到左边，发送回到最右；「稍后发送」在 Ctrl+Enter、长按和右键里。
  // 结构和样式在这里（SendKey.css），造型切换与编排在 lib/claudeSendKey.js——那两颗 <button> 的 class / data-ic / style 归它管，
  // 所以模板里不给它们挂 class: / style: 指令（Svelte 整串重写 class 会把它加的类冲掉）。
  import { onMount, untrack } from 'svelte';
  import { SendKeyMotion, resumableFx } from '../../lib/claudeSendKey.js';
  import { haptic } from '../../lib/dragdrop.svelte.js';
  import { t } from '../../lib/i18n.js';
  import './SendKey.css';

  let {
    busy = false,          // Claude 在干活（停止键在场）
    has = false,           // 输入框里有字或有附件
    upload = null,         // 附件上传：null 没在传 / 0–1 进度 / -1 在传但不知道进度
    verifying = false,     // 会话状态还没经服务端确认：暂不放行发送
    canSteer = true,       // 干活时能不能插话 / 排队（快照访客不能）
    touch = false,
    scope = '',            // 换了会话就传不同的值：那一下直接到位，不演过渡
    onsend,                // (mode: 'send' | 'queue')
    onstop,
  } = $props();

  const RAYS = [0, 1, 2, 3, 4, 5, 6, 7];
  let root = $state(), sendEl = $state(), stopEl = $state(), sendSlot = $state(), stopSlot = $state();
  let ready = $state(false);
  let ctrl = $state(false);          // 按着 Ctrl / ⌘：干活时发送键先换成「稍后发送」的样子
  let stopping = $state(false);      // 点了停止、这一轮还没真停下
  let verifyShown = $state(false);   // 确认超过 400ms 才显示等待（局域网下几百毫秒就确认完，不闪）
  let menuOpen = $state(false);
  let motion = null, stopT = 0, lpT = 0, lpFired = false, first = true, lastScope;

  const speed = () => { try { return parseFloat(getComputedStyle(root).getPropertyValue('--csk-k')) || 1; } catch { return 1; } };
  const canQueue = () => busy && has && canSteer;

  onMount(() => {
    motion = new SendKeyMotion({ root, send: sendEl, stop: stopEl, sendSlot, stopSlot }, { speed });
    ready = true;
    const kd = (e) => {
      if ((e.key === 'Control' || e.key === 'Meta') && !ctrl) ctrl = true;
      if (e.key === 'Escape' && menuOpen) menuOpen = false;
    };
    const ku = (e) => { if (e.key === 'Control' || e.key === 'Meta') ctrl = false; };
    const blur = () => { ctrl = false; };
    const pd = (e) => { if (menuOpen && root && !root.contains(e.target)) menuOpen = false; };
    window.addEventListener('keydown', kd, true);
    window.addEventListener('keyup', ku, true);
    window.addEventListener('blur', blur);
    document.addEventListener('pointerdown', pd, true);
    return () => {
      window.removeEventListener('keydown', kd, true);
      window.removeEventListener('keyup', ku, true);
      window.removeEventListener('blur', blur);
      document.removeEventListener('pointerdown', pd, true);
      clearTimeout(stopT); clearTimeout(lpT);
      motion?.destroy(); motion = null;
    };
  });

  $effect(() => {
    if (!verifying) { verifyShown = false; return; }
    const id = setTimeout(() => { verifyShown = true; }, 400);
    return () => clearTimeout(id);
  });
  $effect(() => { if (!busy) stopping = false; });
  $effect(() => { if (!(busy && has)) menuOpen = false; });

  // 状态 → 造型。头一次、以及换了会话的那一下直接到位；其余都从当前的样子过渡过去
  $effect(() => {
    if (!ready) return;
    const st = { busy, has: has && (!busy || canSteer), upload, verifying: verifyShown, stopping, ctrl };
    const sc = scope;
    untrack(() => {
      if (!motion) return;
      if (first) {
        first = false; lastScope = sc;
        // 刚挂上来、而另一条输入栏的「发出去的那一下」还没演完（新对话第一句：欢迎页那条正换成对话页这条）：
        // 先摆成它发出前的样子，从同一个时间点接着演，演完再对账
        const r = resumableFx(speed());
        if (r && r.owner !== motion) {
          motion.instant(() => { motion.apply({ busy: r.kind !== 'send', has: true, upload: null, verifying: false, stopping: false, ctrl: false }); motion.fx(r.kind, r.viaKey, r.elapsed); });
          motion.apply(st);
        } else motion.instant(() => motion.apply(st));
        return;
      }
      // 「发出去的那一下」正演着时会话 id 也可能变（新对话拿到 id）：那不算换会话，别把它掐掉
      const jump = sc !== lastScope && !motion.fxKind;
      lastScope = sc;
      if (jump) motion.instant(() => motion.apply(st)); else motion.apply(st);
    });
  });

  // 输入栏在真的发出去时调：演「发出去的那一下」。kind = send | steer | queue；viaKey = 键盘发的
  export function fx(kind, viaKey = false) { motion?.fx(kind, viaKey); }
  // 键盘上的停止（Esc）：屏幕上的停止键跟着按一下
  export function stopViaKey() { doStop(true); }

  function doStop(viaKey = false) {
    if (stopping) return;
    if (viaKey && motion && stopEl) motion.press(stopEl);
    haptic('light');
    stopping = true;
    clearTimeout(stopT);
    stopT = setTimeout(() => { stopping = false; }, 8000);   // 没停下来（断网之类）：别一直转，退回方块让人再点
    onstop?.();
  }
  function onSendClick() {
    if (lpFired) { lpFired = false; return; }                 // 长按已经弹了菜单，松手这一下不算点
    if (motion?.fxKind === 'send') { doStop(); return; }       // 那一下还没演完就点：这颗键已经是停止了
    if (sendEl?.getAttribute('aria-disabled') === 'true') return;
    haptic('light');
    onsend?.('send');
  }
  // 长按 / 右键发送键 → 稍后发送（只在 Claude 干活、输入框里有东西时有）
  function onSendDown() {
    lpFired = false; clearTimeout(lpT);
    if (!canQueue()) return;
    lpT = setTimeout(() => { lpFired = true; menuOpen = true; haptic('tick'); }, 420);
  }
  function onSendUp() { clearTimeout(lpT); }
  function onSendContext(e) {
    if (!canQueue()) return;
    e.preventDefault();
    clearTimeout(lpT);
    if (e.pointerType === 'touch' || touch) lpFired = true;    // 触屏长按也会来一次 contextmenu：松手那一下同样不算点
    menuOpen = true;
  }
  function pickQueue() { menuOpen = false; haptic('light'); onsend?.('queue'); }

  const sendLabel = $derived(busy ? (ctrl ? t('稍后发送') : t('插话发送')) : upload != null ? t('附件上传中') : verifying ? t('正在同步会话状态…') : t('发送'));
  const sendTitle = $derived(touch ? sendLabel : busy ? t('插话发送 ⏎ · 稍后发送 Ctrl+⏎') : (upload != null || verifying) ? sendLabel : t('发送') + ' ⏎');
  const stopLabel = $derived(stopping ? t('正在停止…') : t('停止生成'));
</script>

{#snippet icon()}
  <svg class="csk-ic" viewBox="0 0 20 20" aria-hidden="true">
    <g class="csk-piv"><g class="csk-bob"><g class="csk-tw">
      {#each RAYS as i (i)}<line class="csk-ray r{i}" x1="0" y1="0" x2="0" y2="12" style="--a:{i * 45}deg" />{/each}
      <circle class="csk-hub" r=".875" />
    </g></g></g>
    <line class="csk-bar" x1="5.3" y1="3.6" x2="14.7" y2="3.6" />
    <rect class="csk-sq" x="5.1" y="5.1" width="9.8" height="9.8" rx="2.4" />
  </svg>
{/snippet}
{#snippet faces()}
  <span class="csk-body"><span class="csk-face base">{@render icon()}</span><span class="csk-face ink">{@render icon()}</span></span>
{/snippet}

<div class="csk" bind:this={root} data-m="none" data-touch={touch ? '' : undefined}>
  <span class="csk-slot csk-slot-stop" bind:this={stopSlot}>
    <button type="button" class="csk-key submit" bind:this={stopEl} data-ic="square" aria-label={stopLabel} title={touch || stopping ? stopLabel : stopLabel + ' · Esc'} onclick={() => doStop()}>{@render faces()}</button>
  </span>
  <span class="csk-slot" bind:this={sendSlot}>
    <button type="button" class="csk-key submit" bind:this={sendEl} data-ic="arrow" aria-label={sendLabel} title={sendTitle} aria-haspopup={busy && has && canSteer ? 'menu' : undefined}
      onclick={onSendClick} onpointerdown={onSendDown} onpointerup={onSendUp} onpointerleave={onSendUp} onpointercancel={onSendUp} oncontextmenu={onSendContext}>{@render faces()}</button>
  </span>
  {#if menuOpen}
    <div class="csk-menu" role="menu">
      <button type="button" role="menuitem" onclick={pickQueue}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.3 3.6h9.4M10 16V6.8M5.6 11.2 10 6.8l4.4 4.4" /></svg>
        <span>{t('稍后发送')}</span>{#if !touch}<span class="kbd">Ctrl+⏎</span>{/if}
        <small>{t('这一轮结束后再发，不打断它')}</small>
      </button>
    </div>
  {/if}
</div>
