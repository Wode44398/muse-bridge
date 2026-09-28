import assert from "node:assert/strict";
import test from "node:test";
import { decideOutbound, type Detection } from "./net-proxy.ts";

// 出口状态机。抽成纯函数就是为了能测这两条——它们恰恰是生产上最难手工复现的
// （翻转窗口可遇不可求，2026-08-24 追查时日志里几十次交替，实时却连续稳定）：
//   · 迟滞：正用着代理时，单次「直连也行」的判定不许把出口切走；
//   · 粘滞：代理与直连都没验证通过时，绝不主动切进「完全不能出海」的直连。
// DIRECT_HYSTERESIS 当前为 2。

const P = "http://127.0.0.1:7897";
const proxyD: Detection = { kind: "proxy", proxy: P, reason: "探测到可用本地代理" };
const directD: Detection = { kind: "direct", reason: "直连已验证可出海" };
const unknownD: Detection = { kind: "unknown", reason: "代理与直连均未验证通过" };

test("探到可用代理：立即采用，并记为 lastGood", () => {
  const r = decideOutbound({ proxy: "", mode: "auto" }, proxyD, { lastGood: "", directStreak: 0 });
  assert.equal(r.proxy, P);
  assert.equal(r.verified, true);
  assert.equal(r.lastGood, P);
  assert.equal(r.directStreak, 0);
});

test("迟滞：用着代理时，第一次判定为直连不切走", () => {
  const r = decideOutbound({ proxy: P, mode: "auto" }, directD, { lastGood: P, directStreak: 0 });
  assert.equal(r.proxy, P, "第一次不该切");
  assert.equal(r.directStreak, 1);
  assert.match(r.reason, /迟滞观察/);
});

test("迟滞：连续第二次判定为直连才真的切过去", () => {
  const first = decideOutbound({ proxy: P, mode: "auto" }, directD, { lastGood: P, directStreak: 0 });
  const second = decideOutbound({ proxy: first.proxy, mode: "auto" }, directD, {
    lastGood: first.lastGood,
    directStreak: first.directStreak,
  });
  assert.equal(second.proxy, "");
  assert.equal(second.verified, true);
});

test("本来就是直连时，直连结论不受迟滞拖延", () => {
  const r = decideOutbound({ proxy: "", mode: "auto" }, directD, { lastGood: "", directStreak: 0 });
  assert.equal(r.proxy, "");
  assert.doesNotMatch(r.reason, /迟滞/);
});

test("粘滞：两条路都没验证通过时，粘住当前正用的代理", () => {
  const r = decideOutbound({ proxy: P, mode: "auto" }, unknownD, { lastGood: P, directStreak: 0 });
  assert.equal(r.proxy, P, "绝不能因为探不通就切进直连");
  assert.equal(r.verified, false);
  assert.match(r.reason, /保持上次可用配置/);
});

test("粘滞：当前是直连但历史上有可用代理时，回退到那个代理", () => {
  const r = decideOutbound({ proxy: "", mode: "auto" }, unknownD, { lastGood: P, directStreak: 0 });
  assert.equal(r.proxy, P);
  assert.equal(r.verified, false);
});

test("从没探到过代理、直连也验不通：如实说没有已验证出口", () => {
  const r = decideOutbound({ proxy: "", mode: "auto" }, unknownD, { lastGood: "", directStreak: 0 });
  assert.equal(r.proxy, "");
  assert.equal(r.verified, false);
  assert.match(r.reason, /无已验证出口/);
});

test("探到代理后，之前累积的直连迟滞计数清零", () => {
  const r = decideOutbound({ proxy: P, mode: "auto" }, proxyD, { lastGood: P, directStreak: 1 });
  assert.equal(r.directStreak, 0);
});
