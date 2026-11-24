// Antigravity 分页落在本机的两样东西：每个会话没发出去的草稿、会话列表的一份缓存。
//
// 草稿以前只在内存里：刷新、apk 被系统回收、重启之后就没了。现在按会话存进 localStorage——
// 只存文字和【已经传完】的附件（服务端上的路径；blob: 预览地址过了这次页面就失效，不存）。
// 会话列表缓存让冷启动 / 断网时侧栏先有东西看，拉到新的再换掉。
// 纯函数 + 可注入的 storage，node --test 直接跑。

export const DRAFTS_KEY = 'bridge-agy-drafts';
export const SESSIONS_KEY = 'bridge-agy-sessions';
export const NEW_DRAFT = '__new__';
const DRAFT_CAP = 30;          // 最多留多少个会话的草稿（按最近改动）
const DRAFT_TEXT_MAX = 20_000;
const SESSIONS_CAP = 200;

const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };
export const draftKeyOf = (sid) => sid || NEW_DRAFT;

// 附件 → 能落盘的样子（传完的才要；预览地址不存，恢复时按路径现拼）
export function cleanAtts(atts) {
  const out = [];
  for (const a of Array.isArray(atts) ? atts : []) {
    if (!a || a.pending || typeof a.path !== 'string' || !a.path) continue;
    const peaks = Array.isArray(a.peaks)
      ? a.peaks.slice(0, 48).map((v) => Math.round(Math.max(0.05, Math.min(1, Number(v) || 0.12)) * 100) / 100)
      : null;
    out.push({
      path: a.path,
      name: String(a.name || ''),
      kind: a.kind === 'image' || a.kind === 'folder' || a.kind === 'chat' || a.kind === 'voice' ? a.kind : 'file',
      ...(a.quoteId ? { quoteId: String(a.quoteId) } : {}),
      ...(Number.isFinite(a.count) && a.count >= 0 ? { count: a.count } : {}),
      ...(a.note ? { note: String(a.note) } : {}),
      ...(Number.isFinite(a.size) && a.size >= 0 ? { size: a.size } : {}),
      ...(Number.isFinite(Number(a.duration)) && Number(a.duration) > 0 ? { duration: Math.round(Number(a.duration) * 100) / 100 } : {}),
      ...(peaks && peaks.length ? { peaks } : {}),
    });
  }
  return out;
}

export function loadDrafts(storage = ls()) {
  const map = new Map();
  if (!storage) return map;
  try {
    const raw = JSON.parse(storage.getItem(DRAFTS_KEY) || '{}');
    for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (!v || typeof v !== 'object') continue;
      const text = typeof v.text === 'string' ? v.text : '';
      const atts = cleanAtts(v.atts);
      if (!text && !atts.length) continue;
      map.set(k, { text, atts, at: Number(v.at) || 0 });
    }
  } catch {}
  return map;
}

export function saveDrafts(map, storage = ls()) {
  if (!storage) return;
  try {
    const rows = [...map.entries()]
      .filter(([, v]) => v && (v.text || (v.atts && v.atts.length)))
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, DRAFT_CAP);
    const out = {};
    for (const [k, v] of rows) out[k] = { text: String(v.text || '').slice(0, DRAFT_TEXT_MAX), atts: cleanAtts(v.atts), at: v.at || 0 };
    if (rows.length) storage.setItem(DRAFTS_KEY, JSON.stringify(out));
    else storage.removeItem(DRAFTS_KEY);
  } catch {}
}

// 写一条（空的 = 删掉）。返回 map 有没有变。
export function putDraft(map, sid, text, atts, now = Date.now()) {
  const k = draftKeyOf(sid);
  const t = String(text || '');
  const a = cleanAtts(atts);
  const prev = map.get(k);
  if (!t && !a.length) return map.delete(k);
  if (prev && prev.text === t && JSON.stringify(prev.atts) === JSON.stringify(a)) return false;
  map.set(k, { text: t, atts: a, at: now });
  return true;
}

// —— 会话列表缓存 ——
const ROW_KEYS = ['sessionId', 'cwd', 'projectId', 'projectName', 'title', 'customTitle', 'updatedAt', 'updatedMs', 'hidden'];
export function saveSessionsCache(rows, storage = ls()) {
  if (!storage) return;
  try {
    const slim = (Array.isArray(rows) ? rows : []).slice(0, SESSIONS_CAP).map((r) => {
      const o = {};
      for (const k of ROW_KEYS) if (r && r[k] !== undefined) o[k] = r[k];
      return o;
    }).filter((r) => r.sessionId);
    storage.setItem(SESSIONS_KEY, JSON.stringify({ at: Date.now(), rows: slim }));
  } catch {}
}
export function loadSessionsCache(storage = ls()) {
  if (!storage) return [];
  try {
    const raw = JSON.parse(storage.getItem(SESSIONS_KEY) || 'null');
    const rows = raw && Array.isArray(raw.rows) ? raw.rows : [];
    return rows.filter((r) => r && typeof r.sessionId === 'string' && r.sessionId && !r.hidden);
  } catch { return []; }
}

// 排着队被退回的几条消息 → 并回输入框：文字用空行接在现有草稿后面，附件按路径去重追加
export function mergeReturned(draftText, draftAtts, items) {
  const texts = [String(draftText || '').trim(), ...(Array.isArray(items) ? items : []).map((x) => String(x?.text || '').trim())].filter(Boolean);
  const atts = [...(Array.isArray(draftAtts) ? draftAtts : [])];
  const seen = new Set(atts.map((a) => a && a.path).filter(Boolean));
  for (const it of Array.isArray(items) ? items : []) {
    for (const a of cleanAtts(it?.atts)) {
      if (seen.has(a.path)) continue;
      seen.add(a.path);
      atts.push(a);
    }
  }
  return { text: texts.join('\n\n'), atts };
}
