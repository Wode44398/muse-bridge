// 浏览器驱动（CDP）。CdpSession 的实现按职责分在 cdp/ 下的三层里，浏览器宿主与按会话的池子在 cdp/pool.ts；对外的名字仍从这里引。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { browserEnv, clearBrowserLaunchFailure, findBrowser, noteBrowserLaunchFailure } from "./headless.ts";
import "./control-plane.ts";
import "./desktop-host.ts";
import "./tools/bash.ts";
import "./resources.ts";
import "./paths.ts";
import "./atomic-write.ts";
import "./core-link.ts";
import { acquireHost, retireOrphanProfile, shutdownOwnedBrowser } from "./cdp/pool.ts";
import { liveDesktopHost, NO_BUILTIN_BROWSER_HINT } from "./cdp/shared.ts";
import { CdpSessionInput } from "./cdp/session-input.ts";
export { SHOT_MAX_PX, MUT_INIT, pngSize, SETTLE_MAX_MS, MAX_SHOT_WAIT_MS, VIEWPORT_PRESETS, judgeCanvasProbe, withoutControlPlane, mobileUserAgent } from "./cdp/shared.ts";
export type { ConsoleEntry, NetEntry, DialogEntry, ShotFrame, MeasuredViewport, BrowserViewer, AxSnapshot, ScreenshotOptions, ScreenshotResult, CanvasProbeSample, CanvasProbeReport, CastFrame, PointerEcho, BrowserTab } from "./cdp/shared.ts";
export { readDevToolsPortFile, persistBrowserProfile, getBrowser, existingBrowser, recentBrowserOwner, closeBrowser, attachBrowser, browserMode, liveBrowserCount, noBrowserMessage, closeAllBrowserSessions, onBrowserMount, browserMount, browserIsolated, setBrowserIsolated } from "./cdp/pool.ts";
export type { HostLease, BrowserMountEvent } from "./cdp/pool.ts";

export class CdpSession extends CdpSessionInput {
  get alive(): boolean {
    if (this.dead || this.ws?.readyState !== WebSocket.OPEN) return false;
    return this.hostLease ? this.hostLease.alive : this.child?.exitCode == null;
  }

  // opts.profileDir：持久配置档（登录态跨会话保留）；不给 = 一次性临时 profile。
  // opts.shared：不自己拉进程，进同一个配置档的共享无头宿主（按会话各开一份的浏览器池用，见 getBrowser）。
  // opts.isolate：只对共享宿主有意义——在宿主里开一个独立浏览上下文（隔离存储），也因此不进桌面壳。
  // opts.desktop:false：不进桌面壳（宿主锚点自己就是那个无头进程）。
  async launch(startUrl: string, opts: { profileDir?: string; shared?: boolean; isolate?: boolean; desktop?: boolean } = {}): Promise<void> {
    // 桌面壳在场 → 真 WebContentsView（用户面板与 agent 同一个页面实体）；否则 headless。
    // 隔离存储不进壳：壳里是主机自己的持久分区，cookie 和别的会话共用。
    if (opts.desktop !== false && !opts.isolate) {
      const host = await liveDesktopHost();
      if (host) {
        await this.attachDesktop(host, startUrl || "about:blank");
        return;
      }
    }
    if (opts.shared) {
      this.hostLease = await acquireHost(opts.profileDir ?? "");
      await this.joinHost(startUrl || "about:blank", Boolean(opts.isolate));
      return;
    }
    const browser = findBrowser();
    // 浏览器工具照样注册着（桌面壳宿主文件残留、只连着用户的扩展……）但本机没有内置浏览器：说清楚往哪走，别让模型反复重试
    if (!browser) throw new Error(`No Chrome/Edge found for the interactive browser. ${NO_BUILTIN_BROWSER_HINT}`);
    if (opts.profileDir) {
      // Chromium 一个 user-data-dir 只能一个进程开（第二个把参数转交第一个后就退出）：上次崩溃留下的孤儿先请它退出、
      // 再按命令行指纹收干净，并删掉它留下的 DevToolsActivePort（不删会读到死端口）。
      this.profileDir = opts.profileDir;
      mkdirSync(this.profileDir, { recursive: true });
      await retireOrphanProfile(this.profileDir, browser);
    } else {
      this.tmp = mkdtempSync(path.join(tmpdir(), "harness-cdp-"));
      this.profileDir = path.join(this.tmp, "profile");
    }
    this.browserPath = browser;
    // S8（#54）：不再 --no-sandbox——这个浏览器打开模型挑的任意公网页面，renderer 一旦被
    // 利用就直接是用户权限。Windows 普通用户跑 Chromium 自己的沙箱不需要任何特权。
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${this.viewport.width},${this.viewport.height}`,
      "--remote-debugging-port=0",
      `--user-data-dir=${this.profileDir}`,
      startUrl || "about:blank",
    ];
    // S7（#55）：env 不带任何凭据（以前继承全部 provider key）；#64：也不带 __COMPAT_LAYER（见 browserEnv）。
    this.child = spawn(browser, args, { stdio: "ignore", windowsHide: true, env: browserEnv() });
    // spawn 失败（EACCES / EMFILE / 浏览器自更新换目录导致的 ENOENT…）走的是【异步
    // 'error' 事件】而不是同步抛。没有监听者时 EventEmitter 直接 throw，会把整个
    // harness 进程打死。存下来让 readDevToolsPort 立刻报真因，不必空等 15 秒。
    this.child.on("error", (e: Error) => {
      this.dead = true;
      this.spawnError = e;
    });
    this.child.on("exit", () => {
      this.dead = true;
    });
    this.url = startUrl;

    let port: number;
    try {
      port = await this.readDevToolsPort();
    } catch (e) {
      // D5：浏览器进程没开调试端口就退了 / 根本没拉起来（snap 空壳、No usable sandbox……）——记一笔，接下来的新会话不再
      // 提供浏览器工具（headless.ts browserAvailable）；这一会话的工具已经定了，报错里直说别再试。超时不记（机器忙也会超时）。
      if (this.spawnError || this.child?.exitCode != null) {
        noteBrowserLaunchFailure(browser);
        throw new Error(`${(e as Error).message}. The browser cannot start on this machine. ${NO_BUILTIN_BROWSER_HINT}`);
      }
      throw e;
    }
    clearBrowserLaunchFailure(browser);
    this.debugPort = port;
    this.cdpBase = `http://127.0.0.1:${port}`;
    const pages = await this.waitPages(port);
    const page = pages[0];
    this.activeTargetId = String(page.id ?? "");
    await this.connect(String(page.webSocketDebuggerUrl));
    await this.enableDomains();
    this.seedTabs(pages);
    await this.connectBrowserSocket().catch((e) => {
      // 目标管理不可用时退化为单标签（面板只读，×/+ 会报错）
      console.warn("[cdp] tab management unavailable:", (e as Error).message);
    });
  }

  // #64：关自己拉起的浏览器。以前只 child.kill()：在只有 Edge 的机器上 spawn 到的常常只是个
  // 早退的启动壳（自我重启），每关一次就漏一整棵无头 Edge + profile。现在先经 CDP 发
  // Browser.close 让它自己体面退出；等不到、或 spawn 的进程早就先退了，就按 profile 指纹整树收；
  // 最后删 profile（进程退干净前文件锁着，异步重试）。状态同步清掉、收尾在后台跑；返回的
  // Promise 永不 reject，想等它收干净的（测试）就 await。
  // 共享宿主里的会话：只关自己的标签（隔离上下文随之销毁），浏览器进程归宿主——最后一个会话走了宿主才体面退出。
  close(): Promise<void> {
    const owned = this.detach();
    if (owned) return shutdownOwnedBrowser(owned).catch(() => {});
    return this.closing ?? Promise.resolve();
  }

}
