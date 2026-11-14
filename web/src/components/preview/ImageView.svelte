<script module>
  // 主图地址（窗格与画廊预载器共用一份口径：预载器拉的必须就是窗格要挂的那个 URL，才能命中同文档的图片资源复用）：
  // 本地已读好的 dataURL > svg / gif 原图（矢量、动画）> 中档预览图 > 原图
  export function firstSrc(it) {
    if (!it) return '';
    if (it.dataUrl) return it.dataUrl;
    if (it.ext === 'svg' || it.ext === 'gif') return it.url || it.previewUrl || '';
    return it.previewUrl || it.url || '';
  }
  // 预览档长边达到这个数就当「原图可能更大」：服务端衍生图不放大（withoutEnlargement），比它短的预览档就是原图本身
  const TIER_MIN = 1200;
  const SAFE_PX = 4096 * 4096;   // max 档像素上限（同原生 LocalMedia.SAFE_PIXELS）：比它小的 max 档就是原图字节直出
  const TILE = 1024;             // 原图区域块：每块输出边长（设备像素）
  const TILE_CAP = 24;           // 一屏最多挂几块（离视口中心近的优先）
</script>

<script>
  // 画廊里的一格（窗格）：只管把一张图按「适应框」摆好、渐进加载（缩略图 → 中档预览 → 原图）并把几何报给画廊；
  // 缩放 / 平移 / 下拉 / 旋转这些视图状态全由 ImageGallery 驱动、经 props 传进来，窗格自己不接手势。
  //   DOM：.iv-pane > .iv-box（静态适应框 + 视图 transform）> .iv-rot（旋转）> img.iv-blur（缩略图）+ img.iv-img（主图）+ img.iv-hi（原图叠层）
  //   · 主图 onload 后等 decode() 完才上屏（直接不透明，不做淡入）；原图叠层同理，解码完才盖上去，不出半张图
  //   · will-change 只在 live（手势 / 动画进行中）时开；停稳后摘掉，Chrome 按最终倍率重新栅格化——svg 与放大后的位图才清晰
  //   · 尺寸来源：条目自带 width/height（按显示方向）> 原图头部（imageMeta）> 原图 > 主图 > 缩略图（只取比例）
  //   · 「原图加载」开（item.fullRes）：主图 / 预载 / 放大都是真原图；只有原图真解不了（onerror / naturalWidth 0）
  //     才退到 max 档（再不行 preview 档）并提示一句，退了就不再拿原图升级
  //   · 关：主图 = preview 档；放大先升 max 档（item.maxUrl，≤16.7MP）；再放大超过 max 档的分辨率，
  //     按可见区拉原图区域块（item.tileBase + &region=x,y,w,h&w=），挂在 .iv-rot 里随视图走，缩回去就放掉
  //   · 视频条目在滑轨里是海报 + 播放钮占位（停稳后由画廊换成 VideoPlayer）；别的类型给类型图标占位
  import { untrack } from 'svelte';
  import { mediaFallbackUrl } from '../../lib/server.js';
  import { animate, DUR, EASE, reduced } from '../../lib/motion.js';
  import { t } from '../../lib/i18n.js';
  import ViewerState from './kit/ViewerState.svelte';
  import VIcon from './kit/VIcon.svelte';
  import { useViewer } from './kit/context.js';

  let {
    item, W = 0, H = 0,
    current = false,    // 当前页：只有当前页升级原图、出转圈、上报几何
    load = false,       // 主图可以开拉了（当前页恒真；邻居等预载器拉完，命中内存里的同一份资源）
    view = null,        // { s, x, y }：视图变换（相对适应框中心；s=1 即适应）
    rot = 0,            // 旋转角（度，90 的倍数，累加不取模——CSS 才会走近的那一边转）
    dis = null,         // { x, y, k }：下拉关闭的跟手位移与缩小
    live = false,       // 手势 / 动画进行中：开 will-change
    fine = false,       // 电脑端：小于窗口的图按 100% 居中（触屏一律 contain）
    veil = false,       // FLIP 打开前先藏起来（等尺寸）
    meta = null,        // 原图头部信息（imageMeta：精确尺寸 / 动图）
    peek = true,        // 缩略图可以开拉了（邻居等当前页出图后再拉，不和当前页抢连接）
    onmeta, onready, onplay,
  } = $props();

  const viewer = useViewer();
  const isImg = $derived(item.kind === 'image');
  const svg = $derived(item.ext === 'svg');
  const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const isFullSrc = (it, s) => !!it.dataUrl || !it.previewUrl || it.previewUrl === it.url || s === it.url;

  // —— 主图 ——
  let mainSrc = $state(untrack(() => firstSrc(item)));
  let mainFull = $state(untrack(() => isFullSrc(item, firstSrc(item))));   // 挂的就是原图：尺寸可信、不必再升级
  let mainNat = $state.raw(null), mainOk = $state(false), errored = $state(false);
  const tried = new Set();
  let started = $state(untrack(() => load));
  $effect(() => { if (load) untrack(() => { if (!started) started = true; }); });

  // 原图解不了退到的高清档（max 档 / preview 档）：退过就不再拿原图升级、也不分块，上屏后提示一句
  let fellBack = $state(false), fbNoted = false;
  function onMainLoad(e) {
    const im = e.currentTarget, s = mainSrc;
    if (!(im.naturalWidth > 0) && !svg) { onMainError(); return; }   // 解不了的大图有时照样 load，只是没有尺寸
    mainNat = im.naturalWidth > 0 ? { w: im.naturalWidth, h: im.naturalHeight } : null;
    const done = () => { if (s === mainSrc) { mainOk = true; errored = false; } };
    if (typeof im.decode === 'function') im.decode().then(done, done); else done();
  }
  function onMainError() {
    // LAN→隧道自愈（在家走 LAN 时媒体图常因明文 / 混合内容不通，fetch 会自动回退但 <img> 不会）→ 预览档挂了换原图
    // → 原图解不了才依次退 max 档 / preview 档（「原图加载」开着也只在这一步退，不静默降档）
    const fb = mediaFallbackUrl(mainSrc);
    if (fb && fb !== mainSrc && !tried.has(fb)) { tried.add(mainSrc); tried.add(fb); mainSrc = fb; return; }
    tried.add(mainSrc);
    if (!mainFull && !fellBack && item.url && !tried.has(item.url)) { mainSrc = item.url; mainFull = true; return; }
    if (mainFull || fellBack) {
      // 衍生档已经出不了（preview 档挂过）就别再试 max 档：同一条解码链，只会再挂一次
      for (const u of [item.lowUrl && tried.has(item.lowUrl) ? null : item.maxUrl, item.lowUrl, item.previewUrl]) {
        if (u && u !== item.url && !tried.has(u)) { mainSrc = u; mainFull = false; fellBack = true; mainOk = false; return; }
      }
    }
    errored = true;
    if (current) probeStatus(mainSrc);
  }
  $effect(() => {
    if (current && fellBack && mainOk && !fbNoted) untrack(() => { fbNoted = true; viewer.toast(t('原图过大，已显示高清预览')); });
  });
  // 出错后探一次状态码（只探同源，HEAD 不拉正文）：404 说成「文件不存在或已被移动」，和其它查看器同一句；<img> 自己拿不到状态码
  let errStatus = $state(0);
  function probeStatus(src) {
    errStatus = 0;
    let u = null;
    try { u = new URL(src, location.href); } catch {}
    if (!u || u.origin !== location.origin) return;
    fetch(u.href, { method: 'HEAD', cache: 'no-store' }).then((r) => { if (!r.ok && errored && src === mainSrc) errStatus = r.status; }, () => {});
  }
  function retry() {
    tried.clear(); errored = false; mainOk = false; errStatus = 0; fellBack = false; fbNoted = false;
    const s = firstSrc(item);
    mainSrc = '';
    requestAnimationFrame(() => { mainSrc = s; mainFull = isFullSrc(item, s); });
  }
  // 当前页落定（出图或失败）告诉画廊：预载器等它才往两边拉；失败也算落定，这张照样能滑走
  $effect(() => { if (current && (!isImg || mainOk || errored)) onready?.(item.key); });

  // —— 缩略图（立即加载，充当模糊底；不加 CSS 模糊：320 的图放大本身就够柔，省一层滤镜）——
  let thumbNat = $state.raw(null), thumbOk = $state(false), thumbErr = $state(false);
  let thumbOn = $state(untrack(() => peek));
  $effect(() => { if (peek) untrack(() => { if (!thumbOn) thumbOn = true; }); });
  function onThumbLoad(e) {
    const im = e.currentTarget;
    if (im.naturalWidth > 0) thumbNat = { w: im.naturalWidth, h: im.naturalHeight };
    thumbOk = true;
  }

  // —— 高清叠层（当前页：放大到预览档不够用、或认出是动图时）：有 max 档先上 max 档，动图 / 没有 max 档直接原图 ——
  let hiOn = false;
  let hiSrc = $state(''), hiNat = $state.raw(null), hiOk = $state(false), hiMax = $state(false);
  function onHiLoad(e) {
    const im = e.currentTarget, s = hiSrc;
    const nat = im.naturalWidth > 0 ? { w: im.naturalWidth, h: im.naturalHeight } : null;
    const done = () => { if (s === hiSrc) { hiNat = nat; hiOk = true; } };
    if (typeof im.decode === 'function') im.decode().then(done, done); else done();
  }
  function onHiError() {
    const fb = mediaFallbackUrl(hiSrc);
    hiSrc = fb && fb !== hiSrc ? fb : '';   // max 档 / 原图不通就留在预览档
  }

  // —— 几何 ——
  const dims = $derived.by(() => {
    if (item.width > 0 && item.height > 0) return { w: +item.width, h: +item.height, exact: true };
    if (meta && meta.w > 0 && meta.h > 0) return { w: meta.w, h: meta.h, exact: true };
    if (hiNat) return { ...hiNat, exact: !hiMax || hiNat.w * hiNat.h < SAFE_PX * 0.97 };   // 顶到上限的 max 档是缩过的
    if (mainNat) return { ...mainNat, exact: mainFull || Math.max(mainNat.w, mainNat.h) < TIER_MIN };
    if (thumbNat) return { ...thumbNat, exact: false, ratio: true };
    if (mainOk && svg) return { w: 1, h: 1, exact: false, ratio: true };   // 没有固有尺寸的 svg：按方的放
    return null;
  });
  const turn = $derived(Math.abs(rot % 180) === 90);
  const geo = $derived.by(() => {
    if (!isImg || !dims || !(W > 0) || !(H > 0)) return null;
    const ew = turn ? dims.h : dims.w, eh = turn ? dims.w : dims.h;
    let k = Math.min(W / ew, H / eh);
    if (fine && dims.exact && !svg) k = Math.min(k, 1);   // 电脑：小于窗口的按 100% 居中（矢量图照样铺满）
    const bw = ew * k, bh = eh * k;
    const f = dims.ratio ? 0 : bw / ew;                    // 每个原图像素占几个 CSS 像素（只知比例时未知）
    const maxS = svg ? 16 : f > 0 ? Math.max(3, 4 / f) : 8; // 至少放到原图像素的 4 倍
    return { bw, bh, f, maxS, exact: !!dims.exact, nw: dims.w, nh: dims.h, turn };
  });
  $effect(() => { if (current && geo) onmeta?.(geo); });

  // 升级原图：动图（预览档只有首帧）一认出来就换；否则放大到预览档的像素不够用了才换（适应时差得多也换：HiDPI 屏上 1280 档偏软）
  const wantHi = $derived.by(() => {
    if (!current || !isImg || errored || !item.url || mainFull || fellBack || item.dataUrl) return false;
    if (meta?.anim) return true;
    if (!geo || !mainNat) return false;
    const s = view?.s || 1;
    return s * Math.max(geo.bw, geo.bh) * dpr > Math.max(mainNat.w, mainNat.h) * (s > 1.05 ? 1.1 : 1.6);
  });
  $effect(() => {
    if (wantHi && !hiOn) {
      hiOn = true;
      untrack(() => { const m = !meta?.anim && item.maxUrl ? item.maxUrl : ''; hiMax = !!m; hiSrc = m || item.url; });   // max 档只出首帧：动图要原图
    }
  });
  // 头部信息晚到才认出是动图（HiDPI 屏适应时就要升级、等不到 imageMeta）：已挂的 max 档换成原图（max 档超上限时只有首帧）
  $effect(() => { if (hiMax && meta?.anim) untrack(() => { hiMax = false; hiSrc = item.url; }); });

  // —— 原图区域块：max 档也不够用了（「原图加载」关着、超大原图放得很大）才按可见区拉，缩回去 / 翻走就放掉 ——
  // 坐标一律是显示方向（EXIF 转正后）的原图像素；块挂在 .iv-rot 里（按 geo.f 摆），跟着视图变换 / 旋转一起走
  const orig = $derived.by(() => {   // 原图真实尺寸：不能拿缩过的 max 档冒充
    if (item.width > 0 && item.height > 0) return { w: +item.width, h: +item.height };
    if (meta && meta.w > 0 && meta.h > 0) return { w: meta.w, h: meta.h };
    return null;
  });
  const tileReq = $derived.by(() => {
    if (!current || !isImg || !item.tileBase || item.fullRes || fellBack || !hiMax || !hiOk || !hiNat || !orig || !geo || !(geo.f > 0)) return null;
    const base = hiNat.w / orig.w;                          // max 档每个原图像素有几个像素（≈1 = 原图直出，用不着分块）
    if (!(base > 0) || base >= 0.98) return null;
    const s = view?.s || 1;
    const need = geo.f * s * dpr;                           // 现在每个原图像素占几个设备像素
    if (need <= base * 1.05) return null;
    return { rq: Math.min(1, 2 ** Math.ceil(Math.log2(need))), s, x: view?.x || 0, y: view?.y || 0, rot, W, H };
  });
  let tiles = $state.raw([]), tileOk = $state.raw(new Set());
  const tileBad = new Set();
  $effect(() => {
    const q = tileReq, lv = live;
    if (!q) { untrack(() => { if (tiles.length) { tiles = []; tileOk = new Set(); } }); return; }
    if (lv) return;                                         // 手势 / 动画中不动，停稳再算
    const timer = setTimeout(() => untrack(() => planTiles(q)), 120);
    return () => clearTimeout(timer);
  });
  function planTiles(q) {
    const g = geo, o = orig, base = item.tileBase;
    if (!g || !o || !base) return;
    const f = g.f, rw = g.turn ? g.bh : g.bw, rh = g.turn ? g.bw : g.bh;   // .iv-rot 的宽高（图片自身方向）
    const a = (-q.rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of [[0, 0], [q.W, 0], [0, q.H], [q.W, q.H]]) {
      // 窗格四角 → 相对框中心（去平移、除缩放）→ 反转旋转 → .iv-rot 内坐标 → 原图像素
      const bx = (px - q.W / 2 - q.x) / q.s, by = (py - q.H / 2 - q.y) / q.s;
      const lx = (bx * ca - by * sa + rw / 2) / f, ly = (bx * sa + by * ca + rh / 2) / f;
      x0 = Math.min(x0, lx); y0 = Math.min(y0, ly); x1 = Math.max(x1, lx); y1 = Math.max(y1, ly);
    }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(o.w, x1); y1 = Math.min(o.h, y1);
    if (!(x1 > x0 && y1 > y0)) { tiles = []; tileOk = new Set(); return; }
    const TS = Math.round(TILE / q.rq);                     // 每块覆盖的原图像素边长
    // 末尾不足 1/6 块的窄条并进前一块（原生拒收长宽比 >8 的块）
    const nOf = (len) => { const n = Math.max(1, Math.ceil(len / TS)); return n > 1 && len - (n - 1) * TS < TS / 6 ? n - 1 : n; };
    const nx = nOf(o.w), ny = nOf(o.h);
    const span = (i, n, len) => [i * TS, i === n - 1 ? len : (i + 1) * TS];
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, want = [];
    for (let r = Math.min(ny - 1, Math.floor(y0 / TS)); r <= Math.min(ny - 1, Math.floor((y1 - 0.001) / TS)); r++) {
      for (let c = Math.min(nx - 1, Math.floor(x0 / TS)); c <= Math.min(nx - 1, Math.floor((x1 - 0.001) / TS)); c++) {
        const [xa, xb] = span(c, nx, o.w), [ya, yb] = span(r, ny, o.h);
        const w = Math.round(xb - xa), h = Math.round(yb - ya), tw = Math.max(1, Math.round(w * q.rq));
        const key = q.rq + ':' + xa + ',' + ya;
        if (w < 1 || h < 1 || tileBad.has(key)) continue;
        want.push({ key, x: xa, y: ya, w, h, d: Math.hypot(xa + w / 2 - cx, ya + h / 2 - cy),
          url: base + '&region=' + [xa, ya, w, h].join(',') + '&w=' + tw });
      }
    }
    want.sort((m, n) => m.d - n.d);
    tiles = want.slice(0, TILE_CAP);
    const keep = new Set(tiles.map((x) => x.key));
    tileOk = new Set([...tileOk].filter((k) => keep.has(k)));
  }
  function onTileLoad(e, key) {
    const im = e.currentTarget;
    const done = () => { if (tiles.some((x) => x.key === key)) tileOk = new Set([...tileOk, key]); };
    if (!(im.naturalWidth > 0)) { onTileError(key); return; }
    if (typeof im.decode === 'function') im.decode().then(done, done); else done();
  }
  function onTileError(key) { tileBad.add(key); tiles = tiles.filter((x) => x.key !== key); }

  // —— 旋转：布局立刻换成新的适应框，图层用 WAAPI 从旧角度 + 旧大小补间过去（FLIP，不动画宽高）——
  let rotEl = $state(null);
  let lastRot = untrack(() => rot), lastGeo = null;
  $effect(() => {
    const r = rot, g = geo, el = rotEl;
    if (!el || !g) return;
    untrack(() => {
      if (r !== lastRot && lastGeo && !reduced()) {
        const was = lastGeo.turn ? lastGeo.bh : lastGeo.bw, now = g.turn ? g.bh : g.bw;   // 图片自身横轴在屏上的长度
        animate(el, [{ transform: `rotate(${lastRot}deg) scale(${(was / now).toFixed(4)})` }, { transform: `rotate(${r}deg)` }], { d: DUR.base, e: EASE.std, fill: 'none' });
      }
      lastRot = r; lastGeo = g;
    });
  });

  const tx = $derived((view?.x || 0) + (dis?.x || 0));
  const ty = $derived((view?.y || 0) + (dis?.y || 0));
  const sc = $derived((view?.s || 1) * (dis?.k || 1));
  const moved = $derived(Math.abs(tx) > 0.01 || Math.abs(ty) > 0.01 || Math.abs(sc - 1) > 0.0001);
  const showThumb = $derived(thumbOn && !!item.thumbUrl && !thumbErr && !mainOk && !hiOk);
  const shown = $derived(mainOk || hiOk || (thumbOk && showThumb));

  // —— 视频占位：海报是图才用（本地来源没有抽帧时 poster 指向视频本身，<img> 认不了）——
  const poster = $derived(item.kind !== 'video' ? '' : item.poster && item.poster !== item.url ? item.poster : item.thumbUrl || '');
  let posterErr = $state(false);
  const iconOf = (k) => (k === 'video' ? 'video' : k === 'audio' ? 'audio' : k === 'pdf' ? 'page' : k === 'office' ? 'table' : 'file');
</script>

<div class="iv-pane">
  {#if isImg}
    <div class="iv-box" style:left={geo ? (W - geo.bw) / 2 + 'px' : '0'} style:top={geo ? (H - geo.bh) / 2 + 'px' : '0'}
      style:width={(geo ? geo.bw : W) + 'px'} style:height={(geo ? geo.bh : H) + 'px'}
      style:transform={moved ? `translate3d(${tx}px,${ty}px,0) scale(${sc})` : null}
      style:will-change={live ? 'transform' : null}
      style:opacity={!geo || veil ? '0' : null}>
      <div class="iv-rot" bind:this={rotEl}
        style:width={geo ? (turn ? geo.bh : geo.bw) + 'px' : '100%'} style:height={geo ? (turn ? geo.bw : geo.bh) + 'px' : '100%'}
        style:left={geo && turn ? (geo.bw - geo.bh) / 2 + 'px' : '0'} style:top={geo && turn ? (geo.bh - geo.bw) / 2 + 'px' : '0'}
        style:transform={rot ? `rotate(${rot}deg)` : null}>
        {#if showThumb}
          <img class="iv-blur" src={item.thumbUrl} alt="" aria-hidden="true" draggable="false" decoding="async"
            style:opacity={thumbOk ? null : '0'} onload={onThumbLoad} onerror={() => (thumbErr = true)} />
        {/if}
        {#if started && mainSrc && !errored && !hiOk}
          <img class="iv-img" src={mainSrc} alt={item.name} draggable="false" decoding="async"
            style:opacity={mainOk && !hiOk ? null : '0'} onload={onMainLoad} onerror={onMainError} />
        {/if}
        {#if hiSrc}
          <img class="iv-hi" src={hiSrc} alt="" aria-hidden="true" draggable="false" decoding="async"
            style:opacity={hiOk ? null : '0'} onload={onHiLoad} onerror={onHiError} />
        {/if}
        {#each tiles as tl (tl.key)}
          <img class="iv-tile" src={tl.url} alt="" aria-hidden="true" draggable="false" decoding="async"
            style:left={tl.x * (geo?.f || 0) + 'px'} style:top={tl.y * (geo?.f || 0) + 'px'}
            style:width={tl.w * (geo?.f || 0) + 'px'} style:height={tl.h * (geo?.f || 0) + 'px'}
            style:opacity={tileOk.has(tl.key) ? null : '0'} onload={(e) => onTileLoad(e, tl.key)} onerror={() => onTileError(tl.key)} />
        {/each}
      </div>
    </div>
    {#if current && !shown && !errored}
      <ViewerState kind="loading" delay={400} />
    {/if}
    {#if errored}
      <!-- 错误态：画廊认得按钮上的点按（不当单击切沉浸），从按钮上起手照样能滑走 / 下拉关闭 -->
      <div class="iv-err" role="presentation" onclick={(e) => e.stopPropagation()}>
        <ViewerState kind="error" icon="image" title={t('图片加载失败')} status={errStatus} onRetry={retry} overlay={false} />
      </div>
    {/if}
  {:else if item.kind === 'video'}
    <div class="iv-vid" style:transform={dis ? `translate3d(${dis.x}px,${dis.y}px,0) scale(${dis.k})` : null}>
      {#if poster && !posterErr}
        <img class="iv-poster" src={poster} alt="" aria-hidden="true" draggable="false" decoding="async" onerror={() => (posterErr = true)} />
      {:else}
        <VIcon name="video" size={44} class="iv-type" />
      {/if}
      <button type="button" class="iv-play" aria-label={t('播放')}
        onclick={(e) => { e.stopPropagation(); onplay?.(); }}><VIcon name="play" size={26} /></button>
    </div>
  {:else}
    <div class="iv-other" style:transform={dis ? `translate3d(${dis.x}px,${dis.y}px,0) scale(${dis.k})` : null}><VIcon name={iconOf(item.kind)} size={44} /><span>{item.name}</span></div>
  {/if}
</div>

<style>
  .iv-pane { position: absolute; inset: 0; overflow: hidden; }
  .iv-box { position: absolute; transform-origin: 50% 50%; }
  .iv-rot { position: absolute; transform-origin: 50% 50%; }
  .iv-rot img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; user-select: none; -webkit-user-drag: none; -webkit-touch-callout: none; pointer-events: none; }
  .iv-rot img.iv-tile { right: auto; bottom: auto; }   /* 区域块：left / top / 宽高按原图像素 × geo.f 内联给 */
  /* 错误态铺满只为居中：自身不吃指针，只有按钮接手 */
  .iv-err { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
  .iv-err :global(.vw-state-acts) { pointer-events: auto; }
  .iv-vid, .iv-other { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
  .iv-poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; pointer-events: none; }
  .iv-vid :global(.iv-type), .iv-other :global(.vw-ic) { color: var(--vw-fg-3); }
  .iv-play { position: relative; width: 64px; height: 64px; border: 0; padding: 0; border-radius: 50%; display: grid; place-items: center;
    background: rgba(0, 0, 0, .55); color: #fff; cursor: pointer; }
  .iv-play :global(.vw-ic) { margin-left: 3px; }
  .iv-other { flex-direction: column; gap: 12px; color: var(--vw-fg-2); font-size: 13px; padding: 24px; text-align: center; word-break: break-all; }
</style>
