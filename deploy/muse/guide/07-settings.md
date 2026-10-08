# 设置逐项说明

## 怎么打开

- 侧栏最底下的账户卡 → **「设置」**（Settings）；主页右上账户胶囊里也有 **「设置」**。dimensio 侧栏底部的设置会直接打开下面的 dimensio 分区。
- 电脑上是一个居中的对话框：左栏是搜索框和分区列表，右边是内容；按 Esc 或点背景关闭。左上的 **「搜索」**（Search）能按名字或关键词搜设置项（只有电脑上有，界面是英文时用英文搜）。
- 手机上是整页：最上面是账户卡（点进去是「账户」），下面是各分区，点进去从右边滑入，左上角返回。
- 下面这些设置**大多只存在当前这个浏览器 / 设备里**（「通用」那一节全部是），换设备要重新设。

## 分区一览

| 分区 | 谁能看到 |
|---|---|
| 通用（General） | 所有人 |
| 账户（Account） | 所有人（内容按身份不同） |
| Agent（Agents） | 只有管理员 |
| 连接（Connection） | 所有人（控制台入口只有管理员有） |
| dimensio | 能用 dimensio 的人 |
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

通知说明：Claude 页只在一轮**跑完**时通知（Claude 在等你回答问题时**不会**通知）；dimensio 在等你批准、等你回答、交了计划、跑完时都会通知。

## 账户

- **「个人资料」**（Profile）：头像字母、用户名、身份（管理员 / Pro 用户 / 普通用户）。
- **「用量」**（Usage）：共享 Claude 订阅的用量——当前 5 小时窗口和本周各用了多少、多久后重置（80% 以上变红）。大家共用这一份。
- **「我的额度」**（Your usage）——只有注册账号有：今天和最近 7 天跑了几轮、花了多少，管理员设了上限时显示「已用 / 上限」。
- **「密码」**（Password）——只有注册账号有：改密码（见 01-access.md）。
- **「工作空间」**（Workspace）：**「文件与分享」**（Files & sharing）→ 打开文件管理器；手机上还有 **「登录网页版」**（Sign in to the web app）→ 扫码帮电脑登录。
- **「退出登录」**（Sign out）：只退出这台设备。

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
