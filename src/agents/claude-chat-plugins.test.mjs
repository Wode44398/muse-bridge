// runClaudeChat 的特征测试 · 插件系统启动的形态（说明与用法见 claude-chat.test.mjs 文件头）。
//
// 单独一个文件 = 单独一个进程：插件内核一启动，pluginOn(id) 就从「恒开」变成「看插件在不在」，整个进程都跟着变。
// 这里登记几个内置功能的替身（算开着）和一个探针插件，钉住：内置工具按开关给不给、插件贡献的
// 工具 / 提示 / MCP / 钩子 / 每轮参数 / 消息改写 / 审批策略怎样并进一轮、turn.start / turn.end / tool.end 怎样发。

import { chatSuite } from './testing/chat-suite.mjs';

await chatSuite({
  baseline: 'claude-chat-plugins',
  scenarioFiles: ['./chat-scenarios-plugins.mjs'],
  setupFile: './chat-plugins-setup.mjs',
});
