// 插件里的代码可以随意拆文件：用相对路径 import。「重新加载」时整个插件目录的模块会一起换成新的。
// 要用 bridge 核心的模块，写 import … from '@bridge/core/<src 下的相对路径>'（如 '@bridge/core/runtime/bus.mjs'）。

export function greetText(config, name) {
  return `${config.greeting}，${name}${config.exclaim ? '！' : '。'}`;
}
