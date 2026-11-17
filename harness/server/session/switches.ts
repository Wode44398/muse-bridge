// 会话级开关：离开模式、运行档位、访问范围、型号与思考深度。
import { AgentState } from "../agent/state.ts";
import { isPermissionMode, type PermissionMode, type SessionAllow } from "../agent/permissions.ts";
import { accessLock, tenantMode } from "../tenant.ts";
import { BUFFER_TOKENS, compactionWindow, contextTokens } from "../agent/context.ts";
import { getConfig, resolveConfig, resolveKey, type RuntimeConfig } from "../config.ts";
import type { PersistedConfig } from "../store.ts";
import type { ThinkingLevel } from "../agent/turn.ts";
import { prefValue } from "../prefs.ts";
import { clampEffort, EFFORT_ORDER, modelSpec } from "../catalog.ts";
import { registry } from "./registry.ts";
import { buildState, initState, restoreFromRecord, sandboxAccessFor, wireSessionState } from "./build-state.ts";
import { fanout } from "./events.ts";
import { schedulePersist, sessionRecord } from "./persist.ts";
import type { Session } from "./types.ts";

// ── P3（#6）：离开模式 ─────────────────────────────────────────────────────────
// 正常会话里问答 / 权限 / 计划卡没有超时，人一走开这一轮就永久挂起、占着并发名额。用户知道自己什么时候
// 走——出门前在手机上点一下：会话级开关，与权限模式正交（不是第四档），默认关，随会话落盘并广播。开着时：
// 提问立即按「合理默认继续并写明假设」落定；规则判定为 ask 的调用立即拒绝并注明「未经批准」（安全偏向拒，
// 不全批）；计划保持未批准、本轮结束并留言。用户在这个会话发新消息或插话 = 人回来了，自动关。
export function isAway(session: Session): boolean {
  return session.cfg?.away === true;
}
// 离开模式下要批准的卡默认怎么落定（偏好 awayDecision；默认 deny）
export function awayApproves(): boolean {
  return prefValue<string>("awayDecision") === "approve";
}

export function setSessionAway(session: Session, raw: unknown): { ok: boolean; error?: string } {
  if (typeof raw !== "boolean") return { ok: false, error: "away must be true or false" };
  if (!session.cfg) return { ok: false, error: "the session has not started yet" };
  if (isAway(session) === raw) return { ok: true };
  session.cfg = { ...session.cfg, away: raw };
  fanout(session, { e: "away", away: raw });
  schedulePersist(session);
  return { ok: true };
}


// P1：「本会话都允许」写进会话配置并落盘（以前只在内存，会话闲置 30 分钟被淘汰就丢）。
export function applySessionAllow(session: Session, list: SessionAllow[]): void {
  if (session.cfg) session.cfg = { ...session.cfg, sessionAllow: [...list] };
  schedulePersist(session);
}

// P13（X18）：本会话放行的工作区外只读目录——写进会话配置并落盘，广播给附着的设备（档位菜单里列着、能删）
export function applyReadRoots(session: Session, list: string[]): void {
  if (session.cfg) session.cfg = { ...session.cfg, readRoots: [...list] };
  schedulePersist(session);
  fanout(session, { e: "read_roots", roots: [...list] });
}

// P13：撤掉本会话放行的一个只读目录（档位菜单里点 ×）
export function revokeReadRoot(session: Session, dir: string): string[] {
  if (!session.state) session.state = initState(session);
  session.state.revokeReadRoot(dir);
  return [...session.state.readRoots];
}


// 模式变更的单一落点：plan 批准、用户在输入框旁手动切档，都收敛到这里。
// 快照配置（重开会话不回退）+ 广播（所有附着设备的指示器同步）。
// C4（X12）：不再就地改写 system 的 plan 段（以前每切一次整个前缀缓存作废）——模型在下一次请求前收到一条 World State
// 片段：切进 plan 带上完整的 plan 契约，切出去明说「plan 段不再适用，动手」。权限判定每次调用现读模式，「拉手刹」照样当场生效。
export function applyModeChange(session: Session, mode: PermissionMode): void {
  if (session.cfg) session.cfg = { ...session.cfg, permissionMode: mode };
  // bypass 是整机 + 跳过密钥守卫的沙箱档：切进 / 切出时当场重算沙箱 access（每次 resolve 现读，下一步工具调用就按新边界判）。
  if (session.state) session.state.ctx.sandbox.access = sandboxAccessFor(session.cfg);
  fanout(session, { e: "mode", permissionMode: mode });
  schedulePersist(session);
}

// 会话内切档（POST /api/sessions/:id/mode）。运行中也允许：permissions.decide 每次
// 调用都读当前模式，所以切「只读」就是给正在跑的 agent 拉手刹；plan 契约（或它的作废）
// 在下一次请求前以 World State 片段送达（C4）。
export function setSessionMode(session: Session, mode: unknown): { ok: boolean; error?: string } {
  if (!isPermissionMode(mode)) return { ok: false, error: "invalid mode" };
  // bypass 是管理员专用的全权档：租户 / 成员实例不许切（否则成员可借它越过访问范围锁与密钥守卫）。
  if (mode === "bypass" && tenantMode()) return { ok: false, error: "bypass mode is not available on this server" };
  if (!session.state) return { ok: false, error: "session has not started" };
  // 幂等重挂：state 的三个来源（initState / hydrate / executeRun）都挂过这个回调，
  // 这里再确保一次 —— 切档必须落地，不能取决于这条 state 是从哪条路径来的。
  session.state.onModeChange = (m) => applyModeChange(session, m);
  // 同档=幂等 no-op（setPermissionMode 自己短路，不会重复广播）
  session.state.setPermissionMode(mode);
  return { ok: true };
}

// 会话内切访问范围（POST /api/sessions/:id/access）：仅工作空间 ↔ 整机。
// 以前只能在设置页改全局值、且只对新会话生效——用户为了让当前对话读一个工作空间
// 外的文件，得开设置→切档→保存→再开一条新对话。现在对【当前这条会话】当场生效：
// 沙箱 access 是每次 resolve 都读的活值，切完下一次工具调用就按新边界判；下一次请求前
// 追加一条「范围已变」片段让模型知道边界挪了（C4）；快照 cfg 一并改掉，重开会话不回退。
export function setSessionAccess(session: Session, access: unknown): { ok: boolean; error?: string } {
  if (access !== "workspace" && access !== "full") return { ok: false, error: "invalid access" };
  // 访问范围锁（租户模式恒 workspace，见 tenant.ts）：这台 dimensio 上不许切。
  const lock = accessLock();
  if (lock && access !== lock) return { ok: false, error: `access is locked to "${lock}" on this server` };
  // bypass 档期间沙箱恒为 "bypass"（整机 + 跳过密钥守卫）：下面记下用户的访问范围选择但不动沙箱，
  // 等切出 bypass 时（setSessionMode→applyModeChange）才按它恢复。
  const wantSandbox = sandboxAccessFor({ ...session.cfg, access });
  // 幂等：快照值没变、沙箱也已是目标值 = 无实际变化，不重复广播。
  const sandboxSame = !session.state || session.state.ctx.sandbox.access === wantSandbox;
  if (session.cfg?.access === access && sandboxSame) return { ok: true };
  if (session.cfg) session.cfg = { ...session.cfg, access };
  if (session.state) {
    // 其余档照常当场改判（C4：沙箱每次 resolve 都现读，边界即刻生效）。
    session.state.ctx.sandbox.access = wantSandbox;
  }
  fanout(session, { e: "access", access });
  schedulePersist(session);
  return { ok: true };
}

// 会话内换厂商 / 型号 / 思考深度（POST /api/sessions/:id/model）。以前输入框的型号菜单只写全局配置，已经开跑的会话照旧用
// 建会话时拍下的型号——菜单上勾着新型号、实际回答的还是旧的；换厂商更是直接开新对话。现在都在这条会话里换：转录是厂商中立的
// turn/block，各家适配器编码时把别家留下的东西（签名、思考、图片、工具调用 id……）收拾成自己认的样子（维护者 10-10：「一切换模型就开新对话了」）。
// 空闲时当场按新配置重建会话状态；运行中先记进快照配置，下一轮开跑前（startRun）再重建，这一轮不受影响。
export function setSessionModel(
  session: Session,
  raw: { provider?: unknown; model?: unknown; thinking?: unknown },
): { ok: boolean; error?: string; provider?: string; model?: string; thinking?: ThinkingLevel; pending?: boolean } {
  const cfg = session.cfg;
  if (!cfg || !session.state) return { ok: false, error: "session has not started" };
  if (registry.rollingBack === session.id || registry.rewinding.has(session.id)) return { ok: false, error: "a rollback is in progress — try again in a moment" };
  if (raw.provider !== undefined && typeof raw.provider !== "string") return { ok: false, error: "invalid provider" };
  if (raw.model !== undefined && typeof raw.model !== "string") return { ok: false, error: "invalid model" };
  if (raw.thinking !== undefined && !EFFORT_ORDER.includes(raw.thinking as ThinkingLevel)) return { ok: false, error: "invalid thinking level" };
  const provider = (raw.provider as string | undefined)?.trim() || cfg.provider;
  const crossing = provider !== cfg.provider;
  let next: PersistedConfig;
  if (crossing) {
    // 换家：与设置页切厂商同一套校验与联动（厂商存在且没被禁用、地址跟着换、没点名型号就用那家的默认型号与默认深度）
    let resolved: RuntimeConfig;
    try {
      resolved = resolveConfig({ ...getConfig(), provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl, thinking: cfg.thinking }, {
        provider: provider as RuntimeConfig["provider"],
        ...(raw.model !== undefined ? { model: (raw.model as string).trim() } : {}),
        ...(raw.thinking !== undefined ? { thinking: raw.thinking as ThinkingLevel } : {}),
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (!modelSpec(resolved.provider, resolved.model)) return { ok: false, error: `model "${resolved.model}" is not offered by provider "${provider}"` };
    if (!resolveKey(resolved.provider)) return { ok: false, error: `No API key for provider "${provider}". Set it in the Settings panel first.` };
    next = { ...cfg, provider: resolved.provider, model: resolved.model, baseUrl: resolved.baseUrl, thinking: resolved.thinking };
  } else {
    const model = raw.model === undefined ? cfg.model : (raw.model as string).trim();
    if (!model || !modelSpec(cfg.provider, model)) return { ok: false, error: `model "${model}" is not offered by this conversation's provider` };
    // 只换型号：沿用当前深度，按新型号的支持面收档（与设置页同一规则）
    next = { ...cfg, model, thinking: clampEffort(cfg.provider, model, (raw.thinking ?? cfg.thinking) as ThinkingLevel) };
  }
  const model = next.model;
  const thinking = next.thinking as ThinkingLevel;
  if (crossing || model !== cfg.model || thinking !== cfg.thinking) {
    session.cfg = next;
    if (session.running) {
      session.modelRebindPending = true;
      // 跑着的时候连换几次：「从谁换过来」记第一次换之前的那个
      session.modelRebindFrom ??= { provider: cfg.provider, model: cfg.model };
    } else {
      try {
        rebindModel(session, { provider: cfg.provider, model: cfg.model });
      } catch (e) {
        session.cfg = cfg;
        return { ok: false, error: (e as Error).message };
      }
    }
    fanout(session, { e: "model", provider: next.provider, model, thinking });
    schedulePersist(session);
  }
  return { ok: true, provider: next.provider, model, thinking, ...(session.running ? { pending: true } : {}) };
}

// system 里那句「You are running as …」跟着型号改——问它是什么模型时要答对。只改这一句，其余原样。
const MODEL_IDENTITY_RE = /You are running as the "[^"\n]*" model, served via the \S+ provider,/;
export function withModelIdentity(system: string, cfg: PersistedConfig): string {
  return system.replace(MODEL_IDENTITY_RE, () => `You are running as the "${cfg.model}" model, served via the ${cfg.provider} provider,`);
}

// 会话状态按快照配置里的型号 / 深度重建。走的是重启后恢复会话的同一条路（buildState + 记录回填）——适配器、子 agent 的
// 默认型号、输出上限、能不能看图……都在 buildState 里按型号定，逐个就地改容易漏。只在两轮之间做。
export function rebindModel(session: Session, from?: { provider: string; model: string }): void {
  const old = session.state;
  const cfg = session.cfg;
  if (!old || !cfg || session.running) return;
  const rec = sessionRecord(session);
  if (!rec) return;
  const state = buildState(cfg, withModelIdentity(rec.system, cfg), session.id, rec.world, session.mcp ?? null);
  restoreFromRecord(state, rec);
  // 读过的文件照旧算读过（同一个工作区、文件没动，换型号不该逼它把刚读的文件再读一遍）
  for (const [file, seen] of old.ctx.readFileState) state.ctx.readFileState.set(file, seen);
  if (from) noteModelSwitch(state, from, cfg);
  // 换到窗口更小的型号、现在的上下文它装不下：下一次（马上就会触发的）压缩，摘要交给换之前的型号写
  if (old.adapter.capabilities.contextWindow > state.adapter.capabilities.contextWindow && contextTokens(state) >= compactionWindow(state) - BUFFER_TOKENS) {
    state.switchSummarizer = old.switchSummarizer ?? old.adapter;
    state.switchSummarizerProfile = old.switchSummarizer ? old.switchSummarizerProfile : old.profile;
  }
  state.noteRewrite("model");
  wireSessionState(session, state);
  session.state = state;
  session.modelRebindPending = false;
  session.modelRebindFrom = undefined;
}

// 换了谁在答，在转录末尾留一条内部说明（界面不显示）。只改 system 的身份句不够：实测（10-10）MiMo 接手时照抄了前面
// Qwen 那句「我是 qwen3.7-plus」——前面的回答是别的模型写的，得明说。换了又换、中间没发消息：只留最后一条。
function noteModelSwitch(state: AgentState, from: { provider: string; model: string }, to: PersistedConfig): void {
  const tail = state.messages[state.messages.length - 1];
  if (tail?.kind === "model-switch") {
    state.messages.pop();
    // 上一条说明里的「从谁换过来」才是最后真正答过话的那个（A→B→A 中间没发消息 = 没换）
    const first = tail.content[0];
    const m = first?.t === "text" ? /from the "([^"]*)" model \((\S+) provider\)/.exec(first.text) : null;
    if (m) from = { model: m[1], provider: m[2] };
  }
  if (from.provider === to.provider && from.model === to.model) return;
  state.messages.push({
    role: "user",
    origin: "harness",
    kind: "model-switch",
    internal: true,
    content: [{
      t: "text",
      text: `[Model switched] The user switched this conversation from the "${from.model}" model (${from.provider} provider) to you: ` +
        `from here on you are the "${to.model}" model served via the ${to.provider} provider. Earlier assistant replies in this ` +
        "conversation were written by other models — they are not you, so never repeat their self-descriptions. Carry on with the work as usual.",
    }],
  });
}
