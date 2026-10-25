// 会话可见性（预留，开源路线 C10；docs/ARCHITECTURE.md 第 3 节第 4、10 条）。
//
// 「谁能看这个会话」是授权数据，只放 _system，只由服务进程经这里写：
//   <usersRoot>/_system/session-visibility.json   { "<属主 owner 键>": { "<sessionId>": "members" | "group" | "org" } }
// 键就是 sessionRef(属主, sessionId)。缺省 private 不落盘：文件里只有放宽过的会话，没放宽过任何会话的部署根本没有这个文件。
//
// 不放在属主工作空间的 .bridge/（会话库 claude-session-library.json）里：.bridge 在 agent 的工具围栏之内，
// 完全信任档的 agent 用 Bash 就改得到。被网页内容做了提示注入时，它可以自己把私人会话放成全组织可见，而且不留审计。
//
// 今天：没有任何入口调用 setSessionVisibility，也没有地方读 sessionVisibility 来放行，所以恒为 private。
// 将来接入时守住三条：
//   · 改可见性只经 setSessionVisibility（它写审计）；属主自己改，actor 就是属主；管理员改，actor 是主机身份。
//   · 删会话、删号时一并清：setSessionVisibility(ref, 'private') 就是删掉这一条。
//   · 放行之前再确认会话还在、属主还在；认不出的取值一律当 private（principal.normVisibility）。
// 接口按以后能换成数据库来设计（C14）：调用方只用这里导出的函数，不直接读写这个文件。

import path from 'node:path';
import { readJson, writeJson } from '../jsonfile.mjs';
import { SYSTEM_DIR } from '../config/index.mjs';
import { normVisibility, parseSessionRef } from './principal.mjs';
import { appendAudit } from './audit-log.mjs';

export const SESSION_VISIBILITY_FILE = path.join(SYSTEM_DIR, 'session-visibility.json');

let cache = null;   // 单进程独占写：内存为准，磁盘只是持久化
function load() {
  if (cache) return cache;
  const raw = readJson(SESSION_VISIBILITY_FILE, {});
  cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return cache;
}

// ref = sessionRef(属主, sessionId)。只给裸 sessionId（不知道属主）一律 private。
export function sessionVisibility(ref) {
  const r = parseSessionRef(ref);
  if (!r || !r.owner || !r.sessionId) return 'private';
  const bucket = load()[r.owner];
  return normVisibility(bucket && typeof bucket === 'object' ? bucket[r.sessionId] : undefined);
}

// 唯一的写入口（今天没有调用方）。actor = 谁改的（owner 键），via = 哪一张凭据；写一条 session/visibility 审计。
export function setSessionVisibility(ref, visibility, { actor = '', via = '' } = {}) {
  const r = parseSessionRef(ref);
  if (!r || !r.owner || !r.sessionId) return { error: '会话引用要带属主与 sessionId' };
  const v = normVisibility(visibility);
  const data = load();
  const bucket = data[r.owner] && typeof data[r.owner] === 'object' ? data[r.owner] : {};
  const prev = normVisibility(bucket[r.sessionId]);
  if (prev === v) return { ok: true, visibility: v, changed: false };
  if (v === 'private') delete bucket[r.sessionId];
  else bucket[r.sessionId] = v;
  if (Object.keys(bucket).length) data[r.owner] = bucket;
  else delete data[r.owner];
  writeJson(SESSION_VISIBILITY_FILE, data, 2);
  appendAudit({ actor: actor || r.owner, via, action: 'session/visibility', target: r.owner, scope: r.owner, meta: { sessionId: r.sessionId, visibility: v } });
  return { ok: true, visibility: v, changed: true };
}

// 测试用：丢掉内存里的那份，下次从磁盘重读。
export function _resetSessionVisibilityCache() { cache = null; }
