# hooks、技能目录与自定义斜杠命令

dimensio 认 Claude Code 的配置格式：`.claude/` 下现成的 hooks、技能、命令拿来就能用；也可以放在 `.dimensio/` 下（只给 dimensio 用）。

## 放在哪

| 位置 | 项目级 | 用户级 |
|---|---|---|
| hooks | `<工作区>/.dimensio/settings.json`、`settings.local.json`<br>`<工作区>/.claude/settings.json`、`settings.local.json` | `~/.dimensio/settings.json`、`settings.local.json`<br>`~/.claude/settings.json`、`settings.local.json` |
| 技能 | `<工作区>/.dimensio/skills/<名>/SKILL.md`<br>`<工作区>/.claude/skills/<名>/SKILL.md` | `~/.dimensio/skills/<名>/SKILL.md`<br>`~/.claude/skills/<名>/SKILL.md` |
| 命令 | `<工作区>/.dimensio/commands/**/*.md`<br>`<工作区>/.claude/commands/**/*.md` | `~/.dimensio/commands/**/*.md`<br>`~/.claude/commands/**/*.md` |

- 同名时：项目级 > 用户级 > 扩展中心（技能）；同一级里 `.dimensio` 先于 `.claude`。
- 项目级目录里的链接（符号链接、junction）按真实落点判：指到工作区外、或指到凭据类文件的技能和命令不会被收进来（日志里记一行）。用户级的可以链到别处（比如你自己的 dotfiles 仓库），但同样不许指到凭据类文件。
- 多用户服务器上的**成员**实例：不加载任何 hook；技能与命令只认自己工作区里的项目级目录，不读用户级目录。
- 用户级目录可以用环境变量 `DIMENSIO_USER_CONFIG_DIRS` 换（按 PATH 分隔符，前面的优先）。
- hooks 配置在会话建立时读一次；会话里改了 settings，新开的会话才生效。技能与命令每次用时现读。

## hooks

### 配置格式

和 Claude Code 的 `settings.json` 一样：

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "~/.claude/hooks/check.sh", "timeout": 30 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "npm test --silent" }] }
    ]
  }
}
```

- 只执行 `type: "command"` 的 hook（Claude Code 的 prompt / agent 型会跳过并在日志里说明）。
- `matcher`：空或 `*` = 全部；否则按整段正则匹配（`Edit|Write`、`mcp__.*`）。工具名与 Claude Code 同名（Read / Write / Edit / Bash / Grep / Glob / Agent / WebFetch / WebSearch……），旧名 `Task` 也对得上 Agent。SessionStart 的 matcher 对 `startup` / `resume`，PreCompact 的对 `manual` / `auto`，其它事件不看 matcher。
- `timeout` 单位秒，默认 60，最多 600。
- 任一份 settings 写了 `"disableAllHooks": true` 就全部停用。

### 支持的事件

| 事件 | 什么时候 | 能做什么 |
|---|---|---|
| PreToolUse | 工具执行前 | 拦下（退出码 2 或 `permissionDecision: "deny"`）；`allow` 免掉本来要弹的确认卡（控制面文件、硬拒、只读 / 计划模式照旧）；`ask` 把本来放行的调用改成弹卡；`updatedInput` 改参数；`additionalContext` 附在工具结果后 |
| PostToolUse | 工具执行后 | 退出码 2 的 stderr、`decision: "block"` 的 `reason`、`additionalContext` 附在工具结果后交给模型 |
| UserPromptSubmit | 你发出一条消息、模型开始之前；模型工作中途的插话也算 | stdout（纯文本或 `additionalContext`）作为附加上下文；退出码 2 或 `decision: "block"` 拦下这条消息（不进对话；一轮开头的消息把原因显示给你，插话退回输入框） |
| Stop | 主 agent 要收尾时 | 退出码 2 或 `decision: "block"` 不让收尾，原因交给模型接着做；一轮最多拦 3 次 |
| SubagentStop | 子 agent 要收尾时 | 同 Stop |
| SessionStart | 会话的第一轮（`startup`），或服务重启后恢复的会话的第一轮（`resume`） | stdout 作为附加上下文 |
| PreCompact | 整段压缩上下文之前（你点的「立即压缩」是 `manual`；上下文到线、空闲时的自动压缩是 `auto`） | 只通知，不能阻止 |

### 输入输出

- 命令从 stdin 收到一个 JSON：`session_id`、`transcript_path`（dimensio 的会话记录文件，格式与 Claude Code 的不同）、`cwd`、`hook_event_name`、`permission_mode`，以及各事件的字段：`tool_name`、`tool_input`（带一份 Claude Code 的参数名，如 `file_path`）、`tool_use_id`、`tool_response`、`prompt`、`stop_hook_active`、`source`、`trigger`。
- 退出码 0 = 通过；2 = 阻止，stderr 是原因；其它 = 只在日志里记一条警告。
- stdout 是 JSON 时认这些字段：`decision`、`reason`、`additionalContext`、`hookSpecificOutput.permissionDecision`（allow / deny / ask）、`permissionDecisionReason`、`updatedInput`、`additionalContext`。`continue`、`stopReason`、`suppressOutput`、`systemMessage` 暂不支持。
- 命令在工作区目录里、用 Bash 工具同一个 shell 跑（Windows 上是 Git Bash）。环境里去掉了各类密钥（API key、令牌），保留你自己的 HOME；另有 `CLAUDE_PROJECT_DIR` 指向工作区。超时或会话被停止时整棵进程树一起结束；输出各留前 64 KB，进模型的附加上下文最多 1 万字。
- hook 给模型的话都会留在对话记录里（工具结果的一部分，或开头是 `[Hook: 事件名]` 的一条提示）。

### 信任规则

hook 会在你的电脑上执行任意命令，所以：

- **用户级**配置默认生效（那是你自己写的）。
- **项目级**配置默认**不**执行——工作区里的文件可能来自克隆下来的陌生仓库。会话里第一次遇到时会弹一张确认卡，列出要执行的命令；点允许 = 信任这个工作区的这份配置，以后不再问。配置内容一改（哪怕只改一个字），会再问一次。点拒绝，这个会话里不再问、也不执行。没人在场（离开模式、无人值守）时不执行，只记日志。信任记录在 harness 数据目录的 `hook-trust.json`。
- 项目级命令里直接写出来的工作区内文件（比如 `"$CLAUDE_PROJECT_DIR"/.claude/hooks/fmt.sh`、`python scripts/check.py`）也算进信任：确认卡上会列出来，文件内容一改要重新确认；会话进行中被改过的，这个会话里不再执行。命令间接调用的东西（`npm run` 的脚本、Makefile 的步骤）认不出来，不在这道复核里。
- 模型要写任何 `.claude/`、`.dimensio/` 下的 `settings.json` / `settings.local.json`、`hooks/` 目录里的文件（hook 脚本），或者 harness 的 `hook-trust.json`，每次都要你批准，只能「允许这一次」——管理员的全权（bypass）档也一样。技能、命令目录（`skills/`、`commands/`）里的文件同样每次都问（bypass 档照常放行）。

## 技能

- SKILL.md 的 frontmatter：`name`（不写就用目录名）、`description`（目录里只放第一句）、`disable-model-invocation: true`（只能你用 /名字 点）、`user-invocable: false`（不进 / 面板）、`argument-hint`。
- 技能清单在会话开始时进系统提示，标出来源 `(project)` / `(user)`；会话中途增删技能会以一条更新提示告诉模型。
- 载入时会告诉模型技能目录的绝对路径，SKILL.md 里写的相对路径（脚本、参考文件）都相对它。用户级技能目录对模型只读开放：可以读、可以从那里跑脚本，不能往里写（文件工具和 Bash 都一样）。

## 自定义斜杠命令

- 文件名（去掉 `.md`）就是命令名：`.claude/commands/review.md` → `/review`。子目录只用来归类，也可以写成 `/frontend:component`。
- 消息以 `/名字` 开头且对得上时，你的原话照常发出，命令正文展开后紧跟着交给模型。
- 正文里的 `$ARGUMENTS` 换成全部参数，`$1`、`$2`…… 换成按空格切开的各段（引号括起来的算一段）。`@路径` 引用的文件内容附在后面——只认工作区里的、而且不附凭据类文件（`.env`、私钥等），与会话当前的访问范围无关（命令文件可能来自陌生仓库）。
- `!命令` **不会**自动执行（那等于让文件内容直接在你电脑上跑命令）；模型会被告知，需要时它自己用 Bash 跑。
- frontmatter：`description`、`argument-hint` 显示在 / 面板；`allowed-tools` 会告诉模型这条命令要用哪些工具，但不放宽权限；`model` 读出来但不会为一条命令切换模型。
- 命令与技能同名时命令优先；要点同名的技能写 `/skill:名字`。
