// 服务信息、设备芯片、配置与偏好、自定义模型服务、本机模型、技能与连接器状态。
import { outboundProxyStatus } from "../net-proxy.ts";
import express from "express";
import { sessionWorkspace, workspaceRoot } from "../session.ts";
import { commandList } from "../commands.ts";
import { syncConnectors, mcpStatus } from "../mcp.ts";
import { disabledProviders, tenantInfo, accessLock, tenantMode } from "../tenant.ts";
import { prefValue, allPrefs, setPrefs } from "../prefs.ts";
import { projectsRoot } from "../projects.ts";
import { hasKey, getConfig, forgetProvider, setProviderKey, setConfig, type ConfigPatch } from "../config.ts";
import { allProviders } from "../catalog.ts";
import { hostManagesBuiltins, addCustomProvider, customProviderView, draftConn, fetchModels, guessModels, detectConnection, probeCustomModel, testCustomProvider, isSharedProvider, isCustomProviderId, getCustomProvider, updateCustomProvider, removeCustomProvider } from "../custom-providers.ts";
import { shell } from "../tools/bash.ts";
import { toolDefs } from "../tools/registry.ts";
import { deviceToolAvailable, listDevices, setDeviceLink } from "../tools/localpc.ts";
import { ruleProblems } from "../agent/permissions.ts";
import { webSearchStats } from "../tools/websearch.ts";
import { type StrataVariant, cleanVariant, strataVariantOf, localAiStatus, cleanEngine, localAiStart, localAiStop, localGpuInfo, localAiApply } from "../localai.ts";
import { BUILD_INFO } from "../build-info.ts";
import { protocolInfo } from "../protocol.ts";

export function registerInfoRoutes(app: express.Express): void {
  // ── Info + config ────────────────────────────────────────────────────────────

  app.get("/api/info", (_req, res) => {
    // 租户实例（多用户服务端上每个用户一个 harness，见 tenant.ts）关掉的 provider 不出现在目录里——选择器照目录渲染，
    // 不用另改前端；tenant 字段告诉前端藏掉访问范围开关、终端、连 Edge 这些入口。
    const offProviders = disabledProviders();
    const catalog = allProviders().filter((p) => !offProviders.has(p.id));
    res.json({
      workspace: workspaceRoot(),
      projectsRoot: projectsRoot(),
      shell: shell.kind,
      platform: process.platform,
      tools: toolDefs().map((t) => t.name),
      // Derived from the catalog so a newly added provider can never be missing
      // from the hasKey map (kimi was, once).
      providers: Object.fromEntries(catalog.map((p) => [p.id, hasKey(p.id)])),
      // Which models each provider can call + the effort tiers each model exposes.
      // The chat-bar model/effort menus render straight from this.
      catalog,
      // 宿主（bridge 的模型中心）接管了自带厂商：目录里只有它给了 Key 的那几家，界面上不再有填 Key 的地方
      hostBuiltins: hostManagesBuiltins(),
      tenant: tenantInfo(),
      // S9：这个进程跑的是哪版代码（启动时的 HEAD / 是否有未提交改动 / 启动时间）。
      build: BUILD_INFO,
      // M10：协议版本号、还服务的最老前端、能力位（见 protocol.ts 的纪律）
      protocol: protocolInfo(),
    });
  });

  // ── 用户的电脑（输入框下方的设备芯片）：这个会话连哪台——同 Claude 那颗（经 bridge 内部接口，见 tools/localpc.ts）──
  // 没接上 bridge 的设备通道（独立跑的 harness、bridge 关了设备）回 available:false，前端整颗不出现。
  const DEVICE_SESSION_RE = /^[0-9a-f-]{8,64}$/i;
  app.get("/api/devices", async (req, res) => {
    if (!deviceToolAvailable()) {
      res.json({ available: false, enabled: false, devices: [], link: "" });
      return;
    }
    const session = String(req.query.session ?? "");
    try {
      res.json({ available: true, ...(await listDevices(DEVICE_SESSION_RE.test(session) ? session : "")) });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });
  app.post("/api/devices/link", async (req, res) => {
    const session = String(req.body?.session ?? "");
    if (!deviceToolAvailable()) {
      res.status(404).json({ error: "device channel not connected" });
      return;
    }
    if (!DEVICE_SESSION_RE.test(session)) {
      res.status(400).json({ error: "bad session id" });
      return;
    }
    try {
      res.json({ ok: true, link: await setDeviceLink(session, String(req.body?.link ?? "")) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
}

export function registerSettingsRoutes(app: express.Express): void {
  app.get("/api/config", (_req, res) => {
    const cfg = getConfig();
    // accessLocked：访问范围被锁定（租户恒 workspace）——前端据此不摆「仅工作空间 / 整机」开关。
    // awayDecision：离开模式下批准请求的默认落定（偏好项），运行设置里离开模式那一行据此说清楚
    // cacheExpiry：偏好「提示缓存快过期时」（off / hint / compact）——前端据此决定出不出「缓存冷了」提示
    res.json({ ...cfg, hasKey: hasKey(cfg.provider), accessLocked: accessLock(), awayDecision: prefValue<string>("awayDecision"), cacheExpiry: prefValue<string>("cacheExpiry") });
  });

  // ── 自定义模型服务（「模型服务」面板里的「＋」卡；OpenAI / Anthropic / Gemini 协议，key 加密存） ─────────────
  // 菜单用的目录随 /api/info 的 catalog 下发（custom 字段，只含启用的对话型号）；编辑器要完整记录走 GET /api/custom-providers/:id。
  // 识别（v2，能力位 custom-providers-v2）：models 拉型号附能力猜测、guess 手动加的型号按知识层猜、detect 检测连接（同站兄弟地址
  // × 协议真打一次）、probe 探测一个型号的能力、test 真发一句——都收编辑中的草稿（draft，可带 apiKey；不带用已存的），不落盘。
  // 老表单（{name, baseUrl, apiKey, model?}，旧版 apk）照收：服务端自己拉型号、猜能力。
  // 租户实例一律不开放（服务端替用户去连任意地址 = SSRF）。
  // 成员实例（租户）以前一律 403；2026-10-28 起成员也能加自己的服务（只能连公网，见 endpoint-guard.ts），管理员共享过来的
  // 只能用不能改（custom-providers.ts 抛 403）。留着这个口子：以后要按服务器关掉成员自建，在这里拦。
  function customProvidersAllowed(_res: express.Response): boolean {
    return true;
  }
  const customErr = (res: express.Response, e: unknown) => {
    const err = e as Error & { needsModel?: boolean; status?: number };
    res.status(err.status === 403 ? 403 : 400).json({ error: err.message, needsModel: err.needsModel || undefined });
  };

  // 「N 个模型」只数启用的对话型号（asr / tts 这类不进菜单）
  const chatCount = (p: { models: { enabled: boolean; kind: string }[] }) => p.models.filter((m) => m.enabled && m.kind === "chat").length;

  app.post("/api/custom-providers", async (req, res) => {
    if (!customProvidersAllowed(res)) return;
    try {
      const { provider, warning } = await addCustomProvider(req.body ?? {});
      res.json({ ok: true, id: provider.id, models: chatCount(provider), warning, provider: customProviderView(provider) });
    } catch (e) {
      customErr(res, e);
    }
  });

  // 识别用的几个草稿接口（不落盘）：要先于 /:id 注册，免得被当成「改 id=models 的服务」
  app.post("/api/custom-providers/models", async (req, res) => {
    if (!customProvidersAllowed(res)) return;
    try {
      const { conn, key } = draftConn(req.body?.draft ?? req.body ?? {});
      res.json(await fetchModels(conn, key));
    } catch (e) {
      customErr(res, e);
    }
  });
  app.post("/api/custom-providers/guess", (req, res) => {
    if (!customProvidersAllowed(res)) return;
    res.json({ models: guessModels(req.body?.ids, req.body?.protocol) });
  });
  app.post("/api/custom-providers/detect", async (req, res) => {
    if (!customProvidersAllowed(res)) return;
    try {
      const { conn, key, models } = draftConn(req.body?.draft ?? req.body ?? {});
      res.json(await detectConnection(conn, key, models));
    } catch (e) {
      customErr(res, e);
    }
  });
  app.post("/api/custom-providers/probe", async (req, res) => {
    if (!customProvidersAllowed(res)) return;
    try {
      const { conn, key } = draftConn(req.body?.draft ?? req.body ?? {});
      res.json(await probeCustomModel(conn, req.body?.model, key));
    } catch (e) {
      customErr(res, e);
    }
  });
  app.post("/api/custom-providers/test", async (req, res) => {
    if (!customProvidersAllowed(res)) return;
    try {
      const { conn, key, models } = draftConn(req.body?.draft ?? req.body ?? {});
      res.json(await testCustomProvider(conn, models, key, req.body?.model));
    } catch (e) {
      customErr(res, e);
    }
  });

  // 编辑器用：一个服务的完整记录（型号能力、协议、鉴权；key 只给尾 4 位）
  app.get("/api/custom-providers/:id", (req, res) => {
    if (!customProvidersAllowed(res)) return;
    if (isSharedProvider(req.params.id)) return void res.status(403).json({ error: "这是管理员共享的服务，只有管理员能修改" });
    const p = isCustomProviderId(req.params.id) ? getCustomProvider(req.params.id) : undefined;
    if (!p) return void res.status(404).json({ error: "这个自定义服务不存在（可能已被删除）" });
    res.json(customProviderView(p));
  });

  // 改 / 删都走 POST：离线 apk 跨源访问 bridge，反代的 CORS 只放行 GET / POST
  app.post("/api/custom-providers/:id", async (req, res) => {
    if (!customProvidersAllowed(res)) return;
    if (!isCustomProviderId(req.params.id)) return void res.status(404).json({ error: "not found" });
    try {
      const { provider, warning } = await updateCustomProvider(req.params.id, req.body ?? {});
      res.json({ ok: true, id: provider.id, models: chatCount(provider), warning, provider: customProviderView(provider) });
    } catch (e) {
      customErr(res, e);
    }
  });

  app.post("/api/custom-providers/:id/delete", async (req, res) => {
    if (!customProvidersAllowed(res)) return;
    const id = req.params.id;
    if (!isCustomProviderId(id)) return void res.status(404).json({ error: "not found" });
    try {
      await removeCustomProvider(id);
      forgetProvider(id); // 正选着它就退回默认厂商；历史会话照旧留着（接着聊会提示这家已删掉、换一家开新对话）
      res.json({ ok: true, config: { ...getConfig(), hasKey: hasKey(getConfig().provider) } });
    } catch (e) {
      customErr(res, e);
    }
  });

  // E3（G7）：输入框 / 面板的技能清单（扩展中心勾给 dimensio 的；按名现读，新装的马上出现）。内置命令在前端
  // 项目级与用户级的技能、自定义命令也在里面：带 ?session=<id> 按那个会话的工作区列，不带按当前配置的工作区
  app.get("/api/commands", async (req, res) => {
    const id = typeof req.query.session === "string" && /^[A-Za-z0-9-]{1,64}$/.test(req.query.session) ? req.query.session : "";
    res.json(commandList(id ? await sessionWorkspace(id) : workspaceRoot()));
  });

  // E1（G6）：MCP 连接器的连接状态（勾给 dimensio 的；不含凭据、命令行与地址）。先对一遍注册表
  app.get("/api/mcp", async (_req, res) => {
    await syncConnectors();
    res.json({ connectors: mcpStatus() });
  });

  // 出站与联网工具自检。旧的 WebSearch 只有 console.warn，出事没有任何可查的证据；
  // 这里把「出口现在走哪」和「每个搜索后端成/败多少次」摆出来，一次 GET 就能分清
  // 是代理翻了还是上游挂了。
  app.get("/api/net", (_req, res) => {
    res.json({ outbound: outboundProxyStatus(), websearch: webSearchStats() });
  });

  // ── 本机模型（Qwen3.8-27B / Strata 125B）状态与启停 ─────────────────────────
  // composer 的「本机」状态面板用；start/stop 都是幂等的，返回操作后的实时状态。
  // ?engine=qwen|strata 选引擎，不带 = qwen（旧前端只认识这一台）。Strata 另认 ?model=<型号 id>（或 ?variant=<变体>）：问 / 起的是
  // 哪个变体；start 遇上在跑的是别的变体 = 切换（停掉按要的那个重起）。不带 = 在跑的那个，没在跑 = 默认变体。
  const variantOf = (q: Record<string, unknown>): StrataVariant | undefined =>
    cleanVariant(q.variant) ?? (typeof q.model === "string" ? strataVariantOf(q.model)?.id : undefined);

  app.get("/api/localai/status", async (req, res) => {
    res.json(await localAiStatus(cleanEngine(req.query.engine), variantOf(req.query)));
  });

  app.post("/api/localai/start", async (req, res) => {
    res.json(await localAiStart(cleanEngine(req.query.engine), variantOf(req.query)));
  });

  app.post("/api/localai/stop", async (req, res) => {
    res.json(await localAiStop(cleanEngine(req.query.engine), variantOf(req.query)));
  });

  // 启动参数（上下文 / KV 精度 / 视觉 / MTP 或 KV 流式）：保存；在跑就按新参数重启。gpu 给面板做显存估算。
  app.get("/api/localai/gpu", async (req, res) => {
    res.json(await localGpuInfo(cleanEngine(req.query.engine)));
  });

  app.post("/api/localai/settings", async (req, res) => {
    res.json(await localAiApply(req.body?.settings, cleanEngine(req.query.engine), variantOf(req.query)));
  });

  // 偏好设置注册表（prefs.ts）：bridge 设置页「dimensio」分区按清单画表单。null = 恢复默认。
  app.get("/api/prefs", (_req, res) => {
    res.json(allPrefs({ tenant: tenantMode() }));
  });
  app.post("/api/prefs", async (req, res) => {
    try {
      await setPrefs(req.body?.values, { tenant: tenantMode() });
      res.json(allPrefs({ tenant: tenantMode() }));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // 设置页「各厂商 API Key」：给某一家内置厂商存 key，不切换当前厂商（POST /api/config 带 apiKey 存给的是当前那家）。
  // 回各家「有没有 key」的新表（同 /api/info 的 providers）。
  app.post("/api/provider-keys", (req, res) => {
    try {
      setProviderKey(req.body?.provider, req.body?.apiKey);
      const off = disabledProviders();
      res.json({ ok: true, providers: Object.fromEntries(allProviders().filter((p) => !off.has(p.id)).map((p) => [p.id, hasKey(p.id)])) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
}

export function registerConfigWriteRoute(app: express.Express, KNOWN_TOOLS: ReadonlySet<string>): void {
  app.post("/api/config", (req, res) => {
    try {
      // P5（X24）：新写进来的权限规则先自查——写法不对、工具名不存在、模式为空的规则永远不会生效
      const problems = ruleProblems(req.body?.permissionRules, KNOWN_TOOLS, getConfig().permissionRules);
      if (problems.length) {
        res.status(400).json({ error: `权限规则有误：${problems.join("；")}` });
        return;
      }
      const cfg = setConfig(req.body as ConfigPatch);
      res.json({ ...cfg, hasKey: hasKey(cfg.provider) });
    } catch (e) {
      // workspace/access validation failures (bad path, not a directory, …)
      res.status(400).json({ error: (e as Error).message });
    }
  });
}
