// Antigravity Native Swarm 消息板提及与多频道可见性规则（纯函数、零 I/O）。
// 与 agy 内置 swarm_board sidecar（channels.mjs / Go board 包）保持同构，
// 确保 @member、@prefix（分片组）、@all、@#channel 及频道订阅历史的计算结果完全一致。

export const MAIN = 'main';
export const ALL = '*';

const NAME_RUNE = /[\p{L}\p{Nd}_-]/u;

function namedToken(lowerText, lowerName) {
  if (!lowerName) return false;
  for (let i = lowerText.indexOf('@'); i >= 0; i = lowerText.indexOf('@', i + 1)) {
    if (i > 0) {
      const before = [...lowerText.slice(Math.max(0, i - 2), i)].pop();
      if (NAME_RUNE.test(before)) continue;
    }
    if (!lowerText.startsWith(lowerName, i + 1)) continue;
    const j = i + 1 + lowerName.length;
    if (j >= lowerText.length) return true;
    if (!NAME_RUNE.test(String.fromCodePoint(lowerText.codePointAt(j)))) return true;
  }
  return false;
}

function named(lowerText, lowerName) {
  if (namedToken(lowerText, lowerName)) return true;
  const m = lowerName.match(/^(.+)-\d+$/);
  return m ? namedToken(lowerText, m[1]) : false;
}

export function mentionsOf(text, names) {
  const lower = String(text || '').toLowerCase();
  return {
    mentions: names.filter((n) => named(lower, String(n).toLowerCase())),
    all: named(lower, 'all'),
  };
}

export function mentions(text, name) {
  const lower = String(text || '').toLowerCase();
  return named(lower, String(name || '').toLowerCase()) || named(lower, 'all');
}

export const channelOf = (m) => (typeof m?.channel === 'string' && m.channel ? m.channel : MAIN);

export const controlOf = (m) => (
  m?.control && typeof m.control === 'object' && !Array.isArray(m.control) ? m.control : null
);

const ALL_BY_ROLE = new Set(['coordinator', 'narrator', 'monitor']);
const ROLE_WORKER_NAME = /^(?:narrator|monitor)(?:-\d+)?$/;

export function effectiveChannels(role, set, name) {
  if (Array.isArray(set)) return set;
  if (ALL_BY_ROLE.has(role)) return [ALL];
  if ((!role || role === 'worker') && ROLE_WORKER_NAME.test(String(name ?? ''))) return [ALL];
  return [];
}

function touches(m, name) {
  const c = controlOf(m);
  return !!c && (c.op === 'subscribe' || c.op === 'unsubscribe') && Array.isArray(c.members) && c.members.includes(name);
}

const storedSet = (map, name) => {
  const v = map && typeof map === 'object' ? map[name] : null;
  return Array.isArray(v) ? v : null;
};

export function channelsAt(name, current, msgs) {
  let set = Array.isArray(current) ? current : null;
  const first = msgs.find((m) => touches(m, name));
  if (first) set = storedSet(controlOf(first).prev, name);
  return msgs.map((m) => {
    if (touches(m, name)) set = storedSet(controlOf(m).next, name);
    return set;
  });
}

const CHANNEL_NAME = /^[a-z][a-z0-9-]{0,23}$/;
const RESERVED = new Set(['main', 'all', 'here']);

export function channelMentions(text) {
  const lower = String(text || '').toLowerCase();
  const out = [];
  for (let i = lower.indexOf('@#'); i >= 0; i = lower.indexOf('@#', i + 1)) {
    if (i > 0 && NAME_RUNE.test([...lower.slice(Math.max(0, i - 2), i)].pop())) continue;
    let j = i + 2;
    while (j < lower.length) {
      const r = String.fromCodePoint(lower.codePointAt(j));
      if (!NAME_RUNE.test(r)) break;
      j += r.length;
    }
    const name = lower.slice(i + 2, j);
    if ((name === MAIN || (CHANNEL_NAME.test(name) && !RESERVED.has(name))) && !out.includes(name)) out.push(name);
  }
  return out;
}

export function mentionsIn(text, name, set, active) {
  if (mentions(text, name)) return true;
  if (!active) return false;
  const all = set.includes(ALL);
  return channelMentions(text).some((c) => c !== MAIN && (all || set.includes(c)) && active(c));
}

export function activeAt(registry, msgs) {
  const reg = new Map((Array.isArray(registry) ? registry : []).map((c) => [c.name, c]));
  if (!reg.size) return msgs.map(() => null);
  const created = new Map();
  const archived = new Map();
  for (const m of msgs) {
    const c = controlOf(m);
    if (c?.op === 'create') created.set(c.channel, Number(m.seq) || 0);
    if (c?.op === 'archive') archived.set(c.channel, Number(m.seq) || 0);
  }
  return msgs.map((m) => {
    const seq = Number(m.seq) || 0;
    return (c) => {
      const ch = reg.get(c);
      if (!ch) return false;
      if (created.has(c) && seq < created.get(c)) return false;
      if (ch.archived) return archived.has(c) && seq < archived.get(c);
      return true;
    };
  });
}

export function seesIn(name, set, msg, active) {
  const ch = channelOf(msg);
  if (ch === MAIN || msg?.agent === name) return true;
  if (set.includes(ALL) || set.includes(ch)) return true;
  return mentionsIn(msg?.text, name, set, active);
}

export const countsUnread = (msg) => !controlOf(msg);

export function memberView(name, role, current, msgs, registry) {
  const sets = channelsAt(name, current, msgs);
  const active = activeAt(registry, msgs);
  const visible = msgs.map((m, i) => seesIn(name, effectiveChannels(role, sets[i], name), m, active[i]));
  return { visible, unread: msgs.map((m, i) => visible[i] && countsUnread(m)) };
}

export function channelRegistry(msgs) {
  const byName = new Map();
  for (const m of msgs) {
    const c = controlOf(m);
    if (!c || typeof c.channel !== 'string' || !c.channel) continue;
    if (c.op === 'create' && !byName.has(c.channel)) {
      byName.set(c.channel, {
        name: c.channel,
        topic: typeof c.topic === 'string' ? c.topic : '',
        createdBy: String(m.agent ?? ''),
        archived: false,
      });
    } else if (c.op === 'archive') {
      const e = byName.get(c.channel) || { name: c.channel, topic: '', createdBy: '', archived: false };
      e.archived = true;
      byName.set(c.channel, e);
    }
  }
  return [...byName.values()];
}

export function currentChannels(name, stored, msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (touches(msgs[i], name)) return storedSet(controlOf(msgs[i]).next, name);
  }
  return Array.isArray(stored) ? stored : null;
}

export function visibleUnread(name, role, current, msgs, lastRead, registry) {
  const { unread } = memberView(name, role, current, msgs, registry);
  let n = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (unread[i] && (Number(msgs[i].seq) || 0) > lastRead) n++;
  }
  return n;
}
