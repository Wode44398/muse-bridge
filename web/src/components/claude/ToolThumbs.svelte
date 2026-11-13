<script>
  // 状态行缩略图条（官方 4.4212 c80ec48f8 的 _i / hi / pi，size="sm"）：
  //   · 一排 24px 高的小图，最多 3 张，多出来的在前面写「+N」；窄屏只留最后一张、写 +N-1；
  //   · 运行中始终跟随最新几张（列表本身按时间追加，取尾巴即可）；
  //   · 悬停 150ms 弹预览卡（大图 + 那一步的标题 + 「n / 共 m」），触屏没有悬停；
  //   · 点开全屏灯箱，在本组所有图片之间翻页。
  import ImgLightbox from '../ImgLightbox.svelte';
  import { mediaFallbackUrl } from '../../lib/server.js';
  import { t } from '../../lib/i18n.js';

  let { shots = [] } = $props();
  const MAX = 3;   // 官方 Qr = 3（sm 档）

  const shown = $derived(shots.slice(-MAX));
  const hidden = $derived(Math.max(0, shots.length - shown.length));
  const offset = $derived(shots.length - shown.length);

  let lb = $state({ open: false, index: 0 });
  let hover = $state(-1);   // 悬停中的图在 shots 里的下标
  let timer = 0;
  function enter(i) { clearTimeout(timer); timer = setTimeout(() => (hover = i), 150); }
  function leave() { clearTimeout(timer); hover = -1; }
  function open(e, i) { e.stopPropagation(); leave(); lb = { open: true, index: i }; }
  $effect(() => () => clearTimeout(timer));
  // 灯箱挂到 body：缩略图条在消息流里，祖先有 transform / contain（屏幕外跳过渲染），fixed 定位会被困住
  function portal(node) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  // 加载失败自愈（同 ChatMediaImage）：手机在家走局域网直连时 <img> 会整排裂图——fetch 失败会自动降回隧道，
  // <img> 的地址却是渲染时算死的。① 局域网地址 → 隧道 ② 已是隧道就隔 1.5s 带 &r=1 再试一次（瞬时抖动）。
  function onImgError(e) {
    const img = e.currentTarget;
    const next = mediaFallbackUrl(img.src);
    if (next !== img.src) { img.src = next; return; }
    if (img.dataset.retried) return;
    img.dataset.retried = '1';
    setTimeout(() => { if (img.isConnected) img.src = next + '&r=1'; }, 1500);
  }
  const label = (i) => (shots.length === 1 ? t('截图') : t('截图 {n}/{total}', { n: i + 1, total: shots.length }));
</script>

{#if shots.length}
  <span class="thumbs" aria-label={t('{n} 张图片', { n: shots.length })}>
    {#if hidden > 0}<span class="more wide" aria-hidden="true">+{hidden}</span>{/if}
    {#if shots.length > 1}<span class="more narrow" aria-hidden="true">+{shots.length - 1}</span>{/if}
    {#each shown as s, j (s.key)}
      {@const i = offset + j}
      <button type="button" class="th" class:last={j === shown.length - 1} aria-label={label(i)}
        onpointerenter={(e) => { if (e.pointerType === 'mouse') enter(i); }} onpointerleave={leave} onclick={(e) => open(e, i)}>
        <img src={s.thumb} alt="" loading="lazy" decoding="async" draggable="false" onerror={onImgError} />
        {#if hover === i}
          <span class="pop" role="tooltip">
            <img src={s.thumb} alt="" onerror={onImgError} />
            <span class="cap"><bdi class="nm">{s.caption}</bdi>{#if shots.length > 1}<span class="ct">{t('{n} / {total}', { n: i + 1, total: shots.length })}</span>{/if}</span>
          </span>
        {/if}
      </button>
    {/each}
  </span>
{/if}
{#if lb.open}<div use:portal><ImgLightbox items={shots} index={lb.index} onClose={() => (lb = { open: false, index: 0 })} onIndex={(n) => (lb.index = n)} /></div>{/if}

<style>
  .thumbs { display: inline-flex; align-items: center; gap: 4px; flex: none; }
  .more { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; margin-inline-end: 2px; }
  .narrow { display: none; }
  .th {
    position: relative; appearance: none; border: 0; padding: 0; margin: 0; background: var(--hover);
    height: 24px; width: 32px; border-radius: 5px; cursor: zoom-in; flex: none;
    box-shadow: 0 0 0 1px var(--divider); -webkit-tap-highlight-color: transparent;
  }
  .th > img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
  .th:focus-visible { outline: 2px solid var(--serif); outline-offset: 1px; }
  /* 悬停预览卡：贴着缩略图上方、右对齐（官方 side=top align=end），宽 ≤ 20rem */
  .pop {
    position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 30; width: min(20rem, calc(100vw - 2rem));
    display: flex; flex-direction: column; overflow: hidden; border-radius: 10px; cursor: default;
    background: var(--bg-elev, var(--bg)); box-shadow: 0 0 0 1px var(--divider), 0 8px 28px rgba(0, 0, 0, .28);
    animation: pop-in 140ms ease-out;
  }
  .pop > img { display: block; width: 100%; max-height: 14rem; object-fit: contain; background: var(--hover); }
  .cap { display: flex; align-items: baseline; gap: 8px; padding: 8px 12px; font-size: 12px; text-align: start; }
  .nm { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text); }
  .ct { flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
  @keyframes pop-in { from { opacity: 0; transform: translateY(4px); } }
  @media (prefers-reduced-motion: reduce) { .pop { animation: none; } }
  /* 窄屏（官方 max-sm）：只留最后一张，计数改成 +N-1 */
  @media (max-width: 639px) {
    .wide { display: none; }
    .narrow { display: inline; }
    .th:not(.last) { display: none; }
  }
</style>
