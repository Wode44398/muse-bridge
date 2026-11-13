// Media Studio 用宋体的展示文字（v3，方案 §9.2「字」）：只有这几句和字标「Media Studio」用宋体 600，
// 字体是只含这些字的子集（components/studio/fonts/studio-serif-600.woff2，安卓国产 ROM 缺中文衬线由此解决）。
// 改了这里的中文要重跑 `python web/src/components/studio/fonts/serif-subset.py`，否则新字会落到系统宋体。
// 英文走子集里的整套 ASCII，不用重跑。
import { t } from '../../lib/i18n.js';

/** 空态展示句（四个创作页各一句；不配说明句，维护者 2026-11-06：只写标签和状态） */
export const emptyLine = (page) => ({
  image: t('画点什么'),
  video: t('拍点什么'),
  voice: t('读点什么'),
  music: t('写首曲子'),
}[page] || '');
