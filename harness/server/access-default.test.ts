// 访问范围默认整机（09-26 的产品决定：新会话默认可访问整机）。
//
// 修前：新会话默认「仅工作空间」（只有 SANDBOX_ACCESS=full 才整机），而且选过的访问范围不落盘——档位菜单 / 设置页切成整机，
// harness 一重启新对话又回到仅工作空间，得一次次重新选。
// 修后：没选过就是整机（SANDBOX_ACCESS=workspace 才默认只给工作空间）；选过的记进 runtime-config.json，重启后照旧。
// 旧会话记录里没有 access 字段的仍按仅工作空间（那是它们当时的默认），不在这里改。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configWritesSettled, getConfig, setConfig } from "./config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const setup = pathToFileURL(path.join(here, "test-setup.ts")).href;
const configUrl = pathToFileURL(path.join(here, "config.ts")).href;
const dirs: string[] = [];
after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

// 新起一个进程加载 config.ts（配置在加载时定下），读它起来时的 access
function bootAccess(saved: Record<string, unknown> | null, env: { SANDBOX_ACCESS?: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-access-"));
  dirs.push(dir);
  const file = path.join(dir, "runtime-config.json");
  if (saved) fs.writeFileSync(file, JSON.stringify(saved));
  const childEnv: NodeJS.ProcessEnv = { ...process.env, DIMENSIO_CONFIG_FILE: file };
  delete childEnv.SANDBOX_ACCESS;
  if (env.SANDBOX_ACCESS !== undefined) childEnv.SANDBOX_ACCESS = env.SANDBOX_ACCESS;
  const r = spawnSync(
    process.execPath,
    ["--import", setup, "--input-type=module", "-e", `const m = await import(${JSON.stringify(configUrl)}); console.log("ACCESS=" + m.getConfig().access);`],
    { env: childEnv, encoding: "utf8", timeout: 60_000 },
  );
  const m = /ACCESS=(\w+)/.exec(r.stdout ?? "");
  assert.ok(m, `子进程没报出 access：${(r.stderr ?? "").slice(0, 400)}`);
  return m[1];
}

test("访问范围 没选过：默认整机；SANDBOX_ACCESS=workspace 才默认只给工作空间", () => {
  assert.equal(bootAccess(null, {}), "full");
  assert.equal(bootAccess({ v: 1, provider: "openai" }, {}), "full", "老的 runtime-config.json 里没有 access 字段：按新默认");
  assert.equal(bootAccess(null, { SANDBOX_ACCESS: "workspace" }), "workspace");
  assert.equal(bootAccess(null, { SANDBOX_ACCESS: "full" }), "full");
});

test("访问范围 选过的记进 runtime-config.json，重启后照旧（用户的选择优先于默认）", async () => {
  assert.equal(bootAccess({ v: 1, access: "workspace" }, {}), "workspace");
  assert.equal(bootAccess({ v: 1, access: "full" }, { SANDBOX_ACCESS: "workspace" }), "full");
  assert.equal(bootAccess({ v: 1, access: "bogus" }, {}), "full", "不认识的值当没选过");

  const before = getConfig().access;
  try {
    setConfig({ access: "workspace" });
    await configWritesSettled();
    const saved = JSON.parse(fs.readFileSync(process.env.DIMENSIO_CONFIG_FILE!, "utf8"));
    assert.equal(saved.access, "workspace", "切访问范围要落盘");
    setConfig({ access: "full" });
    await configWritesSettled();
    assert.equal(JSON.parse(fs.readFileSync(process.env.DIMENSIO_CONFIG_FILE!, "utf8")).access, "full");
  } finally {
    setConfig({ access: before });
    await configWritesSettled();
  }
});
