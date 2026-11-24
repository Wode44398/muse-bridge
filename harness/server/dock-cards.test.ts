// 宽屏工作区卡片状态的规整：存坏的两列顺序、开着的卡、高度比怎么修复。
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COLS, normCols, normOpen, normWeights } from "../web/src/lib/dock-cards.ts";

test("卡片 存坏的列顺序：去重、去掉不认识的、缺的按默认列补在末尾", () => {
  assert.deepEqual(normCols(null), DEFAULT_COLS);
  assert.deepEqual(normCols({ a: ["browser", "browser", "nope", "term"], b: ["term", "files"] }), {
    a: ["browser", "term", "review", "tasks"],
    b: ["files", "memory"],
  });
  assert.deepEqual(normOpen(["review", "x", "review", "term"]), ["review", "term"]);
  assert.deepEqual(normWeights({ review: 99, term: -1, x: 2, files: "1" }), { review: 8, term: 0.15 });
});

test("卡片 bridge 插件的工作区卡片（plg:<插件>:<id>）认、形状不对的丢", () => {
  assert.deepEqual(normOpen(["plg:android:device", "plg:Bad:x", "plg:android", "term", "plg:android:device"]), ["plg:android:device", "term"]);
  assert.deepEqual(normWeights({ "plg:android:device": 2, "plg:x": 3 }), { "plg:android:device": 2 });
});
