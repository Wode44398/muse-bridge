// 给 scripts/idle-restart.ps1 用：现在有几个 agy 会话「这一轮已经说完、后台还在干活」。输出一个整数。
//
// 直接读 agy 的磁盘数据，不问服务端：服务端的 live-runs.json 只记「正在跑的一轮」，agy 把命令转入后台、派出子代理团队后
// 这一轮就结束了，脚本会判空闲、重启把它们一起杀掉（11-23 实遇：01:40 的空闲重启腰斩了后台在跑的 OptiX 测试）。
// 新版服务端的 live-runs 也会算上这些（modules/agy/server/index.mjs 的 busyRuns），这里是兜底，旧版服务端在跑时也管用。
//
//   node --import <仓库>/src/modules/register.mjs scripts/agy-bg-busy.mjs
import os from 'node:os';
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { readSubagentTree, backgroundBusy } from '../modules/agy/server/subagents.mjs';
import { noteAgyProcessStart } from '../modules/agy/server/proc-epoch.mjs';

const dataDir = process.env.AGY_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli');
// 不知道 agy 进程是什么时候起的：别按「早于进程启动」把任务判死，只靠 backgroundBusy 的「15 分钟内有动静」挡僵尸
noteAgyProcessStart(dataDir, 1);

const now = Date.now();
const WINDOW_MS = 12 * 3600 * 1000;
let n = 0;
let ids = [];
try { ids = readdirSync(path.join(dataDir, 'brain')); } catch {}
for (const id of ids) {
  const sys = path.join(dataDir, 'brain', id, '.system_generated');
  let last = 0;
  for (const f of [path.join(sys, 'logs', 'transcript_full.jsonl'), path.join(sys, 'tasks'), path.join(sys, 'subagents')]) {
    try { last = Math.max(last, statSync(f).mtimeMs); } catch {}
  }
  if (!last || now - last > WINDOW_MS) continue;
  try { if (backgroundBusy(readSubagentTree(dataDir, id), now)) n += 1; } catch {}
}
console.log(n);
