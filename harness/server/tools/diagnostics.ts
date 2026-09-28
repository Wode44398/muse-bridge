import { spawn } from "node:child_process";
import path from "node:path";
import { killTree } from "./bash.ts";
import { helperEnv } from "../helper-proc.ts";
import { stripTypeScriptTypes } from "node:module";

// Post-save syntax diagnostics: catch breakage the moment it lands so the model
// fixes it next turn instead of discovering it at test time. Syntax-level
// checks only, fast and zero-config — builds/tests remain the model's job.
// Never throws; resolves null when clean, unknown, or no checker applies.

const PY_TIMEOUT_MS = 5_000;
const MAX_DIAG_CHARS = 1_200;

export async function diagnose(abs: string, content: string): Promise<string | null> {
  try {
    switch (path.extname(abs).toLowerCase()) {
      case ".json":
        return checkJson(content);
      // JSX/TSX excluded — different grammar, the stripper rejects it.
      case ".js":
      case ".mjs":
      case ".cjs":
      case ".ts":
      case ".mts":
      case ".cts":
        return checkJsTs(content);
      case ".py":
        return await checkPython(abs);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function checkJson(content: string): string | null {
  try {
    JSON.parse(content);
    return null;
  } catch (e) {
    return clip(`JSON parse error: ${(e as Error).message}`);
  }
}

// In-process parse via Node's TS type-stripper (SWC). Plain JS is valid TS, so
// one checker covers .js and .ts. Constructs that need transform mode (enum,
// namespace) fail strip with UNSUPPORTED; retry transformed so only genuine
// syntax errors surface.
function checkJsTs(content: string): string | null {
  try {
    stripTypeScriptTypes(content);
    return null;
  } catch (e: any) {
    if (e?.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
      try {
        stripTypeScriptTypes(content, { mode: "transform" });
        return null;
      } catch (e2: any) {
        return e2?.code === "ERR_INVALID_TYPESCRIPT_SYNTAX" ? formatJsError(e2) : null;
      }
    }
    return e?.code === "ERR_INVALID_TYPESCRIPT_SYNTAX" ? formatJsError(e) : null;
  }
}

// The SWC error's stack begins with a code frame (":<line>", offending source,
// a caret) before the JS stack frames — keep the frame, drop the frames.
function formatJsError(e: any): string {
  const stack = String(e?.stack ?? "");
  const cut = stack.search(/\n\s+at /);
  const frame = (cut === -1 ? stack : stack.slice(0, cut)).trim();
  const msg = String(e?.message ?? "syntax error");
  return clip(frame.includes(msg) ? frame : `${msg}\n${frame}`);
}

let pythonCmd: string | null | undefined; // undefined = not probed yet

async function checkPython(abs: string): Promise<string | null> {
  if (pythonCmd === undefined) pythonCmd = await probePython();
  if (!pythonCmd) return null;
  const res = await run(pythonCmd, [
    "-c",
    "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read(), sys.argv[1])",
    abs,
  ]);
  if (!res || res.code === 0) return null;
  // Only report parse-level failures; a broken python install stays silent.
  if (!/SyntaxError|IndentationError|TabError/.test(res.output)) return null;
  return clip(res.output.trim());
}

async function probePython(): Promise<string | null> {
  for (const cmd of ["python", "python3"]) {
    const r = await run(cmd, ["--version"]);
    if (r && r.code === 0) return cmd;
  }
  return null;
}

function run(
  cmd: string,
  args: string[],
): Promise<{ code: number | null; output: string } | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, env: helperEnv() }); // S7：env 去敏
    } catch {
      return resolve(null);
    }
    let output = "";
    const cap = (b: Buffer) => {
      if (output.length < 8_000) output += b.toString();
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    // 同上：python 自己可能再拉子进程，plain kill 只打得到 python.exe。
    const timer = setTimeout(() => killTree(child), PY_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

// Tail-clip: the decisive line of a traceback/frame sits at the end.
function clip(s: string): string {
  return s.length > MAX_DIAG_CHARS ? "…" + s.slice(-MAX_DIAG_CHARS) : s;
}
