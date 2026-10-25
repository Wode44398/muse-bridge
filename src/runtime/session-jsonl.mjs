// transcript（jsonl）的增量读取小工具（2026-10-21）：/api/session 的历史重建缓存（routes/sessions.mjs）与会话信息面板的
// 「输出内容」（session-outputs.mjs）共用。jsonl 只追加，所以这两处都记住「消化到哪个字节」，文件变长只读新增的完整行；
// 已消化部分末尾的几十个字节用来认「是不是被改写过」（改写了就整份重来）。
import { promises as fsp } from 'node:fs';

const CHUNK = 1 << 20;
export const TAIL_BYTES = 64;

/**
 * [start, end) 里以 \n 结尾的完整行逐个交给 onLine(Buffer，只在回调里有效)，返回最后一个完整行之后的位置。
 * 末尾没换行的那一截：本身已是一个完整的 JSON（文件最后一行没写换行）就照样算一行、位置推到 end——之后文件再长，
 * 从这里读到的第一行是个空行，自然跳过；解析不了的半行（CLI 正在写）不算，留给下一次。
 * 1MB 一块，块与块之间 await 读盘，自然让出事件循环。
 */
export async function readJsonlLines(file, start, end, onLine) {
  if (end <= start) return start;
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = start, carry = null, done = start;
    while (pos < end) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, end - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      let chunk = buf.subarray(0, bytesRead);
      if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
      let s = 0, nl;
      while ((nl = chunk.indexOf(10, s)) >= 0) { onLine(chunk.subarray(s, nl)); s = nl + 1; }
      done = pos - (chunk.length - s);
      if (s < chunk.length) carry = Buffer.from(chunk.subarray(s));
    }
    if (carry && pos >= end) {
      let whole = false;
      try { JSON.parse(lineStr(carry)); whole = true; } catch {}
      if (whole) { onLine(carry); done = end; }
    }
    return done;
  } finally { await fh.close().catch(() => {}); }
}

/** 一行的文本（去掉 \r）。 */
export const lineStr = (b) => (b.length && b[b.length - 1] === 13 ? b.subarray(0, b.length - 1) : b).toString('utf8');
/** 一行解析成对象；不是合法 JSON 回 null。 */
export const lineObj = (b) => { try { return JSON.parse(lineStr(b)); } catch { return null; } };

/** off 之前的最后 TAIL_BYTES 个字节（续读前核对「已消化部分没被改写」）。 */
export async function readTail(file, off) {
  const len = Math.min(TAIL_BYTES, off);
  if (len <= 0) return Buffer.alloc(0);
  const fh = await fsp.open(file, 'r');
  try { const b = Buffer.alloc(len); const { bytesRead } = await fh.read(b, 0, len, off - len); return b.subarray(0, bytesRead); }
  finally { await fh.close().catch(() => {}); }
}
