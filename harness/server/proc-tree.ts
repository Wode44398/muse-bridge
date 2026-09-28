// 进程树收尸（Windows）：按创建时间核对父子关系，绝不顺着「悬空的父 PID」杀到别人（实施记录 §4 #77）。
//
// 以前一律 `taskkill /PID <pid> /T /F`。taskkill 找子进程只看 ParentProcessId，而 Windows 上父进程退出后它的 PID
// 会被系统复用：一个早已退出的启动器（explorer / powershell 拉起 wscript 就走了）留下的 PID，一旦被我们新起的某个
// 子进程拿到，对这个子进程做 /T 就会把那条毫不相干的链——wscript → cmd → bridge——整条带走，没有日志、也没人重启。
// 2026-09-24 04:05 生产上的 bridge 就是在跑 harness 全量测试期间这样没的（它的 wscript 的父 PID 正是悬空的）。
//
// 规则：子进程一定比父进程晚创建。收一棵树时先取一次进程表，从根往下只认「创建时间不早于父进程」的子进程，
// 再逐个结束（不用 /T）。根必须还是我们认得的那个进程：Node 还没收到它的退出时进程句柄仍开着，系统不会复用它的
// PID；已经退出的，就不再按 PID 去杀（那个 PID 可能已经是别人的了）。
import { execFile, type ChildProcess } from "node:child_process";
import { helperEnv } from "./helper-proc.ts";

export interface ProcRow {
  pid: number;
  ppid: number;
  created: number; // 创建时间，毫秒
  name: string;
}

// 纯函数：从 rootPid 往下收，只认创建时间不早于父进程的子进程（排除悬空父 PID 指过来的无关进程）。根排第一。
export function descendantsOf(rootPid: number, table: readonly ProcRow[]): number[] {
  const root = table.find((p) => p.pid === rootPid);
  if (!root) return [];
  const kids = new Map<number, ProcRow[]>();
  for (const p of table) {
    if (p.pid === p.ppid) continue;
    const list = kids.get(p.ppid);
    if (list) list.push(p);
    else kids.set(p.ppid, [p]);
  }
  const out: number[] = [];
  const seen = new Set<number>();
  const queue: ProcRow[] = [root];
  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p.pid);
    for (const c of kids.get(p.pid) ?? []) {
      if (c.created >= p.created) queue.push(c);
    }
  }
  return out;
}

// 制表符用 [char]9 拼：PowerShell 单引号字符串里的 `t 不转义（第一版就栽在这，整张表解析成空、什么都杀不掉）。
const TABLE_SCRIPT =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object { " +
  "$t = 0; if ($_.CreationDate) { $t = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; " +
  "($_.ProcessId, $_.ParentProcessId, $t, $_.Name) -join [char]9 }";

export function parseProcTable(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, created, name] = line.trim().split("\t");
    if (!pid || !ppid || created === undefined) continue;
    const row = { pid: Number(pid), ppid: Number(ppid), created: Number(created), name: name ?? "" };
    if (Number.isInteger(row.pid) && Number.isInteger(row.ppid) && Number.isFinite(row.created)) rows.push(row);
  }
  return rows;
}

// 当前进程表（Win32_Process）。辅助进程：env 去凭据（S7）。
export function processTable(timeoutMs = 20_000): Promise<ProcRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", TABLE_SCRIPT],
      { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: helperEnv() },
      (err, stdout) => {
        const rows = parseProcTable(String(stdout ?? ""));
        if (err && !rows.length) reject(err);
        else resolve(rows);
      },
    );
  });
}

function killPid(pid: number): boolean {
  try {
    process.kill(pid, "SIGKILL"); // Windows 上即 OpenProcess + TerminateProcess，只杀这一个
    return true;
  } catch {
    return false; // 已经没了 / 没权限
  }
}

// 收掉 pid 这棵树（根 + 按创建时间核对过的子孙），返回收掉的 PID。rootHandle：根是我们自己 spawn 的子进程时传进来，
// 根就经它的句柄结束（句柄开着，PID 不可能被复用）；不传则按 PID 结束（调用方刚从进程表 / 端口表里查到它）。
export async function killProcessTree(pid: number, rootHandle?: ChildProcess): Promise<number[]> {
  if (process.platform !== "win32") {
    if (rootHandle) rootHandle.kill("SIGKILL");
    else killPid(pid);
    return [pid];
  }
  const table = await processTable();
  const tree = descendantsOf(pid, table);
  // 表里没有根（取表出了岔子）：有句柄就经句柄把根结束掉——句柄开着，这个 PID 一定还是我们的。
  if (!tree.length && rootHandle) tree.push(pid);
  const killed: number[] = [];
  for (const p of tree) {
    if (p === pid && rootHandle) {
      if (rootHandle.exitCode === null && rootHandle.signalCode === null && rootHandle.kill("SIGKILL")) killed.push(p);
    } else if (killPid(p)) {
      killed.push(p);
    }
  }
  return killed;
}

// S11（codex C8 的「kill 前复核身份」）：只收「本进程直接拉起的子进程」这棵树——给按 PID 记下、手里没有进程句柄的子进程用
// （如 MCP SDK 起的 stdio 连接器，句柄在 SDK 里）。它可能早已退出、PID 被别的进程复用：动手前在进程表里核对它的父进程还是
// 本进程，不是就什么都不做（返回空）。
export async function killOwnChildTree(pid: number): Promise<number[]> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return [];
  if (process.platform !== "win32") return killPid(pid) ? [pid] : [];
  const table = await processTable();
  const root = table.find((p) => p.pid === pid);
  if (!root || root.ppid !== process.pid) return [];
  const killed: number[] = [];
  for (const p of descendantsOf(pid, table)) if (killPid(p)) killed.push(p);
  return killed;
}

// 给「自己 spawn 的子进程」用：Node 已经收到它的退出就什么都不做（PID 可能已被复用）；否则收整棵树。
// 发起即返回（与原来 spawn taskkill 一样不等结果），失败时至少把根结束掉。
export function killChildTree(child: ChildProcess): void {
  if (child.pid == null || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    child.kill("SIGKILL");
    return;
  }
  void killProcessTree(child.pid, child).catch(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已经没了 */
    }
  });
}
