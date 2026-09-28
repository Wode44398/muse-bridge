// Q7（X46）：tsc 进 npm test、单用例超时、收尾检查受控文件不变（test-global.ts）。
// 行为测试是嵌套跑一次真的 node --test（带同一个 --test-global-setup）：夹具测试往 harness/ 写受控文件、往生产
// 数据目录放测试桶，整次运行必须判失败并点名；干净的一次必须通过，且顺手清掉过期的测试临时目录。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Q7 npm test：先过 tsc，带全局收尾检查与单用例超时", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(harnessRoot, "package.json"), "utf8"));
  const script: string = pkg.scripts.test;
  assert.match(script, /^tsc --noEmit && /, "类型检查必须在测试之前、失败即停");
  assert.match(script, /--test-global-setup=\.\/server\/test-global\.ts/);
  assert.match(script, /--test-timeout=\d+/);
  assert.match(script, /--import \.\/server\/test-setup\.ts/);
});

function nestedRun(fixtureBody: string): { status: number | null; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-q7-nested-"));
  try {
    const file = path.join(dir, "fixture.test.mjs");
    fs.writeFileSync(file, `import test from "node:test";\nimport fs from "node:fs";\nimport path from "node:path";\n${fixtureBody}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // 否则嵌套的 runner 会把自己当成子进程、按机器格式往外报
    const r = spawnSync(process.execPath, ["--test-global-setup=./server/test-global.ts", "--test", file], {
      cwd: harnessRoot,
      env,
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
    });
    return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("Q7 收尾检查：测试写了受控文件、往生产数据目录放了测试桶——整次运行判失败并点名", { timeout: 150_000 }, () => {
  const tag = randomBytes(3).toString("hex"); // 恰好 6 位，和 mkdtemp 的随机后缀同形
  const probeFile = path.join(harnessRoot, `q7-probe-${tag}.txt`);
  const probeBucket = path.join(harnessRoot, "memory", "workspaces", `dimensio-q7-probe-${tag}-0123456789`);
  try {
    const r = nestedRun(`
      test("写到不该写的地方", () => {
        fs.writeFileSync(${JSON.stringify(probeFile)}, "written by a test\\n");
        fs.mkdirSync(${JSON.stringify(probeBucket)}, { recursive: true });
      });`);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /测试改动了受控文件或生产数据目录/);
    assert.match(r.output, new RegExp(`q7-probe-${tag}\\.txt`));
    assert.match(r.output, new RegExp(`dimensio-q7-probe-${tag}`));
  } finally {
    fs.rmSync(probeFile, { force: true });
    fs.rmSync(probeBucket, { recursive: true, force: true });
  }
});

test("Q7 干净的一次照常通过；开跑前清掉 24 小时前留下的测试临时目录，新的与生产固定目录不动", { timeout: 150_000 }, () => {
  const tmp = os.tmpdir();
  const tag = randomBytes(3).toString("hex"); // 恰好 6 位，和 mkdtemp 的随机后缀同形
  const stale = path.join(tmp, `dimensio-q7sweep-${tag}`);
  const fresh = path.join(tmp, `dimensio-q7fresh-${tag}`);
  const named = path.join(tmp, `dimensio-q7named${tag}`); // 没有 mkdtemp 的 6 位随机后缀：不是测试夹具，不动
  for (const d of [stale, fresh, named]) fs.mkdirSync(d, { recursive: true });
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(named, twoDaysAgo, twoDaysAgo);
  try {
    const r = nestedRun(`test("什么都不写", () => {});`);
    assert.equal(r.status, 0, r.output);
    assert.doesNotMatch(r.output, /测试改动了受控文件/);
    assert.equal(fs.existsSync(stale), false, "24 小时前的测试临时目录应当被清掉");
    assert.equal(fs.existsSync(fresh), true, "新的不动（可能是另一场正在跑的测试）");
    assert.equal(fs.existsSync(named), true, "名字不像测试夹具的不动");
  } finally {
    for (const d of [stale, fresh, named]) fs.rmSync(d, { recursive: true, force: true });
  }
});
