// QQ 机器人（OneBot 11）：群友 @ 机器人或用前缀提问 → 以授权账号跑 Claude → 回答发回群里。
//
// 这个插件只管两件事：OneBot 协议适配（收上报、调发消息接口）和群聊规则（触发、冷却、白名单、按群设置）。
// 其余都交给 bridge 的插件运行环境：
//   ctx.webhook   收协议端的 HTTP 上报（只收本机直连 / 带密钥）
//   ctx.chat      以授权账号跑无人值守的 Claude：同一个群串行、记住会话续写、不出审批卡
//   ctx.files     群里的图片存进账号工作区当附件       ctx.share   Claude 产出的文件做成公开只读链接
//   ctx.process   「由 bridge 拉起」时托管协议端进程（停用时整棵收掉、崩了自动重启）
//   ctx.status / ctx.action / ctx.configOptions   设置页的状态块、按钮、群号下拉
//   ui.panel + web/index.html                     QQ 控制台（聊天记录、手动发消息、重开对话）

import path from 'node:path';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

const PLAIN_GUIDE = '你的回复会原样发进 QQ 群，QQ 不渲染 Markdown：发进群的话用纯文本（不要 #、**、`、代码块、表格、列表符号），分点用 1. 2. 3.。写进文件的内容照常用 Markdown / 代码，不受此限制。';
const CHAT_GUIDE = '你在 QQ 里回答群友（或好友私聊）的问题。每条用户消息开头的【…】标着是谁在说话；多人共用这段对话，答的时候针对当前提问的人。回答简洁、口语化，适合在聊天软件里读。';

export function apply(ctx, cfg) {
  const id = ctx.id;
  const logDir = path.join(ctx.dataDir, 'logs');
  let selfId = '';
  let online = false;
  let lastErr = '';
  let groupCache = [];            // [{ group_id, group_name, member_count }]
  const lastAsk = new Map();      // 冷却：'cid:qq' → 时间
  const stats = ctx.store.get('stats', { day: '', replies: 0 });

  // ── OneBot 调用 ──
  async function onebot(action, params = {}) {
    const res = await fetch(cfg.apiUrl.replace(/\/+$/, '') + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.apiToken ? { Authorization: 'Bearer ' + cfg.apiToken } : {}) },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || (j.status && j.status !== 'ok')) throw new Error((j && (j.message || j.wording)) || 'HTTP ' + res.status);
    return j.data;
  }
  async function probe() {
    try {
      const me = await onebot('get_login_info');
      selfId = String(me.user_id || '');
      online = true; lastErr = '';
    } catch (e) { online = false; lastErr = String(e?.message || e); }
    ctx.status.refresh();
  }
  async function refreshGroups() {
    groupCache = (await onebot('get_group_list').catch(() => null)) || groupCache;
    return groupCache;
  }
  const groupName = (gid) => groupCache.find((g) => String(g.group_id) === String(gid))?.group_name || '';

  // ── 聊天记录（插件自己的数据目录，一聊一个 jsonl）──
  const logFile = (cid) => path.join(logDir, cid.replace(/[^\w-]/g, '_') + '.jsonl');
  function logLine(cid, rec) {
    try { mkdirSync(logDir, { recursive: true }); appendFileSync(logFile(cid), JSON.stringify({ t: Date.now(), ...rec }) + '\n'); } catch {}
    const chats = ctx.store.get('chats', {});
    chats[cid] = { name: rec.chat || chats[cid]?.name || cid, last: Date.now(), count: (chats[cid]?.count || 0) + 1 };
    ctx.store.set('chats', chats);
    ctx.bus.toPage('message', { cid });
  }
  function readLog(cid, n = 200) {
    try { return readFileSync(logFile(cid), 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l)); } catch { return []; }
  }

  // ── 发消息 ──
  function chunks(text) {
    const out = [];
    let s = String(text || '').trim() || '（没有内容）';
    while (s.length > cfg.maxSeg) { let cut = s.lastIndexOf('\n', cfg.maxSeg); if (cut < cfg.maxSeg / 2) cut = cfg.maxSeg; out.push(s.slice(0, cut)); s = s.slice(cut).trim(); }
    out.push(s);
    return out;
  }
  async function send(cid, text, { replyTo, atQQ } = {}) {
    const isPrivate = cid.startsWith('p');
    const target = cid.replace(/^[gp]/, '');
    const parts = chunks(text);
    for (let i = 0; i < parts.length; i++) {
      const message = [];
      if (i === 0 && replyTo) message.push({ type: 'reply', data: { id: String(replyTo) } });
      if (i === 0 && atQQ && !isPrivate) message.push({ type: 'at', data: { qq: String(atQQ) } }, { type: 'text', data: { text: ' ' } });
      message.push({ type: 'text', data: { text: parts[i] } });
      if (isPrivate) await onebot('send_private_msg', { user_id: Number(target), message });
      else await onebot('send_group_msg', { group_id: Number(target), message });
    }
  }

  // ── 收上报 ──
  function textOf(segs) {
    return (Array.isArray(segs) ? segs : []).filter((s) => s.type === 'text').map((s) => s.data?.text || '').join('').trim();
  }
  const atMe = (segs) => (Array.isArray(segs) ? segs : []).some((s) => s.type === 'at' && String(s.data?.qq) === selfId);
  const images = (segs) => (Array.isArray(segs) ? segs : []).filter((s) => s.type === 'image' && s.data?.url).map((s) => s.data.url).slice(0, 4);

  async function onEvent(req, res, x) {
    const e = x.json();
    ctx.http.json(res, 200, {});   // 先回协议端，别让它等 Claude
    if (!e || e.post_type !== 'message' || !cfg.runAs) return;
    if (e.self_id) selfId = String(e.self_id);
    const isGroup = e.message_type === 'group';
    if (!isGroup && e.message_type !== 'private') return;
    const cid = (isGroup ? 'g' : 'p') + String(isGroup ? e.group_id : e.user_id);
    const segs = e.message;
    let text = textOf(segs);
    const nick = e.sender?.card || e.sender?.nickname || String(e.user_id);
    const chatName = isGroup ? (groupName(e.group_id) || '群 ' + e.group_id) : '私聊 · ' + nick;

    // 触发
    let hit = false;
    if (isGroup) {
      if (cfg.allowGroups.length && !cfg.allowGroups.includes(String(e.group_id))) return;
      if (cfg.groups[String(e.group_id)]?.enabled === false) return;
      if (cfg.replyAt && atMe(segs)) hit = true;
      if (cfg.prefix && text.startsWith(cfg.prefix)) { hit = true; text = text.slice(cfg.prefix.length).trim(); }
    } else {
      if (!cfg.privateReply) return;
      hit = true;
      if (cfg.prefix && text.startsWith(cfg.prefix)) text = text.slice(cfg.prefix.length).trim();
    }
    if (!hit) return;
    const imgs = images(segs);
    if (!text && !imgs.length) return;
    const ck = cid + ':' + e.user_id;
    if (Date.now() - (lastAsk.get(ck) || 0) < cfg.cooldownSec * 1000) return;
    lastAsk.set(ck, Date.now());
    logLine(cid, { chat: chatName, who: nick, qq: String(e.user_id), text: text || '（图片）' });
    answer({ cid, chatName, nick, qq: e.user_id, text, imgs, msgId: e.message_id, isGroup, gid: String(e.group_id || '') })
      .catch((err) => ctx.warn('回答失败：', err?.message || err));
  }

  async function answer(q) {
    // 图片：下载后存进账号工作区，交给 Claude 当附件（它直接看得见）
    const attachments = [];
    for (const [i, url] of q.imgs.entries()) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (r.ok) attachments.push(ctx.files.put(cfg.runAs, Buffer.from(await r.arrayBuffer()), `qq-${q.msgId}-${i}.jpg`));
      } catch {}
    }
    const effort = (q.isGroup && cfg.groups[q.gid]?.effort) || cfg.effort || undefined;
    const turn = ctx.chat.run({
      as: cfg.runAs,
      session: 'qq:' + q.cid,
      message: `【${q.nick}（QQ ${q.qq}）】${q.text || '（看图）'}`,
      attachments,
      model: cfg.model || undefined,
      effort,
      prompt: CHAT_GUIDE + (cfg.plainReply ? '\n' + PLAIN_GUIDE : ''),
      label: 'QQ · ' + q.chatName,
    });
    ctx.status.refresh();
    const out = await turn.result;
    let text = out.isError ? '出错了：' + String(out.text || '').slice(0, 300) : out.text;
    if (!out.isError && cfg.fileLink && out.files?.length) {
      try {
        const sh = await ctx.share.space(cfg.runAs, out.files.map((f) => f.path));
        text += '\n\n文件：' + (sh.url || sh.path);
      } catch (e) { ctx.warn('文件链接没做成：', e?.message || e); }
    }
    await send(q.cid, text, { replyTo: q.msgId, atQQ: q.isGroup ? q.qq : null });
    logLine(q.cid, { chat: q.chatName, who: 'Claude', bot: true, text });
    const today = new Date().toISOString().slice(0, 10);
    if (stats.day !== today) { stats.day = today; stats.replies = 0; }
    stats.replies++;
    ctx.store.set('stats', stats);
    ctx.status.refresh();
  }

  // ── 接到 bridge 上 ──
  ctx.webhook('onebot', onEvent, {
    verify: cfg.hookToken ? { secret: cfg.hookToken } : { loopbackOnly: true },
    maxBytes: 2_000_000,
    perMinute: 1200,
  });

  if (cfg.mode === 'managed') {
    if (!cfg.napcatDir || !existsSync(path.join(cfg.napcatDir, cfg.napcatScript))) {
      lastErr = '找不到协议端启动脚本：' + path.join(cfg.napcatDir || '（没填目录）', cfg.napcatScript);
    } else {
      ctx.process.spawn('napcat', { command: path.join(cfg.napcatDir, cfg.napcatScript), cwd: cfg.napcatDir, restart: 'on-failure' });
    }
  }

  ctx.status(() => {
    const items = [
      { label: 'QQ 号', value: selfId || '—' },
      { label: '今天回复', value: String(stats.day === new Date().toISOString().slice(0, 10) ? stats.replies : 0) },
      { label: '在答 / 排队', value: String(ctx.chat.running) },
    ];
    if (!cfg.runAs) return { tone: 'warn', text: '还没选「以哪个账号回答」', items };
    if (!online) return { tone: 'warn', text: '协议端连不上' + (lastErr ? '：' + lastErr : ''), items };
    return { tone: 'ok', text: 'QQ 在线', items };
  });

  ctx.action({ id: 'probe', label: '检查连接', handler: async () => { await probe(); await refreshGroups(); return online ? `在线，${groupCache.length} 个群` : '连不上：' + lastErr; } });

  const groupOptions = async () => (await refreshGroups()).map((g) => ({ value: String(g.group_id), label: g.group_name || String(g.group_id), desc: g.member_count ? g.member_count + ' 人' : '' }));
  ctx.configOptions('allowGroups', groupOptions);
  ctx.configOptions('groups', groupOptions);

  // 面板（web/index.html）用的接口：只有服务器主机能看
  ctx.route('GET', '/api/plugin/' + id + '/chats', (req, res) => {
    if (!ctx.http.admin(req, res)) return;
    const chats = Object.entries(ctx.store.get('chats', {})).map(([cid, c]) => ({ cid, ...c })).sort((a, b) => b.last - a.last);
    ctx.http.json(res, 200, { chats, online, selfId });
  });
  ctx.route('GET', '/api/plugin/' + id + '/log', (req, res, url) => {
    if (!ctx.http.admin(req, res)) return;
    ctx.http.json(res, 200, { messages: readLog(String(url.searchParams.get('cid') || '')) });
  });
  ctx.route('POST', '/api/plugin/' + id + '/send', async (req, res) => {
    if (!ctx.http.admin(req, res)) return;
    try {
      const b = await ctx.http.body(req);
      const cid = String(b.cid || '');
      if (!/^[gp]\d+$/.test(cid) || !String(b.text || '').trim()) { ctx.http.json(res, 400, { error: '要 cid 和 text' }); return; }
      await send(cid, String(b.text));
      logLine(cid, { who: '你（手动）', bot: true, text: String(b.text) });
      ctx.http.json(res, 200, { ok: true });
    } catch (e) { ctx.http.json(res, 502, { error: '没发出去：' + (e?.message || e) }); }
  });
  ctx.route('POST', '/api/plugin/' + id + '/reset', async (req, res) => {
    if (!ctx.http.admin(req, res)) return;
    const b = await ctx.http.body(req).catch(() => ({}));
    const had = cfg.runAs ? ctx.chat.reset(cfg.runAs, 'qq:' + String(b.cid || '')) : false;
    ctx.http.json(res, 200, { ok: true, had });
  });

  probe().then(refreshGroups).catch(() => {});
  ctx.setInterval(probe, 60_000);
}
