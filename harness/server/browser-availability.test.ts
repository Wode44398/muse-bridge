// D5（移植自 Muse Bridge）：没有浏览器的机器上不提供浏览器工具、提示词跟着降级。
// 修前：Browser / ReadPage / Eval / Network 恒注册，system 与 playbook 恒写浏览器验证路线——没装 Chromium 的 Linux VPS、
// Chromium 起不来（snap 空壳、No usable sandbox）的 VM 上，模型会反复调 Browser、每次都「起不来」，白耗轮次。
// 修后：本机浏览器 / 桌面壳的浏览器宿主 / 经扩展连着的用户浏览器有一个就照常；都没有才降级。建会话时定一次，会话内不变。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import { systemPrompt } from "./agent/prompt.ts";
import { setConfig } from "./config.ts";
import {
  browserBackendsFrom,
  browserLaunchFailedRecently,
  browserOverride,
  clearBrowserLaunchFailure,
  findBrowser,
  judgeBrowserAvailable,
  noteBrowserLaunchFailure,
  type BrowserProbe,
} from "./headless.ts";
import { createSession, startRun, type Session } from "./session.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { toolDefs } from "./tools/registry.ts";

const BROWSER_TOOLS = ["Browser", "ReadPage", "Eval", "Network"];
const SAVED = process.env.DIMENSIO_BROWSER;
const roots: string[] = [];
after(() => {
  if (SAVED === undefined) delete process.env.DIMENSIO_BROWSER;
  else process.env.DIMENSIO_BROWSER = SAVED;
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

function setEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.DIMENSIO_BROWSER;
  else process.env.DIMENSIO_BROWSER = value;
}

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.DIMENSIO_BROWSER;
  setEnv(value);
  try {
    return fn();
  } finally {
    setEnv(before);
  }
}

const none: BrowserProbe = { override: null, localBrowser: undefined, localFailed: false, desktopHost: false, extension: false };

test("D5 判定：三种后端任何一个在就算有；都没有才算没有", () => {
  assert.equal(judgeBrowserAvailable(none), false, "没装浏览器、没有桌面壳、没连扩展");
  assert.equal(judgeBrowserAvailable({ ...none, localBrowser: "/usr/bin/chromium" }), true, "本机 Chromium");
  assert.equal(judgeBrowserAvailable({ ...none, desktopHost: true }), true, "只有桌面壳的浏览器宿主");
  assert.equal(judgeBrowserAvailable({ ...none, extension: true }), true, "只有经扩展连着的用户浏览器");
  assert.deepEqual(browserBackendsFrom({ ...none, localBrowser: "x", desktopHost: true, extension: true }), ["local", "desktop", "extension"]);
  // 装着但最近真启动没起来（snap 空壳 / No usable sandbox）：本机这一路不算，别的后端照算
  assert.equal(judgeBrowserAvailable({ ...none, localBrowser: "/usr/bin/chromium", localFailed: true }), false);
  assert.equal(judgeBrowserAvailable({ ...none, localBrowser: "/usr/bin/chromium", localFailed: true, desktopHost: true }), true);
});

test("D5 部署方开关 DIMENSIO_BROWSER：off 压过探测结果，on 一律当作有，不设 / 认不得的值 = 自动", () => {
  for (const v of ["off", "OFF", "0", "false", "no", "none"]) assert.equal(browserOverride(v), false, v);
  for (const v of ["on", "1", "true", "yes"]) assert.equal(browserOverride(v), true, v);
  for (const v of [undefined, "", "auto", "maybe"]) assert.equal(browserOverride(v), null, String(v));
  assert.equal(judgeBrowserAvailable({ override: false, localBrowser: "x", localFailed: false, desktopHost: true, extension: true }), false);
  assert.equal(judgeBrowserAvailable({ ...none, override: true }), true);
});

test("D5 起不来的记忆：按路径 + 文件签名认，10 分钟过期，换了文件或启动成功就清掉", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-nobrowser-"));
  roots.push(dir);
  const exe = path.join(dir, "chromium");
  fs.writeFileSync(exe, "#!/bin/sh\necho snap only\n");
  const t0 = 1_000_000;
  assert.equal(browserLaunchFailedRecently(exe, t0), false);
  noteBrowserLaunchFailure(exe, t0);
  assert.equal(browserLaunchFailedRecently(exe, t0 + 60_000), true);
  assert.equal(browserLaunchFailedRecently(exe, t0 + 11 * 60_000), false, "过期就再给一次机会");
  noteBrowserLaunchFailure(exe, t0);
  fs.writeFileSync(exe, "#!/bin/sh\nexec /opt/chrome/chrome \"$@\"\n# the real package\n");
  assert.equal(browserLaunchFailedRecently(exe, t0 + 60_000), false, "重装 / 换成真包");
  noteBrowserLaunchFailure(exe, t0);
  clearBrowserLaunchFailure(exe);
  assert.equal(browserLaunchFailedRecently(exe, t0 + 60_000), false, "启动成功清掉");
});

test("D5 注册表：没有浏览器时四个浏览器工具都不在（Preview 照在），有就都在", () => {
  const off = withEnv("off", () => toolDefs().map((d) => d.name));
  for (const n of BROWSER_TOOLS) assert.ok(!off.includes(n), `${n} 不该注册`);
  assert.ok(off.includes("Preview") && off.includes("Bash"), "别的工具不受影响");
  const on = withEnv("on", () => toolDefs().map((d) => d.name));
  for (const n of BROWSER_TOOLS) assert.ok(on.includes(n), `${n} 应注册`);
});

test("D5 注册表：本机有 Chromium 系浏览器时（开发机）不设开关也照常注册", { skip: findBrowser() ? false : "本机没有 Chrome/Edge" }, () => {
  const names = withEnv(undefined, () => toolDefs().map((d) => d.name));
  for (const n of BROWSER_TOOLS) assert.ok(names.includes(n), n);
});

test("D5 system：有浏览器与不给开关逐字相同；没有浏览器时不提 Browser / Eval / Network、桌面与安卓", () => {
  const base = { root: "/ws", shell: "bash", platform: "linux", provider: "openai", model: "m", access: "full", webSearch: true } as const;
  const dflt = systemPrompt(base);
  assert.equal(systemPrompt({ ...base, browser: true }), dflt);
  assert.match(dflt, /verifiable end-to-end via Browser\(attach\)/);
  assert.match(dflt, /a desktop \(Electron\) app or an Android app/);
  assert.match(dflt, /For browser flows use Eval\(js:/);
  assert.match(
    dflt,
    /through the actual UI with Browser\/ReadPage, assert outcomes with Eval\/Network, and fix and re-run until the flow passes\. A desktop app gets the same closing loop through Browser\(attach\)\. State clearly/,
  );
  const nob = systemPrompt({ ...base, browser: false });
  assert.match(nob, /## Playbooks\nStep-by-step playbooks — running and verifying a web app, and the safety rules/);
  assert.match(nob, /through its endpoints with curl, confirm from the server side with Preview\(action:"logs"\), and fix and re-run/);
  assert.doesNotMatch(nob, /Browser\(|Browser\/ReadPage|Eval\/Network|Android app/);
  assert.doesNotMatch(nob, /\$\{/);
});

// 生产路径建会话（假 key 只为建得起来，模型换成脚本）。状态在 startRun 里按此刻的环境建
async function startedSession(t: TestContext, env: string | undefined): Promise<Session> {
  t.mock.method(console, "log", () => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-nobrowser-ws-"));
  roots.push(root);
  setConfig({ provider: "openai", model: "deepseek-flash", thinking: "off", apiKey: "DUMMY-nobrowser-key", workspace: root, permissionMode: "auto", access: "workspace" });
  const before = process.env.DIMENSIO_BROWSER;
  setEnv(env);
  try {
    const session = createSession();
    const run = startRun(session, "你好");
    session.state!.adapter = scripted(t).next(say("你好！"));
    await run.done;
    return session;
  } finally {
    setEnv(before);
  }
}

test("D5 会话：建会话时定一次——工具清单、system、playbook 开关一致；之后浏览器回来了也不改（不打穿缓存），新会话才有", async (t) => {
  const session = await startedSession(t, "off");
  const state = session.state!;
  const names = state.tools.map((d) => d.name);
  for (const n of BROWSER_TOOLS) assert.ok(!names.includes(n) && !state.toolMap.has(n), `${n} 不在这个会话里`);
  assert.equal(state.browser, false);
  assert.doesNotMatch(state.system, /Browser\(attach\)|Eval\/Network/);
  assert.match(state.system, /running and verifying a web app, and the safety rules/);

  // 浏览器后来有了（桌面壳晚注册 / 扩展连上 / 部署方改开关）：已经开着的会话不跟着变
  const toolsBefore = [...names];
  const systemBefore = state.system;
  const before = process.env.DIMENSIO_BROWSER;
  setEnv("on");
  try {
    const again = startRun(session, "再说一句");
    session.state!.adapter = scripted(t).next(say("好"));
    await again.done;
    assert.equal(session.state, state, "同一个状态对象");
    assert.deepEqual(session.state!.tools.map((d) => d.name), toolsBefore);
    assert.equal(session.state!.system, systemBefore);
  } finally {
    setEnv(before);
  }

  const fresh = await startedSession(t, "on");
  const freshNames = fresh.state!.tools.map((d) => d.name);
  for (const n of BROWSER_TOOLS) assert.ok(freshNames.includes(n), `新会话有 ${n}`);
  assert.equal(fresh.state!.browser, true);
  assert.match(fresh.state!.system, /verifiable end-to-end via Browser\(attach\)/);
});
