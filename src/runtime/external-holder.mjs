// 续聊前的「单写者」判活：同一个 Claude 会话若正被 bridge 之外的活进程持有（官方 Desktop、
// 终端里的 claude CLI），bridge 再 resume 就会分叉 jsonl——对方进程内存里还是旧链，下一轮挂在
// 自己的叶子上，bridge 这一轮在「叶子→parentUuid 主链」重建里直接消失；对方正在生成时两边还会
// 并发追加同一个文件。
//
// 判据是 CLI 自己维护的本机会话注册表 ~/.claude/sessions/<pid>.json（除子会话外无条件登记，
// 进程退出即删）。bridge 自己拉起的 SDK 进程 entrypoint 是 sdk-*，不算外部持有者。
// 注册表读不了/格式不对一律 fail-open（返回 null），不因判活故障挡住正常续聊。

import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REG_DIR = path.join(os.homedir(), '.claude', 'sessions');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }   // EPERM = 进程在、只是没权限发信号
}

const LABELS = { 'claude-desktop': 'Claude Desktop', cli: 'Claude Code 终端' };

// 返回 { pid, entrypoint, label, status, name } 或 null（没有外部持有者）。
export function findExternalHolder(sessionId, regDir = REG_DIR) {
  if (!sessionId) return null;
  let files;
  try { files = readdirSync(regDir).filter((f) => /^\d+\.json$/.test(f)); } catch { return null; }
  for (const f of files) {
    let j;
    try { j = JSON.parse(readFileSync(path.join(regDir, f), 'utf8')); } catch { continue; }
    if (!j || j.sessionId !== sessionId) continue;
    const ep = String(j.entrypoint || '');
    if (ep.startsWith('sdk-')) continue;           // bridge 自己（及其他 SDK 宿主）的进程
    const pid = Number(j.pid);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !pidAlive(pid)) continue;
    return {
      pid,
      entrypoint: ep || 'unknown',
      label: LABELS[ep] || ep || '另一个 Claude 进程',
      status: j.status === 'busy' ? 'busy' : 'idle',
      name: typeof j.name === 'string' ? j.name : '',
    };
  }
  return null;
}
