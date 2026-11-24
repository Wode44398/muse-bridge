// loop 的挂点：一批工具调用跑完之后，看它们读 / 改过的文件所在的子目录有没有还没加载的指令文件，有就追加（见 subdir.ts）。
import type { AgentState } from "../agent/state.ts";
import type { Block } from "../agent/turn.ts";
import { loadedDocDirs, pendingDocs, PROJECT_DOC_KIND, touchedFiles } from "./subdir.ts";
import { docsTopOf } from "./top.ts";

export function attachProjectDocs(
  state: AgentState,
  calls: readonly { id: string; name: string; args: Record<string, unknown> }[],
  results: readonly Block[],
): void {
  const sandbox = state.ctx.sandbox;
  if (!sandbox) return;
  const ok = new Set(results.flatMap((b) => (b.t === "tool_result" && b.ok ? [b.id] : [])));
  const files = touchedFiles(calls, ok, (p) => sandbox.resolve(p));
  if (!files.length) return;
  for (const doc of pendingDocs(sandbox.root, files, loadedDocDirs(state.messages), docsTopOf(sandbox.root))) {
    state.appendUserBlocks([{ t: "text", text: doc.text }], false, { origin: "harness", kind: PROJECT_DOC_KIND });
  }
}
