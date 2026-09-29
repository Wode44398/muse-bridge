// dimensio 英文界面文案 · 后端下发的文案（tr() 运行时匹配；键 = 后端原文）
// 键逐字抄自 harness/server/**/*.ts 里会上屏的中文（HTTP 报错、事件里的人话、工具结果行、权限卡原因、目录备注……），
// 带 {占位} 的是模板键：tr() 整句匹配，占位里的片段会再过一遍 tr()（所以「这一轮出错：{summary}」里的分类器原话也能翻）。
// 只给模型看的提示词 / 工具结果、日志、测试、诊断包不在这里。
// 同一句有「数量 = 1」的特例时，另起一个更长的键（tr() 先试长键）：见 grep 的「处匹配」几条。
export default {
  // ── 运行出错：分类器的一句人话（providers/classify.ts）─────────────────────────
  "API key 无效、过期或没有这个模型的权限（provider 说的）：去设置里换 key 或换模型":
    "The provider says the API key is invalid, expired, or has no access to this model. Change the key in Settings or switch models.",
  "请求在出口被拒（代理、CDN 或地区限制，不是 key 的问题）：检查出站代理的出口":
    "The request was blocked on its way out (proxy, CDN, or region restriction, not the API key). Check the outbound proxy’s exit IP.",
  "被限流了：会稍后自动重试": "Rate limited. Retrying automatically in a moment.",
  "上游繁忙或过载：会稍后自动重试": "The provider is busy or overloaded. Retrying automatically in a moment.",
  "账户欠费或额度用完：充值或换一个模型后再试（重试没用）":
    "The account is out of credit or over its quota. Retrying won’t help. Top up or switch models, then try again.",
  "上下文超出了模型窗口：先压缩再试": "The context exceeds the model’s context window. Compact it, then try again.",
  "请求体过大（多半是图片或很长的工具结果）：先压缩再试":
    "The request is too large (usually images or a very long tool result). Compact the context, then try again.",
  "上游或网关超时：会稍后自动重试": "The provider or gateway timed out. Retrying automatically in a moment.",
  "provider 服务端出错：会稍后自动重试": "The provider had a server error. Retrying automatically in a moment.",
  "请求被拒绝（参数或模型名不对）：重试没用": "The request was rejected (wrong parameters or model name). Retrying won’t help.",
  "未知错误": "Unknown error",

  // ── 运行出错：loop 自己的收场（agent/loop.ts）与等网络 / 本机模型（agent/netwait.ts）──────────
  "模型什么都没回（多半是连接中途掉了），重发几次也没回来":
    "The model didn’t return anything, even after several retries (the connection probably dropped).",
  "上下文超出了模型窗口，压缩之后仍然放不下：带摘要开一个新会话接着做":
    "The context still exceeds the model’s context window after compacting. Continue in a new session with a summary.",
  "和模型的连接断了，重试也没接上": "Lost the connection to the model. Retrying didn’t reconnect.",
  "模型几次都没按要求交记忆审计，这一轮没能收尾":
    "The model didn’t submit the required memory audit after several reminders, so this turn couldn’t finish.",
  "模型反复交审计、不干正事，已经让它停下": "The model kept submitting audits instead of doing the work, so it was stopped.",
  // 活动行（输入框上方一行）：尽量短
  "答复先撤回：改了代码，但还没有通过的验证，正在让它补跑检查":
    "Response withdrawn: code changed but no check has passed. Asking the agent to run checks.",
  // 胶囊在输入框里的英文名是「Local model: …」（hx-composer「本机模型：{status}」）
  "本机模型没有启动（llama-server 不在运行）：在输入框的「本机」胶囊里启动它，或换一个模型":
    "The local model isn’t started (llama-server isn’t running). Start it from the “Local model” capsule in the composer, or switch models.",
  "本机模型 {n} 秒还没加载好（{error}）": "The local model still isn’t loaded after {n} sec ({error})",
  "网络 {n} 分钟未恢复（最后一次：{error}）": "The network hasn’t recovered after {n} min (last error: {error})",

  // ── 权限卡：命中的规则（agent/permissions.ts）────────────────────────────────
  // 显示在卡片右上的等宽小芯片里（单行、超长省略），英文尽量短
  "内置·高危命令复核": "Built-in · Risky command",
  "内置·不可恢复操作": "Built-in · Irreversible",
  "内置·启动前确认": "Built-in · Confirm first",
  "内置·控制面文件": "Built-in · Control file",
  "刚拒绝过同一目标": "Denied earlier this turn",

  // ── 权限卡：给人看的原因（why）──────────────────────────────────────────────
  "要改控制面文件（{file}）：写进去的指令会带进之后的会话，或改掉运行配置 / 会话记录":
    "Wants to change a control file ({file}). Instructions written there carry over to later sessions, or it may change the run config or session records.",
  "改 shell 启动文件（{file}）：写进去的东西之后每开一个终端都会执行":
    "Changes a shell startup file ({file}). Whatever it writes runs in every new terminal.",
  "这一轮你刚拒绝过「{target}」，它换了个办法又要碰它":
    "You denied “{target}” earlier in this turn, and the agent is trying to reach it another way.",
  "你设的规则 {rule} 要求这类操作先问你": "Your rule {rule} requires asking you first.",
  "这条命令要写 {target}，你设的规则 {rule} 要求先问你": "This command writes {target}, and your rule {rule} requires asking you first.",
  "这条命令没法完全解析，可能会写到规则 {rule} 管着的路径":
    "This command couldn’t be fully analyzed and may write to paths covered by rule {rule}.",
  // 多个目录：服务端用「」「连起来。tr() 的占位只能配汉字字面，所以 2 个、3 个各起一个更长的键把路径拆开（更多的仍走通用键）
  "要读工作区外的目录「{dir}」（只读，不会写）": "Wants to read a folder outside the workspace: “{dir}” (read-only, no writes)",
  "要读工作区外的 {n} 个目录「{dirs}」（只读，不会写）":
    "Wants to read {n} folders outside the workspace: “{dirs}” (read-only, no writes)",
  "要读工作区外的 {n} 个目录「{a}」「{b}」（只读，不会写）":
    "Wants to read {n} folders outside the workspace: “{a}”, “{b}” (read-only, no writes)",
  "要读工作区外的 {n} 个目录「{a}」「{b}」「{c}」（只读，不会写）":
    "Wants to read {n} folders outside the workspace: “{a}”, “{b}”, “{c}” (read-only, no writes)",
  "连接器「{server}」的工具「{tool}」没有声明只读，可能会改动外部的数据或替你发出东西":
    "Tool “{tool}” from connector “{server}” isn’t marked read-only. It may change external data or send things on your behalf.",
  "要启动工作流「{name}」：按下面的脚本派出多个子 agent 干活":
    "Wants to start workflow “{name}”, which runs the script below and dispatches several subagents",
  // tools/shell-policy.ts：检查点兜不住 / 高危的命令
  "这条命令没法完全解析，里面又出现了 {cmd} 这类高危程序":
    "This command couldn’t be fully analyzed, and it mentions {cmd}, a high-risk program.",
  "递归删除的目标（{target}）要到运行时才知道——它要是空的，就会从根目录删起":
    "The recursive delete target ({target}) is only known at run time. If it’s empty, this deletes from the root.",
  "访问云主机的元数据端点——在云上，它直接发这台机器的云凭证":
    "Accesses the cloud instance metadata endpoint. On a cloud machine, that hands out the machine’s cloud credentials.",
  "把刚从网上下载的内容直接交给 shell / 解释器执行，没先存下来给人看一眼":
    "Runs content just downloaded from the internet directly in a shell or interpreter, without saving it for review first",
  "永久改用户 / 整机的环境变量（SetEnvironmentVariable）":
    "Permanently changes user or machine environment variables (SetEnvironmentVariable)",
  "永久改用户 / 整机的环境变量（setx）": "Permanently changes user or machine environment variables (setx)",
  "把容器命令发给远程的 Docker（{host}）": "Sends container commands to a remote Docker ({host})",
  "把命令发给远程的 Docker（{host}）": "Sends the command to a remote Docker ({host})",
  "命令可能发给远程的 Docker（context {context}）": "The command may go to a remote Docker (context {context})",
  "强推：改写远端的提交历史，被盖掉的提交本地检查点救不回来":
    "Force push: rewrites commit history on the remote. Local checkpoints can’t recover overwritten commits.",
  "删掉远端的分支或标签": "Deletes branches or tags on the remote",
  "发布到（或撤出）包仓库（{cmd}）——发出去别人就可能装上了，收不干净":
    "Publishes to (or withdraws from) a package registry ({cmd}). Once it’s out, others may install it, and it can’t be fully taken back.",
  "把镜像推到镜像仓库（{cmd} push）": "Pushes an image to a registry ({cmd} push)",
  "改动 GitHub 上的发布（gh release {sub}）": "Changes a release on GitHub (gh release {sub})",
  "删掉 GitHub 上的仓库（gh repo delete）": "Deletes a repository on GitHub (gh repo delete)",
  "归档 GitHub 上的仓库（gh repo archive）": "Archives a repository on GitHub (gh repo archive)",
  "改动本机全局装的包和命令（{cmd} -g）——在工作区之外，检查点管不到":
    "Changes globally installed packages and commands on this computer ({cmd} -g). This is outside the workspace, so checkpoints can’t undo it.",
  "改动本机全局装的包（yarn global {sub}）": "Changes globally installed packages on this computer (yarn global {sub})",
  "从本机共用的 Python 里卸载包（别的程序可能还在用）":
    "Uninstalls packages from this computer’s shared Python (other programs may still use them)",
  "给整台机器装 / 卸软件（{cmd}）": "Installs or removes software for the whole computer ({cmd})",
  "改 Windows 注册表（{cmd}）": "Changes the Windows registry ({cmd})",
  "改全局 git 配置（git config {scope}），本机所有仓库都受影响":
    "Changes global git settings (git config {scope}). Every repository on this computer is affected.",

  // ── 设置：权限规则自查（index.ts → agent/permissions.ts ruleProblem；多条用「；」连起来）──────────
  "权限规则有误：{problems}": "Invalid permission rules: {problems}",
  // 「{a}；…」按最后一条的类型配、{a} 取第一条：1–2 条都对；3 条以上（一次存进 3 条坏规则）中间几条会留中文，tr() 做不到
  "「{rule}」不是「工具名」或「工具名(模式)」的写法": "“{rule}” isn’t in the form “Tool” or “Tool(pattern)”",
  "「{rule}」里的工具 {tool} 不存在": "Tool {tool} in “{rule}” doesn’t exist",
  "「{rule}」的模式是空的——要管这个工具的每一次调用，直接写 {tool}":
    "“{rule}” has an empty pattern. To cover every call to this tool, just write {tool}.",
  "「{rule}」连「{sample}」都匹配不上": "“{rule}” doesn’t even match “{sample}”",
  "{a}；「{rule}」不是「工具名」或「工具名(模式)」的写法": "{a}; “{rule}” isn’t in the form “Tool” or “Tool(pattern)”",
  "{a}；「{rule}」里的工具 {tool} 不存在": "{a}; tool {tool} in “{rule}” doesn’t exist",
  "{a}；「{rule}」的模式是空的——要管这个工具的每一次调用，直接写 {tool}":
    "{a}; “{rule}” has an empty pattern. To cover every call to this tool, just write {tool}.",
  "{a}；「{rule}」连「{sample}」都匹配不上": "{a}; “{rule}” doesn’t even match “{sample}”",

  // ── 工具行第二行：结果（tools/*.ts 的 outcome）───────────────────────────────
  // Read
  "空文件": "Empty file",
  "读了全部 {n} 行": { one: "Read 1 line", other: "Read all {n} lines" },
  "读了第 {start}–{end} 行（共 {n} 行）": "Read lines {start}–{end} of {n}",
  // Glob
  "找到 {n} 个文件": { one: "Found 1 file", other: "Found {n} files" },
  "找到 {n} 个文件（只列了前这些）": "Showing the first {n} files",
  "没有匹配的文件": "No matching files",
  // Grep（两个数：「1 个文件」单独成键，免得出现 “1 files”）
  "没有匹配": "No matches",
  "1 处匹配（1 个文件）": "1 match in 1 file",
  "{matchCount} 处匹配（1 个文件）": "{matchCount} matches in 1 file",
  "{n} 处匹配（{files} 个文件）": "{n} matches in {files} files",
  "{matchCount} 处匹配（1 个文件） · 只列了一部分": "{matchCount} matches in 1 file · Partial list",
  "{n} 处匹配（{files} 个文件） · 只列了一部分": "{n} matches in {files} files · Partial list",
  // Edit / Write
  "改了 {n} 处（+{added} −{removed} 行）": {
    one: "1 edit (+{added} −{removed} lines)",
    other: "{n} edits (+{added} −{removed} lines)",
  },
  "改了 {n} 处（+{added} −{removed} 行） · 语法检查没过": {
    one: "1 edit (+{added} −{removed} lines) · Syntax check failed",
    other: "{n} edits (+{added} −{removed} lines) · Syntax check failed",
  },
  "覆盖 · {n} 行": { one: "Overwritten · 1 line", other: "Overwritten · {n} lines" },
  "新建 · {n} 行": { one: "Created · 1 line", other: "Created · {n} lines" },
  "覆盖 · {n} 行 · 语法检查没过": {
    one: "Overwritten · 1 line · Syntax check failed",
    other: "Overwritten · {n} lines · Syntax check failed",
  },
  "新建 · {n} 行 · 语法检查没过": {
    one: "Created · 1 line · Syntax check failed",
    other: "Created · {n} lines · Syntax check failed",
  },
  // Bash
  "跑了 {sec} 秒还没完，转到后台继续（{id}）": "Still running after {sec}s · Moved to background ({id})",
  "超时（{sec} 秒）被停下": "Killed (timed out after {sec}s)",
  "被中止": "Stopped",
  "退出码 {code} · {n} 行输出": {
    one: "Exit code {code} · 1 line of output",
    other: "Exit code {code} · {n} lines of output",
  },
  "退出码 {code} · 没有输出": "Exit code {code} · No output",
  // MCP 连接器工具
  "返回错误": "Returned an error",
  "返回 {n} 字": { one: "Returned 1 char", other: "Returned {n} chars" },
  "返回 {chars} 字 · {n} 张图": {
    one: "Returned {chars} chars · 1 image",
    other: "Returned {chars} chars · {n} images",
  },
  // WebFetch（不截断时的「HTTP 200 · 523 字」字面只有一个汉字，tr() 认不了）
  "HTTP {status} · {size} 字 · 太长截断了": "HTTP {status} · {size} chars · Truncated",
  // WebSearch
  "{n} 条结果（{source}）": { one: "1 result ({source})", other: "{n} results ({source})" },
  "{n} 条结果（{source} · 缓存）": { one: "1 result ({source} · cached)", other: "{n} results ({source} · cached)" },
  "智谱 web_search": "Zhipu web_search",
  // UpdateGoal
  "目标暂停：{reason}": "Goal paused: {reason}",
  // 只出现在「目标暂停：…」「需要你：…」的冒号后面，小写
  "（没说原因）": "(no reason given)",
  "目标达成": "Goal achieved",
  "目标达成：{verify} 通过": "Goal achieved: {verify} passed",
  "验证没过：{verify}（{status}）": "Check didn’t pass: {verify} ({status})",
  "失败": "Failed",
  // ExitPlanMode
  "你不在，计划等你回来审": "You’re away. The plan will wait for your review.",
  "超时没人审，计划保持未批准": "Timed out. Plan not approved",
  "没等到决定，这一轮先结束了": "The turn ended before a decision",
  "转到新会话实施": "Handed off to a new session",
  "已批准，接着执行": "Approved. Proceeding.",
  "被退回修改": "Sent back for changes",
  // AskUserQuestion：模型没给小标题时的默认
  "问题 {n}": "Question {n}",

  // ── 目标续跑：暂停 / 达成的原因（goal.ts、session.ts）─────────────────────────
  "你按了停止": "You stopped it",
  "服务重启打断了这一轮": "A service restart interrupted this turn",
  "这一轮出错：{summary}": "This turn failed: {summary}",
  "需要你：{need}": "Needs your input: {need}",
  "连续 {n} 轮没有动手": { one: "No action for 1 turn", other: "No action for {n} turns in a row" },
  "轮数用完（{n} 轮）": { one: "Turn limit reached (1 turn)", other: "Turn limit reached ({n} turns)" },
  "时长用完（{n} 分钟）": "Time limit reached ({n} min)",
  // dimensio 各处「服务重启」都叫 service restart（hx-state 同）
  "服务重启了，目标先暂停——点「继续」接着做": "The service restarted, so the goal is paused. Tap “Continue” to pick it up again.",
  "服务要重启，目标先暂停": "The service is about to restart, so the goal is paused",
  "正在回滚，目标先暂停": "Rewinding, so the goal is paused",
  "没能起下一轮": "Couldn’t start the next turn",
  "你暂停了": "You paused it",
  "达成：{summary}": "Achieved: {summary}",
  "达成：{verify} 通过": "Achieved: {verify} passed",
  "模型声明达成（没有验证命令）": "The model says it’s achieved (no verify command)",

  // ── 检查点名字（回滚面板）──────────────────────────────────────────────────
  "执行 {cmd} 之前": "Before running {cmd}",
  "回滚前现场（要撤销回滚，就回滚到这里）": "Before rewind (rewind here to undo that rewind)",
  "改写前现场（要撤销改写，就回滚到这里）": "Before edit (rewind here to undo the edit)",
  "撤销文件前现场（要找回，就回滚到这里）": "Before revert (rewind here to get the files back)",
  // 检查点面板把这三种拆成「小标签 + 括号里的说明」分开显示（CheckpointsSheet 的 special()），两半各自成键；小标签要短
  "回滚前现场": "Before rewind",
  "改写前现场": "Before edit",
  "撤销文件前现场": "Before revert",
  "要撤销回滚，就回滚到这里": "Rewind here to undo that rewind",
  "要撤销改写，就回滚到这里": "Rewind here to undo the edit",
  "要找回，就回滚到这里": "Rewind here to get the files back",
  "（服务重启后自动续跑）": "(Auto-resumed after a service restart)",
  "（目标第 {n} 轮）": "(Goal · Turn {n})",

  // ── 会话标题（服务端起的名字、列表里的占位条目）───────────────────────────────
  "附件：{name}": "Attachment: {name}",
  "引用：{title}": "Reference: {title}",
  "接续：{title}": "Continued: {title}",
  "实施：{title}": "Implement: {title}",
  "对话": "Chat",
  "计划": "Plan",
  "[已从检查点恢复] {title}": "[Restored from checkpoint] {title}",
  "[只读·新版本 v{version}] {title}": "[Read-only · newer version v{version}] {title}",
  "（会话文件已损坏：{what}，没有可恢复的检查点副本）": "(Session file is corrupt: {what}. No checkpoint copy to restore from.)",
  "（会话文件这会儿读不了：{code}，稍后再试）": "(Can’t read the session file right now: {code}. Try again later.)",

  // ── 会话 / 运行的 HTTP 报错 ─────────────────────────────────────────────────
  "服务正在重启（部署中），这一条没有发出；稍后再发":
    "The service is restarting (deploying). This message wasn’t sent. Send it again in a moment.",
  "会话文件这会儿读不了（{code}），稍后再试": "Can’t read the session file right now ({code}). Try again later.",
  "这个会话由更新版本的 dimensio 写入（记录版本 v{version}，本版本只认到 v{max}），这里只能只读查看；要继续它，请换回新版本。":
    "This session was written by a newer version of dimensio (record v{version}; this version reads up to v{max}). It’s read-only here. Switch back to the newer version to continue it.",
  "这个对话用的自定义模型服务已经删掉了——在「模型服务」里换一家，开新对话接着做。":
    "The custom provider this chat used has been deleted. Choose another provider and continue in a new chat.",
  "当前模型不支持原生音频，请切换到 MiMo 后重新发送。": "The current model doesn’t support audio input. Switch to MiMo and send again.",
  "音频 {name} 超过 24 MB，请压缩为 MP3/FLAC 或分段后发送。":
    "Audio {name} is over 24 MB. Compress it to MP3/FLAC or split it before sending.",
  "本条消息的音频总计超过 32 MB，请分批发送。": "The audio in this message is over 32 MB in total. Send it in smaller batches.",
  "终端数量已达上限": "Terminal limit reached",
  "文件不存在": "File doesn’t exist",
  "git diff 失败": "git diff failed",

  // ── 自定义模型服务（custom-providers.ts、index.ts）─────────────────────────────
  "这台服务器不允许添加自定义模型服务": "This server doesn’t allow custom providers",
  "请填写接口地址": "Enter a base URL",
  "接口地址格式不对": "Invalid base URL",
  "接口地址只支持 http / https": "Base URL must use http or https",
  "接口地址里别带账号密码，API key 单独填": "Don’t put a username or password in the base URL. Enter the API key separately.",
  "接口地址太长": "Base URL is too long",
  "API key 被拒绝（HTTP {status}）": "API key rejected (HTTP {status})",
  "模型列表取不到（HTTP {status}）": "Couldn’t get the model list (HTTP {status})",
  "接口没有返回 JSON——地址是不是少了 /v1？": "The endpoint didn’t return JSON. Is /v1 missing from the URL?",
  "接口没列出任何模型": "The endpoint didn’t list any models",
  "连接超时（12 秒没有响应）": "Connection timed out (no response in 12 sec)",
  "连不上：{reason}": "Couldn’t connect: {reason}",
  "连不上这个接口": "Can’t reach this endpoint",
  "最多添加 {n} 个自定义服务": { one: "You can add only 1 custom provider", other: "You can add up to {n} custom providers" },
  "请填写 API key": "Enter an API key",
  "API key 没能加密保存：{reason}": "Couldn’t encrypt and save the API key: {reason}",
  "这个自定义服务不存在（可能已被删除）": "This custom provider doesn’t exist (it may have been deleted)",

  // ── 项目 / 工作空间（projects.ts、tenant.ts、index.ts）─────────────────────────
  "项目名称不能为空": "Enter a project name",
  "项目名称不能超过 80 个字符": "Project name can’t be longer than 80 characters",
  "项目名称包含不能用于文件夹的字符": "Project name contains characters that can’t be used in a folder name",
  "这个名称是系统保留名称": "This name is reserved by the system",
  "缺少项目路径": "Project path is missing",
  "“{name}”文件夹已存在，请用“使用现有文件夹”导入": "A folder named “{name}” already exists. Import it as an existing folder instead.",
  "所选工作空间不是有效文件夹": "The selected workspace isn’t a valid folder",
  "快照桶不能作为项目导入": "A snapshot workspace can’t be imported as a project",
  "快照对话不参与置顶/隐藏": "Snapshot chats can’t be pinned or hidden",
  // 租户实例的越界报错：{what} 只有这四种（tenant.ts assertInTenant 的调用方），逐个成键——「工作区」在这里是工作空间文件夹，不是侧边面板
  "路径超出了你的工作空间：{path}": "Path is outside your workspace: {path}",
  "工作区超出了你的工作空间：{path}": "Folder is outside your workspace: {path}",
  "项目文件夹超出了你的工作空间：{path}": "Project folder is outside your workspace: {path}",
  "目录超出了你的工作空间：{path}": "Folder is outside your workspace: {path}",

  // ── 卡片落定在哪台设备（DecidedBy.label 的服务端取值；客户端自报的手机 / 平板 / 电脑由 lib/client-id.ts 处理）──
  // 只嵌在「在{label}上」（hx-lib-shell：on {label}）里、卡片标题「已拒绝 · on …」的句中，所以小写
  "另一台设备": "another device",
  "无头调用": "a headless client",

  // ── 记忆 / 召回 ────────────────────────────────────────────────────────────
  "全局": "Global",
  "快照对话": "Snapshot chat",
  // 召回理由（knowledge-search.ts；界面取前两条、用「；」连——第二条另起「{a}；…」键，{a} 会再过一遍 tr()）
  "意思相近": "Similar meaning",
  "无查询词，按当前性与类型列出": "No query, listed by status and type",
  "标题精确匹配": "Exact title match",
  "标题包含查询词": "Title contains the query",
  "路径精确匹配": "Exact path match",
  "路径匹配": "Path match",
  "scope 精确匹配": "Exact scope match",
  "scope 匹配": "Scope match",
  "标题命中 {n} 个词": { one: "1 word in title", other: "{n} words in title" },
  "路径命中 {n} 个词": { one: "1 word in path", other: "{n} words in path" },
  "scope 命中 {n} 个词": { one: "1 word in scope", other: "{n} words in scope" },
  "正文命中 {n} 个词": { one: "1 word in body", other: "{n} words in body" },
  "路径过滤命中 {path}": "Path filter matched {path}",
  "scope 过滤命中 {scope}": "Scope filter matched {scope}",
  "语义相似 {score}": "Semantic similarity {score}",
  "{a}；路径精确匹配": "{a}; exact path match",
  "{a}；路径匹配": "{a}; path match",
  "{a}；scope 精确匹配": "{a}; exact scope match",
  "{a}；scope 匹配": "{a}; scope match",
  "{a}；标题命中 {n} 个词": { one: "{a}; 1 word in title", other: "{a}; {n} words in title" },
  "{a}；路径命中 {n} 个词": { one: "{a}; 1 word in path", other: "{a}; {n} words in path" },
  "{a}；scope 命中 {n} 个词": { one: "{a}; 1 word in scope", other: "{a}; {n} words in scope" },
  "{a}；正文命中 {n} 个词": { one: "{a}; 1 word in body", other: "{a}; {n} words in body" },
  "{a}；路径过滤命中 {path}": "{a}; path filter matched {path}",
  "{a}；scope 过滤命中 {scope}": "{a}; scope filter matched {scope}",
  "{a}；语义相似 {score}": "{a}; semantic similarity {score}",

  // ── MCP 连接器状态（mcp.ts）────────────────────────────────────────────────
  "凭据解不开（{reason}）": "Couldn’t decrypt credentials ({reason})",
  "找不到扩展目录": "Can’t find the extensions folder",

  // ── 模型目录（catalog.ts：型号标签、备注；思考档只有开 / 关的型号用 effortLabels）────────────
  // 厂商名「本机」与思考档「关闭 / 开启」是通用词：显示处分别按语境取（本机 → Local；开关值用 tc('开关', …)），这里不收裸键
  "开关::关闭": "Off",
  "开关::开启": "On",
  "V4 Pro（退役中）": "V4 Pro (retiring)",
  "新主力 · 1M 上下文": "Latest main model · 1M context",
  "上一代主力 · 复杂 agent 编码": "Previous main model · Complex agentic coding",
  "均衡 · 新一代 Sonnet": "Balanced · Latest Sonnet",
  "旗舰 · 自适应思考": "Flagship · Adaptive thinking",
  "长程 agent · 高清视觉": "Long-running agents · High-res vision",
  "均衡": "Balanced",
  "极速 · 传统思考预算": "Fastest · Classic thinking budget",
  "V4.1 · 原生视觉 · 1M ctx": "V4.1 · Native vision · 1M ctx",
  "09-14 起转发至 V4.1 Flash": "Routed to V4.1 Flash since Sep 14",
  "旗舰 2.4T · 图/视频 · 1M ctx": "Flagship 2.4T · Image/video · 1M ctx",
  "多模态快模 · 1M ctx": "Fast multimodal · 1M ctx",
  "旗舰": "Flagship",
  "均衡 · 多模态": "Balanced · Multimodal",
  "轻量快": "Light and fast",
  "旗舰 · 恒思考 · 1M ctx": "Flagship · Always-on thinking · 1M ctx",
  "多模态 · 1/40 价 · 1M ctx": "Multimodal · 1/40 the price · 1M ctx",
  "Coding/长程 · 1M ctx": "Coding/long-running · 1M ctx",
  "旗舰 · 1M ctx · 恒思考": "Flagship · 1M ctx · Always-on thinking",
  "旗舰 · 256k · 不吃视频": "Flagship · 256k · No video input",
  "编码特化 · 1M ctx · 预览": "Coding-tuned · 1M ctx · Preview",
  "极速 ≈180 tok/s": "Fastest ≈180 tok/s",
  "旗舰 · 图/视频/音频 · 1M ctx": "Flagship · Image/video/audio · 1M ctx",
  "极速 · 需单独 API 权限 · 10× 单价": "Fastest · Needs separate API access · 10× price",
  "高效 · 图/视频/音频 · 1M ctx": "Efficient · Image/video/audio · 1M ctx",
  "最新 Flash · 1M ctx": "Latest Flash · 1M ctx",
  "旗舰 Pro": "Flagship Pro",
  "稳定 · 可关思考": "Stable · Thinking optional",
  "本机 · 离线可用 · 视觉": "Local · Works offline · Vision",
  "本机 · 离线可用": "Local · Works offline",
};
