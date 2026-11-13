// 截图健全性：截图和 DOM 对不上就不算通过（2026-11-05：p393 / image-longprompt 的截图整张变成顶栏 2×5 平铺，
// DOM 完全正常、检测报 0，差点把坏图当对比图发给维护者）。两道核对：
//   1. 色块探针：截图前在页面里挑几个「底色实心、看得见、中心点打得到自己」的元素（发送钮、输入框、卡片、顶栏、按钮……），
//      记下位置和计算后的底色；截图后在那块区域（内缩 25%）取各通道中位数，和底色差得多就是截图没画对。
//   2. 顶栏平铺：顶栏那条带（有字的那一截）在画面更下面原样重复出现＝合成器拿错了贴图。
// 依赖 sharp（仓库根 node_modules 里有）；没有 sharp 就跳过（返回 null），不拦检测。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let sharp = null;
try { sharp = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../package.json'))('sharp'); } catch {}
export const shotCheckAvailable = () => !!sharp;

// 页面里跑：window.__qaShotProbes() → { dpr, top, solids[], dom }
export const PROBE_SRC = String.raw`
window.__qaShotProbes = function () {
  const dpr = devicePixelRatio || 1;
  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { rgb: p.slice(0, 3), a: p[3] == null ? 1 : p[3] }; };
  const visible = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.999 || e.hasAttribute('inert')) return false; if (s.filter !== 'none' || s.mixBlendMode !== 'normal') return false; } return true; };
  const R = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const solids = [];
  const CAND = '.studio-root .cp-send, .studio-root .cp, .studio-root .pl-panel, .studio-root .pl-model, .studio-root .sd-band, .studio-root .cv-row, .studio-root .fc-audio, .studio-root .ch-bubble, .studio-root .sh-panel, .sst .ig, .sst .ivc, .sh-body, .ly-pop, .studio-root .pv, button, [role=button]';
  for (const el of document.querySelectorAll(CAND)) {
    if (solids.length >= 14) break;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 20 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) continue;
    const s = getComputedStyle(el);
    const bg = parse(s.backgroundColor);
    if (!bg || bg.a < 0.999 || s.backgroundImage !== 'none' || s.backdropFilter && s.backdropFilter !== 'none') continue;
    if (!visible(el)) continue;
    // 中心和四个内缩角都得打到它自己或它的非媒体后代（没被别的层盖住、取样处不是图 / 视频 / 画布）
    const pts = [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]];
    // 打到的后代自己不能有底色（开关中间那颗白圆钮这种会把中位数带走）
    const bare = (h) => { for (let e = h; e && e !== el; e = e.parentElement) { const b = parse(getComputedStyle(e).backgroundColor); if (b && b.a > 0.01) return false; if (getComputedStyle(e).backgroundImage !== 'none') return false; } return true; };
    if (!pts.every(([fx, fy]) => { const h = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy); return h && (h === el || el.contains(h)) && !h.closest('img, video, canvas, svg') && bare(h); })) continue;
    // 取样区里压着图的也不要（中位数会被图的颜色带偏）
    const ir = { l: r.left + r.width * 0.25, r: r.left + r.width * 0.75, t: r.top + r.height * 0.25, b: r.top + r.height * 0.75 };
    // 取样区里压着图、或者压着自带底色的后代（开关的白圆钮——点按区的 ::after 盖在上面，elementFromPoint 看不出来）也不要
    const over = (m) => { const b = m.getBoundingClientRect(); return b.width > 0 && b.right > ir.l && b.left < ir.r && b.bottom > ir.t && b.top < ir.b; };
    if ([...el.querySelectorAll('img, video, canvas')].some(over)) continue;
    if ([...el.querySelectorAll('*')].slice(0, 300).some((m) => { const b = parse(getComputedStyle(m).backgroundColor); return ((b && b.a > 0.01) || getComputedStyle(m).backgroundImage !== 'none') && over(m); })) continue;
    solids.push({ sel: (el.className && String(el.className).split(' ')[0]) || el.tagName.toLowerCase(), rect: R(r), rgb: bg.rgb });
  }
  // 文字探针：最上层露着的文字（字号 ≥ 12、颜色不太淡），截图里那块不该是一片纯色
  const texts = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n && texts.length < 24; n = tw.nextNode()) {
    const t = n.nodeValue.trim();
    if (t.length < 2) continue;
    const p = n.parentElement;
    if (!p || p.closest('svg, style, script, [aria-hidden="true"]') || !visible(p)) continue;
    const s = getComputedStyle(p);
    const col = parse(s.color);
    if (!col || col.a < 0.3 || parseFloat(s.fontSize) < 12) continue;
    const rg = document.createRange(); rg.selectNodeContents(n);
    const rc = [...rg.getClientRects()].find((x) => x.width >= 20 && x.height >= 10);
    if (!rc || rc.left < 0 || rc.top < 0 || rc.right > innerWidth || rc.bottom > innerHeight) continue;
    const h = document.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2);
    if (!h || !(h === p || p.contains(h) || h.contains(p))) continue;
    // 盖在上面的半透明 / 渐隐层（毛玻璃顶栏、mask 渐隐区）会把字抹淡，离视口上下边 40px 内的不取
    if (rc.top < 40 || rc.bottom > innerHeight - 40) continue;
    texts.push({ t: t.slice(0, 12), rect: R(rc) });
  }
  const topEl = document.querySelector('.studio-root .sd-top');
  let tr = topEl && topEl.getBoundingClientRect();
  // 顶栏得真露在最上层（sheet 的遮罩、抽屉盖着时它那一条不能拿来比平铺）
  if (tr) { const h = document.elementFromPoint(tr.left + tr.width / 2, tr.bottom - 8); if (!h || !topEl.contains(h)) tr = null; }
  const page = document.querySelector('.studio-root .sd-page.on');
  const q = (s) => page && page.querySelector(s);
  const rr = (e) => (e ? R(e.getBoundingClientRect()) : null);
  return {
    dpr, vw: innerWidth, vh: innerHeight,
    top: tr && tr.height > 20 ? R(tr) : null,
    solids, texts,
    dom: { page: page && page.getAttribute('aria-label'), composer: rr(q('.cp')), field: rr(q('.cp-field')), canvas: rr(q('.cf-scroll')), emptyTitle: rr(q('.em h3')), chips: rr(q('.cf-chips')) },
  };
};
`;

/** buf：JPEG 截图；p：__qaShotProbes() 的结果。返回 { ok, problems[], checked } */
export async function checkShot(buf, p) {
  if (!sharp || !p) return null;
  const img = sharp(buf);
  const { width: W, height: H } = await img.metadata();
  const { data } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const k = W / p.vw;   // 设备像素 / CSS 像素
  const px = (x, y) => { const i = (y * W + x) * 3; return [data[i], data[i + 1], data[i + 2]]; };
  const problems = [];
  // 1. 色块探针
  let bad = 0, checked = 0;
  for (const s of p.solids) {
    const x0 = Math.round((s.rect.x + s.rect.w * 0.25) * k), x1 = Math.round((s.rect.x + s.rect.w * 0.75) * k);
    const y0 = Math.round((s.rect.y + s.rect.h * 0.25) * k), y1 = Math.round((s.rect.y + s.rect.h * 0.75) * k);
    if (x1 - x0 < 4 || y1 - y0 < 4 || x1 > W || y1 > H) continue;
    // 取「出现最多的那种颜色」（按 8 级量化分桶，再取桶里的平均）：字多的小按钮上，中位数会被字带偏，众数还是底色
    const buckets = new Map();
    const step = Math.max(1, Math.floor((x1 - x0) / 24));
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const c = px(x, y); const key = (c[0] >> 3) * 1024 + (c[1] >> 3) * 32 + (c[2] >> 3);
      const b = buckets.get(key) || [0, 0, 0, 0]; b[0] += c[0]; b[1] += c[1]; b[2] += c[2]; b[3]++; buckets.set(key, b);
    }
    let best = null; for (const b of buckets.values()) if (!best || b[3] > best[3]) best = b;
    const med = [0, 1, 2].map((i) => Math.round(best[i] / best[3]));
    const d = Math.max(...med.map((v, i) => Math.abs(v - s.rgb[i])));
    checked++;
    // 大块（≥ 60×40）按严格阈值；小块里字占比高、JPEG 色度压缩会把中位数带偏几个单位，放宽
    const tol = s.rect.w >= 60 && s.rect.h >= 40 ? 10 : 14;
    if (d > tol) { bad++; problems.push('色块 ' + s.sel + ' 截图里是 rgb(' + med.join(',') + ')，页面上是 rgb(' + s.rgb.map(Math.round).join(',') + ')'); }
  }
  // 1b. 文字探针：DOM 里露着字的那块，截图里亮度标准差太小（一片纯色）＝字没画出来
  let tbad = 0, tchecked = 0;
  for (const s of p.texts || []) {
    const x0 = Math.max(0, Math.round(s.rect.x * k)), x1 = Math.min(W, Math.round((s.rect.x + s.rect.w) * k));
    const y0 = Math.max(0, Math.round(s.rect.y * k)), y1 = Math.min(H, Math.round((s.rect.y + s.rect.h) * k));
    if (x1 - x0 < 6 || y1 - y0 < 6) continue;
    let n = 0, sum = 0, sq = 0;
    const st = Math.max(1, Math.floor((x1 - x0) / 60));
    for (let y = y0; y < y1; y += st) for (let x = x0; x < x1; x += st) { const c = px(x, y); const l = (c[0] + c[1] + c[2]) / 3; n++; sum += l; sq += l * l; }
    const sd = Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
    tchecked++;
    if (sd < 4) { tbad++; if (tbad <= 3) problems.push('文字「' + s.t + '」那块在截图里是一片纯色'); }
  }
  // 2. 顶栏平铺：顶栏里有字的那一截（下半部的标签行或上面的标题行）在更下面原样出现
  if (p.top) {
    const bandH = Math.max(8, Math.round(Math.min(p.top.h, 44) * k * 0.5));
    const by = Math.round((p.top.y + p.top.h) * k) - bandH - Math.round(4 * k);
    const cols = 96, sx = W / cols;
    const band = (y) => { const out = new Float32Array(cols * 4); for (let r = 0; r < 4; r++) { const yy = Math.min(H - 1, y + Math.round(r * bandH / 4)); for (let c = 0; c < cols; c++) { const v = px(Math.floor(c * sx), yy); out[r * cols + c] = (v[0] + v[1] + v[2]) / 3; } } return out; };
    const ref = band(by);
    const mean = ref.reduce((a, b) => a + b, 0) / ref.length;
    const varr = ref.reduce((a, b) => a + (b - mean) ** 2, 0) / ref.length;
    if (varr > 40) {   // 这一截得有内容（字、下划线），纯底色的带子到处都一样，不能拿来比
      const from = Math.round((p.top.y + p.top.h) * k) + bandH;
      for (let y = from; y < H - bandH; y += 2) {
        const b = band(y);
        let mad = 0; for (let i = 0; i < b.length; i++) mad += Math.abs(b[i] - ref[i]);
        mad /= b.length;
        if (mad < 2) { problems.push('顶栏那一条在画面 y=' + Math.round(y / k) + ' 处原样重复（截图平铺）'); break; }
      }
    }
  }
  // 平铺：一处就算坏；色块：错两处以上（或总共只查了一两处、错了一处）才算坏，单个探针偶尔误判不拦
  const tiled = problems.some((x) => x.startsWith('顶栏'));
  const colorBad = bad >= 2 || (checked + tchecked <= 2 && bad >= 1);
  const textBad = tbad >= 3 || (tchecked > 0 && tbad / tchecked > 0.3);
  return { ok: !tiled && !colorBad && !textBad, problems, checked: checked + tchecked, bad: bad + tbad };
}
