# 插件（功能扩展）

bridge 的功能都是插件：内置功能（定时任务、分享链接、设备、手机操控、内置浏览器、共享终端……）是默认开着的一组，Gemini / ChatGPT / dimensio 三个 agent 扩展也在同一张表里，第三方插件装进来和它们平起平坐。用户在「设置 › 扩展 › 功能扩展」里逐项开关、改配置、装插件；你用 `plugins.*` 操作做同样的事（只有服务器主机能用）。

## 看状态、开关、改配置

- `plugins.list`：每个插件的 status（active 在跑 / disabled 关着 / blocked 缺依赖 / error 出错）、enabled、restart（改了要重启服务端）、pendingRestart、schema 与 config。
- `plugins.toggle {id, enabled}`：热插件当场生效（接口、Claude 工具、后台任务一并挂上 / 摘下）；restart 插件落盘后等重启。关掉用户正在用的功能前先问。
- `plugins.config {id, config}`：先 `plugins.list` 取当前 config，改完整体传回（没传的项回到默认值）；secret 项传打码串「••••••••」= 沿用旧值；错一项整体拒，错误里写着哪一项。
- 关着的内置功能，它的接口、Claude 工具、agent 操作都不在；对应手册章节在目录里会注明「这台服务器关着这项功能」。
- `plugins.status {id, logs?}`：插件自报的状态块、托管的子进程（带 logs=子进程名 附日志尾巴）、入站回调地址、动作按钮；`plugins.action {id, action}` 按按钮。
- `plugins.install_github {repo}` 从 GitHub 装（只装用户点名、信得过的仓库，先确认）；`plugins.check_update {id}` 看有没有新版。
- 授权字段（`type:"user"` + `grant:"chat"`）新选了服务器主机或 Pro 档账号时，`plugins.config` 要带 `confirmGrant: true`——先问用户。

{{ops:plugins}}

## 给用户写一个插件

用户想要的能力 bridge 没有时（接一个内部系统、加一个 Claude 工具、定时同步某个数据、做个 QQ / 微信机器人……），直接写成插件。
只有服务器主机能建插件（插件和 bridge 同进程、权限相同）；成员问起就说明要主机来装。

1. **建骨架**：调 `plugins.scaffold {id, name?, description?, panel?, from?}`。缺省在你工作空间下建 `plugins-dev/<id>/` 并登记启用；
   `panel: true` 带一个控制面板页面；`from: "hello-world"` / `from: "qq-onebot"` 拿示例整个当起点（id 自动换成新的）。返回目录与文件清单。
2. **改代码**：照本章下面的参考改 `bridge-plugin.json`（名字、配置 schema、`ui`）和 `index.mjs`（`apply(ctx, config)`），用你的文件工具直接写。
3. **重新加载**：`plugins.reload {id}`，不用重启服务；返回的 `plugin.status` 不是 active 时看 `plugin.error` 修（语法错、apply 抛错都写在那）。
4. **试**：插件的接口用 curl / 内置浏览器调；有面板就让用户去设置里「插件」组点开看；`plugins.status {id}` 看状态块、子进程、回调地址。
   插件给 Claude 的工具**要下一条消息才出现**（工具集在这一轮开始时就定了），告诉用户「发下一条消息就能用」。
5. **交付**：告诉用户插件在哪、怎么开关、设置里要填什么；要给别人用就把目录打成 zip（设置 › 功能扩展 › 添加 › 上传 zip），或放到 GitHub 用「GitHub 地址」装。

两个示例的完整代码就在程序目录 `src/plugins/examples/` 下（`hello-world` 最小；`qq-onebot` 用到以账号跑 Claude、收外部推送、托管外部程序、分组表单、状态块、控制面板），不知道某个能力怎么写时先读对应示例。

## 插件目录

```
weather/
├─ bridge-plugin.json    清单（必需）
├─ index.mjs             入口（必需，清单 entry 可改名）
├─ lib/…                 随意拆文件，相对路径 import
├─ web/index.html        插件页面（可选，见「插件页面」）
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
| `engines` | 兼容要求：`{ "bridge": ">=6.70", "pluginApi": 2 }`。不满足就拒装、拒加载并说明原因。写法：`>= > <= < =`、`^`（同主版本）、`~`（同主次版本）、空格 = 且、`\|\|` = 或 |

### 入口

```js
export function apply(ctx, config) {
  // 在这里登记：接口、Claude 工具、agent 操作、定时器……
  // 也可以 return 一个函数，停用时调用
}
```

也认 `export default { apply(ctx, config) {}, config: {…} }`（配置 schema 写在代码里时）。

引用 bridge 核心模块：`import { busPublish } from '@bridge/core/runtime/bus.mjs'`（`@bridge/core/` = 程序的 `src/`）。
第三方 npm 包：插件目录自带 `node_modules`；找不到时回落到 bridge 自己的依赖（sharp、MCP SDK 等不用再装一份）。

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
- 改配置后热插件当场按新配置重启（先撤掉旧的，再 `apply` 一遍）。

## ctx 参考

登记的东西都会在**停用 / 改配置 / 重新加载**时按相反顺序自动撤销。

### 基础

| | |
|---|---|
| `ctx.id` / `ctx.config` / `ctx.meta` | 插件 id、生效配置（只读）、清单信息 |
| `ctx.log()` / `ctx.warn()` / `ctx.error()` | 带 `[plugin:<id>]` 前缀的日志 |
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
| `ctx.http.admin(req, res)` | 要求服务器主机 |
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

`turn`：`{ kind: 'chat' | 'routine', ctx（身份上下文：kind、cwd、sandbox…）, snap, message, sessionId, getGen() }`。
快照访客永远拿不到插件工具。工具集在 Claude 进程起来时定下，插件开关 / 重载后下一条消息自动换新。

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

## 以账号身份做事（ctx.chat / files / share）

插件要「替某个人问 Claude」时（QQ / 微信 / 邮件机器人、工单自动回复……），不用登录、不用自己调 `/api/chat`：

```js
const turn = ctx.chat.run({
  as: config.runAs,            // 必须是设置里 type:'user' + grant:'chat' 字段选过的账号
  session: 'qq:774176839',     // 插件自己起的会话键：核心记下真实会话，下次同键自动续写
  message: '今天天气怎么样',
  attachments: [ctx.files.put(config.runAs, imageBuffer, 'a.jpg')],   // 可选：图片直接给 Claude 看
  model, effort,               // 可选，缺省跟账号默认
  prompt: '你在 QQ 群里答问…', // 可选：追加的系统提示
  label: 'QQ · 某群',          // 可选：会话列表里的来源标签
});
for await (const ev of turn.events) { /* queued / start / text / tool / note / done */ }
const { text, files, sessionId, isError } = await turn.result;   // files = 回答里链接到的真实文件
turn.stop();
```

- 执行器与定时任务同一份：账号的沙箱围栏、额度、计费、号池换号照常生效；**无人值守**：不出审批卡（工具按账号档位直接放行或拒绝）、
  提问直接取消、不进计划模式；不会顶掉这个账号在前端正在进行的对话。
- 排队由核心做：同一个 `session` 串行，不同 `session` 并行，同一账号最多 2 路（`ctx.chat.configure({ maxParallel: 1..4 })`）。
- `ctx.chat.reset(as, session)` 忘掉记着的会话（下次开新对话）；`ctx.chat.sessionOf(as, session)` 查真实会话 id。
- 多用户模式关着时，只能用「服务账号」（账号设置里勾的那种）。

| | |
|---|---|
| `ctx.files.put(as, buffer, name)` | 存进该账号的上传目录，返回绝对路径（能当 `attachments`） |
| `ctx.files.root(as)` | 该账号的工作区根目录 |
| `await ctx.share.space(as, paths)` | 把该账号工作区里的文件 / 文件夹做成公开只读在线工作空间，返回 `{ url, path, token, expiresAt }` |

## 外部程序与回调（ctx.process / webhook）

```js
const p = ctx.process.spawn('napcat', { command: 'D:/napcat/napcat.bat', cwd: 'D:/napcat', restart: 'on-failure', maxRestarts: 5 });
p.on('exit', ({ code }) => …); p.restart(); p.stop(); p.tail(100);   // p.state：starting / running / backoff / stopped / failed

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

## 显示位（状态块、动作按钮、动态选项、store）

| | |
|---|---|
| `ctx.status(fn)` | 详情页顶部的状态块：`fn()` 返回 `{ tone: 'ok' \| 'warn' \| 'error' \| 'idle', text, items: [{ label, value }] }`（可 async）。`ctx.status.refresh()` 立刻重算并推给在线页面 |
| `ctx.action({ id, label, desc?, danger?, confirm?, handler(who, args) })` | 详情页按钮（也是 agent 接口 `plugins.action`）；返回字符串当结果提示 |
| `ctx.configOptions(field, fn)` | `options: "plugin"` 字段的选项：`fn(who)` 返回 `[{ value, label, desc? }]`。登记 `'groups'` 同时管 `'groups.$key'`，登记 `'list'` 同时管 `'list[]'` |
| `ctx.bus.toPage(type, payload)` | 推给插件自己的页面（SDK 里 `bridge.on(type, fn)` 收） |
| `ctx.store` | `<数据目录>/store.json` 的键值存储：`get(k, 默认)` / `set(k, v)` / `delete(k)` / `all()`，防抖落盘、停用时写完 |

子进程与回调的状态自动并进状态块，不用自己报。

## 插件页面

`web/` 下的文件由 bridge 在 `/plugins/<id>/web/` 提供（插件开着才给）。清单 `ui` 声明放在哪：

- `ui` 的 `panel`：控制面板。设置侧栏（手机是设置首页）多一组「插件」，一个插件一行，点进去全幅显示。
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

- 嵌在 bridge 里时，请求由宿主页代发、带宿主自己的登录态，只放行 `/api/plugin/<本插件>/` 下的路径；
- 独立打开（「在新窗口打开」、手机 App）时，地址的 `#t=` 带一张**插件票据**：只对本插件的 `/api/plugin/<id>/` 有效，
  10 分钟不用就失效、用着就续（最长 12 小时），插件停用即作废；身份是打开面板的那个人。
- 手机 App 里面板在原生另起的干净页面里打开（不挂 App 的任何原生接口）。
- 主题：`<html>` 有 `data-theme`（dark / light）和 `data-mode`，`--bp-*` 颜色变量随 bridge 实时变；`bridge-plugin.css` 提供
  `.bp-page / .bp-section / .bp-group / .bp-row / .bp-btn / .bp-input / .bp-switch / .bp-seg / .bp-badge` 等现成控件，默认就和设置页一个样子。

## 安装与分发

- **本机目录**：开发时用，代码直接从那儿加载，改了点「重新加载」。
- **zip**：把插件目录打成 zip（清单在包根，或唯一的一层子目录里——GitHub 下载的 zip 就是这样），在功能扩展 › 添加 › 上传 zip。
  覆盖安装同 id 的插件 = 升级，旧版进数据根 `plugins/.trash/`（留最近 3 份）。
- **GitHub 地址**：功能扩展 › 添加 › GitHub 地址，填 `owner/repo`、`owner/repo@ref` 或仓库网址。没写 ref 装最新 Release
  （有 .zip 资产用资产，没有用该 tag 的源码包），没发过 Release 用默认分支。详情页「检查更新」比最新 Release 的版本号。
  只从 github.com / codeload / 资产域下载，重定向逐跳校验，包最大 50MB。
- **agent 接口**：`plugins.list` / `plugins.status` / `plugins.toggle` / `plugins.config` / `plugins.action` / `plugins.scaffold` / `plugins.link` / `plugins.reload` /
  `plugins.install_github` / `plugins.check_update` / `plugins.uninstall`。

开关和配置存在数据根的 `plugins.json`；装的插件在 `plugins/<id>/`；插件数据在 `plugin-data/<id>/`。

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
