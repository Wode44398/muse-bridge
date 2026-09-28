import { execFileSync } from "node:child_process";
import path from "node:path";
import { helperEnv, helperGitArgs } from "./helper-proc.ts";

// S9（#24）：/api/info 说清「这个进程跑的是哪版代码」。部署后 harness 没被重拉、仍跑旧代码，
// 或者冻住后被看门狗换过一次，一眼就能看出来：codeSha 是进程启动那一刻的 HEAD，dirty 表示
// 启动时 server/ 下有未提交改动（跑的代码与 codeSha 不完全一致），startedAt 是启动时间。
// 在模块加载（= 进程启动）时就算好——拖到第一次请求再算，中间有新提交就会报错版本。

export interface BuildInfo {
  codeSha: string | null;
  dirty: boolean | null;
  startedAt: number;
}

const HARNESS_DIR = path.resolve(import.meta.dirname, "..");

function git(args: string[]): string | null {
  try {
    return execFileSync("git", [...helperGitArgs(), ...args], {
      cwd: HARNESS_DIR,
      env: helperEnv(),
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function compute(): BuildInfo {
  const startedAt = Date.now();
  const sha = git(["rev-parse", "--short=12", "HEAD"]);
  const status = sha === null ? null : git(["status", "--porcelain", "--", "server"]);
  return { codeSha: sha || null, dirty: status === null ? null : status.length > 0, startedAt };
}

export const BUILD_INFO: Readonly<BuildInfo> = Object.freeze(compute());
