<script>
  // 「聊天快照」页（/c/<token>，QQ 群 /chat）——bridge Claude 分页的阉割版：没有侧栏/
  // 会话列表/项目/设置，只有对话本身。流式渲染（Thread）、输入与模型/effort 选择器
  //（Composer 原样复用，用户自己选档）、附件卡、AskUserQuestion 卡全部白拿；
  // 所有 /api 请求经 apiUrl() 自动带 ?ct=（lib/csnap.js）。
  //
  // boot：查 /api/csnap/meta → active 则加载既有会话历史 + 镜像在跑轮（链接公开、多人
  // 共聊：别的访客发起的轮实时镜像到本屏，复用 mirrorActiveTurn）；closed/expired 出落地态。
  // Claude 调 close_snapshot 时后端广播 snap_closed → 立即切「已关停」。
  import { onMount } from 'svelte';
  import Composer from './Composer.svelte';
  import Thread from './Thread.svelte';
  import ClaudeLogo from './ClaudeLogo.svelte';
  import TopBar from './TopBar.svelte';
  import MediaViewer from './preview/MediaViewer.svelte';
  import ClaudeDock from './dock/ClaudeDock.svelte';
  import { api } from '../lib/api.js';
  import { loadCaps } from '../lib/caps.js';
  import { caps, ui, session } from '../lib/state.svelte.js';
  import { chat, loadSession, mirrorActiveTurn, onSnapClosed } from '../lib/chat.svelte.js';
  import { dock, openDock, closeDock, useSnapDock } from '../lib/dock.svelte.js';
  import { layout } from '../lib/layout.svelte.js';
  import { t, tc, tr } from '../lib/i18n.js';

  // 'boot' 加载中 | 'active' 可聊 | 'closed' 被 Claude 关停 | 'expired' 过期 | 'gone' 不存在
  let state = $state('boot');
  let closedReason = $state('');
  // 对话进行中被关停/过期：保留已渲染的对话（Claude 的最后说明还在流），只把输入框
  // 换成横幅；整页落地态（state 切换）留给「进页即死」与刷新后的 /c/ 服务端落地页。
  let softDead = $state('');   // '' | 'closed' | 'expired'

  let scrollEl = $state();
  let composerWrapEl = $state();

  // 快照页无主页/抽屉概念，但共享的 chat 控制器读 ui.view（greeting/chat）——照常驱动。
  ui.screen = 'claude';

  // —— 右侧工作台（快照版：审阅 / 文件 / 只读浏览器，没有终端）——
  // ws 由服务端锁死在本快照的桶目录，前端只放占位；宽屏与对话分栏、窄屏底部 sheet。
  useSnapDock();
  // 侧列形态门槛＝layout.side（折叠屏展开 ~750px 也算），断点单源见 lib/layout.svelte.js。
  const wide = $derived(layout.side);
  function toggleDock() { if (dock.open) closeDock(); else openDock(dock.view === 'menu' ? 'menu' : dock.view); }

  async function refreshMeta() {
    try {
      const m = await api.get('/api/csnap/meta');
      if (m.status === 'active') return m;
      if (m.reason) closedReason = m.reason;
      const dead = m.status === 'closed' ? 'closed' : (m.status === 'expired' ? 'expired' : 'gone');
      // 屏上已有对话 → 软关停（保留对话 + 横幅）；否则整页落地态。gone（桶已删）一律整页。
      if (dead !== 'gone' && state === 'active' && chat.messages.length) softDead = dead;
      else state = dead;
      return null;
    } catch { return null; }   // 网络抖动：维持现态，别把活页误判成 gone
  }

  onMount(() => {
    let metaTimer, mirrorTimer;
    (async () => {
      try { caps.data = await loadCaps(); caps.loaded = true; } catch {}
      const m = await refreshMeta();
      if (!m) { if (state === 'boot') state = 'gone'; return; }
      // 分群设置：本快照禁用 Fable → 从模型选择器过滤掉整个 Fable 5.x 档（claude-fable-5 /
      // claude-fable-5-1；服务端也会拦，双保险）。用新对象替换而非改动 window.__CAPS__，只影响
      // 这个快照页。必须在 state='active'（Composer 挂载）之前完成，避免选择器先带着 Fable 闪一下。
      const isFable = (x) => /^claude-fable-5/.test(x.id);
      if (!m.fable5 && caps.data?.claude?.models?.some(isFable)) {
        caps.data = { ...caps.data, claude: { ...caps.data.claude, models: caps.data.claude.models.filter((x) => !isFable(x)) } };
      }
      state = 'active';
      // 房间既有对话：加载历史（loadSession 置 ui.view='chat'）；没有就停在 greeting。
      if (m.sessionId) {
        session.id = m.sessionId;
        try { await loadSession(m.sessionId); } catch {}
      }
      // 在跑的轮（自己刷新回来 / 别的访客正在问）→ 立刻挂直播镜像；此后每 4s 探一次。
      try { await mirrorActiveTurn(); } catch {}
      mirrorTimer = setInterval(() => { if (!document.hidden && state === 'active') mirrorActiveTurn(); }, 4000);
      // 兜底探活：过期/别处关停时页面及时切态（60s 粒度足够）。
      metaTimer = setInterval(async () => { if (state === 'active' && !session.busy) await refreshMeta(); }, 60000);
    })();
    const offClosed = onSnapClosed((reason) => { closedReason = reason; softDead = 'closed'; });
    return () => { clearInterval(metaTimer); clearInterval(mirrorTimer); offClosed(); };
  });

  // 输入卡悬浮：量高度垫进滚动区底部（与 ClaudePage 同款）。
  $effect(() => {
    if (!composerWrapEl || !scrollEl) return;
    const ro = new ResizeObserver(() => {
      scrollEl?.style.setProperty('--composer-h', composerWrapEl.offsetHeight + 'px');
    });
    ro.observe(composerWrapEl);
    return () => ro.disconnect();
  });

  // 贴底滚动（与 ClaudePage 同款：新消息/切数组强制滚底，其余仅在已贴底时跟随）。
  let atBottom = $state(true);
  let lastCount = 0;
  let lastArrRef = chat.messages;
  function onScroll() { if (scrollEl) atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 120; }
  $effect(() => {
    const arr = chat.messages;
    const n = arr.length;
    const m = arr[n - 1];
    let _ = 0;
    if (m && m.role === 'assistant') { _ = m.thinking.length + m.segments.length; const last = m.segments[m.segments.length - 1]; if (last && last.kind === 'text') _ = last.md.length; }
    const swapped = arr !== lastArrRef; lastArrRef = arr;
    if (swapped) atBottom = true;
    const newMsg = n > lastCount || swapped; lastCount = n;
    if (scrollEl && (newMsg || atBottom)) requestAnimationFrame(() => { scrollEl.scrollTop = scrollEl.scrollHeight; });
  });

  const DEAD = {
    closed: { icon: '⛔', title: t('快照已被关停'), sub: t('Claude 判定该快照被恶意使用，已将其关停。') },
    expired: { icon: '⏳', title: t('快照已过期'), sub: t('超过 1 小时没有新消息，这个对话快照已自动销毁。') },
    gone: { icon: '👋', title: t('快照不存在'), sub: t('这个对话快照不存在或已销毁。') },
  };
</script>

<div class="snap-root" class:wide={wide && state === 'active' && dock.open}>
  {#if state === 'active'}
    <!-- 右上悬浮控件，直接复用 Claude 分页的 TopBar（去掉汉堡）：宽屏＝工具开关组（审阅 / 浏览器 · ⋮），
         挂在根上、工作台展开时坐在卡片上方那条带里；窄屏＝明暗 + 两点键胶囊。
         绝对定位按根的 padding 盒算、不吃 .snap-root 的 padding-top，所以这里要自己加安全区（sat 默认开）。 -->
    <TopBar hideMenu tools={wide} onDock={toggleDock} />
    <div class="col">
    <div class="stage">
      {#if ui.view === 'greeting'}
        <main class="hero">
          <div class="greeting">
            <span class="snap-hero-logo"><ClaudeLogo anim="static" size={30} interactive /></span>
            <h1>Hey there</h1>
          </div>
          <div class="hero-composer"><Composer placeholder={tc('claude', '想问什么都可以…')} /></div>
          <p class="hero-note">{t('这是一个临时对话空间 · 超过 1 小时没有新消息会自动销毁 · 链接对群内公开，勿发隐私内容')}</p>
        </main>
      {:else}
        <div class="scroll" bind:this={scrollEl} onscroll={onScroll}><Thread /></div>
        <div class="composer-wrap" bind:this={composerWrapEl}>
          <div class="composer-inner">
            {#if softDead}
              <div class="dead-banner">{softDead === 'closed' ? (closedReason ? t('⛔ 此快照已被 Claude 关停：{reason}', { reason: tr(closedReason) }) : t('⛔ 此快照已被 Claude 关停')) : t('⏳ 快照已过期，超过 1 小时没有新消息')}</div>
            {:else}
              <Composer placeholder={tc('claude', '发消息…')} />
            {/if}
          </div>
        </div>
      {/if}
    </div>
    </div>
    <ClaudeDock {wide} />
  {:else if state === 'boot'}
    <div class="dead"><div class="dead-card"><p class="dead-sub">{t('加载中…')}</p></div></div>
  {:else}
    <div class="dead">
      <div class="dead-card">
        <div class="dead-icon">{DEAD[state].icon}</div>
        <h2>{DEAD[state].title}</h2>
        <p class="dead-sub">{DEAD[state].sub}</p>
        {#if state === 'closed' && closedReason}<p class="dead-reason">{t('原因：{reason}', { reason: tr(closedReason) })}</p>{/if}
        <p class="dead-hint">{t('在群里 @机器人 发送 /chat 可以新开一个对话。')}</p>
      </div>
    </div>
  {/if}
</div>
<MediaViewer />
<!-- Agent / Workflow 卡片点开的任务详情住在上面 ClaudeDock 的「任务」视图里：快照页的 Thread 同样会渲染
     子 agent 行——Workflow 工具对访客已在服务端禁掉（disallowedTools），但历史里的卡片仍要能点开。 -->

<style>
  /* 顶栏已去除：安全区顶距挪到根容器，内容不顶进状态栏（hero 绝对定位于 stage、scroll 常规流，都随之下移）。 */
  .snap-root { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--bg); color: var(--text);
    padding-top: var(--sat, 0px); padding-bottom: var(--kb, 0px); }
  /* 宽屏且工作台开着：对话列 + 工作台列并排（窄屏工作台是覆盖式底部 sheet，不占位） */
  .snap-root.wide { flex-direction: row; }
  .col { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }

  .stage { flex: 1; position: relative; min-height: 0; display: flex; flex-direction: column; }
  .hero { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
    padding: 13vh 16px 24px; }
  .greeting { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
  .snap-hero-logo { display: inline-flex; flex: none; }
  .greeting h1 { font-family: var(--serif-stack); font-weight: 290; font-size: 27px; line-height: 1.12; color: var(--serif); }
  .hero-composer { width: 100%; max-width: 760px; }
  .hero-note { margin-top: 16px; max-width: 560px; text-align: center; color: var(--muted); font-size: 12px; line-height: 1.7; padding: 0 10px; }

  .scroll { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-bottom: calc(var(--composer-h, 84px) + 8px); }
  /* 正文滚条=Claude 分页同款 6px 细滚条（只用 webkit 伪元素——别设标准 scrollbar-width/
     scrollbar-color，Chromium 里标准属性一出现伪元素即整体失效） */
  .scroll::-webkit-scrollbar { width: 6px; }
  .scroll::-webkit-scrollbar-track { background: transparent; }
  .scroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 38%, transparent); border-radius: 999px; }
  @media (hover: hover) { .scroll::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--muted) 62%, transparent); } }
  .composer-wrap { position: absolute; left: 0; right: 0; bottom: 0; z-index: 5;
    padding: 6px 8px max(10px, var(--sab, 0px)); background: transparent; pointer-events: none; }
  .composer-inner { max-width: 760px; margin: 0 auto; pointer-events: auto; }

  .dead-banner { background: var(--card); border-radius: 18px; box-shadow: var(--card-shadow); padding: 15px 18px;
    color: var(--muted); font-size: 13.5px; text-align: center; line-height: 1.6; }

  .dead { flex: 1; display: grid; place-items: center; padding: 24px; }
  .dead-card { text-align: center; max-width: 420px; }
  .dead-icon { font-size: 40px; margin-bottom: 14px; }
  .dead-card h2 { font-family: var(--serif-stack); font-weight: 500; font-size: 22px; color: var(--text); margin-bottom: 10px; }
  .dead-sub { color: var(--muted); font-size: 14px; line-height: 1.7; }
  .dead-reason { margin-top: 8px; color: var(--muted); font-size: 13px; }
  .dead-hint { margin-top: 16px; color: var(--muted); font-size: 12.5px; }
</style>
