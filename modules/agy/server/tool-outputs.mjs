// bridge 工具（mcp_bridge_*）的返回内容。
//
// agy 给 MCP 工具发的 tool_call_update 不带返回内容（11-19 实测：completed / failed 都只有入参），
// 步骤展开就只能看到入参、看不到返回和报错原因。返回内容其实都经过 bridge——中枢工具在服务端执行，
// 媒体 / 界面 / 手机文件在 stdio 子进程里执行后报回来——所以这里把它补进本轮事件流（实时），
// 并按会话落一份小文件（重新打开历史时套回去）。
//
// 一个会话一个文件 <agy 数据目录>/tool-outputs/<会话 id>.json，不进 sessions-meta.json：那个文件所有会话共用、
// 每次写都整份重写，塞返回内容会越写越大。

import path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { readJson, writeJson } from '@bridge/core/jsonfile.mjs';
import { genEmit } from '@bridge/core/runtime/gen.mjs';

const MAX_TEXT = 4000;       // 单条返回最多留这么多字
const MAX_PER_SESSION = 200; // 一个会话最多留这么多条（先进先出）
const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;

const HASHED_NAME = (name) => new RegExp(`^mcp_+bridge_+(?:[0-9a-f]{8}_+)?${name.replace(/[^a-z0-9_]/gi, '')}$`, 'i');

function fileOf(agyDir, sessionId) {
  const id = String(sessionId || '').trim();
  if (!agyDir || !SAFE_ID.test(id)) return '';
  return path.join(agyDir, 'tool-outputs', id + '.json');
}

/** MCP CallToolResult → 给人看的一段文字（图片等二进制只留占位）。 */
export function toolResultText(result) {
  const parts = [];
  for (const c of (Array.isArray(result?.content) ? result.content : [])) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'image') parts.push('[图片]');
    else if (c.type === 'audio') parts.push('[音频]');
    else if (c.type === 'resource' || c.type === 'resource_link') parts.push('[资源]');
  }
  const text = parts.join('\n').trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n…（太长，已截断）' : text;
}

/** 彻底删除会话时一并删掉它的返回内容文件。 */
export function dropToolOutputs(agyDir, sessionId) {
  const file = fileOf(agyDir, sessionId);
  if (!file) return;
  try { rmSync(file, { force: true }); } catch {}
}

export function readToolOutputs(agyDir, sessionId) {
  const file = fileOf(agyDir, sessionId);
  if (!file) return {};
  const data = readJson(file, null);
  return data && typeof data === 'object' && data.outputs && typeof data.outputs === 'object' ? data.outputs : {};
}

function saveToolOutput(agyDir, sessionId, toolCallId, entry) {
  const file = fileOf(agyDir, sessionId);
  if (!file || !toolCallId) return;
  const outputs = readToolOutputs(agyDir, sessionId);
  delete outputs[toolCallId];
  outputs[toolCallId] = entry;
  const keys = Object.keys(outputs);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PER_SESSION))) delete outputs[k];
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, { outputs }, 0);
  } catch (e) {
    console.error('[agy] 记工具返回失败：', e?.message || e);
  }
}

// 参数比对：agy 发给 MCP 的参数里没有它自己加的 toolSummary，键序也可能不同
function argsKey(args) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  const a = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  delete a.toolSummary;
  try { return JSON.stringify(norm(a)); } catch { return ''; }
}

/** 这一轮里，这次调用对应的是哪一条工具记录：同名、还没记过返回，参数对得上的优先，否则取最早那条。 */
export function matchToolCallId(gen, name, args) {
  const re = HASHED_NAME(String(name || ''));
  const done = gen?._toolOutputIds instanceof Set ? gen._toolOutputIds : new Set();
  const byId = new Map();   // toolCallId -> { args }
  for (const ev of (Array.isArray(gen?.events) ? gen.events : [])) {
    if (!ev || (ev.type !== 'tool' && ev.type !== 'tool-update')) continue;
    const t = ev.tool && typeof ev.tool === 'object' ? ev.tool : ev;
    const id = String(t.toolCallId || '');
    if (!id) continue;
    const rec = byId.get(id) || { name: '', args: null, status: '' };
    if (t.name) rec.name = String(t.name);
    if (t.status) rec.status = String(t.status);
    if (t.args && typeof t.args === 'object' && Object.keys(t.args).length) rec.args = t.args;
    byId.set(id, rec);
  }
  const want = argsKey(args);
  let fallback = '';
  for (const [id, rec] of byId) {
    if (done.has(id) || !re.test(rec.name)) continue;
    // 已经了结的（审批被拒、agy 判失败 / 取消）不会再有返回：留在候选里的话，用户拒了一次又同意、模型拿同样参数重发时，
    // 返回会贴到被拒的那一步上。返回总是先于 agy 的「完成」事件记下，所以正常完成的不会走到这里还没记。
    if (/^(failed|cancelled|canceled|rejected|completed)$/i.test(rec.status)) continue;
    if (argsKey(rec.args) === want) return id;
    if (!fallback) fallback = id;
  }
  return fallback;
}

/**
 * 记一次 bridge 工具的返回：补进本轮事件流（前端步骤行立刻能展开看到），并落盘给历史用。
 * name = 对外工具名（不带 mcp_bridge_ 前缀）。对不上工具记录就什么都不做。
 */
export function recordToolOutput(ctx, gen, { name, args, text, isError = false } = {}) {
  const body = String(text || '').trim();
  if (!gen || !body) return '';
  const toolCallId = matchToolCallId(gen, name, args);
  if (!toolCallId) return '';
  if (!(gen._toolOutputIds instanceof Set)) gen._toolOutputIds = new Set();
  gen._toolOutputIds.add(toolCallId);
  const output = body.length > MAX_TEXT ? body.slice(0, MAX_TEXT) + '\n…（太长，已截断）' : body;
  try { genEmit(gen, { type: 'tool-update', tool: { toolCallId, output } }); } catch {}
  if (gen.sessionId) saveToolOutput(ctx?.agyDir, gen.sessionId, toolCallId, { text: output, ...(isError ? { isError: true } : {}) });
  return toolCallId;
}

/** 历史消息里的工具记录补上存下来的返回内容（agy 自己带了输出的不动）。 */
export function applyToolOutputs(messages = [], outputs = {}) {
  if (!outputs || typeof outputs !== 'object' || !Object.keys(outputs).length) return messages;
  const put = (t) => {
    const hit = t?.toolCallId ? outputs[t.toolCallId] : null;
    if (hit && typeof hit.text === 'string' && hit.text && !t.output) t.output = hit.text;
  };
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (m?.role !== 'assistant') continue;
    for (const t of (m.tools || [])) put(t);
    for (const b of (m.blocks || [])) if (b?.type === 'tool') put(b.tool);
  }
  return messages;
}
