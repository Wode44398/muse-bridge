import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";

// #97：Windows 上的原生控制台程序（ping、ipconfig、netstat、tasklist、cl.exe、PowerShell 5.1 往管道里写的输出、cmd 的
// 报错……）按系统代码页编码，中文 Windows 上是 GBK（936）。以前一律按 UTF-8 解，模型拿到的中文全是乱码
//（「来自 127.0.0.1 的回复」变成一串 �）。现在：
//   - 按行解：每行先严格按 UTF-8 解，解不通（不是合法 UTF-8）再严格按 GBK 解，还不通才退回有损的 UTF-8。
//     同一条命令里 bash 的 UTF-8 输出和原生程序的 GBK 输出混在一起也各解各的。
//   - 没收完的半行：已经是合法 UTF-8 的前缀当场交出去（提示符、进度条照旧实时可见），只扣下末尾没收全的那个字符；
//     不是合法 UTF-8 的（多半是 GBK）等到换行再解，攒过 4 KB 也照样解掉。
// 非 Windows 平台照旧用 StringDecoder（那里的控制台程序本来就是 UTF-8）。

const HOLD_LIMIT = 4096;
const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const utf8Lossy = new TextDecoder("utf-8");
const gbkStrict: TextDecoder | null = (() => {
  try {
    return new TextDecoder("gbk", { fatal: true });
  } catch {
    return null; // 没带 ICU 的 Node：只能退回 UTF-8
  }
})();

function strictUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return null;
  }
}

function strictGbk(bytes: Uint8Array): string | null {
  if (!gbkStrict || !bytes.length) return null;
  try {
    return gbkStrict.decode(bytes);
  } catch {
    return null; // 也不是 GBK：二进制或别的代码页
  }
}

export function decodeConsoleLine(bytes: Uint8Array): string {
  return strictUtf8(bytes) ?? strictGbk(bytes) ?? utf8Lossy.decode(bytes);
}

// 一整块（以换行结尾）：整块是合法 UTF-8 就一次解完（绝大多数情况），否则逐行各解各的
function decodeBlock(bytes: Uint8Array): string {
  const whole = strictUtf8(bytes);
  if (whole !== null) return whole;
  let out = "";
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a || bytes[i] === 0x0d) {
      out += decodeConsoleLine(bytes.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < bytes.length) out += decodeConsoleLine(bytes.subarray(start));
  return out;
}

// 末尾那个 UTF-8 字符没收全时，切在它前面（0–3 个字节留到下一块）
function utf8SafeCut(b: Uint8Array): number {
  const len = b.length;
  let i = len - 1;
  while (i >= 0 && len - i < 4 && (b[i] & 0xc0) === 0x80) i--;
  if (i < 0) return len;
  const lead = b[i];
  if (lead < 0xc0) return len;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
  return len - i < need ? i : len;
}

export interface ConsoleDecoder {
  write(buf: Uint8Array): string;
  end(): string;
}

export function consoleDecoder(platform: NodeJS.Platform = process.platform): ConsoleDecoder {
  if (platform !== "win32") {
    const d = new StringDecoder("utf8");
    return { write: (buf) => d.write(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)), end: () => d.end() };
  }
  let pending: Uint8Array = new Uint8Array(0);
  return {
    write(buf) {
      if (pending.length) {
        const merged = new Uint8Array(pending.length + buf.length);
        merged.set(pending, 0);
        merged.set(buf, pending.length);
        pending = merged;
      } else {
        pending = buf;
      }
      let out = "";
      let lastBreak = -1;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i] === 0x0a || pending[i] === 0x0d) {
          lastBreak = i;
          break;
        }
      }
      if (lastBreak >= 0) {
        out += decodeBlock(pending.subarray(0, lastBreak + 1));
        pending = pending.subarray(lastBreak + 1);
      }
      if (pending.length) {
        const cut = utf8SafeCut(pending);
        const prefix = cut > 0 ? strictUtf8(pending.subarray(0, cut)) : null;
        if (prefix !== null) {
          out += prefix;
          pending = pending.subarray(cut);
        } else if (pending.length > HOLD_LIMIT) {
          // 攒过上限：多半是 GBK——按 GBK 的字符边界切（末尾可能剩半个 GBK 字，留到下一块），都不像才按 UTF-8 边界有损解
          const used = strictGbk(pending) !== null ? pending.length : strictGbk(pending.subarray(0, pending.length - 1)) !== null ? pending.length - 1 : 0;
          if (used) {
            out += strictGbk(pending.subarray(0, used))!;
            pending = pending.subarray(used);
          } else {
            out += decodeConsoleLine(pending.subarray(0, cut));
            pending = pending.subarray(cut);
          }
        }
      }
      // 留下的那一截拷出来，别让它拽着整块缓冲（Buffer 的 slice 不拷贝，这里用 Uint8Array 的拷贝构造）
      if (pending.length) pending = new Uint8Array(pending);
      return out;
    },
    end() {
      const rest = pending.length ? decodeConsoleLine(pending) : "";
      pending = new Uint8Array(0);
      return rest;
    },
  };
}
