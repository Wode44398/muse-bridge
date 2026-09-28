// 进程树收尸（Windows）：按创建时间核对父子关系，不用 taskkill /T（实施记录 §4 #77）。
//
// taskkill /T 只按 ParentProcessId 找子进程；父进程退出后 PID 会被系统复用。Windows 上 bridge 自己的启动链
// wscript → cmd → node 里，wscript 的父进程（explorer / powershell 拉起它就走了）早已不存在——谁拿到那个悬空的
// 父 PID，谁被 taskkill /T，就把整条 bridge 链一起带走（实际发生过一次）。
// 规则：子进程一定比父进程晚创建。先取一次进程表，从根往下只认创建时间不早于父进程的子孙，再逐个结束。
// 与 harness/server/proc-tree.ts 同一套规则（bridge 不引 harness 的代码，各留一份）。

import { execFile } from 'node:child_process';

// 纯函数：从 rootPid 往下收，只认创建时间不早于父进程的子孙。根排第一。
export function descendantsOf(rootPid, table) {
  const root = table.find((p) => p.pid === rootPid);
  if (!root) return [];
  const kids = new Map();
  for (const p of table) {
    if (p.pid === p.ppid) continue;
    const list = kids.get(p.ppid);
    if (list) list.push(p);
    else kids.set(p.ppid, [p]);
  }
  const out = [];
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p.pid);
    for (const c of kids.get(p.pid) ?? []) if (c.created >= p.created) queue.push(c);
  }
  return out;
}

// 制表符用 [char]9 拼：PowerShell 单引号字符串里的 `t 不转义。
const TABLE_SCRIPT =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object { ' +
  '$t = 0; if ($_.CreationDate) { $t = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; ' +
  '($_.ProcessId, $_.ParentProcessId, $t, $_.Name) -join [char]9 }';

export function parseProcTable(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const [pid, ppid, created, name] = line.trim().split('\t');
    if (!pid || !ppid || created === undefined) continue;
    const row = { pid: Number(pid), ppid: Number(ppid), created: Number(created), name: name ?? '' };
    if (Number.isInteger(row.pid) && Number.isInteger(row.ppid) && Number.isFinite(row.created)) rows.push(row);
  }
  return rows;
}

export function processTable(timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TABLE_SCRIPT],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        const rows = parseProcTable(stdout ?? '');
        if (err && !rows.length) reject(err);
        else resolve(rows);
      });
  });
}

// 收掉自己 spawn 的子进程这棵树。Node 已经收到它的退出就什么都不做（PID 可能已被复用）；根经它自己的句柄结束。
export async function killChildTreeSafe(child) {
  if (!child || child.pid == null || child.exitCode !== null || child.signalCode !== null) return [];
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return [child.pid];
  }
  const tree = descendantsOf(child.pid, await processTable());
  if (!tree.length) tree.push(child.pid); // 表里没有根（取表出岔子）：句柄开着，这个 PID 一定还是我们的
  const killed = [];
  for (const pid of tree) {
    try {
      if (pid === child.pid) {
        if (child.exitCode === null && child.signalCode === null && child.kill('SIGKILL')) killed.push(pid);
      } else {
        process.kill(pid, 'SIGKILL');
        killed.push(pid);
      }
    } catch {
      /* 已经没了 */
    }
  }
  return killed;
}
