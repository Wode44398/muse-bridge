// 非 Claude agent（dimensio）的会话 → 连接哪台设备。Claude 的记在 claude-chat-prefs.json 的会话条目上
// （chat-prefs.mjs setDeviceLink）；dimensio 的会话不在那张表里，单独记一份，免得挤掉 Claude 的偏好条目。
//   <ctx.dataDir>/agent-device-links.json = { "<agent>:<会话 id>": { link: 'd-…' | 'none', at } }
// link 语义同 Claude：设备 id = 连这台；'none' = 这个会话不连设备；没有条目 = 自动（恰好一台在线就用它）。

import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const CAP = 400;
const cache = new Map();
const fileFor = (ctx) => path.join(ctx.dataDir, 'agent-device-links.json');
const linkOf = (v) => (typeof v === 'string' && (v === 'none' || /^d-[0-9a-f]{6,24}$/.test(v)) ? v : null);
export const AGENT_LINK_SESSION_RE = /^[0-9a-f-]{8,64}$/i;
const keyOf = (agent, sid) => (/^[a-z]{2,16}$/.test(String(agent || '')) && AGENT_LINK_SESSION_RE.test(String(sid || '')) ? `${agent}:${sid}` : '');

function load(file) {
  if (cache.has(file)) return cache.get(file);
  let data = null;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const map = Object.assign(Object.create(null), data && typeof data === 'object' ? data : {});
  cache.set(file, map);
  return map;
}

export function agentDeviceLink(ctx, agent, sessionId) {
  const k = keyOf(agent, sessionId);
  if (!ctx?.dataDir || !k) return null;
  return linkOf(load(fileFor(ctx))[k]?.link);
}

/** link = 设备 id / 'none' / ''（恢复自动）。返回写没写成。 */
export function setAgentDeviceLink(ctx, agent, sessionId, link) {
  const k = keyOf(agent, sessionId);
  if (!ctx?.dataDir || !k) return false;
  const file = fileFor(ctx);
  const data = load(file);
  const v = linkOf(link);
  if (v) data[k] = { link: v, at: Date.now() };
  else delete data[k];
  const keys = Object.keys(data);
  if (keys.length > CAP) {
    keys.sort((a, b) => (data[a]?.at || 0) - (data[b]?.at || 0));
    for (const old of keys.slice(0, keys.length - CAP)) delete data[old];
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  } catch {}
  return true;
}

export function _resetAgentDeviceLinks() { cache.clear(); }
