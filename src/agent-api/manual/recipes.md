# 常见任务怎么办

用户的常见说法，对应到界面路径和接口操作的组合；接口参数的细节见 api 章的「全部操作」。

## 「现在哪个 AI 在干活 / 我让它做的事跑完没」

`overview` 一次看全：正在跑的 Claude 对话（会话 id、开始时间、用户那条消息开头）、在等人回答的提问与审批、定时任务（正在跑的、接下来三条）、用户此刻开着哪些 Muse Bridge 界面。具体某个会话的进度用 `chat.wait { sessionId, timeout: 0 }`——立刻返回当前状态与 `partial`。dimensio 的对话不在这里，请用户看 dimensio 页。

界面上：Claude 页侧栏会话行的状态点，以及工作台「任务」面板，见 claude 章。

## 「让 Claude 做某事，做完把结果存成文件 / 告诉我」

1. `chat.send { message: "……做完把结果写进 notes/报告.md", wait: 300 }`——在 message 里写清产出放哪，Claude 自己会写文件。
2. 没等到就循环 `chat.wait { sessionId }`，直到 `status: done`；`reply` 是最终回答，`files` 是它交付的文件。
3. 要自己落盘：`files.write { path, content: reply }`。
4. 要让用户马上看到：`ui.open { file: "notes/报告.md" }`（推进他的预览），或 `ui.notify { text: "报告写好了" }`。

## 「找我之前聊过某件事的那次对话 / 打开它」

`sessions.search { q: "关键词" }` → 挑一个 id → 要内容就 `sessions.read { sessionId }`，要在用户界面上打开就 `ui.open { session: id }`。只想翻最近的：`sessions.list { limit: 20 }`；某个项目的：先 `projects.list`，再 `sessions.list { project }`。

## 「接着那个对话说 / 让它改一下」

`chat.send { sessionId, message }`。那个会话正在跑时默认排队（这一轮结束后自动发）；要它立刻看到用 `whenBusy: "steer"`；要推翻重来用 `"replace"`。

## 「Claude 在问我问题 / 要我批准，帮我选」

`chat.pending` 列出所有在等的（或 `chat.wait` 返回的 `pending`）。提问：`chat.answer { id, answers: ["选项文字"] }`；工具审批：`chat.answer { id, decision: "once" }` / `"always"` / `"deny"`；计划审批：`decision: "accept"` 或 `"revise"` + `feedback`。拿不准用户会怎么选时，先把问题转述给用户。用户界面上同一张卡会同步消失。

## 「带我去某个页面」

`ui.open { page }`：`claude`、`dimensio`、`files`（工作空间）、`routines`（定时触发）、`settings`（可带 `section`：`general`、`account`、`claude`、`providers`、`agentapi`、`connection`、`dimensio`、`android`、`feedback`、`about`，管理员还有 `agents`）、`home`。用户只是问「在哪」时只指路，别直接跳；明确说「带我去 / 打开」才调。

## 「每天 / 每周定时帮我做某事」

`routines.create { name, prompt, schedule: { type: "daily", hour: 1, minute: 0 } }`。时间按服务器时区（Muse 的 VM 一般是 UTC，北京时间 9 点填 1 点）；`type` 还有 `weekdays`、`weekly`（配 `weekday`，0=周日）、`hourly`（只看 minute）。prompt 里写清产出放哪。注册账号启用中的条数有上限；Ultracode 不能用于定时任务。

管理：`routines.list` 看全部与上次结果；`routines.update { id, enabled: false }` 停用；`routines.run { id }` 立即跑一次；`routines.delete` 删除（⚠ 先问）。界面入口：Claude 页侧栏「定时触发」。

## 「工作空间里有没有某个文件 / 这个文件讲什么」

`files.search { q: "文件名的一部分" }`（只按名字找，递归）→ `files.read { path }`（文本类返回内容；二进制给下载地址）。浏览：`files.list { path }`。整理：`files.mkdir`、`files.move { path, toFolder }`、`files.rename`、`files.copy`；删除 `files.delete`（⚠ 永久删除，没有回收站，先问）。

## 「我还剩多少额度」

`usage`：注册账号返回今天 / 本周已用与上限；管理员不限额。共享 Claude 订阅的 5 小时 / 本周用量在 设置 ›「账户」›「用量」和输入框旁的用量环。

## 「帮我给朋友开个账号 / 重启服务 / 更新 / 换域名」

接口里没有这些。开账号、邀请码、额度在服务端控制台（设置 ›「连接」›「服务端控制台」），见 accounts 章；重启在控制台「服务控制」；更新、回滚、换域名、改「只自己用 / 多人用」由 Muse 用 `bootstrap.sh` 的子命令做（见 `deploy/muse/MUSE.md`）。

## 外部 agent 长期值守

需要盯着 Muse Bridge 的 agent（比如隔一阵看看有没有在等人回答的提问）：定期调 `overview`，有 `pending` 就按上面「帮我选」的办法处理或通知用户。不要高频轮询（每分钟一次足够），也不要替用户批准你拿不准的审批。Muse 在 VM 本机调 `http://127.0.0.1:8787` 最省事。
