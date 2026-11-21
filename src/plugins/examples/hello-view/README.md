# 记一笔（声明式应用示例）

bridge「声明式应用」的示例：**不写页面**。`index.mjs` 里用 `ctx.ui.app` 登记 `view`（回一组积木）和 `actions`（积木按下去调的函数），
bridge 自己画界面——网页、桌面、手机 App 一个样，手机 App 也不跑插件的代码。演示一个小记账本，每个使用者一份。

完整的积木表（每种积木的字段与上限）、动作参数怎么并入、跳转写法见 bridge 项目手册「插件」章的「做一个应用」一节
（bridge 里的 Claude 用 bridge 工具的 manual topic=plugins 就能读到；源码在 `src/agent-api/manual/plugins.md`）。

| 做了什么 | 在哪 |
|---|---|
| 主页图标 + 全屏分页「记一笔」，成员也能用、各记各的 | `index.mjs` 的 `ctx.ui.app({ id: 'ledger', who: 'members', … })` |
| 三个标签页：概览 / 明细 / 记一笔（`tabs` 积木，切换时动作的 args 带 `{ tab }`，动作回新 state） | `view` 与 `actions.tab` |
| 概览：本月合计、笔数、今天（`stat`），最近 7 天柱状图（`chart`），按类别汇总（`section` + `list`） | `overview()` |
| 明细：每笔一行，行尾「删除」按钮带确认（`list` 的 `trailing`，动作 args 自动并入这一行的 `{ id }`） | `entryList()` |
| 记一笔：金额 / 类别（分段选择）/ 备注（`form`，提交时 args 带 `{ values }`），清空全部（`button` 带 `confirm`） | `addForm()` |
| 主页图标上的角标：今天记了几笔 | `badge` |
| 数据存服务器上（`ctx.store`），键里带使用者 id；`state` 只放当前标签页 | `load` / `save` |
| 深浅两枚图标、英文界面的名字与标题 | `web/icon-light.svg`、`web/icon-dark.svg`、`locales/en.json`（`ui.app.ledger.title`） |

## 要点

- `view(who, { state })` 回积木列表；`actions` 里的函数回字符串（当提示）或 `{ state?, toast?, nav? }`，什么都不回就只重画。
- `state` 由前端保管、每次随请求带上来，**不能拿它判断权限**，也别放大数据（上限 256 KB）；要长期保存的存 `ctx.store` 或插件数据目录。
- `who` 是调用者的身份上下文：`who.user` 是成员的账号 id，主机没有。按人分开存数据就拿它当键。
- 插件那头数据变了（定时任务、外部回调），调 `ctx.ui.refresh('ledger')` 让正开着的页面重拉。
- view 5 秒封顶、动作 60 秒封顶；出错时界面上显示「应用出错了」和原因，详情在插件日志里。
- 积木里引用的动作名必须在 `actions` 里，否则按钮、表单、标签页整块不画（不报错）；没画出来先查这个。
- 改完要「重新加载」（或 plugins.reload）：bridge 不监视文件。

## 装上试试

- **本机开发**（改完点「重新加载」即生效）：设置 › 扩展 › 功能扩展 › 添加 › 本机目录，填这个目录的绝对路径。
- **从它起步**：让 bridge 里的 Claude 调 plugins.scaffold（from 填 hello-view），或者命令行 `npm run plugin:new -- my-app --from hello-view`；
  要一个更干净的起点用模板：template 填 app-view（命令行 `--template app-view`）。
- 装好后回主页就能看到「记一笔」。也可以让 bridge 里的 Claude 用 ui.open 的 app 参数（hello-view:ledger）直接带你过去。
