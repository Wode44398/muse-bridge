// D3：dimensio 的内置目录（catalog.ts 的 CATALOG，逐型号实测 + 官方口径）和共用型号表（src/model-knowledge/knowledge.mjs，
// bridge 的 Claude 外接与 dimensio 的自定义服务都按它识别）必须一致。以前两边各存一份：30 个内置型号里 10 个对不上，
// Claude 外接给 Sonnet 4.6 开了 xhigh（选了必 400）。以后官方改档位 / 上下文，两处要一起改，漏一处这里就红。
//
// 比的是「同一个型号经自定义服务接进来，dimensio 会把它当成什么」：上下文、输出上限、看图 / 视频 / 音频、思考档（共用模板经
// custom-tiers.ts 映射成七级档后的 id）、首次选中的默认档、开关式档名、图片额度。协议按这家内置厂商实际走的那条（anthropic /
// gemini / 其余 OpenAI 兼容）。本机两台引擎的上下文与识图跟着面板设置走，不比。

import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG, defaultEffort } from "./catalog.ts";
import { slotView } from "./custom-tiers.ts";
import { MK } from "./model-knowledge.ts";
import type { ThinkingLevel } from "./agent/turn.ts";

const SKIP_PROVIDERS = new Set(["local"]);
const protocolOf = (p: string) => (p === "anthropic" ? "anthropic" : p === "gemini" ? "gemini" : "openai");
// 同 catalog.defaultEffort 的规则：型号自己的默认档 > high > low > 第一档
const firstPick = (efforts: ThinkingLevel[], dflt?: ThinkingLevel): ThinkingLevel =>
  dflt && efforts.includes(dflt) ? dflt : efforts.includes("high") ? "high" : efforts.includes("low") ? "low" : efforts[0];

test("内置目录与共用型号表逐型号一致（上下文 / 输出 / 看图 / 视频 / 音频 / 思考档 / 默认档 / 开关档名）", () => {
  const diffs: string[] = [];
  let n = 0;
  for (const spec of CATALOG) {
    if (SKIP_PROVIDERS.has(spec.id)) continue;
    for (const m of spec.models) {
      n++;
      const where = `${spec.id}/${m.id}`;
      const e = MK.tableEntry(m.id);
      if (!e) {
        diffs.push(`${where}：共用型号表里没有`);
        continue;
      }
      const g = MK.guessModel(m.id, { protocol: protocolOf(spec.id) });
      if (g.contextWindow !== m.ctx) diffs.push(`${where} 上下文 目录=${m.ctx} 共用表=${g.contextWindow}`);
      if (g.maxOutput !== m.maxOut) diffs.push(`${where} 输出 目录=${m.maxOut} 共用表=${g.maxOutput}`);
      if (g.vision !== m.image) diffs.push(`${where} 看图 目录=${m.image} 共用表=${g.vision}`);
      if (g.video !== (m.video === true)) diffs.push(`${where} 视频 目录=${m.video === true} 共用表=${g.video}`);
      if (g.audio !== (m.audio === true)) diffs.push(`${where} 音频 目录=${m.audio === true} 共用表=${g.audio}`);
      const v = slotView(g);
      if (v.efforts.join(",") !== m.efforts.join(",")) diffs.push(`${where} 思考档 目录=[${m.efforts}] 共用表=[${v.efforts}]`);
      const want = defaultEffort(spec.id, m.id);
      const got = firstPick(v.efforts, v.defaultEffort);
      if (want !== got) diffs.push(`${where} 默认档 目录=${want} 共用表=${got}`);
      for (const [lv, label] of Object.entries(m.effortLabels ?? {})) {
        if (v.labels[lv as ThinkingLevel] !== label) diffs.push(`${where} 档名 ${lv} 目录=${label} 共用表=${v.labels[lv as ThinkingLevel]}`);
      }
      // 图片额度：目录按厂商配，共用表按型号家族配（经第三方接的小米同样只留最近 2 张）
      const fam = e.media ?? {};
      for (const k of ["maxImages", "maxBytes", "keepRecent"] as const) {
        if (spec.media?.[k] !== fam[k]) diffs.push(`${where} 图片额度 ${k} 目录=${spec.media?.[k]} 共用表=${fam[k]}`);
      }
    }
  }
  assert.ok(n >= 28, `比了 ${n} 个型号`);
  assert.deepEqual(diffs, []);
});

test("Sonnet / Opus 4.6 没有 xhigh（Claude 外接以前开了，选了必 400）", () => {
  for (const id of ["claude-sonnet-4-6", "claude-opus-4-6"]) {
    assert.deepEqual(MK.guessModel(id, { protocol: "anthropic" }).efforts.map((t) => t.id), ["low", "medium", "high", "max"], id);
  }
});
