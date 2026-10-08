// 反馈的本地状态，都在数据目录 feedback/ 底下（服务进程和 bootstrap.sh 调的命令行共用，读写都是原子的）：
//   install-id     这台装机的随机编号（Worker 按它限流、查重；跟用户、地址都没有关系）
//   settings.json  { auto: true|false|null }  出错时自动上报（null = 还没问过用户）
//   errors.json    最近记下的报错（按指纹去重计数），出草稿时挑最近的几条附上
//   drafts/<id>    草稿：用户看过、同意之后才发；24 小时没发就作废
//   outbox/<id>    发不出去（网络 / 审核卡没批）的报告，联网后补发
//   sent.json      发过的报告：Issue 编号、地址——修好之后 Muse 能告诉用户「你报的问题修好了」
import { randomUUID, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '../runtime/paths.mjs';
import { readJson, writeJson } from '../jsonfile.mjs';

export const DIR = path.join(DATA_ROOT, 'feedback');
// 只给服务用户自己看（草稿、待发报告里有用户写的描述）
try { mkdirSync(DIR, { recursive: true, mode: 0o700 }); chmodSync(DIR, 0o700); } catch {}
const P = (...a) => path.join(DIR, ...a);
const DRAFT_TTL = 24 * 3600_000;
const ID_RE = /^[a-z0-9]{10,32}$/;

export function installId() {
  try { const s = readFileSync(P('install-id'), 'utf8').trim(); if (/^[A-Za-z0-9-]{8,64}$/.test(s)) return s; } catch {}
  const id = randomUUID();
  try { mkdirSync(DIR, { recursive: true, mode: 0o700 }); writeFileSync(P('install-id'), id + '\n', { mode: 0o600 }); } catch {}
  return id;
}

export function getSettings() {
  const s = readJson(P('settings.json'), {});
  return { auto: s.auto === true ? true : s.auto === false ? false : null };
}
export function setAuto(on) {
  const s = readJson(P('settings.json'), {});
  s.auto = !!on; s.changedAt = new Date().toISOString();
  writeJson(P('settings.json'), s, 2);
  return getSettings();
}

export const newId = () => randomBytes(8).toString('hex');

export function saveDraft(d) { writeJson(P('drafts', d.id + '.json'), d, 2); return d; }
export function loadDraft(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const d = readJson(P('drafts', id + '.json'), null);
  if (!d || Date.now() - (d.at || 0) > DRAFT_TTL) return null;
  return d;
}
export function dropDraft(id) { if (ID_RE.test(String(id || ''))) rmSync(P('drafts', id + '.json'), { force: true }); }
export function pruneDrafts() {
  for (const f of safeList(P('drafts'))) {
    try { if (Date.now() - statSync(P('drafts', f)).mtimeMs > DRAFT_TTL) rmSync(P('drafts', f), { force: true }); } catch {}
  }
}

export function queueOutbox(entry) { writeJson(P('outbox', entry.id + '.json'), entry, 2); }
export function listOutbox() { return safeList(P('outbox')).map((f) => readJson(P('outbox', f), null)).filter(Boolean); }
export function dropOutbox(id) { if (ID_RE.test(String(id || ''))) rmSync(P('outbox', id + '.json'), { force: true }); }

export function listSent() { const a = readJson(P('sent.json'), []); return Array.isArray(a) ? a : []; }
export function recordSent(item) {
  const a = listSent();
  a.push(item);
  writeJson(P('sent.json'), a.slice(-200), 2);
}
/** 这台机器（这个版本）上同一个指纹是不是已经自动报过了 */
export function autoSentFor(fp, version) { return listSent().some((s) => s.fp === fp && s.source === 'auto' && s.version === version); }
export function autoSentToday() {
  const day = new Date().toISOString().slice(0, 10);
  return listSent().filter((s) => s.source === 'auto' && String(s.at || '').startsWith(day)).length;
}

function safeList(dir) { try { return readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; } }
