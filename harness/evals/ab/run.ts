// Q6（N46）：本机 A/B 评测台。不进 npm test——一批 6 任务 × 2 臂 × 3 次要跑一两个小时，适合夜里后台跑。
//
//   node evals/ab/run.ts --base <工作树A> --head <工作树B> --topic <主题> [--reps 3] [--model local/qwen3.8-27b]
//                         [--tasks id1,id2] [--env-file <某臂读 key 的 .env>] [--ports 8851,8852] [--effort medium] [--max-minutes 240]
//                         [--ext-file <技能夹具的 registry.json>]（C5：两臂都用这份技能目录；skill-* 任务必须给）
//
// 两棵工作树 = 同一个仓库的两个 git worktree（改动前 / 改动后），各自用自己的 harness。两臂轮流跑、不并行（单 GPU），
// 每次重复交换先后。跑完一次就追加进 meta.jsonl，中断后同一条命令重跑会跳过已完成的；harness 起不来、接口报错这类
// 基础设施失败不入账。结果写成 evals/ab/results/<日期>-<主题>.md——这就是「决策收据」，在对应改动的提交说明里引用。
// 纪律：n=3 只看方向；低于 100% 的格子必须逐 run 审（报表里附了判分细节与末尾输出）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Arm, appendMeta, InfraError, readMeta, report, runKey, runTask, startArm } from "./lib.ts";
import { type AbTask, TASKS, taskById } from "./tasks.ts";

const argv = process.argv.slice(2);
const opt = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const base = opt("base");
const head = opt("head");
const topic = opt("topic");
if (!base || !head || !topic) {
  console.error("用法：node evals/ab/run.ts --base <工作树A> --head <工作树B> --topic <主题> [--reps 3] [--model local/qwen3.8-27b] [--tasks id,...]");
  process.exit(2);
}
const reps = Number(opt("reps", "3"));
const [providerId, ...modelParts] = opt("model", "local/qwen3.8-27b")!.split("/");
const effort = opt("effort"); // 不给就用这家型号的默认档（本机 Qwen 是 max = xhigh）
const provider = { provider: providerId, model: modelParts.join("/"), ...(effort ? { thinking: effort } : {}) };
const picked = opt("tasks");
const tasks: AbTask[] = picked ? picked.split(",").flatMap((id) => taskById(id.trim()) ?? []) : TASKS;
// C5：技能任务要两臂都看到同一份技能目录（夹具由 evals/ab/skills-fixture.ts 照真注册表搭，脚本是桩）
const extFile = opt("ext-file");
if (tasks.some((t) => t.needsSkills) && !extFile) {
  console.error("skill-* 任务要配 --ext-file <技能夹具的 registry.json>（用 evals/ab/skills-fixture.ts 搭）");
  process.exit(2);
}
const extraEnv: Record<string, string> = extFile ? { BRIDGE_EXTENSIONS_FILE: path.resolve(extFile) } : {};
const [portA, portB] = opt("ports", "8851,8852")!.split(",").map(Number);
const date = new Date().toISOString().slice(0, 10);
const work = path.join(os.tmpdir(), `dimensio-ab-${date}-${topic.replace(/[^\w.-]+/g, "_")}`);
const metaFile = path.join(work, "meta.jsonl");
const resultFile = path.join(import.meta.dirname, "results", `${date}-${topic}.md`);

// 总时长上限：到点不再开新的 run（停在两次之间，原样重跑可续）；再过 20 分钟还没收场就硬收两臂、退出。
const maxMinutes = Number(opt("max-minutes", "240"));
const softStopAt = Date.now() + maxMinutes * 60_000;

const harnessOf = (tree: string) => (fs.existsSync(path.join(tree, "harness", "server", "index.ts")) ? path.join(tree, "harness") : tree);
const done = new Set(readMeta(metaFile).map(runKey));
console.log(`A/B：${reps} 次 × ${tasks.length} 个任务 × 2 臂，模型 ${provider.provider}/${provider.model}（思考档位 ${effort ?? "默认"}）；工作目录 ${work}；已完成 ${done.size} 个 run`);

const arms: Arm[] = [];
const hardStop = setTimeout(async () => {
  console.error(`超过 --max-minutes ${maxMinutes} 又 20 分钟还没收场：硬收两臂、退出（原样重跑可续）`);
  for (const arm of arms) await arm.stop();
  process.exit(3);
}, (maxMinutes + 20) * 60_000);
hardStop.unref();
try {
  arms.push(await startArm({ name: "base", harnessDir: harnessOf(base), port: portA, root: path.join(work, "arm-base"), envFile: opt("env-file"), extraEnv }));
  arms.push(await startArm({ name: "head", harnessDir: harnessOf(head), port: portB, root: path.join(work, "arm-head"), envFile: opt("env-file"), extraEnv }));
  batch: for (let rep = 1; rep <= reps; rep++) {
    const order = rep % 2 ? arms : [...arms].reverse(); // 每次重复交换先后，抵消「先跑的那臂」的系统偏差
    for (const task of tasks) {
      for (const arm of order) {
        const key = runKey({ task: task.id, arm: arm.name, rep });
        if (done.has(key)) continue;
        if (Date.now() > softStopAt) {
          console.log(`到了 --max-minutes ${maxMinutes}，停在这里；原样重跑会从这一次接着跑`);
          break batch;
        }
        const runDir = path.join(work, "runs", `${task.id}-${arm.name}-${rep}`);
        fs.rmSync(runDir, { recursive: true, force: true });
        try {
          const row = await runTask(arm, task, { runDir, provider, rep });
          appendMeta(metaFile, row);
          console.log(`  ${row.pass ? "✓" : "✗"} ${task.id} · ${arm.name} · 第 ${rep} 次  ${row.detail}（${Math.round(row.wallMs / 1000)}s）`);
        } catch (e) {
          if (!(e instanceof InfraError)) throw e;
          console.error(`  ! ${task.id} · ${arm.name} · 第 ${rep} 次：基础设施失败，不入账——${e.message}`);
        }
      }
    }
  }
} finally {
  for (const arm of arms) await arm.stop();
}

const rows = readMeta(metaFile);
fs.mkdirSync(path.dirname(resultFile), { recursive: true });
fs.writeFileSync(
  resultFile,
  report(rows, {
    title: `A/B · ${topic}（${date}）`,
    arms: ["base", "head"],
    note: `base = ${base}\nhead = ${head}\n模型 ${provider.provider}/${provider.model}（思考档位 ${effort ?? "默认"}），每格 ${reps} 次。n=3 只看方向；低于 100% 的格子逐 run 审过再下结论。` +
      (extFile ? `\n技能目录（两臂同一份）：${path.resolve(extFile)}` : ""),
  }),
);
console.log(`决策收据：${resultFile}`);
