// 手势库自检：不碰查看器，只在页面上盖一层透明测试板，核对每种手势真的产生了预期的 DOM 事件。
// 改 gestures.mjs 之后跑：node web/scripts/preview-qa/run.mjs --name a --scenarios selftest- --profiles p393,d1440 --no-shots
// 坑：板子刚插进 DOM 的那一帧，浏览器的输入命中测试还没算进它（第一下点按会落到 <html> 上）：插完等两帧再发手势。
const BOARD = `(async () => {
  document.getElementById('__pvqa_board')?.remove();
  const b = document.createElement('div');
  b.id = '__pvqa_board';
  b.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent;touch-action:none';
  const ev = window.__pvqaEv = [];
  const rec = (e) => ev.push({ t: e.type, n: e.touches ? e.touches.length : 0, ctrl: !!e.ctrlKey, key: e.key || '', dy: e.deltaY || 0, pt: e.pointerType || '' });
  for (const t of ['click', 'dblclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'wheel', 'mousemove', 'pointerdown', 'pointerup'])
    b.addEventListener(t, (e) => { rec(e); if (t === 'contextmenu' || t === 'wheel') e.preventDefault(); }, { passive: false });
  addEventListener('keydown', rec, { capture: true });
  document.body.appendChild(b);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
})()`;

const count = (evs, pred) => evs.filter(pred).length;

export default [
  {
    id: 'selftest-gestures',
    title: '手势库自检（tap / doubleTap / longPress / swipe / pinch / drag / wheel / key / hover）',
    tags: ['selftest'],
    timeout: 60000,
    async run(ctx) {
      const { w, h } = ctx.cfg;
      const c = { x: w / 2, y: h / 2 };
      const take = async () => { const e = await ctx.eval(`(() => { const e = window.__pvqaEv.slice(); window.__pvqaEv.length = 0; return e; })()`); await ctx.sleep(150); return e; };
      await ctx.eval(BOARD);
      try {
        await ctx.g.tap(c.x, c.y); await ctx.sleep(400);
        let e = await take();
        ctx.assert('tap → click', count(e, (x) => x.t === 'click') === 1, e.map((x) => x.t).join(','));

        await ctx.g.doubleTap(c.x, c.y); await ctx.sleep(400);
        e = await take();
        ctx.assert('doubleTap → 两次 click' + (ctx.touch ? '' : ' + dblclick'), count(e, (x) => x.t === 'click') === 2 && (ctx.touch || count(e, (x) => x.t === 'dblclick') === 1), e.map((x) => x.t).join(','));

        await ctx.g.longPress(c.x, c.y, { hold: 900 }); await ctx.sleep(400);
        e = await take();
        ctx.assert('longPress → contextmenu、不出 click', count(e, (x) => x.t === 'contextmenu') >= 1 && count(e, (x) => x.t === 'click') === 0, e.map((x) => x.t).join(','), { level: ctx.touch ? 'must' : 'info' });

        if (ctx.touch) {
          await ctx.g.swipe({ x: w * 0.8, y: c.y }, { x: w * 0.2, y: c.y }, { ms: 160, steps: 8 }); await ctx.sleep(300);
          e = await take();
          ctx.assert('swipe → touchstart/move/end、单指', count(e, (x) => x.t === 'touchstart') === 1 && count(e, (x) => x.t === 'touchmove') >= 4 && count(e, (x) => x.t === 'touchend') === 1 && e.every((x) => !x.t.startsWith('touch') || x.n <= 1), e.filter((x) => x.t.startsWith('touch')).map((x) => x.t + x.n).join(','));

          await ctx.g.pinch(c, 2, { steps: 8 }); await ctx.sleep(300);
          e = await take();
          ctx.assert('pinch → 两指 touchmove、抬手后不残留', count(e, (x) => x.t === 'touchmove' && x.n === 2) >= 4 && count(e, (x) => x.t === 'click') === 0, e.filter((x) => x.t.startsWith('touch')).map((x) => x.t + x.n).slice(0, 12).join(','));
          // 再点一下：如果上一场残留了触点，这次 touchstart 会带 2 根以上手指
          await ctx.g.tap(c.x, c.y); await ctx.sleep(300);
          e = await take();
          ctx.assert('pinch 之后单指点按只有 1 根手指', e.filter((x) => x.t === 'touchstart').every((x) => x.n === 1), e.filter((x) => x.t === 'touchstart').map((x) => x.n).join(','));
        } else {
          await ctx.g.drag({ x: c.x, y: c.y }, { x: c.x - 200, y: c.y - 100 }, { ms: 200 }); await ctx.sleep(200);
          e = await take();
          ctx.assert('drag → pointerdown、mousemove、pointerup', count(e, (x) => x.t === 'pointerdown') === 1 && count(e, (x) => x.t === 'mousemove') >= 4 && count(e, (x) => x.t === 'pointerup') === 1, e.map((x) => x.t).slice(0, 8).join(','));

          await ctx.g.wheel(c.x, c.y, { dy: -120, ticks: 2 });
          await ctx.g.wheel(c.x, c.y, { dy: -120, ticks: 1, ctrl: true }); await ctx.sleep(200);
          e = await take();
          const wh = e.filter((x) => x.t === 'wheel');
          ctx.assert('wheel ×2 + Ctrl+wheel ×1', wh.length === 3 && wh.filter((x) => x.ctrl).length === 1 && wh.every((x) => x.dy < 0), wh.map((x) => (x.ctrl ? 'ctrl' : '') + x.dy).join(','));

          await ctx.g.hover(c.x + 100, c.y + 50, { steps: 5, ms: 100 }); await ctx.sleep(200);
          e = await take();
          ctx.assert('hover → mousemove', count(e, (x) => x.t === 'mousemove') >= 3, count(e, (x) => x.t === 'mousemove'));
        }

        await ctx.g.key('arrowright'); await ctx.g.key('ctrl+0'); await ctx.g.key('escape'); await ctx.sleep(200);
        e = await take();
        const keys = e.filter((x) => x.t === 'keydown');
        ctx.assert('key → ArrowRight、Ctrl+0、Escape', keys.map((x) => (x.ctrl ? 'ctrl+' : '') + x.key).join(',') === 'ArrowRight,ctrl+0,Escape', keys.map((x) => (x.ctrl ? 'ctrl+' : '') + x.key).join(','));
      } finally {
        await ctx.eval(`(() => { document.getElementById('__pvqa_board')?.remove(); return true; })()`).catch(() => {});
      }
    },
  },
];
