// 所有 /api/* 共用的前置中间件：令牌与 CORS、请求体解析、侧栏变更通知、租户闸。
import express from "express";
import { noteListChanged } from "../session.ts";
import { tenantMode, tenantShell } from "../tenant.ts";
import { allowedBrowserOrigin, INTERNAL_TOKEN_HEADER, apiRequestAuthorized } from "../api-auth.ts";

export function registerApiGuards(app: express.Express, API_TOKEN: string, EXTRA_ORIGINS: Set<string>, PORT: number): void {
  // Harness can execute commands with provider credentials in memory, and its own
  // agent runs shells and a browser on this very loopback interface. So "loopback"
  // and "an allowed browser Origin" prove nothing: every API request must carry the
  // token (bridge: process-only token; standalone dev: the printed dev token).
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();

    const browserOrigin = allowedBrowserOrigin(req.get("origin"), PORT, EXTRA_ORIGINS);
    if (browserOrigin) {
      res.setHeader("Access-Control-Allow-Origin", browserOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", `Content-Type, Authorization, ${INTERNAL_TOKEN_HEADER}`);
    }
    // 资源链接里的 ?dimensio_token= 不能经 Referer 漏给第三方。
    res.setHeader("Referrer-Policy", "no-referrer");
    // Lets the bridge distinguish this guarded API from an older, insecure
    // harness process that happens to be occupying the same port.
    res.setHeader("X-Dimensio-API-Guard", "1");
    // CORS 预检不带自定义头（浏览器只报 Access-Control-Request-Headers），也不会进任何
    // 处理器：直接 204，放不放行由上面的 CORS 头决定；真请求照样要过令牌。
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    if (!apiRequestAuthorized(req, API_TOKEN)) {
      res.status(401).json({ error: "unauthorized harness API request" });
      return;
    }
    next();
  });

  app.use(express.json({ limit: "10mb" }));

  // 改了侧栏结构的写接口成功之后，经全局事件通道通知所有设备重拉列表（以前只有发起的那台设备自己更新，
  // 别的设备上新快照 / 删掉的会话 / 新项目要等手动刷新才出现）。
  const LIST_CHANGES: [RegExp, "sessions" | "projects" | "both"][] = [
    [/^\/api\/quick\/(new|save)$/, "both"],
    [/^\/api\/projects(\/(rename|flags|order))?$/, "projects"],
    [/^\/api\/sessions\/[^/]+(\/(delete|handoff))?$/, "sessions"],
  ];
  app.use((req, res, next) => {
    if (req.method !== "POST" && req.method !== "DELETE") return next();
    const hit = LIST_CHANGES.find(([re]) => re.test(req.path));
    // DELETE 只认 /api/sessions/:id 本身；POST /api/sessions/:id（没有这个路由）不会 2xx，自然不发
    if (hit) res.on("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) noteListChanged(hit[1]);
    });
    next();
  });

  // 租户实例的接口闸（多用户服务端上每个用户一个 harness，见 tenant.ts）：本机模型（整机资源，停它会连带别人）、
  // 连用户的 Edge（主机主人的真实登录态）整组关掉；没有命令行的租户连终端也关。工作区类路径的限制在各处理器里。
  app.use((req, res, next) => {
    if (!tenantMode()) return next();
    const p = req.path;
    if (p.startsWith("/api/localai/")) {
      res.status(403).json({ error: "not available for multi-user accounts on this server" });
      return;
    }
    if (p.startsWith("/api/dock/term/") && !tenantShell()) {
      res.status(403).json({ error: "this account has no command line" });
      return;
    }
    next();
  });
}
