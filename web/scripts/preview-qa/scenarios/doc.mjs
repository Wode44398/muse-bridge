// 文档类（PDF / Office）改版验收：真手势（CDP 鼠标、触摸、按键、输入法上屏），结论看数值，截图佐证。
//   PDF：文本层可选中、查找计数与跳转、Ctrl+滚轮 / 双指以指下为锚、页码跟滚动、页码跳转、缩略图与书签、页内链接、
//        加密 PDF 密码框（错一次、对一次）、300 页画布数量有上限。
//   Office：docx / pptx 冷转换的进度文案、pptx 翻页与全屏放映、xlsx 冻结窗格与两万行虚拟滚动帧率。
// 页面状态读 .pdf-root 的 data-*（phase / page / pages / scale / mode）与 .sg-root（表格）的 data-*。
import * as C from '../lib/checks.mjs';

const PDF300 = '文档/300页-书签-文本层.pdf';
const ENC = '文档/加密-密码1234.pdf';

const ST = `(() => { const r = __pvqa.root()?.querySelector('.pdf-root'); if (!r) return null; const d = r.dataset; return { phase: d.phase, page: +d.page, pages: +d.pages, scale: +d.scale, mode: d.mode }; })()`;
const st = (ctx) => ctx.eval(ST);
const ready = (ctx, ms = 30000) => ctx.waitFor(`(() => { const s = ${ST}; return s && s.phase === 'ready' && s.pages > 0 ? s : null; })()`, ms, 'PDF 就绪');
// 第 n 页画布画出来了
const pageDrawn = (ctx, n, ms = 20000) => ctx.waitFor(`(() => { const c = __pvqa.root()?.querySelector('.pdf-root .page[data-page-number="${n}"] canvas:not([hidden])'); return c && c.width > 0 && __pvqa.canvasDrawn(c) ? { w: c.width, h: c.height } : null; })()`, ms, `第 ${n} 页画布`);
// 视口里露得最多的页（按几何独立算一遍，核对 data-page）
const GEOM_PAGE = `(() => { const sc = __pvqa.root()?.querySelector('.pdf-scroll'); if (!sc) return 0; const R = sc.getBoundingClientRect(); let best = 0, ba = -1;
  for (const p of sc.querySelectorAll('.page')) { const r = p.getBoundingClientRect(); const w = Math.max(0, Math.min(r.right, R.right) - Math.max(r.left, R.left)); const h = Math.max(0, Math.min(r.bottom, R.bottom) - Math.max(r.top, R.top)); const a = w * h; if (a > ba + 1) { ba = a; best = +p.dataset.pageNumber; } }
  if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 && sc.scrollTop > 0) { const all = [...sc.querySelectorAll('.page')]; return +all[all.length - 1].dataset.pageNumber; }
  return best; })()`;
// 记下屏幕点 (x, y) 落在哪页哪个比例位置；之后取同一内容点现在的屏幕坐标
const markAt = (ctx, x, y) => ctx.eval(`(() => { const el = document.elementFromPoint(${x}, ${y})?.closest('.page'); if (!el) return null; const r = el.getBoundingClientRect(); return (window.__docMark = { n: el.dataset.pageNumber, fx: (${x} - r.left) / r.width, fy: (${y} - r.top) / r.height }); })()`);
const markNow = (ctx) => ctx.eval(`(() => { const m = window.__docMark; if (!m) return null; const el = __pvqa.root()?.querySelector('.pdf-root .page[data-page-number="' + m.n + '"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + m.fx * r.width, y: r.top + m.fy * r.height }; })()`);
// 锚点漂移：dx / dy 与滚动是否顶到边（页面比视口窄居中、或滚到头时，锚点本来就留不住，那一维不计）
const driftAt = async (ctx, p) => {
  const q = await markNow(ctx);
  if (!q) return null;
  const b = await ctx.eval(`(() => { const sc = __pvqa.root().querySelector('.pdf-scroll'); const mx = sc.scrollWidth - sc.clientWidth, my = sc.scrollHeight - sc.clientHeight; return { px: sc.scrollLeft <= 0.5 || sc.scrollLeft >= mx - 0.5, py: sc.scrollTop <= 0.5 || sc.scrollTop >= my - 0.5 }; })()`);
  const dx = Math.round(q.x - p.x), dy = Math.round(q.y - p.y);
  return { dx, dy, pinX: b.px, pinY: b.py, ok: (Math.abs(dx) <= 12 || b.px) && (Math.abs(dy) <= 12 || b.py), strict: Math.abs(dx) <= 12 && Math.abs(dy) <= 12 };
};
const typeText = (ctx, text) => ctx.pg.send('Input.insertText', { text });
const scrollerRect = (ctx) => ctx.eval(`(() => { const r = __pvqa.root()?.querySelector('.pdf-scroll')?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; })()`);
const tool = (ctx, label) => ctx.g.tapSel(`button[aria-label^="${label}"]`, { within: ctx.ROOT_SEL });

async function openPdf(ctx, rel, kind = 'pdf') {
  const t0 = Date.now();
  await ctx.open([ctx.item(rel, { kind })], 0);
  const s = await ready(ctx);
  await pageDrawn(ctx, s.page || 1);
  ctx.metric('openMs', Date.now() - t0);
  return s;
}

const PDF = [
  {
    id: 'doc-pdf-text',
    title: 'PDF：文本层可选中、页内链接可跳、默认缩放不过宽',
    tags: ['doc', 'pdf'],
    async run(ctx) {
      const s0 = await openPdf(ctx, PDF300);
      ctx.metric('initial', s0);
      // 默认档：电脑宽屏不再铺满（自动 ≤ 125%），手机按宽
      const pageW = await ctx.eval(`Math.round(__pvqa.root().querySelector('.pdf-root .page').getBoundingClientRect().width)`);
      ctx.metric('pageCssW', pageW);
      if (!ctx.touch) ctx.assert('电脑默认缩放 ≤ 125%', s0.scale <= 1.251, s0.scale);
      else ctx.assert('手机默认按页宽（页宽 ≥ 视口 90%）', pageW >= ctx.cfg.w * 0.9, pageW);
      const spans = await ctx.waitFor(`(() => { const n = __pvqa.root()?.querySelectorAll('.pdf-root .page[data-page-number="1"] .textLayer span').length; return n > 5 ? n : 0; })()`, 15000, '文本层').catch(() => 0);
      ctx.assert('第 1 页有文本层', spans > 5, spans);
      // 真鼠标拖选第一行正文
      if (!ctx.touch) {
        const r = await ctx.eval(`(() => { const sp = [...__pvqa.root().querySelectorAll('.pdf-root .page[data-page-number="1"] .textLayer span')].find((s) => s.textContent.includes('可选中的文本层')); if (!sp) return null; const b = sp.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width }; })()`);
        let sel = '';
        if (r) {
          await ctx.g.drag({ x: r.x + 1, y: r.y }, { x: r.x + Math.min(r.w, 260), y: r.y }, { ms: 260 });
          await ctx.sleep(200);
          sel = await ctx.eval(`String(getSelection())`);
        }
        ctx.metric('selected', sel.slice(0, 40));
        ctx.assert('鼠标拖选拿到文字', sel.includes('可选中'), sel.slice(0, 40));
        await ctx.shot('select');
        await ctx.eval(`(getSelection().removeAllRanges(), 1)`);
      }
      // 页内链接：第 1 页底部「跳到第 31 页」
      await ctx.eval(`(() => { const a = __pvqa.root().querySelector('.pdf-root .page[data-page-number="1"] .annotationLayer a'); a?.scrollIntoView({ block: 'center' }); return !!a; })()`);
      await ctx.sleep(400);
      const link = await ctx.eval(`(() => { const a = __pvqa.root().querySelector('.pdf-root .page[data-page-number="1"] .annotationLayer a'); if (!a) return null; const b = a.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      ctx.assert('页内链接层存在', !!link, link);
      if (link) {
        await ctx.g.tap(link.x, link.y);
        const s1 = await ctx.waitFor(`(() => { const s = ${ST}; return s && s.page === 31 ? s : null; })()`, 5000, '跳到 31 页').catch(() => null);
        ctx.assert('点内链跳到第 31 页', !!s1, (await st(ctx))?.page);
      }
    },
  },
  {
    id: 'doc-pdf-find',
    title: 'PDF：Ctrl+F / 查找钮、命中计数、上下一个、Esc 关闭',
    tags: ['doc', 'pdf'],
    async run(ctx) {
      await openPdf(ctx, PDF300);
      if (ctx.touch) await tool(ctx, '查找'); else await ctx.g.key('ctrl+f');
      const opened = await ctx.waitFor(`(() => { const i = __pvqa.root()?.querySelector('.fb input'); return i && document.activeElement === i ? true : null; })()`, 4000, '查找框聚焦').catch(() => false);
      ctx.assert('查找框打开并聚焦', !!opened, opened);
      if (ctx.touch) {
        const pos = await ctx.eval(`(() => { const b = __pvqa.root().querySelector('.fb')?.getBoundingClientRect(); const bar = __pvqa.root().querySelector('.vw-bar')?.getBoundingClientRect(); return b && { top: Math.round(b.top), barBottom: Math.round(bar?.bottom ?? 0), h: Math.round(b.height) }; })()`);
        ctx.metric('findBarPos', pos);
        ctx.assert('手机查找条在顶栏下方', pos && pos.top >= pos.barBottom - 1, pos);
      }
      await typeText(ctx, '样张123');
      const res = await ctx.waitFor(`(() => { const s = ${ST}; const hl = __pvqa.root().querySelectorAll('.pdf-root .textLayer .highlight').length; const cnt = __pvqa.root().querySelector('.fb-count')?.textContent?.trim(); return s && s.page === 123 && hl > 0 && /18/.test(cnt || '') ? { page: s.page, hl, cnt } : null; })()`, 20000, '命中 18 处并跳到 123 页').catch(() => null);
      ctx.metric('find', res);
      ctx.assert('「样张123」命中 18 处、跳到第 123 页并高亮', !!res, res || (await st(ctx)));
      await ctx.g.key('enter');
      await ctx.sleep(400);
      const c2 = await ctx.eval(`__pvqa.root().querySelector('.fb-count')?.textContent?.trim()`);
      ctx.assert('Enter 到第 2 处', /^2\D/.test(c2 || ''), c2);
      await ctx.g.key('shift+enter');
      await ctx.sleep(400);
      const c1 = await ctx.eval(`__pvqa.root().querySelector('.fb-count')?.textContent?.trim()`);
      ctx.assert('Shift+Enter 回第 1 处', /^1\D/.test(c1 || ''), c1);
      await ctx.shot('found');
      await ctx.g.key('escape');
      await ctx.sleep(400);
      const after = await ctx.eval(`({ bar: !!__pvqa.root()?.querySelector('.fb input'), hl: __pvqa.root()?.querySelectorAll('.pdf-root .textLayer .highlight').length || 0, open: __pvqa.pv.preview.open })`);
      ctx.assert('Esc 关掉查找条与高亮、查看器还开着', !after.bar && after.hl === 0 && after.open, after);
    },
  },
  {
    id: 'doc-pdf-zoom',
    title: 'PDF：Ctrl+滚轮 / 双指以指下为锚、按钮与快捷键、双击切换',
    tags: ['doc', 'pdf', 'zoom'],
    async run(ctx) {
      const s0 = await openPdf(ctx, PDF300);
      const R = await scrollerRect(ctx);
      const p = { x: Math.round(R.x + R.w * 0.66), y: Math.round(R.y + R.h * 0.4) };
      await markAt(ctx, p.x, p.y);
      if (!ctx.touch) {
        await ctx.g.wheel(p.x, p.y, { dy: -120, ctrl: true, ticks: 3, gap: 50 });
        await ctx.sleep(900);
      } else {
        await ctx.g.pinch(p, 2, { steps: 14, ms: 360 });
        await ctx.sleep(900);
      }
      const s1 = await st(ctx);
      const d1 = await driftAt(ctx, p);
      ctx.metric('zoom', { from: s0.scale, to: s1.scale, drift: d1 });
      ctx.assert(ctx.touch ? '双指放大' : 'Ctrl+滚轮放大', s1.scale > s0.scale * 1.2, s1.scale);
      ctx.assert('缩放锚点漂移 ≤ 12px（顶到滚动边的那一维除外）', d1?.ok, d1);
      // 已放大、四周都有滚动余量时再缩放一次：锚点必须严格留在指下
      await ctx.eval(`(() => { const sc = __pvqa.root().querySelector('.pdf-scroll'); sc.scrollTop += 700; sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2; return 1; })()`);
      await ctx.sleep(300);
      const p2 = { x: Math.round(R.x + R.w * 0.42), y: Math.round(R.y + R.h * 0.6) };
      await markAt(ctx, p2.x, p2.y);
      if (!ctx.touch) await ctx.g.wheel(p2.x, p2.y, { dy: -120, ctrl: true, ticks: 2, gap: 50 });
      else await ctx.g.pinch(p2, 1.4, { steps: 12, ms: 300 });
      await ctx.sleep(900);
      const d2 = await driftAt(ctx, p2);
      ctx.metric('zoom2', { scale: (await st(ctx)).scale, drift: d2 });
      ctx.assert('有余量时锚点严格不漂（≤ 12px）', d2?.strict, d2);
      const vv = await ctx.eval(`visualViewport.scale`);
      ctx.assert('没有触发浏览器整页缩放', vv === 1, vv);
      const drawn = await pageDrawn(ctx, (await st(ctx)).page, 8000).catch(() => null);
      ctx.assert('放大后重画清晰（画布宽 ≥ CSS 宽）', !!drawn, drawn);
      await ctx.shot('zoomed');
      if (!ctx.touch) {
        await ctx.g.key('ctrl+=');
        await ctx.sleep(500);
        const s2 = await st(ctx);
        ctx.assert('Ctrl+= 放大一档', s2.scale > s1.scale, s2.scale);
        await ctx.g.key('ctrl+-');
        await ctx.g.key('ctrl+-');
        await ctx.sleep(500);
        const s3 = await st(ctx);
        ctx.assert('Ctrl+- 缩小', s3.scale < s2.scale, s3.scale);
        await ctx.g.key('ctrl+0');
        await ctx.sleep(500);
        const s4 = await st(ctx);
        ctx.assert('Ctrl+0 回到自动', s4.mode === 'auto' && Math.abs(s4.scale - s0.scale) < 0.01, s4);
        // 浮条百分比按钮 → 适应页面
        await ctx.g.tapSel('.vw-float .pdf-pct', { within: ctx.ROOT_SEL });
        await ctx.sleep(300);
        await ctx.g.tapSel('.vw-pop-it', { text: '适应页面' });
        await ctx.sleep(500);
        const s5 = await st(ctx);
        const fits = await ctx.eval(`(() => { const sc = __pvqa.root().querySelector('.pdf-scroll'); const pg = __pvqa.root().querySelector('.pdf-root .page[data-page-number="' + ${ST}.page + '"]').getBoundingClientRect(); return pg.height <= sc.clientHeight; })()`);
        ctx.assert('适应页面：整页放得下', s5.mode === 'page-fit' && fits, s5);
        const vv2 = await ctx.eval(`visualViewport.scale`);
        ctx.assert('Ctrl+= / Ctrl+- 没被浏览器拿去缩放页面', vv2 === 1, vv2);
      } else {
        // 双击：放大过 → 回到适应宽度；再双击 → 2 倍
        await ctx.g.doubleTap(p.x, p.y);
        await ctx.sleep(700);
        const s2 = await st(ctx);
        ctx.assert('双击回到适应宽度', s2.mode === 'auto' && Math.abs(s2.scale - s0.scale) < 0.02, s2);
        await markAt(ctx, p.x, p.y);
        await ctx.g.doubleTap(p.x, p.y);
        await ctx.sleep(700);
        const s3 = await st(ctx);
        const q3 = await markNow(ctx);
        const d3 = q3 ? Math.round(Math.hypot(q3.x - p.x, q3.y - p.y)) : null;
        ctx.assert('再双击放大到约 2 倍、点击处不漂', Math.abs(s3.scale / s0.scale - 2) < 0.05 && d3 != null && d3 <= 12, { scale: s3.scale, drift: d3 });
      }
    },
  },
  {
    id: 'doc-pdf-nav',
    title: 'PDF：页码跟随滚动、输入页码跳转、Home/End、缩略图与书签',
    tags: ['doc', 'pdf'],
    async run(ctx) {
      await openPdf(ctx, PDF300);
      const R = await scrollerRect(ctx);
      const c = { x: R.x + R.w / 2, y: R.y + R.h / 2 };
      if (!ctx.touch) await ctx.g.wheel(c.x, c.y, { dy: 120, ticks: 24, gap: 30 });
      else { for (let i = 0; i < 3; i++) { await ctx.g.swipe({ x: c.x, y: R.y + R.h * 0.8 }, { x: c.x, y: R.y + R.h * 0.2 }, { ms: 180 }); await ctx.sleep(250); } }
      await ctx.sleep(1200);
      const s1 = await st(ctx), g1 = await ctx.eval(GEOM_PAGE);
      ctx.metric('afterScroll', { page: s1.page, geom: g1 });
      ctx.assert('滚动后页码跟上（与几何一致、> 1）', s1.page > 1 && s1.page === g1, { page: s1.page, geom: g1 });
      // 页码框输入 150 回车
      const box = ctx.touch ? '.vw-bottom .pg-in' : '.vw-float .pg-in';
      await ctx.g.tapSel(box, { within: ctx.ROOT_SEL });
      await ctx.sleep(200);
      await typeText(ctx, '150');
      await ctx.g.key('enter');
      await ctx.sleep(700);
      const s2 = await st(ctx), g2 = await ctx.eval(GEOM_PAGE);
      ctx.assert('输入 150 回车跳到第 150 页', s2.page === 150 && g2 === 150, { page: s2.page, geom: g2 });
      await pageDrawn(ctx, 150, 8000).catch(() => null);
      await ctx.shot('page150');
      if (!ctx.touch) {
        await ctx.eval(`(document.activeElement?.blur?.(), 1)`);
        await ctx.g.key('end');
        await ctx.sleep(600);
        const s3 = await st(ctx);
        ctx.assert('End 到最后一页', s3.page === 300, s3.page);
        await ctx.g.key('home');
        await ctx.sleep(600);
        const s4 = await st(ctx);
        ctx.assert('Home 回第一页', s4.page === 1, s4.page);
        await ctx.g.key('pagedown');
        await ctx.sleep(500);
        ctx.assert('PageDown 下一页', (await st(ctx)).page === 2, (await st(ctx)).page);
      }
      // 侧栏缩略图：点第 5 张（电脑侧栏可能已开；默认是缩略图页签）
      const sideOpen = await ctx.eval(`!!document.querySelector('.ps, .ps-sheet')`);
      if (!sideOpen) await tool(ctx, '侧栏');
      await ctx.sleep(400);
      if (!(await ctx.eval(`!!document.querySelector('.ts-it[data-n="5"]')`))) {
        if (ctx.touch) await ctx.g.tapSel('.ps-seg button', { text: '缩略图' }); else await ctx.g.tapSel('.ps-tab', { text: '缩略图' });
      }
      await ctx.waitFor(`!!document.querySelector('.ts-it[data-n="5"]')`, 5000, '缩略图');
      await ctx.sleep(500);
      const thumbsDrawn = await ctx.waitFor(`(() => { const n = document.querySelectorAll('.ts-it img').length; return n >= 3 ? n : 0; })()`, 8000, '缩略图出图').catch(() => 0);
      ctx.assert('缩略图画出来了', thumbsDrawn >= 3, thumbsDrawn);
      await ctx.shot('thumbs');
      await ctx.g.tapSel('.ts-it[data-n="5"]');
      await ctx.sleep(700);
      const s5 = await st(ctx);
      ctx.assert('点缩略图 5 跳到第 5 页', s5.page === 5, s5.page);
      // 书签：「第 7 节」→ 61 页（样张的章标题被 reportlab 同名 key 覆盖成了节标题，以文件为准）
      if (ctx.touch) {
        await tool(ctx, '侧栏');
        await ctx.sleep(500);
        await ctx.g.tapSel('.ps-seg button', { text: '书签' });
      } else {
        const open = await ctx.eval(`!!document.querySelector('.ps')`);
        if (!open) await tool(ctx, '侧栏');
        await ctx.g.tapSel('.ps-tab', { text: '书签' });
      }
      await ctx.sleep(500);
      await ctx.g.tapSel('.po-row, [role="treeitem"]', { text: '第 7 节' });
      await ctx.sleep(800);
      const s6 = await st(ctx);
      ctx.assert('点书签「第 7 节」跳到第 61 页', s6.page === 61, s6.page);
      const lit = await ctx.eval(`(() => { const el = document.querySelector('.po-row.on, [role="treeitem"][aria-current="true"], [role="treeitem"].on'); return el ? el.textContent.trim().slice(0, 20) : null; })()`);
      ctx.metric('outlineActive', lit);
      await ctx.shot('outline');
    },
  },
  {
    id: 'doc-pdf-password',
    title: '加密 PDF：密码框、错一次提示、输对打开',
    tags: ['doc', 'pdf'],
    async run(ctx) {
      await ctx.open([ctx.item(ENC, { kind: 'pdf' })], 0);
      const has = await ctx.waitFor(`!!document.querySelector('input[type=password]')`, 12000, '密码框').catch(() => false);
      ctx.assert('给出密码输入框', has, has);
      if (!has) return;
      await ctx.sleep(400);
      await ctx.g.tapSel('input[type=password]');
      await typeText(ctx, '0000');
      await ctx.g.key('enter');
      const wrong = await ctx.waitFor(`(document.body.innerText || '').includes('密码不正确')`, 6000, '错误提示').catch(() => false);
      ctx.assert('密码错误有提示', wrong, wrong);
      const cleared = await ctx.eval(`document.querySelector('input[type=password]')?.value === ''`);
      ctx.assert('输错后框清空', cleared, cleared);
      await ctx.shot('wrong');
      await ctx.g.tapSel('input[type=password]');
      await typeText(ctx, '1234');
      await ctx.g.key('enter');
      const s = await ready(ctx, 15000).catch(() => null);
      ctx.assert('输对密码打开', !!s, s);
      if (s) await pageDrawn(ctx, 1, 10000).catch(() => null);
      await ctx.shot('opened');
    },
  },
  {
    id: 'doc-pdf-300',
    title: 'PDF 300 页：一路翻到底，画布数量与像素有上限',
    tags: ['doc', 'pdf', 'perf'],
    async run(ctx) {
      await openPdf(ctx, PDF300);
      const sample = () => ctx.eval(`(() => { const cs = [...__pvqa.root().querySelectorAll('.pdf-root .pdfViewer canvas')]; const px = cs.reduce((a, c) => a + c.width * c.height, 0); return { n: cs.length, mp: Math.round(px / 1e5) / 10 }; })()`);
      const seen = [];
      for (const n of [40, 90, 150, 210, 260, 300]) {
        await ctx.eval(`(() => { const el = __pvqa.root().querySelector('.pdf-root .page[data-page-number="${n}"]'); el?.scrollIntoView({ block: 'start' }); return 1; })()`);
        await ctx.sleep(500);
        await pageDrawn(ctx, n, 8000).catch(() => null);
        seen.push({ at: n, ...(await sample()) });
      }
      const maxN = Math.max(...seen.map((x) => x.n)), maxMp = Math.max(...seen.map((x) => x.mp));
      ctx.metric('canvases', seen);
      ctx.assert('任何时刻画布 ≤ 14 张', maxN <= 14, maxN);
      ctx.assert(`画布总像素有上限（≤ ${ctx.touch ? 60 : 160} MP）`, maxMp <= (ctx.touch ? 60 : 160), maxMp);
      const s = await st(ctx);
      ctx.assert('翻到底页码是 300', s.page === 300, s.page);
      await ctx.shot('end');
    },
  },
];

// —— Office ——————————————————————————————————————————————————————————————
// OfficeView 根 .of-root 的 data-phase：loading | convert | sheet | word | slides | error；转好的 PDF 换成 .pdf-root（word / slides 类）。
const OF = `(() => { const r = __pvqa.root(); if (!r) return null; const o = r.querySelector('.of-root'); const p = r.querySelector('.pdf-root');
  return { phase: p ? 'pdf' : (o?.dataset.phase || null), conv: o?.dataset.conv || '', text: o?.querySelector('.of-conv-t')?.textContent?.trim() || '',
    pdf: p ? { phase: p.dataset.phase, page: +p.dataset.page, pages: +p.dataset.pages, mode: p.dataset.mode, slides: p.classList.contains('slides'), word: p.classList.contains('word') } : null }; })()`;
const ofState = (ctx) => ctx.eval(OF);
const pdfReady = (ctx, ms = 150000) => ctx.waitFor(`(() => { const s = ${OF}; return s && s.pdf && s.pdf.phase === 'ready' && s.pdf.pages > 0 ? s.pdf : null; })()`, ms, '转换出的 PDF 就绪');
const CONV_RE = /^(正在转换 · 已用 \d+ 秒|排队中 · 前面还有 \d+ 个|排队中|正在转换)$/;
const secs = (s) => +((/(\d+) 秒/.exec(s || '') || [])[1] ?? -1);
// 不送服务端转换的同一份字节：改个扩展名（docm / ppsx 服务端不认、客户端认），稳定地走快速预览这条路
const quickItem = (ctx, rel, name) => ({ ...ctx.item(rel, { kind: 'office' }), name, key: 'quick:' + name });
// 窄屏触屏（< 640）的 docx 默认是阅读视图：按屏宽重排、不送服务端转 PDF（OfficeView 的 bridge.docx.layout 偏好）。
// 测服务端 PDF 这条路的场景先把偏好钉成「打印版式」，跑完删掉，不串到后面的场景
const LAYOUT_KEY = 'bridge.docx.layout';
const narrowTouch = (ctx) => !!ctx.touch && ctx.cfg.w < 640;
async function withPrintLayout(ctx, fn) {
  if (!narrowTouch(ctx)) return fn();
  await ctx.eval(`localStorage.setItem('${LAYOUT_KEY}', 'print')`);
  try { return await fn(); } finally { await ctx.eval(`localStorage.removeItem('${LAYOUT_KEY}')`).catch(() => {}); }
}
// 打开查看器的「更多」菜单点名字含 text 的那一项（同 entry.mjs：等落点真命中菜单项、隔两帧位置不动再点）
async function menuPick(ctx, text) {
  await ctx.g.tapSel('.vw-btn[aria-haspopup="menu"]', { within: ctx.ROOT_SEL });
  const c = await ctx.waitFor(`(async () => {
    const at = () => { const it = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
      if (!it) return null; const b = it.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const h = document.elementFromPoint(x, y); return { x, y, ok: !!h && (h === it || it.contains(h)) }; };
    const a = at(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const b = at();
    return a && b && b.ok && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 ? b : null; })()`, 5000, '菜单「' + text + '」可点');
  await ctx.g.tap(c.x, c.y);
  // 等菜单收起、挡板撤掉再往下点（收起动效期间 .mm-barrier 还盖着整屏，转换已缓存时 PDF 比它先就绪）
  await ctx.waitFor(`document.querySelectorAll('[role=menuitem]').length === 0 && ![...document.querySelectorAll('.mm-barrier')].some((b) => getComputedStyle(b).pointerEvents !== 'none' && getComputedStyle(b).visibility === 'visible')`, 4000, '菜单收起').catch(() => {});
}
// 阅读视图（WordDoc 按屏宽排）就绪：标题数、是否横向溢出
const REFLOW = `(() => { const s = ${OF}; const w = __pvqa.root()?.querySelector('.wd'); const sc = w?.querySelector('.wd-scroll');
  return s?.phase === 'word' && w && +w.dataset.heads > 0 && sc ? { heads: +w.dataset.heads, sw: sc.scrollWidth, vw: sc.clientWidth, pdf: !!__pvqa.root().querySelector('.pdf-root') } : null; })()`;

// 幻灯片（PdfView slides 与 PptDeck 共用）：当前页 / 总页
const SLIDE = `(() => { const r = __pvqa.root(); const p = r?.querySelector('.pdf-root.slides'); if (p) return { kind: 'pdf', cur: +p.dataset.page, n: +p.dataset.pages };
  const d = r?.querySelector('.pd'); return d ? { kind: 'deck', cur: +d.dataset.slide, n: +d.dataset.slides } : null; })()`;
const slideAt = (ctx) => ctx.eval(SLIDE);
const SHOW = `(() => { const s = document.querySelector('.ss'); if (!s) return null; const b = s.querySelector('.ss-badge')?.textContent?.trim() || ''; const m = /(\\d+) \\/ (\\d+)/.exec(b); return { cur: m ? +m[1] : 0, n: m ? +m[2] : 0, end: !!s.querySelector('.ss-end'), fs: !!document.fullscreenElement }; })()`;
async function flip(ctx, dir = 1) {
  if (!ctx.touch) return ctx.g.key(dir > 0 ? 'right' : 'left');
  const { w, h } = ctx.cfg;
  const a = { x: w * 0.78, y: h * 0.45 }, b = { x: w * 0.22, y: h * 0.45 };
  return dir > 0 ? ctx.g.swipe(a, b, { ms: 180, steps: 10 }) : ctx.g.swipe(b, a, { ms: 180, steps: 10 });
}
async function waitSlide(ctx, n, ms = 4000) {
  return ctx.waitFor(`(() => { const s = ${SLIDE}; return s && s.cur === ${n} ? s : null; })()`, ms, '到第 ' + n + ' 张').catch(() => null);
}
// 翻页 + 缩略图 + 放映（两条路同一套手感）
async function deckFlow(ctx, label) {
  const s0 = await slideAt(ctx);
  ctx.assert(label + '：一共 8 张、停在第 1 张', s0 && s0.n === 8 && s0.cur === 1, s0);
  await flip(ctx, 1);
  const s1 = await waitSlide(ctx, 2);
  ctx.assert(label + '：' + (ctx.touch ? '左滑' : '→') + ' 翻到第 2 张', !!s1, await slideAt(ctx));
  if (!ctx.touch) {
    await ctx.g.key('pagedown');
    ctx.assert(label + '：PageDown 到第 3 张', !!(await waitSlide(ctx, 3)), await slideAt(ctx));
    await ctx.g.key('home');
    ctx.assert(label + '：Home 回第 1 张', !!(await waitSlide(ctx, 1)), await slideAt(ctx));
  } else {
    await ctx.sleep(400);
    await flip(ctx, -1);
    ctx.assert(label + '：右滑回第 1 张', !!(await waitSlide(ctx, 1)), await slideAt(ctx));
  }
  // 缩略图：电脑在侧栏（宽窗默认开），触屏在底栏横条
  const sel = ctx.touch ? '.vw-bottom .ts-it[data-n="5"]' : '.ts-it[data-n="5"]';
  if (!ctx.touch && !(await ctx.eval(`!!document.querySelector('.ts-it[data-n="5"]')`))) await tool(ctx, '幻灯片');
  const has = await ctx.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 6000, '缩略图').catch(() => false);
  ctx.assert(label + '：有幻灯片缩略图', has, has);
  if (has) {
    await ctx.sleep(400);
    await ctx.g.tapSel(sel);
    ctx.assert(label + '：点缩略图 5 到第 5 张', !!(await waitSlide(ctx, 5)), await slideAt(ctx));
  }
  await ctx.shot('slide5');
  // 放映：电脑 F5（从头）/ 触屏顶栏「放映」
  if (!ctx.touch) await ctx.g.key('f5'); else await tool(ctx, '放映');
  const sh = await ctx.waitFor(`(() => { const s = ${SHOW}; return s && s.n === 8 ? s : null; })()`, 5000, '放映').catch(() => null);
  ctx.assert(label + '：进入放映（黑底全屏、从第 1 张）', sh && sh.cur === 1, sh);
  if (!sh) return;
  const bg = await ctx.eval(`getComputedStyle(document.querySelector('.ss')).backgroundColor`);
  ctx.assert(label + '：放映黑底', /rgb\(0, 0, 0\)/.test(bg), bg);
  const { w, h } = ctx.cfg;
  await ctx.g.tap(w / 2, h / 2);
  await ctx.sleep(500);
  const a1 = await ctx.eval(SHOW);
  ctx.assert(label + '：单击下一张', a1 && a1.cur === sh.cur + 1, a1);
  if (!ctx.touch) {
    await ctx.g.key('right');
    await ctx.sleep(400);
    const a2 = await ctx.eval(SHOW);
    ctx.assert(label + '：→ 下一张', a2 && a2.cur === sh.cur + 2, a2);
  }
  await ctx.shot('show');
  if (!ctx.touch) await ctx.g.key('escape'); else await ctx.g.tapSel('.ss-x');
  await ctx.sleep(500);
  const after = await ctx.eval(`({ show: !!document.querySelector('.ss'), open: __pvqa.pv.preview.open, fs: !!document.fullscreenElement })`);
  ctx.assert(label + '：' + (ctx.touch ? '点 ×' : 'Esc') + ' 退出放映、查看器还开着', !after.show && after.open && !after.fs, after);
  const back = await slideAt(ctx);
  ctx.metric('afterShow', back);
}

// 表格
const SG = `(() => { const g = __pvqa.root()?.querySelector('.sg'); if (!g) return null; const d = g.dataset;
  return { sheet: d.sheet, rows: +d.rows, cols: +d.cols, freeze: d.freeze, sel: d.sel, zoom: +d.zoom, fx: g.querySelector('.sg-fx-v')?.textContent ?? null }; })()`;
const sg = (ctx) => ctx.eval(SG);
// 单元格中心的屏幕坐标：取「露在最上面」的列头 / 行头（冻结面板会盖住底下那份）
const CELL = (a) => `(() => { const r = __pvqa.root(); const m = /^([A-Z]+)(\\d+)$/.exec(${JSON.stringify(a)}); if (!r || !m) return null;
  const top = (els) => { for (const el of els) { const b = el.getBoundingClientRect(); if (!b.width || !b.height) continue; const x = b.left + b.width / 2, y = b.top + b.height / 2; if (document.elementFromPoint(x, y) === el) return { x, y, b }; } return null; };
  const c = top([...r.querySelectorAll('.sg-ch .hd')].filter((h) => h.textContent === m[1]));
  const w = top([...r.querySelectorAll('.sg-rh .hd')].filter((h) => h.textContent === m[2]));
  if (!c || !w) return null;
  const x = Math.round(c.x), y = Math.round(w.y), el = document.elementFromPoint(x, y)?.closest('td');
  return { x, y, text: el ? el.textContent : '', w: el ? Math.round(el.getBoundingClientRect().width) : 0, h: el ? Math.round(el.getBoundingClientRect().height) : 0 }; })()`;
const cell = (ctx, a) => ctx.eval(CELL(a));
async function tapCell(ctx, a) {
  const p = await cell(ctx, a);
  if (!p) return null;
  await ctx.g.tap(p.x, p.y);
  await ctx.sleep(250);
  return p;
}
const sgReady = (ctx, sheet, ms = 30000) => ctx.waitFor(`(() => { const s = ${SG}; return s && s.rows > 0 && ${sheet ? `s.sheet === ${JSON.stringify(sheet)}` : 'true'} && __pvqa.root().querySelectorAll('.sg td').length > 5 ? s : null; })()`, ms, '表格就绪');
async function pickSheet(ctx, name) {
  const sel = ctx.touch ? '.vw-bottom .st-tab' : '.sg-status .st-tab';
  await ctx.g.tapSel(sel, { text: name });
  return sgReady(ctx, name, 10000).catch(() => null);
}
// 逐帧采样：帧间隔、探针点上有没有画出单元格（空白帧）
const FPS_ARM = (px, py) => `(() => { const s = window.__fps = { d: [], blank: 0, last: 0, on: true }; const tick = (n) => { if (!s.on) return; if (s.last) s.d.push(n - s.last); s.last = n;
  const el = document.elementFromPoint(${px}, ${py}); if (!el || !el.closest('td')) s.blank++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); return 1; })()`;
const FPS_END = `(() => { const s = window.__fps; s.on = false; const d = s.d.slice(1); const tot = d.reduce((a, b) => a + b, 0) || 1; const o = [...d].sort((a, b) => a - b);
  return { frames: d.length, ms: Math.round(tot), fps: Math.round(d.length * 1000 / tot), p95: Math.round(o[Math.floor(o.length * 0.95)] || 0), max: Math.round(o[o.length - 1] || 0), long: d.filter((x) => x > 50).length, blank: s.blank }; })()`;

async function wordPdf(ctx) {
  let t0 = Date.now();
  await ctx.open([ctx.item('文档/报告.docx', { kind: 'office' })], 0);
  if (narrowTouch(ctx)) {
    // 窄屏触屏：默认阅读视图（A4 PDF 铺 393 宽只剩 46%，正文小得没法读），⋯ 里「打印版式」切回原版式 PDF
    const rv = await ctx.waitFor(REFLOW, 30000, '阅读视图').catch(() => null);
    ctx.metric('reflowMs', Date.now() - t0);
    ctx.metric('reflow', rv);
    ctx.assert('窄屏触屏 docx 默认阅读视图（按屏宽重排、不横向溢出、不出 PDF）', !!rv && !rv.pdf && rv.sw <= rv.vw + 1, rv || (await ofState(ctx)));
    await ctx.shot('reflow');
    if (!rv) return;
    await menuPick(ctx, '打印版式');
    t0 = Date.now();
  }
  const s = await pdfReady(ctx).catch(() => null);
  ctx.metric('openMs', Date.now() - t0);
  ctx.assert('转出的 PDF 以 Word 模式打开', s && s.word, s || (await ofState(ctx)));
  if (!s) return;
  ctx.metric('pages', s.pages);
  ctx.assert('分页保留（≥ 5 页）', s.pages >= 5, s.pages);
  await pageDrawn(ctx, 1).catch(() => null);
  const open = await ctx.eval(`!!document.querySelector('.ps, .ps-sheet')`);
  if (!open) await tool(ctx, '导航');
  const rows = await ctx.waitFor(`(() => { const n = document.querySelectorAll('.po-row').length; return n >= 5 ? n : 0; })()`, 8000, '标题列表').catch(() => 0);
  ctx.metric('outlineRows', rows);
  ctx.assert('「导航」列出文档标题（≥ 5 条）', rows >= 5, rows);
  await ctx.shot('nav');
  if (rows) {
    await ctx.g.tapSel('.po-row .po-t', { text: '第 3 章' });
    await ctx.sleep(900);
    const p = (await st(ctx)).page;
    ctx.assert('点「第 3 章」跳到第 3 章所在页（≥ 3）', p >= 3, p);
    await ctx.shot('chapter3');
  }
  if (narrowTouch(ctx)) {
    // 切回阅读视图：⋯ 里「阅读视图」，偏好跟着记住
    await menuPick(ctx, '阅读视图');
    const rv = await ctx.waitFor(REFLOW, 15000, '切回阅读视图').catch(() => null);
    const pref = await ctx.eval(`localStorage.getItem('${LAYOUT_KEY}')`);
    ctx.assert('⋯「阅读视图」切回按屏宽重排，偏好记成 reflow', !!rv && !rv.pdf && pref === 'reflow', { rv, pref });
  }
}

const OFFICE = [
  {
    id: 'doc-office-cold',
    title: 'Office 冷转换：进度文案逐秒走、先看快速预览、转好提示切换；再开直接出',
    tags: ['doc', 'office'],
    timeout: 300000,
    run: (ctx) => withPrintLayout(ctx, async () => {
      // 按顺序找一份这个实例还没转过的（--fresh 起的实例第一档拿到 docx，后面几档轮到 odt / odp / rtf …）
      const COLD = ['文档/报告.docx', '文档/报告.odt', '文档/演示.odp', '文档/报告.rtf', '文档/报告.doc', '文档/演示.ppt'];
      let hit = null;
      const tried = [];
      for (const rel of COLD) {
        await ctx.close();
        await ctx.sleep(300);
        const t0 = Date.now();
        await ctx.open([ctx.item(rel, { kind: 'office' })], 0);
        const s = await ctx.waitFor(`(() => { const s = ${OF}; return s && ['convert', 'pdf', 'error', 'word', 'slides'].includes(s.phase) ? s : null; })()`, 20000, '转换状态').catch(() => null);
        tried.push({ rel, phase: s?.phase || null });
        if (s?.phase === 'convert') { hit = { rel, t0 }; break; }
      }
      ctx.metric('tried', tried);
      if (!hit) { ctx.assert('还有没转过的样张（实例要 --fresh 起）', false, tried, { level: 'info' }); return; }
      ctx.metric('cold', hit.rel);
      const t1 = (await ofState(ctx)).text;
      ctx.assert('进度文案是「正在转换 · 已用 n 秒」/「排队中」', CONV_RE.test(t1), t1);
      await ctx.sleep(2300);
      const s2 = await ofState(ctx);
      if (s2.phase === 'convert') {
        ctx.assert('秒数在走（2.3 秒后变大）', secs(s2.text) > secs(t1), { t1, t2: s2.text });
        await ctx.shot('converting');
      }
      const quick = /\.docx$/.test(hit.rel);
      let switched = false;
      if (quick) {
        // 6 秒还没转好就给「先看快速预览」
        const btn = await ctx.waitFor(`(() => { const s = ${OF}; if (s?.phase !== 'convert') return 'done'; return [...__pvqa.root().querySelectorAll('.of-conv .vw-pbtn')].some((b) => b.textContent.includes('先看快速预览')) ? 'btn' : null; })()`, 9000, '快速预览按钮').catch(() => null);
        ctx.metric('quickBtn', btn);
        if (btn === 'btn') {
          ctx.assert('等过 6 秒出现「先看快速预览」', Date.now() - hit.t0 >= 5500, Date.now() - hit.t0);
          await ctx.shot('quick-btn');
          await ctx.g.tapSel('.of-conv .vw-pbtn', { text: '先看快速预览', within: ctx.ROOT_SEL });
          const wd = await ctx.waitFor(`(() => { const w = __pvqa.root()?.querySelector('.wd'); return w && +w.dataset.heads > 0 ? +w.dataset.heads : 0; })()`, 15000, '快速预览').catch(() => 0);
          ctx.assert('切到快速预览（浏览器排版、列出标题）', wd > 0, wd);
          await ctx.shot('quick');
          const toast = await ctx.waitFor(`[...document.querySelectorAll('.vw-toast')].some((x) => x.textContent.includes('原版式 PDF 已转换好'))`, 150000, '转好的提示').catch(() => false);
          ctx.metric('convertMs', Date.now() - hit.t0);
          ctx.assert('服务端转好后提示「原版式 PDF 已转换好」', toast, toast);
          if (toast) {
            await ctx.g.tapSel('.vw-toast-act', { text: '切换' });
            const p = await pdfReady(ctx, 20000).catch(() => null);
            ctx.assert('点「切换」换成原版式 PDF', p && p.word, p || (await ofState(ctx)));
            switched = !!p;
          }
        }
      } else {
        const btn = await ctx.eval(`!!__pvqa.root().querySelector('.of-conv .vw-pbtn')`);
        ctx.assert('没有客户端渲染器的格式不给快速预览按钮', !btn, btn);
      }
      if (!switched) {
        const p = await pdfReady(ctx, 150000).catch(() => null);
        ctx.metric('convertMs', Date.now() - hit.t0);
        ctx.assert('转换完成后显示 PDF', !!p, p || (await ofState(ctx)));
      }
      await ctx.shot('converted');
      // 再开一次：命中缓存，直接是 PDF，不再出转换页
      await ctx.close();
      await ctx.sleep(400);
      const t2 = Date.now();
      await ctx.open([ctx.item(hit.rel, { kind: 'office' })], 0);
      let sawConv = false;
      const p2 = await ctx.waitFor(`(() => { const s = ${OF}; if (s?.phase === 'convert') window.__sawConv = true; return s && s.pdf && s.pdf.phase === 'ready' ? s.pdf : null; })()`, 20000, '再开').catch(() => null);
      sawConv = await ctx.eval(`!!window.__sawConv`);
      ctx.metric('reopenMs', Date.now() - t2);
      ctx.assert('再开直接是 PDF（不出转换页）', !!p2 && !sawConv, { p2, sawConv });
    }),
  },
  {
    id: 'doc-word-pdf',
    title: 'docx 走服务端 PDF：Word 版式、导航栏列出标题、点标题跳页；窄屏触屏默认阅读视图、⋯ 里切打印版式',
    tags: ['doc', 'office'],
    timeout: 200000,
    async run(ctx) {
      try { await wordPdf(ctx); } finally { if (narrowTouch(ctx)) await ctx.eval(`localStorage.removeItem('${LAYOUT_KEY}')`).catch(() => {}); }
    },
  },
  {
    id: 'doc-word-quick',
    title: 'Word 快速预览（浏览器排版）：A4 纸面、导航、查找高亮、缩放以指下为锚',
    tags: ['doc', 'office'],
    timeout: 90000,
    async run(ctx) {
      const t0 = Date.now();
      await ctx.open([quickItem(ctx, '文档/报告.docx', '报告.docm')], 0);
      const heads = await ctx.waitFor(`(() => { const w = __pvqa.root()?.querySelector('.wd'); return w && +w.dataset.heads > 0 ? +w.dataset.heads : 0; })()`, 30000, 'Word 快速预览').catch(() => 0);
      ctx.metric('openMs', Date.now() - t0);
      ctx.metric('heads', heads);
      ctx.assert('列出标题（标题 + 5 章 + 5 小节）', heads >= 10, heads);
      if (!heads) return;
      const g = await ctx.eval(`(() => { const r = __pvqa.root(); const p = r.querySelector('.wd-paper').getBoundingClientRect(); const sc = r.querySelector('.wd-scroll'); return { pw: Math.round(p.width), vw: sc.clientWidth, sw: sc.scrollWidth, note: !!r.querySelector('.wd-note'), text: (r.querySelector('.wd-doc').innerText || '').includes('第 1 章'), img: [...r.querySelectorAll('.wd-doc img')].filter((i) => i.naturalWidth > 0).length, tables: r.querySelectorAll('.wd-doc table').length, zoom: +r.querySelector('.wd').dataset.zoom }; })()`);
      ctx.metric('layout', g);
      ctx.assert('正文、插图、表格都在', g.text && g.img >= 1 && g.tables >= 1, g);
      ctx.assert('有「快速预览」说明', g.note, g.note);
      if (!ctx.touch) ctx.assert('电脑：A4 纸宽（794 × 缩放）', Math.abs(g.pw - 794 * g.zoom) <= 2, g);
      else ctx.assert('触屏：纸铺满、不横向溢出', g.pw >= g.vw - 2 && g.sw <= g.vw + 1, g);
      await ctx.shot('doc');
      // 导航：点「第 4 章」→ 滚到那一章、高亮跟上
      const sideOpen = await ctx.eval(`!!document.querySelector('.ps, .ps-sheet')`);
      if (!sideOpen) await tool(ctx, '导航');
      await ctx.waitFor(`document.querySelectorAll('.po-row').length > 5`, 6000, '标题树').catch(() => null);
      await ctx.sleep(300);
      await ctx.g.tapSel('.po-row .po-t', { text: '第 4 章' });
      await ctx.sleep(1100);
      const nav = await ctx.eval(`(() => { const r = __pvqa.root(); const sc = r.querySelector('.wd-scroll').getBoundingClientRect(); const h = [...r.querySelectorAll('.wd-doc h1, .wd-doc h2')].find((x) => x.textContent.includes('第 4 章')); const b = h?.getBoundingClientRect(); const lit = document.querySelector('.po-row.on')?.textContent?.trim() || ''; return { dy: b ? Math.round(b.top - sc.top) : null, lit, sheet: !!document.querySelector('.ps-sheet') }; })()`);
      ctx.metric('nav', nav);
      ctx.assert('点「第 4 章」滚到该章（标题在可视区顶部附近）', nav.dy != null && nav.dy >= -4 && nav.dy <= 80, nav);
      if (!ctx.touch) ctx.assert('导航高亮跟到「第 4 章」', nav.lit.includes('第 4 章'), nav.lit);
      if (ctx.touch && nav.sheet) { await ctx.g.key('escape'); await ctx.sleep(400); }
      await ctx.shot('nav');
      // 查找「章节标题」：5 处、Enter 下一处、Esc 清掉
      if (ctx.touch) await tool(ctx, '查找'); else await ctx.g.key('ctrl+f');
      await ctx.waitFor(`(() => { const i = __pvqa.root()?.querySelector('.fb input'); return i && document.activeElement === i; })()`, 4000, '查找框').catch(() => null);
      await typeText(ctx, '章节标题');
      const f1 = await ctx.waitFor(`(() => { const w = __pvqa.root().querySelector('.wd'); const c = __pvqa.root().querySelector('.fb-count')?.textContent?.trim() || ''; return +w.dataset.hits === 5 ? { hits: 5, c } : null; })()`, 6000, '命中 5 处').catch(() => null);
      ctx.assert('「章节标题」命中 5 处', !!f1, f1 || (await ctx.eval(`__pvqa.root().querySelector('.wd').dataset.hits`)));
      const hl = await ctx.eval(`(() => { try { return CSS.highlights ? (CSS.highlights.get('wd-hit')?.size || 0) : -1; } catch { return -2; } })()`);
      ctx.assert('命中处用 ::highlight 标出（不改 DOM）', hl === 5 || hl === -1, hl);
      // 查找从当前阅读位置往后找（同 Word / 浏览器）：刚跳到第 4 章，首个当前项是第 4 处；Enter 走到下一处（到头绕回）
      const i1 = +(/^(\d+)\D/.exec(f1?.c || '') || [])[1] || 0;
      ctx.metric('findStart', f1?.c || '');
      ctx.assert('首个当前项是视口里 / 之后的那处（≥ 3）', i1 >= 3, f1?.c);
      await ctx.g.key('enter');
      await ctx.sleep(300);
      const c2 = await ctx.eval(`__pvqa.root().querySelector('.fb-count')?.textContent?.trim()`);
      const want = (i1 % 5) + 1;
      ctx.assert('Enter 到下一处', (+(/^(\d+)\D/.exec(c2 || '') || [])[1] || 0) === want, { from: f1?.c, to: c2 });
      await ctx.shot('find');
      await ctx.g.key('escape');
      await ctx.sleep(300);
      const cl = await ctx.eval(`({ bar: !!__pvqa.root().querySelector('.fb input'), hl: CSS.highlights ? (CSS.highlights.get('wd-hit')?.size || 0) : 0, open: __pvqa.pv.preview.open })`);
      ctx.assert('Esc 关查找、清高亮', !cl.bar && cl.hl === 0 && cl.open, cl);
      // 缩放：电脑 Ctrl+滚轮（指下那段字留在指下）；触屏双指（字变大、按宽度重排）
      const R = await ctx.eval(`(() => { const b = __pvqa.root().querySelector('.wd-scroll').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
      const p = { x: Math.round(R.x + R.w * (ctx.touch ? 0.5 : 0.45)), y: Math.round(R.y + R.h * 0.45) };
      const mark = await ctx.eval(`(() => { const el = document.elementFromPoint(${p.x}, ${p.y})?.closest('.wd-doc > *'); if (!el) return null; window.__wdEl = el; const b = el.getBoundingClientRect(); return { fx: (${p.x} - b.left) / b.width, fy: (${p.y} - b.top) / b.height, tag: el.tagName }; })()`);
      const z0 = await ctx.eval(`+__pvqa.root().querySelector('.wd').dataset.zoom`);
      if (!ctx.touch) await ctx.g.wheel(p.x, p.y, { dy: -120, ctrl: true, ticks: 3, gap: 60 });
      else await ctx.g.pinch(p, 1.6, { steps: 14, ms: 360 });
      await ctx.sleep(900);
      const z1 = await ctx.eval(`+__pvqa.root().querySelector('.wd').dataset.zoom`);
      ctx.metric('zoom', { from: z0, to: z1 });
      ctx.assert(ctx.touch ? '双指放大字号' : 'Ctrl+滚轮放大', z1 > z0 * 1.15, { z0, z1 });
      if (mark && !ctx.touch) {
        const q = await ctx.eval(`(() => { const b = window.__wdEl.getBoundingClientRect(); return { x: b.left + ${mark.fx} * b.width, y: b.top + ${mark.fy} * b.height }; })()`);
        const d = { dx: Math.round(q.x - p.x), dy: Math.round(q.y - p.y) };
        ctx.metric('drift', d);
        ctx.assert('Ctrl+滚轮：指下那段字竖向不漂（≤ 12px）', Math.abs(d.dy) <= 12, d);
        // 横向：纸还放得下时保持居中（同 Word / Acrobat，这时横向必然随居中移动）；纸超宽后才以指下为锚
        const PAPER = `(() => { const sc = __pvqa.root().querySelector('.wd-scroll'); const s = sc.getBoundingClientRect(); const pp = __pvqa.root().querySelector('.wd-paper').getBoundingClientRect(); return { fits: sc.scrollWidth <= sc.clientWidth + 1, off: Math.round(pp.left + pp.width / 2 - (s.left + sc.clientWidth / 2)), sl: Math.round(sc.scrollLeft) }; })()`;
        const fp = await ctx.eval(PAPER);
        if (fp.fits) ctx.assert('纸放得下：放大后仍水平居中', Math.abs(fp.off) <= 2, fp);
        // 再放大到纸超宽：横向也要以指下为锚
        const m2 = await ctx.eval(`(() => { const el = document.elementFromPoint(${p.x}, ${p.y})?.closest('.wd-doc > *'); if (!el) return null; window.__wdEl = el; const b = el.getBoundingClientRect(); return { fx: (${p.x} - b.left) / b.width, fy: (${p.y} - b.top) / b.height }; })()`);
        await ctx.g.wheel(p.x, p.y, { dy: -120, ctrl: true, ticks: 5, gap: 60 });
        await ctx.sleep(900);
        const fp2 = await ctx.eval(PAPER);
        if (m2 && !fp2.fits) {
          const q2 = await ctx.eval(`(() => { const b = window.__wdEl.getBoundingClientRect(); return { x: b.left + ${m2.fx} * b.width, y: b.top + ${m2.fy} * b.height }; })()`);
          const d2 = { dx: Math.round(q2.x - p.x), dy: Math.round(q2.y - p.y), z: await ctx.eval(`+__pvqa.root().querySelector('.wd').dataset.zoom`), sl: fp2.sl };
          ctx.metric('drift2', d2);
          ctx.assert('纸超宽后 Ctrl+滚轮横竖都以指下为锚（≤ 12px）', Math.abs(d2.dx) <= 12 && Math.abs(d2.dy) <= 12, d2);
        } else ctx.metric('drift2', { skipped: true, fp2 });
      }
      if (mark && ctx.touch) {
        const dy = await ctx.eval(`Math.round(window.__wdEl.getBoundingClientRect().top + ${mark.fy} * window.__wdEl.getBoundingClientRect().height - ${p.y})`);
        ctx.metric('driftY', dy);
        ctx.assert('捏合后指下那一段还在指下附近（≤ 40px）', Math.abs(dy) <= 40, dy);
        const ov = await ctx.eval(`(() => { const sc = __pvqa.root().querySelector('.wd-scroll'); return { sw: sc.scrollWidth, cw: sc.clientWidth }; })()`);
        ctx.assert('放大后按宽度重排、不横向溢出', ov.sw <= ov.cw + 1, ov);
      }
      const vv = await ctx.eval(`visualViewport.scale`);
      ctx.assert('没有触发浏览器整页缩放', vv === 1, vv);
      await ctx.shot('zoomed');
      if (!ctx.touch) {
        await ctx.g.key('ctrl+0');
        await ctx.sleep(400);
        const z2 = await ctx.eval(`+__pvqa.root().querySelector('.wd').dataset.zoom`);
        ctx.assert('Ctrl+0 回到自动缩放', Math.abs(z2 - z0) < 0.01, { z0, z2 });
      }
    },
  },
  {
    id: 'doc-ppt-pdf',
    title: 'pptx 走服务端 PDF：一屏一张、翻页、缩略图、F5 放映',
    tags: ['doc', 'office'],
    timeout: 200000,
    async run(ctx) {
      const t0 = Date.now();
      await ctx.open([ctx.item('文档/演示.pptx', { kind: 'office' })], 0);
      const s = await pdfReady(ctx).catch(() => null);
      ctx.metric('openMs', Date.now() - t0);
      ctx.assert('转出的 PDF 以幻灯片模式打开', s && s.slides, s || (await ofState(ctx)));
      if (!s) return;
      await pageDrawn(ctx, 1).catch(() => null);
      const fit = await ctx.eval(`(() => { const sc = __pvqa.root().querySelector('.pdf-scroll'); const pg = __pvqa.root().querySelector('.pdf-root .page[data-page-number="1"]').getBoundingClientRect(); const R = sc.getBoundingClientRect(); return { w: Math.round(pg.width), h: Math.round(pg.height), vw: Math.round(R.width), vh: Math.round(R.height), mode: __pvqa.root().querySelector('.pdf-root').dataset.mode }; })()`);
      ctx.metric('fit', fit);
      ctx.assert('一屏放下整张（适应页面）', fit.h <= fit.vh && fit.w <= fit.vw, fit);
      await ctx.shot('slide1');
      await deckFlow(ctx, 'PDF 幻灯片');
    },
  },
  {
    id: 'doc-ppt-quick',
    title: 'PPT 快速预览（浏览器绘制）：文字 / 图表 / 图片 / 表格、翻页、缩略图、放映',
    tags: ['doc', 'office'],
    timeout: 90000,
    async run(ctx) {
      const t0 = Date.now();
      await ctx.open([quickItem(ctx, '文档/演示.pptx', '演示.ppsx')], 0);
      const s = await ctx.waitFor(`(() => { const s = ${SLIDE}; return s && s.kind === 'deck' && s.n > 0 ? s : null; })()`, 30000, 'PPT 快速预览').catch(() => null);
      ctx.metric('openMs', Date.now() - t0);
      ctx.assert('快速预览打开', !!s, s || (await ofState(ctx)));
      if (!s) return;
      const S = `__pvqa.root().querySelector('.pd-slide')`;
      const t1 = await ctx.eval(`(${S}?.innerText || '').replace(/\\s+/g, ' ')`);
      ctx.assert('封面标题文字', t1.includes('预览样张 演示文稿'), t1.slice(0, 60));
      const box = await ctx.eval(`(() => { const b = ${S}.getBoundingClientRect(); const R = __pvqa.root().querySelector('.pd-stage').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), ar: +(b.width / b.height).toFixed(3), vw: Math.round(R.width), vh: Math.round(R.height) }; })()`);
      ctx.metric('slideBox', box);
      ctx.assert('16:9、整张放得下', Math.abs(box.ar - 16 / 9) < 0.02 && box.w <= box.vw && box.h <= box.vh, box);
      await ctx.shot('cover');
      // 第 3 张：柱状图；第 4 张：饼图；第 5 张：图片；第 6 张：表格
      const go = async (n) => { if (!ctx.touch) { await ctx.g.tapSel('.vw-float .pg-in', { within: ctx.ROOT_SEL }); await typeText(ctx, String(n)); await ctx.g.key('enter'); } else { await ctx.g.tapSel(`.vw-bottom .ts-it[data-n="${n}"]`); } return waitSlide(ctx, n); };
      ctx.assert('跳到第 3 张', !!(await go(3)), await slideAt(ctx));
      const bars = await ctx.waitFor(`(() => { const sv = ${S}?.querySelector('svg.pc'); return sv ? sv.querySelectorAll('rect').length : 0; })()`, 4000, '柱状图').catch(() => 0);
      ctx.assert('柱状图画出来（≥ 8 根柱）', bars >= 8, bars);
      await ctx.shot('chart');
      ctx.assert('跳到第 4 张', !!(await go(4)), await slideAt(ctx));
      const pie = await ctx.eval(`(() => { const sv = ${S}?.querySelector('svg.pc'); return sv ? sv.querySelectorAll('path').length : 0; })()`);
      ctx.assert('饼图有扇区（≥ 3）', pie >= 3, pie);
      ctx.assert('跳到第 5 张', !!(await go(5)), await slideAt(ctx));
      const img = await ctx.waitFor(`(() => { const i = ${S}?.querySelector('img'); return i && i.complete && i.naturalWidth > 0 ? i.naturalWidth : 0; })()`, 6000, '图片').catch(() => 0);
      ctx.assert('图片解码显示', img > 0, img);
      ctx.assert('跳到第 6 张', !!(await go(6)), await slideAt(ctx));
      const tds = await ctx.eval(`(() => { const t = ${S}?.querySelector('table'); return t ? { n: t.querySelectorAll('td').length, h: t.querySelector('td')?.textContent?.trim() } : null; })()`);
      ctx.assert('表格 5×4、表头文字在', tds && tds.n === 20 && tds.h === '表头1', tds);
      await ctx.shot('table');
      // 回到第 1 张做一遍通用流程
      if (!ctx.touch) await ctx.g.key('home'); else await go(1);
      await waitSlide(ctx, 1);
      await deckFlow(ctx, '快速预览');
    },
  },
  {
    id: 'doc-xlsx',
    title: 'xlsx：冻结窗格、合并单元格、公式与数字格式、公式栏、换表',
    tags: ['doc', 'office', 'sheet'],
    timeout: 90000,
    async run(ctx) {
      const t0 = Date.now();
      await ctx.open([ctx.item('文档/数据表.xlsx', { kind: 'office' })], 0);
      const s = await sgReady(ctx, '汇总').catch(() => null);
      ctx.metric('openMs', Date.now() - t0);
      ctx.assert('打开到第一张表「汇总」', !!s, s);
      if (!s) return;
      ctx.assert('读出文件里的冻结窗格 B3', s.freeze === 'B3', s.freeze);
      // 合并：A1:F1 横跨 6 列，A17:B18 纵向两行
      const a1 = await cell(ctx, 'A1'), a17 = await cell(ctx, 'A17'), a2 = await cell(ctx, 'A2');
      ctx.metric('merge', { a1, a17 });
      ctx.assert('A1:F1 合并（宽 > 5 列默认宽）', a1 && a1.text.includes('年度汇总') && a1.w > 5 * 64 * s.zoom, a1);
      ctx.assert('A17:B18 纵向合并（高 ≈ 2 行）', a17 && a17.text === '纵向合并' && a2 && a17.h >= 1.8 * a2.h, { a17, a2 });
      // 公式：D3 = B3-C3 → 4534；E3 = D3/B3，格式 0.0% → 40.4%；B15 = SUM → 216252
      await tapCell(ctx, 'D3');
      const d3 = await sg(ctx);
      ctx.assert('点 D3：名称框 D3、公式栏 =B3-C3', d3.sel === 'D3' && d3.fx === '=B3-C3', d3);
      const v = { d3: (await cell(ctx, 'D3'))?.text, e3: (await cell(ctx, 'E3'))?.text, b15: (await cell(ctx, 'B15'))?.text };
      ctx.metric('values', v);
      ctx.assert('公式求值 + 数字格式（4534 / 40.4% / 216252）', v.d3 === '4534' && v.e3 === '40.4%' && /^216,?252$/.test(v.b15 || ''), v);
      await ctx.shot('summary');
      // 冻结：横向滚动后 A 列还在左边（汇总表只有 20 行，竖向冻结看「明细」）
      const scr = await ctx.eval(`(() => { const sc = __pvqa.root().querySelector('.sg-scroll'); const mx = sc.scrollWidth - sc.clientWidth; sc.scrollLeft = Math.min(mx, 400); return { mx, x: sc.scrollLeft }; })()`);
      await ctx.sleep(300);
      if (scr.mx > 40) {
        const a5 = await cell(ctx, 'A5');
        ctx.assert('横向滚动后冻结的 A 列不动', a5 && a5.text === '3 月', { scr, a5 });
        await ctx.shot('frozen-col');
        await ctx.eval(`(__pvqa.root().querySelector('.sg-scroll').scrollLeft = 0, 1)`);
      } else ctx.metric('frozenCol', '宽度放得下，不用横向滚');
      // 换到「明细-2万行」：冻结首行
      const m = await pickSheet(ctx, '明细-2万行');
      ctx.assert('换到「明细-2万行」（2 万行 + 表头、冻结 A2）', m && m.rows === 20001 && m.freeze === 'A2', m);
      if (!m) return;
      // 窄屏 G 列在右边视口外：先横向滚到头再点
      await ctx.eval(`(() => { const sc = __pvqa.root().querySelector('.sg-scroll'); sc.scrollLeft = sc.scrollWidth; return 1; })()`);
      await ctx.sleep(250);
      await tapCell(ctx, 'G2');
      const g2 = await sg(ctx);
      ctx.assert('G2 公式栏 =E2*F2', g2.fx === '=E2*F2', g2);
      if (ctx.touch) {
        // 触屏公式栏：点一下展开看全文
        const fx = await ctx.eval(`!!__pvqa.root().querySelector('.sg-fx.t')`);
        ctx.assert('触屏公式栏在', fx, fx);
      }
      // 宽表：60 列，横向能滚到底
      const w = await pickSheet(ctx, '宽表');
      ctx.assert('换到「宽表」（60 列）', w && w.cols === 60, w);
      await ctx.eval(`(() => { const sc = __pvqa.root().querySelector('.sg-scroll'); sc.scrollLeft = sc.scrollWidth; return 1; })()`);
      await ctx.sleep(300);
      const last = await ctx.eval(`(() => { const r = __pvqa.root(); return [...r.querySelectorAll('.sg td')].some((td) => td.textContent === '列60' && td.getBoundingClientRect().width > 0); })()`);
      ctx.assert('横向滚到底能看到「列60」', last, last);
      await ctx.shot('wide');
    },
  },
  {
    id: 'doc-xlsx-perf',
    title: 'xlsx 两万行：虚拟滚动帧率、无空白帧、表头冻结；Ctrl+End、查找计数',
    tags: ['doc', 'office', 'sheet', 'perf'],
    timeout: 120000,
    async run(ctx) {
      await ctx.open([ctx.item('文档/数据表.xlsx', { kind: 'office' })], 0);
      await sgReady(ctx, '汇总');
      const m = await pickSheet(ctx, '明细-2万行');
      ctx.assert('换到「明细-2万行」', !!m, m);
      if (!m) return;
      const tdN0 = await ctx.eval(`__pvqa.root().querySelectorAll('.sg td').length`);
      ctx.metric('tdCount', tdN0);
      ctx.assert('只画视口里的格子（td < 2000）', tdN0 < 2000, tdN0);
      const b = await cell(ctx, 'B5');
      const R = await ctx.eval(`(() => { const b = __pvqa.root().querySelector('.sg-scroll').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
      const probe = { x: b.x, y: Math.round(R.y + R.h * 0.6) };
      await ctx.eval(`__pvqa.quiet(600, 6000)`, { timeout: 10000 }).catch(() => null);
      await ctx.eval(FPS_ARM(probe.x, probe.y));
      if (!ctx.touch) await ctx.g.wheel(probe.x, probe.y, { dy: 120, ticks: 70, gap: 16 });
      else for (let i = 0; i < 5; i++) { await ctx.g.swipe({ x: R.x + R.w * 0.5, y: R.y + R.h * 0.85 }, { x: R.x + R.w * 0.5, y: R.y + R.h * 0.15 }, { ms: 110, steps: 8, easing: false }); await ctx.sleep(260); }
      await ctx.sleep(700);
      const f = await ctx.eval(FPS_END);
      const top = await ctx.eval(`__pvqa.root().querySelector('.sg-scroll').scrollTop`);
      ctx.metric('fps', f);
      ctx.metric('scrollTop', top);
      ctx.assert('确实滚远了（> 3000px）', top > 3000, top);
      ctx.assert('滚动帧率 ≥ 50', f.fps >= 50, f);
      ctx.assert('长帧（> 50ms）≤ 2', f.long <= 2, f);
      ctx.assert('探针点没有空白帧', f.blank === 0, f.blank);
      const hdr = await ctx.eval(`(() => { const r = __pvqa.root(); const sc = r.querySelector('.sg-scroll').getBoundingClientRect(); const td = [...r.querySelectorAll('.sg td')].find((x) => x.textContent === '序号' && x.getBoundingClientRect().width > 0); if (!td) return null; const b = td.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return { dy: Math.round(b.top - sc.top), on: !!hit && td.contains(hit) }; })()`);
      ctx.assert('滚下去以后冻结的表头行还在顶上', hdr && hdr.on && hdr.dy >= 0 && hdr.dy <= 40, hdr);
      await ctx.shot('scrolled');
      // 等惯性滚动停稳再点工具栏：Chrome 在惯性滚动中的那一下点按只用来「停住」，不会发 click（真机同样如此）
      if (ctx.touch) await ctx.waitFor(`(() => { const s = __pvqa.root().querySelector('.sg-scroll'); const w = window.__sgSettle ||= { v: -1, n: 0 }; if (s.scrollTop === w.v) w.n++; else { w.v = s.scrollTop; w.n = 0; } return w.n >= 4 ? (delete window.__sgSettle, true) : null; })()`, 8000, '惯性停稳').catch(() => null);
      if (!ctx.touch) {
        await ctx.g.key('ctrl+end');
        await ctx.sleep(500);
        const e = await sg(ctx);
        const lastRow = await ctx.eval(`[...__pvqa.root().querySelectorAll('.sg td')].some((x) => x.textContent === '第 20000 行' && x.getBoundingClientRect().height > 0)`);
        ctx.assert('Ctrl+End 到 H20001、末行可见', e.sel === 'H20001' && lastRow, { sel: e.sel, lastRow });
        await ctx.g.key('ctrl+home');
        await ctx.sleep(400);
        ctx.assert('Ctrl+Home 回 A1', (await sg(ctx)).sel === 'A1', (await sg(ctx)).sel);
      }
      // 查找：客户0123 在 2 万行里出现 21 次
      if (ctx.touch) await tool(ctx, '查找'); else await ctx.g.key('ctrl+f');
      await ctx.waitFor(`!!__pvqa.root()?.querySelector('.fb input')`, 4000, '查找框').catch(() => null);
      await ctx.g.tapSel('.fb input', { within: ctx.ROOT_SEL }).catch(() => null);
      await typeText(ctx, '客户0123');
      const c = await ctx.waitFor(`(() => { const t = __pvqa.root().querySelector('.fb-count')?.textContent?.trim() || ''; return /21/.test(t) ? t : null; })()`, 8000, '命中 21 处').catch(() => null);
      ctx.assert('「客户0123」命中 21 处', !!c, c || (await ctx.eval(`__pvqa.root().querySelector('.fb-count')?.textContent`)));
      await ctx.g.key('enter');
      await ctx.sleep(400);
      const sel2 = (await sg(ctx)).sel;
      ctx.assert('Enter 跳到第 2 处（C1101）', sel2 === 'C1101', sel2);
      await ctx.shot('find');
    },
  },
  {
    id: 'doc-csv',
    // csv / tsv 的渲染器定为 DocViewer 的 TableView（MediaViewer 把 office 类里的 csv / tsv 交给它，和 text-csv 同一条路）；
    // 这里从 Office 线的角度把关：编码（BOM）与引号里的逗号、5 万行照样开、tsv 按制表符分列
    title: 'csv / tsv：走 TableView——编码与引号正确、5 万行照样开',
    tags: ['doc', 'office', 'sheet'],
    timeout: 60000,
    async run(ctx) {
      const tv = () => ctx.eval(`(() => {
        const g = __pvqa.root()?.querySelector('[data-pv-table]');
        if (!g) return null;
        const head = [...g.querySelectorAll('[role=columnheader]')].map((x) => x.textContent.trim());
        const rows = [...g.querySelectorAll('.tv-row')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        const first = rows[0] ? [...rows[0].querySelectorAll('[role=gridcell]')].map((x) => x.textContent) : [];
        return { rows: +g.getAttribute('aria-rowcount'), cols: +g.getAttribute('aria-colcount'), head, first, sg: !!__pvqa.root()?.querySelector('.sg') };
      })()`).catch(() => null);
      const t0 = Date.now();
      await ctx.open([ctx.item('代码/表格.csv', { kind: 'office' })], 0);
      await ctx.waitFor(`(() => { const g = __pvqa.root()?.querySelector('[data-pv-table]'); return !!g && +g.getAttribute('aria-rowcount') > 1; })()`, 30000, 'TableView').catch(() => null);
      ctx.metric('openMs', Date.now() - t0);
      const s = await tv();
      ctx.metric('table', s && { rows: s.rows, cols: s.cols, head: s.head, first: s.first });
      ctx.assert('csv 打开（5 万行 + 表头、5 列）', s && s.rows === 50001 && s.cols === 5, s && { rows: s.rows, cols: s.cols });
      if (!s) return;
      ctx.assert('只有一套表格渲染器（不是 SheetGrid）', !s.sg, s.sg);
      ctx.assert('去掉 BOM、引号里的逗号保留', s.head[0] === '序号' && s.first[4] === '含逗号, 的备注 1', { a1: s.head[0], e2: s.first[4] });
      await ctx.shot('csv');
      await ctx.close();
      await ctx.sleep(300);
      await ctx.open([ctx.item('代码/表格.tsv', { kind: 'office' })], 0);
      await ctx.waitFor(`(() => { const g = __pvqa.root()?.querySelector('[data-pv-table]'); return !!g && +g.getAttribute('aria-colcount') > 1; })()`, 10000, 'tsv 表格').catch(() => null);
      const t = await tv();
      ctx.assert('tsv 打开、按制表符分列', t && t.cols === 3 && t.head[0] === '名称', t && { cols: t.cols, a1: t.head[0] });
    },
  },
  {
    id: 'doc-local-office',
    title: '手机本地 Office：pptx / xlsx 不经服务端直接在手机上渲染',
    tags: ['doc', 'office', 'local'],
    mode: 'apk',
    only: (cfg) => cfg.touch,
    timeout: 90000,
    async run(ctx) {
      await ctx.open([ctx.item('文档/演示.pptx', { kind: 'office' })], 0);
      const s = await ctx.waitFor(`(() => { const s = ${SLIDE}; return s && s.kind === 'deck' && s.n === 8 ? s : null; })()`, 30000, '本地 PPT').catch(() => null);
      ctx.assert('本地 pptx 直接渲染（8 张）', !!s, s || (await ofState(ctx)));
      if (s) {
        await flip(ctx, 1);
        ctx.assert('左滑翻到第 2 张', !!(await waitSlide(ctx, 2)), await slideAt(ctx));
        await ctx.shot('pptx');
      }
      await ctx.close();
      await ctx.sleep(300);
      await ctx.open([ctx.item('文档/数据表.xlsx', { kind: 'office' })], 0);
      const g = await sgReady(ctx, '汇总').catch(() => null);
      ctx.assert('本地 xlsx 打开到「汇总」、冻结 B3', g && g.freeze === 'B3', g);
      if (g) {
        const tabs = await ctx.eval(`document.querySelectorAll('.vw-bottom .st-tab').length`);
        ctx.assert('底栏有工作表标签（3 张）', tabs === 3, tabs);
        await ctx.shot('xlsx');
      }
    },
  },
];

export default [...PDF, ...OFFICE];
