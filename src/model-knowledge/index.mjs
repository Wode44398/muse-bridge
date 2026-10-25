// 型号知识的总入口（服务端都从这里拿；网页只要编辑器逻辑的话直接 import ./editor.mjs，少拖一点代码进包）。
// 引用方式：bridge 核心相对路径；dimensio 服务端经 harness/server/core-link.ts（@bridge/core 钩子 / 仓库相对路径两种形态都成立）；
// dimensio 网页经 harness/web/src/lib/model-knowledge.ts。每个 .mjs 配同名 .d.mts（harness 是 TS，开 strict）。
export * from './knowledge.mjs';
export * from './diagnose.mjs';
export * from './editor.mjs';
