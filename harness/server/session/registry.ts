// 会话层共享的可变状态：以前是 session.ts 的模块级变量，拆成多个模块后收进这一个对象，各模块经它读写同一份。
import type { UsageLedger } from "../usage-ledger.ts";
import type { Session } from "./types.ts";

export const registry = {
  sessions: new Map<string, Session>(),

  // In-flight hydrations, keyed by session id. getOrLoadSession awaits disk I/O
  // between the miss and the sessions.set, so two concurrent requests for the same
  // not-yet-resident session (phone + PC, or a resend after a dropped connection)
  // would each build their OWN Session object. The second set() then evicts the
  // first, and startRun's `session.running` guard — which lives ON the object —
  // passes on both: two agents run the same conversation and each persistNow()
  // clobbers the other's messages. Sharing one promise makes the whole
  // miss→build→register sequence atomic per id.
  loading: new Map<string, Promise<Session | undefined>>(),
  // Ids dropped while a hydration was in flight. Without this, a DELETE landing
  // between "read the record off disk" and "register it" resurrects the session in
  // memory, and the next persist writes the deleted file back out.
  droppedWhileLoading: new Set<string>(),
  // 回滚、删除按会话 id 排成的链（见 lifecycle.ts 的 lifecycle）；回滚期间全局静默的那个会话 id
  lifecycleChains: new Map<string, Promise<unknown>>(),
  rollingBack: null as string | null,
  // U9：正在「从这里改写」（以及立即压缩、撤销改写）的会话：这期间不落盘、不起新的一轮
  rewinding: new Set<string>(),
  // O8：用量账本按会话 id 存（会话对象会被逐出、读回、回滚后重建——已经花掉的用量不该跟着对话一起「退回去」）
  usageLedgers: new Map<string, UsageLedger>(),
};
