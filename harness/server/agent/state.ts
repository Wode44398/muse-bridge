import { randomUUID } from "node:crypto";
import type { AttachmentRef, Block, Budget, Msg, ToolDef, Turn } from "./turn.ts";
import type { TodoItem } from "./events.ts";
import type { ProviderAdapter } from "../providers/types.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import type { UsageDelta, UsageTask } from "../usage-ledger.ts";
import {
  DeniedTargets,
  ruleMatches,
  rulesFingerprint,
  sessionAllowRule,
  upgradeSessionAllow,
  type PermissionMode,
  type PermissionRules,
  type SessionAllow,
} from "./permissions.ts";
import { repairToolPairing } from "./pairing.ts";
import { PrefixAudit, type RewriteKind } from "./prefix-audit.ts";
import { messageKind, skillLoadedIn } from "./injections.ts";
import { worldBaseline, worldDelta, worldTokens, type WorldSection, type WorldTokens, type WorldValues } from "./world-state.ts";
import { DEFAULT_MEDIA_BUDGET, planRetirement, retiredText, type MediaItem } from "./media-budget.ts";
import { LoopGuard } from "./loop-guard.ts";

// Image, video and audio share the asset/data/url shape, so they share one store.
type MediaBlock = Extract<Block, { t: "image" } | { t: "video" } | { t: "audio" }>;

// R10（二）：压缩归档的落点。plan 只算这次要写的文件名（count 个分片，不落盘）；write 真写。
// R13：saveElided = 微压缩清掉的旧工具输出先存一份（同步写，返回文件路径；写不成返回 null）。
// E3：插话是 /技能名 时，跟在插话后面追加的那条 harness 消息
export interface SteerAttach {
  name: string; // 技能名或包名
  kind: string; // injections 的类别（slash-skill）
  text: string;
  pkg?: boolean; // 点的是技能包
}
export interface SteerItem {
  id: string;
  text: string;
  attach?: SteerAttach;
}

export interface CompactionArchive {
  plan(count: number): string[];
  write(files: { path: string; text: string }[]): Promise<void>;
  saveElided?(text: string): string | null;
}

export interface AgentStateInit {
  adapter: ProviderAdapter;
  system: string;
  tools: ToolDef[];
  budget: Budget;
  ctx: ToolContext;
  toolMap: Map<string, Tool>;
  permissionMode: PermissionMode;
  permissionRules?: PermissionRules;
  // P1（#47）：全局规则的现读入口。给了就每次判定现读（设置页新加的 deny/ask 对已开着的会话下一次调用
  // 就生效）；不给（测试 / 子 agent 自带规则）就用上面的 permissionRules。
  liveRules?: () => PermissionRules;
  // P1：落过盘的「本会话都允许」（恢复会话时带回来）。
  sessionAllow?: SessionAllow[];
  // P2：子 agent 的模式上限——父会话此刻的模式，每次判定现读（见 effectiveMode）。
  modeCeiling?: () => PermissionMode;
  // V1：最终答复下附服务端尾注（验证回执等）。只给有人看的主会话开；子 agent 的答复是交给父会话的
  // 结果，不掺这类尾注。
  finalFootnotes?: boolean;
  resolveImageAsset?: (assetId: string) => string;
  storeImageAsset?: (block: MediaBlock) => MediaBlock;
  // R10（二）：整段压缩的原文归档（Context Recovery）。只给主会话接；子 agent / 测试不给就不归档、摘要里没有回查页脚。
  compactionArchive?: CompactionArchive;
  // Main agents persist durable knowledge and must audit it. Read-only helper
  // agents have no memory tools, so their loop explicitly disables this gate.
  memoryAuditRequired?: boolean;
}

export interface AssistantParts {
  text: string;
  thinkingText: string;
  thinkingSig?: string;
  calls: { id: string; name: string; args: Record<string, unknown>; meta?: Record<string, unknown> }[];
}

// A pure social acknowledgement cannot add durable project knowledge. Keep
// this deliberately narrow and whole-message anchored: "你好，以后都用中文"
// must NOT match because it contains a lasting user preference.
// Bare acknowledgements ("好的" / "收到" / "ok" / "嗯") belong here for the same
// reason greetings do: they carry nothing to remember, yet every one of them used
// to drive the full MemoryAudit gate — three nudge rounds and, at worst, a hard
// error ending an otherwise fine turn. Only the standalone forms match; anything
// with content after them ("好的，那就改成蓝色") stays a normal turn.
// Bare yes/no is deliberately NOT here: as an answer to a question it can carry a
// decision worth remembering, which is exactly what the audit gate is for.
const PURE_SOCIAL_TURN_RE =
  /^(?:(?:你|您)好(?:呀|啊|哇)?|早上好|早安|下午好|晚上好|晚安|在吗|嗨|哈[啰罗喽]|hello|hi|hey|谢谢(?:你)?|多谢|thanks|thank\s+you|好(?:的|吧|啊|呀)?|行(?:吧|的)?|可以|没问题|知道了|明白(?:了)?|懂了|收到|辛苦(?:了|啦)?|嗯+|哦+|噢+|ok(?:ay)?|sure|got\s+it|understood|sounds\s+good|nice|great|cool|perfect)[\s,，!！.。?？~～]*$/iu;

export function isPureSocialTurn(text: string): boolean {
  return PURE_SOCIAL_TURN_RE.test(text.trim());
}

// 落盘记录里带回来的「本会话都允许」：形状不对的整条丢掉（宁可再问一次，也不凭残缺记录放行）。
function validAllowEntry(a: unknown): a is SessionAllow {
  const x = a as Partial<SessionAllow> | null;
  return Boolean(x) && typeof x!.rule === "string" && x!.rule.length > 0 && typeof x!.mode === "string" &&
    typeof x!.access === "string" && typeof x!.rulesHash === "string";
}

export class AgentState {
  adapter: ProviderAdapter;
  system: string;
  tools: ToolDef[];
  budget: Budget;
  ctx: ToolContext;
  toolMap: Map<string, Tool>;
  permissionMode: PermissionMode;
  // Per-call rules (allow/deny/ask) when no live source is wired (tests, sub-agents
  // with their own rules). Sessions read the global rules live instead (liveRules).
  permissionRules: PermissionRules;
  private readonly liveRules?: () => PermissionRules;
  // P1（#47）：「本会话都允许」，每条带着产生时的授权状态；onSessionAllow 让会话把它落盘。
  sessionAllow: SessionAllow[] = [];
  onSessionAllow?: (list: SessionAllow[]) => void;
  // P13（X18）：用户在卡片上「本会话把这个目录设为只读」的工作区外目录（沙箱经 setReadGrants 现读；onReadRoots 让会话落盘、广播）
  readRoots: string[] = [];
  onReadRoots?: (list: string[]) => void;
  grantReadRoots(dirs: string[]): void {
    const next = [...this.readRoots];
    for (const d of dirs) if (!next.includes(d)) next.push(d);
    if (next.length === this.readRoots.length) return;
    this.readRoots = next;
    this.onReadRoots?.(next);
  }
  revokeReadRoot(dir: string): boolean {
    const next = this.readRoots.filter((d) => d !== dir);
    if (next.length === this.readRoots.length) return false;
    this.readRoots = next;
    this.onReadRoots?.(next);
    return true;
  }
  // Notified when the mode changes mid-run, so the session can persist it and
  // tell every attached device (plan approved → auto).
  onModeChange?: (mode: PermissionMode) => void;
  // R6（#32）：有副作用的工具批次开跑前调用——会话在这里立刻落盘，进程若在工具执行中途死掉，
  // 转录里至少留着「这些调用发出去了」，恢复时才能如实说「结果未知」而不是「没执行」。
  beforeSideEffects?: () => Promise<void>;
  // V5（#20）：这一轮开跑时的检查点快照到现在，工作区改了哪些文件（工作区相对路径）。会话开着检查点时由会话挂上，
  // 验证门禁在要收尾时用它补上调用自己没报的改动；没挂（子 agent、无头、检查点关了）就只认调用报的。
  changedSinceRunStart?: () => Promise<string[]>;
  // N26（HT3）：可能写过工作区的调用（不是只读、也不是只删的）一次加一；snappedAtSeq = 上一张快照（开跑时的检查点、
  // 或上一张轮内快照）拍下时的值。两者相等 = 上一张之后这个 agent 没写过东西，破坏性命令前不必再拍（省一次全量暂存）。
  workSeq = 0;
  snappedAtSeq = 0;
  // C4（X12、N09）：World State 分节注册表（world-state.ts）。systemWorld = system 建成时各节的令牌；worldSource 由会话挂上，
  // 给出此刻各节的值（runStart 时连日期、项目知识、记忆一起给）；rebuildSystem = 压缩成功后重建一次 system（唯一的全量
  // 重建点），返回新 system 与它各节的值。子 agent / 测试不挂就什么都不做。
  systemWorld: WorldTokens = {};
  worldSource?: (runStart: boolean) => WorldValues;
  worldDescribe?: (section: WorldSection, value: string, was: string | undefined) => string;
  rebuildSystem?: () => { system: string; world: WorldValues };
  private readonly resolveImageAsset?: (assetId: string) => string;
  private readonly storeImageAsset?: (block: MediaBlock) => MediaBlock;
  readonly compactionArchive?: CompactionArchive;

  messages: Msg[] = [];
  todos: TodoItem[] = [];
  // ── Steering (插话/转向) ─────────────────────────────────────────────────
  // Messages the user sent WHILE this run was going. The run used to be a closed
  // box: the frontend disabled the composer and the server answered 409, so a
  // correction ("不是这个文件" / "先别动数据库") could only be delivered by
  // stopping the run and starting over — losing the turn's work. These queue up
  // and the loop drains them between turns as ordinary visible user messages, so
  // the model reads them as the user talking mid-task.
  // U2（#46）：每条插话带 id（客户端生成，缺省服务端补），steer_queued / steer_applied / steer_returned 都
  // 带着它——客户端按 id 对得上号，不再按文本猜（同一句「继续」说两次也分得清）。
  // E3：attach = 这条插话是 /技能名——注入插话时紧跟着追加的那条 harness 消息（技能正文），loop 同时发 skill_loaded
  private steerQueue: SteerItem[] = [];
  queueSteer(text: string, id?: string, attach?: SteerAttach): string {
    const clean = text.trim();
    const sid = id || randomUUID();
    if (clean) this.steerQueue.push({ id: sid, text: clean, ...(attach ? { attach } : {}) });
    return sid;
  }
  hasSteer(): boolean {
    return this.steerQueue.length > 0;
  }
  // U2（X36 第二步）：还没注入的插话可以撤回——在队列里就拿掉（返回原话）；已经注入了（或根本没有）返回 null
  withdrawSteer(id: string): string | null {
    const i = this.steerQueue.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const [item] = this.steerQueue.splice(i, 1);
    return item.text;
  }
  // Drain everything queued so far. Returns [] when nothing is pending, so the
  // loop can cheaply check-and-inject at its turn boundaries.
  takeSteer(): SteerItem[] {
    if (!this.steerQueue.length) return [];
    const out = this.steerQueue;
    this.steerQueue = [];
    return out;
  }
  // "Allow this shape of call for the rest of the session": an exact-subject
  // allow rule, which outranks the ask rule that fired (deny still wins).
  // P1：记下此刻的模式 / 访问范围 / 全局规则指纹，任一变了就不再算数；并交给会话落盘。
  // P5：默认记字面规则 Tool(=原文)；rules 给了（卡片上选了「按前缀」）就记这几条——它们是服务端算好、自测过的。
  allowForSession(toolName: string, subject: string, rules?: string[]): void {
    const list = rules?.length ? rules : [sessionAllowRule(toolName, subject)];
    const binding = this.allowBinding();
    this.sessionAllow = [
      ...this.sessionAllow.filter((a) => !list.includes(a.rule)),
      ...list.map((rule) => ({ rule, ...binding, v: 2 as const })),
    ];
    this.onSessionAllow?.(this.sessionAllow);
  }

  private allowBinding(): Omit<SessionAllow, "rule"> {
    return {
      mode: this.permissionMode,
      access: this.ctx.sandbox?.access ?? "workspace",
      rulesHash: rulesFingerprint(this.baseRules()),
    };
  }

  baseRules(): PermissionRules {
    return this.liveRules?.() ?? this.permissionRules;
  }

  // 这一刻还算数的「本会话都允许」。
  validSessionAllows(): string[] {
    const now = this.allowBinding();
    return this.sessionAllow
      .filter((a) => a.mode === now.mode && a.access === now.access && a.rulesHash === now.rulesHash)
      .map((a) => a.rule);
  }

  // 每次判定用的规则：全局规则（现读）+ 还算数的本会话允许。deny 永远压过 allow（见 decide）。
  effectiveRules(): PermissionRules {
    const base = this.baseRules();
    const extra = this.validSessionAllows();
    return extra.length ? { allow: [...base.allow, ...extra], deny: base.deny, ask: base.ask } : base;
  }

  isSessionAllowed(toolName: string, subject: string): boolean {
    return this.validSessionAllows().some((rule) => ruleMatches(rule, toolName, subject));
  }

  setPermissionMode(mode: PermissionMode): void {
    if (this.permissionMode === mode) return;
    this.permissionMode = mode;
    this.onModeChange?.(mode);
  }

  // P2（#18）：每次工具判定用的模式。主 agent 就是自己的模式；子 agent 还要受父会话此刻模式的
  // 约束，只收紧不放宽——以前 coder 的模式在派出时就算定了，用户运行中「拉手刹」切只读，已派出的
  // coder（Workflow 里最多 60 个）照样继续写盘。父会话在 plan 时子 agent 按 read-only 判：子 agent
  // 没有 ExitPlanMode，plan 的拒绝文案（叫它提交计划）对它不成立。
  private readonly modeCeiling?: () => PermissionMode;
  effectiveMode(): PermissionMode {
    const ceiling = this.modeCeiling?.();
    if (!ceiling || ceiling === "auto" || this.permissionMode !== "auto") return this.permissionMode;
    return "read-only";
  }

  totalInputTokens = 0;
  totalOutputTokens = 0;
  // Q4（K11 的用量部分）：输入里命中缓存的读取量 / 写入缓存的量（provider 回报了才有；llama.cpp 兼容服务回报复用量）。
  totalCacheReadTokens = 0;
  totalCacheWriteTokens = 0;
  lastContextTokens = 0;
  // R9：上一次实测的输入 token 数与当时的消息条数（锚）；历史被就地改写时清掉
  contextAnchor: { tokens: number; messages: number } | null = null;
  // R9：provider 真拒过的窗口（R7 的立刻压缩记下来）；主动压缩按它与目录窗口里小的那个判
  observedWindow: number | null = null;
  compactionFailures = 0;
  // Tool-turns since the model last saw its todo list (TodoWrite call or
  // reminder injection) — drives periodic re-injection so the plan survives
  // long runs and compactions.
  turnsSinceTodoSeen = 0;
  // Done-gate: set by a successful Edit/Write, cleared only by explicit passed
  // verification evidence. Inspection, Preview, and failed commands do not count.
  dirtySinceVerify = false;
  mutationEpoch = 0;
  verifiedEpoch = 0;
  lastVerification = "";
  verificationAuditCompleted = false;
  verificationAuditNudges = 0;
  // Consecutive output-token-limit truncations auto-continued so far. Bounded —
  // a model that keeps hitting the cap without converging must not loop forever.
  lengthContinues = 0;
  // Source files edited this run (absolute paths) — feeds the done-gate's
  // reverse-dependency test scan. Reset per user message.
  editedFiles = new Set<string>();
  // Files created this run (absolute paths). This is deliberately separate
  // from editedFiles so ordinary source edits do not become attachment cards.
  createdFiles = new Set<string>();
  // Every Bash command run in this session (capped) — the scan checks these to
  // see which test files were actually exercised. Survives across user messages.
  ranCommands: string[] = [];
  // Commands that succeeded after an edit and look like a real check, but were
  // never passed verify:true. NOT evidence — the gate still holds — but the
  // difference between "you never verified" and "you verified without saying so"
  // is the difference between an accurate nudge and a false accusation
  // (2026-08-16: a k3 run was told it had not verified right after a real-device
  // E2E and a full assembleDebug, both exit 0).
  undeclaredEvidence: string[] = [];
  // Per-run budget (opt-in via /api/run): a wall-clock deadline and/or a cap on
  // model turns. The loop nudges convergence at 80% and, once exhausted, gives
  // the model one final turn whose tool calls are not executed.
  runStartedAt = 0;
  deadlineAt: number | null = null;
  maxTurns: number | null = null;
  runTurns = 0;
  // R7：本 run 里上一次「provider 说超窗 → 立刻压缩」发生在第几轮（rapid-refill 熔断用）
  lastReactiveCompactTurn: number | null = null;
  budgetNudged = false;
  budgetExhausted = false;
  // R15：分级重复熔断（每次新的用户消息重置）；loopGuardStopped = 这次的「收尾轮」是熔断触发的，不是预算
  loopGuard = new LoopGuard();
  loopGuardStopped = false;
  // P6（X17、N16）：本 run 的拒绝台账；连续几次没被批准（用户拒绝 / 没人在场）；到 3 次就收尾——denialsStopped
  // = 这次的收尾轮是连续拒绝触发的。都随每条新的用户消息清零。
  deniedTargets = new DeniedTargets();
  consecutiveDenials = 0;
  denialsStopped = false;
  // Mandatory cross-session-memory audit. A normal run cannot finish until an
  // explicit MemoryAudit checkpoint; full context compaction uses the same gate.
  readonly memoryAuditRequired: boolean;
  memoryAuditCompleted = false;
  memoryAuditAutoSkipped = false;
  memoryChangedSinceAudit = false;
  memoryAuditNudges = 0;
  // plan 模式下「没走 ExitPlanMode 就想收尾」的提醒次数（每条用户消息重置，只提醒一次）
  planNudges = 0;
  // R19：「只写了思考、没给答复就要收尾」的追问次数（每条用户消息重置）
  answerNudges = 0;
  preCompactAuditPassed = false;
  preCompactAuditPrompted = false;

  constructor(init: AgentStateInit) {
    this.adapter = init.adapter;
    this.system = init.system;
    this.tools = init.tools;
    this.budget = init.budget;
    this.ctx = init.ctx;
    this.toolMap = init.toolMap;
    this.permissionMode = init.permissionMode;
    this.permissionRules = init.permissionRules
      ? { allow: [...init.permissionRules.allow], deny: [...init.permissionRules.deny], ask: [...init.permissionRules.ask] }
      : { allow: [], deny: [], ask: [] };
    this.liveRules = init.liveRules;
    // P5：旧记录里的 Tool(原文) 载入时改成字面规则，原文里的 * ? 不再当通配符
    this.sessionAllow = Array.isArray(init.sessionAllow) ? init.sessionAllow.filter(validAllowEntry).map(upgradeSessionAllow) : [];
    this.modeCeiling = init.modeCeiling;
    this.finalFootnotes = init.finalFootnotes ?? false;
    this.resolveImageAsset = init.resolveImageAsset;
    this.storeImageAsset = init.storeImageAsset;
    this.compactionArchive = init.compactionArchive;
    this.memoryAuditRequired = init.memoryAuditRequired ?? true;
    this.memoryAuditCompleted = !this.memoryAuditRequired;
    this.preCompactAuditPassed = !this.memoryAuditRequired;
    // C5：Skill 同名不重复注入——正文此刻还在转录里（加载过、没被整段压缩掉）就只提示「上面已有」
    this.ctx.skillLoaded ??= (name) => skillLoadedIn(this.messages, name);
    // K9（X55）：本会话读过外部内容没有（loop 在网页类工具 / 读过网页的子 agent 返回后置位；随会话落盘）
    this.ctx.externalContent ??= () => this.externalContentSeen;
  }

  // K9（X55）：本会话读过外部内容（网页、搜索结果、浏览器页面，或子 agent 读过）。只会从 false 变 true。
  externalContentSeen = false;

  // R5：出口配对修复的累计次数（诊断用；转录本身是坏的时，每轮都会修一次）。
  pairingRepairs = 0;

  // Q3：请求不变量的违规计数（生产上只计数、不抛；测试里 loopState 收尾核对）与前几条样本。
  invariantViolations = 0;
  invariantSamples: string[] = [];

  // Q3：运行中改写 system 只走这里，由改写者报备原因。请求不变量「同一次 run 内 system 不变」据此放行；直接赋值
  // state.system 的改写不算报备，会被记成违规（它会悄悄打断缓存前缀）。C4 起生产上只剩压缩成功后的重建一处——
  // 切模式、切访问范围改走 World State 片段，不再改写 system。
  systemRewrites = 0;
  lastSystemRewrite: "mode" | "access" | "compaction" | null = null;

  rewriteSystem(next: string, reason: "mode" | "access" | "compaction"): void {
    if (next === this.system) return;
    this.system = next;
    this.systemRewrites++;
    this.lastSystemRewrite = reason;
    this.contextAnchor = null; // R9：锚里算的是旧 system
    this.prefix.noteRewrite(reason);
  }

  // Q4：请求前缀守恒判定器（每次 provider 调用在编码后的请求体上判纯追加，断了记原因与重发量）。
  readonly prefix = new PrefixAudit();

  // Q4：改写模型可见前缀的地方自报原因（压缩、召回换了、审计收尾挪位、恢复会话……），判定器据此归因。
  noteRewrite(kind: RewriteKind): void {
    this.contextAnchor = null; // R9：历史被就地改写，锚对不上了
    this.prefix.noteRewrite(kind);
  }

  toTurn(): Turn {
    const paired = repairToolPairing(this.messages);
    if (paired.repairs) {
      if (!this.pairingRepairs) {
        console.warn(`[agent] repaired ${paired.repairs} tool call/result pairing problem(s) before sending; the stored transcript is malformed`);
      }
      this.pairingRepairs += paired.repairs;
    }
    // R12：一次请求里的历史图片超了 provider 的额度，就退一批最老的工具图（标在转录上，之后每次请求字节都一样）
    const media: MediaItem[] = [];
    let messages = this.materializeMessages(paired.messages, (item) => media.push(item));
    const retire = planRetirement(media, this.adapter.capabilities.mediaBudget ?? DEFAULT_MEDIA_BUDGET);
    if (retire.length) {
      for (const block of retire) block.retired = true;
      this.noteRewrite("media-retire");
      messages = this.materializeMessages(paired.messages);
    }
    return {
      system: this.system,
      messages,
      tools: this.tools,
      budget: this.budget,
    };
  }

  // Resolve immutable session image references only at the provider boundary.
  // The raw transcript keeps small asset ids; provider requests receive native
  // base64 blocks. Tool-result images are handled recursively as well.
  // R12：退役了的图片换成一句文字；collect 按请求里的顺序收集每张图（原块、base64 字节、是不是工具图）给退役阶梯算额度。
  materializeMessages(messages: Msg[], collect?: (item: MediaItem) => void): Msg[] {
    const canVideo = this.adapter.capabilities.video;
    const canAudio = this.adapter.capabilities.audio === true;
    const materialize = (block: Block, fromTool: boolean): Block => {
      // Switching to a text/image-only model mid-session must not silently drop
      // the video the earlier turns were about — say what is missing instead.
      if (block.t === "audio" && !canAudio) {
        return { t: "text", text: `[Audio ${block.name ?? "attachment"} is not readable by ${this.adapter.model}: it takes no audio input. Switch to an audio-capable model such as MiMo to hear the original recording.]` };
      }
      if (block.t === "video" && !canVideo) {
        return {
          t: "text",
          text: `[video ${block.name ?? "attachment"} is not readable by ${this.adapter.model}: it takes no video input. ` +
            "Switch to a video-capable model, or sample it into frames with the Read tool.]",
        };
      }
      if (block.t === "image" && block.retired) return { t: "text", text: retiredText(block.name) };
      if ((block.t === "image" || block.t === "video" || block.t === "audio") && block.asset && !block.data && !block.url && this.resolveImageAsset) {
        const { asset: _asset, ...rest } = block;
        const data = this.resolveImageAsset(block.asset);
        if (block.t === "image") collect?.({ block, bytes: data.length, retirable: fromTool });
        return { ...rest, data };
      }
      if (block.t === "image" && block.data) collect?.({ block, bytes: block.data.length, retirable: fromTool });
      if (block.t === "tool_result") {
        return { ...block, content: block.content.map((b) => materialize(b, true)) };
      }
      return block;
    };
    return messages.map((message) => {
      // 工具回灌的图坐在一条「Attachment(s) from the previous tool call:」开头的用户消息里（tool 角色带不了图）
      const fromTool = messageKind(message) === "tool-attachments";
      return { ...message, content: message.content.map((b) => materialize(b, fromTool)) };
    });
  }

  private externalizeBlocks(content: Block[]): Block[] {
    if (!this.storeImageAsset) return content;
    const externalize = (block: Block): Block => {
      if ((block.t === "image" || block.t === "video" || block.t === "audio") && block.data && !block.asset && !block.url) {
        return this.storeImageAsset!(block);
      }
      if (block.t === "tool_result") {
        return { ...block, content: block.content.map(externalize) };
      }
      return block;
    };
    return content.map(externalize);
  }

  addUserMessage(text: string): void {
    this.addUserMessageBlocks([{ t: "text", text }], text);
  }

  addUserMessageBlocks(
    content: Block[],
    auditText: string,
    metadata: { displayText?: string; attachments?: AttachmentRef[] } = {},
  ): void {
    if (!content.length) throw new Error("user message must contain text or an attachment");
    if (healDanglingToolCalls(this.messages)) this.prefix.noteRewrite("heal");
    const message: Msg = {
      role: "user",
      content: this.externalizeBlocks(content),
      ...(metadata.displayText !== undefined ? { displayText: metadata.displayText } : {}),
      ...(metadata.attachments?.length ? { attachments: metadata.attachments } : {}),
    };
    this.messages.push(message);
    // Fresh run, fresh behavioral gates.
    this.dirtySinceVerify = false;
    this.runEvidence = [];
    this.runAudit = null;
    this.verificationGateGaveUp = false;
    this.memoryAuditGaveUp = false;
    this.failedEdits = new Map();
    this.verificationAuditCompleted = false;
    this.verificationAuditNudges = 0;
    this.undeclaredEvidence = [];
    this.lengthContinues = 0;
    this.editedFiles = new Set();
    this.createdFiles = new Set();
    // Budgets are per-run: they must be re-specified with each user message.
    this.runStartedAt = Date.now();
    this.deadlineAt = null;
    this.maxTurns = null;
    this.runTurns = 0;
    this.lastReactiveCompactTurn = null;
    this.budgetNudged = false;
    this.budgetExhausted = false;
    this.loopGuard = new LoopGuard();
    this.loopGuardStopped = false;
    this.deniedTargets = new DeniedTargets();
    this.consecutiveDenials = 0;
    this.denialsStopped = false;
    const hasImage = content.some((block) => block.t === "image" || block.t === "video" || block.t === "audio");
    this.memoryAuditAutoSkipped = this.memoryAuditRequired && !hasImage && isPureSocialTurn(auditText);
    this.memoryAuditCompleted = !this.memoryAuditRequired || this.memoryAuditAutoSkipped;
    this.memoryChangedSinceAudit = false;
    this.memoryAuditNudges = 0;
    this.planNudges = 0;
    this.answerNudges = 0;
    this.preCompactAuditPassed = !this.memoryAuditRequired || this.memoryAuditAutoSkipped;
    this.preCompactAuditPrompted = false;
  }

  noteMemoryChanged(): void {
    if (!this.memoryAuditRequired) return;
    this.memoryAuditAutoSkipped = false;
    this.memoryChangedSinceAudit = true;
    this.memoryAuditCompleted = false;
    this.preCompactAuditPassed = false;
  }

  // Any successful work after an audit can uncover a new durable fact, so the
  // end gate becomes dirty again. MemoryAudit itself is excluded by the loop.
  noteActivityAfterAudit(): void {
    if (!this.memoryAuditRequired) return;
    if (!this.memoryAuditCompleted) return;
    this.memoryAuditAutoSkipped = false;
    this.memoryAuditCompleted = false;
    this.preCompactAuditPassed = false;
  }

  recordMutation(): void {
    this.mutationEpoch++;
    this.dirtySinceVerify = true;
    // A new edit invalidates whatever ran before it. V2（#21）：追问计数按用户消息累计、只在成功时清零——
    // 以前每次新编辑都清零，一个边改边交答复的模型永远走不到出口。
    this.undeclaredEvidence = [];
    this.lastVerification = "";
    this.verificationAuditCompleted = false;
  }

  // V2（#21）：验证门禁追问用尽后放行（交付最后一版 + 「未验证」尾注），本轮不再追问。
  verificationGateGaveUp = false;
  // K6（G4）：记忆审计门禁追问用尽后放行（交付追问之前那版答复 + 尾注），不再整轮报错。
  memoryAuditGaveUp = false;

  // V3（#33）：本轮没落地的 Edit/Write，按路径记账（同一路径之后编辑成功就销账），收尾时由服务端
  // 在最终答复下列出——以前失败的编辑不进 editedFiles，门禁零介入，「修改完成」原样交付。
  failedEdits = new Map<string, { display: string; reason: string }>();

  // V1（#19）：本轮（每条用户消息一轮）的证据账本——最终答复下的服务端回执从这里生成。
  runEvidence: { passed: boolean; detail: string }[] = [];
  runAudit: { decision: string; reason: string } | null = null;
  finalFootnotes = false;

  recordVerification(passed: boolean, detail: string): void {
    this.lastVerification = detail.trim().slice(0, 500);
    this.runEvidence.push({ passed, detail: this.lastVerification });
    if (this.runEvidence.length > 20) this.runEvidence.shift();
    if (this.mutationEpoch === 0) return;
    if (passed) {
      this.verifiedEpoch = this.mutationEpoch;
      this.dirtySinceVerify = false;
      this.verificationAuditNudges = 0;
      this.undeclaredEvidence = [];
    } else {
      this.verifiedEpoch = Math.min(this.verifiedEpoch, this.mutationEpoch - 1);
      this.dirtySinceVerify = true;
      this.verificationAuditCompleted = false;
    }
  }

  completeVerificationAudit(
    decision: "not_applicable" | "blocked",
    reason: string,
  ): { ok: boolean; message: string } {
    const concrete = reason.replace(/\s+/g, " ").trim();
    if (this.editedFiles.size === 0) {
      return { ok: false, message: "No files were edited in this run, so no verification audit is needed." };
    }
    if (concrete.length < 20) {
      return { ok: false, message: "Give a concrete verification limitation (at least 20 characters)." };
    }
    this.verificationAuditCompleted = true;
    this.verificationAuditNudges = 0;
    this.runAudit = { decision, reason: concrete.slice(0, 300) };
    return {
      ok: true,
      message: `Verification audit recorded as ${decision}: ${concrete}. This does not mark the changes as verified.`,
    };
  }

  completeMemoryAudit(
    decision: "updated" | "none",
    reason: string,
  ): { ok: boolean; message: string } {
    if (!this.memoryAuditRequired) {
      return { ok: false, message: "Memory audit is disabled for this agent." };
    }
    const concrete = reason.replace(/\s+/g, " ").trim();
    if (concrete.length < 12) {
      return { ok: false, message: "Give a concrete audit reason (at least 12 characters)." };
    }
    if (decision === "updated" && !this.memoryChangedSinceAudit) {
      return { ok: false, message: "No successful Remember change occurred since the previous audit." };
    }
    if (decision === "none" && this.memoryChangedSinceAudit) {
      return { ok: false, message: "Memory changed during this run; submit decision:'updated'." };
    }
    this.memoryAuditCompleted = true;
    this.memoryChangedSinceAudit = false;
    this.memoryAuditNudges = 0;
    this.planNudges = 0;
    this.preCompactAuditPassed = true;
    this.preCompactAuditPrompted = false;
    return { ok: true, message: `Memory audit recorded as ${decision}: ${concrete}` };
  }

  // Attach an optional budget to the run just started with addUserMessage.
  setRunBudget(budget?: { deadlineMs?: number; maxTurns?: number }): void {
    this.runStartedAt = Date.now();
    this.deadlineAt =
      budget?.deadlineMs && budget.deadlineMs > 0 ? this.runStartedAt + budget.deadlineMs : null;
    this.maxTurns =
      budget?.maxTurns && budget.maxTurns > 0 ? Math.floor(budget.maxTurns) : null;
  }

  // C4：这一次请求之前，哪几节变了就追加一条内部片段（system 不动）。runStart = 一轮开跑后的第一次请求——日期、项目
  // 知识、记忆只在这时看。返回是否追加了。
  injectWorldDelta(runStart: boolean): boolean {
    if (!this.worldSource) return false;
    const values: WorldValues = { mode: this.permissionMode, access: this.ctx.sandbox.access, ...this.worldSource(runStart) };
    const delta = worldDelta(values, worldBaseline(this.systemWorld, this.messages), this.worldDescribe ?? ((s, v) => `${s}: ${v}`));
    if (!delta) return false;
    this.messages.push({
      role: "user",
      content: [{ t: "text", text: delta.text }],
      internal: true,
      origin: "harness",
      kind: "world-state",
      world: delta.tokens,
    });
    return true;
  }

  // M12：模型还没见过这份 system 的会话（新建的，转录里还没有一条助手消息），system 里还缺的节（建会话时知识 worker
  // 还没对完的项目知识）直接重建进去——没有前缀可断，不算改写，也不必再追加片段。模型答过话的会话（包括恢复的）一概不动。
  refreshSystemIfUnsent(): void {
    if (!this.rebuildSystem || this.messages.some((m) => m.role === "assistant")) return;
    const next = this.rebuildSystem();
    this.system = next.system;
    this.systemWorld = worldTokens({ mode: this.permissionMode, access: this.ctx.sandbox.access, ...next.world });
    this.contextAnchor = null;
  }

  // C4（N09 第 3 步）：压缩成功后重建一次 system——这是唯一合法的全量重建点（Q4 按 compaction 报备）；基线随之换成新
  // system 的值，压掉的那些片段也就不必再补。
  rebuildSystemAfterCompaction(): void {
    if (!this.rebuildSystem) return;
    const next = this.rebuildSystem();
    this.rewriteSystem(next.system, "compaction"); // 经报备：运行中压缩时，请求不变量不把它记成违规
    this.systemWorld = worldTokens({ mode: this.permissionMode, access: this.ctx.sandbox.access, ...next.world });
  }

  // Append an arbitrary user message (e.g. tool feedback carrying an image).
  // C3：harness 自己塞的一律带来源（kind 用 injections.ts 的名字）；缺省 = 用户本人（只有 addUserMessageBlocks 该这么用）。
  appendUserBlocks(
    content: Block[],
    internal = false,
    from?: { origin: "steer" | "harness"; kind?: string; displayText?: string },
  ): void {
    if (content.length) this.messages.push({
      role: "user",
      content: this.externalizeBlocks(content),
      ...(internal ? { internal: true } : {}),
      ...(from ? { origin: from.origin, ...(from.kind ? { kind: from.kind } : {}) } : {}),
      // 插话在界面上显示用户原话（不带给模型看的前缀）
      ...(from?.displayText !== undefined ? { displayText: from.displayText } : {}),
    });
  }

  // O8（N39）：用量账本的出口——每次请求的用量连同厂商 / 型号 / 任务报出去（会话挂上；子 agent 的状态继承父会话的，
  // 任务标 subagent / workflow）。没挂就不记。
  usageSink?: (d: UsageDelta) => void;
  usageTask: UsageTask = "main";

  recordUsage(inputTokens: number, outputTokens: number, cache: { cacheReadTokens?: number; cacheWriteTokens?: number } = {}): void {
    this.usageSink?.({
      provider: this.adapter.id,
      model: this.adapter.model,
      task: this.usageTask,
      input: inputTokens,
      output: outputTokens,
      cacheRead: cache.cacheReadTokens ?? 0,
      cacheWrite: cache.cacheWriteTokens ?? 0,
    });
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCacheReadTokens += cache.cacheReadTokens ?? 0;
    this.totalCacheWriteTokens += cache.cacheWriteTokens ?? 0;
    // Measured prompt size — calibrates the char-based estimate's floor.
    // R9：同时作为锚——记下这次请求发出时有几条消息，之后追加的按估算补上（context.ts 的 contextTokens）。
    if (inputTokens > 0) {
      this.lastContextTokens = inputTokens;
      this.contextAnchor = { tokens: inputTokens, messages: this.messages.length };
    }
  }

  // O8：主循环之外的一次调用（压缩摘要……）只进账本，不进主对话的 totals（那是上下文与主对话用量）
  recordSideUsage(task: UsageTask, u: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void {
    this.usageSink?.({
      provider: this.adapter.id,
      model: this.adapter.model,
      task,
      input: u.inputTokens ?? 0,
      output: u.outputTokens ?? 0,
      cacheRead: u.cacheReadTokens ?? 0,
      cacheWrite: u.cacheWriteTokens ?? 0,
    });
  }

  appendAssistant(parts: AssistantParts, internal = false): void {
    const content: Block[] = [];
    if (parts.thinkingText) {
      content.push({ t: "thinking", text: parts.thinkingText, signature: parts.thinkingSig });
    }
    if (parts.text) content.push({ t: "text", text: parts.text });
    for (const c of parts.calls) {
      content.push({ t: "tool_call", id: c.id, name: c.name, args: c.args, meta: c.meta });
    }
    if (content.length) this.messages.push({ role: "assistant", content, ...(internal ? { internal: true } : {}) });
  }

  appendToolResults(results: Block[], internal = false): void {
    if (results.length) this.messages.push({
      role: "user",
      content: this.externalizeBlocks(results),
      ...(internal ? { internal: true } : {}),
    });
  }
}

const MEMORY_AUDIT_NUDGE_PREFIXES = [
  "[Memory audit required]",
  "[Pre-compaction memory audit]",
];

const VERIFICATION_NUDGE_PREFIXES = [
  "[Automated check] You have edited files",
  "[Automated check] These test files reference modules you edited",
];

// C3（#41）：只认 harness 来源的消息——用户本人贴回一段提示语（「这是什么意思？」），以前被当成旧式追问，连同上一条答复
// 一起从历史里消失。
function isLegacyAuditNudge(message: Msg): boolean {
  return message.role === "user" && message.origin === "harness" && message.content.some(
    (block) => block.t === "text" && MEMORY_AUDIT_NUDGE_PREFIXES.some((prefix) => block.text.startsWith(prefix)),
  );
}

function isLegacyVerificationNudge(message: Msg): boolean {
  return message.role === "user" && message.origin === "harness" && message.content.some(
    (block) => block.t === "text" && VERIFICATION_NUDGE_PREFIXES.some((prefix) => block.text.startsWith(prefix)),
  );
}

// Produce the conversation view exposed to users. The raw transcript keeps
// internal lifecycle turns because providers need the tool-call/result pairs
// for correct continuation. The legacy state machine also cleans sessions
// persisted before `Msg.internal` existed.
export function visibleMessages(messages: Msg[]): Msg[] {
  const visible: Msg[] = [];
  const hiddenAuditCallIds = new Set<string>();
  let legacyAuditContinuation = false;
  let legacyHadPreAuditFinal = false;
  let hideLegacyPostAuditDuplicate = false;

  for (const message of messages) {
    if (message.internal) continue;
    if (isLegacyVerificationNudge(message)) {
      // Before verification nudges were internal, the no-tool answer that
      // triggered one was persisted as an ordinary visible message. Drop that
      // provisional answer and the lifecycle prompt, while retaining every
      // intervening verification tool call/result. Repeating nudges naturally
      // remove each successive premature answer.
      const previous = visible.at(-1);
      if (
        previous?.role === "assistant" &&
        previous.content.some((block) => block.t === "text" && block.text.trim()) &&
        !previous.content.some((block) => block.t === "tool_call")
      ) {
        visible.pop();
      }
      continue;
    }
    if (isLegacyAuditNudge(message)) {
      const previous = visible.at(-1);
      legacyHadPreAuditFinal = Boolean(
        previous?.role === "assistant" &&
        previous.content.some((block) => block.t === "text" && block.text.trim()) &&
        !previous.content.some((block) => block.t === "tool_call"),
      );
      legacyAuditContinuation = true;
      continue;
    }

    if (legacyAuditContinuation) {
      // A fresh human message after an interrupted old audit starts a normal
      // conversation turn; do not let an unfinished legacy marker hide the
      // rest of the session forever.
      const resumedByUser = message.role === "user" && message.content.some((block) => block.t === "text");
      if (resumedByUser) legacyAuditContinuation = false;
    }

    if (legacyAuditContinuation) {
      for (const block of message.content) {
        if (block.t === "tool_call" && block.name === "MemoryAudit") {
          hiddenAuditCallIds.add(block.id);
        }
        if (block.t === "tool_result" && hiddenAuditCallIds.has(block.id)) {
          hiddenAuditCallIds.delete(block.id);
          legacyAuditContinuation = false;
          hideLegacyPostAuditDuplicate = legacyHadPreAuditFinal;
          legacyHadPreAuditFinal = false;
        }
      }
      continue;
    }

    // Before the loop learned to reuse a pre-audit final, it asked the model
    // for another answer after the checkpoint. If a complete no-tool answer
    // immediately preceded the legacy nudge, keep that answer and drop the
    // redundant no-tool assistant message immediately after the audit.
    if (hideLegacyPostAuditDuplicate) {
      hideLegacyPostAuditDuplicate = false;
      if (message.role === "assistant" && !message.content.some((block) => block.t === "tool_call")) continue;
    }

    // A model may proactively submit MemoryAudit in the same assistant message
    // as its final answer. Hide only that lifecycle block, not the answer.
    const content = message.content.filter((block) => {
      if (block.t === "tool_call" && block.name === "MemoryAudit") {
        hiddenAuditCallIds.add(block.id);
        return false;
      }
      if (block.t === "tool_result" && hiddenAuditCallIds.has(block.id)) {
        hiddenAuditCallIds.delete(block.id);
        return false;
      }
      return true;
    });
    if (content.length) visible.push({ ...message, content, internal: undefined });
  }

  return visible;
}

// R5（#11）的出口配对修复搬到了 pairing.ts（Q3 的请求检查与它共用同一套判定）；这里照旧导出。
export { repairToolPairing };

// K1（#61）：按调用 id 在转录里找一次工具调用及其结果（Remember 核对 verified 记忆的证据用）。
export function findToolCall(messages: Msg[], id: string): { name: string; ok: boolean | null } | undefined {
  let name: string | undefined;
  let ok: boolean | null = null;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.t === "tool_call" && b.id === id) name = b.name;
      else if (b.t === "tool_result" && b.id === id) ok = b.ok;
    }
  }
  return name ? { name, ok } : undefined;
}

// The trailing assistant message's tool calls, when none of them got results — a
// mid-run snapshot persisted while those tools were in flight (the process died).
export function danglingToolCalls(messages: Msg[]): { id: string; name: string }[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return [];
  return last.content.flatMap((b) => (b.t === "tool_call" ? [{ id: b.id, name: b.name }] : []));
}

// R6（#32）：委派类工具看不出自己会不会改东西（Agent 的 coder、Workflow 的 agent() 都能写），一律按有副作用算。
export function mayHaveSideEffects(name: string, effect: string | undefined): boolean {
  return name === "Agent" || name === "Workflow" || effect !== "read";
}

const HEAL_READ_TEXT =
  "Not completed: the run stopped (the server was restarted or crashed) before this read-only call returned. " +
  "It had no side effects; re-run it if you still need the result.";
const HEAL_EFFECT_TEXT =
  "Interrupted, result unknown: the run stopped (the server was restarted or crashed) while this call was in flight, " +
  "so it may have partially or fully executed. Check the current state (git status, the files, services or remote " +
  "systems it touches) before doing anything; never blindly re-run a deploy, commit, migration, publish or send.";

export interface HealOptions {
  // Tool effect by name (the session's registry) — decides which of the two texts a call gets.
  effectOf?: (toolName: string) => string | undefined;
  // Workspace changes since the run's checkpoint (`git diff --stat`), attached to side-effect calls.
  diffstat?: string;
  // O1（#9）：按 Workflow 工具调用 id 找回它的运行 journal（完成了几个 agent、共开跑几个）。
  workflowRun?: (toolCallId: string) => { id: string; completed: number; started: number } | undefined;
}

// O1（#9）：跑了一半的 Workflow 不是「没执行」——完成的 agent 结果都在 journal 里，续跑只补剩下的。
function healWorkflowText(run: { id: string; completed: number; started: number }): string {
  return (
    `Interrupted: the server stopped while this Workflow was running (run ${run.id}). ${run.completed} of ` +
    `${run.started} agent calls had finished; their results are saved in the run's journal. To continue, call ` +
    `Workflow again with the same script and resumeFromRunId:"${run.id}" — finished calls are answered from the ` +
    "journal instantly and only the rest run. Do not start over from scratch."
  );
}

// A transcript can end with an assistant message whose tool_calls never got
// results — a mid-run snapshot persisted before the tools finished, then the
// process died. Providers reject that shape on the next request ("assistant with
// tool_calls must be followed by tool results"), so heal it with explicit
// failure results before continuing. Returns true when something was healed.
// R6（#32）：以前一律回填「Not executed … Re-issue the call」——副作用已经落盘时这是假话，会诱导模型
// 把 git commit / 发版 / 迁移再跑一遍。现在按工具 effect 分两种说法，副作用类附上次检查点以来的改动。
export function healDanglingToolCalls(messages: Msg[], opts: HealOptions = {}): boolean {
  const last = messages[messages.length - 1];
  const calls = danglingToolCalls(messages);
  if (!last || calls.length === 0) return false;
  const stat = opts.diffstat?.trim();
  messages.push({
    role: "user",
    ...(last.internal ? { internal: true } : {}),
    content: calls.map(({ id, name }): Block => {
      const effectful = mayHaveSideEffects(name, opts.effectOf?.(name));
      const run = name === "Workflow" ? opts.workflowRun?.(id) : undefined;
      const text = !effectful
        ? HEAL_READ_TEXT
        : (run ? healWorkflowText(run) : HEAL_EFFECT_TEXT) +
          (stat ? `\nWorkspace changes since this run's checkpoint (git diff --stat):\n${stat}` : "");
      return { t: "tool_result", id, ok: false, content: [{ t: "text", text }] };
    }),
  });
  return true;
}
