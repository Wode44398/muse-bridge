<script>
  // 服务浮层里的二级弹层外壳（2026-11-15：模型的高级调用配置、服务的高级设置共用）。
  // 宽屏：盖在服务浮层上的居中卡片（罩层只盖住服务浮层，点罩层 = 关闭）；窄屏：整页从右推入（同设置子页的节拍）。
  // Esc / 系统返回先关它（挂在捕获阶段 + pushBackLayer，压在服务浮层自己那一层上面）；关之前 onclose 可以拦（有改动时问一句）。
  // 内容、底栏由调用方给 snippet；标题区：title（衬线）+ sub（等宽小字，模型 ID 之类）。
  import { onMount, tick } from 'svelte';
  import { pushBackLayer } from '../../lib/nav.js';
  import { activeRequest } from '../../lib/dialogState.svelte.js';
  import { G, svg } from './HsKit.js';
  import { DUR, reduced } from '../../lib/motion.js';
  import { t } from '../../lib/i18n.js';

  // onclose：想关的时候调（Esc、返回、罩层、关闭按钮）；返回 false 或 Promise<false> = 不关。真正卸载由调用方决定
  // onclosed：出场播完，调用方据此卸载
  let { title = '', sub = '', narrow = false, onclose, onclosed, children, foot = null, width = 640 } = $props();

  let panel = $state();
  let closing = $state(false);
  let downOnScrim = false;
  const returnTo = typeof document !== 'undefined' ? document.activeElement : null;

  async function requestClose() {
    if (closing) return;
    const ok = await onclose?.();
    if (ok === false) return;
    closing = true;
  }
  /** 调用方保存成功后直接关（不再走 onclose 的拦截） */
  export function dismiss() { closing = true; }
  // 出场播完再告诉外面卸载
  $effect(() => {
    if (!closing) return;
    const h = setTimeout(() => {
      onclosed?.();
      if (returnTo && returnTo.isConnected) { try { returnTo.focus({ preventScroll: true }); } catch {} }
    }, reduced() ? 0 : DUR.quick + 30);
    return () => clearTimeout(h);
  });

  $effect(() => {
    if (closing) return;
    return pushBackLayer(() => requestClose());
  });
  $effect(() => {
    if (closing) return;
    // 捕获阶段：抢在服务浮层的 Esc（它在冒泡阶段，见 e.defaultPrevented）之前
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || activeRequest()) return;
      e.preventDefault();
      e.stopPropagation();
      requestClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  onMount(() => { tick().then(() => panel?.focus({ preventScroll: true })); });
</script>

<div class="sh" class:narrow class:closing role="presentation"
  onpointerdown={(e) => { downOnScrim = !narrow && e.target === e.currentTarget; }}
  onclick={(e) => { if (downOnScrim && e.target === e.currentTarget) requestClose(); downOnScrim = false; }}>
  <div class="card" bind:this={panel} role="dialog" aria-modal="true" aria-label={title} tabindex="-1" style:--w="{width}px">
    <header class="hd">
      {#if narrow}
        <button type="button" class="hb" aria-label={t('返回')} title={t('返回')} onclick={requestClose}>{@html svg(G.back, 1.8)}</button>
      {/if}
      <div class="tc">
        <h3 class="tt" title={title}>{title}</h3>
        {#if sub}<span class="sb" title={sub}>{sub}</span>{/if}
      </div>
      {#if !narrow}
        <button type="button" class="hb" aria-label={t('关闭')} title={t('关闭')} onclick={requestClose}>{@html svg(G.close)}</button>
      {/if}
    </header>
    <div class="bd">{@render children?.()}</div>
    {#if foot}<footer class="ft">{@render foot()}</footer>{/if}
  </div>
</div>

<style>
  /* 挂在服务浮层的 .panel 里（它是 position:relative、圆角裁切）：absolute 铺满就正好盖住整张服务卡片 */
  .sh { position: absolute; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; padding: 28px; box-sizing: border-box;
    background: color-mix(in srgb, var(--st-backdrop) 85%, transparent); animation: sh-fade var(--mo-quick) var(--ea-fade) both;
    transition: opacity var(--mo-quick) var(--ea-fade); }
  .sh.closing { opacity: 0; pointer-events: none; }
  @keyframes sh-fade { from { opacity: 0; } }
  .card { display: flex; flex-direction: column; width: min(var(--w), 100%); max-height: 100%; overflow: hidden; overflow: clip; outline: none;
    background: var(--st-surface); color: var(--text); border-radius: 18px; box-shadow: var(--st-menu-shadow);
    animation: sh-in var(--mo-base) var(--ea-decel) both; transition: transform var(--mo-quick) var(--ea-accel); }
  .closing .card { transform: translateY(8px) scale(.985); }
  @keyframes sh-in { from { transform: translateY(10px) scale(.985); } }

  .hd { flex: none; display: flex; align-items: center; gap: 10px; min-height: 58px; padding: 10px 10px 10px 22px; box-sizing: border-box; border-bottom: 1px solid var(--st-hair); }
  .tc { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .tt { margin: 0; font-family: var(--font-brand-serif), Georgia, serif; font-size: 18px; font-weight: 500; line-height: 1.25; letter-spacing: -.01em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sb { min-width: 0; font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 12px; color: var(--st-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hb { position: relative; flex: none; display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 9px; background: transparent;
    color: var(--st-text2); cursor: pointer; transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade); }
  .hb :global(svg) { width: 18px; height: 18px; }
  @media (hover: hover) { .hb:hover { background: var(--st-hover); color: var(--text); } }
  .hb:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .bd { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 6px 22px 22px; }
  .ft { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 16px 14px 22px; border-top: 1px solid var(--st-hair); }

  /* 窄屏：整页从右推入 */
  .sh.narrow { padding: 0; align-items: stretch; background: transparent; animation: none; }
  .narrow .card { width: 100%; max-height: none; border-radius: 0; box-shadow: none; background: var(--pm-bg); padding-top: var(--sat, 0px); box-sizing: border-box;
    animation: sh-push var(--mo-page) var(--ea-decel) both; transition: transform var(--mo-quick) var(--ea-accel), opacity var(--mo-quick) var(--ea-fade); }
  .narrow.closing { opacity: 1; }
  .narrow.closing .card { transform: translateX(28%); opacity: 0; }
  @keyframes sh-push { from { transform: translateX(28%); opacity: 0; } }
  .narrow .hd { padding: 6px 12px 6px 6px; border-bottom: 0; min-height: 56px; }
  .narrow .tt { font-size: 17px; }
  .narrow .bd { padding: 4px 16px 24px; }
  .narrow .ft { padding: 10px 16px calc(12px + var(--sab, 0px)); background: var(--pm-bg); }
  @media (pointer: coarse) { .hb::after { content: ''; position: absolute; inset: -5px; } }
  @media (prefers-reduced-motion: reduce) {
    .sh, .card, .narrow .card { animation-name: sh-fade; }
    .closing .card, .narrow.closing .card { transform: none; }
  }
</style>
