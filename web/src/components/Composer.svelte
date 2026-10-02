<script>
  import { uiAlert } from '../lib/dialogs.js';
  import { session, settings, caps, compose, status, prefs } from '../lib/state.svelte.js';
  import { send, stop, bgHoldNow } from '../lib/chat.svelte.js';
  import SlashMenu from './SlashMenu.svelte';
  import { loadCommands, filterCommands } from '../lib/slashCommands.js';
  import { api } from '../lib/api.js';
  import ModelPicker from './ModelPicker.svelte';
  import EffortPanel from './EffortPanel.svelte';
  import QuotaRing from './QuotaRing.svelte';
  import AddMenu from './AddMenu.svelte';
  import { ICON_FEATHER, ICON_RESEARCH } from '../lib/icons.js';
  import { IS_CSNAP } from '../lib/csnap.js';
  import { claudeDefaultModel, claudeEffortFallback } from '../lib/caps.js';
  import { dropHasDirs, entriesFromDrop, walkEntries, itemsFromDirInput, groupByRoot, skipNote, pool } from '../lib/dirDrop.js';
  import { fileToBase64, filesFromInput, removeAttachment, uploadAttachment } from '../lib/attachments.js';
  import { untrack } from 'svelte';
  import { draft, registerComposerReader } from '../lib/composerBridge.svelte.js';
  import { t } from '../lib/i18n.js';

  let { placeholder = 'Type / for skills' } = $props();
  let field = $state();
  let pickerOpen = $state(false), modelBtn = $state(), pickerDir = $state('up');
  let effortOpen = $state(false), effortBtn = $state(), effortDir = $state('up');
  let menuOpen = $state(false), plusBtn = $state(), menuDir = $state('up');
  let fileInput = $state();
  let photoInput = $state();
  let dirInput = $state();

  // —— 外部预填（lib/composerBridge：refusalRetry 的「编辑并重试」等）——
  // 只订阅 nonce：同一段文本连填两次也各生效一次。innerText 赋值把 \n 变成 <br>（textContent
  // 会把换行压成一行，submit 读的正是 innerText）；用完即清 draft.text，换会话 / 转场重挂的
  // 输入栏不会再灌一遍旧草稿。
  $effect(() => {
    const n = draft.nonce;
    if (!n || !field) return;
    const txt = untrack(() => draft.text);
    if (!txt) return;
    untrack(() => { draft.text = ''; });
    field.innerText = txt;
    onInput();   // 「/」菜单状态跟着重算（预填的是 /xxx 也要弹菜单）
    field.focus();
    placeCaretEnd(field);
  });
  // 登记「输入框里有没有草稿」读取器：官方 Edit prompt and retry 在非空时拒绝，不冲掉人正在写的东西。
  $effect(() => registerComposerReader(() => !!(field?.innerText || '').replace(/ /g, ' ').trim()));

  function togglePicker() {
    if (!pickerOpen && modelBtn) { const r = modelBtn.getBoundingClientRect(); pickerDir = (window.innerHeight - r.bottom) >= r.top ? 'down' : 'up'; }
    pickerOpen = !pickerOpen;
  }
  function toggleEffort() {
    if (!effortOpen && effortBtn) { const r = effortBtn.getBoundingClientRect(); effortDir = (window.innerHeight - r.bottom) >= r.top ? 'down' : 'up'; }
    effortOpen = !effortOpen;
  }
  function toggleMenu() {
    if (!menuOpen && plusBtn) { const r = plusBtn.getBoundingClientRect(); menuDir = (window.innerHeight - r.bottom) >= r.top ? 'down' : 'up'; }
    menuOpen = !menuOpen;
  }

  const nameOf = (list, id) => (list.find((x) => x.id === id) || {}).name || id;
  const modelList = $derived(caps.data?.claude?.models || []);
  const curModel = $derived(settings.model || claudeDefaultModel(caps.data));
  const modelName = $derived(nameOf(modelList, curModel));
  // 会话实际模型 ≠ 所选：安全栅门自动回退（system/model_refusal_fallback，scope session）后内核在
  // status.models[sid] 记下「本会话已切到 X」，settings.model 也随 session{swapped} 换成 X——两者
  // 一致时芯片就是 X，什么也不标；人再手动切回原模型才会不一致 → 点线下划 + title 说明
  //（复用 effort mismatch 的样式）。下一轮 bridge 显式传所选模型，这是用户的主动选择，不拦。
  const sessionModel = $derived(session.id ? (status.models || {})[session.id] : null);
  const modelMismatch = $derived(!!(sessionModel && sessionModel.id) && sessionModel.id !== curModel);
  // from 非空 = 安全栅门换来的；为空 = 服务端夹紧后的实况（快照禁 Fable 之类），别把「安全栅门」扣上去
  const modelTitle = $derived(modelMismatch
    ? (sessionModel.from
      ? t('本会话已切换到 {model}（安全栅门自动回退）；已选 {selected}，下一轮起生效', { model: nameOf(modelList, sessionModel.id), selected: modelName })
      : t('本会话实际使用 {model}；已选 {selected}，下一轮起生效', { model: nameOf(modelList, sessionModel.id), selected: modelName }))
    : '');
  // effort 芯片显示【实际生效】档位（SDK 0.3.257：Stop hook 回报本轮真正发给 API 的档，经组织
  // 上限 / 模型不支持降档之后）——但用户刚改过选择（effortAt 更新）就先显示选择，等下一轮
  // 跑完再以实况为准；实况 ≠ 选择时芯片加点线下划 + title 说明。
  const effortList = $derived(caps.data?.claude?.efforts || []);
  const effortApplied = $derived.by(() => {
    const a = session.id ? status.efforts[session.id] : null;
    return a && a.level && a.at > (settings.effortAt || 0) ? a.level : null;
  });
  // 没选 effort = 该模型的 API 默认档（Opus 5.5 是 medium，其余 high；capabilities.effortDefaults）
  const effortChosen = $derived(settings.effort || claudeEffortFallback(caps.data, curModel));
  const effortName = $derived(nameOf(effortList, effortApplied || effortChosen));
  const effortMismatch = $derived(!!effortApplied && effortApplied !== effortChosen);
  const effortTitle = $derived(effortMismatch ? t('已选 {selected}，本会话实际生效 {active}', { selected: nameOf(effortList, effortChosen), active: effortName }) : '');
  // fast mode 生效中（开关开 + 当前模型支持）→ 芯片显示「Opus 5 · Fast」（官方同款）
  const fastOn = $derived(settings.fast && (caps.data?.claude?.fast || []).includes(settings.model || claudeDefaultModel(caps.data)));

  // —— 「/」命令菜单：输入框内容整体是 `/xxx`（单 token、无空白）时打开；空格/换行即关。
  // 数据来自 /api/commands（SDK supportedCommands + terminal_slash_commands 段已在数据层藏掉）。
  let slashQ = $state(null);      // null = 关；'' 或查询串 = 开
  let slashIdx = $state(0);
  const slashItems = $derived(slashQ == null ? [] : filterCommands(status.commands, slashQ));

  // —— 输入建议（官方 prompt suggestion）：上一轮定局后 CLI 预测的下一句（status.suggestions，总线推来）。
  // 输入框空着时替掉占位文字显示；Tab（手机点「填入」键帽）把它填进输入框，改不改都由人再按发送；
  // Esc 收起这一条。在跑 / 快照 / 设置里关了都不显示。
  let empty = $state(true);
  const suggestion = $derived.by(() => {
    if (!prefs.promptSuggest || IS_CSNAP || session.busy || !session.id) return '';
    const s = status.suggestions[session.id];
    return s && !s.dismissed ? s.text : '';
  });
  const showSugg = $derived(!!suggestion && empty && slashQ == null);
  function acceptSuggestion() {
    if (!suggestion || !field) return;
    // 以 DOM 为准再核一次：有字就绝不覆盖（万一哪条路径灌了文本却没触发 input）
    if ((field.innerText || '').trim()) { empty = false; return; }
    field.innerText = suggestion;
    onInput();
    field.focus();
    placeCaretEnd(field);
  }
  function dismissSuggestion() {
    const s = session.id ? status.suggestions[session.id] : null;
    if (s) s.dismissed = true;
  }

  function onInput() {
    const raw = field?.innerText || '';
    empty = !raw.trim();   // trim 连 contenteditable 的 &nbsp; 填充一起去掉
    // 删空后 contenteditable 常留一个 <br>：:empty 不再命中，占位文字（含输入建议）就出不来——没字了就清干净。
    if (empty && field && field.firstChild && field.textContent === '') field.replaceChildren();
    const txt = raw.replace(/ /g, ' ');
    const m = /^\s*\/([^\s/]*)\s*$/.exec(txt);
    const q = m && !/\n/.test(txt.trim()) ? m[1] : null;
    if (q !== slashQ) slashIdx = 0;
    slashQ = q;
    if (q != null) loadCommands();
  }
  function placeCaretEnd(el) {
    try { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch {}
  }
  function pickSlash(c) {
    if (!c || !field) return;
    field.textContent = '/' + c.name + ' ';
    empty = false;
    slashQ = null;
    field.focus();
    placeCaretEnd(field);
  }

  // —— Add files：选文件 / 粘贴(Ctrl+V) / 拖拽 → /api/upload（base64）→ 暂存附件 ——
  function pickFiles() { fileInput && fileInput.click(); }
  function pickPhotos() { photoInput && photoInput.click(); }
  // 统一附件入口：选文件 / 粘贴图片 / 拖拽文件三条路都汇到这里。逐个上传，pending 期间显示占位。
  async function addFiles(fileList) {
    for (const f of [...(fileList || [])]) {
      if (!f) continue;
      if (f.size > 20_000_000) { uiAlert(f.name ? t('{name}：超过 20MB，暂不支持', { name: f.name }) : t('文件：超过 20MB，暂不支持')); continue; }
      // 先放占位（pending）再上传——上传期间附件先可见，用户点发送会被 uploading 拦住。
      const isImg = (f.type || '').startsWith('image/');
      const name = f.name || (isImg ? 'image.png' : 'file');   // 粘贴的截图常无文件名，兜底
      await uploadAttachment(compose.attachments, f, {
        draft: { path: null, name, kind: isImg ? 'image' : 'file', url: isImg ? URL.createObjectURL(f) : null, pending: true },
        upload: async (file) => api.upload(name, await fileToBase64(file)),
        onError: () => uiAlert(t('上传失败：{name}', { name })),
      });
    }
  }
  // e.target.files 是活的 FileList——必须先浅拷贝再清 value，否则 value='' 原地清空列表，
  // addFiles 永远拿到空（选文件通路全灭，手机端唯一入口就是它；粘贴/拖拽传真数组不受影响）。
  async function onFiles(e) { await addFiles(filesFromInput(e)); }
  function removeAtt(a) { removeAttachment(compose.attachments, a); }
  const uploading = $derived(compose.attachments.some((a) => a.pending));

  // —— 挂载文件夹（Claude Design 那种「挂上去，按需读」）——
  // 整个目录树原样传进本人 uploads/<时间戳>-<名字>/，只把【文件夹绝对路径】作为一条附件带走；
  // 后端提示词让 Claude 用 Read/Glob/Grep 按需读，不把内容一股脑塞进上下文。
  function pickFolder() { dirInput && dirInput.click(); }
  async function onDirInput(e) {
    const fl = [...(e.target.files || [])];
    e.target.value = '';
    const { items, stat } = itemsFromDirInput(fl);
    if (!items.length) return;
    for (const g of groupByRoot(items)) await addFolder(g.name, g.items, stat);
  }

  async function addFolder(name, items, stat) {
    const att = { path: null, name, kind: 'folder', url: null, count: items.length, prog: 0, note: '', pending: true };
    compose.attachments.push(att);
    const live = compose.attachments[compose.attachments.length - 1];   // 代理引用，直改才驱动 UI
    try {
      const root = await api.uploadFolderInit(name);
      let done = 0;
      await pool(items, 5, async (it) => {
        // rel 带着顶层文件夹名（"我的项目/src/a.js"），而挂载根【本身就是】这个文件夹——
        // 原样传会套两层（<根>/我的项目/src/...），Claude 还得多下一级。剥掉首段。
        const frel = it.rel.split('/').slice(1).join('/') || it.file.name;
        await api.uploadBlob(it.file.name || 'file', it.file, { fdir: root.dirName, frel });
        live.prog = ++done / items.length;
      });
      live.path = root.path; live.pending = false;
      // 「跳过了 node_modules / 超限截断」写进卡片副行——绝不能用 window.alert：
      // 它会把主线程整个挡住（自动化里更是直接挂死），而这只是条附带说明。
      live.note = stat ? skipNote(stat) : '';
    } catch {
      uiAlert(t('文件夹上传失败：{name}', { name }));
      compose.attachments = compose.attachments.filter((x) => x !== live);
    }
  }

  // —— 拖拽文件进输入栏（桌面）——把文件拖到卡片上直接当附件。只对「文件」拖拽响应，拖文本不干扰。
  let dragOver = $state(false);
  function dtHasFiles(dt) { return !!dt && Array.from(dt.types || []).includes('Files'); }
  function onDragOver(e) { if (!dtHasFiles(e.dataTransfer)) return; e.preventDefault(); dragOver = true; }
  function onDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) dragOver = false; }   // 离开子元素不算，离开整块才灭
  function onDrop(e) {
    if (!dtHasFiles(e.dataTransfer)) { dragOver = false; return; }
    e.preventDefault();
    dragOver = false;
    // 拖进来的有文件夹 → 走整树「挂载」；纯文件维持原来的逐个附件上传。
    // entriesFromDrop 必须在这里【同步】调用：await 之后 dataTransfer 就废了。
    if (dropHasDirs(e)) { addDropped(entriesFromDrop(e)); return; }
    addFiles(e.dataTransfer.files);
  }
  // 一次拖拽可能文件夹与散文件混着来：文件夹各挂一条，散文件照旧逐个当附件。
  async function addDropped(entries) {
    const { items, stat } = await walkEntries(entries);
    if (!items.length) return;
    for (const g of groupByRoot(items)) {
      if (g.isDir) await addFolder(g.name, g.items, stat);
      else await addFiles(g.items.map((x) => x.file));
    }
  }

  // 挂起中（模型已停笔、只在等后台任务）：输入栏按空闲处理——发送键照常，新消息接力进同一个进程，
  // 后台任务照跑。停后台任务走工作台「任务」页（逐条 ⏹ / 结束等待），不再只剩一个会连带杀掉它们的停止键。
  const holding = $derived(!!bgHoldNow());
  const busyNow = $derived(session.busy && !holding);

  function submit() {
    if (uploading) return;   // 附件还在上传——发送按钮已是禁用态，等传完再发
    // innerText（非 textContent）：保留 contenteditable 里 <br>/<div> 代表的换行，
    // 多行 prompt / 粘贴的代码不再被压成一行。  是 contenteditable 的填充空格。
    const txt = (field?.innerText || '').replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if ((!txt && !compose.attachments.length) || busyNow) return;
    field.textContent = '';
    empty = true;
    send(txt);
  }
  // 触屏（手机软键盘没有 Shift）：Enter = 换行，发送靠按钮——与 claude.ai 移动端一致。
  // 桌面保持 Enter 发送 / Shift+Enter 换行。
  const touchUI = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  function onKey(e) {
    // 「/」菜单开着：上下选、Enter/Tab 选中、Esc 关；其余键照常输入（oninput 会重算过滤）。
    if (slashQ != null && slashItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashIdx = (slashIdx + 1) % slashItems.length; return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashIdx = (slashIdx - 1 + slashItems.length) % slashItems.length; return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slashItems[slashIdx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); slashQ = null; return; }
    }
    // 输入建议亮着（输入框空）：Tab 填入、Esc 收起。输入框有字时 Tab 照旧（移焦点）。
    if (showSugg && !e.isComposing) {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); acceptSuggestion(); return; }
      if (e.key === 'Escape') { e.preventDefault(); dismissSuggestion(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !touchUI) { e.preventDefault(); submit(); }
  }
  // 官方整卡 cursor-text：点卡片空白处（内边距、工具条空档）等于点输入框——聚焦并把光标放到末尾。
  // 只认「空白容器」本身被点中；按钮、弹层、附件卡各管各的。从输入框里拖选到空白处松手时
  // click 落在公共祖先上，这时有选区，不去收拢它。
  function onCardClick(e) {
    if (!field || !(e.target === e.currentTarget || e.target.matches?.('.toolbar, .left, .right, .field-wrap, .attachments'))) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && field.contains(sel.anchorNode)) return;
    field.focus();
    placeCaretEnd(field);
  }
  // 粘贴：剪贴板里有文件（截图 / 复制的图片）→ 当附件上传；否则纯文本插入（富文本不带样式）。
  function onPaste(e) {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [];
    if (dt.files && dt.files.length) files.push(...dt.files);
    else if (dt.items) { for (const it of dt.items) if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); } }
    if (files.length) { e.preventDefault(); addFiles(files); return; }
    const txt = dt.getData('text/plain');
    if (txt == null) return;
    e.preventDefault();
    try { document.execCommand('insertText', false, txt); } catch {}
  }
</script>

<!-- 点空白聚焦只是指针便利，键盘本就能 Tab 进输入框 -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="composer" class:drag-over={dragOver} ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop} onclick={onCardClick} role="group">
  {#if dragOver}
    <div class="drop-veil">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
      <span>{t('拖到此处添加附件 · 文件夹会整个挂载')}</span>
    </div>
  {/if}
  {#if compose.attachments.length}
    <div class="attachments">
      {#each compose.attachments as a, ai (a.path || 'pending-' + ai)}
        <div class="att" class:img={a.kind === 'image'} class:pending={a.pending} class:dir={a.kind === 'folder' || a.kind === 'chat'}>
          {#if a.kind === 'image' && a.url}
            <img src={a.url} alt={a.name} />
          {:else if a.kind === 'chat'}
            <!-- 引用对话（侧栏拖一条会话进来，lib/chatQuote.js）：对话气泡图标 + 标题 + 条数 -->
            <span class="att-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12.2c0 3.9-3.6 7-8 7-1.1 0-2.2-.2-3.1-.6L4.5 20l1.2-3.5C4.6 15.3 4 13.8 4 12.2c0-3.9 3.6-7 8-7s8 3.1 8 7z"/><path d="M8.6 11h6.8M8.6 14h4.2"/></svg></span>
            <span class="att-col">
              <span class="att-name">{a.name}</span>
              <span class="att-sub">{a.pending ? t('正在整理对话…') : t('引用对话 · {n} 条消息', { n: a.count || 0 })}</span>
            </span>
          {:else if a.kind === 'folder'}
            <span class="att-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.2c0-1.5 1.2-2.7 2.7-2.7h3.4l2 2.3h6.2c1.5 0 2.7 1.2 2.7 2.7v8.3c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7z"/></svg></span>
            <span class="att-col">
              <span class="att-name">{a.name}</span>
              <span class="att-sub">{a.pending ? t('上传中 {pct}%', { pct: Math.round((a.prog || 0) * 100) }) : a.count == null ? t('本机引用 · 按需读取') : t('{n} 个文件 · 按需读取{note}', { n: a.count, note: a.note ? ' · ' + a.note : '' })}</span>
            </span>
          {:else}
            <span class="att-name">{a.name}</span>
          {/if}
          {#if a.pending && a.kind !== 'folder' && a.kind !== 'chat'}<span class="att-spin"></span>{/if}
          <button class="att-x" aria-label={t('移除')} onclick={() => removeAtt(a)}>×</button>
        </div>
      {/each}
    </div>
  {/if}

  {#if slashQ != null && slashItems.length}<SlashMenu items={slashItems} active={slashIdx} onPick={pickSlash} onHover={(i) => (slashIdx = i)} />{/if}
  <div class="field-wrap">
    <div class="field" class:sugg={showSugg} bind:this={field} contenteditable="true" data-ph={showSugg ? suggestion : placeholder} role="textbox" tabindex="0" aria-multiline="true" onkeydown={onKey} oninput={onInput} onpaste={onPaste} onblur={() => setTimeout(() => (slashQ = null), 120)}></div>
    {#if showSugg}
      <!-- mousedown 不抢焦点：桌面上点键帽等同按 Tab；手机没有 Tab 键，这是唯一入口 -->
      <button class="sg-key" type="button" tabindex="-1" title={t('填入建议（Tab）· Esc 收起')} aria-label={t('填入建议：{text}', { text: suggestion })} onmousedown={(e) => e.preventDefault()} onclick={acceptSuggestion}>{touchUI ? t('填入') : 'Tab'}</button>
    {/if}
  </div>

  <div class="toolbar">
    <div class="left">
      <div class="plus-wrap">
        <button class="tbtn plus" bind:this={plusBtn} aria-label={t('附件与功能')} onclick={toggleMenu}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        {#if menuOpen}<AddMenu dir={menuDir} onClose={() => (menuOpen = false)} onPickFiles={pickFiles} onPickPhotos={pickPhotos} onPickFolder={pickFolder} />{/if}
      </div>
      {#if settings.research}
        <button class="chip" aria-label={t('Research 已开启')} onclick={toggleMenu}>
          <svg viewBox="0 0 20 20" fill="currentColor"><path d={ICON_RESEARCH} /></svg>
        </button>
      {/if}
      {#if settings.style !== 'normal'}
        <button class="chip" aria-label={t('回复风格已开启')} onclick={toggleMenu}>
          <svg viewBox="0 0 20 20" fill="currentColor"><path d={ICON_FEATHER} /></svg>
        </button>
      {/if}
      <!-- 额度环放左侧空位：右侧只留「模型 / Effort / 发送」，窄屏（折叠屏分屏、小窗）
           不会再被挤到把发送键顶出卡片 -->
      {#if !IS_CSNAP}<QuotaRing />{/if}
    </div>
    <div class="right">
      <div class="model-wrap">
        <button class="model" class:mismatch={modelMismatch} title={modelTitle} bind:this={modelBtn} onclick={togglePicker}><span class="mtxt">{modelName}</span>{#if fastOn}<span class="model-fast">&nbsp;· Fast</span>{/if}</button>
        {#if pickerOpen}<ModelPicker onClose={() => (pickerOpen = false)} dir={pickerDir} />{/if}
      </div>
      <div class="model-wrap eff">
        <button class="model lvl" class:mismatch={effortMismatch} title={effortTitle} bind:this={effortBtn} onclick={toggleEffort}><span class="mtxt">{effortName}</span></button>
        {#if effortOpen}<EffortPanel onClose={() => (effortOpen = false)} dir={effortDir} />{/if}
      </div>
      {#if busyNow}
        <button class="submit stop" aria-label={t('停止生成')} onclick={stop}><svg viewBox="0 0 20 20" width="13" height="13"><rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor"/></svg></button>
      {:else}
        <button class="submit" aria-label={uploading ? t('附件上传中') : t('发送')} disabled={uploading} onclick={submit}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>
      {/if}
    </div>
  </div>

  <input type="file" multiple hidden bind:this={fileInput} onchange={onFiles} />
  <!-- 只收图片：安卓壳据此改开系统照片选择器（MainActivity.onShowFileChooser） -->
  <input type="file" multiple hidden accept="image/*" bind:this={photoInput} onchange={onFiles} />
  <!-- webkitdirectory：选文件夹（触屏没有文件夹拖拽，这是手机端唯一入口） -->
  <input type="file" hidden bind:this={dirInput} onchange={onDirInput} webkitdirectory="" directory="" />
</div>

<style>
  /* claude.ai 输入栏原件（ion-dist shared-14 容器 + CSS 的 shadow-composer / -hover / -focus 三态）：
     常态 = 淡描边 + 3.5% 软投影；悬停（且没悬在里面的按钮上）= 描边加深；聚焦（focus-within）=
     描边加深 + 投影加深到 7.5%。描边暗色走 1px 内圈、亮色走 1px 外圈（官方 --cds-ring-inner/outer），
     颜色 = 正文色 10% → 20%（--cds-border → --cds-border-strong）。圆角 20px、200ms 过渡、整卡 cursor:text。 */
  .composer {
    --cmp-ring: rgba(255,255,255,.10); --cmp-ring-strong: rgba(255,255,255,.20);
    --cmp-ring-in: 1px; --cmp-ring-out: 0px;
    --cmp-shadow: 0 4px 20px rgba(0,0,0,.035), inset 0 0 0 var(--cmp-ring-in) var(--cmp-ring), 0 0 0 var(--cmp-ring-out) var(--cmp-ring);
    --cmp-shadow-hover: 0 4px 20px rgba(0,0,0,.035), inset 0 0 0 var(--cmp-ring-in) var(--cmp-ring-strong), 0 0 0 var(--cmp-ring-out) var(--cmp-ring-strong);
    --cmp-shadow-focus: 0 4px 20px rgba(0,0,0,.075), inset 0 0 0 var(--cmp-ring-in) var(--cmp-ring-strong), 0 0 0 var(--cmp-ring-out) var(--cmp-ring-strong);
    position: relative; width: 100%; background: var(--card); border-radius: 20px; box-shadow: var(--cmp-shadow); padding: 14px 12px 10px;
    cursor: text; transition: background-color .2s, box-shadow .2s, opacity .2s;
  }
  :global(html[data-theme="light"]) .composer {
    --cmp-ring: rgba(11,11,11,.10); --cmp-ring-strong: rgba(11,11,11,.20);
    --cmp-ring-in: 0px; --cmp-ring-out: 1px;
  }
  /* 官方 hover 变体只在能悬停的设备上生效（Tailwind v4 的 @media (hover:hover)），触屏不会粘住悬停态 */
  @media (hover: hover) {
    .composer:hover:not(:has(button:hover, a:hover, [role=button]:hover, label:hover)) { box-shadow: var(--cmp-shadow-hover); }
  }
  .composer:focus-within { box-shadow: var(--cmp-shadow-focus); }
  /* 整卡 cursor:text 会被子孙继承：卡内弹层（模型 / Effort / + 菜单 / 「/」菜单 / 额度面板）与附件卡回普通光标（按钮全局已是 pointer） */
  .composer :global(:is([role=menu], [role=listbox], [role=dialog], .qr-wrap)), .att { cursor: default; }
  /* 拖拽文件悬停：卡片描边高亮 + 覆盖一层「拖到此处」提示（pointer-events:none 让拖放事件穿透到卡片） */
  .composer.drag-over { box-shadow: var(--cmp-shadow-focus), inset 0 0 0 2px var(--serif); }
  .drop-veil { position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
    border-radius: 20px; border: 2px dashed var(--serif); background: var(--card); color: var(--serif); font-size: 14px; pointer-events: none; }
  .drop-veil svg { width: 26px; height: 26px; }
  .drop-veil span { text-align: center; padding: 0 16px; }   /* 英文较长会折行：折行时居中 */
  .attachments { display: flex; flex-wrap: wrap; gap: 7px; padding: 2px 6px 10px; }
  .att { position: relative; display: flex; align-items: center; height: 52px; border-radius: 12px; overflow: hidden; background: var(--hover); }
  .att.img { width: 52px; }
  .att img { width: 52px; height: 52px; object-fit: cover; display: block; }
  .att-name { padding: 0 12px; font-size: 13px; color: var(--text); max-width: 170px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .att-x { position: absolute; top: 0; right: 0; width: 17px; height: 17px; border-radius: 50%; background: rgba(0,0,0,.6); color: #fff; font-size: 13px; line-height: 1; display: flex; align-items: center; justify-content: center; }
  /* 扩大触控命中区到 ~32px（视觉不变）——17px 的删除点手机上极难点中 */
  .att-x::before { content: ''; position: absolute; inset: -8px; }
  .att.pending { opacity: .55; }
  /* 挂载的文件夹：图标 + 两行（名字 / 文件数·上传进度）——与图片、单文件卡区分开 */
  .att.dir { gap: 9px; padding: 0 14px 0 11px; max-width: 100%; }   /* 副行（英文更长）过长时收进卡片、省略号 */
  .att.dir.pending { opacity: 1; }              /* 进度写在副行里，不靠整块变淡表达 */
  .att-ic { flex: none; width: 22px; height: 22px; color: var(--serif); }
  .att-ic svg { width: 100%; height: 100%; display: block; }
  .att-col { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .att.dir .att-name { padding: 0; }
  .att-sub { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .att-spin { position: absolute; left: 50%; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; animation: attspin .8s linear infinite; }
  @keyframes attspin { to { transform: rotate(360deg); } }
  .submit:disabled { opacity: .45; }
  .field { min-height: 30px; max-height: 40vh; overflow-y: auto; font-size: 16px; line-height: 1.4; color: var(--text); outline: none; padding: 2px 6px 12px; }
  .field:empty::before { content: attr(data-ph); color: var(--muted); }
  /* 输入建议：占位文字换成建议，右上角一枚小键帽（Tab / 手机上「填入」）；长建议折行时给键帽让位 */
  .field-wrap { position: relative; }
  .field.sugg { padding-right: 58px; }
  .sg-key { position: absolute; top: 0; right: 4px; height: 22px; padding: 0 7px; border-radius: 6px; border: 1px solid var(--divider);
    background: transparent; color: var(--muted); font: inherit; font-size: 11.5px; line-height: 20px; letter-spacing: .02em; }
  .sg-key:active { background: var(--hover); color: var(--text); }
  @media (hover: hover) { .sg-key:hover { background: var(--hover); color: var(--text); } }
  /* 窄屏防「顶飞」：芯片是 white-space:nowrap 的文字，min-content 就是整串文字宽——
     不给 min-width:0 的话这一行的最小宽度会大于卡片，flex 溢出把发送键推到卡片外
     （折叠屏分屏 / 小窗实测：Extra high + 额度环时必现）。这里让两枚芯片可收缩并省略号，
     固定尺寸的 +、额度环、发送键一律 flex:none 保住不被压扁；
     还窄就整组换行（flex-wrap）：宁可工具条排两行，也不把芯片压成「O…」。 */
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 8px; min-width: 0; }
  .left, .right { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .left { flex: none; }
  .right { flex: 1 1 auto; justify-content: flex-end; }
  .left :global(.qr-wrap), .submit { flex: none; }
  .plus-wrap { position: relative; display: flex; flex: none; }
  .tbtn { width: 38px; height: 38px; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: var(--serif); }
  .tbtn:active { background: var(--hover); }
  .tbtn.plus svg { width: 21px; height: 21px; }
  /* 激活态功能 chip 走黑白灰（claude 页配色铁律：彩色只留星芒）——深灰底 + 正文色图标 */
  .chip { width: 38px; height: 38px; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: var(--text); background: var(--hover-strong, var(--hover)); }
  .chip svg { width: 20px; height: 20px; }
  .chip:active { filter: brightness(1.08); }
  .model-wrap { position: relative; min-width: 0; }
  /* 挤不下时先牺牲 Effort（次要信息），模型名尽量保住 */
  .model-wrap.eff { flex-shrink: 3; }
  /* 官方两枚素文本芯片（Opus 5 / Extra）：无 chevron，hover/按下浮出底色 */
  .model { display: flex; align-items: center; padding: 7px 8px; border-radius: 8px; font-size: 14px; color: var(--text); white-space: nowrap; max-width: 100%; }
  .mtxt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  /* 实际生效 ≠ 所选（effort：Stop hook 回报的档；模型：安全栅门回退后的会话模型）：点线下划提示（title 有说明） */
  .model.mismatch .mtxt { text-decoration: underline dotted; text-underline-offset: 3px; text-decoration-color: var(--muted); }
  /* 折叠屏分屏 / 手机小窗（实测可用宽 ~285px）：把官方间距压一点点，让工具条继续排一行，
     不必提前换行。宽屏一律维持官方 p7/8 与 gap8。 */
  @media (max-width: 360px) {
    .toolbar { gap: 6px; }
    .right { gap: 3px; }
    .model { padding: 7px 6px; }
  }
  .model:active { background: var(--hover); }
  @media (hover: hover) { .model:hover { background: var(--hover); } }
  .model.lvl { color: var(--muted); }
  /* 「· Fast」后缀：官方为灰色（与模型名区分） */
  .model-fast { color: var(--muted); }
  .submit { width: 38px; height: 38px; border-radius: 11px; background: var(--text); color: var(--bg); display: flex; align-items: center; justify-content: center; margin-left: 2px; }
  .submit.stop { border-radius: 11px; }
</style>
