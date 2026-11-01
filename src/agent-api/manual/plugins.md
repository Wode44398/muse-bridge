# 插件（功能扩展）

bridge 的功能都是插件：内置功能（定时任务、分享链接、设备、手机操控、内置浏览器、共享终端……）是默认开着的一组，Gemini / ChatGPT / dimensio 三个 agent 扩展也在同一张表里，第三方插件装进来和它们平起平坐。用户在「设置 › 扩展 › 功能扩展」里逐项开关、改配置、装插件；你用 `plugins.*` 操作做同样的事（只有服务器主机能用）。

## 看状态、开关、改配置

- `plugins.list`：每个插件的 status（active 在跑 / disabled 关着 / blocked 缺依赖 / error 出错）、enabled、restart（改了要重启服务端）、pendingRestart、schema 与 config。
- `plugins.toggle {id, enabled}`：热插件当场生效（接口、Claude 工具、后台任务一并挂上 / 摘下）；restart 插件落盘后等重启。关掉用户正在用的功能前先问。
- `plugins.config {id, config}`：先 `plugins.list` 取当前 config，改完整体传回（没传的项回到默认值）；secret 项传打码串「••••••••」= 沿用旧值；错一项整体拒，错误里写着哪一项。
- 关着的内置功能，它的接口、Claude 工具、agent 操作都不在；对应手册章节在目录里会注明「这台服务器关着这项功能」。
- `plugins.status {id, logs?}`：插件自报的状态块、托管的子进程（带 logs=子进程名 附日志尾巴）、入站回调地址、动作按钮；`plugins.action {id, action}` 按按钮。
- `plugins.install_github {repo}` 从 GitHub 装（只装用户点名、信得过的仓库，先确认）；`plugins.check_update {id}` 看有没有新版。
- 官方插件市场：`plugins.market` 看有哪些、哪些有更新；`plugins.market_install {id, version?}` 装 / 更新（用户没点名要装时先确认）；
  `plugins.rollback {id}` 回退到上一版；`plugins.restore_builtin {id}` 内置功能换回内置版。详见下面「插件市场」。
- 授权字段（`type:"user"` + `grant:"chat"`）新选了服务器主机或 Pro 档账号时，`plugins.config` 要带 `confirmGrant: true`——先问用户。

{{ops:plugins}}

## 给用户写一个插件

用户想要的能力 bridge 没有时（接一个内部系统、加一个 Claude 工具、定时同步某个数据、做个 QQ / 微信机器人……），直接写成插件。
只有服务器主机能建插件（插件和 bridge 同进程、权限相同）；成员问起就说明要主机来装。

1. **建骨架**：调 `plugins.scaffold {id, name?, description?, panel?, from?}`。缺省在你工作空间下建 `plugins-dev/<id>/` 并登记启用；
   `panel: true` 带一个控制面板页面；`from: "hello-world"` / `from: "qq-onebot"` 拿示例整个当起点（id 自动换成新的）。返回目录与文件清单。
2. **改代码**：照本章下面的参考改 `bridge-plugin.json`（名字、配置 schema、`ui`）和 `index.mjs`（`apply(ctx, config)`），用你的文件工具直接写。
3. **重新加载**：`plugins.reload {id}`，不用重启服务；返回的 `plugin.status` 不是 active 时看 `plugin.error` 修（语法错、apply 抛错都写在那）。
4. **试**：插件的接口用 curl / 内置浏览器调；有面板就让用户去设置里「插件」组点开看；`plugins.status {id}` 看状态块、子进程、回调地址、定时任务；
   `plugins.status {id, logs: "plugin"}` 看插件自己的日志（ctx.log / warn / error，也在详情页「日志」里）。详情页的「清单体检」提示（拼错的字段、用了内部接口……）要修掉。
   插件给 Claude 的工具**要下一条消息才出现**（工具集在这一轮开始时就定了），告诉用户「发下一条消息就能用」。
5. **交付**：告诉用户插件在哪、怎么开关、设置里要填什么；要给别人用就把目录打成 zip（设置 › 功能扩展 › 添加 › 上传 zip），或放到 GitHub 用「GitHub 地址」装。

两个示例的完整代码就在程序目录 `src/plugins/examples/` 下（`hello-world` 最小；`qq-onebot` 用到以账号跑 Claude、收外部推送、托管外部程序、分组表单、状态块、控制面板），不知道某个能力怎么写时先读对应示例。
聊天平台机器人（QQ、微信、飞书、Telegram……）的完整写法参考官方插件「QQ 机器人」（qqchatbot）：每个聊天一个沙箱、群聊记录、单轮工具发文件、看门狗、每日上限、热更新设置。

## 接口版本与兼容承诺

**公共接口只有三样**：`apply(ctx, config)` 拿到的 `ctx`、清单 `bridge-plugin.json`、页面 SDK `/plugins/_sdk/bridge-plugin.js`。本章写到的都在承诺范围内。

- 现在是**插件接口 v3**（`ctx.api === 3`）。新插件在清单写 `"engines": { "pluginApi": 3 }`；没写的按 v2 对待（区别只有一处：v2 的 `ctx.files.put` 同步返回路径，v3 返回 Promise）。
- **只做加法**：以后加能力不升版本号，用 `ctx.has('能力名')` 探测（如 `ctx.has('chat.sandbox')`）。真要破坏性改动才升 v4，并且 v3 的写法至少再支持一个大版本。
- `@bridge/core/*` 是**内部接口**：能 import（应急用），但不承诺兼容，bridge 升级可能改掉；插件用了会在详情页「清单体检」里标出来，官方插件市场不收。能用 ctx 做的就别碰它，缺什么能力告诉 bridge 维护者加进 ctx。
- 新接口一律返回 Promise、参数与返回值都能 JSON 化（回调函数除外）——给以后把插件挪进独立进程留路。

能力名（`ctx.has` 认的，不是 agent 接口操作）：

```
chat  chat.sandbox  chat.tools  chat.format  chat.history  chat.usage  chat.budget  chat.fast
files  files.rw  share.space  share.chat  process  process.health  webhook  schedule  notify  log.view
config.hot  config.self  status  action  configOptions  store  panel  panel.config  process.args  sandbox.readDirs  claude.tool  claude.prompt  claude.mcp  agentOp  manual
```

## 插件目录

```
weather/
├─ bridge-plugin.json    清单（必需）
├─ index.mjs             入口（必需，清单 entry 可改名）
├─ lib/…                 随意拆文件，相对路径 import
├─ web/index.html        插件页面（可选，见「插件页面」）
├─ locales/en.json       英文界面的词条（可选，见「英文界面」）
└─ README.md
```

### 清单 bridge-plugin.json

| 字段 | 说明 |
|---|---|
| `id` | 必填。小写字母开头，只用小写字母、数字、连字符，≤48 字。决定接口前缀、Claude 工具名、数据目录 |
| `name` / `description` / `version` / `author` / `homepage` | 展示用 |
| `entry` | 入口文件，缺省 `index.mjs` |
| `config` | 配置 schema（见下），设置页据此自动生成表单 |
| `requires` | 依赖的插件 id 列表：依赖没开时本插件记成「缺依赖」，依赖开了自动跟上；关掉依赖会先停掉本插件 |
| `restart` | `true` = 运行中不热插拔（开关、改配置、换版本都等重启服务）。只有包着不能撤销的东西时才用 |
| `defaultEnabled` | 缺省 `true`；`false` 装上后先不启用 |
| `ui` | 插件页面：`{ "panel": { "page": "web/index.html", "title": "控制台", "icon": "chat" }, "settings": "web/settings.html", "who": "host" }`（见「插件页面」）；旧写法 `web.page` 等同 `ui.panel.page` |
| `engines` | 兼容要求：`{ "bridge": ">=7.02", "pluginApi": 3 }`。不满足就拒装、拒加载并说明原因。写法：`>= > <= < =`、`^`（同主版本）、`~`（同主次版本）、空格 = 且、`\|\|` = 或 |
| `permissions` | 这个插件会用到的能力（展示用，不强制）：`chat`（以授权账号跑 Claude）、`sandbox`（在插件自己的沙箱里跑 Claude）、`claude.tools`、`files`、`share`、`process`、`webhook`、`network`、`notify`、`schedule`、`routes`。详情页按人话列给用户看 |

清单里写了不认识的字段（多半是拼错）、不认识的 `widget`、没写 `engines.pluginApi`、代码里 import 了 `@bridge/core/*`，详情页「清单体检」都会提示，不影响安装。

### 入口

```js
export function apply(ctx, config) {
  // 在这里登记：接口、Claude 工具、agent 操作、定时器……
  // 也可以 return 一个函数，停用时调用
}
```

也认 `export default { apply(ctx, config) {}, config: {…} }`（配置 schema 写在代码里时）。

第三方 npm 包：插件目录自带 `node_modules`；找不到时回落到 bridge 自己的依赖（sharp、MCP SDK 等不用再装一份）。
bridge 内部模块（`@bridge/core/…` = 程序的 `src/`）技术上能 import，但属于内部接口、不承诺兼容（见「接口版本与兼容承诺」）。

### 配置怎么生效

- 缺省：用户改了配置，插件整个重启（先撤掉旧的，再按新配置 `apply` 一遍）——进行中的 Claude 对话、子进程都会被停掉。
- **登记 `ctx.onConfig((next, prev) => …)` 就不重启**：只调它，`ctx.config` 换成新值。返回 `false`（或抛错）= 这次还是整个重启（比如改了端口、要重新拉起子进程）。
  apply 的第二个参数是**启用那一刻**的配置——登记了 onConfig 就从 `ctx.config` 读，或在回调里更新自己的变量。
- `await ctx.setConfig(patch)`：插件改**自己**的配置（合并进当前配置、按 schema 校验、落盘、走同一条生效路）。群里发「暂停」、面板上的开关都用它。
  apply / onConfig 里别 await 它（会等自己，直接报错）。
- `ctx.meta.previousVersion`：上一次成功启用时的版本号（第一次装是 `null`），升级时据此迁移数据。

## 配置 schema

与 agent 接口操作的参数同一套写法：

```json
"config": {
  "city":    { "type": "string",  "label": "默认城市", "default": "上海", "max": 40 },
  "units":   { "type": "string",  "label": "单位", "enum": ["metric", "imperial"], "default": "metric" },
  "refresh": { "type": "integer", "label": "刷新间隔（分钟）", "default": 30, "min": 5, "max": 1440 },
  "apiKey":  { "type": "string",  "label": "API Key", "secret": true, "required": true },
  "verbose": { "type": "boolean", "label": "详细日志", "default": false }
}
```

- `type`：string / integer / number / boolean / array / object / map / user。
- `secret: true`：对外一律显示打码串，回传打码串 = 沿用旧值（只对顶层字段）。
- `pattern`：字符串要匹配的正则。

表单相关（服务端只透传，设置页据此排版）：

| 字段 | 作用 |
|---|---|
| `section` | 分组标题，同组字段排在一起（按第一次出现的顺序） |
| `when` | 条件显示：`{ "mode": "managed" }`、`{ "mode": ["a", "b"] }` |
| `widget` | `textarea` / `password` / `slider`（要 min、max）/ `chips` / `segmented` |
| `options` | 动态选项：`claude.models`、`claude.efforts`、`users`、`users:user`（只列普通档）、`users:service`，或 `plugin`（插件用 `ctx.configOptions` 现算） |

结构化字段：

```json
"allowGroups": { "type": "array", "items": { "type": "string", "pattern": "^\\d+$", "options": "plugin" }, "max": 200 },
"groups": { "type": "map", "key": { "label": "群号", "options": "plugin" },
            "value": { "enabled": { "type": "boolean", "default": true }, "effort": { "type": "string", "options": "claude.efforts" } } },
"box":    { "type": "object", "fields": { "a": { "type": "integer", "default": 1 } } },
"runAs":  { "type": "user", "grant": "chat", "options": "users:user", "required": true }
```

- `array` + `items`：逐行增删的列表；`items` 是带 `fields` 的 object 时每行一个小表单。
- `map`：按键编辑的表（键是字符串，`key.pattern` 约束格式）；`value` 写一个字段 spec，或直接写一组子字段。
- `user`：选一个 bridge 账号（值是登录名）。`grant: "chat"` = **选中即授权**插件以这个账号跑 Claude（见 `ctx.chat`）；
  `allowHost: true` 才能选服务器主机本人。新授权主机本人或 Pro 档账号时设置页会再要一次确认。
- 存着的值坏了（比如升级后改了 schema）会退回默认值并在详情里提示，不会让插件起不来。
- 改配置后热插件当场按新配置重启（先撤掉旧的，再 `apply` 一遍）；登记了 `ctx.onConfig` 就只热更新、不重启（见「配置怎么生效」）。

## ctx 参考

登记的东西都会在**停用 / 改配置 / 重新加载**时按相反顺序自动撤销。

### 基础

| | |
|---|---|
| `ctx.id` / `ctx.config` / `ctx.meta` | 插件 id、生效配置（只读，热更新后换新值）、清单信息（`meta.version`、`meta.pluginApi`、`meta.previousVersion`） |
| `ctx.api` / `ctx.has(name)` | 插件接口版本（3）/ 这台 bridge 有没有某项能力（见「接口版本与兼容承诺」） |
| `ctx.log()` / `ctx.warn()` / `ctx.error()` | 日志：进服务端控制台，也进插件自己的日志（详情页「日志」、`plugins.status {logs:'plugin'}`；内存留最近 500 条，第三方插件另落盘 `<数据目录>/logs/plugin.log`） |
| `ctx.onConfig(fn)` / `await ctx.setConfig(patch)` | 配置热更新 / 插件改自己的配置（见「配置怎么生效」） |
| `ctx.dataDir` | 插件自己的数据目录 `<数据根>/plugin-data/<id>/`（已建好）。卸载插件不删它 |
| `ctx.setTimeout` / `ctx.setInterval` | 停用时自动清掉 |
| `ctx.effect(fn)` | 运行 `fn`，它返回的撤销函数（或带 `dispose` / `close` 的对象）停用时调用 |
| `ctx.onDispose(fn)` | 停用时调用 |
| `ctx.when('ready' \| 'listening', fn)` | 到了那个阶段再跑（插件晚于那个阶段启用就当场跑）；fn 可返回撤销函数 |
| `ctx.runtime` | `{ production, noAuth, port, dataRoot, programRoot }`。后台任务一般只在 `production` 实例跑 |

### 接口

| | |
|---|---|
| `ctx.route(method, path, handler)` | 精确路径；`handler(req, res, url)`。建议放在 `/api/plugin/<id>/` 下。已被占用的路径会报错 |
| `ctx.router.use(fn)` / `ctx.router.prefix(method, prefix, handler)` | 中间件 / 前缀路由 |
| `ctx.http.user(req, res)` | 要求登录（主机或成员），返回身份上下文；失败已回 401 并返回 `null` |
| `ctx.http.host(req, res)` | 要求服务器主机（旧名 `ctx.http.admin` 同一个） |
| `ctx.http.json(res, status, obj)` / `ctx.http.text(…)` | 回响应 |
| `await ctx.http.body(req)` | 读 JSON 请求体 |
| `ctx.bus.publish(key, event)` / `ctx.bus.publishAll(event)` | 往在线页面的实时总线推事件 |

### 给 Claude

```js
ctx.claude.tool({
  name: 'forecast',                      // 模型看到 mcp__<插件 id>__forecast
  description: '查某个城市未来三天的天气',
  params: { city: { type: 'string', required: true, desc: '城市名' } },
  access: 'read',                        // read 免审批；缺省 write（按会话的权限模式审批）；danger
  who: 'host',                           // 缺省只给服务器主机本人的会话；'members' 成员也给
  when: (turn) => turn.kind === 'chat',  // 可选：按这一轮决定给不给
  handler: async ({ city }, turn) => `${city}：晴`,   // 返回字符串 / 对象（转 JSON）/ MCP 结果
});
ctx.claude.prompt('一段系统提示');        // 或 (turn) => 字符串；缺省只给主机的会话
ctx.claude.mcp('my-server', (turn) => ({ type: 'stdio', command: 'node', args: ['server.js'] }));   // 挂现成 MCP
```

`turn`：`{ kind: 'chat' | 'routine' | 'plugin', ctx（身份上下文：kind、cwd、sandbox…）, snap, message, sessionId, getGen() }`。
快照访客和插件沙箱永远拿不到这些常驻工具。工具集在 Claude 进程起来时定下，插件开关 / 重载后下一条消息自动换新。
只想给**插件自己发起的那一轮**加工具（机器人「发图到群里」之类），用 `ctx.chat.run({ tools })`，见下。

### 给 agent 接口与手册

```js
ctx.agentOp({ name: 'status', title: '一句话', desc: '详细说明', params: {…}, access: 'read', handler: async (who, args) => ({…}) });
ctx.manual('manual');   // 插件目录下 manual/*.md 并入 bridge 项目手册
```
操作名自动加前缀成 `<id 把连字符换成下划线>.status`，同时出现在 `/agent/v1/…`、手册的接口目录和 bridge 里 Claude 的 bridge 工具里。

### 插件之间

| | |
|---|---|
| `ctx.provide(name, value)` | 提供一个服务（插件停用时撤掉） |
| `ctx.service(name)` | 取服务（不存在抛错）。要用别的插件的服务，就在清单 `requires` 里写上它 |
| `ctx.on(event, fn)` / `ctx.emit(event, payload)` | 插件之间的事件 |

## 以某个身份做事（ctx.chat / sandbox / files / share）

插件要「替某个人问 Claude」时（QQ / 微信 / 邮件机器人、工单自动回复……），不用登录、不用自己调 `/api/chat`。先选身份 `as`：

- **沙箱**（多数机器人用这个）：`const ws = ctx.sandbox('g774176839')`。每个名字一个独立工作区 `<数据目录>/sandboxes/<名字>/`：
  没有命令行、只能读写自己的目录、碰不到主机文件和别的沙箱；不用建账号、不用开多用户。`ctx.sandbox(名字, { web: false })` 连网也关掉。
  用的是服务器的 Claude 登录 / 号池，不记任何账号的额度——用量由核心按插件记账（下面的 `ctx.chat.usage`），上限用 `ctx.chat.configure({ daily })` 设。
  名字：字母或数字开头，只用字母、数字、`_ . -`，≤80 字。简写 `{ sandbox: '名字' }` 等同句柄。`ctx.sandbox.list()` 列出建过的。
  **只读资料目录**：`ctx.sandbox('g1', { readDirs: ['D:/kb', { dir: 'E:/project', hide: ['memory', 'secrets'] }] })`——沙箱里的 Claude 能用 Read / Glob / Grep 查阅这些主机目录（绝对路径），写不了；
  像密钥的文件名（config.json、*.pem、token、.env…）和 `hide` 里的子路径一律不给读，搜索的目录里含着 hide 项也拒（让它往具体子目录搜）。核心会在系统提示里告诉 Claude 有哪些资料目录。
  资料对能跟机器人说话的所有人都可读——别挂含私密内容的目录。最多 8 个，不存在的跳过。
- **账号**：设置里 `type:'user'` + `grant:'chat'` 字段选过的账号（`as: config.runAs`），Claude 在那个账号的工作区里、按它的档位和额度干活。
  多用户模式关着时只能用「服务账号」。

```js
const ws = ctx.sandbox('g774176839');
const turn = ctx.chat.run({
  as: ws,                      // 沙箱句柄，或授权的账号名
  session: 'main',             // 可选，缺省 'default'：插件自己起的会话键，核心记下真实会话，下次同键自动续写
  message: '【小明】今天天气怎么样',
  attachments: [await ws.put(imageBuffer, 'a.jpg')],   // 可选：图片直接给 Claude 看
  model, effort, fast: true,   // 可选，缺省跟 bridge 默认；fast = 快速模式（支持的模型才生效）
  format: 'plain',             // 可选：聊天软件不渲染 Markdown——核心注入统一的纯文本提示（写进文件的不受限）
  prompt: '你在 QQ 群里答问…', // 可选：追加的系统提示
  tools: [{                    // 可选：只在这一轮可用的工具（沙箱也给），模型看到 mcp__<插件 id>__send_file
    name: 'send_file', description: '把文件发进当前聊天', params: { path: { type: 'string', required: true } },
    handler: async ({ path }, turn) => { … },   // turn = { plugin, as, session, from, sessionId }
  }],
  from: { id: '42', name: '小明', role: 'admin' },   // 可选：提问人（传给工具的 turn.from）
  label: 'QQ · 某群',          // 可选：会话列表里的来源标签
});
for await (const ev of turn.events) { /* queued / start / text / tool / note / done */ }
const { ok, code, text, notes, files, sessionId, usage } = await turn.result;
turn.stop();
```

结果：`text` 是干净的回答（模型侧的通知——比如安全栅门换了模型——单独在 `notes` 里，别发给外人）；`files` = 回答里链接到的真实文件；
`usage = { costUsd, durationMs }`；`code`：`ok` / `cancelled`（stop 了）/ `quota`（账号额度用完）/ `budget`（插件每日上限）/
`session_lost`（记着的会话找不到，已自动开新对话重试仍失败）/ `engine`（Claude 出错，`text` 是原因）/ `disabled`（插件停用了）。`isError` = `!ok`（旧写法）。

- 执行器与定时任务同一份：沙箱围栏、额度、计费、号池换号照常生效；**无人值守**：不出审批卡（工具按身份档位直接放行或拒绝）、
  提问直接取消、不进计划模式；不会顶掉这个账号在前端正在进行的对话。
- 排队由核心做：同一个 `(身份, session)` 串行；同一账号最多 2 路，所有沙箱合用 2 路（`ctx.chat.configure({ maxParallel: 1..4 })`）。
- `ctx.chat.configure({ daily: { turns, costUsd } })`：每日上限（0 = 不限），到了直接回 `code: 'budget'`。
- `ctx.chat.usage()` → `{ today: { turns, costUsd }, total, days: [{ day, turns, costUsd }], byKey }`。用过 ctx.chat 的插件，详情页自动有「用量」块。
- `await ctx.chat.history(as, session, { limit })` → 这段会话的转录 `[{ role, text, ts, attachments?, tools? }]`（控制台用）。
- `ctx.chat.reset(as, session)` 忘掉记着的会话（下次开新对话）；`ctx.chat.sessionOf(as, session)` 查真实会话 id；`ctx.chat.running` 在跑 / 排队的轮数。

文件（`as` 同上；路径都相对工作区根，越界报错，`.bridge/` 不能写）：

| | |
|---|---|
| `await ctx.files.put(as, buffer, name)` | 存进上传目录，返回绝对路径（能当 `attachments`）。v2 插件同步返回 |
| `await ctx.files.write(as, rel, data)` / `append(as, rel, text)` | 写 / 追加文件（目录自动建），返回绝对路径 |
| `await ctx.files.read(as, rel, { encoding? })` | 读（不给 encoding 返回 Buffer） |
| `await ctx.files.list(as, rel?)` / `remove(as, rel)` | 列目录 `[{ name, dir, size, mtime }]` / 删文件或文件夹 |
| `ctx.files.root(as)` / `ctx.files.path(as, rel)` | 工作区根目录 / 某个相对路径的绝对路径 |
| 沙箱句柄 | 同一套方法不用传 as：`ws.put / write / append / read / list / remove / path`、`ws.dir`；`await ws.wipe()` 清空整个沙箱 |

分享：

| | |
|---|---|
| `await ctx.share.space(as, paths)` | 把工作区里的文件 / 文件夹做成公开只读在线工作空间，返回 `{ url, path, token, expiresAt }`（要开着「分享链接」） |
| `await ctx.share.chat({ note })` | 铸一个公开的**快照对话页** `/c/<token>`：拿到链接的人在网页上和 Claude 单独聊（隔离工作区、闲置自动销毁，用服务器主机的额度）。返回 `{ url, path, token }`（`url` 要配了公网地址才有；要开着「快照对话」） |
| `await ctx.share.chats()` / `await ctx.share.chatLog(token)` / `ctx.share.forgetChat(token)` | 这个插件铸过的快照（`live` 是否还开着）/ 某个快照的对话转录（快照销毁后读归档）/ 从登记簿删掉 |

## 外部程序、回调、定时、通知（ctx.process / webhook / schedule / notify）

```js
const p = ctx.process.spawn('napcat', {
  command: 'D:/napcat/node.exe', args: ['./index.js'], cwd: 'D:/napcat', restart: 'on-failure', maxRestarts: 5,
  // 可选：健康检查（看门狗）。进程活着但不干活时（QQ 掉线、端口不应答）连续 failAfter 次不过就按进程树重启；
  // 启动后 grace 内不判；重启 maxRestarts 次还不行就停在 unhealthy（进程留着），发 'unhealthy' { givenUp: true }
  health: { check: async () => (await probe()).online, every: 15_000, failAfter: 2, grace: 90_000, timeout: 8_000 },
});
p.on('exit', ({ code }) => …); p.on('unhealthy', ({ givenUp, error }) => …); p.on('healthy', () => …); p.on('state', (s) => …);
p.restart(); p.stop(); p.tail(100);   // p.state：starting / running / backoff / stopped / failed / unhealthy；p.info().health
// args / env 可以写成函数，每次（重新）启动时现算：args: () => ['./index.js', ...(qq ? ['-q', qq] : [])]——换了参数下次重启就生效，不用整个插件重启

ctx.webhook('onebot', async (req, res, { json, text, body }) => { const e = json(); … }, {
  verify: { loopbackOnly: true },          // 或 { secret, header } 、{ hmac: { secret, header, prefix, algo } }，可同时写
  maxBytes: 1_000_000, perMinute: 600, methods: ['POST'],
});                                         // → POST /hook/<插件 id>/onebot
```

- 子进程：停用 / 改配置 / 重载 / bridge 退出时按**进程树**收掉（Windows 用 taskkill /T，只杀自己登记的 pid）；pid 记在
  数据目录的 `.pids`，bridge 被硬杀时下次启动先清掉残留。崩了按 1s、2s、4s… 最长 60s 退避重启，稳定跑满 10 分钟清零；
  `.bat` / `.cmd` 自动套 `cmd /c`；不弹黑窗；日志在 `<数据目录>/logs/<名字>.log`（满 2MB 轮转）。状态与日志在设置页详情里看。
- 回调：没有 bridge 登录态的外部请求只能走这里，**必须声明校验**。`loopbackOnly` 只收本机直连——带隧道 / 代理头（cloudflared 也是从本机连进来的）
  一律拒。没回响应时自动回 200 `{}`。

```js
// 定时任务：比 setInterval 多三样——上次运行时间落盘、bridge 关机错过了开机补跑一次、状态（上次结果 / 下次时间）自动进详情页
const job = ctx.schedule('clean', { daily: '04:20', label: '清理旧图片' }, async ({ lastRun, catchUp }) => { … });
//   when：{ every: '30m' | '2h' | '1d' | 毫秒 }（最短 10 秒）、{ daily: 'HH:MM' }、{ cron: '0 4 * * 1-5' }（分 时 日 月 周，服务器本地时区）
//   另可加 immediate: true（每次启用先跑一次）、dev: true（开发实例也跑；缺省只在正式实例跑）、catchUp: false（错过了不补）
job.runNow(); job.info();

// 提醒服务器主机：在线界面弹提示 + 手机 App 通知栏；同一条 10 分钟内只发一次
ctx.notify({ title: 'QQ 掉线了', body: '到 WebUI 扫码', level: 'warn' });   // level：info / warn / error
```

- 定时任务抛错记进状态与插件日志，不影响下一次；上一次没跑完时到点的这次跳过。记录在 `<数据目录>/schedules.json`。

## 显示位（状态块、动作按钮、动态选项、store）

| | |
|---|---|
| `ctx.status(fn)` | 详情页顶部的状态块：`fn()` 返回 `{ tone: 'ok' \| 'warn' \| 'error' \| 'idle', text, items: [{ label, value }] }`（可 async）。`ctx.status.refresh()` 立刻重算并推给在线页面 |
| `ctx.action({ id, label, desc?, danger?, confirm?, handler(who, args) })` | 详情页按钮（也是 agent 接口 `plugins.action`）；返回字符串当结果提示 |
| `ctx.configOptions(field, fn)` | `options: "plugin"` 字段的选项：`fn(who)` 返回 `[{ value, label, desc? }]`。登记 `'groups'` 同时管 `'groups.$key'`，登记 `'list'` 同时管 `'list[]'` |
| `ctx.bus.toPage(type, payload)` | 推给插件自己的页面（SDK 里 `bridge.on(type, fn)` 收） |
| （自动） | 子进程（含健康）、回调地址、定时任务、用量（用过 ctx.chat 的）、插件日志、清单体检、能力声明，不用插件自己报 |
| `ctx.store` | `<数据目录>/store.json` 的键值存储：`get(k, 默认)` / `set(k, v)` / `delete(k)` / `all()`，防抖落盘、停用时写完 |

子进程与回调的状态自动并进状态块，不用自己报。

## 插件页面

`web/` 下的文件由 bridge 在 `/plugins/<id>/web/` 提供（插件开着才给）。清单 `ui` 声明放在哪：

- `ui` 的 `panel`：控制面板。设置侧栏（手机是设置首页）多一组「插件」，一个插件一行，点进去全幅显示。`title` 是行名，英文界面另用 `titleEn`（不给就照中文显示）。
- `ui` 的 `settings`：嵌在插件详情页、自动表单下面的自定义设置区（高度跟内容走）。
- `ui` 的 `who`：`host`（缺省，只有服务器主机看得到）/ `members`（成员也能开面板，接口里 `ctx.http.user` 拿到的就是成员自己）。

**页面跑在不透明源里**（服务端给插件页面加了 CSP `sandbox`，嵌入时还有 iframe sandbox）：读不到 bridge 的 cookie、localStorage，
碰不到主页面和桌面壳、手机 App 的原生接口——插件的信任止于服务器，不能顺着页面摸到使用者的设备。所以调接口要用 SDK：

```html
<link rel="stylesheet" href="/plugins/_sdk/bridge-plugin.css">
<script type="module">
  import { bridge } from '/plugins/_sdk/bridge-plugin.js';
  const info = await bridge.ready();                 // { pluginId, theme, lang, platform, mode: 'embed' | 'panel' | 'standalone' }
  const list = await bridge.json('chats');           // GET /api/plugin/<id>/chats（非 2xx 抛错，message = 接口的 error）
  await bridge.json('send', { text: 'hi' });         // 带第二个参数 = POST JSON
  const r = await bridge.fetch('raw', { method: 'POST', body: blob });   // 类 Response
  bridge.on('message', (p) => …);                    // ctx.bus.toPage('message', p)
  bridge.onStatus((s) => …);                         // 状态块更新
  bridge.toast('已保存'); await bridge.confirm({ title: '清空？', danger: true });
  img.src = await bridge.blobUrl('image?id=1');      // 要登录才拿得到的图片
  bridge.openExternal(url); bridge.back();
</script>
```

**面板就是控制台**：插件页面能直接改插件自己的设置、按详情页那些按钮，不用插件另写接口（只有服务器主机能用，成员打开的面板会被拒）：

```js
const { schema, config } = await bridge.config.get();   // 配置（secret 打码）与 schema
await bridge.config.set({ paused: true });               // 合并进当前配置、按 schema 校验；插件登记了 ctx.onConfig 就热更新、不打断进行中的事
const models = await bridge.options('model');            // 字段的选项（claude.models / users / ctx.configOptions…；表的子字段写 'groups.model'）
const acts = await bridge.actions();                     // ctx.action 登记的按钮
await bridge.action('probe');                            // 按一下（有 confirm / danger 的先弹确认）
const st = await bridge.status();                        // 状态块 + 子进程 + 定时任务 + 用量
const f = bridge.form(el, { fields?, exclude?, sections?, onChange? });   // 在页面里画一份设置表单：按清单 schema 生成，改了即存
```

`bridge.form` 支持开关、文字 / 多行 / 密码、数字、枚举（分段 / 下拉）、动态选项（下拉）、字符串列表（有选项 = 勾选列表，否则一行一项），按 `section` 分组、`when` 条件显示、英文界面用 `locales/en.json`；
表（map）、对象、账号授权不画，显示「在插件详情里改」——这类设置面板自己按业务画（比如群列表里每个群一个开关），用 `bridge.config.set` 存。
这些走的是 `/api/plugin/<id>/_bridge/*`（插件自己别挂这个前缀下的路径）。

- 嵌在 bridge 里时，请求由宿主页代发、带宿主自己的登录态，只放行 `/api/plugin/<本插件>/` 下的路径；
- 独立打开（「在新窗口打开」、手机 App）时，地址的 `#t=` 带一张**插件票据**：只对本插件的 `/api/plugin/<id>/` 有效，
  10 分钟不用就失效、用着就续（最长 12 小时），插件停用即作废；身份是打开面板的那个人。
- 手机 App 里面板在原生另起的干净页面里打开（不挂 App 的任何原生接口）。
- 主题：`<html>` 有 `data-theme`（dark / light）和 `data-mode`，`--bp-*` 颜色变量随 bridge 实时变；`bridge-plugin.css` 提供
  `.bp-page / .bp-section / .bp-group / .bp-row / .bp-btn / .bp-input / .bp-switch / .bp-seg / .bp-badge` 等现成控件，默认就和设置页一个样子。

## 英文界面（locales/en.json）

第三方插件没法往 bridge 的字典里加词：英文界面下，名称、说明、设置表单、面板标题优先用插件目录 `locales/en.json` 里的词条，没有就照中文显示。
写法按字段路径覆盖清单里的人话，`config` 与 schema 同构：

```json
{
  "name": "QQ bot",
  "description": "…",
  "ui": { "panel": { "title": "QQ bot" } },
  "config": {
    "prefix": { "label": "Trigger prefix", "desc": "…", "section": "When to answer" },
    "mode": { "label": "Endpoint", "enum": { "external": "Already running", "managed": "Started by bridge" } },
    "groups": { "label": "Per-group settings", "key": { "label": "Group number" },
                "value": { "fields": { "enabled": { "label": "Answer in this group" } } } }
  }
}
```

子字段写在 `fields` 下（object、map 的值），列表项写 `items`，map 的键写 `key`；枚举的英文名写成 `enum: { 取值: 英文名 }`。
旧写法 `ui.panel.titleEn` 照认。

## 安装与分发

- **本机目录**：开发时用，代码直接从那儿加载，改了点「重新加载」。
- **zip**：把插件目录打成 zip（清单在包根，或唯一的一层子目录里——GitHub 下载的 zip 就是这样），在功能扩展 › 添加 › 上传 zip。
  覆盖安装同 id 的插件 = 升级，旧版进数据根 `plugins/.trash/`（留最近 3 份）。
- **GitHub 地址**：功能扩展 › 添加 › GitHub 地址，填 `owner/repo`、`owner/repo@ref` 或仓库网址。没写 ref 装最新 Release
  （有 .zip 资产用资产，没有用该 tag 的源码包），没发过 Release 用默认分支。详情页「检查更新」比最新 Release 的版本号。
  只从 github.com / codeload / 资产域下载，重定向逐跳校验，包最大 50MB。
- **插件市场**：见下一节。
- **agent 接口**：`plugins.list` / `plugins.status` / `plugins.toggle` / `plugins.config` / `plugins.action` / `plugins.scaffold` / `plugins.link` / `plugins.reload` /
  `plugins.install_github` / `plugins.check_update` / `plugins.uninstall` / `plugins.market` / `plugins.market_install` / `plugins.rollback` / `plugins.restore_builtin`。

开关和配置存在数据根的 `plugins.json`；装的插件在 `plugins/<id>/`；插件数据在 `plugin-data/<id>/`。

## 插件市场

设置 › 扩展 › 功能扩展里的「插件市场」：bridge 官方发布的插件（目前只上架官方的，不收第三方）。不用升级 bridge 就能装新插件、更新插件，
**也能更新内置功能**。

- 市场是一份签过名的索引（仓库 Wode44398/bridge-plugins 的 Release「index」），列出每个插件的各个版本：下载地址、sha256、大小、engines、更新说明。
  bridge 验过签（公钥写死在程序里）才采用；下载的包按索引里的 sha256 逐字节核对；索引版本号（seq）只升不降。
- **只提示，不自动装**：正式实例每 6 小时查一次，有更新时功能扩展页顶上列出来、设置里出角标；用户点「更新」才装。
- 一个插件的版本列表里，这台 bridge 装不了的（engines 不满足）标着原因；默认装能装的最新版，也可以装指定的旧版（降级）。
- **内置功能的市场版**（索引里 `builtin: true`）：id 等于内置功能的 id，装进 `plugins/.overrides/<id>/` 盖住内置实现——
  开关、配置、分组都不变，详情里显示「市场版 vX」。它起不来（加载失败 / apply 抛错）就自动退回内置实现，详情里写明原因；
  `engines.bridge` 必须有上界（如 `>=6.74 <6.75`），bridge 升级后内核自带修复，旧的市场版自动失效、回到内置版。
  局限：只能换掉经插件 `load()` 加载的代码；门控型内置功能（代码在 Claude 主链路里的那些）和主界面、手机 App 本身不在范围内。
- **回退**：装的插件「回退到上一版」= 从回收区（`plugins/.trash/`）换回最近一份旧版，离线可用、可以再回退回来；
  内置功能「恢复内置版」= 市场版进回收区、换回内置实现，同一个市场版本之后不再提示。
- 内置功能的 id 只有市场能占：上传 zip / GitHub 装同名包一律拒绝。
- `config.json` 的 `pluginMarket: false` 关掉市场；`pluginMarket.index` / `pluginMarket.publicKeys` 换成自建市场（给了公钥就只认它们）。
- 发布端（打包、签名、上传）在市场仓库里，`node scripts/publish.mjs`；只在用户说「发布插件」时跑。

## 内置插件

| id | 名称 | 说明 |
|---|---|---|
| preview-host | 公网预览 | pv-<令牌>.<域名> 转本机开发服务器 / 设备端口 |
| public-access | 公网访问 | 托管 cloudflared 隧道（重启生效） |
| agent-api | 给 agent 的接口 | /agent 接口、项目手册、Claude 的 bridge 工具 |
| feedback | 反馈 | 设置里的反馈 |
| routines | 定时任务 | 按时间表跑 Claude / Gemini |
| auto-archive | 自动归档 | 归档不活跃的会话 |
| pr | 拉取请求 | PR 卡、CI、自动修复、Claude 的 pr 工具 |
| keep-awake | 保持唤醒 | Claude 干活时电脑不睡（重启生效） |
| share / chat-snapshot | 分享链接 / 快照对话 | /s/、/w/、/c/ 链接（关掉后已发的链接一并失效） |
| wallpapers | 自定义壁纸 | 上传壁纸 |
| devices | 设备 | 电脑当设备给 Claude 操作（重启生效） |
| phone-control / phone-files | 手机操控 / 手机文件 | Claude 操作安卓手机 / 读写手机文件 |
| browser / terminal | 内置浏览器 / 共享终端 | Claude 页右侧面板与对应工具 |
| workspace-tools / session-tools / visualize / edge | 工作区协同 / 会话协作 / 内嵌图表 / 主机的 Edge | Claude 的对应工具 |

核心（登录、对话、会话、文件、上传、设置、扩展中心……）不在表里，永远在。

## 注意

- 插件与 bridge 同进程、同权限：别在插件里做用户没要求的事；需要密钥就放进 secret 配置项，别写死在代码里。
- `apply` 里别做长时间阻塞的同步操作（会卡住整个服务）；耗时的初始化放进 `ctx.when('ready', …)` 或异步做。
- 后台任务一般只在正式实例跑：`if (!ctx.runtime.production) return;`。

## 安全

插件代码和 bridge 跑在同一个进程里、权限相同——只装你信任的插件，就像只装信任的 VS Code 扩展。
第三方插件不能顶掉已有接口、agent 操作只能落在自己 id 的组里；管理插件只有服务器主机能做。

授权、校验这些不是安全隔离，是防误操作与可见性：以哪个账号跑 Claude 要主机在设置里选（主机本人 / Pro 档再确认一次），
回调必须声明校验，子进程与回调地址都列在详情页。真正的边界在使用者设备那一侧：插件页面一律不透明源，碰不到浏览器里的
bridge 登录态、桌面壳与手机 App 的原生接口——成员打开主机装的插件面板，插件也拿不到成员的身份。
