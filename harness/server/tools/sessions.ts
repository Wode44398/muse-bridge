// 会话协作的四件工具：StartSession / SendMessage / ListSessions / ReadSession（运行时在 ../session-family.ts）。
// 语义对齐 bridge 里 Claude 的 mcp__sessions__start_session / send_message / list_sessions / read_session（src/mcp/session-tools.mjs），
// 档位（偏好 collab.newSessionPolicy）三种：
//   ask（默认）：user_asked 直接开；offer（用户提了件与手头无关的事）/ own_initiative（自己发现值得单开的后续）弹一张问答卡问用户，
//        选了「新会话 / 开始」才开——dimensio 没有 Claude 那套提议卡台账，卡就是 AskUserQuestion 的同一张卡（会挂住这一轮）；
//   direct：offer / own_initiative 也不问直接开（每条用户消息之后最多自动开 AUTO_MAX 个，超了退回问卡）；
//   onRequest：只有 user_asked。
// 工具说明按建会话时的档位写（def 是 getter，buildState 取一次定下，之后这个会话的工具表不再变）；执行时现读档位。
// 不是用户在这里发起的轮（会话间唤醒 / 派生 / 重启续跑 / 目标续跑）一律不开新会话（官方 “doesn't start sessions on turns it continues by itself”）。
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail, ok } from "./types.ts";
import type { JsonObjectSchema } from "../agent/turn.ts";
import { prefValue } from "../prefs.ts";
import {
  AUTO_MAX,
  autoStartCount,
  bridgeFamilyAvailable,
  familyLink,
  nobodyHere,
  noteAutoStart,
  projectChoices,
  readReport,
  relatedSessions,
  sendMessage,
  spawnChild,
  spawnLimit,
  type SpawnArgs,
  type SpawnResult,
} from "../session-family.ts";

const MIN_BACKGROUND = 80; // fresh 的 background 下限（官方同款）
const MAX_BRIEF = 32_000;
type Policy = "ask" | "direct" | "onRequest";
const policyNow = (): Policy => {
  const v = prefValue<string>("collab.newSessionPolicy");
  return v === "direct" || v === "onRequest" ? v : "ask";
};

// ── 说明 ─────────────────────────────────────────────────────────────────────
const HEAD = `Start a separate session for a piece of work while you stay with the user — a real session the user can open from the sidebar (nested under this one), talk to and stop.
When it ends a turn, none of your other sessions is still working and you are idle, you are continued with a <side-sessions-event> quoting the first 400 characters of its latest reply — so never poll or wait for it: tell the user it is handed off and end your turn (or carry on with other work).`;

// 函数而不是常量：本模块与 session-family.ts → session.ts → tools/registry.ts 成环，模块顶层不能碰那边导出的 AUTO_MAX
const initiationText = (policy: Policy): string => ({
  ask: `\`initiation\` says whose task it is:
- "user_asked": the user told you in words to run this separately / in parallel / in the background ("开个会话做…", "另开一个对话去…", "并行做这几件事") → it starts now.
- "offer": the user's latest message asks for a task that does not belong to what this session is doing → the user gets a card "New session / Do it here" and this call waits for the answer; give the full prompt + background so it can start right away. If they pick "here", do it here.
- "own_initiative": real follow-up work you noticed yourself that the user has not asked for (an out-of-scope fix, the next step your answer recommends) → the user gets a card "Start / Not now" with your tldr; nothing runs unless they start it. At most one per turn, never the same thing twice, never what you are about to do anyway.
A task the user's message tells you to do is never "own_initiative". Quick things (a question, a read, one edit, a few tool calls) stay here.`,
  direct: `The user's setting is "start directly": no cards — the user has already said yes to new sessions, so a task that belongs in its own session starts there at once instead of being done here. \`initiation\` says whose task it is:
- "user_asked": the user told you in words to run this separately / in parallel / in the background.
- "offer": the user's latest message asks for a task that does not belong to what this session is doing → do NOT do it here: start it now, tell the user in one sentence, and end the turn.
- "own_initiative": real follow-up work you noticed yourself that is worth its own session → it starts now too; one call per independent piece, never what you are about to do anyway.
At most ${AUTO_MAX} sessions start this way after each user message; beyond that the user is asked with a card. A task the user's message tells you to do is never "own_initiative". Quick things stay here.`,
  onRequest: `The user's setting allows a new session only when they ask for one: call this only when the user told you in words to run something separately / in parallel / in the background (\`initiation\` "user_asked"). Never propose sessions yourself — mention a follow-up in one sentence of your reply instead.`,
})[policy];

const tail = (bridge: boolean) => `- prompt: the brief — the task, the files or area, what "done" looks like (file paths and identifiers in backticks).
- context "fresh" (default): the new session sees only your prompt + background, so background is required (at least ${MIN_BACKGROUND} characters: overall goal, decisions so far, constraints, how this piece fits). "fork": it starts from a copy of this conversation (up to the user's latest message) + your prompt.
- project ("fresh" only): run it in another of the user's projects — its folder — instead of this session's folder. Name or id from ListSessions. It is still your child session: its report comes back the same way and SendMessage works.${bridge ? `
- agent: "dimensio" (default) or "claude" — "claude" opens it as a Claude session in bridge (Claude Code with its own tools and the user's Claude subscription; "fresh" only, project = one of the user's Claude projects). Use it when the user asks for Claude, or the piece needs something only Claude has. Reports, SendMessage and ReadSession work the same.` : ""}
- model: optionally a cheaper model id of the same provider for mechanical or read-only work.
- The session works in this same folder unless project says otherwise — say which files are its own if you keep editing here.
Later instructions go through SendMessage, never a new session for the same task.`;

function startSchema(policy: Policy, bridge: boolean): JsonObjectSchema {
  const props: Record<string, unknown> = {
    initiation: {
      type: "string",
      enum: policy === "onRequest" ? ["user_asked"] : ["user_asked", "offer", "own_initiative"],
      description: policy === "onRequest" ? 'Always "user_asked".' : 'Who wants this session: "user_asked", "offer" or "own_initiative" (see the tool description).',
    },
    title: { type: "string", description: "Under 60 characters; names the task. Shown in the sidebar and on the card." },
    prompt: { type: "string", description: "The brief: the task, the files or area, what done looks like." },
    background: { type: "string", description: `Required with context "fresh" (at least ${MIN_BACKGROUND} characters): overall goal, decisions and constraints so far — for someone who has not seen this conversation.` },
    context: { type: "string", enum: ["fresh", "fork"], description: '"fresh" (default) or "fork".' },
    project: { type: "string", description: '"fresh" only: another of the user\'s projects (name or id from ListSessions). Omit to stay in this folder.' },
    model: { type: "string", description: "Optional model id (same provider) for this session. Omit to inherit." },
    name: { type: "string", description: 'Optional short handle ([a-z0-9-], ≤24), e.g. "api-tests". Derived from the title when omitted.' },
  };
  if (policy !== "onRequest") props.tldr = { type: "string", description: '"own_initiative" only: one line shown on the card — why you suggest it now. No file paths or code.' };
  if (bridge) props.agent = { type: "string", enum: ["dimensio", "claude"], description: '"dimensio" (default) or "claude" — a Claude session in bridge.' };
  return { type: "object", properties: props, required: ["initiation", "title", "prompt"], additionalProperties: false } as JsonObjectSchema;
}

// ── 结果文本 ─────────────────────────────────────────────────────────────────
function startedText(r: Extract<SpawnResult, { ok: true }>): string {
  const where = r.agent === "claude"
    ? " It is a Claude session in bridge — the user finds it in the Claude page's sidebar; it cannot see this conversation or your uncommitted state, only your brief."
    : r.project
      ? ` It works in the project "${r.project.name}" (${r.project.path}) and cannot see your files; in the sidebar it is listed under that project.`
      : " It works in this same folder.";
  return `Started the session "${r.title}" (id: ${r.id}, name: ${r.name}); it is working in the background and the user can open it from the sidebar.${where} When it ends its turn you get a <side-sessions-event> automatically — do not poll or wait: tell the user in a sentence that it is handed off, then end your turn (or carry on with other work here). Further instructions: SendMessage(to: "${r.name}").`;
}

function briefError(a: SpawnArgs): string {
  if (!a.prompt) return "prompt is required: the complete brief for the new session (the task, the files or area, what done looks like).";
  if (a.context === "fork" && a.project) return 'project only works with context "fresh": a fork carries this conversation and stays in this folder. To start it in another project use "fresh" and put what it needs to know in background.';
  if (a.context === "fork" && a.agent === "claude") return 'agent "claude" only works with context "fresh": a Claude session cannot read this dimensio conversation. Use "fresh" and write what it needs into background.';
  if (a.context !== "fork" && (a.background ?? "").length < MIN_BACKGROUND)
    return `With context "fresh" the new session cannot see this conversation, so background needs at least ${MIN_BACKGROUND} characters: the overall goal, decisions and constraints so far, where this piece fits. Add it, or use context "fork".`;
  if (a.prompt.length + (a.background ?? "").length > MAX_BRIEF) return `The brief plus background is too long (> ${MAX_BRIEF} characters): trim it — the new session reads files itself.`;
  return "";
}

const linkEvent = (ctx: ToolContext, parent: string, r: Extract<SpawnResult, { ok: true }>) => ({
  e: "family_link" as const,
  parent,
  child: r.id,
  title: r.title,
  name: r.name,
  agent: r.agent,
  ...(ctx.callId ? { toolId: ctx.callId } : {}),
});

async function start(ctx: ToolContext, sid: string, a: SpawnArgs): Promise<ToolRunResult> {
  const r = await spawnChild(sid, a);
  if (!r.ok) return fail("session not started", `Could not start the session: ${r.reason}`);
  return {
    ok: true,
    summary: `started session: ${r.title}`,
    outcome: r.agent === "claude" ? `已开出 Claude 会话「${r.title}」` : `已开出子会话「${r.title}」`,
    content: [{ t: "text", text: startedText(r) }],
    meta: { family: { child: r.id, title: r.title, name: r.name, agent: r.agent } },
    events: [linkEvent(ctx, sid, r)],
  };
}

// 问用户（ask 档的 offer / own_initiative；direct 档超了自动名额也退到这里）。返回 true = 用户要开
async function askUser(ctx: ToolContext, a: SpawnArgs, initiation: string, tldr: string): Promise<{ go: boolean; why?: string }> {
  if (!ctx.askUser) return { go: false, why: "nobody" };
  const res = await ctx.askUser(
    [
      initiation === "offer"
        ? {
            header: "新会话",
            question: `为「${a.title}」新建会话，还是就在这里处理？`,
            multiSelect: false,
            options: [
              { label: "新会话", description: "另开一个会话去做，这里接着聊别的" },
              { label: "在这里做", description: "就在当前会话里做" },
            ],
          }
        : {
            header: "建议的任务",
            question: `建议另开一个会话做「${a.title}」${tldr ? `：${tldr}` : ""}`,
            multiSelect: false,
            options: [
              { label: "开始", description: "现在就另开一个会话去做" },
              { label: "先不用", description: "不开，这里接着做手头的事" },
            ],
          },
    ],
    ctx.callId,
  );
  if (res.away) return { go: false, why: "away" };
  if (res.timedOut) return { go: false, why: "timeout" };
  if (res.cancelled) return { go: false, why: "cancelled" };
  const pick = res.answers[0]?.selected?.[0] ?? "";
  return { go: pick === "新会话" || pick === "开始", why: pick };
}

function parseArgs(args: Record<string, unknown>): SpawnArgs & { initiation: string; tldr: string } {
  const s = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
  return {
    initiation: s(args.initiation, 20),
    title: s(args.title, 60),
    prompt: s(args.prompt, MAX_BRIEF + 1),
    background: s(args.background, MAX_BRIEF + 1),
    context: args.context === "fork" ? "fork" : "fresh",
    agent: args.agent === "claude" ? "claude" : "dimensio",
    ...(s(args.project, 300) ? { project: s(args.project, 300) } : {}),
    ...(s(args.model, 120) ? { model: s(args.model, 120) } : {}),
    ...(s(args.name, 24) ? { name: s(args.name, 24) } : {}),
    tldr: s(args.tldr, 300),
  };
}

const sessionIdOf = (ctx: ToolContext): string | null => ctx.ownerId ?? null;

export const startSessionTool: Tool = {
  effect: "write",
  concurrencySafe: false,
  get def() {
    const policy = policyNow();
    const bridge = bridgeFamilyAvailable();
    return { name: "StartSession", description: `${HEAD}\n${initiationText(policy)}\n${tail(bridge)}`, parameters: startSchema(policy, bridge) };
  },
  async run(args, ctx) {
    const sid = sessionIdOf(ctx);
    if (!sid) return fail("no session", "Only a main conversation can start sessions (sub-agents and workflow agents cannot).");
    const a = parseArgs(args);
    if (!a.title) return fail("title required", "title is required: a task name under 60 characters.");
    if (!["user_asked", "offer", "own_initiative"].includes(a.initiation)) {
      return fail("initiation required", 'initiation is required: "user_asked" (the user asked for a separate session), "offer" (a new, unrelated task in the user\'s latest message) or "own_initiative" (follow-up you suggest).');
    }
    if (a.agent === "claude" && !bridgeFamilyAvailable()) return fail("no Claude", 'agent "claude" needs dimensio to run inside bridge; this instance is standalone.');
    const e = briefError(a);
    if (e) return fail("brief incomplete", e);
    const policy = policyNow();
    if (nobodyHere(sid)) {
      return fail("not started", "Not started: this turn was not started by the user here (it is another session's message, a child's report or an automatic continuation), and such turns never start new sessions. Mention it to the user in your reply instead; they can ask for it.");
    }
    if (policy === "onRequest" && a.initiation !== "user_asked") {
      return a.initiation === "offer"
        ? ok("kept here", "No card: the user's setting keeps new tasks in this session unless they ask for a separate one. Do it here as usual.")
        : fail("not proposed", "The user's setting allows new sessions only when they ask for one: do not propose sessions. If the follow-up is worth doing, say so in one sentence of your reply.");
    }
    const lim = spawnLimit(sid);
    if (lim?.code === "children") return fail("limit reached", `Cannot start a new session: ${lim.reason}. Do it here, or tell the user in a sentence why not.`);
    if (a.initiation === "user_asked") return start(ctx, sid, a);
    // offer / own_initiative
    if (policy === "direct" && !lim && autoStartCount(sid) < AUTO_MAX) {
      noteAutoStart(sid);
      return start(ctx, sid, a);
    }
    const ans = await askUser(ctx, a, a.initiation, a.tldr);
    if (ans.go) return start(ctx, sid, a);
    const meta = { family: { declined: true, initiation: a.initiation, answer: ans.why ?? "" } };
    if (a.initiation === "offer") {
      if (ans.why === "在这里做") return { ...ok("kept here", 'The user chose "Do it here": do this task in this session now.'), meta };
      return { ...ok("not answered", `The user did not answer the card (${ans.why ?? "no answer"}). Do not start a session and do not start the task either: say in one sentence that it is waiting for their decision, then end your turn. If they later ask for it, call StartSession again with initiation "user_asked".`), meta };
    }
    return { ...ok("not started", `The user did not start it (${ans.why || "no answer"}). Carry on with your current work; do not propose it again.`), meta };
  },
};

export const sendMessageTool: Tool = {
  effect: "read",
  concurrencySafe: false,
  def: {
    name: "SendMessage",
    description: `Send a message to a related session — your parent, a session you started, or a sibling (dimensio or Claude). "to" = its id or name from ListSessions; "parent" = the session that started you.
If that session is working right now the message reaches it between its steps (like the user typing while it works); if it is idle it is woken up to handle it. Its reply comes back to you the same way (as a <session-message>), so do not poll.
A message is not the user speaking: never forward something as the user's approval unless you quote the user's own words. Do not send pure acknowledgements ("got it", "thanks").`,
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: 'Session id or name from ListSessions, or "parent".' },
        message: { type: "string", description: "What to say. Self-contained: the other session may not know what you are looking at." },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const sid = sessionIdOf(ctx);
    if (!sid) return fail("no session", "Only a main conversation can message other sessions.");
    const text = String(args.message ?? "").trim();
    if (!text) return fail("empty message", "message must not be empty.");
    const r = await sendMessage(sid, String(args.to ?? "").trim(), text);
    if (!r.ok) return fail("not delivered", `Not delivered: ${r.reason}`);
    const how = {
      inserted: "It is working right now; the message reaches it between its steps.",
      woke: "It was idle and has been woken up to handle the message.",
      queued: "It is wrapping up (or bridge is restarting); the message is in its inbox and arrives as soon as it can take it.",
      held: "It has run several automatic turns in a row (or its user holds messages from other sessions), so the message is kept until the user next talks in that session.",
    }[r.how];
    return { ok: true, summary: `message → ${String(args.to ?? "")}`, outcome: "已送达", content: [{ t: "text", text: `${how} Its reply comes back to you as a <session-message> — no need to poll.` }], meta: { family: { target: r.target } } };
  },
};

const STATE_TXT: Record<string, string> = { working: "working", idle: "idle" };

export const listSessionsTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: {
    name: "ListSessions",
    description:
      "List the sessions related to this one (parent, sessions you started, siblings — dimensio or Claude) with their id, name, title and whether they are working right now, plus the start of each one's latest reply, and the user's projects a new session can be started in (StartSession project). Use it — never a search — to find a session you started.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  async run(_args, ctx) {
    const sid = sessionIdOf(ctx);
    if (!sid) return fail("no session", "Only a main conversation has related sessions.");
    const f = await relatedSessions(sid, { reports: true });
    const line = (s: (typeof f.rows)[number]) =>
      `- [${s.relation}${s.agent === "claude" ? ", Claude" : ""}] ${s.title || "(untitled)"} — id: ${s.id}${s.name ? `, name: ${s.name}` : ""}, ${STATE_TXT[s.state] ?? s.state}${s.report ? `\n  latest reply starts: ${s.report.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
    const head = f.self ? `You are a child session (name: ${f.self.name}). ` : "";
    const body = f.rows.length ? `${head}Related sessions:\n${f.rows.map(line).join("\n")}` : `${head}No related sessions (no parent, and none started from here yet).`;
    const projs = await projectChoices();
    const ptail = projs.length > 1 ? `\nThe user's projects (StartSession project = name or id):\n${projs.map((p) => `- ${p.name} — id: ${p.id}, ${p.path}`).join("\n")}` : "";
    return { ok: true, summary: "related sessions", outcome: `${f.rows.length} 个相关会话`, content: [{ t: "text", text: body + ptail }] };
  },
};

export const readSessionTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: {
    name: "ReadSession",
    description: 'Read the latest reply (up to ~6000 characters) of a related session — to check a result before telling the user it is done. "to" = id or name from ListSessions, or "parent".',
    parameters: {
      type: "object",
      properties: { to: { type: "string", description: 'Session id or name from ListSessions, or "parent".' } },
      required: ["to"],
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const sid = sessionIdOf(ctx);
    if (!sid) return fail("no session", "Only a main conversation has related sessions.");
    const r = await readReport(sid, String(args.to ?? "").trim());
    if (!r.ok) return fail("not found", r.reason);
    const label = familyLink(r.target)?.title || r.target.slice(0, 8);
    return {
      ok: true,
      summary: `read session: ${label}`,
      outcome: r.text ? `${r.text.length} 字` : "还没有回复",
      content: [{ t: "text", text: r.text ? `Latest reply of session ${r.target}:\n\n${r.text}` : "That session has no reply yet (it may have just started)." }],
      meta: { family: { target: r.target } },
      // 别的会话写的东西（可能读过网页）：按外部内容算，Remember 先存成待确认
      externalContent: true,
    };
  },
};

export const SESSION_TOOLS: Tool[] = [startSessionTool, sendMessageTool, listSessionsTool, readSessionTool];
