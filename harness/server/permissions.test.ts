// 清单 #75/#76：权限模式（含 plan）与逐次调用规则的判定契约。
import assert from "node:assert/strict";
import test from "node:test";
import { callSubject, decide, ruleMatches, type PermissionRules } from "./agent/permissions.ts";
import { toolMap } from "./tools/registry.ts";
import { refreshDynamicContext, refreshPlanSection, systemPrompt } from "./agent/prompt.ts";

const tools = toolMap();
const rules = (r: Partial<PermissionRules>): PermissionRules => ({
  allow: r.allow ?? [],
  deny: r.deny ?? [],
  ask: r.ask ?? [],
});

test("rule patterns match the call's subject, not the whole args blob", () => {
  // 裸工具名 = 该工具的每次调用
  assert.equal(ruleMatches("Bash", "Bash", "ls"), true);
  assert.equal(ruleMatches("Bash", "Write", "ls"), false);
  // 前缀形式（最常用）：命令首段匹配，空白不敏感
  assert.equal(ruleMatches("Bash(git push:*)", "Bash", "git push origin main"), true);
  assert.equal(ruleMatches("Bash(git push:*)", "Bash", "git  push --force"), true);
  assert.equal(ruleMatches("Bash(git push:*)", "Bash", "git pushx"), false, "前缀必须落在词边界");
  assert.equal(ruleMatches("Bash(git push:*)", "Bash", "git status"), false);
  // glob 形式
  assert.equal(ruleMatches("Write(*)", "Write", "src/a.ts"), true);
  assert.equal(ruleMatches("Edit(src/*)", "Edit", "src/a.ts"), true);
  assert.equal(ruleMatches("Edit(src/*)", "Edit", "docs/a.md"), false);
  // 大小写不敏感的工具名，畸形规则不炸
  assert.equal(ruleMatches("bash(ls:*)", "Bash", "ls -la"), true);
  assert.equal(ruleMatches("((((", "Bash", "ls"), false);
});

test("callSubject picks the argument that actually matters per tool", () => {
  assert.equal(callSubject("Bash", { command: "npm test" }), "npm test");
  assert.equal(callSubject("Bash", { poll: "job3" }), "job3");
  assert.equal(callSubject("Write", { path: "a.ts", content: "x" }), "a.ts");
  assert.equal(callSubject("WebFetch", { url: "https://x.dev" }), "https://x.dev");
  assert.equal(callSubject("TodoWrite", { items: [] }), "");
});

test("deny outranks allow outranks ask, and unknown tools are denied", () => {
  const r = rules({ deny: ["Bash(rm -rf:*)"], ask: ["Bash"], allow: ["Bash(ls:*)"] });
  assert.equal(decide("auto", "Bash", tools, { command: "rm -rf /" }, r).effect, "deny");
  // allow 是用户的明示授权（含「本会话都允许」写进来的那条），必须压过 ask ——
  // 否则答完「本会话都允许」，下一次同形调用又弹一次卡
  assert.equal(decide("auto", "Bash", tools, { command: "ls -la" }, r).effect, "allow");
  // 没有 allow 兜住的调用仍然要问
  assert.equal(decide("auto", "Bash", tools, { command: "npm test" }, r).effect, "ask");
  assert.equal(decide("auto", "NoSuchTool", tools, {}, r).effect, "deny");
  // 无规则时 auto 直接放行
  assert.equal(decide("auto", "Bash", tools, { command: "ls" }).effect, "allow");
});

test("read-only and plan block effectful tools; deny rules bite in every mode", () => {
  for (const mode of ["read-only", "plan"] as const) {
    assert.equal(decide(mode, "Bash", tools, { command: "npm test" }).effect, "deny", `${mode} 拒执行`);
    // P4（C9）：纯读命令降为读，照常放行（细表见 shell-policy.test.ts）
    assert.equal(decide(mode, "Bash", tools, { command: "ls" }).effect, "allow", `${mode} 放行纯读命令`);
    assert.equal(decide(mode, "Write", tools, { path: "a.ts" }).effect, "deny", `${mode} 拒写`);
    assert.equal(decide(mode, "Read", tools, { path: "a.ts" }).effect, "allow", `${mode} 允许读`);
    // ExitPlanMode 是 plan 模式唯一的出口，绝不能被它自己挡住
    assert.equal(decide(mode, "ExitPlanMode", tools, { plan: "x" }).effect, "allow");
    // S2 止血（#35）：Workflow 脚本跑在 vm 里、vm 不是边界——按执行类工具算，只读 / plan 一律拒。
    assert.equal(decide(mode, "Workflow", tools, { script: "export const meta = {}" }).effect, "deny", `${mode} 拒 Workflow`);
  }
  assert.equal(decide("auto", "Workflow", tools, { script: "export const meta = {}" }).effect, "allow", "auto 照旧放行（再由确认卡把关）");
  // plan 的拒绝理由必须告诉模型出路（提示词之外的第二道保险）
  const why = decide("plan", "Write", tools, { path: "a.ts" }).reason;
  assert.match(why, /ExitPlanMode/);
  // deny 规则连读工具也照拦
  const r = rules({ deny: ["Read(secrets/*)"] });
  assert.equal(decide("auto", "Read", tools, { path: "secrets/k.txt" }, r).effect, "deny");
  assert.equal(decide("read-only", "Read", tools, { path: "secrets/k.txt" }, r).effect, "deny");
});

// #75 的恢复语义：plan 段是【会变】的，必须跟着当前模式对齐。会话在 plan 建立、
// 批准后转 auto，重开走 rec.system（不重新生成 prompt）——不摘掉这段，恢复出来的
// 模型还以为自己只读，会拒绝动手。
test("the plan-mode section follows the session's CURRENT mode across resume", () => {
  const env = {
    root: "C:/ws", shell: "bash", platform: "win32",
    provider: "openai", model: "x", webSearch: true, memory: "note-1: x",
  } as const;
  const M = "PLAN MODE IS ACTIVE";
  // 段首标记（前导空行 + 标题），区别于核心提示词里对它的引述
  const MEM_HEADING = String.fromCharCode(10, 10) + "## Memory index" + String.fromCharCode(10);
  const planPrompt = systemPrompt({ ...env, permissionMode: "plan" });
  const autoPrompt = systemPrompt({ ...env, permissionMode: "auto" });
  assert.ok(planPrompt.includes(M));
  assert.ok(!autoPrompt.includes(M));

  const refreshed = (system: string, mode: "auto" | "plan") =>
    refreshPlanSection(refreshDynamicContext(system, { memory: "note-1: x" }), mode, true);

  // 批准后（auto）重开：段摘掉，核心契约与 memory 段都还在
  const asAuto = refreshed(planPrompt, "auto");
  assert.ok(!asAuto.includes(M), "stale plan contract must not survive approval");
  assert.ok(asAuto.includes("## Deliverable form"));
  assert.ok(asAuto.includes("## Memory index"));

  // 仍是 plan 重开：段保留且不重复，且排在动态段之前
  const asPlan = refreshed(planPrompt, "plan");
  assert.equal(asPlan.split(M).length - 1, 1, "exactly one plan section");
  assert.ok(asPlan.indexOf(M) < asPlan.lastIndexOf(MEM_HEADING), "plan section precedes the dynamic tail");

  // 从没进过 plan 的会话切成 plan 重开：段补上
  assert.ok(refreshed(autoPrompt, "plan").includes(M));
});
