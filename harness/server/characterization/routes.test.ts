// 路由层的特征基准：拆分 index.ts 前后，一组有代表性的请求的状态码、内容类型与（规整后的）响应逐字不变，
// 全局事件通道上收到的事件（含「侧栏结构变了」中间件发的 list_changed）也不变。
// 拉起一个隔离的真 harness（数据位置继承 test-setup 的临时目录，环境文件指向不存在的路径，模型是本测试里的假服务）。
// 会拉起浏览器、本机模型、终端 PTY、真出网的接口不在这里打（只打它们「没在跑 / 参数不对」的那一支）。
//
// 不进 npm test。跑法与重新生成见 session-flows.test.ts 开头。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { INTERNAL_TOKEN_HEADER } from "../api-auth.ts";
import { baselineStore, Normalizer } from "./normalize.ts";

const HARNESS = path.resolve(import.meta.dirname, "..", "..");
const store = baselineStore(path.join(import.meta.dirname, "routes.baseline.json"), {
  update: process.env.UPDATE_CHAR_BASELINE === "1",
  actualDir: process.env.CHAR_ACTUAL_DIR,
});
const TOKEN = "char-DUMMY-process-token";
const roots: string[] = [];
let child: ChildProcess | null = null;
let provider: http.Server | null = null;
after(async () => {
  store.flush();
  if (child && child.exitCode === null) {
    child.kill(); // guard: raw-child-kill ok — 测试拉起的 node 进程没有子进程，收尾即可
    await new Promise((r) => child!.once("exit", r));
  }
  provider?.close();
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

const temp = (prefix: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};

// 8871 起找一个没人监听的端口（拆分验证的约定段）
async function portFrom(start: number): Promise<number> {
  for (let p = start; p < start + 30; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new Error(`no free port in ${start}..${start + 30}`);
}

// 假的本机模型：OpenAI 兼容流，每次都回同一段足够长的文字（也当得了压缩摘要）
const REPLY =
  "已经看过了：工作区里只有 a.txt，内容是 alpha。\n\n" +
  "Progress so far: the work recorded above was carried out step by step; continue from the most recent messages.\n".repeat(3);
function startProvider(): Promise<string> {
  provider = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: REPLY } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => provider!.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(provider!.address() as net.AddressInfo).port}/v1`)));
}

interface Req {
  name: string;
  method?: "GET" | "POST" | "DELETE" | "OPTIONS";
  path: string;
  body?: unknown;
  raw?: string; // 原样的请求体（上传）
  auth?: false;
  headers?: Record<string, string>;
  shape?: boolean; // 只记形状（内容与本机环境 / 构建有关）
  sse?: number; // 读 SSE，最多这么多条事件（读到流结束为止）
  drop?: string[]; // 记录前删掉的顶层字段（与本机环境有关的部分）
  mask?: (v: any) => unknown; // 记录前再抹掉的部分
}

function shapeOf(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf((v as Record<string, unknown>)[k])]));
  return v === null ? "null" : typeof v;
}

test("CR01 路由：状态码、内容类型、响应与全局事件", { timeout: 170_000 }, async () => {
  // 快照里 World State 的记忆节只露一个哈希；记忆索引里写着记忆目录的绝对路径（测试数据根每次都是新的临时目录），哈希逐次不同
  const norm = new Normalizer([[/sha1:[0-9a-f]{16}/g, "<world-sha>"]]);
  const ws = temp("dimensio-char-routes-ws-");
  fs.writeFileSync(path.join(ws, "a.txt"), "alpha\n");
  fs.mkdirSync(path.join(ws, "sub"));
  const dirsRoot = temp("dimensio-char-routes-dirs-");
  const providerBase = await startProvider();
  const port = await portFrom(8871);
  child = spawn(process.execPath, ["server/index.ts"], {
    cwd: HARNESS,
    env: {
      ...process.env,
      PORT: String(port),
      DIMENSIO_HOST: "127.0.0.1",
      DIMENSIO_INTERNAL_TOKEN: "",
      DIMENSIO_DEV_TOKEN: TOKEN,
      HARNESS_ENV_FILE: path.join(ws, "no-such.env"),
      DIMENSIO_OUTBOUND_PROXY: "off",
      WORKSPACE_DIR: ws,
      BRIDGE_PORT: "",
      KNOWLEDGE_AUTO_SEMANTIC: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const auth = { [INTERNAL_TOKEN_HEADER]: TOKEN };
  for (const deadline = Date.now() + 60_000; ;) {
    try {
      const r = await fetch(`${base}/api/info`, { headers: auth });
      await r.arrayBuffer();
      if (r.status === 200) break;
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`harness did not come up:\n${out}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  // 全局事件通道：整个过程都挂着
  const globalEvents: unknown[] = [];
  const evCtl = new AbortController();
  const evRes = await fetch(`${base}/api/events`, { headers: auth, signal: evCtl.signal });
  const evDone = (async () => {
    const reader = evRes.body!.getReader();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = /^data: (.*)$/m.exec(chunk);
          if (m) globalEvents.push(JSON.parse(m[1]));
        }
      }
    } catch { /* 收尾时断开 */ }
  })();

  const results: unknown[] = [];
  const vars: Record<string, string> = {};
  const sub = (s: string) => s.replace(/:(sid|sid2|ws|dirs|cp)\b/g, (_m, k: string) => encodeURIComponent(vars[k] ?? `<no-${k}>`));
  const subBody = (b: unknown): unknown => (b === undefined ? undefined : JSON.parse(sub(JSON.stringify(b)).replace(/%3A/gi, ":").replace(/%5C/gi, "\\\\").replace(/%2F/gi, "/")));

  async function hit(r: Req): Promise<any> {
    const url = base + sub(r.path);
    const headers: Record<string, string> = { ...(r.auth === false ? {} : auth), ...(r.headers ?? {}) };
    let body: string | undefined;
    if (r.raw !== undefined) body = r.raw;
    else if (r.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(subBody(r.body));
    }
    const ctl = new AbortController();
    const res = await fetch(url, { method: r.method ?? (body !== undefined ? "POST" : "GET"), headers, body, signal: ctl.signal });
    const type = (res.headers.get("content-type") ?? "").split(";")[0];
    let value: unknown;
    if (type === "text/event-stream") {
      const events: unknown[] = [];
      const reader = res.body!.getReader();
      let buf = "";
      while (events.length < (r.sse ?? 1000)) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(chunk);
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const m = /^data: (.*)$/m.exec(buf.slice(0, i));
          buf = buf.slice(i + 2);
          if (m) events.push(JSON.parse(m[1]));
        }
      }
      ctl.abort();
      value = events;
    } else {
      const text = await res.text();
      try { value = JSON.parse(text); } catch { value = text.slice(0, 2000); }
    }
    // 回显的来源里带着这次挑到的端口：抹成占位，基准才不随「当时哪个端口空着」变
    const cors = res.headers.get("access-control-allow-origin");
    const head = { total: res.headers.get("x-total-count"), cors: cors == null ? cors : cors.replace(`:${port}`, ":<port>"), guard: res.headers.get("x-dimensio-api-guard") };
    let recorded = value;
    if (r.drop && recorded && typeof recorded === "object" && !Array.isArray(recorded)) {
      recorded = Object.fromEntries(Object.entries(recorded as Record<string, unknown>).filter(([k]) => !r.drop!.includes(k)));
    }
    if (r.mask) recorded = r.mask(structuredClone(recorded));
    recorded = JSON.parse(JSON.stringify(recorded ?? null).split(providerBase).join("<provider>"));
    results.push({ name: r.name, status: res.status, type, head, body: r.shape ? shapeOf(recorded) : norm.value(recorded) });
    return value;
  }

  vars.ws = ws;
  vars.dirs = dirsRoot;
  // ── 中间件与探针 ──
  await hit({ name: "unauthorized", path: "/api/info", auth: false });
  await hit({ name: "preflight", method: "OPTIONS", path: "/api/info", auth: false, headers: { origin: `http://127.0.0.1:${port}`, "access-control-request-method": "POST" } });
  await hit({ name: "info", path: "/api/info", drop: ["build"], shape: true });
  await hit({ name: "busy", path: "/api/busy" });
  await hit({ name: "config-get", path: "/api/config", drop: ["workspace"] });
  await hit({ name: "config-post-bad-rule", path: "/api/config", body: { permissionRules: { allow: ["NoSuchTool(x)"], deny: [], ask: [] } } });
  await hit({ name: "config-post", path: "/api/config", body: { provider: "local", model: "qwen3.8-27b", baseUrl: providerBase, workspace: ":ws" }, drop: ["baseUrl"] });
  await hit({ name: "devices", path: "/api/devices" });
  await hit({ name: "devices-link-off", path: "/api/devices/link", body: { session: "x", link: "" } });
  await hit({ name: "commands", path: "/api/commands" });
  await hit({ name: "mcp", path: "/api/mcp" });
  await hit({ name: "net", path: "/api/net", shape: true });
  await hit({ name: "prefs", path: "/api/prefs", shape: true });
  await hit({ name: "prefs-bad", path: "/api/prefs", body: { values: { noSuchPref: 1 } } });
  await hit({ name: "provider-keys-bad", path: "/api/provider-keys", body: { provider: "no-such", apiKey: "DUMMY" } });
  await hit({ name: "custom-guess", path: "/api/custom-providers/guess", body: { ids: ["gpt-4o", "qwen-max"], protocol: "openai" } });
  await hit({ name: "custom-models-bad", path: "/api/custom-providers/models", body: {} });
  await hit({ name: "custom-get-missing", path: "/api/custom-providers/custom-nope" });
  await hit({ name: "custom-delete-missing", path: "/api/custom-providers/nope/delete", body: {} });
  await hit({ name: "custom-add-bad", path: "/api/custom-providers", body: {} });
  await hit({ name: "admin-retire-cancel-bad", path: "/api/admin/retire/cancel", body: { token: "nope" } });
  await hit({ name: "localai-tenant-pass", path: "/api/no-such-endpoint" });
  // ── 记忆与知识 ──
  await hit({ name: "memory-list", path: "/api/memory?workspace=:ws" });
  await hit({ name: "memory-save", path: "/api/memory/save", body: { workspace: ":ws", title: "测试记忆", description: "数据库选型", type: "project", topic: "db-choice", status: "proposed", confidence: "observed", content: "这个项目用 sqlite。" }, shape: true });
  const mems = await hit({ name: "memory-list-2", path: "/api/memory?workspace=:ws", shape: true });
  const memId = Array.isArray(mems) && mems[0]?.id ? String(mems[0].id) : "none";
  await hit({ name: "memory-get", path: `/api/memory/${memId}?workspace=:ws`, shape: true });
  await hit({ name: "memory-get-missing", path: "/api/memory/nope?workspace=:ws" });
  await hit({ name: "memory-overview", path: "/api/memory/overview", shape: true });
  await hit({ name: "memory-dream", path: "/api/memory/dream?workspace=:ws", shape: true });
  await hit({ name: "memory-dream-global", path: "/api/memory/dream?layer=global" });
  await hit({ name: "memory-search-empty", path: "/api/memory/search", body: { workspace: ":ws" } });
  await hit({ name: "memory-search", path: "/api/memory/search", body: { workspace: ":ws", query: "sqlite", semantic: false }, shape: true });
  await hit({ name: "memory-reject", path: `/api/memory/${memId}/reject`, body: { workspace: ":ws", reason: "不要了" } });
  await hit({ name: "memory-restore", path: `/api/memory/${memId}/restore`, body: { workspace: ":ws" } });
  await hit({ name: "memory-promote-missing", path: "/api/memory/nope/promote", body: { workspace: ":ws" } });
  await hit({ name: "memory-delete", path: `/api/memory/${memId}/delete`, body: { workspace: ":ws" } });
  await hit({ name: "memory-bad-ws", path: "/api/memory?workspace=relative/path" });
  await hit({ name: "knowledge-status", path: "/api/knowledge/status", shape: true });
  await hit({ name: "knowledge-modules", path: "/api/knowledge/modules?q=a", shape: true });
  await hit({ name: "knowledge-contracts", path: "/api/knowledge/contracts", shape: true });
  await hit({ name: "knowledge-search-empty", path: "/api/knowledge/search", body: {} });
  await hit({ name: "knowledge-search", path: "/api/knowledge/search", body: { query: "alpha", semantic: false }, shape: true });
  await hit({ name: "knowledge-refresh", path: "/api/knowledge/refresh", body: {}, shape: true });
  await hit({ name: "knowledge-metrics", path: "/api/knowledge/metrics", shape: true });
  // ── 发送一轮（SSE）──
  await hit({ name: "run-bad", path: "/api/run", body: { message: "" } });
  await hit({ name: "run-bad-attachments", path: "/api/run", body: { message: "x", attachments: "a.txt" } });
  await hit({ name: "run-unknown-session", path: "/api/run", body: { sessionId: "no-such-session", message: "x" } });
  const events = (await hit({ name: "run", path: "/api/run", body: { message: "看看 a.txt", clientRunId: "char-run-000001" } })) as any[];
  vars.sid = String(events.find((e) => e.e === "session")?.sessionId ?? "");
  await hit({ name: "run-duplicate", path: "/api/run", body: { message: "看看 a.txt", clientRunId: "char-run-000001" } });
  await hit({ name: "runs-known", path: "/api/runs/char-run-000001" });
  await hit({ name: "runs-unknown", path: "/api/runs/char-run-999999" });
  await hit({ name: "run-2", path: "/api/run", body: { sessionId: ":sid", message: "再说一遍" } });
  // ── 会话读取 ──
  await hit({ name: "sessions", path: "/api/sessions" });
  await hit({ name: "sessions-page", path: "/api/sessions?offset=0&limit=1" });
  await hit({ name: "sessions-search", path: "/api/sessions/search?q=alpha" });
  await hit({ name: "pending", path: "/api/pending" });
  await hit({ name: "session-status", path: "/api/sessions/:sid/status" });
  await hit({ name: "session-status-missing", path: "/api/sessions/no-such-session/status" });
  await hit({ name: "session-get", path: "/api/sessions/:sid" });
  await hit({ name: "session-get-missing", path: "/api/sessions/no-such-session" });
  // system 里写着工作区的绝对路径（每次是新的临时目录），它的哈希不稳定
  await hit({ name: "session-requests", path: "/api/sessions/:sid/requests", mask: (v) => { for (const q of v?.requests ?? []) if (q?.hashes) q.hashes.system = "<hash>"; return v; } });
  await hit({ name: "session-health", path: "/api/sessions/:sid/health" });
  await hit({ name: "session-artifact-nopath", path: "/api/sessions/:sid/artifact" });
  await hit({ name: "session-artifact-unattached", path: "/api/sessions/:sid/artifact?path=a.txt" });
  await hit({ name: "session-asset-missing", path: "/api/sessions/:sid/assets/nope.png" });
  await hit({ name: "session-workflow-missing", path: "/api/sessions/:sid/workflows/wf-nope" });
  await hit({ name: "session-stream-idle", path: "/api/sessions/:sid/stream" });
  await hit({ name: "session-diagnostics", path: "/api/sessions/:sid/diagnostics", body: {}, shape: true });
  await hit({ name: "session-usage", path: "/api/sessions/:sid/usage" });
  await hit({ name: "session-jobs", path: "/api/sessions/:sid/jobs" });
  await hit({ name: "session-job-kill", path: "/api/sessions/:sid/jobs/job1/kill", body: {} });
  await hit({ name: "session-tool-bg", path: "/api/sessions/:sid/tools/c1/background", body: {} });
  // ── 会话级开关与卡片 ──
  await hit({ name: "mode-bad", path: "/api/sessions/:sid/mode", body: { mode: "nope" } });
  await hit({ name: "mode", path: "/api/sessions/:sid/mode", body: { mode: "plan" } });
  await hit({ name: "mode-back", path: "/api/sessions/:sid/mode", body: { mode: "auto" } });
  await hit({ name: "mode-missing", path: "/api/sessions/no-such-session/mode", body: { mode: "auto" } });
  await hit({ name: "away", path: "/api/sessions/:sid/away", body: { away: true } });
  await hit({ name: "away-off", path: "/api/sessions/:sid/away", body: { away: false } });
  await hit({ name: "access", path: "/api/sessions/:sid/access", body: { access: "full" } });
  await hit({ name: "access-back", path: "/api/sessions/:sid/access", body: { access: "workspace" } });
  await hit({ name: "model-bad", path: "/api/sessions/:sid/model", body: { thinking: "ultra" } });
  await hit({ name: "read-roots-bad", path: "/api/sessions/:sid/read-roots", body: {} });
  await hit({ name: "read-roots", path: "/api/sessions/:sid/read-roots", body: { remove: "C:\\nope" } });
  await hit({ name: "answer", path: "/api/sessions/:sid/answer", body: { askId: "nope", answers: [] } });
  await hit({ name: "answer-missing", path: "/api/sessions/no-such-session/answer", body: {} });
  await hit({ name: "permission", path: "/api/sessions/:sid/permission", body: { id: "nope", decision: "once" } });
  await hit({ name: "plan", path: "/api/sessions/:sid/plan", body: { id: "nope", approved: true } });
  await hit({ name: "steer-idle", path: "/api/sessions/:sid/steer", body: { text: "hi" } });
  await hit({ name: "steer-withdraw-noid", path: "/api/sessions/:sid/steer/withdraw", body: {} });
  await hit({ name: "steer-withdraw", path: "/api/sessions/:sid/steer/withdraw", body: { id: "steer-nope-0001" } });
  await hit({ name: "steer-interrupt", path: "/api/sessions/:sid/steer/interrupt", body: { id: "steer-nope-0001" } });
  await hit({ name: "stop", path: "/api/stop", body: { sessionId: ":sid" } });
  await hit({ name: "stop-mismatch-idle", path: "/api/stop", body: { sessionId: ":sid", runId: "other" } });
  // ── 检查点、目标、改写、卫生 ──
  const cps = await hit({ name: "checkpoints", path: "/api/sessions/:sid/checkpoints" });
  vars.cp = String(Array.isArray(cps) && cps.length ? (cps[0].n ?? 1) : 1);
  await hit({ name: "checkpoint-diff", path: "/api/sessions/:sid/checkpoints/:cp/diff" });
  await hit({ name: "checkpoint-diff-missing", path: "/api/sessions/:sid/checkpoints/99/diff" });
  await hit({ name: "rollback-bad", path: "/api/sessions/:sid/rollback", body: {} });
  await hit({ name: "goal-bad", path: "/api/sessions/:sid/goal", body: { action: "nope" } });
  await hit({ name: "goal-none", path: "/api/sessions/:sid/goal", body: { action: "pause" } });
  await hit({ name: "files-restore-bad", path: "/api/sessions/:sid/files/restore", body: { paths: [] } });
  await hit({ name: "files-restore-stale", path: "/api/sessions/:sid/files/restore", body: { paths: ["zzz.txt"] } });
  await hit({ name: "rewind-bad", path: "/api/sessions/:sid/rewind", body: {} });
  await hit({ name: "rewind-missing", path: "/api/sessions/:sid/rewind", body: { ordinal: 9, text: "没有" } });
  await hit({ name: "rewind-undo-bad", path: "/api/sessions/:sid/rewind/undo", body: {} });
  await hit({ name: "handoff-bad", path: "/api/sessions/:sid/handoff", body: { kind: "nope" } });
  await hit({ name: "handoff-plan-missing", path: "/api/sessions/:sid/handoff", body: { kind: "plan", planId: "nope" } });
  await hit({ name: "compact", path: "/api/sessions/:sid/compact", body: {} });
  const h = await hit({ name: "handoff-summary", path: "/api/sessions/:sid/handoff", body: { kind: "summary" } });
  vars.sid2 = String(h?.sessionId ?? "");
  // ── 项目与快照 ──
  await hit({ name: "projects", path: "/api/projects", shape: true });
  await hit({ name: "projects-bad-mode", path: "/api/projects", body: { mode: "nope" } });
  await hit({ name: "projects-blank", path: "/api/projects", body: { mode: "blank", name: "char-proj" }, shape: true });
  await hit({ name: "projects-rename", path: "/api/projects/rename", body: { path: ":ws", name: "改名后" }, shape: true });
  await hit({ name: "projects-flags", path: "/api/projects/flags", body: { path: ":ws", pinned: true }, shape: true });
  await hit({ name: "projects-order", path: "/api/projects/order", body: { paths: [":ws"] } });
  await hit({ name: "quick-new", path: "/api/quick/new", body: {}, shape: true });
  await hit({ name: "quick-save-bad", path: "/api/quick/save", body: { path: "C:\\nope" } });
  // ── 文件、dock、目录 ──
  await hit({ name: "files", path: "/api/files" });
  await hit({ name: "files-upload-nopath", path: "/api/files/upload", raw: "x" });
  await hit({ name: "files-upload", path: "/api/files/upload?path=up/b.txt&sessionId=:sid", raw: "uploaded\n", headers: { "content-type": "application/octet-stream" } });
  await hit({ name: "dock-review", path: "/api/dock/review?ws=:ws", shape: true });
  await hit({ name: "dock-review-session-noid", path: "/api/dock/review?scope=session" });
  await hit({ name: "dock-review-session", path: "/api/dock/review?scope=session&chatId=:sid" });
  await hit({ name: "dock-review-diff-session-bad", path: "/api/dock/review/diff?scope=session&chatId=:sid&file=..%2Fx" });
  await hit({ name: "dock-review-diff", path: "/api/dock/review/diff?ws=:ws&file=a.txt" });
  await hit({ name: "dock-files", path: "/api/dock/files?ws=:ws" });
  await hit({ name: "dock-file", path: "/api/dock/file?ws=:ws&path=a.txt" });
  await hit({ name: "dock-file-missing", path: "/api/dock/file?ws=:ws&path=nope.txt" });
  await hit({ name: "dock-file-nopath", path: "/api/dock/file?ws=:ws" });
  await hit({ name: "dock-file-secret", path: "/api/dock/file?ws=:ws&path=.env" });
  await hit({ name: "dock-ws-missing", path: "/api/dock/files?ws=C%3A%5Cno-such-dir-char" });
  await hit({ name: "dock-term-input", path: "/api/dock/term/input", body: { ws: ":ws", data: "" } });
  await hit({ name: "dock-term-resize", path: "/api/dock/term/resize", body: { ws: ":ws", cols: 80, rows: 24 } });
  await hit({ name: "dock-term-kill", path: "/api/dock/term/kill", body: { ws: ":ws" } });
  await hit({ name: "fs-dirs", path: "/api/fs/dirs?path=:dirs" });
  await hit({ name: "fs-mkdir", path: "/api/fs/mkdir", body: { path: path.join(dirsRoot, "made") } });
  await hit({ name: "fs-dirs-2", path: "/api/fs/dirs?path=:dirs" });
  // ── 浏览器（只打没在跑的那一支）与预览 ──
  await hit({ name: "browser-state", path: "/api/browser/state?sessionId=:sid" });
  await hit({ name: "browser-stream-off", path: "/api/browser/stream?sessionId=:sid" });
  await hit({ name: "browser-input-off", path: "/api/browser/input", body: { sessionId: ":sid", type: "click" } });
  await hit({ name: "browser-resize-off", path: "/api/browser/resize", body: { sessionId: ":sid", preset: "mobile" } });
  await hit({ name: "browser-tab-activate-off", path: "/api/browser/tabs/activate", body: { sessionId: ":sid", id: "t" } });
  await hit({ name: "browser-tab-close-off", path: "/api/browser/tabs/close", body: { sessionId: ":sid", id: "t" } });
  await hit({ name: "browser-navigate-back-off", path: "/api/browser/navigate", body: { sessionId: ":sid", dir: "back" } });
  await hit({ name: "browser-navigate-nourl", path: "/api/browser/navigate", body: { sessionId: ":sid" } });
  await hit({ name: "browser-navigate-path-noservice", path: "/api/browser/navigate", body: { sessionId: ":sid", url: "/x" } });
  await hit({ name: "browser-isolate-noid", path: "/api/browser/isolate", body: {} });
  await hit({ name: "preview-services", path: "/api/preview/services" });
  await hit({ name: "preview-stop-session", path: "/api/preview/stop", body: { sessionId: ":sid" } });
  await hit({ name: "preview-stop-id", path: "/api/preview/stop", body: { serviceId: "nope" } });
  await hit({ name: "preview-stop-all", path: "/api/preview/stop", body: {} });
  // ── 删除与兜底 ──
  await hit({ name: "session-delete-post", path: "/api/sessions/:sid2/delete", body: {} });
  await hit({ name: "session-delete", method: "DELETE", path: "/api/sessions/:sid" });
  await hit({ name: "session-get-deleted", path: "/api/sessions/:sid" });
  await hit({ name: "api-404", path: "/api/definitely/not/here" });
  await hit({ name: "api-404-post", path: "/api/definitely/not/here", body: {} });
  await hit({ name: "spa-root", path: "/", auth: false });
  await hit({ name: "admin-retire-prepare", path: "/api/admin/retire/prepare", body: { ttlMs: 60_000 }, shape: true });
  await hit({ name: "run-while-retiring", path: "/api/run", body: { message: "x" } });
  await hit({ name: "busy-retiring", path: "/api/busy" });
  await hit({ name: "admin-retire-cancel", path: "/api/admin/retire/cancel", body: {} });

  await new Promise((r) => setTimeout(r, 300));
  evCtl.abort();
  await evDone;
  store.check("CR01-routes", { results, global: norm.value(globalEvents) });
});
