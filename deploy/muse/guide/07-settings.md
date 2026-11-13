# 设置逐项说明

## 怎么打开

- 侧栏最底下的账户卡 → **「设置」**（Settings）；主页右上账户胶囊里也有 **「设置」**。
- 网页和手机上，设置是一个整页的列表（像手机的「设置」App）：根页按分组列出各项，点一行从右边推入它的子页；左上角返回，手机上也可以从左边缘往右滑、按返回键，电脑上按 Esc。在根页再返回就关掉设置。网页版设置里没有搜索。
- **dimensio 的设置也在这里**：「Agent」分组里的 dimensio 一行就是它的全部设置；dimensio 页侧栏最底下的「设置」打开的也是这一页（逐项见 03-dimensio.md「dimensio 的设置」）。
- 宽屏电脑上，设置页会分成左右两栏：左边是根页的列表，右边是点开的那一页。
- Windows 桌面客户端里的设置长得不一样：左栏最上面是 **「搜索」**（Search）和账户，下面一列分区——**「通用」**、**「外观」**、**「快捷键」**（Keyboard shortcuts）；Claude、dimensio、Media Studio（打开了才有）、**「模型中心」**（Model Hub）、**「Agent 接入」**；**「扩展」**、**「额度与注册」**、**「设备」**、**「壁纸」**；**「安卓 App」**；**「连接与更新」**（Connection & updates）、**「反馈」**（Feedback）。各分区的内容和下面网页版对应的那一页一样；网页版「关于」里的服务器地址、公网地址在客户端的「连接与更新」里。
- 存在哪：「通用」「外观」「壁纸」**只存在当前这个浏览器 / 设备里**，换设备要重新设；「Claude」「dimensio」「Media Studio」这几页的设置（除了标着 **「这台设备」**（This device）的几项）**存在服务端**，按账号保存、各设备一致；模型中心里的服务也存在服务端。

## 根页一览

从上到下：

| 分组 | 行 | 谁能看到 |
|---|---|---|
| （最上面） | 账户卡：名字和身份，点进去是「账户」；没登录时写「登录」 | 所有人 |
| **「Agent」**（Agents） | Claude、dimensio，每个 agent 一行、各自一页；打开了 Media Studio 时多一行 Media Studio（见下面「Media Studio」与 09-media-studio.md） | 管理员看到所有开着的 agent；成员看到自己能用的 |
| 同上 | **「模型中心」**（Model Hub）：配模型服务的唯一入口，排在各个 agent 之后（见下面「模型中心」与 10-model-hub.md） | 管理员；能用 Claude 的成员（只有他自己的那一份） |
| 同上 | **「Agent 接入」**（Agent access） | 登录的人 |
| **「插件」**（Plugins） | **「安卓 App」**——英文界面下也写这几个中文字 | 登录的人 |
| **「服务器」**（Server） | **「扩展」**（Extensions）、**「额度与注册」**（Quotas & sign-ups）（多人用时才有）、**「服务端控制台」**（Admin console） | 只有管理员 |
| **「个性化」**（Personalization） | **「扩展」**（Extensions）——只有技能：自己添加的技能，以及管理员给所有人加装的（见 05-customize.md「成员自己的技能」） | 注册账号（成员）；管理员这一行在「服务器」分组里 |
| **「偏好」**（Preference） | **「通用」**（General）、**「外观」**（Appearance）、**「壁纸」**（Wallpaper）、**「流体壁纸」**（Fluid wallpaper） | 所有人；壁纸只在有主页（两个 agent 都开着）时有，流体壁纸只在主页用深色流体壁纸时有 |
| （不带标题） | **「设备」** | 登录的人 |
| （不带标题） | **「提交反馈」**（Send feedback）、**「关于」**（About） | 所有人 |

- 这台 Muse 上没有的：**「这台设备」** 分组和里面的 **「手机操控」**——Muse 关掉了手机操控；「软件更新」那一行只在安卓 App 里出现（Muse 用的也是 bridge 的安卓 App，所以 Muse 的 App 里也有），网页里没有（网页总是最新的）。

## 账户

- 页头：头像字母、用户名、身份（**「管理员」**（Admin）/ **「完全信任用户」**（Full trust user）/ **「普通用户」**（Standard user））。
- **「用量」**（Usage）：共享 Claude 订阅的用量——当前 5 小时窗口和本周各用了多少、多久后重置（80% 以上变红）。大家共用这一份。
- **「我的额度」**（Your usage）——只有注册账号有：今天和最近 7 天跑了几轮、花了多少，管理员设了上限时显示「已用 / 上限」；没设就写「不限」。
- **「管理员可见性」**（Admin visibility）——只有注册账号（成员）看得到，管理员本人没有这块。管理员默认只能看到你的会话标题、时间和用量；下面几个开关由你决定：
  - 允许查看对话内容：Claude 对话正文、定时任务的提示词和结果；
  - 允许代聊与代答：管理员可以在你的空间里代你发消息、替你回答提问和审批（代发的消息开头标着「【管理员代发】」）；接着聊你自己的会话，还要同时允许查看对话内容；
  - 允许看你登记的电脑（见下面「设备」）。
  - 技术上服主仍能读到服务器上的文件，这里约束的是控制台的默认行为。
- **「管理员的访问记录」**（Admin access history）——同样只有成员看得到：管理员每次查看内容、代聊代答都记在这里，同时会弹一句提示。
- **「工作空间」**（Workspace）：打开文件管理器（见 04-files.md）。
- **「扫一扫 · 登录网页版」**（Scan to sign in on the web）——只在手机、平板上有：扫电脑上的二维码帮它登录（见 01-access.md）。
- **「修改密码」**（Change password）——只有注册账号有（见 01-access.md）。
- **「切换账号」**（Switch Account）：这台设备上登录过的账号，当前这个打勾；点另一个直接切过去，不用重新输密码；**「添加账号」**（Add Account）再登一个号，原来的照样留着；× 从这台设备移除。见 01-access.md「切换账号、退出登录」。
- **「退出登录」**（Sign out）：只退出这台设备上的当前账号。

## Claude

**「设置 → Claude」**（Settings → Claude）——「Agent」分组里的 Claude 那一行：给 Claude 页的行为设置，**存在服务端、按账号保存**，对新会话生效，各设备一致。改过默认值的项旁边有个小点；单选项点进去改，改过的底部有 **「恢复默认」**（Reset to defaults）。从上到下：

| 分组 / 行 | 里面有什么 |
|---|---|
| 页头 | 「启用 Claude」 开关（只有管理员能改）；还没配认证时提示「在下面『订阅号池』里添加账号」 |
| **「订阅号池」**（Subscription Pool）——只有管理员 | 服务器上的 Claude 订阅账号，每个号的 5 小时 / 每周（和 Fable）用量、套餐标签（Pro / Max / Ultra），没有 5 小时限额的号那一栏写「无限制」；**「添加账号」**（Add Account）；点一个号进去能切换、编辑（含手动标套餐）、调顺序、删除。见 06-users-admin.md「Claude 账号」 |
| **「撞上限额时」**（When you hit a usage limit） | **「限额重置后自动继续」**（Auto-continue when limits reset）：撞上 5 小时限额后，额度恢复时自动接着跑完这一轮，默认开；管理员还有 **「额度用尽自动换号」**（Switch accounts when a limit is reached） |
| **「服务意外重启时」**（If the service restarts unexpectedly） | **「自动继续被中断的对话」**（Resume interrupted conversations）：服务中途崩溃、被结束或 VM 重启打断了正在跑的对话时，服务恢复后约 15 秒自动让 Claude 从中断的地方接着做，默认开，按账号各自设置。同一件事最多连着续 3 次；中断超过 12 小时、或你已经先发了消息就不续。关掉后只留一句「这一轮没跑完」，要你自己说「继续」（见 02-claude-code.md「Claude 在干活的时候」） |
| **「新会话默认」**（New session defaults） | **「权限模式」**（Permission mode）（管理员默认「自动」，其他人默认「接受编辑」）、**「输出风格」**（Output style）；能跑命令的身份还有 **「用工作树」**（Use a worktree）（只管这台设备） |
| **「对话」**（Chat） | **「输入建议」**（Prompt suggestions）、**「对话内交互图表」**（Inline visualizations）、**「动态工作流」**（Dynamic workflows）（关了用不了 Ultracode）、**「子 agent 调用策略」**（Subagent dispatch policy）（行尾是总开关，点进去管生效范围、几套策略、四档用哪个模型、「调用非 Claude 模型」和口述备注，见 02-claude-code.md）、**「思考动画」**（Thinking animation）（这台设备：**「新版 Claude Code」**（Claude Code (new)）、**「新版聊天页」**（Chat (new)）、**「经典星标」**（Classic spark）三选一）、**「消息被拦时自动换模型」**（Switch models when a message is flagged）、**「批准计划时可清空上下文」**（Offer to clear context when approving a plan）、**「Claude 提问无人回答时」**（When Claude’s question goes unanswered）（一直等 / 5 / 10（默认）/ 30 分钟后继续）、**「回复语言」**（Response language）（跟随对话 / 简体中文 / English）；在用量弹层里拖过自动压缩点的，这里多一行 **「自动压缩点」**（Auto-compact point）可以恢复默认 |
| **「会话协作」**（Session collaboration） | **「Claude 发起新会话」**（New sessions started by Claude）：先问我（默认）/ 直接开始 / 只在我要求时（能跑命令的身份才有）；管理员还有 **「其它会话发来的消息」**（Messages from other sessions） |
| **「项目对话」**（Project conversation）——管理员和完全信任账号 | **「开讨论串前先问我」**（Ask before starting a thread），默认关；**「同时在跑的讨论串」**（Threads running at once），默认 4 条；**「每天最多新开讨论串」**（New threads per day），默认 100 条（所有项目合计）；**「讨论串模型」**、**「讨论串推理强度」**——默认跟协调者同一个模型、强度「高」；单个项目可以在项目概览里另选。项目对话怎么用见 02-claude-code.md「项目对话」 |
| **「Git 与拉取请求」**（Git and pull requests）——能跑命令的身份 | **「分支前缀」**（Branch prefix）（默认 claude）、**「工作树起点」**（Worktree base）（当前分支 / 远端默认分支）、**「自动修复拉取请求」**（Auto-fix pull requests）、**「拉取请求合并或关闭后自动归档」**（Auto-archive after PR merge or close）、**「提交与拉取请求署名」**（Commit and PR attribution）。需要 VM 上 gh 已登录，见 02-claude-code.md「拉取请求」 |
| **「会话管理」**（Session management） | **「归档不活跃的会话」**（Archive inactive sessions）：从不（默认）/ 1 / 2 / 7 / 14 / 30 天 |
| **「通知」**（Notifications）（这台设备） | **「权限请求」**（Permission requests）、**「提问」**（Questions）、**「任务完成」**（Task complete）、**「任务出错」**（Task errors）四项，默认都开，**只管这台设备**；总开关、提醒哪几类、横幅、声音在「通用 → 通知」里（见下面「通用」） |
| **「扩展与记忆」**（Extensions and memory） | 管理员：**「技能」**、**「连接器」**、**「插件」**——打开「扩展」页的对应标签，见 05-customize.md——、**「定时任务」**（Routines）；注册账号只有 **「技能」**——他自己的技能，见 05-customize.md「成员自己的技能」——和 **「定时任务」** |
| **「安全」**（Security）——只有管理员 | **「允许绕过权限模式」**（Allow bypass permissions mode）（默认关）、**「允许自动模式」**（Allow auto mode）（默认开），对这台服务器上所有人生效。打开绕过权限前会再确认一次 |
| **「调试」**（Debug）——只有管理员 | **「调试模式」**（Debug mode），默认关：给想帮忙改进这个软件的人用，见 02-claude-code.md「调试模式」 |

- 灰着的选项后面写着「在下方『安全』里开启」：先去「安全」打开对应开关。
- 提示「这一项你改不了」= 你的身份没有这一项（管理员项）；「这个版本的服务端还不认这一项」= 服务端比页面旧，先更新。
- 这台 Muse 上不显示「这台电脑」里的保持唤醒设置；「思考动画」已包含完整的三套样式。
- **「自定义 API」这一行没有了**：给 Claude 接别家模型现在在 **「设置 → 模型中心」**，老的自定义 API 升级时已自动并过去（见下面「模型中心」）。
- 号池里逐号的「重置卡」在这台 Muse 上没有（公开版不带这项），号的详情页里看不到它是正常的。

## 模型中心

**「设置 → 模型中心」**（Settings → Model Hub）——「Agent」分组里排在各个 agent 之后的那一行：Claude、dimensio、Media Studio 用的模型服务（接口地址 + API Key）都在这里加，一个服务加一次，再按模型决定给谁用。以前「设置 → Claude」里的「自定义 API」、dimensio 自己的模型服务和厂商 Key、Media Studio 的媒体服务，升级后第一次启动都自动并了进来，老对话照常能接着聊。

- 管理员看到整台服务器的总览：添加服务、识别模型、勾给哪个 agent、多把 Key、测试、**「共享给成员」**（Share with members）、Vertex AI（Google 云凭据）。成员只有自己的 **「我的服务」**（My providers）和 **「管理员共享给你的服务」**（Providers shared with you by the admin）。
- **在 Muse 上要先放行网站**：加服务之前让 Muse 跑 `allow-sites <接口地址>`，用户在 Muse 里批这个地址的审核卡（选项见 `../MUSE.md` 2.0）；没放行的话识别模型、测试和对话都会一直等到超时。服务上的「走出站代理」开关要保持打开。
- 逐项说明、报错对照、迁移细节见 10-model-hub.md。

## dimensio

- **「设置 → dimensio」**——「Agent」分组里的 dimensio 一行；dimensio 页侧栏最底下的「设置」打开的也是这一页。管理员看到全部（页头有「启用 dimensio」开关）；被授权用 dimensio 的成员也有这一页，只出他自己能改的。
- 里面按分组排：模型（新对话默认的型号和思考深度）、模型服务（管理员这里只有一行「模型中心」）/ API Key（成员自己的 key）、权限与安全、工作空间、记忆、对话、子 agent 调度、会话协作、工作区协同、Git 与拉取请求、会话管理、通知、调试、诊断。逐项见 03-dimensio.md「dimensio 的设置」。

## Media Studio

- **「设置 → Media Studio」**（Settings → Media Studio）——打开了 Media Studio 时「Agent」分组里多出的那一行，Media Studio 页右上角的齿轮打开的也是这里。
- 管理员：页头的「启用 Media Studio」开关、媒体服务（跳到模型中心、Google 云凭据）、四种媒体各自的默认模型、作品存进工作空间的位置，以及「高级」里哪些 agent 能生成、能生成哪几种、视频最高分辨率、内容安全过滤。成员：自己的默认模型和存储，以及自己接的媒体服务。
- 逐项见 09-media-studio.md「设置 → Media Studio」。

## Agent 接入

**「设置 → Agent 接入」**（Settings → Agent access）：让别的 agent（比如部署它的 Muse、Claude Code、脚本）经 HTTP 直接调用这台 Muse Bridge——读项目手册、给 Claude 派活、管文件和定时任务、看谁在跑——不用开浏览器模拟点击。**所有登录的人都能给自己生成**，每个人只管自己的密钥。

- **「地址」**：**「Agent 入口」**（Agent endpoint）（路径是 `/agent`）和 **「项目手册」**（Project handbook）（`/agent/manual`），各有复制 / 打开按钮。
- **「生成密钥」**（Create key）：给每个 agent 单独起个名字（比如「我的 Muse」），点 **「生成」**（Generate）。新密钥**只显示这一次**：点 **「复制给 agent 的说明」**（Copy instructions for the agent）把带地址的说明整段交给 agent，或 **「复制密钥」**（Copy key）；点 **「我已保存好」**（I’ve saved it）之后就再也看不到了，丢了就吊销再生成。
- **「密钥」**（Keys）列表：每把显示创建时间、最近使用、到期日；**「吊销」**（Revoke）→ **「确认吊销」**（Confirm revoke）后用这把密钥的 agent 立刻失去访问。
- 密钥**等同你的登录**：只带生成它那个人的权限（管理员的密钥能做管理员能做的，成员的只能动自己的东西）；**90 天后过期**。
- **改密码 / 重置访问令牌会让全部密钥立即失效**（成员改密码，管理员重置访问令牌）。
- 给 Muse 用：用户生成后把密钥交给 Muse，Muse 怎么用见 `../MUSE.md` 4.8。别把密钥发在公开的地方。

## 安卓 App

设置根页 **「插件」**（Plugins）分组里的 **「安卓 App」** 一行（英文界面下这一行也写中文，页面里面是英文）。内容看在哪儿打开：

- **在新 App 里**（就是 bridge 的安卓 App）：**「这台手机」**（This phone）一组——**「你正在用安卓 App」**（You are using the Android app）和服务器的版本号，说明 App 跟着这台服务器的版本更新：服务器升级后，设置根页的 **「软件更新」** 会提示新版本。换地址不在这一页，在「设置 › 关于 › 服务器地址」（**「更换服务器地址」**）。
- **在旧版 Muse App 里**（已停止更新）：**「这台手机」**一组里写着 **「旧版 App 已停止更新」**，下面是 **「下载新版 App」** → **「下载」**。
- **在手机浏览器里**：**「下载 apk」**（Download the apk）→ **「下载」**（Download）；**「GitHub 发布页」**（GitHub releases）→ **「打开」**（Open）。
- **在电脑上**：同样有下载和 GitHub 发布页，另外显示一个二维码，手机扫了直接下载。
- 底下一段说明：App 把界面装在手机里，网速慢也能秒开，图标上写的是 The Bridge、进去后显示 Muse Bridge；没有 iPhone App，在 Safari 里「添加到主屏幕」。详见 01-access.md。

## 扩展、额度与注册、服务端控制台（管理员）

- **「扩展」**（Extensions）：技能、连接器、插件、功能扩展，见 05-customize.md。
- **「额度与注册」**（Quotas & sign-ups）：多人用时才有。**「凭邀请码注册」**（Invite-code sign-ups）开关和 **「注册用户的默认额度」**（Default quotas for registered users），行尾写着 **「开放注册」**（Open）或 **「注册已关」**（Closed）。更多选项在控制台的同名页，见 06-users-admin.md。
- **「服务端控制台」**（Admin console）：点了打开控制台，见 06-users-admin.md。

## 通用

| 设置 | 选项 | 默认 | 说明 |
|---|---|---|---|
| **「通知」**（Notifications） | 点进去一页 | 开 | 见下面「通知」 |
| **「语言」**（Language） | 简体中文 / English | 跟浏览器语言 | 改了页面会重新加载；dimensio 用同一个设置 |
| **「原图加载」**（Load full-resolution images） | 开 / 关 | 关 | 开了看图直接加载原图（最清楚但费流量）；关着时先看轻量图，放大再换原图 |

### 通知

**「设置 → 通用 → 通知」**（Settings → General → Notifications）：会话消息通知——**每个会话单独一条**，标题就是会话名；正看着的那个会话不提醒。Claude 和 dimensio 的会话都算。

- **「接收通知」**（Allow notifications）：总开关，默认开。
- **「提醒哪些事」**（Notify me about）：**「在等你回答」**（Waiting for your answer）、**「需要你批准」**（Needs your approval）、**「完成」**（Done）、**「出错」**（Failed）。
- **「提醒方式」**（Alerts）：**「横幅」**（Banners）——页面开着、在看别处时滑出一张横幅；**「显示内容详情」**（Show previews）——关掉后通知只写「你有一条新消息」；**「声音」**（Sound）和 **「提示音」**（Notification sound），手机上还有 **「振动」**（Vibration）。
- **网页里**：页面在后台时靠浏览器的系统通知，要先点 **「允许浏览器通知」**（Allow browser notifications）并在浏览器的弹窗里允许；写着「已被拒绝」时，到地址栏左边的网站设置里把通知改回允许。
- **安卓 App 里**：通知进手机通知栏；**「后台保持接收」**（Stay connected in background）打开后，没有会话在跑时也常驻一条不响的通知，电脑上或定时任务发起的会话有动静也能马上提醒（多耗一点电）。
- **「发一条测试通知」**（Send a test notification）：试一下能不能收到。
- Claude 那边每一类还能在「设置 → Claude → 通知」里单独关（只管这台设备）；dimensio 那边在「设置 → dimensio」的「通知」里。

## 外观

- **「明亮」**（Light）/ **「深色」**（Dark）两张卡片选一张，默认深色；手动选了就不再跟随系统。
- **「跟随系统明暗」**（Match system appearance）：跟着手机 / 电脑的深浅色自动换。
- **「禁用系统转场动画」**（Turn off transitions）：关掉页面切换的动画。
- 明暗是**全站统一**的：主页、Claude 页、dimensio 页、Media Studio、设置一起变（以前的「分页跟随主页明暗」和 dimensio 单独的明暗设置都没有了）。在 Claude 页单击星标、在 dimensio 页点月桥标志也能切，见 01-access.md「语言和主题」。

## 壁纸、流体壁纸

这一版的网页与安卓 App 都包含完整玻璃材质、三套思考动画、动态字符背景、Ultracode 能量效果和原版字体。支持 WebGPU 的设备使用主页与桌面 Dock 的实时玻璃；设备能力不足或系统减少动态效果时仍会正常回退。明亮壁纸包含多洛米蒂照片及对应空间视差；深色主页被页面盖住时暂停玻璃和流光，返回主页再恢复。手机 App 须更新到本次随服务器提供的版本，旧离线 App 不会仅靠网页更新换掉自身前端。

- **「壁纸」**（Wallpaper）：主页的背景，**「明亮主题壁纸」**（Light theme wallpapers）和 **「深色主题壁纸」**（Dark theme wallpapers）各选一张，也可以 **「相册上传」**（Upload photo）自己的图（长按自己上传的可以删）。点上面的两张预览图能进实景预览。只有有主页时才有这一行。
- **「流体壁纸」**（Fluid wallpaper）：主页用深色流体壁纸时出现，调颜色、画面和模拟参数，底部可以恢复默认。

## 设备

**「设置 → 设备」**：把装了 bridge **Windows 桌面客户端**的电脑登记成设备，让 Claude 能看那台电脑的屏幕、操作它（要那台电脑自己允许）。登录的人都能管自己的设备。

- 前提：用户在电脑上装 bridge 的桌面客户端、连这台服务器并用同一个账号登录。**只有绑了自己域名（固定地址）时客户端才会登记设备**；用临时地址时客户端只当网页窗口用，这里一直是空的。
- **「我的设备」**（My devices）：登记过的电脑和在线状态；点进去可以改名、断开、吊销（吊销后那台电脑要重新登录才能再连）。
- **「端口转发」**（Port forwarding）：把电脑上的本机端口（比如开发服务器）接到服务器上，手机也能打开、Claude 也能用；**「新的转发…」**（New forward…）选电脑、填端口 → **「接通」**（Connect）。持有地址的人都能访问，不用了就删掉。
- 在桌面客户端里打开这一页，最上面还有 **「这台电脑」**（This computer）：**「关闭」** / **「只看」**（View only）/ **「操作」**（Control），决定 Claude 能不能动这台电脑；档位由那台电脑自己把关，服务器改不了。
- 管理员能在控制台的「设备」页看到所有人的设备；成员允许了「看他的电脑」，管理员才能看他那台的屏幕。

## 提交反馈

**「提交反馈」**（Send feedback）：弹出一张表单，写下遇到的问题、想要的功能（**「写下你的反馈…」**（Write your feedback…）），可以 **「添加图片或视频」**（Add image or video），点 **「提交」**（Submit）。桌面客户端里是左栏的 **「反馈」** 分区。

- **每条反馈都先存在这台服务器上**：VM 的 `/home/hatch/bridge-srv/feedback/reports/` 里，每条一个文件，Muse 可以直接读（推送没开时，管理员打开表单会在下面看到这个位置）。
- **要不要同时发给开发者，看两道开关**，缺一道就只留在服务器上（提交后显示 **「已记下，服务器管理员会看到。」**（Saved. The server admin will see it.））：
  1. 管理员在表单底部打开「把用户反馈同时发给 Muse Bridge 项目的公开 GitHub Issue」（Share user feedback with the public Muse Bridge GitHub issues）。默认关，只有管理员看得到；说明里写着「这个去向是公开的…请提醒大家别写隐私、账号和密钥」。关掉时还没发出去的会一并取消。
  2. 打开之后，每个人提交时表单里多一行「这条也发给 Muse Bridge 项目的公开 GitHub Issue」（Also send this to the public Muse Bridge GitHub issues），默认不勾，每一条都要自己勾了才发。下面的小字写明发什么、**这是公开发布、任何人都能看到**，以及图片不会公开发布（只记张数）、视频不发。
- 两道都开了：提交后显示「已记下，也会转给 Muse Bridge 项目的公开 GitHub Issue。」，这条反馈经 Muse Bridge 的反馈服务提交成 **Muse Bridge 在 GitHub 上的公开 Issue**——谁都能看到。发出前去掉账号名和服务器地址，再把令牌、邮箱、网址、路径、IP 打码；图片只在 Issue 里记个数，图片本身留在服务器上。所以别在文字里写隐私。发不出去（网络、审核卡没批）会自动补发。
- （这几行界面文字是「…发给 {去向}」的模板，去向由这台 Muse 的部署声明填进去；bridge 本体上那里写的是「bridge 开发者」。）
- 出错时自动上报（服务崩溃、更新失败这类）是另一回事：没有网页上的开关，装的时候问过用户，之后让 Muse 用 `feedback-auto on` / `feedback-auto off` 改。它和上面的两道开关互不影响。

### 让 Claude 看看是不是 bug（「问 Claude」）

- 界面上弹出红字报错时，提示条右边有 **「问 Claude」**（Ask Claude）：点一下会开一个新的 Claude 对话，把报错和出错的界面填进输入框，补一句就能发。Claude 页对你开着才有这个按钮。
- 也可以直接在 Claude 对话里说「是不是出 bug 了」。Claude 先看现场：版本、服务已运行多久、上报会发到哪。**只有管理员身份它才看得到服务器最近的报错日志和崩溃记录**；成员看不到服务端日志（里面有别人的活动），Claude 就靠你的描述、截图和它自己复现。
- 是操作或配置问题，它直接帮你解决，不上报。认定是 bug 时，它会先跟你说清要报什么（标题、现象、复现步骤、相关的几行日志）、发到哪，**你同意了才上报**。去向跟上面的表单一样：服务器上的反馈库总存一份（标着「经 Claude 诊断后上报」）；管理员开着上面那个推送开关、你也同意发出去时，才提交成 Muse Bridge 的公开 GitHub Issue——Claude 跟你确认时会说明这是公开的、别写隐私、截图不公开。你是管理员而开关关着时，Claude 会问你要不要顺手打开它。
- **dimensio 也能做同样的事**：在 dimensio 里说「是不是出 bug 了」，它会查 bridge 的项目手册、看现场（同样只有管理员看得到服务端日志），确认是 bug 后跟你说清内容和去向再上报，去向和 Claude 一样。上报这一步每次都会弹一张审批卡，你点允许才发。dimensio 还能用同一套接口查手册回答「怎么用」、替你操作 bridge（找会话、建定时任务、带你去某一页之类），删除这类危险操作同样每次弹审批卡。这些工具跟设备通道走：在「设置 → 扩展 → 功能扩展」里把「设备」关掉的话，dimensio 就没有它们了（Muse 装好时是开着的）。
- 也可以直接跟 Muse 说「报告一个 bridge 的问题」：Muse 先判断是不是已知问题 / 配置问题，再出草稿给你看，你同意才发（`../MUSE.md` 第 8 节）。Muse 的报告只带版本、服务状态和程序自己的报错，不含对话、文件、key 和地址，不用 GitHub 账号。三条路最后都到同一个 GitHub 仓库，同一件事报一次就够。

## 关于

- 页头是应用图标和版本号。这里的版本号是 bridge 本体的版本；Muse Bridge 自己的版本看 Muse 结果块里的「运行版本」，或让 Muse 跑 `status`。
- **「服务器地址」**（Server URL）：这个网页连的是哪台服务器。在网页里别改它；在安卓 App 里点这一行会弹出 **「更换服务器地址」**，临时地址变了、App 没自动跟上时在这里填新地址。
- **「让另一台设备扫码连接」**（Let another device scan to connect）→ **「显示二维码」**（Show QR code）：给自己的另一台手机扫，扫到的会以你的身份登录（3 分钟内有效、只能用一次）。
- **「服务器」**（Server）一组（登录后才有）：**「公网地址」**（Public URL）（点一下复制）、**「地址类型」**（Address type）：临时地址（重启会换）/ 固定地址、**「后端」**（Backend）已运行多久。
- **「下载 App」**（Download the apps）一组（网页里、登录后才有）：**「Windows 桌面客户端」**（Windows desktop app）和 **「安卓 App」**（Android app）两行，带版本和大小，点 **「下载」**（Download）就开始下。版本和这台服务器对齐；Windows 客户端的安装包放在 GitHub 上，点了会转到 GitHub 下载。服务器上暂时没有可发的版本时，这一行写 **「这台服务器没有可发的版本」**，有发布页就显示 **「去发布页」**（Release page）。
- **「网页版总是最新的」**（The web app is always up to date）：界面由服务器直接提供，刷新页面就是服务器上的版本。**「版本历史」**（Version history）列出服务器上发过的版本和说明。
