// 场景模板（文件名以 _ 开头不会被加载）。复制成 scenarios/<你的主题>.mjs，export default 一个场景或数组。
//
// 字段：
//   id        唯一（--scenarios 按前缀筛），建议「主题-动作」：pdf-zoom、video-seek……
//   title     一句话
//   tags      ['baseline'|'open'|'swipe'|'local'|...]（--tags 按标签筛）
//   mode      'web'（普通网页、云端文件，默认）| 'apk'（装本地桩：离线壳 + 手机本地文件）| 'apk:<毫秒>'（本地桩 + 每请求延迟，模拟 SAF 慢路径）
//   profiles  只在这些视口档跑（缺省 = 运行时 --profiles 给的全部）；only(cfg) 进一步按档过滤（cfg.touch / cfg.w / cfg.theme）
//   timeout   毫秒，缺省 90000
//   run(ctx)  主体；cleanup(ctx) 可选（运行器已自动关查看器、复原降速 / 限网 / 缓存）
//
// ctx 常用：
//   ctx.item('图片/透明.png', { kind: 'image' })      样张相对路径 → 查看器描述符（apk 模式给 local、否则 cloud；可传 origin 强制）
//   ctx.gallery('序列', { filter: /\.jpg$/ })          目录下的条目（排好序）
//   await ctx.open(items, index)                      同 FilesPanel 的 openPreview，等查看器根出现
//   await ctx.waitFor(`页面表达式`, ms, '说明')         表达式可用 __pvqa.*（lib/page.mjs）：root() mainImg() imgState() itemPainted(i) paintedAt() smallTargets(44) canvasDrawn(cv)
//   await ctx.eval(`页面表达式`)
//   ctx.g.tap(x,y) / doubleTap / longPress / swipe(from,to,{ms,steps}) / pinch(center,scale) / drag / wheel(x,y,{dy,ctrl}) / key('ctrl+0') / hover
//   ctx.g.tapSel('.mv-top button', { text: '关闭', within: ctx.ROOT_SEL })   选择器点按（先滚进视口、确认落点）
//   await ctx.throttle({ cpu: 4, network: '4g', cache: false })
//   ctx.assert('名字', 条件, 值, { level: 'must'|'goal'|'info' })   must 不过 = 场景不过；goal = 改版目标
//   ctx.metric('名字', 值)                             进 report.json 与 summary.md（_ 开头的只进 report.json）
//   await ctx.shot('名字')                            截图（JPEG）+ 通用检测：越界 / 裁切 / 点按区 <32 / 触屏命中区 <44 / 安全区
//   ctx.local                                         apk 模式下的本地桩：ctx.local.rel('图片/x.jpg')、ctx.local.server.stats
//   ctx.cfg / ctx.touch / ctx.ROOT_SEL
//
// 坑：查看器的按钮选择器一律带作用域（ctx.ROOT_SEL 下），keep-alive 的隐藏分页里有同名元素；多指别调 .click()；
//     连做几次滑动场间 sleep 约 2 秒；结论靠数值（transform、rect、naturalWidth），截图只做佐证。
import * as C from '../lib/checks.mjs';

export default {
  id: 'example-open-png',
  title: '示例：打开透明 PNG，双击放大',
  tags: ['example'],
  mode: 'web',
  profiles: ['p393', 'd1440'],
  async run(ctx) {
    const t0 = Date.now();
    await ctx.open([ctx.item('图片/透明.png', { kind: 'image' })], 0);
    await C.image(ctx, { t0 });
    const { w, h } = ctx.cfg;
    await ctx.g.doubleTap(w / 2, h / 2);
    await ctx.sleep(500);
    const st = await ctx.eval(`__pvqa.imgState()`);
    ctx.metric('scaleAfterDoubleTap', st?.scale);
    ctx.assert('双击放大', (st?.scale ?? 1) > 1.5, st?.scale, { level: 'goal' });
    await ctx.shot('zoomed');
  },
};
