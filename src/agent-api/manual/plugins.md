# 插件（功能扩展）

bridge 的功能都是插件：内置功能（定时任务、分享链接、设备、手机操控、内置浏览器、共享终端……）是默认开着的一组，Media Studio / ChatGPT / dimensio 三个扩展也在同一张表里，第三方插件装进来和它们平起平坐。用户在「设置 › 扩展 › 功能扩展」里逐项开关、改配置、装插件；你用 `plugins.*` 操作做同样的事（只有服务器主机能用）。

## 看状态、开关、改配置

- `plugins.list`：每个插件的 status（active 在跑 / disabled 关着 / blocked 缺依赖 / error 出错）、enabled、restart（改了要重启服务端）、pendingRestart、schema 与 config。
- `plugins.toggle {id, enabled}`：热插件当场生效（接口、Claude 工具、后台任务一并挂上 / 摘下）；restart 插件落盘后等重启。关掉用户正在用的功能前先问。
- `plugins.config {id, config}`：先 `plugins.list` 取当前 config，改完整体传回（没传的项回到默认值）；secret 项传打码串「••••••••」= 沿用旧值；错一项整体拒，错误里写着哪一项。
- 关着的内置功能，它的接口、Claude 工具、agent 操作都不在；对应手册章节在目录里会注明「这台服务器关着这项功能」。
- `plugins.status {id, logs?}`：插件自报的状态块、托管的子进程（带 logs=子进程名 附日志尾巴）、入站回调地址、动作按钮；`plugins.action {id, action}` 按按钮。
- `plugins.install_github {repo}` 从 GitHub 装（只装用户点名、信得过的仓库，先确认）；`plugins.check_update {id}` 看有没有新版。
- 官方插件市场：`plugins.market` 看有哪些、哪些有更新；`plugins.market_install {id, version?}` 装 / 更新（用户没点名要装时先确认）；
  `plugins.rollback {id}` 回退到上一版；`plugins.restore_builtin {id}` 内置功能换回内置版。详见下面「插件市场」。
- 社区插件市场（任何 bridge 用户投稿、只有自动检查）：`plugins.market` 的 `community` 一块；装用 `plugins.market_install {id, channel:"community", ack?}`，
  含服务端代码的要先把作者与能力告诉用户、用户同意后才带 `ack:true`。把用户写的插件发出去：`plugins.community_check` → `plugins.community_publish` → `plugins.community_status`。详见下面「社区插件市场」。
- 授权字段（`type:"user"` + `grant:"chat"`）新选了服务器主机或 Pro 档账号时，`plugins.config` 要带 `confirmGrant: true`——先问用户。

{{ops:plugins}}

## 给用户写一个插件

用户想要的能力 bridge 没有时（接一个内部系统、加一个 Claude 工具、定时同步某个数据、做个 QQ / 微信机器人……），直接写成插件。
只有服务器主机能建插件（插件和 bridge 同进程、权限相同）；成员问起就说明要主机来装。

1. **建骨架**：调 `plugins.scaffold {id, name?, description?, panel?, from?, template?}`。缺省在你工作空间下建 `plugins-dev/<id>/` 并登记启用；
   `panel: true` 带一个控制面板页面；`from: "hello-world"` / `"hello-app"` / `"hello-view"` / `"qq-onebot"` / `"power-tools"` / `"workspace-demo"` 拿示例整个当起点（id 自动换成新的）；
   `template: "app-page"` / `"app-view"` / `"app-chat"` 直接生成一个能用的应用骨架（和 from、panel 不能同给）。返回目录与文件清单。
   用户要的是「主页上多一个图标、点开是个应用」（待办、看板、记账、小工具、问答助手……）就用 template，见「做一个应用」。
2. **改代码**：照本章下面的参考改 `bridge-plugin.json`（名字、配置 schema、`ui`）和 `index.mjs`（`apply(ctx, config)`），用你的文件工具直接写。
3. **重新加载**：`plugins.reload {id}`，不用重启服务；返回的 `plugin.status` 不是 active 时看 `plugin.error` 修（语法错、apply 抛错都写在那）。
4. **试**：插件的接口用 curl / 内置浏览器调。**本机 bridge 的地址看 `whoami` 返回的 server 里的 `local`**（服务端自己监听的地址，如 `http://127.0.0.1:8787`；
   同一处的 `origin` 是对外地址，没配公网地址时为空）——别去扫本机端口猜，一台机器上常同时开着好几个 bridge，猜错就测到别的实例上了。
   有面板就让用户去设置里「插件」组点开看；`plugins.status {id}` 看状态块、子进程、回调地址、定时任务；
   `plugins.status {id, logs: "plugin"}` 看插件自己的日志（ctx.log / warn / error，也在详情页「日志」里）。详情页的「清单体检」提示（拼错的字段、用了内部接口……）要修掉。
   插件给 Claude 的工具**要下一条消息才出现**（工具集在这一轮开始时就定了），告诉用户「发下一条消息就能用」。
5. **交付**：告诉用户插件在哪、怎么开关、设置里要填什么；要给别人用就把目录打成 zip（设置 › 功能扩展 › 添加 › 上传 zip），或放到 GitHub 用「GitHub 地址」装。

六个示例的完整代码就在程序目录 `src/plugins/examples/` 下（`hello-world` 最小；`hello-app` 是没有服务端代码的纯页面插件，主页一个图标、点开一个全屏分页；`hello-view` 是声明式应用，不写页面、bridge 按积木画；`power-tools` 用到「改到核心」那一节的事件、钩子、审批策略、卡片工具与界面扩展；`qq-onebot` 用到以账号跑 Claude、收外部推送、托管外部程序、分组表单、状态块、控制面板；`workspace-demo` 用到「往界面里加东西 › 文件夹」的外观、菜单项、确认框与撤销），不知道某个能力怎么写时先读对应示例。
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
models.provide
events  claude.hook  claude.permission  claude.input  claude.options  tools.agents  tools.agy  tools.codex  net  oauth  models.middleware  tool.card
replaces  service.priority  notify.channel  auth.provider
ui.homeCard  ui.workbench  ui.command  ui.composerAction  ui.messageAction  ui.sessionAction  ui.theme
ui.app  plugin.pageOnly
page.kv  page.grants  page.chat  page.files  page.nav  page.host
ui.app.view  ui.refresh  ui.blocks
ui.fileHandler  ui.command.palette  ui.app.pin  market.app
ui.workspaceDecor  ui.workspaceAction  ui.refreshDecor  claude.memory  events.agy  prompt.agy.cwd
ops.call  claude.permission.ask  events.via  claude.permission.agy  claude.ensureProject  claude.input.hint
```

## 插件目录

```
weather/
├─ bridge-plugin.json    清单（必需）
├─ index.mjs             入口（清单 entry 可改名；只有页面的插件可以没有，见「纯页面插件」）
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
| `entry` | 入口文件，缺省 `index.mjs`。没写 entry、目录里也没有 `index.mjs` = 纯页面插件（要至少声明一个页面）；写了 entry 文件却不在，照样装不上 |
| `config` | 配置 schema（见下），设置页据此自动生成表单 |
| `replaces` | 接管的内置功能 id 列表（见「替换内置功能」）：这个插件开着时它们视同关闭 |
| `requires` | 依赖的插件 id 列表：依赖没开时本插件记成「缺依赖」，依赖开了自动跟上；关掉依赖会先停掉本插件 |
| `restart` | `true` = 运行中不热插拔（开关、改配置、换版本都等重启服务）。只有包着不能撤销的东西时才用 |
| `defaultEnabled` | 缺省 `true`；`false` 装上后先不启用 |
| `category` | 分类；写 `"app"` 的插件在设置 › 功能扩展里归进「应用」一组 |
| `ui` | 插件页面：`{ "panel": { "page": "web/index.html", "title": "控制台", "icon": "chat" }, "settings": "web/settings.html", "who": "host" }`（见「插件页面」）；旧写法 `web.page` 等同 `ui.panel.page`。主页图标与全屏分页写在 `apps` 里（见「应用：主页图标与全屏分页」） |
| `engines` | 兼容要求：`{ "bridge": ">=7.02", "pluginApi": 3 }`。不满足就拒装、拒加载并说明原因。写法：`>= > <= < =`、`^`（同主版本）、`~`（同主次版本）、空格 = 且、`\|\|` = 或 |
| `permissions` | 这个插件会用到的能力（展示用，不强制）：`chat`（以授权账号跑 Claude）、`sandbox`（在插件自己的沙箱里跑 Claude）、`claude.tools`、`files`、`share`、`process`、`webhook`、`network`、`notify`、`schedule`、`routes`、`models`（给 Claude / dimensio 提供模型服务、改模型请求）、`events`、`claude.control`（钩子 / 审批策略 / 消息改写 / 每轮参数）、`ui`（卡片、菜单项、命令、工作台标签和主页应用；清单 ui 里写了 apps 的插件要声明它）、`auth`；另有两个**强制的**页面权限 page.chat（页面里以使用者身份和 Claude 对话）、page.files（读写使用者选中的文件），没声明调不了，见「页面宿主能力」。详情页按人话列给用户看 |

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
| `widget` | `textarea` / `password` / `slider`（要 min、max）/ `chips` / `segmented`；有选项的字符串列表（`array` + `items.enum` 或 `items.options`）写 `checks` = 勾选框多选 |
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
| `ctx.socket(name, handler, { who? })` | 实时通道：插件页面经 `bridge.socket(name)` 连上来，双向收发文本 / 二进制（见「实时通道」） |

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
await ctx.claude.memoryDir('E:\\work\\proj');    // 这个工作目录的 Claude 记忆目录（绝对路径；目录还不存在也给算出来的路径；参数不是绝对路径 → null）
await ctx.claude.memoryInfo('E:\\work\\proj');   // { dir, exists, index（有没有 MEMORY.md）, files（第一层 .md 篇数，封顶 2000）} | null
await ctx.claude.ensureProject('E:\\work\\proj', { who, name });   // 确保是这个人的 Claude 项目：已是就返回，不是就建 → { id, name, path, created }
```

`turn`：`{ kind: 'chat' | 'routine' | 'plugin', ctx（身份上下文：kind、cwd、sandbox…）, snap, message, sessionId, getGen() }`。
memoryDir / memoryInfo 的找法同 Claude Code：`.claude/settings.local.json` → `.claude/settings.json` → 用户 settings 的 autoMemoryDirectory，都没有就是 `<配置目录>/projects/<git 主仓库根的键>/memory`；
第二个参数 `{ who }` 给身份上下文时按那个人的 Claude 配置目录算，缺省按服务器主机。只给位置与篇数，不读内容。能力名 claude.memory。
ensureProject 和侧栏「新建项目」走同一份代码（路径授权、上限照旧），建了在线的 Claude 侧栏当场重拉；只做加法，不改名、不删。能力名 claude.ensureProject。
给 agy 的提示（`agents` 含 'agy'）：`turn.cwd` / `turn.sessionId` 是要挂载的那个会话；有插件工具与否都会带上。系统提示只在**挂载会话时**给 agy，
已挂着的会话拿不到新提示；提示里「不看 cwd 的那部分」变了，agy 常驻进程会在空闲时重启、会话重新挂载时拿到新的；随 cwd 变的部分只对新挂载的会话生效（否则在不同目录的会话间切换会反复重启）。
快照访客和插件沙箱永远拿不到这些常驻工具。工具集在 Claude 进程起来时定下，插件开关 / 重载后下一条消息自动换新。
只想给**插件自己发起的那一轮**加工具（机器人「发图到群里」之类），用 `ctx.chat.run({ tools })`，见下。

### 给 agent 接口与手册

```js
ctx.agentOp({ name: 'status', title: '一句话', desc: '详细说明', params: {…}, access: 'read', handler: async (who, args) => ({…}) });
ctx.manual('manual');   // 插件目录下 manual/*.md 并入 bridge 项目手册
```
操作名自动加前缀成 `<id 把连字符换成下划线>.status`，同时出现在 `/agent/v1/…`、手册的接口目录和 bridge 里 Claude 的 bridge 工具里。

反过来，插件服务端要用 bridge 现成的**只读**操作（某个文件夹下有哪些 Claude / Antigravity 会话、读一段对话、列项目……）：

```js
const { sessions } = await ctx.ops.call('sessions.list', { agent: 'agy', limit: 200 }, { who });   // who = list / handler 收到的身份；缺省服务器主机
const { projects } = await ctx.ops.call('projects.list', {}, { who });
const { messages } = await ctx.ops.call('sessions.read', { sessionId, limit: 5 }, { who });
```

- 和 agent 经 HTTP / bridge_call 调的是同一张操作表：参数照操作的 params 校验、按 `who` 这个身份判权限（要哪个 agent 对他开着、要不要主机），返回操作的原样数据（副本）。
- 只认 `access: 'read'` 的操作；会改东西的（`chat.send`、`routines.create`……）一律拒——替人跑 Claude 用 `ctx.chat`，要用户看得见、批得了的写操作交给 agent 去调。
- 出错抛 `{ code, message, hint }`（code 同 agent 接口：bad_args / forbidden / not_found / failed …）；快照、分享访客这类非登录身份拒。能力名 ops.call。

### 插件之间

| | |
|---|---|
| `ctx.provide(name, value)` | 提供一个服务（插件停用时撤掉） |
| `ctx.service(name)` | 取服务（不存在抛错）。要用别的插件的服务，就在清单 `requires` 里写上它 |
| `ctx.on(event, fn)` / `ctx.emit(event, payload)` | 插件之间的事件 |

### 给 agent 提供模型（ctx.models）

插件能把一个模型端点（兼容 Anthropic Messages 或 OpenAI Chat Completions）登记成**模型服务**，按勾选进 Claude 和 dimensio 的模型列表——
本机反代（网页版订阅额度转成 API）、内网模型网关、自己托管的推理服务都这么接。用户不用再去两边的「模型服务」里各填一遍，插件停用就一起撤掉。

```js
const svc = ctx.models.provide({
  id: 'default',                       // 插件内唯一（小写字母数字连字符），缺省 default
  name: 'Gemini 网页版',
  protocol: 'anthropic',               // 或 'openai'；'gemini'（generateContent 接口）只有 dimensio 认得，这种服务不会给 Claude
  baseUrl: 'http://127.0.0.1:8765',    // 插件是主机装的，本机地址也行
  apiKey: key, authStyle: 'bearer',    // 可选；没 key = 不鉴权（authStyle 缺省按协议）；headers: [{ name, value }]
  agents: ['claude', 'dimensio'],    // 给哪些 agent（缺省都给）
  members: false,                     // true = 多用户服务端的成员也能用（缺省只给服务器主机）
  models: [{ id: 'gemini-argon', label: 'Gemini 4 Argon', contextWindow: 200000, maxOutput: 32000, vision: false,
            thinking: 'effort', efforts: [{ id: 'medium', name: '标准', value: { gemini_thinking: false } }, { id: 'high', name: '深度思考', value: { gemini_thinking: true } }],
            effortDefault: 'medium' }],
  defaultModel: 'gemini-argon', timeoutSec: 600,
  compat: { promptCaching: false, stripBetas: true, slimBody: true, stripThinkingHistory: true },   // 可选：Claude 代理的兼容开关
});
svc.update({ agents: ['claude'] });   // 合并改动、两边当场换；svc.dispose() 撤掉（停用时自动撤）
ctx.models.agents();                  // [{ id: 'claude', label, available }, { id: 'dimensio', …, available: dimensio 扩展开着没 }]
```

- 模型的能力字段和档位表与「设置 › Claude › 模型服务」同一套：`efforts` 每档的 `value` 深合并进请求体（或写进 `effortField`）；dimensio 只有七级思考档，档位 id 用 off / minimal / low / medium / high / xhigh / max 最省事。
- 每个模型可以单独定给谁：`models: [{ id: 'a', agents: ['claude'] }, { id: 'b', agents: ['dimensio'] }, { id: 'c' }]`——
  取与服务级 `agents` 的交集（`protocol: 'gemini'` 照样去掉 claude），不写 = 跟服务级。某个 agent 下一个模型都不剩，那一侧整条服务不出现；
  服务 id（Claude 的 `custom:p-<10 位>:<模型>`、dimensio 的服务卡）不因此改变，老会话照样认得。默认模型不给某一侧时，那一侧用剩下的第一个。
- Claude 里会话模型是 `custom:p-<10 位>:<模型>`（随插件 id 与服务 id 固定，重启后老会话照样认得），走 bridge 的本机代理，不走出站代理；dimensio 里是一张「插件 · 名字」的服务卡。
  两边都**只能用、不能改**（改地址、Key、模型都在插件里），设置里的编辑器看不到它。
- 端点要求鉴权就传 `apiKey`：只在内存和 dimensio 的自定义服务目录里（密钥守卫挡着），不进 Claude 的加密存储。
- 用量：主机自己用不计额度；成员用（`members: true`）计成员的轮数额度，花费记 0。

## 改到核心

前面的能力都是「往旁边加」；这一节的能让插件改 bridge 自己的行为：订阅事件、拦截与改写 Claude 的每一步、替换内置功能、往界面里加东西。
都是加法（`ctx.api` 仍是 3），用 `ctx.has()` 探测；插件给的回调一律隔离——抛错或超时只记插件日志、当它没表态，不会打断一轮对话。
沙箱身份与快照访客的硬边界（路径围栏、没有命令行）永远在插件之前生效，插件放不开它们。

### 订阅 bridge 事件（ctx.events）

```js
ctx.events.on('turn.end', (e) => { if (!e.ok) ctx.notify({ title: '对话出错', body: e.error }); });
ctx.events.on('*', (e, name) => ctx.log(name, e.sessionId));   // 全收
```

| 事件 | 什么时候 | 主要字段 |
|---|---|---|
| turn.start | 一轮开始（Claude 主聊天、定时任务、插件代跑、dimensio、Antigravity） | agent（claude / dimensio / agy）、kind（chat / routine / plugin / goal / resume）、owner、sessionId、cwd、isNew、model、message |
| turn.end | 一轮结束 | 同上 + ok、stopped、error、result（回答，截到 8000 字）、costUsd、durationMs、tools |
| tool.end | Claude 每次工具调用完 | owner、sessionId、tool、input（摘要）、isError、agentId（子 agent） |
| routine.run | 定时任务跑完 | id、name、ok、sessionId、preview |
| device.online / device.offline | 电脑设备上下线 | id、name、owner |
| user.login | 有人登录 | kind、login、via（token / password / register / plugin:…） |
| plugin.state | 插件开关 | id、active、status、error |
| model.request | 模型服务（自定义 API、插件提供的）每次请求 | provider、plugin、model、status、ms、inTok、outTok |

owner：`{ kind: 'admin', login: 'host' }`、`{ kind: 'user', login, id }`、`{ kind: 'sandbox', token }`。事件是事后通知：拿到的是副本，改了不影响 bridge。
别的 agent 经 bridge 操作 `chat.send` 发给 Claude 的那一轮（不是用户本人发的），Claude 的 turn.start / turn.end 多一个 `via`（`'agy'` / `'dimensio'` / `'codex'`）；
同一轮的消息改写（`ctx.claude.input`）、提示与钩子拿到的 turn 里也有 `turn.via`。排队之后才发出去的那条不带。能力名 events.via。
要告诉 Claude「这条不是用户本人说的」，在消息改写里回 `{ hint: '这条来自 Antigravity……' }`：核心把它包进 `<session-hint>` 放在消息最前面，
模型看得到，会话标题、搜索、历史气泡都不带它（别用 prepend，那会进标题）。能力名 claude.input.hint。
Antigravity（agent 'agy'，能力名 events.agy）：一次发送 = 一轮，各发一次 turn.start / turn.end（kind 恒为 chat；中途插话、后台子代理回报续接都算在这一轮里；
排队消息接着跑、后台唤醒各算新的一轮，唤醒的 source 是 'wake'；agy 自己的子代理不发）。新会话的 turn.start 里 sessionId 为空，turn.end 里有；costUsd 恒为 0。

### 拦截与改写 Claude（ctx.claude.hook / permission / input / options）

```js
// 钩子：Claude Code 的生命周期钩子，事件 PreToolUse / PostToolUse / PostToolUseFailure / UserPromptSubmit / SessionStart /
// Stop / SubagentStart / SubagentStop / PreCompact / PostCompact / Notification
ctx.claude.hook('PreToolUse', (input, turn) => {
  if (/rm -rf/.test(input.tool_input.command)) return { decision: 'deny', reason: '不许删整个目录' };
}, { matcher: 'Bash' });                                   // matcher：工具名，'A|B' 任一，'mcp__github__*' 前缀
ctx.claude.hook('UserPromptSubmit', () => ({ context: '今天的值班人：小王' }));
ctx.claude.hook('Stop', (input) => (needsMore(input) ? { block: true, reason: '还没跑测试，接着做' } : undefined));

// 审批策略：Claude 要审批时（当前权限模式要求）先问插件，第一个表态的说了算；不表态就照常弹审批卡
ctx.claude.permission(({ tool, input }) => (tool === 'Bash' && /^git (status|diff|log)\b/.test(input.command) ? 'allow' : undefined));

// 消息改写：只改发给 Claude 的那份（界面上显示的仍是用户原话）；另可回 hint = 只给模型看的旁注（见「订阅 bridge 事件」末尾）
ctx.claude.input(({ message }) => ({ message: message.replace(/\d{11}/g, '<手机号>'), attachments: ['D:/kb/规范.md'] }));

// 每轮参数
ctx.claude.options((turn) => ({
  model: 'claude-opus-5-5', effort: 'high',                // 模型 / 档位（不认识的忽略）
  env: { MY_FLAG: '1' },                                   // 鉴权、代理、bridge 自己的变量不许改
  agents: { reviewer: { description: '代码审查', prompt: '你是严格的审稿人……', tools: ['Read', 'Grep'] } },   // 子 agent 定义
  additionalDirectories: ['D:/kb'],                        // 只给主机本人的会话
  append: '回答末尾附一句今天的天气。',                       // 追加到系统提示
  settings: { /* Claude Code 设置项，用户在设置页的偏好照样说了算 */ },
}));
```

- 钩子返回：PreToolUse `{ decision: 'allow' | 'deny' | 'ask', reason, input }`（input = 改过的参数）；
  UserPromptSubmit / SessionStart / PostToolUse / SubagentStart / Stop `{ context }`（给模型的补充上下文）；UserPromptSubmit / Stop / SubagentStop / PostToolUse `{ block: true, reason }`。
  多个插件：deny 优先，input 依次叠，context 拼接。缺省 30 秒时限（`timeout` 改，最长 10 分钟）。
- 审批策略只在需要审批时被问（绕过权限 / 自动模式下大多数调用根本不问）；要拦**所有**调用用 PreToolUse 钩子。放行越不过计划模式，
  也越不过要用户本人逐次批准的那几样（开自动合并、Auto-fix）。可以慢慢答（比如转去飞书等人点）：缺省等 10 分钟，`timeout` 最长 30 分钟。
- 审批策略回 `'ask'`（或 `{ ask: true, message }`）= **一定要用户本人批**：照常弹审批卡，绕过权限、bridge 自家工具的免审批都不越过它；
  无人值守的轮（定时任务、`ctx.chat` 代跑）没人能批，按拒绝处理。绕过权限 / 自动模式下 CLI 根本不来问，所以要配一个同条件的
  PreToolUse 钩子回 `{ decision: 'ask', reason }` 把调用送进审批（钩子的 reason 会写在卡上）。能力名 claude.permission.ask。
- **Antigravity 的审批**：`ctx.claude.permission(fn, { agents: ['agy'] })`（缺省只管 Claude；写 `['claude', 'agy']` 两边都管）。agy 的每个审批请求在
  自动放行（bridge 自家工具免审批、完全放行模式）**之前**先问它：fn 收到 `{ tool: agy 的工具名（如 mcp_bridge_call）, input: 工具参数, title, agent: 'agy', sessionId }`
  与 turn（`turn.agent === 'agy'`、`turn.cwd` = 会话目录）。回值同上：allow 直接放、deny 直接拒、'ask' 完全放行也弹卡；后台唤醒这类没人在的轮 'ask' 按拒绝。
  只按工具名与参数判断，别看 title（agy 跑命令时 title 就是命令原文）。agy 单次工具调用有 180 秒硬上限，策略最多等 30 秒，超时当没表态。能力名 claude.permission.agy。
- who：`'host'`（缺省）/ `'members'`（成员的会话也管）/ `'all'`（再加插件沙箱跑的轮）。
- 钩子、子 agent、env、附加目录在 Claude 进程起来时就定了：插件改了这些，下一条消息自动冷起新进程。

### 各 agent 都给的工具（ctx.tools.add）

`ctx.tools.add(spec)` 写法同 `ctx.claude.tool`，缺省 Claude、dimensio、Antigravity、ChatGPT（Codex）都给；`ctx.claude.tool` / `ctx.claude.prompt` 也可以写 `agents: ['claude', 'dimensio', 'agy', 'codex']` 里的任意几个。
dimensio 那边是一个叫「bridge 插件」的连接器（模型看到 `mcp__bridge_plugins__<插件>__<工具>`），新会话生效；`access: 'read'` 的免审批。
Antigravity 那边并进 bridge 自带的工具服务（模型看到 `mcp_bridge_plugin_<插件>_<工具>`，名字里的连字符换成下划线），设置里「插件工具」开着才给，`access: 'read'` 的免审批。
Codex 那边并进 bridge 的工具中枢（命名空间 `bridge_plugins`，工具名 `<插件>_<工具>`，连字符换成下划线），清单在建会话时定下、新会话生效；`access: 'read'` 的免审批；`ctx.claude.prompt` 带 `agents` 含 `codex` 的说明并进 Codex 的开发者说明。翻修前建的老会话（没有工具中枢）是一个叫 `bridge_plugins` 的 stdio MCP 服务，只给服务器主机的会话。能力名 `tools.codex`。

工具结果画成卡片：工具 spec 写 `render: 'card'`，handler 回 `{ card: { title, subtitle, fields: [{ label, value }], image, link: { url, label }, markdown, tone }, text }`——
界面上是一张卡片，模型看到 text（没给就是卡片的文字摘要）。image / link 只收 http(s) 与站内地址。

### 网络与授权（ctx.net / ctx.oauth）

```js
ctx.net.proxy();                         // bridge 当前的出站代理地址（直连时 ''）——写进托管程序自己的配置用
ctx.net.onProxyChange((now) => restartMyProxy(now));
await ctx.net.fetch(url, { timeoutMs: 15000 });   // 全局 fetch（本来就走出站代理）+ 时限

const gh = ctx.oauth.client('github', {
  authorizeUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token',
  clientId: cfg.clientId, clientSecret: cfg.clientSecret, scopes: ['repo'],
});
gh.redirectUri();   // 去对方后台登记的回调地址
gh.startUrl();      // 一次性授权链接（面板里 bridge.openExternal 打开）
await gh.fetch('https://api.github.com/user');   // 自动带令牌，快过期自动刷新
```

令牌加密存在插件数据目录里，不进配置、不回给页面。

### 模型请求中间件（ctx.models.middleware）

```js
ctx.models.middleware(({ provider, model, body }) => ({ ...body, temperature: 0.2 }), { only: 'own' });
```

本机模型代理（自定义 API、插件提供的模型）按服务参数改写完、发给上游之前依次调；`only: 'own'` 只管自己 `ctx.models.provide` 的服务。用量在 model.request 事件里。

### 替换内置功能（清单 replaces）

清单写 `"replaces": ["browser"]`：这个插件开着时，内置的「内置浏览器」视同关闭（用户存的开关不动），详情页标「已由 X 接管」；
插件关掉或起不来，内置的自动回来。接管者用 `ctx.claude.tool` 登记的工具用被接管那项的键名（还是 `mcp__browser__*`），老会话、提示词不用改。
能接管的是可开关的内置功能（见文末内置插件表）；核心与 agent 扩展不能接管。

### 服务叠放、通知渠道、外部登录

```js
ctx.provide('search.web', impl, { priority: 10 });   // 给了 priority 的同名服务可叠放：取优先级最高的，撤掉露出下一层

ctx.notify.channel({ id: 'feishu', label: '飞书', who: 'host', send: async ({ title, body, level, sessionId, owner }) => { … } });
// bridge 提醒人时（ctx.notify、Claude 的推送通知……）同时投给所有渠道；who:'members' 连成员的提醒也投（按 owner 找人）

ctx.auth.provider({
  id: 'sso', label: '公司 SSO',
  start: (req, { callbackUrl, state }) => `https://sso.example.com/auth?redirect_uri=${encodeURIComponent(callbackUrl)}&state=${state}`,
  callback: async (req, url, { callbackUrl }) => ({ login: await exchange(url.searchParams.get('code')) }),   // 回 { login } | { error }
});
// 登录页多一个「用 公司 SSO 登录」。只映射到已有账号（不自动建号、不能登成服务器主机）；手机 App 里不显示。
```

### 往界面里加东西（ctx.ui）

手机 App 不跑第三方代码：下面除工作台标签外都是声明，bridge 自己画，按下去执行插件服务端的 handler。

```js
ctx.ui.homeCard({ id: 'oncall', title: '值班', icon: 'users', order: 1, data: async (who) => ({ text: '今天：小王', tone: 'ok', items: [{ label: '电话', value: '1234' }], badge: '3' }), open: 'panel' });
ctx.ui.workbench({ id: 'board', title: '看板', page: 'web/board.html' });   // Claude 工作台多一个标签（插件页面；SDK 的 bridge.context() 拿当前会话）
ctx.ui.workbench({ id: 'dev', title: '设备', icon: 'android', page: 'web/dev.html', hosts: 'all' });   // 各分页的工作区都有这张卡（见下）
ctx.ui.command({ name: 'standup', description: '写站会', template: '总结一下今天做了什么：' });          // 「/」菜单：插模板
ctx.ui.command({ name: 'ticket', description: '开工单', handler: (who, { args, sessionId }) => ({ toast: '已开：' + args }) });
ctx.ui.composerAction({ id: 'tmpl', label: '插入模板', handler: () => ({ insert: '……' }) });        // 输入框「＋」菜单
ctx.ui.messageAction({ id: 'save', label: '存到笔记', roles: ['assistant'], handler: (who, { text }) => '已存' });   // 消息菜单
ctx.ui.sessionAction({ id: 'export', label: '导出到飞书', handler: (who, { sessionId, title }) => ({ open: url }) });   // 会话菜单
ctx.ui.theme({ vars: { '--accent': '#d97757' } });   // 主题变量：只收 -- 开头，值里不许 url( / expression( / ; { }
ctx.ui.app({ id: 'inbox', title: '收件箱', page: 'web/inbox.html', badge: (who) => unread(who) });   // 主页图标 + 全屏分页，见「应用：主页图标与全屏分页」
ctx.ui.app({ id: 'todo', title: '待办', view: (who, { state }) => [/* 积木 */], actions: { … } });   // 声明式应用：bridge 按积木画，见「做一个应用」
ctx.ui.refresh('todo');                                                                     // 让开着这个声明式应用的页面重拉
ctx.ui.fileHandler({ id: 'csv', title: 'CSV 查看器', exts: ['csv'], app: 'inbox' });           // 文件菜单「用 X 打开」→ 本插件的页面型应用
```

- handler 回字符串（当提示）或 `{ toast, insert（换掉输入框里的文字）, send: true（换进去顺手发出）, open: 'panel' | 网址 }`；60 秒封顶。插件命令和内置命令同名时插件的优先。
  命令加 `palette: true` 同时收进桌面版 Ctrl+K 命令面板；应用加 `pin: 'sidebar'` 固定到 Claude 分页侧栏（见「做一个应用 › 更多插槽」）。
- 主页卡片的 data 每次打开主页现算，3 秒没回就只显示标题；`open`：`'panel'`（插件控制面板）、`{ action: 'id' }`（ctx.action 的按钮）、`{ url }`。
- who：`'host'`（缺省）/ `'members'`。英文界面：插件 `locales/en.json` 的 `ui.<种类>.<id>.<字段>`（如 ui.homeCard.oncall.title、ui.command.standup.description）。
- 登记变了，在线页面当场刷新；手机 App 里工作台标签点开是独立的干净页面。

#### 文件夹（ctx.ui.workspaceDecor / workspaceAction / refreshDecor）

给 Antigravity 的工作空间、Claude 的项目（统称文件夹，按绝对路径认）加外观和菜单项。同一份声明，两个分页各按自己的设计语言画。完整示例见 `workspace-demo`。

```js
ctx.ui.workspaceDecor({
  id: 'collab', who: 'host', agents: ['agy', 'claude'],          // agents 缺省两个分页都画
  list: async (who, { agent }) => [{                              // agent = 正在取外观的分页
    path: 'E:\\work\\proj',                                       // 绝对路径（必填）；Windows 不分大小写、去尾斜杠
    panel: true, peers: ['agy', 'claude'], busy: ['claude'],      // 收进底板、画谁的标识、谁在这里干活
    note: '与 Antigravity 共用 · 记忆 214 篇',                      // ≤60；Claude 侧写在项目名下（不给就不写），Antigravity 侧放进悬停卡
    open: { folder: { agent: 'agy', path: 'E:\\work\\proj' } },  // 点文件夹上的标识（Claude 侧方块 / Antigravity 侧头像组）去哪；不给就不跳
    status: { agent: 'claude', text: '正在出 apk', since: Date.now(), open: Target },   // since = 开始时间，前端自己走秒
    footer: { icon: 'book', text: '共用记忆 214 篇', open: Target },
    card: { title, subtitle, sections: [{ label, link: { label, open: Target }, rows: [{ icon, agent, live, text, meta, since, mono, open: Target }] }], foot: { text, link } },
    sessions: [{ agent: 'agy', id: '<会话 id>', by: 'claude' }],              // 本页会话行首标「谁开的」
    peerSessions: [{ agent: 'agy', items: [{ id, title, meta, live }] }],     // 在本页这个文件夹下列出别的 agent 的会话
  }],
});
ctx.ui.workspaceAction({
  id: 'collab-on', label: '设为协作工作空间', icon: 'claude',        // icon 另认 'claude' / 'agy'（画该 agent 的单色标志）
  who: 'host', agents: ['agy'], when: 'plain', decor: 'collab',      // when：always（缺省）/ decorated（这个文件夹有本插件的 decor 外观才出现）/ plain（反之）
  danger: false,
  dialog: (who, { path, agent }) => ({ title, subtitle, hero: { peers: ['agy', 'claude'] },
    sections: [{ label, items: [{ icon, agent, title, desc, chip: { ok, code, text } }] }],
    fields: [{ id: 'askFirst', type: 'switch', label, desc, value: false }],
    ok: '设为协作空间', cancel: '取消', danger: false, extra: { label: '取消协作', action: 'collab-off', danger: true } }),
  handler: (who, { path, projectId, agent, values }) => ({ toast: '好了', decorChanged: true, undo: { label: '撤销', action: 'collab-off' } }),
});
ctx.ui.refreshDecor('collab');            // 外观的数据变了：在线页面重拉（{ who } 只推那个人）
```

- **Target**（点了去哪）只认五种，其余丢掉：`{ action: '<本插件的 workspaceAction id>' }`（跑那个动作，带上这个文件夹）、
  `{ session: { agent: 'claude' | 'agy', id } }`（跨分页打开那个会话）、`{ folder: { agent: 'claude' | 'agy', path } }`（到那个分页的这个文件夹：
  那边正停在这里就不动，否则打开那边在这里正在跑的会话 → 这里最近的会话 → 在这里开新对话）、`{ file: { rel, ws? } }`、`{ url }`（http(s) 或站内 / 开头）。
- 限额：每个 decor 50 个路径（同一路径只留第一条）、card 4 节 × 每节 8 行、sessions 200、peerSessions 每个 agent 20 条；对话框 4 节 × 6 项、开关 4 个（v1 只有 switch）。
  文字一律截断、去换行（note / status 60、footer 80、卡片标题 40、副标题 120、行 80、行尾 30；对话框标题 40、副标题与说明 120、按钮 20）。agent 字段只认 'agy' / 'claude'。
- list、dialog 3 秒封顶，handler 60 秒；出错只写插件日志：list 出错这个外观当作空；dialog 出错这一下不执行（不会跳过确认直接跑 handler）。
- handler 的 values 只有 dialog 里声明过的开关（布尔），没传的取开关的缺省值；没有 dialog 的动作 values 是 {}。handler 回字符串（当提示）或
  `{ toast, open: 'panel' | 网址 | Target, decorChanged: true, undo: { label, action } }`：前端执行完总会重拉一次外观，同一个人的别的设备也会收到重拉通知；
  undo 在提示条上放一个按钮，按下直接跑那个动作（不弹它的确认框，开关取缺省值）。
- when / agents 只管菜单里出不出现；按 Target、undo、对话框的 extra 跑一个动作不看它们，只看 who。
- 同一个文件夹有好几个插件给外观时，按插件 id 排序取第一个画。英文界面：菜单项文字取 `locales/en.json` 的 `ui.workspaceAction.<id>.label`；外观与对话框里插件给的动态文字不翻译。

### 工作区卡片进哪些分页（ctx.ui.workbench 的 hosts）

- `hosts`：`'claude'`（缺省，同四期）/ `'codex'`（ChatGPT 分页）/ `'agy'`（Antigravity）/ `'dimensio'`，可写数组，`'all'` = 全部。
  卡片挂在工作区第二列末尾、收进工具开关的「更多」；快照访客没有。
- `bridge.context()` 按所在分页给：`{ sessionId, cwd, agent }`，agent 是 `claude` / `codex` / `antigravity` / `dimensio`；切会话、换工作目录时 `bridge.on('context')` 再推一次。
- 手机 App 里点开是独立的干净页面（各分页同一条路）。
- 图标名（`icon`）只认内置的一组线条图标，包括 `plugin` `phone` `android` `terminal` `globe` `robot` `chart` 等（同应用的内置图标）。
- 能力名 `ui.workbench.hosts`。

### 实时通道（ctx.socket / bridge.socket）

插件页面要持续收发数据（画面流、日志流、连续的触摸 / 键盘事件）时用它，比轮询接口、`ctx.bus.toPage` 推 JSON 快得多，也能传二进制。

```js
// 服务端
ctx.socket('stream', (sock, who, query) => {
  // who = 连接者的身份上下文（同 ctx.http.user）；query = 页面连接时带的参数（URLSearchParams）
  const t = setInterval(() => { if (sock.bufferedAmount < 1e6) sock.sendBinary(frame()); }, 33);   // 积压太多就先别发
  sock.onJson((m) => handle(m));          // 也有 onText(str) / onBinary(buf)
  sock.onClose(() => clearInterval(t));
  sock.sendJson({ type: 'hello' });       // send(text) / sendJson(obj) / sendBinary(buf) / close(code?, reason?) / open
}, { who: 'host' });                     // 缺省 host：只有服务器主机能连；'members' = 能用这个插件页面的成员也能连

// 页面
const ws = await bridge.socket('stream', { serial: 'emulator-5554' });   // 标准 WebSocket，binaryType = 'arraybuffer'
ws.onmessage = (e) => (typeof e.data === 'string' ? JSON.parse(e.data) : new Uint8Array(e.data));
ws.send(JSON.stringify({ t: 'tap', x: 0.5, y: 0.5 }));
```

- 鉴权：页面先经 SDK 的普通请求（嵌入时宿主代发、独立时带插件票据）换一张 30 秒、只能用一次的连接票，再直连
  `/api/plugin/<id>/_ws/<name>?t=<票>`；身份 = 换票的人。插件停用时端点撤掉、连接全部关闭（1001）。
- 断了不自动重连：要不要重连、怎么补状态跟业务走，页面自己再调一次 `bridge.socket`。
- 一个插件同时最多 64 条连接；页面发上来的单条消息最多 8 MB。经隧道时有 20 秒一次的心跳，空闲连接不会被掐。
- 能力名 `socket`（服务端）、`page.socket`（页面：`bridge.can('socket')`）；页面下载 `bridge.download` 是 `page.download`。

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
  const info = await bridge.ready();                 // { pluginId, theme, lang, platform, mode: 'embed' | 'panel' | 'standalone', app }
  const list = await bridge.json('chats');           // GET /api/plugin/<id>/chats（非 2xx 抛错，message = 接口的 error）
  await bridge.json('send', { text: 'hi' });         // 带第二个参数 = POST JSON
  const r = await bridge.fetch('raw', { method: 'POST', body: blob });   // 类 Response
  bridge.on('message', (p) => …);                    // ctx.bus.toPage('message', p)
  bridge.onStatus((s) => …);                         // 状态块更新
  bridge.toast('已保存'); await bridge.confirm({ title: '清空？', danger: true });
  img.src = await bridge.blobUrl('image?id=1');      // 要登录才拿得到的图片
  const ws = await bridge.socket('stream', { id: 3 });  // 实时通道（插件 ctx.socket 登记的端点）：标准 WebSocket，见「实时通道」
  await bridge.download('export?id=1', 'a.csv');      // 下载插件接口给的文件：嵌入时由宿主存（桌面壳 / 手机 App 走原生下载器）
  bridge.openExternal(url); bridge.back();
  bridge.go('detail.html?id=3');                     // 跳到本插件别的页面（保留 bridge 给的 #，见下）
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
  10 分钟不用就失效、用着就续（最长 12 小时），插件停用即作废（重新启用后旧票也不复活，页面要重新打开）；身份是打开面板的那个人。
- 手机 App 里面板在原生另起的干净页面里打开（不挂 App 的任何原生接口）。
- 多页插件跳页：bridge 给页面的地址 `#` 里带着票据 / 嵌入口令，丢了它新页面就和 bridge 断了联系（嵌入时宿主不再理它的消息，独立打开时没了票据）。
  不管嵌在 bridge 里还是独立打开，普通的本插件链接（`<a href="b.html">`，没写 target / download、href 里本来没有 `#`）和 GET 表单，SDK 在点下去时自动接上这个 `#`；
  **用脚本跳到本插件别的页面时用 `bridge.go('b.html?id=3')`，或者自己把 `location.hash` 原样接上——直接 `location.href = 'b.html'` 会让新页面和 bridge 断开。**
  `bridge.go()` 只认本插件 `/plugins/<id>/` 下的地址，别的抛错。
- 嵌在 bridge 里时，一个页面同一时间只挂一个 bridge 画的框（选择器、授权框、`bridge.confirm` 确认框都算），上一个没关又开一个会抛错、`status` 为 409；
  页面跳走或刷新时 bridge 把挂着的框按取消收掉。页面主线程卡住好几秒时 bridge 可能当它已经离开：SDK 会自己重连，
  正在等的请求抛错、`status` 为 0（同断网，可能办了也可能没办，要不要重试自己定），`bridge.chat.on` 的订阅自己接上，不用页面处理。
- 主题：`<html>` 有 `data-theme`（dark / light）和 `data-mode`，`--bp-*` 颜色变量随 bridge 实时变；`bridge-plugin.css` 提供
  `.bp-page / .bp-section / .bp-group / .bp-row / .bp-btn / .bp-input / .bp-textarea / .bp-select / .bp-switch / .bp-seg / .bp-badge` 等现成控件，默认就和设置页一个样子。

## 应用：主页图标与全屏分页

插件可以在 bridge 主页摆自己的图标（手机主页的图标网格、电脑版的 Dock），点开是一个占满整屏的分页，里面是插件自己的页面（页面型），
或者 bridge 按插件给的积木画的界面（声明式，只能用 `ctx.ui.app` 登记，见「做一个应用」）。这一节讲页面型；从零做一个应用先看「做一个应用」。
页面就是上一节的插件页面：同样跑在不透明源里、用同一个 SDK、独立打开时带插件票。分页的顶栏由 bridge 画（返回、图标、标题、
灰色小字「来自 <插件名>」、「⋯」菜单），插件盖不住、藏不掉——用户始终知道自己在哪个插件里。最小示例是 `hello-app`。

### 清单 ui.apps

```json
"ui": {
  "apps": [
    { "id": "board", "title": "看板", "titleEn": "Board", "page": "web/board.html",
      "icon": { "light": "web/icon-light.svg", "dark": "web/icon-dark.svg" },
      "who": "members", "order": 10 }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 必填。小写字母开头，只用小写字母、数字、连字符，≤32 字；同一插件内不能重复 |
| `title` | 必填。1～20 字。不许和 bridge 自带的入口重名：Claude、ChatGPT、Codex、dimensio、Media Studio、Studio、工作空间、Workspace、设置、Settings、主页、Home、更多、More（不分大小写） |
| `titleEn` | 英文界面的标题（≤30 字）；`locales/en.json` 里 ui 下的 `app.<id>.title` 优先 |
| `page` | 必填。`web/` 下的页面，如 `web/board.html`（不许 `..`、`?`、`#`） |
| `icon` | 见「图标怎么画」；不写 = 内置图标 `plugin` |
| `who` | `host`（缺省，只有服务器主机看得到）/ `members`（成员也看得到、也能打开；接口里 `ctx.http.user` 拿到的是成员自己） |
| `order` | 数字，缺省 0，小的排前；同序按标题排 |
| `pin` | 只认 `"sidebar"`：同时固定到 Claude 分页侧栏的「应用」组；别的值忽略并写进清单体检 |

- 一个插件最多 8 个应用。id、标题、page 不合格的那个应用不登记，图标不合格的退回内置图标——都写进详情页「清单体检」，不影响安装。
- 插件关着时它的应用从主页消失，开了立刻出现（在线页面当场刷新）；改了清单调 `plugins.reload` 生效。
- 主页一共摆 8 格（含 bridge 自带的入口），多出来的收进「更多」。用户可以在设置 › 主页里调顺序、隐藏某个，图标长按 / 右键也能「从主页隐藏」；这些只存在用户那台设备上，插件管不着。

### ctx.ui.app

清单里的应用跟着插件开关走。要按条件出现（某项配置开了才有）、或者要角标时，在 `apply` 里动态登记：

```js
ctx.ui.app({
  id: 'inbox', title: '收件箱', page: 'web/inbox.html', icon: 'chat', who: 'members', order: 5,
  badge: async (who) => (await countUnread(who)) || '',   // 角标：字符串 / 数字 / 函数（who = 正在看主页的人，同主页卡片的 data）
});
```

- 字段与校验同清单：id、标题、page 不合格当场抛错；图标文件缺失或超过 200 KB 只写一条插件日志，退回内置图标。
- 不给 page、给 `view` 函数（加 `actions`、`state`）就是声明式应用，见「做一个应用 › 声明式应用」。
- 和清单里同 id 的应用：这里登记的**盖住**清单里的（常见写法：清单里静态声明好，apply 里同 id 再登记一次补上角标）。清单加动态合起来同样最多 8 个。
- 插件停用时自动撤掉，不用自己收尾。
- 角标每次打开主页现算，3 秒没回就不显示；`0`、空串、`null` 不显示，超过 4 个字截断（数大了自己写成 `'99+'`）；出错只写插件日志。

### 图标怎么画

- 三种写法：内置图标名（`"icon": "chat"`，同面板图标那一套，名字见「积木表」上方的清单）、一张图（`"icon": "web/icon.svg"`，深浅界面共用）、
  深浅两张（`{ "light": "web/icon-light.svg", "dark": "web/icon-dark.svg" }`，只给一张就两边共用）。
- **light / dark 按显示它的界面命名**：`light` 用在浅色界面上（所以画深色线条），`dark` 用在深色界面上（画浅色线条）。主页的明亮主题取 light。
- 文件要在 `web/` 下，svg / png / webp，单个 ≤ 200 KB。推荐 svg：64×64 画布、透明底、线条 3～4 像素、四周留 6 像素左右的边；
  png / webp 至少 192×192。主页会把图标画在和内置入口一样的玻璃方块里，所以别自己画底板、圆角和阴影。
- 图标一律当图片显示（`<img>`）。图标文件被直接打开时也带 CSP `sandbox`，svg 里的脚本不执行——别在图标里写脚本、引外部资源。

### 纯页面插件

只要页面、不需要服务端代码的插件（小工具、看板、计算器……）可以**不写 index.mjs**（清单也别写 `entry`）：

- 开关、页面、应用、英文词条照常，插件详情里和别的插件一样；打 zip、本机目录登记都行。
- 至少要声明一个页面（`ui` 的 `apps` / `panel` / `settings`，或旧写法 `web.page`），否则装不上：「这个插件既没有入口文件也没有页面」。
- 清单里明确写了 `entry` 但文件不在，照样报「缺入口文件」（多半是拼错了）。
- 页面要存数据、调外部服务时再加 `index.mjs`，挂 `/api/plugin/<id>/…` 接口，页面里用 `bridge.json(…)` 调；加完 `plugins.reload`。

建一个：`plugins.scaffold {id, name, template: "app-page"}`（或 `from: "hello-app"` 拿完整示例），再改 `web/app.html` 和两枚图标。

### 三端打开方式

- **网页 / 手机浏览器**：主页图标网格（窄屏超过 4 格时变密排、图标下带名字），点开是 bridge 自己的分页，转场同内置入口；
  最近打开的 2 个应用页保活，切回去状态还在。
- **电脑版**（桌面客户端、宽屏网页）：Dock 里排在内置入口之后；命令面板搜应用名、账户菜单里也能打开。
- **手机 App**：点图标在原生另起的干净页面里打开（同插件面板，不挂 App 的任何原生接口），返回键回主页。
- 页面里：嵌在分页里时 `bridge.info.mode` 是 `'panel'`，手机 App 里是 `'standalone'`；`bridge.app()` 返回 `{ plugin, id }`
  （同 `bridge.info.app`、`bridge.context().app`，不是应用页时为 null）——一个页面给几个应用共用时据此分辨。
- 插件被关掉、或这个人不再看得到这个应用时，开着的应用页会提示「这个应用已经不可用了」并回主页。

### 用 ui.open 带用户去应用

```
ui.open {app: "hello-app:hello"}
```

- 写成「插件id:应用id」；服务端先确认这个用户看得到、插件开着，否则报「没有这个应用，或者你看不到它」。
- 回执口径同 `ui.open` 的其他目标：`confirmed` / `opened` 为准，没回执别说已经打开。
- 给用户做好一个应用后：`plugins.reload {id}` → `ui.open {app}` 直接带过去看，比让用户自己回主页找省事。
- 不知道 app 怎么写：`ui.apps` 列出这个用户看得到的应用，每项的 app 字段原样传给 `ui.open`（成员身份只能走这条，看不到 `plugins.list`）。

## 页面宿主能力

插件页面（面板、应用页、设置区都算）除了调插件自己的接口，还能借 bridge 的手做几件事：给每个使用者存点小数据、以使用者的身份和 Claude 对话、
读写使用者亲手选中的文件、跳到 bridge 的别处、把一段话交给 Claude 分页。**不用写服务端代码**，纯页面插件也能用；完整示例是 `hello-app`。

这些走 `/api/plugin/<id>/_bridge/*`，服务端每次都重判一遍：插件开着；这个身份能用这个插件的页面（主机都行，成员要求插件有对成员开放的页面——
`who: 'members'` 的面板、应用或工作台标签）；要权限的能力，插件声明了、使用者本人也同意过。所以成员打开对成员开放的应用，用的是他自己的会话、
文件和数据；主机专用的插件，成员借页面也碰不到。

### SDK 一览

```js
bridge.can(name) → boolean                                  // 见下面「能力探测」
bridge.kv.get(key) / bridge.kv.set(key, value) / bridge.kv.delete(key) / bridge.kv.list()
bridge.grants() → { declared, granted }                     bridge.requestGrant(perm) → boolean
bridge.chat.start({ prompt, model?, effort? }) → { sessionId }   // 没授权时先自动弹授权框
bridge.chat.send(sessionId, text) → { ok, queued }
bridge.chat.on(sessionId, fn) → off()                       bridge.chat.stop(sessionId)
bridge.chat.sessions({ app? }) / bridge.chat.history(sessionId)
bridge.pick.file({ multiple?, accept? }) → [{ handle, name, size, mime, mode }] | null（取消）
bridge.pick.session() → { sessionId, title } | null
bridge.files.read(handle, { as: 'text' | 'json' | 'blob' | 'arrayBuffer' }) / bridge.files.write(handle, data) / bridge.files.stat(handle)
bridge.nav.session(id) / bridge.nav.file({ rel, ws }) / bridge.nav.app(id 或 '<插件>:<id>') / bridge.nav.settings() / bridge.nav.home()
bridge.composer.prefill(text)                               // 跳到 Claude 分页、开新对话、填好输入框，不代发
bridge.context() → { sessionId, cwd, agent, app, file }      // 工作台标签 / 侧栏里有会话；应用页里有 app；从文件菜单「用 X 打开」进来有 file；没有的为 null，agent 缺省 'claude'（没有会话时也是）
bridge.go(page)                                             // 跳到本插件别的页面（保留 bridge 给的 #）
```

| 能力 | 要不要权限 | 说明 |
|---|---|---|
| 小数据 kv | 不要 | 每个插件、每个使用者一份，别人看不到 |
| 对话 chat | 要（对话权限） | 以使用者身份跑 Claude，会话是他自己的 |
| 选文件 / 读写 | 要（文件权限） | 只能碰使用者在 bridge 选择器里选中的文件 |
| 选会话 | 不要 | 使用者在 bridge 的会话选择器里选，页面只拿到 id 和标题 |
| 跳转 / 填输入框 | 不要 | 只带使用者过去，不替他做任何事 |

### 权限声明与授权

页面权限只有两个，和清单里别的 `permissions` 不同，它们是**强制的**：没声明就调不了，声明了还要使用者本人同意。

```
page.chat    在应用页面里以你的身份和 Claude 对话
page.files   读写你在选择器里选中的文件
```

```json
"permissions": ["ui", "page.chat", "page.files"]
```

- 没声明：调用回 403，响应带 `undeclared: true`——改清单补上再 `plugins.reload`。
- 声明了没同意：回 403，响应带 `needGrant`（权限名）。SDK 的 `bridge.chat.start` 与 `bridge.pick.file` 会先自动弹授权框；别的地方自己调 `bridge.requestGrant(perm)`，用户点「允许」才回 true。
- 授权框由 bridge 自己画（「<应用>」想要……；来自插件「<插件>」），插件盖不住也改不了文案。写授权、签文件句柄、手机 App 中转这三组接口在 `/api/plugins/` 下，
  只认 bridge 自己界面发出的请求（带 `X-Bridge-UI: 1` 头），别的来路一律 403「只能从 bridge 自己的界面调用」——插件页面、插件票、外部脚本都够不着，授权只能由使用者亲手给。
- 授权按「插件 × 使用者」记，每人各自同意；在 **设置 › 页面权限** 里随时撤销（主机与成员都有这一页，各撤各的；插件详情里也列着，应用页「⋯」菜单有「页面权限」直达）。撤销文件权限时，这个插件给这个人发过的文件句柄当场作废；
  撤销对话权限（或插件停用）时，正连着的对话事件流当场断开，`bridge.chat.on` 收到一条带 `needGrant`（停用时带 `status`）的 `error` 事件后不再重连。
- 页面查现状：`bridge.grants()` 回 `{ declared: [{ id, label }], granted: { 权限名: 同意时间 } }`。

### 小数据（kv）

- key 只用字母、数字和 `. _ : -`，1～128 字；value 是能 JSON 化的任意值，单个 ≤ 256 KB，每个插件每人总共 ≤ 10 MB（超了 413）。`bridge.kv.set(key, null)` 等于删除。
- `bridge.kv.list()` 回这个人存过的全部 key。刷新页面、换设备打开都还在（存在服务器上，不是浏览器里）。
- 存在插件数据目录（`ctx.dataDir`）的 `kv/` 下，一人一个文件（主机 `host.json`，成员 `u-<账号>.json`）；插件自己的服务端代码要汇总可以去那里读，页面这条路只碰得到当前使用者的那一份。

### 对话：会话归谁、审批在哪

- `bridge.chat.start` 开的是**使用者自己的真会话**：以打开页面的这个人的身份跑（成员就是成员自己的账号、空间与额度），出现在他 Claude 分页的会话列表里，
  带应用名小标签；他在 Claude 分页里接着聊也行，页面照样收得到。prompt ≤ 100000 字；model / effort 可选，不给按他的默认设置。
- 页面只能碰**本插件替这个人开的会话**：别的会话（他自己开的、别的插件开的、别人的）发消息、订阅、看记录一律 404。`bridge.chat.sessions()` 列本插件替他开过的，新的在前，最多 100 个；
  `{ app: '<应用 id>' }` 只列这个应用开的（在应用页里开的会话记着是哪个应用开的）；转录已经删掉的会话不列。
- 这一轮还在跑时 `bridge.chat.send` 会排队，回 `{ ok: true, queued: true }`；`bridge.chat.stop` 停掉正在跑的那一轮。
- **审批不在页面里**：工具权限、计划、提问照常在 Claude 分页里批，页面没有代批的口子。收到 approval 事件时提示用户「去 Claude 分页批准」，并给一个 `bridge.nav.session(id)` 的按钮带他过去；批完会收到 approval.done。
- 出错：额度用完回 429、会话正被电脑上的 Claude Desktop / 命令行占着回 409，`message` 是人话，直接显示就行。
- `bridge.chat.on` 的事件（连上时这一会话正在跑的那一轮先补发已有的，之后跨轮一直推；30 分钟没有新的一轮服务端就断开）：

```
{ type: 'turn', userText }                                    新一轮开始
{ type: 'text', text }                                        增量文字
{ type: 'tool', id, name, status: 'start' }                   工具开始
{ type: 'tool', id, status: 'done', isError }                 工具结束
{ type: 'approval', kind: 'permission' | 'plan' | 'question', qid, title, description? }
{ type: 'approval.done', qid }
{ type: 'done', ok, result }                                  这一轮结束（result 截 20000 字）
{ type: 'done', ok: false, interrupted: true }                被停掉
{ type: 'error', kind, message }
```

- `bridge.chat.history(sessionId)` 回 `{ messages: [{ role: 'user' | 'assistant', text }] }`（最多 200 条、每条截 20000 字），重开页面时用它把前文画回来。
- 独立页（手机 App 的插件页）订阅着一个会话、又在前台时，SDK 自动告诉 bridge「有人在看」，那一轮结束就不再弹系统通知（提问与审批照弹）；页面不用做什么，嵌入模式不报。

### 文件句柄

- 页面**看不到路径**，也不能按路径读写：`bridge.pick.file` 弹 bridge 自己的文件选择器，浏览的是使用者自己的文件（主机是 vault，成员是他自己的空间）；
  选中后页面拿到的是句柄和文件名，不是路径。`accept` 写扩展名或 MIME（如 `'.md,.txt'`），`multiple: true` 可多选（一次最多 20 个）。
- `bridge.files.read(h, { as: 'text' })` 读内容，`bridge.files.write(h, data)` 存回（≤ 50 MB，先写临时文件再改名，不会写坏一半），`bridge.files.stat(h)` 回 `{ name, size, mime, mtime, mode }`（mtime 是毫秒）。
- 句柄 1 小时有效，插件停用、撤销文件权限时作废（报「文件句柄失效了……请重新选择文件」，让用户重选即可）；每个插件每人最多留 200 个，多了挤掉最旧的。
- 链接到使用者空间以外的文件、受保护位置的文件不发句柄；每次写入前都重新核对一遍。mode 为 `r` 的句柄只能读，写会 403。

### 手机 App 的差异

手机 App 里插件页面在原生另起的干净页面里打开，没有宿主页可以代办：

- kv、chat、files 直接带插件票请求，和嵌在网页里时一样能用（对话事件用流式读取）。
- 要 bridge 自己画界面的那几样（跳转、填输入框、授权框、选文件、选会话）要**新版 App**：App 切回主界面处理，选文件 / 授权 / 选会话处理完回到插件页，
  页面那头的 Promise 照常拿到结果；跳转与填输入框把插件页压到主界面后面、去目的地，按返回能回到插件页。处理请求 10 分钟内有效，每个插件每人最多挂 20 个没处理的。
- 旧版 App 里这几样会抛错「这个操作要在新版 bridge App 里才能用」——先用 `bridge.can` 探测，把用不了的按钮藏掉。

### 能力探测

页面里用 `bridge.can(name)` 判断当前环境能不能用，认这些名字（嵌在网页里看宿主支持什么；手机 App 里 kv / chat / files 恒真，其余看是不是新版 App）：

```
nav  composer  pick.file  pick.session  grant  chat  files  kv
```

```js
if (!bridge.can('pick.file')) pickBtn.hidden = true;
```

插件服务端代码判断这台 bridge 有没有这些能力，用 `ctx.has`，能力名：

```
page.kv  page.grants  page.chat  page.files  page.nav  page.host
```

声明式应用、ctx.ui.refresh、文件「用 X 打开」、命令面板、侧栏固定、市场应用分类各有能力名，见「接口版本与兼容承诺」里的能力名表。

## 做一个应用

用户说「给我做个 X」（记账本、待办、库存表、值班表、读书笔记、问答助手……）时按这条路走，几分钟就能让他在主页点开用上：

1. **建**：选好模板（见下），调 `plugins.scaffold {id, name, template}`。id 用小写英文（如 `expense`）；name 是主页上的标题，超过 20 字会被截断，
   不能和 bridge 自带的入口重名（Claude、设置、主页、工作空间……）。建好就已登记、启用，主页上已经多了这枚图标；应用 id 固定是 `main`。
2. **改**：照下面的写法改生成的文件。
3. **重新加载**：`plugins.reload {id}`。**bridge 不监视文件，每次改完都要 reload**；返回的 `plugin.status` 不是 active 就看 `plugin.error` 修。
4. **自测，再带过去**：本机这台 bridge 的地址就在 `plugins.scaffold` 返回的 `local` 里（和 `whoami` 返回的 server 里的 `local` 是同一个，
   如 `http://127.0.0.1:8787`）——**别去扫本机端口找**，一台机器上常同时开着好几个 bridge，猜错就测到别的实例上了。
   在内置浏览器里打开 `<local>/`（就是 bridge 的主页），点这个应用的图标，点一遍改过的地方；先 find / read_page 拿 ref 再按 ref 点：
   按文字点会点中页面上第一个同名的可点元素，而图表图例、标签页、分段按钮常常同名（「收入」「支出」）。
   然后 `ui.open {app: "<插件id>:main"}` 把用户的界面带过去，以回执的 `confirmed` / `opened` 为准，没回执别说已经打开。
5. **交代**：告诉用户主页上的图标叫什么、数据存在哪、谁能用（模板生成的应用只有服务器主机看得到，见下）。

### 选模板

| template | 什么时候选 | 生成什么 |
|---|---|---|
| `app-view` | **首选**。界面是常规的统计、列表、表格、表单、图表、标签页（记账、待办、库存、打卡、数据看板……）。不写 HTML，bridge 按积木画，网页、电脑版、手机 App 一个样，深浅色与英文界面自动跟上 | `index.mjs`（`ctx.ui.app` 登记 view 与 actions，示例是一份待办清单，数据存 `ctx.store`）；清单写 entry、不写 ui |
| `app-page` | 积木画不出来的界面：自定义布局与样式、画布、小游戏、拖拽、复杂交互，或者要读写用户选中的文件 | 纯页面插件：清单 ui.apps 加 `web/app.html`（SDK 起手，演示 bridge.kv 计数器），没有 index.mjs |
| `app-chat` | 应用本身就是一个对话页（问答助手、写作搭子），对话区的样子要自己定 | 同 app-page，另在 permissions 声明 page.chat；页面里一个完整对话区，会话 id 记在 bridge.kv |
| `basic`（缺省） | 不是应用：接口、给 Claude 的工具、后台任务 | 见「给用户写一个插件」 |

- 声明式应用里只是要放一块对话区，不必选 app-chat：app-view 加一块 chat 积木就行（见「和 Claude 对话的应用」）。
- 三个应用模板都生成深浅两枚图标（`web/icon-light.svg`、`web/icon-dark.svg`）、`locales/en.json` 与 README，应用都是 `who: 'host'`。
  要给成员用，把 who 改成 `'members'`：声明式应用改 `ctx.ui.app` 的参数，页面型改清单 ui.apps 里那一项。
- template 和 from、panel 不能同给。想照着完整示例改：`from: "hello-view"`（声明式）、`from: "hello-app"`（页面型）。

### 页面型应用

页面型 = 清单 ui.apps 里一项带 `page`（或 `ctx.ui.app` 带 page），点开是插件自己的网页，规矩全在「插件页面」「页面宿主能力」两节。最小例子（一个便签）：

```json
{
  "id": "memo", "name": "便签", "version": "0.1.0", "engines": { "pluginApi": 3 }, "permissions": ["ui"],
  "ui": { "apps": [ { "id": "main", "title": "便签", "page": "web/app.html",
    "icon": { "light": "web/icon-light.svg", "dark": "web/icon-dark.svg" }, "who": "members" } ] }
}
```

```html
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="/plugins/_sdk/bridge-plugin.css"></head>
<body><main class="bp-page">
  <h1 class="bp-h1">便签</h1>
  <textarea class="bp-textarea" id="text" rows="10"></textarea>
  <p><button class="bp-btn bp-btn-primary" id="save">保存</button></p>
</main>
<script type="module">
  import { bridge } from '/plugins/_sdk/bridge-plugin.js';
  await bridge.ready();                                   // 先等宿主交过来主题、语言、身份
  const box = document.getElementById('text');
  box.value = (await bridge.kv.get('memo')) || '';         // 每个使用者一份，存在服务器上
  document.getElementById('save').onclick = async () => {
    try { await bridge.kv.set('memo', box.value); bridge.toast('已保存'); }
    catch (e) { bridge.toast(e.message, { error: true }); }
  };
</script>
</body></html>
```

- 每人一份的小数据用 bridge.kv，不用写服务端；多人共享的数据、大数据、要定时处理的，加 `index.mjs` 挂 `/api/plugin/<id>/…` 接口，
  页面里 `bridge.json('items')` 调（加了 index.mjs 清单不用写 entry，缺省就是它）。
- 用脚本跳到本插件别的页面一律 `bridge.go('b.html')`；外部网址用 `bridge.openExternal(url)`。
- 几个应用可以共用一个页面，页面里 `bridge.app()` 分辨是哪一个。

### 声明式应用：view、actions、state

不写页面：`index.mjs` 里 `ctx.ui.app` 登记 `view` 函数，回一组积木，bridge 自己画；积木上的按钮、开关、表单按下去调 `actions` 里的同名函数，
然后用新 state 再调一次 view 重画。**只能在 index.mjs 里登记**——清单是 JSON 写不出函数，清单 ui.apps 里写 view 的那一项会被体检丢掉。

```js
ctx.ui.app({
  id: 'main', title: '记账', icon: { light: 'web/icon-light.svg', dark: 'web/icon-dark.svg' }, who: 'members',
  state: { tab: 'list' },                                   // 初始界面状态
  view: (who, { state }) => [ /* 积木 */ ],                 // 5 秒封顶，可以 async
  actions: { add: (who, { args, state }) => '已记下' },     // 60 秒封顶，可以 async
  // 另有 titleEn、order、badge、pin，同页面型应用
});
```

- `page` 与 `view` 只给一个。`who` 是身份上下文：`who.kind` 为 `'admin'`（服务器主机）或 `'user'`（成员），`who.user` 是成员账号 id（主机为 null）。
- **view** 回积木数组（也认 `{ blocks: [...] }` 或单个积木）。出错或超时，界面上画一块「应用出错了」加原因，同时写一条插件日志。
- **actions** 是 `{ 动作名: 函数 }`，动作名字母开头，只用字母、数字、下划线、连字符，≤ 41 字。动作的返回值：
  - 字符串：当提示弹出来（截 300 字）；
  - `{ state?, toast?, nav? }`：换 state、弹提示、跳转（见「跳转、刷新」）；
  - 什么都不回：用原 state 重画（数据存在 `ctx.store` 里时最常见）；
  - 抛错：用户看到出错提示（就是抛出的 message），插件日志记一条；超时回 504。
- 前端按的动作名不在 actions 里回 404「应用没有「x」这个动作」；动作参数超过 256 KB 回 413。

**state 只是界面状态**（当前标签页、筛选条件、展开了哪一项）：

- 前端按应用保管、每次随请求带上来，服务端不存；换登录身份就作废。进出都要能 JSON 化、≤ 256 KB，超了 413。
- 前端没有 state 时用初始 state（登记时按 JSON 拷了一份）。插件 reload 后，开着的页面带着旧 state 回来——view 里对缺的字段要兜底。
- **state 是前端送来的，不能当权限用**：谁能干什么只看 who。要持久化、多设备一致、多人共享的数据一律存 `ctx.store`
  （`get(k, 默认)` / `set(k, v)` / `delete(k)`）；要每人一份，就把 `who.user || 'host'` 拼进键名。
- 应用页「⋯」菜单的「刷新」带着现有 state 重拉；要「重置」，自己出一个动作回初始 state。

一个能直接改的完整例子（记账本，每人一份）：

```js
export function apply(ctx) {
  const key = (who) => 'items:' + (who.user || 'host');
  const load = (who) => ctx.store.get(key(who), []);
  const save = (who, items) => ctx.store.set(key(who), items);
  const today = () => new Date().toLocaleDateString('sv-SE');   // 本机时区的 YYYY-MM-DD；别用 toISOString，那是 UTC 日期
  ctx.ui.app({
    id: 'main', title: '记账', icon: { light: 'web/icon-light.svg', dark: 'web/icon-dark.svg' }, who: 'members',
    state: { tab: 'list' },
    view: (who, { state }) => {
      const items = load(who);
      const total = items.reduce((s, x) => s + x.amount, 0);
      const days = {};
      for (const x of items) days[x.date] = (days[x.date] || 0) + x.amount;
      return [
        { type: 'stat', items: [{ label: '笔数', value: String(items.length) }, { label: '合计', value: total.toFixed(2) + ' 元' }] },
        { type: 'tabs', value: state.tab, action: 'tab', items: [{ id: 'list', label: '明细' }, { id: 'chart', label: '按天' }] },
        state.tab === 'chart'
          ? { type: 'chart', kind: 'bar', series: [{ name: '支出', points: Object.entries(days) }], y: { unit: '元' } }
          : { type: 'list', empty: '还没有记录', items: items.map((x) => ({
              id: x.id, title: x.note || '（没写备注）', desc: x.date, badge: x.amount.toFixed(2),
              trailing: { type: 'button', label: '删除', style: 'danger', action: { name: 'remove', confirm: '删掉这一笔？' } },
            })) },
        { type: 'form', id: 'add', submit: { label: '记一笔', action: 'add' }, fields: {
          amount: { type: 'number', label: '金额', min: 0, required: true },
          note: { type: 'string', label: '备注', placeholder: '午饭' },
        } },
      ];
    },
    actions: {
      tab: (who, { args, state }) => ({ state: { ...state, tab: args.tab === 'chart' ? 'chart' : 'list' } }),
      add: (who, { args }) => {
        const amount = Number(args.values?.amount);
        if (!Number.isFinite(amount) || amount < 0) return '金额不对';
        const note = String(args.values?.note || '').slice(0, 60);
        save(who, [...load(who), { id: Date.now().toString(36), amount, note, date: today() }]);
        return '已记下';
      },
      remove: (who, { args }) => { save(who, load(who).filter((x) => x.id !== args.id)); },
    },
  });
}
```

清单只要 `{ "id", "name", "version", "entry": "index.mjs", "engines": { "pluginApi": 3 }, "permissions": ["ui"] }`，不写 ui。

### 积木表

积木是 `{ type, …字段 }`。整棵树最深 6 层（顶层算第 1 层）、最多 400 块；不认识的 type 丢掉；字符串超长截断。
`tone` 可选 `muted` / `ok` / `warn` / `error`；`icon` 是内置图标名（小写字母开头，字母、数字、连字符，≤ 24 字）；Act 是动作引用（见下一小节）。

内置图标名（应用图标、面板图标、积木里的 `icon` 共用这一套）：`star` `bolt` `bell` `chart` `calendar` `check` `checklist` `clock` `cloud` `code` `doc` `globe` `heart` `home` `link` `list` `mail` `search` `send` `settings` `tag` `user` `users` `sparkles` `translate` `bookmark` `copy` `share` `download` `upload` `refresh` `terminal` `folder` `image` `board` `wand` `robot` `chat` `plugin`。
**只有这些**——写了别的名字（比如 `plus`、`add`、`trash`）不报错，静默画成拼图图标（`plugin`）；要别的图形就给应用图标用一张 svg（见「图标怎么画」）。

| type | 字段 | 说明 |
|---|---|---|
| text | `text` ≤ 4000、`tone?`、`size?`（sm / md / lg） | 一段文字，保留换行；空的丢掉 |
| markdown | `text` ≤ 100 KB | 消毒后渲染 |
| section | `title?` ≤ 80、`desc?` ≤ 300、`children` | 分组容器；第 6 层的 section 照画，孩子丢掉 |
| stat | `items` ≤ 8：`{ label ≤ 30, value ≤ 40, delta? ≤ 20, tone?（ok / warn / error）, hint? ≤ 80 }` | 一排数字卡；value 写成字符串；label 与 value 都空的丢掉。value 一行放不下时先缩字号（按实际宽度缩，金额这类数字不会从中间折开），缩到最小还放不下才折行，多长都不会被省略号截掉；但一排四张卡时每张只有一百多像素宽，value 尽量就是数字本身（`12,000.00`），币种、单位写进 label（`结余（元）`），长说明放 hint |
| list | `items` ≤ 200、`empty?` ≤ 200 | 每项 `{ id?, title ≤ 120（必填）, desc? ≤ 300, badge? ≤ 16, icon?, tone?, action?, trailing? }`；id 是数字保留原类型，否则转字符串 ≤ 80 |
| | `trailing` | `{ type: 'switch', value, action }` 或 `{ type: 'button', label ≤ 20, action, style? }` |
| table | `columns` ≤ 12：`{ key ≤ 40, label? ≤ 40, align?（left / right / center）}`；`rows` ≤ 500；`rowAction?`；`empty?` ≤ 200 | 单元格转字符串截 200（对象转 JSON）；key 重复的列丢掉；行带 id、列里又没有 id 时保留 id |
| form | `id?`、`fields`（≤ 40）、`value?`、`submit: { label ≤ 20, action }`（必填）、`cancel?` | 没有 submit 或没有字段整块丢掉；见下 |
| chart | `kind?`（line / bar，缺省 line）、`series` ≤ 8：`{ name? ≤ 40, points: [[x, y]] ≤ 500 }`、`x?: { label? ≤ 40, type? }`、`y?: { label? ≤ 40, unit? ≤ 12 }`、`height?`（120～480） | x 是数字或 ≤ 40 字的字符串，y 是数字；x.type：category（缺省，按出现先后排）/ number / time（毫秒、秒级时间戳或日期字符串）。time 的字符串：纯日期 `2026-11-16`（或 `2026-11`）按看图那台设备的本地日期算，不会因时区错一天；带时刻不带时区（`2026-11-16T09:30`）也按本地时间；带 `Z` / `+08:00` 的按那个时区。按天统计的数据用纯日期最省事 |
| button | `label` ≤ 20、`action`、`style?`（primary / secondary / danger）、`confirm?` ≤ 200 | 有 confirm 先弹确认框 |
| buttons | `items` ≤ 6 个 button | 一排按钮 |
| tabs | `value`、`items` ≤ 8：`{ id ≤ 40, label ≤ 20 }`、`action` | value 不在列表里就选第一项 |
| empty | `title` ≤ 80、`desc?` ≤ 300、`icon?` | 空状态、提示 |
| image | `src`（`web/…` 下的 png / jpg / jpeg / webp / svg / gif）、`alt?` ≤ 200、`height?`（40～600） | 只认插件自己的图片 |
| divider | 无 | 分隔线 |
| chat | `session`（会话 id 或 null）、`onSession?`（动作名）、`placeholder?` ≤ 120、`height?`（240～800，缺省 420） | 对话区，见「和 Claude 对话的应用」 |

form 的细节：

- `id` 字母开头（缺省 `form`）；`fields` 是 `{ 键名: 字段 }`，键名规则同动作名。字段 `{ type（string / number / integer / boolean，缺省 string）, label? ≤ 40（缺省用键名）,
  desc? ≤ 200, placeholder? ≤ 120, enum?（≤ 50 项，boolean 不收）, widget?（textarea / password / segmented）, min? / max?（数字类型才有）, required?: true }`。
  没有日期、时间类型：写别的 type 不报错，按 string 处理、不做任何校验。日期用 string 加 placeholder `YYYY-MM-DD`，在动作里自己校验。
- `value` 是初始值（JSON ≤ 64 KB），只收字段里有的标量键，字符串截 20000。前端先校验必填、数字、整数、min / max、enum，过了才提交；
  提交成功清回初始值，没提交的草稿离开页面再回来还在。空着的数字项不带。
- `cancel`：字符串 = 一个清回初始值的按钮（字符串就是标签）；`true` = 默认标签；`{ label, action? }` = 另带一个动作。

### 动作引用（Act）与参数

积木里 `action` / `rowAction` / `submit.action` 写 Act：动作名字符串，或 `{ name, args?, confirm? }`。

- `name` 必须是这个应用 actions 里有的；`args` 是普通对象，JSON ≤ 16 KB，坏了整个 Act 作废；`confirm` ≤ 200，有就先弹确认框。
- Act 不合格时：只为按动作而存在的控件（button、form、tabs、行尾按钮、行尾开关）**整个丢掉**；列表行点击、表格行点击只去掉动作。
  **规范化不报错**：积木没画出来，先查动作名拼对没有、在不在 actions 里、form 有没有 submit 和字段、list 每项有没有 title。
- 按下去时前端把控件自己的参数并进 args，**并入的盖住 Act 里写的**：

| 控件 | 并入 args |
|---|---|
| 列表行点击 | `{ id }`（行有 id 时） |
| 行尾按钮 | `{ id }` |
| 行尾开关 | `{ id, value: 新值 }` |
| 表格行点击 | `{ row }`（规范化后的行：各列的字符串，加上可选的 id） |
| 标签页 | `{ tab: 新 id }` |
| 表单提交 | `{ values }`（校验过、按类型转好的值） |
| button、表单 cancel 带的动作 | 不并入 |

```js
{ type: 'button', label: '删除', style: 'danger', action: { name: 'remove', args: { id: x.id }, confirm: '删掉这一条？' } }
// 动作里：remove: (who, { args }) => { … args.id … }
```

- 一个应用同一时刻只跑一个动作（防连点），跑着时那个控件转圈。args 是前端送来的，当不可信输入校验（类型、长度、id 在不在）。

### 跳转、刷新

动作回 `nav` 把用户带走：

```
'back'                             回上一页（关掉应用页）
'home'                             回主页
{ session: '<会话 id>' }            打开 Claude 会话
{ file: { rel, ws? } }              把文件推进预览
{ app: '<id>' 或 '<插件>:<id>' }     打开另一个应用
{ url: 'https://…' 或 '/…' }        外部网址（http / https，或单个 / 开头的站内地址，不能 //）
```

- 不认识的写法丢掉、不报错（动作本身已经做完了）。动作回来时人已经不在这个应用前台，就不替他跳。
- 跳会话、跳应用之后，按系统返回能回到这个应用。

插件那头数据变了（定时任务、外部回调、别人改了共享数据），让开着这个应用的页面重拉：

```js
ctx.ui.refresh('main');            // 推给所有开着它的人
ctx.ui.refresh('main', { who });   // who 给身份上下文：只推那个人
```

只是通知、不带数据：前端收到后带着自己的 state 重调 view。动作跑着时收到的，等动作回来再拉。

### 和 Claude 对话的应用

两条路，都是以**使用者自己的身份**开真会话（出现在他 Claude 分页的会话列表里），都要在清单 permissions 声明 page.chat，第一次用时 bridge 弹授权框。
成员要能用，应用得是 `who: 'members'`。审批、提问页面里批不了，都引导去 Claude 分页。

**声明式：chat 积木**（不用写前端）：

```js
const key = (who) => 'chat:' + (who.user || 'host');
ctx.ui.app({
  id: 'main', title: '问答', who: 'members',
  view: (who) => [
    { type: 'text', text: '有什么想问的？', tone: 'muted' },
    { type: 'chat', session: ctx.store.get(key(who), null), onSession: 'saveSession', placeholder: '问点什么…' },
    { type: 'button', label: '新对话', action: 'newChat' },
  ],
  actions: {
    saveSession: (who, { args }) => { ctx.store.set(key(who), args.sessionId); },
    newChat: (who) => { ctx.store.delete(key(who)); },
  },
});
```

- session 为空：只有输入框；发第一句时先确认授权、开会话，再调 `onSession` 动作并入 `{ sessionId }`，插件把它存进 `ctx.store`（或 state）。
  没接 onSession 也能聊，只是重开应用、换设备后就接不上了。
- session 有值：先画出历史，再接上实时输出；跑着时有「停止」，等审批时有「去处理」（去 Claude 分页，按返回回到应用），右上「在 Claude 里打开」看完整过程。
- 没声明 page.chat 时，这块换成一块提示「对话积木用不了」。
- chat 积木发出去的就是用户敲的原话；要给第一句拼上背景资料，用页面型。

**页面型：bridge.chat**（app-chat 模板就是这样，那份更完整：画历史、停止、新对话）：

```js
let sid = await bridge.kv.get('session');
let off = null;
const log = document.getElementById('log');
const follow = () => { off = bridge.chat.on(sid, (ev) => {
  if (ev.type === 'turn') log.textContent += '\n\n你：' + ev.userText + '\nClaude：';
  else if (ev.type === 'text') log.textContent += ev.text;
  else if (ev.type === 'approval') bridge.toast('Claude 在等你批准，去 Claude 分页处理');
  else if (ev.type === 'error') {
    bridge.toast(ev.message, { error: true });
    if (ev.kind === 'stream') off = null;   // 订阅被切断（撤销了对话权限、插件停用），SDK 不再重连
  }
}); };
if (sid) follow();
document.getElementById('send').onclick = async () => {
  const text = document.getElementById('q').value.trim();
  if (!text) return;
  if (!sid) { sid = (await bridge.chat.start({ prompt: '背景：……\n\n' + text })).sessionId; await bridge.kv.set('session', sid); follow(); }
  else { await bridge.chat.send(sid, text); if (!off) follow(); }   // 被切断过就发出之后重订：服务端先补发正在跑的这一轮
};
```

事件、历史、排队、会话归属见「页面宿主能力 › 对话：会话归谁、审批在哪」。

### 调试与重新加载

- **没有文件监视**：改了 index.mjs、清单、web/ 下的文件，都要 `plugins.reload {id}`。reload 后在线页面自动重拉登记，开着的声明式应用页也自动按新代码重拉视图；页面型应用只有 web/ 下的文件变了才要让用户点「⋯ › 刷新」或重开。
- 插件日志：`plugins.status {id, logs: "plugin"}`（也在插件详情「日志」里）。view 出错或超时、动作出错或超时、图标文件缺失都写在这里；`ctx.log(…)` 打自己的。
- 清单问题（拼错字段、应用 id 或标题不合格、清单里写了 view）在插件详情「清单体检」里，不合格的应用不登记。
- `ctx.ui.app`、`ctx.ui.fileHandler` 参数不合格当场抛错，apply 跟着失败，`plugins.reload` 回的 `plugin.error` 里就是原因。
- 积木少了一块多半是被规范化丢了（见「动作引用」）。界面上出现「应用出错了」= view 抛错或超过 5 秒，原因就写在那块下面。

### 把用户带到新应用

- `ui.apps` 列出这个用户此刻看得到的应用：`{ apps: [{ app: '<插件>:<id>', title, plugin, pluginName, kind }] }`，kind 为 page 或 view。
  成员身份看不到 `plugins.list`，查应用只能走它；who 为 host 的应用成员看不到。
- `ui.open {app}` 把 app 字段原样传过去（如 `{app: "expense:main"}`）；用户开着几台设备时可以带 device 指定一台手机（见 `ui.view`）。
- 用户说找不到：主页最多摆 8 格（含 bridge 自带的入口），多出来的在「更多」里；电脑版在 Dock 和命令面板里。

### 更多插槽：文件、命令面板、侧栏、市场

```js
// 文件菜单多一项「用「CSV 查看器」打开」→ 打开本插件的页面型应用
ctx.ui.fileHandler({ id: 'csv', title: 'CSV 查看器', exts: ['csv', 'tsv'], app: 'main', who: 'members' });
// 页面里：const { file } = bridge.context();   // { handle, name, size, mime, mode }，直接 bridge.files.read(file.handle, { as: 'text' })

// 命令同时收进桌面版 Ctrl+K 命令面板
ctx.ui.command({ name: 'standup', description: '写站会', template: '总结一下今天做了什么：', palette: true });

// 应用固定到 Claude 分页侧栏的「应用」组（清单 ui.apps 里同样认 "pin": "sidebar"）
ctx.ui.app({ id: 'board', title: '看板', page: 'web/board.html', pin: 'sidebar' });
```

- **fileHandler**：`title` 1～20 字；`exts` 小写、不带点（开头的点会去掉），≤ 20 个，也可以写成 `match: { ext }`；`app` 是本插件**已登记的页面型**应用
  （id 或 `插件:id`；先在清单里写，或先调 `ctx.ui.app`），声明式应用拿不到文件。插件要在 permissions 声明 page.files，否则抛错。
  用户从文件菜单点进来不再弹授权框，句柄是为这一次打开签的。
- **palette**：模板命令在面板里选中后开新对话、填好模板、不代发；带 handler 的命令回的 insert 同样交给新对话。
- **pin**：只认 `'sidebar'`，别的值写一条 warn 后忽略。页面型在侧栏里像工作台标签一样嵌入，`bridge.context()` 带当前会话；声明式照样按积木画；
  手机 App 里页面型走原生独立页。
- **市场分类**：清单写 `"category": "app"` 的插件在设置 › 功能扩展里归进「应用」一组；官方市场索引条目的 `category: 'app'` 与 `icon`（只认 https 地址）
  让它出现在市场的「应用」分类里（分类筛选：全部 / 应用 / 其它）。

## 英文界面（locales/en.json）

第三方插件没法往 bridge 的字典里加词：英文界面下，名称、说明、设置表单、面板标题优先用插件目录 `locales/en.json` 里的词条，没有就照中文显示。
写法按字段路径覆盖清单里的人话，`config` 与 schema 同构：

```json
{
  "name": "QQ bot",
  "description": "…",
  "ui": { "panel": { "title": "QQ bot" }, "app": { "board": { "title": "Board" } } },
  "config": {
    "prefix": { "label": "Trigger prefix", "desc": "…", "section": "When to answer" },
    "mode": { "label": "Endpoint", "enum": { "external": "Already running", "managed": "Started by bridge" } },
    "groups": { "label": "Per-group settings", "key": { "label": "Group number" },
                "value": { "fields": { "enabled": { "label": "Answer in this group" } } } }
  }
}
```

子字段写在 `fields` 下（object、map 的值），列表项写 `items`，map 的键写 `key`；枚举的英文名写成 `enum: { 取值: 英文名 }`。
旧写法 `ui.panel.titleEn` 照认。应用的英文标题写在 `ui` 下的 `app.<应用id>.title`，优先于清单里的 `titleEn`（和 bridge 自带入口重名的不用）。

## 安装与分发

- **本机目录**：开发时用，代码直接从那儿加载，改了点「重新加载」。
- **zip**：把插件目录打成 zip（清单在包根，或唯一的一层子目录里——GitHub 下载的 zip 就是这样），在功能扩展 › 添加 › 上传 zip。
  覆盖安装同 id 的插件 = 升级，旧版进数据根 `plugins/.trash/`（留最近 3 份）。
- **GitHub 地址**：功能扩展 › 添加 › GitHub 地址，填 `owner/repo`、`owner/repo@ref` 或仓库网址。没写 ref 装最新 Release
  （有 .zip 资产用资产，没有用该 tag 的源码包），没发过 Release 用默认分支。详情页「检查更新」比最新 Release 的版本号。
  只从 github.com / codeload / 资产域下载，重定向逐跳校验，包最大 50MB。
- **插件市场**：见下一节；任何人都能投稿的**社区插件市场**见再下一节。
- **agent 接口**：`plugins.list` / `plugins.status` / `plugins.toggle` / `plugins.config` / `plugins.action` / `plugins.scaffold` / `plugins.link` / `plugins.reload` /
  `plugins.install_github` / `plugins.check_update` / `plugins.uninstall` / `plugins.market` / `plugins.market_install` / `plugins.rollback` / `plugins.restore_builtin` /
  `plugins.community_account` / `plugins.community_check` / `plugins.community_publish` / `plugins.community_status`。

开关和配置存在数据根的 `plugins.json`；装的插件在 `plugins/<id>/`；插件数据在 `plugin-data/<id>/`。

## 插件市场

设置 › 扩展 › 功能扩展里的「插件市场」分「官方」与「社区」两栏。这一节讲官方：bridge 官方发布的插件，第三方作者的插件在社区那一栏（见下一节）。不用升级 bridge 就能装新插件、更新插件，
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

## 社区插件市场

任何 bridge 用户都能把自己的插件发上来，别的 bridge 用户在「插件市场 › 社区」里看到、安装。**只有自动检查，没有人工审核**——
给用户装之前、替用户发布之前都要把这一点说清楚。

**装的人这边**
- 社区索引是另一个签过名的文件（仓库 Wode44398/bridge-plugins 的 Release「community-index」），用另一把钥匙签；条目带
  `publisher`（作者的 GitHub 账号，权威身份）、每个版本的 `kind` 与 `caps`：
  - `kind: "page"` 纯页面插件：没有服务端代码，只在沙箱页面里跑，用到对话、文件时还会单独问使用者；
  - `kind: "server"` 含服务端代码：在这台服务器上以 bridge 的**全部权限**运行（能读写服务器上的文件、用账号）。
    `caps` 是自动检测到的能力：process 运行外部程序、network 访问网络、files 读写服务器上的文件、env 读环境变量、core 调用 bridge 内部模块。
- 装 `kind: "server"` 的社区插件必须带 `ack: true`；没带回 needAck（里面有作者、能力的中文标签）。agent 只能在用户看过这些、明确同意后带 ack。
- 社区插件永远不能盖内置功能，也不能用官方插件的 id；同一个 id 官方与社区都有时只认官方。
- **下架**：维护者可以吊销某些版本或整个插件。bridge 拉到索引后，已装的被吊销版本**自动停用**并提醒主机，之后不能再启用（toggle 回 conflict），
  也不能回退到被吊销的版本；卸载它，或装一个没被吊销的新版（装上后开关自动恢复）。条目里的 `report` 是举报链接（GitHub issue）。
- `config.json` 的 `pluginMarket.community: false` 只关社区市场；`pluginMarket.community.index` / `publicKeys` 换成自建的社区索引。

**发布的人这边**（只有服务器主机能发）
- 设置 › 扩展 › 功能扩展 › 插件详情 › 「发布到社区」：自己装的或本机开发目录里的插件都能发。用作者自己的 GitHub 账号：
  这台电脑 gh 登录过就直接用；否则在面板里用 GitHub 设备码登录，或粘贴一个有 public_repo 权限的令牌（令牌只存在服务器上，不经过对话）。
- 流程：本地预检（与市场仓库 CI 同一份规则）→ 以作者的账号 fork 市场仓库、把插件目录提交到 `community/<id>/`、开拉取请求 →
  CI 自动检查，通过就自动合并、打包、签名上架（几分钟）；没通过会在拉取请求里留言写原因，改完重新发布即可（同一个拉取请求会更新）。
- 规则（不通过就上不了架）：
  - 文件 ≤300 个、单个 ≤2 MB、合计 ≤8 MB；只收代码、文本、网页、图片、字体；不许 node_modules（依赖写成纯 JS 放进插件目录）、点开头的文件；
  - 清单 id 与目录名一致、version 写成 x.y.z 且比已上架的大、要写 `engines.pluginApi`；不许 `replaces`（社区插件不能接管 bridge 自带的入口）；
  - 要有这一版的更新说明（发布面板里填，或插件目录里的 market.json：`{"notes": {"1.0.0": "…"}, "nameEn": "…", "descriptionEn": "…"}`）；
  - 服务端代码（web/ 以外的 .mjs / .js / .cjs）要能读：不许压缩、混淆、内嵌大段编码数据；不许 `eval`、`new Function`、`vm`、
    `createRequire`、`WebAssembly`，`import()` / `require()` 的参数必须是写死的字符串；
  - 插件 id 先到先得、绑首个投稿者的 GitHub 账号，之后只有本人能发新版本；内置功能、agent 扩展、官方插件的名字和 `bridge-` / `official-` 开头的 id 不给用。
- agent 替用户发布：`plugins.community_account` 看有没有登录（没有就请用户去面板里登录）→ `plugins.community_check {id, notes}` 修到 ok →
  用户确认要公开发布后 `plugins.community_publish {id, notes}` → `plugins.community_status {id}`（checking 检查中 / failed 没通过 / merged 已合并 / live 已上架）。
- 每个版本的包由 CI 从源码确定性打包，sha256 写进签名索引：作者事后改不了已上架的包，任何人都能从仓库里的源码复现同一个 sha256。

## 内置插件

| id | 名称 | 说明 |
|---|---|---|
| preview-host | 公网预览 | pv-<令牌>.<域名> 转本机开发服务器 / 设备端口 |
| public-access | 公网访问 | 托管 cloudflared 隧道（重启生效） |
| agent-api | 给 agent 的接口 | /agent 接口、项目手册、Claude 的 bridge 工具 |
| feedback | 反馈 | 设置里的反馈 |
| routines | 定时任务 | 按时间表跑 Claude |
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
