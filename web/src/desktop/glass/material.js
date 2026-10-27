// 玻璃材质参数（批2 双引擎共享真相源）。
// 两个引擎读同一组数字，观感一致：
//   GlassScene.svelte（引擎甲，WebGL）—— 主页壁纸场景，真折射/菲涅尔/色散/磨砂
//   domGlass.js（引擎乙，SVG 位移 backdrop）—— 内容页背景，透镜剖面同一套
// 字段：
//   radius  圆角（999=胶囊/圆）      bevel   弯折带宽度 px（折射发生带）
//   refract 折射强度 px（弯折带峰值位移）disp  色散比例 0..1（RGB 通道分离）
//   frost   磨砂半径 px（0=纯透光）   glow    打光强度 0..1（菲涅尔/高光/边光/sheen）
//   tint    [r,g,b,a] 0..1（玻璃体着色，a=浓度）
//   sat/lift 厚介质：内部饱和度提升 / 提亮      sheen  45° 斜向柔光强度
//   zoom    全域微放大（珠子感，长条=0 内部平整） dispBand 参与色散的边带占比 0..1
// 材质分级定调：长条（dock/工具条）走「厚磨砂+宽弯折带」，小件（圆钮/胶囊）走「玻璃珠」。
// 原版全面采用（维护者 ?dvs 拍板「直接用原版」）：DOM 引擎胶囊类走原版滤镜逐字
// （lgMap + oBB 2% 模糊 + 无色散 + 粗环奶雾铬装）；GL 引擎与矩形类对齐原版语义——
// 磨砂改相对值 frostRel（原版 blur=尺寸 2%，随件自缩放）、奶雾 8%、环均匀化。
export const GLASS = {
  // 长条：厚介质配方——奶雾磨砂+提亮提饱和、宽弯折带、色散只在最外段、内部零形变
  bar:   { radius: 30,  bevel: 30, refract: 22, disp: 0.5,  frostRel: 0.03, frost: 2.0, glow: 0.9,
           tint: [1, 1, 1, 0.08], sat: 1.16, lift: 0.06, sheen: 0.07, zoom: 0, dispBand: 0.35 },
  // 信息面板：更磨砂保可读性
  panel: { radius: 22,  bevel: 26, refract: 22, disp: 0.28, frostRel: 0.035, frost: 2.6, glow: 0.55,
           tint: [1, 1, 1, 0.08], sat: 1.08, lift: 0.04, sheen: 0.05, zoom: 0.02, dispBand: 0.5 },
  // 小胶囊/圆钮：DOM 引擎=原版滤镜逐字（refract/disp 不参与，scale=原版位移强度）；
  // GL 引擎=真圆穹顶剖面 + 原版语义磨砂/奶雾
  pill:  { radius: 999, bevel: 999, refract: 22, disp: 0.2,  frostRel: 0.02, frost: 2.2, glow: 0.95,
           scale: 1, tint: [1, 1, 1, 0.08], sat: 1.06, lift: 0.03, sheen: 0.06, zoom: 0, dispBand: 0.6, lens: 1 },
};
// 兼容别名：Dock 即长条配方
GLASS.dock = GLASS.bar;

// 引擎乙用：tint 数组 → css 颜色
export const tintCss = (t) => (t && t[3] > 0
  ? `rgba(${Math.round(t[0] * 255)},${Math.round(t[1] * 255)},${Math.round(t[2] * 255)},${t[3]})`
  : 'transparent');
