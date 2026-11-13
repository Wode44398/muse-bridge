# Media Studio：图像、视频、配音、音乐

Media Studio 是 Muse Bridge 里的媒体创作页：**「图像」**（Image）、**「视频」**（Video）、**「配音」**（Voice）、**「音乐」**（Music）四个创作页放在一起，左边一条常驻的作品栏，作品和工作空间里的文件可以直接拖进任一页当素材。打开它之后，Claude 也会多出画图、配音、配乐、视频这几个工具。

它接替了以前的 Gemini · Vertex 扩展——Gemini 对话已经下线，媒体生成都在这里（从旧版升上来的见本章末尾）。**模型和 Key 要用户自己接、费用由各家按用量收**，所以装好时是关着的，管理员打开、接好模型才用得上。

## 打开它（管理员）

1. **「设置 → 扩展 → 功能扩展」**（Settings → Extensions → Modules），「插件市场」下面的「Agent」一区里有 Media Studio 这张卡，把卡上的开关打开。即时生效，不用重启。
2. 打开后主页多出 **Media Studio** 方块（电脑上是主页 Dock 里的 Media Studio），成员那边也跟着出现（见下面「成员怎么用」）。
3. 设置根页「Agent」分组里的 Media Studio 一行点进去，页头有同一个开关「启用 Media Studio」，在哪边拨都一样。
4. 不想用了就把开关关掉：主页、成员那里都不再出现，Claude 也没有那几个生成工具；生成过的作品还在，再打开就回来。
5. 刚打开时一个模型都没有，点生成会提示「没有可用的模型，先到设置里接一个服务」——先做下一节。

## 给它接模型（设置 → 模型中心）

Media Studio 自己不管 Key。管理员的媒体模型和 Claude、dimensio 的模型一样，都在 **「设置 → 模型中心」**（Settings → Model Hub）里接；模型中心的通用操作（线路、多把 Key、测试、共享给成员）见 10-model-hub.md，这里只讲媒体这一半。两条路，可以都用：

### Google Vertex AI（Nano Banana、Veo、Gemini TTS、Lyria）

模型中心里有一张 **Vertex AI** 卡，没配时标着「未配置」。点开它（**「设置 → Media Studio」** 里的 **「Google 云凭据」**（Google Cloud credentials）那一行打开的也是这张面板）：

1. 先准备凭据，两种都行：
   - **服务账号密钥（推荐）**：Google Cloud 控制台选好项目 → 启用 Vertex AI API → IAM 和管理 › 服务账号里新建一个，角色选「Vertex AI 用户」→ 点进它 › 密钥 › 添加密钥 › 创建新密钥 › JSON，下载那个文件。项目要已经开通结算。
   - **自己的 Google 账号**：在用户自己的电脑上装 gcloud，运行 `gcloud auth application-default login`，浏览器里登录后，上传生成的 `application_default_credentials.json`（Windows 在 `%APPDATA%\gcloud\`，macOS / Linux 在 `~/.config/gcloud/`）。这种不带项目，项目 ID 要自己填。
2. 面板最上面是 **「Google 云凭据」** 卡：把 JSON 文件拖进虚线框，或点 **「选择文件」**（Choose file），或 **「粘贴内容」**（Paste contents）把文件全文贴进去。选错了文件（比如 OAuth 客户端 ID 文件）当场就会说。已经有凭据时这里收成一枚 **「更换凭据」**（Replace credentials）。
3. **「项目 ID」**（Project ID）：服务账号密钥里带的会自动填好；用自己账号的凭据时自己填 Google Cloud 项目 ID。
4. **「Gemini API Key（可选）」**（Gemini API key (optional)）：个别模型、2K / 4K 的部分图像、整首歌要用。保存后只显示末 4 位。
5. **「区域」**（Regions）一般别动：图像走 global，视频 / 配音 / 音乐在 us-central1。
6. 点 **「保存并测试」**（Save and test）：马上生效，并真连一次 Google——不生成东西、不收费。看到「✓ Vertex 已连通」就好了；**「测试连接」**（Test connection）只测不改，**「移除凭据」**（Remove credentials）删掉上传的那份。
7. 凭据存好后，面板下半是 **「媒体模型」**（Media models）：Vertex 上的图像、视频、配音、音乐模型按种类列着，勾上的会出现在 Media Studio 里，改完点 **「保存」**（Save）。要是这里只有一个 **「加上 Vertex 的媒体模型」**（Add Vertex media models）按钮，点一下它——加上后面板会自己关掉，再打开就能看到模型。
8. 同一张面板上半的 **「启用」**（Enable）、**「提供给」**（Available to）和 **「型号」**（Model）管的是另一件事：把 Vertex 上的 Gemini 对话模型给 Claude 和 dimensio 用（见 10-model-hub.md），和 Media Studio 开没开无关。多人用时还有 **「共享给成员」**（Share with members）：打开后成员也能用这份 Vertex——对话模型和媒体模型一起，费用记在管理员的 Google 云项目上。

测试没通过时，卡片上会写一句原因，照着改：

| 写的是 | 怎么办 |
|---|---|
| 这个项目还没开通 Vertex AI API | Google Cloud 控制台「API 和服务」里启用 Vertex AI API |
| 没有权限 | 给这个服务账号（或自己的账号）加「Vertex AI 用户」角色，再核对项目 ID |
| 这个项目没有关联结算账号 | 给项目开通结算 |
| 凭据无效 | 密钥被删或吊销了，重新下载一份上传 |
| 找不到这个项目 / 还没填项目 ID | 核对或填上项目 ID |
| 30 秒没有回应 / 连不上 Google | 多半是 Muse 里的审核卡没批，见下面「在 Muse 上先放行网站」 |

凭据只存在这台 VM 的数据目录里（只有服务本身读得到），成员看不到，接口也只回服务账号邮箱这类摘要。**别把凭据文件的内容发在 Muse 的聊天里**，直接在设置页上传。填了项目 ID 后，卡片底下有这个项目在 Google Cloud 里的账单、配额、用量三个直达链接。

### 别的媒体服务（地址 + Key）

Media Studio 认这几类接口，括号里是各自能做的种类：OpenAI 及兼容地址（图像、视频、配音）、OpenRouter（图像、视频）、fal 与 Replicate（四种都有）、ElevenLabs（配音、音乐）、MiniMax（视频、配音、音乐）、火山方舟（图像、视频）、Gemini API Key（四种都有）。

1. 模型中心里点 **「添加服务」**（Add provider），填 **「接口地址」**（Base URL）和 API Key。
2. 点 **「识别模型」**（Detect models）：识别出的模型按文本、图像、视频、配音、音乐分栏。
3. 在图像 / 视频 / 配音 / 音乐栏里勾上要用的，底部 **「添加到」**（Add to）选 Media Studio，再 **「保存」**。文本模型只能给 Claude / dimensio，媒体模型只能给 Media Studio；这家接口做不了的种类加不进去，保存时会说明原因。
4. 之后想加减模型，回到这个服务里改勾选再保存；上游出了新模型，点 **「重新识别」**（Detect again）再勾。
5. 服务上的 **「走出站代理」**（Use outbound proxy）开关在这台 Muse 上要保持打开——VM 只能经 Muse 的出站代理出网，关了就连不出去。

这几家里没用真 Key 逐个打过的（OpenAI、fal、Replicate、ElevenLabs、MiniMax、火山方舟）是按官方文档接的：第一次用先小额试一条。

模型中心里要是有一张「本机图像模型」卡，那是给有显卡的电脑本地出图用的，**在 Muse 上用不了**。

### 在 Muse 上先放行网站

这台 VM 访问每个新网站都要用户在 Muse 里批准（卡片在输入框上方或右侧「待审核」面板）。没批的时候：「保存并测试」等 30 秒后报「30 秒没有回应…出站代理还在等你批准访问 googleapis.com」，「识别模型」会超时，生成会一直停在排队 / 生成中。

- **Vertex**：凭据配好、Media Studio 打开后，在 Muse 里说一句「放行 Media Studio 要用的网站」，Muse 会跑 `allow-sites`——按现在的配置算，会带上 `oauth2.googleapis.com`、`aiplatform.googleapis.com`（或所选区域的 `<区域>-aiplatform.googleapis.com`）、`us-central1-aiplatform.googleapis.com`、`generativelanguage.googleapis.com`，细节见 `../MUSE.md` 4.9。批完回来再点一次「保存并测试」。
- **别的服务**：添加之前让 Muse 跑 `allow-sites <接口地址>`。有些服务把生成结果放在另一个域名上，第一次生成时可能再弹一张卡。
- 每张卡怎么批由用户自己选。各选项的后果：只选「允许一次」的话，之后在后台生成时还会再问，没人批生成就会停在那里；选「总是允许此站点」以后这个网站不再问（选项见 `../MUSE.md` 2.0）。

## 设置 → Media Studio

**「设置 → Media Studio」**（Settings → Media Studio）——Media Studio 页右上角的齿轮打开的也是这里。管理员从上到下：

| 分组 / 行 | 里面有什么 |
|---|---|
| 页头 | 「启用 Media Studio」开关，只有管理员有 |
| **「媒体服务」**（Media providers） | **「模型中心」**（Model Hub）——跳到模型中心，行尾写着现有几个服务、几个模型；**「Google 云凭据」**——打开模型中心的 Vertex AI 面板 |
| **「默认模型」**（Default models） | 图像、视频、配音、音乐各一行，点进去选一个模型；不选就是「自动」，用目录里排第一的。创作页打开时选中的就是它，Claude 的生成工具没指定模型时也用它 |
| **「存储」**（Storage） | **「自动存进工作空间」**（Save to workspace automatically），默认开；**「保存位置」**（Save location），默认是工作空间里的 `Media Studio` 文件夹 |
| **「高级」**（Advanced）——只有管理员 | 哪些 agent 能生成、能生成哪几种、内容安全过滤，见下一节 |

- 管理员在这里定的默认模型和存储是全服的默认；成员在自己的设置里可以另选，选过的那一行标着「我的」。
- 改过默认值的项旁边有个小点；设置改了马上生效。
- Windows 桌面客户端里是设置左栏的 Media Studio 分区，内容一样。

## 谁能生成、能生成什么、内容安全过滤（设置 → Media Studio → 高级）

只有管理员看得到，改了马上生效。**只管 agent 自己去生成**，用户在 Media Studio 里手动生成不受影响。

- **「允许的 agent」**（Allowed agents）：
  - **Claude**：默认开，Claude 有画图、配音、配乐、视频这几个工具。下面的 **「需要素材时主动生成」**（Generate assets proactively）也默认开——Claude 做网页、文档时会不等用户开口就配图配乐；用户嫌费钱或不想要，关掉它，Claude 就只在被要求时才生成。
  - **dimensio**：默认关。打开后 dimensio 也能生成，图片和语音按 dimensio 的权限档审批，视频和音乐每次先问用户。
  - **「外部 agent」**（External agents）：默认开，指拿「设置 → Agent 接入」里的密钥来调用的 agent 和脚本——包括你自己用 agent 密钥调的时候，见 `../MUSE.md` 4.8。
- **「允许的种类」**（Allowed types）：图像、视频、配音、音乐各一个开关；**「视频最高分辨率」**（Maximum video resolution）可选 720p / 1080p / 4K，agent 要更高会自动降到这一档。想省钱：关掉视频，或把分辨率压到 720p。
- **「内容安全过滤」**（Content safety filters）：骚扰、仇恨言论、色情内容、危险内容四类，每类从 **「Google 默认」**（Google default）、「不过滤」到「拦低风险及以上」五档，跟 Google AI Studio 的安全设置是同一套，只对 Google 的图像模型（Nano Banana）生效；没有接 Google 的服务时组名旁标着「当前服务不适用」。被拦下时报错里会写明原因——换个说法再试，或请管理员调这里。
- 关掉之后 agent 会照实说：Claude 回「管理员没让 Claude 生成媒体」或「管理员关掉了 agent 生成视频」，就是这里的开关关着。

## 用起来

- 主页的 **Media Studio** 方块进去。顶上在 **「图像」**、**「视频」**、**「配音」**、**「音乐」** 四个创作页之间切换，各页的草稿和参数分别留着；右上角有任务指示和设置齿轮。
- 每一页都是「写提示词 → 出作品」：输入框里写要什么、选好模型，常用参数（比例、尺寸、时长、音色）直接摆在输入框底部，其余收在 **「更多」**（More）里。参数跟着模型变，不同模型能调的不一样。
  - 图像：文生图和改图。Google 的图像模型可以接着说「改成…」逐轮修改；别的模型的续改是拿上一张当参考图。
  - 视频：只给文字、给首帧、给首帧加尾帧、或给参考图都行，哪些模型收什么看模型。
  - 配音：把文字读出来，可选音色。
  - 音乐：按描述生成一段配乐，部分模型能唱歌词。
- 左边的作品栏有两个标签：**「作品」**（Works）是四个种类合在一起的作品流，进行中的排在最上面，可以搜索、按种类筛选；「文件」是工作空间里的文件。
- **拿作品当素材**：作品卡和文件都能拖进任一创作页的输入框；作品菜单里的 **「接着做」**（Continue with）可以把一张图送去继续改、当参考图、当视频首帧或尾帧，点了自动切到对应的页并带上素材。工作空间里的文件菜单也有 **「发到 Media Studio」**（Send to Media Studio）。
- 作品菜单里还有下载、**「存进工作空间」**（Save to workspace）、**「在文件中显示」**（Show in Files）、**「复用参数」**（Reuse settings）和删除。删除只删作品库里那一份，已经存进工作空间的文件不受影响。
- **生成在服务器上跑**：切页面、锁屏、断网都不丢，回来接着看。视频和音乐一次约 1–3 分钟。点右上角的任务指示能看进行中和最近的任务，可以 **「取消任务」**（Cancel task）；已经发给服务方、收不回来的视频会标「已放弃（仍可能计费）」。服务重启会中断正在跑的任务。
- **作品存在哪**：每个账号有自己的作品库，互相看不到。在 Media Studio 里生成的默认还会自动复制一份进工作空间，位置是 `Media Studio/<图像|视频|配音|音乐>/<时间>-<描述>`；Claude 和别的 agent 生成的不自动存，它们自己决定放哪。
- 出错的作品卡上写一句原因；被内容过滤拦下时按钮是 **「改提示词」**（Edit prompt）。
- **在 Claude 里**：Media Studio 开着时，直接跟 Claude 说「画一张…」「配一段音乐」「把这段读出来」，作品显示在对话里，也进 Media Studio 的作品流，Claude 还能把文件拿去当素材（比如做网页配图）。
- **在 dimensio 里**：管理员在上一节打开「dimensio」后，同样直接跟它说要什么。

## 成员怎么用

- Media Studio 打开后，新注册的账号默认就有 Claude 和 Media Studio；被单独设过名单、里面没有它的账号，管理员在控制台「用户」页他那一行勾上（见 06-users-admin.md）。
- 成员能用的模型有两种来源：
  - **管理员共享的**：管理员在模型中心把服务（或 Vertex AI）的 **「共享给成员」** 打开。成员看得到名字和模型，看不到地址和 Key；用它生成花的是管理员的钱，**计入成员的额度**。
  - **自己的 Key**：成员没有模型中心，在自己的 **「设置 → Media Studio」** 的 **「媒体服务」** 里点 **「添加服务…」**（Add provider…）接自己的服务——最多 10 个、只能连公网地址、接 Vertex 只能用自己的服务账号 JSON。用自己的 Key 不计额度。在 Muse 上这些地址同样要先放行，请管理员让 Muse 跑 `allow-sites <接口地址>`。
- 成员的设置页里，管理员共享的列在 **「管理员共享给你的服务」**（Providers shared with you by the admin）；默认模型可以自己另选，或选 **「跟随管理员的默认」**（Follow the admin’s default）。
- 限制成员的用量：控制台 **「额度与注册」**（Quotas & sign-ups）里，**「成员能用的高消耗功能」**（High-cost features for members）可以把 **「生成图片、语音、音乐」**（Generate images, speech, and music）和 **「生成视频」**（Generate video）分别关掉；默认额度里有 **「每天最多生成几次图片、语音、音乐」**（Images, speech, and music per day）和 **「每天最多生成几条视频」**（Videos per day）。

## 新模型自动出现

- Vertex 这类内置服务：服务器启动后约 2 分钟检查一次，之后每 12 小时一次，只读模型列表、不花钱。新出的模型直接出现在创作页的模型菜单里，7 天内名字后面标着 **「新」**（New）；管理员可以在模型中心的 Vertex AI 面板里把不想要的关掉。上游不再提供的模型会从菜单里隐藏。
- 模型中心里「地址 + Key」的服务：模型清单以模型中心里勾选的为准，不会自动加；要新模型就「重新识别」再勾。
- 成员自己接的服务：编辑器里有 **「自动发现」**（Auto-discover）开关和 **「立即检查」**（Check now）；自动检查只在本人打开 Media Studio 时触发。OpenRouter、fal、Replicate 这类聚合服务第一次检查到的上百个模型先放在模型菜单的 **「备选」**（More）里，搜得到、选了就能用。

## 从旧版（Gemini · Vertex）升级上来

- **开关沿用**：以前 Gemini · Vertex 关着的，Media Studio 也关着；开着的照旧开着。
- **凭据和模型不用重配**：原来上传的 Google 云凭据、项目、区域照旧生效，Vertex 的媒体模型自动出现在模型中心的 Vertex AI 面板里；以前填的 Gemini API Key 这类「地址 + Key」的配置，更新后第一次启动会自动并进模型中心。
- **作品都在**：以前在 Vertex 页生成的、Claude 生成的作品，都在 Media Studio 的作品流里，能看、能删。
- **Gemini 对话没有了**：主页的 Vertex 方块、设置里的 Gemini 一行都换成了 Media Studio；以前的 Gemini 对话记录不再显示。还没更新的旧版 App 去开 Gemini 对话，会收到一句「Gemini 对话已下线，媒体生成请用 Media Studio」。想继续跟 Gemini 对话：在模型中心的 Vertex AI 面板里把 Gemini 对话模型给 Claude 或 dimensio 用（见 10-model-hub.md）。
- **用 Gemini 跑的定时任务**：会被停用，任务上写着「Gemini 对话已下线，这条用 Gemini 跑的定时任务已停用；要接着用，请编辑它改用 Claude。」——任务没删，编辑后重新打开就改用 Claude 跑。
- **成员**：以前有 Gemini 权限的成员自动换成 Media Studio。
- **以前在「设置 → Agent → Gemini」改过的那三组**（让别的 agent 生成媒体、agent 能生成什么、内容安全过滤）照旧生效，现在在「设置 → Media Studio → 高级」里，前两组改叫「允许的 agent」「允许的种类」。

## 要花多少钱

- Media Studio 本身不收钱。**用哪家的模型就由哪家收**：Vertex 记在用户自己的 Google Cloud 账单上，其它服务扣各自账号的余额。视频按秒计、最贵；图像按张；音乐按次。
- 取消不一定省钱：已经发给服务方的视频任务，放弃了仍可能计费。
- 想控制花费：在 Google Cloud 里设预算提醒；关掉 Claude 的「需要素材时主动生成」、关掉 agent 生成视频或压低视频分辨率（见上面「谁能生成」一节）；多人用时把成员的视频生成关掉或限次数，或者不共享服务、让成员用自己的 Key。
