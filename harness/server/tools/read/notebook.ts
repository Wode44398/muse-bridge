// Read 读 Jupyter notebook（.ipynb）：按单元格渲染成可读文本——代码、markdown、文本输出（stream / 结果 / 报错）；
// 图片之类的富输出只留一句占位。offset / limit 对 notebook 按单元格算。
const MAX_OUTPUT_CHARS = 4_000;
const MAX_NOTEBOOK_CHARS = 100_000;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

type Json = Record<string, unknown>;

const text = (v: unknown): string => (Array.isArray(v) ? v.map(String).join("") : typeof v === "string" ? v : "");

function clipOut(s: string): string {
  const t = s.replace(ANSI, "").replace(/\s+$/, "");
  return t.length > MAX_OUTPUT_CHARS ? `${t.slice(0, MAX_OUTPUT_CHARS)}\n…[output truncated, ${t.length - MAX_OUTPUT_CHARS} more chars]` : t;
}

function renderOutput(o: Json): string {
  switch (o.output_type) {
    case "stream":
      return clipOut(text(o.text));
    case "error":
      return clipOut([`${String(o.ename ?? "Error")}: ${String(o.evalue ?? "")}`, ...(Array.isArray(o.traceback) ? o.traceback.map(String) : [])].join("\n"));
    case "execute_result":
    case "display_data": {
      const data = (o.data ?? {}) as Json;
      if (data["text/plain"] !== undefined) return clipOut(text(data["text/plain"]));
      if (data["text/markdown"] !== undefined) return clipOut(text(data["text/markdown"]));
      const kinds = Object.keys(data);
      return kinds.length ? `[${kinds.join(", ")} output not shown]` : "";
    }
    default:
      return "";
  }
}

export interface NotebookRead {
  ok: boolean;
  text: string;
  summary: string;
  outcome?: string;
  // 一次就渲染了全部单元格：算读全（Write 的「读全」档据此放行整份覆盖）
  complete?: boolean;
}

export function readNotebook(raw: string, rel: string, offsetArg: unknown, limitArg: unknown): NotebookRead {
  let nb: Json;
  try {
    nb = JSON.parse(raw) as Json;
  } catch (e) {
    return { ok: false, summary: "bad notebook", text: `${rel} is not valid notebook JSON: ${(e as Error).message}` };
  }
  const cells = Array.isArray(nb.cells) ? (nb.cells as Json[]) : [];
  const meta = (nb.metadata ?? {}) as Json;
  const lang = String(((meta.kernelspec ?? {}) as Json).language ?? ((meta.language_info ?? {}) as Json).name ?? "");
  const total = cells.length;
  const offset = Math.max(1, Math.floor(Number(offsetArg ?? 1)) || 1);
  const limit = Math.max(1, Math.floor(Number(limitArg ?? total)) || total);
  const parts: string[] = [];
  let chars = 0;
  let last = offset - 1;
  for (let i = offset - 1; i < Math.min(total, offset - 1 + limit); i++) {
    const c = cells[i];
    const kind = String(c.cell_type ?? "code");
    const count = kind === "code" && c.execution_count !== null && c.execution_count !== undefined ? ` · In [${String(c.execution_count)}]` : "";
    const lines = [`### cell ${i + 1} · ${kind}${count}`, text(c.source).replace(/\s+$/, "") || "(empty)"];
    const outs = Array.isArray(c.outputs) ? (c.outputs as Json[]).map(renderOutput).filter(Boolean) : [];
    if (outs.length) lines.push("--- output ---", outs.join("\n"));
    const block = lines.join("\n");
    if (chars + block.length > MAX_NOTEBOOK_CHARS && parts.length) break;
    parts.push(block);
    chars += block.length;
    last = i + 1;
  }
  const more = last < total ? `\n\n… ${total - last} more cells (use offset=${last + 1}).` : "";
  const header = `${rel}: Jupyter notebook, ${total} cell${total === 1 ? "" : "s"}${lang ? `, ${lang}` : ""}. Rendered view — the file itself is JSON (Edit must match the JSON text; view it raw with Bash if needed).`;
  return {
    ok: true,
    summary: `read notebook ${rel} (${parts.length} cells)`,
    outcome: last >= total && offset === 1 ? `读了全部 ${total} 个单元格` : `读了第 ${offset}–${last} 个单元格（共 ${total} 个）`,
    complete: last >= total && offset === 1,
    text: `${header}\n\n${parts.join("\n\n") || "(no cells)"}${more}`,
  };
}

export const looksLikeNotebook = (p: string): boolean => /\.ipynb$/i.test(p);
