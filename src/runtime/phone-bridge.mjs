// 档 2「手机即远程文件系统」的 PC 侧命令通道。
//
// Claude 在 PC 上调 mcp__phone__* 工具 → 工具 handler 调 requestPhone() → 把一条
// phone_cmd 推到【发起本轮对话的那台手机】的活跃 SSE 流 → 手机原生层（SAF）执行 →
// 手机 POST /api/phone-result 回传 → settle 对应 Promise → 工具拿到结果返回 Claude。
//
// 命令天然下发到「当前在对话的那台手机」（gen 按 caller key 分桶），所以多用户隔离
// 自动成立：每个人的 Claude 只能操作每个人自己手机授权的文件夹。
//
// 这是 questions.mjs（AskUserQuestion 反向通道）的同构推广：pendingPhoneCmds 取代
// pendingQuestions，op/args 取代 question，ownerKey 校验回传方身份一致。
//
// ⚠️ 手机原生侧（SAF 目录授权 + JS 桥执行 phone_cmd + POST 回传）尚未实现——等
// 「工作空间」前端大工程做完再搭。本模块是 PC 侧的完整后端，用 mock 手机客户端可
// 端到端验证；生产用 config.phoneFs 门控（默认关，挂载见 claude.mjs）。
import { readBody } from './body.mjs';
import { contextFor } from './identity.mjs';
import { getCurrentGen, genEmit } from './gen.mjs';
import { randomBytes } from 'node:crypto';

// cmdId -> { ownerKey, settle(result), fail(err) }
const pendingPhoneCmds = new Map();

// read 回传 / write 下发的字节上限（走 SSE/POST body，别撑爆）。scan 只回元数据。
export const PHONE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 向「genKey 对应的活跃手机」下发一条文件命令，等回传。
 * @param {object} o
 *  genKey   caller key（'admin' / 'u:<name>'）——命令推到这台设备的活跃 gen
 *  gen      可选：直接指定要下发到的那一轮（多对话并发下由发起调用的 query 闭包传入，
 *           避免按 key 找「唯一活跃 gen」串到并行的另一轮）；缺省回落 key 查找
 *  op       'list' | 'read' | 'write' | 'scan' | 'delete' | 'pull'
 *           （pull 的文件字节不走本通道——手机直接分块 POST /api/upload-chunk 落 PC，
 *             回传只有 {path,name,size} 元数据，所以不受 PHONE_MAX_BYTES 限制）
 *  args     该 op 的参数
 *  timeoutMs 默认 60s（scan 大目录可放宽）
 * @returns {Promise<any>} 手机回传的 result（ok=false 时 reject 带 error）
 */
export function requestPhone({ genKey = 'admin', gen: genArg, op, args = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const gen = genArg || getCurrentGen(genKey);
    // 没有活跃 gen = 没有手机正连着这轮对话。Claude 几乎总是在对话上下文里调这工具，
    // 所以正常情况 gen 一定在；拿不到就是手机断了/后台被杀。
    if (!gen) { reject(new Error('手机未连接（没有活跃的对话流，无法下发文件命令）')); return; }

    const cmdId = 'pf-' + randomBytes(6).toString('hex');
    let done = false;
    const signal = gen.abort && gen.abort.signal;
    const cleanup = () => {
      done = true;
      pendingPhoneCmds.delete(cmdId);
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      // 一次性命令：处理完从缓冲移除，免得 /api/attach 重连重放又执行一遍。
      try { gen.events = gen.events.filter((e) => !(e && e.type === 'phone_cmd' && e.cmdId === cmdId)); } catch {}
    };
    const onAbort = () => { if (!done) { cleanup(); reject(new Error('已中断')); } };
    const timer = setTimeout(() => { if (!done) { cleanup(); reject(new Error('手机未响应（请确认手机 App 在线且已在工作空间「本地」tab 授权过文件夹）')); } }, timeoutMs);

    pendingPhoneCmds.set(cmdId, {
      ownerKey: genKey,
      settle: (result) => { if (!done) { cleanup(); resolve(result); } },
      fail: (err) => { if (!done) { cleanup(); reject(err instanceof Error ? err : new Error(String(err || '失败'))); } },
    });
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    genEmit(gen, { type: 'phone_cmd', cmdId, op, args });
  });
}

// POST /api/phone-result：手机执行完 phone_cmd 后回传结果。
// body: { cmdId, ok, result? , error? }
export async function handlePhoneResult(req, res, { identify }) {
  const id = identify(req);
  if (!id || (id.kind !== 'admin' && id.kind !== 'user')) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
  let body;
  try { body = JSON.parse(await readBody(req, PHONE_MAX_BYTES + 1024 * 1024)); }
  catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }

  const cmdId = String(body.cmdId || '');
  const entry = pendingPhoneCmds.get(cmdId);
  if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no pending command'); return; }
  // 回传方身份必须等于发起命令那轮的 caller（cmdId 只在该 caller 自己的 SSE 流里出现过；
  // 纵深防御：泄漏的 cmdId 不能被另一账号拿去塞结果）。
  if (entry.ownerKey && entry.ownerKey !== contextFor(id).key) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return;
  }
  if (body.ok === false) entry.fail(String(body.error || '手机端执行失败'));
  else entry.settle(body.result === undefined ? null : body.result);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
