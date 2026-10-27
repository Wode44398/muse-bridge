// Q6（N47）：压缩召回 eval 的自检。真跑要本机模型出摘要（evals/compaction/run.ts，不进 npm test）；这里用脚本化的摘要器
// 证明这把尺子量得对：回放走的是生产压缩（summarize 收到的就是生产的 system）；锚点抽得准；「刚压进摘要」和「摘要又被
// 压了一次」分得开——会把旧事实忘掉的摘要器在 1 轮以上的桶里是 0，记得住的不是；drop 臂是下限；收据里没有会话内容。
import assert from "node:assert/strict";
import test from "node:test";
import { anchorsOf, normText } from "../evals/compaction/anchors.ts";
import { answerRecall, answerRecallWithRecovery, grepArchives, readArchive, RECOVERY_SYSTEM } from "../evals/compaction/answer.ts";
import { AGE_BUCKETS, emptySummarizer, replay, type ReplayResult, type Tally } from "../evals/compaction/replay.ts";
import { ratchets, report, rowOf } from "../evals/compaction/report.ts";
import { COMPACTION_SYSTEM } from "./agent/context.ts";
import type { StreamEvent } from "./agent/events.ts";
import type { Msg, Turn } from "./agent/turn.ts";
import { fakeSummary, scripted } from "./test-harness/scripted-adapter.ts";

const WINDOW = 32_768;

// ── 夹具：一段够长的合成会话 ─────────────────────────────────────────────────
const user = (text: string): Msg => ({ role: "user", content: [{ t: "text", text }] });
const say = (text: string): Msg => ({ role: "assistant", content: [{ t: "text", text }] });
const toolCall = (id: string, name: string, args: Record<string, unknown>): Msg => ({ role: "assistant", content: [{ t: "tool_call", id, name, args }] });
const result = (id: string, ok: boolean, text: string): Msg => ({ role: "user", content: [{ t: "tool_result", id, ok, content: [{ t: "text", text }] }] });
const sha = (i: number) => `c0ffee${i.toString(16).padStart(2, "0")}`;

// 每轮：Write 一个模块（正文在 tool_call 参数里——微压缩只清旧工具输出，清不掉它，于是真会走到整段压缩）、跑一次测试
// （每 3 轮失败一次，报一个这一轮独有的 TS 错误码；其余回一个提交哈希）；每 4 轮用户插一句话。锚点逐轮不同：同一个
// 错误码若也出现在原样保留的尾部，它就不算考题了。
function longSession(rounds: number): Msg[] {
  const msgs: Msg[] = [user("任务：把 mod 模块逐个重写，每写完一个都跑它的测试。")];
  for (let i = 0; i < rounds; i++) {
    const body = `export const v${i} = ${i};\n` + "// filler line that keeps this module a realistic size\n".repeat(50);
    msgs.push(toolCall(`w${i}`, "Write", { path: `C:\\work\\src\\mod${i}.ts`, content: body }));
    msgs.push(result(`w${i}`, true, `wrote ${body.length} chars`));
    msgs.push(toolCall(`b${i}`, "Bash", { command: `node --test test/mod${i}.test.js` }));
    msgs.push(i % 3 === 0 ? result(`b${i}`, false, `error TS${2300 + i}: Cannot find module './fixture${i}.json'`) : result(`b${i}`, true, `pass; committed ${sha(i)}`));
    if (i % 4 === 3) {
      msgs.push(say(`mod${i} 完成。`));
      msgs.push(user(`第 ${i} 轮之后：把 mod${i} 的导出也加进 index，文档第 ${i} 节同步改`));
    }
  }
  return msgs;
}

const textOf = (turn: Turn): string => turn.messages.map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join("")).join("\n");
const summaryEvents = (text: string): StreamEvent[] => [{ e: "text_delta", text }, { e: "turn_done", stopReason: "end" }];

// 只记得「这次中段里 Write 过的文件」的摘要器：上一轮摘要里提过的文件，它自己再压一次就忘了。
function forgetfulSummary(turn: Turn): StreamEvent[] {
  const files = [...textOf(turn).matchAll(/\[tool Write [^\n]*?(mod\d+\.ts)/g)].map((m) => `src/${m[1]}`);
  return summaryEvents(fakeSummary(`Files written: ${[...new Set(files)].join(", ")}`));
}

const total = (ts: Tally[]): Tally => ({ asked: ts.reduce((n, t) => n + t.asked, 0), recalled: ts.reduce((n, t) => n + t.recalled, 0) });
const olderBuckets = (r: ReplayResult): Tally => total(r.events.flatMap((e) => e.byAge.slice(1)));

// ── 锚点 ──────────────────────────────────────────────────────────────────────
test("Q6 压缩召回·锚点：改过的文件、错误码、哈希 / URL / UUID、用户原话；注入片段不算用户原话", () => {
  assert.equal(normText("C:\\\\work\\\\Src\\\\A.ts  and\n more"), "c:/work/src/a.ts and more");
  const needles = (m: Msg) => anchorsOf(m, 0).map((a) => `${a.kind}:${a.needle}`);
  assert.deepEqual(needles(toolCall("w", "Write", { path: "C:\\work\\src\\config.js", content: "x" })), ["file:src/config.js"]);
  assert.deepEqual(needles(toolCall("r", "Read", { path: "C:\\work\\src\\config.js" })), [], "只读不算改过");
  assert.deepEqual(
    needles(result("b", false, "TypeError: x is not a function\n  code ERR_MODULE_NOT_FOUND ENOENT")),
    ["error:enoent", "error:err_module_not_found"],
    "失败结果：errno 与 ERR_ 码优先、最多两个",
  );
  assert.deepEqual(needles(result("b", true, "TypeError: fine")), [], "成功的结果不出错误题");
  assert.deepEqual(
    needles(result("g", true, "commit 4c1fdeb, run 123e4567-e89b-12d3-a456-426614174000, see https://example.com/runs/7. total 1234567")),
    ["id:123e4567-e89b-12d3-a456-426614174000", "id:4c1fdeb", "id:https://example.com/runs/7"],
    "UUID 不被拆成哈希；纯数字不是哈希；URL 去掉句末标点",
  );
  assert.deepEqual(needles(user("把 client 的 timeout 改成 60，server 的别动")), ["user:把 client 的 timeout 改成 60，server 的别动"]);
  assert.deepEqual(needles(user("[Automated check] You have edited files without sufficient passing verification evidence.")), []);
  assert.deepEqual(needles(user("[用户在运行中插话] 以下是用户刚刚发来的消息。\n\n先别改 server，只动 client 那边")), ["user:先别改 server，只动 client 那边"]);
});

// ── 回放 ──────────────────────────────────────────────────────────────────────
test("Q6 压缩召回·回放走生产压缩：反复压缩、腾出比例与剩余量、按「被压过几轮」分桶", async (t) => {
  const session = longSession(60);
  const forgetful = scripted(t).always(forgetfulSummary);
  const r = await replay(session, { window: WINDOW, summarizer: forgetful, system: "sys" });

  assert.ok(r.events.length >= 3, `要反复压缩才量得出衰减：只压了 ${r.events.length} 次`);
  assert.equal(forgetful.callCount, r.events.length, "每次整段压缩调一次摘要器");
  assert.ok(forgetful.inputs.every((turn) => turn.system === COMPACTION_SYSTEM), "摘要请求就是生产的那一个");
  assert.equal(r.failures, 0);
  assert.equal(r.trigger, WINDOW - 13_000);
  for (const e of r.events) {
    assert.ok(e.freed > 0 && e.freed < 1 && e.floor > 0 && e.floor < 1, `腾出 ${e.freed}、剩 ${e.floor}`);
    const fresh = e.byAge[0];
    assert.ok(fresh.asked > 0 && fresh.recalled / fresh.asked >= 0.9, `刚压进去的几乎都找得回（${fresh.recalled}/${fresh.asked}）`);
  }
  // R10：用户原话与锚点索引从上一条摘要里接过来——摘要器自己健忘（只提这次中段里写过的文件），旧事实也不会蒸发
  const older = olderBuckets(r);
  assert.ok(older.asked > 0, "有被压过不止一轮的锚点");
  assert.ok(older.recalled / older.asked >= 0.5, `被压过不止一轮的仍大半找得回（${older.recalled}/${older.asked}）`);
  assert.equal(r.final.byKind.user.recalled, r.final.byKind.user.asked, "用户原话一条不丢");
  assert.ok(r.final.byKind.error.recalled > 0 && r.final.byKind.id.recalled > 0 && r.final.byKind.file.recalled > 0);

  // drop 臂只拿掉 LLM 笔记：用户原话与锚点索引照留，召回不再是 0——量的是 LLM 笔记本身多贡献了多少
  const drop = await replay(session, { window: WINDOW, summarizer: emptySummarizer(scripted(t)), system: "sys" });
  assert.ok(drop.events.length >= 3);
  assert.ok(total(drop.events.flatMap((e) => e.byAge)).recalled > 0);
  assert.equal(AGE_BUCKETS, 4);
});

test("Q6 压缩召回·答题臂：只看压缩后的上下文，每种锚点问一次，答案按字符串判分", async (t) => {
  const r = await replay(longSession(40), { window: WINDOW, summarizer: scripted(t).always(forgetfulSummary), system: "sys" });
  // 脚本化的答题者：把看到的上下文里的文件名照抄出来（锚点索引里是反斜杠路径，按归一化后的文本抄），别的一概答不上
  const answerer = scripted(t).always((turn) => summaryEvents([...new Set([...normText(textOf(turn)).matchAll(/src\/mod\d+\.ts/g)].map((m) => m[0]))].join("\n") || "unknown"));
  const answered = await answerRecall(answerer, r.final.context, r.final.questions);
  const kinds = Object.values(r.final.byKind).filter((k) => k.asked > 0).length;
  assert.equal(answerer.callCount, kinds, "每种有题的锚点问一次");
  assert.deepEqual(answered.file, r.final.byKind.file, "上下文里在的文件，照抄就答得上");
  assert.equal(answered.error.recalled + answered.id.recalled + answered.user.recalled, 0);
});

// ── 收据 ──────────────────────────────────────────────────────────────────────
test("Q6 压缩召回·收据只有数字：会话内容（路径、哈希、用户原话）不进仓库；棘轮判据", async (t) => {
  const session = longSession(60);
  const r = await replay(session, { window: WINDOW, summarizer: scripted(t).always(forgetfulSummary), system: "sys" });
  const d = await replay(session, { window: WINDOW, summarizer: emptySummarizer(scripted(t)), system: "sys" });
  const md = report([rowOf("0123456789abcdef", "current", 50_000, r), rowOf("0123456789abcdef", "drop", 50_000, d)], { title: "压缩召回 · 自检", note: "合成会话" });
  assert.match(md, /\| current \| 1 \|/);
  assert.match(md, /\| drop \| 1 \|/);
  assert.match(md, /0 轮 \| 1 轮 \| 2 轮 \| 3\+ 轮/);
  assert.match(md, /\| 01234567 \| current \|/, "会话只留 id 前 8 位");
  const leaked = session.flatMap((m, i) => anchorsOf(m, i)).filter((a) => md.includes(a.needle));
  assert.deepEqual(leaked.map((a) => a.needle), [], "收据里出现了会话内容");

  assert.equal(ratchets([0.8, 0.6, 0.4, 0.15]), true, "连降三次、最后不到 20%");
  assert.equal(ratchets([0.9, 0.5, 0.3]), false, "降了但还腾得出 30%");
  assert.equal(ratchets([0.6, 0.6, 0.6, 0.6]), false);
});

// ── R10（二）回查臂 ──────────────────────────────────────────────────────────
test("R10（二）压缩召回·回查臂：生产压缩写归档、摘要末尾列出；答题者 Grep 到原文再答；工具输出贴着生产的格式", async (t) => {
  const r = await replay(longSession(40), { window: WINDOW, summarizer: scripted(t).always(forgetfulSummary), system: "sys", archive: true });
  assert.ok(r.final.archives.size >= 1, "压过就有归档");
  const contextText = r.final.context.map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join("")).join("\n");
  assert.match(contextText, /## Context recovery[\s\S]*\n- \/archive\/compacted-1\.txt/);
  // 答题者：闭卷时只照抄上下文里的文件名；接着给了工具就 Grep 错误码，拿到工具结果后只回新找到的错误码
  const answerer = scripted(t).always((turn): StreamEvent[] => {
    if (!turn.tools.length && turn.messages.length === 1) {
      return summaryEvents([...new Set([...normText(textOf(turn)).matchAll(/src\/mod\d+\.ts/g)].map((m) => m[0]))].join("\n") || "unknown");
    }
    const results = turn.messages.at(-1)!.content.flatMap((b) => (b.t === "tool_result" ? b.content : []));
    if (!results.length) return [{ e: "tool_call", id: `g${turn.messages.length}`, name: "Grep", args: { pattern: "TS\\d{4}" } }, { e: "turn_done", stopReason: "tool_use" }];
    const found = results.map((b) => (b.t === "text" ? b.text : "")).join("\n");
    return summaryEvents([...new Set(found.match(/TS\d{4}/g) ?? [])].join("\n") || "nothing new");
  });
  const { byKind, closedByKind, lookups } = await answerRecallWithRecovery(answerer, r.final.context, r.final.questions, r.final.archives);
  const kinds = Object.values(r.final.byKind).filter((k) => k.asked > 0).length;
  assert.equal(lookups, kinds, "每问 Grep 一次");
  assert.equal(answerer.callCount, 3 * kinds, "每问：闭卷一次、Grep 一次、补答一次");
  assert.ok(answerer.inputs[0].tools.length === 0, "先闭卷");
  assert.ok(answerer.inputs[1].tools.some((d) => d.name === "Grep") && answerer.inputs[1].system === RECOVERY_SYSTEM);
  assert.ok(byKind.error.asked > 0);
  assert.equal(closedByKind.error.recalled, 0, "闭卷时错误码一个没答");
  assert.equal(byKind.error.recalled, byKind.error.asked, "错误码都在归档里，Grep 得到");
  assert.deepEqual(byKind.file, closedByKind.file, "计分取并集：闭卷答对的照算");
  assert.ok(closedByKind.file.recalled > 0);

  const archives = new Map([["/archive/compacted-1.txt", "# head\nerror TS2301: x\nlast"]]);
  assert.equal(grepArchives(archives, "ts23"), "/archive/compacted-1.txt:2: error TS2301: x", "不分大小写，路径:行号: 文本");
  assert.equal(grepArchives(archives, "("), "No matches.", "不是合法正则就按字面搜");
  assert.equal(readArchive(archives, "/archive/compacted-1.txt", 2, 1), "2\terror TS2301: x");
  assert.match(readArchive(archives, "/nope.txt"), /No such archive file/);
});
