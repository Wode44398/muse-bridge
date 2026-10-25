<script>
  // 会话信息面板的「拉取请求」卡（官方 Desktop 3.1623 的 PR 栏 + CI 弹层 + rail 上的 Merge，调研 A2 §1.2–1.7）。
  // 数据：src/runtime/pr-monitor.mjs（GET/POST /api/claude/pr + 总线 {type:'pr'}），前端镜像在 lib/pr.svelte.js。
  // 分工照官方：「创建拉取请求」交给 Claude（发 /create-pr 提示词）；合并 / 标为可审查 / 转草稿 / 自动合并 / 重跑检查
  // 由 bridge 直调 GitHub；同步基线分支在主机侧 fetch + merge，冲突就把冲突文件交给 Claude 去解。
  // 危险操作（合并、同步基线、移出、开自动合并）都先在卡里展开一行确认，解释写在确认行里，平时的副标题只放状态。
  import { session } from '../../lib/state.svelte.js';
  import { send, queueSend } from '../../lib/chat.svelte.js';
  import { cs } from '../../lib/claudeSettings.svelte.js';
  import { isFolded, toggleFold } from '../../lib/sessionRail.svelte.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import {
    prViewOf, loadPr, watchPr, prAction, mainPr, ciStatus, conflicting, prTone, stateLabel, REVIEW_LABEL, GH_REASON,
    openGitHub, prCreate, setPrCreateMode, createBlocker, CREATE_BLOCKER, createPrPrompt, compareUrl, baseOf, syncConflictPrompt,
  } from '../../lib/pr.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  import { untrack } from 'svelte';

  let { sid = '' } = $props();

  // 只依赖 sid（同 PrChip：拉取过程读写的 PR 状态不能成为 effect 的依赖）
  $effect(() => { const id = sid; return untrack(() => watchPr(id)); });
  // 一轮刚收尾：Claude 可能刚提交 / 推送 / 建了 PR——跳过服务端缓存补拉一次（git 概况缓存 4 秒、PR 状态 15 秒）
  let wasBusy = false;
  $effect(() => {
    const busy = session.busy;
    if (wasBusy && !busy && sid) { const id = sid; untrack(() => loadPr(id, { refresh: true })); }
    wasBusy = busy;
  });

  const view = $derived(prViewOf(sid));
  const show = $derived(!!view && view.available === true);
  const prs = $derived((view && view.prs) || []);
  const main = $derived(mainPr(view));
  const ghBad = $derived(view && view.gh && !view.gh.ok ? view.gh.reason : '');
  const limited = $derived(!!(view && view.gh && view.gh.limited));
  const blocker = $derived(createBlocker(view, session.busy));
  const fixPaused = $derived(view && view.fix && view.fix.paused ? view.fix.paused : '');

  // 每个 PR 一份交互态：phase = '' | 'checking' | 'confirm' | 'merging' | 'sync' | 'syncing' | 'unbind' | 'automerge' | 'busy'
  // 模板里只读（S，没有就给空白的）；事件里改之前用 st 建条目——渲染期间不能写 $state。
  let ux = $state({});
  const BLANK = Object.freeze({ phase: '', error: '', errDetail: '', method: 'squash', head: '', checksOpen: false });
  const S = (url) => ux[url] || BLANK;
  // 要返回 ux[url]（代理）而不是赋值表达式的值（原始对象）——改原始对象不触发更新，第一次点「合并」确认行就出不来
  const st = (url) => { if (!ux[url]) ux[url] = { ...BLANK }; return ux[url]; };
  $effect(() => { sid; ux = {}; tracking = false; trackUrl = ''; trackErr = ''; menuOpen = false; });

  const num = (n) => Number(n || 0).toLocaleString();
  // GitHub 那边回来的失败（http / graphql：405 不可合并、409 head 变了……）原文是英文、也不在字典里：
  // 卡上显示我们自己的一句（lead），GitHub 原文放进悬停提示（errDetail）
  const GH_RAW = new Set(['http', 'graphql']);
  const fail = (r, lead) => (r.error && !GH_RAW.has(r.code) ? tr(r.error) : lead);
  const failDetail = (r) => (GH_RAW.has(r.code) ? r.error || '' : '');
  function setFail(s, r, lead) { s.error = fail(r, lead); s.errDetail = failDetail(r); }

  // 检查条目的链接是第三方写的（CheckRun detailsUrl / commit status targetUrl）：只认 http(s)，别的退回 PR 的 checks 页
  const safeHref = (u, fallback) => (/^https?:\/\//i.test(String(u || '')) ? u : fallback);

  // —— 创建拉取请求（交给 Claude）——
  let menuOpen = $state(false);
  function createPr(mode = prCreate.mode) {
    menuOpen = false;
    if (mode !== prCreate.mode) setPrCreateMode(mode);
    if (blocker || !view || !view.git) return;
    const g = view.git;
    // 基线 = worktree 切出时的分支（项目当时在 dev 上就开到 dev），不是一律开到默认分支
    send(createPrPrompt({ draft: mode === 'draft', repo: g.repo, branch: g.branch, base: baseOf(view), cwd: g.cwd, attribution: cs.values.attribution }), []);
  }
  function manualPr() {
    menuOpen = false;
    const u = compareUrl(view);
    if (u) openGitHub(u);
    if (view && view.git && !view.git.pushed) showToast(t('这个分支还没推送到 GitHub，推送后再试'), 'err');
  }

  // —— 跟踪已有的拉取请求 ——
  let tracking = $state(false), trackUrl = $state(''), trackErr = $state(''), trackBusy = $state(false);
  async function track() {
    const u = trackUrl.trim();
    if (!u) return;
    trackBusy = true; trackErr = '';
    const r = await prAction(sid, 'bind', { url: u });
    trackBusy = false;
    if (r.ok) { tracking = false; trackUrl = ''; } else trackErr = fail(r, t('无法跟踪这个拉取请求'));
  }

  // —— 合并：先重读二次确认，再确认，再合 ——
  async function mergeStart(pr) {
    const s = st(pr.url);
    s.phase = 'checking'; s.error = '';
    const r = await prAction(sid, 'mergeCheck', { url: pr.url });
    if (!r.ok) { s.phase = ''; setFail(s, r, t('无法加载拉取请求，未合并')); return; }
    s.head = r.result.headSha;
    const ms = r.result.methods || [];
    if (!ms.includes(s.method)) s.method = ms[0] || 'squash';
    s.phase = 'confirm';
  }
  async function mergeGo(pr) {
    const s = st(pr.url);
    s.phase = 'merging';
    const r = await prAction(sid, 'merge', { url: pr.url, method: s.method, expectHead: s.head });
    s.phase = '';
    if (!r.ok) { setFail(s, r, t('无法合并拉取请求')); return; }
    s.error = ''; s.errDetail = '';
    showToast(r.result && r.result.queued ? t('已加入合并队列') : t('已合并拉取请求 #{n}', { n: pr.number }));
  }

  async function simple(pr, op, args, okMsg, errLead) {
    const s = st(pr.url);
    s.phase = 'busy'; s.error = ''; s.errDetail = '';
    const r = await prAction(sid, op, { url: pr.url, ...args });
    s.phase = '';
    if (!r.ok) { setFail(s, r, errLead); return false; }
    if (okMsg) showToast(okMsg);
    return r;
  }
  const markReady = (pr) => simple(pr, 'ready', {}, '', t('无法标为可审查，请重试或到 GitHub 上操作'));
  const toDraft = (pr) => simple(pr, 'draft', {}, '', t('无法转为草稿，请重试或到 GitHub 上操作'));
  async function rerun(pr) {
    const r = await simple(pr, 'rerun', {}, '', t('无法重跑检查'));
    if (!r) return;
    const x = r.result || {};
    showToast(x.rerun ? t('已重跑 {n} 个工作流', { n: x.rerun }) : t('没有能从这里重跑的检查'), x.rerun ? 'ok' : 'err');
  }
  async function unbind(pr) {
    const r = await simple(pr, 'unbind', {}, '', t('操作失败，请重试'));
    if (r) delete ux[pr.url];
  }
  async function setAutoMerge(pr, on) {
    const s = st(pr.url);
    const r = await simple(pr, 'autoMerge', { enabled: on, method: s.method }, '', t('无法更改自动合并'));
    if (r && on) s.phase = '';
  }
  // 展开「就绪后自动合并」确认行：合并方式默认取仓库允许的第一种（仓库禁了 squash 时别带 squash 去开）
  function openAutoMerge(pr) {
    const s = st(pr.url);
    const ms = pr.methods || [];
    if (ms.length && !ms.includes(s.method)) s.method = ms[0];
    s.phase = 'automerge';
  }
  // 合并确认行的提醒：检查失败 / 仍在运行、还没通过评审时照样能合（非必需检查失败 GitHub 也放行），但要写明
  function mergeWarn(pr) {
    const c = pr.checks || {};
    const w = [];
    if (c.failing) w.push(t('{n} 项检查失败', { n: c.failing }));
    if (c.pending) w.push(t('{n} 项检查仍在运行', { n: c.pending }));
    if (pr.reviewDecision === 'REVIEW_REQUIRED') w.push(t('还没有通过评审'));
    else if (pr.reviewDecision === 'CHANGES_REQUESTED') w.push(t('评审要求修改'));
    return w.join(' · ');
  }

  // —— 同步基线分支 ——
  async function syncGo(pr) {
    const s = st(pr.url);
    s.phase = 'syncing'; s.error = ''; s.errDetail = '';
    const r = await prAction(sid, 'syncBase', { base: pr.base });
    s.phase = '';
    if (!r.ok) { setFail(s, r, t('合并基线分支失败')); return; }
    const x = r.result || {};
    if (x.kind === 'merged') showToast(t('已把 {base} 合并进来，记得推送', { base: x.base }));
    else if (x.kind === 'up_to_date') showToast(t('已是最新'));
    else if (x.kind === 'conflicts') {
      // 冲突交给会话处理：以用户身份发一句（工作中就排进队列）；包在 <sync-conflict> 里，转录里折叠成一行（PrMsgCard）
      const msg = syncConflictPrompt(x);
      if (session.busy) queueSend(msg, []); else send(msg, []);
      showToast(t('有 {n} 个文件冲突，已交给 Claude 处理', { n: x.total }));
    } else { s.error = syncReason(x); s.errDetail = x.kind === 'failed' ? x.error || '' : ''; }   // git 的原话（英文）只进悬停提示
  }
  function syncReason(x) {
    const R = {
      uncommitted_changes: t('工作区有未提交的改动，先提交或暂存再同步'),
      operation_in_progress: t('有一次合并或变基还没做完'),
      detached_head: t('当前不在任何分支上'),
      base_not_allowed: t('只能同步拉取请求的基线分支或仓库默认分支'),
      no_base: t('不知道基线分支是哪个'),
      origin_unavailable: t('没有 origin 远程'),
      session_running: t('Claude 正在工作，请等本轮结束'),
    };
    return R[x.reason] || t('合并基线分支失败');
  }

  // —— 会话级开关 ——
  async function toggleFix() {
    const on = !(view && view.monitor && view.monitor.autoFix);
    const r = await prAction(sid, 'monitor', { autoFix: on });
    if (!r.ok) showToast(t('操作失败，请重试'), 'err');
  }
  async function resumeFix() { await prAction(sid, 'monitor', { autoFix: true }); }
  async function toggleArchive() {
    const r = await prAction(sid, 'monitor', { autoArchive: !(view && view.monitor && view.monitor.autoArchive) });
    if (!r.ok) showToast(t('操作失败，请重试'), 'err');
  }

  const CI_TXT = { failed: t('检查失败'), passed: t('检查通过'), pending: t('检查运行中'), skipped: t('检查已跳过'), none: t('尚未上报任何检查'), unavailable: t('检查状态不可用') };
  const METHOD_TXT = { squash: t('压缩合并'), merge: t('合并提交'), rebase: t('变基合并') };
  const PAUSE_TXT = { streak: t('连续自动处理了好几次，已暂停'), daily: t('今天自动处理的次数已到上限') };
  const BUCKET_ORDER = { fail: 0, cancel: 1, pending: 2, pass: 3, skipping: 4 };
  const sortedChecks = (pr) => [...(pr.checkList || [])].sort((a, b) => (BUCKET_ORDER[a.bucket] ?? 9) - (BUCKET_ORDER[b.bucket] ?? 9));
  const canMerge = (pr) => pr.state === 'open' && !pr.isDraft && !(pr.autoMerge && pr.autoMerge.enabled);
</script>

{#snippet caret()}<svg class="rc-caret" class:open={!isFolded('pr')} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>{/snippet}
{#snippet ic(d)}<span class="rr-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{@html d}</svg></span>{/snippet}
{#snippet sw(on, label, onclick, dim = '')}
  <button class="rr click swrow" role="switch" aria-checked={on} {onclick}>
    <span class="rr-txt">{label}</span>{#if dim}<span class="rr-dim small">· {dim}</span>{/if}<span class="rr-grow"></span>
    <span class="sw" class:on aria-hidden="true"><span class="knob"></span></span>
  </button>
{/snippet}
{#snippet dot(bucket)}<span class="cdot {bucket}" aria-hidden="true"></span>{/snippet}

<!-- 只在 GitHub 仓库的会话（或已经绑了 PR）里出现；gh 没装 / 没登录是卡内提示，不让非 GitHub 会话也多出一张「不可用」卡 -->
{#if show && (prs.length || (view.git && view.git.github))}
  <section class="rc">
    <div class="rc-head">
      <button class="rc-title" onclick={(e) => toggleFold('pr', e.altKey)}>{t('拉取请求')}{@render caret()}</button>
      <span class="rc-sum" class:hide={!isFolded('pr')}>
        {#if main}<span class="pill {prTone(main)}">#{main.number}</span>{stateLabel(main.state)}{:else if ghBad}{t('不可用')}{:else}{t('还没有')}{/if}
      </span>
    </div>
    {#if !isFolded('pr')}
      <div class="rc-body">
        {#if ghBad}
          <div class="rr">{@render ic('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>')}<span class="rr-dim">{GH_REASON[ghBad] || GH_REASON.unknown}</span></div>
        {:else if limited}
          <div class="rr"><span class="rr-dim small">{GH_REASON.rate_limited}</span></div>
        {/if}

        {#each prs as pr (pr.url)}
          {@const s = S(pr.url)}
          {@const ci = ciStatus(pr)}
          <div class="pr">
            <a class="rr click prline" href={safeHref(pr.url, '#')} target="_blank" rel="noopener noreferrer" title={pr.title}>
              {@render ic('<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4"/><path d="M13 4l-2 2 2 2"/>')}
              <span class="num">#{pr.number}</span><span class="rr-txt">{pr.title || pr.repo}</span><span class="rr-grow"></span>
              <span class="pill {prTone(pr)}">{stateLabel(pr.state)}</span>
            </a>
            {#if pr.error && !ghBad}<div class="rr"><span class="rr-dim small">{GH_REASON[pr.error] || GH_REASON.unknown}</span></div>{/if}
            <!-- 派生 / 分叉会话从父会话继承来的：只看状态，自动修复与自动合并不对它开放（官方 inherited） -->
            {#if pr.inherited}<div class="rr"><span class="rr-ic"></span><span class="rr-dim small">{t('继承自父会话')}</span></div>{/if}

            {#if pr.checks && pr.state !== 'merged' && pr.state !== 'closed'}
              <button class="rr click" onclick={() => { const x = st(pr.url); x.checksOpen = !x.checksOpen; }} aria-expanded={s.checksOpen}>
                {@render dot(ci === 'failed' ? 'fail' : ci === 'passed' ? 'pass' : ci === 'pending' ? 'pending' : 'skipping')}
                <span class="rr-txt">{CI_TXT[ci]}</span>
                {#if pr.checks.total}
                  <span class="rr-grow"></span>
                  <span class="cnt">
                    {#if pr.checks.failing}<span class="del">✕ {pr.checks.failing}</span>{/if}
                    {#if pr.checks.pending}<span class="warn">◷ {pr.checks.pending}</span>{/if}
                    {#if pr.checks.passing}<span class="add">✓ {pr.checks.passing}</span>{/if}
                  </span>
                {/if}
              </button>
              {#if s.checksOpen && pr.checkList && pr.checkList.length}
                <div class="checks">
                  {#each sortedChecks(pr) as c, ci2 (ci2)}
                    {@const href = safeHref(c.url, pr.url + '/checks')}
                    <a class="rr click chk" {href} target="_blank" rel="noopener noreferrer">
                      {@render dot(c.bucket)}<span class="rr-txt">{c.name}</span>{#if c.workflow}<span class="rr-dim small">· {c.workflow}</span>{/if}
                    </a>
                  {/each}
                </div>
              {/if}
            {/if}

            {#if pr.state === 'open' || pr.state === 'draft'}
              {#if conflicting(pr) || (pr.reviewDecision && REVIEW_LABEL[pr.reviewDecision]) || pr.mergeStateStatus === 'BEHIND'}
                <div class="rr">
                  <span class="rr-ic"></span>
                  {#if conflicting(pr)}<span class="tag del">{t('合并冲突')}</span>{:else if pr.mergeStateStatus === 'BEHIND'}<span class="tag warn">{t('落后于基线分支')}</span>{/if}
                  {#if pr.reviewDecision && REVIEW_LABEL[pr.reviewDecision]}<span class="tag" class:add={pr.reviewDecision === 'APPROVED'} class:warn={pr.reviewDecision === 'CHANGES_REQUESTED'}>{REVIEW_LABEL[pr.reviewDecision]}</span>{/if}
                </div>
              {/if}

              <!-- 操作行 -->
              {#if s.phase === 'confirm'}
                <div class="confirm">
                  <div class="ct">{t('合并拉取请求 #{n}？', { n: pr.number })}</div>
                  {#if mergeWarn(pr)}<div class="cd err">{mergeWarn(pr)}</div>{/if}
                  {#if (pr.methods || []).length > 1}
                    <div class="seg" role="radiogroup">
                      {#each pr.methods as m (m)}<button role="radio" aria-checked={s.method === m} class:on={s.method === m} onclick={() => (st(pr.url).method = m)}>{METHOD_TXT[m]}</button>{/each}
                    </div>
                  {/if}
                  <div class="cbtns"><button class="rbtn" onclick={() => (st(pr.url).phase = '')}>{t('取消')}</button><button class="rbtn primary" onclick={() => mergeGo(pr)}>{t('确认合并')}</button></div>
                </div>
              {:else if s.phase === 'sync'}
                <div class="confirm">
                  <div class="ct">{t('把 origin/{base} 合并进 {branch}？', { base: pr.base, branch: pr.head })}</div>
                  <div class="cd">{t('在这台电脑上 fetch 并合并，不会推送；有冲突就交给 Claude 解决。')}</div>
                  <div class="cbtns"><button class="rbtn" onclick={() => (st(pr.url).phase = '')}>{t('取消')}</button><button class="rbtn primary" onclick={() => syncGo(pr)}>{t('同步')}</button></div>
                </div>
              {:else if s.phase === 'unbind'}
                <div class="confirm">
                  <div class="ct">{t('从这个会话移出 #{n}？', { n: pr.number })}</div>
                  <div class="cd">{t('它的检查和评审不再出现在这里，自动修复和自动归档也不再管它。之后可以重新跟踪。')}</div>
                  <div class="cbtns"><button class="rbtn" onclick={() => (st(pr.url).phase = '')}>{t('取消')}</button><button class="rbtn primary" onclick={() => unbind(pr)}>{t('移出')}</button></div>
                </div>
              {:else if s.phase === 'automerge'}
                <div class="confirm">
                  <div class="ct">{t('就绪后自动合并 #{n}？', { n: pr.number })}</div>
                  <div class="cd">{pr.autoMergeAllowed ? t('必需的检查和评审都通过后，GitHub 会立即合并。') : t('这个仓库没开 GitHub 自动合并：检查通过后由 bridge 代为合并，需要这台电脑在线。')}</div>
                  {#if (pr.methods || []).length > 1}
                    <div class="seg" role="radiogroup">
                      {#each pr.methods as m (m)}<button role="radio" aria-checked={s.method === m} class:on={s.method === m} onclick={() => (st(pr.url).method = m)}>{METHOD_TXT[m]}</button>{/each}
                    </div>
                  {/if}
                  <div class="cbtns"><button class="rbtn" onclick={() => (st(pr.url).phase = '')}>{t('取消')}</button><button class="rbtn primary" onclick={() => setAutoMerge(pr, true)}>{t('开启')}</button></div>
                </div>
              {:else}
                <div class="acts">
                  {#if s.phase === 'checking'}<span class="rr-dim small">{t('正在检查拉取请求…')}</span>
                  {:else if s.phase === 'merging'}<span class="rr-dim small">{t('合并中…')}</span>
                  {:else if s.phase === 'syncing'}<span class="rr-dim small">{t('正在同步基线分支…')}</span>
                  {:else}
                    {#if pr.isDraft}<button class="rbtn" disabled={s.phase === 'busy'} onclick={() => markReady(pr)}>{t('标为可审查')}</button>{/if}
                    {#if canMerge(pr)}<button class="rbtn" disabled={s.phase === 'busy'} onclick={() => mergeStart(pr)}>{t('合并')}</button>{/if}
                    {#if pr.checks && pr.checks.failing}<button class="rbtn" disabled={s.phase === 'busy'} onclick={() => rerun(pr)}>{t('重跑失败的检查')}</button>{/if}
                    {#if pr.base && view.git && view.git.branch === pr.head}<button class="rbtn" disabled={s.phase === 'busy' || session.busy} title={session.busy ? t('Claude 正在工作，请等本轮结束') : ''} onclick={() => (st(pr.url).phase = 'sync')}>{t('同步基线')}</button>{/if}
                    <!-- 次要操作成组靠右：放不下时整组换到下一行，不把两颗拆开 -->
                    <span class="lnks">
                      {#if !pr.isDraft}<button class="lnk" disabled={s.phase === 'busy'} onclick={() => toDraft(pr)}>{t('转为草稿')}</button>{/if}
                      <button class="lnk" onclick={() => (st(pr.url).phase = 'unbind')}>{t('移出')}</button>
                    </span>
                  {/if}
                </div>
              {/if}
              {#if s.error}<div class="rr"><span class="rr-dim small err" title={s.errDetail || null}>{s.error}</span></div>{/if}

              {#if !pr.isDraft && (!pr.inherited || (pr.autoMerge && pr.autoMerge.enabled))}
                {@render sw(!!(pr.autoMerge && pr.autoMerge.enabled), t('就绪后自动合并'), () => (pr.autoMerge && pr.autoMerge.enabled ? setAutoMerge(pr, false) : openAutoMerge(pr)), pr.autoMerge && pr.autoMerge.by === 'bridge' ? (pr.autoMerge.error ? t('上次代合并失败') : t('由 bridge 代为合并')) : '')}
              {/if}
            {:else if s.error}
              <div class="rr"><span class="rr-dim small err" title={s.errDetail || null}>{s.error}</span></div>
            {/if}
          </div>
        {/each}

        {#if prs.some((p) => (p.state === 'open' || p.state === 'draft') && !p.inherited)}
          {@render sw(!!view.monitor.autoFix, t('自动修复'), toggleFix, fixPaused ? t('已暂停') : '')}
          {#if fixPaused}
            <div class="rr"><span class="rr-dim small">{PAUSE_TXT[fixPaused] || t('已暂停')}</span><span class="rr-grow"></span><button class="rbtn" onclick={resumeFix}>{t('恢复自动修复')}</button></div>
          {/if}
        {/if}
        {#if prs.length}
          {@render sw(!!view.monitor.autoArchive, t('合并或关闭后自动归档'), toggleArchive)}
        {/if}

        <!-- 还没有开着的 PR：创建（交给 Claude）/ 跟踪已有的 -->
        {#if !ghBad && view.git && view.git.github && !prs.some((p) => p.state === 'open' || p.state === 'draft' || p.state === 'queued')}
          <div class="rr create">
            {#if view.git.unpushed || view.git.dirty}
              <span class="rr-dim small">{view.git.unpushed ? t('{n} 个提交未推送', { n: num(view.git.unpushed) }) : t('有未提交的改动')}</span>
            {/if}
            <span class="rr-grow"></span>
            <div class="split">
              <button class="rbtn" disabled={!!blocker} title={blocker ? CREATE_BLOCKER[blocker] : ''} onclick={() => createPr()}>{prCreate.mode === 'draft' ? t('创建草稿拉取请求') : t('创建拉取请求')}</button>
              <button class="rbtn chev" aria-label={t('更多创建方式')} aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>
            </div>
          </div>
          {#if menuOpen}
            <div class="menu" role="menu">
              <button role="menuitemradio" aria-checked={prCreate.mode === 'create'} disabled={!!blocker} onclick={() => createPr('create')}>{t('创建拉取请求')}</button>
              <button role="menuitemradio" aria-checked={prCreate.mode === 'draft'} disabled={!!blocker} onclick={() => createPr('draft')}>{t('创建草稿拉取请求')}</button>
              <button role="menuitem" class="sep" onclick={manualPr}>{t('在 GitHub 上手动创建')}</button>
            </div>
          {/if}
          {#if blocker && blocker !== 'busy'}<div class="rr"><span class="rr-dim small">{CREATE_BLOCKER[blocker]}</span></div>{/if}
          {#if tracking}
            <div class="track">
              <!-- svelte-ignore a11y_autofocus -->
              <input type="url" autofocus placeholder="https://github.com/owner/repo/pull/123" bind:value={trackUrl} onkeydown={(e) => { if (e.key === 'Enter') track(); if (e.key === 'Escape') tracking = false; }} />
              <button class="rbtn" disabled={trackBusy || !trackUrl.trim()} onclick={track}>{t('跟踪')}</button>
            </div>
            {#if trackErr}<div class="rr"><span class="rr-dim small err">{trackErr}</span></div>{/if}
          {:else}
            <button class="rr click more" onclick={() => (tracking = true)}><span class="rr-dim small">{t('跟踪已有的拉取请求…')}</span></button>
          {/if}
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  /* 卡片外壳与行原语照 SessionRail（--r-* 令牌挂在 .rail 上，这里继承）；弹层形态下分隔线由本卡自己画 */
  .rc { display: flex; flex-direction: column; flex-shrink: 0; padding: 8px 0; border-radius: 10px; box-shadow: var(--r-ring); background: var(--bg);
    --pr-merged: #a371f7; }
  :global(html[data-theme="light"]) .rc { --pr-merged: #8250df; }
  :global(.rail.pop) .rc { border-radius: 0; box-shadow: none; background: transparent; }
  :global(.rail.pop) .rc:not(:first-child) { border-top: 1px solid var(--divider); }
  :global(.rail.pop) .rc:not(:last-child) { border-bottom: 1px solid var(--divider); }
  .rc-head { display: flex; align-items: center; min-height: 26px; padding: 0 8px; gap: 6px; }
  .rc-title { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 4px; font-size: 12px; font-weight: 500; color: var(--text); border-radius: 6px; }
  .rc-title:hover { background: var(--r-ghost); }
  .rc-caret { width: 13px; height: 13px; color: var(--muted); transition: transform .15s ease; }
  .rc-caret.open { transform: rotate(90deg); }
  .rc-sum { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding-left: 6px; font-size: 12px; color: var(--muted); }
  .rc-sum.hide { visibility: hidden; }
  .rc-body { display: flex; flex-direction: column; padding: 2px 8px 0; }
  .rr { display: flex; align-items: center; gap: 8px; min-height: 26px; width: 100%; padding: 0 4px; font-size: 13px; color: var(--text); text-align: left; border-radius: 6px; min-width: 0; text-decoration: none; }
  .rr.click:hover { background: var(--r-ghost); }
  .rr.click:active { background: var(--r-a2); }
  .rr-ic { flex: none; display: grid; place-items: center; width: 20px; height: 20px; color: var(--serif, var(--muted)); }
  .rr-ic :global(svg) { width: 15px; height: 15px; }
  .rr-txt { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .rr-dim { min-width: 0; flex-shrink: 9999; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); }
  .rr-dim.small { font-size: 12px; }
  .rr-dim.err { color: var(--r-danger); white-space: normal; }
  .rr-grow { flex: 1; }
  .rr.more .rr-dim { padding-left: 28px; }
  .add { color: var(--r-add); }
  .del { color: var(--r-del); }
  .warn { color: var(--r-warn); }
  .num { flex: none; font-variant-numeric: tabular-nums; color: var(--muted); }
  .pr + .pr { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--r-a2); }
  .pill { flex: none; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 99px; background: var(--r-a2); color: var(--text); }
  .pill.ok, .pill.pending { background: color-mix(in srgb, var(--r-add) 18%, transparent); color: var(--r-add); }
  .pill.fail, .pill.conflict, .pill.closed { background: color-mix(in srgb, var(--r-del) 16%, transparent); color: var(--r-del); }
  .pill.merged { background: color-mix(in srgb, var(--pr-merged) 18%, transparent); color: var(--pr-merged); }
  .pill.draft { color: var(--muted); }
  .rc-sum .pill { margin-right: 2px; }
  .cnt { flex: none; display: inline-flex; gap: 8px; font-size: 12px; font-variant-numeric: tabular-nums; }
  .cdot { flex: none; width: 8px; height: 8px; margin: 0 6px; border-radius: 50%; background: var(--muted); }
  .cdot.pass { background: var(--r-add); }
  .cdot.fail, .cdot.cancel { background: var(--r-del); }
  .cdot.pending { background: var(--r-warn); animation: prPulse 1.6s ease-in-out infinite; }
  @keyframes prPulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .cdot.pending { animation: none; } }
  .checks { display: flex; flex-direction: column; max-height: 220px; overflow-y: auto; margin-left: 14px; }
  .chk { min-height: 24px; font-size: 12px; }
  .tag { flex: none; font-size: 12px; color: var(--muted); }
  .tag + .tag::before { content: '·'; margin-right: 6px; color: var(--muted); }
  .acts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 30px; padding: 2px 4px; }
  .rbtn { flex: none; font-size: 12px; padding: 3px 9px; border-radius: 7px; background: var(--r-a2); color: var(--text); white-space: nowrap; }
  .rbtn:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 15%, transparent); }
  .rbtn:disabled { opacity: .45; }
  .rbtn.primary { background: var(--text); color: var(--bg); }
  .rbtn.primary:hover { background: color-mix(in srgb, var(--text) 85%, transparent); }
  .lnks { flex: none; display: inline-flex; margin-left: auto; }
  .lnk { font-size: 12px; color: var(--muted); padding: 3px 4px; border-radius: 6px; }
  .lnk:hover:not(:disabled) { color: var(--text); background: var(--r-ghost); }
  .confirm { display: flex; flex-direction: column; gap: 6px; margin: 4px 0; padding: 8px; border-radius: 8px; background: var(--r-ghost); }
  .ct { font-size: 13px; font-weight: 500; }
  .cd { font-size: 12px; color: var(--muted); line-height: 1.45; }
  .cd.err { color: var(--r-danger); }
  .cbtns { display: flex; justify-content: flex-end; gap: 6px; }
  .seg { display: inline-flex; flex-wrap: wrap; gap: 4px; }
  .seg button { font-size: 12px; padding: 2px 8px; border-radius: 6px; color: var(--muted); box-shadow: inset 0 0 0 1px var(--r-a2); }
  .seg button.on { color: var(--text); background: var(--r-a2); }
  .swrow { min-height: 30px; }
  .sw { flex: none; position: relative; width: 28px; height: 16px; border-radius: 99px; background: var(--r-a2); transition: background-color .15s ease; }
  .sw.on { background: var(--text); }
  .knob { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--bg); box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s cubic-bezier(.165,.84,.44,1); }
  .sw:not(.on) .knob { background: var(--muted); }
  .sw.on .knob { transform: translateX(12px); }
  .create { flex-wrap: wrap; min-height: 32px; margin-top: 2px; }
  .split { flex: none; display: inline-flex; gap: 1px; }
  .split .rbtn:first-child { border-radius: 7px 0 0 7px; }
  .split .rbtn.chev { border-radius: 0 7px 7px 0; padding: 3px 5px; display: grid; place-items: center; }
  .split .rbtn.chev svg { width: 12px; height: 12px; }
  .menu { display: flex; flex-direction: column; align-self: flex-end; min-width: 180px; margin: 2px 0 4px; padding: 4px; border-radius: 10px; background: var(--card); box-shadow: var(--card-shadow, 0 4px 18px rgba(0,0,0,.18)); }
  .menu button { text-align: left; font-size: 13px; padding: 6px 10px; border-radius: 6px; color: var(--text); }
  .menu button:hover:not(:disabled) { background: var(--r-ghost); }
  .menu button:disabled { opacity: .45; }
  .menu button[aria-checked="true"]::after { content: '✓'; float: right; color: var(--muted); }
  .menu .sep { margin-top: 4px; border-top: 1px solid var(--r-a2); border-radius: 0 0 6px 6px; padding-top: 8px; }
  .track { display: flex; gap: 6px; padding: 2px 4px; }
  .track input { flex: 1; min-width: 0; font-size: 12px; padding: 4px 8px; border-radius: 7px; border: 0; background: var(--r-ghost); color: var(--text); box-shadow: inset 0 0 0 1px var(--r-a2); outline: none; }
  .track input:focus { box-shadow: inset 0 0 0 1px var(--muted); }
</style>
