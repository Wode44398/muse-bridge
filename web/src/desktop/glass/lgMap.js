// 胶囊 / 圆形玻璃（domGlass 的 objectBoundingBox 管线）用的位移贴图：200×200 的圆形透镜。
// R/G 通道 = 位移向量（128 = 不动），圆外不动；objectBoundingBox 引用可套任意尺寸的圆 / 胶囊。
// 贴图是原版资源（visuals/modules/lg-map.js，导出 LG_MAP = data URL；32KB，懒加载）。

let pending = null;
/** → Promise<data URL>（模块加载失败 → ''，调用方按没有贴图处理） */
export function lgMap() {
  if (!pending) {
    pending = import('../../visuals/modules/lg-map.js')
      .then((m) => m.LG_MAP)
      .catch(() => '');
  }
  return pending;
}
