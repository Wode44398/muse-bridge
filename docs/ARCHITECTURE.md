# 身份、数据布局与多用户约束

> **English summary.** Today bridge's multi-user model is "one identity = one directory = one owner key". This page describes that model, the on-disk data layout (version 1) and the constraints every change must keep, so that groups, shared spaces and team roles can be added later without rewriting everyone's data. The reserved entry points are `src/runtime/principal.mjs` (owner keys, actor / scope, capabilities, path roots, pool keys, session references), `src/runtime/layout.mjs` (layout version and migrations, run at import time by `layout-boot.mjs`), `src/runtime/audit-log.mjs` (audit and usage-event logs), `src/runtime/session-visibility.mjs` (who may see a session; authorization data lives under `_system/`, never in a workspace's `.bridge/`) and `src/runtime/run-as.mjs` (child processes and credentials). None of them changes behavior today; new code must go through them.

bridge 现在的多用户模型是「一个主人 + 若干互不往来的房客」：一个身份对应一个目录、一把 owner 键、一个记账人、一道路径围栏。家人朋友共用一台服务器，这个模型够用。以后要做的组、共享空间、查看与接手别人的会话、按组分配凭据，都要把这几样拆开。

功能可以以后再做。难改的是已经写进数据和接口里的假设：开源以后，它们就是每个部署者的迁移负担。所以现在先把这些概念收口到几个模块里，并约定新代码怎么写。本页说明身份模型、数据布局和这些约束。

## 1. 身份

每个请求先由 `identify(req)` 认出身份，再由 `contextFor(identity)` 换成这一轮的上下文 `ctx`（都在 `src/runtime/identity.mjs`）。`contextFor` 是唯一把身份映射到「Claude 在哪跑、数据放哪」的地方。

| 身份（`kind`） | 是谁 | owner 键 | 工作目录 |
|---|---|---|---|
| `admin` | 主令牌、管理员会话、本机免鉴权调试台 | `admin` | 工作区（`vaultPath`），不设路径边界 |
| `user` | 账号：邀请码注册的、管理员新建的、服务账号 | `u:<账号 id>` | `<用户根>/<账号目录>/` |
| `share` | 公开只读分享链接的访客 | `s:<分享令牌>` | 分享桶，只读 |
| `snap` | 公开聊天快照的访客 | `c:<快照令牌>` | 快照桶，没有命令行 |
| 组（预留） | 将来的团队 / 小组 | `g:<组 id>` | `<用户根>/_groups/<组 id>/` |

owner 键只经 `ownerKey(kind, id)` 生成、经 `parseOwnerKey(key)` 解析（`principal.mjs`，`identity.mjs` 同名转出）。不要手拼 `'u:' + 名字`，也不要 `key.slice(2)`。

`ctx` 上和身份有关的字段：

| 字段 | 含义 | 今天的取值 |
|---|---|---|
| `key` | owner 键：事件总线分区、在跑轮注册表、审批归属、设备与分享的属主 | 见上表 |
| `actor` | 谁做的（审计、「代发」标记） | 等于 `key`；管理员代聊时是 `admin` |
| `scope` | 数据归谁、终端与浏览器按谁分 | 等于 `key`；代聊时是被代的那个人 |
| `groups` | 属于哪些组 | 恒为空数组 |
| `sandbox` / `shell` / `tier` | 受不受路径围栏、有没有命令行、档位 | 主机 `false / true / admin`；账号按档位 |

读这几个字段用 `actorOf(ctx)`、`scopeOf(ctx)`、`groupsOf(ctx)`。它们对没有新字段的老 `ctx` 会回落到 `key`。

记谁的账不看 `scope`，以 `billingUser(ctx)`（`src/runtime/quota.mjs`）为准：账号的轮记给本人（管理员代他发的也算他的），快照访客的轮记给铸这个快照的账号（这一轮的 `scope` 是 `c:<快照令牌>`），管理员自己的轮不记。

### 角色与能力

管理权按**能力**判断：`can(ctx, '<能力>')`。不要再新增 `kind === 'admin'` 一类的分支。今天每一项能力都等价于原来的判断：

| 能力 | 含义 | 今天谁有 |
|---|---|---|
| `server.manage` | 服务控制、公网访问、扩展与模块 | 主机身份 |
| `users.manage` | 账号、邀请、档位、额度 | 主机身份 |
| `pool.manage` | 号池与换号 | 主机身份 |
| `data.viewOthers` | 查看别人的会话与数据（要写审计） | 主机身份 |
| `chat.asOthers` | 代别人聊天、代答审批（要写审计） | 主机身份 |
| `devices.manageAll` | 管理所有人的设备 | 主机身份 |
| `fs.anyPath` | 选任意本地目录做项目 | 主机身份 |
| `workspace.shell` | 有命令行 | 主机身份、完全信任档（存储值仍是 `pro`） |

角色是预留的：`owner`（服主，今天就是主机身份）、`admin`（将来的管理员账号）、`member`（成员）、`guest`（分享与快照访客）。`users.json` 的 `role` 字段也是预留的，今天不读不写。`can()` 今天也不看角色，所以手改 `users.json` 不会提权。

## 2. 数据布局（v1）

```
<数据根>/                          BRIDGE_DATA_ROOT；没设就是程序目录
  config.json                      主令牌、端口、功能开关、号池（claudeAccounts）……服务进程独占
  devices.json                     设备登记（令牌只存哈希）；见下面「账号与设备的附加字段」
  uploads/  media/  …              主机身份自己的数据
  users/                           用户根（config.json 的 usersRoot / BRIDGE_USERS_ROOT）
    _system/                       服务进程独占，不在任何人的工作空间里
      layout.json                  数据布局版本
      users.json  invites.json  sessions.json  usage.json
      retired-accounts.json        删过的账号 id（永不复用）与数据去向
      admin-access.json            成员给管理员的「可见性」授权与访问记录（按账号 id 分键）
      session-visibility.json      预留：放宽过可见性的会话（今天没有入口写，不会出现）
      audit/audit-YYYY-MM-DD.jsonl          审计
      usage-events/usage-YYYY-MM-DD.jsonl   用量事件
    _groups/<组 id>/               预留：组空间，今天不创建
    _archive/                      删号时选「归档」的账号数据
    <账号目录>/                    账号的工作空间（Claude 的 cwd）；老账号的目录名就是用户名
      .bridge/                     属主自己的数据：claude/（CLAUDE_CONFIG_DIR）、uploads/、media/、会话库……
```

规则：

- **`_` 开头的名字保留给系统。** 账号名本来就不能以 `_` 开头。将来要加的系统目录一律用 `_` 前缀。
- **`_system/` 由服务进程独占。** 成员、角色、可见性、组策略、额度这类「授权数据」只放这里。
- **工作空间里的 `.bridge/` 只放属主可以随便改的数据。** 它在 agent 的工具围栏之内，agent 改得到。
- **共享空间对所有成员用同一个绝对路径。** 不软链、不挂载进个人目录：会话记录按「配置目录 + 绝对 cwd」存放，路径一变，所有人的会话都要改写。

### 账号与设备的附加字段

都是附加字段：旧版本读到会忽略，装回旧版本照样能跑（例外见各条）。

- **账号 id**（`users.json` 每行的 `id`，见 `src/users.mjs`）：老账号没有 `id`，id 就是用户名（目录名、owner 键都不变）；
  新账号的 id 是「用户名-4 位随机串」，不与现存的任何 id、用户名或删过的 id 重复。改名只改 `name`（旧名记进 `renamedFrom`），
  id、目录、owner 键都不动。档位确认记在 `trustAck`。装回旧版本时，新建或改过名的账号会找不到目录（旧代码按名字找）。
- **`_system/retired-accounts.json`**：删过的账号 `{ id, name, deletedAt, data, archive? }`，`data` 是数据去向
  （`purged` / `archived` / `partial` / `kept`）；还有页面连着、数据要等断开再处理时是 `pending`，另带 `want`、`pendingSince`、`meta`，
  处理完摘掉。id 永不复用：同名的人重新注册拿到全新的 id 和目录，继承不到任何东西。
- **`_archive/<id>-<时间>/`**：删号时选「归档」的整个账号目录，附 `account.json`（名字、删除时间、用量，不含密码）。没有自动清理。
- **`invites.json`**：新码带 `expiresAt`（默认 7 天）；完全信任的码要管理员确认过才发（`ackAt`）；用掉后记 `usedById`。
  老码没有 `expiresAt`，不过期（控制台标为老码，可以作废）。
- **`devices.json`**：`login`（登记它的那次登录 `{kind, sid}` / `{kind:'master', gen}`；那次登录退出、过期、被踢，设备随之失效）、
  `loginless`（这一版之后登记、却没有可绑登录的成员设备）、`suspended`（账号停用期间挂起，启用后照常）；
  顶层 `tombstones` 是删掉的设备留下的 `{ owner, machineId, tokenHash, revokedAt }`，老令牌再来时报「已吊销」而不是「不认识」。

### 版本与迁移

`_system/layout.json` 记录这份数据是第几版布局。迁移步骤由 `migrateLayout()`（`src/runtime/layout.mjs`）按版本顺序执行。`src/server.mjs` 紧跟 `config/index.mjs` 之后 import `src/runtime/layout-boot.mjs`，所以迁移在 import 阶段就跑完，早于号池、额度策略、账号库这些「一被 import 就把数据读进内存」的模块：

- 没有 `layout.json` 就是 v0（版本号出现之前的数据）。v0 → v1 不改任何数据，只写版本号。
- 每一步都必须**幂等、只增不删**。老字段、老文件留着，装回旧版本照样能跑。
- 每做完一步立刻写盘。中途失败就停在那一步之前，服务照常启动，下次启动重试。
- 磁盘上的版本比代码新（装回了旧版本）时什么都不动，只在日志里报出来。
- 已经发布的步骤不再改。要改布局就加一个新版本号的新步骤，并在拉取请求里写明怎么回退。
- `layout.mjs` 只许依赖 `config/index.mjs` 和 `principal.mjs` 这类不碰数据的模块。往它的导入链里加台账模块，迁移就又晚于数据载入了（测试按导入图检查）。
- **例外是 `config.json`。** `config/index.mjs` 在迁移之前已经把它读进内存（导出的 `config` 对象，额度策略等从它取值）。改 `config.json` 的步骤必须同时改那份内存对象；做不到就别放进迁移，交给持有那个键的模块（号池 `claudeAccounts`、额度 `policy`……）在自己初始化时处理。

读改写台账时要保留认不出的字段（号池账号就这样做）。这样新版本加的字段，装回旧版本也不会丢。

## 3. 贡献者必须遵守的约束

下面这些约束针对「以后会做的组与团队功能」。今天写代码时守住它们，就不会把单人模型写得更死。

1. **区分 actor 和 scope。** 新的用量、审计、属主记录同时写这两个字段。新代码不要再用 `ctx.key` 表示「谁做的」。
2. **owner 键只经 `ownerKey` / `parseOwnerKey`。** 账号要用不可变 id 做键，不用可以改的登录名。
3. **管理权按能力判断。** 用 `can(ctx, …)`，不新增 `kind === 'admin'` 分支。需要新能力就加进 `principal.mjs` 的能力表。
4. **授权数据只放 `_system/`。** 工作空间的 `.bridge/` 只放属主可以随便改的数据。判断标准：「改了它，别人能多看到或多做什么」的就是授权数据，例如会话可见性、组成员、角色、额度。完全信任档的 agent 用 Bash 就能改 `.bridge/`，写保护只拦得住 Write / Edit 一类工具，不能据此放行。
5. **路径边界只经 `allowedRoots(ctx)`。** 它返回一组根：`null` 表示不设边界（主机身份），否则落在任意一个根之内即可。今天沙箱身份只有 `[ctx.cwd]`。工具围栏用 `fenceViolation(roots, check)` 按多根判；不要再写「是不是在 `ctx.cwd` 下」的单根判断。文件接口按「根 + 相对路径」寻址，今天的根就是 `ctx.cwd`；组空间以后作为另一个可选的根接进来（和新建项目时的「位置」一样），不靠相对路径跨出去。
6. **按目录复用的池子按（属主, 路径）键控。** 终端、无头浏览器这类池子用 `poolRef(ctx, 路径)` 取键，属主取 `scope`。只按路径的话，两个人进了同一个共享目录，就会接到同一个 shell 和同一份网站登录状态。光换键还不够，池子背后的东西也要按属主分开：桌面壳在线时，只有主机身份的浏览器开在壳里（壳的持久分区是主机自己的登录态），其他属主一律起无头浏览器、用自己的临时 profile。池子还要提供按属主收的入口（`killTermsOf(owner)`、`closeBrowsersOf(owner)`），账号删除或停用时整份收掉。
7. **新增的子进程经 `spawnFor(ctx, …)` 起**（不走 `child_process` 的拿 `spawnOptionsFor(ctx, …)`）。将来按人降权（每人一个系统账号或容器）只改这里。
8. **凭据经 `credentialFor(actor, scope)` 取。** 新代码不要直接读全局的激活号令牌。号池账号上的 `groups` 字段是给「按组分配号」预留的，今天不参与选号。
9. **审批的持久化只落到会话或个人一层，不写进仓库里的文件。** 将来的服务器策略和组策略经 Agent SDK 的 `managedSettings` 下发。如果机器上已经有 `/etc/claude-code/managed-settings.json`，要设 `parentSettingsBehavior: "merge"`。
10. **持久化的会话引用写成（属主, sessionId）。** 用 `sessionRef(owner, id)`；读老数据的裸 id 用 `parseSessionRef(v, 存放它的身份)` 补齐。会话可见性按第 4 条属于授权数据，只经 `src/runtime/session-visibility.mjs` 的 `sessionVisibility(ref)` / `setSessionVisibility(ref, v, {actor})` 读写，按 `sessionRef` 键控，缺省 `private`；改动写审计，删会话、删号时一并清。不要放进属主工作空间里的会话库（`.bridge/` 下的 `claude-session-library.json`）。事件总线的 `g:` 前缀留给组。
11. **数据布局改动走 `layout.json` 迁移**，对已有部署零破坏、可回退（见上一节）。
12. **管理员代他人操作、查看他人数据、改额度或档位，都要写审计**（`appendAudit`）。「查看」要在同意检查通过、数据真交出去之后再记，被拒的不记成查看；带上请求，记下是哪一张管理员凭据（`via`）。用量事件在每轮收尾处用 `noteTurnUsage(ctx, …)`（底下是 `appendUsageEvent`）记这一轮的增量：`{actor, scope, billedTo, workspace, accountId, model, tokens, cost}`，其中 `billedTo` 是计费人的 owner 键（`billingUser` 的结果，管理员自己的轮为空），按人分摊按它汇总，不按 `scope`。两份日志都只记元数据，不记对话内容、令牌、密码；邀请码这类本身就是凭据的值只留哈希前缀（`codeHash`）。`meta` 只收 `audit-log.mjs` 白名单（`SAFE_META`）里的键：管理接口新增可改字段时同步加进去，否则审计只剩一个动作名；id 由服务端生成的（例如号池加号），把结果里的 id 记进去。
13. **git 作者和代码托管平台的凭据将来按 actor 注入。** 不要让多人写同一个检出：每人一个 worktree 或克隆，再共享远端。
14. **不再新增全局 JSON 台账。** 新的身份、组、权限数据放进一个模块，接口按以后能换成数据库来设计。
15. **可关的功能写成插件。** bridge 的功能按插件组织（`src/kernel/` 内核 + `src/plugins/` 接线层，写法见手册插件章 `src/agent-api/manual/plugins.md`）：
    新功能能不依赖核心就写成插件——内置的登记进 `src/plugins/catalog.mjs`（默认套装，`load()` 里才 import 功能代码），
    路由用 `ctx.router` / `ctx.route` 挂（停用时自动摘），后台任务放 `ctx.when('ready', …)` 并返回撤销函数；
    给 Claude 的工具走 `ctx.claude.tool`，不再往 `agents/claude.mjs` 里直接加 MCP。核心代码里判断某功能开没开只用
    `pluginOn(id)`（插件系统没启动时恒真 = 老行为），不另加配置开关。包着「import 即有副作用 / 起子进程、撤不干净」老代码的插件标 `restart: true`。

## 4. 现在已经预留了什么

下面的预留今天都不改变行为，测试见 `src/runtime/principal.test.mjs` 与 `src/scenario3-reserve.test.mjs`。

| 预留 | 在哪 | 今天的行为 |
|---|---|---|
| owner 键的生成与解析 | `principal.mjs` 的 `ownerKey` / `parseOwnerKey` / `ownerLabel` | 格式不变 |
| `ctx.actor` / `ctx.scope` / `ctx.groups` | `contextFor` 出口 | 等于 `key` / 等于 `key` / 空；管理员代聊时 `actor = admin` |
| 能力判断 | `can(ctx, cap)` | 等价于原来的 `kind` / `shell` 判断 |
| 多根路径边界 | `allowedRoots` + `fenceViolation`：项目路径授权、工具围栏 | 沙箱身份只有一个根 |
| 终端 / 浏览器按（属主, 路径）分池 | `claude-term.mjs`、`claude-browser.mjs` | 主机身份与只给路径的调用方仍按路径，键不变；其他属主的浏览器不进桌面壳（无头 + 临时 profile），面板按浏览器状态里的 `desktop` 决定走原生视图还是直播帧；账号删除或停用时按属主收掉 |
| 会话可见性 | `session-visibility.mjs`（落 `_system/session-visibility.json`，按（属主, sessionId）键控） | 恒为 `private`；没有入口调用写函数，文件不会出现 |
| 数据布局版本 | `_system/layout.json`、`migrateLayout()`、启动时由 `layout-boot.mjs` 在 import 阶段执行 | v0 → v1 只写版本号 |
| 审计与用量事件 | `_system/audit/`、`_system/usage-events/` | 管理员的账号操作、查看他人数据（同意检查通过后）、代聊、代答审批会写审计；Claude 对话与定时任务里计费的轮（与 `usage.json` 同一口径）经 `noteTurnUsage` 写用量事件，管理员自己的轮今天不记；两份都只追加、没有地方读来做判断；目录在运行中被删会自动重建 |
| 子进程与凭据入口 | `run-as.mjs` 的 `spawnFor` / `credentialFor` | 原样透传；全服当前激活号 |
| 号池按组 | 账号记录的 `groups` 字段 | 读写保留，不参与选号 |
| 组空间路径 | `layout.mjs` 的 `groupRoot(id)` | 只算路径，不创建目录 |

## 5. 明确不做

- **两个账号实时共驾同一个会话。** 官方也不支持。将来的协作对齐官方：团队成员只读可见；「接手」就是把会话复制到自己名下，用自己的凭据继续聊。
- 组、共享空间、角色界面、会话共享界面、组预算、单点登录，现在都不做。
- 团队形态上线之前，要先有系统级隔离（每人一个系统账号或每人一个容器）。今天所有成员的进程都以服务进程的同一个系统账号运行，路径围栏只是纵深防御。
