<script>
  // Quick Ask —— 全局热键呼出的置顶输入条（桌面壳独有）。
  //
  // 语义定死三条：
  // ① 呼出=一次随手提问，回答【就地浮出】，需要完整上下文再「在主窗打开」升级；
  // ② Esc / 点到别处收起【不等于停止】——sse.js 的 abort 只断本地连接，服务端那一轮
  //    继续跑（缓冲还在），下次呼出或去主窗都能接上；
  // ③ 连着问=续聊同一个会话，「新话题」才另起一轮。
  import { onMount, tick } from 'svelte';
  import { startChat } from '../../lib/sse.js';
  import { renderMarkdown, streamBlocks } from '../../lib/md.js';
  import { t, tc, tr } from '../../lib/i18n.js';

  const desktop = typeof window !== 'undefined' ? window.BridgeDesktop : null;
  // 窗口标题（任务栏 / Alt+Tab 里看得到）：quick.html 里写死的是中文，英文界面在这里改写
  if (typeof document !== 'undefined') document.title = t('快速提问');

  let input = $state('');
  let sessionId = $state('');
  let status = $state('idle');        // idle | running | done | error
  let note = $state('');              // 「思考中」「正在用 Bash」这类一行状态
  let answer = $state({ md: '' });    // streamBlocks 的 memo 挂在这个对象上；换轮=换对象
  let errorText = $state('');
  let waitingAnswer = $state(false);  // 这一轮卡在 AskUserQuestion 上（浮窗答不了，得去主窗）
  let handle = null;

  let box;   // 根元素，量高度用
  let ta;    // 输入框

  const hasBody = $derived(Boolean(answer.md || note || errorText || status === 'running'));

  function reset(keepSession = true) {
    if (handle) { try { handle.stop(); } catch {} handle = null; }
    answer = { md: '' };
    note = '';
    errorText = '';
    waitingAnswer = false;
    status = 'idle';
    if (!keepSession) sessionId = '';
  }

  function onEvent(ev) {
    if (!ev) return;
    if (ev.sessionId) sessionId = ev.sessionId;
    switch (ev.type) {
      // 重连后 /api/attach 会从头重放整个缓冲，不清就渲染两遍（同 chat.svelte.js 的规矩）。
      case 'attach': answer = { md: '' }; note = ''; break;
      case 'session': break;
      case 'text': answer.md += ev.text || ''; note = ''; break;
      case 'thinking': if (!answer.md) note = t('思考中…'); break;
      case 'tool': note = ev.name ? t('正在用 {tool}', { tool: ev.name }) : t('正在用 工具'); break;
      case 'question':
      case 'offer':   // 「新会话还是在这里做」的卡（sessions MCP，调用阻塞等答）同理
        // 选择题在这条窄浮窗里答不好（选项可能很长）——交给主窗，这里只把路指出来。
        waitingAnswer = true;
        note = t('它问了你一个问题，去主窗回答');
        break;
      // 逐次工具审批 / 计划审批（lib/permissions.svelte.js）：同样去主窗处理；别处批完了就收起提示
      case 'perm_request': case 'plan_request': waitingAnswer = true; note = t('它在等你批准，去主窗处理'); break;
      case 'perm_answer': case 'plan_answer': waitingAnswer = false; note = ''; break;
      case 'error': status = 'error'; errorText = ev.message || ev.title || t('出错了'); note = ''; break;
      case 'done':
        if (!answer.md && ev.result) answer.md += ev.result;
        status = 'done';
        note = '';
        break;
    }
  }

  function submit() {
    const text = input.trim();
    if (!text || status === 'running') return;
    input = '';
    reset(true);
    status = 'running';
    const params = { message: text, agent: 'claude', client: 'web' };
    if (sessionId) params.sessionId = sessionId;
    handle = startChat(params, {
      onEvent,
      onError: (e) => {
        status = 'error';
        errorText = e?.status === 401 ? t('需要登录') : (e?.message || t('连接中断，请重试'));
      },
      onClose: () => { if (status === 'running') status = 'done'; },
      onReconnecting: () => { note = t('重连中…'); },
    });
  }

  function stopTurn() {
    if (handle) { try { handle.stop(); } catch {} handle = null; }
    status = 'done';
    note = '';
  }

  // 「在主窗打开」：先断本地直播（服务端那一轮不受影响），再让主窗接手同一个会话，
  // 免得两个窗口同时挂在一条流上。
  function escalate() {
    if (handle) { try { handle.stop(); } catch {} handle = null; }
    desktop?.quick?.escalate?.(sessionId || '');
  }

  function onKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); desktop?.quick?.close?.(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  }

  // 输入框自增高（最多五行），高度变化由下面的 ResizeObserver 一并报给主进程。
  function autoGrow() {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
  }

  // 窗口高度跟着内容走：主进程按 clamp 收窄到 [输入条, 620]。上报的是「卡片 + 四周那圈
  // 透明留白」——留白是投影的画布，少算一像素投影就会被窗口边缘切出硬边（见下面的 CSS 注释）。
  // 留白值只写在 CSS 里，这里现读现算，免得两边各写一个数悄悄对不上。
  function reportHeight() {
    if (!box) return;
    const pad = parseFloat(getComputedStyle(box.parentElement).paddingTop) || 0;
    desktop?.quick?.resize?.(Math.ceil(box.getBoundingClientRect().height + pad * 2));
  }

  onMount(() => {
    autoGrow();
    const ro = new ResizeObserver(reportHeight);
    ro.observe(box);
    // 每次呼出：聚焦并全选（接着上一句改词，或直接覆盖着打新的）。
    const offShow = desktop?.quick?.onShow?.(async () => {
      await tick();
      // 收起时主进程把窗口压回了输入条那么高，而卡片高度没变过 → ResizeObserver 不会再响，
      // 带着上一轮回答再呼出就会被切掉半截。所以每次呼出都补报一次当前高度。
      reportHeight();
      ta?.focus();
      ta?.select();
    });
    return () => { ro.disconnect(); offShow?.(); };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="qa" bind:this={box}>
  <div class="bar">
    <span class="dot" class:run={status === 'running'} class:err={status === 'error'}></span>
    <textarea
      bind:this={ta}
      bind:value={input}
      oninput={autoGrow}
      rows="1"
      placeholder={t('问点什么…  Enter 发送 · Esc 收起')}
      spellcheck="false"
    ></textarea>
    {#if status === 'running'}
      <button class="act" onclick={stopTurn} title={t('停止这一轮')}>{t('停止')}</button>
    {:else}
      <button class="act" onclick={submit} disabled={!input.trim()} title={t('发送（Enter）')}>{t('发送')}</button>
    {/if}
  </div>

  {#if hasBody}
    <div class="body">
      {#if note}<div class="note">{note}</div>{/if}
      {#if answer.md}
        <div class="answer sel-text">
          {#each streamBlocks(answer, answer.md) as blk}{@html renderMarkdown(blk)}{/each}
        </div>
      {/if}
      {#if errorText}<div class="err">{tr(errorText)}</div>{/if}
    </div>
    <div class="foot">
      <button class="link" class:hot={waitingAnswer} onclick={escalate}>
        {waitingAnswer ? t('去主窗回答 →') : t('在主窗打开 →')}
      </button>
      {#if sessionId}
        <button class="link" onclick={() => reset(false)}>{tc('claude', '新话题')}</button>
      {/if}
      <span class="spacer"></span>
      <span class="hint">{t('Esc 收起，这一轮继续在后台跑')}</span>
    </div>
  {/if}
</div>

<style>
  /* 透明窗口：body 的不透明底色（app.css 里的 var(--bg)）必须让位给圆角卡片本身，
     否则整块矩形会连同阴影区一起画成实心。 */
  :global(html), :global(body) { background: transparent !important; overflow: hidden; }
  /* app.css 给 #app 定的 height:100% + flex 是整页应用的骨架，搬到这个浮窗上是有害的：
     .qa 成了 flex item，窗口比内容矮时会被 shrink 压扁 → ResizeObserver 量到的是
     "压扁后"的高度 → 上报的目标高度永远等于当前高度 → 窗口再也长不起来（实测有回答
     时窗口仍停在 92px）。浮窗要的是内容撑开高度，所以退回 block。 */
  /* 卡片四周这圈透明留白【就是投影唯一的画布】：窗口只有「卡片 + 这圈留白」那么大，
     投影铺得比留白远，多出来的部分就被窗口矩形一刀切齐——浅色桌面上那是一块边缘锐利的
     灰方块（原来 12px 留白配 48px 模糊的投影，四边都被切在 alpha 19~36 上）。
     改这个数不用改 JS（上报高度现读 padding），但 main.cjs 的 QUICK_MIN_HEIGHT 要跟着走。 */
  :global(#app) { padding: 24px; display: block; height: auto; }

  .qa {
    border-radius: 18px;
    background: color-mix(in srgb, var(--card) 92%, transparent);
    -webkit-backdrop-filter: blur(30px) saturate(1.1);
    backdrop-filter: blur(30px) saturate(1.1);
    /* 投影的扩散范围必须 ≤ 上面那圈 24px：左右 = blur 18，上 = blur - y = 12，
       下 = blur + y = 24。这样最外圈才能自然衰减到全透明，不留硬边。 */
    box-shadow:
      0 6px 18px rgba(0, 0, 0, .34),
      0 2px 6px rgba(0, 0, 0, .18),
      0 0 0 .5px var(--divider);
    overflow: hidden;
  }

  .bar { display: flex; align-items: flex-start; gap: 10px; padding: 14px 14px 14px 16px; }
  .dot {
    width: 8px; height: 8px; margin-top: 7px; border-radius: 50%; flex: none;
    background: var(--muted); opacity: .5; transition: background-color .2s ease, opacity .2s ease;
  }
  .dot.run { background: var(--coral); opacity: 1; animation: pulse 1.3s ease-in-out infinite; }
  .dot.err { background: var(--crit); opacity: 1; }
  @keyframes pulse { 50% { opacity: .35; } }

  textarea {
    flex: 1; min-width: 0; resize: none; border: none; outline: none; background: none;
    color: var(--text); font: inherit; font-size: 15px; line-height: 1.5;
    max-height: 120px; overflow-y: auto;
  }
  textarea::placeholder { color: var(--muted); }

  .act {
    flex: none; padding: 5px 12px; border-radius: 999px; font-size: 13px;
    background: var(--hover); color: var(--text); transition: background-color .15s ease, opacity .15s ease;
  }
  .act:hover:not(:disabled) { background: var(--hover-strong); }
  .act:disabled { opacity: .4; cursor: default; }

  .body { max-height: 420px; overflow-y: auto; padding: 0 16px 12px; }
  .note { color: var(--muted); font-size: 13px; padding: 2px 0 8px; }
  .err { color: var(--crit); font-size: 13px; padding: 4px 0; }

  .answer { color: var(--text); font-size: 14.5px; line-height: 1.68; }
  /* markdown 由 md.js 渲染成 HTML 塞进来，选择器必须 :global 才不会被编译器剪掉 */
  .answer :global(p) { margin: 0 0 .7em; }
  .answer :global(p:last-child) { margin-bottom: 0; }
  .answer :global(ul), .answer :global(ol) { margin: 0 0 .7em; padding-left: 1.4em; }
  .answer :global(li) { margin: .2em 0; }
  .answer :global(h1), .answer :global(h2), .answer :global(h3) { font-size: 1.05em; margin: .9em 0 .4em; }
  .answer :global(code) {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .88em;
    background: var(--hover); padding: .12em .35em; border-radius: 5px;
  }
  .answer :global(pre) {
    background: var(--hover); padding: 10px 12px; border-radius: 10px;
    overflow-x: auto; margin: 0 0 .7em;
  }
  .answer :global(pre code) { background: none; padding: 0; }
  .answer :global(blockquote) {
    border-left: 2px solid var(--divider); padding-left: .8em; color: var(--serif); margin: 0 0 .7em;
  }
  .answer :global(a) { color: var(--coral); }
  .answer :global(table) { border-collapse: collapse; margin: 0 0 .7em; font-size: .92em; }
  .answer :global(th), .answer :global(td) { border: 1px solid var(--divider); padding: .3em .6em; }

  .foot {
    display: flex; align-items: center; gap: 14px;
    padding: 9px 16px; border-top: 1px solid var(--divider);
  }
  .link { font-size: 12.5px; color: var(--muted); transition: color .15s ease; }
  .link:hover { color: var(--text); }
  .link.hot { color: var(--coral); }
  .spacer { flex: 1; }
  .hint { font-size: 11.5px; color: var(--muted); opacity: .7; }
</style>
