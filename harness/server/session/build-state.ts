// 按会话配置建 AgentState（适配器、工具表、system、World State），以及记录回填。
import { familyPromptSection } from "../session-family.ts";
import { coordinatorRoleSection, projectContextText, projectIdFor, registerProjectSession } from "../project-mode.ts";
import { coordinatorToolTable, threadMemoryTools } from "../tools/project.ts";
import { COORDINATOR_SESSION_TOOLS } from "../tools/sessions.ts";
import path from "node:path";
import { AgentState, findToolCall } from "../agent/state.ts";
import type { PermissionMode } from "../agent/permissions.ts";
import { transcriptReadExternal } from "../agent/loop.ts";
import { describeWorldChange, LEGACY_AUDIT_CONTRACT, refreshDynamicContext, refreshPlanSection, systemPrompt } from "../agent/prompt.ts";
import { type Posture, resolveProfile } from "../agent/profile.ts";
import { worldToken, worldTokens, type WorldTokens, type WorldValues } from "../agent/world-state.ts";
import { Sandbox, type SandboxAccess } from "../sandbox.ts";
import { archiveDir, planArchive, writeArchive } from "../compaction-archive.ts";
import { outputsDir, persistOutput } from "../tools/result-store.ts";
import type { FileState, ToolContext } from "../tools/types.ts";
import { toolDefs, toolMap } from "../tools/registry.ts";
import { webSearchAvailable } from "../tools/websearch.ts";
import { makeSubAgentHost } from "../agent/subagent.ts";
import { agentTypesSection } from "../agent/subagent/definitions.ts";
import { backgroundAgentEnded, idleBeforeWrite, idleFilesSnapshot, settleStaleAgentCards } from "./subagents.ts";
import { makeWorkflowRunner } from "../agent/workflow.ts";
import { finishedJobsSummary, shell } from "../tools/bash.ts";
import { addUsage, ledgerRows, type UsageDelta, type UsageLedger, type UsageRow } from "../usage-ledger.ts";
import { type McpBaseline, mcpTools, planMcpBaseline } from "../tools/mcp.ts";
import { createAdapter } from "../providers/registry.ts";
import { effectiveBaseUrl, getConfig, resolveKey } from "../config.ts";
import { memoryRoot } from "../memory.ts";
import { memoryIndexChanges, renderAllMemoryForPrompt } from "../memory-index.ts";
import { memoryGrantDirs } from "../memory-files.ts";
import { externalMemoryBudget, externalMemoryIndex, externalReadDirs } from "../external-memory.ts";
import { recentSessionsSection } from "../recent-sessions.ts";
import { managedSkillsSection } from "../extensions.ts";
import { SessionHooks } from "../hooks/index.ts";
import { inheritedInstructions, readProjectDocs } from "../project-docs.ts";
import { renderProjectKnowledgeForPrompt } from "../knowledge.ts";
import { knowledgeSnapshot } from "../knowledge-service.ts";
import { type PersistedConfig, type PersistedSession, sessionsDir } from "../store.ts";
import type { ToolDef } from "../agent/turn.ts";
import { deferToolDefs, TOOL_SEARCH, toolSearchTool } from "../agent/deferred-tools.ts";
import { shapeVerifyTable, VERIFY_CONTRACT_MARKER } from "../agent/verify-tools.ts";
import { describeTable, describeTool } from "../agent/tool-descriptions.ts";
import { prefValue } from "../prefs.ts";
import { loadSessionImageBase64, sniffImageMime, storeSessionAudio, storeSessionImage, storeSessionVideo } from "../image-assets.ts";
import { sniffVideoMime } from "../video.ts";
import { sniffAudioMime } from "../audio.ts";
import { CodedError, ERROR_CODES } from "../errors.ts";
import { getCustomProvider, hostManagesBuiltins, isCustomProviderId } from "../custom-providers.ts";
import { dispatchSection } from "../agent/dispatch-ladder.ts";
import { registry } from "./registry.ts";
import { applyModeChange, applyReadRoots, applySessionAllow } from "./switches.ts";
import type { Session } from "./types.ts";
import { readGuide, workspaceRoot } from "./workspace.ts";

// 记忆根（测试进程里解析到临时目录之外会抛：那就不设围栏）
function safeMemoryRoot(): string | null {
  try {
    return memoryRoot();
  } catch {
    return null;
  }
}

// fast mode 是全局粘性开关，适配器每次请求现读：菜单里一关，跑着的会话下一次请求就按标准速度计费
const fastMode = (): boolean => getConfig().fast;


// ── State construction ───────────────────────────────────────────────────────

// M12：进 system / World State 的项目知识汇总读快照（同步、不扫描；开跑时由知识 worker 按预算对过）。这个工作区还
// 一份都没有就先空着，对完之后下一次请求前以 World State 片段补上。
function knowledgeSummary(root: string): string {
  const snapshot = knowledgeSnapshot(root);
  return snapshot ? renderProjectKnowledgeForPrompt(root, snapshot) : "";
}

// C4：本地日期 YYYY-MM-DD（World State 的 date 节）
function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Build a fresh AgentState for the given config. `systemOverride` is the resume
// path: preserve the original core/GUIDE contract, but refresh generated
// project facts and memory so a restored conversation does not inherit stale data.
// ── O8（N39）：用量账本（会话 × 厂商 × 型号 × 任务）──────────────────────────────────────────────
// 按会话 id 存在模块里（会话对象会被逐出、读回、回滚后重建——已经花掉的用量不该跟着对话一起「退回去」）；随记录落盘，
// 读回时内存里已有的（更新）优先。
function ledgerFor(sessionId: string): UsageLedger {
  let l = registry.usageLedgers.get(sessionId);
  if (!l) registry.usageLedgers.set(sessionId, (l = {}));
  return l;
}
const usageSinkFor = (sessionId: string) => (d: UsageDelta) => addUsage(ledgerFor(sessionId), d);
export function sessionUsage(sessionId: string): UsageRow[] {
  return ledgerRows(registry.usageLedgers.get(sessionId));
}

// 这个会话已经定下的姿态：记录里有就用；恢复出来、记录里没有的老会话是姿态改造之前建的——那时一律是加固形态（system 写着
// VerificationAudit 那套契约、工具带 verify），按 hardened 恢复，system、工具表、门禁照当初的样子。没有 system 要沿用的（新会话）不定，按评分判
function pinnedPosture(cfg: PersistedConfig, systemOverride: string | undefined): { pinnedPosture?: { posture: Posture; reason: string } } {
  if (cfg.posture === "lean" || cfg.posture === "hardened") return { pinnedPosture: { posture: cfg.posture, reason: "pinned by session" } };
  if (systemOverride) return { pinnedPosture: { posture: "hardened", reason: "legacy session (built before postures)" } };
  return {};
}

export function buildState(
  cfg: PersistedConfig,
  systemOverride?: string,
  sessionId?: string,
  storedWorld?: WorldTokens,
  mcp?: McpBaseline | null,
): AgentState {
  const apiKey = resolveKey(cfg.provider);
  if (!apiKey && isCustomProviderId(cfg.provider) && !getCustomProvider(cfg.provider)) {
    throw new CodedError(ERROR_CODES.providerKeyMissing, "这个对话用的自定义模型服务已经删掉了——在「模型服务」里换一家，开新对话接着做。", 400);
  }
  if (!apiKey) {
    throw new CodedError(
      ERROR_CODES.providerKeyMissing,
      // 宿主的模型中心接管了自带厂商：这家在模型中心里没有服务（删了 / 停用了 / 没勾给 dimensio）
      hostManagesBuiltins() && !isCustomProviderId(cfg.provider)
        ? `「${cfg.provider}」这家厂商现在没有可用的 Key：到「设置 › 模型中心」给它添加服务（或启用原来的），或者换一个模型服务。`
        : `No API key for provider "${cfg.provider}". Set it in the Settings panel or in .env.`,
      400,
    );
  }

  const sandbox = new Sandbox(
    cfg.workspace ? path.resolve(cfg.workspace) : workspaceRoot(),
    sandboxAccessFor(cfg),
  );
  // R10（二）/ R13：会话自己的压缩归档与落盘的大结果可读（只读，只放这个会话自己的两个目录）；挂给这个工作区的外部记忆库只读
  sandbox.setExtraReadDirs([...(sessionId ? [archiveDir(sessionId), outputsDir(sessionId)] : []), ...externalReadDirs(sandbox.root)]);
  // 这个工作区自己的记忆目录（工作区层 + 全局层）可读可写，记忆根里别的工作区的不可达（memory-files.ts）
  sandbox.setOwnStateDirs(memoryGrantDirs(sandbox.root), safeMemoryRoot());
  // P13（X18）：用户在卡片上放行的工作区外只读目录——沙箱每次判定现读（子 agent 共用这个沙箱，同样看得到）
  sandbox.setReadGrants(() => stateRef?.readRoots ?? []);
  const readFileState = new Map<string, FileState>();

  // 租户模式：用的是服务端共享 key 时，地址只能是服务端配置的默认地址（config.ts 的 effectiveBaseUrl）
  const baseUrl = effectiveBaseUrl(cfg.provider, cfg.baseUrl);
  const adapter = createAdapter({
    provider: cfg.provider,
    apiKey,
    model: cfg.model,
    baseUrl,
    fast: fastMode,
    cacheTtl: "1h",
  });
  // 模型档案（agent/profile.ts）：按这个会话的型号解析一次——提示词、工具、请求、loop 阈值都从它取。新建 / 从盘上恢复 /
  // 换型号重建（rebindModel）都经这里，所以换型号就是重新解析。
  // 姿态例外：system 正文与工具表是按它建的，会话第一次建 state 时定下、写回 cfg（cfg 就是 session.cfg / 记录里的 config，
  // 随会话落盘），之后换思考档、换型号、重启恢复都沿用，不按新档位的评分重判（中途翻了 system 与门禁就对不上，工具表一变还打穿缓存）
  const profile = resolveProfile(cfg.provider, cfg.model, { effort: cfg.thinking, ...pinnedPosture(cfg, systemOverride) });
  cfg.posture = profile.posture;

  // setTodos needs the state; wire it after construction via a holder.
  let stateRef: AgentState;
  const limits = { bashTimeoutMs: 120_000, bashMaxTimeoutMs: 600_000 };
  // 用户 hooks（hooks/）：按这个会话的工作区读一次定下；一条都没配就不挂（各挂点什么都不做）
  const hooks = SessionHooks.load(sandbox.root, sessionId);
  // 指令文件 @导入的文件按会话快照（project-docs/imports.ts）：会话里改了 README / package.json 不算项目指令变了；压缩重建 system 时清空重读
  const importCache = new Map<string, string>();
  const ctx: ToolContext = {
    sandbox,
    readFileState,
    // Tags this session's long-lived process resources (background jobs, preview
    // services, its own browser) so concurrent sessions stay separated.
    ownerId: sessionId,
    setTodos: (items) => {
      if (stateRef) stateRef.todos = items;
    },
    limits,
    agentSeesImages: adapter.capabilities.image,
    agentSeesVideo: adapter.capabilities.video,
    agentHearsAudio: adapter.capabilities.audio === true,
    provider: cfg.provider,
    ...(hooks ? { hooks } : {}),
    memoryWriter: true, // 主会话直接写记忆笔记（子 agent 的上下文没有这一项）
  };
  // The Agent tool's backing runner: sub-agents default to this session's
  // provider/model/effort (overridable per call). Mode and rules are read live
  // from the state so a plan→auto flip or a session-wide allow applies to
  // children spawned afterwards; a coder child is refused unless the parent is
  // in auto mode.
  // 这个会话此刻的状态：换型号 / 回滚之后会话重建了状态，之前起的后台子 agent 也该按现在这一份判模式、规则、快照口
  const liveState = (): AgentState | undefined => (sessionId ? registry.sessions.get(sessionId)?.state : undefined) ?? stateRef;
  const subAgents = makeSubAgentHost({
    provider: cfg.provider,
    apiKey,
    model: cfg.model,
    baseUrl,
    thinking: cfg.thinking,
    fast: fastMode,
    sandbox,
    limits,
    parentMode: () => liveState()?.permissionMode ?? cfg.permissionMode,
    parentBrowser: () => liveState()?.browser !== false,
    permissionRules: () => liveState()?.effectiveRules() ?? getConfig().permissionRules,
    ownerId: sessionId,
    // N26：子 agent 的破坏性命令同样先拍轮内快照、改文件前同样先备份（接父会话这一轮挂上的口）。父会话没在跑（后台子 agent
    // 在它收工之后接着干活）时接到这个会话最新的那张检查点上（session/subagents.ts）——不然这段时间的改动没有任何检查点覆盖
    snapshotFiles: (label) => {
      const port = liveState()?.ctx.snapshotFiles;
      if (port) return port(label);
      return sessionId ? idleFilesSnapshot(sessionId, sandbox.root, label) : Promise.resolve();
    },
    beforeFileWrite: (abs) => {
      const port = liveState()?.ctx.beforeFileWrite;
      if (port) return port(abs);
      return sessionId ? idleBeforeWrite(sessionId, sandbox.root, abs) : Promise.resolve();
    },
    // C6（G3）：子 agent / Workflow worker 继承项目指令（AGENTS.md 与 GUIDE.md）——以前几十个并行的 coder 都不知道项目的硬规矩
    projectInstructions: () => inheritedInstructions(readProjectDocs(sandbox.root, { contextWindow: adapter.capabilities.contextWindow, importCache }), readGuide(sandbox.root)),
    // O8：子 agent / 工作流里的 agent 的用量也记进这个会话的账本
    ...(sessionId ? { usageSink: usageSinkFor(sessionId) } : {}),
    // 用户 hooks：子 agent 的工具调用同样过 PreToolUse / PostToolUse，收尾报 SubagentStop
    ...(hooks ? { hooks: () => hooks.forSubagent() } : {}),
    // fork 的前缀、批准卡转交、后台实况都现取这个会话的状态；后台子 agent 收场由会话层通知（session/subagents.ts）
    // 换型号重建之后，之前起的后台子 agent 也该看到会话现在的状态（不是建它那时的那一份）
    parent: liveState,
    cacheTtl: "1h",
    ...(sessionId ? { onBackgroundEnd: (end) => backgroundAgentEnded(sessionId, end) } : {}),
  });
  const runSubAgent = subAgents.run;
  ctx.runSubAgent = runSubAgent;
  ctx.subAgents = subAgents.control;
  ctx.runWorkflow = makeWorkflowRunner({
    runSubAgent,
    journalDir: path.join(sessionsDir(), "workflows"),
  });

  const budget = {
    // Ceiling only — each adapter clips this to its own capability. Kept high
    // because a thinking model's reasoning tokens are billed against the output
    // budget; a low ceiling (was 16k) starved thinking-heavy models (Gemini at
    // HIGH) so they hit MAX_TOKENS mid-thought and never produced an answer.
    maxOutputTokens: Math.min(adapter.capabilities.maxOutputTokens, 65_536),
    thinking: cfg.thinking,
  };

  // WebSearch rides on the Gemini key; without one, don't advertise a dead tool.
  const hasWebSearch = webSearchAvailable();
  let defs = toolDefs();
  const tmap = toolMap();
  if (!hasWebSearch) {
    defs = defs.filter((t) => t.name !== "WebSearch");
    tmap.delete("WebSearch");
  }
  // 瘦身 P0-1：收工不再有记忆审计，MemoryAudit 不再下发。只有瘦身前建的会话例外——它恢复出来的 system 里还写着「收工前必须
  // 交 MemoryAudit」，工具留着让它交得出去（交了回一句「不用了」，见 AgentState.completeMemoryAudit）
  if (!systemOverride?.includes(LEGACY_AUDIT_CONTRACT)) {
    defs = defs.filter((t) => t.name !== "MemoryAudit");
    tmap.delete("MemoryAudit");
  }
  // 验证证据的工具形状（档案 tools.verifyTools，agent/verify-tools.ts）：lean 不带 verify 参数、不下发 VerificationAudit。
  // 沿用的 system 里写着那套验证契约的，工具照原样给——提示词点名的工具得在（姿态按会话定下后两者本来一致；这里兜住覆盖表把
  // verifyTools 单独改成 off 的情况）
  if (systemOverride?.includes(VERIFY_CONTRACT_MARKER)) profile.tools.verifyTools = "on";
  defs = shapeVerifyTable(defs, tmap, profile.tools.verifyTools);
  // 工具说明按姿态（档案 tools.descriptions，agent/tool-descriptions.ts）：hardened 换回改造前的原文
  defs = describeTable(defs, tmap, profile.tools.descriptions);
  // 档案点名只下发哪些内置工具（P0 恒为 null = 不裁）。在浏览器判定之前裁，提示词与工具表说的是同一套
  const subset = profile.tools.subset;
  if (subset) {
    defs = defs.filter((t) => subset.includes(t.name));
    for (const name of [...tmap.keys()]) if (!subset.includes(name)) tmap.delete(name);
  }
  // 项目对话（project-mode.ts）：协调者只拿只读的看 / 查 / 问 / 计划 + 会话工具 + 项目记忆 + 只读 Bash（在浏览器判定之前裁：
  // 协调者没有浏览器工具，提示词也不写那几句）；讨论串照常的工具表，后面追加项目记忆三件（MCP 之后、延迟加载之前）。
  // 建会话时定一次：形态在新会话第一轮就定下，讨论串的标记在它开出来时就在台账里。
  const coordinator = cfg.shape === "project";
  const projectId = coordinator ? (sessionId ?? null) : projectIdFor(sessionId);
  if (coordinator) {
    const trimmed = coordinatorToolTable(tmap, COORDINATOR_SESSION_TOOLS);
    tmap.clear();
    for (const [name, tool] of trimmed) tmap.set(name, tool);
    defs = [...trimmed.values()].map((t) => t.def);
  }
  // D5：浏览器工具（Browser / ReadPage / Eval / Network）跟着 headless.ts browserAvailable 进出注册表——在这里、建会话时
  // 定一次（新建 / 从盘上恢复 / 换型号重建都走 buildState），之后这个会话的工具清单与 system 不再跟着变（每轮改会打穿
  // 提示词缓存）。桌面壳宿主晚注册、扩展后连上、刚装好浏览器，下一个会话就有。
  const hasBrowser = tmap.has("Browser");
  // E1（G6）：基线里的 MCP 工具（直连的逐个；工具多的连接器走 McpDescribe / McpCall 网关）。协调者不接 MCP（连接器能写东西）
  if (!coordinator) {
    for (const t of mcpTools(mcp)) {
      if (tmap.has(t.def.name)) continue;
      defs = [...defs, t.def];
      tmap.set(t.def.name, t);
    }
  }
  // 讨论串：项目记忆三件
  if (projectId && !coordinator) {
    for (const t of threadMemoryTools()) {
      if (tmap.has(t.def.name)) continue;
      defs = [...defs, t.def];
      tmap.set(t.def.name, t);
    }
  }
  // 工具延迟加载（agent/deferred-tools.ts）：不常用的长说明工具只发简介 + 参数骨架，ToolSearch 取完整说明（排在最后：
  // 工具清单只往后追加）。执行与权限判定仍按 tmap 里的完整工具。建会话时定一次，之后不跟着偏好变。
  let deferredTools: Map<string, ToolDef> | undefined;
  if (prefValue<boolean>("deferTools") !== false) {
    // 协调者的本职就是开 / 管讨论串：会话协作那一族对它不推迟
    const families = coordinator ? profile.tools.deferredFamilies.filter((f) => !f.includes("StartSession")) : profile.tools.deferredFamilies;
    const r = deferToolDefs(defs, families);
    if (r.deferred.size) {
      const search = describeTool(toolSearchTool, profile.tools.descriptions);
      defs = [...r.defs, search.def];
      tmap.set(TOOL_SEARCH, search);
      deferredTools = r.deferred;
    }
  }

  // C4（X12、N09）：World State 各节此刻的值（runStart 时连日期、项目知识、记忆一起）
  // 协调者没有 Skill / Remember / Recall：技能目录与记忆索引不进它的 system，也不发它们的更新片段；
  // 项目对话与讨论串多一节 project（项目说明 + 项目记忆索引，一轮开跑时对一次）
  const readWorld = (runStart: boolean): WorldValues => ({
    guide: readGuide(sandbox.root) ?? "",
    projectDocs: readProjectDocs(sandbox.root, { contextWindow: adapter.capabilities.contextWindow, importCache }) ?? "",
    // C5：目录预算按这个模型的窗口算（×2%，封顶 1 万 token）
    ...(coordinator ? {} : { skills: managedSkillsSection({ contextWindow: adapter.capabilities.contextWindow, workspace: sandbox.root }) ?? "" }),
    jobs: sessionId ? finishedJobsSummary(sessionId) : "",
    // 调试模式（prefs/debug.ts）：每轮现读，会话中途开关下一轮以 World State 片段告知；租户实例不出这一项
    debug: process.env.DIMENSIO_TENANT !== "1" && prefValue<boolean>("debugMode") ? (tmap.has("BridgeCall") ? "bridge" : "file") : "",
    ...(runStart
      ? {
          date: localDate(),
          knowledge: knowledgeSummary(sandbox.root),
          // 记忆索引（两层的全部条目 + 目录路径，预算随窗口，memory-index.ts）
          ...(coordinator ? {} : { memory: renderAllMemoryForPrompt(sandbox.root, { contextWindow: adapter.capabilities.contextWindow }) }),
          // 自定义子 agent 类型的清单（.claude/agents、.dimensio/agents；有 Agent 才给）
          ...(tmap.has("Agent") ? { agents: agentTypesSection(sandbox.root, adapter.capabilities.contextWindow) } : {}),
          ...(projectId ? { project: projectContextText(projectId) } : {}),
        }
      : {}),
  });
  // 记忆索引的各版原文（按 World State 令牌存，只在本进程里）：模型手里那一版找得到时，memory 节变了只报差异（memory-index.ts）
  const memoryTexts = new Map<string, string>();
  const worldValues = (runStart: boolean): WorldValues => {
    const values = readWorld(runStart);
    if (values.memory !== undefined) {
      memoryTexts.set(worldToken("memory", values.memory), values.memory);
      while (memoryTexts.size > 16) memoryTexts.delete(memoryTexts.keys().next().value!);
    }
    return values;
  };
  const buildSystem = (mode: PermissionMode, world: WorldValues): string =>
    systemPrompt({
      root: sandbox.root,
      access: sandbox.access,
      permissionMode: mode,
      shell: shell.kind,
      platform: process.platform,
      provider: cfg.provider,
      model: cfg.model,
      guide: world.guide || undefined,
      projectDocs: world.projectDocs || undefined,
      managedSkills: world.skills || undefined,
      projectKnowledge: world.knowledge,
      memory: world.memory,
      // 外部记忆库的索引与这个工作区最近的会话：建 system 时定下，不走 World State（协调者没有记忆工具，不写）
      externalMemory: coordinator ? undefined : externalMemoryIndex(sandbox.root, externalMemoryBudget(adapter.capabilities.contextWindow)),
      recentSessions: coordinator ? undefined : recentSessionsSection(sandbox.root, sessionId),
      date: world.date,
      webSearch: hasWebSearch,
      // D5：浏览器工具没注册（这台机器没有可用的浏览器后端，或部署方关了）：提示词里不写浏览器 / Electron / 安卓那几句
      browser: hasBrowser,
      // bridge 拉起的实例才有 BridgeManual / BridgeCall：有才写 bridge 段（手册、操作、bug 诊断上报）
      bridge: tmap.has("BridgeCall"),
      // 拉取请求（tools/pullrequest.ts）：bridge 拉起的主机实例才有
      pr: tmap.has("PullRequest"),
      // 子 agent 选型阶梯 + 调度偏好（agent/dispatch-ladder.ts）：有 Agent / Workflow / StartSession 才写；
      // bridge 的子 agent 调用策略管着时按它的总开关与生效范围裁剪（只讲这个会话真有的那几样工具）
      agentTypes: world.agents || undefined,
      dispatch:
        tmap.has("Agent") || tmap.has("Workflow") || tmap.has("StartSession")
          ? dispatchSection({ tools: { agent: tmap.has("Agent"), workflow: tmap.has("Workflow"), session: tmap.has("StartSession") } })
          : undefined,
      // 会话协作：有 StartSession 才写这一段；子会话另带「你是子会话」（session-family.ts，建会话时定下）。协调者的协作规矩在它的角色段里
      collab: tmap.has("StartSession") && !coordinator ? familyPromptSection(sessionId) : undefined,
      // 项目对话：协调者整段换成协调者版（project-mode.ts 的角色段）；协调者与讨论串都带项目说明 + 项目记忆索引
      coordinator: coordinator ? coordinatorRoleSection() : undefined,
      project: world.project || undefined,
      profile,
      debug: world.debug || undefined,
    });
  let initialSystem: string;
  let initialWorld: WorldTokens;
  if (systemOverride && storedWorld) {
    // C4：恢复——system 原样沿用（前缀不断），这段时间里变了的节在下一次请求前以片段补上
    initialSystem = systemOverride;
    initialWorld = storedWorld;
  } else if (systemOverride) {
    // C4 之前写的会话：照旧刷新一次（plan 段按当前模式对齐、动态尾段按当前磁盘），从此记下令牌
    const world = worldValues(true);
    initialSystem = refreshPlanSection(
      refreshDynamicContext(systemOverride, { projectKnowledge: world.knowledge, memory: world.memory }),
      cfg.permissionMode,
      hasWebSearch,
    );
    const { date: _notInLegacySystem, agents: _agentsNotInLegacySystem, ...rest } = world;
    initialWorld = worldTokens({ mode: cfg.permissionMode, access: sandbox.access, ...rest });
  } else {
    const world = worldValues(true);
    initialSystem = buildSystem(cfg.permissionMode, world);
    initialWorld = worldTokens({ mode: cfg.permissionMode, access: sandbox.access, ...world });
  }

  if (deferredTools) ctx.deferredTools = deferredTools;
  stateRef = new AgentState({
    adapter,
    system: initialSystem,
    tools: defs,
    budget,
    ctx,
    toolMap: tmap,
    browser: hasBrowser,
    profile,
    permissionMode: cfg.permissionMode,
    permissionRules: cfg.permissionRules,
    // P1（#47）：规则每次判定现读全局配置（设置页新加的 deny/ask 对已开着的会话也立刻生效）；
    // 「本会话都允许」单独一层，随会话落盘。
    liveRules: () => getConfig().permissionRules,
    sessionAllow: cfg.sessionAllow,
    // V1：主会话的最终答复下附服务端验证回执。
    finalFootnotes: true,
    // 瘦身 P0-1：收工不设记忆关口（沉淀挪到 run 之后，见 memory-extract.ts）
    memoryAuditRequired: false,
    // R10（二）：整段压缩前把被压掉的原文归档成纯文本，摘要末尾写明在哪、怎么读（Context Recovery）
    // R13：微压缩清掉的旧工具输出也先存进 outputs 目录，占位里给路径
    compactionArchive: sessionId
      ? { plan: (count) => planArchive(sessionId, count), write: writeArchive, saveElided: (text) => persistOutput(sessionId, "elided", text) }
      : undefined,
    resolveImageAsset: sessionId
      ? (assetId) => loadSessionImageBase64(sessionId, assetId)
      : undefined,
    storeImageAsset: sessionId
      ? (block) => {
          const bytes = Buffer.from(block.data ?? "", "base64");
          if (block.t === "audio") {
            const mime = sniffAudioMime(bytes, block.name);
            if (!mime) throw new Error("cannot persist an unsupported audio block");
            return storeSessionAudio(sessionId, bytes, mime, block.name, block.durationSeconds);
          }
          if (block.t === "video") {
            const videoMime = sniffVideoMime(bytes);
            if (!videoMime) throw new Error("cannot persist an unsupported video block");
            return storeSessionVideo(sessionId, bytes, videoMime, block.name);
          }
          const mime = sniffImageMime(bytes);
          if (!mime) throw new Error("cannot persist an invalid or unsupported image block");
          return storeSessionImage(sessionId, bytes, mime, block.name);
        }
      : undefined,
  });
  // O8：主循环的用量记进这个会话的账本
  if (sessionId) stateRef.usageSink = usageSinkFor(sessionId);
  // P13：会话里已经放行的工作区外只读目录
  stateRef.readRoots = Array.isArray(cfg.readRoots) ? cfg.readRoots.filter((d): d is string => typeof d === "string" && path.isAbsolute(d)) : [];
  // C4：World State 注册表
  stateRef.systemWorld = initialWorld;
  stateRef.worldSource = worldValues;
  stateRef.worldDescribe = (section, value, was, wasToken) => {
    const prev = section === "memory" && value && wasToken !== undefined ? memoryTexts.get(wasToken) : undefined;
    return (prev !== undefined && memoryIndexChanges(prev, value)) || describeWorldChange(section, value, was, hasWebSearch, coordinator);
  };
  stateRef.rebuildSystem = () => {
    importCache.clear(); // 压缩边界：被导入的文件按此刻的磁盘重读一次
    const world = worldValues(true);
    return { system: buildSystem(stateRef.permissionMode, world), world };
  };
  ctx.noteMemoryChanged = () => stateRef.noteMemoryChanged();
  ctx.lookupToolCall = (id) => findToolCall(stateRef.messages, id);
  if (sessionId) stateRef.prefix.label = sessionId; // Q4：前缀判定的日志标明是哪个会话
  ctx.completeMemoryAudit = (decision, reason) => stateRef.completeMemoryAudit(decision, reason);
  ctx.completeVerificationAudit = (decision, reason) =>
    stateRef.completeVerificationAudit(decision, reason);
  return stateRef;
}

// Build the AgentState the first time a session runs (persists across messages).
export function initState(session: Session): AgentState {
  // M11（N33）：发起端带了配置快照就用它，全局配置只作默认
  const g = session.initialConfig ?? getConfig();
  session.initialConfig = undefined;
  session.cfg = {
    provider: g.provider,
    model: g.model,
    baseUrl: g.baseUrl,
    thinking: g.thinking,
    permissionMode: g.permissionMode,
    permissionRules: g.permissionRules,
    workspace: g.workspace,
    access: g.access,
    ...(session.initialShape ? { shape: session.initialShape } : {}),
  };
  // 项目对话：形态定下来，登记进项目台账（之后不加载会话记录也认得出它）
  if (session.initialShape === "project") registerProjectSession(session.id);
  session.initialShape = undefined;
  // E1：此刻连上的 MCP 连接器拍成这个会话的基线（没有就是 null）
  session.mcp = planMcpBaseline();
  const state = buildState(session.cfg, undefined, session.id, undefined, session.mcp);
  wireSessionState(session, state);
  return state;
}


// permissionMode="bypass"（管理员全权档）把沙箱推到 "bypass"（整机 + 跳过密钥守卫）；其余档照 cfg.access。
// 切进 / 切出 bypass 时据此重算沙箱 access，所以离开 bypass 会回到用户原来的访问范围选择。
export function sandboxAccessFor(cfg: { permissionMode?: PermissionMode; access?: SandboxAccess } | null | undefined): SandboxAccess {
  if (cfg?.permissionMode === "bypass") return "bypass";
  return cfg?.access ?? "workspace";
}


// 会话状态挂回会话的三个回调（新建 / 从盘上恢复 / 换型号重建都要挂）
export function wireSessionState(session: Session, state: AgentState): void {
  state.onModeChange = (mode) => applyModeChange(session, mode);
  state.onSessionAllow = (list) => applySessionAllow(session, list);
  state.onReadRoots = (list) => applyReadRoots(session, list);
}

// 记录里落盘的那部分会话状态回填进一份新建的 AgentState（从盘上恢复与换型号重建共用）
export function restoreFromRecord(state: AgentState, rec: PersistedSession): void {
  state.messages = rec.messages;
  state.todos = rec.todos ?? [];
  state.totalInputTokens = rec.totals?.inputTokens ?? 0;
  state.totalOutputTokens = rec.totals?.outputTokens ?? 0;
  state.lastContextTokens = rec.totals?.lastContextTokens ?? 0;
  state.totalCacheReadTokens = rec.totals?.cacheReadTokens ?? 0;
  state.totalCacheWriteTokens = rec.totals?.cacheWriteTokens ?? 0;
  // Q4：接着上次的前缀基线比
  state.prefix.restore(rec.prefixBaseline, rec.totals?.prefix);
  state.dirtySinceVerify = rec.gates?.dirtySinceVerify ?? false;
  state.mutationEpoch = rec.gates?.mutationEpoch ?? (state.dirtySinceVerify ? 1 : 0);
  state.verifiedEpoch = rec.gates?.verifiedEpoch ?? (state.dirtySinceVerify ? 0 : state.mutationEpoch);
  state.lastVerification = rec.gates?.lastVerification ?? "";
  state.editedFiles = new Set(rec.gates?.editedFiles ?? []);
  state.ranCommands = rec.gates?.ranCommands ?? [];
  // K9：K9 之前写的记录没有这项——从转录里推（压缩掉的那部分推不出来，尽力而为）
  state.externalContentSeen = rec.gates?.externalContent ?? transcriptReadExternal(state.messages);
  state.compactionFailures = rec.counters?.compactionFailures ?? 0;
  state.turnsSinceTodoSeen = rec.counters?.turnsSinceTodoSeen ?? 0;
  state.loadedTools = new Set(Array.isArray(rec.tools?.loaded) ? rec.tools.loaded.filter((n) => typeof n === "string") : []);
  // 后台子 agent 的卡片：进程死掉时还写着「在跑」的，改记成已停止
  if (state.ctx.ownerId) settleStaleAgentCards(state.ctx.ownerId, state.messages);
  // Bash 的当前目录：下一次调用时再核一遍（还在不在、出没出工作区），这里只接回来
  if (typeof rec.tools?.cwd === "string" && rec.tools.cwd) (state.ctx.shell ??= {}).cwd = rec.tools.cwd;
}
