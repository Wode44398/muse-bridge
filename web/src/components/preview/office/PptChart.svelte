<script>
  // 幻灯片里的图表（pptx 客户端回落）：读图表部件里缓存的数据画成 SVG——柱形 / 条形 / 折线 / 面积（簇状、堆积、百分比堆积）、饼图 / 圆环。
  // 坐标单位与幻灯片一致（磅），外层整体缩放。配色按 Office 缺省：系列取主题强调色，坐标文字 #595959、网格线 #d9d9d9。
  // 散点 / 雷达等不常见的类型画个带标题的占位框，不硬画错的图。
  // props：chart（pptx.js readChart 的结果）· w · h（磅）
  import { t, locale } from '../../../lib/i18n.js';

  let { chart, w, h } = $props();

  const INK = '#595959', GRID = '#d9d9d9';
  const fs = $derived(Math.max(7, Math.min(14, Math.min(w, h) / 20)));
  const nf = $derived.by(() => { try { return new Intl.NumberFormat(locale() || undefined, { maximumFractionDigits: 2 }); } catch { return new Intl.NumberFormat(); } });

  const series = $derived((chart?.series || []).filter((s) => s.vals?.length));
  const kind = $derived(chart?.type || 'unknown');
  const pie = $derived(kind === 'pie' || kind === 'doughnut');
  const axisKind = $derived(['bar', 'line', 'area'].includes(kind));
  const cats = $derived.by(() => {
    let best = [];
    for (const s of series) if ((s.cats?.length || 0) > best.length) best = s.cats;
    const n = Math.max(best.length, ...series.map((s) => s.vals.length), 0);
    return Array.from({ length: n }, (_, i) => (best[i] != null && best[i] !== '' ? String(best[i]) : String(i + 1)));
  });
  const color = (s, i) => s.color || chart.accents[i % chart.accents.length];

  // —— 版面：标题 / 图例 / 绘图区 ——
  const titleH = $derived(chart?.title ? fs * 2 : fs * 0.6);
  const legendItems = $derived(!chart?.legend ? [] : pie
    ? cats.map((c, i) => ({ label: c, color: series[0]?.points?.find((p) => p.i === i)?.c || chart.accents[i % chart.accents.length] }))
    : series.map((s, i) => ({ label: s.name || `${t('系列')} ${i + 1}`, color: color(s, i) })));
  const legendH = $derived(legendItems.length ? fs * 2 : 0);
  const legendRow = $derived.by(() => {
    // 横排居中，放不下的截掉（不折行，图例不该挤掉图）
    const gap = fs * 1.2, sw = fs * 0.75;
    const out = [];
    let x = 0;
    for (const it of legendItems) {
      const tw = textW(it.label, fs * 0.9);
      const ww = sw + fs * 0.4 + tw;
      if (x + ww > w - fs * 2) break;
      out.push({ ...it, x, tw });
      x += ww + gap;
    }
    const total = Math.max(0, x - gap);
    const left = (w - total) / 2;
    return out.map((it) => ({ ...it, x: it.x + left }));
  });
  /** 粗估文字宽度：中日韩算一个字宽，其它算 0.55 */
  function textW(s, size) {
    let u = 0;
    for (const ch of String(s)) u += /[⺀-￿]/.test(ch) ? 1 : 0.56;
    return u * size;
  }

  const plot = $derived({ x: fs, y: titleH, w: Math.max(10, w - fs * 2), h: Math.max(10, h - titleH - legendH - fs * 0.6) });

  // —— 坐标轴图表 ——
  const stacked = $derived(chart?.grouping === 'stacked' || chart?.grouping === 'percentStacked');
  const percent = $derived(chart?.grouping === 'percentStacked');
  const horiz = $derived(kind === 'bar' && chart?.dir === 'bar');
  const range = $derived.by(() => {
    let lo = 0, hi = 0;
    if (stacked) {
      for (let i = 0; i < cats.length; i++) {
        let pos = 0, neg = 0, tot = 0;
        for (const s of series) { const v = s.vals[i] || 0; if (v >= 0) pos += v; else neg += v; tot += Math.abs(v); }
        if (percent) { hi = 1; lo = Math.min(lo, tot ? neg / tot : 0); }
        else { hi = Math.max(hi, pos); lo = Math.min(lo, neg); }
      }
    } else for (const s of series) for (const v of s.vals) if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
    if (hi === lo) hi = lo + 1;
    return niceScale(lo, hi);
  });
  function niceScale(lo, hi) {
    const raw = (hi - lo) / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => raw <= s) || 10 * mag;
    const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = a; v <= b + step / 1e6; v += step) ticks.push(+v.toPrecision(12));
    return { lo: a, hi: b, ticks };
  }
  const fmt = (v) => (percent ? `${Math.round(v * 100)}%` : nf.format(v));
  // 值轴文字宽（左边留出来）；条形图的分类轴在左边
  const valW = $derived(Math.max(...range.ticks.map((v) => textW(fmt(v), fs * 0.85)), fs) + fs * 0.6);
  const catW = $derived(horiz ? Math.min(plot.w * 0.35, Math.max(...cats.map((c) => textW(c, fs * 0.85)), fs) + fs * 0.6) : 0);
  const area = $derived.by(() => {
    const left = plot.x + (horiz ? catW : valW);
    const bottom = fs * 1.6;
    return { x: left, y: plot.y + fs * 0.4, w: Math.max(10, plot.x + plot.w - left - fs * 0.4), h: Math.max(10, plot.h - bottom - fs * 0.4) };
  });
  // 值 → 坐标
  const vpos = (v) => {
    const r = range, k = (v - r.lo) / (r.hi - r.lo || 1);
    return horiz ? area.x + k * area.w : area.y + area.h - k * area.h;
  };
  const band = $derived(cats.length ? (horiz ? area.h : area.w) / cats.length : 1);
  // 分类 i 的中心（条形图第一个分类在最下面，和 Office 一致）
  const cpos = (i) => (horiz ? area.y + area.h - (i + 0.5) * band : area.x + (i + 0.5) * band);
  const catStep = $derived.by(() => {
    if (horiz) return Math.max(1, Math.ceil((fs * 1.2) / band));
    const widest = Math.max(...cats.map((c) => textW(c, fs * 0.85)), 1);
    return Math.max(1, Math.ceil((widest + fs * 0.6) / band));
  });

  const bars = $derived.by(() => {
    if (kind !== 'bar') return [];
    const out = [];
    const n = series.length || 1;
    const group = band / 2.5 * 1.5;                       // 间隙宽度 150%：柱组占 60%
    const bw = stacked ? group : group / n;
    for (let i = 0; i < cats.length; i++) {
      let pos = 0, neg = 0, tot = 0;
      if (percent) for (const s of series) tot += Math.abs(s.vals[i] || 0);
      series.forEach((s, si) => {
        let v = s.vals[i];
        if (v == null) return;
        if (percent) v = tot ? v / tot : 0;
        let a, b;
        if (stacked) { if (v >= 0) { a = pos; pos += v; b = pos; } else { a = neg; neg += v; b = neg; } }
        else { a = 0; b = v; }
        const p1 = vpos(Math.max(range.lo, Math.min(range.hi, a))), p2 = vpos(Math.max(range.lo, Math.min(range.hi, b)));
        const off = stacked ? -group / 2 : -group / 2 + si * bw;
        const c = s.points?.find((p) => p.i === i)?.c || color(s, si);
        if (horiz) out.push({ x: Math.min(p1, p2), y: cpos(i) + off, w: Math.abs(p2 - p1), h: bw, c });
        else out.push({ x: cpos(i) + off, y: Math.min(p1, p2), w: bw, h: Math.abs(p2 - p1), c });
      });
    }
    return out;
  });
  const lines = $derived.by(() => {
    if (kind !== 'line' && kind !== 'area') return [];
    const acc = new Array(cats.length).fill(0);
    const tot = cats.map((_, i) => series.reduce((s, x) => s + Math.abs(x.vals[i] || 0), 0));
    return series.map((s, si) => {
      const base = stacked ? acc.slice() : null;
      const pts = cats.map((_, i) => {
        let v = s.vals[i];
        if (v == null) return null;
        if (percent) v = tot[i] ? v / tot[i] : 0;
        if (stacked) { acc[i] += v; v = acc[i]; }
        return [area.x + (i + 0.5) * band, vpos(v)];
      });
      const ok = pts.filter(Boolean);
      const d = ok.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('');
      let fill = '';
      if (kind === 'area' && ok.length) {
        const floor = base ? cats.map((_, i) => [area.x + (i + 0.5) * band, vpos(base[i])]).filter((_, i) => pts[i]).reverse() : [[ok[ok.length - 1][0], vpos(Math.max(range.lo, 0))], [ok[0][0], vpos(Math.max(range.lo, 0))]];
        fill = d + floor.map((p) => `L${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('') + 'Z';
      }
      return { d, fill, pts: ok, c: color(s, si) };
    });
  });

  // —— 饼图 ——
  const slices = $derived.by(() => {
    if (!pie || !series[0]) return [];
    const s = series[0];
    const vals = s.vals.map((v) => Math.max(0, v || 0));
    const sum = vals.reduce((a, b) => a + b, 0) || 1;
    const r = Math.max(4, Math.min(plot.w, plot.h) / 2 - fs * 0.4);
    const cx = plot.x + plot.w / 2, cy = plot.y + plot.h / 2;
    const ri = r * (chart.hole || 0);
    let a0 = -Math.PI / 2;
    return vals.map((v, i) => {
      const a1 = a0 + (v / sum) * Math.PI * 2;
      const c = s.points?.find((p) => p.i === i)?.c || chart.accents[i % chart.accents.length];
      const d = arc(cx, cy, r, ri, a0, a1);
      const mid = (a0 + a1) / 2;
      const lab = v / sum >= 0.05 ? { x: cx + Math.cos(mid) * (ri ? (r + ri) / 2 : r * 0.62), y: cy + Math.sin(mid) * (ri ? (r + ri) / 2 : r * 0.62), text: `${Math.round((v / sum) * 100)}%` } : null;
      a0 = a1;
      return { d, c, lab };
    });
  });
  function arc(cx, cy, r, ri, a0, a1) {
    if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rr, a) => `${(cx + Math.cos(a) * rr).toFixed(2)},${(cy + Math.sin(a) * rr).toFixed(2)}`;
    if (!ri) return `M${cx},${cy}L${p(r, a0)}A${r},${r} 0 ${big} 1 ${p(r, a1)}Z`;
    return `M${p(r, a0)}A${r},${r} 0 ${big} 1 ${p(r, a1)}L${p(ri, a1)}A${ri},${ri} 0 ${big} 0 ${p(ri, a0)}Z`;
  }
</script>

<svg class="pc" viewBox="0 0 {w} {h}" width={w} height={h} aria-label={chart?.title || t('图表')} role="img" font-size={fs}>
  {#if chart?.title}
    <text x={w / 2} y={fs * 1.35} text-anchor="middle" font-size={fs * 1.15} font-weight="600" fill={INK}>{chart.title}</text>
  {/if}
  {#if pie}
    {#each slices as s, i (i)}
      <path d={s.d} fill={s.c} stroke="#fff" stroke-width={Math.max(0.5, fs * 0.08)} />
    {/each}
    {#each slices as s, i (i)}
      {#if s.lab}<text x={s.lab.x} y={s.lab.y} dy=".35em" text-anchor="middle" font-size={fs * 0.85} fill="#fff">{s.lab.text}</text>{/if}
    {/each}
  {:else if axisKind && series.length && cats.length}
    <!-- 网格线与值轴 -->
    {#each range.ticks as v (v)}
      {@const p = vpos(v)}
      {#if horiz}
        <line x1={p} x2={p} y1={area.y} y2={area.y + area.h} stroke={GRID} stroke-width="0.75" />
        <text x={p} y={area.y + area.h + fs * 1.2} text-anchor="middle" font-size={fs * 0.85} fill={INK}>{fmt(v)}</text>
      {:else}
        <line x1={area.x} x2={area.x + area.w} y1={p} y2={p} stroke={GRID} stroke-width="0.75" />
        <text x={area.x - fs * 0.4} y={p} dy=".35em" text-anchor="end" font-size={fs * 0.85} fill={INK}>{fmt(v)}</text>
      {/if}
    {/each}
    <!-- 分类轴 -->
    {#each cats as c, i (i)}
      {#if i % catStep === 0}
        {#if horiz}
          <text x={area.x - fs * 0.4} y={cpos(i)} dy=".35em" text-anchor="end" font-size={fs * 0.85} fill={INK}>{c}</text>
        {:else}
          <text x={cpos(i)} y={area.y + area.h + fs * 1.2} text-anchor="middle" font-size={fs * 0.85} fill={INK}>{c}</text>
        {/if}
      {/if}
    {/each}
    {#if horiz}
      <line x1={vpos(Math.max(range.lo, 0))} x2={vpos(Math.max(range.lo, 0))} y1={area.y} y2={area.y + area.h} stroke="#bfbfbf" stroke-width="0.75" />
    {:else}
      <line x1={area.x} x2={area.x + area.w} y1={vpos(Math.max(range.lo, 0))} y2={vpos(Math.max(range.lo, 0))} stroke="#bfbfbf" stroke-width="0.75" />
    {/if}
    {#each bars as b, i (i)}
      <rect x={b.x} y={b.y} width={Math.max(0, b.w)} height={Math.max(0, b.h)} fill={b.c} />
    {/each}
    {#each [...lines].reverse() as l, i (i)}
      {#if l.fill}<path d={l.fill} fill={l.c} opacity=".88" />{/if}
    {/each}
    {#each lines as l, i (i)}
      {#if kind === 'line'}
        <path d={l.d} fill="none" stroke={l.c} stroke-width={Math.max(1, fs * 0.2)} stroke-linejoin="round" stroke-linecap="round" />
        {#each l.pts as p, j (j)}<circle cx={p[0]} cy={p[1]} r={Math.max(1.2, fs * 0.28)} fill={l.c} />{/each}
      {/if}
    {/each}
  {:else}
    <rect x={plot.x} y={plot.y} width={plot.w} height={plot.h} fill="none" stroke={GRID} stroke-dasharray="4 3" />
    <text x={w / 2} y={plot.y + plot.h / 2} dy=".35em" text-anchor="middle" font-size={fs} fill={INK}>{t('图表')}</text>
  {/if}
  {#each legendRow as it, i (i)}
    <rect x={it.x} y={h - legendH + fs * 0.62} width={fs * 0.75} height={fs * 0.75} fill={it.color} />
    <text x={it.x + fs * 1.15} y={h - legendH + fs} dy=".35em" font-size={fs * 0.9} fill={INK}>{it.label}</text>
  {/each}
</svg>

<style>
  .pc { position: absolute; inset: 0; overflow: visible; font-family: inherit; }
</style>
