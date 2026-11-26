// Antigravity 工具清单的体量账：bridge 给 agy 的全部工具（子进程本地的媒体 / 界面 / 手机文件 + 服务端中枢各组）
// 在这里精简、合并、按份额取舍。纯函数、不引服务端模块——stdio 子进程（agy-bridge-server.mjs）也引它。
//
// agy 对一个会话里的全部工具声明（自带工具 + 所有 MCP 服务的工具）有一个总上限，超了就从体量最大的工具开始整个丢掉，
// 不报错，模型根本不知道有这个工具。11-24 对照（会话库 gen_metadata 里 agy 自己记的每个工具的体量）：自带约 7400、
// context7 约 1800、bridge 约 23200，合计约 3.25 万时 device_browser（全场最大，约 2300）被丢；合计约 3.11 万时全都在——
// 上限在两者之间（多半是 3.2 万）。bridge 每加一个工具都往上挤，最先被挤掉的偏偏是最大、最常用的浏览器。所以三层：
//   1. 精简：体量大的工具只给一句话 + 精简参数表，完整说明经 tool_docs 现取（中枢与子进程本地工具同一口径）；
//   2. 合并：同族的几样小工具合成一个按 action 分派的工具（每个工具在 agy 那头另有约 110 的固定开销）；
//   3. 份额：bridge 自己的总量夹在 AGY_BRIDGE_SHARE 以内，超了按先后让出不常用的；浏览器 / 终端 / 工作区 / 电脑这几样永远不让。

export const AGY_DOCS_TOOL = 'tool_docs';

// ── 体量估算 ──────────────────────────────────────────────────────────────────
/** 粗估 token（中文按字计重）。 */
export function agyTokenEstimate(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  const wide = (s.match(/[^\x00-\x7f]/g) || []).length;
  return Math.round((s.length - wide) * 0.25 + wide * 0.9);
}

/**
 * 一个工具在 agy 那头占的声明体量（agy 自己的计数口径）。用 11-24 那份会话记录的 45 个 bridge 工具标定：
 * agy 记的数 ≈ 1.31 × 粗估 + 110（固定开销：名字、包装），总量误差约 +1%（略偏大，偏保守）。
 */
export function agyDeclUnits(tool) {
  return Math.round(1.31 * (agyTokenEstimate(tool?.description || '') + agyTokenEstimate(tool?.inputSchema || {})) + 110);
}

// ── 精简 ────────────────────────────────────────────────────────────────────
const COMPACT_OVER = 450;   // 粗估超过这个数的工具才精简
export const firstPara = (text, max = 260) => {
  const p = String(text || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return p.length > max ? p.slice(0, max).replace(/[，,；;。.\s]*$/, '') + '…' : p;
};
// batch 单步的字段骨架：只留字段名与类型（不带说明、不带枚举，单步 action 的枚举另留）。
// agy 把对象的 properties 当成封闭表：没列的字段一律「additional properties not allowed」，在 agy 那头就拒了，
// 根本到不了 bridge（11-22 反馈：batch 里写 text / ref / x 全被拦，多步只能一轮一步）。所以字段名一个都不能省。
function fieldSkeleton(v) {
  if (!v || typeof v !== 'object') return {};
  if (Array.isArray(v.anyOf)) return { anyOf: v.anyOf.map(fieldSkeleton) };
  const out = {};
  if (v.type) out.type = v.type;
  if (v.type === 'array') out.items = fieldSkeleton(v.items);
  if (v.type === 'object' && v.properties) out.properties = Object.fromEntries(Object.entries(v.properties).map(([k, x]) => [k, fieldSkeleton(x)]));
  return out;
}
// 参数表精简：只留结构（类型、枚举、必填），参数说明只留 30 字以内的；batch 单步只留字段骨架（见上）
function compactSchema(schema) {
  const walk = (o, depth) => {
    if (Array.isArray(o)) return o.map((x) => walk(x, depth));
    if (!o || typeof o !== 'object') return o;
    const r = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'description') { if (depth > 0 && typeof v === 'string' && v.length <= 30) r[k] = v; continue; }
      r[k] = k === 'properties' ? Object.fromEntries(Object.entries(v || {}).map(([pk, pv]) => [pk, walk(pv, depth + 1)])) : walk(v, depth);
    }
    return r;
  };
  const out = walk(schema, 0);
  // 单步能用哪些动作要留着：设备的批内动作和单步不是同一张表（批里能截图、不能 launch），不留模型只能撞校验
  const steps = schema?.properties?.actions;
  if (steps?.items?.properties) {
    const props = steps.items.properties;
    const stepActions = props.action?.enum;
    const fields = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, fieldSkeleton(v)]));
    if (Array.isArray(stepActions)) fields.action = { type: 'string', enum: stepActions };
    out.properties.actions = {
      type: 'array',
      description: '多步：每步一个对象，字段同单步调用',
      items: { type: 'object', properties: fields, ...(steps.items.required ? { required: steps.items.required } : {}) },
      ...(steps.maxItems ? { maxItems: steps.maxItems } : {}),
    };
  }
  return out;
}
export function compactAgyTool(tool) {
  const cost = agyTokenEstimate(tool.description) + agyTokenEstimate(tool.inputSchema);
  if (cost <= COMPACT_OVER) return tool;
  return {
    ...tool,
    description: `${firstPara(tool.description)}\n（精简版说明：动作、参数含义与注意事项先调 ${AGY_DOCS_TOOL}(name:"${tool.name}") 看完整说明。）`,
    inputSchema: compactSchema(tool.inputSchema),
  };
}

// ── 合并 ────────────────────────────────────────────────────────────────────
// 合成一个工具的几族：对外只剩 name，action = 原工具名去掉 prefix。审批、手动允许、通知与界面文案一律先换回原工具名再判
//（memberToolName），口径与合并前完全一样。前端 web/src/lib/agy/logic.js 的 FAMILY_PREFIX 是同一张表（改这里要一起改）。
export const AGY_TOOL_FAMILIES = Object.freeze([
  {
    name: 'pr',
    prefix: 'pr_',
    members: ['pr_status', 'pr_bind', 'pr_unbind', 'pr_sync_base', 'pr_set_monitor', 'pr_set_auto_merge'],
    description: '这个会话绑定的拉取请求（PR），按 action 分：status 看 PR 与 CI、评审、可否合并（别循环跑 gh pr checks）；bind / unbind 绑定或不再跟踪某个 PR（url）；sync_base 在本机把基线分支合进当前分支（不推送，有冲突解决后 commit，或 abort:true 放弃）；set_monitor 自动修复开关（auto_fix）；set_auto_merge 就绪后自动合并开关（enabled）。后两样用户没要求就别开，开时会先问用户。',
  },
  {
    name: 'project_memory',
    prefix: 'project_memory_',
    members: ['project_memory_read', 'project_memory_write', 'project_memory_delete'],
    description: '这个项目的共享记忆（同一个 Antigravity 项目或同一个文件夹里的会话共用，存在 bridge 里），按 action 分：read 不带 name 列出全部并读 MEMORY.md 索引、带 name 读一篇；write 整篇写入一篇（name 以 .md 结尾，content 为全文）；delete 删一篇。',
  },
  {
    name: 'phone_files',
    prefix: 'phone_',
    members: ['phone_list', 'phone_read', 'phone_write', 'phone_scan', 'phone_delete'],
    description: '发起这次对话的那台手机上【系统选择器已授权的文件夹】里的文件，按 action 分：list 列一层目录（path 留空列出已授权根位置 @rN）；read 读文件（默认 utf8，二进制用 encoding:"base64"）；write 覆盖写入；scan 递归找大文件（minSizeMB、limit）；delete 删除（不可撤回，先向用户列出路径与体积并得到确认）。访问不了 Android/data 等私有缓存。',
  },
]);
const FAMILY_BY_NAME = new Map(AGY_TOOL_FAMILIES.map((f) => [f.name, f]));
const FAMILY_OF_MEMBER = new Map(AGY_TOOL_FAMILIES.flatMap((f) => f.members.map((m) => [m, f])));

export const familyOf = (name) => FAMILY_BY_NAME.get(String(name || '')) || null;
export const familyOfMember = (name) => FAMILY_OF_MEMBER.get(String(name || '')) || null;

/** 合并工具的一次调用 → { member: 原工具名（action 不认识时为 ''）, args: 去掉 action 的参数 }；不是合并工具返回 null。 */
export function expandFamilyCall(name, args = {}) {
  const fam = familyOf(name);
  if (!fam) return null;
  const a = args && typeof args === 'object' ? args : {};
  const { action, ...rest } = a;
  const member = fam.prefix + String(action || '').trim().toLowerCase();
  return { family: fam, member: fam.members.includes(member) ? member : '', args: rest };
}

/** 审批 / 文案用的工具名：合并工具按 action 换回原工具名，action 不认识就原样（按合并名判，偏保守）；其余原样。 */
export function memberToolName(name, args) {
  const x = expandFamilyCall(name, args);
  return x && x.member ? x.member : String(name || '');
}

/**
 * 把清单里同族的工具换成一个合并工具（放在族里第一个成员的位置）。参数表 = action 枚举 + 各成员参数的并集
 *（agy 把 properties 当封闭表，一个字段名都不能少）；成员各自的必填项由执行时的原工具校验。族里一个成员都没有就不出现。
 */
export function mergeFamilies(tools) {
  const out = [];
  const done = new Set();
  for (const t of tools) {
    const fam = familyOfMember(t.name);
    if (!fam) { out.push(t); continue; }
    if (done.has(fam.name)) continue;
    done.add(fam.name);
    const members = fam.members.map((n) => tools.find((x) => x.name === n)).filter(Boolean);
    const properties = { action: { type: 'string', enum: members.map((m) => m.name.slice(fam.prefix.length)) } };
    for (const m of members) {
      for (const [k, v] of Object.entries(m.inputSchema?.properties || {})) if (k !== 'action' && !(k in properties)) properties[k] = v;
    }
    const { name: _n, description: _d, inputSchema: _s, annotations: _a, ...extra } = t;   // _group 这类内部字段沿用第一个成员的
    out.push({ ...extra, name: fam.name, description: fam.description, inputSchema: { type: 'object', properties, required: ['action'] }, _members: members });
  }
  return out;
}

// ── 份额 ────────────────────────────────────────────────────────────────────
export const AGY_DECL_LIMIT = 32_000;      // agy 单会话工具声明总上限（推定，见文件头）
// bridge 自己这一份：上限减去 agy 自带工具（约 7400，随 agy 版本涨）、用户自己的 MCP（context7 约 1800）再留约 1700 余量
export const AGY_BRIDGE_SHARE = 21_000;

// 永远不让的：缺了它们 agy 就做不成「看网页 / 动电脑 / 跑命令」这类主活
const NEVER_YIELD = new Set([
  'browser', 'device_browser', 'terminal', 'workspace', 'manual', 'call', AGY_DOCS_TOOL,
  'device_devices', 'device_inspect', 'device_act', 'device_shell', 'device_files', 'device_ports',
]);
// 成对 / 成组才有用的，要让一起让
const unitOf = (name) => (name.startsWith('visualize_') ? 'visualize'
  : ['start_session', 'send_message', 'list_sessions', 'read_session', 'dismiss_task'].includes(name) ? 'sessions'
  : name);
// 先让的排前面
const YIELD_ORDER = ['pr', 'project_memory', 'media_music', 'media_speech', 'phone_files', 'plugin_', 'ext_', 'media_video', 'visualize', 'sessions'];
function yieldRank(unit) {
  const i = YIELD_ORDER.findIndex((k) => (k.endsWith('_') ? unit.startsWith(k) : unit === k));
  return i < 0 ? YIELD_ORDER.length : i;
}

/**
 * 把清单夹进份额：总量（agyDeclUnits 之和）超了就按 YIELD_ORDER 整组让出（同一档里先让大的），直到不超。
 * 返回 { tools: 留下的（原顺序）, withheld: 让出的名字, total: 留下的总量 }。
 */
export function fitBridgeShare(tools, share = AGY_BRIDGE_SHARE) {
  let total = tools.reduce((a, t) => a + agyDeclUnits(t), 0);
  if (total <= share) return { tools, withheld: [], total };
  const units = new Map();
  for (const t of tools) {
    if (NEVER_YIELD.has(t.name)) continue;
    const u = unitOf(t.name);
    const e = units.get(u) || { unit: u, names: [], size: 0 };
    e.names.push(t.name);
    e.size += agyDeclUnits(t);
    units.set(u, e);
  }
  const order = [...units.values()].sort((a, b) => yieldRank(a.unit) - yieldRank(b.unit) || b.size - a.size);
  const withheld = new Set();
  for (const u of order) {
    if (total <= share) break;
    for (const n of u.names) withheld.add(n);
    total -= u.size;
  }
  return { tools: tools.filter((t) => !withheld.has(t.name)), withheld: [...withheld], total };
}
