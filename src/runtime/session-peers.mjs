// 与官方 Claude Desktop / 终端里的 Claude Code 会话互发消息（2026-10-20，A3 §3 / B3 §5）。
//
// 机制是 CLI 2.1.299 自带的跨会话通道（不是 bridge 自己的会话树）：每个 CLI 进程在 ~/.claude/sessions/<pid>.json
// 登记、开一条本机命名管道收件箱（\\.\pipe\LOCAL\cc-msg-<hex>），对方 SendMessage 把一条包成
// <cross-session-message from=… from-name=…> 的消息投进来；Desktop 的每个会话就是一个 entrypoint=claude-desktop 的 CLI。
// 总开关 env CLAUDE_CODE_HARBOR_KITE（显式值压过灰度），入站闸是设置 crossSessionInbound（default / accept / hold / refuse），
// 显式三档由 bridge 经 flag 层 settings 下发（flag 层优先于用户 / 项目设置）；default 不下发，交给 CLI 自己按权限模式判：
// 有显式值时 CLI 直接照值办，跳过「本会话绕过权限时默认扣留」「发送方模式不一致 / 没说明时扣留」两层保护，所以默认不能写 accept。CLI 每收到一条都按当时的设置现判（2.1.299
// cross-session-inbound 的 getPolicyForPeer），所以设置一改就经 q.applyFlagSettings 当场换到每个活着的 CLI 上（registerPeerGate）。
//
// 只对主机管理员开：只有它和 Desktop 共用 ~/.claude/sessions（沙箱身份各有 CLAUDE_CONFIG_DIR），管道又是全机可见的——
// 注册用户 / Pro / 快照访客一律 HARBOR_KITE=0 + refuse：没有 ListAgents、不开收件管道；SendMessage 还在（CLI 给后台
// 子 agent / 队友用的），但发往别的会话的一律报 “Cross-session messaging is not available”（10-21 真 CLI 探针实测）。
//
// 2026-10-20 探针（scratchpad/probe/peer-probe.mjs，SDK 起的 CLI + 手写管道发送方）定下的事实：
//   · SDK 起的 CLI 照样登记（kind interactive、entrypoint sdk-ts）并有收件箱；
//   · 空闲时收到消息，CLI 自己开一轮：先 command_lifecycle(started, command_uuid) 再 system/init——流里没有那条 user 帧；
//     transcript 里那条是 isMeta 的 user 记录，uuid = command_uuid，origin:{kind:'peer', from, name, body, fromSession?}；
//   · hold 档：流里出 system/peer_message_hold {state:'held', message_uuid, from, from_name, cause}（没有正文）；
//     宿主 q.applyFlagSettings({crossSessionInbound:'accept'}) 立刻放行（state:'released' → 自己开一轮），
//     改成 refuse 则整批丢弃（state:'dropped'）。CLI 退出时还扣着的一律作废（发送方收到 expired 回执）。
// claude.mjs 据此：停放中的 CLI 自己开的这一轮若是跨会话消息 → 当作一次自动续跑接住（peerTake），推给前端；
// 不是（定时唤醒之类）照旧关掉。在跑的轮里插进来的 → 直播补一个插话段（steer 事件，正文是下面的显示信封）。
import { readdirSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { busPublish } from './bus.mjs';
import { claudeSetting, onClaudeSettings } from './claude-settings.mjs';
import { sessionQuestions, registerPendingSource } from './questions.mjs';
import { DATA_ROOT } from './paths.mjs';
import { readJson, writeJson } from '../jsonfile.mjs';

const REG_DIR = path.join(os.homedir(), '.claude', 'sessions');
const INBOUND = new Set(['accept', 'hold', 'refuse']);

/** 这一轮开不开跨会话通道：只有主机管理员（非沙箱、非快照）。 */
export const peersOn = (ctx, snap) => !!ctx && ctx.kind === 'admin' && !ctx.sandbox && !snap;

/** 给 CLI 的 env：开着的身份显式点亮（Windows 灰度不再说了算），其余显式关掉。 */
export const peerEngineEnv = (ctx, snap) => ({ CLAUDE_CODE_HARBOR_KITE: peersOn(ctx, snap) ? '1' : '0' });

// 聊天轮之外起的 CLI（定时路由 routines-runner、文件回滚 claude-rewind）一律关门：没人看着，不登记、不开收件箱。
// 不写的话 CLI 2.1.299 按灰度缺省（tengu_harbor_kite / _win 缺省都开）打开通道，入站在非 bypass 模式下默认 accept——
// 本机任何 Claude 会话都能往一次无人值守的运行里塞指令。env 关总开关，settings 再把入站闸关死（两道）。
export const PEER_OFF_ENV = Object.freeze({ CLAUDE_CODE_HARBOR_KITE: '0' });
export const PEER_OFF_SETTINGS = Object.freeze({ crossSessionInbound: 'refuse' });

/** 入站闸（进 flag 层 settings，同时进 warmSig；设置改了还会当场换到活着的 CLI 上，见下）。
 *  null = 不下发（「跟随 Claude 默认」）：spawn 时不写这个键，活着的 CLI 用 applyFlagSettings({…: null}) 清掉 bridge 写过的值。 */
export function peerInbound(ctx, snap) {
  if (!peersOn(ctx, snap)) return 'refuse';
  let v = 'default';
  try { v = claudeSetting(ctx, 'crossSessionInbound'); } catch {}
  return INBOUND.has(v) ? v : null;
}

// —— 入站闸当场生效 ——
// 这是安全闸：管理员把「其它会话发来的消息」改成拒收 / 暂存，不能等这个会话下一条消息冷起才算数——
// 挂起等后台任务的轮可能跑很久，停放的 CLI 也还开着收件箱。claude.mjs 给每个开着通道的 CLI 登记一个 gate
//（= q.applyFlagSettings 包装），进程收尾时注销；预热的那个在被新会话接走之前一直关着（refuse），接走时才登记。
// 设置一变就把新值推给这个身份所有登记着的 CLI（停放的那个下一条消息仍按 warmSig 冷起，无妨）。
const liveGates = new Map();   // key -> Set(gate)
export function registerPeerGate(key, gate) {
  if (!key || typeof gate !== 'function') return;
  if (!liveGates.has(key)) liveGates.set(key, new Set());
  liveGates.get(key).add(gate);
}
export function unregisterPeerGate(key, gate) {
  const set = liveGates.get(key);
  if (!set) return;
  set.delete(gate);
  if (!set.size) liveGates.delete(key);
}
/** 把这个身份所有活着的 CLI 的入站闸换成 value。返回换成功了几个。 */
export async function applyPeerInbound(key, value) {
  const set = liveGates.get(key);
  if (!set || !(value === null || INBOUND.has(value))) return 0;
  const r = await Promise.allSettled([...set].map((g) => g(value)));
  return r.filter((x) => x.status === 'fulfilled').length;
}
onClaudeSettings((ctx, keys) => {
  if (!Array.isArray(keys) || !keys.includes('crossSessionInbound') || !peersOn(ctx, null)) return;
  const v = peerInbound(ctx, null);
  applyPeerInbound(ctx.key, v).then((n) => { if (n) console.log(`[peers] crossSessionInbound -> ${v || '(CLI default)'}: applied to ${n} live CLI(s)`); }).catch(() => {});
});

// —— transcript 里认跨会话消息 ——
// 尾部 512KB 找 uuid 那一条（CLI 在开这一轮时写下，command_lifecycle 稍早于它）。
function tailRecord(file, uuid) {
  let size = 0;
  try { size = statSync(file).size; } catch { return null; }
  const len = Math.min(size, 512 * 1024);
  const buf = Buffer.alloc(len);
  let fd;
  try { fd = openSync(file, 'r'); readSync(fd, buf, 0, len, size - len); } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  // 开一轮的那条是 user 记录（uuid = command_uuid）；插进正在跑的那一轮的多半落成 attachment(queued_command，source_uuid)
  const needles = [`"uuid":"${uuid}"`, `"source_uuid":"${uuid}"`];
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!needles.some((n) => lines[i].includes(n))) continue;
    try { const o = JSON.parse(lines[i]); if (o && (o.uuid === uuid || (o.attachment && o.attachment.source_uuid === uuid))) return o; } catch {}
  }
  return null;
}

const ENVELOPE_RE = /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/;
const envAttr = (a, k) => { const m = String(a || '').match(new RegExp(`\\b${k}="([^"]*)"`)); return m ? m[1] : ''; };
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '');

/** transcript 记录 → 跨会话消息（不是返回 null）。user 记录看 origin（CLI 已解好信封）；没有 origin 的按信封原文解。
 *  插进正在跑的那一轮的落成 attachment(queued_command)，origin 在 attachment 里（2.1.299 实测）。 */
export function peerFromRecord(o) {
  if (!o) return null;
  const ao = o.attachment && o.attachment.origin;
  const og = o.origin && o.origin.kind === 'peer' ? o.origin : ao && ao.kind === 'peer' ? ao : null;
  let text = '';
  if (o.type === 'user' && o.message) text = textOf(o.message.content);
  else if (o.type === 'attachment' && o.attachment && o.attachment.type === 'queued_command') text = textOf(o.attachment.prompt);
  else return null;
  const env = text.match(ENVELOPE_RE);
  if (!og && !env) return null;
  return {
    // 插话的那条：认 source_uuid（= 直播 command_lifecycle 的 command_uuid），不认 attachment 记录自己的 uuid
    uuid: (o.type === 'attachment' && o.attachment.source_uuid) || o.uuid || '',
    from: (og && typeof og.from === 'string' && og.from) || (env ? envAttr(env[1], 'from') : ''),
    name: (og && typeof og.name === 'string' && og.name) || (env ? envAttr(env[1], 'from-name') : ''),
    fromSession: (og && typeof og.fromSession === 'string' && og.fromSession) || (env ? envAttr(env[1], 'from-session') : ''),
    body: (og && typeof og.body === 'string' && og.body) || (env ? env[2] : text),
    turnStart: o.type === 'user' && o.turnOrigin === 'peer',
  };
}

/**
 * 等 uuid 那条记录落盘（最多 timeoutMs），返回 { peer } / { other:true } / null（没等到）。
 * 停放的 CLI 收到 command_lifecycle 时调：是跨会话消息才接住这一轮。
 */
export async function waitPeerRecord(file, uuid, { timeoutMs = 3000, stepMs = 120 } = {}) {
  if (!file || !uuid) return null;
  const t0 = Date.now();
  for (;;) {
    const o = tailRecord(file, uuid);
    if (o) {
      const p = peerFromRecord(o);
      if (!p) return { other: true };
      // 收到的这一刻对方的登记还在：认出来源记进台账，直播与历史重建同一个说法
      rememberPeerSource(p.uuid, peerSourceOf(p.from, p.fromSession, REG_DIR, { fresh: true }));
      return { peer: p };
    }
    if (Date.now() - t0 >= timeoutMs) return null;
    await new Promise((r) => { const t = setTimeout(r, stepMs); if (t.unref) t.unref(); });
  }
}

// 注册表一次读成 { 管道地址 → entrypoint }，2 秒内复用（历史重建一次有多条跨会话消息时不再逐条把目录读一遍）
let regCache = { dir: '', at: 0, map: null };
function regMap(regDir, fresh) {
  const now = Date.now();
  if (!fresh && regCache.map && regCache.dir === regDir && now - regCache.at < 2000) return regCache.map;
  const map = new Map();
  try {
    for (const f of readdirSync(regDir)) {
      if (!/^\d+\.json$/.test(f)) continue;
      let j; try { j = JSON.parse(readFileSync(path.join(regDir, f), 'utf8')); } catch { continue; }
      if (j && typeof j.messagingSocketPath === 'string' && j.messagingSocketPath) map.set(j.messagingSocketPath, String(j.entrypoint || ''));
    }
  } catch {}
  regCache = { dir: regDir, at: now, map };
  return map;
}

// 发送方是谁：按管道地址查注册表（还开着的话），认不出就看 from-session（Desktop 的会话 id 是 local_ 开头）。
// fresh = 收到消息的那一刻（对方可能刚起、刚登记）：不用缓存。
export function peerSourceOf(from, fromSession, regDir = REG_DIR, { fresh = false } = {}) {
  if (/^local_/.test(String(fromSession || ''))) return 'desktop';
  const sock = String(from || '').replace(/^uds:/, '');
  if (!sock) return '';
  const ep = regMap(regDir, fresh).get(sock);
  if (ep === undefined) return '';
  if (ep === 'claude-desktop') return 'desktop';
  if (ep === 'cli') return 'terminal';
  if (ep.startsWith('sdk-')) return 'sdk';
  return 'terminal';
}

// —— 来源台账（消息 uuid → desktop / terminal / sdk / ''）——
// 来源只在收到的那一刻认（waitPeerRecord、hold 登记）：对方进程退了登记文件就删了，历史重建再按注册表算会从
//「终端会话」变成「另一个 Claude 会话」。只有主机管理员有这条通道、uuid 全局唯一，记在数据根下一个小文件里（最多 2000 条，挤最老的）。
let srcFile = path.join(DATA_ROOT, 'claude-peer-sources.json');
let srcMap = null;
const SRC_MAX = 2000;
function srcLoad() {
  if (srcMap) return srcMap;
  const raw = readJson(srcFile, {});
  srcMap = new Map(Object.entries(raw && raw.items && typeof raw.items === 'object' ? raw.items : {}).filter(([, v]) => typeof v === 'string'));
  return srcMap;
}
function rememberPeerSource(uuid, source) {
  if (!uuid) return;
  const m = srcLoad();
  if (m.has(uuid)) return;
  m.set(uuid, source || '');
  while (m.size > SRC_MAX) m.delete(m.keys().next().value);
  writeJson(srcFile, { v: 1, items: Object.fromEntries(m) });
}
/** 收到时记下的来源（没记过 = undefined）。 */
export function knownPeerSource(uuid) {
  if (!uuid) return undefined;
  const m = srcLoad();
  return m.has(uuid) ? m.get(uuid) : undefined;
}

const attr = (s) => String(s || '').replace(/[\r\n]+/g, ' ').replace(/[<>"]/g, '').slice(0, 120);
// 正文里夹着的 bridge 自己的信封标签（会话消息 / 子会话汇报 / 只给模型看的提示 / 跨会话信封本身）：
// 在 < 后插一个零宽空格，界面照样显示原字、却再也拼不成标签——别的进程发来的话不能冒充「父会话派来的任务」，也不能藏字。
const FAKE_ENVELOPE_RE = /<(\/?)(session-message|side-sessions-event|session-hint|cross-session-message|note)\b/gi;
export const defuseEnvelopes = (s) => String(s || '').replace(FAKE_ENVELOPE_RE, '<​$1$2');
/** 给前端显示的信封（用户气泡 / 插话段的正文；前端 sessionFamily.svelte.js 解析成会话消息卡）。 */
export function peerDisplay(p, { source } = {}) {
  const src = source ?? knownPeerSource(p.uuid) ?? peerSourceOf(p.from, p.fromSession);
  return `<cross-session-message from="${attr(p.from)}" from-name="${attr(p.name)}"${p.fromSession ? ` from-session="${attr(p.fromSession)}"` : ''}${src ? ` source="${src}"` : ''}>\n${defuseEnvelopes(p.body)}\n</cross-session-message>`;
}

// —— hold 档：扣住等用户确认的消息 ——
// 每个会话一张单子（内存；CLI 进程没了就作废）。gate = 那个 CLI 的 q.applyFlagSettings 包装，claude.mjs 在收到 held 帧时登记。
const holds = new Map();   // key|sid -> { items:[{ uuid, from, name, source, at }], gate }
const K = (key, sid) => key + '|' + sid;
// 有消息扣着 = 这个会话「在等你」：顺带推一帧 question，侧栏 / 列表的等你作答小点亮起来（停放 15 分钟到点就作废，别让人不知道）
const publish = (key, sid) => {
  const items = (holds.get(K(key, sid))?.items || []).map(viewOf);
  busPublish(key, { type: 'peer_hold', sessionId: sid, items });
  busPublish(key, { type: 'question', sessionId: sid, pending: items.length > 0 || sessionQuestions.hasFor(sid, key) });
};
const viewOf = (x) => ({ uuid: x.uuid, from: x.from, name: x.name, source: x.source, ...(x.cause ? { cause: x.cause } : {}), at: x.at });

/** 这个身份有消息扣着等确认的会话 id（hello.pending / 会话列表 pending 并进去）。 */
export function peerHoldSessions(key) {
  const out = [];
  for (const [k, e] of holds) if (e.items.length && k.startsWith(key + '|')) out.push(k.slice(key.length + 1));
  return out;
}
export const hasPeerHold = (key, sid) => !!holds.get(K(key, sid))?.items.length;
registerPendingSource(hasPeerHold);   // 总线 question / run.end 的 pending 把「待你确认」也算上（questions.mjs pendingFor）
/** hello 帧带的快照 { 会话 id: [扣着的消息] }：断线期间的变化重连即对账。 */
export function peerHoldsSnapshot(key) {
  const out = {};
  for (const sid of peerHoldSessions(key)) out[sid] = peerHoldsOf(key, sid);
  return out;
}

/** claude.mjs：流里来了 system/peer_message_hold。gate(value) 改这个 CLI 的 crossSessionInbound。 */
export function notePeerHold(ctx, sid, m, gate) {
  if (!ctx || !sid || !m) return;
  const k = K(ctx.key, sid);
  const e = holds.get(k) || { items: [], gate: null };
  if (gate) e.gate = gate;
  const uuid = String(m.message_uuid || '');
  if (m.state === 'held') {
    if (uuid && !e.items.some((x) => x.uuid === uuid)) {
      const from = String(m.from || '');
      const source = peerSourceOf(from, '', REG_DIR, { fresh: true });
      rememberPeerSource(uuid, source);
      e.items.push({ uuid, from, name: String(m.from_name || ''), source, cause: String(m.cause || m.hold_cause || ''), at: Date.now() });
      while (e.items.length > 20) e.items.shift();
    }
  } else if (uuid) {
    e.items = e.items.filter((x) => x.uuid !== uuid);   // released / dropped
  }
  holds.set(k, e);
  publish(ctx.key, sid);
}

export function peerHoldsOf(key, sid) { return (holds.get(K(key, sid))?.items || []).map(viewOf); }

/** 用户在「待你确认」卡上点了投递 / 拒收。返回 { ok, reason? }。 */
// base = 收回的闸（peerInbound 的值；null = 清掉 bridge 写的、回到 spawn 时的值 / CLI 默认）
export async function resolvePeerHold(key, sid, action, base = 'hold') {
  const e = holds.get(K(key, sid));
  if (!e || !e.items.length) return { ok: false, reason: '没有待确认的消息了' };
  if (!e.gate) return { ok: false, reason: '这个会话的进程已经不在了，消息已作废' };
  try {
    await e.gate(action === 'accept' ? 'accept' : 'refuse');   // 放行 / 整批丢弃（CLI 立刻按新闸重判扣着的消息）
    await e.gate(base);                                         // 再收回原来的闸
  } catch (err) { return { ok: false, reason: String((err && err.message) || err) }; }
  // CLI 会补发 released / dropped 帧逐条清单子；这里先清，免得卡片在等那几帧时还亮着
  e.items = [];
  publish(key, sid);
  return { ok: true };
}

/** CLI 进程退了：扣着的消息随之作废（gate 不是这个进程登记的就不动——同会话已换了新进程）。 */
export function dropPeerGate(key, sid, gate) {
  const k = K(key, sid);
  const e = holds.get(k);
  if (!e || (gate && e.gate && e.gate !== gate)) return;
  holds.delete(k);
  if (e.items.length) publish(key, sid);
}

export function _resetPeers() { holds.clear(); liveGates.clear(); regCache = { dir: '', at: 0, map: null }; }
export function _setPeerSourceFile(f) { srcFile = f; srcMap = null; }
