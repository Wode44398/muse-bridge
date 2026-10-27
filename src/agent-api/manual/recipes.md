# 常见任务怎么办

用户的常见说法，对应到界面路径和接口操作的组合；接口参数的细节见 api 章的「全部操作」。

## 「现在哪个 AI 在干活 / 我让它做的事跑完没」

`overview` 一次看全：正在跑的 Claude 对话（会话 id、开始时间、用户那条消息开头）、在等人回答的提问与审批、定时任务（正在跑的、接下来三条）、在线的设备、用户此刻开着哪些 bridge 界面。具体某个会话的进度用 `chat.wait { sessionId, timeout: 0 }`——立刻返回当前状态与 `partial`（已经说到的内容）。

界面上：Claude 分页的会话列表，以及工作台的「任务」面板（后台任务与子 agent），见 claude 章。

## 「让 Claude 做某事，做完把结果存成文件 / 发给我」

1. `chat.send { message: "……做完把结果写进 notes/报告.md", wait: 300 }`——在 message 里写清产出放哪，Claude 自己会写文件。
2. 没等到就循环 `chat.wait { sessionId }`，直到 `status: done`；`reply` 是最终回答，`files` 是它交付的文件。
3. 要自己落盘：`files.write { path, content: reply }`。
4. 要让用户马上看到：`ui.open { file: "notes/报告.md" }`（推进他的预览），或 `ui.notify { text: "报告写好了" }`。

## 「找我之前聊过某件事的那次对话 / 打开它」

`sessions.search { q: "关键词" }` → 结果里挑一个 id → 要内容就 `sessions.read { sessionId }`，要在用户界面上打开就 `ui.open { session: id }`。只想翻最近的：`sessions.list { limit: 20 }`；某个项目的：先 `projects.list`，再 `sessions.list { project }`。

## 「接着那个对话说 / 让它改一下」

`chat.send { sessionId, message }`。那个会话正在跑时默认排队（这一轮结束后自动发）；要它立刻看到就 `whenBusy: "steer"`（插进当前这一轮）；要推翻重来用 `"replace"`。

## 「Claude 在问我问题 / 要我批准，帮我选」

`chat.pending` 列出所有在等的（或 `chat.wait` 返回的 `pending`）。提问：`chat.answer { id, answers: ["选项文字"] }`；工具审批：`chat.answer { id, decision: "once" }`（只这一次）/ `"always"` / `"deny"`；计划审批：`decision: "accept"` 或 `"revise"` + `feedback`。拿不准用户会怎么选时，先把问题转述给用户。用户界面上同一张卡会同步消失。

## 「带我去某个页面」

`ui.open { page }`：`claude`、`files`（工作空间）、`routines`（定时任务）、`settings`（可带 `section`，如 `devices`、`agentapi`、`account`）、`vertex`（带 `module`：`chat` / `image` / `video` / `voice` / `music`）、`chatgpt`、`dimensio`、`home`。用户只是问「在哪」时只指路，别直接跳；明确说「带我去 / 打开」才调。界面路径见各章。

## 「生成一张图 / 一段配音 / 视频 / 音乐」

需要 Vertex 扩展且对这个身份开着（`whoami` 的 agents 里有 gemini）。

- 图片：`media.image { prompt, aspectRatio?, imageSize?, model?, saveTo? }`，几秒到几十秒；`saveTo: "images/"` 顺手复制进工作空间。
- 语音：`media.speech { text, voice?, style? }`。
- 视频（`media.video`）、音乐（`media.music`）按秒 / 按次计费、要一两分钟：用户没明确要时先确认。
- 产物也会出现在 Vertex 分页对应模块的历史里；`url` 带同一把密钥可以下载。
- 模型怎么选见 vertex 章。

## 「每天 / 每周定时帮我做某事」

`routines.create { name, prompt, schedule: { type: "daily", hour: 8, minute: 30 } }`。`type` 还有 `weekdays`（工作日）、`weekly`（配 `weekday`，0=周日）、`hourly`（只看 minute）；时间按服务器所在时区。prompt 里写清产出放哪。成员启用中的条数有上限；Ultracode 不能用于定时任务。

管理：`routines.list` 看全部与上次结果；`routines.update { id, enabled: false }` 停用；`routines.run { id }` 立即跑一次；`routines.delete` 删除（⚠ 先问）。界面入口：Claude 分页历史抽屉（手机）/ 左侧栏（桌面）顶部的「定时触发」。

## 「工作空间里有没有某个文件 / 这个文件讲什么」

`files.search { q: "文件名的一部分" }`（只按名字找，递归）→ `files.read { path }`（文本类返回内容；二进制给下载地址）。浏览：`files.list { path }`。整理：`files.mkdir`、`files.move { path, toFolder }`、`files.rename`、`files.copy`；删除 `files.delete`（⚠；只有服务端在 Windows 上、且是主机身份时进回收站，其余一律永久删除，看返回的 recoverable）。

## 「在我电脑上跑个命令 / 看看我电脑屏幕」

`devices.list` 看有哪些设备、在不在线、什么档位 → `devices.run { device, op: "shell", args: { command } }`；看屏幕 `op: "desktop", args: { action: "screenshot" }`；读界面结构 `action: "uia_tree"`。设备在「只看」档时，操作类动作会在电脑上弹窗问用户。这是用户的真实电脑，只做被要求的事。

## 「我还剩多少额度」

`usage`：成员返回今天 / 本周已用与上限、哪些功能对他开着；主机身份不限额。界面：设置 › 账户。

## 外部 agent 长期值守

需要盯着 bridge 的 agent（比如每隔几分钟看有没有在等人回答的提问）：定期调 `overview`，有 `pending` 就按上面「帮我选」的办法处理或通知用户。不要高频轮询（每分钟一次足够），也不要替用户批准你拿不准的审批。
