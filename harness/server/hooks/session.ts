// 一个会话的 hooks：建会话状态时按工作区读一次配置定下来（会话里改了 settings 不生效，下一个会话 / 重新载入才认——
// 模型就算被批准写了配置，也没法在同一个会话里装上再触发）。没有任何 hook 时不建这个对象，调用点什么都不做。
//
// 项目级 hooks 要用户对这个工作区确认过才执行（trust.ts）；用户级的直接生效。子 agent 用 forSubagent() 拿一份共享同一份
// 配置与信任状态的视图，收尾事件报 SubagentStop。
import path from "node:path";
import { sessionsDir } from "../paths.ts";
import { traceEvent } from "../trace-log.ts";
import { type HookCommand, type HookConfig, type HookEvent, loadHookConfig, matcherHits } from "./config.ts";
import { runHookCommand } from "./exec.ts";
import { type HookOutcome, interpretRun, mergeVerdicts } from "./protocol.ts";
import { refsDigest } from "./script-refs.ts";
import { projectHooksTrusted } from "./trust.ts";

export type ProjectTrust = "none" | "trusted" | "pending" | "declined";

interface Shared {
  config: HookConfig;
  workspace: string;
  sessionId?: string;
  trust: ProjectTrust;
  // 这个会话的 SessionStart 发过没有（会话状态重建——重启恢复、换型号——之后再发一次，source 记 resume）
  started: boolean;
  // 点名的脚本在读配置之后被改过的项目级命令：这个会话里不再跑
  stale: Set<HookCommand>;
}

// Claude Code 的 permission_mode 取值
const MODE_NAMES: Record<string, string> = { auto: "default", "read-only": "default", plan: "plan", bypass: "bypassPermissions" };

export class SessionHooks {
  private readonly shared: Shared;
  readonly subagent: boolean;

  private constructor(shared: Shared, subagent: boolean) {
    this.shared = shared;
    this.subagent = subagent;
  }

  static load(workspace: string, sessionId?: string): SessionHooks | undefined {
    const config = loadHookConfig(workspace);
    if (!config) return undefined;
    const trust: ProjectTrust = !config.projectHash ? "none" : projectHooksTrusted(workspace, config.projectHash) ? "trusted" : "pending";
    return new SessionHooks({ config, workspace: path.resolve(workspace), sessionId, trust, started: false, stale: new Set() }, false);
  }

  forSubagent(): SessionHooks {
    return new SessionHooks(this.shared, true);
  }

  get workspace(): string {
    return this.shared.workspace;
  }
  get trust(): ProjectTrust {
    return this.shared.trust;
  }
  get projectHash(): string | null {
    return this.shared.config.projectHash;
  }
  // 等着用户确认的项目级 hooks（确认卡上逐条列出）
  projectHooks(): HookCommand[] {
    return this.shared.config.hooks.filter((h) => h.scope === "project");
  }
  setTrust(trust: "trusted" | "declined"): void {
    this.shared.trust = trust;
  }
  takeSessionStart(): boolean {
    if (this.shared.started) return false;
    this.shared.started = true;
    return true;
  }

  // 此刻会执行的命令：用户级照常，项目级要已信任；matcher 只对带主体的事件（工具名、SessionStart 的 source、PreCompact 的 trigger）有意义
  private commands(event: HookEvent, subject?: string): HookCommand[] {
    const seen = new Set<string>();
    const out: HookCommand[] = [];
    for (const h of this.shared.config.hooks) {
      if (h.event !== event) continue;
      if (h.scope === "project" && this.shared.trust !== "trusted") continue;
      if (subject !== undefined && !matcherHits(h.matcher, subject)) continue;
      if (seen.has(h.command)) continue; // 同一条命令配在几处只跑一次
      seen.add(h.command);
      out.push(h);
    }
    return out;
  }

  // 项目级命令点名的脚本还是用户确认时（读配置时）的内容吗：改过就不跑，记一行（下个会话按新指纹重新确认）
  private scriptsUnchanged(h: HookCommand): boolean {
    if (!h.refs?.length) return true;
    if (this.shared.stale.has(h)) return false;
    if (refsDigest(h.refs) === h.refsDigest) return true;
    this.shared.stale.add(h);
    console.warn(`[hooks] ${h.event} 的项目级 hook 要跑的文件在会话开始后被改过（${h.refs.join("、")}），这个会话里不再执行它；新会话会重新请你确认`);
    return false;
  }

  has(event: HookEvent, subject?: string): boolean {
    return this.commands(event, subject).length > 0;
  }

  // 跑这个事件命中的全部命令（并行），合并结论；一条都没命中返回 null
  async run(
    event: HookEvent,
    fields: Record<string, unknown>,
    opts: { subject?: string; signal?: AbortSignal; permissionMode?: string } = {},
  ): Promise<HookOutcome | null> {
    const cmds = this.commands(event, opts.subject).filter((h) => this.scriptsUnchanged(h));
    if (!cmds.length) return null;
    const { sessionId, workspace } = this.shared;
    const input = JSON.stringify({
      session_id: sessionId ?? "",
      transcript_path: sessionId ? path.join(sessionsDir(), `${sessionId}.json`) : "",
      cwd: workspace,
      hook_event_name: event,
      permission_mode: MODE_NAMES[opts.permissionMode ?? "auto"] ?? "default",
      ...fields,
    });
    const started = Date.now();
    const runs = await Promise.all(
      cmds.map(async (h) => {
        const run = await runHookCommand(h.command, input, { cwd: workspace, timeoutMs: h.timeoutS * 1000, signal: opts.signal });
        return interpretRun(event, run, h.command);
      }),
    );
    const outcome = mergeVerdicts(runs);
    for (const w of outcome.warnings) console.warn(`[hooks] ${w}`);
    if (sessionId) {
      traceEvent(sessionId, {
        e: "hook",
        event,
        ...(opts.subject ? { subject: opts.subject } : {}),
        commands: cmds.length,
        ms: Date.now() - started,
        ...(outcome.block ? { blocked: true } : {}),
        ...(outcome.permission ? { permission: outcome.permission } : {}),
        ...(outcome.warnings.length ? { warnings: outcome.warnings.length } : {}),
      });
    }
    return outcome;
  }
}
