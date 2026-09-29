// E3（G7）：输入框的斜杠命令——纯函数（/ 面板的候选与排序、发送时认内置命令），服务端测试直接测。
// 技能的展开在服务端：/api/run 与插话都认 /技能名（网页、apk、反代共用一条路），这里只管面板和内置命令。
// 内置命令是界面动作（压缩、开新对话……），不发给模型；没命中的 /xxx 照普通消息发出（服务端也认不出，就是普通消息——
// 手机上输入 /api/... 这类路径不会被吞）。解析顺序：内置 → 技能（与 kimi 一致）。

import { t } from "./i18n.ts";

export type BuiltinId = "new" | "compact" | "handoff" | "goal";

export interface Builtin {
  id: BuiltinId;
  name: string;
  description: string;
  argHint?: string;
  // 这一轮还在跑时不能用（压缩、开新会话要等跑完；目标只能在空闲时开）
  idleOnly: boolean;
}

export const BUILTINS: readonly Builtin[] = [
  { id: "new", name: "new", description: t("开一个新对话（同一个项目）"), idleOnly: false },
  { id: "compact", name: "compact", description: t("立即压缩：较早的对话换成摘要，接着在这里聊"), idleOnly: true },
  { id: "handoff", name: "handoff", description: t("带摘要开新会话：整段写成摘要带过去，原会话留着"), idleOnly: true },
  { id: "goal", name: "goal", description: t("把这条作为目标：没达成会自动一轮轮接着做"), argHint: t("<目标>"), idleOnly: true },
];

// 与 api.ts 的 CommandList 同形（这里不引 api.ts，保持纯函数、服务端测试能直接加载）
export interface SlashSkill {
  name: string;
  description: string;
  pkg?: string;
  argumentHint?: string;
  userOnly?: boolean;
}
export interface SlashPackage {
  name: string;
  count: number;
}

export type PaletteItem =
  | { kind: "builtin"; name: string; description: string; hint?: string; builtin: Builtin; disabled?: string }
  | { kind: "skill"; name: string; description: string; hint?: string; pkg?: string; userOnly?: boolean }
  | { kind: "pkg"; name: string; description: string; count: number };

// 正在打命令名（以 / 开头、还没有空白）→ / 后面那一截（可能是空串）；否则 null
export function slashQuery(draft: string): string | null {
  const m = /^\/(\S*)$/.exec(draft);
  return m ? m[1] : null;
}

// 发送时：整条是不是内置命令（/new、/compact、/handoff、/goal 目标）。不分大小写
export function parseBuiltin(text: string): { builtin: Builtin; args: string } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const builtin = BUILTINS.find((b) => b.name === m[1].toLowerCase());
  return builtin ? { builtin, args: (m[2] ?? "").trim() } : null;
}

// 匹配分：全名 > 前缀 > 词首（按 - _ : . 切）> 包含 > 只在包名 / 说明里出现；0 = 不相干
function matchScore(q: string, name: string, extra: string[]): number {
  if (!q) return 1;
  const n = name.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.split(/[-_:.]/).some((part) => part.startsWith(q))) return 60;
  if (n.includes(q)) return 40;
  if (extra.some((e) => e.toLowerCase().includes(q))) return 20;
  return 0;
}

const KIND_ORDER = { builtin: 0, pkg: 1, skill: 2 } as const;

// / 面板的候选：按匹配分排，同分时内置 → 包 → 技能，再按原来的次序。disabled 给出内置命令此刻为什么用不了（面板上灰掉）
export function paletteItems(
  query: string,
  skills: readonly SlashSkill[],
  packages: readonly SlashPackage[],
  opts: { builtins?: readonly Builtin[]; disabled?: (b: Builtin) => string | undefined; limit?: number } = {},
): PaletteItem[] {
  const q = query.trim().toLowerCase().replace(/^skill:/, "");
  const scored: { item: PaletteItem; score: number; at: number }[] = [];
  let at = 0;
  for (const b of opts.builtins ?? BUILTINS) {
    const score = matchScore(q, b.name, [b.description]);
    const disabled = opts.disabled?.(b);
    if (score) scored.push({ item: { kind: "builtin", name: b.name, description: b.description, ...(b.argHint ? { hint: b.argHint } : {}), builtin: b, ...(disabled ? { disabled } : {}) }, score, at: at++ });
  }
  for (const p of packages) {
    const score = matchScore(q, p.name, []);
    if (score) scored.push({ item: { kind: "pkg", name: p.name, description: t("技能包 · {n} 个技能，点包名让它挑", { n: p.count }), count: p.count }, score, at: at++ });
  }
  for (const s of skills) {
    const score = matchScore(q, s.name, [s.pkg ? `${s.pkg}/${s.name}` : "", s.pkg ?? "", s.description]);
    if (score) {
      scored.push({
        item: {
          kind: "skill",
          name: s.name,
          description: s.description,
          ...(s.argumentHint ? { hint: s.argumentHint } : {}),
          ...(s.pkg ? { pkg: s.pkg } : {}),
          ...(s.userOnly ? { userOnly: true } : {}),
        },
        score,
        at: at++,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.at - b.at);
  return scored.slice(0, opts.limit ?? 60).map((s) => s.item);
}

// 选中一项之后输入框里的字：技能 / 包 / 带参数的内置命令补成「/名字 」接着打参数；不带参数的内置命令由调用方直接执行
export function completion(item: PaletteItem): string {
  return `/${item.name} `;
}
