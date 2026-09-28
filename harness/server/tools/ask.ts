import type { Tool, ToolContext, ToolRunResult, AskQuestionSpec, AskResolution } from "./types.ts";
import { ok, fail } from "./types.ts";

// AskUserQuestion — the human-in-the-loop escape hatch. When a decision is
// genuinely the user's to make (a real fork the task text left open, a
// destructive action to confirm), the agent poses structured multiple-choice
// questions and BLOCKS until the user answers. The block is real: run() awaits
// ctx.askUser, which the session resolves only when POST /answer arrives.
//
// This is deliberately the opposite of the harness's default autonomy. The
// description pushes hard against over-asking so a decisive model reaches for it
// only when it truly cannot proceed on a reasonable assumption.

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 5;

interface ParsedQuestion extends AskQuestionSpec {}

function parseQuestions(raw: unknown): { questions: ParsedQuestion[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { questions: [], error: "`questions` must be a non-empty array." };
  }
  if (raw.length > MAX_QUESTIONS) {
    return { questions: [], error: `Ask at most ${MAX_QUESTIONS} questions in one call.` };
  }
  const questions: ParsedQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] as Record<string, unknown> | null;
    const question = String(q?.question ?? "").trim();
    if (!question) return { questions: [], error: `Question ${i + 1} is missing its \`question\` text.` };
    const header = String(q?.header ?? "").trim().slice(0, 20) || `问题 ${i + 1}`;
    const rawOptions = Array.isArray(q?.options) ? q!.options : [];
    const options = rawOptions
      .map((o) => {
        const opt = o as Record<string, unknown> | null;
        const label = String(opt?.label ?? "").trim();
        const description = String(opt?.description ?? "").trim();
        return label ? { label, ...(description ? { description } : {}) } : null;
      })
      .filter((o): o is { label: string; description?: string } => o !== null);
    // Dedupe labels — the frontend keys selection by label, and the answer
    // parser matches labels back to options, so collisions would be ambiguous.
    const seen = new Set<string>();
    const unique = options.filter((o) => (seen.has(o.label) ? false : (seen.add(o.label), true)));
    if (unique.length < 2) {
      return { questions: [], error: `Question ${i + 1} needs at least 2 distinct options.` };
    }
    questions.push({
      header,
      question,
      multiSelect: Boolean(q?.multiSelect),
      options: unique.slice(0, MAX_OPTIONS),
    });
  }
  return { questions };
}

// The tool_result the model reads. Deterministic, one "- " line per question in
// order, so the frontend can zip answers back to questions by index for history
// rebuilds. Reads naturally so the model can act on it directly.
function formatResult(resolution: AskResolution): string {
  const lines = resolution.answers.map((a) => {
    const value = a.selected.length ? a.selected.join(", ") : "（未选择）";
    return `- ${a.header}: ${value}${a.custom ? "（自定义回答）" : ""}`;
  });
  return `用户已回答：\n${lines.join("\n")}`;
}

export const askUserQuestionTool: Tool = {
  // "read" so it is never blocked by a read-only permission mode — asking the
  // user mutates nothing. concurrencySafe:false: it blocks on the user and must
  // not be batched into a parallel read group.
  effect: "read",
  concurrencySafe: false,
  def: {
    name: "AskUserQuestion",
    description:
      "Ask the user to resolve a decision that is genuinely THEIRS to make, and block until they answer. " +
      "Use this ONLY when you cannot proceed on a reasonable assumption: a real fork the task left open " +
      "(which of several valid approaches / targets / scopes), or confirmation before a hard-to-reverse " +
      "action. Do NOT use it for things you can decide yourself, look up, or verify — the default is to " +
      "make a sensible choice, state it, and keep working. Prefer ONE call posing every open question " +
      "(1-4 questions) over stopping repeatedly. Each question gives 2-5 concrete options with a short " +
      "label and a description; the user can always choose 'Other' and type their own answer. After they " +
      "answer, continue the task with their choices.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "1-4 questions to ask together.",
          items: {
            type: "object",
            properties: {
              header: { type: "string", description: "Very short label/topic for the question (≤12 chars), e.g. \"数据库\"、\"部署方式\"." },
              question: { type: "string", description: "The full question to ask." },
              multiSelect: { type: "boolean", description: "Allow selecting multiple options (default false)." },
              options: {
                type: "array",
                description: "2-5 distinct choices.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Short choice text the user sees and picks." },
                    description: { type: "string", description: "One line on what this choice means or implies." },
                  },
                  required: ["label"],
                },
              },
            },
            required: ["question", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const { questions, error } = parseQuestions(args.questions);
    if (error) return fail("bad question", error);

    // No channel to the user (sub-agent / headless / test): degrade to autonomy
    // instead of hanging forever.
    if (!ctx.askUser) {
      return fail(
        "no user channel",
        "Interactive questions are not available in this context. Proceed with the most reasonable " +
          "assumption and state it explicitly in your answer.",
      );
    }

    const resolution = await ctx.askUser(questions, ctx.callId);
    if (resolution.away) {
      // P3：用户开了离开模式——不等答复，这一轮别因为一个问题永久挂住。
      return {
        ...ok(
          "user away",
          "The user is away right now (away mode is on), so nobody can answer. Do not wait: pick the most " +
            "reasonable default for each question, carry on, and in your final answer list the assumptions you " +
            "made on their behalf so they can correct them when back.",
        ),
        meta: { ask: { cancelled: true, away: true } },
      };
    }
    if (resolution.timedOut) {
      // P7：倒计时到了没人答——同离开模式：不再等，按合理默认继续并写明假设（卡片已经在所有设备上作废）
      return {
        ...ok(
          "no answer in time",
          `Nobody answered within ${resolution.timeoutMin ?? "the allowed"} minutes, so the question expired. Do not ask it ` +
            "again right away: pick the most reasonable default for each question, carry on, and in your final answer " +
            "list the assumptions you made so the user can correct them.",
        ),
        meta: { ask: { cancelled: true, timedOut: true } },
      };
    }
    if (resolution.cancelled) {
      return {
        ...ok(
          "no answer",
          "The user did not answer (the run was stopped or the question dismissed). Proceed with your " +
            "best assumption and state it explicitly.",
        ),
        meta: { ask: { cancelled: true } },
      };
    }
    const summaryParts = resolution.answers.map((a) => `${a.header}: ${a.selected.join(", ") || "—"}`);
    return {
      ...ok(summaryParts.join(" · ").slice(0, 80) || "answered", formatResult(resolution)),
      // Exact selections for history reconstruction — one entry per question, in
      // order. The formatted text above is for the model; this is for the UI.
      meta: { ask: { answers: resolution.answers.map((a) => ({ selected: a.selected, custom: a.custom })) } },
    };
  },
};
