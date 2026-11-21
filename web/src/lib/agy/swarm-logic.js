// Antigravity Native Swarm 前端纯逻辑（无 Svelte 依赖，可独立单测）：
//   · buildSwarmViewModel：从 /api/agy/swarm 快照推导总览（目标 / 正在进行 / 分组进度 / 异常 / 截图帧）与成员分组
//   · filterSwarmMessages & renderSwarmPostHtml：消息板过滤 + 安全 Markdown 与 @mention / @#channel / #seq 引用高亮
//   · computeSwarmGraph：协作关系图布局（椭圆 / 分层）、曲线几何与时间线回放状态计算

const ROLE_WORKER_RE = /^(?:narrator|monitor)(?:-\d+)?$/;
const DONE_POST_RE = /^(@[A-Za-z0-9_-]+[\s,:–—-]*)*(?:\*\*|\*|`|_)?\[done\]/i;
const ASK_TEXT_RE = /\?|？|could you|can you|please|ping me|waiting on|请确认|能否|方便看下/i;
const TSTATE = { done: 'done', active: 'running', review: 'running', blocked: 'blocked', failed: 'blocked', queued: 'queued' };

export function isSwarmRoleWorker(m) {
  if (!m || typeof m !== 'object') return false;
  return Boolean(m.roleWorker || m.narrator || (m.role && m.role !== 'worker' && m.role !== 'coordinator') || ROLE_WORKER_RE.test(String(m.name || '')));
}

function cleanInlineText(src, maxLen = 220) {
  const s = String(src || '')
    .replace(/^\s*(?:[-*]|#+|\d+\.)\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > maxLen ? `${s.slice(0, maxLen - 1).trimEnd()}…` : s;
}

export function stripLeadingMentions(text) {
  const s = String(text || '');
  const rest = s.replace(/^(\s*@#?[A-Za-z0-9_.-]+[,:]?)+\s*/, '');
  return rest || s;
}

function stripLeadingTags(text) {
  return stripLeadingMentions(text)
    .replace(/^(?:\*\*|\*|`|_)*\[(?:done|stall)\](?:\*\*|\*|`|_)*[\s:,–—-]*/i, '')
    .trim();
}

export function shortWorkspacePath(raw) {
  const list = String(raw || '').split(/,\s+/).map((p) => p.trim()).filter(Boolean);
  if (!list.length) return '';
  const fmtOne = (p) => {
    const norm = p.replace(/\\/g, '/');
    const segs = norm.replace(/\/+$/, '').split('/').filter(Boolean);
    if (!segs.length) return norm.startsWith('/') ? '/' : p;
    const out = segs.length > 2 ? `…/${segs.slice(-2).join('/')}` : `${norm.startsWith('/') ? '/' : ''}${segs.join('/')}`;
    return out.length > 44 ? `…${out.slice(-43)}` : out;
  };
  return list.length > 1 ? `${fmtOne(list[0])} +${list.length - 1}` : fmtOne(list[0]);
}

/** 把同前缀且全员被提及的分片组（如 worker-1..N）折叠为 @worker。 */
export function collapseRecipientGroups(names, roster = []) {
  const set = new Set(names || []);
  const groups = new Map();
  for (const mem of roster || []) {
    const m = String(mem?.name || '').match(/^(.+)-\d+$/);
    if (!m) continue;
    const prefix = m[1];
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(mem.name);
  }
  const collapsed = new Set();
  const out = [];
  for (const n of names || []) {
    const m = String(n || '').match(/^(.+)-\d+$/);
    const prefix = m?.[1];
    const group = prefix ? groups.get(prefix) : null;
    if (group && group.length >= 2 && group.every((g) => set.has(g))) {
      if (!collapsed.has(prefix)) {
        collapsed.add(prefix);
        out.push(prefix);
      }
    } else {
      out.push(n);
    }
  }
  return out;
}

/** 按工作区消息板筛选条件过滤帖子。 */
export function filterSwarmMessages(messages, {
  q = '',
  channel = '',
  from = '',
  to = '',
  hiddenAgents = null,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const query = String(q || '').trim().toLowerCase();
  const hidden = hiddenAgents instanceof Set ? hiddenAgents : new Set();
  return list.filter((m) => {
    if (!m) return false;
    const ch = m.channel || 'main';
    if (channel && ch !== channel) return false;
    if (hidden.has(m.agent)) return false;
    if (from && m.agent !== from) return false;
    if (to === '@none') {
      if (m.control) return false;
      if ((m.mentions || []).length || m.all || (m.channelMentions || []).length) return false;
    } else if (to === '@all') {
      if (!m.all) return false;
    } else if (to) {
      if (!(m.all || (m.mentions || []).includes(to) || (m.viaChannel || []).includes(to))) return false;
    }
    if (query && !`${m.agent}\n${m.text || ''}\n#${m.seq}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const MENTION_RE = /(^|[^\p{L}\p{N}_-])@([\p{L}\p{N}_-]+)/gu;
const CHANNEL_MENTION_RE = /(^|[^\p{L}\p{N}_-])@#([a-z][a-z0-9-]{0,23})(?![\p{L}\p{N}_-])/giu;
const CITATION_RE = /(^|[^\p{L}\p{N}_&#/-])#([1-9]\d{0,8})(?![\p{L}\p{N}_-])/gu;
const SHOT_LINE_RE = /^\s*(?:[-*]\s*)?screenshot:\s*`?(?:\/|[a-zA-Z]:[\\/])[^\r\n`|]+\.(?:png|jpe?g|webp)`?\s*(?:\|\s*.+?)?\s*$/i;

/**
 * 安全渲染消息板帖子为轻量 HTML（先全量 HTML 转义再格式化）：
 * 支持代码块、标题、列表、粗体/斜体/行内代码，并高亮 @member / @all / @#channel 与可点击跳转的 #seq 引用。
 */
export function renderSwarmPostHtml(rawText, {
  members = [],
  channels = [],
  messages = [],
  stripLead = false,
  hideShotLines = false,
} = {}) {
  const memberByLower = new Map();
  for (const m of members || []) {
    if (m?.name) memberByLower.set(String(m.name).toLowerCase(), m);
  }
  const chanByLower = new Map();
  for (const c of channels || []) {
    if (c?.name) chanByLower.set(String(c.name).toLowerCase(), c);
  }
  const msgBySeq = new Map();
  for (const m of messages || []) {
    if (Number.isFinite(Number(m?.seq))) msgBySeq.set(Number(m.seq), m);
  }

  const highlightChannelMentions = (html) => {
    if (!chanByLower.size) return html;
    return html.replace(CHANNEL_MENTION_RE, (all, pre, name) => {
      const c = chanByLower.get(name.toLowerCase());
      if (!c) return all;
      return `${pre}<button type="button" class="sw-mention chan${c.archived ? ' archived' : ''}" data-sw-channel="${escHtml(c.name)}">@#${escHtml(name)}</button>`;
    });
  };

  const highlightMentions = (html) => {
    const step1 = highlightChannelMentions(html);
    return step1.replace(MENTION_RE, (all, pre, name) => {
      const lower = name.toLowerCase();
      if (lower === 'all') return `${pre}<span class="sw-mention all">@${escHtml(name)}</span>`;
      const hit = memberByLower.get(lower);
      if (hit) {
        return `${pre}<button type="button" class="sw-mention" data-sw-member="${escHtml(hit.name)}">@${escHtml(name)}</button>`;
      }
      const groupHit = (members || []).some((mem) => {
        const g = String(mem?.name || '').toLowerCase().match(/^(.+)-\d+$/);
        return g && g[1] === lower;
      });
      if (groupHit) return `${pre}<span class="sw-mention">@${escHtml(name)}</span>`;
      return all;
    });
  };

  const highlightCitations = (html) => html
    .replace(CITATION_RE, (all, pre, digits) => {
      const seq = Number(digits);
      if (!Number.isInteger(seq) || seq <= 0) return all;
      const target = msgBySeq.get(seq);
      const tip = target ? `#${seq} · @${target.agent}` : `#${seq}`;
      return `${pre}<button type="button" class="sw-seq-ref" data-sw-seq="${seq}" title="${escHtml(tip)}">#${seq}</button>`;
    })
    .replace(/<code>(<button\b[^>]*\bsw-seq-ref\b[^>]*>#[0-9]+<\/button>)<\/code>/g, '$1');

  const inline = (line) => {
    const escaped = escHtml(line)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1<em>$2</em>')
      .replace(/(^|\s)\[(done|stall)\](?=\s|$|[.,:;!])/gi, '$1<span class="sw-tag $2">[$2]</span>');
    return highlightCitations(highlightMentions(escaped));
  };

  const src = stripLead ? stripLeadingMentions(rawText) : String(rawText || '');
  const lines = src.split(/\r?\n/);
  let out = '';
  let inCode = false;
  let codeLines = [];
  let inList = false;
  const closeList = () => { if (inList) { out += '</ul>'; inList = false; } };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        out += `<pre><code>${escHtml(codeLines.join('\n'))}</code></pre>`;
        codeLines = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (hideShotLines && SHOT_LINE_RE.test(line)) continue;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
      continue;
    }
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (li) {
      if (!inList) { out += '<ul>'; inList = true; }
      out += `<li>${inline(li[1])}</li>`;
      continue;
    }
    closeList();
    if (line.trim()) out += `<p>${inline(line)}</p>`;
  }
  if (inCode) out += `<pre><code>${escHtml(codeLines.join('\n'))}</code></pre>`;
  closeList();
  return out;
}

/** 从 /api/agy/swarm 快照构建总览与成员视图模型。 */
export function buildSwarmViewModel(snap) {
  if (!snap || !snap.hasSwarm) return null;
  const allMembers = Array.isArray(snap.members) ? snap.members : [];
  const messages = Array.isArray(snap.messages) ? snap.messages : [];
  const byName = new Map(allMembers.map((m) => [m.name, m]));
  const coord = allMembers.find((m) => m.role === 'coordinator') || null;
  const leadName = coord?.name || 'coordinator';
  const team = allMembers.filter((m) => !isSwarmRoleWorker(m));
  const observers = allMembers.filter((m) => isSwarmRoleWorker(m));
  const teamMsgs = messages.filter((m) => !m.control && !isSwarmRoleWorker(byName.get(m.agent)));

  const lastPostBy = new Map();
  for (const m of teamMsgs) lastPostBy.set(m.agent, m);

  const briefOf = (name) => {
    const re = new RegExp(`^@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i');
    const first = teamMsgs.find((m) => m.agent === leadName && re.test(String(m.text || '').trim()));
    if (!first) return '';
    const line = stripLeadingTags(first.text).split(/(?<=[.!?。！？])\s|\n/)[0] || '';
    return cleanInlineText(line, 110);
  };

  const plan = snap.plan && typeof snap.plan === 'object' ? snap.plan : null;
  const planTasks = plan?.tasks && typeof plan.tasks === 'object' ? plan.tasks : {};
  const view = snap.view && typeof snap.view === 'object' ? snap.view : null;
  const finished = Boolean(snap.finished);

  // 增强成员状态（推断 waiting_on 谁、最近动态、任务简称）
  const enriched = new Map();
  for (const m of allMembers) {
    const lp = lastPostBy.get(m.name) || null;
    let displayState = m.killed ? 'killed' : (m.failure ? 'error' : (m.stuck ? 'stuck' : (m.status === 'working' ? 'working' : 'waiting')));
    let waitingOn = '';
    if (!finished && !m.killed && displayState === 'waiting' && lp && !lp.all) {
      const targets = (lp.mentions || []).filter((n) => n !== m.name && !isSwarmRoleWorker(byName.get(n)));
      if (targets.length && ASK_TEXT_RE.test(lp.text || '')) {
        const t0 = targets[0];
        const repliedAfter = teamMsgs.some((q) => q.seq > lp.seq && q.agent === t0);
        if (!repliedAfter) {
          displayState = 'waiting_on';
          waitingOn = t0;
        }
      }
    }
    if (m.name === leadName && snap.needsUser && !finished && !m.killed) {
      displayState = 'needs_you';
    }
    const taskTitle = m.name === leadName
      ? ''
      : (typeof planTasks[m.name] === 'string' && planTasks[m.name].trim()
        ? planTasks[m.name].trim()
        : briefOf(m.name));
    const nowText = (m.status === 'working' && m.activity)
      ? m.activity
      : (m.failure?.text || (lp ? cleanInlineText(stripLeadingTags(lp.text), 140) : ''));
    enriched.set(m.name, {
      ...m,
      displayState,
      waitingOn,
      taskTitle,
      nowText,
      lastPost: lp,
    });
  }

  // 构建工作项（优先 narrator view.json，其次由 plan.tasks + workers 实时推导）
  const fallbackWsState = (em) => {
    if (!em) return 'queued';
    if (em.killed) return 'done';
    if (em.failure || em.stuck || em.displayState === 'waiting_on') return 'blocked';
    if (em.status === 'working') return 'active';
    if (em.lastPost) return (finished || DONE_POST_RE.test(em.lastPost.text || '')) ? 'done' : 'review';
    return 'queued';
  };

  let workstreams = [];
  if (Array.isArray(view?.workstreams) && view.workstreams.length) {
    workstreams = view.workstreams
      .filter((w) => w && w.title)
      .slice(0, 40)
      .map((w, i) => {
        const owners = (Array.isArray(w.owners) ? w.owners : []).filter((o) => byName.has(o));
        const raw0 = typeof w.state === 'string' ? w.state : 'active';
        const rawState = (finished && raw0 !== 'failed') ? 'done' : raw0;
        const normState = TSTATE[rawState] || 'queued';
        return {
          id: String(w.id || `w-${i}`),
          title: String(w.title).slice(0, 120),
          owners: owners.length ? owners : [leadName],
          rawState,
          state: normState,
          note: cleanInlineText(w.note || '', 160),
          seq: Array.isArray(w.refs) ? Math.max(0, ...w.refs.map((r) => Number(r?.seq) || 0)) : (snap.head || 0),
        };
      });
  } else {
    workstreams = team
      .filter((m) => m.name !== leadName)
      .map((m) => {
        const em = enriched.get(m.name);
        const rawState = fallbackWsState(em);
        return {
          id: m.name,
          title: em.taskTitle || `@${m.name}`,
          owners: [m.name],
          rawState,
          state: TSTATE[rawState] || 'queued',
          note: em.nowText,
          waitingOn: em.waitingOn || '',
          seq: em.lastPost?.seq || 0,
        };
      });
  }

  const wsById = new Map(workstreams.map((w) => [w.id, w]));
  const rawThreads = Array.isArray(view?.threads) && view.threads.length
    ? view.threads.map((t, i) => ({
      id: String(t.id || `t-${i}`),
      title: String(t.title || '').trim(),
      goal: String(t.goal || '').trim(),
      now: String(t.now || '').trim(),
      ids: Array.isArray(t.workstreams) ? t.workstreams.map(String) : [],
    }))
    : (Array.isArray(plan?.threads) ? plan.threads.map((t, i) => ({
      id: String(t.id || `t-${i}`),
      title: String(t.title || '').trim(),
      goal: String(t.goal || '').trim(),
      now: '',
      ids: Array.isArray(t.tasks) ? t.tasks.map(String) : [],
    })) : []);

  const usedWs = new Set();
  const threads = [];
  for (const rt of rawThreads) {
    if (!rt.title) continue;
    const list = rt.ids.map((id) => wsById.get(id)).filter(Boolean);
    list.forEach((w) => usedWs.add(w.id));
    if (!list.length) continue;
    const counts = { done: 0, running: 0, blocked: 0, queued: 0 };
    for (const w of list) counts[w.state] = (counts[w.state] || 0) + 1;
    const state = counts.blocked > 0 ? 'blocked'
      : (counts.running > 0 ? 'running' : (counts.done === list.length ? 'done' : 'queued'));
    const activeItem = list.find((w) => w.state === 'running' || w.state === 'blocked');
    threads.push({
      id: rt.id,
      title: rt.title,
      goal: rt.goal,
      now: rt.now || activeItem?.note || '',
      state,
      counts,
      total: list.length,
      items: list,
    });
  }
  const restWs = workstreams.filter((w) => !usedWs.has(w.id));
  if (restWs.length) {
    const counts = { done: 0, running: 0, blocked: 0, queued: 0 };
    for (const w of restWs) counts[w.state] = (counts[w.state] || 0) + 1;
    const state = counts.blocked > 0 ? 'blocked'
      : (counts.running > 0 ? 'running' : (counts.done === restWs.length ? 'done' : 'queued'));
    threads.push({
      id: '_rest',
      title: '',
      isFallbackGroup: true,
      hasOtherThreads: threads.length > 0,
      goal: '',
      now: '',
      state,
      counts,
      total: restWs.length,
      items: restWs,
    });
  }

  const totals = { done: 0, running: 0, blocked: 0, queued: 0, total: workstreams.length };
  const runningTasks = [];
  const doneTasks = [];
  const queuedTasks = [];
  for (const w of workstreams) {
    totals[w.state] = (totals[w.state] || 0) + 1;
    if (w.state === 'running' || w.state === 'blocked') runningTasks.push(w);
    else if (w.state === 'done') doneTasks.push(w);
    else queuedTasks.push(w);
  }
  runningTasks.sort((a, b) => (a.state === 'blocked' ? 0 : 1) - (b.state === 'blocked' ? 0 : 1));
  doneTasks.sort((a, b) => (b.seq || 0) - (a.seq || 0));

  const goal = plan?.goal?.title
    ? plan.goal
    : (view?.goal?.title
      ? { title: String(view.goal.title).slice(0, 120), line: String(view.goal.line || '').slice(0, 200) }
      : (view?.headline ? { title: snap.title || '', line: String(view.headline).slice(0, 200) } : null));

  const workerList = team.filter((m) => m.name !== leadName).map((m) => enriched.get(m.name));
  const activeMembers = workerList.filter((m) => !m.killed && (m.displayState === 'working' || m.displayState === 'waiting_on' || m.displayState === 'error' || m.displayState === 'stuck'));
  const waitingMembers = workerList.filter((m) => !m.killed && m.displayState === 'waiting');
  const killedMembers = workerList.filter((m) => m.killed);
  const observerMembers = observers.map((m) => enriched.get(m.name));

  // 帧时间线：补齐每帧对应时刻与当时完成数
  const frames = (Array.isArray(snap.frames) ? snap.frames : []).map((f) => {
    const post = messages.find((m) => m.seq >= (f.seq || 0));
    const doneAt = workstreams.filter((w) => w.state === 'done' && w.seq > 0 && w.seq <= (f.seq || 0)).length;
    return {
      ...f,
      ts: post?.ts || 0,
      doneAt,
      total: workstreams.length,
    };
  });

  return {
    title: snap.title || goal?.title || '',
    leadName,
    coordinator: coord ? enriched.get(coord.name) : null,
    finished,
    hasActive: Boolean(snap.hasActive),
    needsUser: Boolean(snap.needsUser),
    coordAsk: snap.coordAsk || '',
    stall: snap.stall || null,
    systemAttention: Array.isArray(snap.systemAttention) ? snap.systemAttention : [],
    goal,
    totals,
    workstreams,
    runningTasks,
    doneTasks,
    queuedTasks,
    threads,
    frames,
    memberByName: enriched,
    memberGroups: {
      coordinator: coord ? enriched.get(coord.name) : null,
      active: activeMembers,
      waiting: waitingMembers,
      observers: observerMembers,
      killed: killedMembers,
    },
    channels: Array.isArray(snap.channels) ? snap.channels : [],
    head: snap.head || 0,
    postsCount: teamMsgs.length,
    totalTokens: snap.summary?.totalTokens || 0,
    durationMs: snap.summary?.durationMs || 0,
    startedAt: snap.summary?.startedAt || 0,
  };
}

/**
 * 计算 @mention 协作关系图的节点位置、曲线边几何与回放高亮态（纯函数）。
 * 节点 ≤12 个时按椭圆排布（协调者居顶，成员间连线成清晰弦线）；更大规模按分层网格换行。
 */
export function computeSwarmGraph(snap, {
  upto = null,
  expandAll = false,
  hideInactive = false,
  width = 420,
} = {}) {
  const w = Math.max(280, Math.round(Number(width) || 420));
  const roster = Array.isArray(snap?.members) ? snap.members : [];
  const byName = new Map(roster.map((m) => [m.name, m]));
  const allMsgs = (Array.isArray(snap?.messages) ? snap.messages : [])
    .filter((m) => m && !m.control && !isSwarmRoleWorker(byName.get(m.agent)));

  const replaying = upto !== null && upto !== undefined;
  const cursor = replaying ? Math.max(0, Math.min(Number(upto) || 0, allMsgs.length)) : allMsgs.length;
  const memberNames = new Set(roster.map((m) => m.name));
  const outsiders = [...new Set(allMsgs.map((m) => m.agent))]
    .filter((n) => n && !memberNames.has(n) && !ROLE_WORKER_RE.test(n));

  const allNodes = [
    ...roster.filter((m) => !isSwarmRoleWorker(m)).map((m) => ({
      id: m.name,
      row: m.role === 'coordinator' ? 0 : 1,
      member: m,
    })),
    ...outsiders.map((n) => ({ id: n, row: 2, member: null })),
  ];

  const active = new Set();
  const coord = roster.find((m) => m.role === 'coordinator');
  if (coord) active.add(coord.name);

  const edgesMap = new Map();
  const unaddressed = new Map();
  const broadcasts = new Map();

  const targetsOf = (m) => {
    const direct = new Set([...(m.mentions || []), ...(m.viaChannel || [])]
      .filter((n) => n !== m.agent && !isSwarmRoleWorker(byName.get(n))));
    const viaAll = new Set();
    if (m.all && expandAll) {
      for (const mem of roster) {
        if (mem.name !== m.agent && !direct.has(mem.name) && !isSwarmRoleWorker(mem)) {
          viaAll.add(mem.name);
        }
      }
    }
    return { direct, viaAll };
  };

  for (let i = 0; i < cursor; i++) {
    const m = allMsgs[i];
    active.add(m.agent);
    const { direct, viaAll } = targetsOf(m);
    if (m.all) broadcasts.set(m.agent, (broadcasts.get(m.agent) || 0) + 1);
    if (!direct.size && !viaAll.size && !m.all && !(m.mentions || []).some((n) => n !== m.agent)) {
      unaddressed.set(m.agent, (unaddressed.get(m.agent) || 0) + 1);
    }
    for (const t of direct) {
      active.add(t);
      const k = `${m.agent}>${t}`;
      const e = edgesMap.get(k) || { from: m.agent, to: t, direct: 0, viaAll: 0 };
      e.direct++;
      edgesMap.set(k, e);
    }
    for (const t of viaAll) {
      if (!hideInactive) active.add(t);
      const k = `${m.agent}>${t}`;
      const e = edgesMap.get(k) || { from: m.agent, to: t, direct: 0, viaAll: 0 };
      e.viaAll++;
      edgesMap.set(k, e);
    }
  }

  const current = replaying && cursor > 0 ? allMsgs[cursor - 1] : null;
  const curTargets = current ? new Set([...targetsOf(current).direct, ...targetsOf(current).viaAll]) : new Set();
  const currentDirect = current ? new Set([current.agent, ...targetsOf(current).direct]) : new Set();

  const nodes = hideInactive
    ? allNodes.filter((n) => currentDirect.has(n.id) || (active.has(n.id) && !n.member?.killed))
    : allNodes;

  // 布局
  const nodeH = 28;
  const pillW = (id, maxW) => {
    const full = Math.max(70, 34 + Math.ceil(String(id).length * 7));
    return id === coord?.name ? Math.min(Math.max(maxW, 118), full) : Math.min(maxW, full);
  };
  const pos = new Map();
  let height = 220;

  if (nodes.length <= 12) {
    const n = nodes.length;
    const maxPill = Math.min(132, Math.max(88, w / Math.max(3, Math.ceil(n / 2) + 1) - 10));
    const rx = Math.max(54, w / 2 - maxPill / 2 - 14);
    const ry = n <= 2 ? 54 : Math.min(148, Math.max(84, n * 18));
    const cx = w / 2;
    const cy = ry + nodeH / 2 + 20;
    nodes.forEach((node, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n);
      pos.set(node.id, {
        x: cx + rx * Math.cos(a),
        y: cy + ry * Math.sin(a),
        w: pillW(node.id, maxPill),
        h: nodeH,
      });
    });
    height = Math.round(cy + ry + nodeH / 2 + 22);
  } else {
    const rows = new Map();
    for (const n of nodes) {
      if (!rows.has(n.row)) rows.set(n.row, []);
      rows.get(n.row).push(n);
    }
    const minW = 96;
    const perLine = Math.max(1, Math.floor(w / (minW + 12)));
    let y = 30;
    for (const [, list] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      for (let i = 0; i < list.length; i += perLine) {
        const line = list.slice(i, i + perLine);
        const gap = w / (line.length + 1);
        const pw = Math.min(136, Math.max(minW, gap - 10));
        line.forEach((n, j) => {
          pos.set(n.id, {
            x: gap * (j + 1),
            y: y + (line.length > 3 && j % 2 ? 12 : 0),
            w: pillW(n.id, Math.min(pw, gap - 6)),
            h: nodeH,
          });
        });
        y += 58;
      }
      y += 28;
    }
    height = Math.max(160, Math.round(y - 14));
  }

  let maxCount = 1;
  for (const e of edgesMap.values()) {
    if (pos.has(e.from) && pos.has(e.to)) {
      maxCount = Math.max(maxCount, e.direct + e.viaAll);
    }
  }

  const trimPoint = (p, q) => {
    const tx = q.x - p.x;
    const ty = q.y - p.y;
    const l = Math.hypot(tx, ty) || 1;
    const ux = tx / l;
    const uy = ty / l;
    const toBorder = Math.min(ux ? p.w / 2 / Math.abs(ux) : Infinity, uy ? p.h / 2 / Math.abs(uy) : Infinity);
    const dist = Math.min(0.45 * l, toBorder + 4);
    return { x: p.x + ux * dist, y: p.y + uy * dist };
  };

  const edges = [];
  for (const e of edgesMap.values()) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (a.x + b.x) / 2 + (-dy / len) * 20;
    const my = (a.y + b.y) / 2 + (dx / len) * 20;
    const start = trimPoint(a, { x: mx, y: my });
    const end = trimPoint(b, { x: mx, y: my });
    const total = e.direct + e.viaAll;
    const isCur = Boolean(current && current.agent === e.from && curTargets.has(e.to));
    edges.push({
      key: `${e.from}>${e.to}`,
      from: e.from,
      to: e.to,
      direct: e.direct,
      viaAll: e.viaAll,
      total,
      width: Number((1.1 + (2.6 * total) / maxCount).toFixed(2)),
      d: `M${start.x.toFixed(1)},${start.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`,
      mx: Number(mx.toFixed(1)),
      my: Number(my.toFixed(1)),
      end,
      isCur,
      viaAllOnly: e.direct === 0,
    });
  }

  const placedNodes = nodes.map((n) => {
    const p = pos.get(n.id);
    const status = n.member?.killed ? 'killed' : (n.member?.failure ? 'error' : (n.member?.status || ''));
    const maxChars = Math.max(4, Math.floor((p.w - 28) / 7));
    const label = n.id.length > maxChars ? `${n.id.slice(0, maxChars - 1)}…` : n.id;
    return {
      id: n.id,
      label,
      conversationId: n.member?.conversationId || '',
      role: n.member?.role || '',
      status,
      x: Number(p.x.toFixed(1)),
      y: Number(p.y.toFixed(1)),
      w: Number(p.w.toFixed(1)),
      h: p.h,
      inactive: replaying && !active.has(n.id),
      hot: Boolean(current && (n.id === current.agent || curTargets.has(n.id))),
      killed: status === 'killed',
      outsider: !n.member,
      unaddressed: unaddressed.get(n.id) || 0,
      broadcasts: expandAll ? 0 : (broadcasts.get(n.id) || 0),
    };
  });

  return {
    width: w,
    height,
    totalPosts: allMsgs.length,
    upto: cursor,
    replaying,
    current,
    nodes: placedNodes,
    edges,
    allMessages: allMsgs,
  };
}
