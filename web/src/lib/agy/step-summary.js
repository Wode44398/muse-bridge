// agy 步骤段的折叠汇总（11-18）：一段连续的思考 / 工具调用折成一行，
// 收起时显示「执行 5 条命令，修改 4 个文件，读取 1 个文件」这样的汇总句，照 Claude 分页 ToolGroup 的做法。
import { classifyToolKind, computeDiffLines } from './logic.js';
import { t } from '../i18n.js';

const locPathOf = (loc) => (typeof loc === 'string' ? loc : String(loc?.path || ''));

export function toolIsRunning(tool) {
  return tool?.status === 'in_progress' || tool?.status === 'pending';
}

export function toolIsFailed(tool) {
  if (!tool || tool.status === 'cancelled') return false;
  if (tool.status === 'failed' || tool.status === 'error') return true;
  return tool.exitCode !== null && tool.exitCode !== undefined && Number(tool.exitCode) !== 0;
}

// 文件类工具按路径去重（同一文件改三次算「修改 1 个文件」）
function fileKeyOf(tool) {
  const d = Array.isArray(tool.diffs) && tool.diffs[0]?.path;
  if (d) return String(d);
  const loc = Array.isArray(tool.locations) && tool.locations.length ? locPathOf(tool.locations[0]) : '';
  if (loc) return loc;
  const a = tool.args?.Path || tool.args?.path || tool.args?.file_path || '';
  return a ? String(a) : '';
}

function catOf(tool, meta) {
  if (meta.category !== 'edit') return meta.category;
  const kind = String(tool.kind || '').toLowerCase();
  const name = String(tool.name || '').toLowerCase();
  return kind === 'delete' || /delete/.test(name) ? 'delete' : 'edit';
}

const PHRASE = {
  execute: (n) => t('执行 {n} 条命令', { n }),
  edit: (n) => t('修改 {n} 个文件', { n }),
  delete: (n) => t('删除 {n} 个文件', { n }),
  read: (n) => t('读取 {n} 个文件', { n }),
  search: (n) => t('搜索 {n} 次', { n }),
  fetch: (n) => t('网络检索 {n} 次', { n }),
};

/**
 * items: [{ blk, tool? }]（blk.type 为 thinking / tool；tool 已按 toolsById 解析好）
 * 返回 { pieces:[{ text, isError }], added, removed, toolCount, thinkCount }
 */
export function summarizeSteps(items, { sessionCwd = '' } = {}) {
  const order = [];
  const groups = new Map();   // key → { keys:Set, err, phrase }
  let added = 0;
  let removed = 0;
  let toolCount = 0;
  let thinkCount = 0;
  for (const it of items || []) {
    if (it.blk?.type === 'thinking') { thinkCount++; continue; }
    const tool = it.tool;
    if (!tool) continue;
    toolCount++;
    const meta = classifyToolKind(tool, { sessionCwd });
    const cat = catOf(tool, meta);
    // bridge 工具自带归类（meta.group）：操作浏览器、查手册这些不是「网络检索」「读取文件」
    const label = meta.group || meta.verb;
    const known = !meta.group && Object.prototype.hasOwnProperty.call(PHRASE, cat);
    const gkey = known ? cat : 'v:' + label;
    let g = groups.get(gkey);
    if (!g) {
      g = { keys: new Set(), err: false, phrase: known ? PHRASE[cat] : (n) => (n > 1 ? t('{verb} {n} 次', { verb: label, n }) : label) };
      groups.set(gkey, g);
      order.push(gkey);
    }
    const fk = (cat === 'edit' || cat === 'delete' || cat === 'read') ? fileKeyOf(tool) : '';
    g.keys.add(fk || tool.toolCallId || ('i' + toolCount));
    if (toolIsFailed(tool)) g.err = true;
    // 与行内 ± 角标同一套算法，保证汇总数 = 各行之和
    for (const d of Array.isArray(tool.diffs) ? tool.diffs : []) {
      const r = computeDiffLines(d.oldText ?? '', d.newText ?? '', 1);
      added += r.added;
      removed += r.removed;
    }
  }
  const pieces = order.map((k) => {
    const g = groups.get(k);
    return { text: g.phrase(g.keys.size), isError: g.err };
  });
  if (pieces.length === 0 && thinkCount > 0) {
    pieces.push({ text: thinkCount > 1 ? t('思考 {n} 段', { n: thinkCount }) : t('思考'), isError: false });
  }
  return { pieces, added, removed, toolCount, thinkCount };
}
