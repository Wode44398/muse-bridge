// M13（D6、N35、X33）：开跑 marker——服务重启 / 进程死掉之后，下一个进程知道哪些轮是被切断的，按 Codex 的形态自动接着做。
//
// marker = <sessions>/running/<会话 id>.json：{ runId, startedAt, resumes, interrupted? }
//   · 一轮开跑时写（同步，在第一个 await 之前）；正常收尾（做完、用户停、报错）删掉；
//   · 因「服务重启」被中止的（M8 排空）留着，标上 interrupted: "restart"；进程直接死掉的（崩溃、被外力杀）自然留着；
//   · resumes = 这条线已经自动续跑过几次——续跑的那一轮又被切断，下一次就 +1，超过上限不再续（重启循环熔断）。
// 写不成、读不了都只记一笔，不影响开跑（诊断性的东西永远不挡主链路）。
import fs from "node:fs";
import path from "node:path";
import { sessionsDir } from "./paths.ts";

export interface RunMarker {
  runId: string;
  startedAt: number;
  resumes: number;
  interrupted?: "restart";
  // 写它的进程（PID + 创建时间）：扫的时候跳过「还活着的别的进程」的 marker——那是人家正在跑的轮，不是被切断的
  // （测试里多个 harness 共用一个会话目录；生产重启时新旧进程也可能短暂重叠）。PID 会被复用，所以连创建时间一起核对。
  pid?: number;
  pidCreated?: number;
}

// 本进程的创建时间（毫秒，和进程表里的 CreationDate 对得上，误差在一两秒内）
export const PROCESS_CREATED = Date.now() - Math.round(process.uptime() * 1000);
const CREATED_TOLERANCE_MS = 3_000;

export function ownMarker(m: RunMarker): boolean {
  return m.pid === process.pid && Math.abs((m.pidCreated ?? 0) - PROCESS_CREATED) <= CREATED_TOLERANCE_MS;
}

// 别的进程写的 marker：它还活着吗（按 PID + 创建时间核对进程表；table 为 null = 查不到表，一律当活着——宁可不续）
export function ownerAlive(m: RunMarker, table: ReadonlyArray<{ pid: number; created: number }> | null): boolean {
  if (ownMarker(m)) return false;
  if (!m.pid) return false; // 老 marker 没记进程：当作主人已经不在
  if (!table) return true;
  return table.some((row) => row.pid === m.pid && Math.abs(row.created - (m.pidCreated ?? 0)) <= CREATED_TOLERANCE_MS);
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function runMarkerDir(): string {
  return path.join(sessionsDir(), "running");
}

function markerFile(sessionId: string): string | null {
  return ID_RE.test(sessionId) ? path.join(runMarkerDir(), `${sessionId}.json`) : null;
}

export function writeRunMarker(sessionId: string, marker: RunMarker): void {
  const file = markerFile(sessionId);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marker));
  } catch (e) {
    console.error(`[run-marker] ${sessionId}: could not write (${(e as Error).message})`);
  }
}

export function readRunMarker(sessionId: string): RunMarker | null {
  const file = markerFile(sessionId);
  if (!file) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RunMarker>;
    if (typeof m.runId !== "string" || typeof m.startedAt !== "number") return null;
    return {
      runId: m.runId,
      startedAt: m.startedAt,
      resumes: Number(m.resumes) || 0,
      ...(m.interrupted === "restart" ? { interrupted: "restart" as const } : {}),
      ...(typeof m.pid === "number" ? { pid: m.pid } : {}),
      ...(typeof m.pidCreated === "number" ? { pidCreated: m.pidCreated } : {}),
    };
  } catch {
    return null;
  }
}

export function clearRunMarker(sessionId: string): void {
  const file = markerFile(sessionId);
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    console.error(`[run-marker] ${sessionId}: could not remove (${(e as Error).message})`);
  }
}

// 进程起来时扫一遍：留下来的 marker 就是被切断的轮
export function listRunMarkers(): Array<{ sessionId: string; marker: RunMarker }> {
  let names: string[];
  try {
    names = fs.readdirSync(runMarkerDir());
  } catch {
    return [];
  }
  const out: Array<{ sessionId: string; marker: RunMarker }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const sessionId = name.slice(0, -5);
    const marker = readRunMarker(sessionId);
    if (marker) out.push({ sessionId, marker });
    else clearRunMarker(sessionId); // 坏的直接清掉
  }
  return out;
}
