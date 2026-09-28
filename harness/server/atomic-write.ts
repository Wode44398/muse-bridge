import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// M6（#25）：统一原子写原语。以前各处各写各的：固定的 `${file}.tmp` 临时名、不串行、不 fsync——同一个
// 会话的两次保存（防抖定时器那次 + 收尾那次）重叠时，两边往同一个 .tmp 写、各自 rename，实测 30 轮里
// 会话文件消失 9 次；断电则可能留下全零文件（生产上 d2341d9d 就是 246KB 全零）。
// 现在：唯一临时名 + 同一路径的异步写入排队串行 + 写完 fsync 再 rename（Windows 上 rename 撞到别的
// 进程正开着目标文件会报 EPERM/EBUSY，短暂重试）。同步版本给启动期 / 同步调用方用：同一进程里同步写
// 本来就不会交错，只需唯一临时名 + fsync。

const chains = new Map<string, Promise<void>>();
const keyOf = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file));
const tmpFor = (file: string) => `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
const RENAME_RETRIES = [30, 80, 200];

// mode：给临时文件设的权限位（POSIX；U5 替用户文件保留原权限用）。
export function atomicWriteFile(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const key = keyOf(file);
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => writeNow(file, data, mode));
  chains.set(key, next);
  const settle = () => {
    if (chains.get(key) === next) chains.delete(key);
  };
  next.then(settle, settle);
  return next;
}

async function writeNow(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpFor(file);
  try {
    const fh = await fsp.open(tmp, "w");
    try {
      if (mode !== undefined) await fh.chmod(mode);
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= RENAME_RETRIES.length || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
        await new Promise((r) => setTimeout(r, RENAME_RETRIES[attempt]));
      }
    }
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

// U5（ZCode C7）：Edit / Write 改用户的文件也走「临时文件 + rename」——写到一半断电、磁盘满、进程被杀，原文件要么是
// 旧的、要么是新的，不会只剩半截。比上面的原语多几条只有用户文件才有的讲究：
//   · 目标是符号链接：写到它指向的真文件（直接 rename 会把链接换成一个普通文件）；悬空的链接照旧原地写。
//   · 还有别的硬链接（nlink > 1）：原地写（rename 会把这个名字从链接组里拆出去，另一个名字就看不到改动了）。
//   · rename 重试完仍被占着（别的进程开着它、不许删除）：退回原地写——不比以前差。
//   · realpath 在 Windows 上顺带拿到磁盘上的大小写：模型写 readme.md 时，README.md 不会被悄悄改成小写。
//   · POSIX 上保留原来的权限位。
// 返回实际走的是哪条路（测试与排查用）。
export async function writeUserFile(file: string, data: string | Uint8Array): Promise<"atomic" | "in-place"> {
  let target = file;
  let mode: number | undefined;
  let existed = false;
  const present = await fsp.lstat(file).catch(() => null);
  if (present) {
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
      target = await fsp.realpath(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await fsp.writeFile(file, data); // 悬空的符号链接：和以前一样顺着链接写
      return "in-place";
    }
    existed = true;
    if (!st.isFile() || st.nlink > 1) {
      // 管道 / 设备这类特殊文件，或有别的硬链接：原地写
      await fsp.writeFile(target, data);
      return "in-place";
    }
    if (process.platform !== "win32") mode = st.mode & 0o7777;
  }
  try {
    await atomicWriteFile(target, data, mode);
    return "atomic";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (!existed || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
    await fsp.writeFile(target, data);
    return "in-place";
  }
}

export function atomicWriteFileSync(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpFor(file);
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
