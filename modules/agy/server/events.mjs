// ACP 事件与消息转换：把 agy acp 的通知、反向请求、历史回放流转成 bridge 统一的事件与消息结构，并在出口统一规整路径。

import { normalizeAgyPath, cleanTitlePaths } from './paths.mjs';
import { isWakePrompt } from './wake-prompt.mjs';

const VALID_KINDS = new Set([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'browser', 'other',
]);

function inferToolKind(name, rawKind) {
  const n = String(name || '').toLowerCase();
  if (n.includes('browser')) return 'browser';
  if (typeof rawKind === 'string' && VALID_KINDS.has(rawKind)) return rawKind;
  if (/read|view/.test(n)) return 'read';
  if (/edit|write|patch|replace/.test(n)) return 'edit';
  if (/grep|glob|find|search/.test(n)) return 'search';
  if (/command|bash|shell|exec|terminal/.test(n)) return 'execute';
  return 'other';
}

export function normalizeToolCall(raw = {}, platform = process.platform) {
  const name = String(raw.name || '');
  const args = raw.rawInput && typeof raw.rawInput === 'object'
    ? raw.rawInput
    : (raw.args && typeof raw.args === 'object' ? raw.args : {});
  const kind = inferToolKind(name, raw.kind);
  const locations = Array.isArray(raw.locations)
    ? raw.locations
      .filter((loc) => loc && typeof loc.path === 'string' && loc.path.trim())
      .map((loc) => ({
        path: normalizeAgyPath(loc.path, platform),
        ...(typeof loc.line === 'number' ? { line: loc.line } : {}),
      }))
    : [];

  const diffs = [];
  const textOutputs = [];
  const content = [];

  for (const item of (Array.isArray(raw.content) ? raw.content : [])) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'diff') {
      const diff = {
        type: 'diff',
        path: normalizeAgyPath(item.path || '', platform),
        oldText: String(item.oldText ?? ''),
        newText: String(item.newText ?? ''),
      };
      diffs.push({ path: diff.path, oldText: diff.oldText, newText: diff.newText });
      content.push(diff);
    } else if (item.type === 'content' && item.content && typeof item.content === 'object') {
      if (item.content.type === 'text' && typeof item.content.text === 'string') {
        textOutputs.push(item.content.text);
      }
      content.push(item);
    } else {
      content.push(item);
    }
  }

  const rawOutObj = raw.rawOutput && typeof raw.rawOutput === 'object' ? raw.rawOutput : null;
  const output = typeof rawOutObj?.output === 'string'
    ? rawOutObj.output
    : (textOutputs.length ? textOutputs.join('\n') : '');
  const exitCode = typeof rawOutObj?.exit_code === 'number'
    ? rawOutObj.exit_code
    : (typeof rawOutObj?.exitCode === 'number' ? rawOutObj.exitCode : null);
  const command = kind === 'execute'
    ? String(args.CommandLine ?? args.command ?? '')
    : '';

  return {
    toolCallId: String(raw.toolCallId || ''),
    name,
    kind,
    status: String(raw.status || 'in_progress'),
    title: cleanTitlePaths(raw.title || name, platform),
    args,
    locations,
    ...(command ? { command } : {}),
    ...(output ? { output } : {}),
    ...(exitCode !== null ? { exitCode } : {}),
    ...(diffs.length ? { diffs } : {}),
    ...(content.length ? { content } : {}),
  };
}

export function extractConfigSummary(configOptions = [], modes = null, models = null) {
  const list = Array.isArray(configOptions) ? configOptions : [];
  const byKey = (key) => list.find((c) => c && (c.id === key || c.category === key));
  const modelOpt = byKey('model');
  const thoughtOpt = byKey('thought_level');
  const modeOpt = byKey('mode');

  return {
    model: modelOpt?.currentValue || models?.currentModelId || null,
    thoughtLevel: thoughtOpt?.currentValue || null,
    mode: modeOpt?.currentValue || modes?.currentModeId || null,
  };
}

function parseEnumOptions(prop = {}) {
  if (Array.isArray(prop.oneOf) && prop.oneOf.length) {
    return prop.oneOf
      .filter((o) => o && o.const !== undefined)
      .map((o) => ({
        value: String(o.const),
        label: String(o.title ?? o.const),
        ...(o.description ? { description: String(o.description) } : {}),
      }));
  }
  if (Array.isArray(prop.anyOf) && prop.anyOf.length) {
    return prop.anyOf
      .filter((o) => o && o.const !== undefined)
      .map((o) => ({
        value: String(o.const),
        label: String(o.title ?? o.const),
        ...(o.description ? { description: String(o.description) } : {}),
      }));
  }
  if (Array.isArray(prop.enum) && prop.enum.length) {
    const names = Array.isArray(prop.enumNames) ? prop.enumNames : [];
    return prop.enum.map((val, idx) => ({
      value: String(val),
      label: String(names[idx] ?? val),
    }));
  }
  return [];
}

export function parseElicitationFields(schema) {
  if (!schema || typeof schema !== 'object' || typeof schema.properties !== 'object' || !schema.properties) {
    return [];
  }
  const requiredSet = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = [];

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!prop || typeof prop !== 'object') continue;
    const base = {
      key,
      title: String(prop.title || key),
      description: prop.description ? String(prop.description) : '',
      required: requiredSet.has(key),
      ...(prop.default !== undefined ? { defaultValue: prop.default } : {}),
    };

    if (prop.type === 'array' && prop.items && typeof prop.items === 'object') {
      const options = parseEnumOptions(prop.items);
      fields.push({ ...base, kind: 'multi', options });
      continue;
    }

    const singleOptions = parseEnumOptions(prop);
    if (singleOptions.length) {
      fields.push({ ...base, kind: 'single', options: singleOptions });
      continue;
    }

    if (prop.type === 'boolean') {
      fields.push({ ...base, kind: 'boolean' });
      continue;
    }

    if (prop.type === 'number' || prop.type === 'integer') {
      fields.push({ ...base, kind: 'number' });
      continue;
    }

    fields.push({ ...base, kind: 'text' });
  }

  return fields;
}

export function normalizePermissionRequest(rpcId, params = {}, platform = process.platform) {
  const sessionId = String(params.sessionId || '');
  const toolCall = normalizeToolCall(params.toolCall || {}, platform);
  const options = Array.isArray(params.options)
    ? params.options.map((o) => ({
      optionId: String(o.optionId || ''),
      name: String(o.name || o.optionId || ''),
      kind: String(o.kind || ''),
    }))
    : [];
  return {
    type: 'permission',
    requestId: String(rpcId),
    sessionId,
    toolCall,
    options,
    status: 'pending',
  };
}

export function normalizeElicitationRequest(rpcId, params = {}, fallbackSessionId = null) {
  const sessionId = String(params.sessionId || params._meta?.sessionId || fallbackSessionId || '');
  const requestedSchema = params.requestedSchema && typeof params.requestedSchema === 'object'
    ? params.requestedSchema
    : null;
  return {
    type: 'question',
    requestId: String(rpcId),
    sessionId: sessionId || null,
    mode: String(params.mode || 'form'),
    message: String(params.message || ''),
    ...(params.url ? { url: String(params.url) } : {}),
    requestedSchema,
    fields: parseElicitationFields(requestedSchema),
    status: 'pending',
  };
}

function collectCompletedEditPaths(tool, platform = process.platform) {
  const seen = new Set();
  const paths = [];
  const push = (raw) => {
    const p = normalizeAgyPath(raw || '', platform);
    if (p && !seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  };
  for (const d of (tool.diffs || [])) push(d.path);
  if (tool.kind === 'edit' || tool.kind === 'delete' || tool.kind === 'move') {
    for (const loc of (tool.locations || [])) push(loc.path);
    push(tool.args?.Path || tool.args?.path);
  }
  return paths;
}

export function convertSessionUpdate(sessionId, update = {}, platform = process.platform) {
  if (!update || typeof update !== 'object') return [];
  const kind = update.sessionUpdate;

  switch (kind) {
    case 'agent_message_chunk': {
      const text = update.content?.type === 'text' ? String(update.content.text ?? '') : '';
      return text ? [{ type: 'text', text }] : [];
    }
    case 'agent_thought_chunk': {
      const text = update.content?.type === 'text' ? String(update.content.text ?? '') : '';
      return text ? [{ type: 'thinking', text }] : [];
    }
    case 'tool_call':
    case 'tool_call_update': {
      const tool = normalizeToolCall(update, platform);
      const out = [{ type: kind === 'tool_call' ? 'tool' : 'tool-update', tool }];
      if (tool.status === 'completed') {
        if (tool.diffs?.length) {
          out.push({ type: 'diff', toolCallId: tool.toolCallId, diffs: tool.diffs });
        }
        for (const p of collectCompletedEditPaths(tool, platform)) {
          out.push({ type: 'fs', path: p });
        }
      }
      return out;
    }
    case 'usage_update':
      return [{
        type: 'usage',
        sessionId,
        used: Math.max(0, Number(update.used) || 0),
        size: Math.max(0, Number(update.size) || 0),
      }];
    case 'session_info_update':
      return typeof update.title === 'string' && update.title.trim()
        ? [{ type: 'title', sessionId, title: update.title.trim() }]
        : [];
    case 'available_commands_update':
      return [{
        type: 'commands',
        sessionId,
        commands: Array.isArray(update.availableCommands)
          ? update.availableCommands.map((c) => ({
            name: String(c.name || ''),
            description: String(c.description || ''),
          }))
          : [],
      }];
    case 'config_option_update': {
      const configOptions = Array.isArray(update.configOptions) ? update.configOptions : [];
      const summary = extractConfigSummary(configOptions);
      return [{
        type: 'config',
        sessionId,
        configOptions,
        ...summary,
      }];
    }
    case 'current_mode_update':
      return typeof update.currentModeId === 'string'
        ? [{ type: 'mode', sessionId, modeId: update.currentModeId }]
        : [];
    default:
      return [];
  }
}

// 把 session/load 回放的更新序列还原成前端可直接渲染的轮次消息数组
export function reconstructHistoryMessages(notifications = [], platform = process.platform) {
  const messages = [];
  let currentRole = null;
  let currentMsg = null;
  let usage = null;
  let title = '';
  let commands = [];
  const sawPendingIds = new Set();

  const ensureMessage = (role) => {
    if (currentMsg && currentRole === role) return currentMsg;
    currentRole = role;
    currentMsg = role === 'user'
      ? { role: 'user', text: '', images: [], blocks: [] }
      : { role: 'assistant', text: '', thinking: '', tools: [], blocks: [] };
    messages.push(currentMsg);
    return currentMsg;
  };

  for (const raw of notifications) {
    const update = raw?.params?.update || raw?.update || raw;
    if (!update || typeof update !== 'object') continue;

    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        const c = update.content || {};
        // bridge 替后台子代理发的续接消息不是用户说的话：跳过它，前后两段回答连成一条（中间分段，别粘成一句）
        if (c.type === 'text' && isWakePrompt(c.text)) {
          if (currentMsg && currentRole === 'assistant') {
            const last = currentMsg.blocks[currentMsg.blocks.length - 1];
            if (last && last.type === 'text' && last.text && !/\n\s*$/.test(last.text)) {
              last.text += '\n\n';
              currentMsg.text += '\n\n';
            }
          }
          break;
        }
        // 新的一条用户文本分片若前面已经是 assistant，则自然开启新一轮 user 消息
        const m = ensureMessage('user');
        if (c.type === 'text' && typeof c.text === 'string') {
          if (m.text) m.text += '\n' + c.text;
          else m.text = c.text;
          m.blocks.push({ type: 'text', text: c.text });
        } else if (c.type === 'image') {
          const img = {
            mimeType: String(c.mimeType || 'image/png'),
            ...(c.data ? { data: String(c.data) } : {}),
            ...(c.path ? { path: String(c.path) } : {}),
            ...(c.name ? { name: String(c.name) } : {}),
            ...(Number.isFinite(Number(c.size)) ? { size: Number(c.size) } : {}),
          };
          if (img.data || img.path) {
            m.images.push(img);
            m.blocks.push({ type: 'image', ...img });
          }
        }
        break;
      }
      case 'agent_thought_chunk': {
        const text = update.content?.type === 'text' ? String(update.content.text ?? '') : '';
        if (!text) break;
        const m = ensureMessage('assistant');
        m.thinking += text;
        const last = m.blocks[m.blocks.length - 1];
        if (last && last.type === 'thinking') last.text += text;
        else m.blocks.push({ type: 'thinking', text });
        break;
      }
      case 'agent_message_chunk': {
        const text = update.content?.type === 'text' ? String(update.content.text ?? '') : '';
        if (!text) break;
        const m = ensureMessage('assistant');
        m.text += text;
        const last = m.blocks[m.blocks.length - 1];
        if (last && last.type === 'text') last.text += text;
        else m.blocks.push({ type: 'text', text });
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const m = ensureMessage('assistant');
        const tool = normalizeToolCall(update, platform);
        if (tool.toolCallId && update.status === 'pending') {
          sawPendingIds.add(tool.toolCallId);
        }
        const idx = m.tools.findIndex((x) => x.toolCallId && x.toolCallId === tool.toolCallId);
        if (idx >= 0) {
          const prev = m.tools[idx];
          const merged = {
            ...prev,
            status: tool.status || prev.status,
            ...(tool.name ? { name: tool.name } : {}),
            ...(tool.kind && tool.kind !== 'other' ? { kind: tool.kind } : {}),
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.args && Object.keys(tool.args).length ? { args: tool.args } : {}),
            ...(tool.locations?.length ? { locations: tool.locations } : {}),
            ...(tool.command ? { command: tool.command } : {}),
            ...(tool.output ? { output: tool.output } : {}),
            ...(tool.exitCode !== undefined && tool.exitCode !== null ? { exitCode: tool.exitCode } : {}),
            ...(tool.diffs?.length ? { diffs: tool.diffs } : {}),
            ...(tool.content?.length ? { content: tool.content } : {}),
          };
          m.tools[idx] = merged;
          const bIdx = m.blocks.findIndex((b) => b.type === 'tool' && b.tool?.toolCallId === tool.toolCallId);
          if (bIdx >= 0) m.blocks[bIdx] = { type: 'tool', tool: merged };
        } else {
          m.tools.push(tool);
          m.blocks.push({ type: 'tool', tool });
        }
        break;
      }
      case 'usage_update':
        usage = {
          used: Math.max(0, Number(update.used) || 0),
          size: Math.max(0, Number(update.size) || 0),
        };
        break;
      case 'session_info_update':
        if (typeof update.title === 'string' && update.title.trim()) {
          title = update.title.trim();
        }
        break;
      case 'available_commands_update':
        if (Array.isArray(update.availableCommands)) {
          commands = update.availableCommands.map((c) => ({
            name: String(c.name || ''),
            description: String(c.description || ''),
          }));
        }
        break;
      default:
        break;
    }
  }

  // 经历过 pending（权限等待）后顺利 completed 的工具调用在历史回放中同样标为已允许
  if (sawPendingIds.size > 0) {
    for (const m of messages) {
      if (m?.role !== 'assistant') continue;
      for (const t of (m.tools || [])) {
        if (t?.toolCallId && sawPendingIds.has(t.toolCallId) && t.status === 'completed' && !t.approvalState) {
          t.approvalState = 'allowed';
        }
      }
      for (const b of (m.blocks || [])) {
        if (b?.type === 'tool' && b.tool?.toolCallId && sawPendingIds.has(b.tool.toolCallId) && b.tool.status === 'completed' && !b.tool.approvalState) {
          b.tool.approvalState = 'allowed';
        }
      }
    }
  }

  return { messages, usage, title, commands };
}
