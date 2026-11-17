// 宽屏工作区卡片的排布：两列顺序的修复、拖动预览、按比例的格子、卡间缝调高度。
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COLS, columns, dividers, normCols, normOpen, normWeights, place, resizePair, slots, target, type CardTool } from "../web/src/lib/dock-cards.ts";

test("卡片 存坏的列顺序：去重、去掉不认识的、缺的按默认列补在末尾", () => {
  assert.deepEqual(normCols(null), DEFAULT_COLS);
  assert.deepEqual(normCols({ a: ["browser", "browser", "nope", "term"], b: ["term", "files"] }), {
    a: ["browser", "term", "review", "tasks"],
    b: ["files", "memory"],
  });
  assert.deepEqual(normOpen(["review", "x", "review", "term"]), ["review", "term"]);
  assert.deepEqual(normWeights({ review: 99, term: -1, x: 2, files: "1" }), { review: 8, term: 0.15 });
});

test("卡片 插进某列：按看得见的卡数位置，没开的卡留在原处", () => {
  const st = { a: ["term", "review", "tasks"] as CardTool[], b: ["browser", "files", "memory"] as CardTool[] };
  const shown: CardTool[] = ["term", "tasks", "browser"];
  // 看得见的 a 列是 term、tasks；插到第 1 张（tasks）前面——review 没开，留在原位
  assert.deepEqual(place(st, "browser", "a", 1, shown), { a: ["term", "review", "browser", "tasks"], b: ["files", "memory"] });
  // 插到末尾：排在最后一张看得见的卡后面
  assert.deepEqual(place(st, "browser", "a", 9, shown), { a: ["term", "review", "tasks", "browser"], b: ["files", "memory"] });
});

test("卡片 拖动预览：两列按左右半定列；一列时进右侧三成才拆两列，拆开后退回门槛放宽到一半", () => {
  const start = { a: ["term", "review", "tasks"] as CardTool[], b: ["browser", "files", "memory"] as CardTool[] };
  const shown: CardTool[] = ["term", "review", "browser"];
  const two = { start, v: "browser" as CardTool, n0: 2 as const, split: false, canTwo: true, shown };
  const left = target(two, 0.2, 0.9);
  assert.equal(left.n, 2);
  assert.deepEqual(left.cols.a.filter((k) => shown.includes(k)), ["term", "review", "browser"], "拖到左列最下");
  assert.deepEqual(columns(left.cols, shown, true)[1], [], "右列拖空了：留作落点");

  const one = { start, v: "term" as CardTool, n0: 1 as const, split: false, canTwo: true, shown };
  assert.equal(target(one, 0.6, 0.5).split, false, "右侧三成之外不拆");
  const split = target(one, 0.8, 0.5);
  assert.equal(split.split, true);
  assert.deepEqual(columns(split.cols, shown, true), [["review", "browser"], ["term"]], "拆开：它单独占右列");
  assert.equal(target({ ...one, split: true }, 0.55, 0.5).split, true, "已拆开：退到一半以内才合回");
  assert.equal(target({ ...one, canTwo: false }, 0.9, 0.5).split, false, "放不下两列：不拆");
  assert.equal(target(one, 0.9, 0.5, false).split, false, "还没停够：不拆");
});

test("卡片 格子按比例：列宽均分，高度按权重分，缝 8px；卡间缝落在上一张的下沿", () => {
  const list: CardTool[][] = [["term", "review"], ["browser"]];
  const at = slots(list, { term: 3, review: 1 });
  assert.equal(at.term!.col, 0);
  assert.equal(at.browser!.col, 1);
  assert.match(at.term!.height, /\* 0\.750000\)/);
  assert.match(at.review!.top, /\* 0\.750000 \+ 8px\)/);
  assert.match(at.browser!.left, /\* 0\.500000 \+ 8px\)/);
  const seams = dividers(list, at);
  assert.deepEqual(
    seams.map((d) => d.key),
    ["term|review"],
  );
  assert.match(seams[0].css, /top:calc\(calc\(.*\) - 8px\);height:8px/);
});

test("卡片 拖卡间缝：两张的权重和不变，各自不低于最小高度", () => {
  // 一列两张、各 1，可分 400px：往下拖 100 → 300 / 100
  const [u, d] = resizePair(1, 1, 2, 400, 100, 120);
  assert.ok(Math.abs(u + d - 2) < 1e-9);
  assert.ok(Math.abs((u / 2) * 400 - 280) < 1e-9, "钳在 400 - 120");
  const [u2] = resizePair(1, 1, 2, 400, -50, 120);
  assert.ok(Math.abs((u2 / 2) * 400 - 150) < 1e-9);
  // 两张加起来都不够两个最小高度：各让一半
  const [u3, d3] = resizePair(1, 1, 2, 160, 500, 120);
  assert.ok(Math.abs((u3 / 2) * 160 - 80) < 1e-9 && Math.abs((d3 / 2) * 160 - 80) < 1e-9);
});
