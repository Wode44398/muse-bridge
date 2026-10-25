// 自定义服务的档位表 ⇄ dimensio 的七级思考档（ThinkingLevel）。
//
// 自定义型号和 bridge 的 Claude 外接用同一种能力形状（档位表 [{ id, name, value }]，见 src/model-knowledge/knowledge.mjs），
// 档位 id 是自由的（on、t3……）；而 dimensio 全链路（配置、会话快照、子 agent 继承档位、clampEffort、runtime-config.json）都按
// 固定的七级 off / minimal / low / medium / high / xhigh / max 排序。不扩枚举（牵连太广），做一层槽位映射——映射本身是纯函数，
// 在 thinking-slots.ts（网页的型号编辑器也直接用它校验），这里转出它的全部导出，再加上要用共用模块 applyTier 的两件：
//   · applyCustomThinking：适配器按「会话档 → 槽 → 档位 id」反查，再交给共用的 applyTier 写进请求体；
//   · autoThinkSlots：恒思考型号上「选着也照样思考」的槽（胶囊据此写「模型自带思考」，不再比对档名文字）。
import type { ThinkingLevel } from "./agent/turn.ts";
import { MK, type Tier } from "./model-knowledge.ts";
import { slotView, tierForLevel, type TieredModel } from "./thinking-slots.ts";

export * from "./thinking-slots.ts";

/**
 * 适配器用：把会话这一档对应的档位写进请求体（共用的 applyTier：budget / adaptive 是 Anthropic 写法，effort 按协议写字段或深合并）。
 * 型号没登记（model 为空）或这一档是「什么都不发」→ 原样返回。cap：输出上限天花板（budget 方式会把 max_tokens 抬到预算之上）。
 */
export function applyCustomThinking<T extends Record<string, unknown>>(
  body: T,
  model: (TieredModel & { efforts: Tier[]; effortField?: string; maxOutput?: number }) | undefined,
  level: ThinkingLevel | undefined,
  opts: { protocol: "openai" | "anthropic" | "gemini"; cap?: number },
): T {
  if (!model) return body;
  const tierId = tierForLevel(model, level);
  return tierId ? MK.applyTier(body, model, tierId, opts) : body;
}

/**
 * 恒思考（alwaysThinks）型号上，选着也照样思考的槽：这一档什么都不发（null 槽），或它的档位写不进请求（发送值为空）。
 * 真关得掉的关闭档（reasoning_effort=none、thinking.type=disabled……）不算——不管档名写成「关闭」「Off」还是「不思考」。
 * 不是恒思考的型号回 []。
 */
export function autoThinkSlots(
  m: TieredModel & { efforts?: Tier[]; effortField?: string; maxOutput?: number },
  protocol: "openai" | "anthropic" | "gemini",
): ThinkingLevel[] {
  if (!m.alwaysThinks) return [];
  const v = slotView(m);
  return v.efforts.filter((s) => {
    const id = v.tierOf[s];
    if (!id) return true;
    return JSON.stringify(MK.applyTier({}, { ...m, efforts: m.efforts ?? [] }, id, { protocol, cap: 4096 })) === "{}";
  });
}
