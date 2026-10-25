// 自定义服务的档位表 ⇄ dimensio 七级思考档的槽位映射（纯函数，没有运行时依赖）。
//
// 从 custom-tiers.ts 拆出来，是为了让网页（harness/web 的型号编辑器）也能直接用同一份映射：编辑时就告诉用户哪几档放不进
// 七个槽（以前服务端静默丢掉，模型菜单里选不到、也永远发不出去）。服务端照旧从 custom-tiers.ts 拿（那边转出这里的全部导出）。
// 这里不 import 任何东西（类型也就地定义）：网页经 bridge 的 @hx 编进去时不能把服务端代码拖进包。
//
// 规则（自定义型号和 bridge 的 Claude 外接用同一种能力形状：档位表 [{ id, name, value }]，档位 id 是自由的）：
//   · 档位 id 本身是七级之一 → 占同名槽；off / none / disabled → off 槽；on / enabled → high 槽（档名「开启」）；
//   · 其余自由 id：只有一个 → high 槽；多个按表里的顺序填空着的 low → medium → high → xhigh → max（不够再用 minimal）；
//     自由 id 不占 off 槽——放不下的进 dropped（编辑器与服务端校验据此报错，读盘时只能丢掉）；
//   · 表里没有关闭档、没设默认档、模型也不是「不发参数也会思考」→ 补一个 off 槽 =「默认」：什么都不发（厂商默认）；
//   · 没有档位：不思考的模型只有 off（不发）；恒思考的只有 high，档名「模型自带思考」（胶囊上照样写出来）。
// 档名和槽位标准名不同才写进 labels（ModelMenu / 胶囊按它显示）。

export type SlotLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const SLOT_ORDER: readonly SlotLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const OFF_IDS = new Set(["off", "none", "disabled"]);
const ON_IDS = new Set(["on", "enabled"]);
const STD_NAME: Record<SlotLevel, string> = { off: "off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" };
export const DEFAULT_SLOT_LABEL = "默认"; // 「什么都不发、用厂商默认」那一槽的档名（off 槽）
export const ALWAYS_THINKS_LABEL = "模型自带思考";

export interface SlotTier {
  id: string;
  name?: string;
}

export interface TieredModel {
  thinking: string;
  efforts?: SlotTier[];
  effortDefault?: string;
  alwaysThinks?: boolean;
}

export interface SlotView {
  efforts: SlotLevel[]; // 升序
  labels: Partial<Record<SlotLevel, string>>;
  defaultEffort?: SlotLevel; // 首次选中时用哪档（没有 = 按 dimensio 的老规则：high > low > 第一档）
  tierOf: Partial<Record<SlotLevel, string | null>>; // 槽 → 档位 id（null = 什么都不发）
  dropped: string[]; // 放不进七个槽的档位 id（按表里的顺序）
}

export function slotView(m: TieredModel): SlotView {
  const tiers = m.thinking === "none" ? [] : (m.efforts ?? []);
  const map = new Map<SlotLevel, string | null>();
  const labels: Partial<Record<SlotLevel, string>> = {};
  const dropped: string[] = [];
  if (!tiers.length) {
    if (m.alwaysThinks) {
      map.set("high", null);
      labels.high = ALWAYS_THINKS_LABEL;
    } else map.set("off", null);
  } else {
    const rest: SlotTier[] = [];
    for (const t of tiers) {
      const id = String(t.id);
      const slot: SlotLevel | null = OFF_IDS.has(id) ? "off" : (SLOT_ORDER as readonly string[]).includes(id) ? (id as SlotLevel) : ON_IDS.has(id) ? "high" : null;
      if (slot && !map.has(slot)) map.set(slot, id);
      else rest.push(t);
    }
    const free = (list: SlotLevel[]) => list.filter((s) => !map.has(s));
    if (rest.length === 1 && !map.has("high")) map.set("high", rest[0].id);
    else if (rest.length) {
      let slots = free(["low", "medium", "high", "xhigh", "max"]);
      if (slots.length < rest.length) slots = free(["minimal", "low", "medium", "high", "xhigh", "max"]);
      rest.forEach((t, i) => {
        if (slots[i]) map.set(slots[i], t.id);
        else dropped.push(String(t.id));
      });
    }
    for (const [slot, id] of map) {
      const name = tiers.find((t) => t.id === id)?.name?.trim();
      if (name && name.toLowerCase() !== STD_NAME[slot].toLowerCase() && !(slot !== "off" && name.toLowerCase() === slot)) labels[slot] = name;
    }
    if (!map.has("off") && !m.effortDefault && !m.alwaysThinks) {
      map.set("off", null);
      labels.off = DEFAULT_SLOT_LABEL;
    }
  }
  const efforts = SLOT_ORDER.filter((s) => map.has(s));
  let defaultEffort: SlotLevel | undefined;
  if (m.effortDefault) defaultEffort = efforts.find((s) => map.get(s) === m.effortDefault);
  else if (map.get("off") === null && labels.off === DEFAULT_SLOT_LABEL) defaultEffort = "off";
  const tierOf: Partial<Record<SlotLevel, string | null>> = {};
  for (const [s, id] of map) tierOf[s] = id;
  return { efforts, labels, ...(defaultEffort ? { defaultEffort } : {}), tierOf, dropped };
}

/** 会话里的档 → 这个模型档位表里的档位 id（'' = 什么都不发）。不在槽里的档（没经 clamp 的旧值）也按什么都不发。 */
export function tierForLevel(m: TieredModel, level: SlotLevel | undefined): string {
  return slotView(m).tierOf[level ?? "off"] ?? "";
}
