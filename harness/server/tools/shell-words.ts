// P4（#15、#4）：共享轻量 shell 分词器。危险命令判定（K5）、Bash 子命令规则（A5）、只读降级（C9）共用这一份。
//
// 以前三处各看各的：deny-list 拿正则扫整串（`grep -rn reboot src` 被硬拒，`rm -fr /` 却放行）；规则拿整串做
// glob（`Bash(git push:*)` 连 `git push && rm -rf ~` 一起放行）；plan 档连一条 `git status` 都跑不了。
// 这里只回答一件事：这条命令行里有哪些程序、以什么参数、带什么重定向在【本机】跑——包括 $(…)、反引号、
// 进程替换、未加引号的 here-document 里的，以及 sudo/env/xargs/bash -c/cmd /c/powershell -Command 等包装器里的。
//
// 契约借 kimi 的解析器（不借它 4.6k 行的实现）：有预算、永不抛错、分析不了就如实标 unanalyzable，调用方据此
// 「转问」而不是按半截结果放行。它不是完整的 bash 语法；拿不准的地方一律往保守那边偏。
// `adb shell …`、`ssh host …`、`docker run …` 里的命令跑在别的机器上，不展开——宿主规则管不到它们。

export type ShellDialect = "bash" | "cmd" | "powershell";

export interface ShellWord {
  // 去掉引号后的字面值；$VAR、%VAR%、${…} 原样保留（$HOME 之类后面还要认），命令替换记作 $(…)
  text: string;
  // 值要到运行时才知道：参数展开、命令替换
  dynamic: boolean;
  // 含命令替换：值完全不可知
  subst: boolean;
  // 含未加引号的 * ? [
  glob: boolean;
  // 第一个字符在引号里（或被转义）："~" 不是家目录、"if" 不是关键字
  leadQuoted: boolean;
}

export interface ShellRedirect {
  op: string; // ">"、">>"、"2>"、"2>&"、"&>"、"<"、"<<"、"<<<" …（fd 前缀在前）
  target: string;
  dynamic: boolean;
}

export interface ShellCommand {
  // argv[0] 的 basename：小写、去掉 .exe/.cmd/.bat/.com；程序名运行时才知道时为 ""
  name: string;
  argv: string[];
  words: ShellWord[];
  // 所在段的原文（去掉了 &&、|、; 等分隔符）——规则按它匹配
  raw: string;
  // 有参数要到运行时才知道（含 xargs 从 stdin 拼参）
  dynamic: boolean;
  redirects: ShellRedirect[];
  // 由外到内剥掉的包装器："sudo"、"env"、"bash -c"、"cmd /c"、"xargs" …
  wrappers: string[];
  dialect: ShellDialect;
  // P12：stdin 从哪来——管道（`curl … | sh`）还是 here-document（`python - <<EOF`，程序就写在命令里）
  pipedIn?: boolean;
  heredoc?: boolean;
}

export interface ShellParse {
  commands: ShellCommand[];
  // 引号没闭合、程序名运行时才知道、脚本串里拼了运行时的值、嵌套太深……命令清单可能不全
  unanalyzable: boolean;
  reason?: string;
}

// 「执行的脚本串里拼了运行时的值」（bash -c "$(…)"、eval、iex $x）：分析不了的原因之一。P12 据此认
// `sh -c "$(curl …)"` 这类下载即执行，所以原因文字只在这里写一处。
export const SPLICED_AT_RUN_TIME = "runs a command string with values spliced in at run time";

const MAX_INPUT = 64 * 1024;
const MAX_DEPTH = 4;
const MAX_COMMANDS = 256;

interface Ctx {
  out: ShellCommand[];
  unanalyzable: boolean;
  reason?: string;
}

interface Heredoc {
  body: string;
  quoted: boolean;
}

interface RawSeg {
  words: ShellWord[];
  redirects: ShellRedirect[];
  raw: string;
  pipedIn: boolean;
  callOp: boolean; // PowerShell 的 `& "x.exe" …`
  heredocs: Heredoc[];
}

interface WordBuf {
  text: string;
  dynamic: boolean;
  subst: boolean;
  glob: boolean;
  quoted: boolean;
  leadQuoted: boolean | null;
}

interface PendingHeredoc {
  delim: string;
  strip: boolean;
  quoted: boolean;
  seg: RawSeg;
}

export function parseShell(command: string, dialect: ShellDialect = "bash"): ShellParse {
  const ctx: Ctx = { out: [], unanalyzable: false };
  try {
    if (command.length > MAX_INPUT) giveUp(ctx, "the command is too long to analyze");
    else parseScript(command, dialect, ctx, 0, [], false);
  } catch {
    giveUp(ctx, "the command could not be parsed");
  }
  return ctx.reason === undefined
    ? { commands: ctx.out, unanalyzable: ctx.unanalyzable }
    : { commands: ctx.out, unanalyzable: ctx.unanalyzable, reason: ctx.reason };
}

function giveUp(ctx: Ctx, why: string): void {
  if (ctx.unanalyzable) return;
  ctx.unanalyzable = true;
  ctx.reason = why;
}

function parseScript(src: string, dialect: ShellDialect, ctx: Ctx, depth: number, chain: string[], dynamic: boolean): void {
  if (depth > MAX_DEPTH) return giveUp(ctx, "commands are nested too deeply to analyze");
  const segs = new Scanner(src, dialect, ctx, depth, chain).run();
  for (const seg of segs) {
    if (ctx.out.length >= MAX_COMMANDS) return giveUp(ctx, "too many commands to analyze");
    emit(seg.words, seg, dialect, ctx, depth, chain, dynamic);
  }
}

// bash 里反斜杠后面跟这些字符才是转义；其余保留反斜杠本身——C:\Users 还是 C:\Users（git-bash 实际会吃掉它，
// 但分析要的是模型想表达的路径）。
const BASH_ESCAPABLE = /[\s;&|<>()$`"'\\#*?[\]{}!~=]/;

// 把一段源码切成「段」（分隔符 && || ; | & 换行、括号），每段是词 + 重定向；命令替换、进程替换、
// PowerShell 脚本块、未加引号的 here-document 里的命令在扫描时就递归解析、直接进结果。
class Scanner {
  src: string;
  dialect: ShellDialect;
  ctx: Ctx;
  depth: number;
  chain: string[];
  segs: RawSeg[] = [];
  seg: RawSeg = newSeg(false);
  segStart = 0;
  word: WordBuf | null = null;
  redirect: { op: string; heredoc: boolean } | null = null;
  heredocs: PendingHeredoc[] = [];

  constructor(src: string, dialect: ShellDialect, ctx: Ctx, depth: number, chain: string[]) {
    this.src = src;
    this.dialect = dialect;
    this.ctx = ctx;
    this.depth = depth;
    this.chain = chain;
  }

  run(): RawSeg[] {
    const src = this.src;
    const bash = this.dialect === "bash";
    const ps = this.dialect === "powershell";
    const cmd = this.dialect === "cmd";
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      const next = src[i + 1];
      if ((bash && ch === "\\") || (ps && ch === "`")) {
        // 续行
        if (next === "\n") {
          i++;
          continue;
        }
        if (next === "\r" && src[i + 2] === "\n") {
          i += 2;
          continue;
        }
      }
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v") {
        this.endWord();
        continue;
      }
      if (ch === "\n") {
        this.endSeg(i);
        if (this.heredocs.length) i = this.readHeredocs(i + 1) - 1;
        this.segStart = i + 1;
        continue;
      }
      if (ch === "#" && !cmd && this.word === null) {
        // 注释：词首的 # 到行尾
        const nl = src.indexOf("\n", i);
        i = (nl < 0 ? src.length : nl) - 1;
        continue;
      }
      if (ps && ch === "<" && next === "#") {
        const end = src.indexOf("#>", i + 2);
        if (end < 0) {
          this.giveUp("an unterminated <# comment");
          break;
        }
        i = end + 1;
        continue;
      }
      if (ch === ";") {
        this.endSeg(i);
        if (next === ";") i++; // case 分支的 ;;
        this.segStart = i + 1;
        continue;
      }
      if (ch === "|") {
        const or = next === "|";
        this.endSeg(i, !or);
        if (or || (bash && next === "&")) i++; // || 与 |&
        this.segStart = i + 1;
        continue;
      }
      if (ch === "&") {
        if (next === "&") {
          this.endSeg(i);
          i++;
          this.segStart = i + 1;
          continue;
        }
        if (next === ">" && !cmd) {
          // &> 与 &>>：stdout+stderr 一起重定向
          this.endWord();
          const op = src[i + 2] === ">" ? "&>>" : "&>";
          this.redirect = { op, heredoc: false };
          i += op.length - 1;
          continue;
        }
        if (ps && this.word === null && this.seg.words.length === 0) {
          this.seg.callOp = true; // PowerShell 调用运算符：`& "C:\x.exe" args`
          continue;
        }
        this.endSeg(i); // 后台执行 / cmd 的顺序执行
        this.segStart = i + 1;
        continue;
      }
      if (ch === "(" || ch === ")") {
        // 子 shell、分组、PowerShell 表达式（$( 与 <( 在各自的分支里先接走了）
        this.endSeg(i);
        this.segStart = i + 1;
        continue;
      }
      if (ps && ch === "{") {
        // PowerShell 脚本块：`ForEach-Object { Remove-Item … }` 里的命令也会跑
        const close = matchClose(src, i, "{", "}", this.dialect);
        if (close < 0) {
          this.giveUp("unbalanced { }");
          break;
        }
        this.nested(src.slice(i + 1, close));
        this.dyn("{…}", false);
        i = close;
        continue;
      }
      if (ch === "'" && !cmd) {
        i = this.single(i);
        continue;
      }
      if (ch === '"') {
        i = this.double(i);
        continue;
      }
      if (bash && ch === "$" && next === "'") {
        i = this.ansiC(i);
        continue;
      }
      if ((bash || ps) && ch === "$") {
        i = this.dollar(i, false);
        continue;
      }
      if (cmd && ch === "%") {
        i = this.percent(i, false);
        continue;
      }
      if (bash && ch === "`") {
        i = this.backtick(i, false);
        continue;
      }
      if (bash && ch === "\\") {
        if (next === undefined) {
          this.add("\\", false);
          continue;
        }
        if (BASH_ESCAPABLE.test(next)) this.add(next, true);
        else this.add("\\" + next, false);
        i++;
        continue;
      }
      if ((ps && ch === "`") || (cmd && ch === "^")) {
        if (next !== undefined) {
          this.add(next, true);
          i++;
        }
        continue;
      }
      if (ch === "<" || ch === ">") {
        i = this.redirection(i);
        continue;
      }
      if (ch === "*" || ch === "?" || ch === "[") this.buf().glob = true;
      this.add(ch, false);
    }
    this.endSeg(src.length);
    if (this.heredocs.length) this.readHeredocs(src.length);
    return this.segs;
  }

  giveUp(why: string): void {
    giveUp(this.ctx, why);
  }

  buf(): WordBuf {
    if (!this.word) this.word = { text: "", dynamic: false, subst: false, glob: false, quoted: false, leadQuoted: null };
    return this.word;
  }

  add(s: string, quoted: boolean): void {
    const w = this.buf();
    if (w.leadQuoted === null) w.leadQuoted = quoted;
    w.text += s;
    if (quoted) w.quoted = true;
  }

  // 值要到运行时才知道的一段（$VAR、${…}、%VAR%）：原文照留
  dyn(s: string, quoted: boolean): void {
    this.add(s, quoted);
    this.buf().dynamic = true;
  }

  // 命令替换：里面的命令同样在本机跑；这个词的值完全不可知
  subst(inner: string, quoted: boolean): void {
    this.nested(inner);
    this.dyn("$(…)", quoted);
    this.buf().subst = true;
  }

  nested(inner: string): void {
    parseScript(inner, this.dialect, this.ctx, this.depth + 1, this.chain, false);
  }

  endWord(): void {
    const w = this.word;
    if (!w) return;
    this.word = null;
    const word: ShellWord = { text: w.text, dynamic: w.dynamic, subst: w.subst, glob: w.glob, leadQuoted: w.leadQuoted === true };
    const r = this.redirect;
    if (!r) {
      this.seg.words.push(word);
      return;
    }
    this.redirect = null;
    this.seg.redirects.push({ op: r.op, target: word.text, dynamic: word.dynamic });
    if (r.heredoc) this.heredocs.push({ delim: word.text, strip: r.op.endsWith("-"), quoted: w.quoted, seg: this.seg });
  }

  endSeg(at: number, piped = false): void {
    this.endWord();
    if (this.redirect) {
      this.redirect = null;
      this.giveUp("a redirection has no target");
    }
    const seg = this.seg;
    seg.raw = this.src.slice(this.segStart, at).trim();
    if (seg.words.length || seg.redirects.length) this.segs.push(seg);
    this.seg = newSeg(piped);
  }

  // here-document 的正文：从命令所在行的下一行读到结束标记行。未加引号的标记照样展开 $(…) 与反引号——那些命令会跑。
  readHeredocs(pos: number): number {
    const src = this.src;
    for (const h of this.heredocs) {
      const lines: string[] = [];
      while (pos < src.length) {
        const nl = src.indexOf("\n", pos);
        const end = nl < 0 ? src.length : nl;
        const line = src.slice(pos, end).replace(/\r$/, "");
        pos = end + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        lines.push(line);
      }
      const body = lines.join("\n");
      h.seg.heredocs.push({ body, quoted: h.quoted });
      if (!h.quoted) this.substitutionsIn(body);
    }
    this.heredocs = [];
    return Math.min(pos, src.length);
  }

  substitutionsIn(text: string): void {
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (c === "\\") {
        k++;
        continue;
      }
      if (c === "$" && text[k + 1] === "(" && text[k + 2] !== "(") {
        const close = matchClose(text, k + 1, "(", ")", "bash");
        if (close < 0) return this.giveUp("an unterminated $( … ) in a here-document");
        this.nested(text.slice(k + 2, close));
        k = close;
      } else if (c === "`") {
        const close = text.indexOf("`", k + 1);
        if (close < 0) return this.giveUp("an unterminated backtick in a here-document");
        this.nested(text.slice(k + 1, close));
        k = close;
      }
    }
  }

  // 以下各读法都返回「最后一个被吃掉的字符」的下标，主循环的 i++ 接着往下走。

  single(i: number): number {
    const src = this.src;
    let j = i + 1;
    let text = "";
    for (;;) {
      const k = src.indexOf("'", j);
      if (k < 0) {
        this.giveUp("an unterminated quote");
        text += src.slice(j);
        j = src.length;
        break;
      }
      text += src.slice(j, k);
      if (this.dialect === "powershell" && src[k + 1] === "'") {
        text += "'";
        j = k + 2;
        continue;
      }
      j = k + 1;
      break;
    }
    this.add(text, true);
    return j - 1;
  }

  double(i: number): number {
    const src = this.src;
    const bash = this.dialect === "bash";
    const ps = this.dialect === "powershell";
    this.add("", true); // `""` 也是一个（空）参数
    let j = i + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === '"') {
        if (ps && src[j + 1] === '"') {
          this.add('"', true);
          j += 2;
          continue;
        }
        return j;
      }
      if (bash && c === "\\" && j + 1 < src.length) {
        const n = src[j + 1];
        if (n !== "\n") this.add(/[$`"\\]/.test(n) ? n : "\\" + n, true);
        j += 2;
        continue;
      }
      if (ps && c === "`" && j + 1 < src.length) {
        this.add(src[j + 1], true);
        j += 2;
        continue;
      }
      if ((bash || ps) && c === "$") {
        j = this.dollar(j, true) + 1;
        continue;
      }
      if (bash && c === "`") {
        j = this.backtick(j, true) + 1;
        continue;
      }
      if (this.dialect === "cmd" && c === "%") {
        j = this.percent(j, true) + 1;
        continue;
      }
      this.add(c, true);
      j++;
    }
    this.giveUp("an unterminated quote");
    return src.length - 1;
  }

  // bash 的 $'…'：\x72\x6d 也得认出是 rm
  ansiC(i: number): number {
    const src = this.src;
    let j = i + 2;
    let text = "";
    while (j < src.length && src[j] !== "'") {
      if (src[j] === "\\" && j + 1 < src.length) {
        const rest = src.slice(j + 1, j + 10);
        const hex = /^x([0-9A-Fa-f]{1,2})/.exec(rest);
        const uni = /^[uU]([0-9A-Fa-f]{1,8})/.exec(rest);
        const oct = /^([0-7]{1,3})/.exec(rest);
        if (hex) {
          text += String.fromCharCode(parseInt(hex[1], 16));
          j += 1 + hex[0].length;
        } else if (uni) {
          text += String.fromCodePoint(Math.min(parseInt(uni[1], 16), 0x10ffff));
          j += 1 + uni[0].length;
        } else if (oct) {
          text += String.fromCharCode(parseInt(oct[1], 8));
          j += 1 + oct[0].length;
        } else {
          const n = src[j + 1];
          text += ANSI_C_ESCAPES[n] ?? n;
          j += 2;
        }
        continue;
      }
      text += src[j++];
    }
    if (j >= src.length) this.giveUp("an unterminated quote");
    this.add(text, true);
    return Math.min(j, src.length - 1);
  }

  dollar(j: number, quoted: boolean): number {
    const src = this.src;
    const n = src[j + 1];
    if (this.dialect === "bash" && n === '"' && !quoted) return this.double(j + 1); // $"…" 按普通双引号算
    if (n === "(") {
      const close = matchClose(src, j + 1, "(", ")", this.dialect);
      if (close < 0) {
        this.giveUp("an unterminated $( … )");
        this.dyn(src.slice(j), quoted);
        return src.length - 1;
      }
      if (this.dialect === "bash" && src[j + 2] === "(" && src[close - 1] === ")") {
        this.dyn("$((…))", quoted); // 算术展开
        return close;
      }
      this.subst(src.slice(j + 2, close), quoted);
      return close;
    }
    if (n === "{") {
      const close = matchClose(src, j + 1, "{", "}", this.dialect);
      if (close < 0) {
        this.giveUp("an unterminated ${ … }");
        this.dyn(src.slice(j), quoted);
        return src.length - 1;
      }
      this.dyn(src.slice(j, close + 1), quoted);
      return close;
    }
    const rest = src.slice(j + 1, j + 80);
    const name = this.dialect === "powershell"
      ? /^(?:[A-Za-z_]\w*(?::[A-Za-z_]\w*)?|[?$^_])/.exec(rest)
      : /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(rest);
    if (!name) {
      this.add("$", quoted);
      return j;
    }
    const lit = "$" + name[0];
    if (this.dialect === "powershell" && /^\$(?:true|false|null)$/i.test(lit)) this.add(lit, quoted);
    else this.dyn(lit, quoted);
    return j + name[0].length;
  }

  // cmd 的 %VAR%、for 变量 %%i、参数 %1 / %~dp0
  percent(j: number, quoted: boolean): number {
    const m = /^%(?:[^%\s]+%|%?~?[A-Za-z0-9])/.exec(this.src.slice(j, j + 80));
    if (!m) {
      this.add("%", quoted);
      return j;
    }
    this.dyn(m[0], quoted);
    return j + m[0].length - 1;
  }

  backtick(j: number, quoted: boolean): number {
    const src = this.src;
    let k = j + 1;
    let inner = "";
    while (k < src.length && src[k] !== "`") {
      if (src[k] === "\\" && k + 1 < src.length && /[`\\$]/.test(src[k + 1])) {
        inner += src[k + 1];
        k += 2;
        continue;
      }
      inner += src[k++];
    }
    if (k >= src.length) this.giveUp("an unterminated backtick");
    this.subst(inner, quoted);
    return Math.min(k, src.length - 1);
  }

  redirection(i: number): number {
    const src = this.src;
    const ch = src[i];
    const bash = this.dialect === "bash";
    if (bash && src[i + 1] === "(") {
      // 进程替换 <(…) >(…)：里面的命令也在本机跑，这个词本身是个 /dev/fd 路径
      const close = matchClose(src, i + 1, "(", ")", this.dialect);
      if (close < 0) {
        this.giveUp("an unterminated process substitution");
        return src.length - 1;
      }
      this.subst(src.slice(i + 2, close), false);
      return close;
    }
    // 紧贴在前面的纯数字词是 fd（2>、2>>）；PowerShell 还有 *>
    let fd = "";
    const w = this.word;
    if (w && !w.quoted && (/^\d+$/.test(w.text) || (this.dialect === "powershell" && w.text === "*"))) {
      fd = w.text;
      this.word = null;
    } else {
      this.endWord();
    }
    let op = ch;
    let j = i + 1;
    if (ch === ">") {
      if (src[j] === ">") op += src[j++];
      else if (bash && src[j] === "|") op += src[j++];
      if (src[j] === "&") op += src[j++];
    } else if (bash && src[j] === "<") {
      op += src[j++];
      if (src[j] === "<" || src[j] === "-") op += src[j++];
    } else if (src[j] === ">" || src[j] === "&") {
      op += src[j++];
    }
    if (this.redirect) this.giveUp("two redirections in a row");
    this.redirect = { op: fd + op, heredoc: op === "<<" || op === "<<-" };
    return j - 1;
  }
}

function newSeg(pipedIn: boolean): RawSeg {
  return { words: [], redirects: [], raw: "", pipedIn, callOp: false, heredocs: [] };
}

const ANSI_C_ESCAPES: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v",
};

// 从 open 处的开括号找到配对的闭括号（跳过引号与转义）；找不到返回 -1。
function matchClose(src: string, open: number, o: string, c: string, dialect: ShellDialect): number {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const ch = src[k];
    if ((dialect === "bash" && ch === "\\") || (dialect === "powershell" && ch === "`") || (dialect === "cmd" && ch === "^")) {
      k++;
      continue;
    }
    if ((ch === "'" && dialect !== "cmd") || ch === '"' || (dialect === "bash" && ch === "`")) {
      k = skipQuoted(src, k, dialect);
      if (k < 0) return -1;
      continue;
    }
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return k;
  }
  return -1;
}

function skipQuoted(src: string, k: number, dialect: ShellDialect): number {
  const q = src[k];
  for (let j = k + 1; j < src.length; j++) {
    const ch = src[j];
    if (q !== "'" && dialect === "bash" && ch === "\\") {
      j++;
      continue;
    }
    if (q === '"' && dialect === "powershell" && ch === "`") {
      j++;
      continue;
    }
    if (ch === q) {
      if (dialect === "powershell" && src[j + 1] === q) {
        j++;
        continue;
      }
      return j;
    }
  }
  return -1;
}

// ── 命令位：关键字、赋值、包装器 ───────────────────────────────────────────────

// 命令位上剥掉就是命令的关键字（`if grep …`、`then rm …`、`! cmd`、`{ cmd; }`、`time cmd`）
const BASH_STRIP = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "esac"]);
// 这一段不是命令（它的命令在别的段里）：`for x in …`、`case $x in`、`function f`
const BASH_SKIP = new Set(["for", "case", "select", "function"]);
const PS_SKIP = new Set([
  "if", "elseif", "else", "foreach", "for", "while", "do", "until", "try", "catch", "finally", "switch",
  "function", "filter", "trap", "param", "begin", "process", "end", "class", "enum", "using",
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

function emit(words: ShellWord[], seg: RawSeg, dialect: ShellDialect, ctx: Ctx, depth: number, chain: string[], dynamic: boolean): void {
  let ws = words;
  let raw = seg.raw;
  for (;;) {
    const head = ws[0];
    if (!head || head.leadQuoted) break;
    const t = head.text;
    if (dialect === "bash") {
      if (BASH_SKIP.has(t)) return;
      if (BASH_STRIP.has(t)) {
        // 关键字从子命令原文里也去掉：`then rm -rf x` 的规则主体是 `rm -rf x`（赋值不去——它会改变命令的行为）
        if (raw.startsWith(t)) raw = raw.slice(t.length).trimStart();
        ws = ws.slice(1);
        continue;
      }
      if (ASSIGNMENT.test(t)) {
        ws = ws.slice(1);
        continue;
      }
    } else if (dialect === "powershell") {
      if (PS_SKIP.has(t.toLowerCase())) return;
      if (t === ".") {
        ws = ws.slice(1); // dot-source
        continue;
      }
      if (t.startsWith("$") && ws[1] && /^[-+*/%]?=$|^\?\?=$/.test(ws[1].text)) {
        ws = ws.slice(2); // $x = <pipeline>
        continue;
      }
    } else {
      if (t.startsWith("@")) {
        ws = t.length > 1 ? [{ ...head, text: t.slice(1) }, ...ws.slice(1)] : ws.slice(1); // @echo off
        continue;
      }
      const l = t.toLowerCase();
      if (l === "if" || l === "for") return giveUp(ctx, `cmd.exe ${l} blocks are not analyzed`);
    }
    break;
  }
  if (raw !== seg.raw) seg = { ...seg, raw }; // 包装器里的命令也用去掉关键字后的原文
  const push = (name: string, list: ShellWord[]) =>
    ctx.out.push({
      name,
      argv: list.map((w) => w.text),
      words: list,
      raw,
      dynamic: dynamic || list.some((w) => w.dynamic),
      redirects: seg.redirects,
      wrappers: chain,
      dialect,
      ...(seg.pipedIn ? { pipedIn: true } : {}),
      ...(seg.heredocs.length ? { heredoc: true } : {}),
    });
  if (!ws.length) {
    if (seg.redirects.length) push("", []); // 光有重定向：`> file` 也是一次写
    return;
  }
  const head = ws[0];
  // PowerShell 里命令位上是变量、字符串、数字的是表达式，不是命令（`$x | Remove-Item`、`"…" -f $a`）
  if (dialect === "powershell" && !seg.callOp && (head.leadQuoted || head.dynamic || /^[\d@[]/.test(head.text))) return;
  if (head.dynamic) {
    giveUp(ctx, "the program name is only known at run time");
    push("", ws);
    return;
  }
  if (dialect === "cmd") {
    // cmd 允许开关贴着命令名：rd/s/q x
    const glued = /^(rd|rmdir|del|erase)((?:\/[^/\s]+)+)$/i.exec(head.text);
    if (glued) ws = [{ ...head, text: glued[1] }, ...glued[2].split(/(?=\/)/).map((s) => ({ ...head, text: s })), ...ws.slice(1)];
  }
  const name = programName(ws[0].text);
  if (unwrap(name, ws, seg, dialect, ctx, depth, chain, dynamic)) return;
  push(name, ws);
}

function programName(text: string): string {
  const parts = text.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").toLowerCase().replace(/\.(?:exe|com|cmd|bat)$/, "");
}

const WRAPPERS = new Set([
  "sudo", "doas", "su", "env", "command", "builtin", "nohup", "unbuffer", "setsid", "winpty", "exec", "nice",
  "ionice", "timeout", "stdbuf", "time", "xargs", "busybox", "watch", "eval", "invoke-expression", "iex", "call",
  "bash", "sh", "zsh", "dash", "ksh", "ash", "mksh", "cmd", "powershell", "pwsh",
]);
const SUDO_VALUE = new Set([
  "-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T",
  "--user", "--group", "--close-from", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--command-timeout",
]);
const XARGS_VALUE = new Set([
  "-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--replace",
  "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var",
]);
const PS_VALUE_PARAMS = [
  "executionpolicy", "windowstyle", "inputformat", "outputformat", "version", "psconsolefile",
  "configurationname", "workingdirectory", "custompipename", "settingsfile",
];
const PS_VALUE_ALIASES = new Set(["ex", "ep", "exec", "w", "wi", "if", "in", "inp", "of", "o", "ou", "out", "v", "ve", "ver", "wd", "wo", "config", "ps", "psc"]);

// 跳过前导选项（valueOpts 里的选项连同它的值一起跳），返回剩下的词。`--` 之后全是参数。
function skipOptions(args: ShellWord[], valueOpts: Set<string> = new Set()): ShellWord[] {
  let k = 0;
  while (k < args.length) {
    const w = args[k];
    if (w.leadQuoted || !w.text.startsWith("-") || w.text === "-") break;
    if (w.text === "--") return args.slice(k + 1);
    k += valueOpts.has(w.text) ? 2 : 1;
  }
  return args.slice(k);
}

function splitWord(w: ShellWord): ShellWord[] {
  return w.text.split(/\s+/).filter(Boolean).map((text) => ({ ...w, text }));
}

function decodeUtf16Base64(text: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const s = Buffer.from(text, "base64").toString("utf16le");
  return s && !s.includes("\uFFFD") ? s : null;
}

const WORD = (text: string): ShellWord => ({ text, dynamic: false, subst: false, glob: false, leadQuoted: false });

// 包装器：剥掉它，把后面真正跑的命令再判一遍（包装器记进 wrappers）。返回 true = 已经替它产出了命令。
function unwrap(
  name: string,
  ws: ShellWord[],
  seg: RawSeg,
  dialect: ShellDialect,
  ctx: Ctx,
  depth: number,
  chain: string[],
  dynamic: boolean,
): boolean {
  if (!WRAPPERS.has(name)) return false;
  if (depth >= MAX_DEPTH) {
    giveUp(ctx, "wrappers are nested too deeply to analyze");
    return false;
  }
  const args = ws.slice(1);
  const inner = (rest: ShellWord[], label = name, extraDynamic = dynamic, s = seg): boolean => {
    if (!rest.length) return false; // 后面没东西：它自己就是命令（sudo -v、env、exec 3>f）
    emit(rest, s, dialect, ctx, depth + 1, [...chain, label], extraDynamic);
    return true;
  };
  // 把一串词拼回脚本再解析（bash -c、eval、cmd /c、powershell -Command）。外层 shell 先把变量值拼进脚本文本，
  // 里层再重新分词——值里带个 `;` 就是另一条命令，所以拼了运行时值的脚本串算分析不了（仍尽力解析）。
  const script = (parts: ShellWord[], d: ShellDialect, label: string): boolean => {
    if (parts.some((w) => w.dynamic)) giveUp(ctx, `${label} ${SPLICED_AT_RUN_TIME}`);
    parseScript(parts.map((w) => w.text).join(" "), d, ctx, depth + 1, [...chain, label], dynamic);
    return true;
  };
  switch (name) {
    case "sudo":
    case "doas":
      return inner(skipOptions(args, SUDO_VALUE));
    case "su": {
      const k = args.findIndex((w) => w.text === "-c" || w.text === "--command");
      return k >= 0 && args[k + 1] ? script([args[k + 1]], "bash", "su -c") : false;
    }
    case "env": {
      const split: ShellWord[] = [];
      let k = 0;
      for (; k < args.length; k++) {
        const w = args[k];
        const t = w.text;
        if (w.leadQuoted || !t.startsWith("-") || t === "-") break;
        if (t === "--") {
          k++;
          break;
        }
        if (t === "-S" || t === "--split-string") {
          const s = args[++k];
          if (s) split.push(...splitWord(s));
        } else if (t.startsWith("--split-string=")) {
          split.push(...splitWord({ ...w, text: t.slice("--split-string=".length) }));
        } else if (t.startsWith("-S")) {
          split.push(...splitWord({ ...w, text: t.slice(2) }));
        } else if (t === "-u" || t === "--unset" || t === "-C" || t === "--chdir") {
          k++;
        }
      }
      while (k < args.length && !args[k].leadQuoted && ASSIGNMENT.test(args[k].text)) k++;
      return inner([...split, ...args.slice(k)]);
    }
    case "command":
      if (args[0] && /^-[pvV]*[vV]/.test(args[0].text)) return false; // command -v：只是查找
      return inner(skipOptions(args));
    case "builtin":
    case "nohup":
    case "unbuffer":
    case "setsid":
    case "winpty":
      return inner(skipOptions(args));
    case "call":
      return dialect === "cmd" ? inner(args) : false;
    case "exec":
      return inner(skipOptions(args, new Set(["-a"])));
    case "nice":
      return inner(skipOptions(args, new Set(["-n", "--adjustment"])));
    case "ionice":
      if (args.some((w) => /^-(?:[pPu]|-pid|-pgid|-uid)$/.test(w.text))) return false;
      return inner(skipOptions(args, new Set(["-c", "-n", "--class", "--classdata"])));
    case "timeout":
      return inner(skipOptions(args, new Set(["-s", "-k", "--signal", "--kill-after"])).slice(1)); // 再跳过时长
    case "stdbuf":
      return inner(skipOptions(args, new Set(["-i", "-o", "-e", "--input", "--output", "--error"])));
    case "time": {
      // bash 的 time 关键字与 /usr/bin/time；后者的 -o FILE 是一次写
      const at = args.findIndex((w) => w.text === "-o" || w.text === "--output");
      const eq = args.find((w) => w.text.startsWith("--output="));
      const target = at >= 0 ? args[at + 1]?.text : eq?.text.slice("--output=".length);
      const s = target ? { ...seg, redirects: [...seg.redirects, { op: ">", target, dynamic: false }] } : seg;
      return inner(skipOptions(args, new Set(["-f", "-o", "--format", "--output"])), name, dynamic, s);
    }
    case "xargs": {
      const rest = skipOptions(args, XARGS_VALUE);
      return inner(rest.length ? rest : [WORD("echo")], "xargs", true); // 参数从 stdin 来
    }
    case "busybox":
      return inner(args);
    case "watch": {
      const exec = args.some((w) => w.text === "-x" || w.text === "--exec");
      const rest = skipOptions(args, new Set(["-n", "--interval", "-q", "--equexit"]));
      if (!rest.length) return false;
      return exec ? inner(rest) : script(rest, "bash", "watch");
    }
    case "eval":
      return dialect === "bash" && args.length > 0 && script(args, "bash", "eval");
    case "invoke-expression":
    case "iex":
      return dialect === "powershell" && args.length > 0 && script(args, "powershell", "Invoke-Expression");
    case "bash":
    case "sh":
    case "zsh":
    case "dash":
    case "ksh":
    case "ash":
    case "mksh": {
      let k = 0;
      let c = false;
      for (; k < args.length; k++) {
        const w = args[k];
        const t = w.text;
        if (w.leadQuoted) break;
        if (t === "--" || t === "-") {
          k++;
          break;
        }
        if (/^[-+][oO]$/.test(t) || t === "--rcfile" || t === "--init-file") {
          k++;
          continue;
        }
        if (/^-[A-Za-z]+$/.test(t)) {
          if (t.includes("c")) c = true;
          continue;
        }
        if (/^--[\w-]+$/.test(t) || /^\+[A-Za-z]+$/.test(t)) continue;
        break;
      }
      if (c) return args[k] ? script([args[k]], "bash", `${name} -c`) : false;
      if (k < args.length) return false; // `bash build.sh`：脚本文件，看不见里面
      if (seg.heredocs.length) {
        // 脚本从 here-document 来
        for (const h of seg.heredocs) parseScript(h.body, "bash", ctx, depth + 1, [...chain, name], dynamic);
        return true;
      }
      if (seg.pipedIn) giveUp(ctx, `${name} reads its script from a pipe`);
      return false;
    }
    case "cmd": {
      const k = args.findIndex((w) => /^\/\/?[ckCK]$/.test(w.text));
      return k >= 0 && script(args.slice(k + 1), "cmd", "cmd /c");
    }
    case "powershell":
    case "pwsh": {
      for (let k = 0; k < args.length; k++) {
        const w = args[k];
        if (w.text === "-") {
          giveUp(ctx, `${name} reads its script from stdin`);
          return false;
        }
        const m = /^[-/]([A-Za-z]+)(?::.*)?$/.exec(w.text);
        if (!m || w.leadQuoted) return script(args.slice(k), "powershell", name); // 第一个非选项起全是命令
        const p = m[1].toLowerCase();
        if (p === "c" || (p.length > 2 && "command".startsWith(p))) {
          return script(args.slice(k + 1), "powershell", `${name} -Command`);
        }
        if (p === "e" || p === "ec" || (p.length > 1 && "encodedcommand".startsWith(p))) {
          const b = args[k + 1];
          const decoded = b && !b.dynamic ? decodeUtf16Base64(b.text) : null;
          if (decoded === null) {
            giveUp(ctx, `${name} -EncodedCommand could not be decoded`);
            return false;
          }
          return script([{ ...WORD(decoded) }], "powershell", `${name} -EncodedCommand`);
        }
        if ("file".startsWith(p)) return false; // 脚本文件
        if (PS_VALUE_ALIASES.has(p) || (p.length >= 3 && PS_VALUE_PARAMS.some((o) => o.startsWith(p)))) k++;
      }
      return false;
    }
  }
  return false;
}
