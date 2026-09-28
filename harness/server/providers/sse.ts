// Minimal server-sent-events reader over a fetch() Response body.
// Both Anthropic and OpenAI stream `text/event-stream`; this yields one
// parsed message per SSE event ({ event?, data }). Comments (`:`) are skipped.

import type { StreamEvent } from "../agent/events.ts";
import type { ProviderAdapter } from "./types.ts";

// R2（#2）：流空闲超时。以前 fetch 只挂了 run 的 abort：provider 连上之后不再发字节（代理半死、隧道卡住），
// 这一轮就无限挂住，只能人工点停止。首字节（发出请求 → 响应头）与字节间（相邻两块字节之间）分开计时，
// 默认都是 5 分钟：max effort 长思考期间 provider 仍在发 thinking 块或 ping 心跳，按字节算不会误杀。
// 超时 = 中止这次请求，报成可重试的 stream_idle 错误，走 loop 现有的重试。
export interface StreamLimits {
  firstByteMs: number;
  idleMs: number;
}
const envMs = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
export const streamLimits = (): StreamLimits => ({
  firstByteMs: envMs("DIMENSIO_STREAM_FIRST_BYTE_MS", 300_000),
  idleMs: envMs("DIMENSIO_STREAM_IDLE_MS", 300_000),
});

export class StreamStallError extends Error {
  phase: "first_byte" | "idle";
  constructor(phase: "first_byte" | "idle", ms: number) {
    super(
      phase === "first_byte"
        ? `no response from the provider within ${Math.round(ms / 1000)}s`
        : `the provider stream went silent for ${Math.round(ms / 1000)}s`,
    );
    this.name = "StreamStallError";
    this.phase = phase;
  }
}

// 守卫交给适配器的 signal → 这次请求的「收到字节」回调；readSSE 每读到一块就报一次。
const byteSinks = new WeakMap<AbortSignal, () => void>();
function sawBytes(signal?: AbortSignal): void {
  if (signal) byteSinks.get(signal)?.();
}

export function guardStream(adapter: ProviderAdapter, limits: StreamLimits = streamLimits()): ProviderAdapter {
  return {
    ...adapter,
    async *stream(turn, signal): AsyncIterable<StreamEvent> {
      const ctl = new AbortController();
      const started = Date.now();
      let lastByte = 0; // 0 = 还没收到任何字节
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        const [phase, ms, since] = lastByte
          ? (["idle", limits.idleMs, lastByte] as const)
          : (["first_byte", limits.firstByteMs, started] as const);
        const left = since + ms - Date.now();
        if (left <= 0) {
          ctl.abort(new StreamStallError(phase, ms));
          return;
        }
        timer = setTimeout(arm, left);
        timer.unref?.();
      };
      const onBytes = () => {
        const first = !lastByte;
        lastByte = Date.now();
        // 首字节之后改按字节间窗口计时；之后每块只记时间，不重排定时器。
        if (first) {
          clearTimeout(timer);
          arm();
        }
      };
      const onAbort = () => ctl.abort(signal?.reason);
      if (signal?.aborted) ctl.abort(signal.reason);
      else signal?.addEventListener("abort", onAbort, { once: true });
      byteSinks.set(ctl.signal, onBytes);
      arm();
      try {
        yield* adapter.stream(turn, ctl.signal);
      } catch (e) {
        const stall = ctl.signal.reason;
        if (!(stall instanceof StreamStallError) || signal?.aborted) throw e;
        yield { e: "error", kind: "stream_idle", retriable: true, raw: stall.message };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export interface SSEMessage {
  event?: string;
  data: string;
}

// Parse a Retry-After response header (seconds or HTTP-date) into milliseconds,
// clamped to a sane range. Undefined when absent/unparseable. Shared by all
// adapters so a 429's own pacing can ride the error event to the retry loop.
export function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  let ms: number;
  const secs = Number(raw);
  if (Number.isFinite(secs)) ms = secs * 1000;
  else {
    const when = Date.parse(raw);
    if (Number.isNaN(when)) return undefined;
    ms = when - Date.now();
  }
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(Math.max(ms, 1_000), 300_000); // R8：最多照办 5 分钟（以前 2 分钟）
}

// signal：适配器收到的那个（经 guardStream 时，它认得这次请求），每块字节都报给空闲计时。
export async function* readSSE(res: Response, signal?: AbortSignal): AsyncGenerator<SSEMessage> {
  if (!res.body) return;
  sawBytes(signal); // 响应头到了
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sawBytes(signal);
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, "\n");

      let boundary: number;
      while ((boundary = buf.indexOf("\n\n")) !== -1) {
        const rawEvent = buf.slice(0, boundary);
        buf = buf.slice(boundary + 2);

        let event: string | undefined;
        const dataLines: string[] = [];
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith(":")) continue; // comment / heartbeat
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (dataLines.length) yield { event, data: dataLines.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
