// 会话级「上下文用量 / 实际生效 effort / 斜杠命令」缓存（2026-09-01，SDK 0.3.257 三个新接口落地）。
//
// - 上下文用量：每轮 result 后经 SDK 控制接口 query.getContextUsage({detail:'full'}) 拿到
//   按类别（System prompt / System tools / MCP tools / Memory files / Skills / Messages /
//   Free space / Autocompact buffer…）的 token 分布，归一成前端面板要的紧凑结构，按
//   caller key + sessionId 记（多对话并发各记各的），并持久化到 ctx-usage.json——刷新页面、
//   换设备打开旧会话，环形面板照样有上一轮的分布。
// - 实际 effort：Stop hook 的 input.effort（{level} 或字符串）= 本轮真正发给 API 的档位
//   （经 env 覆盖 / 组织上限 / 模型不支持降档之后）。init 帧在 SDK 宿主上不带 effort，
//   只有 Remote Control 帧带，所以只能从 hook 拿。
// - 斜杠命令：query.supportedCommands() 的 {name,description,argumentHint} 全表 +
//   init 帧的 terminal_slash_commands（doctor/color 这类绑定本地终端 UX 的命令，手机/远程
//   UI 应隐藏）。按 caller key 记一份（命令表跟账号/技能有关，不跟会话）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let _file = '';
const usages = new Map();    // key|sid -> usage（归一后）
const efforts = new Map();   // key|sid -> { level, at }
const commands = new Map();  // key -> { commands:[{name,description,argumentHint}], terminal:[], at }
const MAX_USAGES = 60;
let saveTimer = null;

export function initCtxUsage(root) {
  _file = path.join(root, 'ctx-usage.json');
  if (!existsSync(_file)) return;
  try {
    const s = JSON.parse(readFileSync(_file, 'utf8'));
    for (const [k, v] of Object.entries(s?.usages || {})) if (v && typeof v === 'object' && v.max > 0) usages.set(k, v);
    for (const [k, v] of Object.entries(s?.efforts || {})) if (v && typeof v === 'object') efforts.set(k, v);
    for (const [k, v] of Object.entries(s?.commands || {})) if (v && Array.isArray(v.commands)) commands.set(k, v);
  } catch {}
}

function persist() {
  if (!_file) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      writeFileSync(_file, JSON.stringify({
        usages: Object.fromEntries(usages),
        efforts: Object.fromEntries(efforts),
        commands: Object.fromEntries(commands),
      }));
    } catch {}
  }, 500);
}

function bump(map, k, v, max) {
  map.delete(k);
  map.set(k, v);
  while (map.size > max) map.delete(map.keys().next().value);
}

// 类别性质判定——照官方桌面端 c094b416e 的规则：kind 字段优先，没有就按名字猜。
// 'free' 剩余窗口 / 'buffer' 压缩预留 / 'deferred' 窗口外的延迟加载工具（只列出来看，不计入
// 用量）/ 'used' 真占窗口的内容。
export function categoryKind(c) {
  const name = String(c?.name || '');
  if (c?.kind === 'free' || name === 'Free space') return 'free';
  if (c?.kind === 'buffer' || name === 'Autocompact buffer') return 'buffer';
  if (c?.kind === 'deferred' || c?.isDeferred || /\(deferred\)$/i.test(name)) return 'deferred';
  return 'used';
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const str = (v, n = 200) => String(v == null ? '' : v).slice(0, n);

// SDK 的 SDKControlGetContextUsageResponse → 前端面板用的紧凑结构（几 KB，可持久化）。
export function normalizeContextUsage(u, model = '') {
  if (!u || typeof u !== 'object') return null;
  const max = num(u.rawMaxTokens) || num(u.maxTokens);
  if (!max) return null;
  const categories = (Array.isArray(u.categories) ? u.categories : []).map((c) => ({
    name: str(c.name, 60), tokens: num(c.tokens), kind: categoryKind(c), color: str(c.color, 40),
  }));
  // 已用 = 非 free、非 deferred 的类别之和（官方 w()）；SDK 的 totalTokens 是同一口径的自报值，
  // 两者取自报值优先（它含未归类的零头），没有再用求和。
  const summed = categories.filter((c) => c.kind === 'used' || c.kind === 'buffer').reduce((a, c) => a + c.tokens, 0);
  const total = num(u.totalTokens) || summed;
  return {
    model: str(u.model || model, 60),
    total, max,
    pct: Math.max(0, Math.min(100, Math.round(total / max * 100))),
    categories,
    mcpTools: (Array.isArray(u.mcpTools) ? u.mcpTools : []).map((t) => ({ name: str(t.name, 120), server: str(t.serverName, 60), tokens: num(t.tokens) })),
    memoryFiles: (Array.isArray(u.memoryFiles) ? u.memoryFiles : []).map((f) => ({ path: str(f.path, 300), type: str(f.type, 30), tokens: num(f.tokens) })),
    agents: (Array.isArray(u.agents) ? u.agents : []).map((a) => ({ type: str(a.agentType, 80), source: str(a.source, 40), tokens: num(a.tokens) })),
    skills: Array.isArray(u.skills?.skillFrontmatter)
      ? u.skills.skillFrontmatter.map((s) => ({ name: str(s.name, 80), source: str(s.source, 40), plugin: str(s.pluginName, 60), tokens: num(s.tokens) }))
      : [],
    autocompact: { enabled: !!u.isAutoCompactEnabled, threshold: num(u.autoCompactThreshold), source: str(u.autocompactSource, 30) },
    at: Date.now(),
  };
}

export function applyContextUsage(key, sessionId, usage) {
  if (!sessionId || !usage) return null;
  bump(usages, key + '|' + sessionId, usage, MAX_USAGES);
  persist();
  return usage;
}
export function getContextUsage(key, sessionId) {
  return sessionId ? (usages.get(key + '|' + sessionId) || null) : null;
}

// hook 的 effort 字段三态：'xhigh' | {level:'xhigh',…} | 数字（内部预算）| 缺省。
// 'ultracode' SDK 的 hook 永远不会回（它在 hook 层没有标记，只回解析后的 xhigh）——它由 claude.mjs
// settleEffort 在 result 后按 getSettings().applied.ultracode 合成后经 applyEffort 落库；正则收下它
// 只是让所有走 normalize 的路径口径一致。
export function normalizeEffortLevel(e) {
  const v = (e && typeof e === 'object') ? e.level : e;
  return (typeof v === 'string' && /^(low|medium|high|xhigh|max|ultracode)$/.test(v)) ? v : null;
}
export function applyEffort(key, sessionId, level) {
  if (!sessionId) return;
  bump(efforts, key + '|' + sessionId, { level: level || null, at: Date.now() }, MAX_USAGES * 2);
  persist();
}
export function getEffort(key, sessionId) {
  return sessionId ? (efforts.get(key + '|' + sessionId) || null) : null;
}

export function applyCommands(key, list, terminal) {
  const cmds = (Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c.name === 'string' && c.name)
    .map((c) => ({ name: str(c.name, 80), description: str(c.description, 240), argumentHint: str(c.argumentHint, 80) }));
  if (!cmds.length) return;
  commands.set(key, { commands: cmds, terminal: (Array.isArray(terminal) ? terminal : []).map((s) => str(s, 80)), at: Date.now() });
  persist();
}
export function getCommands(key) {
  return commands.get(key) || { commands: [], terminal: [], at: 0 };
}
