# 设置逐项说明

## 怎么打开

- 侧栏最底下的账户卡 → **「设置」**（Settings）；主页右上账户胶囊里也有 **「设置」**。
- 网页和手机上，设置是一个整页的列表（像手机的「设置」App）：根页按分组列出各项，点一行从右边推入它的子页；左上角返回，手机上也可以从左边缘往右滑、按返回键，电脑上按 Esc。在根页再返回就关掉设置。网页版设置里没有搜索。
- **dimensio 的设置不在这里**：在 dimensio 页侧栏最底下的「设置」里（见 03-dimensio.md）。这里的 dimensio 那一页只有管理员的启用开关。
- Windows 桌面客户端里的设置长得不一样：左栏最上面是 **「搜索」**（Search）和账户，下面一列分区——**「通用」**、**「外观」**、**「快捷键」**（Keyboard shortcuts）；Claude、dimensio、**「Agent 接入」**；**「扩展」**、**「额度与注册」**、**「设备」**、**「壁纸」**；**「安卓 App」**；**「连接与更新」**（Connection & updates）、**「反馈」**（Feedback）。各分区的内容和下面网页版对应的那一页一样；网页版「关于」里的服务器地址、公网地址在客户端的「连接与更新」里。
- 存在哪：「通用」「外观」「壁纸」**只存在当前这个浏览器 / 设备里**，换设备要重新设；「Claude」那一页的设置（除了标着 **「这台设备」**（This device）的几项）**存在服务端**，按账号保存、各设备一致。

## 根页一览

从上到下：

| 分组 | 行 | 谁能看到 |
|---|---|---|
| （最上面） | 账户卡：名字和身份，点进去是「账户」；没登录时写「登录」 | 所有人 |
| **「Agent」**（Agents） | Claude、dimensio，每个 agent 一行、各自一页 | 管理员看到所有开着的 agent；成员只有 Claude |
| 同上 | **「Agent 接入」**（Agent access） | 登录的人 |
| **「插件」**（Plugins） | **「安卓 App」**——英文界面下也写这几个中文字 | 登录的人 |
| **「服务器」**（Server） | **「扩展」**（Extensions）、**「额度与注册」**（Quotas & sign-ups）（多人用时才有）、**「服务端控制台」**（Admin console） | 只有管理员 |
| **「偏好」**（Preference） | **「通用」**（General）、**「外观」**（Appearance）、**「壁纸」**（Wallpaper）、**「流体壁纸」**（Fluid wallpaper） | 所有人；壁纸只在有主页（两个 agent 都开着）时有，流体壁纸只在主页用深色流体壁纸时有 |
| （不带标题） | **「设备」** | 登录的人 |
| （不带标题） | **「提交反馈」**（Send feedback）、**「关于」**（About） | 所有人 |

- 这台 Muse 上没有的：**「这台设备」** 分组和里面的 **「手机操控」**——Muse 关掉了手机操控；「软件更新」那一行只在 bridge 自己的安卓 App 里出现，Muse 的安卓 App 和网页里都没有（网页总是最新的）。

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
- **「切换账号」**（Switch Account）、**「退出登录」**（Sign out）：只影响这台设备。

## Claude

**「设置 → Claude」**（Settings → Claude）——「Agent」分组里的 Claude 那一行：给 Claude 页的行为设置，**存在服务端、按账号保存**，对新会话生效，各设备一致。改过默认值的项旁边有个小点；单选项点进去改，改过的底部有 **「恢复默认」**（Reset to defaults）。从上到下：

| 分组 / 行 | 里面有什么 |
|---|---|
| 页头 | 「启用 Claude」 开关（只有管理员能改）；还没配认证时提示「在下面『订阅号池』里添加账号」 |
| **「订阅号池」**（Subscription Pool）——只有管理员 | 服务器上的 Claude 订阅账号，每个号的 5 小时 / 每周用量，**「添加账号」**（Add Account）；点一个号进去能切换、编辑、调顺序、删除。见 06-users-admin.md「Claude 账号」 |
| **「模型服务」**（Provider）→ **「自定义 API」**（Custom API） | 给 Claude 页接别家的模型，见下面「自定义 API」 |
| **「撞上限额时」**（When you hit a usage limit） | **「限额重置后自动继续」**（Auto-continue when limits reset）：撞上 5 小时限额后，额度恢复时自动接着跑完这一轮，默认开；管理员还有 **「额度用尽自动换号」**（Switch accounts when a limit is reached） |
| **「服务意外重启时」**（If the service restarts unexpectedly） | **「自动继续被中断的对话」**（Resume interrupted conversations）：服务中途崩溃、被结束或 VM 重启打断了正在跑的对话时，服务恢复后约 15 秒自动让 Claude 从中断的地方接着做，默认开，按账号各自设置。同一件事最多连着续 3 次；中断超过 12 小时、或你已经先发了消息就不续。关掉后只留一句「这一轮没跑完」，要你自己说「继续」（见 02-claude-code.md「Claude 在干活的时候」） |
| **「新会话默认」**（New session defaults） | **「权限模式」**（Permission mode）（管理员默认「自动」，其他人默认「接受编辑」）、**「输出风格」**（Output style）；能跑命令的身份还有 **「用工作树」**（Use a worktree）（只管这台设备） |
| **「对话」**（Chat） | **「输入建议」**（Prompt suggestions）、**「对话内交互图表」**（Inline visualizations）、**「动态工作流」**（Dynamic workflows）（关了用不了 Ultracode）和 **「子 agent 调度偏好」**（Subagent dispatch preferences）、**「消息被拦时自动换模型」**（Switch models when a message is flagged）、**「批准计划时可清空上下文」**（Offer to clear context when approving a plan）、**「Claude 提问无人回答时」**（When Claude’s question goes unanswered）（一直等 / 5 / 10（默认）/ 30 分钟后继续）、**「回复语言」**（Response language）（跟随对话 / 简体中文 / English）；在用量弹层里拖过自动压缩点的，这里多一行 **「自动压缩点」**（Auto-compact point）可以恢复默认 |
| **「会话协作」**（Session collaboration） | **「Claude 发起新会话」**（New sessions started by Claude）：先问我（默认）/ 直接开始 / 只在我要求时（能跑命令的身份才有）；管理员还有 **「其它会话发来的消息」**（Messages from other sessions） |
| **「Git 与拉取请求」**（Git and pull requests）——能跑命令的身份 | **「分支前缀」**（Branch prefix）（默认 claude）、**「工作树起点」**（Worktree base）（当前分支 / 远端默认分支）、**「自动修复拉取请求」**（Auto-fix pull requests）、**「拉取请求合并或关闭后自动归档」**（Auto-archive after PR merge or close）、**「提交与拉取请求署名」**（Commit and PR attribution）。需要 VM 上 gh 已登录，见 02-claude-code.md「拉取请求」 |
| **「会话管理」**（Session management） | **「归档不活跃的会话」**（Archive inactive sessions）：从不（默认）/ 1 / 2 / 7 / 14 / 30 天 |
| **「通知」**（Notifications）（这台设备） | **「权限请求」**（Permission requests）、**「提问」**（Questions）、**「任务完成」**（Task complete）三项，**只管这台设备**；总开关在「通用」里，关着时这里写「通知总开关在『通用』里关着」 |
| **「扩展与记忆」**（Extensions and memory）——只有管理员 | **「技能」**、**「连接器」**、**「插件」**——打开「扩展」页的对应标签，见 05-customize.md——、**「定时任务」**（Routines） |
| **「安全」**（Security）——只有管理员 | **「允许绕过权限模式」**（Allow bypass permissions mode）（默认关）、**「允许自动模式」**（Allow auto mode）（默认开），对这台服务器上所有人生效。打开绕过权限前会再确认一次 |

- 灰着的选项后面写着「在下方『安全』里开启」：先去「安全」打开对应开关。
- 提示「这一项你改不了」= 你的身份没有这一项（管理员项）；「这个版本的服务端还不认这一项」= 服务端比页面旧，先更新。
- 这台 Muse 上看不到的：「这台电脑」（保持唤醒，Muse 关掉了）、「思考动画」（这一版只有一种样式）。

### 自定义 API（给 Claude 页接别家模型）

**「设置 → Claude → 自定义 API」**（Settings → Claude → Custom API）：给 **Claude 页**接别家的模型，和 dimensio 里的「模型服务」不是一回事。管理员和每个注册账号各有自己的一份，互相看不到；成员的只能连公网地址、最多 10 个。

- 点进去是一个整页面板 **「Claude · 自定义 API」**，**「添加服务」**：从常用厂商预设开始（DeepSeek、Kimi、OpenRouter 等，预设只填好地址和协议），或 **「从头配置」** 接任意兼容端点。
- 填 **「接口地址」**（Base URL）、**「接口协议」**（API protocol）——OpenAI 兼容端点由 Muse Bridge 把 Claude Code 的请求整体翻译过去；兼容 Anthropic Messages 的端点则原样转发——再填 API Key（加密存在服务器上，不回传浏览器），点 **「从服务拉取」** 拿模型列表，选要用的，保存。也可以 **「手动添加」** 模型 ID。**「检测连接」**（Check connection）能试出地址和协议对不对。
- 编辑器里还能设 **「调用参数」**、兼容选项（第三方端点不认 Claude Code 的一些字段时调这里）、超时与重试，以及 **「测试与日志」**。这台 Muse 上请求一律经 Muse 的出站代理，编辑器里没有代理开关。
- 加好的模型出现在 Claude 页模型菜单的「More models」里，按服务分组；每个服务可以单独停用、从菜单里隐藏。
- **在 Muse 上要先放行这个网站**：加之前让 Muse 跑 `allow-sites <接口地址>`，提醒用户把审核卡选成「总是允许此站点」，不然请求会超时（`../MUSE.md` 第 6 节）。

## dimensio

- **「设置 → dimensio」**——「Agent」分组里，只有管理员看得到：只有 「启用 dimensio」 开关和认证状态（一家 key 都没配时有提示）。
- dimensio 自己的设置（API Key、记忆、权限规则、工作空间、访问范围、外观、显示全部工作过程、诊断）在 dimensio 页侧栏最底下的「设置」里，见 03-dimensio.md「dimensio 的设置面板」。

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

- **在 App 里**：**「这台手机」**（This phone）一组——**「安卓 App」**（Android app）的版本号；**「服务器地址」**（Server address）→ **「更换」**（Change）换地址（临时地址变了、或想连另一台 Muse）；服务器上有更新的 App 时出现 **「App 有新版本」**（App update available）和 **「下载」**（Download）。
- **在手机浏览器里**：**「下载 apk」**（Download the apk）→ **「下载」**；安卓手机上还有 **「在 App 里打开」**（Open in the app）→ **「打开」**（Open）（装好后点它，App 自动填好现在这个地址）；**「GitHub 发布页」**（GitHub releases）→ 打开。
- **在电脑上**：同样有下载和 GitHub 发布页，另外显示一个二维码，手机扫了直接下载。
- 底下一段说明：App 只是把网页装进独立窗口，界面随服务器更新；没有 iPhone App，在 Safari 里「添加到主屏幕」。详见 01-access.md。

## 扩展、额度与注册、服务端控制台（管理员）

- **「扩展」**（Extensions）：技能、连接器、插件、功能扩展，见 05-customize.md。
- **「额度与注册」**（Quotas & sign-ups）：多人用时才有。**「凭邀请码注册」**（Invite-code sign-ups）开关和 **「注册用户的默认额度」**（Default quotas for registered users），行尾写着 **「开放注册」**（Open）或 **「注册已关」**（Closed）。更多选项在控制台的同名页，见 06-users-admin.md。
- **「服务端控制台」**（Admin console）：点了打开控制台，见 06-users-admin.md。

## 通用

| 设置 | 选项 | 默认 | 说明 |
|---|---|---|---|
| **「通知」**（Notifications） | 开 / 关 | 开 | 总开关：Claude 一轮跑完、等你批准、等你回答时提醒（正开着页面、正看着这个对话时不打扰）。每一类在「Claude → 通知」里单独开关。**网页不会主动向浏览器要通知权限**：收不到就到浏览器的网站设置里，把这个网址的通知改成允许 |
| **「语言」**（Language） | 简体中文 / English | 跟浏览器语言 | 改了页面会重新加载；dimensio 用同一个设置 |
| **「原图加载」**（Load full-resolution images） | 开 / 关 | 关 | 开了看图直接加载原图（最清楚但费流量）；关着时先看轻量图，放大再换原图 |

dimensio 也会在等你批准、等你回答、交了计划、跑完时通知。

## 外观

- **「明亮」**（Light）/ **「深色」**（Dark）两张卡片选一张，默认深色；手动选了就不再跟随系统。
- **「跟随系统明暗」**（Match system appearance）：跟着手机 / 电脑的深浅色自动换。
- **「分页跟随主页明暗」**（Pages match Home appearance）：有主页时才有，Claude 页等跟着主页的明暗走。
- **「禁用系统转场动画」**（Turn off transitions）：关掉页面切换的动画。
- 只管网页本身（主页、Claude 页、设置）；dimensio 页的明暗在 dimensio 自己的设置里。

## 壁纸、流体壁纸

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
  1. 管理员在表单底部打开 **「把用户反馈同时发给 bridge 开发者」**（Share user feedback with the Bridge developer）。默认关，只有管理员看得到；关掉时还没发出去的会一并取消。
  2. 打开之后，每个人提交时表单里多一行 **「这条也发给 bridge 开发者」**（Also send this to the Bridge developer），默认不勾，每一条都要自己勾了才发。
- 两道都开了：提交后显示 **「已记下，也会转给 bridge 开发者。」**（Saved. It will also be sent to the Bridge developer.）。**在 Muse 上，「bridge 开发者」指的是 Muse Bridge 的维护者**：这条反馈经 Muse Bridge 的反馈服务提交成 **Muse Bridge 在 GitHub 上的公开 Issue**——谁都能看到。发出前去掉账号名和服务器地址，再把令牌、邮箱、网址、路径、IP 打码；**图片和视频不会公开**（表单上写着图片会原样发出，在 Muse 上只在 Issue 里记个数，图片本身留在服务器上）。所以别在文字里写隐私。发不出去（网络、审核卡没批）会自动补发。
- 出错时自动上报（服务崩溃、更新失败这类）是另一回事：没有网页上的开关，装的时候问过用户，之后让 Muse 用 `feedback-auto on` / `feedback-auto off` 改。它和上面的两道开关互不影响。

### 让 Claude 看看是不是 bug（「问 Claude」）

- 界面上弹出红字报错时，提示条右边有 **「问 Claude」**（Ask Claude）：点一下会开一个新的 Claude 对话，把报错和出错的界面填进输入框，补一句就能发。Claude 页对你开着才有这个按钮。
- 也可以直接在 Claude 对话里说「是不是出 bug 了」。Claude 先看现场：版本、服务已运行多久、上报会发到哪。**只有管理员身份它才看得到服务器最近的报错日志和崩溃记录**；成员看不到服务端日志（里面有别人的活动），Claude 就靠你的描述、截图和它自己复现。
- 是操作或配置问题，它直接帮你解决，不上报。认定是 bug 时，它会先跟你说清要报什么（标题、现象、复现步骤、相关的几行日志）、发到哪，**你同意了才上报**。去向跟上面的表单一样：服务器上的反馈库总存一份（标着「经 Claude 诊断后上报」）；管理员开着「把用户反馈同时发给 bridge 开发者」、你也同意发出去时，才提交成 Muse Bridge 的公开 GitHub Issue。你是管理员而开关关着时，Claude 会问你要不要顺手打开它。
- dimensio 也能帮你看是不是 bug，经同样的流程上报。
- 也可以直接跟 Muse 说「报告一个 bridge 的问题」：Muse 先判断是不是已知问题 / 配置问题，再出草稿给你看，你同意才发（`../MUSE.md` 第 8 节）。Muse 的报告只带版本、服务状态和程序自己的报错，不含对话、文件、key 和地址，不用 GitHub 账号。三条路最后都到同一个 GitHub 仓库，同一件事报一次就够。

## 关于

- 页头是应用图标和版本号。这里的版本号是 bridge 本体的版本；Muse Bridge 自己的版本看 Muse 结果块里的「运行版本」，或让 Muse 跑 `status`。
- **「服务器地址」**（Server URL）：这个网页连的是哪台服务器。在 Muse 的网页和安卓 App 里都别改它——换 App 的地址用「安卓 App」那一页的「更换」。
- **「让另一台设备扫码连接」**（Let another device scan to connect）→ **「显示二维码」**（Show QR code）：给自己的另一台手机扫，扫到的会以你的身份登录（3 分钟内有效、只能用一次）。
- **「服务器」**（Server）一组（登录后才有）：**「公网地址」**（Public URL）（点一下复制）、**「地址类型」**（Address type）：临时地址（重启会换）/ 固定地址、**「后端」**（Backend）已运行多久。
- **「网页版总是最新的」**（The web app is always up to date）：界面由服务器直接提供，刷新页面就是服务器上的版本。**「版本历史」**（Version history）列出服务器上发过的版本和说明。
