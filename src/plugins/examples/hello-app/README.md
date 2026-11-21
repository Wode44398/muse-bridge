# 你好应用（示例插件）

bridge「应用」的最小示例：一个**纯页面插件**（没有 `index.mjs`，不跑任何服务端代码），装上后主页多一个图标，点开是一个全屏分页。
页面里顺带演示三样「页面宿主能力」——不写服务端代码也能存数据、和 Claude 对话、读写使用者选中的文件。

| 做了什么 | 在哪 |
|---|---|
| 主页图标 + 全屏分页「你好应用」，成员也看得到 | `bridge-plugin.json` 的 `ui.apps`（`who: "members"`） |
| 深浅两枚图标（浅色界面用 light、深色界面用 dark） | `web/icon-light.svg`、`web/icon-dark.svg` |
| 计数器：点一下加一，存在服务器上，刷新页面、换设备都还在（`bridge.kv.get` / `bridge.kv.set`） | `web/app.html` 第一块 |
| 和 Claude 对话：以使用者身份开真会话，流式显示回复，能停、能接着说；要审批时提示「去 Claude 分页批准」并带跳转（`bridge.chat.start` / `bridge.chat.send` / `bridge.chat.on` / `bridge.chat.stop`） | `web/app.html` 第二块 |
| 选一个文件显示前 2000 字、改完存回（`bridge.pick.file` / `bridge.files.read` / `bridge.files.write`），页面只拿到句柄、看不到路径 | `web/app.html` 第三块 |
| 对话与文件要使用者同意：清单声明 page.chat、page.files 两个页面权限，第一次用时 bridge 弹自己的授权框 | `bridge-plugin.json` 的 `permissions` |
| 用 `bridge.can` 探测能力，老版本 bridge、旧版 App 里把用不了的那块藏掉 | `web/app.html` |
| 页面环境：显示 `bridge.info`、`bridge.context()`、`bridge.app()`，一个按钮弹提示 | `web/app.html` 末尾 |
| 英文界面的名字与应用标题 | `locales/en.json`（`ui.app.hello.title`） |

## 装上试试

- **本机开发**（改完点「重新加载」即生效）：设置 › 扩展 › 功能扩展 › 添加 › 本机目录，填这个目录的绝对路径。
- **打包安装**：把这个目录打成 zip，设置 › 扩展 › 功能扩展 › 添加 › 上传 zip。
- **从它起步**：让 bridge 里的 Claude 调 plugins.scaffold（from 填 hello-app），或者命令行 `npm run plugin:new -- my-app --from hello-app`；
  要一个更干净的起点用模板：template 填 app-page（纯页面）或 app-chat（对话页）。

装好后回主页就能看到「你好应用」；手机 App 里点开是独立的干净页面。也可以让 bridge 里的 Claude 用 `ui.open` 的 `app` 参数（`hello-app:hello`）直接带你过去。

## 往下写

- 要服务端接口（存数据、调外部服务）：加一个 `index.mjs`（`export function apply(ctx) { … }`），页面里用 `bridge.json('…')` 调 `/api/plugin/<id>/…`。
- 要角标或按身份变的应用：在 `apply` 里用 `ctx.ui.app({ id, title, page, badge })` 动态登记，同 id 的盖住清单里的。
- 只要存点小数据、和 Claude 聊、读写用户的文件，用不着服务端代码：照 `web/app.html` 的三块写，清单里声明用到的页面权限。
  使用者给过的授权在 设置 › 页面权限 里能看、能撤销。
- 界面是常规的列表、表单、统计、图表，不想写前端：做成声明式应用，见示例 `hello-view`。

完整写法见 bridge 项目手册「插件」章的「做一个应用」「应用：主页图标与全屏分页」「页面宿主能力」三节（bridge 里的 Claude 用 bridge 工具的 manual topic=plugins 就能读到；源码在 `src/agent-api/manual/plugins.md`）。
