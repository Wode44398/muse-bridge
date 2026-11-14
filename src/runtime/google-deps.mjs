// Google 云 SDK（@google/genai、google-auth-library）用到时才加载。
//
// 事故（2026-11-13，公开版 v2026.11.13.0849）：核心的 model-hub/vertex.mjs 与 google-clients.mjs 在顶层静态 import 这两个包，
// 而 Windows 安装包的主包按老规矩把它们当成「只有 Vertex 扩展用的依赖」卸掉了（client/build/stage.ps1）——
// 装机版一启动就 ERR_MODULE_NOT_FOUND、退出码 1，监督进程连拉 6 次后放弃，整台服务端起不来。
// 现在主包照带这两个包（stage.ps1 不再卸），这里再兜一层：缺包只让 Vertex / Gemini 相关功能报错，服务端照常起。
// 两个包都有 CommonJS 入口，用 createRequire 同步加载，调用方（含 Media Studio 的驱动）的同步接口不用改。

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cache = new Map();

function load(name) {
  if (cache.has(name)) return cache.get(name);
  let mod;
  try { mod = require(name); }
  catch (e) {
    if (e?.code !== 'MODULE_NOT_FOUND') throw e;
    throw Object.assign(new Error(`缺少依赖 ${name}：这台 bridge 的程序文件不完整，Vertex / Gemini 相关功能用不了。更新到最新版或重新安装即可`), { status: 503, code: 'BRIDGE_DEP_MISSING' });
  }
  cache.set(name, mod);
  return mod;
}

export const googleAuthLib = () => load('google-auth-library');
export const googleGenAILib = () => load('@google/genai');
