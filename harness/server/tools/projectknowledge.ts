import { findTestsForPath, renderProjectKnowledgeForPrompt, renderProjectKnowledgeVolatile } from "../knowledge.ts";
import { refreshProjectKnowledge } from "../knowledge-service.ts";
import { getSearchMetrics, renderSearchResults, searchUnifiedKnowledge, type KnowledgeKind } from "../knowledge-search.ts";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail, ok } from "./types.ts";

export const projectKnowledgeTool: Tool = {
  effect: "read",
  concurrencySafe: false,
  def: {
    name: "ProjectKnowledge",
    description:
      "Read deterministic, rebuildable knowledge generated from the current workspace. " +
      "Use summary for the project profile, modules for boundaries/imports/exports, tests for source-to-test relations, " +
      "contracts for routes/config/data/CI/deploy/guides, health for coverage and verification history, search for hybrid generated-fact retrieval, " +
      "metrics for aggregate retrieval quality, status for cache metadata, or refresh after external changes. This is rebuildable code-derived data, not decision memory.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["summary", "modules", "tests", "contracts", "health", "search", "metrics", "status", "refresh"], description: "Operation; defaults to summary." },
        path: { type: "string", description: "Optional workspace-relative path filter." },
        query: { type: "string", description: "Optional text filter; required for action=search." },
        kinds: { type: "array", items: { type: "string", enum: ["profile", "command", "module", "test", "route", "config", "data", "ci", "deploy", "guide", "verification"] }, description: "Optional action=search kind filter." },
        semantic: { type: "boolean", description: "Use semantic reranking for action=search when configured (default true)." },
        limit: { type: "number", description: "Maximum rows/results, 1-20 for search." },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const action = String(args.action ?? "summary");
    const actions = ["summary", "modules", "tests", "contracts", "health", "search", "metrics", "status", "refresh"];
    if (!actions.includes(action)) return fail("project knowledge", `action must be ${actions.join(", ")}.`);
    const root = ctx.sandbox.root;
    if (action === "metrics") {
      return ok("project knowledge search metrics", JSON.stringify(getSearchMetrics(root), null, 2));
    }
    // M12：在知识 worker 里对（不在主线程上扫描工作区，别的会话照常流式输出）
    const knowledge = await refreshProjectKnowledge(root, { force: action === "refresh" });
    if (action === "summary" || action === "refresh") {
      return ok(
        `project knowledge ${knowledge.rebuilt ? "rebuilt" : "current"}`,
        `${renderProjectKnowledgeForPrompt(root, knowledge)}\n${renderProjectKnowledgeVolatile(knowledge)}`,
      );
    }
    if (action === "status") {
      return ok(
        `project knowledge ${knowledge.rebuilt ? "rebuilt" : "current"}`,
        `Generated: ${knowledge.profile.generatedAt}\nFingerprint: ${knowledge.profile.sourceFingerprint}\n` +
          `Scanned files: ${knowledge.profile.scannedFiles}${knowledge.profile.truncated ? " (capped)" : ""}\n` +
          `Test files: ${knowledge.tests.testFiles.length}\nMapped sources: ${Object.keys(knowledge.tests.bySource).length}`,
      );
    }
    if (action === "health") {
      const health = knowledge.health;
      const verifications = health.verifications.slice(-10).reverse().map((item) =>
        `- ${item.at} ${item.passed ? "PASS" : "FAIL"} ${item.tool}: ${item.detail}` +
        `${item.command ? ` [${item.command}]` : ""}${item.editedPaths.length ? ` paths=${item.editedPaths.join(",")}` : ""}`,
      ).join("\n") || "(none recorded)";
      return ok(
        `knowledge health: ${health.sourceFiles} modules, ${health.verifications.length} verifications`,
        `Source modules: ${health.sourceFiles} (${health.analyzedSourceFiles} analyzed)\nTest-mapped sources: ${health.mappedSources}\nUnmapped sources: ${health.unmappedSources}\n` +
          `Contracts: routes=${health.routeCount}, config=${health.uniqueConfigKeys} keys/${health.configCount} references, data=${health.dataCount}, CI=${health.ciCount}, deploy=${health.deployCount}, guides=${health.guideCount}\n` +
          `Last passing verification: ${health.lastPassingVerification?.at ?? "none"}\n\nRecent verification evidence:\n${verifications}`,
      );
    }
    const query = String(args.query ?? args.path ?? "").trim().toLowerCase();
    if (action === "modules") {
      const modules = knowledge.modules.modules.filter((item) => !query ||
        item.path.toLowerCase().includes(query) || item.boundary.toLowerCase().includes(query) ||
        item.exports.some((name) => name.toLowerCase().includes(query)));
      const rows = modules.slice(0, 100).map((item) =>
        `- ${item.path} [${item.language}; ${item.boundary}] exports=${item.exports.join(",") || "-"}; imports=${item.imports.length}; importedBy=${item.importedBy.length}; tests=${item.tests.join(",") || "-"}`,
      );
      return ok(`module map: ${modules.length} matches`, rows.join("\n") || "(none detected)");
    }
    if (action === "contracts") {
      const matches = (values: string[]) => !query || values.some((value) => value.toLowerCase().includes(query));
      const rows = [
        ...knowledge.contracts.routes.filter((item) => matches([item.method, item.route, item.file])).map((item) => `- route ${item.method} ${item.route} — ${item.file}:${item.line}`),
        ...knowledge.contracts.config.filter((item) => matches([item.name, item.file])).map((item) => `- config ${item.name} (${item.source}) — ${item.file}:${item.line}`),
        ...knowledge.contracts.data.filter((item) => matches([item.kind, item.name, item.file])).map((item) => `- data ${item.kind} ${item.name} — ${item.file}:${item.line}`),
        ...knowledge.contracts.ci.filter((item) => matches([item.kind, item.path])).map((item) => `- CI ${item.kind} — ${item.path}`),
        ...knowledge.contracts.deploy.filter((item) => matches([item.kind, item.path])).map((item) => `- deploy ${item.kind} — ${item.path}`),
        ...knowledge.contracts.guides.filter((item) => matches([item.path, ...item.headings, ...item.constraints.map((c) => c.text)])).map((item) => `- guide ${item.path}: ${item.constraints.length} constraints, headings=${item.headings.join(" | ")}`),
      ];
      return ok(`runtime contracts: ${rows.length} matches`, rows.slice(0, 150).join("\n") || "(none detected)");
    }
    if (action === "search") {
      const rawQuery = String(args.query ?? "").trim();
      if (!rawQuery) return fail("project knowledge search", "query is required for action=search.");
      const response = await searchUnifiedKnowledge(root, rawQuery, {
        generatedOnly: true,
        kinds: Array.isArray(args.kinds) ? args.kinds.map(String) as KnowledgeKind[] : undefined,
        path: args.path ? String(args.path) : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        semantic: typeof args.semantic === "boolean" ? args.semantic : undefined,
        signal: ctx.signal,
        knowledge, // 上面刚对过，不必再对一遍
      });
      return ok(`project knowledge search: ${response.results.length} results (${response.semantic})`, renderSearchResults(response));
    }
    const testQuery = String(args.path ?? args.query ?? "").trim();
    if (!testQuery) {
      const rows = knowledge.tests.testFiles.map((test) => `- ${test.path} (${test.sources.length} mapped sources)`).join("\n") || "(none detected)";
      return ok(`test map: ${knowledge.tests.testFiles.length} files`, rows);
    }
    const matches = findTestsForPath(knowledge, testQuery);
    if (!matches.length) return ok(`test map: no match for ${testQuery}`, `No generated test relation matched "${testQuery}". Search the test suite directly for aliases or dynamic references.`);
    const rows = matches.flatMap((match) => match.references.map((ref) => `- ${match.source} -> ${ref.test} (${ref.via})`));
    return ok(`test map: ${rows.length} references`, rows.join("\n"));
  },
};
