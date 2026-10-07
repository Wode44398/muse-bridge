// C5（G1、K57、X51、G3 部分；#10）：技能目录经济学。
//
// 修前：扩展中心勾给 dimensio 的技能在 system 里平铺——每条完整描述 + SKILL.md 绝对路径，实际装机 73 条约 2.7 万字符常驻，
// 77% 是两个财经包（gildata 45、caixin 11）；没有预算，小窗口模型照样整段塞；模型用 Read 读 SKILL.md，正文落在
// tool_result 里，长任务一微压缩就被换成占位，技能指令悄悄没了。
// 修后：成员 ≥3 的包折成一行（包说明 + 成员名单）、不列路径；预算 = 窗口 × 2%（封顶 1 万 token），超了按档退化；
// Skill 工具按名加载——包列成员、技能正文作为紧随其后的 harness 消息送达（不在 tool_result 里），同名不重复注入。
// 全部是假注册表 + 临时目录，不读真实扩展中心。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { injectionKind, messageKind } from "./agent/injections.ts";
import type { Block, Msg } from "./agent/turn.ts";
import { catalogBudget, catalogEntries, firstSentence, managedSkills, managedSkillsSection, renderCatalog } from "./extensions.ts";
import { startRun } from "./session.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { skillTool } from "./tools/skill.ts";

let tmp = "";
let extRoot = "";
const savedFile = process.env.BRIDGE_EXTENSIONS_FILE;

interface FakeSkill {
  name: string;
  description: string;
  pkg?: string;
  dimensio?: boolean;
}

function install(skills: FakeSkill[]): void {
  const items = skills.map((s, i) => {
    const dir = path.join(extRoot, "skills", s.name);
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${s.name}\ndescription: "${s.description}"\n---\n\n# ${s.name}\n\nBODY-${s.name}: run scripts/run.py\n`);
    return {
      id: `id${i}`, type: "skill", name: s.name, description: s.description, enabled: true,
      agents: { claude: true, dimensio: s.dimensio ?? true }, dir: `skills/${s.name}`, entry: "SKILL.md",
      ...(s.pkg ? { pkg: s.pkg } : {}),
    };
  });
  fs.writeFileSync(path.join(extRoot, "registry.json"), JSON.stringify({ items }));
}

const FIXTURE: FakeSkill[] = [
  { name: "clone-site", description: "Clone a public web page into an offline copy, animations included." },
  { name: "acme", pkg: "acme-data", description: "Acme is a financial data platform: quotes, filings, macro and FX." },
  { name: "acme-quote", pkg: "acme-data", description: "行情数据：个股与指数的日线、分时与估值。" },
  { name: "acme-filing", pkg: "acme-data", description: "Use for company filings and announcements." },
  { name: "acme-macro", pkg: "acme-data", description: "Use for macro indicators such as CPI and GDP." },
  { name: "acme-fx", pkg: "acme-data", description: "Use for FX rates." },
  { name: "cx-bond", pkg: "caixin-x", description: "财新债券数据：存储中国债券的基本信息与发行情况。" },
  { name: "cx-stock", pkg: "caixin-x", description: "财新股票数据：存储沪深北交易所股票的基本信息。" },
  { name: "cx-macro", pkg: "caixin-x", description: "财新宏观行业数据：全国及各省市人口与生产总值。" },
  { name: "duo-a", pkg: "duo", description: "First of a two-skill package." },
  { name: "duo-b", pkg: "duo", description: "Second of a two-skill package." },
  { name: "claude-only", description: "Not granted to dimensio.", dimensio: false },
];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-c5-"));
  extRoot = path.join(tmp, "extensions");
  fs.mkdirSync(extRoot, { recursive: true });
  process.env.BRIDGE_EXTENSIONS_FILE = path.join(extRoot, "registry.json");
});

afterEach(() => {
  if (savedFile === undefined) delete process.env.BRIDGE_EXTENSIONS_FILE;
  else process.env.BRIDGE_EXTENSIONS_FILE = savedFile;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
});

const textOf = (blocks: Block[]): string => blocks.map((b) => (b.t === "text" ? b.text : b.t === "tool_result" ? textOf(b.content) : "")).join("");

test("C5 目录：成员 ≥3 的包折成一行、不列路径；真实形状的目录缩到三成以内；预算按窗口 × 2% 退化", () => {
  install(FIXTURE);
  const section = managedSkillsSection({ contextWindow: 131_072 }) ?? "";
  assert.match(section, /^- acme-data \(package, 5 skills\) — Acme is a financial data platform/m, "包折成一行，说明取路由成员（acme ⊂ acme-data）");
  assert.match(section, /skills: acme, acme-quote, acme-filing, acme-macro, acme-fx/, "带成员名单，点名可直接加载");
  assert.match(section, /^- caixin-x \(package, 3 skills\) — 财新债券数据 \/ 财新股票数据 \/ 财新宏观行业数据/m, "没有路由成员：拼成员描述的开头");
  assert.doesNotMatch(section, /^- acme-quote —/m, "折进包的成员不再各占一行");
  assert.match(section, /^- duo-a — First/m, "两个成员的包不折");
  assert.match(section, /^- clone-site — Clone a public web page/m);
  assert.ok(!section.includes("claude-only"), "没勾给 dimensio 的不出现");
  assert.ok(!section.includes("SKILL.md") && !section.includes(extRoot), "目录里不再列路径（Skill 按名加载）");
  assert.match(section, /Skill\(\{name: "<skill>"\}\)/, "教模型用 Skill 工具");
  assert.match(section, /Don't hand a skill to a sub-agent/, "不许交给子 agent 代读");

  // 预算：窗口 × 2%，封顶 1 万 token；拿不到窗口按 8000 字符
  assert.deepEqual(catalogBudget(131_072), { tokens: 2621 });
  assert.deepEqual(catalogBudget(2_000_000), { tokens: 10_000 });
  assert.deepEqual(catalogBudget(undefined), { chars: 8000 });
  const entries = catalogEntries(managedSkills());
  const full = renderCatalog(entries, { chars: 100_000 });
  assert.equal(full.level, 0);
  const lv1 = renderCatalog(entries, { chars: full.text.length - 1 });
  assert.equal(lv1.level, 1, "放不下就先截描述、包不带名单");
  assert.ok(!lv1.text.includes("skills: acme,"));
  const names = renderCatalog(entries, { chars: renderCatalog(entries, { chars: lv1.text.length - 1 }).text.length });
  assert.equal(names.level, 2, "再放不下就只剩名字");
  assert.match(names.text, /^- acme-data \(package, 5 skills\)$/m);
  const tight = renderCatalog(entries, { chars: 60 });
  assert.equal(tight.level, 3);
  assert.ok(tight.omitted > 0 && tight.text.includes(`…and ${tight.omitted} more`), "省略的条目注明个数、说明仍能按名加载");

  // 真实装机的形状：45 个英文描述的 gildata 成员（其一是路由）+ 11 个中文长描述的 caixin 成员 + 16 个单技能 + 1 个散装
  const prod: FakeSkill[] = [
    ...Array.from({ length: 45 }, (_, i) => ({
      name: i === 0 ? "gildata" : `gildata-workflow-${i}`,
      pkg: "gildata-aifinmarket",
      description: `Use for workflow ${i} on Gildata facts; trigger phrases include 个股分析、估值、研报; ${"equity research detail ".repeat(8)}`.slice(0, 245),
    })),
    ...Array.from({ length: 11 }, (_, i) => ({ name: `caixin-${i}`, pkg: "caixin-data-agent", description: `财新数据${i}：${"存储中国证券市场的基本信息与历史变动情况，".repeat(14)}`.slice(0, 420) })),
    ...Array.from({ length: 16 }, (_, i) => ({ name: `single-${i}`, pkg: `single-${i}`, description: `Standalone skill ${i}: ${"does one specific thing well ".repeat(8)}`.slice(0, 245) })),
    { name: "clone-site", description: "把一个公开网页完整复刻为本地离线运行的副本，连动效一并复刻。".repeat(8).slice(0, 600) },
  ];
  install(prod);
  const flat = managedSkills().map((s) => `- ${s.name} — ${s.description}\n  SKILL.md: ${s.skillMd}`).join("\n"); // 修前的平铺形状
  const folded = renderCatalog(catalogEntries(managedSkills()), catalogBudget(131_072));
  assert.equal(folded.level, 0, `本机 128K 窗口放得下完整一档（预算 2621 token）`);
  assert.ok(folded.text.length < flat.length * 0.3, `折叠后 ${folded.text.length} 字符，修前 ${flat.length}`);
});

// 瘦身 P0-3：完整一档也只留每条描述的第一句（封顶 120 字）——第二句往后是用法细节与触发词清单，Skill 载入时才要
test("P0-3 目录：每条描述只留第一句", () => {
  assert.equal(firstSentence("Generate audio in two ways: text-to-speech, or custom sound effects.### Speech (text-to-speech):- High-quality"), "Generate audio in two ways: text-to-speech, or custom sound effects.");
  assert.equal(firstSentence("把一个公开网页完整复刻为本地离线运行的副本，连动效一并复刻。**三条路径**：①静态站"), "把一个公开网页完整复刻为本地离线运行的副本，连动效一并复刻。");
  assert.equal(firstSentence("Version 2.1 of the tool"), "Version 2.1 of the tool", "小数点不是句末");
  assert.ok(firstSentence("x".repeat(400)).length <= 120);
  install([
    { name: "long-one", description: `Does the thing. ${"Extra usage detail and trigger phrases. ".repeat(10)}` },
    { name: "zh-one", description: `财新宏观数据：全国人口与生产总值。${"存储各省市的历史变动情况，".repeat(10)}` },
  ]);
  const section = managedSkillsSection({ contextWindow: 131_072 }) ?? "";
  assert.match(section, /^- long-one — Does the thing\.$/m);
  assert.match(section, /^- zh-one — 财新宏观数据：全国人口与生产总值。$/m);
});

test("C5 Skill 工具：包列成员、技能正文紧随工具结果作为 harness 消息（不在 tool_result 里）、同名不重复注入、名字不对列全部名字", async (t) => {
  install(FIXTURE);
  const adapter = scripted(t).next(
    calls(call("s1", "Skill", { name: "acme-data" })),
    calls(call("s2", "Skill", { name: "acme-quote", args: "<600519> & co" })),
    calls(call("s3", "Skill", { name: "acme-quote" })),
    calls(call("s4", "Skill", { name: "nope" })),
    say("完成"),
  );
  const session = attachSession(adapter, tmp, { tools: [skillTool] });
  const run = startRun(session, "查一下行情");
  await run.done;

  const msgs: Msg[] = session.state!.messages;
  const result = (id: string) => {
    for (const m of msgs) for (const b of m.content) if (b.t === "tool_result" && b.id === id) return { ok: b.ok, text: textOf(b.content), at: msgs.indexOf(m) };
    assert.fail(`没有 ${id} 的结果`);
  };
  const pkg = result("s1");
  assert.ok(pkg.ok && pkg.text.includes('Package "acme-data" — 5 skills') && pkg.text.includes("- acme-quote — 行情数据"), pkg.text);

  const loaded = result("s2");
  assert.ok(loaded.ok);
  assert.match(loaded.text, /^Skill "acme-quote" loaded/);
  assert.ok(!loaded.text.includes("BODY-acme-quote"), "正文不在 tool_result 里（微压缩只清旧工具输出）");
  const next = msgs[loaded.at + 1];
  assert.equal(next.role, "user");
  assert.equal(messageKind(next), "skill", "紧随其后的是一条 harness 注入（kind skill）");
  const body = textOf(next.content);
  assert.ok(body.startsWith("[Skill: acme-quote]"), body.slice(0, 80));
  assert.ok(body.includes("BODY-acme-quote") && !body.includes('description: "'), "正文去掉了 frontmatter");
  assert.ok(body.includes(`Skill directory: ${path.join(extRoot, "skills", "acme-quote")}`), "交回技能目录，脚本从那里跑");
  assert.ok(body.includes("<skill-args>&lt;600519&gt; &amp; co</skill-args>"), "参数做了 XML 转义");
  assert.ok(textOf(adapter.inputs[2].messages.flatMap((m) => m.content)).includes("BODY-acme-quote"), "下一次请求模型就看得到正文");

  const again = result("s3");
  assert.ok(again.ok && again.text.includes("already loaded"), again.text);
  assert.equal(msgs.filter((m) => messageKind(m) === "skill").length, 1, "同名不重复注入");

  const missing = result("s4");
  assert.equal(missing.ok, false);
  assert.ok(missing.text.includes('No skill or package named "nope"') && missing.text.includes("acme-data") && missing.text.includes("clone-site"), missing.text);
  assert.ok(!missing.text.includes("claude-only"));
});

test("C5 旧记录认得出技能注入；新装的技能按名现读、点名即可加载", async () => {
  assert.equal(injectionKind("[Skill: acme-quote]\nLoaded from the Bridge extension center."), "skill");
  install(FIXTURE.slice(0, 2));
  const ctx = { skillLoaded: () => false } as unknown as Parameters<typeof skillTool.run>[1];
  const before = await skillTool.run({ name: "late-skill" }, ctx);
  assert.equal(before.ok, false);
  install([...FIXTURE.slice(0, 2), { name: "late-skill", description: "Installed after the session started." }]);
  const after = await skillTool.run({ name: "late-skill" }, ctx);
  assert.ok(after.ok && after.skill?.text.includes("BODY-late-skill"), "会话里的清单冻结，但新装的技能点名就能用");
});
