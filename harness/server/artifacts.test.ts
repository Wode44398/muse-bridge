import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attachAssistantArtifacts, referencedPaths } from "./artifacts.ts";
import { Sandbox } from "./sandbox.ts";
import type { Msg } from "./agent/turn.ts";
import { writeTool } from "./tools/write.ts";
import type { ToolContext } from "./tools/types.ts";

test("referencedPaths reads links, code spans, and bare deliverables", () => {
  assert.deepEqual(
    referencedPaths("完成：[报告](reports/final report.pdf)，另见 `notes/总结.md` 和 data/result.csv。"),
    ["reports/final report.pdf", "notes/总结.md", "data/result.csv"],
  );
});

test("assistant artifacts are real, deduplicated, and attached to the final message", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-artifacts-"));
  try {
    fs.mkdirSync(path.join(root, "reports"));
    fs.writeFileSync(path.join(root, "reports", "summary.md"), "# result\n", "utf8");
    fs.writeFileSync(path.join(root, "source.ts"), "export {};\n", "utf8");
    const messages: Msg[] = [
      { role: "user", content: [{ t: "text", text: "make a report" }] },
      {
        role: "assistant",
        content: [{ t: "text", text: "报告已完成：`reports/summary.md`；实现改动见 `source.ts`；missing.pdf 没有生成。" }],
      },
    ];
    const artifacts = attachAssistantArtifacts(messages, new Sandbox(root), [
      path.join(root, "reports", "summary.md"),
    ]);
    assert.deepEqual(artifacts.map((item) => ({ path: item.path, name: item.name, kind: item.kind })), [
      { path: "reports/summary.md", name: "summary.md", kind: "text" },
    ]);
    assert.equal(messages[1].artifacts?.[0].size, 9);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Write marks only a newly created file as an artifact candidate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-created-"));
  try {
    const ctx: ToolContext = {
      sandbox: new Sandbox(root),
      readFileState: new Map(),
      setTodos: () => {},
      limits: { bashTimeoutMs: 1_000, bashMaxTimeoutMs: 1_000 },
      agentSeesImages: false,
    };
    const first = await writeTool.run({ path: "result.js", content: "export default 1;\n" }, ctx);
    assert.deepEqual(first.createdFiles, ["result.js"]);
    const second = await writeTool.run({ path: "result.js", content: "export default 2;\n" }, ctx);
    assert.equal(second.createdFiles, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
