// 验证门禁的「Bash 改过哪些文件」只记落点确定的写目标；变量拼出来的路径照样进 writes（路径规则按最坏情况管），
// 但不进 edits——2026-09-30 MiMo 会话里 `cp 成品.html "$OUT/zh_check.html"` 被记成工作区里的 `$OUT/zh_check.html`，
// 已验过的一轮又被门禁追问了一次。
import assert from "node:assert/strict";
import test from "node:test";
import { shellTouches } from "./tools/shell-policy.ts";
import { parseShell } from "./tools/shell-words.ts";

const touches = (cmd: string) => shellTouches(parseShell(cmd));

test("变量拼出来的写目标：进 writes、不进门禁的 edits", () => {
  const t = touches('OUT="C:/tmp/x"; cp "out/a.html" "$OUT/zh_check.html"; echo hi > "$OUT/log.txt"');
  assert.ok(t.writes.includes("$OUT/zh_check.html") && t.writes.includes("$OUT/log.txt"), JSON.stringify(t.writes));
  assert.deepEqual(t.edits, []);
});

test("落点确定的写目标照记", () => {
  assert.deepEqual(touches('cp a.html "dist/b.html" && echo x > notes.txt').edits.sort(), ["dist/b.html", "notes.txt"]);
  assert.deepEqual(touches("sed -i 's/a/b/' src/app.ts").edits, ["src/app.ts"]);
});
