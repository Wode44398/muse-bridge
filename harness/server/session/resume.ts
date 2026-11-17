// 服务重启 / 进程死掉之后的自动续跑。
import { clearRunMarker, listRunMarkers, ownerAlive, ownMarker } from "../run-markers.ts";
import { processTable } from "../proc-tree.ts";
import { registry } from "./registry.ts";
import { initState } from "./build-state.ts";
import { getOrLoadSession, writeRecord } from "./persist.ts";
import { startRun } from "./run.ts";
import type { Session } from "./types.ts";

// ── M13（D6、N35、X33）：服务重启 / 进程死掉之后自动续跑（Codex 形态）─────────────────────────────
// 旧轮已经落定（转录里写着被重启切断，悬空的工具调用由恢复路径补上「结果未知、先查状态」），新开一轮，首条是 harness 内部
// 片段，不重提原 prompt。同一条线连着续跑超过 MAX_AUTO_RESUMES 次（续跑的进程又死了）就停，留一句说明等人来接。
export const RESUME_KIND = "resume";
export const RESUME_STOPPED_KIND = "resume-stopped";
export const MAX_AUTO_RESUMES = 2;

export function resumeText(reason: "restart" | "crash"): string {
  const why = reason === "restart" ? "was interrupted by a server restart (a deploy)" : "stopped unexpectedly (the server went down)";
  return (
    `[Resumed] The previous run ${why} before it finished. Continue the task from where it stopped: first check the current ` +
    "state of anything that was mid-flight (files being edited, commands, background jobs), then carry on — do not redo work " +
    "that is already done. If the task was in fact finished, just say so briefly."
  );
}

export async function resumeInterruptedRuns(): Promise<{ resumed: string[]; gaveUp: string[] }> {
  const resumed: string[] = [];
  const gaveUp: string[] = [];
  const markers = listRunMarkers();
  // 有别的进程写的 marker 才查一次进程表（Windows；查不到就一律当主人还活着，宁可不续）
  const table = markers.some(({ marker }) => !ownMarker(marker) && marker.pid)
    ? process.platform === "win32" ? await processTable().catch(() => null) : null
    : [];
  for (const { sessionId, marker } of markers) {
    if (registry.sessions.get(sessionId)?.running) continue;
    if (ownerAlive(marker, table)) continue; // 别的活着的进程正在跑的轮，不是被切断的
    let session: Session | undefined;
    try {
      session = await getOrLoadSession(sessionId);
    } catch (e) {
      // 缺 key、更新版本写的只读会话……续不了，marker 清掉（不然每次起来都试）
      console.error(`[resume] session ${sessionId} cannot be resumed: ${(e as Error).message}`);
      clearRunMarker(sessionId);
      continue;
    }
    if (!session) {
      clearRunMarker(sessionId);
      continue;
    }
    if (marker.resumes >= MAX_AUTO_RESUMES) {
      clearRunMarker(sessionId);
      session.state ??= initState(session);
      session.state.appendUserBlocks(
        [{
          t: "text",
          text: `[Auto-resume stopped] This run was interrupted ${marker.resumes + 1} times in a row (the server kept going down), so it was not resumed again. The user can say "continue" to pick it up.`,
        }],
        false,
        { origin: "harness", kind: RESUME_STOPPED_KIND },
      );
      await writeRecord(session);
      gaveUp.push(sessionId);
      continue;
    }
    const run = startRun(session, "", undefined, [], undefined, { resume: { resumes: marker.resumes + 1, reason: marker.interrupted ?? "crash" } });
    if (run.started) resumed.push(sessionId);
    // 没起来（又在退役 / 回滚）：marker 留着，下一次起来再试
  }
  if (resumed.length || gaveUp.length) console.log(`[resume] resumed ${resumed.length} interrupted run(s), gave up on ${gaveUp.length}`);
  return { resumed, gaveUp };
}
