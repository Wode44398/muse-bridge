// Q12（F2 / G3）：trace 贯穿。一轮 run = 一个 traceId；这一轮里的每次模型调用、每次工具调用各是一个子 span。
// 以前全库没有任何关联 id：子 agent、重试、后台命令、出站请求之间对不上号，排障只能靠 console 和事后猜。
//
// 经 AsyncLocalStorage 传播：session.ts 把整轮 executeRun 放进 run 的上下文里（其中每个 await 都继承它）；loop.ts 给每次
// 模型调用、每个工具套子 span。用处：
//   · trace-log.ts 落盘的事件都带 traceId（按会话一个 JSONL）；
//   · net-proxy.ts 的全局 dispatcher 记下这一轮里每个出站请求的元数据，只给模型请求加关联头（WebFetch 访问的任意网站不带）。
// 注意：ALS 跟的是「调 next() 的人」——模型流是 async generator，要用 traceIterable 让它每一步都在模型 span 里跑。
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export type SpanKind = "run" | "model" | "tool";

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sessionId: string;
  runId?: string;
  kind: SpanKind;
  name?: string; // 模型调用 = provider id；工具 = 工具名
}

const als = new AsyncLocalStorage<TraceContext>();
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export function currentTrace(): TraceContext | undefined {
  return als.getStore();
}

export function startTrace(sessionId: string, runId?: string): TraceContext {
  return { traceId: hex(16), spanId: hex(8), sessionId, runId, kind: "run" };
}

// 当前上下文下开一个子 span（不在任何 trace 里就返回 undefined：测试、脚本、后台任务照常跑）
export function childSpan(kind: SpanKind, name?: string): TraceContext | undefined {
  const parent = als.getStore();
  return parent ? { ...parent, spanId: hex(8), parentSpanId: parent.spanId, kind, name } : undefined;
}

export function runInTrace<T>(ctx: TraceContext | undefined, fn: () => T): T {
  return ctx ? als.run(ctx, fn) : fn();
}

// 让一个异步迭代器的每一步都在 ctx 里执行（模型 adapter 的流在里面发 fetch，出站拦截器才认得出这是模型请求）
export function traceIterable<T>(source: AsyncIterable<T>, ctx: TraceContext | undefined): AsyncIterable<T> {
  if (!ctx) return source;
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const it = source[Symbol.asyncIterator]();
      return {
        next: (...args: [] | [unknown]) => als.run(ctx, () => it.next(...(args as []))),
        return: (value?: unknown) =>
          als.run(ctx, () => (it.return ? it.return(value as T) : Promise.resolve({ done: true as const, value: value as T }))),
        throw: (error?: unknown) => als.run(ctx, () => (it.throw ? it.throw(error) : Promise.reject(error))),
      };
    },
  };
}

// 模型请求带的关联头（中继 / 自建模型服务的日志能据此对上这一轮）
export const TRACE_HEADER = "x-dimensio-trace-id";
export const SPAN_HEADER = "x-dimensio-span-id";
