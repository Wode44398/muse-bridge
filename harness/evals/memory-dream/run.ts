// 离线记忆整理 eval：在正式服记忆与会话的【副本】上跑一遍 dreamWorkspace，看它对积压的条目做了什么。不进 npm test——要真模型。
//
//   node evals/memory-dream/run.ts --memory <记忆目录> --sessions <会话目录> --model <厂商>/<型号> --topic <主题>
//                                  [--config <runtime-config.json>] [--limit <工作区数>] [--keep]
//
// 记忆目录整份、会话目录顶层的 *.json 先复制进临时目录（不在原地读写，--keep 才留下，给人逐条看、给预览实例当数据）。
// 收据写进 evals/memory-dream/results/<日期>-<主题>.md，只有计数（工作区用序号，不写名字、不写条目标题与正文）；
// 逐条的前后状态与复核意见写在临时目录的 detail.json 里，不进仓库。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const memSrc = opt("memory");
const sesSrc = opt("sessions");
const topic = opt("topic");
const modelArg = opt("model");
if (!memSrc || !sesSrc || !topic || !modelArg) {
  console.error("用法：node evals/memory-dream/run.ts --memory <记忆目录> --sessions <会话目录> --model <厂商>/<型号> --topic <主题> [--config <runtime-config.json>] [--limit N] [--keep]");
  process.exit(2);
}
const limit = Number(opt("limit", "0")) || Infinity;
const keep = argv.includes("--keep");
// 收据按本机日期命名（与人记的日子一致）
const now = new Date();
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

// 先改道全部数据位置，再 import 服务端模块
const work = fs.mkdtempSync(path.join(os.tmpdir(), `dimensio-dream-${date}-`));
const at = (p: string) => path.join(work, p);
fs.cpSync(memSrc, at("memory"), { recursive: true });
fs.mkdirSync(at("sessions"));
for (const f of fs.readdirSync(sesSrc)) {
  if (f.endsWith(".json") && fs.statSync(path.join(sesSrc, f)).isFile()) fs.copyFileSync(path.join(sesSrc, f), path.join(at("sessions"), f));
}
const cfgSrc = opt("config");
if (cfgSrc && fs.existsSync(cfgSrc)) fs.copyFileSync(cfgSrc, at("runtime-config.json"));
Object.assign(process.env, {
  MEMORY_DIR: at("memory"),
  SESSIONS_DIR: at("sessions"),
  KNOWLEDGE_DIR: at("knowledge"),
  DIMENSIO_CONFIG_FILE: at("runtime-config.json"),
  DIMENSIO_MEMORY_DREAM: "0",
});

const { listMemories } = await import("../../server/memory.ts");
const { dreamCandidates, dreamWorkspace } = await import("../../server/memory-dream.ts");
const { listSessions } = await import("../../server/store.ts");
const { getConfig } = await import("../../server/config.ts");
const { providerBaseUrl } = await import("../../server/catalog.ts");
const { initOutboundProxy } = await import("../../server/net-proxy.ts");
const { customKeysReady, customProviderKey, isCustomProviderId } = await import("../../server/custom-providers.ts");
const { createAdapter } = await import("../../server/providers/registry.ts");
type ProviderId = import("../../server/providers/types.ts").ProviderId;

const [providerId, ...modelParts] = modelArg.split("/");
const provider = providerId as ProviderId;
const model = modelParts.join("/");
const custom = isCustomProviderId(provider);
if (custom) await customKeysReady;
const KEY_ENV: Partial<Record<string, string>> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", kimi: "KIMI_API_KEY", mimo: "MIMO_API_KEY", gemini: "GEMINI_API_KEY", qwen: "QWEN_API_KEY" };
const apiKey = custom ? customProviderKey(provider) ?? "" : provider === "local" ? process.env.LOCAL_API_KEY || "local" : process.env[KEY_ENV[provider] ?? ""] ?? "";
if (!apiKey) {
  console.error(custom ? `${provider} 不在自定义服务目录里，或解不开它的 key（DIMENSIO_CUSTOM_PROVIDERS_DIR 指到正式服那份的副本）` : `${provider} 没有 key：在环境变量 ${KEY_ENV[provider]} 里给`);
  process.exit(2);
}
if (provider !== "local") await initOutboundProxy();
const adapter = createAdapter({ provider, model, apiKey, baseUrl: providerBaseUrl(provider) });

// 要整理的工作区：会话里出现过的（新的在前），有待复核的条目、或最近一周至少两个会话
const seen = new Set<string>();
const workspaces: string[] = [];
for (const m of (await listSessions()).sort((a, b) => b.updatedAt - a.updatedAt)) {
  const ws = path.resolve(m.workspace || getConfig().workspace);
  const key = ws.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  workspaces.push(ws);
}

type Snap = Record<string, { status: string; declared: string; confidence: string; verdict?: string; note?: string; origin?: string }>;
const snap = (ws: string): Snap => {
  if (!fs.existsSync(ws)) return {};
  return Object.fromEntries(
    listMemories(ws).map((m) => [m.id, { status: m.status, declared: m.declaredStatus, confidence: m.confidence, verdict: m.reviewVerdict, note: m.reviewNote, origin: m.origin }]),
  );
};

const rows: Array<{ n: number; notes: number; candidates: number; s: Awaited<ReturnType<typeof dreamWorkspace>> }> = [];
const detail: Array<{ ws: string; before: Snap; after: Snap; summary: unknown }> = [];
let n = 0;
for (const ws of workspaces) {
  if (rows.length >= limit) break;
  n++;
  const before = snap(ws);
  const candidates = dreamCandidates(ws).batches.flat().length;
  const started = Date.now();
  const s = await dreamWorkspace(ws, { adapter, trigger: "manual" });
  if (!s.reviewed && !s.sessionsLooked && !s.error) continue; // 这个工作区没什么可整理的
  rows.push({ n, notes: Object.keys(before).length, candidates, s });
  detail.push({ ws, before, after: snap(ws), summary: s });
  console.log(`#${n} ${s.error ? `错误：${s.error}` : `复核 ${s.reviewed}，生效 ${s.promoted.length}，改写 ${s.rewritten.length}，合并 ${s.merged.length}，退场 ${s.retired.length}，新记 ${s.created.length}，没过关 ${s.notApplied.length}，跳过批 ${s.unparsed}`}（${Math.round((Date.now() - started) / 1000)}s）`);
}

const sum = (f: (s: (typeof rows)[number]["s"]) => number) => rows.reduce((a, r) => a + f(r.s), 0);
const lines = [
  `# 离线记忆整理 eval · ${topic}`,
  "",
  `- 日期：${date}；模型：\`${modelArg}\`；数据：正式服记忆与会话的副本（${workspaces.length} 个工作区里有活可干的 ${rows.length} 个）`,
  `- 合计：复核 ${sum((s) => s.reviewed)} 条；转为生效 ${sum((s) => s.promoted.length)}；改写 ${sum((s) => s.rewritten.length)}；合并掉 ${sum((s) => s.merged.length)}；退场 ${sum((s) => s.retired.length)}；` +
    `跨会话新记 ${sum((s) => s.created.length)}；想改但没过关 ${sum((s) => s.notApplied.length)}；答复取不出 JSON 跳过 ${sum((s) => s.unparsed)} 批；出错 ${rows.filter((r) => r.s.error).length} 个工作区`,
  `- 用量：输入 ${sum((s) => s.tokens.input)} token、输出 ${sum((s) => s.tokens.output)} token；墙钟 ${Math.round(sum((s) => s.ms) / 1000)} 秒`,
  "",
  "| 工作区 | 条目 | 待复核 | 复核 | 生效 | 改写 | 合并 | 退场 | 新记 | 没过关 | 跳过批 | 看的会话 | 秒 | 备注 |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) =>
    `| #${r.n} | ${r.notes} | ${r.candidates} | ${r.s.reviewed} | ${r.s.promoted.length} | ${r.s.rewritten.length} | ${r.s.merged.length} | ${r.s.retired.length} | ${r.s.created.length} | ${r.s.notApplied.length} | ${r.s.unparsed} | ${r.s.sessionsLooked} | ${Math.round(r.s.ms / 1000)} | ${r.s.error ? "错误" : r.s.aborted ? "中断" : ""} |`,
  ),
  "",
];
const outDir = path.join(import.meta.dirname, "results");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${date}-${topic}.md`);
fs.writeFileSync(out, lines.join("\n"));
fs.writeFileSync(at("detail.json"), JSON.stringify(detail, null, 1));
console.log(`收据：${out}`);
if (keep) console.log(`副本与逐条明细留在：${work}`);
else fs.rmSync(work, { recursive: true, force: true });
