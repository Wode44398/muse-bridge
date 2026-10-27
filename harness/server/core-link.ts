// harness 引 bridge 核心（src/ 下的纯模块：加密存储、共用型号知识……）的唯一入口。
//
// 两种形态都要成立：
//   · 仓库里直接跑（dev-launcher、npm test、测试里 spawn 的 server/index.ts）：harness/ 和 src/ 同在仓库根下，
//     顺着相对路径 ../../src/<rel> 就到；
//   · dimensio 离线包装在数据目录（<数据根>/modules/dimensio/harness）：包里只有 harness 的 server / web/dist / tools，
//     没有 src/——相对路径摸不到。bridge 拉起 harness 时一律带 --import 核心解析钩子（modules/dimensio/server/routes/harness.mjs），
//     钩子把 @bridge/core/<rel> 映射到程序目录的 src/（src/modules/core-resolve.mjs）。
// 所以：先问 import.meta.resolve('@bridge/core/<rel>')——有钩子就走它；没有就抛，回落到仓库相对路径。只按「解析」成败分支，
// 加载时的错误（目标模块自己坏了）原样抛出，不当成「没钩子」吞掉。
// 同步加载（createRequire + require(esm)，Node ≥ 22.12）：调用方在模块初始化时就要用（catalog、custom-providers），不必顶层 await；
// 实测约 1ms，和 ESM import 拿到的是同一个模块实例（不会出现两份状态）。被加载的模块不能有顶层 await。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const req = createRequire(import.meta.url);

/** 核心模块的文件 URL：rel 是 src/ 下的相对路径（如 "extension-secrets.mjs"）。 */
export function coreUrl(rel: string): string {
  try {
    return import.meta.resolve(`@bridge/core/${rel}`);
  } catch {
    return new URL(`../../src/${rel}`, import.meta.url).href;
  }
}

/** 同步拿到核心模块（命名空间对象）。类型由调用方用 typeof import(...) 给。 */
export function coreModule<T>(rel: string): T {
  return req(fileURLToPath(coreUrl(rel))) as T;
}
