// GET /api/claude/agent-transcript?session=<sid>&agentId=<id> —— 子 agent 转录（Agent 卡「转录面板」的历史数据源）。
//
// 直播时子 agent 的 assistant 帧经 agent_msg 事件实时到前端；重开会话没有这些事件，只有磁盘上的
// <sessionsDir>/<sid>/subagents/agent-<agentId>.jsonl（同名 .meta.json 带 agentType/description/toolUseId）。
// 只取 assistant 记录：text 合并成段（≤20000/段，满了另起一段），tool_use 合并成一组 {name,summary}，思考跳过
//（落盘时正文本就被清空）。prompt = 开头连续 user 记录里最后一条的正文（剥掉工作流 harness 的框）。
// 运行中的 agent 被打开时前端带 ?from=<offset> 增量拉（只解析新追加的行），见 readAgentTranscript。
// 鉴权同 /api/session：会话必须落在本人某个项目目录下（locateSessionPaths 即所有权证明）；agentId
// 白名单字符 + 目录前缀校验，防穿越。找不到 → 404。
import path from 'node:path';
import { readFileSync, statSync, existsSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import * as claudeProjects from '../claude-projects.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { toolSummary, clip } from '../runtime/tool-summary.mjs';
import { findGenBySession } from '../runtime/gen.mjs';
import { readBody } from '../runtime/body.mjs';

const MAX_BYTES = 32 * 1024 * 1024;   // 子 agent 转录通常几十 KB 到几 MB；再大就不整读了
const TEXT_CAP = 20000;               // 单段正文封顶（相邻正文合并到这个长度就另起一段，不截断）
const PROMPT_CAP = 200000;            // 提示词给全文（工作流 agent 的 promptPreview 只有 400 字，完整版只在这里）
const MAX_ENTRIES = 2000;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  return '';
}

// 工作流 agent 的任务文本落盘时套着一层 harness 框：首行「[Workflow harness — computed task] …follows:」，
// 其后每行缩进两格（CLI 2.1.2xx，progress 帧 promptFramed:true）。给人看的是框里那段原文：剥首行、去两格缩进。
export function unframePrompt(text) {
  const s = String(text || '');
  const m = /^\[Workflow harness\b[^\]\n]*\][^\n]*\n/.exec(s);
  if (!m) return s;
  return s.slice(m[0].length).split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n').trim();
}

// 相邻同类条目合并（正文并段、工具并组）——服务端整读与前端增量拼接用同一套规则（前端 lib/agentTranscript.js 同构）。
function pushEntry(entries, en) {
  const last = entries[entries.length - 1];
  if (en.kind === 'text') {
    if (last && last.kind === 'text' && last.text.length + en.text.length + 2 <= TEXT_CAP) { last.text += (last.text ? '\n\n' : '') + en.text; return; }
    if (entries.length < MAX_ENTRIES) entries.push({ kind: 'text', text: clip(en.text, TEXT_CAP) });
  } else if (en.kind === 'tools') {
    if (last && last.kind === 'tools') { last.tools.push(...en.tools); return; }
    if (entries.length < MAX_ENTRIES) entries.push({ kind: 'tools', tools: en.tools.slice() });
  }
}

// 转录文件定位：Agent 工具的子 agent 落 <sid>/subagents/agent-<id>.jsonl；动态工作流（Workflow 工具）里的
// agent 落 <sid>/subagents/workflows/<wf_…>/agent-<id>.jsonl（CLI 2.1.257 实测，同名 .meta.json
// {agentType:'workflow-subagent', spawnDepth}）。agentId 已由调用方按白名单校验，wf 目录名来自 readdir，
// 两段都不可能带路径分隔符——拼出来的路径必在 subagents/ 之下。
export function locateAgentTranscript(dir, agentId) {
  const direct = path.join(dir, 'agent-' + agentId + '.jsonl');
  if (existsSync(direct)) return { file: direct, meta: path.join(dir, 'agent-' + agentId + '.meta.json') };
  const wfRoot = path.join(dir, 'workflows');
  let names = [];
  try { names = readdirSync(wfRoot); } catch { return null; }
  for (const n of names.slice(0, 500)) {
    const f = path.join(wfRoot, n, 'agent-' + agentId + '.jsonl');
    if (existsSync(f)) return { file: f, meta: path.join(wfRoot, n, 'agent-' + agentId + '.meta.json') };
  }
  return null;
}

// 读转录。from = 上次返回的 offset（字节）时只解析新追加的整行（delta:true，prompt 不再给——前端留着首拉那份）：
// 运行中的 agent 被打开时前端每 2s 来一次，文件动辄几 MB，整读整解析太亏。只消费到最后一个换行为止，
// 半行留给下一拉（jsonl 按行追加写，换行字节不会落在 UTF-8 多字节序列中间）。文件变短 = 被重写 → 退回整读。
export function readAgentTranscript(file, { from = 0 } = {}) {
  const st = statSync(file);
  if (!st.isFile()) return null;
  const size = st.size, mtime = st.mtimeMs;
  const start = Number.isFinite(from) && from > 0 && from <= size ? Math.floor(from) : 0;
  const delta = start > 0;
  if (size - start > MAX_BYTES) throw Object.assign(new Error('too large'), { status: 413 });
  if (delta && start === size) return { entries: [], model: '', prompt: '', mtime, size, offset: size, delta };
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  const nl = buf.lastIndexOf(0x0a);
  const used = nl < 0 ? 0 : nl + 1;
  const entries = [];
  let model = '', prompt = '', promptDone = delta;
  for (const line of buf.subarray(0, used).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || !o.message) continue;
    if (o.type === 'user') {
      // prompt = 开头那串连续 user 记录里的最后一条正文（CLI readWorkflowAgentTranscript 同款：前面几条可能是
      //「user request」「assistant context」这类转述框，最后一条才是这个 agent 的任务）；第一条 assistant 之后不再改
      if (!promptDone && !o.isMeta) { const t = textOf(o.message.content); if (t.trim()) prompt = clip(unframePrompt(t), PROMPT_CAP); }
      continue;
    }
    if (o.type !== 'assistant') continue;
    promptDone = true;
    if (!model && o.message.model) model = String(o.message.model);
    const content = Array.isArray(o.message.content) ? o.message.content : [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text) pushEntry(entries, { kind: 'text', text: b.text });
      else if (b.type === 'tool_use') pushEntry(entries, { kind: 'tools', tools: [{ name: b.name || '', summary: toolSummary(b.name, b.input || {}) }] });
    }
  }
  return { entries, model, prompt, mtime, size, offset: start + used, delta };
}

export function registerClaudeTaskRoutes(router, { identify }) {
  router.on('GET', '/api/claude/agent-transcript', (req, res, url) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(who);
    const sid = String(url.searchParams.get('session') || '');
    const agentId = String(url.searchParams.get('agentId') || '');
    if (!/^[0-9a-fA-F-]{8,}$/.test(sid) || !/^[A-Za-z0-9_-]{4,64}$/.test(agentId)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad id'); return;
    }
    // 项目制：transcript 可能在任一项目目录，跨目录定位（含防穿越）；找不到就是不属于本人的会话。
    const p = claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, sid);
    if (!p) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    const dir = path.join(p.subdir, 'subagents');
    const loc = locateAgentTranscript(dir, agentId);
    if (!loc || !path.resolve(loc.file).startsWith(path.resolve(dir) + path.sep)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    let data = null;
    const from = Number(url.searchParams.get('from') || 0);
    try { data = readAgentTranscript(loc.file, { from }); } catch (e) {
      const code = e && e.status === 413 ? 413 : 404;
      res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(code === 413 ? 'transcript too large' : 'not found'); return;
    }
    if (!data) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    let meta = null;
    if (!data.delta) { try { meta = JSON.parse(readFileSync(loc.meta, 'utf8')); } catch {} }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessionId: sid, agentId, ...data,
      meta: meta && typeof meta === 'object'
        ? { agentType: String(meta.agentType || ''), description: String(meta.description || ''), toolUseId: String(meta.toolUseId || ''), spawnDepth: Number(meta.spawnDepth) || 0 }
        : null,
    }));
  });

  // POST /api/claude/task/stop {sessionId, taskId} —— 单条停止后台任务（任务面板每行的 ⏹）。
  // 走这一轮活着的控制通道（SDK query.stopTask → 控制请求 stop_task）：本轮悬停等后台任务时
  // 通道正是活的，这也是能单停的前提；轮已结束/不是本人的会话 → 409/404，前端照实提示。
  // 停掉后 CLI 发 background_tasks_changed + task_notification(stopped)，UI 经既有事件收敛。
  router.on('POST', '/api/claude/task/stop', async (req, res) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(who);
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch {}
    const sid = String(body.sessionId || '');
    const taskId = String(body.taskId || '');
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!/^[0-9a-fA-F-]{8,}$/.test(sid) || !/^[A-Za-z0-9_-]{2,64}$/.test(taskId)) return json(400, { error: 'bad id' });
    // 所有权：会话必须落在本人某个项目目录下（与 agent-transcript 同一道闸）。
    if (!claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, sid)) return json(404, { error: 'not found' });
    const gen = findGenBySession(ctx.key, sid);
    if (!gen || gen.done || typeof gen.stopTask !== 'function') return json(409, { error: 'no live run' });
    try { await gen.stopTask(taskId); } catch (e) {
      return json(502, { error: String((e && e.message) || e || 'stop failed') });
    }
    json(200, { ok: true });
  });
}
