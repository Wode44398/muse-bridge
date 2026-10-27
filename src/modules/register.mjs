// 给扩展另起的 node 子进程预加载：node --import <本文件> <脚本>。
// 装上 @bridge/core 解析钩子（见 core-resolve.mjs），子进程里的扩展代码才能引核心。
import { installCoreResolver } from './core-resolve.mjs';

installCoreResolver();
