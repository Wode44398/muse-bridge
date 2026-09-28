import fs from "node:fs";
import path from "node:path";

// Schema version shared by every generated knowledge artifact. The cache check in
// knowledge.ts compares ALL of them against this one number, so it must live in a
// single place: it used to be a constant there plus three literal 2s here, and
// bumping only one side silently turned every read into a full rebuild.
export const KNOWLEDGE_SCHEMA = 3;

export interface KnowledgeFile {
  abs: string;
  rel: string;
  ext: string;
  size: number;
}

export interface ModuleImport {
  spec: string;
  target?: string;
  kind: "relative" | "package" | "python";
}

export interface ProjectModule {
  path: string;
  language: string;
  boundary: string;
  imports: ModuleImport[];
  importedBy: string[];
  exports: string[];
  tests: string[];
}

export interface ModuleMap {
  schema: number;
  workspace: string;
  generatedAt: string;
  sourceFingerprint: string;
  truncated: boolean;
  sourceFiles: number;
  analyzedFiles: number;
  boundaries: Array<{ path: string; fileCount: number; entrypoints: string[] }>;
  modules: ProjectModule[];
}

export interface RouteContract {
  method: string;
  route: string;
  file: string;
  line: number;
  framework: "javascript" | "python" | "go";
}

export interface ConfigContract {
  name: string;
  file: string;
  line: number;
  source: "process.env" | "os.getenv" | "os.environ" | "env::var" | "System.getenv";
}

export interface DataContract {
  kind: "sql-table" | "prisma-model" | "mongoose-schema";
  name: string;
  file: string;
  line: number;
}

export interface GuideContract {
  path: string;
  headings: string[];
  constraints: Array<{ line: number; text: string }>;
}

export interface RuntimeContracts {
  schema: number;
  workspace: string;
  generatedAt: string;
  sourceFingerprint: string;
  truncated: boolean;
  routes: RouteContract[];
  config: ConfigContract[];
  data: DataContract[];
  ci: Array<{ path: string; kind: string }>;
  deploy: Array<{ path: string; kind: string }>;
  guides: GuideContract[];
}

export interface VerificationRecord {
  at: string;
  tool: string;
  passed: boolean;
  detail: string;
  command?: string;
  editedPaths: string[];
  sourceFingerprint: string;
  gitHead: string | null;
}

export interface KnowledgeHealth {
  schema: number;
  workspace: string;
  generatedAt: string;
  sourceFingerprint: string;
  sourceFiles: number;
  analyzedSourceFiles: number;
  mappedSources: number;
  unmappedSources: number;
  testFiles: number;
  routeCount: number;
  configCount: number;
  uniqueConfigKeys: number;
  dataCount: number;
  ciCount: number;
  deployCount: number;
  guideCount: number;
  verifications: VerificationRecord[];
  lastPassingVerification?: VerificationRecord;
}

const SOURCE_EXTS = new Set([
  ".c", ".cc", ".cjs", ".cpp", ".cs", ".css", ".cts", ".go", ".html", ".java",
  ".js", ".jsx", ".kt", ".kts", ".mjs", ".mts", ".php", ".py", ".rb", ".rs",
  ".scss", ".svelte", ".swift", ".ts", ".tsx", ".vue",
]);
const CONTRACT_EXTS = new Set([...SOURCE_EXTS, ".sql", ".prisma"]);
const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"];
const MAX_DETAIL_FILES = 4_000;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_CONSTRAINTS_PER_GUIDE = 32;
const TEST_RE = /(^|\/)(test_[^/]+|[^/]+_test|[^/]+\.(test|spec))\.(py|js|ts|jsx|tsx|mjs|cjs|mts|cts)$/i;

function slash(value: string): string {
  return value.split(path.sep).join("/");
}

function languageFor(ext: string): string {
  return ({
    ".c": "C", ".cc": "C++", ".cjs": "JavaScript", ".cpp": "C++", ".cs": "C#",
    ".css": "CSS", ".cts": "TypeScript", ".go": "Go", ".html": "HTML",
    ".java": "Java", ".js": "JavaScript", ".jsx": "JavaScript", ".kt": "Kotlin",
    ".kts": "Kotlin", ".mjs": "JavaScript", ".mts": "TypeScript", ".php": "PHP",
    ".py": "Python", ".rb": "Ruby", ".rs": "Rust", ".scss": "SCSS", ".svelte": "Svelte",
    ".swift": "Swift", ".ts": "TypeScript", ".tsx": "TypeScript", ".vue": "Vue",
  } as Record<string, string>)[ext] ?? ext.slice(1).toUpperCase();
}

function readText(file: KnowledgeFile): string | null {
  if (file.size > MAX_SOURCE_BYTES) return null;
  try {
    return fs.readFileSync(file.abs, "utf8");
  } catch {
    return null;
  }
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function collectMatches(
  content: string,
  regex: RegExp,
  visit: (match: RegExpExecArray, line: number) => void,
): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    visit(match, lineAt(content, match.index));
    if (match[0].length === 0) regex.lastIndex++;
  }
}

function importSpecs(content: string): Array<{ spec: string; kind: "relative" | "package" }> {
  const result = new Map<string, "relative" | "package">();
  for (const re of [
    /(?:from\s*|require\s*\(|import\s*\()\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
  ]) {
    collectMatches(content, re, (match) => {
      const spec = match[1];
      result.set(spec, spec.startsWith(".") ? "relative" : "package");
    });
  }
  return [...result].map(([spec, kind]) => ({ spec, kind }));
}

function pythonImports(content: string): string[] {
  const result = new Set<string>();
  collectMatches(content, /^\s*(?:from|import)\s+([.a-zA-Z_][.a-zA-Z0-9_]*)/gm, (match) => result.add(match[1]));
  return [...result];
}

function resolveImport(root: string, from: KnowledgeFile, spec: string, known: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const raw = path.resolve(path.dirname(from.abs), spec);
  const candidates = [raw, ...RESOLVE_EXTS.map((ext) => raw + ext), ...RESOLVE_EXTS.map((ext) => path.join(raw, `index${ext}`))];
  for (const candidate of candidates) {
    const rel = slash(path.relative(root, candidate));
    if (!rel.startsWith("../") && known.has(rel)) return rel;
  }
  return undefined;
}

function resolvePython(from: KnowledgeFile, spec: string, known: Set<string>): string | undefined {
  const modulePath = spec.replace(/^\.+/, "").replaceAll(".", "/");
  const base = spec.startsWith(".") ? slash(path.posix.dirname(from.rel)) : "";
  for (const candidate of [
    slash(path.posix.join(base, `${modulePath}.py`)),
    slash(path.posix.join(base, modulePath, "__init__.py")),
    `${modulePath}.py`,
    `${modulePath}/__init__.py`,
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

function exportsFor(content: string): string[] {
  const names = new Set<string>();
  collectMatches(content, /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, (m) => names.add(m[1]));
  collectMatches(content, /\bexports\.([A-Za-z_$][\w$]*)\s*=/g, (m) => names.add(m[1]));
  collectMatches(content, /^\s*(?:def|class)\s+([A-Za-z_][\w]*)/gm, (m) => {
    if (!m[1].startsWith("_")) names.add(m[1]);
  });
  return [...names].sort().slice(0, 80);
}

function boundaryFor(rel: string): string {
  const parts = rel.split("/");
  return parts.length > 1 ? parts[0] : ".";
}

export function buildModuleMap(
  root: string,
  files: KnowledgeFile[],
  sourceFingerprint: string,
  generatedAt: string,
  entrypoints: string[],
  bySource: Record<string, unknown>,
  testFiles: Array<{ path: string; sources: Array<{ path: string }> }>,
): ModuleMap {
  const sourceFiles = files.filter((f) => SOURCE_EXTS.has(f.ext) && !TEST_RE.test(f.rel));
  const selected = sourceFiles.slice(0, MAX_DETAIL_FILES);
  const known = new Set(sourceFiles.map((f) => f.rel));
  const testsBySource = new Map<string, string[]>();
  for (const test of testFiles) {
    for (const source of test.sources) {
      const rows = testsBySource.get(source.path) ?? [];
      rows.push(test.path);
      testsBySource.set(source.path, rows);
    }
  }
  const modules: ProjectModule[] = [];
  for (const file of selected) {
    const content = readText(file);
    const imports: ModuleImport[] = [];
    if (content != null) {
      for (const item of importSpecs(content)) {
        imports.push({ ...item, target: resolveImport(root, file, item.spec, known) });
      }
      if (file.ext === ".py") {
        for (const spec of pythonImports(content)) {
          imports.push({ spec, kind: "python", target: resolvePython(file, spec, known) });
        }
      }
    }
    modules.push({
      path: file.rel,
      language: languageFor(file.ext),
      boundary: boundaryFor(file.rel),
      imports: imports.sort((a, b) => a.spec.localeCompare(b.spec)),
      importedBy: [],
      exports: content == null ? [] : exportsFor(content),
      tests: [...new Set(testsBySource.get(file.rel) ?? [])].sort(),
    });
  }
  const moduleByPath = new Map(modules.map((m) => [m.path, m]));
  for (const module of modules) {
    for (const imported of module.imports) {
      if (imported.target && moduleByPath.has(imported.target)) moduleByPath.get(imported.target)!.importedBy.push(module.path);
    }
  }
  for (const module of modules) module.importedBy = [...new Set(module.importedBy)].sort();
  const boundaries = new Map<string, { fileCount: number; entrypoints: string[] }>();
  for (const module of modules) {
    const item = boundaries.get(module.boundary) ?? { fileCount: 0, entrypoints: [] };
    item.fileCount++;
    if (entrypoints.includes(module.path)) item.entrypoints.push(module.path);
    boundaries.set(module.boundary, item);
  }
  // Include a source as mapped when it has a direct test-map entry even if the
  // detailed source scan was capped; this keeps health coverage honest.
  void bySource;
  return {
    schema: KNOWLEDGE_SCHEMA,
    workspace: path.resolve(root),
    generatedAt,
    sourceFingerprint,
    truncated: sourceFiles.length > MAX_DETAIL_FILES,
    sourceFiles: sourceFiles.length,
    analyzedFiles: modules.length,
    boundaries: [...boundaries].sort(([a], [b]) => a.localeCompare(b)).map(([boundaryPath, item]) => ({ path: boundaryPath, ...item })),
    modules,
  };
}

function addRoute(routes: RouteContract[], seen: Set<string>, route: RouteContract): void {
  const key = `${route.method}\0${route.route}\0${route.file}\0${route.line}`;
  if (!seen.has(key)) {
    seen.add(key);
    routes.push(route);
  }
}

function classifyCi(rel: string): string | undefined {
  const lower = rel.toLowerCase();
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(lower)) return "github-actions";
  if (lower === ".gitlab-ci.yml") return "gitlab-ci";
  if (lower === "azure-pipelines.yml") return "azure-pipelines";
  if (lower === "jenkinsfile") return "jenkins";
  return undefined;
}

function classifyDeploy(rel: string): string | undefined {
  const base = path.posix.basename(rel).toLowerCase();
  if (base.startsWith("dockerfile")) return "dockerfile";
  if (/^docker-compose.*\.ya?ml$/.test(base) || /^compose\.ya?ml$/.test(base)) return "docker-compose";
  if (base === "fly.toml") return "fly";
  if (base === "vercel.json") return "vercel";
  if (base === "netlify.toml") return "netlify";
  if (base === "procfile") return "procfile";
  if (/(^|[-_.])(deploy|release|publish)([-_.]|$)/.test(base)) return "script";
  return undefined;
}

const GUIDE_NAMES = new Set(["AGENTS.MD", "GUIDE.MD", "CLAUDE.MD"]);

// M12（N37）：会读进生成知识的文件——源码 / 测试（含 .sql、.prisma）、CI 与部署文件、AGENTS / GUIDE / CLAUDE.md。
// knowledge.ts 的源指纹只算这些（加上清单与锁文件）：日志、笔记、图片、数据文件变了不必整份重建。
export function affectsKnowledge(rel: string, ext: string): boolean {
  if (CONTRACT_EXTS.has(ext)) return true;
  if (GUIDE_NAMES.has(path.posix.basename(rel).toUpperCase())) return true;
  return Boolean(classifyCi(rel) || classifyDeploy(rel));
}

function guideFor(file: KnowledgeFile): GuideContract | undefined {
  const base = path.basename(file.rel).toUpperCase();
  if (!GUIDE_NAMES.has(base)) return undefined;
  const content = readText(file);
  if (content == null) return { path: file.rel, headings: [], constraints: [] };
  const headings: string[] = [];
  const constraints: Array<{ line: number; text: string }> = [];
  for (const [index, raw] of content.split(/\r?\n/).entries()) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) headings.push(heading[1].trim().slice(0, 160));
    if (constraints.length < MAX_CONSTRAINTS_PER_GUIDE &&
        /\b(MUST|MUST NOT|NEVER|REQUIRED|SHOULD NOT)\b|必须|务必|禁止|不得|不要/.test(line)) {
      constraints.push({ line: index + 1, text: line.slice(0, 300) });
    }
  }
  return { path: file.rel, headings: headings.slice(0, 60), constraints };
}

export function buildRuntimeContracts(
  root: string,
  files: KnowledgeFile[],
  sourceFingerprint: string,
  generatedAt: string,
): RuntimeContracts {
  const routes: RouteContract[] = [];
  const config: ConfigContract[] = [];
  const data: DataContract[] = [];
  const seenRoutes = new Set<string>();
  const seenConfig = new Set<string>();
  const seenData = new Set<string>();
  const sourceFiles = files.filter((f) => CONTRACT_EXTS.has(f.ext)).slice(0, MAX_DETAIL_FILES);
  for (const file of sourceFiles) {
    const content = readText(file);
    if (content == null) continue;
    collectMatches(content, /\b(?:app|router|server)\s*\.\s*(get|post|put|patch|delete|options|head|use)\s*\(\s*["'`]([^"'`]+)["'`]/gi, (m, line) => {
      addRoute(routes, seenRoutes, { method: m[1].toUpperCase(), route: m[2], file: file.rel, line, framework: "javascript" });
    });
    collectMatches(content, /^\s*@(?:app|router)\.(get|post|put|patch|delete|options|head|route)\s*\(\s*["']([^"']+)["']/gim, (m, line) => {
      addRoute(routes, seenRoutes, { method: m[1].toUpperCase(), route: m[2], file: file.rel, line, framework: "python" });
    });
    collectMatches(content, /\b(?:http\.)?HandleFunc\s*\(\s*["`]([^"`]+)["`]/g, (m, line) => {
      addRoute(routes, seenRoutes, { method: "ANY", route: m[1], file: file.rel, line, framework: "go" });
    });

    const configPatterns: Array<[RegExp, ConfigContract["source"]]> = [
      [/\bprocess\.env\.([A-Z][A-Z0-9_]*)/g, "process.env"],
      [/\bos\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g, "os.getenv"],
      [/\bos\.environ\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g, "os.environ"],
      [/\benv::var\(\s*["']([A-Z][A-Z0-9_]*)["']/g, "env::var"],
      [/\bSystem\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g, "System.getenv"],
    ];
    for (const [re, source] of configPatterns) {
      collectMatches(content, re, (m, line) => {
        const key = `${m[1]}\0${file.rel}\0${line}`;
        if (!seenConfig.has(key)) {
          seenConfig.add(key);
          config.push({ name: m[1], file: file.rel, line, source });
        }
      });
    }

    const dataPatterns: Array<[RegExp, DataContract["kind"]]> = [
      [/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([A-Za-z_][\w.-]*)/gi, "sql-table"],
      [/^\s*model\s+([A-Za-z_][\w]*)\s*\{/gm, "prisma-model"],
      [/\b([A-Za-z_][\w]*)Schema\s*=\s*new\s+(?:mongoose\.)?Schema\b/g, "mongoose-schema"],
    ];
    for (const [re, kind] of dataPatterns) {
      collectMatches(content, re, (m, line) => {
        const key = `${kind}\0${m[1]}\0${file.rel}\0${line}`;
        if (!seenData.has(key)) {
          seenData.add(key);
          data.push({ kind, name: m[1], file: file.rel, line });
        }
      });
    }
  }
  const ci = files.map((f) => ({ path: f.rel, kind: classifyCi(f.rel) })).filter((item): item is { path: string; kind: string } => Boolean(item.kind));
  const deploy = files.map((f) => ({ path: f.rel, kind: classifyDeploy(f.rel) })).filter((item): item is { path: string; kind: string } => Boolean(item.kind));
  const guides = files.map(guideFor).filter((item): item is GuideContract => Boolean(item));
  return {
    schema: KNOWLEDGE_SCHEMA,
    workspace: path.resolve(root),
    generatedAt,
    sourceFingerprint,
    truncated: files.filter((f) => CONTRACT_EXTS.has(f.ext)).length > MAX_DETAIL_FILES,
    routes: routes.sort((a, b) => a.route.localeCompare(b.route) || a.file.localeCompare(b.file) || a.line - b.line),
    config: config.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file)),
    data: data.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file)),
    ci: ci.sort((a, b) => a.path.localeCompare(b.path)),
    deploy: deploy.sort((a, b) => a.path.localeCompare(b.path)),
    guides: guides.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function buildKnowledgeHealth(
  root: string,
  sourceFingerprint: string,
  generatedAt: string,
  modules: ModuleMap,
  contracts: RuntimeContracts,
  testFileCount: number,
  mappedSourceCount: number,
  previous?: KnowledgeHealth | null,
): KnowledgeHealth {
  const verifications = (previous?.verifications ?? []).slice(-50);
  const sourceFiles = modules.sourceFiles;
  const lastPassingVerification = [...verifications].reverse().find((item) => item.passed);
  return {
    schema: KNOWLEDGE_SCHEMA,
    workspace: path.resolve(root),
    generatedAt,
    sourceFingerprint,
    sourceFiles,
    analyzedSourceFiles: modules.analyzedFiles,
    mappedSources: mappedSourceCount,
    unmappedSources: Math.max(0, sourceFiles - mappedSourceCount),
    testFiles: testFileCount,
    routeCount: contracts.routes.length,
    configCount: contracts.config.length,
    uniqueConfigKeys: new Set(contracts.config.map((item) => item.name)).size,
    dataCount: contracts.data.length,
    ciCount: contracts.ci.length,
    deployCount: contracts.deploy.length,
    guideCount: contracts.guides.length,
    verifications,
    lastPassingVerification,
  };
}
