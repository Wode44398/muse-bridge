// 项目指令文件（m 线）：@导入、预算随窗口放宽并从最远的层截、子目录的指令文件按需加载。
//
// 修前：同层只取 AGENTS.override.md / AGENTS.md / CLAUDE.md 里第一个；合计 16,000 字符硬截断；不支持 @import；子目录的不读。
// 修后：Claude Code 式的 `@路径` 导入（代码块与行内代码里的不算，最多 5 层，只许仓库内与用户主目录下的文本文件，凭据类路径拒）；
// 预算随窗口放宽（有上限），超了从离工作区最远的层开始截、写明截了什么与文件在哪；模型第一次读 / 改某个子目录里的文件时，
// 那个子目录还没加载过的指令文件作为一条 harness 消息追加（登记为 project-doc，同一会话每层只一次，压缩后回填只列路径、不重复注入）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { messageKind } from "./agent/injections.ts";
import { priorRestore, renderRestore, RESTORE_KIND } from "./agent/compaction-restore.ts";
import type { Msg } from "./agent/turn.ts";
import { projectDocsBudget, readProjectDocs } from "./project-docs.ts";
import { collectImports, importRefs, MAX_IMPORT_DEPTH } from "./project-docs/imports.ts";
import { loadedDocDirs, loadedDocSummary, pendingDocs, PROJECT_DOC_KIND } from "./project-docs/subdir.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { readTool } from "./tools/read.ts";
import { customProvidersDir, memoryRoot } from "./paths.ts";

function repo(t: TestContext): string {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-m-docs-"));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  fs.mkdirSync(path.join(top, ".git"));
  return top;
}
const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

test("m @导入：独占一行与行内的都算，代码块与行内代码里的不算；相对写它的文件解析；同一个文件只收一次", (t) => {
  assert.deepEqual(importRefs("See @docs/style.md and (@./a.md).\n```\n@not/this.md\n```\nuse `@types/node` here\nmail me@example.com"), ["docs/style.md", "./a.md"]);
  const top = repo(t);
  write(path.join(top, "AGENTS.md"), "ROOT-RULES\n@docs/style.md\n\n```sh\n@docs/ignored.md\n```\n");
  write(path.join(top, "docs", "style.md"), "STYLE-GUIDE\nalso @./naming.md\n");
  write(path.join(top, "docs", "naming.md"), "NAMING-RULES\nback to @style.md\n");
  write(path.join(top, "docs", "ignored.md"), "IGNORED-IN-FENCE\n");
  const docs = readProjectDocs(top, { installRoot: null }) ?? "";
  assert.match(docs, /<file path="AGENTS.md">\nROOT-RULES/);
  assert.match(docs, /<file path="docs\/style.md" imported-by="AGENTS.md">\nSTYLE-GUIDE/);
  assert.match(docs, /<file path="docs\/naming.md" imported-by="docs\/style.md">\nNAMING-RULES/, "按导入它的文件所在目录解析");
  assert.equal((docs.match(/STYLE-GUIDE/g) ?? []).length, 1, "互相导入不重复、不死循环");
  assert.ok(!docs.includes("IGNORED-IN-FENCE"), "代码块里的 @ 不算");
});

test("m @导入：最多 5 层；凭据类文件、仓库与主目录之外的、二进制的都不收", (t) => {
  const top = repo(t);
  // 一条 7 层的链：只收到第 5 层
  write(path.join(top, "AGENTS.md"), "ROOT\n@l1.md\n@.env\n@blob.bin\n");
  for (let i = 1; i <= 7; i++) write(path.join(top, `l${i}.md`), `LEVEL-${i}\n@l${i + 1}.md\n`);
  write(path.join(top, ".env"), "API_TOKEN=FAKE-not-a-real-token\n");
  fs.writeFileSync(path.join(top, "blob.bin"), Buffer.from([0x41, 0x00, 0x42]));
  const docs = readProjectDocs(top, { installRoot: null }) ?? "";
  for (let i = 1; i <= MAX_IMPORT_DEPTH; i++) assert.ok(docs.includes(`LEVEL-${i}`), `第 ${i} 层`);
  assert.ok(!docs.includes(`LEVEL-${MAX_IMPORT_DEPTH + 1}`), "超过 5 层的不收");
  assert.ok(!docs.includes("FAKE-not-a-real-token"), "凭据类路径照沙箱规则拒");
  assert.ok(!docs.includes(`<file path="blob.bin"`), "二进制不收");
  assert.ok(!docs.includes(`<file path=".env"`));

  // 仓库之外、也不在用户主目录下的文件
  const outside = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "win.ini") : "/etc/hostname";
  if (fs.existsSync(outside) && path.relative(os.homedir(), outside).startsWith("..")) {
    write(path.join(top, "AGENTS.md"), `ROOT\n@${outside}\n`);
    const again = readProjectDocs(top, { installRoot: null }) ?? "";
    assert.ok(!again.includes("imported-by"), "仓库与主目录之外的不收");
  }
});

test("m 预算随窗口放宽（有上下限）；超了从离工作区最远的层开始截，写明截了什么、文件在哪", (t) => {
  assert.equal(projectDocsBudget(undefined), 16_000);
  assert.equal(projectDocsBudget(200_000), 40_000);
  assert.equal(projectDocsBudget(2_000_000), 64_000, "有上限");
  const top = repo(t);
  const ws = path.join(top, "pkg");
  write(path.join(top, "AGENTS.md"), `FAR-START\n${"far rule line.\n".repeat(3000)}FAR-END\n`);
  write(path.join(ws, "AGENTS.md"), "NEAR-RULES\n");
  const docs = readProjectDocs(ws, { installRoot: null, contextWindow: 100_000 }) ?? "";
  assert.ok(docs.length <= projectDocsBudget(100_000) + 200, `在预算内（${docs.length}）`);
  assert.match(docs, /<file path="pkg\/AGENTS.md">\nNEAR-RULES/, "离工作区最近的整份留下");
  assert.match(docs, /FAR-START/);
  assert.ok(!docs.includes("FAR-END"), "最远的那层被截短");
  assert.match(docs, /\[… truncated: \d+ of \d+ characters of AGENTS\.md shown — Read .*AGENTS\.md for the rest\]/);
});

test("m 子目录的指令文件：第一次读到那个目录的文件时追加一次（登记为 project-doc），同一会话不重复；依赖目录不跟", async (t) => {
  const adapter = scripted(t).next(
    useTool("r1", "Read", { path: "pkg/a.ts" }),
    useTool("r2", "Read", { path: "pkg/b.ts" }),
    useTool("r3", "Read", { path: "node_modules/dep/index.js" }),
    say("看完了"),
  );
  const { state, root } = loopState(t, adapter, { tools: [readTool], user: "看看 pkg 里的代码" });
  fs.mkdirSync(path.join(root, ".git"));
  write(path.join(root, "AGENTS.md"), "ROOT-RULES\n");
  write(path.join(root, "pkg", "AGENTS.md"), "PKG-RULES: tabs, not spaces\n");
  write(path.join(root, "pkg", "CLAUDE.md"), "See AGENTS.md.\n");
  write(path.join(root, "pkg", "a.ts"), "export const a = 1;\n");
  write(path.join(root, "pkg", "b.ts"), "export const b = 2;\n");
  write(path.join(root, "node_modules", "dep", "AGENTS.md"), "DEP-RULES\n");
  write(path.join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  await drive(state, adapter);

  const docs = state.messages.filter((m) => messageKind(m) === PROJECT_DOC_KIND);
  assert.equal(docs.length, 1, "pkg 只加载一次，根目录那层在 system 里、不在这里，依赖目录不跟");
  const body = docs[0].content.map((b) => (b.t === "text" ? b.text : "")).join("");
  assert.match(body, /^\[Project instructions: pkg\/\] This directory has its own instruction file/);
  assert.match(body, /PKG-RULES: tabs, not spaces/);
  assert.ok(!body.includes("See AGENTS.md"), "只是指向 AGENTS.md 的 CLAUDE.md 不重复");
  assert.ok(!body.includes("ROOT-RULES") && !body.includes("DEP-RULES"));
  const at = state.messages.indexOf(docs[0]);
  assert.ok(state.messages[at - 1].content.some((b) => b.t === "tool_result"), "紧跟在那批工具结果后面");
  assert.ok(adapter.inputs[1].messages.some((m) => m.content.some((b) => b.t === "text" && b.text.startsWith("[Project instructions: pkg/]"))), "下一次请求就带着");
});

test("m 子目录的指令文件：压缩后回填只列路径，按需加载认它为已加载、不再整段注入", (t) => {
  const root = repo(t);
  write(path.join(root, "pkg", "AGENTS.md"), "PKG-RULES\n");
  const file = path.join(root, "pkg", "a.ts");
  const [first] = pendingDocs(root, [file], new Set());
  assert.equal(first.dir, "pkg");
  const loaded: Msg = { role: "user", origin: "harness", kind: PROJECT_DOC_KIND, content: [{ t: "text", text: first.text }] };
  assert.deepEqual([...loadedDocDirs([loaded])], ["pkg"]);
  const summary = loadedDocSummary([loaded]);
  assert.deepEqual(summary, ["- pkg/ (AGENTS.md)"]);

  // 压缩：那条消息被摘要掉，回填里列着它
  const restore = renderRestore({ todos: "", plan: "", jobs: "", files: [], docs: summary })!;
  assert.equal(restore.kind, RESTORE_KIND);
  const restoreText = restore.content.map((b) => (b.t === "text" ? b.text : "")).join("");
  assert.match(restoreText, /## Directory instruction files loaded earlier\n.*\n- pkg\/ \(AGENTS\.md\)/);
  assert.ok(!restoreText.includes("PKG-RULES"), "回填不带原文");
  assert.deepEqual([...loadedDocDirs([restore])], ["pkg"]);
  assert.deepEqual(pendingDocs(root, [file], loadedDocDirs([restore])), [], "压缩后不重复整段注入");
  assert.deepEqual(loadedDocSummary([restore]), summary, "再压缩一次也接得上");
});

// 审查修复：@导入与子目录指令文件经符号链接 / junction 指到别处时，按真实落点再判一次范围与凭据
test("m @导入：经 junction / 符号链接指到凭据目录的不收；指令文件本身是这种链接也不读", (t) => {
  const top = repo(t);
  const secretDir = customProvidersDir();
  fs.mkdirSync(secretDir, { recursive: true });
  const secret = path.join(secretDir, "providers.json");
  const hadSecret = fs.existsSync(secret);
  if (!hadSecret) fs.writeFileSync(secret, '{"key":"FAKE_SECRET_KEY_DUMMY"}\n');
  t.after(() => {
    if (!hadSecret) fs.rmSync(secret, { force: true });
  });
  fs.symlinkSync(secretDir, path.join(top, "link"), "junction");
  write(path.join(top, "AGENTS.md"), "ROOT-RULES\n@link/providers.json\n");
  const docs = readProjectDocs(top, { installRoot: null }) ?? "";
  assert.match(docs, /ROOT-RULES/);
  assert.ok(!docs.includes("FAKE_SECRET_KEY_DUMMY"), "经 junction 的凭据文件不进提示词");
  assert.ok(!docs.includes("imported-by"));

  // 子目录本身是指向凭据目录的 junction、里面恰好有个 AGENTS.md：不读
  const agentsThere = path.join(secretDir, "AGENTS.md");
  fs.writeFileSync(agentsThere, "FAKE_SECRET_AGENTS_DUMMY\n");
  t.after(() => fs.rmSync(agentsThere, { force: true }));
  assert.deepEqual(pendingDocs(top, [path.join(top, "link", "x.ts")], new Set()), [], "真实落点是凭据目录的指令文件不加载");

  // 仓库里正常的链接（CLAUDE.md → 同仓库的 AGENTS.md）照常
  const ok = repo(t);
  write(path.join(ok, "docs", "rules.md"), "LINKED-RULES\n");
  fs.symlinkSync(path.join(ok, "docs"), path.join(ok, "d"), "junction");
  write(path.join(ok, "AGENTS.md"), "ROOT\n@d/rules.md\n");
  assert.match(readProjectDocs(ok, { installRoot: null }) ?? "", /LINKED-RULES/, "落点仍在仓库里的链接照收");
});

test("m 同层 AGENTS.md 与 CLAUDE.md：只有纯指针才去重，指针行之外还有规则的两份都收", (t) => {
  const top = repo(t);
  write(path.join(top, "AGENTS.md"), "Run npm test before committing.\n");
  write(path.join(top, "CLAUDE.md"), "# 项目说明\n先读 AGENTS.md。\n所有输出一律用简体中文。不许直接推 main 分支，先开 PR。\n");
  const docs = readProjectDocs(top, { installRoot: null }) ?? "";
  assert.match(docs, /Run npm test before committing/);
  assert.match(docs, /所有输出一律用简体中文/, "带实质规则的 CLAUDE.md 不能当指针丢掉");
  assert.match(docs, /不许直接推 main/);

  // 纯指针（标题 + 一句引导语）照旧只留 AGENTS.md
  write(path.join(top, "CLAUDE.md"), "# Claude\n先读 @AGENTS.md。\n");
  const again = readProjectDocs(top, { installRoot: null }) ?? "";
  assert.ok(!again.includes("<file path=\"CLAUDE.md\">"), "纯指针不重复");
  // 指针行里夹着规则的也不算纯指针
  write(path.join(top, "CLAUDE.md"), "See AGENTS.md. Always answer in Chinese and never push to main without a review.\n");
  assert.match(readProjectDocs(top, { installRoot: null }) ?? "", /never push to main/);
});

// 收口：仓库外的导入（哪怕在用户主目录下）、dimensio 自己的数据（别的工作区的记忆等）一律不收
test("收口 @导入：只收仓库内的；仓库外的兄弟目录、dimensio 的记忆目录都不收", (t) => {
  const top = repo(t);
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-m-docs-sibling-"));
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }));
  write(path.join(sibling, "notes.md"), "SIBLING-PROJECT-SECRET\n");
  write(path.join(top, "AGENTS.md"), `ROOT\n@../${path.basename(sibling)}/notes.md\n@${path.join(sibling, "notes.md")}\n`);
  const docs = readProjectDocs(top, { installRoot: null }) ?? "";
  assert.match(docs, /ROOT/);
  assert.ok(!docs.includes("SIBLING-PROJECT-SECRET"), "仓库外（主目录下）的不收");

  // 仓库就是 harness 所在的仓库（记忆根在仓库里）：别的工作区的记忆笔记照样不收
  const memTop = path.dirname(memoryRoot());
  const other = path.join(memoryRoot(), "workspaces", `other-${Date.now()}`);
  write(path.join(other, "plan.md"), "OTHER-WORKSPACE-NOTE\n");
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const rel = path.relative(memTop, path.join(other, "plan.md")).split(path.sep).join("/");
  const got = collectImports(path.join(memTop, "AGENTS.md"), `@${rel}\n`, memTop, new Set());
  assert.deepEqual(got.map((i) => i.text), [], "dimensio 的记忆目录不收");
});

test("收口 @导入：被导入的文件按会话快照——它在会话里改了，项目指令一节不跟着变；指令文件本身改了照常变", (t) => {
  const top = repo(t);
  write(path.join(top, "CLAUDE.md"), "Read @README.md and @package.json first.\n");
  write(path.join(top, "README.md"), "README-V1\n");
  write(path.join(top, "package.json"), '{"name":"x","dependencies":{}}\n');
  const cache = new Map<string, string>();
  const first = readProjectDocs(top, { installRoot: null, importCache: cache }) ?? "";
  assert.match(first, /README-V1/);
  write(path.join(top, "package.json"), '{"name":"x","dependencies":{"left-pad":"1.0.0"}}\n');
  write(path.join(top, "README.md"), "README-V2\n");
  assert.equal(readProjectDocs(top, { installRoot: null, importCache: cache }), first, "导入文件改了：同一份（World State 令牌不变）");
  assert.match(readProjectDocs(top, { installRoot: null }) ?? "", /README-V2/, "不带快照就是现读");
  write(path.join(top, "CLAUDE.md"), "Read @README.md and @package.json first. Use tabs.\n");
  const changed = readProjectDocs(top, { installRoot: null, importCache: cache }) ?? "";
  assert.match(changed, /Use tabs/, "指令文件本身改了照常变");
  assert.match(changed, /README-V1/, "导入的仍是快照");
  cache.clear(); // 压缩重建 system 时清空
  assert.match(readProjectDocs(top, { installRoot: null, importCache: cache }) ?? "", /README-V2/);
});

test("收口 回填：plan 模式下计划后面紧跟目录指令文件一节，反复压缩时计划原文不变、目录指令一节只出现一次", () => {
  const plan = "Step 1: do A\nStep 2: do B";
  const docs = ["- pkg/sub/ (AGENTS.md)"];
  const first = renderRestore({ todos: "", plan, jobs: "", files: [], docs })!;
  assert.equal(priorRestore([first]).plan, plan, "上一条回填拆回来的计划不夹着目录指令一节");
  const second = renderRestore({ todos: "", plan: priorRestore([first]).plan, jobs: "", files: [], docs: loadedDocSummary([first]) })!;
  const text = second.content.map((b) => (b.t === "text" ? b.text : "")).join("");
  assert.equal((text.match(/## Directory instruction files loaded earlier/g) ?? []).length, 1);
  assert.equal(priorRestore([second]).plan, plan);
});
