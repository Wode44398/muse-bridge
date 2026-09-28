// 会滑的选中块跟手（09-26 的问题：打开 effort 选择栏瞬间每次都是从不思考滑向预设思考档位；侧边工作区的功能选中聚焦移动有点慢，
// 不太跟手）。
//
// 修前：分段控件第一次量到位置时连同「开过渡」一起落下——弹层已经先排过一次版、块停在 x = 0，于是每次打开都从第一项（不思考）
// 滑到当前档位；块只在松手（click）之后、值回来之后才动，思考深度还要等服务端往返。
// 修后：第一次落位不带过渡；换到别的项才滑，同一项只是容器变宽窄直接落位；按下就先滑向按着的那项，点了先停在点的那项。
import assert from "node:assert/strict";
import test from "node:test";
import { IND_HIDDEN, slideTarget, slideTo } from "../web/src/lib/slide.ts";

test("选中块 第一次落位不滑（不再每次打开都从第一项滑过来）；量不到先不动", () => {
  assert.equal(slideTo(IND_HIDDEN, null, "high"), IND_HIDDEN, "还没排版：不动");
  assert.equal(slideTo(IND_HIDDEN, { x: 0, w: 0 }, "high"), IND_HIDDEN, "宽 0：不动");
  const first = slideTo(IND_HIDDEN, { x: 120, w: 40 }, "high");
  assert.deepEqual(first, { key: "high", x: 120, w: 40, shown: true, animate: false });
});

test("选中块 换到别的项才滑；同一项只是容器变宽窄直接落位；位置没变不算一次变化", () => {
  const at = slideTo(IND_HIDDEN, { x: 120, w: 40 }, "high");
  const moved = slideTo(at, { x: 40, w: 36 }, "low");
  assert.deepEqual(moved, { key: "low", x: 40, w: 36, shown: true, animate: true });
  assert.equal(slideTo(moved, { x: 40, w: 36 }, "low"), moved, "重量一次、位置没变：原样");
  assert.deepEqual(slideTo(moved, { x: 52, w: 44 }, "low"), { key: "low", x: 52, w: 44, shown: true, animate: false }, "同一项、容器变了：直接落位");
});

test("选中块 滑向哪一项：按着的 > 刚点的 > 当前值", () => {
  assert.equal(slideTarget("term", "review", "tasks"), "term");
  assert.equal(slideTarget(null, "review", "tasks"), "review");
  assert.equal(slideTarget(null, null, "tasks"), "tasks");
});
