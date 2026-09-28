// M12（N37、#22）：项目知识 worker。扫描工作区、比指纹、重建五张表、追加验证记录、打 dirty 标记——凡是读写知识缓存的
// 活都在这一条线程里按到达顺序做完，主线程只拿结果（knowledge-service.ts）。写盘都在这里，主线程与 worker 不会互相
// 盖掉 health.json（以前主线程追加验证记录与重建各写各的）。
import { parentPort } from "node:worker_threads";
import {
  ensureProjectKnowledge,
  loadCachedProjectKnowledge,
  markProjectKnowledgeDirty,
  recordProjectVerification,
  type ProjectKnowledge,
  type RecordProjectVerificationOptions,
} from "./knowledge.ts";

type Env = Record<string, string | undefined>;
export type KnowledgeJob =
  | { id: number; kind: "ensure"; root: string; force?: boolean; known?: string; env: Env }
  | { id: number; kind: "verify"; root: string; options: RecordProjectVerificationOptions; known?: string; env: Env }
  | { id: number; kind: "dirty"; root: string; env: Env };

// 主线程每次都带上知识目录一类的环境变量：worker 的 process.env 是建线程那一刻的副本，之后主线程改了它看不见
function applyEnv(env: Env): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// 主线程手里那份指纹没变（也没重建）：只回 health（验证记录可能多了），不把几 MB 的模块图再搬一遍
function reply(id: number, knowledge: ProjectKnowledge | null, known?: string): void {
  if (!knowledge) parentPort!.postMessage({ id, ok: true });
  else if (!knowledge.rebuilt && known && known === knowledge.profile.sourceFingerprint) {
    parentPort!.postMessage({ id, ok: true, unchanged: true, health: knowledge.health });
  } else parentPort!.postMessage({ id, ok: true, knowledge });
}

parentPort!.on("message", (job: KnowledgeJob) => {
  try {
    applyEnv(job.env);
    if (job.kind === "dirty") {
      markProjectKnowledgeDirty(job.root);
      reply(job.id, null);
    } else if (job.kind === "verify") {
      recordProjectVerification(job.root, job.options); // 它自己先对一遍知识（必要时重建）再追加
      reply(job.id, loadCachedProjectKnowledge(job.root), job.known);
    } else {
      reply(job.id, ensureProjectKnowledge(job.root, { force: job.force }), job.known);
    }
  } catch (error) {
    parentPort!.postMessage({ id: job.id, ok: false, error: (error as Error).message });
  }
});
