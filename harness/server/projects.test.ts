import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBlankProject, importProject, listProjects, setProjectFlags } from "./projects.ts";

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("blank projects create a managed workspace and persist their name", async () => {
  const root = temp("dimensio-projects-");
  const registry = path.join(root, "projects.json");
  process.env.PROJECTS_ROOT = path.join(root, "managed");
  process.env.PROJECTS_FILE = registry;

  const created = await createBlankProject("Alpha");
  assert.equal(created.name, "Alpha");
  assert.equal(created.path, path.join(root, "managed", "Alpha"));
  assert.equal(fs.statSync(created.path).isDirectory(), true);

  const listed = await listProjects();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);
  assert.equal(listed[0]?.exists, true);
});

test("existing and discovered workspaces deduplicate by absolute path", async () => {
  const root = temp("dimensio-import-");
  const workspace = path.join(root, "existing");
  fs.mkdirSync(workspace);
  process.env.PROJECTS_ROOT = path.join(root, "managed");
  process.env.PROJECTS_FILE = path.join(root, "projects.json");

  const imported = await importProject(workspace);
  const listed = await listProjects([workspace, path.join(root, "other")]);
  assert.equal(listed.filter((p) => p.id === imported.id).length, 1);
  assert.equal(listed.some((p) => p.name === "other" && !p.exists), true);
});

test("blank project names cannot escape the managed root", async () => {
  const root = temp("dimensio-project-name-");
  process.env.PROJECTS_ROOT = path.join(root, "managed");
  process.env.PROJECTS_FILE = path.join(root, "projects.json");
  await assert.rejects(() => createBlankProject("../escape"), /不能用于文件夹/);
});

test("pinned projects lead the list and hidden ones stay listed for restore", async () => {
  const root = temp("dimensio-project-flags-");
  const a = path.join(root, "alpha");
  const b = path.join(root, "beta");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  process.env.PROJECTS_ROOT = path.join(root, "managed");
  process.env.PROJECTS_FILE = path.join(root, "projects.json");

  await importProject(a);
  await importProject(b); // 后导入 → 默认排在前面
  assert.equal((await listProjects())[0]?.path, b);

  await setProjectFlags(a, { pinned: true });
  const pinned = await listProjects();
  assert.equal(pinned[0]?.path, a);
  assert.equal(pinned[0]?.pinned, true);

  // 隐藏只是不显示：仍然出现在列表里（带 hidden 标记），侧栏据此提供恢复入口
  await setProjectFlags(b, { hidden: true });
  assert.equal((await listProjects()).find((p) => p.path === b)?.hidden, true);
  assert.equal(fs.existsSync(b), true);

  await setProjectFlags(b, { hidden: false });
  assert.equal((await listProjects()).find((p) => p.path === b)?.hidden, false);
});

test("a workspace discovered from history can be hidden and stays hidden", async () => {
  const root = temp("dimensio-project-hide-implicit-");
  const seen = path.join(root, "from-history");
  fs.mkdirSync(seen);
  process.env.PROJECTS_ROOT = path.join(root, "managed");
  process.env.PROJECTS_FILE = path.join(root, "projects.json");

  await setProjectFlags(seen, { hidden: true });
  const listed = await listProjects([seen]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.hidden, true);

  // 重新“使用现有文件夹”导入同一个目录 = 明确要它回来
  await importProject(seen);
  assert.equal((await listProjects([seen]))[0]?.hidden, false);
});
