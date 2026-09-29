// 英文界面文案 · share-misc （键 = 中文原文，见 lib/i18n.js）
// 公开只读分享页（/w/、/s/）、新建项目选择器、vmx 浮层（模型/素材来源/工作空间素材选择器/播放器）、
// 以及共享 lib：文件业务规则、通知、手机本地文件、相对时间、壁纸、flux 参数、对话框、另存为。
export default {
  // —— 分享页（SharePage.svelte）：文件类型 ——
  '文件夹': 'Folder',
  '图片': 'Image',
  '视频': 'Video',
  '音频': 'Audio',
  '文档': 'Document',
  'files::表格': 'Spreadsheet',
  '演示文稿': 'Presentation',
  '网页': 'Web page',
  '压缩包': 'ZIP archive',
  'files::压缩包': 'Archive',            // 分享页类型标签：zip/rar/7z/tar 同归此类，不能只说 ZIP
  '代码': 'Code',
  '文本': 'Text',
  '文件': 'File',

  // —— 分享页：时间与有效期 ——
  '今天 {time}': 'Today {time}',
  '昨天 {time}': 'Yesterday {time}',
  '已过期': 'Expired',
  '1 小时内失效': 'Expires in under an hour',
  '{n} 小时后失效': { one: 'Expires in {n} hr', other: 'Expires in {n} hr' },
  '{n} 天后失效': { one: 'Expires in {n} day', other: 'Expires in {n} days' },
  '有效期至 {time}': 'Expires {time}',
  '链接有效期至 {time}，到期后内容自动删除': 'This link expires {time}. Its contents are deleted automatically after that.',
  '只读分享，到期后内容自动删除': 'Read-only share. Contents are deleted automatically when it expires.',

  // —— 分享页：头部 / 路径条 / 列表 ——
  '{name} 等 {n} 项': { one: '{name} ({n} item)', other: '{name} and others ({n} items)' },
  '分享': 'Share',
  '{title} · 分享': '{title} · Shared',
  '{n} 个文件夹': { one: '{n} folder', other: '{n} folders' },
  '{n} 个文件': { one: '{n} file', other: '{n} files' },
  '{folders}、{files}': '{folders}, {files}',
  '共 {size}': '{size} total',
  '只读分享': 'Read-only share',
  '位置': 'Location',
  '返回上一级': 'Up to parent folder',
  '全部文件': 'All files',
  '视图': 'View',
  '列表视图': 'List view',
  '网格视图': 'Grid view',
  '这个文件夹是空的': 'This folder is empty',
  '打开': 'Open',
  '预览': 'Preview',
  '下载': 'Download',
  '下载 {name}': 'Download {name}',

  // —— 分享页：失效 / 出错 / 下载条 ——
  '链接已失效': 'Link expired',
  '这个分享不存在或已经过期。': 'This shared link doesn’t exist or has expired.',
  '如需继续访问，请联系分享者重新分享。': 'To access it again, ask the person who shared it for a new link.',
  '加载失败': 'Couldn’t load',
  '网络好像不太顺畅，稍后再试一次。': 'Check your connection and try again in a moment.',
  '重新加载': 'Reload',
  '这个文件夹已不存在': 'This folder no longer exists',
  '加载失败，请重试': 'Couldn’t load. Try again.',
  '已交给浏览器下载': 'Downloading in your browser',
  '已下载': 'Downloaded',
  '已取消': 'Canceled',
  '取消下载': 'Cancel download',

  // —— 新建项目选择器（ProjectPicker.svelte）——
  '新建项目': 'New project',
  '把文件夹拖进底栏，它就是新项目的工作空间': 'Drag a folder to the bar below to make it the new project’s workspace.',
  '无法读取可选位置': 'Couldn’t load locations',
  '没有可用的位置': 'No locations available',
  '正在读取位置…': 'Loading locations…',
  '创建中…': 'Creating…',
  '创建失败': 'Couldn’t create',
  '关闭': 'Close',

  // —— vmx 浮层（neo/*.svelte）——
  '选择模型': 'Select model',
  '暂停': 'Pause',
  '播放': 'Play',
  '添加图片': 'Add image',
  '工作空间': 'Workspace',
  '从云端文件里选图片': 'Pick an image from your cloud files',
  '手机存储': 'Phone storage',
  '从手机相册 / 文件选': 'Pick from photos or files',
  '选择素材图片': 'Choose source image',
  '这个文件夹里没有图片': 'No images in this folder',

  // —— 模型说明（neoUi.js MODEL_DESC；Vertex 口吻）——
  '快速 · 支持尾帧与参考图': 'Fast · Last frame and reference images',
  '质量优先 · 支持尾帧与参考图': 'Best quality · Last frame and reference images',
  '轻量省额度': 'Lightweight · Lower usage',
  '新一代 · 原生音轨对白 · 360p-4K': 'Next-gen · Native audio and dialogue · 360p–4K',
  '旗舰 · 多轮续改 · 联网搜索': 'Flagship · Multi-turn editing · Google Search grounding',
  '快 · 思考档 · 图片搜索': 'Fast · Thinking level · Image search',
  '最省 · 仅 1K · 思考档': 'Lowest cost · 1K only · Thinking level',
  '轻量基础款': 'Basic and lightweight',
  '快速自然': 'Fast and natural',
  '新架构预览': 'New architecture · Preview',
  '表现力最佳': 'Most expressive',
  '约 30 秒配乐': 'About 30 sec per track',
  '新版预览': 'New version · Preview',
  '最长 3 分钟': 'Up to 3 min',

  // —— 音乐灵感 chips（点一下填进提示词栏）——
  '温柔钢琴独奏': 'Gentle solo piano',
  '史诗管弦配乐': 'Epic orchestral score',
  'Lo-fi 学习节拍': 'Lo-fi study beats',
  '赛博朋克合成波': 'Cyberpunk synthwave',
  '国风竹笛山水': 'Serene Chinese bamboo flute',
  '慵懒爵士三重奏': 'Laid-back jazz trio',

  // —— 分享链接 / 发送给 AI（files-business.js）——
  '1小时': '1 hour',
  '1天': '1 day',
  '7天': '7 days',
  '30天': '30 days',
  '请填写分享密码': 'Enter a password',
  '{url}\n分享密码：{pw}': '{url}\nPassword: {pw}',
  '正在准备…': 'Preparing…',
  '准备失败': 'Couldn’t prepare',
  '已加到对话输入，去问它吧': 'Added to the composer',
  '已挂为生成素材，可换模型/调参后点生成': 'Added as source media. Adjust settings, then generate.',
  '正在读取…': 'Loading…',
  '读取失败': 'Couldn’t load',
  '内容已填入提示词栏': 'Text added to the prompt',
  '该文件不支持发给这个目标': 'This file can’t be sent there',

  // —— 相对时间（format.js relTime：列表用紧凑式，GLOSSARY §1.9）——
  '刚刚': 'Just now',
  '{n} 分钟前': '{n}m ago',
  '{n} 小时前': '{n}h ago',
  '{n} 天前': '{n}d ago',
  '昨天': 'Yesterday',                  // 仅英文分支用（§1.9：1 天 = Yesterday）
  '已重置': 'Reset',

  // —— 手机本地文件（localfs.js）——
  '本地': 'Local',
  '此设备不支持写入手机本地（需在新版 app 内）': 'Saving to phone storage requires the latest mobile app',
  '尚未授权本地工作空间文件夹——请在工作空间「本地」tab 选一个手机文件夹': 'Access to a phone folder hasn’t been granted. Choose one in Workspace → Local.',
  '写入失败': 'Couldn’t write the file',
  '需更新 App 后使用': 'Update the app to use this',
  '操作失败': 'Something went wrong',

  // —— 系统通知（notify.js：安卓常驻/完成通知、浏览器通知）——
  '{label} · 处理中': '{label} · Working',
  '正在处理…': 'Working…',
  '{label} · 回复中': '{label} · Responding',
  '正在回复…': 'Responding…',
  '{label} · 出错': '{label} · Error',
  '{label} · 完成': '{label} · Done',
  '出错了': 'Something went wrong',
  '回复已生成': 'Response ready',

  // —— Vertex 语音默认说话人（state.svelte.js）——
  '主持人': 'Host',
  '嘉宾': 'Guest',

  // —— flux 流体壁纸参数（state.svelte.js；配色沿用 Wallpaper Engine 原名）——
  '池畔': 'Poolside',
  '原版': 'Original',
  '等离子': 'Plasma',
  '自由': 'Freedom',
  '演化速度': 'Simulation speed',
  '缩放': 'Zoom',
  '线段长度': 'Line length',
  '线段宽度': 'Line width',
  '线条间距': 'Line spacing',
  '粘度': 'Viscosity',
  '速度耗散': 'Velocity dissipation',
  '扩散迭代': 'Diffusion iterations',
  '压力迭代': 'Pressure iterations',
  '流体尺寸': 'Fluid size',

  // —— 壁纸库（wallpaper.svelte.js）——
  '多洛米蒂': 'Dolomites',
  '流光': 'Flux',
  '我的壁纸': 'My wallpaper',

  // —— 对话框 / 另存为（dialogs.js、save.js）——
  '确定': 'OK',
  '取消': 'Cancel',
  '另存为…': 'Save as…',
};
