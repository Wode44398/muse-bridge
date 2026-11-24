// agy 输入框右端「仪表分身出发送键」用的小弹簧引擎与形状生成（Material 3 Expressive 动效语言）：
// - 弹簧参数取 M3 Expressive motion scheme 的量级：空间类（位移 / 尺寸 / 形状）允许回弹，效果类（透明度）临界阻尼不回弹。
// - 形状：超椭圆指数 p（2 = 圆，≈3.4 = M3 圆角方）× 波瓣调制（n 瓣、幅度 a，即 M3 的 cookie / soft-burst），整体旋转 rot。
//   用同一个参数化形状在「曲奇 → 圆 → 圆角方」之间连续变形，而不是缩放一张固定图形。
// 只在有弹簧没停下时跑 rAF，全部停稳即自停（被盖住的逐帧订阅者必须自停）。

export class Spring {
  constructor(x, stiffness, damping) {
    this.x = x; this.target = x; this.v = 0;
    this.tune(stiffness, damping);
  }
  tune(stiffness, damping) {
    this.k = stiffness;
    this.c = 2 * damping * Math.sqrt(stiffness);
    return this;
  }
  to(target) { this.target = target; return this; }
  jump(x) { this.x = x; this.target = x; this.v = 0; return this; }
  kick(v) { this.v += v; return this; }
  step(dt) {
    const a = -this.k * (this.x - this.target) - this.c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
  }
  settled(eps = 0.002) {
    return Math.abs(this.x - this.target) < eps && Math.abs(this.v) < eps * 20;
  }
}

// 半隐式欧拉，按 1/240s 细分保证高刚度稳定；dt 上限 1/30 防切后台回来一大步
export function stepAll(springs, dt) {
  const h = 1 / 240;
  let left = Math.min(dt, 1 / 30);
  while (left > 1e-6) {
    const d = Math.min(h, left);
    for (const s of springs) s.step(d);
    left -= d;
  }
}

const N = 120;
// 以 (cx, cy) 为心的闭合路径。R = 半宽；p = 超椭圆指数；a / n = 波瓣幅度与瓣数；rot = 旋转角（度）；sx / sy = 轴向拉伸
export function blobPath(R, p, a, n, rot, cx = 0, cy = 0, sx = 1, sy = 1) {
  if (R <= 0.15) return '';
  const pp = Math.max(1.7, p);
  const rr = (rot * Math.PI) / 180;
  const cr = Math.cos(rr), sr = Math.sin(rr);
  let d = '';
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    const c = Math.cos(th), s = Math.sin(th);
    const se = Math.pow(Math.pow(Math.abs(c), pp) + Math.pow(Math.abs(s), pp), -1 / pp);
    const r = Math.max(0, R) * se * (1 + a * Math.cos(n * th));
    const x0 = r * c * sx, y0 = r * s * sy;
    const x = cx + (x0 * cr - y0 * sr);
    const y = cy + (x0 * sr + y0 * cr);
    d += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
  }
  return d + 'Z';
}

// 解析液滴分身桥（纯矢量切线凹颈，零高斯模糊，60fps 零锯齿）：
// 连接水平两圆 (x1, r1) 与 (x2, r2)，strength ∈ (0, 1] 控制液桥饱满度与拉断收缩
export function metaballBridge(x1, r1, x2, r2, strength) {
  if (strength <= 0.015) return '';
  const dist = Math.abs(x1 - x2);
  if (dist < 2 || r1 < 3 || r2 < 3) return '';
  if (dist > r1 + r2 + 24) return '';
  const rightX = Math.max(x1, x2);
  const leftX = Math.min(x1, x2);
  const rr = x1 >= x2 ? r1 : r2;
  const lr = x1 >= x2 ? r2 : r1;
  const spread = 0.58 + 0.24 * strength;
  const aL = Math.min(1.05, spread);
  const aR = Math.min(1.05, spread);
  const lx = leftX + lr * Math.cos(aL);
  const ly = lr * Math.sin(aL);
  const rx = rightX - rr * Math.cos(aR);
  const ry = rr * Math.sin(aR);
  const midX = (lx + rx) * 0.5;
  const neckHalf = Math.max(0.8, Math.min(lr, rr) * (0.58 * Math.pow(strength, 1.35)));
  return [
    `M ${lx.toFixed(2)} ${(-ly).toFixed(2)}`,
    `Q ${midX.toFixed(2)} ${(-neckHalf).toFixed(2)} ${rx.toFixed(2)} ${(-ry).toFixed(2)}`,
    `L ${rx.toFixed(2)} ${ry.toFixed(2)}`,
    `Q ${midX.toFixed(2)} ${neckHalf.toFixed(2)} ${lx.toFixed(2)} ${ly.toFixed(2)}`,
    'Z',
  ].join(' ');
}
