// 数据布局版本与迁移器骨架（开源路线 C11）。
//
// 开源以后，users/<账号>/.bridge、_system、owner 键、config.json 的键都是别人部署里的数据契约：改布局要有
// 版本号可依，不能靠猜（users-migrate.mjs 改写路径的那次就是没有版本号、只能逐个文件判断的例子）。
// 这里在 <usersRoot>/_system/layout.json 记「这份数据是第几版布局」，启动时按版本顺序跑迁移步骤。
//
// 版本：
//   v0  没有 layout.json——版本号出现之前的数据。
//   v1  首个公开版冻结的布局（docs/ARCHITECTURE.md「数据布局」）。v0 → v1 不改任何数据，只落版本号。
//
// 规则（写新迁移步骤之前先读）：
//   · 每一步都必须幂等、只增不删：老字段、老文件留着，装回旧版本照样能跑（旧代码不认识的字段原样保留）。
//   · 步骤按 to 升序执行，每做完一步立刻落盘（version 取已做步骤的最大 to，applied 记步骤名）；
//     中途失败就停在那一步之前，服务照常启动，下次启动重试。
//   · 磁盘上的版本比代码新（装回了旧版本）：什么都不做、不降级，只在返回值里报出来。
//   · 已经发布出去的步骤不再改；冻结前（开源首发之前）补进来的同版本步骤按名字补跑（applied 里没有就跑）。
//   · layout.json 只由服务进程读写，放在 _system（不在任何人的工作空间里，agent 改不到）。
//   · 什么时候跑：server.mjs 紧跟 config/index.mjs 之后 import runtime/layout-boot.mjs，在 import 阶段就跑完，
//     早于号池、额度策略、账号库这些「被 import 时就把数据读进内存」的模块。所以本文件只许依赖 config 与 principal
//     这类不碰数据的模块，别在这里 import 任何台账模块（scenario3-reserve.test 按导入图检查）。
//   · 唯一的例外是 config.json：config/index.mjs 在迁移之前已经把它读进内存（导出的 config 对象）。改 config.json 的
//     步骤必须同时改那份内存对象；做不到就别放进迁移，交给持有那个键的模块（号池 claudeAccounts、额度 policy…）
//     在自己初始化时处理。

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SYSTEM_DIR, NATIVE_ROOT } from '../config/index.mjs';
import { GROUPS_DIR_NAME, validGroupId } from './principal.mjs';

export const LAYOUT_VERSION = 1;
export const LAYOUT_FILE = 'layout.json';

// 迁移步骤：{ to, name, up({ systemDir, usersRoot }) }。up 同步执行、可抛错（抛错 = 这一步没做成）。
export const MIGRATIONS = Object.freeze([
  { to: 1, name: 'v1-baseline', up() { /* 冻结 v1：不改数据，只落版本号 */ } },
]);

// 将来的组空间（预留，今天不创建）：<usersRoot>/_groups/<组 id>/。对所有成员是同一个绝对路径，
// 不软链、不挂载进个人目录（transcript 按「配置目录 + 绝对 cwd」存放，路径一变所有人的会话都要改写）。
export const GROUPS_ROOT = path.join(NATIVE_ROOT, GROUPS_DIR_NAME);
export function groupRoot(id) {
  if (!validGroupId(id)) throw Object.assign(new Error('组 id 不合法'), { status: 400 });
  return path.join(GROUPS_ROOT, String(id));
}

function readRaw(file) {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

// 读当前布局：{ version, applied, raw }。没有文件或读不懂 = v0。
export function readLayout(systemDir = SYSTEM_DIR) {
  const raw = readRaw(path.join(systemDir, LAYOUT_FILE));
  const version = raw && Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : 0;
  const applied = raw && Array.isArray(raw.applied) ? raw.applied.filter((s) => typeof s === 'string') : [];
  return { version, applied, raw };
}

// 原子写（tmp + rename），失败要让调用方知道（jsonfile.writeJson 只记日志不抛，这里要据此停住）。
function writeLayout(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2));
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

// 启动时调用一次。永不抛：返回 { from, version, ran, newer?, error? }。
export function migrateLayout({
  systemDir = SYSTEM_DIR,
  usersRoot = NATIVE_ROOT,
  migrations = MIGRATIONS,
  target = LAYOUT_VERSION,
  now = () => new Date().toISOString(),
} = {}) {
  const file = path.join(systemDir, LAYOUT_FILE);
  const cur = readLayout(systemDir);
  const from = cur.version;
  if (from > target) return { from, version: from, ran: [], newer: true };
  const done = new Set(cur.applied);
  const steps = migrations.filter((m) => m && m.to <= target && !done.has(m.name)).sort((a, b) => a.to - b.to);
  let version = from;
  const applied = [...cur.applied];
  const ran = [];
  const stamp = () => writeLayout(file, { ...(cur.raw || {}), version, applied, updatedAt: now() });
  try {
    for (const m of steps) {
      m.up({ systemDir, usersRoot });
      version = Math.max(version, m.to);
      applied.push(m.name);
      ran.push(m.name);
      stamp();
    }
    // 没有步骤到 target（目标版本没有登记步骤）：所有登记的都做完了，直接落到 target。
    if (version < target) { version = target; stamp(); }
    return { from, version, ran };
  } catch (e) {
    return { from, version, ran, error: String((e && e.message) || e) };
  }
}
