// 子 agent 里要人批准的调用：父会话这一轮正在跑、而且有人在场（不是离开模式）时，批准卡经父会话交给用户，卡上写明来自哪个
// 子 agent；父会话没在跑（后台子 agent 在父会话收工之后）或开着离开模式时，照旧按「没人在场」拒。
// 实现为子 agent 上下文上的一个取值器：loop 每次判定时现看，父会话此刻的状态说了算。
// 用户在卡上点了「本会话都允许」：规则同时记进父会话（之后派出的子 agent 也认），子 agent 自己的状态由 loop 照常记。
import type { AgentState } from "../state.ts";
import type { ToolContext } from "../../tools/types.ts";

type RequestPermission = NonNullable<ToolContext["requestPermission"]>;

export function wireApprovals(ctx: ToolContext, parent: (() => AgentState | undefined) | undefined, label: string): void {
  if (!parent) return;
  Object.defineProperty(ctx, "requestPermission", {
    configurable: true,
    enumerable: true,
    get(): RequestPermission | undefined {
      const p = parent();
      const ask = p?.ctx.requestPermission;
      if (!p || !ask) return undefined;
      if (p.ctx.humanAttended && !p.ctx.humanAttended()) return undefined;
      return async (req) => {
        const from = `来自子 agent「${label.slice(0, 40)}」`;
        const verdict = await ask({ ...req, why: req.why ? `${from}：${req.why}` : from });
        if (verdict.decision === "session" && !req.noSession) p.allowForSession(req.tool, req.subject, verdict.rules);
        return verdict;
      };
    },
    set() {
      /* 子 agent 的批准口由父会话此刻的状态决定，不接受赋值 */
    },
  });
}
