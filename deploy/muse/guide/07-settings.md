# 设置逐项说明

## 怎么打开

- 侧栏最底下的账户卡 → **「设置」**（Settings）；主页右上账户胶囊里也有 **「设置」**。dimensio 侧栏底部的设置会直接打开下面的 dimensio 分区。
- 电脑上是一个居中的对话框：左栏是搜索框和分区列表，右边是内容；按 Esc 或点背景关闭。左上的 **「搜索」**（Search）能按名字或关键词搜设置项（只有电脑上有，界面是英文时用英文搜）。
- 手机上是整页：最上面是账户卡（点进去是「账户」），下面是各分区，点进去从右边滑入，左上角返回。
- 「通用」那一节的设置**只存在当前这个浏览器 / 设备里**，换设备要重新设；「Claude」那一节的设置（除了标明「这台设备」的几项）**存在服务端**，按账号保存、各设备一致。

## 分区一览

| 分区 | 谁能看到 |
|---|---|
| 通用（General） | 所有人 |
| 账户（Account） | 所有人（内容按身份不同） |
| Claude | 能用 Claude 页的人 |
| 模型服务（Model providers） | 只有管理员 |
| Agent（Agents） | 只有管理员 |
| 连接（Connection） | 所有人（控制台入口只有管理员有） |
| dimensio | 能用 dimensio 的人 |
| Agent 接入（Agent access） | 所有登录的人 |
| 安卓 app（Android app） | 所有人 |
| 反馈（Feedback） | 登录了的人 |
| 关于（About） | 所有人 |
| 「自定义」分组：技能 / 连接器 / 插件 | 只有管理员（见 05-customize.md） |

## 通用

| 设置 | 选项 | 默认 | 说明 |
|---|---|---|---|
| **「外观 → 主题」**（Appearance → Theme） | 三个图标：显示器 = 跟随系统、太阳 = 浅色、月亮 = 深色 | 深色 | 只管 Claude 页和主页；dimensio 的明暗在 dimensio 分区单独设 |
| **「语言」**（Language） | 简体中文 / English | 跟浏览器语言 | 改了页面会重新加载 |
| **「通知 → 任务通知」**（Notifications → Task notifications） | 开 / 关 | 开 | 任务跑完时发浏览器通知（正开着页面时不打扰）。**默认开着但浏览器不会自动问权限**：收不到通知就把它关掉再打开一次，浏览器弹出询问时选允许（已知问题） |
| **「对话 → 输入建议」**（Chat → Prompt suggestions） | 开 / 关 | 开 | 每轮回复完，在空输入框里用灰字猜你下一句；电脑按 Tab、手机点「填入」 |
| **「思考动画」**（Thinking animation） | 新版 Claude Code / 新版聊天页 / 经典星标 | 新版 Claude Code | Claude 回复时那个动态标记的样式 |
| **「图片 → 原图加载」**（Images → Load full-resolution images） | 开 / 关 | 关 | 开了看图直接加载原图（最清楚但费流量）；关着时先看轻量图，放大再换原图 |

通知说明：这里是总开关。Claude 页在一轮跑完、等你批准、等你回答时通知（每一类在「Claude」→「通知」里单独开关）；dimensio 在等你批准、等你回答、交了计划、跑完时都会通知。

## 账户

- **「个人资料」**（Profile）：头像字母、用户名、身份（管理员 / Pro 用户 / 普通用户）。
- **「用量」**（Usage）：共享 Claude 订阅的用量——当前 5 小时窗口和本周各用了多少、多久后重置（80% 以上变红）。大家共用这一份。
- **「我的额度」**（Your usage）——只有注册账号有：今天和最近 7 天跑了几轮、花了多少，管理员设了上限时显示「已用 / 上限」。
- **「密码」**（Password）——只有注册账号有：改密码（见 01-access.md）。
- **「工作空间」**（Workspace）：**「文件与分享」**（Files & sharing）→ 打开文件管理器；手机上还有 **「登录网页版」**（Sign in to the web app）→ 扫码帮电脑登录。
- **「管理员可见性」**（Admin visibility）——只有注册账号（成员）看得到，管理员本人没有这块。管理员默认只能看到你的会话标题、时间和用量；下面两个开关由你决定：
  - **「允许查看对话内容」**（Let the admin read my chats）：Claude 对话正文、定时任务的提示词和结果；
  - **「允许代聊与代答」**（Let the admin act for me）：管理员可以在你的空间里代你发消息、替你回答提问和审批（代发的消息开头标着「【管理员代发】」）；接着聊你自己的会话，还要同时允许查看对话内容。
  - 技术上服主仍能读到服务器上的文件，这里约束的是控制台的默认行为。
- **「管理员的访问记录」**（Admin access history）——同样只有成员看得到：管理员每次查看内容、代聊代答都记在这里，同时会弹一句提示。
- **「退出登录」**（Sign out）：只退出这台设备。

## Claude

给 Claude 页的行为设置，**存在服务端、按账号保存**，对新会话生效，各设备一致。改过默认值的项旁边有个小点，可以「恢复默认」。分组从上到下：

| 分组 | 里面有什么 |
|---|---|
| **「撞上限额时」**（When you hit a usage limit） | **「限额重置后自动继续」**（Auto-continue when limits reset）：撞上 5 小时限额后，额度恢复时自动接着跑完这一轮，默认开 |
| **「新会话默认」**（New session defaults） | **「权限模式」**（Permission mode）（管理员默认「自动」，其他人默认「接受编辑」）、**「输出风格」**（Output style）、**「新对话落点」**（Where new chats open）（打开 Claude 页没有对话可接时落在哪：自动 / 临时对话 / 工作空间）；能跑命令的身份还有 **「用工作树」**（Use a worktree）（只管这台设备） |
| **「对话」**（Chat） | **「输入建议」**（Prompt suggestions）、**「对话内交互图表」**（Inline visualizations）、**「动态工作流」**（Dynamic workflows）和子 agent 调度偏好、消息被拦时自动换模型、批准计划时可清空上下文、Claude 提问无人回答时多久后继续（默认 10 分钟）、回复语言、自动压缩点 |
| **「会话协作」**（Session collaboration） | **「Claude 发起新会话」**（New sessions started by Claude）：先问我（默认）/ 直接开始 / 只在我要求时；管理员还有「其它会话发来的消息」怎么处理 |
| **「Git 与拉取请求」**（Git and pull requests） | **「分支前缀」**（Branch prefix）（默认 claude）、工作树起点、**「自动修复拉取请求」**（Auto-fix pull requests）、**「拉取请求合并或关闭后自动归档」**（Auto-archive after PR merge or close）、提交与 PR 是否带 Claude 署名。需要 VM 上 gh 已登录，见 02-claude-code.md「拉取请求」 |
| **「会话管理」**（Session management） | **「归档不活跃的会话」**（Archive inactive sessions）：从不（默认）/ 1 / 2 / 7 / 14 / 30 天；管理员还有「跟随 Claude Desktop 的归档」 |
| **「通知」**（Notifications） | **「权限请求」**（Permission requests）、**「提问」**（Questions）、**「任务完成」**（Task complete）三项，**只管这台设备**；通知总开关在「通用」里 |
| **「安全」**（Security）——只有管理员 | 「允许绕过权限模式」（默认关）、「允许自动模式」（默认开），对这台服务器上所有人生效。打开绕过权限前会再确认一次 |

- 管理员还有「Claude 工作时保持唤醒」这类主机项，在 Muse 的 VM 上用不到。
- 灰着的选项后面写着「在下方『安全』里开启」：先去「安全」打开对应开关。
- 提示「这一项你改不了」= 你的身份没有这一项（管理员项）；「这个版本的服务端还不认这一项」= 服务端比页面旧，先更新。

## 模型服务（只有管理员）

**「设置 → 模型服务」**（Settings → Model providers）：给 **Claude 页**接别家的模型，和 dimensio 里的「模型服务」（见下）不是一回事。

- 点 **「自定义 API」**（Custom API）打开管理面板，**「添加服务」**（Add provider）：从常用厂商预设开始（DeepSeek、Kimi、OpenRouter 等，预设只填好地址和协议），或 **「从头配置」**（Start from scratch）接任意兼容端点。
- 填 **「接口地址」**（Base URL）、**「接口协议」**（API protocol）——OpenAI 兼容端点由 Muse Bridge 把 Claude Code 的请求整体翻译过去；兼容 Anthropic Messages 的端点则原样转发——再填 API Key（加密存在服务器上，不回传浏览器），点 **「从服务拉取」**（Fetch from service）拿模型列表，选要用的，保存。也可以手动添加模型 ID。
- 编辑器里还能设调用参数、兼容选项（第三方端点不认 Claude Code 的一些字段时调这里）、超时与重试，以及 **「测试与日志」**。
- 加好的模型出现在 Claude 页的模型菜单里，和官方型号并列；每个服务可以单独停用、从菜单里隐藏。
- **在 Muse 上要先放行这个网站**：加之前让 Muse 跑 `allow-sites <接口地址>`，提醒用户把审核卡选成「总是允许此站点」，不然请求会超时（`../MUSE.md` 第 6 节）。
- 注册账号看不到这一节，但用得到管理员加好的模型。

## Agent（只有管理员）

- 每个 agent 一个 **「启用」** 开关；关掉后所有人都看不到这个页面。只剩一个开着时，打开网址直接就是那一页。
- 状态：可用 / 还没配认证 / 这台机器上没装。详见 06-users-admin.md。

## 连接

- **「这台设备」**（This device）：**「服务器地址」**（Server URL）、**「连接状态」**（Connection status）——在线 / 离线。
- **「管理」**（Administration）——只有管理员有：**「服务端控制台」**（Admin console）→ **「打开」**。控制台见 06-users-admin.md。

## dimensio

能用 dimensio 的人才有这一节。改了 API Key、权限规则、工作空间之后，点「访问范围」下面那个 **「保存」**（Save）才生效；「显示」里的两项改了立即生效。

- **「模型服务」**（Provider）：当前选的厂商和型号、是否已配 key；API Key 输入框（**内置厂商的 key 填在这里只放在内存里，重启就没了，长期用让 Muse 跑 set-api-key**；自定义服务的 key 加密保存，重启还在）。换厂商在 dimensio 输入框旁的模型胶囊里。
- **「记忆」**（Memory）→ **「记忆管理」**（Manage memory）：打开记忆面板（见 03-dimensio.md）。
- **「权限规则」**（Permission rules）：「每次问我」「从不允许」两个框，一行一条。
- **「工作空间」**（Workspace）：**「默认工作空间」**（Default workspace）——新对话没选项目时在哪干活，和 **「访问范围」**（Access）——整机可访问（默认）/ 仅工作空间。注册账号看不到访问范围（固定为仅工作空间）。
- **「显示」**（Display）：**「dimensio 外观」**（dimensio appearance）——跟随系统（默认）/ 浅色 / 深色；**「显示全部工作过程」**（Show all work steps）——默认关。
- **「诊断」**（Diagnostics）：导出当前对话的诊断包（先在 dimensio 里打开一个对话）。
- 显示「连不上 dimensio 服务」：dimensio 没启用 / 没装 / 正在重启。

## Agent 接入

**「设置 → Agent 接入」**（Settings → Agent access）：让别的 agent（比如部署它的 Muse、Claude Code、脚本）经 HTTP 直接调用这台 Muse Bridge——读项目手册、给 Claude 派活、管文件和定时任务、看谁在跑——不用开浏览器模拟点击。**所有登录的人都能给自己生成**，每个人只管自己的密钥。

- **「地址」**：**「Agent 入口」**（Agent endpoint）（路径是 `/agent`）和 **「项目手册」**（Project handbook）（`/agent/manual`），各有复制 / 打开按钮。
- **「生成密钥」**（Create key）：给每个 agent 单独起个名字（比如「我的 Muse」），点 **「生成」**（Generate）。新密钥**只显示这一次**：点 **「复制给 agent 的说明」**（Copy instructions for the agent）把带地址的说明整段交给 agent，或「复制密钥」；点「我已保存好」之后就再也看不到了，丢了就吊销再生成。
- **「密钥」**（Keys）列表：每把显示创建时间、最近使用、到期日；**「吊销」**（Revoke）后用这把密钥的 agent 立刻失去访问。
- 密钥**等同你的登录**：只带生成它那个人的权限（管理员的密钥能做管理员能做的，成员的只能动自己的东西）；**90 天后过期**。
- **改密码 / 重置访问令牌会让全部密钥立即失效**（成员改密码，管理员重置访问令牌）。
- 给 Muse 用：用户生成后把密钥交给 Muse，Muse 怎么用见 `../MUSE.md` 4.8。别把密钥发在公开的地方。

## 安卓 app

- 在 app 里：显示 app 版本；**「服务器地址」**（Server URL）→ **「更换」**（Change）换地址；服务器上有新版 app 时出现下载按钮。
- 在浏览器里：**「下载 apk」**（Download APK）、安卓手机上的 **「在 app 里打开」**（Open in app）、GitHub 发布页；电脑上显示下载二维码；iPhone 上提示用 Safari 添加到主屏幕。详见 01-access.md。

## 反馈

- **「报告问题或提建议」**（Report a problem or suggest something）→ **「报告」**（Report）：弹出对话框，选 **「出问题了」**（Something’s wrong）/ **「功能建议」**（Suggestion）/ **「安全问题」**（Security issue），写一句发生了什么（可以不写），点 **「发送」**（Send）。不用 GitHub 账号。
  - 会自动附上版本、服务状态、程序自己的报错位置和出错前的几步操作，**不含对话、文件、key 和地址**；点 **「查看会发送的内容」**（See what will be sent）能先看全文。
  - 普通问题提交到项目公开的 GitHub Issues；别人报过同一个问题时会变成在原报告上 +1；安全问题私下发给维护者，不公开。
  - 页面出错时，错误提示条上也会出现 **「报告问题」**（Report a problem）按钮，点了会带上出错文字。
- **「出错时自动发送错误报告」**（Send error reports automatically）——只有管理员能改：服务崩溃、接口出错、更新失败时自动发报告，同一个错误每个版本只报一次。也可以让 Muse 用 `feedback-auto on/off` 改。
- **「发过的报告」**（Sent reports）：发过的报告和对应的 GitHub 编号，点开能看。
- 通过 Muse 报告的流程见 `../MUSE.md` 第 8 节。

## 关于

- 显示「Muse Bridge」和「网页版 · 界面由服务器直接提供，刷新页面即是最新」。版本号看 Muse 结果块里的「运行版本」，或让 Muse 跑 `status`。
