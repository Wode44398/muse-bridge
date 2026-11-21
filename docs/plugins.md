# bridge 插件

插件的完整写法（清单、配置 schema、ctx 参考、以账号身份做事、外部程序与回调、显示位、插件页面、做一个应用、安装与分发、安全）
在 **[`src/agent-api/manual/plugins.md`](../src/agent-api/manual/plugins.md)**——它也是 bridge 项目手册的「插件」章：
bridge 里的 Claude 用 bridge 工具 `manual topic=plugins` 就能读到，装好的 bridge（Windows 客户端、Docker）里也带着，不依赖源码仓库。

- 示例：[`src/plugins/examples/hello-world`](../src/plugins/examples/hello-world)（最小）、[`src/plugins/examples/hello-app`](../src/plugins/examples/hello-app)（纯页面插件：主页一个图标、点开一个全屏分页，没有 index.mjs）、[`src/plugins/examples/hello-view`](../src/plugins/examples/hello-view)（声明式应用：不写页面，bridge 按积木画）、[`src/plugins/examples/qq-onebot`](../src/plugins/examples/qq-onebot)（以账号跑 Claude、托管进程、回调、面板）、[`src/plugins/examples/power-tools`](../src/plugins/examples/power-tools)（事件、钩子、审批策略、卡片工具与界面扩展）。
- 建骨架：让 bridge 里的 Claude 调 `plugins.scaffold`，或命令行 `npm run plugin:new -- <id> [目录] [--panel] [--from <示例> | --template app-page|app-view|app-chat] [--name <显示名>]`（逻辑、示例与模板名单在 `src/plugins/scaffold.mjs` 的 `EXAMPLES` / `TEMPLATES`）。
- 做一个应用（主页图标 + 全屏分页，页面型或声明式）：手册「做一个应用」一节——选模板、积木表、动作与参数、和 Claude 对话、调试与重新加载。
