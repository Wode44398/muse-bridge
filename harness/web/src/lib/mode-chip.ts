// 输入框左下的档位胶囊（运行档位 · 访问范围 · 离开 · 目标——09-26 把目标模式并进来，输入框不再单独挂一颗「目标」）
// 说什么、亮不亮、用哪个图标。纯函数，Node 测试直接跑。
// 默认（自主执行 · 整机 · 没离开 · 这条不是目标）只写「自主」、不亮；有人拉了闸（只读 / 计划、仅工作空间、本会话放行了
// 工作区外的目录、离开、这条是目标）才写出来并亮墨色。手机上胶囊只剩图标：这条是目标时图标换成靶心。
import type { IconName } from "./icons.ts";
import { t } from "./i18n.ts";

export type RunMode = "auto" | "read-only" | "plan";

export interface ModeChipInput {
  mode: RunMode;
  access: "workspace" | "full";
  roots: number; // 本会话放行的工作区外只读目录数（只在仅工作空间时有意义）
  away: boolean;
  goal: boolean; // 输入框里这条要作为目标发出
}

export const MODE_LABEL: Record<RunMode, string> = { auto: t("自主"), "read-only": t("只读"), plan: t("计划") };
const MODE_ICON: Record<RunMode, IconName> = { auto: "shield", "read-only": "eye", plan: "todo" };

export function modeChip(i: ModeChipInput): { text: string; alt: boolean; icon: IconName } {
  const fenced = i.access === "workspace";
  const roots = fenced ? i.roots : 0;
  const parts = [
    MODE_LABEL[i.mode],
    fenced ? t("仅工作空间") : "",
    roots ? t("+{n} 目录", { n: roots }) : "",
    i.away ? t("离开") : "",
    i.goal ? t("目标") : "",
  ].filter(Boolean);
  return {
    text: parts.join(" · "),
    alt: i.mode !== "auto" || fenced || roots > 0 || i.away || i.goal,
    icon: i.goal ? "target" : MODE_ICON[i.mode],
  };
}
