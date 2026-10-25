# 接入与调用（给 agent 的接口）

这台 Muse Bridge 服务器（{{origin}}，版本 {{version}}）给 agent 准备了一套 HTTP 接口：拿到地址和一把 agent 密钥，就能直接查手册、给 Claude 派活、管文件与定时任务、把用户的界面带到某处——不用打开浏览器对着截图模拟点击。

## 这是什么、能做什么

Muse Bridge 是装在 Muse（muse.ai）agent VM 上的网页工作台：用户用浏览器或安卓 app 打开一个网址，就能用 Claude Code 和 dimensio，文件与会话都存在这台 VM 上（详见 overview 章）。这套接口把用户在界面上能做的主要事情做成了「操作」，每个操作一个地址：

- 查：我是谁、现在在跑什么（`whoami`、`overview`）、项目手册（`manual`）、Claude 会话与历史（`sessions.list` / `sessions.search` / `sessions.read`）、文件（`files.list` / `files.read` / `files.search`）、定时任务（`routines.list`）、额度（`usage`）。
- 做：给 Claude 发消息并等结果、回答它的提问与审批（`chat.send`、`chat.wait`、`chat.answer`）；写 / 移动 / 删除文件；建 / 改 / 停 / 立即运行定时任务；把用户开着的 Muse Bridge 界面带到某页、某个会话或某个文件（`ui.open`）。
- 每个操作都以密钥所属的身份执行，和他本人在界面上操作的权限完全一样：注册账号只碰得到自己的文件夹，没有命令行的身份就没有命令行。
- 接口只驱动 Claude Code；dimensio 的对话不经这套接口（用户要用 dimensio 就请他打开 dimensio 页）。

入口一览（不带密钥也能看前两个）：

| 地址 | 内容 |
|---|---|
| `GET {{origin}}/agent`（同 `/llms.txt`） | 就是本章：怎么接入、怎么调、全部操作参考。加 `?format=json` 得到机器可读目录 |
| `GET {{origin}}/agent/manual` | 项目手册目录；`/agent/manual/<章>` 整章；`/agent/manual?q=关键词` 检索最相关的小节 |
| `GET {{origin}}/agent/v1` | 操作目录（JSON，含每个操作的参数 schema 与你现在能不能用），要带密钥 |
| `GET` 或 `POST {{origin}}/agent/v1/<操作名>` | 执行一个操作，要带密钥 |

## 第一步：拿到 agent 密钥

agent 密钥由用户本人在 Muse Bridge 里生成：设置 ›「Agent 接入」›「生成密钥」。起个名字（如「我的 Muse」），明文以 `bak_` 开头、只显示这一次；「复制给 agent 的说明」会把地址、密钥和开场步骤一并复制，直接粘给 agent 即可。

- 一把密钥 = 用户的一次登录：能做他能做的一切；90 天后过期；可随时在同一页吊销；每人最多 20 把。
- 注册账号改密码、管理员重置访问令牌（`reset-token`），名下的密钥全部立即失效。
- 接口不能铸新密钥（只能人在设置页里生成），只能用 `keys.list` 看、`keys.revoke` 吊销。
- 已有的登录凭据（管理员访问令牌、账号登录令牌）放在同一个请求头里也认，但建议每个 agent 一把独立密钥，方便单独吊销。

## 部署它的 Muse 自己怎么用

Muse 本身就是一个 agent，拿到密钥就能用这套接口帮用户管理 Muse Bridge（查用法、看谁在跑、建定时任务、找历史会话、把用户界面带到某页……）。

- 请用户在 设置 ›「Agent 接入」生成一把（名字写「Muse」），把「复制给 agent 的说明」粘给 Muse。
- 在 VM 本机调用 `http://127.0.0.1:8787/agent/...` 就行：不走出站代理（`NO_PROXY=127.0.0.1,localhost`）、不弹 Muse 的网站审核卡，临时地址变了也不受影响。返回内容里的地址仍是公网地址。
- 密钥只放在环境变量或权限 600 的文件里，不要写进长期记忆、笔记或聊天记录；丢了就请用户吊销再生成一把。
- 装、更新、回滚、换域名、看门狗这些运维事不在接口里，照旧用 `bootstrap.sh` 的子命令（见 `deploy/muse/MUSE.md`）。

## 怎么调用

每个请求带请求头 `Authorization: Bearer <密钥>`（调用方设不了 Authorization 时可用 `X-Bridge-Key: <密钥>`）。只认请求头，不认 cookie，也不收放在网址里的密钥——别把密钥拼进 URL。

- `POST /agent/v1/<操作名>`，请求体是 JSON 对象，键就是操作的参数。推荐用这个。
- `GET /agent/v1/<操作名>?参数=值`：只适合简单的只读操作；数组、对象参数要写成 JSON 字符串。
- 未声明的参数会被拒（报 `bad_args` 并列出可用参数），拼错名字不会被静默忽略。

curl：

```
curl -s -X POST {{origin}}/agent/v1/whoami -H "Authorization: Bearer $BRIDGE_KEY"
curl -s -X POST {{origin}}/agent/v1/chat.send -H "Authorization: Bearer $BRIDGE_KEY" -H "Content-Type: application/json" \
  -d '{"message":"把工作空间里的 README.md 总结成三句话","wait":120}'
```

Python：

```
import os, requests
r = requests.post("{{origin}}/agent/v1/sessions.search", json={"q": "周报"},
                  headers={"Authorization": "Bearer " + os.environ["BRIDGE_KEY"]}, timeout=700)
print(r.json())
```

## 回应格式与错误

所有操作回同一种外形：

- 成功：`{ "ok": true, "op": "<操作名>", "data": { … } }`
- 失败：`{ "ok": false, "error": { "code": "…", "message": "人话说明", "hint": "下一步怎么办（可选）" } }`

| code | HTTP | 含义 |
|---|---|---|
| `bad_args` | 400 | 参数缺了、类型不对、不认识 |
| `unauthorized` | 401 | 没带密钥、密钥失效或被吊销 |
| `forbidden` | 403 | 这个身份没这个权限（如普通账号要命令行、agent 没对他开） |
| `not_found` | 404 | 没有这个操作 / 会话 / 文件 / 任务 |
| `conflict` | 409 | 目标已存在、会话正被别处占着 |
| `quota` | 429 | 注册账号的额度用完 |
| `unavailable` | 503 | 功能没装或没开 |
| `timeout` / `failed` | 504 / 500 | 超时 / 其他失败，看 message |

很多返回里带 `next` 字段：建议的下一步（例如「用 chat.wait 等结果」）。

## 慢操作：等对话

标「可能较慢」的操作（`chat.send` 带 wait、`chat.wait`）可能跑几十秒到几分钟。为了不被 Cloudflare 隧道掐断，服务端在 4 秒内没结果时会**先回 HTTP 200**，然后每 10 秒写一个空白字符保活，最后写出 JSON（JSON 前面的空白是合法的，常见 HTTP 库照常能解析）。所以：

- **一律看响应体里的 `ok`，不要只看 HTTP 状态码**——这种情况下出错也是 200 + `ok:false`。
- 客户端超时设长一点（≥ 你传的 wait 秒数 + 30 秒）；做不到就用小的 wait，循环调 `chat.wait`。
- 调用方断开连接不会停掉正在跑的对话；之后用 `chat.wait`、`overview` 接着看。
- 用临时地址时隧道偶尔不稳，在 VM 本机调 `127.0.0.1:8787` 最可靠。

## 给 Claude 派活并拿到结果

最常见的流程：

1. `chat.send { message, project?, wait? }` → 拿到 `sessionId`。不传 sessionId 开新会话（可用 `projects.list` 先选项目）；传了就在那个会话里接着说。会话正在跑时，`whenBusy` 默认 `queue`（排队，这一轮结束后自动发），也可 `steer`（插进正在跑的这一轮）或 `replace`（停掉重发）。
2. `chat.wait { sessionId, timeout }` → `status` 是下面之一：
   - `done`：`reply` 是 Claude 的最终回答，`files` 是它交付的文件；
   - `needs_input`：它在等人——`pending` 里是提问或工具审批，用 `chat.answer` 回，再接着 `chat.wait`；
   - `running`：还没完，`partial` 是目前说到的内容，继续 `chat.wait`；
   - `error` / `stopped`：出错 / 被停；`idle`：这个会话现在没在跑（返回最后一条回答）。
3. 要看完整过程：`sessions.read { sessionId }`。

注意：这一轮会实时出现在用户的界面上（会话列表、正在回复），和他自己发的一样，额度也算在密钥所属的身份上。Claude 有完整工具（读写文件、按身份的命令行、联网搜索与抓网页），但这台 VM 没有浏览器，不能打开网页截图。派活时把产出放在哪里写清楚。

## 权限、安全与礼貌

- 操作分三类：只读、会改东西（目录里标「改动」）、⚠ 删除 / 不可撤回（标 ⚠）。⚠ 类在执行前先征得用户同意——这和用户自己点按钮是一回事。工作空间的删除没有回收站。
- 替用户批准 Claude 的工具审批（`chat.answer` 的 decision）等于放行真操作，想清楚再批；拿不准就把问题转述给用户。
- `ui.open` / `ui.notify` 会直接改变用户眼前的界面，只在用户要你「带我去 / 打开给我看 / 提醒我」时用。
- 接口不跨身份：看不到、动不了别人的会话和文件；也没有服务端控制台（账号、邀请码、额度、Claude 账号、服务控制）的操作。
- 密钥只放在环境变量或密钥管理里，别写进代码仓库、日志、长期记忆或聊天记录。

## 在 Muse Bridge 里运行的 Claude 怎么用

Muse Bridge 自己的 Claude 会话里挂着两件工具，身份就是这一轮的身份，不需要密钥：

- `mcp__bridge__manual { topic?, q? }`：查本手册（目录 / 整章 / 检索）。
- `mcp__bridge__call { op, args }`：调一个操作，参数与返回和 HTTP 完全一样。查手册与只读操作免审批，会改东西的在手动审批模式下照常弹卡。
- 另开并行会话优先用 `mcp__sessions__start_session`。

用户问「这个 app 怎么用 / 在哪 / 能不能……」、或要你替他操作 Muse Bridge 本身（定时任务、历史会话、带他去某页……）时用它们。

## 直接调界面用的 /api/*

Muse Bridge 前端自己用的 `/api/*` 接口用同一把密钥也能调，但它们是给界面写的，随版本改、没有文档承诺。能用 `/agent/v1` 的操作就别绕过去；确实缺一个能力时，可以告诉用户这个能力值得加进接口（设置 ›「反馈」里提建议）。

## 全部操作

{{you}}

{{ops}}
