// Q15 / F5（ZCode F5、kimi K47 的 env 那一块）：harness 服务端读的环境变量，全部在这里登记——名字、归哪一块、用途、
// 默认值、是不是凭据。以前 90 多个变量散在 26 个文件里，大半没有任何说明，想知道「有哪些开关」只能全仓搜。
//
// 守卫（runtime-env.test.ts）：
//   · 服务端代码（不含测试与测试夹具）里读到的每个变量——`process.env.X`、`fromEnv("X")`（paths.ts）、`envMs("X", …)`
//     （netwait.ts / sse.ts）——都必须在这里登记；登记了却没有代码读的也报（删了开关记得删这里）；
//   · 标成凭据的都在子进程环境的剔除名单里（helper-proc.ts 的 isSensitiveEnvName）——凭据不会被 Bash 这类子进程继承。
// 新加一个变量：在这里加一行（按归属放），写清用途与默认值。
export type EnvArea =
  | "服务" // 端口、绑定、令牌、来源白名单
  | "路径" // 数据目录与文件的位置
  | "厂商" // 模型厂商的 key / 型号 / 地址
  | "知识与记忆"
  | "联网搜索"
  | "网络" // 出站代理与探测
  | "超时与重试"
  | "沙箱与子进程"
  | "检查点"
  | "bridge 集成" // 由 bridge 拉起时传进来的
  | "测试"
  | "系统"; // 操作系统 / Node 自带的变量（harness 只读或代为设置）

export interface EnvVar {
  name: string;
  area: EnvArea;
  description: string;
  default?: string;
  secret?: boolean; // 凭据：不打印、不进日志，子进程环境里剔除
}

export const ENV_REGISTRY: readonly EnvVar[] = [
  // ── 服务 ──
  { name: "PORT", area: "服务", description: "harness 监听端口", default: "8799" },
  { name: "DIMENSIO_HOST", area: "服务", description: "绑定地址（只在回环上，经 bridge 反代对外）", default: "127.0.0.1" },
  { name: "DIMENSIO_INTERNAL_TOKEN", area: "服务", description: "bridge 与 harness 之间的能力令牌（bridge 拉起时传入）", secret: true },
  { name: "DIMENSIO_DEV_TOKEN", area: "服务", description: "独立运行（不经 bridge）时开发页用的令牌；不给就每次启动随机生成", secret: true },
  { name: "DIMENSIO_ALLOWED_ORIGINS", area: "服务", description: "额外放行的页面来源（逗号分隔），写接口按来源白名单挡跨站请求" },
  { name: "DIMENSIO_CONTROL_PORTS", area: "服务", description: "额外的控制面端口（逗号分隔）：agent 不许占用、结束这些端口上的进程" },

  // ── 路径 ──
  { name: "SESSIONS_DIR", area: "路径", description: "会话记录目录", default: "<harness>/sessions" },
  { name: "WORKSPACE_DIR", area: "路径", description: "默认工作区", default: "<harness>/workspace" },
  { name: "DIMENSIO_CONFIG_FILE", area: "路径", description: "运行配置文件（上次选的厂商、型号、档位、规则）", default: "<harness>/runtime-config.json" },
  { name: "PROJECTS_FILE", area: "路径", description: "项目注册表（侧栏项目）", default: "<harness>/projects.json" },
  { name: "PROJECTS_ROOT", area: "路径", description: "新建项目的默认父目录", default: "~/Dimensio Projects" },
  { name: "DIMENSIO_QUICK_FILE", area: "路径", description: "快照对话的当前桶指针", default: "<harness>/quick.json" },
  { name: "DIMENSIO_QUICK_ROOT", area: "路径", description: "快照对话一次性桶的根目录", default: "~/.dimensio/quick" },
  { name: "DIMENSIO_CUSTOM_PROVIDERS_DIR", area: "路径", description: "自定义模型服务（地址、备注与加密的 API key）", default: "<harness>/custom-providers" },
  { name: "MEMORY_DIR", area: "路径", description: "记忆库目录（按工作区分）", default: "<harness>/memory" },
  { name: "KNOWLEDGE_DIR", area: "路径", description: "项目知识索引目录", default: "<harness>/knowledge" },
  { name: "DIMENSIO_GLOBAL_GUIDE", area: "路径", description: "全局 GUIDE.md（每个新会话都带的个人指南）", default: "~/.dimensio/GUIDE.md" },
  { name: "HARNESS_ENV_FILE", area: "路径", description: "启动时加载的 .env 文件", default: "<harness>/.env" },

  // ── 厂商 ──
  { name: "ANTHROPIC_API_KEY", area: "厂商", description: "Anthropic key", secret: true },
  { name: "ANTHROPIC_MODEL", area: "厂商", description: "Anthropic 默认型号", default: "目录里的默认" },
  { name: "OPENAI_API_KEY", area: "厂商", description: "OpenAI 兼容（DeepSeek 等）key", secret: true },
  { name: "OPENAI_MODEL", area: "厂商", description: "OpenAI 兼容默认型号", default: "目录里的默认" },
  { name: "OPENAI_BASE_URL", area: "厂商", description: "OpenAI 兼容接口地址", default: "目录里的地址" },
  { name: "QWEN_API_KEY", area: "厂商", description: "通义（DashScope）key；没有就用 VISION_API_KEY", secret: true },
  { name: "QWEN_MODEL", area: "厂商", description: "通义默认型号；没有就用 VISION_MODEL", default: "目录里的默认" },
  { name: "QWEN_BASE_URL", area: "厂商", description: "通义接口地址；没有就用 VISION_BASE_URL", default: "目录里的地址" },
  { name: "VISION_API_KEY", area: "厂商", description: "辅助视觉（文本模型看图）用的 key，兼作通义 key 的后备", secret: true },
  { name: "VISION_MODEL", area: "厂商", description: "辅助视觉型号，兼作通义型号的后备" },
  { name: "VISION_BASE_URL", area: "厂商", description: "辅助视觉接口地址，兼作通义地址的后备" },
  { name: "ZHIPU_API_KEY", area: "厂商", description: "智谱 key（也用于联网搜索的智谱后端）", secret: true },
  { name: "ZHIPU_MODEL", area: "厂商", description: "智谱默认型号", default: "目录里的默认" },
  { name: "ZHIPU_BASE_URL", area: "厂商", description: "智谱接口地址", default: "目录里的地址" },
  { name: "KIMI_API_KEY", area: "厂商", description: "Kimi 订阅端点 key（与旧开放平台的 key 不通用）；没有就用 MOONSHOT_API_KEY", secret: true },
  { name: "MOONSHOT_API_KEY", area: "厂商", description: "Kimi key 的旧名（后备）", secret: true },
  { name: "KIMI_MODEL", area: "厂商", description: "Kimi 默认型号", default: "目录里的默认" },
  { name: "KIMI_BASE_URL", area: "厂商", description: "Kimi 接口地址", default: "目录里的地址" },
  { name: "MIMO_API_KEY", area: "厂商", description: "MiMo key（Token Plan 的 tp- 与按量的 sk- 不通用）", secret: true },
  { name: "MIMO_MODEL", area: "厂商", description: "MiMo 默认型号", default: "目录里的默认" },
  { name: "MIMO_BASE_URL", area: "厂商", description: "MiMo 接口地址（按 key 前缀自动选）", default: "按 key 前缀" },
  { name: "GEMINI_API_KEY", area: "厂商", description: "Gemini key；没有就用 GOOGLE_API_KEY（也用于联网搜索的 Gemini 后端）", secret: true },
  { name: "GOOGLE_API_KEY", area: "厂商", description: "Gemini key 的后备名", secret: true },
  { name: "GEMINI_MODEL", area: "厂商", description: "Gemini 默认型号", default: "目录里的默认" },
  { name: "GEMINI_BASE_URL", area: "厂商", description: "Gemini 接口地址", default: "目录里的地址" },

  // ── 知识与记忆 ──
  { name: "KNOWLEDGE_AUTO_SEMANTIC", area: "知识与记忆", description: "每轮自动召回是否带语义检索；0 = 只用关键词", default: "开" },
  { name: "KNOWLEDGE_EMBEDDING_API_KEY", area: "知识与记忆", description: "语义检索的 embedding key；没有就用通义 key", secret: true },
  { name: "KNOWLEDGE_EMBEDDING_BASE_URL", area: "知识与记忆", description: "embedding 接口地址；没有就用通义 / 视觉的地址", default: "DashScope 兼容地址" },
  { name: "KNOWLEDGE_EMBEDDING_MODEL", area: "知识与记忆", description: "embedding 型号", default: "text-embedding-v4" },
  { name: "KNOWLEDGE_EMBEDDING_DIMENSIONS", area: "知识与记忆", description: "embedding 维度", default: "256" },
  { name: "DIMENSIO_EXTERNAL_MEMORY", area: "知识与记忆", description: "K8 外部记忆库只读挂载：`<库目录>` 或 `<库目录>=><工作区>|<工作区>`，分号分隔；默认不挂" },

  // ── 联网搜索 ──
  { name: "WEBSEARCH_BACKENDS", area: "联网搜索", description: "钉死后端顺序（逗号分隔：zhipu / kimi / deepseek / qwen / gemini / anthropic / mimo / ddg）；不给就当前会话那家的原生搜索排第一，其余按可用的自动排" },
  { name: "WEBSEARCH_DISABLE_DDG", area: "联网搜索", description: "1 = 不用 DuckDuckGo 后端" },
  { name: "WEBSEARCH_MODEL", area: "联网搜索", description: "Gemini 搜索用的型号（逗号分隔的候选）" },
  { name: "WEBSEARCH_ZHIPU_ENGINE", area: "联网搜索", description: "智谱搜索引擎档位", default: "search_std" },
  { name: "WEBSEARCH_DEEPSEEK_MODEL", area: "联网搜索", description: "DeepSeek 原生搜索（Anthropic 兼容接口）用的型号", default: "deepseek-chat" },
  { name: "WEBSEARCH_QWEN_MODEL", area: "联网搜索", description: "通义原生搜索（DashScope enable_search）用的型号", default: "qwen-plus" },
  { name: "WEBSEARCH_MIMO_MODEL", area: "联网搜索", description: "小米原生搜索（web_search 工具，需在控制台开插件）用的型号", default: "mimo-v2.6-flash" },
  { name: "MIMO_SEARCH_API_KEY", area: "联网搜索", description: "小米搜索专用的按量付费 key（Token Plan 的 tp- key 用不了联网插件；聊天仍用 MIMO_API_KEY）", secret: true },
  { name: "MIMO_SEARCH_BASE_URL", area: "联网搜索", description: "小米搜索专用 key 的接口地址", default: "https://api.xiaomimimo.com/v1" },
  { name: "WEBSEARCH_ANTHROPIC_MODEL", area: "联网搜索", description: "Claude 原生搜索（web_search 服务端工具）用的型号", default: "claude-haiku-4-5-20251001" },
  { name: "ANTHROPIC_BASE_URL", area: "联网搜索", description: "Claude 原生搜索走的接口地址（中转站时改它）", default: "https://api.anthropic.com" },

  // ── 网络 ──
  { name: "DIMENSIO_OUTBOUND_PROXY", area: "网络", description: "出站代理：auto（探测本机代理）/ off（直连）/ 代理地址", default: "auto" },
  { name: "BRIDGE_PROXY_PORTS", area: "网络", description: "auto 模式下探测的本机代理端口（逗号分隔）" },
  { name: "BRIDGE_PROXY_PROBES", area: "网络", description: "判断代理能不能出海的探测地址（逗号分隔）", default: "google generate_204 两个" },

  // ── 超时与重试 ──
  { name: "DIMENSIO_STREAM_FIRST_BYTE_MS", area: "超时与重试", description: "模型流式响应首字节最多等多久", default: "300000" },
  { name: "DIMENSIO_STREAM_IDLE_MS", area: "超时与重试", description: "模型流式响应中途静默最多多久算卡住", default: "300000" },
  { name: "DIMENSIO_SUMMARY_TIMEOUT_MS", area: "超时与重试", description: "压缩摘要请求的时限", default: "180000" },
  { name: "DIMENSIO_GREP_TIMEOUT_MS", area: "超时与重试", description: "Grep 工具的时限" },
  { name: "DIMENSIO_NET_WAIT_MS", area: "超时与重试", description: "断网时等网络恢复的总上限", default: "1800000" },
  { name: "DIMENSIO_NET_WAIT_BASE_MS", area: "超时与重试", description: "等网络恢复的首次退避", default: "5000" },
  { name: "DIMENSIO_RETRY_SCALE", area: "超时与重试", description: "重试退避的倍率（测试里调小）", default: "1" },
  { name: "DIMENSIO_INTERACTION_TIMEOUT_SCALE", area: "超时与重试", description: "卡片倒计时（提问 / 权限 / 计划）的倍率", default: "1" },

  // ── 沙箱与子进程 ──
  { name: "SANDBOX_ACCESS", area: "沙箱与子进程", description: "新会话默认访问范围（用户选过的以 runtime-config.json 为准）：workspace = 仅工作空间，其余 = 整机", default: "full" },
  { name: "DIMENSIO_READONLY_PATHS", area: "沙箱与子进程", description: "工作区外对所有会话开放读取的目录（分号分隔；只放行读与纯读命令）" },
  { name: "DIMENSIO_CHILD_ENV_ALLOW", area: "沙箱与子进程", description: "额外传给子进程（Bash 等）的变量名（逗号分隔；凭据名照样剔除）" },
  { name: "DIMENSIO_CHILD_HOME", area: "沙箱与子进程", description: "子进程用的隔离 HOME", default: "%TEMP%/dimensio-child-home" },
  { name: "DIMENSIO_SCRATCH_DIR", area: "沙箱与子进程", description: "$WORKSPACE_TMP 草稿目录（多用户时各用各的）", default: "%TEMP%/dimensio-scratch" },
  { name: "DIMENSIO_TENANT", area: "沙箱与子进程", description: "1 = 租户实例（bridge 多用户服务端给注册用户拉的）：锁访问范围、工作区限在自己文件夹、越界不弹审批、不连 bridge 集成件" },
  { name: "DIMENSIO_TENANT_SHELL", area: "沙箱与子进程", description: "租户有没有命令行：0 = 没有（关掉 Bash / Preview / 终端）", default: "1" },
  { name: "DIMENSIO_ACCESS_LOCK", area: "沙箱与子进程", description: "锁定访问范围（workspace / full），配置与会话接口都不许改；租户默认 workspace" },
  { name: "DIMENSIO_DENY_PATHS", area: "沙箱与子进程", description: "额外禁区（分隔符同 PATH）：文件工具与命令行都拒；租户自己的根除外" },
  { name: "DIMENSIO_DISABLED_TOOLS", area: "沙箱与子进程", description: "关掉的工具名（逗号分隔），主会话与子 agent 都没有" },
  { name: "DIMENSIO_DISABLE_PROVIDERS", area: "沙箱与子进程", description: "关掉的 provider（逗号分隔）：目录与配置接口里都不出现" },
  { name: "HEADLESS_BROWSER", area: "沙箱与子进程", description: "无头浏览器可执行文件（Browser / 截图工具用）", default: "自动找 Edge / Chrome" },
  { name: "PV_PUBLIC_DOMAIN", area: "沙箱与子进程", description: "Preview 服务的公网域名后缀（有就给预览生成公网地址）" },

  // ── 检查点 ──
  { name: "CHECKPOINTS", area: "检查点", description: "off = 不拍影子 git 检查点", default: "开" },
  { name: "CHECKPOINT_MAX_FILE_MB", area: "检查点", description: "检查点收录的单文件大小上限（MB）" },
  { name: "CHECKPOINT_MAX_SESSIONS", area: "检查点", description: "保留检查点的会话数上限" },

  // ── bridge 集成 ──
  { name: "BRIDGE_PORT", area: "bridge 集成", description: "托管 harness 的 bridge 端口（控制面端口之一）" },
  { name: "BRIDGE_ROOT", area: "bridge 集成", description: "bridge 仓库根（找扩展注册表、bridge 配置的位置）" },
  { name: "BRIDGE_DATA_ROOT", area: "bridge 集成", description: "bridge 数据根（找扩展注册表、bridge 配置的位置）" },
  { name: "BRIDGE_EXTENSIONS_FILE", area: "bridge 集成", description: "扩展中心注册表 registry.json 的位置（技能、连接器）", default: "按 bridge 数据根推" },
  { name: "BRIDGE_DESKTOP_HOST_FILE", area: "bridge 集成", description: "桌面壳落盘的宿主信息（共享浏览器的 CDP 端口等）" },
  { name: "BRIDGE_DESKTOP_BROKER", area: "bridge 集成", description: "桌面壳 broker 地址（给了就不读宿主文件）" },
  { name: "BRIDGE_DESKTOP_CDP_PORT", area: "bridge 集成", description: "桌面壳的 CDP 端口（与 broker 一起给）" },
  { name: "BRIDGE_LOCAL_PC_DESCRIPTOR", area: "bridge 集成", description: "本机 Agent（LocalPC 工具）的描述文件" },
  { name: "DIMENSIO_EDGE_EXTENSION_IDS", area: "bridge 集成", description: "额外认可的 Edge 扩展 ID（逗号分隔；自己打包的扩展 ID 与内置的不同时用）" },

  // ── 测试 ──
  { name: "DIMENSIO_TEST_ISOLATION", area: "测试", description: "测试进程标记（test-setup 设的）：数据全在临时目录、不自动续跑、不连 MCP" },
  { name: "DIMENSIO_AUTO_RESUME", area: "测试", description: "测试里强制打开 M13 自动续跑" },
  { name: "NODE_TEST_CONTEXT", area: "测试", description: "node --test 自己设的；用来认出测试进程" },

  // ── 系统 ──
  { name: "SHELL", area: "系统", description: "工作台终端用的 shell（非 Windows）", default: "bash" },
  { name: "HTTP_PROXY", area: "系统", description: "出站代理生效时由 harness 设给子进程" },
  { name: "HTTPS_PROXY", area: "系统", description: "出站代理生效时由 harness 设给子进程" },
  { name: "NO_PROXY", area: "系统", description: "出站代理生效时由 harness 设给子进程（本机地址直连）" },
];

export const ENV_NAMES: ReadonlySet<string> = new Set(ENV_REGISTRY.map((v) => v.name));
