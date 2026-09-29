<script>
  // 发送图片的全屏预览灯箱——复刻 claude.ai：背景压暗(brightness) + 居中「图片＋文件名＋下载」一组 +
  // 多图左右切换。点图片周围留白 / Esc 关闭；下标由父组件受控（Thread 持有 lb.index）。
  import { pushBackLayer } from '../lib/nav.js';
  import { swipeDismiss } from '../lib/motion.js';
  import { t } from '../lib/i18n.js';
  let { items = [], index = 0, onClose, onIndex } = $props();

  // 下滑关闭（相册类查看器的通用手势，此前只能点关闭钮）：位移 1:1 跟手，罩层随
  // 进度变淡、图片微缩——松手按速度投影决定关掉还是弹回，弹簧续写松手速度。
  let dragY = $state(0);
  const dragP = $derived(Math.min(1, dragY / 320));
  const dragClose = (node) => swipeDismiss(node, {
    axis: 'y', dir: 1, edge: 0, threshold: 0.28,
    size: () => 320,
    guard: (e) => !e.target?.closest?.('button, a'),   // 别把关闭钮/翻页钮/下载按成拖拽
    base: () => dragY, cur: () => dragY,
    onMove: (y) => (dragY = y),
    onSettle: (go) => { if (!go) dragY = 0; },
    onDismiss: () => onClose?.(),
  });

  // 系统返回先关灯箱（组件仅在 open 时挂载，卸载即自动出栈）。
  $effect(() => pushBackLayer(() => onClose?.()));

  const cur = $derived(items[index] || null);
  const many = $derived(items.length > 1);

  function prev(e) { e?.stopPropagation(); if (index > 0) onIndex?.(index - 1); }
  function next(e) { e?.stopPropagation(); if (index < items.length - 1) onIndex?.(index + 1); }
  function close() { onClose?.(); }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'ArrowRight') next();
  }

  // 打开时锁背景滚动（组件仅在 open 时挂载，卸载即还原）。
  $effect(() => {
    const html = document.documentElement;
    const prevOv = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { html.style.overflow = prevOv; };
  });
</script>

<svelte:window onkeydown={onKey} />

{#if cur}
  <div class="lb" use:dragClose style:--lb-p={dragP}>
    <!-- 背景：点击关闭（在对话框之下，点到图片周围留白即触发） -->
    <button class="lb-scrim" aria-label={t('关闭')} onclick={close}></button>

    <button class="lb-close" aria-label={t('关闭')} onclick={close}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>

    {#if many && index > 0}
      <button class="lb-nav left" aria-label={t('上一张')} onclick={prev}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
    {/if}
    {#if many && index < items.length - 1}
      <button class="lb-nav right" aria-label={t('下一张')} onclick={next}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>
    {/if}

    <div class="lb-dialog" style:transform={dragY > 0 ? `translateY(${dragY}px) scale(${1 - dragP * 0.08})` : ''}>
      {#key cur.url}
        <img class="lb-img" src={cur.url} alt={cur.name} />
      {/key}
      <div class="lb-cap">
        <span class="lb-name">{cur.name}{#if many}<span class="lb-count"> · {index + 1}/{items.length}</span>{/if}</span>
        {#if cur.url}
          <a class="lb-dl" href={cur.url} download={cur.name} aria-label={t('下载')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>
          </a>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* 铺满屏，内容居中；背景 50% 黑 + brightness(.75) 压暗底层页面（复刻 claude.ai：底层对话透出压暗）。
     纯 CSS 淡入，不依赖 RAF，切后台也稳。brightness 不支持时退化为 50% 黑罩，仍可用。 */
  /* 罩层随下滑进度(--lb-p)变淡：手指往下带，底层内容同步露出来，是"拖走"而不是"点掉" */
  .lb { position: fixed; inset: 0; z-index: 320; display: grid; place-items: center;
    padding: max(52px, calc(var(--sat) + 44px)) 16px max(20px, var(--sab)); animation: lbIn var(--mo-base) var(--ea-fade);
    background: rgba(0,0,0,calc(.5 * (1 - var(--lb-p, 0))));
    /* brightness 压暗保持静态：它是 backdrop-filter，逐帧改会在拖动时把整屏重新滤镜化
       （手机上直接掉帧）。跟手的暗度变化交给上面那层黑罩的 alpha 就够了。 */
    -webkit-backdrop-filter: brightness(.75); backdrop-filter: brightness(.75); }
  @keyframes lbIn { from { opacity: 0; } to { opacity: 1; } }
  /* 背景按钮：铺满、透明、置于对话框之下——点到图片周围留白即关闭 */
  .lb-scrim { position: absolute; inset: 0; z-index: 0; background: transparent; cursor: default; }

  /* 对话框：图片＋文件名＋下载 竖排居中（宽度封顶 640，同 claude.ai max-w-[40rem]） */
  .lb-dialog { position: relative; z-index: 1; max-width: 640px; width: 100%; max-height: 100%;
    display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .lb-img { min-height: 0; max-width: 100%; max-height: calc(100% - 56px); object-fit: contain; border-radius: 8px;
    box-shadow: 0 10px 44px rgba(0,0,0,.5); animation: lbImg var(--mo-base) var(--ea-decel); }
  @keyframes lbImg { from { opacity: 0; transform: scale(.985); } to { opacity: 1; transform: none; } }

  .lb-cap { display: flex; flex-direction: column; align-items: center; gap: 8px; flex: none; color: #fff; }
  .lb-name { font-size: 13px; max-width: 82vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 3px rgba(0,0,0,.5); }
  .lb-count { color: rgba(255,255,255,.6); }
  .lb-dl { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; }
  .lb-dl svg { width: 21px; height: 21px; }
  .lb-dl:hover, .lb-dl:active { background: rgba(255,255,255,.15); }

  .lb-close { position: absolute; z-index: 2; top: max(12px, var(--sat)); right: 12px; width: 42px; height: 42px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; color: #fff; }
  .lb-close svg { width: 22px; height: 22px; }
  .lb-close:hover, .lb-close:active { background: rgba(255,255,255,.15); }

  .lb-nav { position: absolute; z-index: 2; top: 50%; transform: translateY(-50%); width: 44px; height: 44px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; color: #fff; background: rgba(255,255,255,.12); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
  .lb-nav svg { width: 24px; height: 24px; }
  .lb-nav.left { left: 12px; } .lb-nav.right { right: 12px; }
  .lb-nav:hover, .lb-nav:active { background: rgba(255,255,255,.22); }
</style>
