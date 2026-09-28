// Workflow 脚本的执行进程（主进程一侧见 workflow.ts 的 startWorkflowSandbox）。S2 根治（#35）：以前脚本跑在 worker
// 线程里的 vm 上下文中，经注入的宿主函数 `agent.constructor("return process")()` 就能逃出 vm，拿到整个进程——读写
// 任意文件、起子进程。现在它是一个独立子进程：Node 权限模型只许读本文件，读写别的文件、起子进程、起线程、加载原生
// 扩展一律拒；--disallow-code-generation-from-strings 让 .constructor 那条路在源头失败；环境变量里没有凭据。
// vm 上下文照旧：脚本只看得到注入的 API。每个 agent() 调用经 IPC 回主进程——子 agent、并发闸、token 预算、journal、
// 权限链都在那边。本文件只依赖 node:vm（权限模型下读不了别的模块）。
import vm from "node:vm";

interface RunData {
  body: string;
  filename: string;
  args: unknown;
  meta: unknown;
  budgetTotal: number | null;
}

type ToMain =
  | { t: "ready" }
  | { t: "agent"; seq: number; prompt: unknown; opts: unknown }
  | { t: "phase"; title: string }
  | { t: "log"; text: string }
  | { t: "done"; value: unknown }
  | { t: "fail"; message: string };

type FromMain = { t: "start"; data: RunData } | { t: "agent_result"; seq: number; ok: boolean; value?: unknown; error?: string; spent: number };

const send = (m: ToMain) => process.send?.(m);

// 主进程没了（崩溃、被收掉）IPC 就断：这里跟着退出，不留孤儿。
process.on("disconnect", () => process.exit(0));

let seq = 0;
let spent = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let started = false;

process.on("message", (m: FromMain) => {
  if (m.t === "start") {
    if (!started) {
      started = true;
      void run(m.data);
    }
    return;
  }
  if (m.t !== "agent_result") return;
  const p = pending.get(m.seq);
  if (!p) return;
  pending.delete(m.seq);
  spent = m.spent;
  if (m.ok) p.resolve(m.value);
  else p.reject(new Error(m.error ?? "agent failed"));
});
// 监听挂好了再要脚本：主进程收到 ready 才下发，消息不会在监听之前到达而丢掉
send({ t: "ready" });

const MAX_ITEMS = 4096;

// 跨进程的值走 JSON：函数、symbol 这类传不过去的，在脚本这一侧就报清楚。
function cloneable(v: unknown): unknown {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

const fmt = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isAbort = (e: unknown) => /workflow (aborted|deadline)/.test(fmt(e));

function safeString(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

async function run(data: RunData): Promise<void> {
  function agent(prompt: unknown, opts: unknown = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let safeOpts: unknown;
      try {
        safeOpts = cloneable(opts ?? {});
      } catch {
        reject(new Error("agent(): opts must be plain JSON data"));
        return;
      }
      const n = seq++;
      pending.set(n, { resolve, reject });
      send({ t: "agent", seq: n, prompt, opts: safeOpts });
    });
  }

  async function parallel(thunks: unknown): Promise<unknown[]> {
    if (!Array.isArray(thunks)) throw new Error("parallel(): expects an array of functions returning promises");
    if (thunks.length > MAX_ITEMS) throw new Error(`parallel(): at most ${MAX_ITEMS} items (got ${thunks.length})`);
    return Promise.all(
      thunks.map(async (t, i) => {
        try {
          return await (typeof t === "function" ? t() : t);
        } catch (e) {
          if (isAbort(e)) throw e;
          send({ t: "log", text: `parallel[${i}] failed: ${fmt(e)}` });
          return null;
        }
      }),
    );
  }

  async function pipeline(items: unknown, ...stages: unknown[]): Promise<unknown[]> {
    if (!Array.isArray(items)) throw new Error("pipeline(): first argument must be an array of items");
    if (items.length > MAX_ITEMS) throw new Error(`pipeline(): at most ${MAX_ITEMS} items (got ${items.length})`);
    if (!stages.length || !stages.every((s) => typeof s === "function")) {
      throw new Error("pipeline(): stages must be functions (prevResult, item, index) => …");
    }
    return Promise.all(
      items.map(async (item, i) => {
        let v: unknown = item;
        for (let s = 0; s < stages.length; s++) {
          try {
            v = await (stages[s] as (a: unknown, b: unknown, c: number) => unknown)(v, item, i);
          } catch (e) {
            if (isAbort(e)) throw e;
            send({ t: "log", text: `pipeline[${i}] failed at stage ${s + 1}: ${fmt(e)}` });
            return null;
          }
        }
        return v;
      }),
    );
  }

  function phase(title: unknown): void {
    send({ t: "phase", title: String(title ?? "").slice(0, 120) });
  }

  function log(...parts: unknown[]): void {
    const text = parts.map((p) => (typeof p === "string" ? p : safeString(p))).join(" ").slice(0, 2000);
    send({ t: "log", text });
  }

  const budget = {
    get total() {
      return data.budgetTotal;
    },
    spent: () => spent,
    remaining: () => (data.budgetTotal ? Math.max(0, data.budgetTotal - spent) : Infinity),
  };

  const sandbox = {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    args: data.args,
    meta: data.meta,
    budget,
    console: { log, info: log, warn: log, error: log },
  };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

  let value: unknown;
  try {
    // 包装与 workflow.ts 的 wrapWorkflowBody 逐字一致（提交前的编译检查照它算行号；这里不能 import，见那边的注释）
    const script = new vm.Script(`(async () => {\n${data.body}\n})()`, { filename: data.filename });
    // 超时只管得住同步开头；之后挂住的由主进程的截止时间收掉整个进程。
    value = await (script.runInContext(context, { timeout: 5_000 }) as Promise<unknown>);
  } catch (e) {
    send({ t: "fail", message: fmt(e) });
    return;
  }
  try {
    send({ t: "done", value: cloneable(value) });
  } catch (e) {
    send({ t: "fail", message: `workflow returned a value that is not plain JSON data: ${fmt(e)}` });
  }
}
