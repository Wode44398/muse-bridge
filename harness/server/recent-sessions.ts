// system 里记忆部分的「这个工作区最近的会话」：日期 + 标题 + id。用户说「上次那个 X」时模型有线索，再用 Recall 读那个会话或搜索。
// 建会话时定下（与 system 同契约，不走 World State）。列会话要读会话文件（异步），buildState 是同步的：开跑前先暖一次缓存
//（session/run.ts 在第一次请求前、补 system 之前），建 system 时只读缓存——缓存还没有就不出这一段。
// 每个实例只读自己的会话目录：成员实例看到的就只是他自己的会话。
import path from "node:path";
import type { SessionMeta } from "./store.ts";
import { workspaceSessions } from "./session-search.ts";

const MAX_LISTED = 15;
const TITLE_MAX = 80;
const cache = new Map<string, SessionMeta[]>();
const key = (root: string): string => (process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root));

// 最多等 budgetMs：会话很多时第一次要把每个会话文件读一遍（之后按 mtime 缓存），不能拖住开跑。超时就先不出这一段，
// 读完的结果照样进缓存，下一个新会话用得上
export const WARM_BUDGET_MS = 1500;
export async function warmRecentSessions(root: string, budgetMs = WARM_BUDGET_MS): Promise<void> {
  const k = key(root);
  const work = workspaceSessions(root, { limit: MAX_LISTED + 5 }).then(
    (list) => {
      cache.set(k, list);
    },
    () => {
      /* 列不出来就不出这一段 */
    },
  );
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
    timer.unref?.();
  });
  await Promise.race([work, late]);
  if (timer) clearTimeout(timer);
}

const day = (ms: number): string => {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "?";
};

// 渲染好的整段（含标题行）；没有别的会话 / 缓存还没暖 = undefined。exclude = 当前会话
export function recentSessionsSection(root: string, exclude?: string): string | undefined {
  const list = (cache.get(key(root)) ?? []).filter((m) => m.id !== exclude && !m.corrupt).slice(0, MAX_LISTED);
  if (!list.length) return undefined;
  const lines = list.map((m) => {
    const title = (m.title ?? "").replace(/\s+/g, " ").trim() || "(untitled)";
    return `- ${day(m.updatedAt)} ${title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title} · session:${m.id}`;
  });
  return `## Recent sessions in this workspace
Earlier conversations here, newest first. Recall with id "session:<id>" reads one (add a query to see only the matching parts); Recall with layer "sessions" and a query searches all of them.

${lines.join("\n")}`;
}
