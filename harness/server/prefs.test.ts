import { test } from "node:test";
import assert from "node:assert/strict";
import { PREFS, PREF_GROUPS, allPrefs, prefValue, setPrefs } from "./prefs.ts";

test("prefs：每项都登记在已知分组里、默认值合乎自身类型", () => {
  const groups = new Set(PREF_GROUPS.map((g) => g.id));
  for (const p of PREFS) {
    assert.ok(groups.has(p.group), `${p.key} 的分组 ${p.group} 未登记`);
    assert.ok(p.label, `${p.key} 缺 label`);
    if (p.type === "enum") assert.ok(p.options?.some((o) => o.value === p.default), `${p.key} 默认值不在选项里`);
    else if (p.type === "bool") assert.equal(typeof p.default, "boolean");
    else if (p.type === "number") assert.equal(typeof p.default, "number");
    else assert.equal(typeof p.default, "string");
    assert.deepEqual(prefValue(p.key), p.default);
  }
});

test("prefs：每项都带英文文案（bridge 设置页切到 English 时显示）", () => {
  for (const g of PREF_GROUPS) assert.ok(g.en, `分组 ${g.id} 缺英文`);
  for (const p of PREFS) {
    assert.ok(p.en?.label, `${p.key} 缺 en.label`);
    if (p.desc) assert.ok(p.en?.desc, `${p.key} 有 desc，缺 en.desc`);
    for (const o of p.options ?? []) assert.ok(p.en?.options?.[o.value], `${p.key} 的选项 ${o.value} 缺英文`);
  }
});

test("prefs：不认识的键、非对象整批拒绝", async () => {
  await assert.rejects(async () => setPrefs({ noSuchKey: true }), /不认识/);
  await assert.rejects(async () => setPrefs([1]), /对象/);
  assert.ok(Array.isArray(allPrefs().items));
});

test("prefs：老开关 idleCompact 读进来并进 cacheExpiry（开着 → 自动压缩，关着 → 只提示，已选过的不动）", async () => {
  const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const path = await import("node:path");
  const { configFile } = await import("./paths.ts");
  const { reloadPrefs } = await import("./prefs.ts");
  const file = path.join(path.dirname(configFile()), "prefs.json");
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  try {
    for (const [raw, want] of [[{ idleCompact: true }, "compact"], [{ idleCompact: false }, "hint"], [{ idleCompact: true, cacheExpiry: "off" }, "off"]] as const) {
      writeFileSync(file, JSON.stringify(raw));
      reloadPrefs();
      assert.equal(prefValue("cacheExpiry"), want);
    }
  } finally {
    if (before === null) writeFileSync(file, "{}");
    else writeFileSync(file, before);
    reloadPrefs();
  }
});
