// C4（X12、N09 第 2/3 步，K11、K12、K60、K63 部分；#30 余）：World State 分节注册表。
//
// 以前运行中切档、切访问范围都就地改写 system（plan 段、访问范围段摘了又补），恢复会话时再按当前磁盘重写 system 的
// 动态尾段——每一次都让整个请求的前缀缓存从 system 起作废；GUIDE、AGENTS.md、技能在会话中途改了，模型根本不知道。
// 现在 system 在会话里定下来就不动（压缩成功是唯一的全量重建点），这些「harness 维护的事实」按节登记：
//   · 每节一个「令牌」：短的（模式、访问范围、日期、后台 job）就是值本身，长的（GUIDE、AGENTS.md、技能、项目知识、
//     记忆）是内容哈希；
//   · system 建成时各节的令牌记在 state.systemWorld；之后哪节变了，就在下一轮请求前追加一条内部片段（origin harness、
//     kind world-state），片段上带着它更新的那几节的令牌（Msg.world）；
//   · 基线 = system 的令牌，被转录里各节最后一个片段覆盖。片段被回滚或压缩剪掉，基线自然退回 system 的值，那一节
//     就会整段重新注入——不用另记「注入过没有」。
import { createHash } from "node:crypto";
import type { Msg } from "./turn.ts";

export type WorldSection = "mode" | "access" | "date" | "guide" | "projectDocs" | "skills" | "knowledge" | "memory" | "jobs";
export type WorldValues = Partial<Record<WorldSection, string>>;
export type WorldTokens = Partial<Record<WorldSection, string>>;

// 每轮都看的节；其余（日期、项目知识、记忆）只在一轮开跑时看——它们在一轮里要么不变，要么是模型自己改的
export const TURN_SECTIONS: readonly WorldSection[] = ["mode", "access", "guide", "projectDocs", "skills", "jobs"];
export const RUN_START_SECTIONS: readonly WorldSection[] = ["date", "knowledge", "memory"];

const SHORT: ReadonlySet<WorldSection> = new Set(["mode", "access", "date", "jobs"]);
const SHORT_MAX = 64; // 短节的值超过这个长度（结束的 job 攒多了）也改记哈希，别让令牌把会话文件撑大
// 只报新消息的节：变空不必说（后台 job 被停会话清掉、服务重启后登记表是空的——都不是模型要知道的事）
const NEWS_ONLY: ReadonlySet<WorldSection> = new Set(["jobs"]);

export function worldToken(section: WorldSection, value: string): string {
  if (SHORT.has(section) && (value ?? "").length <= SHORT_MAX) return value;
  return value ? `sha1:${createHash("sha1").update(value).digest("hex").slice(0, 16)}` : "";
}

// 片段里「原来是什么」只对短节有意义（长节的令牌是哈希）
const readable = (token: string | undefined): string | undefined => (token && !token.startsWith("sha1:") ? token : undefined);

export function worldTokens(values: WorldValues): WorldTokens {
  const out: WorldTokens = {};
  for (const [section, value] of Object.entries(values) as [WorldSection, string][]) out[section] = worldToken(section, value);
  return out;
}

// 模型此刻认为的样子：system 的令牌，被转录里各节最后一个片段覆盖
export function worldBaseline(system: WorldTokens, messages: readonly Msg[]): WorldTokens {
  const out: WorldTokens = { ...system };
  for (const m of messages) {
    if (!m.world) continue;
    for (const [section, token] of Object.entries(m.world)) out[section as WorldSection] = token;
  }
  return out;
}

export interface WorldDelta {
  text: string;
  tokens: WorldTokens;
}

// 变了的节 → 一条片段；都没变 → null。values 里没给的节不看（这一轮不查它）。
export function worldDelta(values: WorldValues, baseline: WorldTokens, describe: (section: WorldSection, value: string, was: string | undefined) => string): WorldDelta | null {
  const lines: string[] = [];
  const tokens: WorldTokens = {};
  for (const [section, value] of Object.entries(values) as [WorldSection, string][]) {
    const token = worldToken(section, value);
    const was = baseline[section];
    if (was === token) continue;
    // 现在是空的，而基线里没有这一节（system 建成时不含它）或者这一节只报新消息：不必说
    if (!value && (was === undefined || NEWS_ONLY.has(section))) continue;
    lines.push(describe(section, value, readable(was)));
    tokens[section] = token;
  }
  if (!lines.length) return null;
  return {
    text: `[World state update] These harness-maintained facts changed since you last saw them. They supersede what the system prompt or earlier updates say about the same things.\n\n${lines.join("\n\n")}`,
    tokens,
  };
}
