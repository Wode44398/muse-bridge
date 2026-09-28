// 在跑轮的落盘台账 + 「被中断」留痕。
//
// 为什么需要：gen.mjs 里的 gens 全在内存。进程一死，「这个会话正在跑一轮」这件事
// 就【没有任何人知道了】——2026-08-25 那次 ARM 深度研究就是这样：12:39 最后一个
// TaskUpdate 落进 transcript，12:41 进程消失，watchdog 90 秒后把服务拉回来，但新进程
// 手里是一张白纸：transcript 干干净净地断在一个 tool_result 上，没有任何异常记录，
// 前端只能靠 reconcile 连试 4 次「落盘慢半拍」再自行收敛，页面上则是一轮永远没有下文的
// 对话——用户看到的就是「Claude 干着干着消失了」。
//
// 修法：开跑时把这一轮写进 inflight-runs.json，收尾时销账。下次启动时文件里还剩着的
// 每一条，都是上一条命没来得及销账的轮（我们既然抢到了端口，上一个进程必定已经不在）：
//   ① 往它的 transcript 追加一条【和 CLI 自己写的 API Error 记录同构】的合成消息，
//      于是重开会话时那一轮末尾有一句明确的「本轮被中断」，而不是无声无息地断掉；
//   ② 同时记进 interrupted-runs.json，/api/attach 据此直接回一个终止事件，
//      前端当场收敛，不必再走 4 轮 behind 的兜底路径。
//
// 幂等：同一个会话重新开跑会清掉它的中断标记；transcript 尾部已经有标记就不再追加。

import { existsSync, readFileSync, writeFileSync, appendFileSync, openSync, readSync, fstatSync, closeSync, renameSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sessionPaths } from './paths.mjs';

const MARK = 'bridge_interrupted';
const NOTE = '⚠️ 这一轮没跑完：bridge 服务进程在它执行到一半时退出了（崩溃或重启），本轮被中断。'
  + '已经落盘的文件和已经写进记录的内容都还在——说一句「继续」就能从这里接着往下做。';
// 尾部读多少字节够找到最后一条记录。单条记录再大（含大段 tool_result）也远不到这个量级。
const TAIL_BYTES = 512 * 1024;

let FILE = '';
let INT_FILE = '';
const _live = new Map();          // composite(key, sessionId) -> rec
// 中断标记同样按 caller 分区：和 findGenBySession 一样，一个身份只看得见自己的轮。
// 不分区的话，拿到别人的会话 id 就能从 /api/attach 探出「那一轮在跑什么」（userText）。
const _interrupted = new Map();   // composite(key, sessionId) -> { key, sessionId, at, startedAt, userText }

// 长度前缀的复合键：key 里带冒号（'u:名字'、'c:token'），拼接必须无歧义。
const idOf = (key, sessionId) => {
  const k = String(key || '');
  return k.length + ':' + k + ':' + String(sessionId || '');
};

// 小文件原子写：先写 .tmp 再 rename，避免进程正好死在写一半时留下半截 JSON。
function writeJson(file, value) {
  if (!file) return;
  const tmp = file + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
  } catch { /* 台账是尽力而为：写不下去也绝不能影响正在跑的轮 */ }
}

function readJson(file) {
  try { const v = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
}

const persist = () => writeJson(FILE, [..._live.values()]);
const persistInt = () => writeJson(INT_FILE, [..._interrupted.values()]);

// ---- 台账读写 -------------------------------------------------------------------

// rec: { key, sessionId, userText, startedAt, cwd, configDir, agent }
export function beginInflight(rec) {
  if (!FILE || !rec || !rec.sessionId || !rec.key) return;
  const id = idOf(rec.key, rec.sessionId);
  // 先作废旧的中断标记再谈台账：这个会话既然又开跑了，attach 就不该再拿上一轮的中断
  // 去掐它。放在 has() 早退之前——同一轮重复 announce（新会话拿到 id 后会再播一次）
  // 时也要保证标记已经清掉。
  if (_interrupted.delete(id)) persistInt();
  if (_live.has(id)) return;
  _live.set(id, {
    key: String(rec.key),
    sessionId: String(rec.sessionId),
    agent: rec.agent || 'claude',
    userText: String(rec.userText || '').slice(0, 300),
    startedAt: rec.startedAt || Date.now(),
    cwd: rec.cwd || '',
    configDir: rec.configDir || null,
    pid: process.pid,
  });
  persist();
}

export function endInflight(key, sessionId) {
  if (!FILE || !sessionId) return;
  if (_live.delete(idOf(key, sessionId))) persist();
}

// /api/attach 用：这个 caller 的这个会话，上一轮是不是被【进程中途退出】掐掉的
//（没有 gen 可挂时才问）。
export function interruptedRun(key, sessionId) {
  return sessionId ? (_interrupted.get(idOf(key, sessionId)) || null) : null;
}
export const INTERRUPT_NOTE = NOTE;

// 前端已经看到并收敛过了就可以清掉——避免同一条中断在每次 attach 都再播一遍。
export function clearInterrupted(key, sessionId) {
  if (sessionId && _interrupted.delete(idOf(key, sessionId))) persistInt();
}

// ---- 启动时收尸 -----------------------------------------------------------------

export function initInflight(root) {
  FILE = path.join(root, 'inflight-runs.json');
  INT_FILE = path.join(root, 'interrupted-runs.json');
  // 盘上那份台账属于【上一条命】，本进程的在跑集合从零开始。
  _live.clear();

  for (const r of readJson(INT_FILE)) {
    if (r && r.sessionId) _interrupted.set(idOf(r.key, r.sessionId), r);
  }

  const orphans = readJson(FILE).filter((r) => r && r.sessionId);
  // 先清台账再留痕：留痕万一抛了，也不会在下次启动时被当成新的孤儿重复标记。
  writeJson(FILE, []);
  for (const rec of orphans) {
    try { markInterrupted(rec); }
    catch (e) { console.error('[inflight] 中断留痕失败 session=' + rec.sessionId + ':', e && e.message); }
  }
  if (orphans.length) {
    console.log(`[inflight] 上一条命有 ${orphans.length} 轮没跑完（进程中途退出），已在 transcript 留下「被中断」`);
    for (const r of orphans) console.log(`[inflight]   session=${r.sessionId} 开跑于 ${new Date(r.startedAt || 0).toLocaleString()} :: ${String(r.userText || '').slice(0, 60)}`);
  }
  return orphans;
}

function markInterrupted(rec) {
  _interrupted.set(idOf(rec.key, rec.sessionId), {
    key: String(rec.key || ''),
    sessionId: String(rec.sessionId),
    at: Date.now(),
    startedAt: rec.startedAt || 0,
    userText: String(rec.userText || '').slice(0, 300),
  });
  persistInt();
  appendTranscriptMarker(rec);
}

// ---- transcript 留痕 -------------------------------------------------------------

// 只读文件尾部：transcript 动辄几 MB，为了拿最后一条记录整份读进来不划算。
function readTail(file, bytes = TAIL_BYTES) {
  let fd = -1;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch { return ''; }
  finally { if (fd >= 0) { try { closeSync(fd); } catch {} } }
}

// 追加一条与 CLI 自己写的 API Error 记录同构的合成 assistant 消息。
// 同构很重要：`model:"<synthetic>"` + `isApiErrorMessage:true` 正是 Claude Code 写
// 「API Error: 529 Overloaded」那类本地错误气泡用的形状，CLI 自己 resume 时按错误气泡
// 处理，bridge 的历史渲染则原样当成一条 assistant 文本显示出来。链上挂在文件最后一条
// 带 uuid 的记录后面（CLI 注入 "Continue from where you left off." 时挂的也是 attachment）。
function appendTranscriptMarker(rec) {
  const p = sessionPaths(rec.sessionId, rec.cwd, rec.configDir || null);
  if (!p || !existsSync(p.file)) return;

  const lines = readTail(p.file).split('\n');
  let last = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }   // 尾部截断的半行：跳过
    if (o && o.error === MARK) return;                      // 已经标过了，幂等退出
    if (o && o.uuid && (o.type === 'assistant' || o.type === 'user' || o.type === 'attachment')) { last = o; break; }
  }
  if (!last) return;   // 找不到可挂的父记录就不硬写，宁可不留痕也不写坏这份 transcript

  const line = JSON.stringify({
    parentUuid: last.uuid,
    isSidechain: false,
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: 'msg_bridge_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20),
      container: null,
      model: '<synthetic>',
      role: 'assistant',
      stop_details: null,
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage: {
        input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: null,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        inference_geo: null, iterations: null, speed: null,
      },
      content: [{ type: 'text', text: NOTE }],
      context_management: null,
    },
    isApiErrorMessage: true,
    error: MARK,
    userType: last.userType || 'external',
    entrypoint: last.entrypoint || 'sdk-ts',
    cwd: last.cwd || rec.cwd || '',
    sessionId: rec.sessionId,
    version: last.version || '',
    gitBranch: last.gitBranch || '',
  });
  appendFileSync(p.file, line + '\n');
}
