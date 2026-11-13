// 液态玻璃 · Apple iOS 27 UI Kit 规格（「长什么样」）
// 数据源：Figma 编辑器内置 UI kits → iOS and iPadOS 27（取样草稿 FJhrG73zAPCTmYdQd5jNkA，组件树在 design/ios27-settings/cases/trees），
// 由样稿的 verify/gen-kit.js 程序化导出（lg-kit-data.js），这里只摘 bridge 用到的几块。动画参数一个都不放（见 core.js）。
// 几何单位 pt = CSS px；颜色 0–1。开关 / 滑块按下态旋钮明暗两份完全相同，只存一份。

const KNOB = (w, h, ring, glass, spec) => ({ frame: { w, h }, layers: [ring, glass, spec] });

/* 开关按下态旋钮（kit「Toggle - Switch · Pressed」的 Knob 帧，58×38） */
const TOGGLE_KNOB = KNOB(58, 38,
  { name: 'Shadow', x: 0, y: 7, w: 58, h: 38, r: 1000, opacity: .5, effects: [{ type: 'LAYER_BLUR', radius: 6 }] },
  { name: 'Glass Effect', x: -1, y: -1, w: 60, h: 40, r: 1000,
    fills: [{ color: [1, 1, 1], opacity: .0902, blend: 'NORMAL' }],
    strokes: [{ color: [.8, .8, .8], opacity: 1, blend: 'LINEAR_BURN' }], strokeWeight: .5, strokeAlign: 'INSIDE',
    effects: [
      { type: 'GLASS', frost: 0, refraction: .8, depth: 7, dispersion: 0, lightAngle: 0, lightIntensity: 0, splay: 0 },
      { type: 'INNER_SHADOW', color: [.902, .902, .902, 1], radius: 30, x: 0, y: 40, spread: -40, blend: 'LINEAR_BURN' },
      { type: 'INNER_SHADOW', color: [.1569, .1569, .1569, 1], radius: 10, x: 0, y: -40, spread: -40, blend: 'LINEAR_DODGE' },
      { type: 'INNER_SHADOW', color: [.1569, .1569, .1569, 1], radius: 10, x: 0, y: 40, spread: -40, blend: 'LINEAR_DODGE' },
    ] },
  { name: 'Specular Light', x: 0, y: 0, w: 58, h: 38, r: 1000,
    fills: [{ color: [1, 1, 1], opacity: 1, blend: 'MULTIPLY' }],
    effects: [
      { type: 'INNER_SHADOW', color: [.1569, .1569, .1569, 1], radius: .5, x: 0, y: -3, spread: -2.25, blend: 'LINEAR_DODGE' },
      { type: 'INNER_SHADOW', color: [.1569, .1569, .1569, 1], radius: .5, x: 0, y: 3, spread: -2.25, blend: 'LINEAR_DODGE' },
    ] });

/* 滑块按下态旋钮（kit「Sliders · Pressed」，57×38）。导出的实例里 Glass Effect 的 x 有 +2 偏差：
   参考图量得玻璃以旋钮中心左右对称，与开关同为 x = −1（样稿 lg-kit.js 已核对） */
const SLIDER_KNOB = KNOB(57, 38,
  { name: 'Shadow', x: 0, y: 7, w: 57, h: 38, r: 1000, opacity: .4, effects: [{ type: 'LAYER_BLUR', radius: 6 }] },
  { name: 'Glass Effect', x: -1, y: -1, w: 59, h: 40, r: 1000,
    fills: [{ color: [1, 1, 1], opacity: .0902, blend: 'NORMAL' }],
    strokes: [{ color: [.8, .8, .8], opacity: 1, blend: 'LINEAR_BURN' }], strokeWeight: .5, strokeAlign: 'INSIDE',
    effects: [
      { type: 'GLASS', frost: 0, refraction: .8, depth: 7, dispersion: 0, lightAngle: 0, lightIntensity: 0, splay: 0 },
      { type: 'INNER_SHADOW', color: [.9, .9, .9, 1], radius: 25, x: 0, y: 15, spread: -10, blend: 'LINEAR_BURN' },
      { type: 'INNER_SHADOW', color: [.1569, .1569, .1569, 1], radius: 10, x: 0, y: -40, spread: -40, blend: 'LINEAR_DODGE' },
      { type: 'INNER_SHADOW', color: [.25, .25, .25, 1], radius: 10, x: 0, y: 40, spread: -40, blend: 'LINEAR_DODGE' },
    ] },
  { name: 'Specular Light', x: 0, y: 0, w: 57, h: 38, r: 1000,
    fills: [{ color: [1, 1, 1], opacity: 1, blend: 'MULTIPLY' }],
    effects: [
      { type: 'INNER_SHADOW', color: [.1569, .1569, .1569, 1], radius: .5, x: 0, y: -3, spread: -2.25, blend: 'LINEAR_DODGE' },
      { type: 'INNER_SHADOW', color: [.1569, .1569, .1569, 1], radius: .5, x: 0, y: 3, spread: -2.25, blend: 'LINEAR_DODGE' },
    ] });

/* 菜单面板（kit「Menu」＝ Liquid Glass - Regular - Medium，圆角 34）明 / 暗 */
const HAIR = (c) => [
  { type: 'DROP_SHADOW', color: [c, c, c, 1], radius: 0, x: 0, y: 0, spread: .5, blend: 'LINEAR_BURN' },
  { type: 'DROP_SHADOW', color: [c, c, c, 1], radius: 0, x: -1.25, y: 0, spread: -.75, blend: 'LINEAR_BURN' },
  { type: 'DROP_SHADOW', color: [c, c, c, 1], radius: 0, x: 1.25, y: 0, spread: -.75, blend: 'LINEAR_BURN' },
];
const MEDIUM_GLASS = (hi) => ({ name: 'Glass Effect', x: 0, y: 0, r: 34, fills: [{ color: [1, 1, 1], opacity: 1, blend: 'MULTIPLY' }],
  effects: [
    { type: 'GLASS', frost: 16, refraction: .7, depth: 30, dispersion: .2, lightAngle: 0, lightIntensity: .25, splay: .2 },
    { type: 'INNER_SHADOW', color: [hi, hi, hi, 1], radius: 10, x: 0, y: -40, spread: -40, blend: 'LINEAR_DODGE' },
    { type: 'INNER_SHADOW', color: [hi, hi, hi, 1], radius: 10, x: 0, y: 40, spread: -40, blend: 'LINEAR_DODGE' },
  ] });
const MEDIUM = {
  light: [
    { name: 'Fill + Shadow', x: 0, y: 0, r: 34,
      fills: [{ color: [1, 1, 1], opacity: .7, blend: 'LIGHTEN' }, { color: [.749, .749, .749], opacity: .1, blend: 'DARKEN' }],
      effects: [{ type: 'DROP_SHADOW', color: [0, 0, 0, .25], radius: 48, x: 0, y: 8, spread: 0, blend: 'NORMAL' }, ...HAIR(.8588)] },
    MEDIUM_GLASS(.1569),
  ],
  dark: [
    { name: 'Fill + Shadow', x: 0, y: 0, r: 34,
      fills: [{ color: [.102, .102, .102], opacity: .7, blend: 'LUMINOSITY' }, { color: [.102, .102, .102], opacity: .9, blend: 'LUMINOSITY' }, { color: [.102, .102, .102], opacity: 1, blend: 'LIGHTEN' }],
      effects: [{ type: 'DROP_SHADOW', color: [0, 0, 0, .45], radius: 48, x: 0, y: 8, spread: 0, blend: 'NORMAL' }, ...HAIR(.651)] },
    MEDIUM_GLASS(.102),
  ],
};

const clone = (o) => JSON.parse(JSON.stringify(o));
export const KIT = {
  /* 开关：Toggle - Switch，64×28 胶囊、内距 2、旋钮 38×24；按下态旋钮 58×38（中心不变） */
  toggle: { w: 64, h: 28, pad: 2, knob: [38, 24], pressed: [58, 38], travel: 64 - 2 * 2 - 38 },
  /* 滑块：Sliders，轨道 6 高圆角 3，旋钮 38×24（中心落在 [19, 宽−19]，填充画到旋钮中心）；按下态 57×38 */
  slider: { trackH: 6, knob: [38, 24], pressed: [57, 38] },
  /* 菜单：Menu（Medium），圆角 34、上下内距 10；快捷操作 / 按下滑选高亮借 kit 快捷操作按下底（R20、左右内缩 10） */
  menu: { r: 34, padV: 10, hlInset: 10, hlR: 20 },
  // 按下态旋钮：Shadow（外部模糊环）、Glass Effect、Specular Light，坐标相对旋钮帧
  knobPressed: (kind) => clone(kind === 'slider' ? SLIDER_KNOB : TOGGLE_KNOB),
  // 菜单材质：w×h、R34
  medium: (dark, w, h) => clone(MEDIUM[dark ? 'dark' : 'light']).map((L) => ({ ...L, w, h })),
  // 滑块静止旋钮的两道投影（0/6/13 与 0/0.5/4 黑 12%）
  sliderKnobShadows: [
    { x: 0, y: 6, radius: 13, spread: 0, color: [0, 0, 0, .12] },
    { x: 0, y: .5, radius: 4, spread: 0, color: [0, 0, 0, .12] },
  ],
};
