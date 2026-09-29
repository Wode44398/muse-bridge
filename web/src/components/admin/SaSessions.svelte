<script>
  // 会话 / 续聊：左=用户，中=该用户会话，右=消息预览 + 代发续聊（SSE 直播）。
  // admin 自己走 /api/sessions + /api/chat；其他用户走 /api/admin/user/*（身份注入见后端）。
  import { api } from '../../lib/api.js';
  import { authHeaders } from '../../lib/api.js';
  import { apiUrl } from '../../lib/server.js';
  import { sa, fmtAgo, saToast, pumpSSE } from '../../lib/serverAdmin.svelte.js';
  import { t, tc, tr } from '../../lib/i18n.js';

  let user = $state('admin');
  let sessions = $state([]);
  let cur = $state(null);          // 当前会话 id
  let msgs = $state([]);           // [{role:'user'|'asst', text}]
  let loadingList = $state(true);
  let loadingThread = $state(false);
  let input = $state('');
  let busy = $state(false);
  let question = $state(null);     // AskUserQuestion: { qid, questions, picks:[] }
  let threadEl = $state(null);
  let ctrl = null;

  const userList = $derived([{ name: 'admin' }, ...sa.users]);

  $effect(() => { sa.tick; user; loadSessions(); });

  async function loadSessions() {
    loadingList = true;
    try {
      const d = user === 'admin'
        ? await api.get('/api/sessions')
        : await api.get('/api/admin/user/sessions?name=' + encodeURIComponent(user));
      sessions = d?.sessions || [];
    } catch { sessions = []; }
    loadingList = false;
  }
  function pickUser(name) {
    if (name === user) return;
    user = name; cur = null; msgs = []; question = null;
    try { ctrl?.abort(); } catch {}
  }
  async function openSession(id) {
    cur = id; loadingThread = true; question = null;
    try {
      const d = user === 'admin'
        ? await api.get('/api/session?id=' + encodeURIComponent(id))
        : await api.get('/api/admin/user/session?name=' + encodeURIComponent(user) + '&id=' + encodeURIComponent(id));
      msgs = (d?.messages || []).map((m) => ({ role: m.role === 'user' ? 'user' : 'asst', text: m.text || '' }));
    } catch (e) { msgs = []; saToast(t('读取会话失败：{reason}', { reason: tr(e?.message || e) }), true); }
    loadingThread = false;
    scrollBottom();
  }
  // /api/admin/user/sessions 给没标题的会话填了占位「(无标题)」：认出占位再按界面语言显示（用户自己的标题原样）
  const titleOf = (s) => (!s.title || s.title === '(无标题)' ? t('(无标题)') : s.title); // i18n-ignore 与服务端占位比对
  function scrollBottom() { requestAnimationFrame(() => { if (threadEl) threadEl.scrollTop = threadEl.scrollHeight; }); }

  function send() {
    const text = input.trim();
    if (!text || busy) return;
    input = '';
    msgs.push({ role: 'user', text });
    msgs.push({ role: 'asst', text: '' });
    const asst = msgs[msgs.length - 1];   // Svelte5 深代理：改 push 后的代理元素 UI 才更新
    scrollBottom();
    busy = true;
    const body = { message: text, sessionId: cur || undefined };
    let url = '/api/chat';
    if (user !== 'admin') { url = '/api/admin/user/chat'; body.name = user; }
    ctrl = new AbortController();
    fetch(apiUrl(url), {
      method: 'POST', credentials: 'same-origin', signal: ctrl.signal,
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    })
      .then((r) => pumpSSE(r, (ev) => {
        if (ev.type === 'session' && ev.sessionId) cur = ev.sessionId;
        else if (ev.type === 'text') { asst.text += ev.text || ''; scrollBottom(); }
        else if (ev.type === 'question') { question = { qid: ev.qid, questions: ev.questions || [], picks: (ev.questions || []).map(() => null) }; }
        else if (ev.type === 'error') { asst.text += '\n' + t('[错误] {message}', { message: tr(ev.message || '') }); scrollBottom(); }
        else if (ev.type === 'done') { if (!asst.text && ev.result) { asst.text = ev.result; scrollBottom(); } }
      }))
      .catch((e) => { if (!ctrl.signal.aborted) { asst.text += '\n' + t('[连接中断] {reason}', { reason: tr(e?.message || e) }); } })
      .finally(() => { busy = false; loadSessions(); });
  }
  function stop() { try { ctrl?.abort(); } catch {} busy = false; }

  async function answer(cancelled) {
    const q = question; if (!q) return;
    const answers = cancelled ? [] : q.questions.map((_, i) => ({ selected: q.picks[i] != null ? [q.picks[i]] : [] }));
    question = null;
    const url = user === 'admin' ? '/api/answer' : '/api/admin/user/answer';
    const body = { qid: q.qid, cancelled, answers };
    if (user !== 'admin') body.name = user;
    try { await api.post(url, body); } catch (e) { saToast(t('回传失败：{reason}', { reason: tr(e?.message || e) }), true); }
  }
</script>

<div class="wrap">
  <!-- 用户列 -->
  <div class="sa-card col ucol">
    <div class="colh">{tc('admin', '用户')}</div>
    <div class="list">
      {#each userList as u (u.name)}
        <button class="li" class:on={u.name === user} onclick={() => pickUser(u.name)}>
          <span class="sa-trunc">{u.name === 'admin' ? t('admin（我）') : u.name}</span>
          {#if u.name === 'admin'}<span class="sa-badge blue">admin</span>{/if}
        </button>
      {/each}
    </div>
  </div>

  <!-- 会话列 -->
  <div class="sa-card col scol">
    <div class="colh">{tc('admin', '会话')} <span class="sa-dim">{loadingList ? '…' : sessions.length}</span></div>
    <div class="list">
      {#if loadingList}
        <div class="sa-empty">{t('加载中…')}</div>
      {:else if !sessions.length}
        <div class="sa-empty">{t('无会话')}</div>
      {:else}
        {#each sessions as s (s.id)}
          <button class="li" class:on={s.id === cur} onclick={() => openSession(s.id)}>
            <span class="lt sa-trunc">{titleOf(s)}</span>
            <span class="lm sa-mono">{(s.id || '').slice(0, 8)} · {fmtAgo(s.mtime)}</span>
          </button>
        {/each}
      {/if}
    </div>
  </div>

  <!-- 消息 + 续聊 -->
  <div class="sa-card col tcol">
    <div class="colh">
      {#if cur}{user === 'admin' ? 'admin' : user} · <span class="sa-mono sa-dim">{cur.slice(0, 8)}</span>{:else}{t('选择会话后可预览、续聊')}{/if}
    </div>
    <div class="thread" bind:this={threadEl}>
      {#if loadingThread}
        <div class="sa-empty">{t('加载中…')}</div>
      {:else if !msgs.length}
        <div class="sa-empty">{t('左侧选一个会话开始（也可不选，直接发消息开新会话）')}</div>
      {:else}
        {#each msgs as m, i (i)}
          <div class="msg" class:mine={m.role === 'user'}>
            <div class="who">{m.role === 'user' ? t('用户') : 'Claude'}</div>
            <div class="bubble">{m.text}{#if busy && i === msgs.length - 1 && m.role === 'asst' && !m.text}<span class="typing">{t('思考中…')}</span>{/if}</div>
          </div>
        {/each}
      {/if}
    </div>
    <div class="foot">
      <textarea rows="1" placeholder={user === 'admin' ? t('代 自己 发消息续聊…（Enter 发送）') : t('代 {user} 发消息续聊…（Enter 发送）', { user })} bind:value={input}
        onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}></textarea>
      {#if busy}
        <button class="sa-btn dgr" onclick={stop}>{t('停止')}</button>
      {:else}
        <button class="sa-btn pri" onclick={send} disabled={!input.trim()}>{t('发送')}</button>
      {/if}
    </div>
  </div>
</div>

<!-- AskUserQuestion：代答弹窗 -->
{#if question}
  <button class="sa-mask" aria-label={t('跳过')} onclick={() => answer(true)}></button>
  <div class="sa-modal">
    <h3>{t('Claude 提了个问题')}</h3>
    {#each question.questions as q, qi (qi)}
      {#if qi > 0}<div class="qsep"></div>{/if}
      <p style="color:#fff;font-weight:600">{tr(q.question) || ''}</p>
      {#each q.options || [] as o (o.label)}
        <label class="qopt">
          <input type="radio" name="saq{qi}" value={o.label}
            checked={question.picks[qi] === o.label}
            onchange={() => { question.picks[qi] = o.label; }} />
          <span>{tr(o.label)}{#if o.description}<small> — {tr(o.description)}</small>{/if}</span>
        </label>
      {/each}
    {/each}
    <div class="acts">
      <button class="sa-btn" onclick={() => answer(true)}>{t('跳过')}</button>
      <button class="sa-btn pri" onclick={() => answer(false)}>{t('提交')}</button>
    </div>
  </div>
{/if}

<style>
  .wrap { display: grid; grid-template-columns: 190px 260px 1fr; gap: 12px; height: 100%; min-height: 420px; }
  .col { display: flex; flex-direction: column; overflow: hidden; }
  .colh { flex: none; font-size: 12.5px; font-weight: 650; color: var(--sa-tx2); padding: 13px 16px 10px; border-bottom: .5px solid rgba(255,255,255,.09); }
  .list { flex: 1; overflow-y: auto; padding: 6px; }
  .li { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; padding: 9px 11px; border-radius: 12px;
    border: 0; background: none; color: #fff; font: inherit; font-size: 13.5px; cursor: pointer; text-align: left; transition: background .13s ease; }
  .li:hover { background: rgba(255,255,255,.08); }
  .li.on { background: rgba(10,132,255,.22); box-shadow: inset 0 0 0 .5px rgba(10,132,255,.5); }
  .ucol .li { flex-direction: row; align-items: center; gap: 8px; }
  .lt { width: 100%; }
  .lm { font-size: 10.5px; color: var(--sa-tx3); }

  .thread { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
  .msg { max-width: 92%; }
  .msg.mine { align-self: flex-end; }
  .who { font-size: 10.5px; font-weight: 650; letter-spacing: .4px; color: var(--sa-tx3); margin-bottom: 4px; }
  .msg.mine .who { text-align: right; }
  .bubble { white-space: pre-wrap; word-break: break-word; font-size: 13.5px; line-height: 1.55; color: rgba(255,255,255,.88); }
  .msg.mine .bubble { background: rgba(255,255,255,.1); box-shadow: inset 0 0 0 .5px rgba(255,255,255,.12); border-radius: 14px; padding: 9px 13px; }
  .typing { color: var(--sa-tx3); animation: blink 1.2s ease-in-out infinite; }
  @keyframes blink { 0%, 100% { opacity: .4; } 50% { opacity: 1; } }

  .foot { flex: none; display: flex; gap: 8px; padding: 10px; border-top: .5px solid rgba(255,255,255,.09); }
  .foot textarea { flex: 1; resize: none; background: rgba(255,255,255,.07); box-shadow: inset 0 0 0 .5px rgba(255,255,255,.14);
    border: 0; outline: none; border-radius: 12px; padding: 10px 13px; color: #fff; font: inherit; font-size: 13.5px; max-height: 120px; }
  .foot textarea:focus { box-shadow: inset 0 0 0 1px rgba(10,132,255,.65); }

  .qsep { height: .5px; background: rgba(255,255,255,.12); margin: 6px 0; }
  .qopt { display: flex; align-items: flex-start; gap: 9px; padding: 6px 2px; font-size: 13.5px; color: #e8e8e8; cursor: pointer; }
  .qopt input { margin-top: 2px; accent-color: var(--sa-blue); }
  .qopt small { color: #9a9a9a; }

  @media (max-width: 1080px) {
    .wrap { grid-template-columns: 1fr; grid-template-rows: auto auto 1fr; min-height: 0; }
    .ucol .list { display: flex; flex-wrap: wrap; gap: 4px; }
    .ucol .li { width: auto; }
    .scol { max-height: 200px; }
    .tcol { min-height: 320px; }
  }
</style>
