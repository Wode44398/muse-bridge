// Tab 输入建议（对齐官方 Claude Code 的 prompt suggestion）：一轮正常做完后，猜用户接下来会打的那句话，
// 输入框空着时当灰字显示，按 Tab 填入。
//
// 与官方的区别：官方是分叉主对话（同型号、蹭主对话的缓存）；这里用便宜模型看一段对话摘录——不占主对话的型号与上下文。
// 在收轮之后异步生成，不拖慢收轮；新一轮开跑即作废（广播空建议）。抑制条件照官方：早期对话（助手回答不到两条）、
// 这一轮不是正常做完、计划档、还有排队的话；生成出来的再过一遍官方的过滤规则（含中文的对应写法）。
// 建议只在内存里（重启就没了，与官方同：它是提示，不是记录），经全局事件 suggestion 广播，打开会话时也能取。
import { emitGlobal, type Session } from "../session.ts";
import { prefValue } from "../prefs.ts";
import { askAux, conversationExcerpt } from "./aux-model.ts";
import { getQueue } from "./store.ts";

export interface Suggestion {
  text: string;
  at: number;
}

const current = new Map<string, Suggestion>();
const gen = new Map<string, number>(); // 每个会话的世代：新一轮开跑就 +1，晚到的旧建议作废

export function suggestionOf(id: string): Suggestion | null {
  return current.get(id) ?? null;
}

export function clearSuggestion(id: string): void {
  gen.set(id, (gen.get(id) ?? 0) + 1);
  if (current.delete(id)) emitGlobal({ e: "suggestion", id, text: "", at: Date.now() });
}

const SYSTEM = `[SUGGESTION MODE: Suggest what the user might naturally type next into this coding assistant.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
Assistant offers options → suggest the one the user would likely pick, based on conversation
Assistant asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Assistant-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Format: 2-12 words (or a short Chinese phrase if the user writes Chinese), match the user's language and style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`;

const CJK = /[㐀-鿿]/;
const ALLOWED_SINGLE = new Set(["yes", "yeah", "yep", "yea", "yup", "sure", "ok", "okay", "push", "commit", "deploy", "stop", "continue", "check", "exit", "quit", "no"]);

// 官方 shouldFilterSuggestion 的规则（+ 中文的对应写法）。留下的返回收拾过的文字，滤掉的返回 null
export function filterSuggestion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, "").trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  const cjk = CJK.test(s);
  const words = s.split(/\s+/).length;
  if (lower === "done") return null;
  if (/^(nothing found|nothing to suggest|no suggestion)/.test(lower) || /\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) || /^\W*silence\W*$/.test(lower)) return null;
  if (/^(无|没有建议|保持沉默|沉默)[。.]?$/.test(s)) return null;
  if (/^\(.*\)$|^\[.*\]$|^（.*）$|^【.*】$/.test(s)) return null;
  if (/^(api error:|prompt is too long|request timed out|invalid api key|image was too large)/.test(lower)) return null;
  if (/^\w+:\s/.test(s) || /^(建议|下一句|用户)[:：]/.test(s)) return null;
  if (!cjk && words < 2 && !s.startsWith("/") && !ALLOWED_SINGLE.has(lower)) return null;
  if (!cjk && words > 12) return null;
  if (cjk && s.length > 40) return null;
  if (s.length >= 100) return null;
  if (/[.!?]\s+[A-Z]/.test(s) || /[。！？；].+/.test(s.replace(/[。！？]+$/, ""))) return null;
  if (/[\n*]|\*\*/.test(s)) return null;
  if (/thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/.test(lower)) return null;
  if (/谢谢|多谢|辛苦了|不错|很好|太好了|完美|没问题了|就这样吧/.test(s)) return null;
  if (/^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(s)) return null;
  if (/^(我来|我会|让我|我已|我先|这是|以下是|下面是|你可以|你应该|你能)/.test(s)) return null;
  s = s.replace(/[。.]$/, "");
  return s || null;
}

// 一轮正常做完后调。onReady：有建议了通知界面（经全局事件）
export async function maybeSuggest(session: Session): Promise<void> {
  const id = session.id;
  if (!prefValue<boolean>("promptSuggestions") || !session.cfg || !session.state) return;
  if (getQueue(id).length) return; // 排着的话马上就要发出去
  if (session.state.effectiveMode?.() === "plan") return;
  const ex = conversationExcerpt(session.state.messages, { maxChars: 3000, perMessage: 900 });
  if (ex.assistantTurns < 2) return; // 官方 early_conversation
  const my = (gen.get(id) ?? 0) + 1;
  gen.set(id, my);
  const got = await askAux(
    session.cfg,
    { system: SYSTEM, prompt: `Recent conversation:\n\n${ex.text}\n\nWhat would the user type next?`, maxOutputTokens: 400, timeoutMs: 25_000 },
    "输入建议",
  );
  if (gen.get(id) !== my || session.running || session.discarded) return; // 这期间开了新一轮
  const text = filterSuggestion(got?.text);
  if (!text) return;
  const item = { text, at: Date.now() };
  current.set(id, item);
  emitGlobal({ e: "suggestion", id, text: item.text, at: item.at });
}
