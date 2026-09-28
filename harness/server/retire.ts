// M8（K27 / N36）：两段式退役闸 + 优雅排空。
//
// 以前部署（test-admin.ps1 deploy / admin.ps1 restart-server）和 bridge 退出都直接 Stop-Process -Force /
// child.kill() 掉 harness——Windows 上就是 TerminateProcess，harness 的清理一行都不执行：在跑的轮被腰斩、
// 最后几秒的转录没落盘、后台 job 与 dev server 成了孤儿。施工期间要频繁部署，每次都会这样。现在：
//   · prepare：冻结新 run（/api/run 回 503），报告此刻还在跑的轮。冻结有期限（默认 15 分钟），发起部署的
//     脚本中途死掉，dimensio 也不会从此发不出消息；
//   · commit：排空——在跑的轮按「服务重启」中止（转录写明，不说成用户停的），全部会话立即落盘，收掉
//     job / dev server / 终端 / 浏览器，然后退出（bridge 下次有请求时照常拉起新进程）；
//   · cancel：解冻。
// 两条入口：bridge 走 HTTP（harness 令牌保护）；手里没有令牌的部署脚本写 sessions 目录下的
// retire.request.json——agent 写不进 sessions 目录（S7 的写保护），harness 每秒看一眼，状态写回
// retire.status.json。和 bridge 自更新分支的 GET /api/busy 同形（{ running }），合并时不打架。

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// 中止原因：loop 按它把被切断的一轮写成「服务重启」而不是「用户停止」。
export const RESTART_REASON = "server-restart";

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 2 * 60 * 60_000;

export interface Fence {
  token: string;
  since: number;
  expiresAt: number;
}
let fence: Fence | null = null;

export function retiring(now = Date.now()): boolean {
  if (fence && now >= fence.expiresAt) fence = null; // 过期自动解冻
  return fence !== null;
}

export function currentFence(): Fence | null {
  return retiring() ? fence : null;
}

// 已在冻结中再 prepare：同一个 token，期限只延不缩（重试的脚本不会把期限改短）。
export function prepareRetire(ttlMs: unknown = DEFAULT_TTL_MS, now = Date.now()): Fence {
  const ttl = Math.min(Math.max(Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS, 1_000), MAX_TTL_MS);
  if (retiring(now)) fence!.expiresAt = Math.max(fence!.expiresAt, now + ttl);
  else fence = { token: randomUUID(), since: now, expiresAt: now + ttl };
  return fence!;
}

export function cancelRetire(token?: unknown): boolean {
  if (!retiring()) return false;
  if (typeof token === "string" && token && token !== fence!.token) return false;
  fence = null;
  return true;
}

// ── 部署脚本的文件入口 ─────────────────────────────────────────────────────────
// 请求：{ action: "prepare" | "commit" | "cancel", ttlMs?, force?, requestedAt: epoch ms }。处理完就删；
// 比本进程启动还早的请求一律当过期删掉——否则上一次部署残留的 commit 会让新进程一起来就退出。

export const REQUEST_FILE = "retire.request.json";
export const STATUS_FILE = "retire.status.json";
const BOOTED_AT = Date.now();

export interface RetireRequest {
  action: "prepare" | "commit" | "cancel";
  ttlMs?: number;
  force?: boolean;
  requestedAt: number;
}

export function readRetireRequest(dir: string, bootedAt = BOOTED_AT): RetireRequest | null {
  const file = path.join(dir, REQUEST_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 删不掉下一轮再试；请求本身按时间戳判重 */
  }
  let raw: Partial<RetireRequest>;
  try {
    raw = JSON.parse(text.replace(/^﻿/, "")); // PowerShell 5.1 写文件爱带 BOM
  } catch {
    return null;
  }
  const at = Number(raw.requestedAt);
  if (!Number.isFinite(at) || at < bootedAt - 5_000) return null;
  if (raw.action !== "prepare" && raw.action !== "commit" && raw.action !== "cancel") return null;
  return { action: raw.action, ttlMs: raw.ttlMs, force: raw.force === true, requestedAt: at };
}

export function writeRetireStatus(dir: string, status: Record<string, unknown>): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, STATUS_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...status, pid: process.pid, updatedAt: Date.now() }));
    fs.renameSync(tmp, file);
  } catch {
    /* 状态文件只是给脚本看的，写不下去不影响服务 */
  }
}
