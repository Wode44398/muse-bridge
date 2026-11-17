// 用服务端会话记录重建时间线（历史会话、断线对账的底座）。
import { t } from "../i18n.ts";
import { resetStreamTurn } from "../stream-turn.ts";
import { mergeTimeline } from "../timeline-merge.ts";
import { insertAfter, permissionItemsFromMeta, planItemFromResult } from "../card-receipts.ts";
import * as tl from "../timeline-reducer.ts";
import { ciEventNotice } from "../pr-text.ts"; // 拉取请求自动修复那一轮首条的提示条
import { TASK_NOTIFICATION_KIND, taskNoticeText } from "../task-notice.ts"; // 后台任务通知那一轮首条的提示条
import { sessionRefsFrom } from "../session-refs.ts";
import type { AskItem, AskOption, AskQuestion, Item, PermissionItem, PlanItem, ToolItem } from "../timeline-types.ts";
import type { Chat } from "./chat.svelte.ts";
import { dropStream } from "./effects.ts";

const { extractText, agentRunFromMeta, workflowRunFromMeta } = tl;

// C3（#41）：用户侧消息从哪来由服务端标（Msg.origin / kind），这里只认它——不再按开头猜。以前用户自己写的
// 「[Reminder] 明早九点…」被渲染成系统提示条，压缩摘要、附件转交、插话前缀又被当成用户气泡。
//  · origin "harness"：注入（预算 / 提醒 / 续写提示……）→ 提示条（首行）；压缩摘要给一句人话；附件转交不显示
//  · origin "steer"：用户运行中插话 → 用户气泡，显示原话（displayText；旧记录剥掉给模型看的前缀）
//  · 没有 origin：用户本人 → 用户气泡，无论写的是什么
function harnessNotice(kind: string | undefined, text: string): string | null {
  // C5：技能正文紧跟在 Skill 工具那一行后面，界面上那一行已经说了「载入技能」，正文不再单独显示
  if (kind === "tool-attachments" || kind === "skill") return null;
  // E3：用户 /技能名（/包名）点的技能——正文不显示，界面上一行提示（与直播时 skill_loaded 那一行同一句话）
  if (kind === "slash-skill") {
    const m = /^\[Skill( package| again)?: ([^\]\n]+)\]/.exec(text);
    return m ? tl.skillLoadedText(m[2], m[1] === " package") : t("已载入技能");
  }
  if (kind === "compaction-summary") return t("更早的对话已压缩成摘要");
  // U9：从这里改写之后给模型的说明——界面上只说一句
  if (kind === "rewind") return t("对话退回到这里 · 工作区文件没有回退");
  // O7：目标续跑——第一轮的说明、之后每一轮的首条
  if (kind === "goal-start") {
    const m = /at most (\d+) rounds/.exec(text);
    return m ? t("开始目标 · 最多 {n} 轮：没达成就一轮轮接着做", { n: m[1] }) : t("开始目标：没达成就一轮轮接着做");
  }
  if (kind === "goal-continue") {
    const m = /^\[Goal\] Round (\d+)\/(\d+)/.exec(text);
    return m ? t("目标 · 第 {x}/{y} 轮", { x: m[1], y: m[2] }) : t("目标 · 接着做");
  }
  // U10：审阅面板里撤销了这个对话对几个文件的改动
  if (kind === "restore") {
    const m = /changes to (\d+) file/.exec(text);
    return m ? t("在审阅面板撤销了 {n} 个文件的改动", { n: m[1] }) : t("在审阅面板撤销了文件改动");
  }
  // C8：带摘要开新会话——新会话开头那条接续摘要
  if (kind === "handoff-summary") return t("接续自上一个会话（开头是它的摘要）");
  // M13：服务重启 / 进程死掉之后自动续跑
  if (kind === "resume") return t("服务重启后自动接着做");
  if (kind === "resume-stopped") return t("连着几次被重启切断，没有再自动续跑——说「继续」接着做");
  // 拉取请求自动修复：bridge 发来的 CI 失败 / 合并冲突 / 新评审意见（server/pr.ts）——一行提示
  if (kind === "ci-event") return ciEventNotice(text);
  // 定时任务（server/routine-runs.ts）：bridge 的定时任务到点自动发起的这一轮——指令是上面那条用户消息，这里一行提示
  if (kind === "routine") {
    const m = /^\[Scheduled task\] "([^"\n]*)"/.exec(text);
    return m && m[1] && m[1] !== "untitled" ? t("定时任务「{name}」到点自动运行 · 无人值守", { name: m[1] }) : t("定时任务到点自动运行 · 无人值守");
  }
  // 后台任务通知（server/job-notify.ts）：后台命令跑完 / 盯着的输出出现了——一行提示
  if (kind === TASK_NOTIFICATION_KIND) return taskNoticeText(text);
  return text.split("\n")[0] || null;
}
function steerText(msg: any, text: string): string {
  if (typeof msg.displayText === "string") return msg.displayText;
  const cut = text.indexOf("\n\n");
  return cut >= 0 ? text.slice(cut + 2) : text;
}

// 从 tool_call 参数重建问题。镜像服务端 parseQuestions 的规整（label 去重、
// 选项截 5、header 截 20），让历史重建卡与当时的 live 卡长一样。
function askQuestionsFromArgs(callId: string, raw: any): AskQuestion[] {
  return (Array.isArray(raw) ? raw : []).map((q: any, i: number) => {
    const seen = new Set<string>();
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o: any) => ({ label: String(o?.label ?? "").trim(), description: o?.description ? String(o.description) : undefined }))
      .filter((o: AskOption) => o.label && !seen.has(o.label) && (seen.add(o.label), true))
      .slice(0, 5);
    return {
      id: `${callId}:${i}`,
      header: String(q?.header ?? "").trim().slice(0, 20) || t("问题 {n}", { n: i + 1 }),
      question: String(q?.question ?? ""),
      multiSelect: Boolean(q?.multiSelect),
      options,
    };
  });
}

// 用户所选来自 tool_result 的结构化 meta.ask（服务端按题序写入），零解析。
// 无 meta（中断被 heal 的失败结果 / 预算跳过）→ 保持未选，卡片显示未作答。
function askSelectionsFromMeta(meta: any, questions: AskQuestion[]): Record<string, string[]> {
  const selected: Record<string, string[]> = {};
  const answers = Array.isArray(meta?.ask?.answers) ? meta.ask.answers : [];
  questions.forEach((q, i) => {
    const one = answers[i]?.selected;
    selected[q.id] = Array.isArray(one) ? one.map((s: unknown) => String(s)) : [];
  });
  return selected;
}

// 会话协作的 harness 片段（server/agent/injections.ts）：画成会话消息卡，不是提示条
const SESSION_KINDS = new Set(["session-brief", "session-message", "side-sessions-event"]);

function rebuildTimeline(messages: any[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, ToolItem>();
  const asks = new Map<string, AskItem>();
  for (const msg of messages) {
    const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
    if (msg.role === "user") {
      const texts = blocks.filter((b) => b.t === "text").map((b) => b.text);
      // tool_result 回填到对应工具卡 / 问答卡
      for (const b of blocks) {
        if (b.t === "tool_result") {
          const ask = asks.get(b.id);
          if (ask) {
            ask.answered = true;
            ask.selected = askSelectionsFromMeta(b.meta, ask.questions);
            continue;
          }
          const ref = tools.get(b.id);
          if (ref) {
            ref.status = b.ok ? "ok" : "fail";
            ref.output = extractText(b.content);
            ref.summary = ref.output.split("\n")[0]?.slice(0, 80) ?? "";
            if (typeof b.meta?.outcome === "string" && b.meta.outcome) ref.outcome = b.meta.outcome; // U8（K36）：落盘的结果行
            // Agent / Workflow 的结构化摘要（服务端 meta）→ 历史里也有卡片可展开
            if (b.meta?.subagent) ref.agent = agentRunFromMeta(b.meta.subagent);
            if (b.meta?.workflow) ref.workflow = workflowRunFromMeta(b.meta.workflow);
            if (b.meta?.family && typeof b.meta.family === "object") ref.family = b.meta.family; // 会话协作：工具行链到的会话
            // #103：这次调用弹过的权限卡、计划卡的回执——刷新、换台设备打开也看得见批的哪一档、谁在哪台设备上定的
            const cards: Item[] = permissionItemsFromMeta(b.meta);
            const plan = ref.name === "ExitPlanMode" ? planItemFromResult(b.id, ref.args, b) : null;
            if (plan) cards.push(plan);
            insertAfter<Item>(items, ref, cards);
          }
        }
      }
      const raw = texts.join("\n").trim();
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      if (msg.origin === "harness" && SESSION_KINDS.has(msg.kind)) {
        // 会话协作：会话信封画成卡片；上一条可见的是一轮的收尾（或这是第一条）= 这条开了新的一轮（会话间唤醒）
        const prev = items[items.length - 1];
        items.push({ kind: "session", text: raw, turn: !prev || (prev.kind === "text" && Boolean(prev.run)) || prev.kind === "notice" });
      } else if (msg.origin === "harness") {
        const notice = harnessNotice(msg.kind, raw);
        if (notice) items.push({ kind: "notice", text: notice });
      } else {
        const text = msg.origin === "steer" ? steerText(msg, raw) : typeof msg.displayText === "string" ? msg.displayText : raw;
        const recall = tl.recallRefsFrom(msg.recall); // N45：这一轮自动召回了哪些
        const refs = sessionRefsFrom(msg.refs); // 引用会话：这条消息引用了哪些对话
        if (text || attachments.length || refs.length) {
          items.push({ kind: "user", text, attachments, ...(recall.length ? { recall } : {}), ...(refs.length ? { refs } : {}) });
        }
      }
    } else if (msg.role === "assistant") {
      // U8（E3）：这一轮的用时盖在这一轮最后一条回答上——挂到它的最后一段正文
      const run = msg.run && typeof msg.run.durationMs === "number" ? { durationMs: msg.run.durationMs, waitedMs: Number(msg.run.waitedMs) || 0 } : undefined;
      const lastTextIdx = run ? blocks.map((b) => b.t === "text" && Boolean(b.text?.trim())).lastIndexOf(true) : -1;
      for (const [bi, b] of blocks.entries()) {
        if (b.t === "thinking" && b.text?.trim()) {
          items.push({ kind: "thinking", text: b.text, open: false, live: false });
        } else if (b.t === "text" && b.text?.trim()) {
          items.push({ kind: "text", text: b.text, live: false, artifacts: msg.artifacts ?? undefined, ...(bi === lastTextIdx && run ? { run } : {}) });
        } else if (b.t === "tool_call" && b.name === "AskUserQuestion") {
          // 问答卡（历史静态态：等下方 tool_result 回填所选，未答则保持空）
          const ask: AskItem = {
            kind: "ask", id: b.id,
            questions: askQuestionsFromArgs(b.id, b.args?.questions),
            answered: false, selected: {},
          };
          items.push(ask);
          asks.set(b.id, ask);
        } else if (b.t === "tool_call") {
          // 默认按中断态建卡：完成的调用随后一定有 tool_result 回填成 ok/fail；
          // 没有结果的（运行被掐断的快照）不能假装绿色完成。
          const tool: ToolItem = {
            kind: "tool", id: b.id, name: b.name, args: b.args ?? {},
            status: "fail", summary: "已中断：未拿到结果", output: "", open: false, // i18n-ignore：tasks.ts 按「已中断」前缀认「已停止」，显示处 tr()
          };
          items.push(tool);
          tools.set(b.id, tool);
        }
      }
    }
  }
  return items;
}

// 合并后重建 id→条目 索引。必须扫【合并后的 chat.timeline】拿代理元素：
// 指到 rebuildTimeline 产出的原始字面量上，后续 tool_end 改的就是个影子，
// 界面看不到任何更新（pushItem 那条同款坑）。
function reindexRefs(chat: Chat) {
  chat.toolRefs.clear();
  chat.askRefs.clear();
  chat.permRefs.clear();
  chat.planRefs.clear();
  chat.agentRefs.clear();
  chat.workflowRefs.clear();
  for (const it of chat.timeline) {
    if (it.kind === "tool") {
      const tool = it as ToolItem;
      chat.toolRefs.set(tool.id, tool);
      if (tool.agent) chat.agentRefs.set(tool.agent.id, tool.agent);
      if (tool.workflow) {
        chat.workflowRefs.set(tool.workflow.id, tool.workflow);
        for (const a of tool.workflow.agents) chat.agentRefs.set(a.id, a);
      }
    }
    else if (it.kind === "ask") chat.askRefs.set(it.id, it as AskItem);
    else if (it.kind === "permission") chat.permRefs.set(it.id, it as PermissionItem);
    else if (it.kind === "plan") chat.planRefs.set(it.id, it as PlanItem);
  }
}

// 用服务端会话记录重建一个 chat 的视图。upTo 给出 = 镜像 base（截到本轮开始前，
// 后续事件靠重放补齐）；不给 = 终态完整重建。
export function applyRecord(chat: Chat, rec: any, upTo?: number) {
  dropStream(chat); // 整轮由记录重建，在途缓冲作废（落地就重复了）
  chat.curText = null;
  chat.curThinking = null;
  const messages: any[] = rec.messages ?? [];
  mergeTimeline(
    chat.timeline,
    rebuildTimeline(upTo === undefined ? messages : messages.slice(0, upTo)),
  );
  reindexRefs(chat);
  chat.recFp = upTo === undefined ? (rec.fp ?? null) : null;
  // M2：附着到的是哪一轮。没在跑 / 旧后端不给就清掉——附着直播会带着它去核对，留着上一轮的 id 会一直 409 打转
  chat.runId = rec.running && typeof rec.runId === "string" ? rec.runId : null;
  resetStreamTurn(chat);
  chat.todos = rec.todos ?? [];
  chat.goal = rec.goal ?? null; // O7：目标续跑的状态
  chat.usage = {
    inTok: rec.totals?.inputTokens ?? 0,
    outTok: rec.totals?.outputTokens ?? 0,
  };
  chat.title = rec.title ?? chat.title;
  chat.cfg = rec.config ?? chat.cfg;
  chat.away = rec.config?.away === true; // P3
  chat.shape = rec.config?.shape === "project" ? "project" : ""; // 项目对话
  chat.readRoots = Array.isArray(rec.config?.readRoots) ? rec.config.readRoots.filter((d: unknown) => typeof d === "string") : []; // P13
}
