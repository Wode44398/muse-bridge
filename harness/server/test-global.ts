// Q7（X46）+ K04：npm test 的全局收尾检查（经 --test-global-setup 挂载，跑在 node --test 的父进程里）。
//
// 测试隔离靠 test-setup.ts 改道 + paths.ts 解析点守卫，这里是第三道，兜「还没人想到的那一类」：
//   ① 受控文件不变：开跑前记下 harness/ 下的 git status（含未跟踪、不含已忽略）和这些文件的内容指纹，收尾比对。
//      测试改写或新建了受控文件就判整次失败——当初那条 memory/user-s-favorite-number.md 就是测试写出、被提交进库的；
//   ② 生产数据目录里不多出测试桶：memory/workspaces、knowledge/workspaces 下新出现的 dimensio-* 桶（测试临时目录一律
//      以 dimensio- 开头）。不做全量比对：同机另一个 harness 实例可能正往这里写真实工作区的桶。
// 另外开跑前清掉 24 小时前留下的测试临时目录：Windows 上句柄没放开时 rmSync 删不掉，日积月累攒了三千多个。
// 跑测试的同时别手动改 harness/ 下的文件，否则收尾会把你的改动当成测试写的。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HARNESS = path.resolve(import.meta.dirname, "..");
const BUCKET_DIRS = [path.join(HARNESS, "memory", "workspaces"), path.join(HARNESS, "knowledge", "workspaces")];
const TEST_BUCKET = /^dimensio-/i;
const STALE_MS = 24 * 3600_000;
const TEMP_FIXTURE = /^dimensio-[A-Za-z0-9-]*-[A-Za-z0-9]{6}$/; // mkdtemp 的 6 位随机后缀
const TEMP_KEEP = new Set(["dimensio-scratch", "dimensio-child-home"]); // 生产 harness 自己的固定目录

interface Snapshot {
  files: Map<string, string> | null; // null：不在 git 仓库里，跳过这一项
  buckets: Map<string, Set<string>>;
}

let before: Snapshot | null = null;

function git(args: string[]): string {
  // --no-optional-locks：只读，不顺手刷新 index（不和同仓库里别的 git 操作抢 index.lock）
  return execFileSync("git", ["--no-optional-locks", "-c", "core.quotepath=false", ...args], {
    cwd: HARNESS,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function fingerprint(abs: string): string {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return st.isDirectory() ? "dir" : "other";
    return createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return "missing";
  }
}

// harness/ 下 git 认为「不干净」的受控文件（修改、新增、删除、未跟踪；已忽略的不算）→ 状态码 + 内容指纹。
function dirtyFiles(): Map<string, string> | null {
  let top: string;
  let raw: string;
  try {
    top = git(["rev-parse", "--show-toplevel"]).trim();
    raw = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  } catch {
    return null;
  }
  const out = new Map<string, string>();
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // 改名 / 复制后面还跟着原路径
    out.set(rel, `${code}:${fingerprint(path.resolve(top, rel))}`);
  }
  return out;
}

function snapshot(): Snapshot {
  const buckets = new Map<string, Set<string>>();
  for (const dir of BUCKET_DIRS) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      /* 目录不存在 = 空 */
    }
    buckets.set(dir, new Set(names));
  }
  return { files: dirtyFiles(), buckets };
}

function sweepStaleTemp(): number {
  const tmp = os.tmpdir();
  let removed = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - STALE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || TEMP_KEEP.has(entry.name) || !TEMP_FIXTURE.test(entry.name)) continue;
    const abs = path.join(tmp, entry.name);
    try {
      if (fs.statSync(abs).mtimeMs > cutoff) continue;
      fs.rmSync(abs, { recursive: true, force: true });
      removed++;
    } catch {
      /* 还有句柄占着就下次再清 */
    }
  }
  return removed;
}

export async function globalSetup(): Promise<void> {
  const swept = sweepStaleTemp();
  if (swept) console.log(`[test-global] 清掉 ${swept} 个 24 小时前留下的测试临时目录`);
  before = snapshot();
}

export async function globalTeardown(): Promise<void> {
  if (!before) return;
  const after = snapshot();
  const problems: string[] = [];
  if (before.files && after.files) {
    for (const [rel, state] of after.files) {
      const was = before.files.get(rel);
      if (was === undefined) problems.push(`新出现的改动：${rel}（${state.slice(0, 2).trim() || "?"}）`);
      else if (was !== state) problems.push(`内容被改写：${rel}`);
    }
    for (const rel of before.files.keys()) {
      if (!after.files.has(rel)) problems.push(`开跑前的改动在跑完后不见了（被还原或删除）：${rel}`);
    }
  }
  for (const [dir, names] of after.buckets) {
    const was = before.buckets.get(dir) ?? new Set<string>();
    for (const name of names) {
      if (!was.has(name) && TEST_BUCKET.test(name)) problems.push(`生产数据目录里多出测试桶：${path.join(dir, name)}`);
    }
  }
  if (problems.length) {
    console.error("[test-global] 测试改动了受控文件或生产数据目录（本次运行判失败）：");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("  某个测试没有把写入改道到临时目录——见 server/test-setup.ts 与 server/paths.ts。");
    process.exitCode = 1;
  }
}
