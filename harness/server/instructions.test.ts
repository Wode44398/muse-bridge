// Q10（F12）：指令引用存在性自检。AGENTS.md 这类指令文件最常见的腐烂是「引用的文件已经不在了」——kimi、hermes 的
// 根指令文件都有过悬空引用。这里把 harness/AGENTS.md 与仓库根 AGENTS.md 里反引号引用的仓库内路径逐个核对：
// 相对指令文件所在目录找，找不到再相对仓库根找。只认看起来是仓库路径的（server/、web/、scripts/…开头），
// `.env` 这类举例用的名字不查。U10（E6）：设计规格 harness/DESIGN.md 每条带源码出处，一并核对。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const HARNESS = path.dirname(import.meta.dirname);
const REPO = path.dirname(HARNESS);
const DOCS = [path.join(HARNESS, "AGENTS.md"), path.join(REPO, "AGENTS.md"), path.join(HARNESS, "DESIGN.md")];
const REPO_PATH = /^(?:server|web|scripts|docs|public|src|harness|test-harness|memory|evals)\/[^\s`]*$/;
// 构建产物（gitignore 掉的）：全新 checkout 里本来就没有，指令里提到它们不算悬空（09-25 合回 main 时在全新集成 worktree 里误报过）
const BUILD_OUTPUTS = ["public/app", "web/dist", "harness/web/dist"];

function referencedPaths(doc: string): string[] {
  const text = fs.readFileSync(doc, "utf8");
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter((p) => REPO_PATH.test(p));
}

test("Q10 指令引用存在性：两份 AGENTS.md 与 DESIGN.md 里引用的仓库路径都真实存在", () => {
  const missing: string[] = [];
  let checked = 0;
  for (const doc of DOCS) {
    for (const ref of referencedPaths(doc)) {
      checked++;
      const clean = ref.replace(/[:#].*$/, "");
      if (BUILD_OUTPUTS.some((out) => clean === out || clean.startsWith(`${out}/`))) continue;
      if (![path.dirname(doc), REPO].some((base) => fs.existsSync(path.join(base, clean)))) {
        missing.push(`${path.relative(REPO, doc)}: \`${ref}\``);
      }
    }
  }
  assert.deepEqual(missing, [], "指令文件里引用的路径不存在了——改指令，或者把文件找回来");
  assert.ok(checked >= 10, `只核对到 ${checked} 处引用，提取规则可能坏了`);
});
