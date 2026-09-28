// Q1（K45）：共享的脚本化 provider。以前 50 多个测试各自手写 `async *stream()`，靠 `turn++` 计数分支——
// 多调一次模型也照样绿（多出来的调用落进 else 分支），少调一次也没人发现。这里：
//   - 队列式：next(...) 按调用顺序排好每一次模型调用吐什么；每次调用记下输入的深拷贝（inputs）。
//   - 多调、少调都让【测试】失败：队列空了还被调就记账并抛错（抛错可能被 loop 的重试吞掉，所以不能只靠抛错），
//     测试收尾 assertDone() 统一核对；scripted(t) 会自动在 t.after 里调它。kimi 的同类 harness 两处都漏了。
//   - validate：每次调用先过一遍请求检查，默认就是 Q3 的请求不变量校验器（checkTurn），违反即记账，收尾判失败。
//     故意喂坏请求的测试显式传 validate: false。
// 例外情形要显式声明：always(step) 表示「之后每次都这样答」（用于故意中止的测试）。
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { StopReason, StreamEvent } from "../agent/events.ts";
import { checkTurn } from "../agent/turn-invariants.ts";
import type { Turn } from "../agent/turn.ts";
import type { Capabilities, ProviderAdapter, ProviderId } from "../providers/types.ts";

export type StepFn = (turn: Turn, call: number) => Iterable<StreamEvent> | AsyncIterable<StreamEvent>;
export type Step = readonly StreamEvent[] | { throws: string } | StepFn;

export const TEST_CAPABILITIES: Capabilities = {
  contextWindow: 100_000,
  maxOutputTokens: 1000,
  thinking: false,
  image: false,
  video: false,
  cache: false,
  parallelToolCalls: false,
};

// ── 常用的一步 ────────────────────────────────────────────────────────────────
// 压缩摘要的假回应：生产把短得离谱的摘要当成没写（#83，重试一次再按失败处理），假摘要要有真摘要的长度。
// 补上的套话里不含路径、哈希、错误码这类锚点，不影响压缩召回的判分。
export function fakeSummary(gist: string): string {
  return `${gist}\n\n${"Progress so far: the work recorded above was carried out step by step; continue from the most recent messages.\n".repeat(3)}`;
}

export function say(text: string, stopReason: StopReason = "end"): StreamEvent[] {
  return [{ e: "text_delta", text }, { e: "turn_done", stopReason }];
}

export type ToolCallEvent = Extract<StreamEvent, { e: "tool_call" }>;

export function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCallEvent {
  return { e: "tool_call", id, name, args };
}

// 一步里并发发出若干工具调用（以 tool_use 结束）。
export function calls(...toolCalls: StreamEvent[]): StreamEvent[] {
  return [...toolCalls, { e: "turn_done", stopReason: "tool_use" }];
}

export function useTool(id: string, name: string, args: Record<string, unknown> = {}): StreamEvent[] {
  return calls(call(id, name, args));
}

// loop 挂在 hints.onWire 上的前缀观察者（Q4）是函数，不是请求内容、也克隆不了：记输入时剥掉。脚本化 provider
// 不编码请求，所以不会调它——要测前缀判定，用 wire-fakes.ts 在 fetch 层假扮 provider、走真 adapter。
function requestOf(turn: Turn): Turn {
  if (!turn.hints?.onWire) return turn;
  const { onWire: _observer, ...hints } = turn.hints;
  const { hints: _all, ...rest } = turn;
  return Object.keys(hints).length ? { ...rest, hints } : rest;
}

export interface ScriptedOptions {
  id?: ProviderId;
  model?: string;
  capabilities?: Partial<Capabilities>;
  // 每次调用的请求检查：返回违反项（空数组 = 合规）。默认 checkTurn；false = 不查。
  validate?: ((turn: Turn) => string[]) | false;
}

export class ScriptedAdapter implements ProviderAdapter {
  id: ProviderId;
  model: string;
  capabilities: Capabilities;
  readonly inputs: Turn[] = [];
  // 每次调用收到的 AbortSignal（按调用顺序；调用方没传就是 undefined）——测「停止管不管得到这次请求」用
  readonly signals: (AbortSignal | undefined)[] = [];
  // 轨迹记录器挂在这里（trajectory.ts）：每次模型调用时回调一次。
  onCall?: (call: number, turn: Turn) => void;
  private readonly queue: Step[] = [];
  private fallback: Step | null = null;
  private readonly unexpected: number[] = [];
  private readonly violations: string[] = [];
  private readonly validate?: (turn: Turn) => string[];

  constructor(opts: ScriptedOptions = {}) {
    this.id = opts.id ?? "openai";
    this.model = opts.model ?? "fake";
    this.capabilities = { ...TEST_CAPABILITIES, ...opts.capabilities };
    this.validate = opts.validate === false ? undefined : (opts.validate ?? checkTurn);
  }

  next(...steps: Step[]): this {
    this.queue.push(...steps);
    return this;
  }

  // 队列用完之后每次都这样答（显式声明「之后一直这样」，不算多调）。
  always(step: Step): this {
    this.fallback = step;
    return this;
  }

  get callCount(): number {
    return this.inputs.length;
  }

  get remaining(): number {
    return this.queue.length;
  }

  lastInput(): Turn {
    assert.ok(this.inputs.length > 0, "ScriptedAdapter：模型一次都没被调用");
    return this.inputs[this.inputs.length - 1];
  }

  async *stream(turn: Turn, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const input = structuredClone(requestOf(turn));
    const n = this.inputs.push(input);
    this.signals.push(signal);
    if (this.validate) {
      for (const v of this.validate(input)) this.violations.push(`第 ${n} 次调用：${v}`);
    }
    this.onCall?.(n, input);
    const step = this.queue.shift() ?? this.fallback;
    if (!step) {
      this.unexpected.push(n);
      throw new Error(`ScriptedAdapter: unexpected model call #${n} — the script has no more steps`);
    }
    if (typeof step === "function") {
      yield* step(input, n);
      return;
    }
    if ("throws" in step) throw new Error(step.throws);
    for (const ev of step) yield structuredClone(ev);
  }

  // 测试收尾：多调、少调、请求检查不过，任何一样都判失败。
  assertDone(): void {
    const problems: string[] = [];
    if (this.unexpected.length) problems.push(`多调了模型：第 ${this.unexpected.join("、")} 次调用时脚本已经用完`);
    if (this.queue.length) problems.push(`少调了模型：还有 ${this.queue.length} 步脚本没用上（一共调了 ${this.inputs.length} 次）`);
    if (this.violations.length) problems.push(`请求检查不过：\n  ${this.violations.join("\n  ")}`);
    if (problems.length) assert.fail(`ScriptedAdapter：\n${problems.join("\n")}`);
  }
}

// 常用入口：建一个脚本化 provider，并在测试收尾自动 assertDone()。
export function scripted(t: TestContext, opts: ScriptedOptions = {}): ScriptedAdapter {
  const adapter = new ScriptedAdapter(opts);
  t.after(() => adapter.assertDone());
  return adapter;
}
