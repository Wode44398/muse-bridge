// 模型中心的五个种类线稿（文本 / 图像 / 视频 / 配音 / 音乐）：与设置页 SI（lib/settingsIcons.js）同一家族——
// 24 网格、1.6 描边、圆头圆角、只用 currentColor、不填色；画框类与 SI.wallpaper 共用 17×14、圆角 2.6 的外框，
// 摆在一起时外轮廓对齐（y 5~19），不会一枚大一枚小。种类不着色：种类只靠字形和文字区分（品牌色只留给品牌标）。
//
// KIND_GLYPH：只有内层路径（要自己套 <svg> 定尺寸 / 描边时用）；KIND_ICON：完整的 <svg> 字符串，{@html} 直接用，
// 尺寸由外层 CSS 定（svg 不写宽高）。

export const KIND_GLYPH = {
  // 文本：一个 T 字（顶梁两端下折 + 竖笔 + 底脚），不用对话气泡——气泡读作「聊天」，这里是「出文字的模型」
  text: '<path d="M5.5 8V5.5h13V8"/><path d="M12 5.5v13"/><path d="M9.5 18.5h5"/>',
  // 图像：画框 + 远近两道山 + 太阳（与 SI.wallpaper 同形）
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.6"/><path d="M3.8 16.2l4.3-4.3a1.5 1.5 0 0 1 2.1 0l5.6 5.6"/><path d="M13.7 15.3l1.5-1.5a1.5 1.5 0 0 1 2.1 0l3 3"/><circle cx="15.6" cy="9.4" r="1.4"/>',
  // 视频：同一个画框，里面一枚圆角播放三角（三角的重心落在框的正中，视觉上不偏左）
  video: '<rect x="3.5" y="5" width="17" height="14" rx="2.6"/><path d="M10.3 9.4v5.2a.7.7 0 0 0 1.05.6l4.2-2.6a.7.7 0 0 0 0-1.2l-4.2-2.6a.7.7 0 0 0-1.05.6z"/>',
  // 配音：话筒（胶囊 + 托架弧 + 立柱）。不用声波：声波和音乐太像，配音的本义是「人声」
  voice: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v2.5"/>',
  // 音乐：一对连梁八分音符（两道梁）
  music: '<path d="M9 17.5V6.6l10-2.1v10.9"/><circle cx="6.8" cy="17.5" r="2.2"/><circle cx="16.8" cy="15.4" r="2.2"/><path d="M9 9.6l10-2.1"/>',
};

const wrap = (g) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${g}</svg>`;

/** 完整的 svg 字符串：KIND_ICON.text / image / video / voice / music */
export const KIND_ICON = {
  text: wrap(KIND_GLYPH.text),
  image: wrap(KIND_GLYPH.image),
  video: wrap(KIND_GLYPH.video),
  voice: wrap(KIND_GLYPH.voice),
  music: wrap(KIND_GLYPH.music),
};
