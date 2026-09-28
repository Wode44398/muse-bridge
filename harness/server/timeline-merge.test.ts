import assert from "node:assert/strict";
import test from "node:test";
import { itemFp, mergeTimeline } from "../web/src/lib/timeline-merge.ts";

// 断线对账最常见的情形：前面的回合一个字都没变，只在尾部多了新内容。
// 前缀元素必须【原地不动】（身份不变），否则整个会话的 markdown 会被重解析、
// DOM 全量重建、视口跳底 —— 手机上每次重连都来一次。
test("unchanged prefix keeps element identity; only the tail is spliced", () => {
  const a = { kind: "user", text: "跑一下测试" };
  const b = { kind: "text", text: "好的，我来跑。" };
  const cur: any[] = [a, b];

  const changed = mergeTimeline(cur, [
    { kind: "user", text: "跑一下测试" },
    { kind: "text", text: "好的，我来跑。" },
    { kind: "tool", id: "t1", name: "Bash", status: "ok", summary: "3 passed", output: "..." },
  ]);

  assert.equal(changed, true);
  assert.equal(cur.length, 3);
  assert.equal(cur[0], a, "前缀元素被换掉了 = 等于整表替换");
  assert.equal(cur[1], b, "前缀元素被换掉了 = 等于整表替换");
});

test("identical timelines report no change and touch nothing", () => {
  const cur: any[] = [
    { kind: "user", text: "hi" },
    { kind: "text", text: "hello" },
  ];
  const snapshot = [...cur];

  assert.equal(
    mergeTimeline(cur, [
      { kind: "user", text: "hi" },
      { kind: "text", text: "hello" },
    ]),
    false,
  );
  assert.deepEqual(cur, snapshot);
  assert.equal(cur[0], snapshot[0]);
});

// 工具卡/思考行的展开态是本地 UI 态，服务端记录里没有。计入指纹的话每条展开过
// 的行都会被判成"有变化"，然后被折叠版覆盖 —— 用户正看着的输出当场合上。
test("locally expanded rows survive a resync", () => {
  const tool = { kind: "tool", id: "t1", name: "Bash", status: "ok", summary: "ok", output: "x", open: true };
  const cur: any[] = [tool];

  assert.equal(
    mergeTimeline(cur, [
      { kind: "tool", id: "t1", name: "Bash", status: "ok", summary: "ok", output: "x", open: false },
    ]),
    false,
  );
  assert.equal(cur[0], tool);
  assert.equal(cur[0].open, true);
});

// 中途分叉（重试/门禁撤回把本轮内容换掉）：分叉点之前保身份，之后整段换新。
test("divergence replaces from the first differing item onward", () => {
  const keep = { kind: "user", text: "改一下配色" };
  const cur: any[] = [
    keep,
    { kind: "text", text: "半截被掐掉的回答" },
    { kind: "tool", id: "t9", name: "Read", status: "fail", summary: "已中断：未拿到结果", output: "" },
  ];

  assert.equal(
    mergeTimeline(cur, [
      { kind: "user", text: "改一下配色" },
      { kind: "text", text: "重试后的完整回答" },
    ]),
    true,
  );
  assert.equal(cur.length, 2);
  assert.equal(cur[0], keep);
  assert.equal((cur[1] as any).text, "重试后的完整回答");
});

// 工具卡从「运行中」跑到「ok」必须被认出是变化，否则重连后永远停在转圈上。
test("tool status transitions count as a change", () => {
  const cur: any[] = [{ kind: "tool", id: "t1", name: "Bash", status: "running", summary: "", output: "" }];
  assert.equal(
    mergeTimeline(cur, [
      { kind: "tool", id: "t1", name: "Bash", status: "ok", summary: "3 passed", output: "..." },
    ]),
    true,
  );
  assert.equal((cur[0] as any).status, "ok");
});

// 问答卡/权限卡/计划卡的落定同理：别的设备答完，本机对账要认出来。
test("decision cards change fingerprint when they settle", () => {
  assert.notEqual(
    itemFp({ kind: "ask", id: "a1", answered: false, selected: {} }),
    itemFp({ kind: "ask", id: "a1", answered: true, selected: { "a1:0": ["是"] } }),
  );
  assert.notEqual(
    itemFp({ kind: "permission", id: "p1", decided: null }),
    itemFp({ kind: "permission", id: "p1", decided: "once" }),
  );
  assert.notEqual(
    itemFp({ kind: "plan", id: "l1", plan: "步骤一", decided: null }),
    itemFp({ kind: "plan", id: "l1", plan: "步骤一", decided: "approved" }),
  );
});

// 服务端记录先短后长（落盘慢半拍）也要能收敛，不能因为长度不同就整表换。
test("shorter incoming record truncates in place without replacing the prefix", () => {
  const head = { kind: "user", text: "hi" };
  const cur: any[] = [head, { kind: "text", text: "half" }];
  assert.equal(mergeTimeline(cur, [{ kind: "user", text: "hi" }]), true);
  assert.equal(cur.length, 1);
  assert.equal(cur[0], head);
});
