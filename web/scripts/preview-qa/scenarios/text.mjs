// 文本类预览（代码 / 文本 / JSON / 日志 / CSV / Markdown 相对链接 / HTML 源码）：真手势 + 键盘，靠数值下结论。
//
//   打开耗时：json / log / js 到正文出现（目标 < 1s）；语法高亮、行号在
//   查找：Ctrl+F（触屏点「查找」）→ 输词 → 命中数与 node 侧按同一规则数出来的一致；Enter 跳下一个
//   跳行：Ctrl+G → 输行号 → 当前行号槽 = 该行
//   换行：Alt+Z / 工具按钮切 .cm-lineWrapping
//   GBK：床前明月光正确解码，副标题标 GB18030
//   大文件：超过上限标「仅显示前 xx」，没有编辑入口
//   CSV：表格（冻结表头、虚拟滚动）+ 看原文
//   md：相对图片加载；相对 md 链接在查看器里开（不整页跳）；相对 PDF 链接走预览
//   md 预览：键盘滚动（PgDn / ↓ / 空格 / End / Home）；查看器内查找（计数、Enter 下一处、不分大小写、Esc 只关查找）
//   HTML：源码切换；Esc 关查看器
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as C from '../lib/checks.mjs';

const R = `__pvqa.root()`;
const cmText = `(${R}?.querySelector('[data-pv-code] .cm-content')?.textContent || '')`;
const barBtn = (label) => `${R}?.querySelector('.vw-bar [aria-label^=${JSON.stringify(label)}]')`;

// 等 CodeView 出正文（.cm-content 里有 needle），返回耗时
async function codeOpen(ctx, needle, t0, { timeout = 20000, name } = {}) {
  let ok = false;
  try { ok = await ctx.waitFor(`${cmText}.includes(${JSON.stringify(needle)})`, timeout, '代码视图出现「' + needle + '」'); } catch {}
  const ms = ok ? Date.now() - t0 : null;
  ctx.metric('openMs', ms);
  ctx.assert(name || `出现「${needle}」`, ok, ok);
  return ms;
}

const typeText = (ctx, text) => ctx.pg.send('Input.insertText', { text });
const countOf = (ctx) => ctx.eval(`${R}?.querySelector('.cv-count')?.textContent || ''`).catch(() => '');
const activeLine = (ctx) => ctx.eval(`${R}?.querySelector('.cm-activeLineGutter')?.textContent?.trim() || ''`).catch(() => '');

// node 侧按 CodeView 的规则（不区分大小写、纯文本）数命中
function countHits(dir, rel, q, cap) {
  let s = readFileSync(path.join(dir, rel), 'utf8');
  if (cap && Buffer.byteLength(s) > cap) s = Buffer.from(s).subarray(0, cap).toString('utf8');
  const a = s.toLowerCase(), b = q.toLowerCase();
  let n = 0;
  for (let i = a.indexOf(b); i >= 0; i = a.indexOf(b, i + b.length)) n++;
  return n;
}

// md 里某个链接的 DOM 连续 400ms 没被换掉、页内位置不变（双链索引到货 / 分块渲染收尾会换 DOM，图片解码会推位置）→ 返回等了多久；超时返回 null
const settleLink = (ctx, text) => ctx.eval(`(async () => {
  const find = () => [...(${R}?.querySelectorAll('.doc-md a') || [])].find((a) => a.textContent.includes(${JSON.stringify(text)}));
  const t0 = performance.now(); let el = null, top = null, since = 0;
  while (performance.now() - t0 < 10000) {
    const cur = find(), y = cur ? Math.round(cur.getBoundingClientRect().top + (cur.closest('.doc-scroll')?.scrollTop || 0)) : null;
    // 出链胶囊（.doc-out）只在双链索引到货后才有：有它（或等满 4s）才开始算稳定
    const ready = !!${R}?.querySelector('.doc-out') || performance.now() - t0 > 4000;
    if (cur && cur === el && y === top && ready && !${R}?.querySelector('.doc-rendering')) { if (performance.now() - since >= 400) return Math.round(performance.now() - t0); }
    else { el = cur; top = y; since = performance.now(); }
    await new Promise((z) => setTimeout(z, 50));
  }
  return null;
})()`, { timeout: 15000 }).catch(() => null);

// 点 md 里的行内链接：折行的链接外接框中心可能落在别的链接上（窄屏「PDF 附件」跨两行就点中了旁边的「另一篇」），按第一个行盒的中心点
async function tapLink(ctx, text) {
  const c = await ctx.eval(`(async () => {
    const a = [...(${R}?.querySelectorAll('.doc-md a') || [])].find((x) => x.textContent.includes(${JSON.stringify(text)}));
    if (!a) return null;
    a.scrollIntoView({ block: 'center' });
    for (let i = 0; i < 3; i++) await new Promise((z) => requestAnimationFrame(z));
    const b = [...a.getClientRects()].find((r) => r.width > 4) || a.getBoundingClientRect();
    const x = b.left + Math.min(b.width / 2, 24), y = b.top + b.height / 2, hit = document.elementFromPoint(x, y);
    return { x, y, lines: a.getClientRects().length, hitOk: !!hit && (hit === a || a.contains(hit)) };
  })()`, { timeout: 8000 });
  if (!c) throw new Error('找不到链接「' + text + '」');
  await ctx.g.tap(c.x, c.y);
  return c;
}

async function openFind(ctx) {
  if (ctx.touch) await ctx.g.tapSel('.vw-bar [aria-label^="查找"]', { within: ctx.ROOT_SEL });
  else await ctx.g.key('ctrl+f');
  return ctx.waitFor(`document.activeElement?.classList?.contains('cv-q') || document.activeElement?.classList?.contains('tv-q')`, 4000, '查找框获得焦点').catch(() => false);
}

const S = [
  {
    id: 'text-js', title: '打开 2MB js：高亮、行号、查找、跳行、换行、Esc 关',
    async run(ctx) {
      const t0 = Date.now();
      await ctx.open([ctx.item('代码/大文件.js', { kind: 'text' })], 0);
      const ms = await codeOpen(ctx, 'export function handler1(', t0);
      ctx.assert('js 打开 < 1s', ms != null && ms < 1000, ms, { level: 'goal' });
      const hl = await ctx.waitFor(`${R}?.querySelectorAll('[data-pv-code] .cvh-kw').length || 0`, 5000, '关键字着色').catch(() => 0);
      ctx.metric('kwSpans', hl);
      ctx.assert('语法高亮（关键字着色）', hl > 0, hl);
      const ln = await ctx.eval(`!!${R}?.querySelector('[data-pv-code] .cm-lineNumbers .cm-gutterElement')`).catch(() => false);
      ctx.assert('行号槽', ln, ln);
      const editTa = await ctx.eval(`${R}?.querySelectorAll('textarea').length || 0`).catch(() => 0);
      ctx.assert('默认不是可写 textarea', editTa === 0, editTa);
      await ctx.shot('open');

      // 查找
      const focused = await openFind(ctx);
      ctx.assert('查找框弹出并聚焦', focused, focused);
      await typeText(ctx, 'handler1');
      const want = countHits(ctx.samplesDir, '代码/大文件.js', 'handler1');
      const got = await ctx.waitFor(`(() => { const s = ${R}?.querySelector('.cv-count')?.textContent || ''; const m = /\\/\\s*([\\d,]+)/.exec(s); return m ? +m[1].replace(/,/g, '') : 0; })()`, 5000, '命中数').catch(() => 0);
      ctx.metric('findCount', got);
      ctx.metric('_findWant', want);
      ctx.assert('查找命中数与原文一致', got === want, `${got} / 期望 ${want}`);
      const hits = await ctx.eval(`${R}?.querySelectorAll('[data-pv-code] .cv-hit').length || 0`).catch(() => 0);
      ctx.assert('命中高亮可见', hits > 0, hits);
      const c1 = await countOf(ctx);
      await ctx.g.key('enter');
      await ctx.sleep(200);
      const c2 = await countOf(ctx);
      ctx.metric('findStep', `${c1} → ${c2}`);
      // 计数和 md / PDF 查找条同一写法「2/1,111」（旧写法带空格「2 / 1,111」也认）
      ctx.assert('Enter 跳到下一个', c1 !== c2 && /^2\s*\//.test(c2), `${c1} → ${c2}`);
      await ctx.shot('find');
      await ctx.g.key('escape');
      await ctx.sleep(200);
      const barGone = await ctx.eval(`!${R}?.querySelector('.cv-bar')`).catch(() => false);
      const stillOpen = await ctx.eval(`!!${R}`).catch(() => false);
      ctx.assert('Esc 先关查找条、不关查看器', barGone && stillOpen, { barGone, stillOpen });

      // 跳行
      await ctx.g.key('ctrl+g');
      await ctx.waitFor(`document.activeElement?.classList?.contains('cv-q')`, 3000, '跳行框').catch(() => {});
      await typeText(ctx, '5000');
      await ctx.g.key('enter');
      const al = await ctx.waitFor(`(() => { const s = ${R}?.querySelector('.cm-activeLineGutter')?.textContent?.trim(); return s === '5000' ? s : ''; })()`, 3000, '当前行 5000').catch(async () => activeLine(ctx));
      ctx.metric('gotoLine', al);
      ctx.assert('Ctrl+G 跳到第 5000 行', al === '5000', al);
      await ctx.shot('goto');

      // 换行
      const w0 = await ctx.eval(`!!${R}?.querySelector('[data-pv-code] .cm-content.cm-lineWrapping')`);
      if (ctx.touch) await ctx.g.key('alt+z');
      else await ctx.g.tapSel('.vw-bar [aria-label^="自动换行"]', { within: ctx.ROOT_SEL });
      await ctx.sleep(250);
      const w1 = await ctx.eval(`!!${R}?.querySelector('[data-pv-code] .cm-content.cm-lineWrapping')`);
      await ctx.g.key('alt+z');
      await ctx.sleep(250);
      const w2 = await ctx.eval(`!!${R}?.querySelector('[data-pv-code] .cm-content.cm-lineWrapping')`);
      ctx.metric('wrap', `${w0}→${w1}→${w2}`);
      ctx.assert('换行开关来回切', w0 !== w1 && w1 !== w2, `${w0}→${w1}→${w2}`);

      // Esc 关查看器
      await ctx.g.key('escape');
      const closed = await ctx.waitFor(`!${R}`, 3000, '查看器关闭').catch(() => false);
      ctx.assert('Esc 关查看器', closed, closed);
    },
  },
  {
    id: 'text-json', title: '打开 10MB JSON：耗时、高亮、折叠、截断提示',
    async run(ctx) {
      const t0 = Date.now();
      await ctx.open([ctx.item('代码/数据.json', { kind: 'text' })], 0);
      const ms = await codeOpen(ctx, '"title": "样张 JSON"', t0);
      ctx.assert('json 打开 < 1s', ms != null && ms < 1000, ms, { level: 'goal' });
      const hl = await ctx.waitFor(`${R}?.querySelectorAll('[data-pv-code] .cvh-prop, [data-pv-code] .cvh-str').length || 0`, 5000, 'json 着色').catch(() => 0);
      ctx.assert('JSON 高亮', hl > 0, hl);
      const fold = await ctx.eval(`!!${R}?.querySelector('[data-pv-code] .cm-foldGutter')`).catch(() => false);
      ctx.assert('可折叠（折叠槽）', fold, fold, { level: 'goal' });
      // 触屏上限 4MB、电脑 10MB（样张 9.96MB）：触屏应标截断且无编辑入口
      const notice = await ctx.eval(`(${R}?.querySelector('.doc-notice[role=status]')?.textContent || '')`).catch(() => '');
      ctx.metric('notice', notice.slice(0, 60));
      if (ctx.touch) ctx.assert('触屏：超过 4MB 标「仅显示前」', /仅显示前/.test(notice), notice.slice(0, 40));
      await ctx.shot();
    },
  },
  {
    id: 'text-log', title: '打开 12MB 日志：截断提示、不可编辑、级别着色',
    async run(ctx) {
      const t0 = Date.now();
      await ctx.open([ctx.item('代码/运行.log', { kind: 'text' })], 0);
      const ms = await codeOpen(ctx, '处理请求', t0);
      ctx.assert('log 打开 < 1s', ms != null && ms < 1000, ms, { level: 'goal' });
      const notice = await ctx.waitFor(`(${R}?.querySelector('.doc-notice[role=status]')?.textContent || '')`, 3000, '截断提示').catch(() => '');
      ctx.metric('notice', notice.slice(0, 60));
      ctx.assert('超过上限标「仅显示前 xx」', /仅显示前/.test(notice), notice.slice(0, 40));
      const edit = await ctx.eval(`!!${barBtn('编辑')}`).catch(() => true);
      ctx.assert('截断的文件没有编辑入口', !edit, edit);
      const lv = await ctx.eval(`({ err: ${R}?.querySelectorAll('.cv-lv-err').length || 0, warn: ${R}?.querySelectorAll('.cv-lv-warn').length || 0, ts: ${R}?.querySelectorAll('.cv-log-ts').length || 0 })`).catch(() => ({}));
      ctx.metric('logMarks', lv);
      ctx.assert('日志 ERROR / WARN 着色', lv.err > 0 && lv.warn > 0, lv);
      await ctx.shot();
    },
  },
  {
    id: 'text-gbk', title: 'GBK 文本自动识别',
    async run(ctx) {
      const t0 = Date.now();
      await ctx.open([ctx.item('代码/GBK编码.txt', { kind: 'text' })], 0);
      await codeOpen(ctx, '床前明月光', t0, { name: 'GBK 文本正确解码（床前明月光）' });
      const sub = await ctx.eval(`${R}?.querySelector('.vw-bar .vw-sub')?.textContent || ''`).catch(() => '');
      ctx.metric('subtitle', sub);
      ctx.assert('副标题标出编码', /GB18030/.test(sub), sub);
      await ctx.shot();
    },
  },
  {
    id: 'text-csv', title: '打开 3MB CSV：表格、冻结表头、看原文',
    async run(ctx) {
      const t0 = Date.now();
      await ctx.open([ctx.item('代码/表格.csv', { kind: 'office' })], 0);
      let ok = false;
      try { ok = await ctx.waitFor(`(() => { const g = ${R}?.querySelector('[data-pv-table]'); return !!g && (g.innerText || '').includes('城市'); })()`, 15000, '表格'); } catch {}
      ctx.metric('openMs', ok ? Date.now() - t0 : null);
      ctx.assert('CSV 以表格显示', ok, ok);
      const rows = await ctx.eval(`+(${R}?.querySelector('[data-pv-table]')?.getAttribute('aria-rowcount') || 0)`).catch(() => 0);
      ctx.metric('rows', rows);
      ctx.assert('行数 > 1000（全部解析）', rows > 1000, rows);
      const cells = await ctx.eval(`${R}?.querySelectorAll('[data-pv-table] [role=gridcell]').length || 0`).catch(() => 0);
      ctx.metric('domCells', cells);
      ctx.assert('虚拟滚动（DOM 格子 < 3000）', cells > 0 && cells < 3000, cells);
      const q = `(${R}?.querySelector('[data-pv-table]'))`;
      await ctx.eval(`(() => { const g = ${q}; g.scrollTop = 20000; return true; })()`);
      await ctx.sleep(300);
      const head = await ctx.eval(`(() => { const g = ${q}, h = g?.querySelector('[role=row]'); if (!h) return null; const a = g.getBoundingClientRect(), b = h.getBoundingClientRect(); return Math.round(b.top - a.top); })()`).catch(() => null);
      ctx.assert('滚动后表头冻结在顶', head != null && Math.abs(head) <= 2, head);
      await ctx.shot('table');
      await ctx.g.tapSel('.vw-bar [aria-label^="查看原文"]', { within: ctx.ROOT_SEL });
      const raw = await ctx.waitFor(`${cmText}.includes('序号,日期,城市')`, 5000, '原文').catch(() => false);
      ctx.assert('「查看原文」切到代码视图', raw, raw);
      await ctx.g.tapSel('.vw-bar [aria-label^="表格视图"]', { within: ctx.ROOT_SEL });
      const back = await ctx.waitFor(`!!${R}?.querySelector('[data-pv-table]')`, 5000, '回表格').catch(() => false);
      ctx.assert('切回表格', back, back);
    },
  },
  {
    id: 'text-tsv', title: '打开 TSV：表格',
    async run(ctx) {
      await ctx.open([ctx.item('代码/表格.tsv', { kind: 'office' })], 0);
      const ok = await ctx.waitFor(`(() => { const g = ${R}?.querySelector('[data-pv-table]'); return !!g && +g.getAttribute('aria-colcount') > 1; })()`, 10000, 'tsv 表格').catch(() => false);
      ctx.assert('TSV 以表格显示（多列）', ok, ok);
      await ctx.shot();
    },
  },
  {
    id: 'text-md-links', title: 'md：相对图片、相对 md 链接在查看器里开、相对 PDF 走预览',
    async run(ctx) {
      const t0 = Date.now();
      await ctx.open([ctx.item('笔记/笔记.md', { kind: 'markdown' })], 0);
      await C.text(ctx, '预览样张笔记', { t0, name: 'md 渲染' });
      await C.imagesLoaded(ctx, { min: 2, name: 'md 相对路径图片（≥2 张）' });
      const href0 = await ctx.eval('location.href');
      // 双链索引晚到会整篇重渲（块 HTML 变了的那段 DOM 换新）：等链接所在段落稳定再点，不然手指落下后元素被换掉、click 丢
      ctx.metric('linkSettleMs', await settleLink(ctx, '同目录的另一篇'));
      ctx.metric('linkTap', await tapLink(ctx, '同目录的另一篇'));
      const other = await ctx.waitFor(`(${R}?.innerText || '').includes('长文用来测滚动与目录')`, 8000, '另一篇').catch(() => false);
      const href1 = await ctx.eval('location.href');
      ctx.assert('相对 md 链接在查看器里打开', other, other);
      ctx.assert('没有整页跳转', href0 === href1, href1);
      await ctx.shot('other');
      // 返回上一篇（导航栈）
      await ctx.g.tapSel('.vw-bar .vw-close', { within: ctx.ROOT_SEL });
      const backOk = await ctx.waitFor(`(${R}?.innerText || '').includes('预览样张笔记')`, 6000, '回上一篇').catch(() => false);
      ctx.assert('返回回到上一篇', backOk, backOk);
      ctx.metric('pdfLinkSettleMs', await settleLink(ctx, 'PDF 附件'));
      ctx.metric('pdfLinkTap', await tapLink(ctx, 'PDF 附件'));
      const pdf = await ctx.waitFor(`(() => { const r = ${R}; const cv = r && [...r.querySelectorAll('canvas')].find((c) => c.width > 0 && __pvqa.canvasDrawn(c)); return !!cv; })()`, 15000, 'PDF 画出').catch(() => false);
      const href2 = await ctx.eval('location.href');
      ctx.assert('相对 PDF 链接在查看器里预览', pdf, pdf);
      ctx.assert('PDF 链接没有整页跳转', href0 === href2, href2);
      await ctx.shot('pdf');
    },
  },
  {
    id: 'text-html-source', title: 'HTML：源码切换',
    async run(ctx) {
      await ctx.open([ctx.item('网页/index.html', { kind: 'html' })], 0);
      await ctx.waitFor(`(() => { const f = ${R}?.querySelector('iframe'); return f && f.getBoundingClientRect().height > 50; })()`, 15000, 'iframe').catch(() => false);
      await ctx.g.tapSel('.vw-bar [aria-label^="源码"]', { within: ctx.ROOT_SEL });
      const src = await ctx.waitFor(`(${R}?.querySelector('[data-pv-source] .cm-content')?.textContent || '').includes('<')`, 8000, '源码').catch(() => false);
      ctx.assert('「源码」切到代码视图', src, src);
      const hl = await ctx.eval(`${R}?.querySelectorAll('[data-pv-source] .cvh-type').length || 0`).catch(() => 0);
      ctx.assert('HTML 源码着色（标签名）', hl > 0, hl);
      await ctx.shot('source');
      await ctx.g.tapSel('.vw-bar [aria-label^="查看页面"]', { within: ctx.ROOT_SEL });
      const page = await ctx.waitFor(`!${R}?.querySelector('[data-pv-source]') && !!${R}?.querySelector('iframe')`, 5000, '回页面').catch(() => false);
      ctx.assert('切回页面', page, page);
      await ctx.g.key('escape');
      await ctx.sleep(300);
      const closed = await ctx.waitFor(`!${R}`, 3000, '查看器关闭').catch(() => false);
      ctx.assert('Esc 关查看器（焦点在页面里也行）', closed, closed);
    },
  },
  {
    id: 'text-sniff', title: '无扩展名 / 点文件：嗅探；二进制给「无法预览 + 以文本方式打开」',
    async run(ctx) {
      await ctx.open([ctx.item('代码/.env.example')], 0);
      const env = await ctx.waitFor(`${cmText}.length > 5`, 8000, '点文件按文本显示').catch(() => false);
      ctx.assert('点文件 .env.example 按文本显示', env, env);
      await ctx.close();
      await ctx.sleep(300);
      await ctx.open([ctx.item('代码/Makefile')], 0);
      const mk = await ctx.waitFor(`${cmText}.length > 5`, 8000, 'Makefile').catch(() => false);
      ctx.assert('无扩展名文本 Makefile 按文本显示', mk, mk);
      await ctx.close();
      await ctx.sleep(300);
      await ctx.open([ctx.item('代码/二进制无扩展名')], 0);
      const bin = await ctx.waitFor(`(${R}?.innerText || '').includes('无法预览')`, 8000, '无法预览').catch(() => false);
      ctx.assert('二进制给「无法预览」', bin, bin);
      await ctx.shot('bin');
      await ctx.g.tapSel('button', { text: '以文本方式打开', within: ctx.ROOT_SEL });
      const forced = await ctx.waitFor(`!!${R}?.querySelector('[data-pv-code] .cm-content')`, 8000, '以文本方式打开').catch(() => false);
      ctx.assert('「以文本方式打开」后出代码视图', forced, forced);
    },
  },
  {
    id: 'text-svg-source', title: 'SVG：图片 ⇄ 源码（⋮ 里切）',
    async run(ctx) {
      await ctx.open([ctx.item('图片/矢量.svg', { kind: 'image' })], 0);
      const img = `!!${R}?.querySelector('img') && ${R}.querySelector('img').naturalWidth > 0`;
      await ctx.waitFor(img, 10000, 'svg 图片').catch(() => false);
      const viaMenu = async (label) => {
        // 触屏看图：顶栏 2.6s 后自动藏起来（藏着时点不到 ⋮）——像人一样先点一下画面把它叫出来
        if (await ctx.eval(`!!${R}?.querySelector('.vw-bar.vw-hide')`).catch(() => false)) {
          const st = await ctx.g.center('.vw-stage', { within: ctx.ROOT_SEL });
          await ctx.g.tap(st.x, st.y);
          await ctx.waitFor(`!${R}?.querySelector('.vw-bar.vw-hide')`, 3000, '顶栏出来').catch(() => false);
          await ctx.sleep(240);
        }
        await ctx.g.tapSel('.vw-bar [aria-label^="更多"]', { within: ctx.ROOT_SEL });
        // 触屏是 ios27 MorphMenu（弹簧从按钮长出来，项是 [role=menuitem]、不是 .vw-pop-it）、电脑是平的 .vw-pop：
        // 两端都按角色找；等落点真命中这一项、且隔两帧位置不动了再点（展开没到位时点下去会落在挡板上）
        const c = await ctx.waitFor(`(async () => {
          const at = () => { const it = [...document.querySelectorAll('[role=menu] [role=menuitem], [role=menu] [role=menuitemradio]')].find((b) => (b.textContent || '').includes(${JSON.stringify(label)}));
            if (!it) return null; const b = it.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const h = document.elementFromPoint(x, y); return { x, y, ok: !!h && (h === it || it.contains(h)) }; };
          const a = at(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const b = at();
          return a && b && b.ok && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 ? b : null; })()`, 5000, '菜单「' + label + '」可点');
        await ctx.g.tap(c.x, c.y);
      };
      await viaMenu('查看源码');
      const src = await ctx.waitFor(`${cmText}.includes('<svg')`, 8000, 'svg 源码').catch(() => false);
      ctx.assert('「查看源码」切到代码视图', src, src);
      // 文字先到、着色随 XML 语法包（懒加载）晚一拍：等着色出来，别在文字刚出现的那一帧就判
      const hl = await ctx.waitFor(`${R}?.querySelectorAll('[data-pv-code] .cvh-type').length || 0`, 4000, 'XML 着色').catch(() => 0);
      ctx.assert('SVG 源码按 XML 着色', hl > 0, hl);
      await ctx.shot('svg-source');
      await viaMenu('查看图片');
      const back = await ctx.waitFor(`${img} && !${R}?.querySelector('[data-pv-code]')`, 8000, '回到图片').catch(() => false);
      ctx.assert('「查看图片」切回图片', back, back);
    },
  },
  {
    id: 'text-md-find', title: 'md 预览：键盘滚动（PgDn / ↓ / 空格 / End / Home）、查看器内查找（计数、Enter 下一处、不分大小写、Esc 只关查找）',
    async run(ctx) {
      const t0 = Date.now();
      await ctx.open([ctx.item('笔记/另一篇.md', { kind: 'markdown' })], 0);
      await C.text(ctx, '长文用来测滚动与目录', { t0, name: 'md 渲染' });
      const SC = `${R}?.querySelector('.doc-scroll')`;
      const top = () => ctx.eval(`Math.round(${SC}?.scrollTop || 0)`);
      if (!ctx.touch) {
        // 电脑：打开即可用键盘滚（同浏览器 / Typora），不用先点一下正文
        await ctx.sleep(400);
        const s0 = await top();
        await ctx.g.key('pagedown'); await ctx.sleep(600);
        const s1 = await top();
        await ctx.g.key('down'); await ctx.sleep(400);
        const s2 = await top();
        await ctx.g.key('space'); await ctx.sleep(600);
        const s3 = await top();
        await ctx.g.key('end'); await ctx.sleep(700);
        const gap = await ctx.eval(`(() => { const el = ${SC}; return Math.round(el.scrollHeight - el.clientHeight - el.scrollTop); })()`);
        await ctx.g.key('home'); await ctx.sleep(700);
        const s4 = await top();
        const k = { s0, s1, s2, s3, gap, s4 };
        ctx.metric('keys', k);
        ctx.assert('PgDn 向下滚近一屏', s1 - s0 > 200, k);
        ctx.assert('↓ 往下滚一小段', s2 > s1, k);
        ctx.assert('空格 向下翻一屏', s3 - s2 > 200, k);
        ctx.assert('End 到底、Home 回顶', gap <= 2 && s4 <= 1, k);
      }
      // 查找：电脑 Ctrl+F（顶栏也有「查找」钮），触屏走 ⋯ 里的「查找…」
      const openFind = async () => {
        if (!ctx.touch) return ctx.g.key('ctrl+f');
        await ctx.g.tapSel('.vw-btn[aria-haspopup="menu"]', { within: ctx.ROOT_SEL });
        const c = await ctx.waitFor(`(async () => {
          const at = () => { const it = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((b) => (b.textContent || '').includes('查找'));
            if (!it) return null; const b = it.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const h = document.elementFromPoint(x, y); return { x, y, ok: !!h && (h === it || it.contains(h)) }; };
          const a = at(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const b = at();
          return a && b && b.ok && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 ? b : null; })()`, 5000, '菜单「查找…」可点');
        await ctx.g.tap(c.x, c.y);
      };
      const COUNT = `(${R}?.querySelector('.fb-count')?.textContent || '').trim()`;
      const focused = () => ctx.waitFor(`(() => { const i = ${R}?.querySelector('.fb input'); return !!i && document.activeElement === i; })()`, 4000, '查找框聚焦').catch(() => false);
      await openFind();
      ctx.assert('打开查找条、输入框拿到焦点', await focused(), null);
      await typeText(ctx, '长文用来测滚动');
      const c1 = await ctx.waitFor(`(() => { const c = ${COUNT}; return c.endsWith('/199') ? c : null; })()`, 5000, '命中 199 处').catch(() => null);
      ctx.metric('count', c1);
      ctx.assert('「长文用来测滚动」命中 199 处（计数 n/199）', !!c1, c1 || (await ctx.eval(COUNT)));
      const hl = await ctx.eval(`(() => { try { return CSS.highlights ? (CSS.highlights.get('md-hit')?.size || 0) : -1; } catch { return -2; } })()`);
      ctx.assert('命中处用 ::highlight 标出（不改 DOM）', hl === 199 || hl === -1, hl);
      const i1 = +(/^(\d+)\//.exec(c1 || '') || [])[1] || 0;
      await ctx.g.key('enter'); await ctx.sleep(400);
      const c2 = await ctx.eval(COUNT);
      ctx.assert('Enter 到下一处', (+(/^(\d+)\//.exec(c2) || [])[1] || 0) === (i1 % 199) + 1, { from: c1, to: c2 });
      // 当前项滚进可视区（不被顶栏 / 查找条挡住）
      const vis = await ctx.eval(`(() => { const c = CSS.highlights?.get('md-cur'); const r = c && [...c][0]; if (!r) return null; const b = r.getBoundingClientRect(); const s = ${SC}.getBoundingClientRect(); return { top: Math.round(b.top - s.top), bottom: Math.round(s.bottom - b.bottom) }; })()`);
      ctx.assert('当前项在滚动区的可视范围里', !vis || (vis.top >= 0 && vis.bottom >= 0), vis);
      await ctx.shot('find');
      await ctx.g.key('escape'); await ctx.sleep(400);
      const cl = await ctx.eval(`({ bar: !!${R}?.querySelector('.fb input'), hl: CSS.highlights ? (CSS.highlights.get('md-hit')?.size || 0) : 0, open: !!${R} })`);
      ctx.assert('Esc 只关查找、清高亮，查看器还开着', !cl.bar && cl.hl === 0 && cl.open, cl);
      // 不分大小写：代码块里全小写的「fib」要被「FIB」找到（4 处）
      await ctx.close(); await ctx.sleep(300);
      await ctx.open([ctx.item('笔记/笔记.md', { kind: 'markdown' })], 0);
      await C.text(ctx, '预览样张笔记', { name: 'md 渲染（笔记）', level: 'info' });
      await ctx.sleep(600);
      await openFind();
      await focused();
      await typeText(ctx, 'FIB');
      const c3 = await ctx.waitFor(`(() => { const c = ${COUNT}; return c.includes('/') ? c : null; })()`, 5000, '命中计数').catch(() => null);
      ctx.metric('caseFold', c3);
      ctx.assert('不分大小写：「FIB」找到全小写的 fib（4 处）', /\/4$/.test(c3 || ''), c3 || (await ctx.eval(COUNT)));
    },
  },
];

export default S.map((s) => ({ tags: ['text'], mode: 'web', timeout: 90000, ...s }));
