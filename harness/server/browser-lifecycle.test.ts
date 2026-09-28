// S8（#54）+ #64：真起本机的 Chrome / Edge。
//
// 修前：共享浏览器以 --no-sandbox 启动（整棵进程树都没有 Chromium 沙箱）；关闭只 child.kill()，
// 在 Edge 会「自我重启」的环境里（env 带 __COMPAT_LAYER，会话的 Git Bash 就带）spawn 到的只是
// 个早退的启动壳——启动要么直接报「browser exited before opening a debug port」，要么起来了
// 关不掉，每次都漏一整棵无头 Edge + profile。
//
// 只在 Windows 上跑（按 profile 指纹查进程用的是 Win32_Process）；没装浏览器就跳过。
// 用例自己兜底收尸：先取证（关闭后还剩哪些进程、profile 目录在不在），再把剩的杀干净，最后断言。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CdpSession } from "./cdp.ts";
import { findBrowser } from "./headless.ts";

const WIN = process.platform === "win32";
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));

interface Proc {
  pid: number;
  cmd: string;
}

// 命令行里带着这个 profile 目录的全部 chrome/msedge 进程。
function profileProcesses(profileDir: string): Proc[] {
  const script =
    "$d = $env:S8_PROFILE; " +
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | " +
    "Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | " +
    "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, S8_PROFILE: profileDir },
  });
  return String(r.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => /^(\d+)\t(.*)$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ pid: Number(m[1]), cmd: m[2] }));
}

const tmpOf = (s: CdpSession) => (s as unknown as { tmp: string }).tmp;

async function lifecycle(): Promise<void> {
  const s = new CdpSession();
  let tmp = "";
  let failure: unknown = null;
  try {
    await s.launch("about:blank");
    tmp = tmpOf(s);
    await s.navigate("data:text/html,<title>s8-sandboxed</title><p>ok</p>", 300);
    assert.equal(await s.title(), "s8-sandboxed", "页面照常渲染");
    const procs = profileProcesses(path.join(tmp, "profile"));
    assert.ok(procs.length >= 2, `浏览器主进程 + 至少一个子进程（实得 ${procs.length}）`);
    const bare = procs.filter((p) => /--no-sandbox\b/.test(p.cmd));
    assert.deepEqual(bare.map((p) => p.pid), [], "这个 profile 的进程一个都不许带 --no-sandbox");
  } catch (e) {
    failure = e;
  }
  tmp ||= tmpOf(s);
  await s.close();
  const profile = path.join(tmp, "profile");
  const leftover = tmp ? profileProcesses(profile) : [];
  const dirLeft = Boolean(tmp) && fs.existsSync(tmp);
  // 命中的就是这个 profile 的全部进程，逐个结束；#77：不带 /T（会顺着悬空的父 PID 杀到不相干的进程）。
  for (const p of leftover) spawnSync("taskkill", ["/PID", String(p.pid), "/F"], { windowsHide: true });
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (failure) throw failure;
  assert.deepEqual(leftover.map((p) => p.pid), [], "close() 之后这个 profile 的进程一个都不许剩");
  assert.equal(dirLeft, false, "close() 之后 profile 目录应已删掉");
}

test(
  "S8：共享浏览器不带 --no-sandbox 照常渲染；#64：close() 之后进程与 profile 都收干净",
  { skip: !WIN || !findBrowser() ? "需要 Windows + 本机 Chrome/Edge" : false, timeout: 120_000 },
  async () => {
    await lifecycle();
  },
);

test(
  "#64：Edge 在带 __COMPAT_LAYER 的环境里（会自我重启）也能起、能用、关干净",
  { skip: !WIN || !EDGE ? "需要 Windows + Edge" : false, timeout: 120_000 },
  async () => {
    const saved = { browser: process.env.HEADLESS_BROWSER, compat: process.env.__COMPAT_LAYER };
    process.env.HEADLESS_BROWSER = EDGE!;
    process.env.__COMPAT_LAYER = "DetectorsAppHealth";
    try {
      await lifecycle();
    } finally {
      if (saved.browser === undefined) delete process.env.HEADLESS_BROWSER;
      else process.env.HEADLESS_BROWSER = saved.browser;
      if (saved.compat === undefined) delete process.env.__COMPAT_LAYER;
      else process.env.__COMPAT_LAYER = saved.compat;
    }
  },
);
