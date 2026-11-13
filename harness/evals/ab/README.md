# 本机评测台：两树 A/B（Q6 / N46）与型号矩阵（模型档案 P0）

改动会不会让模型「变笨」、某个型号该配哪套提示词 / 工具说明——单测答不了，要让真模型在陷阱任务上跑、按格子比。两种用法：

| 模式 | 入口 | 臂 | 用途 |
|---|---|---|---|
| 两树 A/B | `run.ts` | 同一型号 × 两棵工作树（改动前 / 改动后） | 某个提交的决策收据 |
| 型号矩阵 | `matrix.ts` | 同一棵树 × 若干型号 ×（可选）档案变体 | 按模型家族调参、拉基线 |

## 两树 A/B

两棵工作树 = 同一个仓库的两个 git worktree。在任意一棵的 `harness/` 下：

```bash
node evals/ab/run.ts --base ../claude-bridge-base --head . --topic q7-hints --reps 3
```

- `--model` 默认 `local/qwen3.8-27b`；云端型号加 `--env-file <.env>`，自定义服务加 `--providers-dir`（见下）。
- 不给 `--tasks` 时跑 `--suite classic`（老题，与以往收据同口径）；`--suite hard|all` 带上新难题。
- 两臂轮流跑、不并行；每次重复交换先后。账本 `%TEMP%/dimensio-ab-<日期>-<主题>/meta.jsonl`，中断了原样重跑会跳过已完成的。

## 型号矩阵

```bash
node evals/ab/matrix.ts --topic qwen-baseline --reps 3 \
  --models custom-024744f2/qwen3.8-flash-next-fp8,local/qwen3.8-27b,local/strata-orca@medium,deepseek/deepseek-v4-flash \
  --providers-dir %TEMP%/dimensio-mp-providers --env-file <有云端 key 的 .env>
```

- **型号写法** `provider/model[@档位]`：内置厂商 id、`custom-<id>`（自定义服务）、`local`（本机）。`@` 后是思考档位；不写就照这一臂的型号目录
  （`/api/info` 的 catalog）查默认档、显式设上——`POST /api/config` 点名了型号时服务端不重算默认档，不显式传会沿用起臂前的全局档位。
  设完核对 provider / 型号 / 档位，任何一项不符就中止；每臂实际档位写进收据（逐 run 也记在账本的 `effort`）。`run.ts` 同理。
- **选题**：`--suite all`（默认，老题 + 新题）/ `hard` / `classic`，或 `--tasks id1,id2`。skill-* 题要技能夹具，仍走 `run.ts --ext-file`。
- **档案变体**：`--variants-file v.json`，内容形如
  `[{ "name": "base" }, { "name": "tuned", "profileOverrides": { … }, "env": { "K": "V" } }]`——每个型号 × 每个变体是一臂（给了变体文件臂名一律是 `型号#变体`，只有一个变体也带）。
  `profileOverrides` 原样序列化进这一臂进程的 `DIMENSIO_PROFILE_OVERRIDES`；评测台只透传，怎么解释归模型档案那条线。
- **并发按端点分**：内置云端每家默认 3、自定义服务默认 4，`--concurrency custom-024744f2=6,deepseek=2` 覆盖；`local` 恒为 1。
- **本机多型号**：两台引擎（Qwen 27B / Strata）抢一张卡，本机的活按型号分组串行、组间切引擎。`--local-switch`：
  - `manual`（默认）：打印「去本机面板切到哪台」，切好后自动接着跑（最多等 30 分钟）；
  - `auto`（要显式写）：经这一臂的 `/api/localai` 停掉另一台、本引擎停了再起（状态接口不报在跑的是哪个型号，换组一律重起），
    轮询 `/api/localai/status` 等就绪。本机引擎是整机共用的，**auto 会停掉正式服 8799 正在用的那台**；
  - `none`：只跑一个本机型号、已经手动起好时用。
  切引擎会影响正式服上正在用本机型号的会话——挑没人用的时候跑。
- **续跑**：账本 `%TEMP%/dimensio-matrix-<主题>/meta.jsonl`（`--work` 可改），键 = 题|臂|第几次；中断后原样重跑同一条命令。`--report-only` 只按账本重出报表。
- 每臂一个 harness 进程（端口从 `--base-port 8861` 起找空的）；`--max-minutes`（默认 480）到点不再开新 run。

### 接自定义服务（借正式服的 custom-*）

评测臂默认看不到任何自定义服务（目录改道到臂的临时根）。要用正式服配好的服务，把整个目录复制一份给臂用——密钥文件（DPAPI 加密）
只按字节复制，不解密、不打印：

```bash
node evals/ab/providers-copy.ts --from C:/Users/you/claude-bridge/harness/custom-providers \
  --to %TEMP%/dimensio-mp-providers --fix-vllm-thinking custom-024744f2
```

`--fix-vllm-thinking` 只改副本：vLLM 的 Qwen 模板不认顶层 `enable_thinking`，要放进 `chat_template_kwargs`（否则「关闭」档照样想，
旁路请求的额度全花在思考上）。然后 `matrix.ts` / `run.ts` 加 `--providers-dir %TEMP%/dimensio-mp-providers`（等价于设
`DIMENSIO_CUSTOM_PROVIDERS_DIR`）。`--to` 有保护：与 `--from` 相同或互相包含直接拒绝；已存在的 `--to` 只有空目录、或带
`.dimensio-eval-copy` 标记的旧副本才会被删掉重来。fp8 那台（`custom-024744f2/qwen3.8-flash-next-fp8`，256k 上下文）可以并发，默认 4 路。

### 接本机各型号

`local/qwen3.8-27b`（llama.cpp，8080）与 `local/strata-orca`（Strata，8081，默认 medium 档——xhigh 会停不下来）。Strata 拆成多个
独立型号之后照样写 `local/<型号>`：哪个型号归哪台引擎直接用服务端的 `engineOfModel`（`server/localai.ts`），两边口径一致；
换型号时先停再起，`/api/localai/start` 带 `&model=`（服务端目前忽略它，按引擎起——拆型号那条线要让它真按型号起）。

## 隔离

每臂一个独立 harness 进程，会话、记忆、知识、运行配置、项目、工作区、快照对话、浏览器配置档、自定义服务目录全在这一臂的临时根里
（`server/paths.ts` 的数据路径收口：**两棵树都必须是 Q8 之后的代码**，更早的代码 runner 直接拒绝）；令牌由 runner 生成注入。
访问范围一律「仅工作空间」（环境变量 + 配置双保险）；npm 全局前缀 / 缓存指进临时根、`PIP_REQUIRE_VIRTUALENV=true`、`PYTHONUSERBASE` 指进临时根，
并经 `DIMENSIO_CHILD_ENV_ALLOW` 放行给模型的命令（Bash 子进程环境是白名单，不放行就到不了）；子进程家目录（`DIMENSIO_CHILD_HOME`，
HOME / APPDATA 都在它下面）与草稿目录（`DIMENSIO_SCRATCH_DIR`，即 `$WORKSPACE_TMP`）也在这一臂的临时根，不和 8799 共用。
草稿目录按臂分，同一臂并发的几道题仍共用一个（题目都不依赖它）。

## 结果怎么读

结果写成 `evals/ab/results/<日期>-<主题>.md`，这就是**决策收据**：在对应改动的提交说明里引用它。

- 矩阵收据：汇总（通过率 + Wilson 95% 区间、pass^k、中位 token / 步数 / 耗时、工具失败率、编辑失败率、自称完成但没过、撞预算）、
  逐题 × 臂通过矩阵、分维度得分、工具失败按类别、过程信号（缓存读、思考估算、仅思考回合、截断续写、门禁追问、loop-guard、权限拒绝、
  最长连续相同调用）、成本合计、没通过的 run 逐条。耗时只算各条消息的流（`activeMs`），不含每条之后等记录落定、等记忆沉淀
  （多轮题以前会因此偏大；老账本没有这一项的用墙钟）。主题里的斜杠等字符在文件名里换成 `_`。
- n 小只看方向，看区间别看点估计；没通过的格子必须逐 run 审，分清**模型失败**还是**题目 / 判分 bug**（后者先修题）。
- 指标口径：步数 = assistant 回合；工具调用与失败、错误类别来自 `/api/run` 事件流（工具自己的 summary），注入片段（追问、续写、
  预算耗尽、loop-guard）与仅思考回合来自会话记录；token 一栏按会话用量账本合计（主循环 + 子 agent + 压缩摘要 + 记忆沉淀）。

## 题目

`tasks.ts`（老题）+ `tasks-hard.ts`（模型档案 P0 的新题，`suite: "hard"`）。判分只看磁盘状态与会话记录，是确定性的；
「真的好了没有」一律自己跑测试判，不信模型自己说的；要看答复的题，答复本身是格式受约束的产物（严格 JSON、只回一句话）。

| 维度 | 新题 |
|---|---|
| 编辑格式 | edit-crlf、edit-tabs、edit-large-local、edit-multi-site、edit-unicode、edit-no-rewrite |
| 工具调用健壮性 | tool-todo-enum、tool-deny-reroute（题目自带权限规则）、tool-ps-quoting |
| 指令遵循 | if-json-only、if-zh-constraints、if-forbidden-trap |
| 长跨度多轮 | mt-followup（两条消息）、mt-recall-long（三条消息 + 长文回查）、long-refactor、long-needle |
| 收尾完整性 | finish-8-items |
| 日常 | daily-rename |

多轮题写 `followups`：首条消息跑完、记录落定后在同一会话里接着发（`/api/run` 带 `sessionId`），maxTurns / deadline 按每条消息算。
题目要权限规则就写 `permissionRules`（并进这一臂的全局规则，规则只针对本题现场的文件名）。

加题：写 `setup`（在空目录里摆现场）、`check`（判分）、`reference`（参考解），再写 `dimension` / `difficulty` / `scoring`。
`server/ab-eval.test.ts` 会检查每个题原样现场判不通过、做完参考解判通过；`evals/ab/matrix.test.ts`（单跑：
`node --import ./server/test-setup.ts --test evals/ab/matrix.test.ts`）查矩阵的纯函数、报表，并用假服务把并发 + 多轮 + 权限规则的管线跑一遍。

## 成本与耗时量级

- 老题：每题每次 1–3 万到 20 万 token、10–80 秒（fp8 vLLM）；12 题一遍约 100 万 token、7 分钟。
- 新题（fp8 vLLM 实测，`results/2026-11-07-mp-p0-smoke.md`）：多数 3–20 万 token、5–70 秒；mt-recall-long 约 29 万（三条消息累积上下文）；
  long-refactor 逐处 Edit 的型号会到 30 轮以上、超过 20 万。18 题 + 3 道老题一遍合计约 216 万 token（low 档）/ 275 万（medium 默认档，`results/2026-11-07-mp-p0-smoke-r2.md`），四路并发墙钟约 3–4 分钟。
- 本机 27B / Strata 单路，耗时约是 fp8 vLLM 四路并发的 3–5 倍；云端按各家价目，跑 5 次重复前先用 `--reps 1` 估一遍。
