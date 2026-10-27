# 你好世界（示例插件）

bridge 插件的最小完整示例。它做了五件事：

| 做了什么 | 在哪 |
|---|---|
| 一个接口 `GET /api/plugin/hello-world/greet?name=…` | `index.mjs` 的 `ctx.route` |
| 一个给 Claude 的工具 `mcp__hello-world__greet` | `ctx.claude.tool` |
| 一个 agent 接口操作 `hello_world.stats` | `ctx.agentOp` |
| 三项设置（问候语、感叹号、提示 Claude） | `bridge-plugin.json` 的 `config`，设置页自动生成表单 |
| 一个插件页面 | `web/index.html` |

## 装上试试

- **本机开发**（改完代码点「重新加载」即生效）：设置 › 扩展 › 功能扩展 › 添加 › 本机目录，填这个目录的绝对路径。
- **打包安装**：把这个目录打成 zip，设置 › 扩展 › 功能扩展 › 添加 › 上传 zip。

装好后让 Claude「用 greet 工具跟小明打个招呼」，或在浏览器打开 `/plugins/hello-world/web/`。

完整写法见 bridge 项目手册的「插件」章（bridge 里的 Claude 用 bridge 工具的 manual topic=plugins 就能读到；源码在 `src/agent-api/manual/plugins.md`）。
