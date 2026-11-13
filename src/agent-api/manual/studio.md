# Media Studio（图像 / 视频 / 配音 / 音乐）

Media Studio 是 bridge 的媒体创作工作室：四个创作页（图像、视频、配音、音乐）加一条常驻的工作空间侧栏，用来把媒体工具串成工作流（先出图 → 拿图当视频首帧 → 视频出来再配音、配乐）。每个创作页都能接自己的模型服务与 Key。2026-11-04 起它接替了原来 Gemini 分页里的媒体部分；Gemini 对话已下线。

## Media Studio 是什么

- 它是功能扩展「Media Studio」（agent id `studio`，工具型页面，不能拿来聊天）。服务端装着、管理员开着、对这个人授权了，主页才有入口。新账号默认有它；以前有 Gemini 权限的成员自动换成 Media Studio。
- 一个「服务」= 一家媒体接口（方言）+ 连接参数 + 一组模型。方言决定怎么调：`vertex`（Google Vertex AI）、`gemini`（Gemini API Key）、`openai`（含所有 OpenAI 兼容地址）、`openrouter`、`fal`、`replicate`、`elevenlabs`、`minimax`、`ark`（火山方舟）、`local`（本机 Qwen 图像模型，只有管理员）。
- 生成在服务端跑：切页面、锁屏、断网都不丢，回来按任务列表对账。花钱且慢：视频、音乐一次约 1–3 分钟。
- 作品按账号隔离，存在各人自己的媒体库里；默认还会自动复制一份进工作空间（见「作品与工作空间」）。
- 成员的图像 / 配音 / 音乐与视频生成受管理员的额度管（控制台「额度与注册」：开关与每日次数）——用管理员共享的服务才计额度；成员自己的 Key 不计。

Google 系内置模型与参数的可选值（服务端按能力表现填；各人另接的服务以 `GET /api/studio/catalog` 为准）：

{{studio.params}}

## 界面：外壳、四个创作页与侧栏

- 顶部：Studio 标题、四个创作页的分段切换（图像 / 视频 / 配音 / 音乐）、任务指示（有进行中的任务时是「转圈 + 数字」，点开是任务托盘）、设置入口（⚙ 打开 设置 › Media Studio）。
- 桌面宽屏：左边常驻工作空间侧栏（可折叠、宽度记忆），中间画布 + 底部输入岛，右边参数栏。平板：侧栏推入式。手机：分段切换贴顶，侧栏是从左缘拉出的抽屉，参数走输入岛上方的 chips 与弹出面板。
- 侧栏两个标签：「作品」= 跨四个种类的作品流（进行中的任务置顶，可按种类筛选，派生关系用细线串起）；「文件」= 工作空间文件，默认打开保存目录。
- 串联：作品卡和文件都能拖进任何创作页的输入岛当素材（落点提示首帧 / 尾帧 / 参考图 / 改图，按模型能收什么置灰）；作品卡菜单里有「接着做」（图像 → 视频首帧 / 尾帧 / 参考图、继续改图；文本文件 → 配音），点了自动切页、带上素材、记下血缘。
- 切创作页时各页的草稿和参数分别保留。
- 参数一律按模型卡渲染：常用的（比例、尺寸、时长、音色）在输入岛上方，其余在「高级」里。参数的来源按顺序找：内置模型卡（已知模型，参数矩阵逐个真打过）→ 服务自报的参数描述（OpenRouter 目录、Replicate / fal 的 schema，「参数：接口自报」）→ 沿用同族最近的内置模型（「参数：沿用 …」，Google 系再按 OpenRouter 公共目录修正时长 / 分辨率 / 比例的取值范围）→ 通用参数（「参数：通用」）。最后总有一个「原始参数」JSON 框，原样合并进请求。

接口：`ui.open`（page `studio`，module `image` / `video` / `voice` / `music`）

## 四个创作页

- 图像：文生图与改图。Google 系（Nano Banana）支持多轮续改：续改链带着前几轮的图与思考签名接着改；别的方言没有多轮上下文，续改 = 拿上一张出图当参考图。素材角色：改图（edit）、参考图（ref）。
- 视频：文字、首帧、首尾帧或参考图生成短视频。任务类型按给的素材定：只有文字 = 文生；首帧 = 图生；首帧 + 尾帧 = 首尾插值；参考图 = 带入主体 / 风格（参考图与首尾帧互斥，哪些模型收什么以模型卡为准）。部分模型收负面提示词。
- 配音：文字转语音。选音色（Google 30 个内置音色；ElevenLabs 拉取账号里的音色；其余按各家内置表），风格是一句自然语言前缀；Google TTS 支持两人对白（正文按「名字：台词」分行）。
- 音乐：按风格描述生成一段配乐；部分模型能唱歌词、部分收负面提示词。

选型思路：要最高画质选质量档；画真实存在的新事物（人物、品牌、地标）选支持联网 / 图片搜索的模型并打开搜索；图标与小装饰选最省的；视频先用低价预览档（如 Omni 360p）试构图再出高档。

## 任务：进度、取消与对账

- 每次生成是一个任务：排队 → 运行 → 完成 / 出错 / 已取消。任务托盘列出进行中的任务和最近 50 条。
- 取消尽力而为：还没发出去的直接停；Veo、Omni 这类发出去就收不回的，标「已放弃（仍可能计费）」，结果到了也不要。
- 服务重启时没跑完的任务标「服务重启，任务中断」。

接口：`GET /api/studio/jobs?active=1`、`POST /api/studio/jobs`、`POST /api/studio/jobs/<id>/cancel`；agent 侧用 `media.image` / `media.video` / `media.speech` / `media.music`

## 作品与工作空间

- 作品流里能看到全部作品，包括以前在 Gemini 页生成的、Claude 用媒体工具生成的（旧作品也能看、能删）。
- 自动存进工作空间：设置「自动存进工作空间」默认开，「保存位置」默认 `Media Studio`（相对各人自己的工作空间根）。落点 `<保存位置>/<图像|视频|配音|音乐>/<YYYYMMDD-HHmmss>-<描述摘要>.<扩展名>`。只对在 Studio 里发起的生成生效；Claude 和 agent 接口生成的不自动存（它们自己决定放哪）。
- 作品菜单可「另存到…」指定文件夹；删除作品只删媒体库里那份，可选连同自动存的副本一起删。
- 作品的规范地址是 `/api/vertex/media?id=<作品 id>`（聊天内嵌、离线 apk 都认它），缩略图加 `&v=thumb`。

接口：`GET /api/studio/assets?kind=&q=&thread=&cursor=`、`POST /api/studio/assets/<id>/save`、`POST /api/studio/assets/<id>/delete`

## 服务与 Key（设置 › Media Studio › 服务）

服务管理器对标 Claude 的「自定义 API」：预设、连接参数、模型列表（拉取或手填）、每个模型的默认参数、测试连接、调用日志、成员自带 Key、管理员共享给成员。

- 预设：Google Vertex AI、Gemini API、OpenRouter、OpenAI、OpenAI 兼容（自定义地址）、fal、Replicate、ElevenLabs、MiniMax、火山方舟、本机图像模型、自定义。
- 连接：接口地址（Vertex 与本机模型不用填）、API Key（加密存在服务器上，界面只显示末 4 位）、鉴权方式、请求头、超时、失败重试、服务级「额外请求体」。Vertex 服务另有项目 ID、对话区域（默认 global，Nano Banana 用）、媒体区域（默认 us-central1，Veo / TTS / Lyria 用），凭据二选一：沿用主机的 Google 凭据（ADC），或这个服务自己的服务账号 JSON。
- 模型：「从服务拉取」或手动添加（选种类：图像 / 视频 / 配音 / 音乐）；常见模型带模型卡（参数齐全），未知模型用通用卡 + 额外参数。
- 测试连接不花钱：只调列表 / 账户 / 余额这类只读接口（Vertex 用 countTokens）。「最近请求」看这个服务最近 50 次调用。
- 自动发现新模型（默认开，每个服务一个「自动发现」开关；Vertex、Gemini API、OpenRouter、Replicate、fal、OpenAI、ElevenLabs 有，MiniMax、火山方舟、本机模型没有列表接口不发现）：服务启动 2 分钟后检查一次、之后每 12 小时一次，有人拉模型目录时上次检查超过 6 小时也会在后台补一次；设置里「立即检查」马上查。只读列表接口，不花钱（Vertex 的新模型用不生成的探针确认能调用才加）。
  - 直连服务（Vertex、Gemini API、OpenAI、ElevenLabs）发现的新模型直接出现在模型选择器里。聚合服务（OpenRouter、Replicate、fal）第一次检查时把已有的上百个模型记成「备选」：不进主列表，选择器里搜得到、选了就能用；之后新出现的才进主列表。新发现的模型 7 天内、你还没用过时名字旁有一个小红点。
  - 上游不再列出的模型从选择器里隐藏（条目不删，再出现就恢复）。手动添加的、预设自带的模型永远不动；在设置里关掉的保持关，删掉的不会再被加回来。检查失败只记在服务卡上（时间与原因），不影响已有模型。
  - 成员自己的服务也会检查，但只在本人打开 Studio 时触发。
- 成员：最多 10 个服务、只许公网地址、没有本机模型、接 Vertex 只能用自己的服务账号、不能共享。管理员可把自己的服务标「共享给成员」：成员看得到名字和模型，看不到地址和 Key，用它生成计成员额度。
- 一键导入 Vertex：把主机现有的 Google 云凭据、Gemini API Key、OpenRouter Key、本机图像模型一次性变成服务（标共享，成员照旧能用），可以重复点（就地更新）。升级后主机一个服务都没有、但 Vertex 配好了时，首次启动会自动导入一次。
- 「Google 云凭据」卡（主机的服务账号 / ADC、项目、区域、Gemini Key、测试连接）现在是 Vertex 服务连接区的一部分；保存后已导入的服务跟着刷新。凭据只存在服务器数据目录，接口只回服务账号邮箱等摘要。

接口：`GET /api/studio/providers`、`POST /api/studio/providers/{create,update,delete,test,models,import-vertex,sync}`、`GET /api/studio/providers/log?id=`、`GET /api/studio/models/resolve?key=`（备选模型的完整参数）（这组没有 agent 操作：接服务、填 Key 只能在设置页里做）

## Media Studio 设置（设置 › Media Studio）

主机级（管理员）与个人级（每人自己）两层，读取时个人值压过主机值。改动即时生效。

- 「默认模型」（个人可覆盖）：图像、视频、配音、音乐各选一个服务里的模型；不选用内置默认。也是 Claude 媒体工具不指定模型时用的。
- 「存储」（个人可覆盖）：「自动存进工作空间」「保存位置」。
- 「高级 › 允许的 agent」（管理员；2026-11-06 前叫「让别的 agent 生成媒体」）：
  - 「Claude」（默认开）：Claude 对话和定时任务里的 mcp__media__* 生成工具；「需要素材时主动生成」（默认开）关掉后只在用户明确要求时生成。
  - 「dimensio」（默认关）：经 BridgeCall 调 media.*；图片和语音按 dimensio 的权限档审批，视频和音乐每次弹卡。
  - 「ChatGPT · Codex」（默认关，只在有 Codex 的服务器上出现）。
  - 「外部 agent」（默认开）：拿 agent 密钥调 /agent/v1/media.* 的 agent 和脚本。
- 「高级 › 允许的种类」（管理员；以前叫「agent 能生成什么」）：图像 / 视频 / 配音 / 音乐四个开关；「视频最高分辨率」720p / 1080p / 4K（agent 要更高会降档）。
- 「高级 › 内容安全过滤」（管理员）：骚扰 / 仇恨言论 / 色情内容 / 危险内容，每类「Google 默认 / 不过滤 / 只拦高风险 / 拦中风险及以上 / 拦低风险及以上」，只发给 Google 图像模型（Nano Banana）；全是默认时不发。被拦下时报错写明原因。
- 关掉的调用方或种类：agent 接口目录里对应的 media.* 标不可用，原因写着「管理员没让 … 生成媒体（设置 › Media Studio）」；Claude 从下一条消息起没有那几个工具。
- 以前在 设置 › Agent › Gemini 改过的这几项照旧生效（首次读取时照抄过来）。

接口：`media.settings` 看主机级全部项，`media.settings_set` 改（values = { key: 值 }，null = 恢复默认；同机 agent 实例不能改）。HTTP：`GET / POST /api/studio/settings`（POST 带 `scope: 'host' | 'mine'`）；老接口 `/api/vertex/settings` 仍可读写原来那几组。

## 在 Claude 和 agent 里生成媒体

- Claude：Media Studio 对这个账号开着（成员还需管理员开放媒体生成）时，Claude 自带 mcp__media__generate_image / video / speech / music 四个工具，作品内联显示在对话里、文件路径交给 Claude 当素材，也进 Studio 的作品流。`model` 可以传内置模型的裸 id（如 `gemini-3.1-flash-image`、`veo-3.1-fast-generate-001`、`gpt-image-2.5-sunburst`），也可以传 `<服务 id>/<模型 id>` 用 Studio 里任一服务；不传用 Studio 设置里的默认（没设就是工具说明里写的内置默认）。
- agent 接口：`media.image` / `media.video` / `media.speech` / `media.music`，`model` 同上两种写法；`saveTo` 顺手复制进工作空间。
- 桌面 Claude Code：仓库根的 `mcp-media.mjs`（stdio MCP）用主机的 Studio 服务生成，写到 outputPath 或 genmedia/。
- 定时触发不能直接调用媒体生成模块；需要定时出图时用 Claude 引擎并在指令里让它生成。

## Media Studio 的限制

- 没有 Key、没真打过的方言（OpenAI、fal、Replicate、ElevenLabs、MiniMax、火山方舟）按官方文档实现，第一次用建议先「测试连接」再小额试一条。
- 自动发现的参数来自服务方的目录描述，「必填」不一定写得出来：例如有的视频模型只做图生视频、不给首帧会被服务方以参数错误退回（不计费），按报错补上素材即可。OpenRouter 视频提交后没有取消接口，取消只能放弃等待（仍会计费）。
- 「Google 目录里列出」不等于能调用：Google 预览模型转正后会改名、回收旧 id；一个模型能不能用以真打为准。
- 部分 Google 模型 / 档位依赖 Gemini API Key（Omni、lyria-3 系列、Nano Banana 2.1 的 2K/4K），没有 Gemini API 服务时用不了或只出 1K。
- 媒体生成按次 / 按秒计费且较慢；成员受管理员设置的媒体 / 视频开关与每日次数限制。
- 服务重启会中断正在跑的任务（已经发出去的视频仍可能计费）。
