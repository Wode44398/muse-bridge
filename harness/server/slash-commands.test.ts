// E3（G7；kimi 修订「命令即技能」）：斜杠命令。
//
// 修前：dimensio 没有命令。技能只能靠模型自己挑——用户说了「用 acme-quote」也得模型先调一次 Skill 工具，手机上 70 多个
// 技能常常挑不准、或者没载入就按自己的路子干；输入框里也没有地方看有哪些技能。
// 修后：消息以 /名字 开头、对得上扩展中心勾给 dimensio 的技能时，技能正文确定性地紧跟在这条消息后面（运行中发的走插话，
// 跟在插话后面）；认不出的照普通消息发。SKILL.md 写了 disable-model-invocation 的是「自定义命令」：模型看不到、载入不了，
// 只能用户点。输入框的 / 面板（内置命令 + 技能包 + 技能）的排序与发送时认内置命令是纯函数，这里一起测。
// 全部是假注册表 + 临时目录，不读真实扩展中心。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { messageKind } from "./agent/injections.ts";
import { visibleMessages } from "./agent/state.ts";
import type { Block, Msg } from "./agent/turn.ts";
import { commandList, resolveSlash } from "./commands.ts";
import { managedSkillsSection } from "./extensions.ts";
import { mirrorBaseCount, startRun, steerSession } from "./session.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { skillTool } from "./tools/skill.ts";
import { BUILTINS, paletteItems, parseBuiltin, slashQuery } from "../web/src/lib/slash.ts";

let tmp = "";
let extRoot = "";
const savedFile = process.env.BRIDGE_EXTENSIONS_FILE;

interface FakeSkill {
  name: string;
  description: string;
  pkg?: string;
  front?: string; // 额外的 frontmatter 行
  body?: string;
}

function install(skills: FakeSkill[]): void {
  const items = skills.map((s, i) => {
    const dir = path.join(extRoot, "skills", s.name);
    fs.mkdirSync(dir, { recursive: true });
    const front = `name: ${s.name}\ndescription: "${s.description}"\n${s.front ? `${s.front}\n` : ""}`;
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${front}---\n\n# ${s.name}\n\n${s.body ?? `BODY-${s.name}`}\n`);
    return {
      id: `id${i}`, type: "skill", name: s.name, description: s.description, enabled: true,
      agents: { claude: true, dimensio: true }, dir: `skills/${s.name}`, entry: "SKILL.md",
      ...(s.pkg ? { pkg: s.pkg } : {}),
    };
  });
  fs.writeFileSync(path.join(extRoot, "registry.json"), JSON.stringify({ items }));
}

const FIXTURE: FakeSkill[] = [
  { name: "clone-site", description: "Clone a public web page into an offline copy." },
  { name: "acme-quote", pkg: "acme-data", description: "行情数据：个股与指数的日线、分时与估值。" },
  { name: "acme-filing", pkg: "acme-data", description: "Use for company filings and announcements." },
  { name: "acme-macro", pkg: "acme-data", description: "Use for macro indicators such as CPI and GDP." },
  { name: "weekly-report", description: "按固定格式写周报。", front: "disable-model-invocation: true\nargument-hint: <本周要点>", body: "按下面的格式写周报，要点：$ARGUMENTS。" },
  { name: "house-style", description: "内部文风约定（给模型参考）。", front: "user-invocable: false" },
];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-e3-"));
  extRoot = path.join(tmp, "extensions");
  fs.mkdirSync(extRoot, { recursive: true });
  process.env.BRIDGE_EXTENSIONS_FILE = path.join(extRoot, "registry.json");
  install(FIXTURE);
});

afterEach(() => {
  if (savedFile === undefined) delete process.env.BRIDGE_EXTENSIONS_FILE;
  else process.env.BRIDGE_EXTENSIONS_FILE = savedFile;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
});

const textOf = (blocks: Block[]): string => blocks.map((b) => (b.t === "text" ? b.text : b.t === "tool_result" ? textOf(b.content) : "")).join("");
const inputText = (msgs: Msg[]) => textOf(msgs.flatMap((m) => m.content));

test("E3 解析：精确名（不分大小写、可带 skill:）、包名/技能名、包名都认；认不出的当普通消息（/api/... 不会被吞）", () => {
  const a = resolveSlash("  /ACME-quote  600519 的日线 ");
  assert.equal(a?.kind, "skill");
  assert.equal(a?.kind === "skill" && a.skill.name, "acme-quote");
  assert.equal(a?.args, "600519 的日线");
  assert.equal(resolveSlash("/skill:clone-site https://example.com")?.kind, "skill");
  const nested = resolveSlash("/acme-data/acme-macro CPI");
  assert.ok(nested?.kind === "skill" && nested.skill.name === "acme-macro");
  const pkg = resolveSlash("/acme-data 茅台最近怎么样");
  assert.ok(pkg?.kind === "pkg" && pkg.pkg.members.length === 3);
  for (const plain of ["/api/sessions 怎么调", "/", "/ 空格开头", "/nope 参数", "看一下 /acme-quote", "acme-quote"]) {
    assert.equal(resolveSlash(plain), null, plain);
  }
});

test("E3 /技能名 开跑：原话照留，正文紧跟一条 slash-skill 消息、第一次请求就看得到；skill_loaded 进 runLog，镜像底座停在用户消息", async (t) => {
  const adapter = scripted(t).next(say("好的，按技能来"));
  const session = attachSession(adapter, tmp, { tools: [skillTool] });
  const run = startRun(session, "/acme-quote 600519 的日线");
  assert.ok(run.started);
  await run.done;

  const msgs: Msg[] = session.state!.messages;
  const at = msgs.findIndex((m) => m.role === "user" && !m.origin && textOf(m.content) === "/acme-quote 600519 的日线");
  assert.ok(at >= 0, "用户原话照原样留着");
  const next = msgs[at + 1];
  assert.equal(messageKind(next), "slash-skill");
  const body = textOf(next.content);
  assert.ok(body.startsWith("[Skill: acme-quote]") && body.includes("/acme-quote") && body.includes("BODY-acme-quote"), body.slice(0, 200));
  assert.ok(!body.includes("<skill-args>"), "参数就在上面的用户消息里，不再另附");
  assert.ok(inputText(adapter.inputs[0].messages).includes("BODY-acme-quote"), "模型第一次请求就看得到正文，不用自己调 Skill");
  assert.deepEqual(
    session.runLog.filter((ev) => ev.e === "skill_loaded"),
    [{ e: "skill_loaded", name: "acme-quote", via: "slash" }],
  );
  assert.equal(session.runUserMsg, msgs[at], "镜像底座停在用户消息（技能那一行靠 runLog 里的 skill_loaded 补，不重复）");
  assert.equal(mirrorBaseCount(session), visibleMessages(msgs.slice(0, at + 1)).length);

  // 普通消息、认不出的 /xxx：什么都不追加
  const plain = scripted(t).next(say("收到"), say("收到"));
  const s2 = attachSession(plain, tmp, { tools: [skillTool] });
  await startRun(s2, "/api/sessions 这个接口怎么调").done;
  await startRun(s2, "看看行情").done;
  assert.equal(s2.state!.messages.filter((m) => messageKind(m) === "slash-skill").length, 0);
  assert.equal(s2.runLog.filter((ev) => ev.e === "skill_loaded").length, 0);
});

test("E3 再点一次只提醒、不整段再塞；正文用 $ARGUMENTS 的按新参数重新注入（参数原样替换，$ 字符不被当成替换模式）；/包名 列成员让模型挑", async (t) => {
  const adapter = scripted(t).next(say("一"), say("二"), say("三"), say("四"), say("五"));
  const session = attachSession(adapter, tmp, { tools: [skillTool] });
  const kinds = () => session.state!.messages.filter((m) => messageKind(m) === "slash-skill").map((m) => textOf(m.content));

  await startRun(session, "/acme-quote 600519").done;
  await startRun(session, "/acme-quote 000001").done;
  const [first, again] = kinds();
  assert.ok(first.includes("BODY-acme-quote"));
  assert.ok(again.startsWith("[Skill again: acme-quote]") && !again.includes("BODY-acme-quote"), again);

  await startRun(session, "/weekly-report 上线 v5.22、修了 $1 和 $& 两个坑").done;
  await startRun(session, "/weekly-report 第二周").done;
  const reports = kinds().filter((x) => x.startsWith("[Skill: weekly-report]"));
  assert.equal(reports.length, 2, "用了 $ARGUMENTS：换参数就重新注入");
  assert.ok(reports[0].includes("要点：上线 v5.22、修了 $1 和 $& 两个坑。"), reports[0]);
  assert.ok(reports[1].includes("要点：第二周。"));

  await startRun(session, "/acme-data 茅台最近怎么样").done;
  const pkg = kinds().at(-1)!;
  assert.ok(pkg.startsWith("[Skill package: acme-data]") && pkg.includes("- acme-quote — 行情数据") && pkg.includes("Skill({name"), pkg);
  assert.deepEqual(session.runLog.filter((ev) => ev.e === "skill_loaded"), [{ e: "skill_loaded", name: "acme-data", via: "slash", pkg: true }]);
});

test("E3 自定义命令（disable-model-invocation）：目录里没有、Skill 工具拒载、/名字 照样能点；user-invocable:false 不进 / 面板；argument-hint 进清单", async () => {
  const section = managedSkillsSection({ contextWindow: 131_072 }) ?? "";
  assert.ok(!section.includes("weekly-report"), "只能用户点的命令不给模型看");
  assert.ok(section.includes("house-style"), "不进面板的照样给模型看");

  const ctx = { skillLoaded: () => false } as unknown as Parameters<typeof skillTool.run>[1];
  const refused = await skillTool.run({ name: "weekly-report" }, ctx);
  assert.equal(refused.ok, false);
  assert.match(textOf(refused.content), /can only be started by the user.*\/weekly-report/s);
  assert.equal(resolveSlash("/weekly-report 本周")?.kind, "skill", "用户点名照样能用");

  const list = commandList();
  assert.deepEqual(list.skills.map((s) => s.name), ["clone-site", "acme-quote", "acme-filing", "acme-macro", "weekly-report"]);
  const weekly = list.skills.find((s) => s.name === "weekly-report")!;
  assert.equal(weekly.userOnly, true);
  assert.equal(weekly.argumentHint, "<本周要点>");
  assert.deepEqual(list.packages, [{ name: "acme-data", count: 3 }]);
});

test("E3 运行中发 /技能名 走插话：插话后面紧跟技能正文，loop 发 skill_loaded；下一次请求就看得到", async (t) => {
  const adapter = scripted(t);
  const session = attachSession(adapter, tmp, { tools: [skillTool] });
  let steered: ReturnType<typeof steerSession> | null = null;
  adapter.next(
    function* () {
      steered = steerSession(session, "/clone-site 顺便把首页也抓下来");
      yield* calls(call("s1", "Skill", { name: "nope" }));
    },
    say("好，一起抓"),
  );
  await startRun(session, "先看看这个站").done;
  assert.equal(steered!.ok, true);

  const msgs: Msg[] = session.state!.messages;
  const steerAt = msgs.findIndex((m) => m.origin === "steer");
  assert.ok(steerAt > 0);
  assert.equal(messageKind(msgs[steerAt + 1]), "slash-skill");
  assert.ok(textOf(msgs[steerAt + 1].content).includes("BODY-clone-site"));
  assert.ok(inputText(adapter.inputs[1].messages).includes("BODY-clone-site"), "下一次请求就看得到正文");
  const evs = session.runLog.map((ev) => ev.e);
  assert.ok(evs.indexOf("skill_loaded") > evs.indexOf("steer_applied"), evs.join(","));
});

test("E3 输入框 / 面板：只在打命令名时出现；排序 全名 > 前缀 > 词首 > 包含 > 说明，中文说明也搜得到；发送时只认内置命令的全名", () => {
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/acme"), "acme");
  assert.equal(slashQuery("/acme-quote 600519"), null, "敲了空格就是在写参数了");
  assert.equal(slashQuery("看 /acme"), null);

  const skills = commandList().skills;
  const packages = commandList().packages;
  const names = (q: string) => paletteItems(q, skills, packages).map((i) => `${i.kind}:${i.name}`);
  assert.deepEqual(names("").slice(0, 5), ["builtin:new", "builtin:compact", "builtin:handoff", "builtin:goal", "pkg:acme-data"], "空查询：内置在前、然后包、然后技能");
  assert.deepEqual(names("acme"), ["pkg:acme-data", "skill:acme-quote", "skill:acme-filing", "skill:acme-macro"]);
  assert.deepEqual(names("quote").slice(0, 1), ["skill:acme-quote"], "词首也算");
  assert.deepEqual(names("行情"), ["skill:acme-quote"], "中文说明也搜得到");
  assert.deepEqual(names("co"), ["builtin:compact", "skill:clone-site", "skill:acme-filing"], "名字前缀排最前；只在说明里出现的（copy、company）排后面");
  const blocked = paletteItems("comp", skills, packages, { disabled: (b) => (b.idleOnly ? "这一轮跑完再用" : undefined) });
  assert.equal(blocked[0].kind === "builtin" && blocked[0].disabled, "这一轮跑完再用");

  assert.equal(parseBuiltin("/compact")?.builtin.id, "compact");
  assert.deepEqual(parseBuiltin(" /Goal  让 npm test 全绿 "), { builtin: BUILTINS.find((b) => b.id === "goal")!, args: "让 npm test 全绿" });
  assert.equal(parseBuiltin("/compactx"), null);
  assert.equal(parseBuiltin("/acme-quote 600519"), null, "技能照常发给服务端展开");
  assert.equal(parseBuiltin("帮我 /compact 一下"), null);
});
