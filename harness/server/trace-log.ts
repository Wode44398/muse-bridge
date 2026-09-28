// Q12（F2）：运行事件落盘。以前事件只活在内存 runLog 里（一轮结束只留尾部 200 条），进程一重启，这一轮发生过什么就彻底
// 没了——没法事后还原「那一轮到底卡在哪、重试了几次、哪个请求慢」。
//
// 每个会话一个 <sessions>/traces/<会话 id>.jsonl，fanout（全部事件的单一出口）旁路写入，每行带 traceId / spanId：
//   · 只记结构性事件（开跑、轮次、工具起止、用量、压缩、卡片、报错、收尾……）与出站请求元数据，不记逐字 delta；
//   · 每个字段脱敏（redactOutput）并截断，对象序列化后同样处理——工具参数里的令牌、URL 查询串里的 key 都不落盘；
//   · 有界：单文件超过 TRACE_FILE_MAX 轮转成 .1.jsonl（只留一份旧的）；轮转失败就在 2 倍处停写；
//   · 诊断永不影响主链路：批量异步追加，出错全吞。删会话时一并删掉。
import fsp from "node:fs/promises";
import path from "node:path";
import { sessionsDir } from "./paths.ts";
import { redactOutput } from "./redact.ts";
import { currentTrace, type TraceContext } from "./trace.ts";

export const TRACE_FILE_MAX = 4 << 20;
const STRING_MAX = 300;
// 逐字流、参数进度、工具实时尾行：量大、重放用的 runLog 已经有，落盘不要
const SKIP = new Set(["text_delta", "thinking_delta", "tool_call_begin", "tool_progress"]);
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function traceDir(): string {
  return path.join(sessionsDir(), "traces");
}

export function traceFile(sessionId: string): string | null {
  return SESSION_ID_RE.test(sessionId) ? path.join(traceDir(), `${sessionId}.jsonl`) : null;
}
const rotated = (file: string) => file.replace(/\.jsonl$/, ".1.jsonl");

// 先截到 4 倍再脱敏（几 MB 的 base64 截图不进正则），最后截到 STRING_MAX——跨在预截断边界上的半截密钥反正在 300 之外
function clipString(value: string): string {
  const head = redactOutput(value.length > STRING_MAX * 4 ? value.slice(0, STRING_MAX * 4) : value);
  return head.length > STRING_MAX || value.length > STRING_MAX * 4
    ? `${head.slice(0, STRING_MAX)}…(+${value.length - STRING_MAX} chars)`
    : head;
}

function clipField(value: unknown): unknown {
  if (typeof value === "string") return clipString(value);
  if (value === null || typeof value !== "object") return value;
  try {
    return clipString(JSON.stringify(value));
  } catch {
    return "[unserializable]";
  }
}

const pending = new Map<string, string[]>();
const sizes = new Map<string, number>();
let chain: Promise<void> = Promise.resolve();
let scheduled = false;

export function traceEvent(sessionId: string, ev: Record<string, unknown>, ctx: TraceContext | undefined = currentTrace()): void {
  try {
    const kind = String(ev.e ?? "");
    if (SKIP.has(kind)) return;
    if (kind === "subagent_event" && SKIP.has(String((ev.event as { e?: unknown } | undefined)?.e ?? ""))) return;
    const file = traceFile(sessionId);
    if (!file) return;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ev)) if (key !== "e") fields[key] = clipField(value);
    const line = JSON.stringify({
      t: new Date().toISOString(),
      ...(ctx ? { trace: ctx.traceId, span: ctx.spanId, ...(ctx.runId ? { run: ctx.runId } : {}) } : {}),
      e: kind,
      ...fields,
    });
    const list = pending.get(file) ?? [];
    list.push(line);
    pending.set(file, list);
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => void flushTraceLog(), 50).unref();
    }
  } catch {
    /* 诊断永不影响主链路 */
  }
}

// 把排着的行写下去（测试、收尾用；平时 50ms 攒一批）
export function flushTraceLog(): Promise<void> {
  scheduled = false;
  const batch = [...pending.entries()];
  pending.clear();
  if (!batch.length) return chain;
  chain = chain.then(async () => {
    for (const [file, lines] of batch) {
      try {
        const data = `${lines.join("\n")}\n`;
        await fsp.mkdir(path.dirname(file), { recursive: true });
        let size = sizes.get(file) ?? (await fsp.stat(file).catch(() => null))?.size ?? 0;
        if (size + data.length > TRACE_FILE_MAX) {
          try {
            await fsp.rename(file, rotated(file));
            size = 0;
          } catch {
            if (size > TRACE_FILE_MAX * 2) continue; // 轮转不了（被别的程序开着）：到 2 倍就不再写
          }
        }
        await fsp.appendFile(file, data);
        sizes.set(file, size + Buffer.byteLength(data));
      } catch {
        /* 写失败全吞 */
      }
    }
  });
  return chain;
}

export async function deleteTraceLog(sessionId: string): Promise<void> {
  const file = traceFile(sessionId);
  if (!file) return;
  await flushTraceLog();
  sizes.delete(file);
  for (const f of [file, rotated(file)]) await fsp.rm(f, { force: true }).catch(() => {});
}
