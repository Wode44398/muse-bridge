// 自定义 API 的「模型知识」——2026-10-21 起挪进 src/model-knowledge/（和 dimensio 的自定义服务共用一份，以前两边各存一张表、
// 已经漂移了 10/30 个型号）。这里只做转出，原来的 import 路径照常可用；新代码直接 import '../model-knowledge/index.mjs'。
// 来源与取值顺序、思考模板、已知型号表的说明见 src/model-knowledge/knowledge.mjs 文件头。
export * from '../model-knowledge/knowledge.mjs';
