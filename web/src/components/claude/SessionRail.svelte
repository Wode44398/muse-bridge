<script>
  // 会话信息面板（官方 Desktop 2.37337 的 Session rail，cf74bc599 rD / c73f45bc3 Df 卡片外壳逆向）。
  // 一列圆角卡片：环境 / 上下文 / 连接器 / 输出内容 / 更改。标题旁的箭头是折叠（›=收起、⌄=展开），
  // 收起时标题右侧露摘要；Alt+点标题 = 全部一起展开/收起（官方同款）。
  // 宽的时候停靠在聊天区右侧（280px 悬浮，不挤正文）；不够宽就是工具条下面的弹层，点外面 / Esc 收起。
  // 数据：环境 = 项目 + 工作台 meta（分支 / worktree）；上下文 = 用量圆环同一份；连接器 = 每轮 init 帧的
  // MCP 状态；输出内容 = 服务端按 transcript 推算（/api/claude/session-rail）；更改 = 审阅面板那份 git diff。
  // 官方还有一行 Remote Control 开关——它要全权限登录，bridge 的推理令牌开不了，不摆。
  import { session, status, ui } from '../../lib/state.svelte.js';
  import { dock, toggleDockView, openDockFiles, ensureDockMeta } from '../../lib/dock.svelte.js';
  import { chat, send, queueSend, mcpState, openSession } from '../../lib/chat.svelte.js';
  import { REL_LABEL } from '../../lib/sessionFamily.svelte.js';
  import SuggestedTasksCard from './SuggestedTasksCard.svelte';   // 「建议的任务」：Claude 提议了还没开的会话卡
  import PrCard from './PrCard.svelte';   // 「拉取请求」卡（PR/CI 闭环，自带数据与样式）
  import { rail, toggleRail, railVisible, isFolded, toggleFold } from '../../lib/sessionRail.svelte.js';
  import { ctxSummary, fmtCompact } from '../../lib/ctxUsage.js';
  import { openPreview } from '../../lib/preview.svelte.js';
  import { api } from '../../lib/api.js';
  import { IS_CSNAP } from '../../lib/csnap.js';
  import { t } from '../../lib/i18n.js';

  // name：项目名（芯片同款）；path：工作目录绝对路径
  let { name = '', path = '' } = $props();

  // 宽窄自己量：挂载点（聊天区）够宽就停靠在右侧、正文与输入栏让出 300px（官方同款，见下方 rail-docked），
  // 不够宽就是弹层。门槛 = 正文最小舒适宽度 760 + 面板 300。
  let probe = $state(null);
  $effect(() => {
    const host = probe && probe.parentElement;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { rail.narrow = host.clientWidth < 1060; });
    ro.observe(host);
    rail.narrow = host.clientWidth < 1060;
    return () => ro.disconnect();
  });
  // 停靠时给挂载点打标，正文滚动区与输入栏据此让出右侧（样式在本文件 :global 规则里）
  $effect(() => {
    const host = probe && probe.parentElement;
    if (!host) return;
    const on = docked && visible && !!sid;
    host.classList.toggle('rail-docked', on);
    return () => host.classList.remove('rail-docked');
  });
  const docked = $derived(!rail.narrow);
  const visible = $derived(railVisible());

  const sid = $derived(session.id || '');

  // —— 服务端数据：输出内容 + 连接器兜底；会话切换 / 一轮收尾时重拉 ——
  let railData = $state({ outputs: [], mcp: null, family: null, for: '' });
  let review = $state({ git: false, add: 0, del: 0, for: '' });
  async function loadRail(id) {
    if (!id || IS_CSNAP) { railData = { outputs: [], mcp: null, family: null, for: '' }; return; }
    try {
      const r = await api.get(`/api/claude/session-rail?id=${encodeURIComponent(id)}`);
      if (session.id === id) railData = { outputs: Array.isArray(r?.outputs) ? r.outputs : [], mcp: r?.mcp || null, family: r?.family || null, for: id };
    } catch { if (session.id === id) railData = { outputs: [], mcp: null, family: null, for: id }; }
  }
  async function loadReview(ws) {
    if (!ws) { review = { git: false, add: 0, del: 0, for: '' }; return; }
    try {
      const d = await api.get(`/api/claude/review?ws=${encodeURIComponent(ws)}`);
      if (dock.ws === ws) review = { git: !!d?.git, add: d?.total?.add || 0, del: d?.total?.del || 0, for: ws };
    } catch { if (dock.ws === ws) review = { git: false, add: 0, del: 0, for: ws }; }
  }
  let wasBusy = false;
  // 一轮收尾后的「更改」重拉去抖 3 秒：几秒内接连收尾的几轮（排队的消息、子会话陆续收工）只跑最后一次
  // git diff；到点时面板已经收起就记一笔，等面板再打开时补拉（FR2 ③）。
  // 「更改」卡折叠时标题右侧仍露 +N −M 摘要，所以折叠不算不拉的理由。
  let reviewT = 0, reviewStale = false;
  $effect(() => {
    const id = sid, ws = dock.ws, busy = session.busy;
    if (!visible) return;
    // 打开时、换会话时、一轮刚收尾时各拉一次（跑的过程中不追着拉，免得 git diff 被反复执行）
    const settled = wasBusy && !busy;
    wasBusy = busy;
    if (railData.for !== id || settled) loadRail(id);
    if (review.for !== ws || reviewStale) { clearTimeout(reviewT); reviewT = 0; reviewStale = false; loadReview(ws); }
    else if (settled) {
      clearTimeout(reviewT);
      reviewT = setTimeout(() => {
        reviewT = 0;
        if (dock.ws !== ws) return;          // 换了工作区：上面 review.for !== ws 那条自己会拉
        if (railVisible()) loadReview(ws); else reviewStale = true;
      }, 3000);
    }
    if (ws && !dock.meta) ensureDockMeta();
  });
  $effect(() => () => clearTimeout(reviewT));

  // —— 环境 ——
  const parent = $derived.by(() => {
    if (!path) return '';
    const p = String(path).replace(/[\\/]+$/, '');
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i > 0 ? p.slice(0, i) : '';
  });
  const folder = $derived.by(() => {
    const p = String(path || '').replace(/[\\/]+$/, '');
    return name || p.split(/[\\/]/).pop() || '';
  });
  const branch = $derived(dock.meta?.git ? (dock.meta.branch || '') : '');
  const isWt = $derived(!!dock.meta?.worktree);

  // —— 上下文（与用量圆环同一份：status.usages 优先，旧 status.contexts 兜底）——
  const ctx = $derived.by(() => {
    if (!sid) return null;
    const u = status.usages[sid];
    if (u) return { ...ctxSummary(u.total, u.max), used: u.total, max: u.max };
    const c = status.contexts[sid] || (status.context && status.context.sessionId === sid ? status.context : null);
    return c ? { ...ctxSummary(c.used, c.total), used: c.used, max: c.total } : null;
  });
  const ctxPct = $derived(ctx && ctx.pct != null ? ctx.pct : null);
  const ctxTone = $derived(ctxPct == null ? '' : ctxPct >= 90 ? 'danger' : ctxPct >= 75 ? 'warn' : 'accent');
  const compacting = $derived(!!chat.messages.at(-1)?.compacting);

  // —— 连接器 ——
  const servers = $derived((mcpState.bySession[sid]?.servers) || railData.mcp?.servers || []);
  const needFix = $derived(servers.filter((s) => s.status === 'failed' || s.status === 'needs-auth'));
  const STATUS_TXT = { failed: t('重新连接'), 'needs-auth': t('需要登录'), pending: t('连接中…'), disabled: t('已停用'), connected: t('已连接') };
  const connSummary = $derived(needFix.length ? t('{n} 项待重新连接', { n: needFix.length }) : t('{n} 个已连接', { n: servers.length }));
  const connList = $derived([...needFix, ...servers.filter((s) => !needFix.includes(s))].slice(0, 3));

  // —— 相关会话（会话协作：父 / 子 / 兄弟，session-family）——
  const fam = $derived(railData.for === sid ? railData.family : null);
  const famRows = $derived(fam ? [...(fam.parent ? [fam.parent] : []), ...fam.children, ...fam.siblings] : []);
  const famWorking = $derived(famRows.filter((r) => r.state === 'working').length);
  const famSummary = $derived(famWorking ? t('{n} 个在干活', { n: famWorking }) : t('{n} 个', { n: famRows.length }));
  // 有会话在干活时每 6 秒重拉一次（子会话收工、父会话被唤醒，这张卡要跟上）
  $effect(() => {
    if (!visible || !sid || !famWorking) return;
    const id = sid;
    const timer = setInterval(() => { if (!document.hidden) loadRail(id); }, 6000);
    return () => clearInterval(timer);
  });

  // —— 输出内容 ——
  let outMore = $state(false);
  const outputs = $derived(railData.for === sid ? railData.outputs : []);
  const outShown = $derived(outMore ? outputs : outputs.slice(0, 5));
  $effect(() => { sid; outMore = false; });

  // —— 更改 ——
  const hasChanges = $derived(review.add > 0 || review.del > 0);
  const COMMIT_MSG = t('把工作区的改动提交，写一条合适的提交说明。');
  function commitChanges() {
    if (!hasChanges || !sid) return;
    // 官方「Commit changes」= 以用户身份给 Claude 发一条消息让它自己提交；工作中就排进队列
    if (session.busy) queueSend(COMMIT_MSG, []);
    else send(COMMIT_MSG, []);
  }
  const num = (n) => Number(n || 0).toLocaleString();

  function head(e, card) { toggleFold(card, e.altKey); }

  // 弹层模式：点外面 / Esc 收起
  let rootEl = $state(null);
  $effect(() => {
    if (docked || !visible) return;
    const down = (e) => {
      if (rootEl && rootEl.contains(e.target)) return;
      if (e.target.closest && e.target.closest('[data-rail-toggle]')) return;
      toggleRail(false);
    };
    const key = (e) => { if (e.key === 'Escape') toggleRail(false); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  });
</script>

{#snippet caret(card)}<svg class="rc-caret" class:open={!isFolded(card)} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>{/snippet}
{#snippet ic(d)}<span class="rr-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{@html d}</svg></span>{/snippet}

<span class="rail-probe" bind:this={probe} aria-hidden="true"></span>
{#if visible && sid}
  <aside class="rail" class:docked class:pop={!docked} bind:this={rootEl} aria-label={t('会话信息')}>
    <div class="rail-scroll">
      <!-- 环境 -->
      {#if folder || branch}
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'environment')}>{t('环境')}{@render caret('environment')}</button>
            {#if isFolded('environment')}<span class="rc-sum">{folder || branch}</span>{/if}
          </div>
          {#if !isFolded('environment')}
            <div class="rc-body">
              <div class="rr">{@render ic('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M2 20h20"/>')}<span class="rr-txt">{t('这台电脑')}</span></div>
              {#if folder}
                <button class="rr click" title={path} onclick={() => openDockFiles({})}>
                  {@render ic('<path d="M3.5 7.2c0-1.5 1.2-2.7 2.7-2.7h3.4l2 2.3h6.2c1.5 0 2.7 1.2 2.7 2.7v8.3c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7z"/>')}
                  <span class="rr-txt rr-name">{folder}</span>
                  {#if parent}<span class="rr-dim">· {parent}</span>{/if}
                </button>
              {/if}
              {#if branch}
                <div class="rr">{@render ic('<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7.5v9M18 10c0 4-6 3.5-11 7"/>')}<span class="rr-txt">{branch}</span>{#if isWt}<span class="rr-dim">· worktree</span>{/if}</div>
              {/if}
            </div>
          {/if}
        </section>
      {/if}

      <!-- 相关会话（会话协作）：父会话、它派生的子会话、兄弟会话；点一行打开那个会话 -->
      {#if famRows.length}
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'family')}>{t('相关会话')}{@render caret('family')}</button>
            <span class="rc-sum" class:hide={!isFolded('family')}>{famSummary}</span>
          </div>
          {#if !isFolded('family')}
            <div class="rc-body">
              {#each famRows as r (r.id)}
                <button class="rr click fam" title={r.report || r.title} onclick={() => openSession(r.id)}>
                  {@render ic(r.relation === 'parent' ? '<path d="M12 19V7"/><path d="M7 11l5-5 5 5"/>' : r.relation === 'child' ? '<path d="M6 5v7a3 3 0 0 0 3 3h9"/><path d="M14 11l4 4-4 4"/>' : '<path d="M6 5v14M18 5v14M6 12h12"/>')}
                  <span class="rr-txt">{r.title || r.name || t('（无标题）')}</span>
                  <span class="rr-grow"></span>
                  {#if r.state === 'working'}<span class="fam-dot" aria-hidden="true"></span>{/if}
                  <span class="rr-st">{REL_LABEL[r.relation] || REL_LABEL.linked}</span>
                </button>
              {/each}
            </div>
          {/if}
        </section>
      {/if}

      <!-- 建议的任务（会话协作：Claude 提议、还没开的会话卡，官方 “{count} suggested tasks”） -->
      <SuggestedTasksCard />

      <!-- 上下文 -->
      {#if !IS_CSNAP}
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'context')}>{t('上下文')}{@render caret('context')}</button>
            <span class="rc-sum" class:hide={!isFolded('context')}>
              {#if ctxPct != null}{ctxPct}%<span class="bar"><span class="bar-fill {ctxTone}" style="width:{Math.max(6, ctxPct)}%"></span></span>{:else}{t('暂无数据')}{/if}
            </span>
          </div>
          {#if !isFolded('context')}
            <div class="rc-body">
              {#if ctx}
                <div class="rr"><span class="rr-txt">{fmtCompact(ctx.used)} / {fmtCompact(ctx.max)}</span><span class="rr-grow"></span><span class="rr-dim">{ctxPct}%</span></div>
                <div class="ctx-track"><span class="bar-fill {ctxTone}" style="width:{Math.max(2, ctxPct || 0)}%"></span></div>
                <div class="rr">
                  <span class="rr-dim small">{session.busy ? t('本轮结束后可压缩') : t('压缩会话可腾出上下文空间')}</span><span class="rr-grow"></span>
                  <button class="rbtn" disabled={session.busy || compacting || ui.offline} onclick={() => send('/compact', [])}>{compacting ? t('压缩中…') : t('压缩')}</button>
                </div>
              {:else}
                <div class="rr"><span class="rr-dim">{t('这个会话还没有上下文用量数据，发一条消息后就有')}</span></div>
              {/if}
            </div>
          {/if}
        </section>
      {/if}

      <!-- 连接器 -->
      {#if servers.length}
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'connectors')}>{t('连接器')}{@render caret('connectors')}</button>
            <span class="rc-sum" class:hide={!isFolded('connectors')}>{connSummary}</span>
          </div>
          {#if !isFolded('connectors')}
            <div class="rc-body">
              {#each connList as s (s.name)}
                <div class="rr">
                  {@render ic('<path d="M9 7V4M15 7V4M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v4"/>')}
                  <span class="rr-txt">{s.name}</span><span class="rr-grow"></span>
                  <span class="rr-st" class:warn={s.status === 'failed' || s.status === 'needs-auth'}>{STATUS_TXT[s.status] || s.status}</span>
                </div>
              {/each}
              {#if servers.length > 3}<div class="rr"><span class="rr-dim small">{t('另有 {n} 个', { n: servers.length - 3 })}</span></div>{/if}
            </div>
          {/if}
        </section>
      {/if}

      <!-- 输出内容 -->
      {#if outputs.length}
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'outputs')}>{t('输出内容')}{@render caret('outputs')}</button>
            <span class="rc-sum" class:hide={!isFolded('outputs')}>{outputs.length}</span>
          </div>
          {#if !isFolded('outputs')}
            <div class="rc-body">
              {#each outShown as f (f.path)}
                <button class="rr click" title={f.path} onclick={() => openPreview({ origin: 'claude', id: sid, path: f.path, name: f.name })}>
                  {@render ic('<path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>')}
                  <span class="rr-txt">{f.name}</span>
                </button>
              {/each}
              {#if outputs.length > 5 && !outMore}<button class="rr click more" onclick={() => (outMore = true)}><span class="rr-dim">{t('显示更多（{n}）', { n: outputs.length - 5 })}</span></button>{/if}
            </div>
          {/if}
        </section>
      {/if}

      <!-- 拉取请求（PrCard.svelte）：不是主机本人 / 不在 GitHub 仓库里时整张卡不出现 -->
      {#if !IS_CSNAP}<PrCard {sid} />{/if}

      <!-- 更改 -->
      {#if review.git}
        <section class="rc">
          <div class="rc-head">
            <button class="rc-title" onclick={(e) => head(e, 'changes')}>{t('更改')}{@render caret('changes')}</button>
            {#if isFolded('changes')}<span class="rc-sum"><span class="add">+{num(review.add)}</span> <span class="del">−{num(review.del)}</span></span>{/if}
          </div>
          {#if !isFolded('changes')}
            <div class="rc-body">
              <div class="rr">
                <button class="diffbtn" title={t('打开改动')} onclick={() => toggleDockView('review')}>
                  {@render ic('<rect x="4" y="4" width="16" height="16" rx="3.6"/><path d="M12 7.9v4.2M9.9 10h4.2M9.9 15.6h4.2"/>')}
                  <span class="add">+{num(review.add)}</span><span class="del">−{num(review.del)}</span>
                </button>
                <span class="rr-grow"></span>
                <button class="rbtn" disabled={!hasChanges} title={hasChanges ? t('让 Claude 提交这些改动') : t('没有可提交的改动')} onclick={commitChanges}>{t('提交更改')}</button>
              </div>
            </div>
          {/if}
        </section>
      {/if}
    </div>
  </aside>
{/if}

<style>
  /* 官方紧凑密度 token：卡片无底色、1px ring（暗色内圈 / 亮色外圈，alpha-2）、圆角 10px、上下 8px；
     标题 12px 中粗、摘要 12px 次要色；行高 26px、正文 13px；图标盒 20px；卡片间距 10px；面板宽 280px。 */
  :global(.stage.rail-docked > .scroll), :global(.stage.rail-docked > .composer-wrap) { padding-right: 300px !important; transition: padding-right .2s cubic-bezier(.165,.84,.44,1); }
  .rail-probe { position: absolute; width: 0; height: 0; overflow: hidden; pointer-events: none; }
  .rail { --r-a2: color-mix(in srgb, var(--text) 10%, transparent); --r-ghost: color-mix(in srgb, var(--text) 6%, transparent);
    --r-add: #32d74b; --r-del: #ff2c56; --r-accent: #4c8dff; --r-warn: #db9300; --r-danger: #ff2c56;
    --r-ring: inset 0 0 0 1px var(--r-a2); width: 280px; display: flex; flex-direction: column; z-index: 25; }
  :global(html[data-theme="light"]) .rail { --r-add: #1e9e3c; --r-del: #cd2054; --r-accent: #2a78d6; --r-warn: #734500; --r-danger: #cd2054; --r-ring: 0 0 0 1px var(--r-a2); }
  .rail.docked { position: absolute; top: 56px; right: 14px; bottom: calc(var(--composer-h, 150px) + 12px); }
  .rail.pop { position: absolute; top: 52px; right: 12px; max-height: min(72vh, 640px); border-radius: 12px; background: var(--card); box-shadow: var(--card-shadow); padding: 4px 0; }
  .rail-scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; display: flex; flex-direction: column; gap: 10px; padding: 1px; }
  .rail-scroll::-webkit-scrollbar { display: none; }
  .rail.pop .rail-scroll { gap: 0; }
  .rc { display: flex; flex-direction: column; flex-shrink: 0; padding: 8px 0; border-radius: 10px; box-shadow: var(--r-ring); background: var(--bg); }
  .rail.pop .rc { border-radius: 0; box-shadow: none; background: transparent; }
  .rail.pop .rc + .rc { border-top: 1px solid var(--divider); }
  .rc-head { display: flex; align-items: center; min-height: 26px; padding: 0 8px; gap: 6px; }
  .rc-title { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 4px; font-size: 12px; font-weight: 500; color: var(--text); border-radius: 6px; }
  .rc-title:hover { background: var(--r-ghost); }
  .rc-caret { width: 13px; height: 13px; color: var(--muted); transition: transform .15s ease; }
  .rc-caret.open { transform: rotate(90deg); }
  .rc-sum { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding-left: 6px; font-size: 12px; color: var(--muted); }
  .rc-sum.hide { visibility: hidden; }
  .rc-body { display: flex; flex-direction: column; padding: 2px 8px 0; }
  .rr { display: flex; align-items: center; gap: 8px; min-height: 26px; width: 100%; padding: 0 4px; font-size: 13px; color: var(--text); text-align: left; border-radius: 6px; min-width: 0; }
  .rr.click:hover { background: var(--r-ghost); }
  .rr.click:active { background: var(--r-a2); }
  .rr-ic { flex: none; display: grid; place-items: center; width: 20px; height: 20px; color: var(--serif, var(--muted)); }
  .rr-ic :global(svg) { width: 15px; height: 15px; }
  .rr-txt { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .rr-name { flex: none; max-width: 60%; }
  .rr-dim { min-width: 8ch; flex-shrink: 9999; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); }
  .rr-dim.small { font-size: 12px; }
  .rr.more .rr-dim { padding-left: 28px; }
  .rr-grow { flex: 1; }
  .rr-st { flex: none; font-size: 12px; color: var(--muted); }
  .rr-st.warn { color: var(--r-warn); }
  .bar { display: inline-flex; width: 24px; height: 10px; padding: 2px; border-radius: 99px; background: var(--r-a2); }
  .bar-fill { display: block; min-width: 6px; height: 100%; border-radius: 99px; background: var(--r-accent); }
  .bar-fill.warn { background: var(--r-warn); }
  .bar-fill.danger { background: var(--r-danger); }
  .ctx-track { display: flex; height: 6px; margin: 2px 4px 6px; border-radius: 99px; background: var(--r-a2); overflow: hidden; }
  .add { color: var(--r-add); }
  .del { color: var(--r-del); }
  .diffbtn { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; padding: 0 6px 0 0; border-radius: 6px; font-size: 13px; font-variant-numeric: tabular-nums; }
  .diffbtn:hover { background: var(--r-ghost); }
  .rbtn { flex: none; font-size: 12px; padding: 3px 9px; border-radius: 7px; background: var(--r-a2); color: var(--text); }
  .rbtn:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 15%, transparent); }
  .rbtn:disabled { opacity: .45; }
  .fam-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--r-accent); animation: famPulse 1.6s ease-in-out infinite; }
  @keyframes famPulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .fam-dot { animation: none; } }
</style>
