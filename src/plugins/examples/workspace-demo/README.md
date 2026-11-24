# 协作工作空间（示例插件）

工作区插槽的示例，每样能力用一次：

- `ctx.ui.workspaceDecor`：把共用的文件夹画成一块底板，带双方标识、在干活的进度、状态行（走秒）、底部一行、悬停卡、会话「谁开的」标记、对方的会话列表
- `ctx.ui.workspaceAction`：文件夹菜单里「设为协作工作空间」（确认框带开关）、「协作设置」（编辑态，左下有「取消协作」）、「取消协作」；结果带撤销
- `ctx.ui.refreshDecor`：轮次开始 / 结束、演示开关轮换时推一声，界面重拉外观
- `ctx.claude.memoryInfo`：底板上显示共用记忆的篇数
- `ctx.claude.prompt(…, { agents: ['agy'] })`：只给在共用文件夹里的 Antigravity 会话加一句提示（`turn.cwd`）
- `ctx.events.on('turn.start' / 'turn.end')`：Claude 和 Antigravity 的轮次都会来

写法说明见 bridge 项目手册 plugins 章「往界面里加东西 › 文件夹」。
