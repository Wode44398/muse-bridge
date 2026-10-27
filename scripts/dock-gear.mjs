// 桌面主页 Dock「设置」齿轮字形的几何真相（web/src/desktop/home/DesktopHome.svelte）。
// 梯形齿 + 齿顶凸圆角 + 齿根凹圆角，切点全部解析求出，输出 viewBox 0 0 44 44 的 path d。
// 改齿形：调下面的参数 → `node scripts/dock-gear.mjs` → 把输出整段替换进 DesktopHome 的 dkGearG 那条 path。
const f = (v) => +v.toFixed(2);
const P = (p) => `${f(p[0])} ${f(p[1])}`;
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const pol = (r, t) => [r * Math.cos(t), r * Math.sin(t)];

// 圆角圆心：到齿面直线（过 a、b）的有向距离 = off（朝 side 一侧）、到原点距离 = R，取离 near 最近的解
function filletCenter(a, b, side, off, R, near) {
  const u = mul(sub(b, a), 1 / len(sub(b, a)));
  let n = [-u[1], u[0]]; if (dot(n, side) < 0) n = mul(n, -1);
  const base = add(a, mul(n, off));
  const B = 2 * dot(base, u), C = dot(base, base) - R * R;
  const disc = Math.sqrt(B * B - 4 * C);
  const c = [(-B + disc) / 2, (-B - disc) / 2].map((t) => add(base, mul(u, t)))
    .sort((p, q) => len(sub(p, near)) - len(sub(q, near)))[0];
  return { c, onLine: sub(c, mul(n, off)) };
}

export function gear({ cx = 22, cy = 22, N, Ro, Rr, tipW, rootW, rt, rr, hole, rot = -Math.PI / 2 }) {
  const aTip = tipW / 2 / Ro, aRoot = rootW / 2 / Rr, pitch = (2 * Math.PI) / N;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const th = rot + i * pitch, mid = pol(1, th);
    const Lr = pol(Rr, th - aRoot), Lt = pol(Ro, th - aTip);
    const Rr_ = pol(Rr, th + aRoot), Rt = pol(Ro, th + aTip);
    const tl = filletCenter(Lr, Lt, sub(mid, mul(Lr, 1 / Rr)), rt, Ro - rt, Lt);   // 齿顶：圆心在齿内
    const tr = filletCenter(Rr_, Rt, sub(mid, mul(Rr_, 1 / Rr)), rt, Ro - rt, Rt);
    const rl = filletCenter(Lr, Lt, sub(mul(Lr, 1 / Rr), mid), rr, Rr + rr, Lr);   // 齿根：圆心在齿槽
    const rrr = filletCenter(Rr_, Rt, sub(mul(Rr_, 1 / Rr), mid), rr, Rr + rr, Rr_);
    pts.push({
      rlCircle: mul(rl.c, Rr / len(rl.c)), rlLine: rl.onLine,
      tlLine: tl.onLine, tlCircle: mul(tl.c, Ro / len(tl.c)),
      trCircle: mul(tr.c, Ro / len(tr.c)), trLine: tr.onLine,
      rrLine: rrr.onLine, rrCircle: mul(rrr.c, Rr / len(rrr.c)),
    });
  }
  const T = (p) => P(add(p, [cx, cy]));
  let d = `M${T(pts[0].rlCircle)}`;
  for (let i = 0; i < N; i++) {
    const p = pts[i], nx = pts[(i + 1) % N];
    // y 向下：角度增大 = 顺时针 = sweep 1；齿根圆角是凹拐 sweep 0
    d += `A${f(rr)} ${f(rr)} 0 0 0 ${T(p.rlLine)}L${T(p.tlLine)}`;
    d += `A${f(rt)} ${f(rt)} 0 0 1 ${T(p.tlCircle)}A${f(Ro)} ${f(Ro)} 0 0 1 ${T(p.trCircle)}A${f(rt)} ${f(rt)} 0 0 1 ${T(p.trLine)}`;
    d += `L${T(p.rrLine)}A${f(rr)} ${f(rr)} 0 0 0 ${T(p.rrCircle)}A${f(Rr)} ${f(Rr)} 0 0 1 ${T(nx.rlCircle)}`;
  }
  d += 'Z';
  d += `M${f(cx + hole)} ${f(cy)}A${f(hole)} ${f(hole)} 0 1 0 ${f(cx - hole)} ${f(cy)}A${f(hole)} ${f(hole)} 0 1 0 ${f(cx + hole)} ${f(cy)}Z`;
  return d;
}

// 现役参数（2026-09-24 定稿）：8 齿，齿顶宽 5.4、齿根宽 7.4，齿顶圆角 1.5、齿根圆角 1.2，中心孔 5.4
console.log(gear({ N: 8, Ro: 17.6, Rr: 13.2, tipW: 5.4, rootW: 7.4, rt: 1.5, rr: 1.2, hole: 5.4 }));
