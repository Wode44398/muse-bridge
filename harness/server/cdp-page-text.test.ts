import { test } from "node:test";
import assert from "node:assert/strict";
import { CdpSession } from "./cdp.ts";

// page_text 与 bridge 浏览器工具共用页面内脚本（src/runtime/cdp-page-text.mjs，那边有 DOM 桩单测）；
// 这里只验 harness 这层：注入的是共用脚本、长行折叠在截断之前、AX 快照里链接带地址。

test("pageText injects the shared flat-tree walker and folds repeated lines before the cap", async () => {
  const session = new CdpSession();
  const seen: string[] = [];
  const ad = "The Creative Pass — join today";
  (session as unknown as { eval: (e: string) => Promise<unknown> }).eval = async (expression: string) => {
    seen.push(expression);
    return { from: "main", title: "T", text: `头\n${Array(11).fill(ad).join("\n")}\n尾`, shadow: 2, more: false };
  };
  const r = await session.pageText(1000);
  assert.match(seen[0], /shadowRoot/, "用的是能穿 shadow DOM 的共用脚本");
  assert.match(seen[0], /"limit":4000/);
  assert.equal(r.text, `头\n${ad}（×11）\n尾`);
  assert.equal(r.shadow, 2);
  assert.equal(r.truncated, false);
});

test("axSnapshot: link lines end with their url, same-origin shortened to the path", async () => {
  const session = new CdpSession();
  const url = (value: string) => [{ name: "url", value: { type: "string", value } }];
  (session as unknown as { send: (m: string) => Promise<unknown> }).send = async () => ({
    nodes: [
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Releases" }, properties: url("https://github.com/o/r/releases"), childIds: ["2", "3", "4"] },
      { nodeId: "2", parentId: "1", role: { value: "link" }, name: { value: "v1.2.0" }, backendDOMNodeId: 10, properties: url("https://github.com/o/r/releases/tag/v1.2.0") },
      { nodeId: "3", parentId: "1", role: { value: "link" }, name: { value: "Docs" }, backendDOMNodeId: 11, properties: url("https://docs.example.com/start") },
      { nodeId: "4", parentId: "1", role: { value: "link" }, name: { value: "More" }, backendDOMNodeId: 12, properties: url("javascript:void(0)") },
    ],
  });
  const { text } = await session.axSnapshot();
  assert.match(text, /link "v1\.2\.0" \[ref1\] → \/o\/r\/releases\/tag\/v1\.2\.0$/m);
  assert.match(text, /link "Docs" \[ref2\] → https:\/\/docs\.example\.com\/start$/m);
  assert.match(text, /link "More" \[ref3\]$/m);
});
