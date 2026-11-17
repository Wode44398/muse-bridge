// agent 主循环（agent/loop.ts）的特征基准：拆分前后，重试、续写、各门禁的追问、预算、连续拒绝、并发只读调用、待办提醒、
// 未知 / 未加载工具这些分支的事件序列、发给模型的请求与落盘记录逐字不变。走生产路径（buildState 建的真工具表）。
//
// 不进 npm test。跑法与重新生成见 session-flows.test.ts 开头。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import { createSession, dropSession, resolvePermission } from "../session.ts";
import type { StreamEvent } from "../agent/events.ts";
import { call, calls, say, useTool } from "../test-harness/scripted-adapter.ts";
import { baselineStore } from "./normalize.ts";
import { configure, Trace, turn, waitFor, workspace } from "./flow-kit.ts";

const store = baselineStore(path.join(import.meta.dirname, "loop-flows.baseline.json"), {
  update: process.env.UPDATE_CHAR_BASELINE === "1",
  actualDir: process.env.CHAR_ACTUAL_DIR,
});
const roots: string[] = [];
const BASE = { sessions: process.env.SESSIONS_DIR, semantic: process.env.KNOWLEDGE_AUTO_SEMANTIC, retry: process.env.DIMENSIO_RETRY_SCALE };
process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-char-sessions-"));
roots.push(process.env.SESSIONS_DIR);
process.env.KNOWLEDGE_AUTO_SEMANTIC = "0";
// 重试退避整体调快（逻辑不变）；退避本身带随机抖动，等多久不进基准
process.env.DIMENSIO_RETRY_SCALE = "0.001";
const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
after(() => {
  store.flush();
  restore("SESSIONS_DIR", BASE.sessions);
  restore("KNOWLEDGE_AUTO_SEMANTIC", BASE.semantic);
  restore("DIMENSIO_RETRY_SCALE", BASE.retry);
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

const ev = (...events: StreamEvent[]): StreamEvent[] => events;
const readA = useTool("r1", "Read", { path: "a.txt" });

async function scenario(t: TestContext, name: string, body: (tr: Trace, root: string) => Promise<string>) {
  const tr = new Trace(t, store);
  const root = workspace(roots);
  const id = await body(tr, root);
  tr.steps.push({ label: "disk", value: await tr.disk(id) });
  tr.finish(name);
  dropSession(id);
}

test("LX01 可重试的上游错误：退避后重发成功", async (t) => {
  await scenario(t, "LX01-retry", async (tr, root) => {
    configure(root);
    const s = createSession();
    await turn(tr, s, "run", "你好", [
      ev({ e: "error", kind: "http_503", retriable: true, raw: "upstream overloaded", class: "overloaded", summary: "上游过载" }),
      ev({ e: "error", kind: "http_429", retriable: true, raw: "slow down", class: "rate_limit", summary: "限流", retryAfterMs: 5 }),
      say("重发之后好了。"),
    ]);
    return s.id;
  });
});

test("LX02 不可重试的上游错误：这一轮以错误收场，转录补一条边界", async (t) => {
  await scenario(t, "LX02-fatal-error", async (tr, root) => {
    configure(root);
    const s = createSession();
    await turn(tr, s, "run", "看看 a.txt", [readA, ev({ e: "error", kind: "http_400", retriable: false, raw: { error: "bad request" }, summary: "请求有误" })]);
    await turn(tr, s, "run2", "再试一次", [say("这次好了。")]);
    return s.id;
  });
});

test("LX03 输出被长度上限截断：追一句接着写", async (t) => {
  await scenario(t, "LX03-length-continue", async (tr, root) => {
    configure(root);
    const s = createSession();
    await turn(tr, s, "run", "写长一点", [say("前半段，", "length"), say("后半段。")]);
    return s.id;
  });
});

test("LX04 空回应：重发一次；再空就以 empty_model_response 收场", async (t) => {
  await scenario(t, "LX04-empty-response", async (tr, root) => {
    configure(root);
    const s = createSession();
    await turn(tr, s, "run1", "你好", [ev({ e: "turn_done", stopReason: "end" }), say("刚才断了，现在好了。")]);
    await turn(tr, s, "run2", "再来", [ev({ e: "turn_done", stopReason: "end" }), ev({ e: "turn_done", stopReason: "end" })]);
    return s.id;
  });
});

test("LX05 只有思考没有答复：追问一次", async (t) => {
  await scenario(t, "LX05-answer-nudge", async (tr, root) => {
    configure(root);
    const s = createSession();
    await turn(tr, s, "run", "说点什么", [ev({ e: "thinking_delta", text: "想一想该怎么答。" }, { e: "usage", inputTokens: 10, outputTokens: 5 }, { e: "turn_done", stopReason: "end" }), say("答复在这里。")]);
    return s.id;
  });
});

test("LX06 待办没做完、话说到一半：追问接着干；之后待办提醒", async (t) => {
  await scenario(t, "LX06-cutoff-and-todo-reminder", async (tr, root) => {
    configure(root);
    const s = createSession();
    await turn(tr, s, "run", "改一下", [
      useTool("t1", "TodoWrite", { todos: [{ content: "改 a.txt", status: "in_progress" }, { content: "跑测试", status: "pending" }] }),
      say("我先看一下文件，然后改，"),
      readA,
      useTool("r2", "Read", { path: "sub/note.md" }),
      useTool("r3", "Read", { path: "a.txt", offset: 1 }),
      useTool("r4", "Glob", { pattern: "*.txt" }),
      useTool("r5", "Grep", { pattern: "alpha" }),
      useTool("r6", "Read", { path: "sub/note.md", offset: 1 }),
      say("看完了，待办还没做。"),
    ]);
    return s.id;
  });
});

test("LX07 改了代码没交验证证据：追问；跑了真的检查之后收尾", async (t) => {
  await scenario(t, "LX07-verify-gate", async (tr, root) => {
    configure(root);
    const s = createSession();
    await turn(tr, s, "run", "加一个函数", [
      useTool("w1", "Write", { path: "add.ts", content: "export const add = (a: number, b: number) => a + b;\n" }),
      say("加好了。"),
      useTool("v1", "Bash", { command: "node -e \"process.exit(0)\"", verify: true }),
      say("验证过了，加好了。"),
    ]);
    return s.id;
  });
});

test("LX08 计划模式里用散文答「计划」：提醒一次提交计划", async (t) => {
  await scenario(t, "LX08-plan-nudge", async (tr, root) => {
    configure(root, { permissionMode: "plan" });
    const s = createSession();
    await turn(tr, s, "run", "把 a.txt 改成 beta", [say("我的计划是把 a.txt 改成 beta。"), say("这只是回答，已经说完了。")]);
    return s.id;
  });
});

test("LX09 一轮里并发多个只读调用", async (t) => {
  await scenario(t, "LX09-parallel-reads", async (tr, root) => {
    configure(root);
    const s = createSession();
    await turn(tr, s, "run", "两个都看看", [calls(call("p1", "Read", { path: "a.txt" }), call("p2", "Read", { path: "sub/note.md" }), call("p3", "Glob", { pattern: "*.txt" })), say("都看完了。")]);
    return s.id;
  });
});

test("LX10 轮数预算：到 80% 提醒收敛，用完之后只给一轮写总结（工具调用不执行）", async (t) => {
  await scenario(t, "LX10-budget", async (tr, root) => {
    configure(root);
    const s = createSession();
    await turn(tr, s, "run", "多看几个", [readA, useTool("r2", "Read", { path: "sub/note.md" }), useTool("r3", "Read", { path: "a.txt", offset: 1 }), useTool("r4", "Read", { path: "a.txt" }), say("总结：看了几个文件。")], { budget: { maxTurns: 4 } });
    return s.id;
  });
});

test("LX11 连续几次没被批准：停手，收尾轮交代清楚", async (t) => {
  await scenario(t, "LX11-denials-stop", async (tr, root) => {
    configure(root, { permissionRules: { allow: [], deny: [], ask: ["Write"] } });
    const s = createSession();
    let denied = 0;
    await turn(tr, s, "run", "写三个文件", [
      useTool("w1", "Write", { path: "x1.txt", content: "1\n" }),
      useTool("w2", "Write", { path: "x2.txt", content: "2\n" }),
      useTool("w3", "Write", { path: "x3.txt", content: "3\n" }),
      say("都没被批准，等你决定。"),
    ], {
      during: async (_a, live) => {
        for (let i = 0; i < 3; i++) {
          await waitFor(`第 ${i + 1} 张权限卡`, () => live().filter((e) => e.e === "permission_ask").length > i);
          const card = live().filter((e) => e.e === "permission_ask")[i];
          if (resolvePermission(s, String(card.id), "deny", i === 0 ? "先别写" : undefined)) denied++;
        }
      },
    });
    tr.note("denied", denied);
    return s.id;
  });
});

test("LX12 未知工具、参数不对、未加载的延迟工具", async (t) => {
  await scenario(t, "LX12-bad-calls", async (tr, root) => {
    configure(root);
    const s = createSession();
    await turn(tr, s, "run", "随便试试", [
      useTool("u1", "NoSuchTool", { x: 1 }),
      useTool("u2", "Read", { nope: true }),
      useTool("u3", "Browser", { action: "navigate", url: "about:blank" }),
      useTool("u4", "ToolSearch", { query: "select:Browser" }),
      say("试完了。"),
    ]);
    return s.id;
  });
});
