// 几组路由共用的小工具：SSE 心跳间隔、退役中的统一回复、按请求恢复会话。
import express from "express";
import { type Session, getOrLoadSession } from "../session.ts";
import { ERROR_CODES, sendError } from "../errors.ts";

// SSE 心跳间隔，与 bridge 的 src/runtime/sse.mjs HEARTBEAT_MS 一致（10s）。离线 apk 里内置的旧版 dimensio 前端
// 回前台阈值还是 12s 且挂着 window focus：15s 心跳下最近一次 ping 之后 12–15s 回前台，健康的直播流会被当半开掐掉、整轮重放；
// 10s 让老前端也有余量（新前端 22s / 40s 阈值不受影响），每条连接只是每 10s 多几个字节。
export const SSE_PING_MS = 10_000;

// M8：退役冻结期间不接新 run——客户端按「没送达」把这一条放回输入框（M2），稍后再发。
export const RETIRING_ERROR = { error: "服务正在重启（部署中），这一条没有发出；稍后再发", code: "retiring" };

// 会话级开关要先把会话从盘上恢复出来，而恢复可能抛错（持久化的厂商没配 key；M7：更新版本写的会话只读）——
// 统一回带原因的错误。以前这三个接口直接 await，抛错时请求一直挂着不回。
// Q14：带码的错误按自己的状态码与稳定码回（读不了 503、只读 409、缺 key 400），其余照旧 400。
export async function sessionForRequest(id: string, res: express.Response): Promise<Session | undefined> {
  try {
    const session = await getOrLoadSession(id);
    if (!session) res.status(404).json({ error: "unknown session", code: ERROR_CODES.sessionNotFound });
    return session;
  } catch (e) {
    sendError(res, e);
    return undefined;
  }
}

// Q14：读不了的会话如实回 503 + 稳定码（客户端稍后重试），不冒充「没有这个会话」
export function sendUnreadable(res: express.Response, loaded: { code: string }): void {
  res.status(503).json({ error: `会话文件这会儿读不了（${loaded.code}），稍后再试`, code: ERROR_CODES.sessionUnreadable });
}
