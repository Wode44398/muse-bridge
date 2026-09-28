import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { helperEnv, helperGitArgs } from "./helper-proc.ts";
import { knowledgeRoot } from "./paths.ts";
import {
  affectsKnowledge,
  buildKnowledgeHealth,
  buildModuleMap,
  KNOWLEDGE_SCHEMA,
  buildRuntimeContracts,
  type KnowledgeHealth,
  type ModuleMap,
  type RuntimeContracts,
  type VerificationRecord,
} from "./knowledge-detail.ts";

export type {
  ConfigContract,
  DataContract,
  GuideContract,
  KnowledgeHealth,
  ModuleImport,
  ModuleMap,
  ProjectModule,
  RouteContract,
  RuntimeContracts,
  VerificationRecord,
} from "./knowledge-detail.ts";

const SCHEMA = KNOWLEDGE_SCHEMA;
const MAX_FILES = 10_000;
const MAX_TEST_FILES = 600;
const MAX_TEST_BYTES = 2 * 1024 * 1024;
const SOURCE_EXTS = new Set([
  ".c", ".cc", ".cjs", ".cpp", ".cs", ".css", ".cts", ".go", ".html", ".java", ".js", ".jsx",
  ".kt", ".kts", ".mjs", ".mts", ".php", ".py", ".rb", ".rs", ".scss", ".svelte",
  ".swift", ".ts", ".tsx", ".vue",
]);
const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"];
const IGNORE_DIRS = new Set([
  ".git", ".gradle", ".idea", ".next", ".nyc_output", ".pytest_cache", ".ruff_cache",
  ".svn", ".tox", ".venv", ".vscode", "__pycache__", "build", "coverage", "dist",
  "node_modules", "target", "venv",
]);
const MANIFEST_NAMES = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "Pipfile", "poetry.lock", "uv.lock",
  "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json",
]);
const TEST_RE = /(^|\/)(test_[^/]+|[^/]+_test|[^/]+\.(test|spec))\.(py|js|ts|jsx|tsx|mjs|cjs|mts|cts)$/i;

interface ScannedFile {
  abs: string;
  rel: string;
  ext: string;
  size: number;
  mtimeMs: number;
}

export interface ProjectProfile {
  schema: number;
  workspace: string;
  generatedAt: string;
  sourceFingerprint: string;
  truncated: boolean;
  scannedFiles: number;
  packageManager: string | null;
  languages: Record<string, number>;
  manifests: string[];
  // Sibling projects living under the workspace, each with its own manifest. A
  // workspace is not always one project: the fields above describe the ROOT, and
  // in a multi-project bucket that root profile actively misleads (2026-08-16: a
  // Gradle/Java Android project got described as "npm, HTML, JavaScript;
  // entrypoints server.js" from a leftover app in the same bucket).
  subProjects: Array<{ dir: string; manifest: string }>;
  frameworks: string[];
  scripts: Record<string, string>;
  commands: Partial<Record<"test" | "build" | "lint" | "typecheck" | "start" | "dev", string>>;
  entrypoints: string[];
  git: { branch: string | null; head: string | null };
}

export interface TestReference {
  test: string;
  via: "import" | "module-name";
}

export interface ProjectTest {
  path: string;
  sources: Array<{ path: string; via: "import" | "module-name" }>;
}

export interface TestMap {
  schema: number;
  workspace: string;
  generatedAt: string;
  sourceFingerprint: string;
  truncated: boolean;
  testFiles: ProjectTest[];
  bySource: Record<string, TestReference[]>;
}

export interface ProjectKnowledge {
  profile: ProjectProfile;
  tests: TestMap;
  modules: ModuleMap;
  contracts: RuntimeContracts;
  health: KnowledgeHealth;
  rebuilt: boolean;
}

function slash(value: string): string {
  return value.split(path.sep).join("/");
}

function workspaceKey(root: string): string {
  const absolute = path.resolve(root);
  const base = path.basename(absolute).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(absolute.toLowerCase()).digest("hex").slice(0, 12);
  return `${base}-${hash}`;
}

export function projectKnowledgeDir(root: string): string {
  return path.join(knowledgeRoot(), "workspaces", workspaceKey(root));
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function scan(root: string): { files: ScannedFile[]; truncated: boolean } {
  const files: ScannedFile[] = [];
  const stack = [path.resolve(root)];
  const generatedRoot = knowledgeRoot();
  let truncated = false;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path.resolve(abs) === generatedRoot) continue;
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.endsWith(".egg-info")) stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      files.push({ abs, rel: slash(path.relative(root, abs)), ext: path.extname(entry.name).toLowerCase(), size: stat.size, mtimeMs: stat.mtimeMs });
      if (files.length >= MAX_FILES) {
        truncated = true;
        stack.length = 0;
        break;
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, truncated };
}

// 锁文件只看在不在（它决定包管理器），内容变了（装了个依赖）不影响生成的知识
const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Pipfile.lock", "Cargo.lock", "poetry.lock", "uv.lock"]);

// M12（N37）：指纹只算会读进知识的文件。以前任何文件的 size / mtime 一变就整份重建——笔记库每 10 分钟有自动备份提交、
// 工作区里的日志每跑一次命令就长一截，冷路径成了常态（往日志里追加一行就重建，见 probe-loop-block-touch）。
function fingerprint(files: ScannedFile[], truncated: boolean): string {
  const hash = createHash("sha256");
  hash.update(`schema:${SCHEMA};truncated:${truncated};relevant-only\n`);
  for (const file of files) {
    const base = path.posix.basename(file.rel);
    if (LOCKFILES.has(base)) hash.update(`${file.rel}\0lock\n`);
    else if (MANIFEST_NAMES.has(base) || affectsKnowledge(file.rel, file.ext)) hash.update(`${file.rel}\0${file.size}\0${Math.trunc(file.mtimeMs)}\n`);
  }
  return hash.digest("hex");
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function packageManager(files: ScannedFile[]): string | null {
  const roots = new Set(files.filter((f) => !f.rel.includes("/")).map((f) => f.rel));
  if (roots.has("pnpm-lock.yaml")) return "pnpm";
  if (roots.has("yarn.lock")) return "yarn";
  if (roots.has("bun.lock") || roots.has("bun.lockb")) return "bun";
  if (roots.has("package-lock.json")) return "npm";
  if (roots.has("uv.lock")) return "uv";
  if (roots.has("poetry.lock")) return "poetry";
  if (roots.has("Pipfile.lock")) return "pipenv";
  if (roots.has("Cargo.lock")) return "cargo";
  if (roots.has("go.mod")) return "go";
  return roots.has("package.json") ? "npm" : null;
}

function languageFor(ext: string): string | null {
  return ({
    ".c": "C", ".cc": "C++", ".cjs": "JavaScript", ".cpp": "C++", ".cs": "C#", ".css": "CSS", ".cts": "TypeScript", ".go": "Go",
    ".html": "HTML", ".java": "Java", ".js": "JavaScript", ".jsx": "JavaScript", ".kt": "Kotlin",
    ".kts": "Kotlin", ".mjs": "JavaScript", ".mts": "TypeScript", ".php": "PHP", ".py": "Python",
    ".rb": "Ruby", ".rs": "Rust", ".scss": "SCSS", ".svelte": "Svelte", ".swift": "Swift",
    ".ts": "TypeScript", ".tsx": "TypeScript", ".vue": "Vue",
  } as Record<string, string>)[ext] ?? null;
}

// S7（#55）：以前不传 env，git 继承全部 provider key；工作区仓库的配置在 agent 手里。
function gitValue(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", [...helperGitArgs(), ...args], {
      cwd: root,
      env: helperEnv(),
      encoding: "utf8",
      timeout: 1500,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function loadPackage(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function detectFrameworks(pkg: Record<string, unknown> | null): string[] {
  if (!pkg) return [];
  const deps = { ...((pkg.dependencies as Record<string, string>) || {}), ...((pkg.devDependencies as Record<string, string>) || {}) };
  const known: Record<string, string> = {
    "@angular/core": "Angular", "@nestjs/core": "NestJS", "@sveltejs/kit": "SvelteKit", "@vitejs/plugin-react": "Vite",
    "astro": "Astro", "django": "Django", "electron": "Electron", "express": "Express", "fastify": "Fastify",
    "next": "Next.js", "nuxt": "Nuxt", "react": "React", "remix": "Remix", "svelte": "Svelte", "vite": "Vite", "vue": "Vue",
  };
  return [...new Set(Object.keys(deps).map((name) => known[name]).filter(Boolean))].sort();
}

function entrypoints(root: string, files: ScannedFile[], pkg: Record<string, unknown> | null): string[] {
  const known = new Set(files.map((f) => f.rel));
  const result = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const rel = slash(value.replace(/^\.\//, ""));
    if (known.has(rel)) result.add(rel);
  };
  add(pkg?.main);
  add(pkg?.module);
  const bin = pkg?.bin;
  if (typeof bin === "string") add(bin);
  else if (bin && typeof bin === "object") Object.values(bin as Record<string, unknown>).forEach(add);
  for (const base of ["index", "main", "app", "server", "src/index", "src/main", "server/index"]) {
    for (const ext of RESOLVE_EXTS) if (known.has(`${base}${ext}`)) result.add(`${base}${ext}`);
  }
  return [...result].sort();
}

// Every manifest that is NOT at the workspace root marks a project of its own.
// Reported rather than merged: guessing which one is "the" project from file
// counts or mtimes is exactly how the root profile came to describe the wrong
// one. The model gets the list and picks by what it is actually working on.
function subProjects(manifests: string[]): Array<{ dir: string; manifest: string }> {
  const byDir = new Map<string, string>();
  for (const rel of manifests) {
    const dir = path.posix.dirname(slash(rel));
    if (dir === "." || dir === "/" || !MANIFEST_NAMES.has(path.posix.basename(slash(rel)))) continue;
    if (!byDir.has(dir)) byDir.set(dir, path.posix.basename(slash(rel)));
  }
  return [...byDir.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([dir, manifest]) => ({ dir, manifest }));
}

function commandFor(manager: string | null, name: string, scripts: Record<string, string>): string | undefined {
  if (!scripts[name]) return undefined;
  if (manager === "yarn") return `yarn ${name}`;
  if (manager === "pnpm") return `pnpm ${name}`;
  if (manager === "bun") return `bun run ${name}`;
  return `npm run ${name}`;
}

function buildProfile(root: string, files: ScannedFile[], truncated: boolean, sourceFingerprint: string, generatedAt: string): ProjectProfile {
  const pkg = loadPackage(root);
  const manager = packageManager(files);
  const rawScripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts as Record<string, unknown> : {};
  const scripts = Object.fromEntries(Object.entries(rawScripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const commands: ProjectProfile["commands"] = {};
  for (const name of ["test", "build", "lint", "typecheck", "start", "dev"] as const) {
    const command = commandFor(manager, name, scripts);
    if (command) commands[name] = command;
  }
  const languages: Record<string, number> = {};
  for (const file of files) {
    const language = languageFor(file.ext);
    if (language) languages[language] = (languages[language] ?? 0) + 1;
  }
  const manifests = files.filter((f) => MANIFEST_NAMES.has(path.basename(f.rel)) || /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f.rel)).map((f) => f.rel);
  return {
    schema: SCHEMA, workspace: path.resolve(root), generatedAt, sourceFingerprint, truncated,
    subProjects: subProjects(manifests),
    scannedFiles: files.length, packageManager: manager,
    languages: Object.fromEntries(Object.entries(languages).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    manifests, frameworks: detectFrameworks(pkg), scripts, commands,
    entrypoints: entrypoints(root, files, pkg),
    git: { branch: gitValue(root, ["branch", "--show-current"]), head: gitValue(root, ["rev-parse", "--short=12", "HEAD"]) },
  };
}

function resolveLocalImport(root: string, testFile: ScannedFile, spec: string, sources: Set<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const raw = path.resolve(path.dirname(testFile.abs), spec);
  const candidates = [raw, ...RESOLVE_EXTS.map((ext) => raw + ext), ...RESOLVE_EXTS.map((ext) => path.join(raw, `index${ext}`))];
  for (const candidate of candidates) {
    const rel = slash(path.relative(root, candidate));
    if (!rel.startsWith("../") && sources.has(rel)) return rel;
  }
  return null;
}

function importSpecs(content: string): string[] {
  const result = new Set<string>();
  for (const re of [
    /(?:from\s*|require\s*\(|import\s*\()\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
  ]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(content))) result.add(match[1]);
  }
  return [...result];
}

function pythonModules(content: string): string[] {
  const result = new Set<string>();
  const re = /^\s*(?:from|import)\s+([.a-zA-Z_][.a-zA-Z0-9_]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) result.add(match[1]);
  return [...result];
}

function inferredModuleToken(spec: string): string {
  const normalized = spec.replaceAll("\\", "/").replace(/\.(?:[cm]?[jt]sx?|py)$/i, "");
  return normalized.split(/[/.]/).filter(Boolean).pop()?.toLowerCase() ?? "";
}

function buildTestMap(root: string, files: ScannedFile[], truncated: boolean, sourceFingerprint: string, generatedAt: string): TestMap {
  const sources = files.filter((f) => SOURCE_EXTS.has(f.ext) && !TEST_RE.test(f.rel));
  const sourcePaths = new Set(sources.map((f) => f.rel));
  const sourcesByToken = new Map<string, string[]>();
  for (const source of sources) {
    const token = path.basename(source.rel, source.ext).toLowerCase();
    if (token.length < 3 || ["app", "index", "main", "types", "utils"].includes(token)) continue;
    sourcesByToken.set(token, [...(sourcesByToken.get(token) ?? []), source.rel]);
  }
  const testFiles: ProjectTest[] = [];
  const bySource: Record<string, TestReference[]> = {};
  const tests = files.filter((f) => TEST_RE.test(f.rel)).slice(0, MAX_TEST_FILES);
  for (const test of tests) {
    if (test.size > MAX_TEST_BYTES) {
      testFiles.push({ path: test.rel, sources: [] });
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(test.abs, "utf8");
    } catch {
      continue;
    }
    const refs = new Map<string, "import" | "module-name">();
    for (const spec of importSpecs(content)) {
      const resolved = resolveLocalImport(root, test, spec, sourcePaths);
      if (resolved) {
        refs.set(resolved, "import");
      } else if (spec.startsWith(".") || spec.startsWith("@") || spec.includes("/")) {
        const candidates = sourcesByToken.get(inferredModuleToken(spec)) ?? [];
        if (candidates.length === 1) refs.set(candidates[0], "module-name");
      }
    }
    for (const spec of pythonModules(content)) {
      const candidates = sourcesByToken.get(inferredModuleToken(spec)) ?? [];
      if (candidates.length === 1 && !refs.has(candidates[0])) refs.set(candidates[0], "module-name");
    }
    const related = [...refs].sort(([a], [b]) => a.localeCompare(b)).map(([sourcePath, via]) => ({ path: sourcePath, via }));
    testFiles.push({ path: test.rel, sources: related });
    for (const ref of related) (bySource[ref.path] ??= []).push({ test: test.rel, via: ref.via });
  }
  return {
    schema: SCHEMA, workspace: path.resolve(root), generatedAt, sourceFingerprint,
    truncated: truncated || files.filter((f) => TEST_RE.test(f.rel)).length > MAX_TEST_FILES,
    testFiles, bySource: Object.fromEntries(Object.entries(bySource).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function cacheFiles(absolute: string) {
  const dir = projectKnowledgeDir(absolute);
  return {
    profile: path.join(dir, "project-profile.json"),
    tests: path.join(dir, "test-map.json"),
    modules: path.join(dir, "module-map.json"),
    contracts: path.join(dir, "runtime-contracts.json"),
    health: path.join(dir, "health.json"),
    dirty: path.join(dir, "dirty"),
  };
}

// 盘上那份知识：五张表都在、都是这一版的结构、都属于这个工作区、彼此指纹一致才算数（不扫描工作区，不管它新不新）
function readCache(absolute: string, files: ReturnType<typeof cacheFiles>): Omit<ProjectKnowledge, "rebuilt"> | null {
  const profile = readJson<ProjectProfile>(files.profile);
  const tests = readJson<TestMap>(files.tests);
  const modules = readJson<ModuleMap>(files.modules);
  const contracts = readJson<RuntimeContracts>(files.contracts);
  const health = readJson<KnowledgeHealth>(files.health);
  if (profile?.schema === SCHEMA && tests?.schema === SCHEMA &&
      modules?.schema === SCHEMA && contracts?.schema === SCHEMA && health?.schema === SCHEMA &&
      Number.isInteger(modules.sourceFiles) && Number.isInteger(modules.analyzedFiles) &&
      Number.isInteger(health.analyzedSourceFiles) && Number.isInteger(health.uniqueConfigKeys) &&
      profile.workspace === absolute && tests.workspace === absolute && modules.workspace === absolute &&
      contracts.workspace === absolute && health.workspace === absolute &&
      tests.sourceFingerprint === profile.sourceFingerprint && modules.sourceFingerprint === profile.sourceFingerprint &&
      contracts.sourceFingerprint === profile.sourceFingerprint && health.sourceFingerprint === profile.sourceFingerprint) {
    return { profile, tests, modules, contracts, health };
  }
  return null;
}

// M12：主线程冷启动时用——读盘上最近一份，不扫描工作区（可能略旧；新不新交给 worker 去对）
export function loadCachedProjectKnowledge(root: string): ProjectKnowledge | null {
  const absolute = path.resolve(root);
  const cached = readCache(absolute, cacheFiles(absolute));
  return cached ? { ...cached, rebuilt: false } : null;
}

// 同步实现：扫描、比指纹、必要时重建并落盘。生产上只在知识 worker 里跑（knowledge-service.ts）——主线程上跑一次，
// 用户自己的笔记库能冻住整个 harness 5–8 秒；测试与 worker 直接用它。
export function ensureProjectKnowledge(root: string, options: { force?: boolean } = {}): ProjectKnowledge {
  const absolute = path.resolve(root);
  const files = cacheFiles(absolute);
  const profileFile = files.profile;
  const testsFile = files.tests;
  const modulesFile = files.modules;
  const contractsFile = files.contracts;
  const healthFile = files.health;
  const dirtyFile = files.dirty;
  const scanned = scan(absolute);
  const sourceFingerprint = fingerprint(scanned.files, scanned.truncated);
  const cached = readCache(absolute, files);
  const oldHealth = cached?.health ?? readJson<KnowledgeHealth>(healthFile);
  const dirty = fs.existsSync(dirtyFile);
  if (!options.force && !dirty && cached && cached.profile.sourceFingerprint === sourceFingerprint) {
    return { ...cached, rebuilt: false };
  }
  const generatedAt = new Date().toISOString();
  const profile = buildProfile(absolute, scanned.files, scanned.truncated, sourceFingerprint, generatedAt);
  const tests = buildTestMap(absolute, scanned.files, scanned.truncated, sourceFingerprint, generatedAt);
  const modules = buildModuleMap(
    absolute,
    scanned.files,
    sourceFingerprint,
    generatedAt,
    profile.entrypoints,
    tests.bySource,
    tests.testFiles,
  );
  const contracts = buildRuntimeContracts(absolute, scanned.files, sourceFingerprint, generatedAt);
  const health = buildKnowledgeHealth(
    absolute,
    sourceFingerprint,
    generatedAt,
    modules,
    contracts,
    tests.testFiles.length,
    Object.keys(tests.bySource).length,
    oldHealth,
  );
  atomicJson(profileFile, profile);
  atomicJson(testsFile, tests);
  atomicJson(modulesFile, modules);
  atomicJson(contractsFile, contracts);
  atomicJson(healthFile, health);
  try { fs.rmSync(dirtyFile, { force: true }); } catch { /* best-effort cache marker */ }
  return { profile, tests, modules, contracts, health, rebuilt: true };
}

export interface RecordProjectVerificationOptions {
  tool: string;
  passed: boolean;
  detail: string;
  command?: string;
  editedPaths?: string[];
}

export function recordProjectVerification(root: string, options: RecordProjectVerificationOptions): VerificationRecord {
  const absolute = path.resolve(root);
  const knowledge = ensureProjectKnowledge(absolute);
  const relativeEdited = [...new Set((options.editedPaths ?? []).map((value) => {
    const resolved = path.resolve(value);
    const relative = slash(path.relative(absolute, resolved));
    return relative && !relative.startsWith("../") ? relative : resolved;
  }))].slice(0, 100);
  const record: VerificationRecord = {
    at: new Date().toISOString(),
    tool: options.tool.slice(0, 80),
    passed: options.passed,
    detail: options.detail.replace(/\s+/g, " ").trim().slice(0, 500),
    command: options.command?.replace(/\s+/g, " ").trim().slice(0, 500) || undefined,
    editedPaths: relativeEdited,
    sourceFingerprint: knowledge.profile.sourceFingerprint,
    gitHead: knowledge.profile.git.head,
  };
  const verifications = [...knowledge.health.verifications, record].slice(-50);
  const next: KnowledgeHealth = {
    ...knowledge.health,
    verifications,
    lastPassingVerification: record.passed
      ? record
      : [...verifications].reverse().find((item) => item.passed),
  };
  atomicJson(path.join(projectKnowledgeDir(absolute), "health.json"), next);
  return record;
}

export function markProjectKnowledgeDirty(root: string): void {
  const file = path.join(projectKnowledgeDir(root), "dirty");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${new Date().toISOString()}\n`, "utf8");
}

// C2（N09 第 1 步，#30）：进 system prompt 的只有稳定的汇总。源文件指纹与验证记录（Health）每改一个文件、每跑
// 一次验证就变——以前它们在 system 里，恢复会话时 system 尾段就被整段重写，整个请求的前缀缓存作废。这两样改由
// ProjectKnowledge 工具现查（见下面的 renderProjectKnowledgeVolatile）。
// C7（#59）：空的字段整行省略；工作区里什么事实都没有（空目录、只有文档）就返回空串——整段不注入。以前空工作区也注入
// 一段「0 source files / 0 routes / 0 files」样板，白占 token，还让模型怀疑格式出了 bug。
export function renderProjectKnowledgeForPrompt(root: string, current?: ProjectKnowledge): string {
  const { profile, tests, modules, contracts } = current ?? ensureProjectKnowledge(root);
  const stack = [profile.packageManager, ...Object.keys(profile.languages).slice(0, 4), ...profile.frameworks].filter(Boolean).join(", ");
  const commands = Object.entries(profile.commands).filter(([, command]) => command).map(([name, command]) => `${name}=${command}`).join("; ");
  const entries = profile.entrypoints.slice(0, 6).join(", ");
  const configKeys = new Set(contracts.config.map((item) => item.name)).size;
  const contractParts = [
    contracts.routes.length ? `${contracts.routes.length} routes` : "",
    configKeys ? `${configKeys} config keys (${contracts.config.length} references)` : "",
    contracts.data.length ? `${contracts.data.length} data models/tables` : "",
    contracts.ci.length ? `${contracts.ci.length} CI artifacts` : "",
    contracts.deploy.length ? `${contracts.deploy.length} deploy artifacts` : "",
  ].filter(Boolean);
  const facts = [
    stack || entries ? [stack ? `Stack: ${stack}.` : "", entries ? `Entrypoints: ${entries}.` : ""].filter(Boolean).join(" ") : "",
    commands ? `Commands: ${commands}.` : "",
    ...((profile.subProjects ?? []).length
      ? [
          `Sub-projects with their own manifest — the Stack/Entrypoints/Commands above describe the workspace ROOT only, ` +
            `so for work inside one of these, read its manifest instead of trusting that line: ` +
            (profile.subProjects ?? []).map((item) => `${item.dir} (${item.manifest})`).join(", "),
        ]
      : []),
    modules.modules.length ? `Modules: ${modules.modules.length} source files across ${modules.boundaries.length} boundaries.` : "",
    contractParts.length ? `Runtime contracts: ${contractParts.join(", ")}.` : "",
    tests.testFiles.length
      ? `Tests: ${tests.testFiles.length} files; ${Object.keys(tests.bySource).length} source files mapped. Use ProjectKnowledge(action:"tests", path:"...") for details.`
      : "",
  ].filter(Boolean);
  if (!facts.length) return "";
  return [
    `Generated from the current workspace: rebuildable facts, not long-term memory. ProjectKnowledge(action:"status") shows the source fingerprint, ProjectKnowledge(action:"health") the verification history.`,
    ...facts,
  ].join("\n");
}

// 易变的两行：只进工具的现查结果与知识状态接口，不进 system prompt（见上）。
export function renderProjectKnowledgeVolatile(current: ProjectKnowledge): string {
  const { profile, health } = current;
  return [
    `Source fingerprint ${profile.sourceFingerprint.slice(0, 12)}.`,
    `Health: ${health.verifications.length} verification records${health.lastPassingVerification ? `; last pass ${health.lastPassingVerification.at}` : "; no passing verification recorded"}.`,
  ].join("\n");
}

export function findTestsForPath(knowledge: ProjectKnowledge, query: string): Array<{ source: string; references: TestReference[] }> {
  const normalized = slash(query).replace(/^\.\//, "").toLowerCase();
  return Object.entries(knowledge.tests.bySource)
    .filter(([source]) => source.toLowerCase() === normalized || source.toLowerCase().includes(normalized) || path.basename(source).toLowerCase() === path.basename(normalized).toLowerCase())
    .map(([source, references]) => ({ source, references }));
}
