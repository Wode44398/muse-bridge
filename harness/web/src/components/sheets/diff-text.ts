// 回滚预览的 diff 解读（纯函数，不碰 DOM）。服务端给的是「git diff --stat」+ 空行 + 完整补丁（从检查点到现在，
// 即回滚会撤销的东西），超过 6 万字截断并在末尾加「…[diff truncated]」；什么都没改时是空白或一句英文说明。
// 这里拆出：改了哪些文件、各增删多少行（按补丁逐行数，精确；补丁被截断时，截掉的那几个文件从 --stat 里补上）。

export interface DiffFile {
  path: string;
  add: number;
  del: number;
  bin: boolean;
  changed?: number; // 只在 --stat 里见到（补丁被截断了）：总改动行数，分不出增删
}
export interface DiffSummary {
  empty: boolean;
  truncated: boolean;
  files: DiffFile[];
  add: number;
  del: number;
}

const NO_CHANGES = "(no changes since this checkpoint)";
const TRUNCATED = "…[diff truncated]";

// git 对含非 ASCII / 特殊字符的路径加引号并转义（中文文件名是 \346\226\207 这种八进制字节）：还原成原文
export function unquoteGitPath(p: string): string {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const ESC: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...enc.encode(ch));
      continue;
    }
    const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0];
    if (oct) {
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
      continue;
    }
    const nx = body[i + 1] ?? "";
    bytes.push(ESC[nx] ?? nx.charCodeAt(0));
    i += 1;
  }
  try {
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch {
    return body;
  }
}

// 「+++ b/x」「--- a/x」里的路径（/dev/null = 没有）
function sidePath(rest: string): string {
  const s = unquoteGitPath(rest.trim().replace(/\t.*$/, ""));
  if (s === "/dev/null") return "";
  return s.replace(/^[ab]\//, "");
}
// 「diff --git a/x b/y」：取 b 那一侧（含空格的路径按最后一个 " b/" 切；带引号的按引号切）
function headerPath(line: string): string {
  const rest = line.slice("diff --git ".length);
  const quoted = /"b\/(?:[^"\\]|\\.)*"$/.exec(rest);
  if (quoted) return sidePath(quoted[0].replace(/^"b\//, '"'));
  const at = rest.lastIndexOf(" b/");
  return at >= 0 ? rest.slice(at + 3) : rest;
}

export function parseCheckpointDiff(raw: string): DiffSummary {
  const text = raw.replace(/\r\n/g, "\n");
  const body = text.trim();
  if (!body || body === NO_CHANGES) return { empty: true, truncated: false, files: [], add: 0, del: 0 };
  const truncated = body.endsWith(TRUNCATED);

  // 补丁：逐文件数 + / - 行（只数 @@ 之后的；+++ / --- 是文件头）
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let inHunk = false;
  const cut = text.indexOf("\ndiff --git ");
  const patch = cut >= 0 ? text.slice(cut + 1) : text.startsWith("diff --git ") ? text : "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { path: headerPath(line), add: 0, del: 0, bin: false };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith("+++ ")) {
        const p = sidePath(line.slice(4));
        if (p) cur.path = p;
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) cur.bin = true;
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) cur.add++;
    else if (line.startsWith("-")) cur.del++;
  }

  // --stat：总数以它的汇总行为准（补丁可能被截断）；截断时补上补丁里没出现的文件
  const statText = cut >= 0 ? text.slice(0, cut) : patch ? "" : text;
  let add = files.reduce((a, f) => a + f.add, 0);
  let del = files.reduce((a, f) => a + f.del, 0);
  const statFiles: DiffFile[] = [];
  for (const line of statText.split("\n")) {
    const sum = /^\s*\d+ files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(line);
    if (sum) {
      add = Number(sum[1] ?? 0);
      del = Number(sum[2] ?? 0);
      continue;
    }
    const m = /^\s*(.+?)\s+\|\s+(?:(\d+)|Bin\b)/.exec(line);
    if (m) statFiles.push({ path: unquoteGitPath(m[1].trim()), add: 0, del: 0, bin: !m[2], changed: m[2] ? Number(m[2]) : undefined });
  }
  if (truncated || !files.length) {
    // --stat 会把太长的路径缩成「.../尾巴」：按尾巴认
    const same = (s: DiffFile, f: DiffFile) => f.path === s.path || (s.path.startsWith(".../") && `/${f.path}`.endsWith(s.path.slice(3)));
    const last = files[files.length - 1];
    for (const s of statFiles) {
      const hit = files.find((f) => same(s, f));
      if (!hit) files.push(s);
      // 截断处的那个文件只数到一半：用 --stat 的总行数
      else if (hit === last && truncated && s.changed !== undefined && s.changed > hit.add + hit.del) hit.changed = s.changed;
    }
  }
  return { empty: false, truncated, files, add, del };
}

// 补丁上色（行级）：HTML 先转义，再按行首打类名（新增 da / 删除 dr / 块头 dh / 文件头 dm）
export function diffHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split("\n")
    .map((l) => {
      const e = esc(l);
      if (l.startsWith("+") && !l.startsWith("+++")) return `<span class="da">${e}</span>`;
      if (l.startsWith("-") && !l.startsWith("---")) return `<span class="dr">${e}</span>`;
      if (l.startsWith("@@")) return `<span class="dh">${e}</span>`;
      if (l.startsWith("diff ") || l.startsWith("index ") || l.startsWith("+++") || l.startsWith("---")) return `<span class="dm">${e}</span>`;
      return e;
    })
    .join("\n");
}
