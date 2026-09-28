import fs from "node:fs/promises";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";
import { diagnose } from "./diagnostics.ts";
import { introducesRedactionMark, REDACTED_WRITE_HINT, REDACTION_MARK } from "../redact.ts";
import { writeUserFile } from "../atomic-write.ts";

// Edit's determinism is the #1 reason agent coding derails; these three
// guarantees come straight from the plan (§7.1):
//   1. unique-match enforcement (or replace_all)
//   2. normalization retry (smart quotes / EOL) with original-style preserved
//   3. read-before-edit gate + concurrent-modification detection

export const editTool: Tool = {
  effect: "write",
  concurrencySafe: false,
  def: {
    name: "Edit",
    description:
      "Replace an exact substring in a file you have already Read. old_string must be " +
      "unique unless replace_all is true. Whitespace/quote mismatches are tolerated. " +
      "If the file changed on disk since that Read (your own sed/script write, say), the edit still goes " +
      "through as long as old_string matches the new content uniquely — no re-Read needed. " +
      "old_string and new_string must differ. The saved file gets a quick syntax check " +
      "(JS/TS/JSON/Python); any syntax error is reported in the result — fix it before moving on.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to edit." },
        old_string: { type: "string", description: "Exact text to find (include enough context to be unique)." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  // P11（kimi K20）：不读文件就判得出的失败，在弹卡之前回给模型——以前改控制面文件（AGENTS.md）时先弹一张卡，批了才报
  // 「先 Read」，卡片白问。说法与 run() 一字不差；要读文件才判得出的（old_string 找不到、文件变了）仍在 run() 里。
  prepare(args, ctx) {
    let abs: string;
    try {
      abs = ctx.sandbox.resolve(String(args.path), { forWrite: true });
    } catch {
      return null; // 路径不对由 run() 照常报
    }
    const oldStr = String(args.old_string ?? "");
    const newStr = String(args.new_string ?? "");
    const veto = (summary: string, content: string) => ({ veto: { summary, content } });
    if (oldStr === newStr) return veto("no-op edit", "old_string and new_string are identical.");
    if (!oldStr) return veto("empty match", "old_string is empty. Use Write to create a file.");
    if (introducesRedactionMark(oldStr, newStr)) return veto("redacted text", REDACTED_WRITE_HINT);
    if (!ctx.readFileState.get(abs)) return veto("not read", `You must Read ${ctx.sandbox.rel(abs)} before editing it.`);
    return null;
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const abs = ctx.sandbox.resolve(String(args.path), { forWrite: true });
    const oldStr = String(args.old_string ?? "");
    const newStr = String(args.new_string ?? "");
    const replaceAll = Boolean(args.replace_all);

    if (oldStr === newStr) return fail("no-op edit", "old_string and new_string are identical.");
    if (!oldStr) return fail("empty match", "old_string is empty. Use Write to create a file.");
    // S4：工具输出是脱敏过的。把 [REDACTED…] 标记当原文写回，就等于用标记覆盖掉真密钥。
    if (introducesRedactionMark(oldStr, newStr)) return fail("redacted text", REDACTED_WRITE_HINT);

    // (3) read-before-edit gate.
    const state = ctx.readFileState.get(abs);
    if (!state) {
      return fail("not read", `You must Read ${ctx.sandbox.rel(abs)} before editing it.`);
    }

    let current: string;
    let mtimeMs: number;
    try {
      const stat = await fs.stat(abs);
      mtimeMs = stat.mtimeMs;
      current = await fs.readFile(abs, "utf8");
    } catch (e) {
      return fail("read failed", `Could not read ${args.path}: ${(e as Error).message}`);
    }

    // (3) concurrent-modification detection. A changed file is NOT an automatic
    // refusal: the model's own `sed -i`/script writes trip this constantly, and
    // refusing cost a full round trip every time (2026-08-16: 5 in one k3 run,
    // 3 of which the model then fixed by simply re-issuing the same Edit).
    // What actually keeps the edit well-defined is old_string still matching
    // uniquely in the CURRENT bytes — so refresh our view and let the match
    // rules below decide. Ambiguous or vanished matches still fail, and now say
    // that the file moved under them.
    const changedOnDisk = current !== state.content;
    if (changedOnDisk) {
      ctx.readFileState.set(abs, { mtimeMs, content: current, readRanges: [], complete: false });
    }
    const changedNote = changedOnDisk
      ? `${ctx.sandbox.rel(abs)} changed on disk since you Read it (my view is now refreshed to the current bytes). `
      : "";

    const eol = current.includes("\r\n") ? "\r\n" : "\n";
    const contentLF = current.replace(/\r\n/g, "\n");
    let oldLF = oldStr.replace(/\r\n/g, "\n");
    let newLF = newStr.replace(/\r\n/g, "\n");

    // (2) exact first, then 1:1 normalization (smart quotes etc.) so the model
    // needn't byte-match odd punctuation; we still splice the ORIGINAL chars.
    let { count, index: matchIndex, len: matchLen } = locate(contentLF, oldLF);

    // U5（ZCode C7，只抄这一条确定性策略、不做宽匹配）：old_string 是连着 Read 的行号前缀（"    12\t"）一起抄的。
    // 原样找不到、每一行都带前缀且编号连续时，剥掉再找；new_string 整段带前缀就一并剥掉，只有部分行带就报错让它重发。
    let prefixNote = "";
    const bareOld = count === 0 ? stripReadLinePrefixes(oldLF) : null;
    if (bareOld) {
      const hit = locate(contentLF, bareOld);
      if (hit.count > 0) {
        const bareNew = stripNewStringPrefixes(newLF);
        if (bareNew === null) {
          return fail(
            "line-number prefixes",
            `${changedNote}old_string was copied together with Read's line-number prefixes ("     N<tab>") and matches once they are removed, ` +
              "but new_string has them on only some lines. Resend both as plain file text — the part after the tab — without the prefixes.",
          );
        }
        if (bareNew === bareOld) return fail("no-op edit", "old_string and new_string are identical once Read's line-number prefixes are removed.");
        prefixNote = `Removed Read's line-number prefixes from old_string${bareNew !== newLF ? " and new_string" : ""} — they are display-only; next time copy just the text after the tab. `;
        oldLF = bareOld;
        newLF = bareNew;
        ({ count, index: matchIndex, len: matchLen } = hit);
      }
    }

    if (count === 0) {
      // S4：old_string 抄了脱敏标记——磁盘上那里是真密钥，永远对不上。直接说清楚，别让模型反复重试。
      if (oldStr.includes(REDACTION_MARK)) {
        return fail("redacted text", `${changedNote}old_string contains a [REDACTED…] marker, but the file holds the real secret there, so it can never match. ${REDACTED_WRITE_HINT}`);
      }
      const hint = closestMatchHint(contentLF, bareOld ?? oldLF);
      return fail(
        "no match",
        `${changedNote}old_string not found in ${ctx.sandbox.rel(abs)}.` +
          (hint ? `\n${hint}` : " Re-Read and copy the exact text."),
      );
    }
    // (1) unique-match enforcement.
    if (count > 1 && !replaceAll) {
      return fail(
        "ambiguous",
        `${changedNote}${prefixNote}old_string matches ${count} places in ${ctx.sandbox.rel(abs)}. Add surrounding context to make it unique, or set replace_all=true.`,
      );
    }

    let resultLF: string;
    if (replaceAll) {
      // Replace on the normalized view but splice originals by re-scanning.
      resultLF = replaceAllPreservingOriginal(contentLF, oldLF, newLF);
    } else {
      resultLF =
        contentLF.slice(0, matchIndex) + newLF + contentLF.slice(matchIndex + matchLen);
    }

    const result = eol === "\r\n" ? resultLF.replace(/\n/g, "\r\n") : resultLF;

    try {
      await writeUserFile(abs, result); // U5：临时文件 + rename，写到一半出事原文件还在
      const stat = await fs.stat(abs);
      const totalLines = result.split(/\r?\n/).length;
      // An externally changed file is no longer fully read, whatever the stale
      // state claimed — Write's overwrite gate must not inherit that coverage.
      const complete = changedOnDisk ? false : state.complete;
      ctx.readFileState.set(abs, {
        mtimeMs: stat.mtimeMs,
        content: result,
        readRanges: complete ? [[1, totalLines]] : [],
        complete,
      });
    } catch (e) {
      return fail("write failed", `Could not write ${args.path}: ${(e as Error).message}`);
    }

    const n = replaceAll ? count : 1;
    const applied =
      (changedOnDisk
        ? `${changedNote}old_string still matched the current content, so the edit was applied on top of that change — check the echoed region. `
        : "") + prefixNote + `Applied ${n} replacement${n === 1 ? "" : "s"} in ${ctx.sandbox.rel(abs)}.`;
    // Echo the edited region back (numbered, like Read output) so the model can
    // confirm the change landed as intended without burning a turn on a re-Read.
    const snippet = replaceAll ? null : editSnippet(resultLF, matchIndex, newLF.length);
    const diag = await diagnose(abs, result);
    const parts = [applied];
    if (snippet) parts.push(snippet);
    if (diag) parts.push(`⚠ Syntax check fails on the saved file — fix this before moving on:\n${diag}`);
    // U8（K36）：改了几处、增删几行
    const oldLines = oldLF.split("\n").length;
    const newLines = newLF.split("\n").length;
    return {
      ok: true,
      summary: `edited ${ctx.sandbox.rel(abs)} (${n} replacement${n === 1 ? "" : "s"})${diag ? " ⚠ syntax" : ""}`,
      outcome: `改了 ${n} 处（+${newLines * n} −${oldLines * n} 行）${diag ? " · 语法检查没过" : ""}`,
      content: [{ t: "text", text: parts.join("\n\n") }],
    };
  },
};

// Post-edit echo: the new text plus a little surrounding context. `start`/`len`
// address the replacement inside the LF-normalized result (the prefix before the
// match is unchanged by the splice, so the match index maps directly).
const SNIPPET_CONTEXT_LINES = 3;
const SNIPPET_MAX_LINES = 24;

function editSnippet(content: string, start: number, len: number): string {
  const lines = content.split("\n");
  const startLine = content.slice(0, start).split("\n").length; // 1-based
  const endLine = content.slice(0, start + len).split("\n").length;
  const from = Math.max(1, startLine - SNIPPET_CONTEXT_LINES);
  const to = Math.min(lines.length, endLine + SNIPPET_CONTEXT_LINES);
  let shown = lines.slice(from - 1, to);
  let note = "";
  if (shown.length > SNIPPET_MAX_LINES) {
    note = `\n… (${shown.length - SNIPPET_MAX_LINES} more lines through line ${to})`;
    shown = shown.slice(0, SNIPPET_MAX_LINES);
  }
  const body = shown.map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join("\n");
  return `Result (lines ${from}-${to}):\n${body}${note}`;
}

// When the match fails, show the most similar region of the file so the model
// sees exactly how its old_string diverges (usually whitespace or a stale
// identifier) instead of burning a turn on a full re-Read.
const HINT_MIN_SCORE = 0.55;
const HINT_MAX_LINES = 24;
const HINT_MAX_COST = 2_000_000; // fileLines × oldLines guard for huge inputs

function closestMatchHint(content: string, oldStr: string): string | null {
  const fileLines = content.split("\n");
  const oldNorm = oldStr.split("\n").map(normLine);
  const w = oldNorm.length;
  if (w === 0 || fileLines.length < w || fileLines.length * w > HINT_MAX_COST) return null;
  const fileNorm = fileLines.map(normLine);

  let bestScore = 0;
  let bestStart = -1;
  for (let start = 0; start + w <= fileNorm.length; start++) {
    let sum = 0;
    for (let j = 0; j < w; j++) sum += lineSim(fileNorm[start + j], oldNorm[j]);
    const score = sum / w;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  if (bestStart < 0 || bestScore < HINT_MIN_SCORE) return null;

  const shown = Math.min(w, HINT_MAX_LINES);
  const snippet = fileLines
    .slice(bestStart, bestStart + shown)
    .map((l, i) => `${String(bestStart + 1 + i).padStart(6)}\t${l}`)
    .join("\n");
  const more = w > shown ? `\n… (${w - shown} more lines in this region)` : "";
  // U5（#58）：只有空白不同时明说是哪一行、差在哪。以前缩进差 2 个空格的相似度约 99.6%，四舍五入成
  // 「similarity 100%」，再配上「请逐字比较」，读起来自相矛盾，模型要多花一轮。
  const oldLines = oldStr.split("\n");
  if (fileNorm.slice(bestStart, bestStart + w).every((l, j) => l === oldNorm[j])) {
    const j = oldLines.findIndex((l, k) => l !== fileLines[bestStart + k]);
    const fileLine = fileLines[bestStart + j] ?? "";
    const oldLine = oldLines[j] ?? "";
    const lead = (s: string) => /^[ \t]*/.exec(s)![0];
    const show = (s: string) => (s ? JSON.stringify(s) : "nothing");
    const what = lead(fileLine) !== lead(oldLine)
      ? `file line ${bestStart + 1 + j} is indented with ${show(lead(fileLine))} (${lead(fileLine).length} chars), your old_string line ${j + 1} with ${show(lead(oldLine))} (${lead(oldLine).length} chars)`
      : `whitespace inside or at the end of file line ${bestStart + 1 + j} differs from your old_string line ${j + 1}`;
    return (
      `Only whitespace differs from lines ${bestStart + 1}-${bestStart + w}: ${what}.\n${snippet}${more}\n` +
      "Copy the exact whitespace from the file and retry."
    );
  }
  const pct = Math.min(99, Math.floor(bestScore * 100)); // 没对上就不说 100%
  return (
    `Closest match is lines ${bestStart + 1}-${bestStart + w} (similarity ${pct}%):\n` +
    `${snippet}${more}\n` +
    `Your old_string differs from this text — compare character-by-character (whitespace, quotes, wording) and retry with the exact file text.`
  );
}

function normLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Dice coefficient over char bigrams — cheap, order-tolerant line similarity.
function lineSim(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

// Exact first, then the 1:1 normalized view (length-preserving, so index/len map onto the original).
function locate(content: string, needle: string): { count: number; index: number; len: number } {
  const exact = countOccurrences(content, needle);
  if (exact > 0) return { count: exact, index: content.indexOf(needle), len: needle.length };
  const normContent = normalize(content);
  const normNeedle = normalize(needle);
  const count = countOccurrences(normContent, normNeedle);
  return { count, index: count ? normContent.indexOf(normNeedle) : -1, len: normNeedle.length };
}

// U5：Read（和 Edit 的回显）每行是 `String(n).padStart(6) + "\t" + 原文`；"→" 是另一家常见的写法，模型从训练里带来。
// 空行抄过来时，行尾的 tab 常被当成行尾空白吃掉，只剩一个数字。
const READ_PREFIX = /^ *(\d+)(?:\t|→)(.*)$/;
const BARE_NUMBER = /^ *(\d+)$/;

// old_string：每一行都带前缀、编号连续才剥（末尾的换行照留）；只有一行时还要求就是 Read 的排版（6 位右对齐），
// 免得把一行「12<tab>foo」这样的数据误当成前缀。剥不了返回 null。
function stripReadLinePrefixes(s: string): string | null {
  const lines = s.split("\n");
  const trailing = lines.length > 1 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  const out: string[] = [];
  let next = -1;
  for (const line of lines) {
    const m = READ_PREFIX.exec(line) ?? BARE_NUMBER.exec(line);
    if (!m) return null;
    const n = Number(m[1]);
    if (next !== -1 && n !== next) return null;
    next = n + 1;
    out.push(m[2] ?? "");
  }
  if (lines.length === 1 && !(lines[0].startsWith(`${String(next - 1).padStart(6)}\t`) || lines[0].startsWith(`${String(next - 1).padStart(6)}→`))) {
    return null;
  }
  const bare = out.join("\n") + (trailing ? "\n" : "");
  return bare.trim() ? bare : null;
}

// new_string（只在 old_string 剥过时才看）：带前缀的行一个都没有 → 原样；非空行全带 → 剥掉（编号不必连续，
// 插进来的新行常被重新编号）；有的带有的不带 → null，交给调用方报错，不猜。
function stripNewStringPrefixes(s: string): string | null {
  const lines = s.split("\n");
  let prefixed = 0;
  let plain = 0;
  const out = lines.map((line) => {
    const m = READ_PREFIX.exec(line);
    if (m) {
      prefixed++;
      return m[2];
    }
    const bare = BARE_NUMBER.exec(line);
    if (bare) return ""; // 抄过来的空行；要是整段都没有前缀，下面会原样返回
    if (line) plain++;
    return line;
  });
  if (!prefixed) return s;
  return plain ? null : out.join("\n");
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

// Replace every occurrence, matching on the normalized view but splicing the
// original characters at each hit (so file's own quote/space style survives).
function replaceAllPreservingOriginal(content: string, oldStr: string, newStr: string): string {
  const direct = content.indexOf(oldStr) !== -1;
  if (direct) return content.split(oldStr).join(newStr);

  const normContent = normalize(content);
  const normOld = normalize(oldStr);
  let out = "";
  let pos = 0;
  let i = normContent.indexOf(normOld);
  while (i !== -1) {
    out += content.slice(pos, i) + newStr;
    pos = i + normOld.length;
    i = normContent.indexOf(normOld, pos);
  }
  out += content.slice(pos);
  return out;
}

// 1:1 character normalization: smart quotes / dashes / nbsp -> ascii. Length
// is preserved so match indices map directly onto the original string.
function normalize(s: string): string {
  let out = "";
  for (const ch of s) {
    switch (ch) {
      case "‘":
      case "’":
      case "‛":
        out += "'";
        break;
      case "“":
      case "”":
      case "‟":
        out += '"';
        break;
      case "–":
      case "—":
        out += "-";
        break;
      case " ":
        out += " ";
        break;
      default:
        out += ch;
    }
  }
  return out;
}
