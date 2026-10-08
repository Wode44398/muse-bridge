// M10（D8）：前后端协议版本号 + 能力位。
//
// 离线 apk 把前端打进包、只有 /api 走网，天然会出现「旧前端配新后端」（反过来也会：新包先装上、服务端还没重启）。
// 以前前端靠挨个探端点认「旧后端」（detectFeatures：每次启动多打三个请求，其中一个是整页会话列表），而且只认得出
// 「有没有这个端点」，认不出「这个端点的语义变没变」。
//
// 纪律（additive）：接口只加不改——加字段、加端点、加事件类型都不算不兼容，协议号不动。非改不可（改字段语义、删字段、
// 换事件流形态，如 M9 的附着改造）时：
//   · PROTOCOL 加一；
//   · 决定还服务不服务旧前端：服务就按客户端报的协议号留兼容路径；不服务就把 MIN_CLIENT 抬到新号——前端据此提示
//     「请更新 App」，而不是拿着看不懂的数据静默出错。
// 能力位 = 这台服务端有哪些可选的 API 面，前端据此决定显示什么、不必再探端点。只增不删：去掉一项就是不兼容改动。
//
// 客户端怎么报自己的协议号：事件流请求（/api/run、/api/sessions/:id/stream、/api/events）的查询串带 proto=<号>。
// 不能用自定义请求头：离线 apk 跨源访问 bridge，bridge 的 CORS 只放行 Content-Type / Authorization——加一个头，
// 预检就失败、所有请求一起挂，新前端连旧 bridge 时正是这样。没报 = 0（M10 之前的前端）。
// 服务端按它分流的第一处是 M9（附着改造）；在那之前只是约定好、先让新装的 apk 都带上。

export const PROTOCOL = 1;
// 0 = M10 之前、不报协议号的前端也照常服务（到今天为止的改动全是 additive）
export const MIN_CLIENT = 0;

export const CAPABILITIES = [
  "sessions", // 会话列表 / 记录 / 恢复（/api/sessions*）
  "files", // 工作区文件浏览与附件（/api/files*）
  "projects", // 项目侧栏（/api/projects*）
  "global-events", // P8 全局事件通道（/api/events）
  "memory", // K4 记忆治理：/api/memory* 认 workspace，晋升 / 驳回 / 撤销驳回（没有这一位的旧服务端只认全局工作区）
  "diagnostics", // Q13 一键诊断包：POST /api/sessions/:id/diagnostics
  "jobs", // U11 会话的后台 job：GET /api/sessions/:id/jobs、POST /api/sessions/:id/jobs/:jobId/kill
  "rewind", // U9 从这里改写：POST /api/sessions/:id/rewind、POST /api/sessions/:id/rewind/undo
  "hygiene", // C8 上下文卫生：POST /api/sessions/:id/compact、POST /api/sessions/:id/handoff {kind: summary | plan}
  "session-review", // U10 审阅「本会话」：GET /api/dock/review?scope=session、…/review/diff?scope=session、POST /api/sessions/:id/files/restore
  "memory-global", // K7 全局层记忆：/api/memory* 认 layer=global（关于用户与这台机器、每个工作区都适用；确认后才生效，有预算）
  "goal", // O7 目标续跑：/api/run 认 goal {verify?, maxRounds?, maxMinutes?}；POST /api/sessions/:id/goal {action: pause | resume | clear}；事件 goal
  "usage-ledger", // O8 用量账本：GET /api/sessions/:id/usage（厂商 × 型号 × 任务：主对话 / 子 agent / 工作流 / 压缩）
  "commands", // E3 斜杠命令：GET /api/commands（/ 面板的技能清单）；/api/run 与插话认 /技能名（事件 skill_loaded）
  "mcp", // E1 MCP 连接器：GET /api/mcp（连接状态）；会话里的 mcp__<连接器>__<工具> 与网关 McpDescribe / McpCall
  "read-roots", // P13 越界只读放行：读工作区外时弹卡（允许一次 / 本会话设为只读）；会话配置 readRoots、事件 read_roots、POST /api/sessions/:id/read-roots {remove}
  "steer-withdraw", // U2 待送达的插话可撤回：POST /api/sessions/:id/steer/withdraw {id}（事件 steer_withdrawn）、立即中断并发送 POST …/steer/interrupt {id}
  "session-search", // K10 侧栏正文搜索：GET /api/sessions/search?q=…（用户的话与助手正文命中 + 摘录）
  "project-order", // 侧栏项目块拖动排序：POST /api/projects/order {paths}（一个区拖完之后的完整次序）
  "session-refs", // 引用会话：/api/run 认 refs（会话 id，最多 3 个；被引用对话的摘要跟在消息后面给模型，消息上记 refs 给界面）
  "memory-overview", // K11 记忆总览：GET /api/memory/overview（全局层 + 各项目 + 旧快照桶的条目、用量、进提示字数、历史事件）
  "custom-providers", // 自定义模型服务：POST /api/custom-providers {name, baseUrl, apiKey, model?}、POST …/:id（改）、POST …/:id/delete；/api/info 的 catalog 里带 custom 字段（租户实例回 403）
  "session-model", // 会话内换型号 / 思考深度：POST /api/sessions/:id/model {model?, thinking?}（运行中回 pending，下一条消息起生效）；事件 model
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface ProtocolInfo {
  version: number;
  minClient: number;
  capabilities: Capability[];
}

export function protocolInfo(): ProtocolInfo {
  return { version: PROTOCOL, minClient: MIN_CLIENT, capabilities: [...CAPABILITIES] };
}
