// 英文界面文案 · model-hub（模型中心首页 HubHome、浮层外框 HubOverlays、Vertex 上游 HubVertex、状态层 modelHub.svelte.js）（键 = 中文原文，见 lib/i18n.js）
// 已在别的分区字典里有英文的通用词（保存、取消、添加服务、已共享给成员、有改动没保存，确定放弃？等）不在这里重复；
// 同一句中文在别的文件里的英文必须与这里一致（i18n-check 查冲突）
export default {
  // —— 设置入口的一句状态（modelHub.svelte.js）——
  '接 DeepSeek、Kimi、OpenRouter 等兼容 API': 'Connect DeepSeek, Kimi, OpenRouter and other compatible APIs',
  '模型服务、API 池、号池与各家 Key': 'Model providers, API pools, account pool and vendor keys',
  '{n} 个模型服务': { one: '{n} model provider', other: '{n} model providers' },
  '服务器没有正常响应（HTTP {s}）': 'The server didn’t respond properly (HTTP {s})',

  // —— 线路状态（modelHub.svelte.js 的 lineNote；冷却原因是服务端 runtime/model-hub/pool.mjs 写的短语，经 tr() 翻）——
  '{why}，约 {m} 分钟后再试': '{why}, retry in about {m} min',
  '冷却中': 'Cooling down',
  'Key 无效': 'Invalid key',
  '被拒绝': 'Rejected',
  '余额不足': 'Out of credit',
  '限额': 'Rate limited',

  // —— 首页：服务列表（HubHome）——
  '未命名服务': 'Untitled provider',
  '线路已全部停用': 'All routes disabled',
  '{n} 条线路冷却中': { one: '{n} route cooling down', other: '{n} routes cooling down' },
  '未添加模型': 'No models added',
  '没给任何 agent': 'Not given to any agent',
  '启用 Vertex': 'Enable Vertex',
  '在 dimensio 里编辑 {name}': 'Edit {name} in dimensio',
  '把 {name} 交给模型中心': 'Move {name} into Model Hub',
  'dimensio 对这家厂商有专门适配：添加给它的模型直连官方接口，用第一条可用的 Key': 'dimensio has a dedicated adapter for this vendor: models added to it call the official endpoint directly, using the first available key',
  // 服务端 routes/model-hub.mjs 收编时给的提醒（经 tr() 翻）
  '这个服务有 {n} 个模型，先添加了前 {m} 个；其余的在模型列表里，勾上就能加': 'This provider has {n} models. The first {m} were added; the rest are in the model list, ready to tick.',
  '没有这一类的服务': 'No providers of this type',
  '读不到模型服务': 'Couldn’t load model providers',
  '没改成': 'Couldn’t change it',

  // —— 首页：连着老服务端（新前端 + v1 服务端）、Studio 列表读不出 ——
  '服务器版本较旧，添加服务与改模型要先更新服务器': 'This server is on an older version. Update it to add providers or change models.',
  // 服务端 runtime/model-hub/overview.mjs 给的 studioErr（经 tr() 翻）
  '读不出 Media Studio 的服务': 'Couldn’t load Media Studio providers',
  '读不出 Media Studio 的服务列表，详情见服务器日志': 'Couldn’t load Media Studio providers. See the server log for details.',

  // —— 首页：改为共用（确认框：问句 + 后果两级；措辞按 modelHub.svelte.js 的 adoptReach() 分三种）——
  '改为共用': 'Make shared',
  '交给模型中心': 'Hand over to Model Hub',
  '把「{name}」改为两边共用？': 'Share “{name}” between Claude and dimensio?',
  '把「{name}」交给模型中心管理？': 'Let Model Hub manage “{name}”?',
  '地址、型号和 Key 会照抄成一个共用服务，dimensio 里也能选；原来那份从 Claude 的模型菜单里隐藏（用着它的老会话照常能跑）。':
    'Its address, models and key are copied into one shared provider that dimensio can use too. The original is hidden from Claude’s model menu (older sessions using it keep working).',
  '地址、型号和 Key 会照抄成一个模型中心服务；原来那份从 Claude 的模型菜单里隐藏（用着它的老会话照常能跑）。':
    'Its address, models and key are copied into a Model Hub provider. The original is hidden from Claude’s model menu (older sessions using it keep working).',
  '地址、型号和 Key 会照抄成一个共用服务，Claude 里也能选；原来那份会从 dimensio 里删掉，正用着它的对话要重新选一次模型。':
    'Its address, models and key are copied into one shared provider that Claude can use too. The original is removed from dimensio, so chats using it need to pick a model again.',
  '地址、型号和 Key 会照抄成一个模型中心服务，模型照旧只给 dimensio（Gemini 接口给不了 Claude）；原来那份会从 dimensio 里删掉，正用着它的对话要重新选一次模型。':
    'Its address, models and key are copied into a Model Hub provider, and its models stay dimensio-only (Claude can’t use the Gemini API). The original is removed from dimensio, so chats using it need to pick a model again.',
  '地址、Key 和现有的媒体模型不变，之后还能把它的文本模型加到 Claude 和 dimensio。':
    'Its address, key and existing media models stay the same, and you can later add its text models to Claude and dimensio.',
  '模型中心服务已经建好，但 dimensio 里原来那份没删掉': 'The Model Hub provider is ready, but the original in dimensio wasn’t removed',
  '请到 dimensio 的「模型服务」里手动删一下，免得出现两张一样的卡。':
    'Delete it by hand in dimensio’s “Model providers” so you don’t end up with two identical cards.',

  // —— 首页：订阅账号与内置厂商 ——
  '用本机登录态': 'Uses this machine’s login',
  '读不到用量': 'Couldn’t read usage',
  '管理 {name}': 'Manage {name}',
  'dimensio 内置厂商': 'dimensio built-in vendors',
  '未填 Key': 'Key not set',

  // —— 首页：成员 ——
  '我的服务': 'My providers',
  '最多 {n} 个服务': { one: 'Up to {n} provider', other: 'Up to {n} providers' },
  'dimensio 的模型服务': 'dimensio model providers',
  '打开 dimensio 的模型服务': 'Open dimensio model providers',

  // —— 浮层（HubOverlays）——
  '读不到 Vertex 的设置': 'Couldn’t load Vertex settings',
  '这台服务器没装 Media Studio': 'Media Studio isn’t installed on this server',

  // —— Vertex 上游（HubVertex）——
  '填好项目 ID 并保存凭据后，这里的型号才会出现在 Claude 和 dimensio 里': 'Fill in the project ID and save the credentials — the models below then show up in Claude and dimensio',
  '提供给': 'Available to',
  '别的 Vertex 型号 ID，回车添加': 'Another Vertex model ID, press Enter to add',
  '型号 ID': 'Model ID',
  '没保存上': 'Couldn’t save',

  // —— 老配置统一并进模型中心（2026-11-13）：首页待交接的行、Vertex 的媒体模型、本机图像模型卡（HubBuiltin / BuiltinModels）——
  '待交给模型中心': 'Not in Model Hub yet',
  '这个媒体服务已经不在了': 'This media service no longer exists',
  '这个服务里没有模型': 'This service has no models',
  '在这台服务器上本地生成图像，不用地址和 Key。打开的模型会出现在 Media Studio 里。': 'Generates images locally on this server, no address or key needed. Models you turn on show up in Media Studio.',
  '媒体模型': 'Media models',
  '打开的模型会出现在 Media Studio 里': 'Models you turn on show up in Media Studio',
  '图像、视频、配音、音乐模型给 Media Studio 用': 'Image, video, voice and music models for Media Studio',
  '加上 Vertex 的媒体模型': 'Add Vertex media models',
  '正在加…': 'Adding…',
  '已加上': 'Added',
  '没加上': 'Couldn’t add',
};
