import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveKey } from "./config.ts";
import { projectKnowledgeDir, type ProjectKnowledge } from "./knowledge.ts";
import { refreshProjectKnowledge } from "./knowledge-service.ts";
import { GLOBAL_MEMORY, listMemories, memoryDir, readMemory, type MemoryStatus } from "./memory.ts";
import { listExternalNotes } from "./external-memory.ts";

export type KnowledgeKind =
  | "memory"
  | "profile"
  | "command"
  | "module"
  | "test"
  | "route"
  | "config"
  | "data"
  | "ci"
  | "deploy"
  | "guide"
  | "verification";

export interface KnowledgeDocument {
  id: string;
  kind: KnowledgeKind;
  title: string;
  text: string;
  paths: string[];
  scope: string[];
  source: string;
  status?: MemoryStatus | "current";
  confidence?: string;
}

export interface KnowledgeSearchOptions {
  kinds?: KnowledgeKind[];
  scope?: string[];
  path?: string;
  status?: Array<MemoryStatus | "current">;
  limit?: number;
  semantic?: boolean;
  includeQuarantined?: boolean;
  generatedOnly?: boolean;
  signal?: AbortSignal;
  recordMetrics?: boolean;
  // C7（#60）：验证记录只要通过的和最近一次失败的（自动召回用；显式检索照旧能查到全部历史）
  latestFailureOnly?: boolean;
  // M12：调用方手里已有的项目知识（自动召回用开跑时按预算取的那份）；不给就等知识 worker 对完
  knowledge?: ProjectKnowledge;
}

export interface KnowledgeSearchResult {
  document: KnowledgeDocument;
  score: number;
  lexicalScore: number;
  semanticScore?: number;
  reasons: string[];
}

export interface SearchMetrics {
  schema: 1;
  queries: number;
  zeroResults: number;
  semanticQueries: number;
  semanticUsed: number;
  semanticFailures: number;
  averageLatencyMs: number;
  lastQueryAt?: string;
  resultsByKind: Partial<Record<KnowledgeKind, number>>;
  recent: Array<{
    at: string;
    queryHash: string;
    latencyMs: number;
    resultCount: number;
    topIds: string[];
    semantic: "disabled" | "unavailable" | "used" | "failed";
  }>;
}

export interface KnowledgeSearchResponse {
  query: string;
  results: KnowledgeSearchResult[];
  totalDocuments: number;
  eligibleDocuments: number;
  skippedQuarantined: number;
  semantic: "disabled" | "unavailable" | "used" | "failed";
  latencyMs: number;
}

interface EmbeddingCache {
  schema: 1;
  model: string;
  dimensions: number;
  updatedAt: string;
  vectors: Record<string, number[]>;
}

const DEFAULT_METRICS: SearchMetrics = {
  schema: 1,
  queries: 0,
  zeroResults: 0,
  semanticQueries: 0,
  semanticUsed: 0,
  semanticFailures: 0,
  averageLatencyMs: 0,
  resultsByKind: {},
  recent: [],
};
const EMBEDDING_DOCUMENT_CAP = 240;
const EMBEDDING_BATCH = 10;
const EMBEDDING_PARALLEL = 3;
const MAX_EMBED_TEXT = 4_000;
const DEFAULT_DIMENSIONS = 256;
const SEMANTIC_RESULT_MIN = 0.30;

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function normalize(value: string): string {
  return slash(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function terms(value: string): string[] {
  const result = new Set<string>();
  for (const token of normalize(value).match(/[\p{L}\p{N}_./:-]+/gu) ?? []) {
    if (token.length > 1) result.add(token);
    if (/\p{Script=Han}/u.test(token)) {
      const chars = [...token];
      for (let i = 0; i < chars.length - 1; i++) result.add(chars.slice(i, i + 2).join(""));
    } else {
      for (const part of token.split(/[./:_-]/)) if (part.length > 1) result.add(part);
    }
  }
  return [...result].slice(0, 40);
}

function doc(
  kind: KnowledgeKind,
  id: string,
  title: string,
  text: string,
  source: string,
  paths: string[] = [],
  scope: string[] = [],
  status: KnowledgeDocument["status"] = "current",
  confidence?: string,
): KnowledgeDocument {
  return { kind, id, title, text: text.slice(0, 12_000), source, paths, scope, status, confidence };
}

function knowledgeDocuments(root: string, knowledge: ProjectKnowledge, generatedOnly: boolean): KnowledgeDocument[] {
  const out: KnowledgeDocument[] = [];
  if (!generatedOnly) {
    for (const meta of listMemories(root)) {
      const record = readMemory(root, meta.id);
      if (!record) continue;
      out.push(doc(
        "memory",
        `memory:${record.id}`,
        record.title,
        `${record.description}\n${record.content}\nEvidence: ${record.evidence.join("; ")}`,
        `memory/${record.id}.md`,
        record.anchors,
        [record.topic, ...record.scope],
        record.status,
        record.confidence,
      ));
    }
    // K7：全局层的条目一并检索（id 带 global: 前缀，Recall 按它去全局层读）；还没有全局层就不去建它
    if (fs.existsSync(memoryDir(GLOBAL_MEMORY))) {
      for (const meta of listMemories(GLOBAL_MEMORY)) {
        const record = readMemory(GLOBAL_MEMORY, meta.id);
        if (!record) continue;
        out.push(doc(
          "memory",
          `memory:global:${record.id}`,
          `[global] ${record.title}`,
          `${record.description}\n${record.content}\nEvidence: ${record.evidence.join("; ")}`,
          `memory/global/${record.id}.md`,
          [],
          [record.topic, ...record.scope],
          record.status,
          record.confidence,
        ));
      }
    }
    // K8：挂着的外部记忆库（只读、未经治理）：标题带 [external]，命中注入特征的只进标题
    for (const note of listExternalNotes(root)) {
      out.push(doc(
        "memory",
        `memory:external:${note.id}`,
        `[external, not governed] ${note.title}`,
        note.withheld ? note.title : `${note.description}\n${note.body}`,
        `external/${note.source}`,
        [],
        [note.type],
        "active",
        "external",
      ));
    }
  }
  const { profile, tests, modules, contracts, health } = knowledge;
  // C7（#59）：列表为空的字段整个省略——以前渲染成「Entrypoints . Manifests .」这种孤立句点；三样都空就不出这条
  const stack = [profile.packageManager, ...Object.keys(profile.languages), ...profile.frameworks].filter(Boolean);
  const profileText = [
    stack.length ? `Stack ${stack.join(", ")}.` : "",
    profile.entrypoints.length ? `Entrypoints ${profile.entrypoints.join(", ")}.` : "",
    profile.manifests.length ? `Manifests ${profile.manifests.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  if (profileText) {
    out.push(doc(
      "profile",
      "profile:workspace",
      `Project profile: ${path.basename(profile.workspace)}`,
      profileText,
      "project-profile.json",
      [...profile.entrypoints, ...profile.manifests],
      ["project", "stack", "entrypoints"],
    ));
  }
  for (const [name, command] of Object.entries(profile.commands)) {
    if (!command) continue;
    out.push(doc("command", `command:${name}`, `${name} command`, command, "project-profile.json", [], ["command", name]));
  }
  for (const module of modules.modules) {
    out.push(doc(
      "module",
      `module:${module.path}`,
      module.path,
      `${module.language} module in ${module.boundary}. Exports ${module.exports.join(", ") || "none detected"}. ` +
        `Imports ${module.imports.map((item) => item.target ?? item.spec).join(", ") || "none"}. ` +
        `Imported by ${module.importedBy.join(", ") || "none"}. Tests ${module.tests.join(", ") || "none mapped"}.`,
      "module-map.json",
      [module.path, ...module.tests, ...module.imports.flatMap((item) => item.target ? [item.target] : [])],
      ["module", module.boundary, module.language],
    ));
  }
  for (const test of tests.testFiles) {
    out.push(doc(
      "test",
      `test:${test.path}`,
      test.path,
      `Tests sources ${test.sources.map((item) => `${item.path} (${item.via})`).join(", ") || "not mapped"}.`,
      "test-map.json",
      [test.path, ...test.sources.map((item) => item.path)],
      ["test", "verification"],
    ));
  }
  for (const route of contracts.routes) {
    out.push(doc("route", `route:${route.method}:${route.route}:${route.file}:${route.line}`, `${route.method} ${route.route}`, `${route.framework} route at ${route.file}:${route.line}`, "runtime-contracts.json", [route.file], ["api", "route", route.method.toLowerCase()]));
  }
  for (const item of contracts.config) {
    out.push(doc("config", `config:${item.name}:${item.file}:${item.line}`, item.name, `${item.source} configuration key referenced at ${item.file}:${item.line}. Values are intentionally not indexed.`, "runtime-contracts.json", [item.file], ["config", "environment"]));
  }
  for (const item of contracts.data) {
    out.push(doc("data", `data:${item.kind}:${item.name}:${item.file}:${item.line}`, item.name, `${item.kind} declared at ${item.file}:${item.line}`, "runtime-contracts.json", [item.file], ["data", item.kind]));
  }
  for (const item of contracts.ci) out.push(doc("ci", `ci:${item.path}`, item.path, `${item.kind} continuous integration definition`, "runtime-contracts.json", [item.path], ["ci", item.kind]));
  for (const item of contracts.deploy) out.push(doc("deploy", `deploy:${item.path}`, item.path, `${item.kind} build/deployment artifact`, "runtime-contracts.json", [item.path], ["deploy", item.kind]));
  for (const guide of contracts.guides) {
    out.push(doc(
      "guide",
      `guide:${guide.path}`,
      guide.path,
      `Headings: ${guide.headings.join("; ")}. Constraints: ${guide.constraints.map((item) => `L${item.line} ${item.text}`).join("; ")}.`,
      "runtime-contracts.json",
      [guide.path],
      ["guide", "constraints"],
    ));
  }
  for (const [index, verification] of health.verifications.entries()) {
    out.push(doc(
      "verification",
      `verification:${verification.at}:${index}`,
      `${verification.passed ? "PASS" : "FAIL"} ${verification.tool}`,
      `${verification.detail}${verification.command ? ` Command: ${verification.command}` : ""} Commit: ${verification.gitHead ?? "unknown"}.`,
      "health.json",
      verification.editedPaths,
      ["verification", verification.passed ? "passed" : "failed", verification.tool],
    ));
  }
  return out;
}

function matchesFilters(document: KnowledgeDocument, options: KnowledgeSearchOptions): boolean {
  if (options.kinds?.length && !options.kinds.includes(document.kind)) return false;
  if (options.status?.length && (!document.status || !options.status.includes(document.status))) return false;
  if (options.path) {
    const wanted = normalize(options.path);
    if (!document.paths.some((item) => normalize(item).includes(wanted) || wanted.includes(normalize(item)))) return false;
  }
  if (options.scope?.length) {
    const available = document.scope.map(normalize);
    if (!options.scope.some((wanted) => available.some((item) => item === normalize(wanted) || item.includes(normalize(wanted))))) return false;
  }
  return true;
}

function lexicalScore(document: KnowledgeDocument, query: string): { score: number; reasons: string[] } {
  const q = normalize(query);
  const queryTerms = terms(query);
  const title = normalize(document.title);
  const body = normalize(document.text);
  const paths = document.paths.map(normalize);
  const scope = document.scope.map(normalize);
  let score = 0;
  const reasons: string[] = [];
  if (!q) return { score: 1, reasons: ["无查询词，按当前性与类型列出"] };
  if (title === q) {
    score += 35;
    reasons.push("标题精确匹配");
  } else if (title.includes(q)) {
    score += 20;
    reasons.push("标题包含查询词");
  }
  if (paths.some((item) => item === q)) {
    score += 45;
    reasons.push("路径精确匹配");
  } else if (paths.some((item) => item.includes(q) || q.includes(item))) {
    score += 24;
    reasons.push("路径匹配");
  }
  if (scope.some((item) => item === q)) {
    score += 22;
    reasons.push("scope 精确匹配");
  } else if (scope.some((item) => item.includes(q) || q.includes(item))) {
    score += 12;
    reasons.push("scope 匹配");
  }
  let titleHits = 0;
  let pathHits = 0;
  let scopeHits = 0;
  let bodyHits = 0;
  for (const term of queryTerms) {
    if (title.includes(term)) titleHits++;
    if (paths.some((item) => item.includes(term))) pathHits++;
    if (scope.some((item) => item.includes(term))) scopeHits++;
    if (body.includes(term)) bodyHits++;
  }
  score += Math.min(titleHits, 6) * 5;
  score += Math.min(pathHits, 6) * 7;
  score += Math.min(scopeHits, 6) * 5;
  score += Math.min(bodyHits, 10) * 1.5;
  if (titleHits) reasons.push(`标题命中 ${titleHits} 个词`);
  if (pathHits) reasons.push(`路径命中 ${pathHits} 个词`);
  if (scopeHits) reasons.push(`scope 命中 ${scopeHits} 个词`);
  if (bodyHits) reasons.push(`正文命中 ${bodyHits} 个词`);
  if (document.status === "active" || document.status === "current") score += 2;
  if (document.confidence === "verified" || document.confidence === "user_confirmed") score += 2;
  return { score, reasons };
}

function appliedFilterEvidence(options: KnowledgeSearchOptions): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (options.path) {
    score += 12;
    reasons.push(`路径过滤命中 ${options.path}`);
  }
  if (options.scope?.length) {
    score += 8;
    reasons.push(`scope 过滤命中 ${options.scope.join(",")}`);
  }
  return { score, reasons };
}

function embeddingConfig(): { apiKey: string; baseUrl: string; model: string; dimensions: number } | undefined {
  const apiKey = process.env.KNOWLEDGE_EMBEDDING_API_KEY?.trim() || resolveKey("qwen");
  if (!apiKey) return undefined;
  const dimensionsRaw = Number(process.env.KNOWLEDGE_EMBEDDING_DIMENSIONS || DEFAULT_DIMENSIONS);
  return {
    apiKey,
    baseUrl: (process.env.KNOWLEDGE_EMBEDDING_BASE_URL || process.env.QWEN_BASE_URL || process.env.VISION_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, ""),
    model: process.env.KNOWLEDGE_EMBEDDING_MODEL || "text-embedding-v4",
    dimensions: Number.isInteger(dimensionsRaw) && dimensionsRaw >= 64 && dimensionsRaw <= 2048 ? dimensionsRaw : DEFAULT_DIMENSIONS,
  };
}

async function embed(inputs: string[], config: NonNullable<ReturnType<typeof embeddingConfig>>, signal?: AbortSignal): Promise<number[][]> {
  const timeout = AbortSignal.timeout(20_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, input: inputs, dimensions: config.dimensions, encoding_format: "float" }),
    signal: combined,
  });
  if (!response.ok) throw new Error(`embedding endpoint returned HTTP ${response.status}`);
  const body = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
  const rows = (body.data ?? []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
  if (rows.length !== inputs.length || rows.some((row) => row.length !== config.dimensions || row.some((n) => !Number.isFinite(n)))) {
    throw new Error("embedding endpoint returned an invalid vector batch");
  }
  return rows;
}

function vectorHash(document: KnowledgeDocument, model: string, dimensions: number): string {
  return createHash("sha256").update(`${model}\0${dimensions}\0${document.kind}\0${document.title}\0${document.text}`).digest("hex");
}

function embeddingText(document: KnowledgeDocument): string {
  return `${document.kind}: ${document.title}\npaths: ${document.paths.join(", ")}\nscope: ${document.scope.join(", ")}\n${document.text}`.slice(0, MAX_EMBED_TEXT);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function priorityForEmbedding(document: KnowledgeDocument): number {
  return ({ memory: 100, guide: 95, route: 90, config: 88, data: 86, command: 84, verification: 82, profile: 80, ci: 78, deploy: 76, test: 65, module: 55 } as Record<KnowledgeKind, number>)[document.kind];
}

async function semanticScores(
  root: string,
  query: string,
  documents: KnowledgeDocument[],
  signal?: AbortSignal,
): Promise<Map<string, number> | undefined> {
  const config = embeddingConfig();
  if (!config) return undefined;
  const selected = [...documents]
    .sort((a, b) => priorityForEmbedding(b) - priorityForEmbedding(a) || a.id.localeCompare(b.id))
    .slice(0, EMBEDDING_DOCUMENT_CAP);
  const file = path.join(projectKnowledgeDir(root), "semantic-index.json");
  const stored = readJson<EmbeddingCache>(file);
  const cache: EmbeddingCache = stored?.schema === 1 && stored.model === config.model && stored.dimensions === config.dimensions
    ? stored
    : { schema: 1, model: config.model, dimensions: config.dimensions, updatedAt: new Date(0).toISOString(), vectors: {} };
  const missing = selected.filter((document) => !cache.vectors[vectorHash(document, config.model, config.dimensions)]);
  const batches: KnowledgeDocument[][] = [];
  for (let i = 0; i < missing.length; i += EMBEDDING_BATCH) batches.push(missing.slice(i, i + EMBEDDING_BATCH));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(EMBEDDING_PARALLEL, batches.length) }, async () => {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      const vectors = await embed(batch.map(embeddingText), config, signal);
      batch.forEach((document, index) => {
        cache.vectors[vectorHash(document, config.model, config.dimensions)] = vectors[index];
      });
    }
  }));
  const keep = new Set(selected.map((document) => vectorHash(document, config.model, config.dimensions)));
  const pruned = Object.fromEntries(Object.entries(cache.vectors).filter(([hash]) => keep.has(hash)));
  if (missing.length || Object.keys(pruned).length !== Object.keys(cache.vectors).length) {
    cache.vectors = pruned;
    cache.updatedAt = new Date().toISOString();
    atomicJson(file, cache);
  }
  const [queryVector] = await embed([query.slice(0, MAX_EMBED_TEXT)], config, signal);
  const scores = new Map<string, number>();
  for (const document of selected) {
    const vector = cache.vectors[vectorHash(document, config.model, config.dimensions)];
    if (vector) scores.set(document.id, cosine(queryVector, vector));
  }
  return scores;
}

function metricsFile(root: string): string {
  return path.join(projectKnowledgeDir(root), "search-metrics.json");
}

export function getSearchMetrics(root: string): SearchMetrics {
  const stored = readJson<SearchMetrics>(metricsFile(root));
  return stored?.schema === 1 ? stored : structuredClone(DEFAULT_METRICS);
}

function writeMetrics(root: string, response: KnowledgeSearchResponse): void {
  const metrics = getSearchMetrics(root);
  const previousQueries = metrics.queries;
  metrics.queries++;
  if (response.results.length === 0) metrics.zeroResults++;
  if (response.semantic !== "disabled") metrics.semanticQueries++;
  if (response.semantic === "used") metrics.semanticUsed++;
  if (response.semantic === "failed") metrics.semanticFailures++;
  metrics.averageLatencyMs = Math.round(((metrics.averageLatencyMs * previousQueries) + response.latencyMs) / metrics.queries);
  metrics.lastQueryAt = new Date().toISOString();
  for (const result of response.results) {
    const kind = result.document.kind;
    metrics.resultsByKind[kind] = (metrics.resultsByKind[kind] ?? 0) + 1;
  }
  metrics.recent.push({
    at: metrics.lastQueryAt,
    queryHash: createHash("sha256").update(response.query).digest("hex").slice(0, 16),
    latencyMs: response.latencyMs,
    resultCount: response.results.length,
    topIds: response.results.slice(0, 5).map((item) => item.document.id),
    semantic: response.semantic,
  });
  metrics.recent = metrics.recent.slice(-30);
  atomicJson(metricsFile(root), metrics);
}

export async function searchUnifiedKnowledge(
  root: string,
  query: string,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResponse> {
  const started = performance.now();
  const knowledge = options.knowledge ?? (await refreshProjectKnowledge(root));
  const all = knowledgeDocuments(root, knowledge, Boolean(options.generatedOnly));
  let skippedQuarantined = 0;
  // 验证记录按时间先后排着：最后一条失败的就是最近一次失败
  const latestFailure = options.latestFailureOnly
    ? all.filter((document) => document.kind === "verification" && document.scope.includes("failed")).at(-1)?.id
    : undefined;
  const eligible = all.filter((document) => {
    if (document.kind === "memory" && !options.includeQuarantined && document.status !== "active") {
      skippedQuarantined++;
      return false;
    }
    if (options.latestFailureOnly && document.kind === "verification" && document.scope.includes("failed") && document.id !== latestFailure) {
      return false;
    }
    return matchesFilters(document, options);
  });
  const scored = eligible.map((document) => {
    const lexical = lexicalScore(document, query);
    const filter = appliedFilterEvidence(options);
    return {
      document,
      lexicalScore: lexical.score + filter.score,
      score: lexical.score + filter.score,
      reasons: [...filter.reasons, ...lexical.reasons],
    } as KnowledgeSearchResult;
  });
  let semantic: KnowledgeSearchResponse["semantic"] = options.semantic === false ? "disabled" : "unavailable";
  if (options.semantic !== false && query.trim()) {
    try {
      const scores = await semanticScores(root, query, eligible, options.signal);
      if (scores) {
        semantic = "used";
        for (const item of scored) {
          const similarity = scores.get(item.document.id);
          if (similarity == null) continue;
          item.semanticScore = similarity;
          // Similarity below 0.2 is usually noise. Retain the diagnostic value
          // but do not allow it to overwhelm exact path/scope/keyword evidence.
          item.score += Math.max(0, similarity - 0.2) * 18;
          if (similarity >= SEMANTIC_RESULT_MIN) item.reasons.push(`语义相似 ${similarity.toFixed(2)}`);
        }
      }
    } catch {
      semantic = "failed";
    }
  }
  const hasQuery = Boolean(query.trim());
  const limit = Math.min(20, Math.max(1, Math.trunc(options.limit ?? 8)));
  const results = scored
    .filter((item) => !hasQuery || item.reasons.length > 0 || (item.semanticScore ?? 0) >= SEMANTIC_RESULT_MIN)
    .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
    .slice(0, limit)
    .map((item) => ({ ...item, score: Number(item.score.toFixed(3)), lexicalScore: Number(item.lexicalScore.toFixed(3)) }));
  const response: KnowledgeSearchResponse = {
    query,
    results,
    totalDocuments: all.length,
    eligibleDocuments: eligible.length,
    skippedQuarantined,
    semantic,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
  };
  if (options.recordMetrics !== false) writeMetrics(root, response);
  return response;
}

export function renderSearchResults(response: KnowledgeSearchResponse): string {
  if (!response.results.length) {
    return `No current knowledge matched. ${response.skippedQuarantined} quarantined memory notes were excluded. Semantic: ${response.semantic}.`;
  }
  const rows = response.results.map((item, index) => {
    const document = item.document;
    const meta = [document.kind, document.status, document.confidence].filter(Boolean).join("; ");
    const paths = document.paths.length ? `\n  paths: ${document.paths.slice(0, 5).join(", ")}` : "";
    return `${index + 1}. [${document.id}] (${meta}) ${document.title}\n  why: ${item.reasons.join("; ") || "semantic supplement"}${paths}\n  ${document.text.slice(0, 700)}`;
  });
  return `${rows.join("\n\n")}\n\nSearch diagnostics: semantic=${response.semantic}; eligible=${response.eligibleDocuments}/${response.totalDocuments}; quarantined skipped=${response.skippedQuarantined}; latency=${response.latencyMs}ms.`;
}
