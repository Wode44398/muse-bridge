# 改到核心（示例插件）

插件接口四期的示例，每样新能力用一次：

- `ctx.events.on('turn.end')`：记下最近的对话，出错时 `ctx.notify` 提醒
- `ctx.claude.hook('PreToolUse')`：拦下 rm -rf、git push --force 这类危险命令（所有权限模式都生效）
- `ctx.claude.permission`：只读 git 命令免审批
- `ctx.claude.input`：发给 Claude 前给手机号打码
- `ctx.claude.options`：每轮追加一段系统提示
- `ctx.tools.add` + `render: 'card'`：Claude 和 dimensio 都能用的工具，结果画成卡片
- `ctx.ui.homeCard` / `command` / `messageAction`：主页卡片、「/review」「/turns」命令、消息菜单「统计字数」
- `ctx.notify.channel`：一个只写插件日志的通知渠道（换成飞书 / Telegram 的接口就是真渠道）

写法说明见 bridge 项目手册 plugins 章「改到核心」。
