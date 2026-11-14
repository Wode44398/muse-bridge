// 基线：电脑看图的滚轮缩放与鼠标拖动平移（痛点①）。现状预期：滚轮、Ctrl+滚轮、拖动都不改变图片 transform。
// 记录：每一步之后主图的 transform / scale / 位移、visualViewport.scale（Ctrl+滚轮若被浏览器拿去整页缩放会体现在这里）。
// 改版目标（goal）：滚轮按指针位置缩放、放大后可直接拖动平移、键盘 + / - / 0。
export default [
  {
    id: 'desk-wheel-zoom',
    title: '电脑：滚轮 / Ctrl+滚轮 / 拖动 / 键盘缩放大图',
    tags: ['baseline', 'desktop', 'zoom'],
    only: (cfg) => !cfg.touch,
    async run(ctx) {
      await ctx.open([ctx.item('图片/大图-8000x6000.jpg', { kind: 'image' })], 0);
      const s0 = await ctx.waitFor(`(() => { const s = __pvqa.imgState(); return s && s.complete && s.nw > 0 ? s : null; })()`, 20000, '主图');
      await ctx.sleep(500);
      const { w, h } = ctx.cfg;
      const c = { x: w * 0.62, y: h * 0.45 };   // 偏离中心：按指针位置缩放才看得出锚点
      const st = () => ctx.eval(`__pvqa.imgState()`);
      await ctx.g.wheel(c.x, c.y, { dy: -120, ticks: 3 });
      await ctx.sleep(600);
      const s1 = await st();
      await ctx.g.wheel(c.x, c.y, { dy: -120, ticks: 3, ctrl: true });
      await ctx.sleep(600);
      const s2 = await st();
      await ctx.g.drag({ x: w * 0.5, y: h * 0.5 }, { x: w * 0.5 - 200, y: h * 0.5 - 120 }, { ms: 300 });
      await ctx.sleep(600);
      const s3 = await st();
      await ctx.g.key('=');
      await ctx.g.key('+');
      await ctx.sleep(600);
      const s4 = await st();
      // 不绑实现：缩放看「显示宽 / 布局宽」（含祖先 transform），平移看显示矩形中心的位移
      const sc = (s) => Math.max(s?.scale ?? 1, s?.effScale ?? 1);
      const same = (p, q) => p && q && p.transform === q.transform && p.rect.w === q.rect.w && p.cx === q.cx && p.cy === q.cy;
      ctx.metric('t0', s0.transform);
      ctx.metric('wheel', { transform: s1?.transform, scale: sc(s1), vv: s1?.vv });
      ctx.metric('ctrlWheel', { transform: s2?.transform, scale: sc(s2), vv: s2?.vv });
      ctx.metric('drag', { transform: s3?.transform, cx: s3?.cx, cy: s3?.cy });
      ctx.metric('keyPlus', { transform: s4?.transform, scale: sc(s4) });
      ctx.metric('wheelChanged', !same(s0, s1));
      ctx.metric('ctrlWheelChanged', !same(s1, s2));
      ctx.assert('Ctrl+滚轮没有触发整页缩放', (s2?.vv ?? 1) === 1, s2?.vv);
      ctx.assert('滚轮缩放图片', sc(s1) > 1.05, sc(s1), { level: 'goal' });
      ctx.assert('放大后拖动平移', !!s3 && !!s2 && (Math.abs(s3.cx - s2.cx) > 20 || Math.abs(s3.cy - s2.cy) > 20), s3 && { dx: s3.cx - (s2?.cx ?? 0), dy: s3.cy - (s2?.cy ?? 0) }, { level: 'goal' });
      ctx.assert('键盘 + 放大', sc(s4) > sc(s3) + 0.05, sc(s4), { level: 'goal' });
      await ctx.shot();
    },
  },
  {
    id: 'desk-keys-gallery',
    title: '电脑：← → 翻页、Esc 关闭',
    tags: ['baseline', 'desktop', 'keys'],
    only: (cfg) => !cfg.touch,
    async run(ctx) {
      const items = ctx.gallery('序列').slice(0, 5);
      await ctx.open(items, 0);
      await ctx.waitFor(`__pvqa.itemPainted(0)`, 20000, '首张');
      await ctx.g.key('arrowright');
      await ctx.sleep(300);
      const i1 = await ctx.eval(`__pvqa.pv.preview.index`);
      await ctx.g.key('arrowleft');
      await ctx.sleep(300);
      const i2 = await ctx.eval(`__pvqa.pv.preview.index`);
      ctx.assert('→ 下一张', i1 === 1, i1);
      ctx.assert('← 上一张', i2 === 0, i2);
      await ctx.shot();
      await ctx.g.key('escape');
      await ctx.sleep(400);
      const open = await ctx.eval(`__pvqa.pv.preview.open`);
      ctx.assert('Esc 关闭查看器', open === false, open);
    },
  },
];
