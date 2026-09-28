// 工具行 / 任务卡的共享规则——直播（agents/claude.mjs）与历史重建（routes/sessions.mjs）同一份。
//
// 以前 toolShown/toolSummary 两边各抄一份，改一处忘另一处就会让「直播看到的」和「重开会话看到的」
// 不一样（前端 mergeMessages 对账时整段替换闪屏）。2026-09-02 对齐 claude.ai /code 时把这些规则抽到
// 这里：哪些工具露成工具行、行上那句摘要怎么取、条目带哪些【安全】输入字段、Workflow 脚本的 meta
// 怎么抠、后台任务完成通知 <task-notification> 怎么解析、工作流 .output 怎么读——全在这一个模块。
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const clip = (s, n) => {
  const t = s == null ? '' : String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// 不当普通工具行的工具：AskUserQuestion→ask 块；agy 委托 / 媒体生成有各自专属 UI（胶囊 / 媒体卡）。
// Agent/Task/Workflow 从 2026-09-02 起【也露】——它们的工具行就是子 agent 卡 / 工作流卡的宿主
//（task_* 事件按 tool_use id 挂到那一行上），不再另立一颗「并行子任务」胶囊。
export function toolShown(name) {
  if (typeof name !== 'string' || !name) return false;
  return name !== 'AskUserQuestion' && !name.startsWith('mcp__antigravity__') && !name.startsWith('mcp__media__');
}

// 官方 /code 页工具分组的 standalone 桶（桌面端 c06cf64bb `xr` 集合，HD 分桶时命中即单独成组）：
// 这些工具永远【自己一段】，不与前后连续的 tool_use 并进同一个分组——Workflow 尤其重要：它的
// 318px 工作流卡只在「不在分组内」时渲染，被夹进 Grep/Bash 的分组里就只剩一行字。
// 直播（web/src/lib/chat.svelte.js pushTool）与历史重建（routes/sessions.mjs）必须同构，
// 前端在 toolVerbs.js 里抄了同一份集合——改一处记得改另一处。AskUserQuestion 在 bridge 里
// 本就不是工具行（ask 段），不在此列。
export const STANDALONE_TOOLS = new Set(['Workflow', 'ExitPlanMode', 'SendUserMessage', 'SendUserFile', 'PushNotification', 'Artifact', 'ReportFindings', 'ClaudeDesign']);
export function toolStandalone(name) { return typeof name === 'string' && STANDALONE_TOOLS.has(name); }

// —— 上下文压缩（compact_boundary）——
// 官方 /code 页把压缩记成一条 `compacted` 条目：Claude 干活途中压缩时「rolls-up」并进工具循环分组，
// 否则独立成行（桌面端 ion bundle：compacted:{rollUp:"rolls-up",when:"compaction-while-claude-works"}）。
// bridge 把它落成 tools 段里的一条合成条目（name=COMPACT_TOOL，带 compact 字段、没有 tool_use），
// id=边界记录的 uuid——直播 compact_boundary 帧与 jsonl 里那条 system 记录是同一个 uuid，前端指纹对得上。
// 前端 toolVerbs.js 抄了同一个名字——改一处记得改另一处。
export const COMPACT_TOOL = '__compact';
// 边界元数据：jsonl 是 compactMetadata{preTokens,postTokens,durationMs}，SDK 直播帧是
// compact_metadata{pre_tokens,post_tokens,duration_ms}——两种都认。
export function compactMeta(o) {
  const m = (o && (o.compactMetadata || o.compact_metadata)) || {};
  const num = (a, b) => { const v = Number(m[a] !== undefined ? m[a] : m[b]); return Number.isFinite(v) && v > 0 ? v : 0; };
  return {
    trigger: m.trigger === 'manual' ? 'manual' : 'auto',
    preTokens: num('preTokens', 'pre_tokens'),
    postTokens: num('postTokens', 'post_tokens'),
    ms: num('durationMs', 'duration_ms'),
  };
}
// 压缩后注入的那条「摘要」user 记录（jsonl 标 isCompactSummary；直播帧没有这个标记，靠紧跟边界的位置认）。
export const COMPACT_SUMMARY_RE = /^\s*This session is being continued from a previous conversation/;

// 摘要取哪个字段（照官方桌面端的 meta 取法）。Workflow 不走这张表——脚本正文不能当摘要，见 workflowNameFromInput。
const TOOL_PICK = {
  Bash: 'command', PowerShell: 'command', Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path', Glob: 'pattern', Grep: 'pattern', WebFetch: 'url', WebSearch: 'query',
  Task: 'description', Agent: 'description', Skill: 'skill', Monitor: 'command', TaskStop: 'task_id',
};

// 官方 y()：input.name 显式给了用它；否则从脚本前 4KB 的 `meta = { name: '…' }` 抠；再不济用 scriptPath 文件名。
const META_NAME_RE = /\bmeta\s*=\s*\{[^}]*?\bname\s*:\s*['"]([^'"]+)['"]/;
export function workflowNameFromInput(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.name === 'string' && input.name) return input.name;
  if (typeof input.script === 'string') {
    const m = input.script.slice(0, 4096).match(META_NAME_RE);
    if (m) return m[1];
  }
  if (typeof input.scriptPath === 'string' && input.scriptPath) {
    return (input.scriptPath.split(/[\\/]/).pop() || '').replace(/\.[^.]+$/, '');
  }
  return '';
}

// 历史重建没有 task_started 帧，只有脚本本身：从 `export const meta = {…}` best-effort 抠
// name / description / phases[{title,detail}]（运行时真实 phases 由 workflow_progress 给，meta 只是占位）。
export function workflowMetaFromScript(script) {
  const out = { name: '', description: '', phases: [] };
  if (typeof script !== 'string' || !script) return out;
  const head = script.slice(0, 8192);
  const mi = head.search(/\bmeta\s*=\s*\{/);
  const meta = mi >= 0 ? head.slice(mi) : head;
  const nm = meta.match(/\bname\s*:\s*['"]([^'"]+)['"]/);
  if (nm) out.name = nm[1];
  const pi = meta.search(/\bphases\s*:\s*\[/);
  // description 通常写在 phases 之前；phases 里每段也有 detail 字样，先在 phases 之前找，找不到再全量找。
  const dm = (pi >= 0 ? meta.slice(0, pi) : meta).match(/\bdescription\s*:\s*(['"`])([\s\S]*?)\1/)
    || meta.match(/\bdescription\s*:\s*(['"`])([\s\S]*?)\1/);
  if (dm) out.description = clip(dm[2].replace(/\s+/g, ' ').trim(), 300);
  if (pi >= 0) {
    const body = meta.slice(pi);
    const end = body.indexOf(']');
    const list = end > 0 ? body.slice(0, end) : body;
    const re = /\{\s*title\s*:\s*(['"`])([\s\S]*?)\1\s*(?:,\s*detail\s*:\s*(['"`])([\s\S]*?)\3)?/g;
    let m;
    while ((m = re.exec(list)) && out.phases.length < 40) {
      out.phases.push({ title: clip(m[2].trim(), 120), detail: clip((m[4] || '').replace(/\s+/g, ' ').trim(), 300) });
    }
  }
  return out;
}

// 一行摘要（工具行 meta / 手机「具体操作」视图）。
export function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  let out = '';
  if (name === 'Workflow') {
    out = workflowNameFromInput(input) || workflowMetaFromScript(input.script).description;
  } else {
    const k = TOOL_PICK[name];
    out = k && input[k] != null ? String(input[k]) : '';
    if (!out) { // 兜底：第一个非空字符串字段
      for (const key of Object.keys(input)) { const v = input[key]; if (typeof v === 'string' && v.trim()) { out = v; break; } }
    }
  }
  out = String(out).replace(/\s+/g, ' ').trim();
  return out.length > 160 ? out.slice(0, 160) + '…' : out;
}

// tool_args / 历史条目携带的输入子集：只挑安全字段（存在才带），给前端工具行的参数表用。
// 不带脚本正文、不带任意 MCP 字段——那些既可能巨大，也可能夹着不该出服务器的东西。
const SAFE_KEYS = ['file_path', 'notebook_path', 'path', 'pattern', 'glob', 'command', 'description', 'url', 'query', 'skill', 'subject', 'subagent_type', 'run_in_background', 'offset', 'limit'];
export function toolInputSubset(name, input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const k of SAFE_KEYS) {
    const v = input[k];
    if (v == null || v === '') continue;
    if (typeof v === 'string') out[k] = clip(v, 500);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  if (typeof input.prompt === 'string' && input.prompt) out.prompt = clip(input.prompt, 200);
  if (name === 'Workflow') { const n = workflowNameFromInput(input); if (n) out.name = n; }
  if (Array.isArray(input.todos)) out.todosCount = input.todos.length;
  return out;
}

// 任务状态归一：SDK 的 task_notification 只有 completed|failed|stopped，task_updated.patch 与
// <task-notification> 里还会出现 killed（→stopped）/ error（→failed）。
export function normTaskStatus(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'killed' || v === 'stopped' || v === 'cancelled' || v === 'canceled') return 'stopped';
  if (v === 'failed' || v === 'error' || v === 'errored') return 'failed';
  return 'completed';
}

// SDK usage {total_tokens, tool_uses, duration_ms} → 前端 {tokens, toolUses, ms}；没有就 null（历史卡别显示「0 tokens」）。
export function taskUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  return { tokens: n(u.total_tokens ?? u.tokens), toolUses: n(u.tool_uses ?? u.toolUses), ms: n(u.duration_ms ?? u.ms) };
}

// 后台任务完成通知：CLI 注入给模型的 <task-notification>…</task-notification> 文本（transcript 里有三种
// 落盘形态：user 文本块 / attachment.queued_command.prompt / queue-operation.content，内容相同）。
// 也认 <agent-notification>/<bash-notification> 变体。返回 null = 不是通知。
const NOTIFY_RE = /<(?:task|agent|bash)-notification>/;
const tag = (text, name) => {
  const m = text.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1].trim() : '';
};
export function parseTaskNotification(text) {
  if (typeof text !== 'string' || !NOTIFY_RE.test(text)) return null;
  const taskId = tag(text, 'task-id');
  const toolUseId = tag(text, 'tool-use-id');
  if (!taskId && !toolUseId) return null;
  const num = (name) => { const v = Number(tag(text, name)); return isFinite(v) ? v : 0; };
  const hasUsage = /<usage>/.test(text);
  return {
    taskId, toolUseId,
    taskType: tag(text, 'task-type'),
    status: normTaskStatus(tag(text, 'status')),
    summary: clip(tag(text, 'summary'), 600),
    result: clip(tag(text, 'result'), 600),
    outputFile: tag(text, 'output-file'),
    usage: hasUsage ? { tokens: num('subagent_tokens'), toolUses: num('tool_uses'), ms: num('duration_ms') } : null,
  };
}

// 工作流的 .output（%TEMP%\claude\<proj>\<sid>\tasks\<taskId>.output）是 JSON：
// {summary, agentCount, logs[], result, workflowProgress[], totalTokens, totalToolCalls}——完成通知本身
// 没有逐 agent 的数据，点阵 / Phases 面板收尾要靠它。保留期不可靠（会被清），一律 best-effort：
// 读不到、不是 JSON、超 2MB 都返回 null。子 agent 的 .output 是纯文本（常常为空），解析失败即 null。
// 只读 CLI 任务输出目录里的文件：<tmpdir>/claude/<proj>/<sid>/tasks/<taskId>.output。历史重建把用户文本块里的
// <task-notification> 也当通知解析（CLI 注入的三种落盘形态之一），<output-file> 若来自用户自己敲的一条消息，
// 不加围栏就是以 bridge 进程身份替他读任意 JSON 再回给客户端。直播的 SDK 路径同样是这个形状，过得了。
const TASK_ROOTS = [...new Set([os.tmpdir(), process.env.TEMP, process.env.TMP, process.env.TMPDIR].filter(Boolean).map((d) => path.resolve(d, 'claude')))];
const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);   // Windows 路径不分大小写
export function isTaskOutputPath(file) {
  if (!file || typeof file !== 'string') return false;
  const abs = path.resolve(file);
  if (!/\.output$/i.test(abs) || path.basename(path.dirname(abs)) !== 'tasks') return false;
  return TASK_ROOTS.some((r) => fold(abs).startsWith(fold(r + path.sep)));
}
export function readWorkflowOutput(file) {
  if (!isTaskOutputPath(file)) return null;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > 2_000_000) return null;
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const n = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
    let result;
    if (j.result !== undefined && j.result !== null) {
      result = typeof j.result === 'string' ? j.result : JSON.stringify(j.result);
      if (typeof result === 'string') result = clip(result, 600);
    }
    return {
      progress: Array.isArray(j.workflowProgress) ? j.workflowProgress : undefined,
      result,
      summary: typeof j.summary === 'string' ? j.summary : '',
      tokens: n(j.totalTokens), toolCalls: n(j.totalToolCalls), agentCount: n(j.agentCount),
    };
  } catch { return null; }
}
