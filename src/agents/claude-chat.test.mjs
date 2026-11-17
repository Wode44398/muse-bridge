// runClaudeChat 的特征测试（characterization test）：把「它现在怎么做」钉成基准，护着对 agents/claude.mjs 的重构。
//
// 做法：假的 SDK query()（按剧本吐 SDK 消息流，testing/fake-claude-sdk.mjs）+ 假请求 / 假响应 + 隔离的数据根，
// 跑真的 runClaudeChat；把发给前端的事件、总线广播、交给 SDK 的 options、对 CLI 的控制请求、钩子返回值、日志
// 与落地状态按发生顺序记成时间线，去掉时间戳 / 随机 id / 临时目录后与基准文件逐字比对。
//
// 基准：testing/claude-chat.baseline.<平台>.txt。提示词、路径写法随平台不同，所以按平台各一份；
// 没有当前平台的基准时跳过比对（不算通过也不算失败）。
// 行为是有意改的：UPDATE_CHAT_BASELINE=1 重跑本文件重写基准，并把基准的 diff 当成这次改动的一部分来审。
// 行为没想改却对不上：那就是改坏了，别更新基准。
// 只跑名字里含某段文字的场景：CHAT_TEST_ONLY=<文字>；把时间线打到标准输出：CHAT_TEST_VERBOSE=1。
//
// 本文件跑的是插件系统没启动的形态（功能开关恒开）；插件系统启动后的形态在 claude-chat-plugins.test.mjs。

import { chatSuite } from './testing/chat-suite.mjs';

await chatSuite({
  baseline: 'claude-chat',
  scenarioFiles: ['./chat-scenarios.mjs', './chat-scenarios-turns.mjs', './chat-scenarios-edge.mjs'],
});
