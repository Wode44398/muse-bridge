<script>
  // dimensio 分页的工作区：同一份统一外壳（Workbench），由 bridge 注入进 dimensio 的页面（HarnessPage 的 dockView）。
  // 工作区状态仍只有 dimensio 自己那一份（它的会话切换、视图上报、自动展开、胶囊都读那份）——这里把它经 dk
  // 适配成外壳认的宿主形状，不另存。专属卡（任务、带会话范围的审阅）的内容由 dimensio 给；文件、记忆是共用面板；
  // 终端 / 浏览器在 dimensio 的 agent 工具并到 bridge 那套运行时之后也是共用面板（dk.sharedTerm / sharedBrowser）。
  import { untrack } from 'svelte';
  import { ui } from '../../lib/state.svelte.js';
  import { api } from '../../lib/api.js';
  import { registerDockHost } from '../../lib/dock.svelte.js';
  import { sharedTool, pluginCards } from '../../lib/dock/tools.js';
  import { isPluginView, workbenchByKey, openWorkbenchStandalone } from '../../lib/pluginUi.svelte.js';
  import { inAndroidApp } from '../../lib/pluginPanels.svelte.js';
  import { t } from '../../lib/i18n.js';
  import { agentPopOut, listenCardBack } from '../../lib/solo.js';
  import Workbench from './Workbench.svelte';

  let { dk, panel, icon } = $props();

  // meta（这个身份在这个工作空间有没有命令行、目录还在不在）是 bridge 的接口，按 ws 存一份
  let meta = $state(null);
  let metaWs = $state('');
  let asking = '';
  async function ensureMeta() {
    const ws = dk.ws;
    if (!ws || asking === ws) return null;
    if (meta && metaWs === ws) return meta;
    asking = ws;
    let m = null, gone = false;
    try { m = await api.get(`/api/claude/dock/meta?ws=${encodeURIComponent(ws)}`); } catch (e) { gone = e?.status === 404; }
    if (!m) m = { rel: null, git: false, shell: false, gone };
    if (asking === ws) asking = '';
    // 拉取期间可能已切走工作空间——晚到的结果不许盖到新 ws 头上
    if (dk.ws === ws) { meta = m; metaWs = ws; }
    return m;
  }

  // 变量不叫 state：组件里它会遮住同名的符文
  const view = {
    get open() { return dk.open; },
    get view() { return dk.view; },
    get views() { return dk.views; },
    get max() { return dk.max; },
    get ws() { return dk.ws; },
    // 浏览器按会话各开一份：dimensio 的会话在 bridge 的浏览器池里带 d_ 前缀，免得和 Claude 的会话 id 撞；
    // 还没有 id 的新对话用 d_ 那一份（和它的 agent 工具落在同一把键上）
    get sessionId() { return dk.sharedBrowser ? `d_${dk.chatId || ''}` : ''; },
    get meta() { return metaWs === dk.ws ? meta : null; },
    get termLive() { return dk.termLive; },
    set termLive(v) { if (!v) dk.clearTermLive(); },
    get browserLive() { return dk.browserUrl; },
    set browserLive(_v) {},
    get filesTarget() { const f = dk.filesTarget; return f ? { seq: f.seq, rel: f.rel, ws: '', open: f.open } : null; },
    get focus() { const f = dk.focus; return f ? { view: f.tool, seq: f.seq } : null; },
    snap: false,
  };
  const host = registerDockHost(view, {
    id: 'dimensio', initialView: 'browser', filesRoot: 'ws', previewHost: 'hx-files', memoryAgent: 'dimensio',
    state: view,
    get cols() { return dk.cols; },
    weights: { get w() { return dk.weights; } },
    // 插件卡片（ctx.ui.workbench 的 hosts 含 dimensio）：插件没了不开；手机 App 里改成原生干净页面打开（同其它分页）
    open: (v) => {
      if (isPluginView(v)) {
        const w = workbenchByKey(v);
        if (!w) return;
        if (inAndroidApp()) { openWorkbenchStandalone(w, ctxNow()); return; }
      }
      dk.openTool(v);
    },
    context: () => ctxNow(),
    close: () => dk.close(),
    closeView: (v) => dk.closeCard(v),
    toggleView: (v) => dk.toggleCard(v),
    toggleMax: (v) => dk.toggleMax(v),
    noteFocus: (v) => dk.noteFocus(v),
    // 多卡不多卡、哪些卡该在桌上由 dimensio 自己按形态定
    setMulti() {},
    prune() {},
    setCols: (c) => dk.setCols(c),
    setWeights: (w, o) => dk.setWeights(w, !!o?.live),
    ensureMeta,
    browserSession: () => view.sessionId,
    onBrowserTabs: (tabs, alive) => dk.noteBrowser(tabs, alive),
  });

  // 共用工具沿用登记表里的条目，叫法、列位、提示点按 dimensio 给的；快捷键由 dimensio 的页面统一接（工作区关着时也要能开）
  // 插件卡片的上下文（SDK 的 bridge.context()）：dimensio 的会话 id 与工作目录
  function ctxNow() { return { sessionId: dk.chatId || null, cwd: dk.ws || null, agent: 'dimensio' }; }
  // 把插件给 dimensio 的卡片注入它的工作区（卡片表在 harness 里，宿主只给键、标题、图标）
  $effect(() => {
    const list = pluginCards('dimensio').map((x) => ({ key: x.key, label: x.label, closeLabel: x.closeLabel, icon: x.icon }));
    untrack(() => dk.setExtraTools?.(list));
  });
  const tools = $derived(dk.tools.map((x) => ({ ...(x.own ? {} : sharedTool(x.key) || {}), ...x, ...(x.plugin ? { iconSvg: true } : {}), match: null, ok: null })));

  // 共用卡拖出 app 成独立窗口（同 Claude 分页）：dimensio 自己的终端 / 浏览器（没并到 bridge 运行时那会儿）是专属卡，不放出去
  const basePop = agentPopOut('dimensio', () => view, () => theme);
  const popOut = { ...basePop, ok: (v) => basePop.ok(v) && !tools.find((x) => x.key === v)?.own };
  $effect(() => listenCardBack('dimensio', (v) => { if (tools.some((x) => x.key === v)) { host.open(v); try { window.focus(); } catch {} } }));

  let two = $state(false);
  $effect(() => { const v = two; untrack(() => dk.setTwo(v)); });
  // 明暗跟 dimensio 自己的档（跟系统 / 浅 / 深），不跟 bridge 全站主题
  const theme = $derived(ui.pageChrome ? (ui.pageChrome.dark ? 'dark' : 'light') : '');
</script>

<Workbench {host} {tools} wide={dk.docked} multi sizing="host" twoOk={dk.twoOk} bind:two skin="dimensio" mobile="sheet"
  filesFloat="always" {theme} label={t('工作区')} {panel} {icon} {popOut} keysOn={false} backLayer={dk.pushLayer} />
