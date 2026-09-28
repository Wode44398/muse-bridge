// 侧栏项目块拖动排序（09-26：工作空间的块可以长按拖动）。
//
// 修前：项目只能置顶 / 隐藏，次序固定是「置顶的按置顶时刻、其余按新建时刻」，想把常用的挪到上面只能置顶。
// 修后：注册表多一个位次 rank（小的在前），POST /api/projects/order 按一个区拖完之后的完整次序写；置顶区与非置顶区
// 各排各的；没拖过的（新建的、刚置顶的）排在本区最前；置顶 / 取消置顶换了区就清掉位次。前端的两个纯函数：手指位置 →
// 插入位置（夹在本区里）、插完之后本区的次序（没动返回 null）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { importProject, listProjects, setProjectFlags, setProjectOrder } from "./projects.ts";
import { CAPABILITIES } from "./protocol.ts";
import { insertionIndex, reorderZone } from "../web/src/lib/reorder.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
function dirs(...names: string[]): Record<string, string> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-order-"));
  roots.push(base);
  const out: Record<string, string> = {};
  for (const n of names) {
    out[n] = path.join(base, n);
    fs.mkdirSync(out[n]);
  }
  return out;
}
const names = async (only: string[]) => (await listProjects()).map((p) => p.name).filter((n) => only.includes(n));
const pause = () => new Promise((r) => setTimeout(r, 5)); // 新建时刻要分得出先后

test("项目排序：按拖出来的次序；置顶区与非置顶区各排各的；新建的排本区最前；换区清位次", async () => {
  const d = dirs("alpha", "bravo", "charlie", "delta", "echo");
  for (const n of ["alpha", "bravo", "charlie", "delta"]) {
    await importProject(d[n]);
    await pause();
  }
  const all = ["alpha", "bravo", "charlie", "delta", "echo"];
  assert.deepEqual(await names(all), ["delta", "charlie", "bravo", "alpha"], "没拖过：新建的在前（原规矩）");

  await setProjectFlags(d.alpha, { pinned: true });
  await setProjectOrder([d.bravo, d.delta, d.charlie]);
  assert.deepEqual(await names(all), ["alpha", "bravo", "delta", "charlie"], "置顶的在前；非置顶区按拖出来的次序");

  await importProject(d.echo);
  assert.deepEqual(await names(all), ["alpha", "echo", "bravo", "delta", "charlie"], "新建的（没拖过）排在本区最前");

  await pause();
  await setProjectFlags(d.delta, { pinned: true });
  assert.deepEqual(await names(all), ["delta", "alpha", "echo", "bravo", "charlie"], "刚置顶的排到置顶区最前（位次作废）");
  await setProjectOrder([d.alpha, d.delta]);
  assert.deepEqual(await names(all), ["alpha", "delta", "echo", "bravo", "charlie"], "置顶区自己也能排");

  await setProjectFlags(d.delta, { pinned: false });
  const back = await names(all);
  assert.equal(back[0], "alpha");
  assert.ok(back.indexOf("delta") < back.indexOf("bravo"), "取消置顶回到非置顶区的前面（没拖过的在前）");
  await assert.rejects(setProjectOrder([]), /缺少项目路径/);
  assert.ok(CAPABILITIES.includes("project-order"), "能力位：新前端据此才让项目块可拖");
});

test("前端：手指位置 → 插入位置夹在被拖那一项的区里；插完之后本区的次序；没动返回 null", () => {
  const items = [
    { id: "p1", pinned: true },
    { id: "p2", pinned: true },
    { id: "u1", pinned: false },
    { id: "u2", pinned: false },
    { id: "u3", pinned: false },
  ];
  // 五个标题行，每行 30 高
  const heads = items.map((_, i) => ({ top: i * 30, bottom: i * 30 + 30 }));
  assert.equal(insertionIndex(heads, 5, items, "u3"), 2, "非置顶的拖到最上面：夹在非置顶区的开头");
  assert.equal(insertionIndex(heads, 140, items, "p1"), 2, "置顶的拖到最下面：夹在置顶区的末尾");
  assert.equal(insertionIndex(heads, 50, items, "u3"), 2, "中线以上 = 插在它前面（夹进本区）");
  assert.equal(insertionIndex(heads, 95, items, "u1"), 3, "第四行（下标 3）中线以上 = 插在它前面");
  assert.equal(insertionIndex(heads, 200, items, "u1"), 5, "都不是 = 插在最后");

  assert.deepEqual(reorderZone(items, "u3", 2), ["u3", "u1", "u2"], "挪到本区最前");
  assert.deepEqual(reorderZone(items, "u1", 5), ["u2", "u3", "u1"], "挪到最后");
  assert.deepEqual(reorderZone(items, "p2", 0), ["p2", "p1"], "置顶区里换位");
  assert.equal(reorderZone(items, "u2", 3), null, "插在自己前面 = 没动");
  assert.equal(reorderZone(items, "u2", 4), null, "插在自己后面 = 没动");
  assert.equal(reorderZone(items, "nope", 1), null);
});
