// 会话浏览器面板与预览服务。
import express from "express";
import { emitGlobal, anySessionRunning } from "../session.ts";
import { latestService, listServices, stopService, stopServicesFor, stopAllServices } from "../services.ts";
import { recentBrowserOwner, onBrowserMount, existingBrowser, browserMount, browserMode, setBrowserIsolated, VIEWPORT_PRESETS, getBrowser } from "../cdp.ts";
import { SSE_PING_MS } from "./shared.ts";

export function registerBrowserRoutes(app: express.Express): void {
  // ── Live Browser pane (screencast of a conversation's browser) ──────────────
  // The user's window into — and hands on — the SAME browser the agent drives.
  // 11-14 起按会话各开一份（cdp.ts getBrowser）：每个路由都认 sessionId（GET 查询串 / POST 请求体——前端不加自定义请求头），
  // 看的、点的、导航的都是那个会话的浏览器；空串 = 不属于任何会话的默认那份（还没发出第一条消息的新对话）。
  // 完全不带 sessionId 的旧前端（离线 apk 里的老包）拿最近用过的那一份——与以前「面板看的就是 agent 正在用的浏览器」一致。
  // All routes GET/POST only (bridge proxy CORS). SSE frames flow only while at
  // least one viewer is subscribed; the browser itself is unaffected by viewers
  // coming and going (phone can disconnect mid-task, agent keeps working).

  // 会话 id 只认这种形状（会话 id 是 UUID）；别的一律当没给，退回默认那份
  const cleanBrowserOwner = (v: unknown): string => {
    const s = String(v ?? "");
    return /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : "";
  };
  function browserOwnerOf(req: express.Request): string {
    const q = (req.query as Record<string, unknown>)?.sessionId;
    const raw = q !== undefined ? q : (req.body as Record<string, unknown> | undefined)?.sessionId;
    return raw === undefined ? recentBrowserOwner() : cleanBrowserOwner(raw);
  }

  // 挂载状态灯：会话的浏览器从「没有标签」变「有标签」（或反过来）、隔离开关变了，就经全局事件通道广播 browser_mount
  onBrowserMount((ev) => emitGlobal({ ...ev, at: Date.now() }));

  app.get("/api/browser/state", (req, res) => {
    const owner = browserOwnerOf(req);
    const page = existingBrowser(owner);
    // mounted = 这个会话的浏览器里有标签（挂载状态灯）；isolated = 这个会话开着隔离存储
    const { mounted, isolated } = browserMount(owner);
    res.json(
      page
        ? { alive: true, url: page.url, viewport: page.viewport, tabs: page.tabs, mode: browserMode(owner), mounted, isolated }
        : { alive: false, tabs: [], mode: null, mounted, isolated },
    );
  });

  // 隔离存储（按会话）：开 / 关都会关掉这个会话现有的浏览器标签，下次打开按新模式起。只有会话有（默认那份不能开）。
  app.post("/api/browser/isolate", async (req, res) => {
    const owner = cleanBrowserOwner(req.body?.sessionId);
    if (!owner) {
      res.status(400).json({ error: "sessionId is required — isolated storage is per conversation" });
      return;
    }
    try {
      res.json({ ok: true, ...(await setBrowserIsolated(owner, req.body?.on === true)) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get("/api/browser/stream", async (req, res) => {
    const page = existingBrowser(browserOwnerOf(req));
    if (!page) {
      res.status(409).json({ error: "browser not running" });
      return;
    }
    // native=1：桌面壳里的观众看的是真 WebContentsView，不需要 JPEG 帧——
    // 只保留 state/tabs/pointer 事件驱动工具条与挂载。其余观众（手机/网页）照旧帧流。
    const native = String((req.query as Record<string, unknown>)?.native ?? "") === "1";
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ e: "state", url: page.url, viewport: page.viewport });

    let unsub: (() => void) | null = null;
    // 登记观看者：Browser 工具据此告诉模型用户此刻看不看得到这个浏览器（要用户动手前先确认他看得见）
    const unView = page.addViewer(native ? "native" : "stream");
    // Pointer echo: viewers see where the agent (or another device) points/clicks.
    const unsubPtr = page.subscribePointer((p) => send({ e: "pointer", ...p }));
    // Tab strip: every viewer mirrors this conversation's browser tabs live; an empty
    // list means the last tab was closed and this conversation's browser is gone.
    const unsubTabs = page.subscribeTabs((tabs) => {
      send({ e: "tabs", tabs });
      if (!tabs.length) send({ e: "state", alive: false });
    });
    // 视口变化（面板设备钮 或 agent 的 Browser(resize)）：所有观众同步点亮档位；
    // 桌面壳观众还要靠它按新视口重新缩放摆放原生视图。
    const unsubViewport = page.subscribeViewport((viewport) => send({ e: "viewport", viewport }));
    if (!native) {
      try {
        unsub = await page.subscribeCast((f) => {
          send({ e: "frame", data: f.data, w: f.deviceWidth, h: f.deviceHeight, url: page.url });
        });
      } catch (e) {
        unView();
        unsubPtr();
        unsubTabs();
        unsubViewport();
        send({ e: "error", message: (e as Error).message });
        res.end();
        return;
      }
    }
    const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_PING_MS);
    res.on("close", () => {
      clearInterval(heartbeat);
      unView();
      unsub?.();
      unsubPtr();
      unsubTabs();
      unsubViewport();
    });
  });

  // Forward the user's pointer/keyboard into that conversation's browser (they share the
  // page with the agent — same state, two pairs of hands).
  app.post("/api/browser/input", async (req, res) => {
    const page = existingBrowser(browserOwnerOf(req));
    if (!page) {
      res.status(409).json({ error: "browser not running" });
      return;
    }
    const b = req.body ?? {};
    const x = Number(b.x ?? 0);
    const y = Number(b.y ?? 0);
    try {
      switch (String(b.type ?? "")) {
        case "click":
          await page.clickCoord(x, y, {
            button: b.button === "right" ? "right" : "left",
            clickCount: b.double ? 2 : 1,
            source: "user",
          });
          break;
        case "move":
          await page.hoverCoord(x, y, "user");
          break;
        case "wheel":
          await page.wheel(x, y, Number(b.deltaY ?? 0), Number(b.deltaX ?? 0));
          break;
        case "key":
          await page.pressKey(String(b.key ?? ""));
          break;
        case "text":
          await page.typeText(String(b.text ?? ""));
          break;
        default:
          res.status(400).json({ error: `unknown input type "${b.type}"` });
          return;
      }
      res.json({ ok: true, url: page.url });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Viewport switch from the pane's device buttons — the SAME setViewport the
  // agent's Browser(resize) uses, so user and agent stay on one page and
  // the pane's highlight follows whoever resized last (via frame dimensions).
  app.post("/api/browser/resize", async (req, res) => {
    const page = existingBrowser(browserOwnerOf(req));
    if (!page) {
      res.status(409).json({ error: "browser not running" });
      return;
    }
    const b = req.body ?? {};
    const preset = VIEWPORT_PRESETS[String(b.preset ?? "")];
    const w = preset ? preset.width : Number(b.width);
    const h = preset ? preset.height : Number(b.height);
    if (!(w > 0 && h > 0)) {
      res.status(400).json({ error: "pass preset (mobile|tablet|desktop) or positive width+height" });
      return;
    }
    try {
      await page.setViewport(w, h, preset ? preset.mobile : w < 600);
      res.json({ ok: true, viewport: page.viewport });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ── 标签页（面板 tabstrip 的 × / ＋ / 切换）──────────────────────────────────
  // 与 agent 共用这个会话的浏览器：新建/关闭/切换立刻广播给所有观看者（stream 的
  // tabs 事件），agent 的后续操作始终落在前台标签上。

  app.post("/api/browser/tabs/new", async (req, res) => {
    try {
      const owner = browserOwnerOf(req);
      const existed = Boolean(existingBrowser(owner));
      const page = await getBrowser(owner); // 未运行则拉起 —— ＋也是启动入口
      let url = String(req.body?.url ?? "").trim();
      if (url && !/^(https?:\/\/|about:)/i.test(url)) {
        url = (/^(localhost|127\.|192\.168\.|10\.)/.test(url) ? "http://" : "https://") + url;
      }
      if (existed) {
        await page.newTab(url || "about:blank");
      } else if (url) {
        // 刚拉起的浏览器自带首个标签 —— 它就是「新标签」，别再生第二个
        await page.navigate(url);
      }
      res.json({ ok: true, tabs: page.tabs, url: page.url });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post("/api/browser/tabs/activate", async (req, res) => {
    const page = existingBrowser(browserOwnerOf(req));
    if (!page) {
      res.status(409).json({ error: "browser not running" });
      return;
    }
    const id = String(req.body?.id ?? "");
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    try {
      await page.activateTab(id);
      res.json({ ok: true, tabs: page.tabs, url: page.url });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post("/api/browser/tabs/close", async (req, res) => {
    const owner = browserOwnerOf(req);
    const page = existingBrowser(owner);
    if (!page) {
      res.status(409).json({ error: "browser not running" });
      return;
    }
    const id = String(req.body?.id ?? "");
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    try {
      await page.closeTab(id);
      // 关的是最后一个标签时这个会话的浏览器随之关闭（= 真实浏览器关窗口）。
      const alive = Boolean(existingBrowser(owner));
      res.json({ ok: true, tabs: alive ? page.tabs : [], alive });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // User-driven navigation from the pane's address bar (launches the browser if
  // needed — the pane is usable before the agent ever touches it).
  app.post("/api/browser/navigate", async (req, res) => {
    const owner = browserOwnerOf(req);
    const dir = String(req.body?.dir ?? "");
    try {
      if (dir === "back" || dir === "forward") {
        const page = existingBrowser(owner);
        if (!page) {
          res.status(409).json({ error: "browser not running" });
          return;
        }
        const moved = await page.history(dir === "back" ? -1 : 1);
        res.json({ ok: Boolean(moved), url: page.url });
        return;
      }
      let url = String(req.body?.url ?? "").trim();
      if (!url) {
        res.status(400).json({ error: "url is required" });
        return;
      }
      if (url.startsWith("/")) {
        // 相对路径：这个会话最近起的 Preview 服务（没有会话 = 进程里最近的那个，与以前一致）
        const s = (owner && latestService(owner)) || latestService();
        if (!s) {
          res.status(400).json({ error: "path given but no preview server is running" });
          return;
        }
        url = `http://localhost:${s.port}${url}`;
      } else if (!/^https?:\/\//i.test(url)) {
        url = (/^(localhost|127\.|192\.168\.|10\.)/.test(url) ? "http://" : "https://") + url;
      }
      const page = await getBrowser(owner);
      await page.navigate(url);
      res.json({ ok: true, url: page.url });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Live service registry snapshot. The bridge's pv-* Host router polls this to
  // resolve public-preview tokens → local ports; entries vanish with the service,
  // so a stopped server's public URL 404s naturally.
  app.get("/api/preview/services", (_req, res) => {
    res.json(listServices());
  });

  // Stop a preview server: an explicit serviceId, or all of ONE session's servers
  // (sessionId — what "new chat" cleanup means), or the whole process's servers.
  app.post("/api/preview/stop", (req, res) => {
    const serviceId = req.body?.serviceId ? String(req.body.serviceId) : "";
    if (serviceId) {
      res.json({ stopped: stopService(serviceId) });
      return;
    }
    // Per-session cleanup is the right granularity and needs no global guard: it
    // only ever touches servers this session started. The old global stop-all had
    // the wrong grain in both directions — opening a session on the PC killed the
    // dev server a phone-started run was testing, while an orphaned server from a
    // finished session could never be cleaned up as long as any session ran.
    const sessionId = req.body?.sessionId ? String(req.body.sessionId) : "";
    if (sessionId) {
      res.json({ stopped: stopServicesFor(sessionId) > 0, scope: "session" });
      return;
    }
    // No scope given = the blunt process-wide janitor. Still refuse while a run is
    // in flight; without a session id we cannot tell whose server is whose.
    if (anySessionRunning()) {
      res.json({
        stopped: false,
        reason: "a session is running — pass sessionId to stop only that session's servers",
      });
      return;
    }
    stopAllServices();
    res.json({ stopped: true, scope: "all" });
  });
}
