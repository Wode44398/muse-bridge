// 发送、插话、送达确认与收尾、停止；待送达托盘的撤回 / 立即中断。
import * as api from "../api.ts";
import { t, tr } from "../i18n.ts";
import { haptic } from "../touch.ts";
import { findSteerItem } from "../stream-turn.ts";
import * as tl from "../timeline-reducer.ts";
import type { AttachmentItem, SessionRefView } from "../timeline-types.ts";
import { attachKind } from "../attach-kind.ts";
import type { Chat, SessionMeta } from "./chat.svelte.ts";
import { app, flags, MAX_PARALLEL, paneVisible, rememberSession, RESYNC_TIMEOUT_MS, runningCount, toast } from "./core.svelte.ts";
import { flushStream, handleEvent, pushItem, settleCursors } from "./effects.ts";
import { replyToCard } from "./cards.ts";
import { startNativeWatch } from "./global-events.ts";
import { canRefSessions, refreshSessions } from "./lists.ts";
import { projectModeAvailable } from "./extras.ts";
import { forceResync, scheduleResync } from "./resync.ts";

// ── 发送 / 停止 / 新会话 ─────────────────────────────────────────────────────

// 运行中插话：先乐观上屏（用户立刻看到自己说了什么），再投给服务端。
// 服务端 409 = 那一轮刚好结束 → 回退成正常发送，消息不丢。
async function steerRunning(chat: Chat, msg: string) {
  if (!chat.id) {
    toast(t("这一轮还没建立会话，稍等一下再插话"));
    return;
  }
  // U2（#46）：插话的身份——乐观放进待送达托盘，服务端回来的 steer_queued / applied / returned 按它对号
  const steerId = newId("s");
  chat.pendingSteers.push({ id: steerId, text: msg });
  haptic("light");
  const dropBubble = () => {
    tl.takePendingSteer(chat, steerId, msg);
    const i = findSteerItem(chat.timeline, { id: steerId });
    if (i >= 0) chat.timeline.splice(i, 1);
  };
  try {
    await api.steer(chat.id, msg, chat.runId, steerId);
  } catch (e: any) {
    if (e?.status === 409 && e?.message === "run_mismatch") {
      // M2（#44）：本端以为还在跑的那一轮已经结束，此刻在跑的是另一台设备新起的一轮——这句纠偏不能
      // 带着「优先于此前的指示」注进别人的那一轮。撤掉气泡、放回输入框，接上正在跑的那一轮让人看清再说。
      dropBubble();
      if (chat === app.chat) app.refill = msg;
      toast(t("你插话的那一轮已经结束，现在在跑的是另一台设备发起的；话已放回输入框"));
      forceResync(chat);
      return;
    }
    if (e?.status === 409) {
      // 那一轮已经结束：把刚才乐观插入的气泡撤掉，按正常一轮重发。
      dropBubble();
      chat.running = false;
      await send(msg);
      return;
    }
    pushItem(chat, { kind: "error", text: t("插话没送达：{reason}", { reason: tr(String(e?.message ?? e)) }) });
  }
}
// M11（N33）：新会话用界面此刻显示的配置（顶栏的项目、输入框旁的型号 / 思考 / 档位 / 访问范围都读 app.config）。
// 服务端的全局值可能刚被另一台设备改了——手机切的项目、整机访问、auto 档以前会串进这台设备新建的对话。
function displayedConfig(): api.RunConfig | undefined {
  const c = app.config;
  if (!c) return undefined;
  const pick = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    provider: pick(c.provider),
    model: pick(c.model),
    thinking: pick(c.thinking),
    workspace: pick(c.workspace),
    access: pick(c.access),
    permissionMode: pick(c.permissionMode),
  };
}

// cardTarget（P10，N43）：这段话要回应的那张停着的卡（输入框算好的：草稿开始写时它已经停着）。
export async function send(raw: string, cardTarget?: string | null) {
  const chat = app.chat;
  const msg = raw.trim();
  if (!msg && !chat.attachments.length && !chat.refs.length) return;
  // 运行中发送 = 插话/转向（服务端在下一个回合边界注入），不再是「被禁用」。
  // 附件不走这条路：注入点是纯文本消息，带附件的请等这一轮结束。
  if (chat.running) {
    if (!msg) return;
    if (cardTarget) {
      const reply = await replyToCard(chat, cardTarget, msg);
      if (reply === "ok") return;
      if (reply === "failed") {
        // 没送达：话放回输入框，卡还停着，可以再发一次或直接点卡片
        if (chat === app.chat) app.refill = msg;
        toast(t("没送达，话已放回输入框"));
        return;
      }
      // 卡已经不在等了（别的设备先定了 / 失效了）：这段话改作插话，不丢
      toast(t("那张卡已经处理过了，这段话作为插话发出"));
    }
    await steerRunning(chat, msg);
    return;
  }
  if (runningCount() >= MAX_PARALLEL) {
    toast(t("最多同时运行 {n} 个对话，先等一个跑完", { n: MAX_PARALLEL }));
    return;
  }
  const paths = [...chat.attachments];
  const attachments: AttachmentItem[] = paths.map((path) => ({ path, kind: attachKind(path) }));
  // 引用会话：旧服务端不认 refs——芯片留在输入框里（不假装引用过）
  const refs = canRefSessions() ? chat.refs.slice() : [];
  const refKey = (list: SessionRefView[] | undefined) => (list ?? []).map((r) => r.id).join("\n");
  // M2（#51）：这一条的发送身份。上一条没送达、用户原样再发 → 沿用同一个 id（其实已落地的话服务端认得出）。
  const prior = chat.undelivered;
  const clientRunId =
    prior && prior.text === msg && prior.paths.join("\n") === paths.join("\n") && refKey(prior.refs) === refKey(refs)
      ? prior.clientRunId
      : newClientRunId();
  const draft = { clientRunId, text: msg, paths, ...(refs.length ? { refs } : {}) };
  // O7：输入框上「目标」开着——这一条开一个目标（发出去就收起；被拒收再还回去）
  const goalDraft = chat.goalDraft?.on && msg ? chat.goalDraft : null;
  const goal = goalDraft ? { maxRounds: goalDraft.maxRounds, ...(goalDraft.verify.trim() ? { verify: goalDraft.verify.trim() } : {}) } : undefined;
  if (goalDraft) chat.goalDraft = null;
  chat.undelivered = null;
  chat.attachments = [];
  if (refs.length) chat.refs = [];
  pushItem(chat, { kind: "user", text: msg, attachments, ...(refs.length ? { refs: refs.map(({ id, title }) => ({ id, title })) } : {}) });
  settleCursors(chat); // 上一轮若异常收尾，残留 live 旗子在此掐灭
  chat.running = true;
  flags.browserAutoMuted = false; // 新的一条消息：浏览器面板的自动展开恢复
  chat.activity = t("思考中");
  if (!chat.title) chat.title = msg.replace(/\s+/g, " ").slice(0, 60) || t("新任务");
  haptic("light");
  startNativeWatch();
  const gen = ++chat.liveGen;
  chat.resyncAttempt = 0;
  chat.abortCtl = new AbortController();
  let sawEnd = false; // 服务端确认本轮结束（closed）；没等到 = 断流，不是结束
  let delivered = false; // 收到 session 回执 = 这一轮已在服务端起来
  let rejected = ""; // 服务端明确拒收（非 2xx）：这一条没起一轮
  try {
    chat.lastByteAt = Date.now();
    await api.runStream(
      {
        sessionId: chat.id,
        message: msg,
        attachments: paths,
        clientRunId,
        ...(chat.id ? {} : { config: displayedConfig(), ...(chat.shape === "project" && projectModeAvailable() ? { shape: "project" as const } : {}) }),
        ...(goal ? { goal } : {}),
        ...(refs.length ? { refs: refs.map((r) => r.id) } : {}),
      },
      (ev) => {
        if (gen !== chat.liveGen) return;
        if (ev.e === "closed") {
          sawEnd = true;
          return;
        }
        if (ev.e === "session") delivered = true;
        if (ev.e === "error" && typeof ev.status === "number") {
          if (ev.status === 409 && ev.body?.error === "duplicate_run" && typeof ev.body.sessionId === "string") {
            // 同一条其实早已落地（上次只是回包没到）：接上那一轮，不重起
            delivered = true;
            chat.id = ev.body.sessionId;
            return;
          }
          rejected = String(ev.message ?? `HTTP ${ev.status}`);
          return;
        }
        handleEvent(chat, ev);
        if (ev.e === "session") showNewSessionRow(chat);
      },
      chat.abortCtl.signal,
      () => {
        if (gen === chat.liveGen) chat.lastByteAt = Date.now();
      },
    );
  } catch (e: any) {
    // 主动收线（stop / forceResync）都先 ++liveGen 再 abort，在此已被世代
    // 挡掉；能走到这的都是意外死亡的连接 —— 一律对账恢复，绝不当结束。
    if (gen !== chat.liveGen) return;
    if (!delivered) {
      // 回执没到：可能 POST 根本没落地（真·发送失败），也可能落地了、事件却没回来——先问服务端再定性。
      void confirmDelivery(chat, gen, draft, String(e?.message ?? e));
      return;
    }
    scheduleResync(chat, gen, 0); // 断流 ≠ 结束：对账后续播或收终态
    return;
  }
  if (gen !== chat.liveGen) return;
  if (rejected) {
    if (goalDraft) chat.goalDraft = goalDraft;
    undelivered(chat, gen, draft, rejected);
    // 常见的是 409「已经在跑」（另一台设备刚起了一轮）：接上它看清楚；草稿在输入框里不受影响
    if (chat.id) forceResync(chat);
    return;
  }
  if (sawEnd) {
    finishRun(chat, gen);
    return;
  }
  // 没等到 closed 就散场（中间层安静掐断）。回执没到 → 先问落地没有；到了 → 对账续上。
  if (!delivered) {
    void confirmDelivery(chat, gen, draft, "");
    return;
  }
  scheduleResync(chat, gen, 0);
}

// 新会话一拿到 id 就先在侧栏占一行（维护者 10-11：发了「你好」半天列表里没这个对话——以前只在这一轮收尾时刷新列表）。
// 服务端的列表随后刷新时以它为准。
function showNewSessionRow(chat: Chat) {
  if (!chat.id || app.sessions.some((s) => s.id === chat.id)) return;
  const cfg = chat.cfg ?? displayedConfig();
  app.sessions = [
    {
      id: chat.id,
      title: chat.title,
      updatedAt: Date.now(),
      messageCount: 1,
      provider: cfg?.provider ?? "",
      model: cfg?.model ?? "",
      workspace: cfg?.workspace ?? app.config?.workspace ?? "",
      running: true,
      waiting: null,
    },
    ...app.sessions,
  ];
  if (app.sessionsTotal >= 0) app.sessionsTotal += 1;
}

// M2 / U2：发送 / 插话的身份。非安全上下文（局域网 http 直连）没有 crypto.randomUUID，用 getRandomValues 拼。
function newId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
const newClientRunId = () => newId("c");

// M2（#51）：回执没到时问服务端「这一条落地了没有」。落地了 → 接上那一轮；确定没落地 → 撤掉气泡、
// 文字和附件放回输入框（不自动重发）；问不到（网络还没回来 / 旧后端没这个接口）→ 退回旧的认领 / 对账。
async function confirmDelivery(
  chat: Chat,
  gen: number,
  draft: { clientRunId: string; text: string; paths: string[]; refs?: SessionRefView[] },
  failMsg: string,
) {
  if (gen !== chat.liveGen) return;
  chat.reconnecting = true;
  chat.activity = t("确认是否送达");
  const hit = await api.lookupRun(draft.clientRunId, RESYNC_TIMEOUT_MS);
  if (gen !== chat.liveGen) return;
  if (hit?.known && hit.sessionId) {
    chat.id = hit.sessionId;
    if (chat === app.chat) rememberSession(hit.sessionId);
    scheduleResync(chat, gen, 0);
    return;
  }
  if (hit && !hit.known) {
    undelivered(chat, gen, draft, failMsg || t("网络中断"));
    return;
  }
  if (!chat.id) {
    void adoptOrphanRun(chat, gen, failMsg);
    return;
  }
  scheduleResync(chat, gen, 0);
}

function undelivered(
  chat: Chat,
  gen: number,
  draft: { clientRunId: string; text: string; paths: string[]; refs?: SessionRefView[] },
  reason: string,
) {
  if (gen !== chat.liveGen) return;
  const i = chat.timeline.findLastIndex((it: any) => it.kind === "user" && !it.steer && it.text === draft.text);
  if (i >= 0) chat.timeline.splice(i, 1);
  chat.undelivered = draft;
  if (draft.paths.length) chat.attachments = [...draft.paths];
  if (draft.refs?.length) chat.refs = [...draft.refs];
  if (chat === app.chat) app.refill = draft.text;
  else chat.pendingRefill = draft.text;
  const why = tr(reason);
  toast(
    chat === app.chat
      ? t("消息没送达（{reason}），已放回输入框，确认后再发", { reason: why })
      : chat.title
        ? t("「{title}」消息没送达（{reason}），已放回输入框，确认后再发", { title: tr(chat.title), reason: why })
        : t("「后台对话」消息没送达（{reason}），已放回输入框，确认后再发", { reason: why }),
  );
  chat.reconnecting = false;
  finishRun(chat, gen);
}

// 新会话首轮断流的收场：POST 可能已经落地、服务端那一轮正在后台跑（手机切网
// 最容易撞这个窗口），本地却连 sessionId 都还没拿到，没有东西可对账。探一次
// 会话列表认领：在跑 + 不在本地活跃池 + 标题对得上（服务端标题就是首句 60 字，
// 与本地同规则）；只有一个陌生的在跑会话时也认（纯附件轮的标题两边不同款）。
// 认到 = 接上直播续看；认不到才算真发送失败。
async function adoptOrphanRun(chat: Chat, gen: number, failMsg: string) {
  if (gen !== chat.liveGen) return;
  chat.reconnecting = true;
  chat.activity = t("重连中");
  let found: SessionMeta | undefined;
  try {
    const page = await api.listSessionsPage(0, 10, RESYNC_TIMEOUT_MS);
    if (gen !== chat.liveGen) return;
    const known = new Set(app.chats.map((c) => c.id).filter(Boolean) as string[]);
    const strangers = (page.items as SessionMeta[]).filter((s) => s.running && !known.has(s.id));
    found = strangers.find((s) => s.title === chat.title) ?? (strangers.length === 1 ? strangers[0] : undefined);
  } catch { /* 连不上 → 按发送失败收场，用户可重发 */ }
  if (gen !== chat.liveGen) return;
  if (found) {
    chat.id = found.id;
    if (chat === app.chat) rememberSession(found.id);
    scheduleResync(chat, gen, 0); // 走统一对账：重建 base + 附着直播
    return;
  }
  chat.reconnecting = false;
  if (failMsg) pushItem(chat, { kind: "error", text: failMsg });
  finishRun(chat, gen);
}

// 权威收尾：只有确认服务端本轮真的结束（closed / mirror_end / status 说没在跑）
// 才降 running。断流路径一律走 scheduleResync，绝不从这里出。
export function finishRun(chat: Chat, gen: number) {
  if (gen !== chat.liveGen) return;
  settleCursors(chat); // 断流没等到 done 也要掐灭 live 旗子
  const wasRunning = chat.running;
  if (wasRunning) chat.lastRunEndAt = Date.now();
  chat.running = false;
  chat.activity = "";
  chat.reconnecting = false;
  chat.abortCtl = null;
  chat.runId = null;
  // U2：这一轮收尾了，待送达托盘里还剩的（没等到 steer_returned 就断了流）放回输入框，不留残条
  if (chat.pendingSteers.length) {
    const left = chat.pendingSteers.map((p) => p.text);
    chat.pendingSteers = [];
    if (chat === app.chat) app.refill = left.join("\n");
  }
  // 后台会话跑完了 → 提醒（前台、分屏里的另一格自己看得见，不吵）
  if (wasRunning && !paneVisible(chat) && chat.id) {
    toast(chat.title ? t("「{title}」已完成", { title: tr(chat.title) }) : t("「后台对话」已完成"));
    haptic("light");
  }
  if (app.features.sessions) refreshSessions();
}

// 撕掉一个 chat 的本地连接与恢复循环（不碰服务端的 run）。
export function killLive(chat: Chat) {
  flushStream(chat); // 缓冲落地 + 停掉批量定时器（stop 时最后一批字不丢）
  chat.liveGen++;
  clearTimeout(chat.resyncTimer);
  chat.reconnecting = false;
  chat.abortCtl?.abort();
  chat.abortCtl = null;
}

export async function stop() {
  const chat = app.chat;
  const runId = chat.runId;
  killLive(chat);
  let mismatch = false;
  if (chat.id) {
    try {
      await api.stopRun(chat.id, runId);
    } catch (e: any) {
      mismatch = e?.status === 409 && e?.message === "run_mismatch";
    }
  }
  settleCursors(chat);
  chat.running = false;
  chat.activity = "";
  chat.runId = null;
  if (mismatch) {
    // M2（#44）：本端以为在跑的那一轮已经结束，此刻在跑的是另一台设备新起的一轮——没去停它。接上它，
    // 看清了还想停就再点一次（那时带的就是这一轮的 runId），不会停不下来。
    toast(t("你要停的那一轮已经结束；现在在跑的是另一台设备发起的，没有停它。要停请再点一次"));
    forceResync(chat);
  }
  if (app.features.sessions) refreshSessions();
}

// ── U2（X36 第二步、hermes N17a）：待送达托盘——撤回 / 立即中断并发送 ──────────────────────────────────────
export function steerTrayActions(): boolean {
  return Boolean(app.compat?.caps?.includes("steer-withdraw"));
}
// 撤回：还没送达就拿回来放进输入框（已经送达的撤不回来）
export async function withdrawPendingSteer(s: tl.PendingSteer): Promise<void> {
  const chat = app.chat;
  if (!chat.id) return;
  try {
    const r = await api.withdrawSteer(chat.id, s.id);
    if (!r.ok) {
      toast(r.reason === "delivered" ? t("这句已经送到了，撤不回来") : t("这一轮已经结束"));
      return;
    }
  } catch (e: any) {
    toast(t("没撤成：{reason}", { reason: tr(String(e?.message ?? e)) }));
    return;
  }
  tl.takePendingSteer(chat, s.id, s.text);
  if (chat === app.chat) app.refill = s.text;
}
// 立即中断并发送：服务端撤回这条、只停这一轮（后台 job 与 dev server 留着）、以这句开新一轮；回来就接上新的一轮
export async function interruptWithPendingSteer(s: tl.PendingSteer): Promise<void> {
  const chat = app.chat;
  if (!chat.id) return;
  let r: { ok: boolean; reason?: string };
  try {
    r = await api.interruptSteer(chat.id, s.id);
  } catch (e: any) {
    toast(t("没中断成：{reason}", { reason: tr(String(e?.message ?? e)) }));
    return;
  }
  if (!r.ok) {
    toast(
      r.reason === "delivered"
        ? t("这句已经送到了，不用再中断")
        : r.reason === "busy"
          ? t("这一轮还没停下来，话已放回输入框")
          : t("这一轮已经结束"),
    );
    return;
  }
  tl.takePendingSteer(chat, s.id, s.text);
  forceResync(chat);
}
