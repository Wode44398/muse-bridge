// 时间线 → Feed 的显示单元（纯函数，不依赖 Svelte；server/feed-units.test.ts 直接测）。
//
// 工具组折叠（原在 Feed.svelte 里）：连续的工具 / 思考段收成一张组卡。
// U8（Codex X43）：组卡只收「只读探索」——看文件、搜代码、查网页这些只看不改的调用；改文件、跑命令、派子 agent、
// 开工作流这些动作单独成行，一眼看得见这一轮真正做了什么（以前一律收进「执行了 N 步」，改了哪些文件得点开才知道）。
// Workflow 永远自成一行（官方 /code 页分桶同款；并进组卡的话运行中的紧凑卡被收起只露一行）。
// 子 agent（Agent 工具）也不进组：紧挨着的几个 Agent（模型一轮里并行派出去的一批）合成一个单元，画成一张子 agent 卡
//（一个 = 单卡，多个 = 叠卡），两种模式都一样——派出去的活是这一轮的主干，不该埋在「执行了 N 步」里。
//
// 精简模式（compact，默认——设置里「显示全部工作过程」关着）：对齐 bridge Claude 分页（= 官方 /code 页）的工具分组——
// 不分只读还是动作，连续 ≥2 次工具（含穿插的思考，Workflow 除外）一律收成一行：跑着时头行说此刻在做什么，做完说
//「读取了 3 个文件，执行了 2 条命令」，点开再看每一步。只有 1 次工具的段不套组头，各行照常（单行工具行本身也只留头行）。
// 上面那套只读探索分组是「显示全部工作过程」打开时的样子，原样保留。
//
// U8（ZCode E3）：轮次折叠。一轮 = 用户自己发的一条消息到下一条之间（运行中插话不算分界）。做完的轮（最近这一轮除外——
// 跑着的、刚做完的都留着看）只要跑过工具，过程——工具、思考、中间的叙述——收成一行「处理过程 · N 次工具 · 用时」，点开
// 照原样展开；卡片回执、报错、提示、截图与这一轮最后一段回答照常显示。
import type { Item, RunTiming, ToolItem } from "./timeline-types.ts";
import { t, tc } from "./i18n.ts";

// 只读探索：只看不改的工具
export const EXPLORE_TOOLS = new Set([
  "Read", "Grep", "Glob", "WebFetch", "WebSearch", "ReadPage", "Recall", "ProjectKnowledge", "Network", "LocalPCInspect", "Skill",
]);

export type FeedUnit =
  | { g: true; f?: false; a?: false; key: string; items: Item[]; live: boolean }
  | { g: false; f?: false; a?: false; key: string; item: Item }
  // 一批并行的子 agent（紧挨着的 Agent 工具行）：一张子 agent 卡
  | { g: false; f?: false; a: true; key: string; items: ToolItem[] }
  // 一轮的过程折成的一行（open = 点开了：过程照原样跟在它后面）
  | { g: false; f: true; a?: false; key: string; items: Item[]; tools: number; run?: RunTiming; open: boolean };

const isExplore = (it: Item) => it.kind === "thinking" || (it.kind === "tool" && EXPLORE_TOOLS.has((it as ToolItem).name));
const isAgent = (it: Item | undefined): it is ToolItem => it?.kind === "tool" && (it as ToolItem).name === "Agent";
const isStep = (it: Item) => it.kind === "thinking" || (it.kind === "tool" && (it as ToolItem).name !== "Workflow" && !isAgent(it));

// 工具组：tl[from, to) 里连续的只读探索（含穿插的思考）≥2 次工具且段长 ≥3 才收成组卡；
// 精简模式：连续的工具 / 思考（Workflow、Agent 除外）≥2 次工具就收
function pushGrouped(out: FeedUnit[], tl: Item[], from: number, to: number, running: boolean, compact = false): void {
  const inGroup = compact ? isStep : isExplore;
  const minLen = compact ? 2 : 3;
  let i = from;
  while (i < to) {
    if (isAgent(tl[i])) {
      let j = i;
      while (j < to && isAgent(tl[j])) j++;
      out.push({ g: false, a: true, key: `a:${(tl[i] as ToolItem).id}`, items: tl.slice(i, j) as ToolItem[] });
      i = j;
      continue;
    }
    if (!inGroup(tl[i])) {
      out.push({ g: false, key: `i:${i}`, item: tl[i] });
      i++;
      continue;
    }
    let j = i;
    let toolCount = 0;
    let firstToolId = "";
    while (j < to && inGroup(tl[j])) {
      if (tl[j].kind === "tool") {
        toolCount++;
        if (!firstToolId) firstToolId = (tl[j] as ToolItem).id;
      }
      j++;
    }
    if (toolCount >= 2 && j - i >= minLen) {
      out.push({ g: true, key: `g:${firstToolId}`, items: tl.slice(i, j), live: running && j === tl.length });
    } else {
      for (let m = i; m < j; m++) out.push({ g: false, key: `i:${m}`, item: tl[m] });
    }
    i = j;
  }
}

interface FoldPlan {
  key: string;
  first: number; // 第一个过程条目的位置（折叠行放这里）
  folded: Set<number>;
  tools: number;
  run?: RunTiming;
}

// 这一轮要不要折、折哪些：过程 = 工具、思考、中间的叙述（最后一段回答不算）；一次工具都没跑的轮不折
export function planFold(tl: Item[], from: number, to: number): FoldPlan | null {
  let lastText = -1;
  for (let i = to - 1; i >= from; i--) {
    if (tl[i].kind === "text") {
      lastText = i;
      break;
    }
  }
  const folded = new Set<number>();
  let tools = 0;
  let firstTool = "";
  for (let i = from; i < to; i++) {
    const it = tl[i];
    if (i === lastText) continue;
    if (it.kind === "tool") {
      tools++;
      if (!firstTool) firstTool = it.id;
      folded.add(i);
    } else if (it.kind === "thinking" || it.kind === "text") {
      folded.add(i);
    }
  }
  if (!tools) return null;
  const last = lastText >= 0 ? tl[lastText] : null;
  return {
    key: `f:${firstTool}`,
    first: Math.min(...folded),
    folded,
    tools,
    ...(last?.kind === "text" && last.run ? { run: last.run } : {}),
  };
}

export function feedUnits(tl: Item[], running: boolean, openFolds: Record<string, boolean> = {}, compact = false): FeedUnit[] {
  const out: FeedUnit[] = [];
  // 轮次边界：用户自己发的消息（运行中插话不算）
  const cuts = [0];
  tl.forEach((it, i) => {
    if (i > 0 && it.kind === "user" && !it.steer) cuts.push(i);
  });
  cuts.push(tl.length);
  for (let s = 0; s + 1 < cuts.length; s++) {
    const from = cuts[s];
    const to = cuts[s + 1];
    // 最近这一轮不折（跑着的、刚做完的都留着看）
    const plan = to === tl.length ? null : planFold(tl, from, to);
    if (!plan) {
      pushGrouped(out, tl, from, to, running, compact);
      continue;
    }
    const open = openFolds[plan.key] === true;
    const fold: FeedUnit = { g: false, f: true, key: plan.key, items: [...plan.folded].map((i) => tl[i]), tools: plan.tools, open, ...(plan.run ? { run: plan.run } : {}) };
    if (open) {
      pushGrouped(out, tl, from, plan.first, running, compact);
      out.push(fold);
      pushGrouped(out, tl, plan.first, to, running, compact);
      continue;
    }
    for (let i = from; i < to; i++) {
      if (i === plan.first) out.push(fold);
      else if (!plan.folded.has(i)) out.push({ g: false, key: `i:${i}`, item: tl[i] });
    }
  }
  return out;
}

// 折叠行上的用时：「用时 2 分 13 秒（等你的 40 秒不算）」——扣掉等人的时间才是真在干活的时间
export function foldTiming(run: RunTiming | undefined): string {
  if (!run) return "";
  const work = Math.max(0, run.durationMs - run.waitedMs);
  if (run.waitedMs >= 1000) return t("用时 {d}（等你的 {w}不算）", { d: dur(work), w: dur(run.waitedMs) });
  return t("用时 {d}", { d: dur(work) });
}

function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return tc("dimensio", "{n} 秒", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? t("{m} 分 {s} 秒", { m, s: s % 60 }) : t("{n} 分", { n: m });
  const h = Math.floor(m / 60);
  return m % 60 ? t("{h} 小时 {m} 分", { h, m: m % 60 }) : tc("dimensio", "{n} 小时", { n: h });
}
