// 模型档案 P0：报表用的小统计。n 小（每格 1–10 次）时通过率本身没意义，必须带区间：Wilson 95% 在 n 小、p 靠近 0 / 1 时
// 比正态近似靠谱得多。pass^k（τ-bench 的口径）= 同一题连跑 k 次全过的概率的无偏估计 C(c,k)/C(n,k)，按题平均——
// 看的是「稳不稳」，k=1 时就是通过率。

export function wilson(passed: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 0];
  const p = passed / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

// perTask：每题的 [通过次数, 总次数]；次数不足 k 的题不计入。返回 null = 没有一题够 k 次
export function passHatK(perTask: [number, number][], k: number): number | null {
  const usable = perTask.filter(([, n]) => n >= k);
  if (!usable.length) return null;
  return usable.reduce((s, [c, n]) => s + choose(c, k) / choose(n, k), 0) / usable.length;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const pct = (x: number | null, digits = 0) => (x === null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(digits)}%`);
export const ratio = (a: number, b: number) => (b ? a / b : null);
