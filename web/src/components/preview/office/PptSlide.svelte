<script>
  // 一张幻灯片（pptx 客户端回落）：pptx.js 解析出的形状按磅排在 deck.w × deck.h 的画布上，整体 CSS 缩放到 w 像素宽。
  // 正文、缩略图、放映都用它，同一套排版；缩略图里不出链接（格子本身是按钮）。
  // props：deck · n（1 起）· w（显示宽度，像素；0 = 铺满父元素宽，缩略图用）· links（链接可点；缺省否）
  import VIcon from '../kit/VIcon.svelte';
  import PptChart from './PptChart.svelte';
  import { t } from '../../../lib/i18n.js';

  let { deck, n, w, links = false } = $props();

  let autoW = $state(0);
  const W = $derived(w || autoW);
  const s = $derived(deck?.slides?.[n - 1] || null);
  const k = $derived(deck ? W / deck.w : 1);

  // 常见预设形状用 clip-path 裁出轮廓（填充可以是渐变 / 图片），其余按矩形
  const CLIP = {
    triangle: 'polygon(50% 0,100% 100%,0 100%)',
    rtTriangle: 'polygon(0 0,100% 100%,0 100%)',
    diamond: 'polygon(50% 0,100% 50%,50% 100%,0 50%)',
    parallelogram: 'polygon(25% 0,100% 0,75% 100%,0 100%)',
    trapezoid: 'polygon(25% 0,75% 0,100% 100%,0 100%)',
    homePlate: 'polygon(0 0,82% 0,100% 50%,82% 100%,0 100%)',
    pentagon: 'polygon(50% 0,100% 38%,82% 100%,18% 100%,0 38%)',
    chevron: 'polygon(0 0,80% 0,100% 50%,80% 100%,0 100%,20% 50%)',
    hexagon: 'polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)',
    octagon: 'polygon(29% 0,71% 0,100% 29%,100% 71%,71% 100%,29% 100%,0 71%,0 29%)',
    rightArrow: 'polygon(0 25%,62% 25%,62% 0,100% 50%,62% 100%,62% 75%,0 75%)',
    leftArrow: 'polygon(100% 25%,38% 25%,38% 0,0 50%,38% 100%,38% 75%,100% 75%)',
    upArrow: 'polygon(25% 100%,25% 38%,0 38%,50% 0,100% 38%,75% 38%,75% 100%)',
    downArrow: 'polygon(25% 0,25% 62%,0 62%,50% 100%,100% 62%,75% 62%,75% 0)',
    plus: 'polygon(35% 0,65% 0,65% 35%,100% 35%,100% 65%,65% 65%,65% 100%,35% 100%,35% 65%,0 65%,0 35%,35% 35%)',
  };
  const LINE = new Set(['line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'curvedConnector3']);

  function place(sh, text) {
    const tf = [];
    let rot = sh.rot || 0;
    // 文字不跟着水平翻转（PowerPoint 也不镜像文字），垂直翻转相当于转 180°
    if (text) { if (sh.flipV) rot += 180; }
    if (rot) tf.push(`rotate(${rot}deg)`);
    if (!text && sh.flipH) tf.push('scaleX(-1)');
    if (!text && sh.flipV) tf.push('scaleY(-1)');
    return `left:${sh.x}px;top:${sh.y}px;width:${sh.w}px;height:${sh.h}px;${tf.length ? `transform:${tf.join(' ')};` : ''}`;
  }
  function geoStyle(sh) {
    let css = '';
    if (sh.fill) css += `background:${sh.fill.css};`;
    if (sh.line && !CLIP[sh.geom]) css += `outline:${+sh.line.w.toFixed(2)}px ${sh.line.dash} ${sh.line.c};outline-offset:${-(sh.line.w / 2).toFixed(2)}px;`;
    if (sh.geom === 'ellipse') css += 'border-radius:50%;';
    else if (sh.geom === 'roundRect') css += `border-radius:${(sh.radius || 0).toFixed(2)}px;`;
    else if (CLIP[sh.geom]) css += `clip-path:${CLIP[sh.geom]};`;
    return css;
  }
  const ALIGN = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify', thaiDist: 'justify' };
  const JUSTIFY = { t: 'flex-start', ctr: 'center', b: 'flex-end', just: 'center', dist: 'center' };
  function bodyStyle(tx, anchor) {
    const [pt, pr, pb, pl] = tx.pad;
    return `padding:${pt}px ${pr}px ${pb}px ${pl}px;justify-content:${JUSTIFY[anchor || tx.anchor] || 'flex-start'};white-space:${tx.wrap ? 'pre-wrap' : 'pre'};${tx.vert ? 'writing-mode:vertical-rl;' : ''}`;
  }
  function lineH(p) {
    const red = 1 - (p.lnRed || 0);
    if (p.lnSpc?.pts) return `${p.lnSpc.pts}px`;
    return String(+(1.2 * (p.lnSpc?.pct ?? 1) * red).toFixed(3));
  }
  function gap(sp, size) {
    if (!sp) return 0;
    return sp.pts != null ? sp.pts : sp.pct * size * 1.2;
  }
  function paraStyle(p) {
    const size = p.runs.find((r) => r.t)?.size || p.size || 18;
    return `text-align:${ALIGN[p.algn] || 'left'};padding-left:${Math.max(0, p.marL)}px;text-indent:${p.indent}px;line-height:${lineH(p)};font-size:${size}px;` +
      `margin-top:${gap(p.spcBef, size).toFixed(2)}px;margin-bottom:${gap(p.spcAft, size).toFixed(2)}px;`;
  }
  function runStyle(r) {
    let css = `font-size:${+r.size.toFixed(2)}px;color:${r.color};`;
    if (r.font) css += `font-family:${r.font},var(--ps-font);`;
    if (r.b) css += 'font-weight:700;';
    if (r.i) css += 'font-style:italic;';
    if (r.u || r.strike) css += `text-decoration:${[r.u && 'underline', r.strike && 'line-through'].filter(Boolean).join(' ')};`;
    if (r.cap) css += 'text-transform:uppercase;';
    if (r.base) css += `vertical-align:${r.base > 0 ? 'super' : 'sub'};font-size:${+(r.size * 0.66).toFixed(2)}px;`;
    return css;
  }
  function bulletStyle(p) {
    const first = p.runs.find((r) => r.t) || {};
    const size = (first.size || p.size || 18) * (p.bullet.scale || 1);
    const wd = p.indent < 0 ? -p.indent : 0;
    return `color:${p.bullet.color || first.color || 'inherit'};font-size:${+size.toFixed(2)}px;${wd ? `width:${wd}px;` : 'margin-right:.4em;'}`;
  }
  function cropStyle(c) {
    if (!c) return 'inset:0;width:100%;height:100%;';
    const [l, tp, r, b] = c;
    const sw = 1 - l - r || 1, sh = 1 - tp - b || 1;
    return `left:${(-l / sw) * 100}%;top:${(-tp / sh) * 100}%;width:${100 / sw}%;height:${100 / sh}%;`;
  }
  function cellStyle(c, styled) {
    const sides = ['top', 'right', 'bottom', 'left'];
    let css = c.bg ? `background:${c.bg};` : '';
    c.bd.forEach((b, i) => {
      if (b === 'none') css += `border-${sides[i]}:0;`;
      else if (b) css += `border-${sides[i]}:${b};`;
      else css += `border-${sides[i]}:${styled ? '1px solid #fff' : '.75px solid rgba(0,0,0,.28)'};`;
    });
    const [pt, pr, pb, pl] = c.pad;
    return css + `padding:${pt}px ${pr}px ${pb}px ${pl}px;vertical-align:${c.anchor === 'ctr' ? 'middle' : c.anchor === 'b' ? 'bottom' : 'top'};`;
  }
</script>

{#snippet paras(tx)}
  {#each tx.paras as p, pi (pi)}
    <p class="pp" style={paraStyle(p)}>{#if p.bullet}<span class="pb" style={bulletStyle(p)}>{p.bullet.char}</span>{/if}{#each p.runs as r, ri (ri)}{#if r.br}<br />{:else if r.href && links}<a class="pr" href={r.href} target="_blank" rel="noopener noreferrer" style={runStyle(r)}>{r.t}</a>{:else}<span class="pr" style={runStyle(r)}>{r.t}</span>{/if}{/each}{#if !p.runs.length}<br />{/if}</p>
  {/each}
{/snippet}

{#if deck && s}
  <div class="psl" style:width={w ? `${w}px` : '100%'} style:height="{(W * deck.h) / deck.w}px" bind:clientWidth={autoW}>
    <div class="psl-in" style:width="{deck.w}px" style:height="{deck.h}px" style:transform="scale({k})" style:background={s.bg}>
      {#each s.shapes as sh, i (i)}
        {#if sh.kind === 'pic'}
          <div class="sp sp-pic" style={place(sh, false)} style:border-radius={sh.geom === 'ellipse' ? '50%' : null}>
            {#if sh.src && !sh.src.startsWith('unsupported:')}
              <img src={sh.src} alt={sh.alt || ''} draggable="false" decoding="async" style={cropStyle(sh.crop)} />
            {:else}
              <div class="sp-miss" title={t('这张图片的格式无法在网页里显示')}>
                <VIcon name="image" size={Math.max(12, Math.min(40, Math.min(sh.w, sh.h) / 3))} />
              </div>
            {/if}
            {#if sh.line}<i class="sp-ln" style="outline:{sh.line.w}px {sh.line.dash} {sh.line.c};outline-offset:{-sh.line.w / 2}px"></i>{/if}
          </div>
        {:else if sh.kind === 'table'}
          <div class="sp sp-tbl" style={place(sh, true)}>
            <table class="tb-t" style:width="{sh.table.cols.reduce((a, b) => a + b, 0)}px">
              <colgroup>{#each sh.table.cols as cw, ci (ci)}<col style:width="{cw}px" />{/each}</colgroup>
              <tbody>
                {#each sh.table.rows as row, ri (ri)}
                  <tr style:height="{row.h}px">
                    {#each row.cells as c, ci (ci)}
                      {#if !c.skip}
                        <td colspan={c.span > 1 ? c.span : undefined} rowspan={c.rspan > 1 ? c.rspan : undefined} style={cellStyle(c, sh.table.styled)}>
                          {#if c.text}{@render paras(c.text)}{/if}
                        </td>
                      {/if}
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else if sh.kind === 'chart'}
          <div class="sp" style={place(sh, true)}>
            {#if sh.chart}<PptChart chart={sh.chart} w={sh.w} h={sh.h} />{/if}
          </div>
        {:else if LINE.has(sh.geom)}
          <svg class="sp sp-line" style={place(sh, false)} viewBox="0 0 {Math.max(sh.w, 0.01)} {Math.max(sh.h, 0.01)}" preserveAspectRatio="none" aria-hidden="true">
            {#if sh.line}<line x1="0" y1="0" x2={sh.w} y2={sh.h} stroke={sh.line.c} stroke-width={sh.line.w} stroke-dasharray={sh.line.dash === 'dashed' ? `${sh.line.w * 4} ${sh.line.w * 3}` : null} vector-effect="non-scaling-stroke" />{/if}
          </svg>
        {:else}
          <div class="sp" style={place(sh, !!sh.text)}>
            {#if sh.fill || sh.line}<i class="sp-geo" style={geoStyle(sh)} style:transform={sh.text && (sh.flipH || sh.flipV) ? `scale(${sh.flipH ? -1 : 1},${sh.flipV ? -1 : 1})` : null}></i>{/if}
            {#if sh.text}<div class="sp-tx" style={bodyStyle(sh.text)}>{@render paras(sh.text)}</div>{/if}
          </div>
        {/if}
      {/each}
    </div>
  </div>
{/if}

<style>
  .psl { position: relative; overflow: hidden; contain: layout paint; user-select: text; -webkit-user-select: text; }
  .psl-in { position: absolute; left: 0; top: 0; transform-origin: 0 0; overflow: hidden; color: #000;
    --ps-font: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', sans-serif;
    font-family: var(--ps-font); font-kerning: normal; text-rendering: optimizeLegibility; -webkit-text-size-adjust: none; text-size-adjust: none; }
  .sp { position: absolute; box-sizing: border-box; }
  .sp-geo, .sp-ln { position: absolute; inset: 0; pointer-events: none; }
  .sp-tx { position: absolute; inset: 0; box-sizing: border-box; display: flex; flex-direction: column; overflow-wrap: break-word; word-break: normal; line-break: auto; }
  .sp-pic { overflow: hidden; }
  .sp-pic img { position: absolute; display: block; max-width: none; }
  .sp-miss { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: rgba(0, 0, 0, .3);
    background: rgba(0, 0, 0, .04); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .12); }
  .sp-line { overflow: visible; }
  .pp { margin: 0; }
  .pb { display: inline-block; text-indent: 0; }
  .pr { white-space: inherit; }
  a.pr { text-decoration: underline; cursor: pointer; }
  .tb-t { border-collapse: collapse; table-layout: fixed; }
  .tb-t td { box-sizing: border-box; overflow: hidden; overflow-wrap: break-word; white-space: pre-wrap; }
</style>
