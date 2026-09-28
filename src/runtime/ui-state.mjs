// 工作区人机协同的两块地基（内存态，进程重启即清，无隐私落盘）：
//
// ① UI 视图快照 —— 前端（手机/电脑浏览器）把「用户此刻在看什么」防抖上报到
//    POST /api/ui/state：dock 开没开、文件面板在哪个目录、预览着哪个文件（页码/
//    编辑态）。按 ctx.key + clientId 存，agent 的 mcp__workspace__workspace view
//    读最新鲜的一份。多设备同时在线时全部保留，按新鲜度排序。
//
// ② 请求-应答 broker —— agent 要前端【干一件事并交回结果】（截图当前预览、拉取
//    未保存草稿）时：makeUiRequest 经本轮 gen 的 SSE 下发 {type:'wsx', op, id}，
//    前端做完 POST /api/ui/answer {id, ...} 回来，挂起的 MCP 调用即刻返回。
//    gen 事件会被 /api/attach 重放——前端按 at 时间窗 + 已处理 id 去重，服务端
//    这边过期/未知 id 的应答直接丢弃，双保险。

import { randomUUID } from 'node:crypto';
import { genEmit } from './gen.mjs';

const FRESH_MS = 90_000;          // 上报超过 90s 视为陈旧（用户可能已锁屏/关页）
const MAX_CLIENTS_PER_KEY = 8;    // 每个身份最多留 8 个客户端快照（防伪造 clientId 撑爆）

const states = new Map();   // ctx.key -> Map(clientId -> { client, state, at })

export function noteUiState(key, clientId, client, state) {
  if (!key || !clientId) return;
  let m = states.get(key);
  if (!m) { m = new Map(); states.set(key, m); }
  if (!m.has(clientId) && m.size >= MAX_CLIENTS_PER_KEY) {
    // 满了先踢最旧的
    let oldest = null;
    for (const [id, v] of m) if (!oldest || v.at < oldest.v.at) oldest = { id, v };
    if (oldest) m.delete(oldest.id);
  }
  m.set(clientId, { client: String(client || 'web'), state: state || {}, at: Date.now() });
}

// 该身份的全部新鲜快照，按上报时间倒序（[0] = 最新）。
export function getUiState(key) {
  const m = states.get(key);
  if (!m) return [];
  const now = Date.now();
  const out = [];
  for (const [clientId, v] of m) {
    if (now - v.at > FRESH_MS * 10) { m.delete(clientId); continue; }   // 十倍陈旧直接清
    out.push({ clientId, client: v.client, state: v.state, at: v.at, fresh: now - v.at <= FRESH_MS });
  }
  out.sort((a, b) => b.at - a.at);
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
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(result || {});
  return true;
}
