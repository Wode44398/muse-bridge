// 让功能扩展（modules/<id>/）引用核心代码的解析钩子。
//
// 扩展装在数据目录（客户端是 %LOCALAPPDATA%\bridge-client\data\modules\<id>），和程序目录
// 不在一棵树上，`../../src/xxx.mjs` 这种相对路径走不通。约定扩展一律写
// `import … from '@bridge/core/<src 下的相对路径>'`，由这里映射到程序目录的 src/。
// 仓库内置（modules/ 与 src/ 同仓）和装在数据目录两种情况走同一个写法、解析出同一个文件
// URL——和核心自己用相对路径 import 的是同一个模块实例，不会出现两份状态。
//
// 第二件事：程序目录之外的代码（装在数据目录的扩展）import 第三方包时，先按 Node 常规从
// 扩展自己的 node_modules 找（扩展独有的依赖随包带），找不到再回落到程序目录的 node_modules
// （sharp、node-pty、MCP SDK 这类核心共用的依赖不必每个扩展各带一份）。程序目录里的代码
// （核心、仓库内置的扩展）本来就能往上找到 node_modules，不走回落。
//
// module.registerHooks 是同步、同线程的钩子（Node ≥ 22.15 / 23.5），import 与 require 都生效。
// 扩展另起的 node 子进程（如 Codex 的 stdio MCP）不继承钩子：spawn 时带上
// ['--import', CORE_REGISTER_URL, 脚本]。

import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, '..');
const PROGRAM_DIR = path.resolve(SRC_DIR, '..');
const SRC_ENTRY_URL = pathToFileURL(path.join(SRC_DIR, 'server.mjs')).href;
const coreRequire = createRequire(SRC_ENTRY_URL);
const PREFIX = '@bridge/core/';

// 子进程预加载用：node --import <它> <脚本>
export const CORE_REGISTER_URL = pathToFileURL(path.join(HERE, 'register.mjs')).href;

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
let installed = false;

function outsideProgram(parentURL) {
  if (!parentURL || !parentURL.startsWith('file:')) return false;
  let p;
  try { p = fold(fileURLToPath(parentURL)); } catch { return false; }
  return !p.startsWith(fold(PROGRAM_DIR) + path.sep);
}

const isBare = (s) => !(s.startsWith('.') || s.startsWith('/') || s.startsWith('file:') || s.startsWith('node:') || /^[a-zA-Z]:[\\/]/.test(s));

export function installCoreResolver() {
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(PREFIX)) {
        const target = path.resolve(SRC_DIR, specifier.slice(PREFIX.length));
        if (!fold(target).startsWith(fold(SRC_DIR) + path.sep)) throw new Error('非法的核心模块路径：' + specifier);
        return { url: pathToFileURL(target).href, shortCircuit: true };
      }
      try {
        const r = nextResolve(specifier, context);
        // 插件热重载（plugins/discover.mjs）：入口带 ?bpv=<n> 重新 import 时，它里面的相对 import 也带上同一个 n，
        // 整个插件目录的模块都换成新的一份，而不是只换入口、其余还用缓存里的旧代码。
        const bpv = context.parentURL && /[?&]bpv=(\d+)/.exec(context.parentURL);
        if (bpv && (specifier.startsWith('./') || specifier.startsWith('../')) && r && typeof r.url === 'string'
          && r.url.startsWith('file:') && !r.url.includes('?')) {
          return { ...r, url: r.url + '?bpv=' + bpv[1] };
        }
        return r;
      } catch (err) {
        if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'MODULE_NOT_FOUND') throw err;
        if (!isBare(specifier) || !outsideProgram(context.parentURL)) throw err;
        // require()（createRequire 出来的也算）：默认解析器只认真正发起 require 的那个模块，换 parentURL 不管用
        // （node-pty 这类原生模块常这么载入），改用程序目录的 require.resolve 直接定位。
        if ((context.conditions || []).includes('require')) {
          return { url: pathToFileURL(coreRequire.resolve(specifier)).href, shortCircuit: true };
        }
        return nextResolve(specifier, { ...context, parentURL: SRC_ENTRY_URL });
      }
    },
  });
}
