<script>
  // 单轮消息视图（11-18 翻新）：用户气泡；助手消息按块顺序切成「步骤段」与「正文段」——
  // 连续的思考 / 工具调用并成一段步骤（StepGroup：两步以上折成一行汇总，点开看明细），正文照常排版；其后是审批卡、提问卡、交付物与错误重试。
  // 回答中间还可能夹着：中途插话（用户在它干活时又发的一条）、媒体进度卡（生成图片 / 视频时读秒，生成完原地换成成品）。
  import { renderMarkdown, renderStreamingMarkdown, streamBlocks } from '../../lib/md.js';
  import { onMdClick } from '../../lib/linkNav.js';
  import { agyArtifactUrl, openPreview } from '../../lib/preview.svelte.js';
  import { attDragSrc } from '../../lib/dragOut.js';
  import { attLook } from '../../lib/agy/attach-look.js';
  import { relativeToWorkspace } from '../../lib/agy/workspace-logic.js';
  import { resolveAgyLocalLink } from '../../lib/agy/logic.js';
  import { agy, locateAgyFileInWorkspace, sendAgyMessage } from '../../lib/agy/store.svelte.js';
  import { openAgyAgentsPanel } from '../../lib/dock.svelte.js';
  import { agySubagents, isMultiAgentTool, isSwarmTool, matchSendMessageToSubagent } from '../../lib/agy/subagents.svelte.js';
  import { agySwarm } from '../../lib/agy/swarm.svelte.js';
  import { t, tr } from '../../lib/i18n.js';
  import { untrack } from 'svelte';
  import { claudeFade } from '../../lib/claudeFade.js';
  import { emphDecel, standard } from '../../lib/agy/motion.js';
  import StepGroup from './StepGroup.svelte';
  import { slide } from 'svelte/transition';
  import { layout } from '../../lib/layout.svelte.js';
  import WidgetFrame from '../claude/WidgetFrame.svelte';
  import { widgetSegOf } from '../../lib/agy/widget.js';
  import { mediaSegOf, inlineMediaPaths, pathKey } from '../../lib/agy/media.js';
  import { relayedMessage } from '../../lib/agy/relay.js';
  import AgyMediaCard from './AgyMediaCard.svelte';
  import AgySubagentCard from './AgySubagentCard.svelte';
  import AgySwarmCard from './AgySwarmCard.svelte';
  import PermissionCard from './PermissionCard.svelte';
  import QuestionCard from './QuestionCard.svelte';
  import AgyTurnFoot from './AgyTurnFoot.svelte';
  import AgyAttachment from './AgyAttachment.svelte';

  const {
    msg,
    sessionId = '',
    sessionCwd = '',
    isLast = false,
    reconnecting = false,
    onRetry = null,
  } = $props();

  // 吐字（11-19）：复用 Claude 页的「先排版后显形」引擎（lib/claudeFade.js：抖动缓冲匀速播放、表格整行到齐），
  // 换成 Google 系的显形质感——每个字由虚到实「凝」出来：0.62s 内透明度走 emphasized decelerate（先快后缓），
  // 虚化从 5px 按 standard 曲线收干净；写头因此是一小段柔焦的光晕，而不是一刀切的边。
  const AGY_FX = { dur: 620, ease: emphDecel, blur: 5, blurEase: (p) => 1 - standard(p) };

  // 刚发出的这条（本地 id = 'u-<时间戳>'）：气泡从输入框方向升上来；打开历史 / 重连补发的不演
  const freshUser = untrack(() => msg.role === 'user' && /^u-\d+$/.test(String(msg.id || '')) && Date.now() - Number(String(msg.id).slice(2)) < 2500);
  const live = $derived(msg.status === 'streaming');
  // bridge 自动转进来的消息（子会话汇报、会话间消息、CI 事件）：不是用户本人打的，收成一行说明
  const relayed = $derived(msg.role === 'user' ? relayedMessage(msg.text) : null);
  const relayLabel = $derived(!relayed ? '' : relayed.kind === 'ci' ? t('bridge 转来：拉取请求的检查结果') : relayed.kind === 'report' ? t('bridge 转来：子会话的汇报') : t('bridge 转来的消息'));

  let copied = $state(false);
  let copyTimer = null;
  const pendingPermissions = $derived(
    Array.isArray(msg.permissions) ? msg.permissions.filter((p) => p.status === 'pending') : []
  );

  // 连续的 thinking / tool 块并成一个步骤段，text 块与多代理卡片单独内联成段（不重复叠一层单行工具步骤）
  const segments = $derived.by(() => {
    const out = [];
    const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
    const tools = blocks.filter((b) => b.type === 'tool').map((b) => b.tool);
    const swarmTools = tools.filter(isSwarmTool);
    const subTree = agySubagents.sessionId === sessionId ? agySubagents.tree : null;
    const hasSessionSwarm = Boolean(agySwarm.sessionId === sessionId && agySwarm.data?.hasSwarm);
    const shownAgentIds = new Set();
    let emittedSwarmCard = false;
    blocks.forEach((blk, bi) => {
      if (blk.type === 'text') {
        out.push({ kind: 'text', key: 't' + bi, bi, blk });
        return;
      }
      if (blk.type === 'steer') {
        out.push({ kind: 'steer', key: 'u' + (blk.id || bi), blk });
        return;
      }
      if (blk.type !== 'thinking' && blk.type !== 'tool') return;
      // Native Swarm 创建/加人操作：整条消息聚合为一张 AgySwarmCard，避免拉多名成员时连续刷出多张占位卡
      if (blk.type === 'tool' && String(blk.tool?.name || '').toLowerCase() === 'swarm') {
        const act = String(blk.tool?.args?.action || '').toLowerCase();
        if (act === 'add' || act === 'title') {
          if (!emittedSwarmCard) {
            emittedSwarmCard = true;
            out.push({ kind: 'swarm', key: 'sw-' + bi, swarmTools });
          }
          return;
        }
      }
      // 多代理 / 子代理派出（排除已用媒体卡的生图子代理）：直接以行内卡片嵌入对话流，不再在上方重复画单行步骤
      if (blk.type === 'tool' && isMultiAgentTool(blk.tool)) {
        out.push({ kind: 'subagent', key: 'ag' + bi, tool: blk.tool, msgTools: tools });
        return;
      }
      const last = out[out.length - 1];
      if (last && last.kind === 'steps') last.items.push({ bi, blk });
      else out.push({ kind: 'steps', key: 's' + bi, items: [{ bi, blk }] });
      // bridge 工具中枢的内嵌图表（visualize_show_widget）：步骤里留一行，图表本身紧跟着画进对话
      const w = blk.type === 'tool' ? widgetSegOf(blk.tool) : null;
      if (w) out.push({ kind: 'widget', key: 'w' + bi, seg: w });
      // 生成媒体的工具调用：步骤里留一行，进度卡 / 成品紧跟着摆进对话
      const m = blk.type === 'tool' ? mediaSegOf(blk.tool, { tools, live: msg.status === 'streaming' }) : null;
      if (m) out.push({ kind: 'media', key: 'm' + bi, seg: m });
      // 后续轮次操作消息板或 Swarm 状态时，原地附一张聚合 Swarm 状态卡（同条消息只出一次）
      if (blk.type === 'tool' && !emittedSwarmCard && hasSessionSwarm && isSwarmTool(blk.tool)) {
        emittedSwarmCard = true;
        out.push({ kind: 'swarm', key: 'sw-live-' + bi, swarmTools });
      }
      // 后续轮次里通过 send_message 续联已知子代理团队时，就地附一张团队状态卡（同条消息内按代理去重）
      const targetSub = blk.type === 'tool' ? matchSendMessageToSubagent(blk.tool, subTree) : null;
      if (targetSub && targetSub.id && !shownAgentIds.has(targetSub.id)) {
        shownAgentIds.add(targetSub.id);
        out.push({ kind: 'subagent', key: 'ag-msg-' + bi, tool: blk.tool, msgTools: tools });
      }
    });
    return out;
  });
  // 等的是别的后台子代理（不是生图，没有进度卡）时，在回答末尾留一行「还在等」
  const waitingAgents = $derived(
    msg.background && !(msg.background.agents || []).some((a) => a.kind === 'image') ? (msg.background.agents || []).length : 0
  );

  // 图表里的 sendPrompt：当作用户消息发给 Antigravity；在跑或正在切会话时发不了（卡下提示「未发送」）。
  // sendAgyMessage 会清空输入框——用户正在写的草稿先存下、发出后原样放回。
  function sendWidgetPrompt(text) {
    if (agy.busy || agy.loadingSession) return false;
    const keepText = agy.draftText;
    const keepAtts = agy.draftAtts;
    const pending = sendAgyMessage(text, []);
    agy.draftText = keepText;
    agy.draftAtts = keepAtts;
    return pending.then(() => true, () => false);
  }

  // 点开一个文件（交付物卡、正文里的文件链接）：和 Claude 页一样进右侧工作区——文件页落到它所在的目录、
  // 面板里直接打开预览；不在会话目录里的（上传目录等）以它的父目录为根挂载。定位不了才回落全屏查看器。
  function openInWorkspace(filePath, name = '') {
    if (!filePath) return false;
    if (locateAgyFileInWorkspace(filePath, { openFile: true })) return true;
    openPreview({
      origin: 'agy',
      id: sessionId,
      path: filePath,
      name: name || filePath.split(/[\\/]/).pop() || t('文件'),
    });
    return true;
  }

  function handleInternalLink(rawHref) {
    if (/^https?:\/\//i.test(rawHref)) {
      try {
        const u = new URL(rawHref);
        const p = u.searchParams.get('path');
        if (p) return openInWorkspace(p, u.searchParams.get('name') || '');
      } catch {}
    }
    const resolved = resolveAgyLocalLink(rawHref, sessionCwd);
    if (!resolved) return false;
    return openInWorkspace(resolved);
  }

  // 用户自己发的附件：会话目录里的文件 / 文件夹在工作区里定位；上传来的图片、视频、文件不在工作区里，用查看器看。
  function openUserAtt(att) {
    if (att.kind === 'folder') { if (att.path) locateAgyFileInWorkspace(att.path); return; }
    if (att.path && sessionCwd && relativeToWorkspace(att.path, sessionCwd) !== null) {
      openInWorkspace(att.path, att.name);
      return;
    }
    const look = attLook(att);
    if (att.url && !att.path) {
      openPreview({
        origin: 'url',
        url: att.url,
        name: att.name || 'image.png',
        kind: look.media || att.kind || 'image',
      });
    } else if (att.path) {
      openPreview({
        origin: 'agy',
        id: sessionId,
        path: att.path,
        name: att.name || att.path.split(/[\\/]/).pop(),
      });
    }
  }

  function openDeliverable(att) {
    if (att?.path) openInWorkspace(att.path, att.name);
  }

  // 附件分两排：能出预览图的（图片 / 视频）在上，其余文件卡在下——高矮不一的东西不混在一行里
  const splitRows = (list) => {
    const all = Array.isArray(list) ? list : [];
    return [all.filter((a) => attLook(a).media), all.filter((a) => !attLook(a).media)];
  };
  // 进度卡上已经摆出来的成品，底部的交付物里不再摆第二遍
  const shownInline = $derived(inlineMediaPaths(segments.map((s) => s.seg)));
  // 手机档：这一轮做完后步骤行（思考 / 工具调用的汇总）整段收走，只留回答——窄屏上它被截成半句，做完了也没人再看；
  // 要翻过程去工作区的「活动」「审阅」。在跑、被停下、出错时照常留着；整条回答只有步骤（没有正文）时也留着，免得一片空白。
  const stepsGone = $derived(layout.compact && msg.status === 'done' && segments.some((s) => s.kind !== 'steps'));
  const delivRows = $derived(splitRows((Array.isArray(msg.attachments) ? msg.attachments : []).filter((a) => !shownInline.has(pathKey(a.path)))));
  const userRows = $derived(splitRows(msg.atts));

  async function copyAnswer() {
    if (!msg.md) return;
    try {
      await navigator.clipboard.writeText(msg.md);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = msg.md;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    copied = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied = false; }, 1500);
  }
</script>

{#if relayed}
  <details class="agy-msg agy-relay">
    <summary><span class="rl-t">{relayLabel}</span>{#if relayed.peek}<span class="rl-p">{relayed.peek}</span>{/if}</summary>
    <div class="rl-body sel-text">{relayed.body}</div>
  </details>
{:else if msg.role === 'user'}
  <div class="agy-msg user">
    {#if Array.isArray(msg.atts) && msg.atts.length > 0}
      <div class="agy-user-atts">
        {#each userRows as row, ri (ri)}
          {#if row.length > 0}
            <div class="agy-user-row">
              {#each row as att, ai (ai)}
                <AgyAttachment
                  {att}
                  {sessionId}
                  variant="user"
                  solo={ri === 0 && row.length === 1}
                  onopen={att.url || att.path ? openUserAtt : null}
                  drag={() => attDragSrc(att)}
                />
              {/each}
            </div>
          {/if}
        {/each}
      </div>
    {/if}

    {#if msg.text}
      <div class="agy-user-bubble sel-text" class:sent={freshUser}>{msg.text}</div>
    {/if}
  </div>
{:else}
  <div class="agy-msg ai">
    {#if !isLast && msg.status === 'streaming' && msg.blocks.length === 0 && !msg.permissions?.length && !msg.questions?.length}
      <div class="agy-wait-row">
        <span class="agy-pulse-dot"></span>
        <span>{t('正在思考…')}</span>
      </div>
    {/if}

    {#each segments as seg (seg.key)}
      {#if seg.kind === 'steps'}
        {#if !stepsGone}
          <div class="agy-steps-slot" out:slide={{ duration: 260 }}>
            <StepGroup items={seg.items} {msg} {sessionId} />
          </div>
        {/if}
      {:else if seg.kind === 'widget'}
        <div class="agy-widget">{#key seg.seg.id}<WidgetFrame seg={seg.seg} live={msg.status === 'streaming'} sendPrompt={sendWidgetPrompt} />{/key}</div>
      {:else if seg.kind === 'media'}
        <AgyMediaCard seg={seg.seg} {sessionId} onopen={openDeliverable} />
      {:else if seg.kind === 'swarm'}
        <AgySwarmCard swarmTools={seg.swarmTools} {sessionId} />
      {:else if seg.kind === 'subagent'}
        <AgySubagentCard tool={seg.tool} msgTools={seg.msgTools} />
      {:else if seg.kind === 'steer'}
        {@const rows = splitRows(seg.blk.atts)}
        <div class="agy-steer">
          {#if rows[0].length + rows[1].length > 0}
            <div class="agy-user-atts">
              {#each rows as row, ri (ri)}
                {#if row.length > 0}
                  <div class="agy-user-row">
                    {#each row as att, ai (ai)}
                      <AgyAttachment
                        {att}
                        {sessionId}
                        variant="user"
                        solo={ri === 0 && row.length === 1}
                        onopen={att.url || att.path ? openUserAtt : null}
                        drag={() => attDragSrc(att)}
                      />
                    {/each}
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
          {#if seg.blk.text}
            <div class="agy-user-bubble sel-text" class:sent={live}>{seg.blk.text}</div>
          {/if}
        </div>
      {:else}
        {@const blk = seg.blk}
        {@const liveText = msg.status === 'streaming' && seg.bi === msg.blocks.length - 1}
        {@const chunks = liveText ? streamBlocks(blk, blk.text) : [blk.text]}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="agy-md sel-text" use:claudeFade={{ key: (msg.id || '') + ':' + seg.key, live: liveText, fx: AGY_FX }} onclick={(e) => onMdClick(e, handleInternalLink)}>{#each chunks as chunk, ci (ci)}{@const isTail = liveText && ci === chunks.length - 1}{@html isTail ? renderStreamingMarkdown(chunk) : renderMarkdown(chunk)}{/each}</div>
      {/if}
    {/each}

    {#if waitingAgents > 0}
      <button type="button" class="agy-wait-row agy-wait-btn" onclick={() => openAgyAgentsPanel()}>
        <span class="agy-pulse-dot"></span>
        <span>{t('后台子代理还在跑，回报到了会接着说…')}</span>
        <span class="msr agy-wait-chev" aria-hidden="true">expand_more</span>
      </button>
    {/if}

    {#if pendingPermissions.length > 0}
      {#each pendingPermissions as perm (perm.requestId)}
        <div class:agy-rise={live}><PermissionCard {perm} {sessionCwd} /></div>
      {/each}
    {/if}

    {#if Array.isArray(msg.questions) && msg.questions.length > 0}
      {#each msg.questions as qItem (qItem.requestId)}
        <div class:agy-rise={live}><QuestionCard question={qItem} /></div>
      {/each}
    {/if}

    {#if delivRows[0].length + delivRows[1].length > 0}
      <div class="agy-deliverables" class:agy-rise={isLast}>
        {#each delivRows as row, ri (ri)}
          {#if row.length > 0}
            <div class="agy-deliv-row" class:files={ri === 1}>
              {#each row as att (att.path)}
                {@const dlSrc = agyArtifactUrl(sessionId, att.path, { dl: true, name: att.name })}
                <AgyAttachment
                  {att}
                  {sessionId}
                  variant="deliv"
                  solo={ri === 0 && row.length === 1}
                  onopen={openDeliverable}
                  download={dlSrc}
                  drag={() => attDragSrc({ path: att.path, name: att.name, downloadUrl: dlSrc })}
                />
              {/each}
            </div>
          {/if}
        {/each}
      </div>
    {/if}

    {#if msg.status === 'interrupted' && !isLast}
      <div class="agy-interrupted">{t('已停止')}</div>
    {/if}

    {#if msg.status === 'error'}
      <div class="agy-err-banner" class:agy-rise={isLast}>
        <span class="msr4">error</span>
        <span class="err-txt sel-text">{tr(msg.error) || t('请求执行失败')}</span>
        {#if onRetry}
          <button type="button" class="agy-err-retry" onclick={onRetry}>
            <span>{t('重试')}</span>
          </button>
        {/if}
      </div>
    {/if}

    {#if msg.status !== 'streaming' && (msg.md || (isLast && onRetry))}
      <div class="agy-ai-foot" class:arrive={isLast}>
        {#if msg.md}
          <button type="button" class="agy-act-btn" onclick={copyAnswer} title={t('复制回复')} aria-label={t('复制回复')}>
            <span class="msr">{copied ? 'check' : 'content_copy'}</span>
          </button>
        {/if}
        {#if isLast && onRetry}
          <button type="button" class="agy-act-btn" onclick={onRetry} title={t('重新生成')} aria-label={t('重新生成')}>
            <span class="msr">replay</span>
          </button>
        {/if}
      </div>
    {/if}

    {#if isLast}
      <AgyTurnFoot {msg} {sessionCwd} {reconnecting} />
    {/if}
  </div>
{/if}

<style>
  .agy-msg { display: flex; flex-direction: column; }
  .agy-msg:not(:last-child) { margin-bottom: 26px; }

  /* —— 用户消息：右侧浅底气泡 —— */
  .agy-msg.user { align-items: flex-end; gap: 6px; }
  .agy-user-atts {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: min(85%, 620px);
  }
  .agy-user-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }
  /* 刚发出的气泡：从输入框方向升上来、略带放大落位（emphasized decelerate），右下角为原点 */
  .agy-user-bubble.sent {
    transform-origin: 100% 100%;
    animation: agy-sent 0.5s cubic-bezier(0.05, 0.7, 0.1, 1) backwards;
  }
  @keyframes agy-sent {
    from { opacity: 0; transform: translateY(26px) scale(0.94); }
    40% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .agy-user-bubble.sent { animation: none; }
  }
  /* 吐字引擎：还没轮到的字与盒子先隐形（排版已定，显形只改透明度 / 虚化） */
  .agy-md :global(.c-wait) { opacity: 0; }
  .agy-user-bubble {
    max-width: min(85%, 620px);
    padding: 10px 16px;
    /* 大圆角 + 右上（靠发送者一侧）一个小角：Gemini 的气泡形状 */
    border-radius: 22px 6px 22px 22px;
    background: var(--ag-bubble-bg);
    color: var(--ag-bubble-on);
    font-size: var(--ag-msg-size, 15px);
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* —— bridge 转来的消息：一行淡字，点开看全文 —— */
  .agy-relay { display: block; font-size: 12.5px; color: var(--ag-on-faint); }
  .agy-relay summary {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    cursor: pointer;
    list-style: none;
    padding: 4px 0;
  }
  .agy-relay summary::-webkit-details-marker { display: none; }
  .agy-relay .rl-t { flex: none; color: var(--ag-on-dim); }
  .agy-relay .rl-p { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agy-relay[open] .rl-p { display: none; }
  .agy-relay .rl-body {
    margin-top: 4px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--ag-surface-1);
    color: var(--ag-on-dim);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.55;
    max-height: 320px;
    overflow: auto;
  }

  /* —— 助手消息：步骤段（思考 + 工具）紧凑成行，正文段正常排版 —— */
  .agy-msg.ai { gap: 10px; }
  .agy-steps-slot { display: flex; flex-direction: column; min-width: 0; }
  /* 中途插话：夹在回答中间的用户消息，画法与用户气泡一致，上下各让出一段，读起来是「又一问」而不是回答的一部分 */
  .agy-steer {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    margin: 10px 0;
  }
  .agy-wait-row {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 28px;
    color: var(--ag-on-dim);
    font-size: 13px;
  }
  .agy-wait-btn {
    align-self: flex-start;
    padding: 0 8px 0 4px;
    border-radius: 8px;
  }
  .agy-wait-btn:hover { background: var(--ag-hover); color: var(--ag-on); }
  .agy-wait-chev { font-size: 16px; transform: rotate(-90deg); color: var(--ag-on-faint); }
  .agy-pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ag-accent);
    animation: agy-pulse 1.2s ease-in-out infinite;
  }
  @keyframes agy-pulse { 50% { opacity: 0.3; transform: scale(0.8); } }

  /* —— 交付物：预览图一排、文件卡一排（画法在 AgyAttachment） —— */
  .agy-deliverables {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .agy-deliv-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  /* 文件卡排成等宽的格子：几张卡上下对齐，不随名字长短参差 */
  .agy-deliv-row.files {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(208px, 1fr));
  }
  .agy-deliv-row.files :global(.aa-card) {
    min-width: 0;
    max-width: none;
  }

  /* —— 状态 —— */
  .agy-interrupted {
    font-size: 12.5px;
    color: var(--ag-on-faint);
  }
  .agy-err-banner {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--ag-err-bg);
    color: var(--ag-err);
    font-size: 13px;
    line-height: 1.5;
  }
  .agy-err-banner .msr4 { font-size: 18px; margin-top: 1px; }
  .err-txt { flex: 1; min-width: 0; word-break: break-word; }
  .agy-err-retry {
    flex: none;
    height: 26px;
    padding: 0 10px;
    border-radius: 13px;
    font-size: 12.5px;
    color: var(--ag-err);
    border: 1px solid var(--ag-err-bd) !important;
  }
  .agy-err-retry:hover { background: var(--ag-err-bg); }

  .agy-ai-foot {
    display: flex;
    gap: 2px;
    margin: -4px 0 0 -6px;
  }
  /* 收尾时复制 / 重新生成两颗键淡入，不是和最后一个字同一帧蹦出来 */
  .agy-ai-foot.arrive { animation: agy-foot-arrive 0.36s cubic-bezier(0.2, 0, 0, 1) 0.12s backwards; }
  @keyframes agy-foot-arrive { from { opacity: 0; transform: translateY(-3px); } }
  .agy-act-btn {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-faint);
  }
  .agy-act-btn:hover { background: var(--ag-hover); color: var(--ag-on); }
  .agy-act-btn .msr { font-size: 16px; }
</style>
