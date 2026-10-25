// 和 bridge 的 Claude 外接编辑器共用的界面无关逻辑（src/model-knowledge/：档位表规则与预设、来源徽章、探测结论怎么应用、
// 地址与协议对不上的提示）。组件只从这里 import——两边 UI 套件不同，组件不能互用，只共用规则、数据形状和措辞键。
// 经 @hx 编进 bridge 时相对路径按真实文件位置解析，结果相同；开发态 vite 要放开仓库根（vite.config.ts 的 server.fs.allow）。
export * from "../../../../src/model-knowledge/editor.mjs";
export { protocolMismatch, endpointUrl, LEVEL_NAMES, MAX_TIERS, TIER_ID_RE, isOffTier } from "../../../../src/model-knowledge/knowledge.mjs";
export type { Tier, TierValue, Protocol, Source, ThinkingKind } from "../../../../src/model-knowledge/knowledge.mjs";

// dimensio 自己的：档位表 → 七级思考档的槽位映射（和服务端 custom-tiers.ts 同一份纯函数，零依赖）。编辑时就能指出放不进
// 七个槽的档位——以前服务端静默丢掉，模型菜单里选不到、也永远发不出去。
import { slotView, type TieredModel } from "../../../server/thinking-slots.ts";
export { slotView };
/** 放不进七级思考档的档位 id（空 = 都放得下）。 */
export const slotsLost = (m: TieredModel): string[] => slotView(m).dropped;
