# harness（dimensio）— Agent 指令

只写热路径上的铁律。系统怎么工作（工具清单、事件、环境变量、路由）以代码为准，这里不描述——手写的描述跟不上重构，过期了还会误导。
贡献流程（隔离开发实例、拉取请求、版本号由维护者改）见仓库根的 CONTRIBUTING.md 与 AGENTS.md，这里只补 harness 自己的规矩。

## 交付

- dimensio 是 bridge 的一个分页：功能的交付标准是「在 bridge 里能用」（经 bridge 服务端的反代 + 鉴权），8799 只是开发脚手架。
- 改了前端（`web/` 或 bridge 的 `web/src`）：harness 与 bridge 两套前端都要构建通过，并在 bridge 里实际用一遍——单开 harness 页面不算验证。
  验证构建输出到临时目录（`--outDir`），不覆盖正在服务的产物，构建产物也不提交。
- 改前端先读 `DESIGN.md`（令牌、交互文法、稳定性、Svelte 5 的坑）；其中几条由 `server/design-guard.test.ts` 守着，基线 `web/design-baseline.json` 只减不增。
- 服务端新读一个环境变量，先在 `server/runtime-env.ts` 登记（归属、用途、默认值，凭据标 secret）；`server/runtime-env.test.ts` 守着：没登记的、登记了没人读的都报。
- 验证只用隔离实例（显式给一个不常用的端口，数据目录指到临时目录），不重启、不结束正在服务的实例。

## 安全

- 不打印、不回传任何凭据：不 cat 凭据文件（`.env`、bridge 的 `config.json`、`extensions/registry.json`、`~/.claude` 等）；要看结构就写脚本，只输出键名、类型、布尔值。
- 测试夹具只用明显的假令牌（带 FAKE / DUMMY 字样）。
- 结束进程树不用 `taskkill /T`、不按 PID 判活（顺着悬空的父 PID 误杀过正在服务的服务端）；用 `server/proc-tree.ts`。守卫测试会拦。

## 测试

- `npm test` = tsc + 全部测试 + 收尾检查（受控文件不许被测试改动、生产数据目录不许冒出测试桶）。改了 harness 就跑全量：守卫测试不 import 被扫的模块，只跑相关测试时点不到它们。
- 数据位置只经 `server/paths.ts` 解析；测试进程解析到临时目录之外会直接抛错。
- 测试里不再手写 `async *stream()` 假 provider：用 `server/test-harness/scripted-adapter.ts`（多调 / 少调判失败、请求不变量自动检查）；要看编码后的请求体用 `server/test-harness/wire-fakes.ts`；要走真会话用 `server/test-harness/session-fixture.ts`。
- `server/guards-baseline.json` 是燃尽基线：违规数只准减、用例数只准增；豁免写成 `// guard: <规则> ok — <理由>`，没有理由的豁免判红。
- 快照只用于「一轮之内门禁的先后顺序」这类顺序本身就是契约的场景（`server/loop-gates.test.ts`），其余写不变量。快照 diff 必须有人看过，不许为了变绿去 `--test-update-snapshots`。
- 会改变弱模型行为的改动（提示词、技能披露、熔断参数、注入物）合入前按 `evals/ab/README.md` 跑 A/B，收据写进拉取请求；改压缩按 `evals/compaction/README.md` 在改前 / 改后各跑一次。单测答不了「模型有没有变笨」。
- 测试挂了先判断：是代码错了，还是测试钉住了一个错误的契约（以前 `server/knowledge-search.test.ts` 就把「召回不落盘」钉成过契约）。不许为了变绿放宽断言。
- 如实报告：测试红就贴输出；跳过的步骤写明跳过了。

## 上下文（缓存纪律）

1. 除了压缩边界，不改写模型已经看过的历史。运行中确需改写 system（切模式、切访问范围）走 `AgentState.rewriteSystem` 报备；改写消息的地方调 `state.noteRewrite` 报备原因——没报备的断点会被前缀判定器（`server/agent/prefix-audit.ts`）记成 unexplained 并告警。
2. 每轮的注入物（召回、提醒、追问）以 internal 消息持久化追加，不要只插在请求里、下一轮再拿掉。
3. 新的注入片段要把开头登记进 `server/agent/injections.ts`：来源判别落地之前，分窗渲染、请求记录和会话体检都靠它认。

这三条有机器检查：`server/context-layout.test.ts`（分窗尺子，已知多开窗的场景在它的燃尽清单里）与生产上的前缀判定器。

## 纪律

- 同一条规则只存一份。审查、workflow 要用这些规则时在运行时读本文件原文，不复制成技能或提示词。
- 注释只描述本文件，不写跨文件的关系——最先过期的就是它。
- 本文件与仓库根 `AGENTS.md` 里引用的路径必须真实存在（`server/instructions.test.ts` 检查）。

## 否决过的方案（除非有新理由，别再提）

- 无人值守模式（记忆删改转 `.pending/` 提案）：不做，默认有人在；只有开了离开模式才算不在场。
- 权限规则的「项目」一档：不做，只有全局规则 + 本会话允许。
- 本机模型的默认 effort 调低：不调，维持 xhigh。
- 用快照文件做主断言：不做，快照只给门禁先后顺序用（见上）。
