// 作品墙的瀑布格（方案 §12.2）：纯函数，组件只拿结果去摆（绝对定位 + transform）。
// 比例一律是「高 / 宽」：格子宽由列数定，高跟着比例走。夹在 0.56–1.78：再扁再长的图在墙上也只是一条缝 / 一根柱子，
// 打开焦点才看全貌。

export const RATIO_MIN = 0.56;
export const RATIO_MAX = 1.78;
// 不知道比例时先按 4:3 排（图加载出来再按真实比例重排一次）
export const RATIO_GUESS = 0.75;

/** 列数：手机 2 列；中栏够宽才 3 / 4 列（按墙自己的宽，素材架、参数坞推拉时跟着变） */
export function wallCols(width, compact) {
  if (compact) return 2;
  return width >= 1180 ? 4 : width >= 700 ? 3 : 2;
}
export const wallGap = (compact) => (compact ? 6 : 10);

export function clampRatio(r) {
  const v = Number(r);
  if (!(v > 0) || !Number.isFinite(v)) return RATIO_GUESS;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, v));
}

/** 宽高 → 高 / 宽；缺一个就回 null */
export function ratioOf(w, h) {
  const a = Number(w), b = Number(h);
  return a > 0 && b > 0 ? b / a : null;
}

const ASPECT = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/;
const SIZE = /^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i;
/**
 * 任务发出时的比例参数 → 高 / 宽（取景框按它画）。认「16:9」这类比例值和「1024x1536」这类尺寸值；
 * 尺寸也可能是 { width, height }。都没有（「自动」、模型不收比例）回 null，由调用方按页面猜。
 */
export function ratioFromParams(params) {
  if (!params || typeof params !== 'object') return null;
  let size = null;
  for (const v of Object.values(params)) {
    if (typeof v === 'string') {
      const m = ASPECT.exec(v);
      if (m && Number(m[1]) > 0 && Number(m[2]) > 0) return Number(m[2]) / Number(m[1]);
      const s = SIZE.exec(v);
      if (s && !size) size = ratioOf(s[1], s[2]);
    } else if (v && typeof v === 'object' && !Array.isArray(v) && !size) {
      size = ratioOf(v.width, v.height);
    }
  }
  return size;
}

/**
 * 一面连续的瀑布格：按顺序往最矮的一列放（差不到半像素的算一样高，取靠左的，免得新的一件左右乱跳）。
 * ratios：每一格的高 / 宽（会被夹）；回 { boxes: [{ x, y, w, h, col }], height }，坐标保留一位小数。
 */
export function masonry(ratios, { width, cols, gap, top = 0 }) {
  const n = Math.max(1, cols | 0);
  const W = Math.max(0, Number(width) || 0);
  const cw = n > 1 ? (W - gap * (n - 1)) / n : W;
  const cy = new Array(n).fill(top);
  const r1 = (v) => Math.round(v * 10) / 10;
  const boxes = [];
  for (const r of ratios) {
    let c = 0;
    for (let j = 1; j < n; j++) if (cy[j] < cy[c] - 0.5) c = j;
    const h = Math.round(cw * clampRatio(r));
    boxes.push({ x: r1(c * (cw + gap)), y: r1(cy[c]), w: r1(cw), h, col: c });
    cy[c] += h + gap;
  }
  const height = boxes.length ? Math.max(...cy) - gap : 0;
  return { boxes, height: Math.max(0, r1(height)), colW: r1(cw) };
}
