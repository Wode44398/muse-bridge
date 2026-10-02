<script>
  // 统一沉浸式查看器外壳。全局常驻（App 末尾挂载），preview.open 时全屏接管。
  // 据当前条目 kind 路由到已接入的图片、视频、音频和文档查看器。
  // 画廊翻页（子查看器手势 + 桌面箭头 + 键盘）、下滑关闭联动调暗背景、顶栏、滚动锁、安全区。
  import { preview, closePreview, previewNext, previewPrev } from '../../lib/preview.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import ImageView from './ImageView.svelte';
  import VideoPlayer from './VideoPlayer.svelte';
  import AudioPlayer from './AudioPlayer.svelte';
  import DocViewer from './DocViewer.svelte';
  import PdfView from './PdfView.svelte';
  import OfficeView from './OfficeView.svelte';
  import HtmlView from './HtmlView.svelte';
  import { t } from '../../lib/i18n.js';

  // host：本实例服务的宿主——'app'（App 末尾的全屏实例）| 'dock'（Claude 工作台侧栏内嵌
  // 实例，fixed 根被宿主的 transform 圈定在侧栏内）。只认 preview.host 相符的打开请求；
  // 副作用（键盘/滚动锁/预载）同样只在本实例接管时生效，避免双实例互踩。
  const { host = 'app' } = $props();
  const active = $derived(preview.open && (preview.host || 'app') === host);

  const cur = $derived(preview.items[preview.index] || null);
  const many = $derived(preview.items.length > 1);
  const canPrev = $derived(preview.index > 0);
  const canNext = $derived(preview.index < preview.items.length - 1);
  const isDoc = $derived(!!cur && !['image', 'video', 'audio'].includes(cur.kind));   // 文档类(md/text/pdf/office)走 DocViewer 自带头部

  let dragP = $state(0);   // 下滑关闭进度 0..1（子查看器上报）→ 调暗背景 + 内容微缩
  function onDragProgress(p) { dragP = p; }
  function go(dir) { dragP = 0; dir > 0 ? previewNext() : previewPrev(); }
  function close() { dragP = 0; closePreview(); }

  // 切条目时复位下滑进度 + 关掉 ⋮ 菜单
  $effect(() => { preview.index; dragP = 0; mvMenu = false; });

  // —— 右上 ⋮：视频交给播放器的设置弹层（倍速/画质/下载），其余出自己的小菜单（下载）——
  let playerApi = $state(null);   // VideoPlayer bind:api
  let mvMenu = $state(false);
  function onMore() {
    if (cur?.kind === 'video' && playerApi?.openMenu) playerApi.openMenu();
    else mvMenu = !mvMenu;
  }
  $effect(() => { if (!mvMenu) return; return pushBackLayer(() => (mvMenu = false)); });   // 系统返回先关菜单

  // —— 智能预载：相册/漫画侧滑连续观看时，滑到第 N 张就静默把邻近几张提前拉好 ——
  // 窗口=向后 3 张 + 向前 1 张（按接近度排序），只预载图片条目的 previewUrl（1280 轻量档，
  // 原图留给缩放升级，预载原图会在漫画场景烧掉海量流量）。一次只挂 1 个在途请求（不与当前
  // 大图抢带宽），首拉延迟 250ms 让当前图先起跑；载完 decode() 预解码，侧滑进来零加载零解码
  // 卡顿。失败静默记过不重试（可见 <img> 自有 LAN 自愈/错误态兜底）。
  const PRE_AHEAD = 3, PRE_BEHIND = 1, PRE_KEEP = 6;
  const preDone = new Set();   // 本次会话内已预载（或已失败）的 URL
  let preQueue = [];           // 待载 URL（接近度序）
  let preBusy = false;
  let preKeep = [];            // 持有最近几个 Image 引用，防解码位图被过早回收
  $effect(() => {
    if (!active) { preDone.clear(); preKeep = []; preQueue = []; return; }
    const i = preview.index, items = preview.items;
    if (items.length < 2) return;
    const order = [];
    for (let d = 1; d <= PRE_AHEAD; d++) order.push(i + d);
    for (let d = 1; d <= PRE_BEHIND; d++) order.push(i - d);
    preQueue = order
      .filter((j) => j >= 0 && j < items.length)
      .map((j) => items[j])
      .filter((it) => it.kind === 'image' && !it.dataUrl)
      .map((it) => it.previewUrl || it.url)
      .filter((u) => u && !preDone.has(u));
    if (preQueue.length) setTimeout(pump, 250);
  });
  function pump() {
    if (preBusy || !active || !preQueue.length) return;
    const u = preQueue.shift();
    if (preDone.has(u)) { pump(); return; }
    preBusy = true;
    const im = new Image();
    const done = () => { preBusy = false; pump(); };
    im.onload = () => {
      preDone.add(u);
      preKeep.push(im);
      if (preKeep.length > PRE_KEEP) preKeep.shift();
      // 预解码尽力而为、不串行在队列里——后台页 decode() 会被浏览器无限期推迟（同 RAF），
      // 队列等它就卡死；字节先拉回来才是重点，解码真机前台瞬时完成。
      im.decode?.().catch(() => {});
      done();
    };
    im.onerror = () => { preDone.add(u); done(); };
    im.src = u;
  }

  // 键盘（桌面/外接键盘）。挂在 window 冒泡阶段，是最后一站：里面的组件先处理过的键会带着
  // defaultPrevented 冒上来（md 编辑器收补全浮层/收选区、表格格子退出、编辑器里的方向键移光标……），
  // 不再二次解释成关闭/翻页；组字中的 Esc 是取消输入法候选，也不算
  function onKey(e) {
    if (!active || e.defaultPrevented || e.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowLeft' && canPrev) { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight' && canNext) { e.preventDefault(); go(1); }
  }

  // 打开时锁住背景滚动
  $effect(() => {
    if (!active) return;
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { html.style.overflow = prev; };
  });
</script>

<svelte:window onkeydown={onKey} />

{#if active && cur}
  <div class="mv-root">
    <div class="mv-backdrop" style:opacity={1 - dragP * 0.85}></div>

    <!-- 内容区（据 kind 路由）。下滑时整体微缩 + 圆角，营造"卡片被拎起"的手感 -->
    <div class="mv-stage" style:transform="scale({1 - dragP * 0.06})" style:border-radius={dragP > 0.01 ? '18px' : '0'}>
      {#key cur.key}
        <div class="mv-page">
          {#if cur.kind === 'image'}
            <ImageView item={cur} {canPrev} {canNext} onClose={close} onPrev={() => go(-1)} onNext={() => go(1)} {onDragProgress} />
          {:else if cur.kind === 'video'}
            <VideoPlayer item={cur} onClose={close} {onDragProgress} bind:api={playerApi} />
          {:else if cur.kind === 'audio'}
            <div class="mv-audio"><div class="mv-audio-box"><AudioPlayer item={cur} dark /></div></div>
          {:else if cur.kind === 'pdf'}
            <PdfView item={cur} onClose={close} />
          {:else if cur.kind === 'office'}
            <OfficeView item={cur} onClose={close} />
          {:else if cur.kind === 'html'}
            <HtmlView item={cur} onClose={close} />
          {:else}
            <DocViewer item={cur} onClose={close} />
          {/if}
        </div>
      {/key}
    </div>

    <!-- 顶栏（渐变保证亮图上可读）：返回 + 文件名 + 计数 + 下载。文档类用 DocViewer 自带头部，这里不出 -->
    {#if !isDoc}
    <div class="mv-top" style:opacity={1 - dragP}>
      <button class="mv-btn" aria-label={t('关闭')} onclick={close}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
      <span class="mv-title">{cur.name}</span>
      {#if many}<span class="mv-count">{preview.index + 1} / {preview.items.length}</span>{/if}
      {#if cur.kind === 'video' || cur.downloadHref}
        <button class="mv-btn" aria-label={t('更多')} onclick={onMore}>
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5.4" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="18.6" r="1.9"/></svg>
        </button>
      {/if}
    </div>
    {/if}

    <!-- 非视频的 ⋮ 小菜单（下载）；视频的菜单由 VideoPlayer 底部弹层承担 -->
    {#if mvMenu && cur.downloadHref}
      <div class="mv-menu-back" role="presentation" onclick={() => (mvMenu = false)}>
        <div class="mv-menu" role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()}>
          <a class="mv-mrow" href={cur.downloadHref} download={cur.name} onclick={() => { mvMenu = false; }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M12 16l-5-5M12 16l5-5"/><path d="M5 20h14"/></svg>
            <span>{t('下载')}</span>
          </a>
        </div>
      </div>
    {/if}

    <!-- 桌面/平板：左右箭头（手机靠滑动） -->
    {#if many && !isDoc}
      {#if canPrev}<button class="mv-arrow left" aria-label={t('上一个')} onclick={() => go(-1)} style:opacity={1 - dragP}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>{/if}
      {#if canNext}<button class="mv-arrow right" aria-label={t('下一个')} onclick={() => go(1)} style:opacity={1 - dragP}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>{/if}
    {/if}
  </div>
{/if}

<style>
  /* 进出用纯 CSS 动画（不依赖 RAF，避免切后台时 JS 过渡卡死浮层不卸载）：进场淡入、关闭瞬时卸载 */
  .mv-root { position: fixed; inset: 0; z-index: 300; animation: mvIn var(--mo-base) var(--ea-fade); }
  @keyframes mvIn { from { opacity: 0; } to { opacity: 1; } }
  .mv-page { animation: mvPageIn var(--mo-quick) var(--ea-decel); }
  @keyframes mvPageIn { from { opacity: 0; } to { opacity: 1; } }
  .mv-backdrop { position: absolute; inset: 0; background: #0a0a0c; -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px); }
  .mv-stage { position: absolute; inset: 0; overflow: hidden; transform-origin: center; will-change: transform; }
  .mv-page { position: absolute; inset: 0; }
  .mv-audio { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 0 28px; }
  .mv-audio-box { width: 100%; max-width: 560px; }

  /* 顶栏：从顶部黑渐变压底，白图标，安全区内 */
  .mv-top { position: absolute; top: 0; left: 0; right: 0; z-index: 5; display: flex; align-items: center; gap: 6px;
    padding: max(8px, var(--sat)) 10px 24px;
    background: linear-gradient(to bottom, rgba(0,0,0,.5), rgba(0,0,0,0)); pointer-events: none; }
  .mv-top > * { pointer-events: auto; }
  .mv-btn { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; flex: none; }
  .mv-btn svg { width: 22px; height: 22px; }
  .mv-btn:active { background: rgba(255,255,255,.16); }
  .mv-title { flex: 1; min-width: 0; color: #fff; font-size: 15px; font-weight: 500; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-shadow: 0 1px 3px rgba(0,0,0,.4); }
  .mv-count { color: rgba(255,255,255,.82); font-size: 13px; font-variant-numeric: tabular-nums; flex: none; padding: 0 4px; text-shadow: 0 1px 3px rgba(0,0,0,.4); }

  /* ⋮ 小菜单（非视频）：右上锚定下拉 */
  .mv-menu-back { position: absolute; inset: 0; z-index: 7; }
  .mv-menu { position: absolute; top: max(52px, calc(var(--sat) + 44px)); right: 10px; min-width: 168px; border-radius: 14px; overflow: hidden;
    background: rgba(28,28,30,.96); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
    padding: 5px 0; animation: mvMenuIn var(--mo-quick) var(--ea-decel); box-shadow: 0 8px 28px rgba(0,0,0,.45); }
  @keyframes mvMenuIn { from { opacity: 0; transform: translateY(-6px) scale(.97); } to { opacity: 1; transform: none; } }
  .mv-mrow { display: flex; align-items: center; gap: 12px; padding: 11px 16px; color: #fff; font-size: 14.5px; }
  .mv-mrow:active { background: rgba(255,255,255,.08); }
  .mv-mrow svg { width: 19px; height: 19px; flex: none; }

  .mv-arrow { position: absolute; top: 50%; transform: translateY(-50%); z-index: 5; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; background: rgba(0,0,0,.28); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
  .mv-arrow svg { width: 24px; height: 24px; }
  .mv-arrow.left { left: 10px; } .mv-arrow.right { right: 10px; }
  .mv-arrow:active { background: rgba(0,0,0,.45); }
  /* 触屏隐藏箭头（靠滑动），仅细指针(鼠标)显示 */
  @media (pointer: coarse) { .mv-arrow { display: none; } }

</style>
