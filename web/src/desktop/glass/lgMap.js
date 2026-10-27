// 胶囊 / 圆形玻璃（domGlass 的 objectBoundingBox 管线）用的位移贴图：200×200 的圆形透镜。
// R/G 通道 = 位移向量（128 = 不动），圆外不动；objectBoundingBox 引用可套任意尺寸的圆 / 胶囊。
// 公开版是这里自写的解析式剖面（中心不动、越近边缘越往里收，像一块凸透镜）；
// 维护者的私有 overlay 可提供另一张（清单 modules.lgMap，导出 LG_MAP = data URL）。
import { ovModule } from '../../lib/overlay.svelte.js';

const N = 200;
let own = '';

/** 自写的圆透镜位移图（data URL，生成一次）。 */
export function ownLensMap() {
  if (own) return own;
  try {
    const cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    const ctx = cv.getContext('2d');
    const id = ctx.createImageData(N, N);
    const d = id.data;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = ((x + 0.5) / N) * 2 - 1, v = ((y + 0.5) / N) * 2 - 1;
        const r = Math.hypot(u, v);
        let dx = 0, dy = 0;
        if (r < 1 && r > 0) {
          // 剖面：g(r) = 0.06r + 0.94r^1.8 —— 中间几乎平，边缘陡，指向圆心
          const g = 0.06 * r + 0.94 * Math.pow(r, 1.8);
          dx = -(u / r) * g; dy = -(v / r) * g;
        }
        const i = (y * N + x) * 4;
        d[i] = Math.round(128 + dx * 127);
        d[i + 1] = Math.round(128 + dy * 127);
        d[i + 2] = 0;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
    own = cv.toDataURL('image/png');
  } catch { own = ''; }
  return own;
}

let pending = null;
/** 用哪张：overlay 有就用它的，否则自写的。→ Promise<data URL> */
export function lgMap() {
  if (!pending) {
    pending = ovModule('lgMap')
      .then((m) => (m && typeof m.LG_MAP === 'string' && m.LG_MAP ? m.LG_MAP : ownLensMap()))
      .catch(() => ownLensMap());
  }
  return pending;
}
