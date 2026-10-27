<script>
  // ChatGPT 官方视觉样板跑在同包 iframe 内；本宿主只负责 bridge 专属能力：
  // 鉴权/LAN 自愈、真实 Codex SSE、历史、上传与 Markdown 安全渲染。
  import { onMount } from 'svelte';
  import { canDragOut, startDragOut, attDragSrc } from '../lib/dragOut.js';
  import { api, authHeaders } from '../lib/api.js';
  import { startChat, resumeActive } from '../lib/sse.js';
  import { renderMarkdown } from '../lib/md.js';
  import { codexArtifactUrl, kindOf, openPreview } from '../lib/preview.svelte.js';
  import { mediaFallbackUrl } from '../lib/server.js';
  import { ui, me, caps } from '../lib/state.svelte.js';
  import { closePage } from '../lib/pageMorph.js';
  import { codexCapabilities } from '../lib/caps.js';
  import { codexDock, openCodexDock, closeCodexDock, setCodexDockWs, noteCodexAgentBrowser } from '../lib/dock.svelte.js';
  import { noteFsChange } from '../lib/fsSync.svelte.js';
  import CodexWorkspace from './dock/CodexWorkspace.svelte';
  import ProjectPicker from './ProjectPicker.svelte';
  import { hasNativePickDirectory, nativePickDirectory } from '../lib/nativeDesktop.js';
  import { layout } from '../lib/layout.svelte.js';
  import { drag, dropZone, dropToast } from '../lib/dragdrop.svelte.js';
  import { WS_FILE, dtHasWsFiles, wsDescriptorFrom } from '../lib/fileDrag.js';
  import { t, tr, lang } from '../lib/i18n.js';

  const BASE = import.meta.env.BASE_URL;
  let frame = $state();
  // 首开不闪：克隆页的 <html> 写死 class="light"，以前先白一下、等 init 消息到了再翻成暗色
  // （加上 iframe 加载前的黑底，首开是「黑→白→黑」闪三下）。现在主题随地址带进去（克隆页
  // <head> 里第一时间套上），且 iframe 在克隆页报 ready、init 落地之后才淡入——之前露的是
  // 本页与克隆页同色的底，转场长出来的就是一块干净的底色。src 只取一次，换主题走 postMessage。
  // 界面语言也随地址带进去：克隆页自己读 localStorage 的 bridge-lang，但宿主用 ?lang= 临时覆盖时要跟着走
  const frameSrc = BASE + 'chatgpt/index.html?theme=' + (ui.theme === 'light' ? 'light' : 'dark') + '&lang=' + lang();
  let frameShown = $state(false);
  // 这套页面不随公开版发布，由维护者部署的私有 overlay 提供（构建时拷进 chatgpt/，见 web/scripts/chatgpt-overlay.mjs）。
  // 先探一下：没有就不挂 iframe，给一句「此版本未包含」（管理员另看到原因与恢复办法）。认页面自己的样式表 clone.css 而不只看
  // 状态码——dev 服务器对不存在的路径会回落成 app 自己的 index.html（200）。网络抖动照旧挂 iframe，不误报。
  let frameMissing = $state(false);
  fetch(BASE + 'chatgpt/index.html', { cache: 'no-cache' })
    .then(async (r) => { frameMissing = r.status === 404 || (r.ok && !(await r.text()).includes('clone.css')); })
    .catch(() => {});
  // 首开时本页是在入场转场的同一拍挂上的：克隆页（~0.5MB 脚本 + 大段 DOM）若立刻开始加载，
  // 解析与首绘会压在转场动画上掉帧。等卡片长到九成（~300ms）或转场落幕再给 iframe 地址——
  // 长出来的是干净底色，内容随后淡入。
  let frameArmed = $state(!ui.morphing);
  $effect(() => {
    if (frameArmed) return;
    if (!ui.morphing) { frameArmed = true; return; }
    const tid = setTimeout(() => { frameArmed = true; }, 300);
    return () => clearTimeout(tid);
  });
  let pickOpen = $state(false);   // 新建项目选择器（远程端）
  // 工作区以【侧列】形态摆的门槛＝layout.side（折叠屏展开 ~750px 也算），不再是 1024。
  const wide = $derived(layout.side);
  let workspaceName = $state('');
  let activeRun = null;
  let answer = '';
  let presentedAnswer = '';
  let commentary = new Map();
  let reasoning = new Map();
  let presentationFrame = 0;
  let presentationLastAt = 0;
  let presentationBudget = 0;
  let latestTextEvent = null;
  let pendingTerminal = null;
  let lastHapticAt = 0;
  let lastProcessHaptic = '';
  const imageObjectUrls = new Set();

  function post(type, payload = {}) {
    try { frame?.contentWindow?.postMessage({ channel: 'bridge-chatgpt', type, ...payload }, '*'); } catch {}
  }

  $effect(() => {
    post('capabilities', { codex: JSON.parse(JSON.stringify(codexCapabilities(caps.data))) });
  });

  // 建项目：名称留空 → 服务端取文件夹名（与 Claude 分页同规矩）。样板侧只等 project-created。
  async function createProjectAt(dir) {
    const result = await api.createCodexProject('', dir);
    pickOpen = false;
    post('project-created', { project: result.project });
    pushSessions();
  }

  function safeInsets() {
    const style = getComputedStyle(document.documentElement);
    return {
      safeTop: style.getPropertyValue('--sat').trim() || '0px',
      safeBottom: style.getPropertyValue('--sab').trim() || '0px',
    };
  }

  function pushSafeInsets() {
    post('safe-insets', safeInsets());
  }

  let usagePending = false;
  async function pushUsage() {
    if (usagePending) return;
    usagePending = true;
    try { post('usage', { usage: await api.codexUsage() }); }
    catch { post('usage', { usage: { available: false, buckets: [], stale: true } }); }
    finally { usagePending = false; }
  }
  function pushLayout() {
    post('layout', { tier: layout.compact ? 'compact' : layout.medium ? 'medium' : 'expanded', dockOpen: codexDock.open });
  }
  $effect(() => { layout.w; codexDock.open; pushLayout(); });

  async function pushSessions() {
    try {
      const [d, p] = await Promise.all([api.codexSessions(), api.codexProjects()]);
      post('sessions', { sessions: d.sessions || [], projects: p.projects || [] });
    } catch (e) {
      post('sessions', { sessions: [], error: errorText(e, t('无法读取历史对话')) });
    }
  }

  // 服务端 / 网络报错原文经 tr() 译成英文再下发给克隆页显示；没有原文才用各处的兜底文案
  function errorText(e, fallback) {
    return tr(e?.body?.error || e?.body?.message || e?.message) || fallback;
  }

  function decorateAttachments(items, sessionId = '') {
    return (Array.isArray(items) ? items : []).filter((item) => item?.path).map((item) => {
      const name = String(item.name || String(item.path).split(/[\\/]/).pop() || t('文件'));
      const kind = kindOf(name);
      return {
        ...item, name, kind: kind === 'other' ? (item.kind || 'other') : kind,
        sessionId: sessionId || item.sessionId || '',
        url: codexArtifactUrl(sessionId || item.sessionId || '', item.path, { name }),
        downloadUrl: codexArtifactUrl(sessionId || item.sessionId || '', item.path, { dl: true, name }),
      };
    });
  }

  async function resolveFailedImage(data) {
    const requestId = String(data.requestId || '');
    const filePath = String(data.path || '');
    if (!requestId || !filePath) return;

    // Resource elements cannot add Authorization headers and keep the exact LAN URL
    // they were rendered with. First use the shared LAN -> tunnel failover; if the
    // tunnel URL itself failed, fetch with normal bridge auth and hand the iframe a
    // same-origin blob URL instead.
    const failedUrl = String(data.url || '');
    const fallbackUrl = mediaFallbackUrl(failedUrl);
    if (fallbackUrl && fallbackUrl !== failedUrl) {
      post('image-resolved', { requestId, url: fallbackUrl });
      return;
    }

    try {
      const url = codexArtifactUrl(String(data.sessionId || ''), filePath, { name: String(data.name || '') });
      const response = await fetch(url, {
        headers: authHeaders(), credentials: 'same-origin', cache: 'no-store',
      });
      if (!response.ok) throw new Error(`image HTTP ${response.status}`);
      const blob = await response.blob();
      if (!String(blob.type || '').toLowerCase().startsWith('image/')) throw new Error('not an image');
      const objectUrl = URL.createObjectURL(blob);
      imageObjectUrls.add(objectUrl);
      post('image-resolved', { requestId, url: objectUrl });
    } catch {
      post('image-resolved', { requestId, error: true });
    }
  }

  function reducedMotion() {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  function haptic(kind) {
    if (document.visibilityState !== 'visible') return;
    const now = performance.now();
    const minGap = kind === 'text' ? 78 : kind === 'tick' ? 140 : 0;
    if (minGap && now - lastHapticAt < minGap) return;
    if (kind === 'text' && reducedMotion()) return;
    lastHapticAt = now;
    try {
      if (window.AndroidStore?.haptic) {
        window.AndroidStore.haptic(kind);
        return;
      }
    } catch {}
    try {
      const pattern = kind === 'text' ? 3 : kind === 'done' ? [8, 34, 12] : kind === 'error' ? [14, 38, 18] : 7;
      navigator.vibrate?.(pattern);
    } catch {}
  }

  function processHaptic(key) {
    if (!key || key === lastProcessHaptic) return;
    lastProcessHaptic = key;
    haptic('tick');
  }

  function cancelPresentation() {
    if (presentationFrame) cancelAnimationFrame(presentationFrame);
    presentationFrame = 0;
    presentationLastAt = 0;
    presentationBudget = 0;
    latestTextEvent = null;
    pendingTerminal = null;
  }

  function safeSliceEnd(text, wanted) {
    let end = Math.min(text.length, Math.max(0, wanted));
    if (end > 0 && end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end += 1;
    }
    return end;
  }

  function emitPresentedText(piece) {
    if (!piece) return;
    post('event', { event: {
      ...(latestTextEvent || { type: 'text' }), type: 'text', text: piece,
      fullText: presentedAnswer, html: renderMarkdown(presentedAnswer),
    } });
    if (/\S/.test(piece)) haptic('text');
  }

  function deliverTerminal() {
    const queued = pendingTerminal;
    pendingTerminal = null;
    if (!queued) return;
    const { ev, data } = queued;
    const finalText = answer || ev.result || '';
    post('event', { event: {
      ...ev, result: finalText, html: finalText ? renderMarkdown(finalText) : '',
      attachments: decorateAttachments(ev.attachments, ev.sessionId || data.sessionId || ''),
    } });
    if (ev.type === 'done') haptic('done');
    else if (ev.type === 'error') haptic('error');
    else haptic('click');
    pushSessions();
  }

  function flushPresentation() {
    if (answer.length > presentedAnswer.length) {
      const piece = answer.slice(presentedAnswer.length);
      presentedAnswer = answer;
      emitPresentedText(piece);
    }
    deliverTerminal();
  }

  function presentationTick(now) {
    presentationFrame = 0;
    if (document.visibilityState !== 'visible' || reducedMotion()) {
      flushPresentation();
      return;
    }
    if (!presentationLastAt) presentationLastAt = now - 34;
    const elapsed = Math.min(80, now - presentationLastAt);
    if (elapsed < 28) {
      presentationFrame = requestAnimationFrame(presentationTick);
      return;
    }
    presentationLastAt = now;
    const backlog = Math.max(0, answer.length - presentedAnswer.length);
    if (backlog) {
      let charsPerSecond = Math.min(320, 72 + backlog * 1.5);
      if (pendingTerminal) charsPerSecond = Math.max(charsPerSecond, backlog / 0.55);
      presentationBudget += charsPerSecond * elapsed / 1000;
      const count = Math.max(1, Math.floor(presentationBudget));
      presentationBudget = Math.max(0, presentationBudget - count);
      const end = safeSliceEnd(answer, presentedAnswer.length + count);
      const piece = answer.slice(presentedAnswer.length, end);
      presentedAnswer = answer.slice(0, end);
      emitPresentedText(piece);
    }
    if (presentedAnswer.length < answer.length) {
      presentationFrame = requestAnimationFrame(presentationTick);
    } else {
      presentationLastAt = 0;
      presentationBudget = 0;
      deliverTerminal();
    }
  }

  function schedulePresentation() {
    if (!presentationFrame) presentationFrame = requestAnimationFrame(presentationTick);
  }

  function queueTerminal(ev, data) {
    const finalText = answer || ev.result || '';
    if (finalText.length > answer.length) answer = finalText;
    pendingTerminal = { ev, data };
    if (document.visibilityState !== 'visible' || reducedMotion()) flushPresentation();
    else schedulePresentation();
  }

  function resetRunText() {
    cancelPresentation();
    answer = '';
    presentedAnswer = '';
    commentary = new Map();
    reasoning = new Map();
    lastProcessHaptic = '';
  }

  function appendItem(store, key, text) {
    const full = (store.get(key) || '') + (text || '');
    store.set(key, full);
    return full;
  }

  function handleRunEvent(ev, data = {}) {
    if (!ev) return;
    if (ev.type === 'attach') {
      resetRunText();
      post('event', { event: ev });
      return;
    }
    if (ev.type === 'text') {
      answer += ev.text || '';
      latestTextEvent = ev;
      schedulePresentation();
      return;
    }
    if (ev.type === 'commentary') {
      const key = ev.itemId || 'commentary';
      const full = appendItem(commentary, key, ev.text);
      processHaptic(`commentary:${key}`);
      post('event', { event: { ...ev, fullText: full, html: renderMarkdown(full) } });
      return;
    }
    if (ev.type === 'reasoning' || ev.type === 'thinking') {
      const key = `${ev.itemId || 'reasoning'}:${ev.summaryIndex ?? 0}`;
      const full = appendItem(reasoning, key, ev.text);
      processHaptic(`reasoning:${key}`);
      post('event', { event: { ...ev, type: 'reasoning', fullText: full, html: renderMarkdown(full) } });
      return;
    }
    if (ev.type === 'tool') {
      const tool = ev.tool || {};
      if (tool.kind === 'mcp' && /bridge[_-]browser/i.test(String(tool.server || tool.name || tool.tool || ''))) {
        noteCodexAgentBrowser(tool.url || tool.input?.url || 'about:blank');
      }
      processHaptic(`tool:${tool.id || tool.callId || tool.kind || tool.tool || 'unknown'}:${tool.status || 'running'}`);
      post('event', { event: ev });
      return;
    }
    if (ev.type === 'fs') {
      // Codex 文件改动落盘：工作区里打开着的同名文档自动跟盘刷新（与 Claude 分页共用 fsSync）
      noteFsChange(ev.path);
      return;
    }
    if (ev.type === 'reconnecting') {
      processHaptic('reconnecting');
      post('event', { event: ev });
      return;
    }
    if (ev.type === 'done' || ev.type === 'interrupted') {
      pushUsage();
      queueTerminal(ev, data);
      return;
    }
    if (ev.type === 'error') {
      // 服务端报错原文（中文）在这里译好再交给克隆页显示（克隆页读不到字典）
      queueTerminal(ev.message ? { ...ev, message: tr(ev.message) } : ev, data);
      return;
    }
    post('event', { event: ev });
  }

  function runHandlers(data = {}) {
    return {
      onEvent(ev) { handleRunEvent(ev, data); },
      onError(e) { handleRunEvent({ type: 'error', message: errorText(e, t('连接失败，请重试')) }, data); },
      onReconnecting() { handleRunEvent({ type: 'reconnecting' }, data); },
      onClose() { activeRun = null; },
    };
  }

  function beginTurn(data) {
    if (activeRun) return;
    resetRunText();
    haptic('click');
    activeRun = startChat({
      agent: 'codex',
      message: String(data.message || ''),
      sessionId: data.sessionId || undefined,
      codexModel: data.model,
      codexEffort: data.effort,
      codexServiceTier: data.serviceTier || null,
      codexProjectId: data.projectId || undefined,
      attachments: Array.isArray(data.attachments) ? data.attachments.map((x) => x.path).filter(Boolean) : [],
      codexAttachmentMeta: Array.isArray(data.attachments) ? data.attachments.map((x) => ({
        path: x.path, name: x.name, kind: x.kind, mime: x.mime, size: x.size,
      })) : [],
    }, runHandlers(data), { scope: 'codex' });
  }

  async function resumeCodexRun() {
    if (activeRun) return;
    resetRunText();
    activeRun = await resumeActive(runHandlers(), { scope: 'codex' });
  }

  // —— 从工作空间投一份文件过来 ——
  // Codex 的输入栏在 iframe 里，附件靠 post('uploaded') 下发；所以这里不走 fileDrag 的
  // attachToAgent，而是把工作空间那份文件先备成 uploads 素材，再按 Codex 自己的协议投进去。
  // 手指（全域拖拽）与鼠标（HTML5 拖拽）两条路都收在 dropWsFiles 里。
  async function dropWsFiles(rels, ws = '') {
    const out = [];
    for (const rel of rels) {
      try {
        const d = await api.fileToUpload(rel, true, ws);
        out.push(...decorateAttachments([{ name: d.name, path: d.path, size: 0, mime: '', kind: kindOf(d.name) }]));
      } catch {}
    }
    if (out.length) post('uploaded', { attachments: out });
    dropToast(out.length ? t('已挂进 Codex 的输入栏') : t('准备失败'));
  }
  const codexDrop = {
    key: 'chat:codex', effect: 'send', label: (p) => (p?.count > 1 ? t('把 {n} 项挂进这个对话', { n: p.count }) : t('挂进这个对话')),
    accept: (p) => p?.type === WS_FILE && !!p.rels?.length,
    drop: (p) => dropWsFiles(p.rels, p.ctx?.ws || ''),
  };
  let wsDragOver = $state(false);
  function onWsDragOver(e) {
    if (!dtHasWsFiles(e)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
    wsDragOver = true;
  }
  function onWsDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) wsDragOver = false; }
  function onWsDrop(e) {
    if (!dtHasWsFiles(e)) return;
    e.preventDefault();
    wsDragOver = false;
    const desc = wsDescriptorFrom(e.dataTransfer);
    if (desc) dropWsFiles(desc.rels, desc.ws || '');
  }

  async function uploadFiles(files) {
    const out = [];
    for (const file of files) {
      try {
        const d = await api.uploadBlob(file.name, file, {
          onProgress: (progress) => post('upload-progress', { name: file.name, progress }),
        });
        out.push(...decorateAttachments([{
          name: d.name || file.name, path: d.path, size: file.size || 0, mime: file.type || '', kind: kindOf(file.name),
        }]));
      } catch (e) {
        post('upload-error', { name: file.name, message: errorText(e, t('上传失败')) });
      }
    }
    post('uploaded', { attachments: out });
  }

  onMount(() => {
    const onMessage = async (ev) => {
      if (ev.source !== frame?.contentWindow || ev.data?.channel !== 'bridge-chatgpt') return;
      const d = ev.data;
      if (d.type === 'ready') {
        post('init', {
          codex: JSON.parse(JSON.stringify(codexCapabilities(caps.data))),
          theme: ui.theme,
          dragOut: canDragOut(),   // 桌面壳：iframe 里的附件卡挂 draggable，起拖经 drag-out 消息交宿主原生拖出
          user: me.user || (me.kind === 'admin' ? 'admin' : ''),
          ...safeInsets(),
        });
        pushSessions();
        pushLayout();
        pushUsage();
        resumeCodexRun();
        // init 在克隆页里是同步套上的；再等两帧让它按新布局画完，才把 iframe 显出来
        requestAnimationFrame(() => requestAnimationFrame(() => { frameShown = true; }));
        setTimeout(() => { frameShown = true; }, 400);   // rAF 被节流（后台预挂）时的兜底
      } else if (d.type === 'drag-out') {
        startDragOut(attDragSrc(d.attachment || null)).catch(() => {});
      } else if (d.type === 'usage-refresh') {
        pushUsage();
      } else if (d.type === 'back') {
        closePage('chatgpt');   // 收回主页上的入口（与其它分页同一套返回）
      } else if (d.type === 'workspace-toggle') {
        if (codexDock.open) closeCodexDock(); else openCodexDock(codexDock.view || 'review');
      } else if (d.type === 'workspace-open') {
        if (['files', 'review'].includes(d.view)) openCodexDock(d.view);
      } else if (d.type === 'workspace-context') {
        workspaceName = String(d.projectName || '');
        setCodexDockWs(String(d.path || ''));
      } else if (d.type === 'send') {
        beginTurn(d);
      } else if (d.type === 'stop') {
        cancelPresentation();
        answer = presentedAnswer;
        haptic('click');
        api.codexStop().catch(() => {});
        activeRun?.stop(); activeRun = null;
      } else if (d.type === 'sessions') {
        pushSessions();
      } else if (d.type === 'open-project-picker') {
        // 自建目录浏览已退役：本机桌面壳直接弹系统原生文件夹选择器，其余端开 ProjectPicker
        // （工作空间文件管理器 + 底部拖入栏）。项目名固定取文件夹名，不再有名称输入框。
        if (hasNativePickDirectory()) {
          const dir = await nativePickDirectory(codexDock.ws || '');
          if (dir) await createProjectAt(dir);
        } else {
          pickOpen = true;
        }
      } else if (d.type === 'open-session') {
        try {
          const session = await api.codexSession(String(d.id || ''));
          post('session', {
            id: d.id,
            projectId: session.projectId || null,
            projectName: session.projectName || '',
            contextUsage: session.contextUsage || null,
            messages: (session.messages || []).map((m) => ({
              ...m,
              attachments: decorateAttachments(m.attachments, String(d.id || '')),
              html: m.role === 'assistant' ? renderMarkdown(m.text || '') : undefined,
            })),
          });
        } catch (e) {
          post('session-error', { message: errorText(e, t('无法打开对话')) });
        }
      } else if (d.type === 'delete-session') {
        try { await api.deleteCodexSession(String(d.id || '')); } catch {}
        pushSessions();
      } else if (d.type === 'upload') {
        uploadFiles(Array.isArray(d.files) ? d.files : []);
      } else if (d.type === 'preview') {
        const items = (Array.isArray(d.items) ? d.items : []).filter((item) => item?.path).map((item) => ({
          origin: 'codex', id: item.sessionId || d.sessionId || '', path: item.path,
          name: item.name, kind: item.kind,
        }));
        openPreview(items, Number(d.index) || 0);
      } else if (d.type === 'image-load-error') {
        resolveFailedImage(d);
      }
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('resize', pushSafeInsets);
    const usageTimer = setInterval(() => {
      if (!document.hidden && ui.screen === 'chatgpt') pushUsage();
    }, 60_000);
    return () => {
      clearInterval(usageTimer);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('resize', pushSafeInsets);
      activeRun?.stop(); activeRun = null;
      closeCodexDock();
      cancelPresentation();
      for (const url of imageObjectUrls) URL.revokeObjectURL(url);
      imageObjectUrls.clear();
    };
  });

  $effect(() => { ui.theme; post('theme', { theme: ui.theme }); });
  $effect(() => { post('workspace-state', { open: codexDock.open, view: codexDock.view }); });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="chatgpt-page" class:light={ui.theme === 'light'} class:dnd-on={drag.overKey === 'chat:codex' || wsDragOver}
  role="presentation" use:dropZone={codexDrop} ondragover={onWsDragOver} ondragleave={onWsDragLeave} ondrop={onWsDrop}>
  <div class="chat-frame">
    {#if frameMissing}
      <div class="missing" role="status">
        <b>{t('此版本未包含 ChatGPT 页面')}</b>
        {#if me.kind === 'admin'}
          <p>{t('这次前端构建没有接上私有 overlay（环境变量 BRIDGE_OVERLAY_DIR，或数据根 config.json 的 overlayDir）。配好后重新构建前端即可恢复。')}</p>
        {:else}
          <p>{t('这个部署没有附带 Codex 分页的界面。')}</p>
        {/if}
        <button type="button" onclick={() => closePage('chatgpt')}>{t('返回')}</button>
      </div>
    {:else if frameArmed}<iframe bind:this={frame} class:shown={frameShown} src={frameSrc} title="ChatGPT" allow="clipboard-write"></iframe>{/if}
  </div>
  <CodexWorkspace {wide} {workspaceName} />
  <!-- 新建项目选择器（远程端）：工作空间文件管理器 + 底部「拖入选为工作空间」栏 -->
  {#if pickOpen}
    <ProjectPicker preferPath={codexDock.ws || ''} onPick={createProjectAt} onClose={() => (pickOpen = false)} />
  {/if}
</div>

<style>
  /* 底色必须等于 clone 自己的 --main-surface-primary（实测暗 #000 / 亮 #fff）：
     桌面 WCO 下整块 iframe 会下推一条标题栏带，色不对就是一条肉眼可见的接缝。 */
  .chatgpt-page { position: fixed; inset: 0; z-index: 40; display:flex; background: #000; overflow:hidden; }
  /* 拎着工作空间的文件悬在 Codex 上：整页亮一圈，松手＝挂进它的输入栏 */
  .chatgpt-page.dnd-on::after { content: ''; position: absolute; inset: 6px; border-radius: 16px; pointer-events: none; z-index: 5;
    box-shadow: inset 0 0 0 2px #10a37f; background: rgba(16, 163, 127, .07); }
  .chatgpt-page.light { background: #fff; }
  .chat-frame { flex:1; min-width:0; position:relative; }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent;
    opacity: 0; transition: opacity var(--mo-base) var(--ea-fade); }
  iframe.shown { opacity: 1; }
  .missing { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; padding: calc(var(--sat, 0px) + 24px) 32px calc(var(--sab, 0px) + 24px); text-align: center;
    color: rgba(255, 255, 255, .88); font-size: 15px; }
  .missing b { font-size: 17px; font-weight: 600; }
  .missing p { margin: 0; max-width: 340px; line-height: 1.5; color: rgba(255, 255, 255, .56); }
  .missing button { margin-top: 10px; padding: 8px 20px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, .22);
    background: transparent; color: inherit; font: inherit; cursor: pointer; }
  .chatgpt-page.light .missing { color: rgba(0, 0, 0, .86); }
  .chatgpt-page.light .missing p { color: rgba(0, 0, 0, .52); }
  .chatgpt-page.light .missing button { border-color: rgba(0, 0, 0, .16); }
</style>
