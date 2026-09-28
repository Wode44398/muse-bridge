// P1（#5、#47、#48）：权限模式与规则落盘 + 配置写回防丢失 + deny/ask 每次判定读当前配置 + 会话 allow 单独落盘
// 并绑定 {模式, 访问范围, 规则指纹} + Workflow 卡上的「本会话都允许」真的生效。
// 改写自探针 04-codex/笔记/probe-rules-frozen.ts 与 probe-workflow-session-allow.ts。
//
// 修前：① 设置页新加的 deny/ask 对已开着的会话永不生效（规则在会话建立时冻结）；② 「本会话都允许」只在
// 内存，会话闲置 30 分钟被淘汰就丢，切了模式 / 访问范围照样生效；③ 权限模式与规则不落盘，服务一重启回到
// auto + 空规则；④ Workflow 卡上点「本会话都允许」没人记账，下一次照样弹卡。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { AgentState } from "./agent/state.ts";
import { decide } from "./agent/permissions.ts";
import { configWritesSettled, getConfig, setConfig } from "./config.ts";
import {
  createSession,
  dropSession,
  evictIdleSessions,
  getOrLoadSession,
  persistNow,
  resolvePermission,
  startRun,
  watchSession,
} from "./session.ts";
import { saveSession } from "./store.ts";
import { Sandbox } from "./sandbox.ts";
import { workflowTool } from "./tools/workflow.ts";
import type { ProviderAdapter } from "./providers/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-p1-"));
const baseline = getConfig();
after(() => {
  setConfig({ permissionRules: baseline.permissionRules, permissionMode: baseline.permissionMode });
  fs.rmSync(ws, { recursive: true, force: true });
});

const push = { command: "git push origin main" };
const pub = { command: "npm publish" };

// persistChoice 走串行写队列；等排着的都落盘
const flushConfig = () => configWritesSettled();

async function oldSession(id: string) {
  // 用户加规则之前就开着的会话（假 key，全程不发请求）
  setConfig({ provider: "openai", apiKey: "FAKE-DUMMY-KEY", workspace: ws, permissionRules: { allow: [], deny: [], ask: [] }, permissionMode: "auto" });
  const g = getConfig();
  await saveSession({
    v: 1, id, createdAt: Date.now(), updatedAt: Date.now(), title: "p1",
    config: { provider: g.provider, model: g.model, baseUrl: g.baseUrl, thinking: g.thinking, permissionMode: "auto", permissionRules: g.permissionRules, workspace: ws, access: "workspace" },
    system: "p1", messages: [], todos: [],
  } as any);
  const s = await getOrLoadSession(id);
  assert.ok(s?.state);
  return s;
}

test("#47①：设置页新加的 deny / ask 对已开着的会话，下一次调用就生效", async () => {
  const s = await oldSession("p1-rules-0001");
  const st = s.state!;
  assert.equal(decide("auto", "Bash", st.toolMap, push, st.effectiveRules()).effect, "allow");

  setConfig({ permissionRules: { allow: [], deny: ["Bash(git push:*)"], ask: ["Bash(npm publish:*)"] } });
  assert.equal(decide("auto", "Bash", st.toolMap, push, st.effectiveRules()).effect, "deny", "修前旧会话照样 allow");
  assert.equal(decide("auto", "Bash", st.toolMap, pub, st.effectiveRules()).effect, "ask");
  dropSession(s.id);
});

test("#47②：「本会话都允许」随会话落盘，闲置淘汰后重载还在；切模式 / 访问范围 / 改规则就失效", async () => {
  const s = await oldSession("p1-rules-0002");
  setConfig({ permissionRules: { allow: [], deny: [], ask: ["Bash(npm run deploy:*)"] } });
  const deploy = { command: "npm run deploy" };
  s.state!.allowForSession("Bash", "npm run deploy");
  assert.equal(decide("auto", "Bash", s.state!.toolMap, deploy, s.state!.effectiveRules()).effect, "allow");
  await persistNow(s);

  s.touchedAt = Date.now() - 31 * 60_000; // 手机上走开 31 分钟
  assert.ok(evictIdleSessions() >= 1);
  const s2 = await getOrLoadSession("p1-rules-0002");
  const st = s2!.state!;
  assert.equal(decide("auto", "Bash", st.toolMap, deploy, st.effectiveRules()).effect, "allow", "修前重载后丢了，又弹卡");

  // 访问范围变了：这条允许不再算数
  st.ctx.sandbox.access = "full";
  assert.equal(decide("auto", "Bash", st.toolMap, deploy, st.effectiveRules()).effect, "ask");
  st.ctx.sandbox.access = "workspace";
  assert.equal(decide("auto", "Bash", st.toolMap, deploy, st.effectiveRules()).effect, "allow");
  // 全局规则改了（哪怕加的是别的规则）：同上
  setConfig({ permissionRules: { allow: [], deny: ["Bash(rm -rf:*)"], ask: ["Bash(npm run deploy:*)"] } });
  assert.equal(decide("auto", "Bash", st.toolMap, deploy, st.effectiveRules()).effect, "ask");
  dropSession(s2!.id);
});

test("#5：权限模式与规则落盘，重启后还在；K56：写前重读保留别的字段，坏文件改名留证不直接盖掉", async () => {
  const file = process.env.DIMENSIO_CONFIG_FILE!;
  await flushConfig(); // 前面用例排着的写盘先落地，免得盖掉下面手写的文件
  fs.writeFileSync(file, JSON.stringify({ v: 1, provider: "openai", model: getConfig().model, thinking: getConfig().thinking, handEdited: "keep me" }));
  setConfig({ permissionMode: "read-only", permissionRules: { allow: [], deny: ["Bash(git push:*)"], ask: [] } });
  await flushConfig();
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.permissionMode, "read-only");
  assert.deepEqual(onDisk.permissionRules.deny, ["Bash(git push:*)"]);
  assert.equal(onDisk.handEdited, "keep me", "别的字段原样保留");

  // 「重启」：新进程加载同一份配置文件
  const probe = `const C = await import(${JSON.stringify(pathToFileURL(path.join(here, "config.ts")).href)});` +
    `const c = C.getConfig(); console.log(JSON.stringify({ mode: c.permissionMode, rules: c.permissionRules }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env: { ...process.env, DIMENSIO_CONFIG_FILE: file }, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const reloaded = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
  assert.equal(reloaded.mode, "read-only", "修前重启回到 auto");
  assert.deepEqual(reloaded.rules.deny, ["Bash(git push:*)"], "修前重启回到空规则");

  // 坏文件：不直接盖掉，改名留证后再写
  fs.writeFileSync(file, "{ not json");
  setConfig({ permissionMode: "auto" });
  await flushConfig();
  const dir = path.dirname(file);
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(file) + ".corrupt-"));
  assert.equal(kept.length, 1, "坏文件改名留证");
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), "{ not json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).permissionMode, "auto");
});

test("#48：Workflow 卡上点「本会话都允许」，本会话之后的工作流不再弹卡", async () => {
  setConfig({ permissionRules: { allow: [], deny: [], ask: [] }, permissionMode: "auto" });
  const script = `export const meta = { name: "p1wf", description: "d", phases: [] };\nlog("x");\n`;
  let n = 0;
  const adapter: ProviderAdapter = {
    id: "openai", model: "fake",
    capabilities: { contextWindow: 100_000, maxOutputTokens: 1000, thinking: false, image: false, video: false, cache: false, parallelToolCalls: false },
    async *stream() {
      n++;
      if (n <= 3) {
        yield { e: "tool_call", id: `wf${n}`, name: "Workflow", args: { script } };
        yield { e: "turn_done", stopReason: "tool_use" };
        return;
      }
      yield { e: "text_delta", text: "done" };
      yield { e: "turn_done", stopReason: "end" };
    },
  };
  const session = createSession();
  let ran = 0;
  session.state = new AgentState({
    adapter, system: "t", tools: [workflowTool.def], budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: {
      sandbox: new Sandbox(ws), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false,
      runWorkflow: async () => {
        ran++;
        return { id: `wf_${ran}`, name: "p1wf", description: "d", phases: [], ok: true, agents: [], cached: 0, inputTokens: 0, outputTokens: 0, durationMs: 1, logs: [], result: null } as any;
      },
    },
    toolMap: new Map([["Workflow", workflowTool]]),
    permissionMode: "auto",
    memoryAuditRequired: false,
    liveRules: () => getConfig().permissionRules,
  });
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: ws, access: "workspace" };
  const events: Record<string, unknown>[] = [];
  const run = startRun(session, "跑三次工作流");
  watchSession(session, (ev) => {
    events.push(ev);
    if (ev.e === "permission_ask") resolvePermission(session, String(ev.id), "session"); // 用户点「本会话都允许」
  });
  await run.done;
  assert.equal(ran, 3, "三次工作流都跑了");
  assert.equal(events.filter((e) => e.e === "permission_ask").length, 1, "修前每次都弹卡（3 次）");
  assert.ok(session.cfg?.sessionAllow?.some((a) => a.rule === "Workflow"), "记进了会话配置（随会话落盘）");
  dropSession(session.id);
});
