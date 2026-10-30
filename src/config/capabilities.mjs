// Single source of truth for all model enums, defaults, per-model capability maps,
// and display labels. Both the backend (server.mjs, mcp-media.mjs) and the frontend
// (public/index.html) consume from this one module. The frontend gets the data via
// server-rendered injection into the HTML (window.__CAPS__) so there's no boot-time
// race. The /api/capabilities endpoint exposes the same JSON for debugging or other
// consumers.
//
// When you add a new model / change a default / discover a per-model quirk, edit
// HERE — everything else just imports.

export const CAPABILITIES = {
  claude: {
    models: [
      // Fable 5.1 (2026-09-01，SDK 0.3.257 / 内核 2.1.257 首次收录，官方 /model 默认
      // Fable 档)。同价位接棒 Fable 5（$10/$50，cache read 降到 $0.25/M），长程 agent
      // 编码/文档表格/多步检索/视觉更强；思考恒开、effort 五档（probe 实测 max 通过）。
      // 发布当天 probe（modelUsage.contextWindow）：**裸 id 直接 1M**（不像 Fable 5/
      // Opus 5 要 [1m] 后缀才 1M），[1m] 兄弟档也接受同样 1M；maxOutputTokens 64k。
      // fast mode 不支持（注 settings.fastMode 后 fast_mode_state 仍 off，对照 Opus 5
      // 同时刻 on），故不进 fast 表。三条 API 级差异（forced tool_choice 400、思考块
      // 绑定产出模型、编辑历史使思考块失效）全在 SDK 内核里处理，bridge 不感知。
      { id: 'claude-fable-5-1', name: 'Fable 5.1' },
      // Opus 5.5（2026-09-22，SDK 0.3.280 / 内核 2.1.280 首次收录，官方 /model 的 Opus 档默认）。
      // 比 Opus 5 更便宜（$4/$20，cache read $0.20/M），知识截止 2026-06，maxOutputTokens 128k。
      // 发布当天 probe（bridge 激活账号真打，modelUsage.contextWindow）：**裸 id 直接 1M**（同
      // Fable 5.1，不进 oneM 表），[1m] 兄弟档也是 1M；effort 五档（max 实测通过）；**不传 effort 时
      // API 默认 medium**（Opus 5 是 high）——见下 effortDefaults；fast mode 支持（fast_mode_state=on）。
      // 安全栅门回退：bio/frontier_llm → Opus 5、cyber → Opus 4.8（CLI 内置表），走现有 onModelNotice。
      { id: 'claude-opus-5-5', name: 'Opus 5.5' },
      // Fable 5 (Mythos-class, 2026-06-09). Probe-verified on SDK 0.3.150 (bundled
      // CLI 2.1.150): runs fine despite docs saying "picker needs CLI 2.1.170+" —
      // that gate is interactive-only. Like Opus 4.8, the bare id gets a 200k
      // window at the SDK layer; 1M requires the explicit [1m] suffix (verified
      // via modelUsage.contextWindow). All five effort levels accepted.
      // Note: Fable 5 系有安全分类器（cyber/bio）。SDK 宿主【默认自动切换】（switchModelsOnFlag
      // 默认 true，CLI 2.1.257 实读 + 09-02 探针）：被标记的请求会切到回退模型重试（cyber→Opus 4.8、
      // bio→Opus 5），并下发 system/model_refusal_fallback 帧——bridge 渲染成提示卡、撤回半截正文、
      // 把会话模型切过去（claude.mjs onModelNotice）；表外类别才以 model_refusal_no_fallback + 拒答
      // 结束本轮。旧注释「headless 路径无自动回退」是 SDK 0.3.150 时代的 probe 结论，已过时。
      // 2026-07-12 起 1M 上下文默认开启：picker 只列裸 id，凡在 oneM 表里的模型，
      // 后端跑 query 时一律静默换成 [1m] 兄弟档（见 claude.mjs to1M）。选项里不再
      // 出现 “xx 1M”；旧客户端发来的 [1m] id 仍被白名单接受（见下 CLAUDE_MODELS）。
      { id: 'claude-fable-5', name: 'Fable 5' },
      // Opus 5 (2026-07-24). Claude 5 家族第四员——定位「日常主力」：接近 Fable 5
      // 智力、半价（$5/$25），复杂 agent 编码与企业工作首选，知识截止 2026-05。
      // adaptive thinking（无 extended），effort 五档，API 默认 high。发布当天
      // probe 验证（SDK 0.3.150，modelUsage.contextWindow）：裸 id 200k，[1m]
      // 兄弟档 1M——与 Fable 5 / Opus 4.8 同款行为。
      { id: 'claude-opus-5', name: 'Opus 5' },
      { id: 'claude-opus-4-8', name: 'Opus 4.8' },
      { id: 'claude-opus-4-7', name: 'Opus 4.7' },
      // Sonnet 5.5（2026-09-28，SDK 0.3.280 / 内核 2.1.280 已认，无需升 SDK）。发布当天 probe（bridge
      // 激活账号真打）：**裸 id 200k、[1m] 兄弟档 1M**（同 Sonnet 5，进 oneM 表）；effort 五档，max 实测通过；
      // **不传 effort 时默认 high**（Stop hook 实测，不进 effortDefaults）；fast 注 settings 后仍 off → 不进 fast 表。
      { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
      // Sonnet 5 (2026-06-30). Anthropic's new flagship Sonnet — most agentic
      // Sonnet yet, and the new default for Claude Free/Pro. 128k out, adaptive
      // thinking (no extended), all five efforts; effort defaults high on the
      // API/CLI. Intro pricing $2/$10 per MTok through 2026-08-31, then $3/$15.
      // Dateless pinned snapshot id (alias == id). Probe-verified on this SDK
      // (0.3.150) via modelUsage.contextWindow: bare id gets a 200k window, the
      // [1m] suffix gets the full 1M — same as Fable 5 / Opus 4.8.
      { id: 'claude-sonnet-5', name: 'Sonnet 5' },
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
      // Haiku 5.5（2026-10-07，SDK 0.3.293 / 内核 2.1.293 首次收录，CLI haiku 别名同日切到它）。官方目录：$0.10/$0.50
      //（prompt 超 10 万 token 起 $0.50/$2.50）、知识截止 2026-06、adaptive thinking 不可关。发布当天 probe（admin 本机登录真打）：
      // **裸 id 直接 1M**、maxOutputTokens 128k（不进 oneM）；effort 五档（max/xhigh 实测通过）；**不传 effort 默认 medium**
      //（Stop hook 实测，进 effortDefaults）；fast 注 settings 后仍 off（同刻 Opus 5.5 为 on）→ 不进 fast 表。
      // 新 CLI 的后台小模型（标题/摘要等）也换成了它，modelUsage 里会多出这一行。
      { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
      { id: 'claude-opus-4-6', name: 'Opus 4.6 Legacy' },
    ],
    // 支持 [1m] 兄弟档的裸 id（probe 验证过 contextWindow=1M 的那几个）。Sonnet 4.6 /
    // Haiku 4.5 / Opus 4.6 没有 [1m] 档，保持 200k。Fable 5.1 / Opus 5.5 / Haiku 5.5 裸 id 本身就是 1M（见上），
    // 不必进这张表——to1M 原样放行即可。
    oneM: ['claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5-5', 'claude-sonnet-5'],
    // fast mode 支持的模型（官方口径 Opus 5.5/5/4.8/4.7；SDK 0.3.220 起 settings.fastMode
    // 可点亮，2026-07-30 probe 实测 fast_mode_state=on，Opus 5.5 于 09-22 实测 on）。前端模型菜单
    // 据此显隐 ⚡ 开关，后端 runClaudeChat 据此决定是否注入 settings。
    fast: ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7'],
    // 「没选 effort」时实际跑的档位（bridge 不传 effort，由 CLI 按内置模型目录 default_effort 取；
    // 09-22 探针 Stop hook 实测 Opus 5.5=medium、Opus 4.7=xhigh；10-07 Haiku 5.5=medium）。表外一律 high。前端芯片/拉条的
    // 默认高亮读它，否则选 Opus 5.5 不动 effort 会恒显「已选 High，实际 Medium」。注意 admin 会话
    // 读 ~/.claude/settings.json，其 modelSettings.<id>.effortLevel（桌面端 /effort 按模型存）会盖过它。
    effortDefaults: { 'claude-opus-5-5': 'medium', 'claude-haiku-5-5': 'medium', 'claude-opus-4-7': 'xhigh' },
    efforts: [
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
      // 显示名叫「Extra」而不是官方的「Extra high」：档名要直接印在输入栏芯片上，
      // 窄屏（折叠屏分屏、桌面小窗）最长的这一档是把整行挤爆的元凶。id 不动。
      { id: 'xhigh', name: 'Extra' },
      { id: 'max', name: 'Max' },
    ],
    // Ultracode = 常驻动态工作流编排（Workflow 工具），与 effort 档位【独立】（2026-10-30，对齐桌面端 4.29 的
    // ultracodeSeparate：apply_flag_settings 分别收 effortLevel 与 ultracode）。SDK 0.3.311 探针实测
    // effort:low/high/max + settings{ultracode:true} 都同时生效（getSettings().applied 两项各自回报）。
    // 请求体带 ultracode:true，后端经 claudeEffortOptions 合进 settings {ultracode, enableWorkflows}。
    // 旧客户端 / 旧偏好里的 effort:'ultracode'（09-02 起它曾是拉条末档）仍收，按 xhigh + ultracode 解释。
    ultracode: { name: 'Ultracode' },
    // 「没主动选模型」这一档的唯一真相。前端芯片/picker 高亮读它，后端 MODEL 也回落到它
    // （config.json 的 model 若留空就走这里）。2026-07-25 前这两边各写各的字面量，导致
    // 芯片显示 Opus 5、实际却按 config.json 跑 Opus 4.8——加新模型时只改这一行。
    // 2026-09-22 起 Opus 5.5（CLI 2.1.280 的 opus 别名同日切到它）。
    defaults: { model: 'claude-opus-5-5' },
  },
  vertex: {
    // Gemini-via-Vertex. Ids probe-verified on the project (225322445252), last
    // full sweep 2026-09-02. Catalog listing ≠ callable (preview 转正后旧 -preview
    // id 会 404，如 3.1-flash-lite-preview)——加模型前先真打一次 generateContent。
    models: [
      // Gemini 4 Argon（09-30 发布，首发只给 Fairwind；2026-10-13 目录里出现、global 真打 200，id 就叫
      // gemini-4-argon，无 -preview）。thinkingLevel 家族：minimal 400、low/medium/high 收，thinkingBudget 400；
      // 搜索/读网址/代码执行任意组合都收，识图低/中/高都生效；输出上限 32,768（3.x 的一半）。
      // 名称不带「Gemini」：顶栏是「Gemini」+ 型号名两段拼的（v6.10 前写全名，顶栏成了「Gemini Gemini 4 Argon」）。
      { id: 'gemini-4-argon', name: '4 Argon' },
      // 3.8 Flash (2026-09-02)：发布当天 Vertex global 直接可用（GA，无 -preview
      // 后缀）。距 3.7 Flash 仅三周，同价同速档（$0.75/$3.75 introductory 到 12-31，
      // 之后 $1.50/$7.50），长在长程软工/agentic/多步推理。同批发布的
      // gemini-3.8-flash-cyber 未上架：安全专用变体，只发给 Fairwind Program 的
      // 可信防守方——本项目 probe 404，目录里也没有。
      { id: 'gemini-3.8-flash', name: '3.8 Flash' },
      // 3.7 Flash (2026-08-13)：编码/agent 大版本（DeepSWE 49→65.3），1M 上下文。
      { id: 'gemini-3.7-flash', name: '3.7 Flash' },
      { id: 'gemini-3.6-flash', name: '3.6 Flash' },
      { id: 'gemini-3.5-flash', name: '3.5 Flash' },
      { id: 'gemini-3.1-pro-preview', name: '3.1 Pro' },
      { id: 'gemini-3-flash-preview', name: '3 Flash' },
      // Lite 档取最新一代（3.5）；旧 3.1-flash-lite-preview 已 404（GA 改名回收）。
      { id: 'gemini-3.5-flash-lite', name: '3.5 Flash Lite' },
      { id: 'gemini-2.5-flash', name: '2.5 Flash' },
      { id: 'gemini-2.5-pro', name: '2.5 Pro' },
    ],
    // Unified thinking level; vertex.mjs maps it per model family (Gemini 3 ->
    // thinkingLevel, Gemini 2.5 -> thinkingBudget). 部分模型拒 'minimal'
    // （见 noMinimal），后端 thinkingFor() 按同一张表静默夹到 low。
    thinkLevels: [
      { id: 'minimal', name: 'Minimal' },
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
    ],
    // 不支持 minimal 的模型。前端按这张表把该档从菜单摘掉，后端 thinkingFor() 读同一张
    // 表夹到 low（旧实现是 /pro/ 正则——**只按名字猜是错的**：2026-09-02 逐档真打
    // 实测 3.8/3.7 Flash 同样报 400 `Thinking level is unsupported:
    // THINKING_LEVEL_MINIMAL`，而 3.6 及更早的 Flash、3.5 Lite 都收 200。也就是说
    // 3.7 上架以来「默认模型 + Minimal」一直是必 400 的组合，正则兜不住）。
    // 加模型时这一档必须逐个真打，别按家族名推断。
    noMinimal: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro'],
    // 对话工具与识图清晰度（2026-10-06 九款逐个真打）：systemInstruction / urlContext / codeExecution 全部 200；
    // 3.x 三个工具与 googleSearch 任意组合都收。2.5 Flash / Pro 的 codeExecution 不能和 googleSearch / urlContext 同开
    // （400「Multiple tools are supported only when they are all search tools」），urlContext + googleSearch 可以——
    // 前端开代码执行时关掉另两个，后端再兜底（保留搜索类、丢代码执行）。代码执行会把 matplotlib 图表以 inlineData PNG 回传。
    codeSolo: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    // mediaResolution：低 / 中 / 高都生效（一张 1024² 图 3.x = 262 / 535 / 1095 token，2.5 = 72 / 264 / 1296），
    // 不传 ≈ 高；ULTRA_HIGH 在 generationConfig 层 400，不收。「自动」= 沿用快速识图（3.x 有图时用中档）。
    mediaRes: [
      { id: 'auto', name: '自动' }, { id: 'low', name: '低 · 最省' },
      { id: 'medium', name: '中' }, { id: 'high', name: '高 · 看清小字' },
    ],
    systemMax: 8000,   // 系统提示词上限（字符）
    defaults: { model: 'gemini-3.8-flash', think: 'medium' },
    // The "功能" (modality) picker for the Vertex agent. Extensible.
    funcs: [
      { id: 'chat', name: '对话' },
      { id: 'image', name: '图像' },
      { id: 'video', name: '视频' },
      { id: 'voice', name: '语音' },
      { id: 'music', name: '音乐' },
    ],
  },
  veo: {
    // 视频生成（Veo + Gemini Omni 两家族，按 id 路由）。
    // - veo-3.1-*：Vertex us-central1 predictLongRunning（veo-3.0/2.0 已 404 下架，2026-08-27 探针）。
    // - gemini-omni-1.1-flash：Google 新一代对话式视频模型（2026-08 发布，原生带音轨、
    //   最短 3s、360p-4k），走 Gemini Developer API Interactions 端点（config.geminiApiKey，
    //   modules/vertex/server/omni.mjs）——Vertex 侧 preview id 配额为 0 必 429，dev API 是实测可用通道。
    //   旧款 gemini-omni-flash-preview 未上架：被 1.1 完全覆盖且不认分辨率参数（探针实测
    //   360p 请求照样出 720p），没有独立价值。
    models: [
      { id: 'veo-3.1-fast-generate-001', name: '3.1 Fast' },
      { id: 'veo-3.1-generate-001', name: '3.1' },
      { id: 'veo-3.1-lite-generate-001', name: '3.1 Lite' },
      { id: 'gemini-omni-1.1-flash', name: 'Omni 1.1' },
    ],
    // 「自动」= 不传比例参数（2026-08-28 探针）：Omni 文生视频按 prompt 语义自选比例、
    // 有首帧图跟源图；Veo 3.1 有首帧图也跟源图（720×1280 竖图实测出竖片），纯文字回落 16:9。
    // 现有四个模型全支持省略，故不做 per-model 门控；将来上不支持省略的模型再加。
    // 比例枚举两家一致：Omni 400 直接报「Supported values: '16:9', '9:16'」，Veo 对
    // 1:1/4:3/21:9 一律「Invalid aspect ratio」（2026-08-29 探针）。
    aspects: [{ id: 'auto', name: '自动' }, { id: '16:9', name: '16:9 横' }, { id: '9:16', name: '9:16 竖' }],
    // 时长档位是两家的并集，真正能选哪几档看 durSupport。
    durations: [
      { id: 3, name: '3 秒' }, { id: 4, name: '4 秒' }, { id: 5, name: '5 秒' }, { id: 6, name: '6 秒' },
      { id: 7, name: '7 秒' }, { id: 8, name: '8 秒' }, { id: 9, name: '9 秒' }, { id: 10, name: '10 秒' },
    ],
    // Per-model 时长（2026-08-29 探针）：Omni 的 400 原文给出闭区间——1s「less than the
    // minimum allowed 3s」、11s「exceeds the maximum allowed 10s」，故 3–10 秒逐秒可选；
    // Veo 3.1 全系仍是官方三档 4/6/8。此前全家共用 4/6/8，Omni 的 3/5/7/9/10 选不到，
    // 且旧客户端传 3 会被白名单打回默认 8——这就是「设置不对」的那一条。
    durSupport: {
      'veo-3.1-generate-001': [4, 6, 8],
      'veo-3.1-fast-generate-001': [4, 6, 8],
      'veo-3.1-lite-generate-001': [4, 6, 8],
      'gemini-omni-1.1-flash': [3, 4, 5, 6, 7, 8, 9, 10],
    },
    // SDK docs say 720p/1080p only, but 4k is accepted on this project (verified).
    // 360p 仅 Omni（低价预览档）。
    resolutions: [{ id: '360p', name: '360p' }, { id: '720p', name: '720p' }, { id: '1080p', name: '1080p' }, { id: '4k', name: '4K' }],
    audio: [{ id: true, name: '带音频' }, { id: false, name: '无音频' }],
    // 任务类型：**不是 API 字段**——两家都靠"喂进去什么素材"分流（Omni 的 response_format
    // 只认 type/resolution/aspect_ratio/duration/delivery，探针逐个试过没有 task 键）。
    // 摆出来是因为素材槽的含义随任务变，选错了要么白给钱要么报错：前端据此决定露哪几个槽、
    // 生成前校验必需素材，后端据此丢弃与任务无关的图（免得 Veo 收到尾帧却按 t2v 跑）。
    tasks: [
      { id: 't2v', name: '文生视频', hint: '只给文字描述' },
      { id: 'i2v', name: '图生视频', hint: '从一张首帧图动起来' },
      { id: 'interp', name: '首尾插值', hint: '给定首帧与尾帧，中间自动补' },
      { id: 'ref', name: '参考图生成', hint: '带入主体/风格，最多 3 张' },
    ],
    taskSupport: {
      'veo-3.1-generate-001': ['t2v', 'i2v', 'interp', 'ref'],
      'veo-3.1-fast-generate-001': ['t2v', 'i2v', 'interp', 'ref'],
      'veo-3.1-lite-generate-001': ['t2v', 'i2v', 'interp', 'ref'],
      'gemini-omni-1.1-flash': ['t2v', 'i2v'],
    },
    // 画质（Veo 专属，2026-08-29 探针实证：传 zzz 回「Invalid compression quality type」
    // ⇒ 该参数被真校验；枚举取 SDK VideoCompressionQuality）。Omni 无此旋钮。
    qualities: [{ id: '', name: '默认' }, { id: 'OPTIMIZED', name: '标准 · 体积小' }, { id: 'LOSSLESS', name: '无损 · 体积大' }],
    // Veo 专属三件（Omni 的 response_format 里都不存在，探针逐个 400「Unknown parameter」）：
    // 负面提示词 / 提示词增强 / 画质。前端按这张表显隐，后端按同一张表丢弃。
    veoOnly: ['veo-3.1-generate-001', 'veo-3.1-fast-generate-001', 'veo-3.1-lite-generate-001'],
    defaults: { model: 'veo-3.1-fast-generate-001', duration: 8, resolution: '720p', aspect: 'auto', task: 't2v' },
    // Per-model resolution support（veo-3.1 全系 720p-4k；Omni 全档 2026-08-28 逐档实测）。
    resSupport: {
      'veo-3.1-generate-001': ['720p', '1080p', '4k'],
      'veo-3.1-fast-generate-001': ['720p', '1080p', '4k'],
      'veo-3.1-lite-generate-001': ['720p', '1080p', '4k'],
      'gemini-omni-1.1-flash': ['360p', '720p', '1080p', '4k'],
    },
    // 图像输入能力（按模型）：首帧所有模型都支持(image-to-video)；veo-3.1 还支持
    // 尾帧(首尾插值)+最多 3 张参考图(asset)；Omni 目前只接首帧（尾帧/参考图待其 API 开放）。
    imgCaps: {
      'veo-3.1-generate-001': { last: true, ref: 3 },
      'veo-3.1-fast-generate-001': { last: true, ref: 3 },
      'veo-3.1-lite-generate-001': { last: true, ref: 3 },
      'gemini-omni-1.1-flash': { last: false, ref: 0 },
    },
    // 音频恒开的模型（Omni 原生带音轨，没有开关）——前端据此隐藏「生成音频」toggle。
    audioFixed: ['gemini-omni-1.1-flash'],
  },
  image: {
    // 全 Nano Banana（Gemini 原生图像，多轮续改、最高 4K），走 generateContent on 'global'。
    // 2026-08-27 重对齐：① Gemini 3 系 preview 转正，-preview 旧 id 已 404 回收；
    // ② Imagen 全家从清单删除——本项目（组织 230925370064）拿不到 Imagen 准入，四区
    //    probe 全 404、Model Garden 目录 imagen 命中 0，不是 id 写错，改名救不了。
    //    驱动层 imagen-* 路由代码保留（generateImages on us-central1），以后拿到准入加回即可。
    models: [
      { id: 'gemini-3-pro-image', name: 'Nano Banana Pro' },
      // 2026-10-06 当天 GA（Nano Banana 2 = 3.1 Flash Image 的升级版），Vertex global 真打 200。
      // 坑：Vertex 上 imageSize 会校验（乱填 400），但 2K / 4K 实际都只出 1K（同请求 3.1 Flash 出 2048×2048）；
      // Gemini Developer API 同模型真出大图 → 2K / 4K 改走 dev API（见下方 devBig 与 imagen.mjs viaDevApi）。
      { id: 'gemini-nano-banana-2.1', name: 'Nano Banana 2.1' },
      { id: 'gemini-3.1-flash-image', name: 'Nano Banana Flash' },
      { id: 'gemini-3.1-flash-lite-image', name: 'Nano Banana Lite' },
      { id: 'gemini-2.5-flash-image', name: 'Nano Banana 2.5' },
      { id: 'qwen-image-2.1-local', name: 'Qwen Image 2.1 · 本机' },
    ],
    // 「自动」= 不传 aspectRatio，让模型按内容自定比例（Nano Banana 文生图自选、改图贴合原图）；
    // media.mjs 见 'auto' 即省略该参数。Imagen 无自由比例，自动≈默认方图。
    // 2026-08-29 逐档真打（Vertex generateContent，lite@1K + pro 抽验）：除原有五档外
    // 2:3 / 3:2 / 4:5 / 5:4 / 21:9 全部 200 出图（21:9 在 pro 上实测 1584×672）。
    // 注意 SDK 的 ImageConfig 注释漏了 4:5 / 5:4——以真打为准，别照抄注释。
    aspects: [
      { id: 'auto', name: '自动' }, { id: '1:1', name: '1:1' }, { id: '16:9', name: '16:9' }, { id: '9:16', name: '9:16' },
      { id: '4:3', name: '4:3' }, { id: '3:4', name: '3:4' }, { id: '3:2', name: '3:2' }, { id: '2:3', name: '2:3' },
      { id: '5:4', name: '5:4' }, { id: '4:5', name: '4:5' }, { id: '21:9', name: '21:9' },
      // 超宽 / 超长只有 Nano Banana 2.1 认（2026-10-06 真打：4:1 → 2064×512、1:8 → 352×2928，1K 档也收）；
      // `only` = 只对这些模型显示 / 放行，别的模型收到按「自动」处理（imgAspectFor）。文档列的 9:21 Vertex 实测 400，没收。
      { id: '4:1', name: '4:1', only: ['gemini-nano-banana-2.1'] }, { id: '1:4', name: '1:4', only: ['gemini-nano-banana-2.1'] },
      { id: '8:1', name: '8:1', only: ['gemini-nano-banana-2.1'] }, { id: '1:8', name: '1:8', only: ['gemini-nano-banana-2.1'] },
    ],
    sizes: [{ id: '1K', name: '1K' }, { id: '2K', name: '2K' }, { id: '4K', name: '4K' }],
    // 人物生成（Vertex ImageConfig.person_generation，2026-08-29 探针）：ALLOW_ADULT /
    // ALLOW_ALL 实测 200；ALLOW_NONE 只吃到配额 429（枚举解析在配额检查之前，能过解析
    // 就是合法值）；而 Imagen 那套的 DONT_ALLOW 直接 400「Invalid value ... PersonGeneration」
    // ——两套枚举不通用，别混。空串 = 不传，走模型默认。
    personGen: [
      { id: '', name: '默认' }, { id: 'ALLOW_ALL', name: '允许（含儿童）' },
      { id: 'ALLOW_ADULT', name: '仅成人' }, { id: 'ALLOW_NONE', name: '不生成人物' },
    ],
    // Image-gen thinking: only minimal/high (NOT the full 4-level chat scale).
    thinkLevels: [{ id: 'minimal', name: 'Minimal' }, { id: 'high', name: 'High' }],
    defaults: { model: 'gemini-3-pro-image' },
    // Per-model advanced caps — VERIFIED ON VERTEX 2026-08-27 (Vertex ≠ AI Studio docs).
    //   3-pro-image:            thinking NO (400), web search YES, image search NO (400), 1K/2K/4K
    //   3.1-flash-image:        thinking YES (minimal/high), web search YES, image search YES, 1K/2K/4K
    //   3.1-flash-lite-image:   thinking YES, web search NO (400), image search NO (400), 仅 1K（2K/4K 皆 400）
    //   2.5-flash-image:        nothing advanced (conservative)；1K/2K/4K 实测都收
    //   nano-banana-2.1 (10-06): thinking YES（minimal/medium/high 都收，不传=模型默认 medium），web + image search YES，
    //                            personGeneration 仅 Vertex（1K）；2K/4K 走 dev API，超宽比例、思考、图搜在 dev API 上同样实测通过
    thinkSupport: ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-nano-banana-2.1'],
    searchSupport: ['gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-nano-banana-2.1'],
    imageSearchSupport: ['gemini-3.1-flash-image', 'gemini-nano-banana-2.1'],
    // 选 2K / 4K 时改走 Gemini Developer API（预付费 key、返回 JPEG、不认 personGeneration）的模型；1K 仍走 Vertex。
    // 没配 dev key 时 imagen.mjs 照走 Vertex（会出 1K）。前端据此在大尺寸下隐藏人物生成、标注扣费通道。
    devBig: ['gemini-nano-banana-2.1'],
    // Per-model imageSize support——lite 只吃 1K，传 2K/4K 直接 400，各调用方按此夹紧。
    sizeSupport: {
      'qwen-image-2.1-local': ['1K', '2K', '4K', 'custom'],
      'gemini-3-pro-image': ['1K', '2K', '4K'],
      'gemini-nano-banana-2.1': ['1K', '2K', '4K'],
      'gemini-3.1-flash-image': ['1K', '2K', '4K'],
      'gemini-3.1-flash-lite-image': ['1K'],
      'gemini-2.5-flash-image': ['1K', '2K', '4K'],
    },
  },
  tts: {
    models: [
      { id: 'gemini-2.5-flash-tts', name: 'Flash TTS' },
      { id: 'gemini-3.1-flash-tts-preview', name: '3.1 Flash TTS' },
      { id: 'gemini-2.5-pro-tts', name: 'Pro TTS' },
    ],
    // 全部 30 个官方预置音色——2026-08-29 在 gemini-3.1-flash-tts-preview 上逐个真打，
    // 30/30 返回 200（2.5 两款只是撞了每分钟配额 429，不是拒绝，故三款共用同一张表）。
    // 此前只列了 10 个，另外 20 个用户根本选不到。
    voices: [
      { id: 'Zephyr', name: 'Zephyr · 明亮' }, { id: 'Puck', name: 'Puck · 轻快' }, { id: 'Charon', name: 'Charon · 知性' },
      { id: 'Kore', name: 'Kore · 沉稳' }, { id: 'Fenrir', name: 'Fenrir · 激昂' }, { id: 'Leda', name: 'Leda · 年轻' },
      { id: 'Orus', name: 'Orus · 坚定' }, { id: 'Aoede', name: 'Aoede · 轻盈' }, { id: 'Callirrhoe', name: 'Callirrhoe · 随和' },
      { id: 'Autonoe', name: 'Autonoe · 明快' }, { id: 'Enceladus', name: 'Enceladus · 气声' }, { id: 'Iapetus', name: 'Iapetus · 清晰' },
      { id: 'Umbriel', name: 'Umbriel · 从容' }, { id: 'Algieba', name: 'Algieba · 顺滑' }, { id: 'Despina', name: 'Despina · 柔滑' },
      { id: 'Erinome', name: 'Erinome · 清亮' }, { id: 'Algenib', name: 'Algenib · 沙哑' }, { id: 'Rasalgethi', name: 'Rasalgethi · 讲解' },
      { id: 'Laomedeia', name: 'Laomedeia · 欢快' }, { id: 'Achernar', name: 'Achernar · 柔和' }, { id: 'Alnilam', name: 'Alnilam · 果断' },
      { id: 'Schedar', name: 'Schedar · 平稳' }, { id: 'Gacrux', name: 'Gacrux · 成熟' }, { id: 'Pulcherrima', name: 'Pulcherrima · 外放' },
      { id: 'Achird', name: 'Achird · 友好' }, { id: 'Zubenelgenubi', name: 'Zubenelgenubi · 随意' },
      { id: 'Vindemiatrix', name: 'Vindemiatrix · 温柔' }, { id: 'Sadachbia', name: 'Sadachbia · 活泼' },
      { id: 'Sadaltager', name: 'Sadaltager · 博识' }, { id: 'Sulafat', name: 'Sulafat · 温暖' },
    ],
    // 多人对白：speechConfig.multiSpeakerVoiceConfig，最多 2 个说话人，各自一个音色。
    // 2026-08-29 真打 200（3.1-flash-tts / 2.5-pro-tts；2.5-flash 那次是配额 429）。
    // 文本里用「名字：台词」分行，名字要和这里的 speaker 名对上。
    maxSpeakers: 2,
    // 风格指令：Gemini TTS 靠自然语言控风格（官方就是这么用的），我们把它拼在正文前面
    // 送进同一个 prompt。**注意**：speechConfig.languageCode 探针过——连 'zz-ZZ' 都收 200，
    // 即完全不校验、也看不出效果，属于"设了等于没设"，故不做成设置项（语言靠文本自动判定）。
    styles: [
      { id: '', name: '默认' }, { id: '用轻松愉快的语气说：', name: '轻松' }, { id: '用沉稳严肃的语气说：', name: '严肃' },
      { id: '用温柔平缓的语气说：', name: '温柔' }, { id: '用激动兴奋的语气说：', name: '激动' },
      { id: '用低声耳语的方式说：', name: '耳语' }, { id: '像新闻播报一样说：', name: '播报' },
    ],
    defaults: { model: 'gemini-2.5-flash-tts', voice: 'Kore' },
  },
  music: {
    // lyria-002 -> Vertex :predict; lyria-3-* -> Gemini Developer API (key), since
    // Vertex won't serve lyria-3 to this project.
    // lyria-3.5（2026-09-04 GA）同走 dev API generateContent：Vertex :predict 404、
    // Vertex Interactions 报 Unsupported model；实测约 40s 出 ~65s 44.1k 立体声 mp3，可带人声。
    models: [
      { id: 'lyria-3.5', name: 'Lyria 3.5', desc: '整首歌 · 可带人声与歌词' },
      { id: 'lyria-002', name: 'Lyria 2' },
      { id: 'lyria-3-clip-preview', name: 'Lyria 3' },
      { id: 'lyria-3-pro-preview', name: 'Lyria 3 Pro · 最长3分钟' },
    ],
    // 负面提示词只有 lyria-002 这条 Vertex :predict 通道吃（instance.negative_prompt）；
    // lyria-3 走 Gemini Developer API 的 generateContent，只有一个 prompt，驱动层压根
    // 不看 negativePrompt——所以选 lyria-3 时前端要收起这一栏，别摆一个填了没用的框。
    negSupport: ['lyria-002'],
    defaults: { model: 'lyria-002' },
  },
  codex: {
    // Verified against the installed Codex App Server model/list catalog.
    // Codex supports Astra Ultra (the public API effort list is different).
    // Keep the ids exact because they are passed straight to App Server turn/start.
    models: [
      { id: 'gpt-6.1-sol', name: '6.1 Sol', description: '编程与日常工作的主力', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], serviceTiers: ['priority'] },
      { id: 'gpt-6-astra', name: '6 Astra', description: '复杂推理、编程与专业工作', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], serviceTiers: ['priority'] },
      { id: 'gpt-5.6-sol', name: '5.6 Sol', description: '复杂、开放式任务', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], serviceTiers: ['priority'] },
      { id: 'gpt-5.6-terra', name: '5.6 Terra', description: '日常通用工作', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], serviceTiers: ['priority'] },
      { id: 'gpt-5.6-luna', name: '5.6 Luna', description: '快速、清晰任务', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], serviceTiers: ['priority'] },
    ],
    efforts: [
      { id: 'low', name: 'Light' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
      { id: 'xhigh', name: 'Extra High' },
      { id: 'max', name: 'Max' },
      { id: 'ultra', name: 'Ultra' },
    ],
    defaults: { model: 'gpt-6.1-sol', effort: 'medium', serviceTier: null },
  },
};

// ---- Derived helpers for backend convenience ----------------------------
// The Sets give O(1) membership tests for endpoint validation; the lists are
// what the frontend renders. Both come from the same CAPABILITIES object above.

const ids = (list) => list.map((x) => x.id);
const idSet = (list) => new Set(ids(list));

// 白名单 = picker 里的裸 id + 1M 兄弟档 id（旧客户端/收藏的会话可能还发 [1m]，别 400）。
export const CLAUDE_MODELS = new Set([
  ...ids(CAPABILITIES.claude.models),
  ...CAPABILITIES.claude.oneM.map((id) => id + '[1m]'),
]);
export const ULTRACODE = 'ultracode';
// 白名单另收旧写法 'ultracode'（= xhigh + Ultracode，见上面 capabilities 的 ultracode 注释）
export const CLAUDE_EFFORTS = new Set([...ids(CAPABILITIES.claude.efforts), ULTRACODE]);
// 档位与 Ultracode 归一：旧写法 effort:'ultracode' 拆成 { effort:'xhigh', ultracode:true }；其余原样。
export function splitUltracode(effort, ultracode) {
  if (effort === ULTRACODE) return { effort: 'xhigh', ultracode: true };
  return { effort: effort || undefined, ultracode: ultracode === true };
}
// effort 档位 + Ultracode → SDK query 选项。Ultracode 合成 settings {ultracode, enableWorkflows}（调用方把 settings 与
// fastMode 合并成一份 settings 字面量；enableWorkflows 显式开是因为 Pro 计划默认关）；档位原样；都没有 → {}。
export function claudeEffortOptions(effort, ultracode) {
  const s = splitUltracode(effort, ultracode);
  return {
    ...(s.effort ? { effort: s.effort } : {}),
    ...(s.ultracode ? { settings: { ultracode: true, enableWorkflows: true } } : {}),
  };
}
// 未指定模型时的默认（config/index.mjs 的 MODEL 与前端芯片共用同一个值）。
export const CLAUDE_MODEL_DEFAULT = CAPABILITIES.claude.defaults.model;
// 1M 归一：支持 1M 的裸 id → [1m] 兄弟档；已带 [1m] 或不支持的原样返回。
const ONE_M = new Set(CAPABILITIES.claude.oneM);
export const to1M = (model) => (model && ONE_M.has(model) ? model + '[1m]' : model);
// fast mode 支持判定（按裸 id；默认模型也算——未指定模型时 fall 到 defaults.model）。
const FAST_SET = new Set(CAPABILITIES.claude.fast);
export const claudeSupportsFast = (model) => FAST_SET.has(String(model || CAPABILITIES.claude.defaults.model).replace(/\[1m\]$/, ''));
// 不传 effort 时该模型实际跑的档位（按裸 id；未指定模型按 defaults.model）。前端传入 caps 数据以跟随后端。
export const claudeDefaultEffort = (model, caps = CAPABILITIES) => {
  const c = (caps && caps.claude) || CAPABILITIES.claude;
  const id = String(model || c.defaults.model).replace(/\[1m\]$/, '');
  return (c.effortDefaults || {})[id] || 'high';
};

export const VERTEX_MODELS = idSet(CAPABILITIES.vertex.models);
export const VERTEX_MODEL_DEFAULT = CAPABILITIES.vertex.defaults.model;
// 拒 minimal 的模型（vertex.mjs 的 thinkingFor 夹紧用；前端摘菜单读的是 caps 里同一张表）。
export const VERTEX_NO_MINIMAL = new Set(CAPABILITIES.vertex.noMinimal);
// 代码执行不能和搜索类工具同开的模型（vertex.mjs 组工具时兜底丢掉代码执行）
export const VERTEX_CODE_SOLO = new Set(CAPABILITIES.vertex.codeSolo);
export const VERTEX_MEDIA_RES = idSet(CAPABILITIES.vertex.mediaRes);
export const VERTEX_SYSTEM_MAX = CAPABILITIES.vertex.systemMax;
export const VERTEX_THINK_LEVELS = idSet(CAPABILITIES.vertex.thinkLevels);
export const VERTEX_THINK_DEFAULT = CAPABILITIES.vertex.defaults.think;

export const VEO_MODELS = idSet(CAPABILITIES.veo.models);
export const VEO_MODEL_DEFAULT = CAPABILITIES.veo.defaults.model;
export const VEO_ASPECTS = idSet(CAPABILITIES.veo.aspects);
export const VEO_RESOLUTIONS = idSet(CAPABILITIES.veo.resolutions);
export const VEO_RES_SUPPORT = CAPABILITIES.veo.resSupport;
export const veoResSupport = (model) => VEO_RES_SUPPORT[model] || ['720p', '1080p'];
// 时长按模型夹紧：不在该模型档位表里的值取「最接近的合法档」而不是硬回落默认 8——
// 用户选了 Omni 的 3 秒再切回 Veo，应该落到 4 秒（最近档），不是跳到 8 秒。
export const veoDurSupport = (model) => CAPABILITIES.veo.durSupport[model] || [4, 6, 8];
export const veoDurClamp = (model, d) => {
  const sup = veoDurSupport(model);
  const n = Number(d);
  if (sup.includes(n)) return n;
  if (!isFinite(n)) return CAPABILITIES.veo.defaults.duration;
  return sup.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best), sup[0]);
};
export const veoTaskSupport = (model) => CAPABILITIES.veo.taskSupport[model] || ['t2v', 'i2v'];
export const veoTaskOk = (model, task) => veoTaskSupport(model).includes(task);
// Veo 专属参数（负面提示词 / 提示词增强 / 画质）——Omni 一律不传，它的 response_format
// 认不出这些键会直接 400。
const VEO_ONLY = new Set(CAPABILITIES.veo.veoOnly);
export const veoOnlyParams = (model) => VEO_ONLY.has(model);
export const VEO_QUALITIES = idSet(CAPABILITIES.veo.qualities);

export const IMAGE_MODELS = idSet(CAPABILITIES.image.models);
export const IMAGE_MODEL_DEFAULT = CAPABILITIES.image.defaults.model;
export const IMAGE_ASPECTS = idSet(CAPABILITIES.image.aspects);
// 只有部分模型认的比例（aspects 里带 only，如 2.1 的 4:1 / 1:8）：别的模型收到就当「自动」，免得 400。
const IMG_ASPECT_ONLY = new Map(CAPABILITIES.image.aspects.filter((a) => a.only).map((a) => [a.id, new Set(a.only)]));
export const imgAspectFor = (model, aspect) =>
  IMAGE_ASPECTS.has(aspect) && (!IMG_ASPECT_ONLY.has(aspect) || IMG_ASPECT_ONLY.get(aspect).has(model)) ? aspect : 'auto';
export const IMAGE_SIZES = idSet(CAPABILITIES.image.sizes);
export const IMG_THINK_LEVELS = idSet(CAPABILITIES.image.thinkLevels);
export const IMG_THINK_SUPPORT = new Set(CAPABILITIES.image.thinkSupport);
export const IMG_SEARCH_SUPPORT = new Set(CAPABILITIES.image.searchSupport);
export const IMG_IMGSEARCH_SUPPORT = new Set(CAPABILITIES.image.imageSearchSupport);
// 人物生成枚举（空串 = 不传）。Nano Banana 专属，Imagen 那条路不吃这个键。
export const IMG_PERSON_GEN = new Set(CAPABILITIES.image.personGen.map((x) => x.id).filter(Boolean));
// 按模型夹紧 imageSize：不支持的档位落到该模型能收的最大档（lite 只有 1K）。
export const imgSizeClamp = (model, size) => {
  const sup = CAPABILITIES.image.sizeSupport[model];
  if (!sup || !size) return size;
  return sup.includes(size) ? size : sup[sup.length - 1];
};

export const TTS_MODELS = idSet(CAPABILITIES.tts.models);
export const TTS_MODEL_DEFAULT = CAPABILITIES.tts.defaults.model;
export const TTS_VOICES = idSet(CAPABILITIES.tts.voices);
export const TTS_VOICE_DEFAULT = CAPABILITIES.tts.defaults.voice;
export const TTS_MAX_SPEAKERS = CAPABILITIES.tts.maxSpeakers;

export const MUSIC_MODELS = idSet(CAPABILITIES.music.models);
export const MUSIC_MODEL_DEFAULT = CAPABILITIES.music.defaults.model;
const MUSIC_NEG = new Set(CAPABILITIES.music.negSupport);
export const musicNegSupport = (model) => MUSIC_NEG.has(model);

// Codex: model + model-specific effort validation for the ChatGPT picker.
export const CODEX_MODELS = idSet(CAPABILITIES.codex.models);
export const CODEX_MODEL_DEFAULT = CAPABILITIES.codex.defaults.model;
export const CODEX_EFFORT_DEFAULT = CAPABILITIES.codex.defaults.effort;
const CODEX_MODEL_META = new Map(CAPABILITIES.codex.models.map((m) => [m.id, m]));
export function codexEffortAllowed(model, effort) {
  return !!effort && (CODEX_MODEL_META.get(model)?.efforts || []).includes(effort);
}
export function codexServiceTierAllowed(model, serviceTier) {
  return !!serviceTier && (CODEX_MODEL_META.get(model)?.serviceTiers || []).includes(serviceTier);
}
