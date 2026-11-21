// 抖动噪点瓦片：盖在大面积、很淡的模糊光晕上，抹掉 8 位色深量化出来的一圈圈同心色带。
// 每个像素是同一种颜色（黑或白）、透明度随机取 0–3/255：叠上去只把底下的像素随机压低 / 抬高 0–3 级，
// 肉眼看不出颗粒，但台阶的边被打散了。浅色底上白点没用（已经接近白），所以浅色用黑点、深色用白点。
// 运行时用 canvas 画一次、缓存成 data URL（随机数据压不动，做成静态资源反而大）。

const cache = new Map();

export function ditherTile(color = 'k', size = 96, maxAlpha = 3) {
  const key = color + size + ':' + maxAlpha;
  if (cache.has(key)) return cache.get(key);
  let url = '';
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    const v = color === 'w' ? 255 : 0;
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = Math.floor(Math.random() * (maxAlpha + 1));
    }
    ctx.putImageData(img, 0, 0);
    url = cv.toDataURL('image/png');
  } catch { url = ''; }
  cache.set(key, url);
  return url;
}
