// 档位胶囊把目标模式并进来（09-26：目标模式和运行档位的设定合并到一处）。
//
// 修前：输入框底行两颗胶囊——档位（自主 / 只读 / 计划 · 访问范围 · 离开）和单独一颗「目标」，手机上挤成一排图标。
// 修后：目标开关进档位菜单，档位胶囊把「这条是目标」一起写出来（手机上只剩图标时换成靶心）；默认（自主 · 整机 · 没离开 ·
// 不是目标）只写「自主」、不亮，拉了闸的才写出来亮墨色——整机是默认之后，「仅工作空间」才是拉闸的那一档。
import assert from "node:assert/strict";
import test from "node:test";
import { MODE_LABEL, modeChip } from "../web/src/lib/mode-chip.ts";

const base = { mode: "auto" as const, access: "full" as const, roots: 0, away: false, goal: false };

test("档位胶囊 默认只写「自主」、不亮；只读 / 计划 / 仅工作空间 / 离开各自写出来并亮", () => {
  assert.deepEqual(modeChip(base), { text: "自主", alt: false, icon: "shield" });
  assert.deepEqual(modeChip({ ...base, access: "workspace" }), { text: "自主 · 仅工作空间", alt: true, icon: "shield" });
  assert.deepEqual(modeChip({ ...base, mode: "read-only", away: true }), { text: "只读 · 离开", alt: true, icon: "eye" });
  assert.deepEqual(modeChip({ ...base, mode: "plan" }), { text: "计划", alt: true, icon: "todo" });
  assert.equal(MODE_LABEL.auto, "自主");
});

test("档位胶囊 目标并进来：这条是目标时写「目标」、亮、图标换靶心；放行目录只在仅工作空间时算", () => {
  assert.deepEqual(modeChip({ ...base, goal: true }), { text: "自主 · 目标", alt: true, icon: "target" });
  assert.deepEqual(modeChip({ ...base, roots: 2 }), { text: "自主", alt: false, icon: "shield" }, "整机下放行目录没有意义，不写");
  assert.deepEqual(modeChip({ mode: "plan", access: "workspace", roots: 2, away: true, goal: true }), {
    text: "计划 · 仅工作空间 · +2 目录 · 离开 · 目标",
    alt: true,
    icon: "target",
  });
});
