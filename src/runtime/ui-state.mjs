// 工作区人机协同的两块地基（内存态，进程重启即清，无隐私落盘）：
//
// ① UI 视图快照 —— 前端（手机/网页/桌面壳）把「用户此刻在看什么」防抖上报到
//    POST /api/ui/state：dock 开没开、文件面板在哪个目录、预览着哪个文件（页码/
//    编辑态）。按 ctx.key + clientId 存，agent 的 mcp__workspace__workspace view
//    读最新鲜的一份。多设备同时在线时全部保留，按新鲜度排序。
//
// ② 请求-应答 broker —— agent 要前端【干一件事并交回结果】（截图当前预览、拉取
//    未保存草稿）时：makeUiRequest 经本轮 gen 的 SSE 下发 {type:'wsx', op, id}，
//    前端做完 POST /api/ui/answer {id, ...} 回来，挂起的 MCP 调用即刻返回。
//    gen 事件会被 /api/attach 重放——前端按 at 时间窗 + 已处理 id 去重，服务端
//    这边过期/未知 id 的应答直接丢弃，双保险。
//
// ③ 界面指令回执 —— agent 接口的 ui.open / ui.notify 经账号总线发 ui.cmd，前端执行完拿同一个 id
//    POST /api/ui/answer 回执 {ok, client, visible, reason?}；waitUiAck 等它（同一张 pending 表）。
//    没回执 = 没确认（界面在后台/锁屏/已关，或不回执的旧版 App），调用方照实说，不报假成功。

import { randomUUID } from 'node:crypto';
import { genEmit } from './gen.mjs';

const FRESH_MS = 90_000;          // 上报超过 90s 视为陈旧（用户可能已锁屏/关页）
const MAX_CLIENTS_PER_KEY = 8;    // 每个身份最多留 8 个客户端快照（防伪造 clientId 撑爆）

const states = new Map();   // ctx.key -> Map(clientId -> { client, state, at, activeAt, device, visible })

// opts.device：这一端所在手机的设备 id（phone-control 的 'd:…' / 'm:…'；网页 / 桌面 = null）。
// opts.visible：页面此刻在不在前台（新版前端才报；旧版 = null 未知）。
// opts.beat：心跳（前台时每分钟一次、切到后台时一次）——只续「最近联系」at，不算用户又在这一端操作了，
// 所以不动 activeAt（「最近活跃的那个界面」按 activeAt 挑）。
export function noteUiState(key, clientId, client, state, { device = null, visible = null, beat = false } = {}) {
  if (!key || !clientId) return;
  let m = states.get(key);
  if (!m) { m = new Map(); states.set(key, m); }
  const prev = m.get(clientId);
  if (!prev && m.size >= MAX_CLIENTS_PER_KEY) {
    // 满了先踢最旧的
    let oldest = null;
    for (const [id, v] of m) if (!oldest || v.at < oldest.v.at) oldest = { id, v };
    if (oldest) m.delete(oldest.id);
  }
  const now = Date.now();
  m.set(clientId, {
    client: String(client || 'web'), state: state || {}, at: now,
    activeAt: beat && prev ? prev.activeAt : now,
    device: device || null,
    visible: typeof visible === 'boolean' ? visible : null,
  });
}

// 该身份的全部快照（十倍陈旧的清掉），按最近活跃倒序（[0] = 用户最近在用的那一端）。
// fresh = 90 秒内联系过（视图变化或心跳）；不等于用户一定看得见——看 visible。
export function getUiState(key) {
  const m = states.get(key);
  if (!m) return [];
  const now = Date.now();
  const out = [];
  for (const [clientId, v] of m) {
    if (now - v.at > FRESH_MS * 10) { m.delete(clientId); continue; }   // 十倍陈旧直接清
    out.push({ clientId, client: v.client, state: v.state, at: v.at, activeAt: v.activeAt || v.at, fresh: now - v.at <= FRESH_MS, device: v.device || null, visible: v.visible ?? null });
  }
  out.sort((a, b) => b.activeAt - a.activeAt);
  return out;
}

// ---- 请求-应答 broker ----

const pending = new Map();   // id -> { resolve, reject, timer, key }

export function makeUiRequest(gen, key, op, payload = {}, { timeoutMs = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('前端没有应答（用户端可能不在线、App 版本较旧、或该内容不支持此操作）'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, key });
    genEmit(gen, { type: 'wsx', op, id, ...payload, at: Date.now() });
  });
}

// 前端应答落地。身份 key 必须与发起时一致（别的账号拿到 id 也答不进来）。
export function answerUiRequest(key, id, result) {
  const p = pending.get(id);
  if (!p || p.key !== key) return false;
  const r = result || {};
  if (p.take && !p.take(r)) return true;   // 回执收下了，但还要接着等（见 waitUiAck 的 needOk）
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(r);
  return true;
}

// 等界面指令的回执：先登记、再发指令（同步登记，回执来得再快也不会落空）。超时 resolve(null)，不抛。
// needOk：广播给多端时，先回来的 ok:false 先记着、接着等别的端；到点还没有 ok 的就交出最后那份 ok:false。
// expect：广播时会回执的端数（报了在前台的那几端）；它们都回了 ok:false 就不再干等到点。
export function waitUiAck(key, id, ms = 4000, { needOk = false, expect = 0 } = {}) {
  return new Promise((resolve) => {
    let last = null, fails = 0;
    const timer = setTimeout(() => { pending.delete(id); resolve(last); }, ms);
    pending.set(id, {
      key, timer, resolve,
      reject: () => { pending.delete(id); clearTimeout(timer); resolve(last); },
      take: (r) => { if (!needOk || r.ok !== false) return true; last = r; return expect > 0 && ++fails >= expect; },
    });
  });
}
