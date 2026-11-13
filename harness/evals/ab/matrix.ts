// 模型档案 P0：矩阵评测台。同一棵树，臂 = 型号 ×（可选）档案配置 / 环境变量覆盖；两树 A/B 照旧走 run.ts。不进 npm test。
//
//   node evals/ab/matrix.ts --models <provider/model[@档位]>,… --topic <主题> [--reps 1] [--suite all|hard|classic] [--tasks id,…]
//        [--variants-file <变体.json>] [--providers-dir <自定义服务目录副本>] [--env-file <.env>]
//        [--concurrency custom-xxxx=4,deepseek=3] [--local-switch manual|auto|none] [--harness <工作树>]
//        [--base-port 8861] [--max-minutes 480] [--work <账本目录>] [--report-only]
//
// - 型号写法：deepseek/deepseek-v4-flash、custom-024744f2/qwen3.8-flash-next-fp8、local/strata-orca@medium（@ 后是思考档位；不写就照
//   这一臂的型号目录查默认档、显式设上。设完核对 provider / 型号 / 档位，有一项不符就中止；每臂实际档位写进收据）。
// - 变体文件（可选）：[{ "name": "base" }, { "name": "tuned", "profileOverrides": { … }, "env": { "K": "V" } }]——每个型号 × 每个变体
//   是一臂（给了变体文件，臂名一律带 #变体名，哪怕只有一个变体——免得和不带变体的那次续跑账本撞键）；profileOverrides 原样序列化进这一臂进程的 DIMENSIO_PROFILE_OVERRIDES（评测侧只透传，怎么用归模型档案那条线）。
// - 每臂一个 harness 进程，全部落盘目录在这一臂的临时根（lib.ts startArm），访问范围一律「仅工作空间」。
// - 按端点分并发：内置云端每家默认 3，自定义服务默认 4（--concurrency 覆盖），local 恒为 1，而且同一时间只跑一个本机型号：
//   本机型号按型号分组串行，组间切引擎（默认 manual：打印步骤、等你切好；auto 要显式写：经这一臂的 /api/localai 停掉别的、
//   起这一台并等就绪——本机引擎是整机共用的，auto 会停掉正式服 8799 正在用的那台；none：不管，认定已经起好）。
// - 断点续跑沿用 meta.jsonl 账本（键 = 题|臂|第几次）：中断后原样重跑同一条命令，跳过已完成的；基础设施失败不入账。
// - 结果写成 evals/ab/results/<日期>-<主题>.md（决策收据，见 matrix-report.ts）。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { engineOfModel } from "../../server/localai.ts";
import { type Arm, api, appendMeta, ArmFatalError, assertArmConfig, InfraError, readMeta, type RunRow, runKey, runTask, startArm, wantedEffort } from "./lib.ts";
import { matrixReport } from "./matrix-report.ts";
import { type AbTask, taskById, tasksOfSuite } from "./tasks.ts";

export interface ModelSpec {
  provider: string;
  model: string;
  effort?: string;
  spec: string; // 原样写法，也是臂名的前缀
}

export interface Variant {
  name: string;
  profileOverrides?: unknown;
  env?: Record<string, string>;
}

export interface ArmPlan {
  name: string;
  model: ModelSpec;
  variant: Variant;
  endpoint: string; // 并发按它分组：local / 内置厂商 id / custom-xxxx
}

export function parseModelSpec(raw: string): ModelSpec {
  const spec = raw.trim();
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) throw new Error(`型号写法不对：${spec}（要 provider/model，例如 custom-024744f2/qwen3.8-flash-next-fp8）`);
  const provider = spec.slice(0, slash);
  let model = spec.slice(slash + 1);
  let effort: string | undefined;
  const at = model.lastIndexOf("@");
  if (at > 0) {
    effort = model.slice(at + 1);
    model = model.slice(0, at);
  }
  return { provider, model, ...(effort ? { effort } : {}), spec };
}

export function planArms(models: ModelSpec[], variants: Variant[]): ArmPlan[] {
  const vs = variants.length ? variants : [{ name: "default" }];
  return models.flatMap((m) =>
    vs.map((v) => ({ name: variants.length ? `${m.spec}#${v.name}` : m.spec, model: m, variant: v, endpoint: m.provider === "local" ? "local" : m.provider })),
  );
}

// 每个端点同时跑几个：local 恒为 1（一张卡），自定义服务默认 4，内置云端默认 3；--concurrency 覆盖（local 不认覆盖）
export function endpointLimit(endpoint: string, overrides: Record<string, number>): number {
  if (endpoint === "local") return 1;
  const o = overrides[endpoint];
  if (Number.isFinite(o) && o > 0) return Math.floor(o);
  return endpoint.startsWith("custom-") ? 4 : 3;
}

// 本机型号属于哪台引擎：直接用服务端的口径（server/localai.ts engineOfModel），Strata 拆成多个独立型号时只改那一处，
// 两边不会对不上。同一引擎的不同型号之间也要停了再起。
export const localEngineOf = (model: string): "qwen" | "strata" => engineOfModel(model);

export interface WorkItem {
  arm: ArmPlan;
  task: AbTask;
  rep: number;
}

// 待跑清单：按「第几次 → 题 → 臂」排（先把每题每臂跑一遍，早期中断也有横比的数）；已完成的跳过
export function workItems(arms: ArmPlan[], tasks: AbTask[], reps: number, done: Set<string>): WorkItem[] {
  const out: WorkItem[] = [];
  for (let rep = 1; rep <= reps; rep++) for (const task of tasks) for (const arm of arms) if (!done.has(runKey({ task: task.id, arm: arm.name, rep }))) out.push({ arm, task, rep });
  return out;
}

// 本机的活按型号分组（组内保持原顺序），组的先后按型号第一次出现的顺序
export function localGroups(items: WorkItem[]): { model: string; items: WorkItem[] }[] {
  const groups = new Map<string, WorkItem[]>();
  for (const it of items) if (it.arm.endpoint === "local") (groups.get(it.arm.model.model) ?? groups.set(it.arm.model.model, []).get(it.arm.model.model)!).push(it);
  return [...groups].map(([model, xs]) => ({ model, items: xs }));
}

async function freePort(from: number, taken: Set<number>): Promise<number> {
  for (let p = from; p < from + 200; p++) {
    if (taken.has(p)) continue;
    // 两个地址都要试：别的程序绑在 0.0.0.0 时，Windows 仍允许再绑 127.0.0.1，探活却会打到那个程序上
    const tryListen = (host: string) =>
      new Promise<boolean>((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.listen(p, host, () => probe.close(() => resolve(true)));
      });
    const ok = (await tryListen("0.0.0.0")) && (await tryListen("127.0.0.1"));
    if (ok) {
      taken.add(p);
      return p;
    }
  }
  throw new Error(`${from} 起 200 个端口都被占了`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LocalStatus {
  installed?: boolean;
  missing?: string[];
  ready?: boolean;
  state?: string;
}

async function localStatus(arm: Arm, engine: string): Promise<LocalStatus> {
  return (await (await api(arm, "GET", `/api/localai/status?engine=${engine}`)).json()) as LocalStatus;
}

async function waitLocalReady(arm: Arm, engine: string, minutes: number): Promise<void> {
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    const st = await localStatus(arm, engine);
    if (st.installed === false) throw new Error(`本机引擎 ${engine} 没装（启动脚本不在）`);
    if (st.missing?.length) throw new Error(`本机引擎 ${engine} 缺文件：${st.missing.length} 个`);
    if (st.ready) return;
    await sleep(3000);
  }
  throw new Error(`本机引擎 ${engine} 等了 ${minutes} 分钟还没就绪`);
}

// 切到这个本机型号：auto 经 harness 的 /api/localai 停掉另一台、本引擎停了再起（状态接口不报在跑的是哪个型号，
// 换型号或第一组都没法确认，一律重起），等就绪；manual 打印步骤后等就绪
async function switchLocal(arm: Arm, model: string, previous: string | null, mode: string): Promise<void> {
  if (mode === "none") return;
  const engine = localEngineOf(model);
  if (mode === "manual") {
    console.log(`\n== 请手动切本机引擎：dimensio「本机」面板 → 停掉另一台 → 起 ${engine}（型号 ${model}），就绪后这里自动接着跑（最多等 30 分钟）`);
    await waitLocalReady(arm, engine, 30);
    return;
  }
  for (const other of ["qwen", "strata"].filter((e) => e !== engine)) await api(arm, "POST", `/api/localai/stop?engine=${other}`);
  const st = await localStatus(arm, engine);
  if (previous !== model && st.state !== "off") await api(arm, "POST", `/api/localai/stop?engine=${engine}`);
  // model 参数给「Strata 拆成独立型号」之后的接口用；现在的接口按引擎起，忽略它
  await api(arm, "POST", `/api/localai/start?engine=${engine}&model=${encodeURIComponent(model)}`);
  console.log(`  本机：已请求起 ${engine}（${model}），等就绪……`);
  await waitLocalReady(arm, engine, 15);
}

function gitHead(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "?";
  }
}

export const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80);

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name: string, fallback?: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
  };
  const flag = (name: string) => argv.includes(`--${name}`);
  const topic = opt("topic");
  const modelsArg = opt("models");
  if (!topic || !modelsArg) {
    console.error("用法：node evals/ab/matrix.ts --models <provider/model[@档位]>,… --topic <主题> [--reps 1] [--suite all|hard|classic] [--tasks id,…] [--variants-file f.json] [--providers-dir 目录] [--concurrency ep=n,…] [--local-switch auto|manual|none]");
    process.exit(2);
  }
  const models = modelsArg.split(",").filter(Boolean).map(parseModelSpec);
  const variantsFile = opt("variants-file");
  const variants: Variant[] = variantsFile ? (JSON.parse(fs.readFileSync(variantsFile, "utf8")) as Variant[]) : [];
  const arms = planArms(models, variants);
  const reps = Number(opt("reps", "1"));
  const picked = opt("tasks");
  const tasks: AbTask[] = picked ? picked.split(",").map((id) => taskById(id.trim()) ?? (() => { throw new Error(`没有这道题：${id}`); })()) : tasksOfSuite(opt("suite", "all")!);
  if (tasks.some((t) => t.needsSkills)) throw new Error("skill-* 题要技能夹具，走 run.ts --ext-file");
  const concurrency = Object.fromEntries((opt("concurrency") ?? "").split(",").filter(Boolean).map((kv) => [kv.split("=")[0].trim(), Number(kv.split("=")[1])]));
  const localSwitch = opt("local-switch", "manual")!;
  if (!["manual", "auto", "none"].includes(localSwitch)) throw new Error(`--local-switch 只认 manual / auto / none：${localSwitch}`);
  const harnessDir = path.resolve(opt("harness", path.resolve(import.meta.dirname, "..", ".."))!);
  const harness = fs.existsSync(path.join(harnessDir, "harness", "server", "index.ts")) ? path.join(harnessDir, "harness") : harnessDir;
  const work = path.resolve(opt("work", path.join(os.tmpdir(), `dimensio-matrix-${safeName(topic)}`))!);
  const metaFile = path.join(work, "meta.jsonl");
  const date = new Date().toISOString().slice(0, 10);
  const resultFile = path.join(import.meta.dirname, "results", `${date}-${safeName(topic)}.md`);
  const providersDir = opt("providers-dir");
  const maxMinutes = Number(opt("max-minutes", "480"));
  const softStopAt = Date.now() + maxMinutes * 60_000;

  const done = new Set(readMeta(metaFile).map(runKey));
  const items = flag("report-only") ? [] : workItems(arms, tasks, reps, done);
  const endpoints = [...new Set(arms.map((a) => a.endpoint))];
  console.log(
    `矩阵：${arms.length} 臂 × ${tasks.length} 题 × ${reps} 次；待跑 ${items.length}（已完成 ${done.size}）；并发 ${endpoints.map((e) => `${e}=${endpointLimit(e, concurrency)}`).join(" ")}；账本 ${work}`,
  );

  const live = new Map<string, Arm>();
  const efforts = new Map<string, { thinking: string; byDefault: boolean }>(); // 臂 → 核对过的实际档位（逐 run 带上、写进收据）
  const hardStop = setTimeout(async () => {
    console.error(`超过 --max-minutes ${maxMinutes} 又 20 分钟还没收场：硬收全部臂、退出（原样重跑可续）`);
    for (const arm of live.values()) await arm.stop();
    process.exit(3);
  }, (maxMinutes + 20) * 60_000);
  hardStop.unref();

  try {
    if (items.length) {
      // 起臂：只起这一批要用到的。全局配置（provider / 型号 / 档位 / 权限规则）起臂后设一次，之后逐会话只带工作区快照。
      // 权限规则只并了各题的 deny：题目的 allow / ask 是全局的，并进来会影响同一臂并发的别的题；目前也没有题用到。
      const ports = new Set<number>();
      const rules = { allow: [] as string[], ask: [] as string[], deny: [...new Set(tasks.flatMap((t) => t.permissionRules?.deny ?? []))] };
      for (const plan of arms.filter((a) => items.some((it) => it.arm === a))) {
        const extraEnv: Record<string, string> = { ...(plan.variant.env ?? {}) };
        if (providersDir) extraEnv.DIMENSIO_CUSTOM_PROVIDERS_DIR = path.resolve(providersDir);
        if (plan.variant.profileOverrides !== undefined) extraEnv.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify(plan.variant.profileOverrides);
        const arm = await startArm({ name: plan.name, harnessDir: harness, port: await freePort(Number(opt("base-port", "8861")), ports), root: path.join(work, "arms", safeName(plan.name)), envFile: opt("env-file"), extraEnv });
        live.set(plan.name, arm);
        const thinking = await wantedEffort(arm, plan.model.provider, plan.model.model, plan.model.effort);
        const cfg = (await (
          await api(arm, "POST", "/api/config", {
            provider: plan.model.provider,
            model: plan.model.model,
            thinking,
            access: "workspace",
            permissionMode: "auto",
            permissionRules: rules,
          })
        ).json()) as { provider?: string; model?: string; thinking?: string; hasKey?: boolean };
        if (plan.model.provider !== "local" && cfg.hasKey === false) throw new Error(`${plan.name}：这一家没有 key（内置厂商给 --env-file；自定义服务给 --providers-dir 指向正式服目录的副本）`);
        assertArmConfig(plan.name, { provider: plan.model.provider, model: plan.model.model, thinking }, cfg);
        efforts.set(plan.name, { thinking, byDefault: !plan.model.effort });
        console.log(`  起臂 ${plan.name} :${arm.port}（实际 ${cfg.provider}/${cfg.model}，档位 ${cfg.thinking}${plan.model.effort ? "" : "，默认档"}）`);
      }

      let finished = 0;
      let localInfraStreak = 0; // 本机连着几次基础设施失败（引擎崩了 / 挂住了还回空包）
      const deadArms = new Map<string, string>(); // key 无效 / 欠费 / 没 key 的臂：剩下的题全跳过
      const runOne = async (it: WorkItem) => {
        if (Date.now() > softStopAt) return false;
        if (deadArms.has(it.arm.name)) return true;
        const arm = live.get(it.arm.name)!;
        const runDir = path.join(work, "runs", `${it.task.id}-${safeName(it.arm.name)}-${it.rep}`);
        fs.rmSync(runDir, { recursive: true, force: true });
        const provider = { provider: it.arm.model.provider, model: it.arm.model.model, thinking: efforts.get(it.arm.name)!.thinking };
        try {
          const row = await runTask(arm, it.task, { runDir, provider, rep: it.rep, concurrent: true });
          appendMeta(metaFile, row);
          finished++;
          console.log(`  ${row.pass ? "✓" : "✗"} [${finished}/${items.length}] ${it.task.id} · ${it.arm.name} · 第 ${it.rep} 次  ${row.detail}（${Math.round(row.wallMs / 1000)}s，${Math.round(row.tokens / 1000)}k）`);
        } catch (e) {
          if (!(e instanceof InfraError)) throw e;
          if (e instanceof ArmFatalError) {
            if (!deadArms.has(it.arm.name)) console.error(`  ✖ ${it.arm.name} 停掉：provider 拒绝服务（key 无效 / 欠费 / 没 key），剩下的题不跑——${e.message}`);
            deadArms.set(it.arm.name, e.message);
            return true;
          }
          console.error(`  ! ${it.task.id} · ${it.arm.name} · 第 ${it.rep} 次：基础设施失败，不入账——${e.message}`);
          if (it.arm.endpoint === "local") localInfraStreak++;
        }
        return true;
      };

      const workers: Promise<void>[] = [];
      for (const ep of endpoints.filter((e) => e !== "local")) {
        const queue = items.filter((it) => it.arm.endpoint === ep);
        // 同一臂的 $WORKSPACE_TMP 草稿目录是共用的（变量是进程级），同一道题的几次重复同时跑会往里写同名文件互相覆盖：
        // 取题时跳过「这一臂上这道题正在跑」的，都在跑就先拿队首（不让 worker 闲着）
        const inFlight = new Map<string, number>();
        const take = () => {
          const i = queue.findIndex((it) => !inFlight.get(`${it.arm.name}|${it.task.id}`));
          return i < 0 ? queue.shift() : queue.splice(i, 1)[0];
        };
        for (let w = 0; w < Math.min(endpointLimit(ep, concurrency), queue.length); w++) {
          workers.push(
            (async () => {
              for (let it = take(); it; it = take()) {
                const key = `${it.arm.name}|${it.task.id}`;
                inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
                try {
                  if (!(await runOne(it))) return;
                } finally {
                  inFlight.set(key, inFlight.get(key)! - 1);
                }
              }
            })(),
          );
        }
      }
      // 本机：按型号分组串行，组间切引擎
      workers.push(
        (async () => {
          let previous: string | null = null;
          for (const group of localGroups(items)) {
            if (Date.now() > softStopAt) return;
            await switchLocal(live.get(group.items[0].arm.name)!, group.model, previous, localSwitch);
            previous = group.model;
            for (const it of group.items) {
              // 引擎中途崩掉或挂住（11-07 基线：llama-server 第 13 题起每次 2 秒回空包，后面 77 次全废）：
              // auto 模式下每题前看一眼状态，连着两次基础设施失败也当它坏了，停了重起
              if (localSwitch === "auto") {
                const arm = live.get(it.arm.name)!;
                const engine = localEngineOf(group.model);
                const st = await localStatus(arm, engine).catch(() => ({ state: "unknown" }) as { state: string });
                if (st.state !== "on" || localInfraStreak >= 2) {
                  console.log(`  本机：${engine} 状态 ${st.state}、连续失败 ${localInfraStreak} 次，重起（${group.model}）`);
                  await api(arm, "POST", `/api/localai/stop?engine=${engine}`).catch(() => {});
                  await api(arm, "POST", `/api/localai/start?engine=${engine}&model=${encodeURIComponent(group.model)}`);
                  await waitLocalReady(arm, engine, 15);
                  localInfraStreak = 0;
                }
              }
              const before = localInfraStreak;
              if (!(await runOne(it))) return;
              if (localInfraStreak === before) localInfraStreak = 0;
            }
          }
        })(),
      );
      await Promise.all(workers);
      if (Date.now() > softStopAt) console.log(`到了 --max-minutes ${maxMinutes}，停在这里；原样重跑会接着跑`);
    }
  } finally {
    for (const arm of live.values()) await arm.stop();
  }

  const names = arms.map((a) => a.name);
  const rows: RunRow[] = readMeta(metaFile).filter((r) => names.includes(r.arm) && tasks.some((t) => t.id === r.task));
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  // 每臂实际档位：这次起过臂的用起臂时核对过的值，--report-only / 续跑没起臂的从账本里取（老账本没记就写「未记录」）
  const effortOf = (n: string) => {
    const e = efforts.get(n);
    return e ? `${e.thinking}${e.byDefault ? "（默认档）" : ""}` : [...new Set(rows.filter((r) => r.arm === n).map((r) => r.effort ?? "未记录"))].join("/") || "—";
  };
  const note =
    `代码：${harness}（${gitHead(harness)}）；每格 ${reps} 次；并发 ${endpoints.map((e) => `${e}=${endpointLimit(e, concurrency)}`).join(" ")}；访问范围仅工作空间。\n` +
    `档位：${names.map((n) => `${n} = ${effortOf(n)}`).join("；")}\n` +
    (variants.length ? `变体：${variants.map((v) => `${v.name}${v.profileOverrides !== undefined ? "（带档案覆盖）" : ""}`).join("、")}\n` : "") +
    "n 小时只看方向；区间是 Wilson 95%。没通过的 run 逐条审过再下结论（模型失败 vs 题目 / 判分 bug）。";
  fs.writeFileSync(resultFile, matrixReport(rows, { title: `矩阵 · ${topic}（${date}）`, arms: names, note }));
  console.log(`决策收据：${resultFile}`);
}

if (import.meta.main) {
  // 跑几小时的批次中途悄无声息退出过（退出码 1、日志无栈）：把退出原因与时间落进日志，下次能查
  process.on("exit", (code) => console.error(`[matrix] 进程退出 code=${code} ${new Date().toISOString()}`));
  process.on("uncaughtException", (e) => {
    console.error(`[matrix] 未捕获异常：${e?.stack ?? e}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => console.error(`[matrix] 未处理的 rejection：${(e as Error)?.stack ?? e}`));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    try {
      process.on(sig, () => {
        console.error(`[matrix] 收到 ${sig}，退出`);
        process.exit(130);
      });
    } catch {}
  }
  await main();
}
