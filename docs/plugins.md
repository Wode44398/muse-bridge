# bridge 插件

插件的完整写法（清单、配置 schema、ctx 参考、以账号身份做事、外部程序与回调、显示位、插件页面、安装与分发、安全）
在 **[`src/agent-api/manual/plugins.md`](../src/agent-api/manual/plugins.md)**——它也是 bridge 项目手册的「插件」章：
bridge 里的 Claude 用 bridge 工具 `manual topic=plugins` 就能读到，装好的 bridge（Windows 客户端、Docker）里也带着，不依赖源码仓库。

- 示例：[`src/plugins/examples/hello-world`](../src/plugins/examples/hello-world)（最小）、[`src/plugins/examples/qq-onebot`](../src/plugins/examples/qq-onebot)（以账号跑 Claude、托管进程、回调、面板）。
- 建骨架：让 bridge 里的 Claude 调 `plugins.scaffold`，或命令行 `npm run plugin:new -- <id> [目录] [--panel] [--from hello-world|qq-onebot]`（逻辑在 `src/plugins/scaffold.mjs`）。
