// harness 引 bridge 核心（src/ 下的纯模块：加密存储、共用型号知识……）的唯一入口。
// harness/ 与 src/ 同在仓库根下，顺着相对路径 ../../src/<rel> 就到。
// 同步加载（createRequire + require(esm)，Node ≥ 22.12）：调用方在模块初始化时就要用（catalog、custom-providers），不必顶层 await；
// 实测约 1ms，和 ESM import 拿到的是同一个模块实例（不会出现两份状态）。被加载的模块不能有顶层 await。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const req = createRequire(import.meta.url);

/** 核心模块的文件 URL：rel 是 src/ 下的相对路径（如 "extension-secrets.mjs"）。 */
export function coreUrl(rel: string): string {
  return new URL(`../../src/${rel}`, import.meta.url).href;
}

/** 同步拿到核心模块（命名空间对象）。类型由调用方用 typeof import(...) 给。 */
export function coreModule<T>(rel: string): T {
  return req(fileURLToPath(coreUrl(rel))) as T;
}
