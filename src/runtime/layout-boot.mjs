// 启动时最先跑的数据布局迁移（只做副作用的模块，开源路线 C11；见 runtime/layout.mjs）。
//
// 为什么单独一个模块：ES 模块要等全部静态 import 求值完，才执行 server.mjs 的函数体。在函数体里调 migrateLayout()，
// 号池（claude-account.mjs 的 init）、额度策略（policy.mjs 顶层补默认值）、账号库（users.mjs）早已把数据读进内存，
// 有的还写过盘；之后迁移改了磁盘，它们第一次 persist 就会把迁移前的那份整个写回去，迁移被静默冲掉，
// layout.json 却已经记下「做过了」。
//
// 所以 server.mjs 在 config/index.mjs 之后、其他任何模块之前 import 本文件。本文件只依赖 layout.mjs →
// config/index.mjs（与它自己的 paths / capabilities / deploy-profile）+ principal.mjs（纯函数），
// 求值时不会把任何数据模块拉进来（scenario3-reserve.test 有一条按导入图检查这件事）。
//
// 例外：config.json 已经由 config/index.mjs 在迁移之前读进内存（导出的 config 对象，policy.mjs 等从它取值）。
// 要改 config.json 的迁移步骤，得同时改那份内存对象；做不到就别放进迁移，交给持有那个键的模块在初始化时处理。
//
// 日志不在这里打：日志环（log-ring）这时还没装上。server.mjs 装好之后读 bootLayout 再打。
import { migrateLayout } from './layout.mjs';

export const bootLayout = migrateLayout();
