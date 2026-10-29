// 给 Claude 的提示词段：主动用进程内的媒体生成工具（mcp__media__*）做配图 / 配乐 / 朗读，
// 以及选型与质量门。原文一字未改搬自 agents/claude.mjs。
// 设置 › Agent › Gemini 全是默认（主动生成、四种都开、视频不封顶）时原样用 MEDIA_NUDGE——系统提示一字不变，
// 已有会话的提示缓存不受影响；改过才按 mediaNudgeFor 现拼一版（只提开着的工具，不主动时改成「只在用户要求时」）。
export const MEDIA_NUDGE = '\n\n你还有一组「媒体生成」MCP 工具：mcp__media__generate_image（图像）、mcp__media__generate_video（视频，慢 1-3 分钟且较贵）、mcp__media__generate_speech（把文字读成语音）、mcp__media__generate_music（音乐）。当任务需要这类素材时——比如做网页/文档需要配图、需要背景音乐、需要把文字朗读出来——你应当【主动】调用它们，不必等用户点名要求。每次调用：① 产物会内嵌展示给用户；② 返回值里带产物的【绝对文件路径】，你可以用 Read 查看它、或用 Bash 把它复制进你正在做的项目当素材（例如嵌进 HTML 引用）。视频又慢又贵，仅在用户明确需要时才用。\n\n【按需选模型与质量】做网页等多图任务别一律默认顶配：显眼大图（hero/整屏背景）用默认模型 + imageSize:"4K"（页面轻量用 2K）；正文插图 2K；图标/小装饰用 imageSize:"1K" 或换 model:"gemini-3.1-flash-lite-image"（最省、只出 1K）省成本。视频默认 720p，hero 传 resolution:"1080p"、确需超清才 "4k"；要带声音/对白的片段或省钱预览（360p）可换 model:"gemini-omni-1.1-flash"。同一页面多图复用同一组风格词保持一致。\n\n【质量门】正式图像素材生成后，务必用 Read 回看自检：① 主体/内容对不对 ② 构图能否用（hero 要留出放标题的负空间、关键物别被裁）③ 比例对不对 ④ 有无明显瑕疵（畸变 / 乱码文字 / 多余肢体 / 水印感）⑤ 风格是否跟页面其它素材一致。不过关且可修就调 prompt（加负面词，如 clean composition, no text, no watermark）或换模型/尺寸重生成，最多 2 次；仍不行就用最好一版并一句话说明短板。';

const KINDS = ['image', 'video', 'speech', 'music'];
const TOOL_LABEL = {
  image: 'mcp__media__generate_image（图像）',
  video: 'mcp__media__generate_video（视频，慢 1-3 分钟且较贵）',
  speech: 'mcp__media__generate_speech（把文字读成语音）',
  music: 'mcp__media__generate_music（音乐）',
};

/** kinds：开着的种类（image / video / speech / music）；videoCap：视频分辨率上限（'4k' = 不封顶）。 */
export function mediaNudgeFor({ proactive = true, kinds = KINDS, videoCap = '4k' } = {}) {
  const on = KINDS.filter((k) => kinds.includes(k));
  if (!on.length) return '';
  if (proactive && on.length === KINDS.length && videoCap === '4k') return MEDIA_NUDGE;
  const img = on.includes('image'), vid = on.includes('video');
  let s = '\n\n你还有一组「媒体生成」MCP 工具：' + on.map((k) => TOOL_LABEL[k]).join('、') + '。';
  s += proactive
    ? '当任务需要这类素材时——比如做网页/文档需要配图、需要背景音乐、需要把文字朗读出来——你应当【主动】调用它们，不必等用户点名要求。'
    : '只在用户明确要求生成图片、视频、语音或音乐时才调用它们；做网页、文档时别为了配图、配乐主动去生成（管理员在设置里关掉了「主动生成」）。';
  s += '每次调用：① 产物会内嵌展示给用户；② 返回值里带产物的【绝对文件路径】，你可以用 Read 查看它、或用 Bash 把它复制进你正在做的项目当素材（例如嵌进 HTML 引用）。';
  if (vid) s += '视频又慢又贵，仅在用户明确需要时才用。';
  const off = KINDS.filter((k) => !on.includes(k));
  if (off.length) s += '管理员没开放给你的种类（' + off.map((k) => ({ image: '图像', video: '视频', speech: '语音', music: '音乐' })[k]).join('、') + '）没有对应工具，用户要时告诉他去 设置 › Agent › Gemini 打开。';
  const tips = [];
  if (img) tips.push('做网页等多图任务别一律默认顶配：显眼大图（hero/整屏背景）用默认模型 + imageSize:"4K"（页面轻量用 2K）；正文插图 2K；图标/小装饰用 imageSize:"1K" 或换 model:"gemini-3.1-flash-lite-image"（最省、只出 1K）省成本。');
  if (vid) {
    tips.push(videoCap === '4k'
      ? '视频默认 720p，hero 传 resolution:"1080p"、确需超清才 "4k"；要带声音/对白的片段或省钱预览（360p）可换 model:"gemini-omni-1.1-flash"。'
      : `视频默认 720p，最高只到 ${videoCap}（管理员的上限，要更高会自动降档）；要带声音/对白的片段或省钱预览（360p）可换 model:"gemini-omni-1.1-flash"。`);
  }
  if (img) tips.push('同一页面多图复用同一组风格词保持一致。');
  if (tips.length) s += '\n\n【按需选模型与质量】' + tips.join('');
  if (img) s += '\n\n【质量门】正式图像素材生成后，务必用 Read 回看自检：① 主体/内容对不对 ② 构图能否用（hero 要留出放标题的负空间、关键物别被裁）③ 比例对不对 ④ 有无明显瑕疵（畸变 / 乱码文字 / 多余肢体 / 水印感）⑤ 风格是否跟页面其它素材一致。不过关且可修就调 prompt（加负面词，如 clean composition, no text, no watermark）或换模型/尺寸重生成，最多 2 次；仍不行就用最好一版并一句话说明短板。';
  return s;
}
