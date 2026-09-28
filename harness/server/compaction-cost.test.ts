// R11：按成本压缩 + 微压缩滞回。1M 窗口不等于该用满——窗口 ≥ 512K 的模型默认在 256K 压，目录可按型号配 compactAt；
// 上下文条的上限报压缩窗口（满格 = 要压了）。微压缩一次腾不出 4K token 就不改写前缀，直接整段压缩换一段长跑道。
import assert from "node:assert/strict";
import test from "node:test";
import { BUFFER_TOKENS, ensureContextFits, estimateTokens } from "./agent/context.ts";
import type { Msg } from "./agent/turn.ts";
import { modelLimits } from "./catalog.ts";
import { createAdapter } from "./providers/registry.ts";
import { fakeSummary, say, scripted } from "./test-harness/scripted-adapter.ts";
import { loopState } from "./test-harness/trajectory.ts";

const user = (text: string): Msg => ({ role: "user", content: [{ t: "text", text }] });
const reply = (text: string): Msg => ({ role: "assistant", content: [{ t: "text", text }] });
const call = (id: string): Msg => ({ role: "assistant", content: [{ t: "tool_call", id, name: "Bash", args: { command: `run ${id}` } }] });
const result = (id: string, chars: number): Msg => ({ role: "user", content: [{ t: "tool_result", id, ok: true, content: [{ t: "text", text: "o".repeat(chars) }] }] });
const ELIDED = /old tool output elided/;
const hasElided = (msgs: Msg[]) => JSON.stringify(msgs).match(ELIDED) !== null;
const hasSummary = (msgs: Msg[]) => JSON.stringify(msgs).includes("[Earlier context summary]");

// 纯文本历史（微压缩腾不出地方）：n 轮问答，每条回答约 1000 token
const textHistory = (n: number): Msg[] => [user("task"), ...Array.from({ length: n }, (_, i) => [user(`q${i}`), reply("r".repeat(4_000))]).flat()];

// summarizes：预期要几次摘要（脚本化适配器收尾时核对脚本都用完了）
function costState(t: test.TestContext, capabilities: { contextWindow: number; compactAt?: number }, messages: Msg[], summarizes = 1) {
  const adapter = scripted(t, { capabilities }).next(...Array.from({ length: summarizes }, () => say(fakeSummary("notes"))));
  const { state } = loopState(t, adapter, { memoryAudit: false });
  state.messages = messages;
  return { adapter, state };
}

test("R11 窗口 ≥ 512K 的模型默认在 256K 就压，上下文条的上限报压缩窗口；512K 以下的模型照旧按窗口压", async (t) => {
  const history = textHistory(300); // 约 30 万 token
  assert.ok(estimateTokens("", history) > 280_000 && estimateTokens("", history) < 380_000);

  const big = costState(t, { contextWindow: 1_000_000 }, structuredClone(history));
  const fit = await ensureContextFits(big.state);
  assert.equal(fit.compacted, true, "1M 窗口、30 万 token：该压了");
  assert.equal(big.adapter.callCount, 1);
  assert.equal(fit.limit, 256_000 + BUFFER_TOKENS, "报给前端的上限是压缩窗口");
  assert.ok(fit.used < 256_000 * 0.6, `压完 ${fit.used}：尾部按压缩窗口的 40% 留，不是按 1M 的`);

  const mid = costState(t, { contextWindow: 400_000 }, structuredClone(history), 0);
  const midFit = await ensureContextFits(mid.state);
  assert.equal(midFit.compacted, false, "400K 窗口（不到 512K）：离窗口还远，不压");
  assert.equal(mid.adapter.callCount, 0);
  assert.equal(midFit.limit, 400_000);
});

test("R11 目录里按型号配的 compactAt 优先于默认值", async (t) => {
  const history = textHistory(80); // 约 8 万 token
  const { adapter, state } = costState(t, { contextWindow: 1_000_000, compactAt: 60_000 }, history);
  const fit = await ensureContextFits(state);
  assert.equal(fit.compacted, true);
  assert.equal(adapter.callCount, 1);
  assert.equal(fit.limit, 60_000 + BUFFER_TOKENS);
  // 目录字段真的接到了适配器的能力上
  assert.equal(modelLimits("anthropic", "claude-opus-5-5").ctx, 1_000_000);
  const adapterCaps = createAdapter({ provider: "anthropic", apiKey: "FAKE-KEY-FOR-TEST", model: "claude-opus-5-5" }).capabilities;
  assert.equal(adapterCaps.compactAt, modelLimits("anthropic", "claude-opus-5-5").compactAt);
});

// 三条旧工具输出 + 一段问答把用量推过触发线（窗口 4 万、触发线 2.7 万：尾部 1.6 万，切得出中段）
function microState(t: test.TestContext, outputChars: number, pairs: number, summarizes: number, contextWindow = 40_000) {
  const messages: Msg[] = [user("task"), reply("ok")];
  for (const id of ["a", "b", "c"]) messages.push(call(id), result(id, outputChars));
  for (let i = 0; i < pairs; i++) messages.push(user(`q${i}`), reply("r".repeat(1_200)));
  return costState(t, { contextWindow }, messages, summarizes);
}

test("R11 微压缩滞回：一次腾不出 4K token 就不改写旧工具输出，直接整段压缩", async (t) => {
  // 三条各约 800 token 的旧输出：微压缩只腾得出约 2.3K（以前这就够回到线下，然后下一轮又贴线、又改写一次）
  const { adapter, state } = microState(t, 3_200, 84, 1);
  const before = estimateTokens(state.system, state.messages);
  assert.ok(before > 40_000 - BUFFER_TOKENS && before - 2_400 < 40_000 - BUFFER_TOKENS, "开局就在触发线上，微压缩那 2K 也够回到线下");
  const fit = await ensureContextFits(state);
  assert.equal(fit.compacted, true);
  assert.equal(adapter.callCount, 1, "走了整段压缩（要了一次摘要）");
  assert.ok(hasSummary(state.messages));
  assert.equal(hasElided(state.messages), false, "没有做那次只腾 2K 的微压缩");
});

test("R11 微压缩腾得出 4K token 以上就照常只微压缩，不要摘要", async (t) => {
  const { adapter, state } = microState(t, 8_000, 72, 0);
  assert.ok(estimateTokens(state.system, state.messages) > 40_000 - BUFFER_TOKENS);
  const fit = await ensureContextFits(state);
  assert.equal(fit.compacted, true);
  assert.equal(adapter.callCount, 0, "没要摘要");
  assert.ok(hasElided(state.messages));
  assert.equal(hasSummary(state.messages), false);
  assert.ok(fit.used < 40_000 - BUFFER_TOKENS);
});

test("R11 兜底：整段压缩这次做不成（熔断了 / 切不出中段），腾得不多的微压缩也照做", async (t) => {
  const fused = microState(t, 3_200, 84, 0);
  fused.state.compactionFailures = 3;
  const fit = await ensureContextFits(fused.state);
  assert.equal(fit.compacted, true);
  assert.equal(fused.adapter.callCount, 0, "熔断了：不要摘要");
  assert.ok(hasElided(fused.state.messages), "小额微压缩照做");

  // 窗口 2 万：尾部（8000）把头之后的全部吞下，整段压缩切不出中段
  const tiny = microState(t, 3_200, 16, 0, 20_000);
  const tinyFit = await ensureContextFits(tiny.state);
  assert.equal(tinyFit.compacted, true);
  assert.equal(tiny.adapter.callCount, 0);
  assert.ok(hasElided(tiny.state.messages));
  assert.equal(tiny.state.compactionFailures, 1, "整段压缩那次记一次失败");
});
