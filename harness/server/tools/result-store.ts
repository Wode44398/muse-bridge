// R13（B1）：大结果落盘。以前 Bash 只留头 5K + 尾 25K、WebFetch 只留前 6 万字，被截掉的中段永久丢失——一次完整测试输出、
// 一次大 diff、一页长文档，模型想回头看只能重跑。现在截断之前把全文（先脱敏）存进会话自己的 outputs 目录，截断提示里写明
// 在哪、怎么读；微压缩清掉的旧工具输出也先存一份，占位里给路径（以前只能「重跑工具」）。
// 落点：sessionsDir()/outputs/<会话 id>/，沙箱对本会话这个目录开只读豁免（与压缩归档同一个口子），删会话时一并删。
// 不在工作区里，所以不进检查点快照。单个文件封顶 20 MB。
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sessionsDir } from "../paths.ts";

const SESSION_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
export const PERSIST_MAX_BYTES = 20_000_000;
const FLUSH_CHARS = 64_000;
const PEM_HOLD_CHARS = 1_000_000; // 没闭合的私钥块最多等这么多再写（不然跨块切开就脱不了敏）

export function outputsDir(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
  return path.join(sessionsDir(), "outputs", sessionId);
}

function newFile(sessionId: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "output";
  return path.join(outputsDir(sessionId), `${safe}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}.txt`);
}

const capped = (text: string): string => {
  if (Buffer.byteLength(text, "utf8") <= PERSIST_MAX_BYTES) return text;
  return `${Buffer.from(text, "utf8").subarray(0, PERSIST_MAX_BYTES).toString("utf8")}\n…[not saved beyond ${PERSIST_MAX_BYTES / 1_000_000} MB]\n`;
};

// 一次写完的全文（调用方已经脱过敏）。没有会话或写不成返回 null——调用方照旧截断，只是没有回查路径。
export function persistOutput(sessionId: string | undefined, name: string, text: string): string | null {
  if (!sessionId) return null;
  try {
    const file = newFile(sessionId, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, capped(text), "utf8");
    return file;
  } catch {
    return null;
  }
}

// 边流边写（Bash）：按块缓冲、切在换行处、过 transform（脱敏）再写；没闭合的 PEM 私钥块等它闭合再写。
export class OutputSpill {
  readonly file: string;
  private readonly stream: fs.WriteStream;
  private readonly transform: (text: string) => string;
  private pending = "";
  private written = 0;
  private full = false;
  private failed = false;

  // （Node 的去类型模式不支持构造参数属性，字段照常声明）
  constructor(sessionId: string, name: string, transform: (text: string) => string) {
    this.transform = transform;
    this.file = newFile(sessionId, name);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.stream = fs.createWriteStream(this.file, { encoding: "utf8" });
    this.stream.on("error", () => {
      this.failed = true;
    });
  }

  write(chunk: string): void {
    this.pending += chunk;
    if (this.pending.length >= FLUSH_CHARS) this.flush(false);
  }

  private flush(final: boolean): void {
    if (this.full || this.failed || !this.pending) return;
    let cut = final ? this.pending.length : this.pending.lastIndexOf("\n") + 1;
    if (!final) {
      const begin = this.pending.lastIndexOf("-----BEGIN", cut);
      if (begin >= 0 && this.pending.indexOf("-----END", begin) < 0 && this.pending.length < PEM_HOLD_CHARS) {
        cut = this.pending.lastIndexOf("\n", begin) + 1;
      }
    }
    if (cut <= 0) return;
    let piece = this.transform(this.pending.slice(0, cut));
    this.pending = this.pending.slice(cut);
    const bytes = Buffer.byteLength(piece, "utf8");
    if (this.written + bytes > PERSIST_MAX_BYTES) {
      piece = `${Buffer.from(piece, "utf8").subarray(0, Math.max(0, PERSIST_MAX_BYTES - this.written)).toString("utf8")}\n…[not saved beyond ${PERSIST_MAX_BYTES / 1_000_000} MB]\n`;
      this.full = true;
    }
    this.written += bytes;
    this.stream.write(piece);
  }

  // 写完并关上；返回文件路径（写失败返回 null）。
  async end(): Promise<string | null> {
    this.flush(true);
    await new Promise<void>((resolve) => this.stream.end(resolve));
    return this.failed ? null : this.file;
  }
}

// 删会话时调用。它的后台 Bash 刚被杀、落盘流可能还没关上（Windows 上目录里有开着的文件删不掉）：重试几次，删不掉也不抛
// ——别让删会话因为这个失败。
export async function deleteSessionOutputs(sessionId: string): Promise<void> {
  if (!SESSION_ID_RE.test(sessionId)) return;
  try {
    await fs.promises.rm(outputsDir(sessionId), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.error(`[outputs] could not remove the saved outputs of session ${sessionId}: ${(e as Error).message}`);
  }
}

// 截断提示里的回查说明（Bash、WebFetch、微压缩占位共用一个口径）
export function savedHint(file: string, chars: number): string {
  return `the full output (${chars} chars) is saved at ${file} — Read it with offset/limit or Grep it instead of re-running`;
}
