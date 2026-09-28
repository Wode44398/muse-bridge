// C6（G2、K24、N29、X53、G3）：AGENTS.md 兼容 + 子 agent 继承项目指令。
//
// 修前：dimensio 只读工作区根的 GUIDE.md——只有 AGENTS.md / CLAUDE.md 的仓库里读不到任何项目约定；派出去的子 agent、
// Workflow worker 连 GUIDE 都不知道。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { systemPrompt } from "./agent/prompt.ts";
import { makeSubAgentRunner } from "./agent/subagent.ts";
import { inheritedInstructions, readProjectDocs } from "./project-docs.ts";
import { Sandbox } from "./sandbox.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";

function repo(t: TestContext): { above: string; top: string } {
  const above = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-c6-"));
  t.after(() => fs.rmSync(above, { recursive: true, force: true }));
  const top = path.join(above, "repo");
  fs.mkdirSync(path.join(top, ".git"), { recursive: true });
  fs.mkdirSync(path.join(top, "pkg", "app"), { recursive: true });
  fs.writeFileSync(path.join(above, "AGENTS.md"), "ABOVE-THE-REPO\n"); // git 根之上：不收
  fs.writeFileSync(path.join(top, "AGENTS.md"), "ROOT-RULES\n");
  fs.writeFileSync(path.join(top, "CLAUDE.md"), "ROOT-CLAUDE-DUPLICATE\n"); // 同一层已有 AGENTS.md：不取
  fs.writeFileSync(path.join(top, "pkg", "CLAUDE.md"), "PKG-CLAUDE\n"); // 这一层只有 CLAUDE.md：取它
  return { above, top };
}

test("C6: collects from the git root down, one file per level (AGENTS.md over CLAUDE.md), nearest last, sources labeled", (t) => {
  const { top } = repo(t);
  const ws = path.join(top, "pkg", "app");
  const docs = readProjectDocs(ws, { installRoot: null }) ?? "";
  assert.match(docs, /<file path="AGENTS.md">\nROOT-RULES\n<\/file>/);
  assert.match(docs, /<file path="pkg\/CLAUDE.md">\nPKG-CLAUDE\n<\/file>/);
  assert.ok(docs.indexOf("ROOT-RULES") < docs.indexOf("PKG-CLAUDE"), "离工作区最近的排在最后");
  assert.ok(!docs.includes("ROOT-CLAUDE-DUPLICATE"), "每层只取第一个命中");
  assert.ok(!docs.includes("ABOVE-THE-REPO"), "git 根之上不收");
  // AGENTS.override.md 在这一层压过别的
  fs.writeFileSync(path.join(top, "pkg", "AGENTS.override.md"), "PKG-OVERRIDE\n");
  const again = readProjectDocs(ws, { installRoot: null }) ?? "";
  assert.ok(again.includes("PKG-OVERRIDE") && !again.includes("PKG-CLAUDE"));
  // 没有任何指令文件：不注入
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-c6-bare-"));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  assert.equal(readProjectDocs(bare, { installRoot: null }), undefined);
});

test("C6: a read error keeps the last good content (a deleted file drops out); the install-tree default workspace loads nothing", (t) => {
  const { top } = repo(t);
  const ws = path.join(top, "pkg", "app");
  assert.ok(readProjectDocs(ws, { installRoot: null })?.includes("ROOT-RULES"));
  // 读失败（这里用「同名的变成了目录」模拟占用之类的错误，不是「不存在」）：沿用上次读到的
  fs.rmSync(path.join(top, "AGENTS.md"));
  fs.mkdirSync(path.join(top, "AGENTS.md"));
  assert.ok(readProjectDocs(ws, { installRoot: null })?.includes("ROOT-RULES"), "偶发读错误不让整段消失");
  // 真的删掉了：这一层退到下一个候选（CLAUDE.md）
  fs.rmdirSync(path.join(top, "AGENTS.md"));
  const now = readProjectDocs(ws, { installRoot: null }) ?? "";
  assert.ok(!now.includes("ROOT-RULES") && now.includes("ROOT-CLAUDE-DUPLICATE"));

  // N29：会话落在回退选出的默认工作区、而它又在 dimensio 自己的安装仓库里 → 不加载（那份 AGENTS.md 是写给开发 dimensio 的）
  assert.equal(readProjectDocs(ws, { installRoot: top, defaultWorkspace: ws }), undefined);
  assert.ok(readProjectDocs(ws, { installRoot: top, defaultWorkspace: path.join(top, "elsewhere") }), "用户自己打开这个仓库当项目：照常加载");
});

test("C6: the main prompt frames it as project data under the GUIDE; sub-agents inherit both", async (t) => {
  const prompt = systemPrompt({
    root: "/ws", shell: "bash", platform: "linux", provider: "openai", model: "m",
    projectDocs: '<file path="AGENTS.md">\nUSE-PNPM\n</file>', guide: "GUIDE-WINS",
  });
  const agents = prompt.indexOf("## Project instructions (AGENTS.md)");
  assert.ok(agents > 0);
  assert.match(prompt, /project-provided reference data/);
  assert.match(prompt, /memory files or memory directories do not apply to you/);
  assert.ok(agents < prompt.indexOf("## Project guide (GUIDE.md)"), "GUIDE 排在后面、冲突时赢");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-c6-sub-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = scripted(t).next(say("done"));
  const run = makeSubAgentRunner(
    {
      provider: "openai", apiKey: "FAKE-KEY", model: "fake", thinking: "off", sandbox: new Sandbox(root),
      limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
      projectInstructions: () => inheritedInstructions('<file path="AGENTS.md">\nUSE-PNPM\n</file>', "GUIDE-WINS"),
    },
    () => adapter,
  );
  const r = await run({ prompt: "look around" });
  assert.equal(r.ok, true);
  const system = JSON.stringify(adapter.lastInput().system);
  assert.ok(system.includes("USE-PNPM") && system.includes("GUIDE-WINS"), "子 agent 的 system prompt 里带着项目指令");
  assert.ok(system.includes("Project instructions (AGENTS.md)") && system.includes("Project guide (GUIDE.md)"));
});
