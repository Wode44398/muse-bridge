<script>
  // i18n-ignore-file（开发专用页，不翻译）
  // 原版 liquid-glass（维护者下载的文件夹）vs bridge 复刻版（A/B 定案的右侧配方：
  // DOM 引擎解析式透镜位移 + 参考铬装）——同壁纸可拖对比页（dev-only，?dvs）。
  // 原版逐字照搬：CSS 铬装 + 它的 SVG 滤镜（feImage base64 位移图 + objectBoundingBox
  // 2% 模糊 + SMIL 悬停鼓包），滤镜从原版页里现抽现注
  // （backdrop-filter:url(#id) 只认同文档滤镜，外链 SVG 无效）。
  // 原版页不在公开仓：在维护者私有 overlay 的 web/lg-ref/index.html（ovUrl 取；dev 下经 vite 代理 /app/_ov 到后端）。
  // 没有 overlay 时左边不出，只提示。
  import { onMount } from 'svelte';
  import { overlayReady, ovHas, ovUrl } from '../../lib/overlay.svelte.js';
  import '../tokens.css';
  import { dskGlass } from './domGlass.js';

  document.documentElement.dataset.desktop = '1';

  const SIZE = 320;   // 与原版 20rem 等大
  let a = $state({ x: window.innerWidth * 0.32 - SIZE / 2, y: window.innerHeight * 0.52 - SIZE / 2 });
  let b = $state({ x: window.innerWidth * 0.68 - SIZE / 2, y: window.innerHeight * 0.52 - SIZE / 2 });

  function drag(node, pos) {
    let sx = 0, sy = 0, ox = 0, oy = 0;
    const move = (e) => { pos.x = ox + e.clientX - sx; pos.y = oy + e.clientY - sy; };
    const up = () => node.removeEventListener('pointermove', move);
    const down = (e) => {
      try { node.setPointerCapture(e.pointerId); } catch {}
      sx = e.clientX; sy = e.clientY; ox = pos.x; oy = pos.y;
      node.addEventListener('pointermove', move);
    };
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    return { destroy() { node.removeEventListener('pointerdown', down); up(); } };
  }

  let refReady = $state(false);
  let refErr = $state('');
  let filterHost = null;
  onMount(() => {
    overlayReady()
      .then(() => {
        if (!ovHas('lg-ref/index.html')) throw new Error('no overlay');
        return fetch(ovUrl('lg-ref/index.html'));
      })
      .then((r) => r.text())
      .then((txt) => {
        const m = txt.match(/<svg[\s\S]*?<\/svg>/);
        if (!m) { refErr = 'lg-ref 里没找到 <svg> 滤镜'; return; }
        filterHost = document.createElement('div');
        filterHost.setAttribute('aria-hidden', 'true');
        filterHost.innerHTML = m[0];
        document.body.appendChild(filterHost);
        refReady = true;
      })
      .catch(() => { refErr = '原版拷贝没就位：私有 overlay 的 web/lg-ref/index.html（后端要配 overlayDir 或 BRIDGE_OVERLAY_DIR）'; });
    return () => filterHost?.remove();
  });
</script>

<div class="cmp">
  <img class="wp" src="/assets/wallpapers/ridges.jpg" alt="" draggable="false" />

  {#if refReady}
    <!-- 原版：id=btn 保住 SMIL 悬停鼓包（animate begin="btn.mouseover"） -->
    <button id="btn" class="ref-glass" style:left="{a.x}px" style:top="{a.y}px" use:drag={a} aria-label="原版玻璃"></button>
  {:else if refErr}
    <p class="err">{refErr}</p>
  {/if}

  <!-- bridge 当前默认（已全面采用原版：同贴图/同模糊/同铬装，dskGlass 零参数） -->
  <button class="mine" style:left="{b.x}px" style:top="{b.y}px" use:drag={b}
          use:dskGlass={{ radius: 999 }}
          aria-label="bridge 默认玻璃"></button>

  <div class="lab" style:left="{a.x + SIZE / 2}px" style:top="{a.y + SIZE + 12}px">原版（文件夹 · 悬停会鼓）</div>
  <div class="lab" style:left="{b.x + SIZE / 2}px" style:top="{b.y + SIZE + 12}px">bridge 默认（已切原版配方）</div>
  <div class="tip">两个圆都能拖 · 同壁纸公平对比</div>
</div>

<style>
  .cmp { position: fixed; inset: 0; overflow: hidden; background: #0a0a0a; }
  .wp { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }

  /* 原版铬装逐字照搬（仅定位从 fixed 居中改为受控拖拽） */
  .ref-glass {
    position: absolute; width: 320px; height: 320px; border-radius: 50%;
    background: rgba(255, 255, 255, .08); border: 2px solid transparent;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, .6), 0 16px 32px rgba(0, 0, 0, .12);
    backdrop-filter: url(#frosted); -webkit-backdrop-filter: url(#frosted);
    display: grid; place-items: center; cursor: grab; outline: 0; padding: 0;
    touch-action: none;
  }
  .ref-glass::before, .ref-glass::after,
  .mine::before, .mine::after {
    content: ""; position: absolute; left: 30%; top: calc(50% - 5px);
    width: 40%; height: 10px; background: #fff; border-radius: 10px;
  }
  .ref-glass::after, .mine::after { transform: rotate(90deg); }
  .ref-glass:active, .mine:active { cursor: grabbing; }

  /* bridge 默认：滤镜/奶雾底/环/影全部由 dskGlass 注入（原版配方），这里只管定位与拖拽 */
  .mine {
    position: absolute; width: 320px; height: 320px; border-radius: 50%;
    border: 2px solid transparent; padding: 0;
    display: grid; place-items: center; cursor: grab; outline: 0;
    touch-action: none;
  }

  .lab {
    position: absolute; transform: translateX(-50%); pointer-events: none;
    color: #fff; font: 600 13px/1.4 var(--dsk-font); letter-spacing: .06em;
    text-shadow: 0 1px 6px rgba(0, 0, 0, .55); white-space: nowrap;
  }
  .tip {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%); pointer-events: none;
    color: rgba(255, 255, 255, .6); font: 12px var(--dsk-font); text-shadow: 0 1px 4px rgba(0, 0, 0, .5);
  }
  .err { position: fixed; top: 40%; left: 50%; transform: translateX(-50%); color: #d96a5a; font: 13px var(--dsk-font); }
</style>
