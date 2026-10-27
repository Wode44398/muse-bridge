// Q6（N47）：压缩召回 eval。不进 npm test——要真模型出摘要、答题。
//
//   node evals/compaction/run.ts --sessions <会话目录> --topic <主题> [--model local/qwen3.8-27b] [--window 32768]
//                                [--arms current,drop] [--no-answer] [--limit 20]
//
// 会话先整份复制进临时目录再读（不在原地读，跑完删掉）。已经在现实里压缩过的会话跳过（原来的中段已经不在记录里了），
// 按这个窗口压不起来的短会话跳过。每个会话每个臂回放一遍（replay.ts，生产压缩代码），可选再答题（answer.ts）。
// 臂：current = 生产摘要；drop = 同样切分、摘要为空（下限，量摘要贡献了多少）。改压缩（R10）时在改前 / 改后两棵
// 工作树各跑一次，对照两张收据。收据写进 evals/compaction/results/<日期>-<主题>.md，只有数字。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUFFER_TOKENS, estimateTokens } from "../../server/agent/context.ts";
import { injectionKind } from "../../server/agent/injections.ts";
import type { Msg } from "../../server/agent/turn.ts";
import { providerBaseUrl } from "../../server/catalog.ts";
import { initOutboundProxy } from "../../server/net-proxy.ts";
import { createAdapter } from "../../server/providers/registry.ts";
import type { ProviderId } from "../../server/providers/types.ts";
import { answerRecall, answerRecallWithRecovery } from "./answer.ts";
import type { AnchorKind } from "./anchors.ts";
import { emptySummarizer, replay, type Tally } from "./replay.ts";
import { report, rowOf, type SessionRow } from "./report.ts";

const argv = process.argv.slice(2);
const opt = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const src = opt("sessions");
const topic = opt("topic");
if (!src || !topic) {
  console.error("用法：node evals/compaction/run.ts --sessions <会话目录> --topic <主题> [--model local/qwen3.8-27b] [--window 32768] [--arms current,drop] [--no-answer] [--limit 20]");
  process.exit(2);
}
const [providerId, ...modelParts] = opt("model", "local/qwen3.8-27b")!.split("/");
const provider = providerId as ProviderId;
const model = modelParts.join("/");
const window = Number(opt("window", "32768"));
const arms = opt("arms", "current,drop")!.split(",").map((a) => a.trim());
const answer = !argv.includes("--no-answer");
const limit = Number(opt("limit", "0")) || Infinity;
const date = new Date().toISOString().slice(0, 10);
const trigger = window - BUFFER_TOKENS;
if (trigger <= window * 0.4) {
  console.error(`窗口 ${window} 太小：触发线（窗口 − ${BUFFER_TOKENS}）必须高于尾部预算（窗口的 40%），否则压完就是空中段`);
  process.exit(2);
}

const KEY_ENV: Partial<Record<ProviderId, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  qwen: "QWEN_API_KEY",
  zhipu: "ZHIPU_API_KEY",
  kimi: "KIMI_API_KEY",
  mimo: "MIMO_API_KEY",
  gemini: "GEMINI_API_KEY",
};
const apiKey = provider === "local" ? process.env.LOCAL_API_KEY || "local" : process.env[KEY_ENV[provider] ?? ""] ?? "";
if (!apiKey) {
  console.error(`${provider} 没有 key：在环境变量 ${KEY_ENV[provider]} 里给`);
  process.exit(2);
}
if (provider !== "local") await initOutboundProxy(); // 云端要走本机代理；本机模型直连
const adapter = createAdapter({ provider, model, apiKey, baseUrl: providerBaseUrl(provider) });

const isCompacted = (messages: Msg[]) => messages.some((m) => m.content.some((b) => b.t === "text" && injectionKind(b.text) === "compaction-summary"));

const work = fs.mkdtempSync(path.join(os.tmpdir(), `dimensio-compaction-${date}-`));
const rows: SessionRow[] = [];
const skipped = { compacted: 0, short: 0, unreadable: 0 };
try {
  const files = fs.readdirSync(src).filter((f) => f.endsWith(".json") && fs.statSync(path.join(src, f)).isFile());
  for (const f of files) fs.copyFileSync(path.join(src, f), path.join(work, f));
  // 长的先跑：--limit 截的是最长的那几个
  const ordered = files.map((f) => ({ f, size: fs.statSync(path.join(work, f)).size })).sort((a, b) => b.size - a.size);
  let used = 0;
  for (const { f } of ordered) {
    if (used >= limit) break;
    let rec: { id?: string; system?: string; messages?: Msg[] };
    try {
      rec = JSON.parse(fs.readFileSync(path.join(work, f), "utf8"));
    } catch {
      skipped.unreadable++;
      continue;
    }
    if (!Array.isArray(rec.messages)) {
      skipped.unreadable++;
      continue;
    }
    if (isCompacted(rec.messages)) {
      skipped.compacted++;
      continue;
    }
    const tokens = estimateTokens(rec.system ?? "", rec.messages);
    if (tokens < trigger) {
      skipped.short++;
      continue;
    }
    used++;
    const id = rec.id ?? path.basename(f, ".json");
    for (const arm of arms) {
      const started = Date.now();
      const summarizer = arm === "drop" ? emptySummarizer(adapter) : adapter;
      // R10（二）recovery 臂 = 生产压缩 + 归档（摘要末尾列出），答题时模型可以 Grep / Read 归档
      const recovery = arm === "recovery";
      const result = await replay(rec.messages, { window, summarizer, system: rec.system, archive: recovery });
      let answered: Record<AnchorKind, Tally> | undefined;
      let closed: Record<AnchorKind, Tally> | undefined;
      let lookups: number | undefined;
      if (answer && recovery) {
        ({ byKind: answered, closedByKind: closed, lookups } = await answerRecallWithRecovery(adapter, result.final.context, result.final.questions, result.final.archives));
      } else if (answer) answered = await answerRecall(adapter, result.final.context, result.final.questions);
      const row = rowOf(id, arm, tokens, result, answered, lookups, closed);
      rows.push(row);
      console.log(`  ${row.session} · ${arm}：${row.compactions} 次压缩，${Math.round((Date.now() - started) / 1000)}s`);
    }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
}

const resultFile = path.join(import.meta.dirname, "results", `${date}-${topic}.md`);
fs.mkdirSync(path.dirname(resultFile), { recursive: true });
fs.writeFileSync(
  resultFile,
  report(rows, {
    title: `压缩召回 · ${topic}（${date}）`,
    note:
      `模型 ${provider}/${model}；模拟窗口 ${window}（触发线 ${trigger}）；臂 ${arms.join("、")}；答题${answer ? "开" : "关"}。\n` +
      `语料 ${rows.length / Math.max(arms.length, 1)} 个会话；跳过：现实里压缩过 ${skipped.compacted}、按这个窗口压不起来 ${skipped.short}、读不了 ${skipped.unreadable}。`,
  }),
);
console.log(`收据：${resultFile}`);
process.exit(0); // 云端代理的自愈定时器不必等
