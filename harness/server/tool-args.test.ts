// 工具入参的别名与缺参提示（agent/tool-input.ts + tools/arg-aliases.ts）。
// 修前：别名表（profile.tools.pathAliases）为空且没人读——按主流 harness 的习惯写 Read({file_path}) 会去读一个叫 "undefined"
// 的文件；Grep 的 output_mode、Bash 的 run_in_background 原样被丢掉；必填参数缺了由各工具各报一句含糊的错。
// 修后：执行前按各工具自带的别名表归一成规范名（转录里留原话），读转录的地方经 toolArg 对别名同样成立；缺必填时不执行，
// 回一句照着就能改的话。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { missingArgsText, missingRequired, normalizeToolArgs, toolArg } from "./agent/tool-input.ts";
import { extractAnchors } from "./agent/compaction-shape.ts";
import { ARG_ALIASES } from "./tools/arg-aliases.ts";
import { readTool } from "./tools/read.ts";
import { grepTool } from "./tools/grep.ts";
import { bashTool } from "./tools/bash.ts";
import { skillTool } from "./tools/skill.ts";
import { agentTool } from "./tools/agent.ts";
import { editTool } from "./tools/edit.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { ok, type Tool } from "./tools/types.ts";
import type { Msg } from "./agent/turn.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
const tmp = (prefix: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};
const norm = (tool: Tool, args: Record<string, unknown>) => normalizeToolArgs(tool.def.parameters, args, tool.aliases).args;

test("别名归一：文件类 file_path / filePath / absolute_path / filename → path；规范名给了就以规范名为准", () => {
  for (const key of ["file_path", "filePath", "absolute_path", "filename"]) {
    assert.deepEqual(norm(readTool, { [key]: "a.txt", offset: "3" }), { path: "a.txt", offset: 3 }, key);
  }
  assert.deepEqual(norm(editTool, { file_path: "a.ts", old_str: "x", new_str: "y" }), { path: "a.ts", old_string: "x", new_string: "y" });
  assert.deepEqual(norm(readTool, { path: "real.txt", file_path: "other.txt" }), { path: "real.txt", file_path: "other.txt" });
});

test("别名归一：Grep 的 output_mode（连取值）、-i、-C、-A / -B；Bash 的 run_in_background；Skill 的 skill；Agent 的 description / subagent_type", () => {
  assert.deepEqual(norm(grepTool, { pattern: "x", output_mode: "files_with_matches", "-i": true, "-C": 2, "-n": true }), {
    pattern: "x",
    mode: "files",
    ignoreCase: true,
    context: 2,
    "-n": true,
  });
  assert.deepEqual(norm(grepTool, { pattern: "x", mode: "FILES_WITH_MATCHES", "-A": 3, "-B": 1 }), { pattern: "x", mode: "files", after: 3, before: 1 });
  assert.deepEqual(norm(bashTool, { command: "ls", run_in_background: true, description: "list" }), { command: "ls", background: true, description: "list" });
  assert.deepEqual(norm(skillTool, { skill: "pdf", args: "x" }), { name: "pdf", args: "x" });
  // subagent_type 是正式参数（类型名由 runner 解析：内置、别名 Explore / general-purpose、自定义类型）；改名前的 tools 是它的别名
  assert.deepEqual(norm(agentTool, { prompt: "p", description: "找入口", subagent_type: "Explore" }), { prompt: "p", label: "找入口", subagent_type: "Explore" });
  assert.deepEqual(norm(agentTool, { prompt: "p", tools: "coder" }), { prompt: "p", subagent_type: "coder" });
  assert.deepEqual(norm(agentTool, { task: "p", run_in_background: true, resume: "abc12345" }), { prompt: "p", background: true, id: "abc12345" });
});

test("toolArg：读转录时规范名优先、别名也认；压缩锚点抽取对 file_path 写法同样成立", () => {
  assert.equal(toolArg("Read", { file_path: "a.txt" }, "path"), "a.txt");
  assert.equal(toolArg("Read", { path: "b.txt", file_path: "a.txt" }, "path"), "b.txt");
  assert.equal(toolArg("Bash", { cmd: "ls" }, "command"), "ls");
  assert.equal(toolArg("Unknown", { file_path: "a" }, "path"), undefined);
  const msgs: Msg[] = [{ role: "assistant", content: [{ t: "tool_call", id: "e1", name: "Edit", args: { file_path: "src/x.ts", old_string: "a", new_string: "b" } }] }];
  assert.deepEqual(extractAnchors(msgs).files, ["src/x.ts"]);
  assert.ok(ARG_ALIASES.Read.file_path);
});

test("缺必填：说清缺哪个、这个工具认哪些、给了哪些、最像的是哪个", () => {
  const schema = readTool.def.parameters;
  assert.deepEqual(missingRequired(schema, { fil_path: "a" }), ["path"]);
  const text = missingArgsText("Read", schema, { fil_path: "a" }, ["path"]);
  assert.match(text, /Read was not run: missing required parameter "path"/);
  assert.match(text, /Read takes: path \(required\), offset, limit/);
  assert.match(text, /You passed: fil_path/);
  assert.match(text, /use "path" instead of "fil_path"/);
  assert.deepEqual(missingRequired(schema, { path: "a", extra: 1 }), [], "多余的未知参数不算错");
});

function probe(seen: Record<string, unknown>[], opts: Partial<Tool> = {}): Tool {
  return {
    effect: "read",
    concurrencySafe: true,
    def: { name: "Probe", description: "probe", parameters: { type: "object", properties: { path: { type: "string" }, mode: { type: "string" } }, required: ["path"] } },
    async run(args) {
      seen.push(args);
      return ok("probed", "ok");
    },
    ...opts,
  };
}

test("loop 里：Read({file_path}) 真读到文件，转录里留模型原话；缺必填不执行、照着提示重发就过", async (t) => {
  const root = tmp("dimensio-alias-");
  fs.writeFileSync(path.join(root, "notes.txt"), "hello alias\n");
  const seen: Record<string, unknown>[] = [];
  const adapter = scripted(t).next(
    calls(call("r1", "Read", { file_path: "notes.txt" }), call("p1", "Probe", { file: 1 })),
    (turn) => {
      const results = JSON.stringify(turn.messages.at(-1));
      assert.match(results, /hello alias/);
      assert.match(results, /Probe was not run: missing required parameter \\"path\\"/);
      return calls(call("p2", "Probe", { path: "x" }));
    },
    say("好了"),
  );
  const session = attachSession(adapter, root, { tools: [readTool, probe(seen)] });
  await send(session, "读一下");
  assert.deepEqual(seen, [{ path: "x" }], "缺参那次没执行");
  const raw = session.state!.messages.flatMap((m) => m.content).find((b) => b.t === "tool_call" && b.id === "r1");
  assert.deepEqual(raw && raw.t === "tool_call" ? raw.args : null, { file_path: "notes.txt" });
});

test("必填随动作而变的工具（looseRequired）不被 loop 拦，交给工具自己报；档案 pathAliases 叠在工具别名表下面", async (t) => {
  const seen: Record<string, unknown>[] = [];
  const adapter = scripted(t).next(calls(call("p1", "Probe", { mode: "x" }), call("p2", "Probe", { target: "t.txt" })), say("好了"));
  const session = attachSession(adapter, tmp("dimensio-loose-"), { tools: [probe(seen, { looseRequired: true })] });
  session.state!.profile.tools.pathAliases = { target: "path" };
  await send(session, "跑");
  assert.deepEqual(seen, [{ mode: "x" }, { path: "t.txt" }]);
});
