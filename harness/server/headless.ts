import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { killTree } from "./tools/bash.ts";
import { helperEnv } from "./helper-proc.ts";
import { desktopHostInfo } from "./desktop-host.ts";

// Headless screenshot via a system Chromium browser's built-in one-shot
// --screenshot flag. No puppeteer/CDP dependency — we launch the browser, let it
// render the page (virtual-time-budget gives client-side JS time to run), and it
// writes a PNG we read back. This is the "eyes" for the visual-verify channel:
// a non-multimodal agent can't see a page, so we screenshot it here and hand the
// image to a multimodal model (see vision.ts) for a text verdict.

// Prefer Chrome, fall back to Edge (both ship Chromium and support --screenshot).
const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  // Linux（发行版包 / 官方 Chrome / snap）与 macOS
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium", "/usr/bin/microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export function findBrowser(): string | undefined {
  if (process.env.HEADLESS_BROWSER && existsSync(process.env.HEADLESS_BROWSER)) {
    return process.env.HEADLESS_BROWSER;
  }
  return CANDIDATES.find((p) => existsSync(p));
}

// 浏览器工具（Browser / ReadPage / Eval / Network）能不能用：本机找得到 Chromium 系浏览器，或者桌面壳交来了它自己的
// 浏览器宿主。都没有（例如没装浏览器的 Linux 服务器）就不向模型提供这几个工具，系统提示里的浏览器段也不写。
// 现算不缓存：装上浏览器 / 设了 HEADLESS_BROWSER 之后，新会话就能用。
export function browserAvailable(): boolean {
  return Boolean(findBrowser()) || desktopHostInfo() !== null;
}

// 浏览器专用 env：helperEnv（不带凭据，S7）之上再去掉 __COMPAT_LAYER。Edge 看到它（会话里的
// Git Bash 就带着）会「自我重启」：spawn 拿到的 pid 约 1 秒内退出，真浏览器成了孤儿，
// child.kill / taskkill /T 都够不着（#64，2026-09-23 实测）；截图路径还会因此提前收场。
export function browserEnv(): NodeJS.ProcessEnv {
  const env = helperEnv();
  for (const name of Object.keys(env)) if (name.toUpperCase() === "__COMPAT_LAYER") delete env[name];
  return env;
}

// #64 兜底：按 profile 目录指纹收掉还活着的浏览器进程（早退的启动壳留下的真身、残留的子进程）。
// 命中的就是这个 profile 的全部进程（主进程和各子进程命令行里都带 --user-data-dir），逐个结束即可——
// #77：不再 taskkill /T，它会顺着悬空的父 PID 杀到不相干的进程。
function reapScript(browser: string): string {
  const names = [...new Set(["chrome.exe", "msedge.exe", path.basename(browser).toLowerCase()])]
    .filter((n) => /^[\w.-]+\.exe$/i.test(n));
  const filter = names.map((n) => `Name='${n}'`).join(" OR ");
  return [
    "$d = $env:DIMENSIO_REAP_PROFILE",
    `$hit = @(Get-CimInstance Win32_Process -Filter "${filter}" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0 })`,
    "foreach ($p in $hit) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }",
    "$hit.Count",
  ].join("; ");
}

// 进程退出路径专用的同步版本（exit 处理器里等不了异步）。返回命中的进程数；失败算 0，永不抛。
export function reapProfileProcessesSync(profileDir: string, browser = ""): number {
  if (process.platform !== "win32") return 0;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", reapScript(browser)], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: { ...helperEnv(), DIMENSIO_REAP_PROFILE: profileDir },
  });
  return r.status === 0 ? Number(String(r.stdout ?? "").trim().split(/\s+/).pop()) || 0 : 0;
}

// 返回命中的进程数；查询失败算 0，永不抛。
export function reapProfileProcesses(profileDir: string, browser = ""): Promise<number> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", reapScript(browser)],
        { windowsHide: true, timeout: 30_000, env: { ...helperEnv(), DIMENSIO_REAP_PROFILE: profileDir } },
        (err, stdout) => resolve(err ? 0 : Number(String(stdout).trim().split(/\s+/).pop()) || 0),
      );
      return;
    }
    execFile("ps", ["-eo", "pid=,args="], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(0);
      let n = 0;
      for (const line of String(stdout).split("\n")) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!m || !m[2].includes(profileDir)) continue;
        try {
          process.kill(Number(m[1]), "SIGKILL");
          n++;
        } catch {
          /* already gone */
        }
      }
      resolve(n);
    });
  });
}

export interface ShotOptions {
  width?: number;
  height?: number;
  // How long to let the page's JS run before capturing (ms). Client-rendered
  // apps need this; a static page ignores it.
  settleMs?: number;
  timeoutMs?: number;
}

export interface ShotResult {
  png: Buffer;
  width: number;
  height: number;
  browser: string;
}

// Screenshot a URL, returning the raw PNG bytes. Throws with a clear message if
// no browser is found or the capture fails/times out.
export async function screenshot(url: string, opts: ShotOptions = {}): Promise<ShotResult> {
  const browser = findBrowser();
  if (!browser) {
    throw new Error(
      "No headless browser found. Install Chrome or Edge, or set HEADLESS_BROWSER to its path.",
    );
  }
  const width = opts.width ?? 1280;
  const height = opts.height ?? 900;
  const settleMs = opts.settleMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const tmp = mkdtempSync(path.join(tmpdir(), "harness-shot-"));
  const outFile = path.join(tmp, "shot.png");
  // S8（#54）：不再 --no-sandbox——这个浏览器打开的是任意页面，Windows 普通用户跑 Chromium
  // 自己的沙箱不需要任何特权。
  const args = [
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--user-data-dir=${path.join(tmp, "profile")}`,
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${settleMs}`,
    `--screenshot=${outFile}`,
    url,
  ];

  try {
    await runBrowser(browser, args, timeoutMs, path.join(tmp, "profile"));
    if (!existsSync(outFile)) {
      throw new Error("browser exited without writing a screenshot (page may have failed to load)");
    }
    const png = readFileSync(outFile);
    if (png.length === 0) throw new Error("screenshot file was empty");
    return { png, width, height, browser: path.basename(browser) };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

function runBrowser(browser: string, args: string[], timeoutMs: number, profileDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, args, { stdio: "ignore", windowsHide: true, env: browserEnv() });
    // 浏览器是一整棵进程树（renderer / GPU / utility）——超时必须 killTree，
    // 否则一次卡住的截图会留下一窝无头浏览器进程接着烧 CPU。树外的（#64）按 profile 指纹收。
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true; // 收尸期间 child 的 exit 会先到——结局仍是「超时」
      killTree(child);
      void reapProfileProcesses(profileDir, browser).finally(() =>
        reject(new Error(`headless screenshot timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      if (!timedOut) reject(e);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      if (!timedOut) resolve();
    });
  });
}
