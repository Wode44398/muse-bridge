// Q13（F4 / Codex C8）：一键诊断包。手机上「卡住了、慢了、报错了」时，把这一个会话当时的现场打成一个 JSON 交给用户：
//   about（版本、协议、平台、进程内存）+ session（配置——不含 key、条数与结构——不含对话正文）+ health（Q5 体检）
//   + trace（Q12 事件日志的末尾）+ ring（诊断内存环里这个会话的输出，外加进程级输出的末尾）+ crashes（最近几次崩溃留痕）
//   + skipped（没放进来的、截掉的写明——宁可说清楚不完整，也不悄悄截断）。整包上限 DIAG_MAX_BYTES，超了从最老的删起并注明。
// 写到会话工作区的 .dimensio/diagnostics/<会话 id>/diag-<时间>.json：目录里的 .gitignore 让 git 看不见，检查点排除，删会话回收。
// 前端按「产物」打开——手机上走 bridge 的查看器（能分享 / 另存），桌面独立时直接下载。
// 这里不 import session.ts（session.ts 删会话时要调这里的回收），会话摘要由调用方整理好传进来。
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILD_INFO } from "./build-info.ts";
import { recentCrashes, ringSlice, type RingEntry } from "./diag-ring.ts";
import { protocolInfo } from "./protocol.ts";
import { redactOutput } from "./redact.ts";
import type { HealthReport } from "./session-health.ts";
import { flushTraceLog, traceFile } from "./trace-log.ts";

export const DIAG_DIR = ".dimensio/diagnostics";
export const DIAG_MAX_BYTES = 2 << 20;
const TRACE_TAIL = 800;
const PROCESS_TAIL = 200;
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export interface DiagnosticsInput {
  sessionId: string;
  workspace: string;
  session: Record<string, unknown>; // 调用方整理好的会话摘要（不含正文、不含 key）
  health: HealthReport | null;
}

function readTrace(sessionId: string): Record<string, unknown>[] {
  const file = traceFile(sessionId);
  if (!file) return [];
  const lines: Record<string, unknown>[] = [];
  for (const f of [file.replace(/\.jsonl$/, ".1.jsonl"), file]) {
    try {
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* 半行（写到一半）跳过 */
        }
      }
    } catch {
      /* 没有这个文件 */
    }
  }
  return lines;
}

const iso = (t: number) => new Date(t).toISOString();
const ringView = (entries: RingEntry[]) => entries.map((e) => ({ t: iso(e.t), level: e.level, ...(e.trace ? { trace: e.trace } : {}), msg: e.msg }));

export async function buildDiagnostics(input: DiagnosticsInput): Promise<{ bundle: Record<string, unknown>; json: string }> {
  await flushTraceLog();
  const skipped: string[] = ["对话正文不在包里：只有条数、角色、工具名这类结构；要看正文请直接打开这个会话"];
  const traceAll = readTrace(input.sessionId);
  let trace = traceAll.slice(-TRACE_TAIL);
  if (traceAll.length > trace.length) skipped.push(`事件日志只放了最后 ${trace.length} 行（共 ${traceAll.length} 行）`);
  let ring = ringView(ringSlice(input.sessionId));
  let processTail = ringView(ringSlice(undefined, PROCESS_TAIL));
  const mem = process.memoryUsage();
  const bundle: Record<string, unknown> = {
    about: {
      kind: "dimensio-diagnostics",
      generatedAt: new Date().toISOString(),
      build: BUILD_INFO,
      protocol: protocolInfo(),
      node: process.version,
      platform: `${process.platform} ${os.release()} ${process.arch}`,
      uptimeSec: Math.round(process.uptime()),
      memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    },
    session: input.session,
    health: input.health,
    trace,
    ring,
    processTail,
    crashes: recentCrashes(),
    skipped,
  };
  let json = JSON.stringify(bundle, null, 1);
  // 超上限：从最老的删起（事件日志、会话输出、进程输出轮流减半），并写明
  let cut = false;
  while (json.length > DIAG_MAX_BYTES && (trace.length > 20 || ring.length > 20 || processTail.length > 20)) {
    cut = true;
    if (trace.length > 20) trace = trace.slice(Math.floor(trace.length / 2));
    if (ring.length > 20) ring = ring.slice(Math.floor(ring.length / 2));
    if (processTail.length > 20) processTail = processTail.slice(Math.floor(processTail.length / 2));
    bundle.trace = trace;
    bundle.ring = ring;
    bundle.processTail = processTail;
    json = JSON.stringify(bundle, null, 1);
  }
  if (cut || json.length > DIAG_MAX_BYTES) {
    skipped.push(`整包超过 ${DIAG_MAX_BYTES >> 20} MB：事件日志留了最后 ${trace.length} 行、会话输出 ${ring.length} 条、进程输出 ${processTail.length} 条`);
    json = JSON.stringify(bundle, null, 1);
  }
  // 最后一道：整包再过一遍脱敏（会话摘要是调用方给的，这里不假设它干净）
  json = redactOutput(json);
  return { bundle, json };
}

export function sessionDiagnosticsDir(workspace: string, sessionId: string): string | null {
  return SESSION_ID_RE.test(sessionId) ? path.join(workspace, ...DIAG_DIR.split("/"), sessionId) : null;
}

export async function writeDiagnostics(input: DiagnosticsInput): Promise<{ path: string; name: string; kind: "text"; size: number }> {
  const dir = sessionDiagnosticsDir(input.workspace, input.sessionId);
  if (!dir) throw new Error(`invalid session id: ${input.sessionId}`);
  const { json } = await buildDiagnostics(input);
  const base = path.join(input.workspace, ...DIAG_DIR.split("/"));
  await fsp.mkdir(dir, { recursive: true });
  const ignore = path.join(base, ".gitignore");
  if (!fs.existsSync(ignore)) await fsp.writeFile(ignore, "# dimensio 的诊断包：不进版本库（随会话删除回收）\n*\n");
  const name = `diag-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await fsp.writeFile(path.join(dir, name), json);
  return { path: `${DIAG_DIR}/${input.sessionId}/${name}`, name, kind: "text", size: Buffer.byteLength(json) };
}

export async function deleteSessionDiagnostics(workspace: string, sessionId: string): Promise<void> {
  const dir = sessionDiagnosticsDir(workspace, sessionId);
  if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}
