// 子 agent 调用策略的 HTTP 接口（bridge 设置 › dimensio › 子 agent 调用策略）。策略存在 bridge，这里只做 bridge 算不了的那部分：
//   POST /api/dispatch/preview { strategy?, allowThirdParty? } → { ok, preview:{ tiers, candidates, unrated, generated } }
//        按给的策略（可携写法，bridge 的 src/runtime/dispatch-dimensio.mjs）在这个实例此刻真能用的型号上算四档落点（agent/dispatch-ladder.ts）；
//        不给 strategy = 按这个实例此刻生效的那份。
//   GET  /api/dispatch/legacy → { ladder, note }：旧的两项偏好（按难度选型阶梯开关、子 agent 调度偏好文本），bridge 迁进它那份时用
//   POST /api/dispatch/refresh → { ok }：bridge 改了策略后叫一声，丢掉缓存，下一个会话按新的
// 调用方是 bridge 服务端（modules/dimensio 的 dispatchPreview / dispatchLegacy / dispatchChanged，带实例令牌直连）。浏览器经反代也打得到，
// 但三样都只读 / 无副作用（预览不落盘、旧偏好设置页本来就看得到、作废缓存只是多问一次 bridge），不另设闸。
import type { Express } from "express";
import { ladderPreview } from "./agent/dispatch-ladder.ts";
import { cleanStrategy, currentDispatchPolicy, invalidateDispatchPolicy, refreshDispatchPolicy } from "./agent/dispatch-policy.ts";
import { prefValue } from "./prefs.ts";

export function registerDispatchRoutes(app: Express): void {
  app.post("/api/dispatch/preview", async (req, res) => {
    const b = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    if (b.allowThirdParty !== undefined && typeof b.allowThirdParty !== "boolean") {
      res.status(400).json({ error: "allowThirdParty must be true / false" });
      return;
    }
    try {
      let strategy = b.strategy === undefined || b.strategy === null ? undefined : cleanStrategy(b.strategy);
      let allowThirdParty = b.allowThirdParty as boolean | undefined;
      if (strategy === undefined || allowThirdParty === undefined) {
        await refreshDispatchPolicy();
        const p = currentDispatchPolicy();
        strategy ??= p?.strategy ?? null;
        allowThirdParty ??= p ? p.allowThirdParty : true;
      }
      res.json({ ok: true, preview: await ladderPreview({ strategy, allowThirdParty }) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/dispatch/legacy", (_req, res) => {
    res.json({ ladder: prefValue<boolean>("subagentLadder") !== false, note: String(prefValue<string>("subagentDispatch") ?? "") });
  });

  app.post("/api/dispatch/refresh", (_req, res) => {
    invalidateDispatchPolicy();
    void refreshDispatchPolicy();
    res.json({ ok: true });
  });
}
