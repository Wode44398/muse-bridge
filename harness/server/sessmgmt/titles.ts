// 会话标题：手动改名，与首轮之后的 AI 起标题。
//
// 默认标题是首句前 60 字（开跑时定）。首轮正常收尾后，偏好「AI 起标题」开着、用户没改过名，就用便宜模型照对话起一个
// 短标题替换它；失败（没 key、超时、回了一堆废话）静默保留首句标题，最多试两次。用户手动改过的标题 AI 一律不碰。
// 写标题的规矩：在内存里的会话改对象上的 title（它的单写者下次落盘带上）；在跑的会话只改对象（收尾时落盘）；
// 不在内存里的直接改盘上的记录。改名不算活动——尽量保住记录里的 updatedAt，免得旧对话改个名就跳到列表最上面。
import { getSession, lifecycle, sessionRecord, type Session } from "../session.ts";
import { loadSessionResult, saveSession } from "../store.ts";
import { prefValue } from "../prefs.ts";
import { askAux, conversationExcerpt } from "./aux-model.ts";
import { getFlags, patchFlags } from "./store.ts";

export const TITLE_MAX = 80;
const MAX_TRIES = 2;

export function cleanTitle(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
}

async function writeTitle(id: string, title: string): Promise<boolean> {
  return lifecycle(id, async () => {
    const live = getSession(id);
    if (live) {
      live.title = title;
      if (live.running) return true;
      const rec = sessionRecord(live);
      if (!rec) return true; // 还没跑过一轮：没有记录可写，第一次落盘就带上
      const disk = await loadSessionResult(id);
      await saveSession({ ...rec, updatedAt: disk.kind === "ok" ? disk.rec.updatedAt : rec.updatedAt });
      return true;
    }
    const disk = await loadSessionResult(id);
    if (disk.kind !== "ok") return false;
    // 读盘的这一会儿它被读进了内存：交给内存里那份
    const raced = getSession(id);
    if (raced) {
      raced.title = title;
      return true;
    }
    await saveSession({ ...disk.rec, title });
    return true;
  });
}

// 用户改名（空 = 恢复成首句标题由用户说了算，这里不猜：空名拒绝）
export async function renameSession(id: string, raw: unknown): Promise<{ ok: boolean; title?: string; error?: string }> {
  const title = cleanTitle(raw);
  if (!title) return { ok: false, error: "标题不能为空" };
  const ok = await writeTitle(id, title);
  if (!ok) return { ok: false, error: "没有这个会话" };
  patchFlags(id, { titleBy: "user" });
  return { ok: true, title };
}

const TITLE_SYSTEM = `You name chat sessions for a coding/assistant app's session list.
Write ONE short title that captures the main topic or goal of the conversation so the user recognizes it in a list.
- Use the same language the user writes in. Chinese: 4-14 characters, no trailing punctuation. English: 3-7 words, sentence case.
- No quotes, no emoji, no prefixes like "Title:", no explanation.
Good: 修复移动端登录按钮 / 给 API 客户端加重试 / Debug failing CI tests
Bad (too vague): 代码修改 / Code changes
Reply with ONLY the title.`;

// 模型回的东西收拾成标题；不像标题的（空、太长、多行解释）返回 null
export function parseTitle(raw: string): string | null {
  let s = raw.trim();
  // 有的模型会包 JSON 或引号
  const json = /^\{[\s\S]*"title"\s*:\s*"([^"]+)"[\s\S]*\}$/.exec(s);
  if (json) s = json[1];
  s = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "";
  s = s.replace(/^(title|标题)\s*[:：]\s*/i, "").replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, "").replace(/[。．.!！]+$/, "").trim();
  if (!s || s.length > 60) return null;
  return s;
}

function shouldTitle(id: string): boolean {
  if (!prefValue<boolean>("aiTitles")) return false;
  const f = getFlags(id);
  return f.titleBy === undefined && (f.titleTries ?? 0) < MAX_TRIES;
}

const inflight = new Set<string>();

// 一轮收尾后调（只认正常做完的轮）。onTitle：标题换了之后通知界面。
export async function maybeAiTitle(session: Session, onTitle: (id: string, title: string) => void): Promise<void> {
  const id = session.id;
  if (inflight.has(id) || !shouldTitle(id) || !session.cfg || !session.state) return;
  const ex = conversationExcerpt(session.state.messages, { maxChars: 2400, perMessage: 800 });
  if (!ex.userTurns || !ex.assistantTurns) return;
  inflight.add(id);
  try {
    patchFlags(id, { titleTries: (getFlags(id).titleTries ?? 0) + 1 });
    const before = session.title;
    const got = await askAux(
      session.cfg,
      { system: TITLE_SYSTEM, prompt: `Conversation:\n\n${ex.text}\n\nTitle:`, maxOutputTokens: 600, timeoutMs: 30_000 },
      "AI 标题",
    );
    const title = got ? parseTitle(got.text) : null;
    if (!title) return;
    // 生成的这一会儿用户改了名（或会话被删了）：不覆盖
    const f = getFlags(id);
    if (f.titleBy === "user" || session.discarded || session.title !== before) return;
    if (!(await writeTitle(id, cleanTitle(title)))) return;
    patchFlags(id, { titleBy: "ai" });
    onTitle(id, session.title);
  } catch (e) {
    console.warn(`[sessmgmt] AI 标题失败：${(e as Error).message}`);
  } finally {
    inflight.delete(id);
  }
}
