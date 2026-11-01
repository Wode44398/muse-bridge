// 「这条消息是从哪台客户端发来的」——发送端识别、按会话的逐条记录，以及安卓客户端名册。
//
// 为什么不写进提示词：同一个会话会在几台 Win 客户端、手机 App、浏览器之间来回接着聊，停放的 CLI 也跨轮复用，
// 写死在提示词里要么过时、要么每换一台就冷起。所以发送端只落在这里，agent 需要在用户本地做事时
// 经 mcp__device__devices 现查（「这条消息发自」+ 设备清单上的标记 + history 逐条回看）。
//
// 发送端 origin = { kind, id?, name?, detail? }：
//   desktop  Windows 桌面客户端（瘦客户端里的网页带上壳登记的设备 id，routes/chat.mjs 的 fromComputer）
//   phone    安卓 App（WebView UA 的 BridgeDevice/<id>、胶囊的 X-Bridge-Device；id 同手机操控的 'd:<id>' / 'm:<机型>'）
//   web      浏览器（没装客户端）
//   session  别的 Claude 会话 / bridge 自己发起的（派生、会话间消息、CI 监控……）
//   internal bridge agent 接口（Codex / dimensio 等经 internalRequest 代发）
//   admin    管理控制台代聊
//
// 手机名册：桌面客户端登录即登记（devices.json），手机没有登记这一步——这里按「来过就记」补一份：
// 聊天请求记 id + 机型，「手机操控」长轮询再补上用户起的设备名、系统版本、App 版本。按身份 key 分。

import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { DATA_ROOT } from './paths.mjs';

const PHONES_PATH = path.join(DATA_ROOT, 'phone-clients.json');
const PHONES_PER_OWNER = 20;          // 重装 App 会换 id，旧的按最近使用挤掉
const ORIGIN_SESSIONS = 400;          // 只留最近 N 个会话的发送端记录
const ORIGINS_PER_SESSION = 200;
const TEXT_CLIP = 60;

const nowIso = () => new Date().toISOString();
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

// —— 安卓客户端名册 ——
let phones = null;
let phonesDirty = false;
let phonesTimer = null;
function loadPhones() {
  if (phones) return phones;
  try { phones = JSON.parse(readFileSync(PHONES_PATH, 'utf8')); } catch { phones = null; }
  if (!phones || typeof phones !== 'object') phones = {};
  phones.owners = Object.assign(Object.create(null), phones.owners && typeof phones.owners === 'object' ? phones.owners : {});
  return phones;
}
function savePhones() {
  phonesDirty = false;
  try {
    mkdirSync(path.dirname(PHONES_PATH), { recursive: true });
    const tmp = PHONES_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(phones));
    renameSync(tmp, PHONES_PATH);
  } catch {}
}
// 「最近在用」每次请求都会变，攒 30 秒写一次；新设备 / 改名当场写。
function schedulePhonesSave(now) {
  if (now) { if (phonesTimer) { clearTimeout(phonesTimer); phonesTimer = null; } savePhones(); return; }
  phonesDirty = true;
  if (phonesTimer) return;
  phonesTimer = setTimeout(() => { phonesTimer = null; if (phonesDirty) savePhones(); }, 30_000);
  phonesTimer.unref?.();
}

/**
 * 记一次手机客户端的活动。owner = 身份 key；id = phone-control 的 deviceIdFromReq（'d:…' / 'm:…'，'legacy' 不记）。
 * info：name / model / android / appCode（有就更新，空的不覆盖）。
 */
export function notePhoneClient(owner, id, info = {}) {
  if (!owner || !id || id === 'legacy') return;
  const all = loadPhones();
  const mine = all.owners[owner] || (all.owners[owner] = Object.create(null));
  const p = mine[id];
  const isNew = !p;
  const rec = p || (mine[id] = { id, firstSeenAt: nowIso() });
  let renamed = false;
  for (const k of ['name', 'model', 'android']) {
    const v = clip(info[k], 60);
    if (v && rec[k] !== v) { rec[k] = v; renamed = true; }
  }
  const code = Number(info.appCode);
  if (Number.isFinite(code) && code > 0) rec.appCode = code;
  rec.lastSeenAt = nowIso();
  if (isNew) {
    const ids = Object.keys(mine);
    if (ids.length > PHONES_PER_OWNER) {
      ids.sort((a, b) => String(mine[a].lastSeenAt).localeCompare(String(mine[b].lastSeenAt)))
        .slice(0, ids.length - PHONES_PER_OWNER).forEach((k) => { delete mine[k]; });
    }
  }
  schedulePhonesSave(isNew || renamed);
}

/** 这个身份用过的手机，最近用过的在前。 */
export function phoneClients(owner) {
  const mine = owner ? loadPhones().owners[owner] : null;
  if (!mine) return [];
  return Object.values(mine).map((p) => ({ ...p }))
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
}

/** 手机的短句柄（同手机操控的 device 参数）：'d:<id>' 取前 6 位，'m:<机型>' 取机型。 */
export function phoneHandle(id) {
  const s = String(id || '');
  if (s.startsWith('d:')) return s.slice(2, 8);
  if (s.startsWith('m:')) return s.slice(2);
  return s;
}
export const phoneName = (p) => (p && (p.name || p.model)) || '安卓手机';

// —— 发送端识别 ——
/** 浏览器 UA → 「Edge · Windows」这样的短描述（只给人/模型看，不做判断用）。 */
export function browserOf(ua) {
  const s = String(ua || '');
  const b = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  const os = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return [b, os].filter(Boolean).join(' · ');
}

const FAMILY_LABEL = {
  spawn: '父会话派生出这个会话时交代的任务', inbox: '子会话 / 别的会话发来的汇报', peer: '另一个 Claude 会话发来的消息',
  plan: '计划模式拆出的新会话', ci: '拉取请求监控（CI / 评审事件）',
};

/**
 * 这条 /api/chat 请求是从哪台客户端发来的。
 * @param {object} o
 * @param {object} o.headers       请求头（排队 / 限额续跑重放时是当初那条请求的头）
 * @param {boolean} o.fromPhone    routes/chat.mjs 判出的「手机 App 发起」
 * @param {string} [o.phoneId]     手机 id（deviceIdFromReq，'legacy' 视为没有）
 * @param {string} [o.phoneModel]  UA 里的机型号
 * @param {object} [o.computer]    已核对归属的桌面客户端设备 { id, name }
 * @param {boolean} [o.capsule]    原生悬浮胶囊发的
 * @param {boolean} [o.narrow]     窄屏网页
 * @param {object} [o.family]      会话派生 / 会话间消息（session-family.mjs 的 FAMILY_REQ）
 * @param {boolean} [o.internal]   bridge agent 接口代发（internalRequest 的假请求）
 */
export function describeOrigin({ headers = {}, fromPhone = false, phoneId = '', phoneModel = '', computer = null, capsule = false, narrow = false, family = null, internal = false } = {}) {
  const fk = family && family.origin && family.origin.kind;
  if (fk) return { kind: 'session', detail: FAMILY_LABEL[fk] || 'bridge 内部发起' };
  if (computer && computer.id) return { kind: 'desktop', id: computer.id, name: computer.name || '' };
  if (fromPhone) {
    const id = phoneId && phoneId !== 'legacy' ? phoneId : '';
    return { kind: 'phone', ...(id ? { id } : {}), name: phoneModel || '', ...(capsule ? { detail: '悬浮胶囊' } : {}) };
  }
  const ua = String(headers['user-agent'] || '');
  if (internal || ua === 'bridge-agent-api') return { kind: 'internal', detail: 'bridge agent 接口代发（Codex / dimensio / 自动化）' };
  const br = browserOf(ua);
  return { kind: 'web', detail: [narrow ? '窄屏' : '', br].filter(Boolean).join(' ') || '' };
}

/**
 * 给人/模型看的一句话。lookup 现查名字（设备改名、手机后来才报上设备名）：
 * { desktop: (id) => {name}|null, phone: (id) => {name,model}|null }
 */
export function originLabel(o, lookup = {}) {
  if (!o) return '未知';
  if (o.kind === 'desktop') {
    const d = lookup.desktop ? lookup.desktop(o.id) : null;
    return `Windows 桌面客户端「${(d && d.name) || o.name || o.id}」[${o.id}]`;
  }
  if (o.kind === 'phone') {
    const p = o.id && lookup.phone ? lookup.phone(o.id) : null;
    const nm = (p && phoneName(p)) || o.name || '安卓手机';
    return `安卓 App「${nm}」${o.id ? `[${phoneHandle(o.id)}]` : ''}${o.detail ? '（' + o.detail + '）' : ''}`;
  }
  if (o.kind === 'web') return '浏览器网页（没经客户端）' + (o.detail ? '：' + o.detail : '');
  if (o.kind === 'admin') return '管理控制台代聊';
  return o.detail || 'bridge 内部发起';
}

// —— 每条消息的发送端（按会话）——
const cache = new Map();   // file -> data
const fileFor = (ctx) => path.join(ctx.dataDir, 'claude-msg-origins.json');
function loadOrigins(file) {
  if (cache.has(file)) return cache.get(file);
  let data = null;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  if (!data || typeof data !== 'object') data = {};
  data.sessions = Object.assign(Object.create(null), data.sessions && typeof data.sessions === 'object' ? data.sessions : {});
  cache.set(file, data);
  return data;
}

/** 记一条用户消息的发送端。text 只留开头一小段，用来和对话里的消息对上号。 */
export function recordMessageOrigin(ctx, sessionId, origin, text = '') {
  if (!ctx?.dataDir || !sessionId || !origin) return;
  const file = fileFor(ctx);
  const data = loadOrigins(file);
  const list = data.sessions[sessionId] || [];
  list.push({ at: nowIso(), ...origin, text: clip(text, TEXT_CLIP) });
  if (list.length > ORIGINS_PER_SESSION) list.splice(0, list.length - ORIGINS_PER_SESSION);
  // 重新插入 = 挪到末尾，超额时从最久没动的会话删起
  delete data.sessions[sessionId];
  data.sessions[sessionId] = list;
  const ids = Object.keys(data.sessions);
  if (ids.length > ORIGIN_SESSIONS) ids.slice(0, ids.length - ORIGIN_SESSIONS).forEach((k) => { delete data.sessions[k]; });
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  } catch {}
}

/** 这个会话最近 n 条用户消息的发送端（旧 → 新）。 */
export function messageOrigins(ctx, sessionId, n = 10) {
  if (!ctx?.dataDir || !sessionId) return [];
  const list = loadOrigins(fileFor(ctx)).sessions[sessionId] || [];
  return list.slice(-Math.max(1, n));
}

export function __resetClientOriginsForTest() { phones = null; cache.clear(); if (phonesTimer) { clearTimeout(phonesTimer); phonesTimer = null; } }
