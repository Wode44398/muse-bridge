// Q14（F6）：稳定错误码。接口出错时回 { error: 人话, code: 稳定的机器码 }——客户端按 code 分支（重试、提示、降级），
// 不按英文措辞猜；措辞可以随时改，code 只增不改（和 protocol.ts 的能力位同一条纪律）。
// 以前恢复会话失败一律 400 带原文、读不了文件一律当「没有这个会话」404——客户端分不清「该重试」还是「真没了」。
import type express from "express";

export const ERROR_CODES = {
  sessionNotFound: "session_not_found",
  sessionUnreadable: "session_unreadable", // 会话文件在，但这会儿读不了（被占用、权限、是个目录……）：稍后重试
  sessionReadOnly: "session_read_only", // 更新版本写的会话：只读，不能在这个版本里接着跑
  sessionRunning: "session_running",
  duplicateRun: "duplicate_run",
  rollingBack: "rolling_back",
  providerKeyMissing: "provider_key_missing",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class CodedError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, status = 500) {
    super(message);
    this.name = "CodedError";
    this.code = code;
    this.status = status;
  }
}

// 带码的错误按它自己的状态码回；别的错误照旧用调用方给的兜底状态码、只带原文
export function sendError(res: express.Response, error: unknown, fallbackStatus = 400): void {
  if (error instanceof CodedError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(fallbackStatus).json({ error: error instanceof Error ? error.message : String(error) });
}
