import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeCanvasProbe, type CanvasProbeSample } from "./cdp.ts";

// Shorthand: a sample with one canvas.
function sample(docH: number, c: { id?: string; attrW: number; attrH: number; rectW: number; rectH: number }): CanvasProbeSample {
  return { docH, canvases: [{ id: c.id ?? "chart1", ...c }] };
}

test("healthy canvas at dpr 2 passes", () => {
  const s = sample(24000, { attrW: 2074, attrH: 760, rectW: 1037, rectH: 380 });
  const v = judgeCanvasProbe(s, s, 2);
  assert.equal(v.passed, true);
  assert.deepEqual(v.problems, []);
});

test("deliberate 2x supersampling stays legal", () => {
  // backing = rect × dpr × 2 — within the ×3 headroom
  const s = sample(20000, { attrW: 4148, attrH: 1520, rectW: 1037, rectH: 380 });
  const v = judgeCanvasProbe(s, s, 2);
  assert.equal(v.passed, true);
});

test("dpr feedback loop: backing grows between samples with no input", () => {
  // The arm-dk bug: h reads back its own dpr-multiplied attribute each render.
  const s0 = sample(33000, { attrW: 1555, attrH: 855, rectW: 1037, rectH: 570 });
  const s1 = sample(33000, { attrW: 1555, attrH: 1924, rectW: 1037, rectH: 1283 });
  const v = judgeCanvasProbe(s0, s1, 1.5);
  assert.equal(v.passed, false);
  assert.match(v.problems[0], /feedback loop/);
});

test("blown-out backing store beyond Chromium limit fails", () => {
  const s = sample(43000, { attrW: 1555, attrH: 65409, rectW: 1037, rectH: 43606 });
  const v = judgeCanvasProbe(s, s, 1.5);
  assert.equal(v.passed, false);
  assert.match(v.problems[0], /exceeds Chromium's limit/);
});

test("backing far beyond layout × dpr fails even under the absolute cap", () => {
  // ratio applied twice: rect 380 × dpr 2 × dpr 2 ≈ 1520... make it clearly past ×3 headroom and above the 4096 floor
  const s = sample(20000, { attrW: 1037, attrH: 6200, rectW: 1037, rectH: 380 });
  const v = judgeCanvasProbe(s, s, 2);
  assert.equal(v.passed, false);
  assert.match(v.problems[0], /applied more than once/);
});

test("runaway page height fails even when no canvas is initialized", () => {
  // Exploded chart pushed siblings 33M px down; later canvases never set up (attr 300×150 defaults).
  const s0: CanvasProbeSample = { docH: 33_554_428, canvases: [{ id: "chart2", attrW: 300, attrH: 150, rectW: 1037, rectH: 518 }] };
  const v = judgeCanvasProbe(s0, s0, 1.25);
  assert.equal(v.passed, false);
  assert.match(v.problems.join(" "), /runaway/);
});

test("page height creeping between samples fails", () => {
  const s0 = sample(30000, { attrW: 1037, attrH: 380, rectW: 1037, rectH: 380 });
  const s1 = sample(40000, { attrW: 1037, attrH: 380, rectW: 1037, rectH: 380 });
  const v = judgeCanvasProbe(s0, s1, 2);
  assert.equal(v.passed, false);
  assert.match(v.problems.join(" "), /still growing/);
});

test("hidden canvas (zero rect) skips the layout-ratio check but keeps the absolute cap", () => {
  const ok = sample(10000, { attrW: 1024, attrH: 1024, rectW: 0, rectH: 0 });
  assert.equal(judgeCanvasProbe(ok, ok, 2).passed, true);
  const huge = sample(10000, { attrW: 40000, attrH: 128, rectW: 0, rectH: 0 });
  assert.equal(judgeCanvasProbe(huge, huge, 2).passed, false);
});

test("no canvases at all passes", () => {
  const s: CanvasProbeSample = { docH: 5000, canvases: [] };
  const v = judgeCanvasProbe(s, s, 2);
  assert.equal(v.passed, true);
});
