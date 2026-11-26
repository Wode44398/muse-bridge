// Codex 分页外框（窄栏 / 侧栏 / 顶栏 / 首页 / 窄栏几页）用到的纯逻辑：不碰 DOM、不碰 i18n，便于单测。
// 文案由组件按这里给的记号自己拼（t('{n} 小时', { n }) 之类），这样英文界面也走字典。

/** 线程按项目分组。项目认不出来的（项目被删了、别的号建的）按它自带的 projectName 归成一组，再没有就归「其它」。
 *  返回 [{ key, id, name, branch, path, known, sessions }]：已知项目按 projects 的顺序在前，认不出的按名字排在后。
 *  项目里没有线程也照样列出来（可以在里面开新线程）。 */
export function groupSessions(projects = [], sessions = []) {
  const byId = new Map();
  const out = [];
  for (const p of projects) {
    const g = { key: 'p:' + p.id, id: p.id, name: p.name || '', branch: p.branch || '', path: p.path || '', known: true, sessions: [] };
    byId.set(p.id, g);
    out.push(g);
  }
  const loose = new Map();
  for (const s of sessions) {
    if (s.projectId && byId.has(s.projectId)) { byId.get(s.projectId).sessions.push(s); continue; }
    const name = s.projectName || '';
    const k = 'n:' + name;
    if (!loose.has(k)) loose.set(k, { key: k, id: '', name, branch: '', path: '', known: false, sessions: [] });
    loose.get(k).sessions.push(s);
  }
  const byTime = (a, b) => (b.mtime || 0) - (a.mtime || 0);
  for (const g of out) g.sessions.sort(byTime);
  const rest = [...loose.values()].sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || a.name.localeCompare(b.name));
  for (const g of rest) g.sessions.sort(byTime);
  return [...out, ...rest];
}

/** 侧栏搜索：标题或项目名里有关键字就算命中（不分大小写）。q 空 = 全命中。 */
export function matches(session, groupName, q) {
  const k = String(q || '').trim().toLowerCase();
  if (!k) return true;
  return String(session?.title || '').toLowerCase().includes(k) || String(groupName || '').toLowerCase().includes(k);
}

/** 标题按关键字切段，命中的那一段 hit=true（只标第一处，和 demo 一样）。 */
export function markParts(text, q) {
  const s = String(text ?? '');
  const k = String(q || '').trim().toLowerCase();
  if (!k) return [{ text: s, hit: false }];
  const i = s.toLowerCase().indexOf(k);
  if (i < 0) return [{ text: s, hit: false }];
  return [
    ...(i > 0 ? [{ text: s.slice(0, i), hit: false }] : []),
    { text: s.slice(i, i + k.length), hit: true },
    ...(i + k.length < s.length ? [{ text: s.slice(i + k.length), hit: false }] : []),
  ];
}

/** 侧栏行尾的时间：多久以前。返回 { unit, n }，unit ∈ now | min | hour | yesterday | day | week | date（date 时 n = 时间戳）。 */
export function ago(mtime, now = Date.now()) {
  const ms = Number(mtime) || 0;
  if (!ms) return null;
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return { unit: 'now', n: 0 };
  if (s < 3600) return { unit: 'min', n: Math.floor(s / 60) };
  if (s < 86400) return { unit: 'hour', n: Math.floor(s / 3600) };
  const day0 = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const days = Math.round((day0(now) - day0(ms)) / 86400000);
  if (days <= 1) return { unit: 'yesterday', n: 1 };
  if (days < 7) return { unit: 'day', n: days };
  if (days < 35) return { unit: 'week', n: Math.floor(days / 7) };
  return { unit: 'date', n: ms };
}

/** 状态列的记号：store 的 leadOf → theme.css 的 data-st（error 在样式里叫 err；write 在侧栏上也算「在想」）。 */
export function leadToken(lead) {
  if (lead === 'error') return 'err';
  if (lead === 'write') return 'think';
  return lead === 'think' || lead === 'exec' || lead === 'ask' || lead === 'unread' ? lead : '';
}

/** 一条线程所有轮的改动合计（顶栏改动计数）。summarize = turns.js 的 turnSummary。 */
export function diffTotal(turns = [], summarize) {
  let a = 0, d = 0;
  for (const turn of turns || []) {
    if (!turn) continue;
    try { const s = summarize(turn); a += s.a || 0; d += s.d || 0; } catch {}
  }
  return { a, d };
}

/** 前后翻线程的两个键能不能按。 */
export function historyEnds(history = [], at = -1) {
  return { back: at > 0, fwd: at >= 0 && at < history.length - 1 };
}

/** 收起的项目（localStorage 里存的是收起的那些 id，默认展开）。 */
export function parseFolded(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 500) : [];
  } catch { return []; }
}

export function toggleFolded(list = [], key) {
  return list.includes(key) ? list.filter((x) => x !== key) : [...list, key];
}

/* ---------------- 首页标志：发第一句时 `_` 飞下去 ---------------- */

// 标志的 viewBox 是 149..567（418 单位）；下划线 370.0–436.7，y = 408.7，笔画 24
const VB = 418, VB0 = 149, UL_X0 = 370.021, UL_X1 = 436.706, UL_Y = 408.738, UL_W = 24;

/** 标志的盒子（视口坐标 {left, top, width}）→ 下划线那一笔的盒子 { x, y, w, h }。 */
export function underscoreBox(logo) {
  const k = (logo.width || 0) / VB;
  return {
    x: logo.left + (UL_X0 - VB0) * k,
    y: logo.top + (UL_Y - VB0) * k - (UL_W / 2) * k,
    w: (UL_X1 - UL_X0) * k + UL_W * k,
    h: UL_W * k,
  };
}

/** `_` 从标志飞到小球的关键帧：先往上抛一点、缩成小球，再落到目标。from / to 都是同一坐标系里的 { x, y, w, h }。 */
export function underscoreFlight(from, to, opacity = 0.3) {
  const sx = from.x + from.w / 2, sy = from.y + from.h / 2;
  const ex = to.x + to.w / 2, ey = to.y + to.h / 2;
  const dx = ex - sx, dy = ey - sy;
  const lift = Math.min(70, Math.abs(dy) * 0.35 + 24);
  return {
    start: { left: sx, top: sy, w: from.w, h: from.h },
    frames: [
      { transform: 'translate(-50%,-50%)', width: from.w + 'px', height: from.h + 'px', borderRadius: from.h / 2 + 'px', opacity: String(opacity), easing: 'cubic-bezier(.3,0,.25,1)' },
      { transform: `translate(calc(-50% + ${dx * 0.32}px), calc(-50% + ${dy * 0.32 - lift}px))`, width: '12px', height: '12px', borderRadius: '6px', opacity: '1', offset: 0.42, easing: 'cubic-bezier(.45,0,.2,1)' },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`, width: to.w + 'px', height: to.h + 'px', borderRadius: to.h / 2 + 'px', opacity: '1' },
    ],
  };
}

/* ---------------- 窄栏几页 ---------------- */

/** 产物：从各线程的消息里收集助手交出来的附件，按线程分组（每组按出现顺序，同一路径只留一份）。 */
export function collectArtifacts(threads = []) {
  const out = [];
  for (const th of threads) {
    const seen = new Set();
    const items = [];
    for (const m of th?.messages || []) {
      if (m?.role !== 'assistant') continue;
      for (const a of m.attachments || []) {
        if (!a?.path || seen.has(a.path)) continue;
        seen.add(a.path);
        items.push({ path: a.path, name: a.name || String(a.path).split(/[\\/]/).pop() || '', kind: a.kind || '' });
      }
    }
    if (items.length) out.push({ id: th.id, title: th.title || '', mtime: th.mtime || 0, items });
  }
  return out;
}

/** 定时任务分两组：工作文件夹落在某个 Codex 项目里的在前（同一个仓库），其余在后。 */
export function splitRoutines(routines = [], projects = []) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const roots = projects.map((p) => ({ p, root: norm(p.path) })).filter((x) => x.root);
  const inProject = [], other = [];
  for (const r of routines) {
    const cwd = norm(r.cwd);
    const hit = cwd ? roots.find((x) => cwd === x.root || cwd.startsWith(x.root + '/')) : null;
    if (hit) inProject.push({ routine: r, project: hit.p });
    else other.push({ routine: r, project: null });
  }
  return { inProject, other };
}

/** 并发上限地跑一串异步任务，结果按原顺序（失败的那项是 null）。 */
export async function pool(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch { out[k] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
