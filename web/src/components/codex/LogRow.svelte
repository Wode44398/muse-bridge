<script>
  // 工作记录里的一条（种类见 lib/codex/turns.js 的头注释）。写法照 demo 的 rowHtml：图标 · 动词 · 宾语 · 后缀 … 右边结果，
  // 能展开的那几种（查看、命令、编辑、工具结果、子智能体、看过的图、审查）点这一行展开。
  // fresh = 这一条是在你眼前长出来的：从零高度弹开、字上扫一道光；原地换内容（等你批准 → 正在运行）时这一行从淡回到实。
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { t } from '../../lib/i18n.js';
  import { renderMarkdown, renderStreamingMarkdown } from '../../lib/md.js';
  import { codexArtifactUrl } from '../../lib/preview.svelte.js';
  import { codexMdClick, openCodexFile } from '../../lib/codex/thread/links.js';
  import { openCodexDock } from '../../lib/dock.svelte.js';
  import { codex, openThread, findModel } from '../../lib/codex/store.svelte.js';
  import { accLabel } from '../../lib/codex/settings-logic.js';
  import { rolled, roll, anim, EASE, reduced } from '../../lib/codex/motion.js';
  import { diffLines } from '../../lib/codex/thread/diff.js';
  import {
    fmtSecs, exploreText, approvalTag, outLines, toolView, mediaKindOf, isWidgetRow, agentVerb, reviewOf,
    firstLine, isMultiline, fillParts,
  } from '../../lib/codex/thread/words.js';
  import { streamFade } from '../../lib/codex/thread/streamFade.js';
  import { grow, sweep, settleLine } from '../../lib/codex/thread/fx.js';

  let { row, turn, sid = '', fresh = false } = $props();

  let el = $state(null);
  let lineEl = $state(null);
  let verbEl = $state(null);
  let open = $state(false);
  let everOpen = $state(false);   // 展开过就留着里面的东西：收起时要有内容可收（网格行高过渡），也免得反复建大段 diff
  let touched = false;          // 你自己点过展开 / 收起：之后不再替你自动开合
  let rawOpen = $state(false);

  const st = $derived(row.status || '');
  $effect(() => { if (open) everOpen = true; });
  const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

  /* ---------------- 每种的样子 ---------------- */

  const view = $derived.by(() => {
    const r = row;
    switch (r.kind) {
      case 'explore':
        return { ico: 'file', verb: st === 'run' ? t('正在查看') : t('查看了'), obj: exploreText(r.items), roll: true, more: r.items.length > 0 };
      case 'cmd': {
        const tag = r.status === 'deny' ? t('你拒绝了') : approvalTag(r.approval);
        const verb = r.status === 'run' ? t('正在运行') : r.status === 'wait' ? t('等你批准') : r.status === 'deny' ? t('没有运行') : t('运行了命令');
        return { ico: r.status === 'wait' || r.status === 'deny' ? 'shield' : 'term', verb, obj: r.cmd, mono: true, tag, more: r.status !== 'wait' && r.status !== 'deny' };
      }
      case 'edit': {
        const files = r.files || [];
        const one = files.length === 1 ? files[0] : null;
        const verb = st === 'run' ? t('正在编辑') : st === 'deny' ? t('没有改') : t('编辑了');
        const tag = st === 'deny' ? t('你拒绝了')
          : one?.move ? t('改名为 {name}', { name: baseName(one.move) })
            : one?.type === 'add' ? t('新文件') : one?.type === 'delete' ? t('删掉了') : '';
        return { ico: 'edit', verb, obj: one ? one.name || baseName(one.path) : t('{n} 个文件', { n: files.length }), mono: !!one, title: one?.path || '', tag, more: files.some((f) => f.diff) };
      }
      case 'web':
        return { ico: 'globe', verb: st === 'run' ? t('正在搜索网页') : t('搜索了网页'), obj: r.query };
      case 'tool':
      case 'mcp': {
        const v = toolView(r);
        const outText = r.kind === 'mcp' ? r.err : r.text;
        const inline = isWidgetRow(r) || mediaKindOf(r);
        return { ...v, more: !inline && !!String(outText || '').trim(), out: outText };
      }
      case 'agent':
        return { ico: 'codex', verb: agentVerb(r.tool), obj: firstLine(r.prompt, 120), more: !!(r.prompt || r.threads?.length) };
      case 'image':
        return { ico: 'image', verb: r.gen ? t('生成了一张图') : t('看了一张图'), obj: baseName(r.path), mono: true, title: r.path, more: !r.gen && !!r.path };
      case 'review':
        return { ico: 'eye', verb: r.phase === 'exit' ? t('审查完了') : t('开始审查'), obj: firstLine(r.text, 100), more: isMultiline(r.text, 100) };
      default:
        return null;
    }
  });

  // 「自动审查」那条：开始时一行转圈，审完原地换成结论；后面已经有结论了就不再留那行「审查中」
  const reviewNote = $derived.by(() => {
    if (row.kind !== 'note' || row.code !== 'review') return null;
    const phase = row.data?.phase || '';
    if (phase === 'started') {
      const idx = turn.rows.indexOf(row);
      const later = turn.rows.some((r, i) => i > idx && r.kind === 'note' && r.code === 'review' && r.data?.phase !== 'started');
      return later || !turn.live ? { hide: true } : { running: true };
    }
    return reviewOf(row.data?.review);
  });

  const switchTo = $derived.by(() => {
    if (row.kind !== 'note' || row.code !== 'switch') return '';
    const acc = (codex.pool?.accounts || []).find((a) => a.id === row.data?.to);
    return acc ? accLabel(acc) : row.data?.to || '';
  });

  const modelName = (id) => findModel(id)?.name || id || '';

  /* ---------------- 命令的结果 ---------------- */

  const secs = $derived(fmtSecs(row.ms));
  const out = $derived(row.kind === 'cmd' && everOpen ? outLines(row.out) : { lines: [], cut: 0 });
  // 这一行是在你眼前跑完的：耗时从 0.0s 滚到真数，最后跳一下
  let landed = $state(false);
  let prevSt = untrack(() => row.status);
  $effect(() => {
    const s = row.status;
    if (s === prevSt) return;
    const was = prevSt;
    prevSt = s;
    if (was === 'run' && (s === 'ok' || s === 'fail') && turn.live) landed = true;
    if (was === 'wait' && s !== 'wait') { settleLine(lineEl); sweep(verbEl); }
  });

  function popSecs(node, text) {
    if (!landed || reduced()) { roll(node, text, { instant: true }); return { update(v) { roll(node, v); } }; }
    roll(node, '0.0s', { instant: true });
    requestAnimationFrame(() => {
      roll(node, text);
      anim(node, [{ transform: 'scale(1)' }, { transform: 'scale(1.12)', offset: 0.4 }, { transform: 'scale(1)' }], { dur: 320, delay: 200 });
    });
    return { update(v) { roll(node, v); } };
  }

  // 跑着的命令自己展开，跑完过一会儿自己收起（成功快一点、失败多留一会儿）；你点过就听你的
  $effect(() => {
    if (row.kind !== 'cmd' || touched) return;
    const s = row.status;
    if (s === 'run' && turn.live) { open = true; return; }
    if (open && (s === 'ok' || s === 'fail')) {
      const id = setTimeout(() => { if (!touched) open = false; }, s === 'ok' ? 700 : 1100);
      return () => clearTimeout(id);
    }
  });

  function toggle(e) {
    if (!view?.more || e.target.closest('button, a')) return;
    touched = true;
    open = !open;
  }
  function onKey(e) {
    if ((e.key === 'Enter' || e.key === ' ') && view?.more && e.target === e.currentTarget) { e.preventDefault(); touched = true; open = !open; }
  }

  // 输出小窗口：贴着底部跟着滚；你往上翻了就停在那里
  let scr = $state(null);
  let stick = true;
  let fadeTop = $state(false);
  $effect(() => {
    out.lines.length;
    row.out;
    if (scr && stick) scr.scrollTop = scr.scrollHeight;
  });
  function onScr() {
    stick = scr.scrollHeight - scr.scrollTop - scr.clientHeight < 8;
    fadeTop = scr.scrollTop > 2;
  }

  let copied = $state(false);
  async function copyOut() {
    try { await navigator.clipboard.writeText(String(row.out || '')); copied = true; setTimeout(() => { copied = false; }, 900); } catch {}
  }

  const termState = $derived(
    st === 'run' ? t('运行中') : st === 'ok' ? t('成功') : st === 'fail' ? (row.exit != null ? t('退出码 {n}', { n: row.exit }) : t('失败'))
      : st === 'stop' ? t('已停止') : '',
  );

  /* ---------------- 进出场 ---------------- */

  function enter(node) {
    if (!fresh) return;
    if (row.kind === 'compact') {
      if (!reduced()) anim(node, [{ opacity: 0, letterSpacing: '.3em' }, { opacity: 1, letterSpacing: '0' }], { dur: 520 });
      return;
    }
    grow(node, row.kind === 'steer' ? { dur: 380 } : {});
    sweep(node.querySelector('.row-txt .v'));
  }

  /* ---------------- 链接、预览 ---------------- */

  // 只有绝对路径能交给产物接口（相对路径不知道相对谁），相对的就只列出来
  const ABS = /^([A-Za-z]:[\\/]|\/)/;
  const openFile = (path, name) => openCodexFile(sid, path, name);
  const mdLink = (e) => codexMdClick(e, sid);

  const sessionOf = (id) => codex.sessions.find((s) => s.id === id) || null;
</script>

{#snippet okMark()}<span class="res ok"><svg viewBox="0 0 14 14"><path d="M3 7.4l2.6 2.5L11 4.4" /></svg></span>{/snippet}
{#snippet badMark()}<span class="res bad"><svg viewBox="0 0 14 14"><path d="M4 4l6 6M10 4l-6 6" /></svg></span>{/snippet}
{#snippet spin()}<svg class="spin" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.2" /></svg>{/snippet}
{#snippet stopped()}<Icon name="pause" size={14} /><span>{t('已停止')}</span>{/snippet}

{#if row.kind === 'say'}
  <div class="row" use:enter>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="note-p md" use:streamFade={{ live: turn.live }} onclick={mdLink}>{@html turn.live ? renderStreamingMarkdown(row.text) : renderMarkdown(row.text)}</div>
  </div>
{:else if row.kind === 'steer'}
  {#if row.relay}
    <div class="row" use:enter>
      <div class="relay sq"><div class="hd"><Icon name="msg" class="mi-ico" /><span>{t('来自会话')}</span></div><p>{row.text}</p></div>
    </div>
  {:else}
    <div class="row steer-row" use:enter>
      <div class="steer-in">
        <div class="msg-steer sq" class:pending={row.pending} class:failed={!!row.failed} title={row.pending ? t('正在插进去…') : t('跑着的时候插的话，Codex 下一步就会读到')}>{row.text}</div>
        {#if row.failed}<div class="steer-fail">{t('没插进去')} · {row.failed}</div>{/if}
      </div>
    </div>
  {/if}
{:else if row.kind === 'compact'}
  <div class="row" use:enter><div class="divider">{t('已压缩上下文')}</div></div>
{:else if row.kind === 'note'}
  {#if row.code === 'rerouted'}
    <div class="row nrow" use:enter>
      <div class="note sq">
        <span class="n-ico"><Icon name="model" /></span>
        <div class="n-txt">
          {#each fillParts(t('{from} 暂不可用，这一轮用了 {to}'), { from: modelName(row.data?.from), to: modelName(row.data?.to) }) as p}{#if p.key}<b>{p.text}</b>{:else}{p.text}{/if}{/each}
        </div>
      </div>
    </div>
  {:else if row.code === 'warning'}
    {@const msg = String(row.data?.message || '')}
    <div class="row nrow" use:enter>
      <div class="note sq" class:raw-open={rawOpen}>
        <span class="n-ico"><Icon name="warn" /></span>
        <div class="n-txt"><b>{t('Codex 警告')}</b> {firstLine(msg)}{#if isMultiline(msg)}<div class="raw">{msg}</div>{/if}</div>
        {#if isMultiline(msg)}<div class="n-act"><button class="tbtn" onclick={() => { rawOpen = !rawOpen; }}>{rawOpen ? t('收起') : t('展开')}</button></div>{/if}
      </div>
    </div>
  {:else if row.code === 'switch'}
    <div class="row" use:enter>
      <div class="row-line">
        <span class="row-ico"><Icon name="swap" /></span>
        <span class="row-txt"><span class="v">{row.data?.reason === 'rate-limit' || !row.data?.reason ? t('额度用完，已换到 {to} 接着跑', { to: switchTo }) : t('已换到 {to} 接着跑', { to: switchTo })}</span></span>
      </div>
    </div>
  {:else if row.code === 'answered'}
    <div class="row" use:enter>
      <div class="row-line">
        <span class="row-ico"><Icon name="msg" /></span>
        <span class="row-txt" title={row.data?.question || undefined}>
          {#if row.data?.cancelled}<span class="v">{t('你没有回答这个问题')}</span>
          {:else}<span class="v">{t('你答了')}</span> <span class="o">{row.data?.secret ? '••••' : (row.data?.picked || []).join(t('、'))}</span>{/if}
        </span>
      </div>
    </div>
  {:else if row.code === 'review' && reviewNote && !reviewNote.hide}
    <div class="row" class:x={!!reviewNote.reason && reviewNote.reason.length > 60} class:open use:enter>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="row-line" bind:this={lineEl} onclick={() => { if (reviewNote.reason?.length > 60) open = !open; }} onkeydown={onKey} role={reviewNote.reason?.length > 60 ? 'button' : undefined} tabindex={reviewNote.reason?.length > 60 ? 0 : undefined}>
        <span class="row-ico"><Icon name="eye" /></span>
        <span class="row-txt">
          <span class="v" bind:this={verbEl}>{reviewNote.running ? t('自动审查中') : reviewNote.verdict === 'allow' ? t('自动审查：允许') : reviewNote.verdict === 'deny' ? t('自动审查：拦下') : t('自动审查完了')}</span>
          {#if reviewNote.reason}<span class="o dim">{reviewNote.reason}</span>{/if}
        </span>
        <span class="row-meta">{#if reviewNote.running}{@render spin()}{/if}</span>
        {#if reviewNote.reason?.length > 60}<Icon name="chev" class="row-chev" />{/if}
      </div>
      {#if reviewNote.reason?.length > 60}<div class="row-more"><div><div class="inner"><p class="plain">{reviewNote.reason}</p></div></div></div>{/if}
    </div>
  {/if}
{:else if view}
  <div class="row" class:x={view.more} class:open={open && view.more} class:wait={st === 'wait'} bind:this={el} use:enter>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="row-line" bind:this={lineEl} onclick={toggle} onkeydown={onKey} role={view.more ? 'button' : undefined} tabindex={view.more ? 0 : undefined} aria-expanded={view.more ? open : undefined}>
      <span class="row-ico" class:sonar={st === 'wait'}><Icon name={view.ico} /></span>
      <span class="row-txt" title={view.title || undefined}>
        <span class="v" bind:this={verbEl}>{view.verb}</span>
        {#if view.pre}<span class="dim">{view.pre}</span>{/if}
        {#if view.roll}<span class="o roll" use:rolled={view.obj}></span>{:else if view.obj}<span class="o" class:mono={view.mono}>{view.obj}</span>{/if}
        {#if view.post}<span class="dim">{view.post}</span>{/if}
        {#if view.tag}<span class="tag">· {view.tag}</span>{/if}
      </span>
      <span class="row-meta">
        {#if row.kind === 'cmd'}
          {#if st === 'run'}{@render spin()}
          {:else if st === 'ok'}{@render okMark()}<span>{t('成功')}</span>{#if secs}<span class="roll secs" use:popSecs={secs}></span>{/if}
          {:else if st === 'fail'}{@render badMark()}<span class="bad">{row.exit != null ? t('退出码 {n}', { n: row.exit }) : t('失败')}</span>{#if secs}<span class="roll secs" use:popSecs={secs}></span>{/if}
          {:else if st === 'stop'}{@render stopped()}
          {/if}
        {:else if row.kind === 'edit'}
          {#if st === 'stop'}{@render stopped()}
          {:else if st !== 'deny'}
            {@const a = (row.files || []).reduce((s, f) => s + f.a, 0)}
            {@const d = (row.files || []).reduce((s, f) => s + f.d, 0)}
            <span class="a roll" use:rolled={'+' + a}></span><span class="d roll" use:rolled={'−' + d}></span>
          {/if}
        {:else if row.kind === 'agent'}
          {#if st === 'run'}{@render spin()}
          {:else if st === 'ok'}{@render okMark()}<span>{t('完成')}</span>
          {:else if st === 'fail'}{@render badMark()}<span class="bad">{t('失败')}</span>
          {:else if st === 'stop'}{@render stopped()}{/if}
        {:else if row.kind === 'tool' || row.kind === 'mcp' || row.kind === 'web' || row.kind === 'explore'}
          {#if st === 'run'}{@render spin()}
          {:else if st === 'fail'}{@render badMark()}<span class="bad">{t('失败')}</span>
          {:else if st === 'stop'}{@render stopped()}
          {:else}
            {#if view.link}<button class="lnk" onclick={() => openCodexDock(view.link.view)}>{view.link.label}</button>{/if}
            {#if row.kind === 'tool' && secs}<span>{secs}</span>{/if}
          {/if}
        {:else if row.kind === 'image' && st === 'run'}{@render spin()}
        {/if}
      </span>
      {#if view.more}<Icon name="chev" class="row-chev" />{/if}
    </div>
    {#if view.more}
      <div class="row-more"><div><div class="inner">
        {#if everOpen}
          {#if row.kind === 'explore'}
            <div class="files">
              {#each row.items as it}
                {#if it.type === 'read' && ABS.test(it.path || '')}<button class="fl" title={it.path} onclick={() => openFile(it.path, it.name)}>{it.path}</button>
                {:else if it.type === 'read'}<span>{it.path || it.name}</span>
                {:else if it.type === 'list'}<span>{(it.path || '.') + '/'}</span>
                {:else}<span>{t('搜了')} “{it.query}”{it.path ? ' · ' + it.path : ''}</span>{/if}
              {/each}
            </div>
          {:else if row.kind === 'cmd'}
            {#if everOpen}
              <div class="term sq" style:--fade-top={fadeTop ? 1 : 0}>
                <div class="scr" bind:this={scr} onscroll={onScr}>
                  <div class="ln cmd">$ {row.cmd}</div>
                  {#if out.cut}<div class="ln dim">{t('（前面还有 {n} 行）', { n: out.cut })}</div>{/if}
                  {#each out.lines as ln, i (i)}<div class="ln">{ln}</div>{/each}
                </div>
                <div class="term-foot">
                  <span class="st">{termState}</span>
                  {#if row.cwd}<span class="cwd" title={row.cwd}>{row.cwd}</span>{/if}
                  <span class="grow"></span>
                  {#if row.out}<button class="lnk" onclick={copyOut}>{copied ? t('已复制') : t('复制输出')}</button>{/if}
                </div>
              </div>
            {/if}
          {:else if row.kind === 'edit'}
            <div class="diffs">
              {#each row.files as f}
                {@const dl = diffLines(f.diff, f.type)}
                <div class="diff sq">
                  <div class="hd"><Icon name="file" class="mi-ico" /><b class="mono dpath" title={f.path}>{f.path}</b><span class="grow"></span><span class="a">+{f.a}</span><span class="d">−{f.d}</span></div>
                  <div class="dbody"><div class="dl">
                    {#each dl.lines as l}
                      <div class="l" class:add={l.s === '+'} class:del={l.s === '-'} class:hunk={l.s === '@'}><span class="n">{l.n ?? ''}</span><span class="s">{l.s === '+' ? '+' : l.s === '-' ? '−' : ''}</span><span class="t">{l.s === '@' ? '⋯' : l.t}</span></div>
                    {/each}
                  </div></div>
                  {#if dl.more}<div class="dmore">{t('还有 {n} 行没显示', { n: dl.more })}</div>{/if}
                </div>
              {/each}
            </div>
          {:else if row.kind === 'agent'}
            <div class="sub-log">
              {#if row.prompt}<div class="ln plain">{row.prompt}</div>{/if}
              {#each row.threads || [] as tid}
                {#if sessionOf(tid)}<button class="lnk sub-open" onclick={() => openThread(tid)}>{t('打开它的线程')} ›</button>{/if}
              {/each}
            </div>
          {:else if row.kind === 'image'}
            <button class="thumb sq" onclick={() => openFile(row.path)} title={row.path}><img src={codexArtifactUrl(sid, row.path, { name: baseName(row.path) })} alt="" loading="lazy" /></button>
          {:else if row.kind === 'review'}
            <p class="plain">{row.text}</p>
          {:else if view.out}
            <pre class="tool-out">{view.out}</pre>
          {/if}
        {/if}
      </div></div></div>
    {/if}
  </div>
{/if}

<style>
  /* 命令输出：demo 只是演示滚动，这里要真能翻；脚注不能被限高裁掉 */
  .term { max-height: none; }
  .term .scr { max-height: 150px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--fill4) transparent; }
  .term-foot .cwd { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); color: var(--fg4); }
  .term-foot .st { flex: none; }

  /* 等你批准：图标外一圈声纳（和侧栏状态列同一个节奏） */
  .row-ico.sonar::before { content: ""; position: absolute; left: 50%; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; box-shadow: 0 0 0 1.4px var(--fg); animation: cx-sonar calc(var(--k) * 1.7s) var(--ease-out) infinite; }

  .row-meta :global(svg) { flex: none; }
  .row-meta .lnk { font-size: 12px; }
  .row-meta .roll.secs { display: inline-flex; }

  /* 进度说明：正文小段，比回答小一号、淡一档 */
  .note-p.md { font-size: 13.5px; line-height: 1.6; color: var(--fg2); }
  .note-p.md :global(p) { margin: 0 0 6px; }
  .note-p.md :global(code) { font-size: .9em; }

  .nrow { padding: 3px 0; }
  .note .n-txt { overflow-wrap: anywhere; }

  .steer-in { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; max-width: 100%; }
  .msg-steer { transition: opacity var(--d-3); }
  .msg-steer.pending { opacity: .55; }
  .msg-steer.failed { opacity: .6; }
  .steer-fail { color: var(--fg3); font-size: 12px; }

  .files .fl { color: inherit; font: inherit; border-radius: 4px; }
  .files .fl:hover { color: var(--fg); text-decoration: underline; text-underline-offset: 3px; }

  .diffs { display: flex; flex-direction: column; gap: 8px; }
  .diff .hd .dpath { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; direction: rtl; text-align: left; }
  .diff .hd .a { color: var(--add); } .diff .hd .d { color: var(--del); }
  .dbody { overflow: auto; max-height: 360px; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--fill4) transparent; }
  .dl { display: grid; min-width: 100%; width: max-content; }
  .diff .l.hunk { color: var(--fg4); background: var(--fill1); }
  .dmore { padding: 4px 12px 6px; color: var(--fg3); font: 12px/1.5 var(--font); border-top: 1px solid var(--line1); }

  .sub-log .plain { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg2); }
  .sub-open { align-self: flex-start; margin-top: 2px; }

  .plain { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg3); font-size: 12.5px; line-height: 1.6; }
  .tool-out { margin: 0; max-height: 240px; overflow: auto; padding: 8px 10px; border-radius: 10px; background: var(--fill2); color: var(--fg2); font: 12px/1.6 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; scrollbar-width: thin; }

  .thumb { display: block; overflow: hidden; --r: 10px; border: 1px solid var(--line2); max-width: 240px; }
  .thumb img { display: block; max-width: 100%; max-height: 180px; object-fit: contain; }

  @container cx (max-width: 640px) {
    .term .scr { max-height: 120px; }
    .term-foot .cwd { display: none; }
  }
</style>
