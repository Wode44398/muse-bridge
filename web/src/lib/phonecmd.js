// 档 2 手机端执行器：收到 PC 上 Claude 下发的 phone_cmd（SSE 事件）→ 调原生 SAF
// （window.AndroidStore.*，与「本地工作空间」同一套桥）→ POST /api/phone-result 回传。
//
// 命令通道：src/runtime/phone-bridge.mjs（PC 侧）把 {cmdId,op,args} 推到对话流，本函数
// 执行后回传 {cmdId,ok,result?,error?}。op: list/read/write/scan/delete/pull。
//
// 仅离线 apk 内可用（原生桥存在）+ 已授权本地工作空间文件夹。范围=用户 SAF 授权的那个
// 文件夹（Android 硬约束，看不到整机/app 私有缓存）。
import { api } from './api.js';
import { localFileUrl } from './localfs.js';

const S = () => (typeof window !== 'undefined' ? window.AndroidStore : null);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// 把手机本地文件流式拉上 PC（uploads/）：fetch 原生 /__localfile（带 Range 的本地流，
// 不整读进 JS 内存）→ 攒 ~4MB 分块顺序 POST /api/upload-chunk（服务端流式落盘，上限 2GB）。
// 返回 {path(PC 绝对路径), name, size}。仅离线 apk 壳内可用（无原生流时 fetch 404 → 抛错走兜底）。
async function pullToPc(rel, name) {
  const resp = await fetch(localFileUrl(rel));
  if (!resp.ok || !resp.body) throw new Error('本地流不可用');   // i18n-ignore 回传给 agent 的工具结果（AI 读）
  const reader = resp.body.getReader();
  const id = 'pf' + Math.random().toString(36).slice(2, 12);
  const CHUNK = 4 * 1024 * 1024;
  let buf = [], bufBytes = 0, total = 0, fin = null;
  const flush = async (last) => {
    const blob = new Blob(buf); buf = []; bufBytes = 0;
    const r = await api.post(`/api/upload-chunk?id=${id}&last=${last ? 1 : 0}&name=${encodeURIComponent(name)}`, blob);
    if (last) fin = r;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.push(value); bufBytes += value.byteLength; total += value.byteLength;
    if (bufBytes >= CHUNK) await flush(false);
  }
  await flush(true);   // 末块（可为空——last=1 让服务端 finalize 落名）
  if (!fin || !fin.path) throw new Error('上传未完成');   // i18n-ignore 回传给 agent 的工具结果（AI 读）
  return { path: fin.path, name: fin.name, size: total };
}

export async function runPhoneCmd(ev) {
  const { cmdId, op, args = {} } = ev || {};
  if (!cmdId) return;
  let result = null, ok = true, error = '';
  const s = S();
  // 不支持原生桥的设备（电脑浏览器直播镜像 / 在线壳）【静默忽略】：别抢答失败——真正的手机
  // 可能同时挂着同一条流，抢答会把 pending 命令 settle 成失败（镜像竞态）。没手机在线时由
  // PC 侧超时兜底。
  if (!s || typeof s.localList !== 'function') return;
  try {
    if (typeof s.hasLocalRoot === 'function' && !s.hasLocalRoot()) throw new Error('尚未授权本地工作空间文件夹——请在工作空间「本地」tab 选择一个手机文件夹');   // i18n-ignore 回传给 agent 的工具结果（AI 读）

    if (op === 'list') {
      const r = parse(s.localList(args.path || '')) || {};
      if (r.error) throw new Error(r.error);
      result = { entries: r.items || [] };
    } else if (op === 'read') {
      const enc = args.encoding === 'base64' ? 'base64' : 'utf8';
      const content = enc === 'base64' ? s.localReadB64(args.path) : s.localReadText(args.path);
      if (content == null) throw new Error('读取失败（文件不存在、过大或非该类型）');   // i18n-ignore 回传给 agent 的工具结果（AI 读）
      result = { content, encoding: enc };
    } else if (op === 'write') {
      if (typeof s.localWrite !== 'function') throw new Error('当前 app 版本不支持写入，请更新');   // i18n-ignore 回传给 agent 的工具结果（AI 读）
      const r = parse(s.localWrite(args.path, String(args.content ?? ''), args.encoding === 'base64')) || {};
      if (!r.ok) throw new Error(r.error || '写入失败');   // i18n-ignore 回传给 agent 的工具结果（AI 读）
      result = { ok: true, name: r.name };
    } else if (op === 'scan') {
      if (typeof s.localScan !== 'function') throw new Error('当前 app 版本不支持扫描，请更新');   // i18n-ignore 回传给 agent 的工具结果（AI 读）
      const r = parse(s.localScan(args.path || '', args.minSizeMB ?? 20, args.limit ?? 100)) || {};
      if (r.error) throw new Error(r.error);
      result = { files: r.files || [], truncated: !!r.truncated };
    } else if (op === 'delete') {
      if (typeof s.localDelete !== 'function') throw new Error('当前 app 版本不支持删除，请更新');   // i18n-ignore 回传给 agent 的工具结果（AI 读）
      const r = parse(s.localDelete(args.path)) || {};
      if (!r.ok) throw new Error(r.error || '删除失败');   // i18n-ignore 回传给 agent 的工具结果（AI 读）
      result = { ok: true };
    } else if (op === 'pull') {
      // 把手机文件完整拉到 PC（解压/转格式等「电脑工具」场景）。优先原生流式分块（大文件），
      // 原生流不可用（在线壳/dev）→ 退回 base64 单发（/api/upload 上限 20MB）。
      const p = String(args.path || '');
      const name = p.split('/').pop() || 'file';
      try {
        result = await pullToPc(p, name);
      } catch (e1) {
        const b64 = s.localReadB64(p);
        if (!b64) throw new Error('拉取失败：' + String(e1?.message ?? e1) + '（且 base64 兜底读不到——文件不存在或过大，兜底上限约 20MB）');   // i18n-ignore 回传给 agent 的工具结果（AI 读）
        const up = await api.upload(name, b64);
        result = { path: up.path, name: up.name, size: Math.floor(b64.length * 3 / 4) };
      }
    } else {
      throw new Error('未知操作：' + op);   // i18n-ignore 回传给 agent 的工具结果（AI 读）
    }
  } catch (e) { ok = false; error = String(e?.message ?? e); }
  try { await api.post('/api/phone-result', { cmdId, ok, result, error }); } catch {}
}
