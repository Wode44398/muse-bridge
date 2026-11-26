// 量主页入口图标的「墨迹」：每张 SVG 按 object-fit: contain 放进一个方框后，实际画出来的部分
// 占框的哪一块、重心在哪。主页（web/src/components/Home.svelte 的 ICON_FIT）按这些数给每枚图标
// 定大小和位移——图标素材换了、画板留白变了，就重跑一遍再改那张表，别凭眼睛调。
// 用法：node scripts/brand/measure-home-icons.cjs
// 输出的数都以「框边长 = 100」计：w/h 墨迹宽高，cx/cy 墨迹边界中心相对框中心的偏移（右、下为正），
// mx/my 按不透明度加权的重心偏移，cover 墨迹面积占框面积的百分比。
const sharp = require('sharp');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const ICONS = 'web/public/assets/icons/', MASCOT = 'web/src/visuals/assets/mascot/';
const FILES = {
  'claude 站立': MASCOT + 'claude-小人-正面站立.svg',
  'claude 举旗': MASCOT + 'claude-小人-举旗.svg',
  chatgpt: ICONS + 'chatgpt-dark.svg',
  codex: ICONS + 'codex-dark.svg',
  agy: ICONS + 'antigravity.svg',
  dimensio: ICONS + 'dimensio-dark.svg',
  studio: ICONS + 'studio-dark.svg',
};
const S = 800;   // 栅格边长：够大，量到 0.1% 没问题

(async () => {
  for (const [name, file] of Object.entries(FILES)) {
    const { data } = await sharp(path.join(root, file), { density: 600 })
      .resize(S, S, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let x0 = S, y0 = S, x1 = -1, y1 = -1, sa = 0, sx = 0, sy = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const a = data[(y * S + x) * 4 + 3];
      if (a > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      sa += a; sx += a * x; sy += a * y;
    }
    const pct = (v) => (v / S * 100).toFixed(1).padStart(6);
    console.log(name.padEnd(12),
      'w', pct(x1 + 1 - x0), ' h', pct(y1 + 1 - y0),
      ' cx', pct((x0 + x1 + 1) / 2 - S / 2), ' cy', pct((y0 + y1 + 1) / 2 - S / 2),
      ' mx', pct(sx / sa - S / 2), ' my', pct(sy / sa - S / 2),
      ' cover', (sa / 255 / (S * S) * 100).toFixed(1).padStart(5));
  }
})();
