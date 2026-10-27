// 和 bridge 的 Claude 外接共用的型号知识（src/model-knowledge/：已知型号表、思考模板、接口元数据解析、地址规则、报错判读）。
// 经 core-link.ts 取——源码直跑和 dimensio 离线包两种形态都成立。类型来自同目录的 .d.mts（只在类型检查时用，运行时擦掉）。
import { coreModule } from "./core-link.ts";

export type * from "../../src/model-knowledge/index.mjs";
export const MK = coreModule<typeof import("../../src/model-knowledge/index.mjs")>("model-knowledge/index.mjs");
