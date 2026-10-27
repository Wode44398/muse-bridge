<script>
  import { uiAlert } from '../lib/dialogs.js';
  import { dragOut, attDragSrc } from '../lib/dragOut.js';
  import { mediaDragSrc } from '../lib/vertexMedia.svelte.js';
  // Vertex (Gemini) 分页 —— 视觉严格还原参考资源（真实 Gemini 移动页 Luminous 亮色主题）。
  // 结构仿 ClaudePage（滑动层 + 顶栏 + stage + 抽屉），但用 Gemini 主题与自写的 Gemini 风组件。
  //  · 左上：汉堡(历史抽屉) + 模型选择器「Gemini · <模型名> ⌄」（放在 Gemini 原模型选择处）
  //  · 右上：模块菜单入口（对话/图像/视频/语音/音乐）+ 新建
  //  · 主区：对话=aurora 星标问候 + 流式回复；媒体模块=占位（模型选择器已就位、标注模型名）
  import { onDestroy, untrack } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { ui, me, caps, vertex as vs, prefs, toggleVertexTheme, setVertexFastVision, saveVertexChatOpts, agentOn } from '../lib/state.svelte.js';
  import { swipeDismiss } from '../lib/motion.js';
  import { closePage, backPeek } from '../lib/pageMorph.js';
  import { vchat, vsend, vstop, vnewChat, vloadSession, vprefetchSessions } from '../lib/vertex.svelte.js';
  import { cacheVertexSessions, getCachedVertexSessions, removeCachedVertexMessages } from '../lib/cache.js';
  import { vmedia, loadHistory, delMedia, mediaUrl, newImageChat, openImageChat, delImageChat } from '../lib/vertexMedia.svelte.js';
  import { api } from '../lib/api.js';
  import { mediaFallbackUrl } from '../lib/server.js';
  import { renderMarkdown, streamBlocks } from '../lib/md.js';
  import { fmtElapsed } from '../lib/format.js';
  import { registerCloser } from '../lib/nav.js';
  import { layout } from '../lib/layout.svelte.js';
  import { fileDrop, pasteFiles, pastePlainText } from '../lib/dropPaste.js';
  import { streamFade } from '../lib/streamFade.js';
  import GeminiSparkle from './GeminiSparkle.svelte';
  import VImagePanel from './VImagePanel.svelte';
  import VVideoPanel from './VVideoPanel.svelte';
  import VVoicePanel from './VVoicePanel.svelte';
  import VMusicPanel from './VMusicPanel.svelte';
  import { closeNeoSheet } from '../lib/neoSheet.js';
  import { fileToBase64, filesFromInput, removeAttachment, uploadAttachment } from '../lib/attachments.js';
  import '../gemini/theme.css';
  import '../gemini/media-neo.css';
  import { drag, dropZone } from '../lib/dragdrop.svelte.js';
  import { agentDropZone } from '../lib/fileDrag.js';
  import { t, tc, tr } from '../lib/i18n.js';
  // 从工作空间拎一份文件过来松手 = 挂进 Gemini 对话的输入栏（与 Claude 分页同一套语义）。
  const geminiDrop = agentDropZone('gemini', { label: t('挂进这个对话') });

  // —— 模块定义（右上菜单 + 模型路由）——
  const FUNC_LABEL = { chat: t('对话'), image: t('图像'), video: t('视频'), voice: t('语音'), music: t('音乐') };
  const FUNC_CAPS = { chat: 'vertex', image: 'image', video: 'veo', voice: 'tts', music: 'music' };
  const FUNC_MODELKEY = { chat: 'chatModel', image: 'imageModel', video: 'videoModel', voice: 'voiceModel', music: 'musicModel' };
  // 模块图标：一律用 Gemini 原版 Luminous Symbols 字体 glyph（实测站上抓的连字名），
  // 不再用自绘 stroke SVG（那是 claude 页风格）。
  const FUNC_GLYPH = { chat: 'gemini_chat', image: 'image', video: 'videocam', voice: 'volume_up', music: 'music_note' };  // 全部实测存在于 Luminous 字体（graphic_eq 缺字形，用 volume_up）
  // 五个模块都随 Gemini 开关（服务端下发的 me.agents）。
  const FUNCS = $derived(agentOn('gemini') ? Object.keys(FUNC_LABEL) : []);
  // vs.func 指向菜单里没有的模块（例如旧状态里已下线的模块）：挪到第一个。
  $effect(() => { if (FUNCS.length && !FUNCS.includes(vs.func)) vs.func = FUNCS[0]; });

  const capBlock = $derived(caps.data?.[FUNC_CAPS[vs.func]] || {});
  const modelList = $derived(capBlock.models || []);
  const curModelId = $derived(vs[FUNC_MODELKEY[vs.func]] || capBlock.defaults?.model || modelList[0]?.id || '');
  const modelName = $derived((modelList.find((m) => m.id === curModelId) || {}).name || curModelId || '—');
  // 对话专属：思考档 + 联网搜索
  // 有些模型不吃 minimal（后端 thinkingFor 会静默夹成 low）——菜单里就别摆这一档，
  // 否则芯片显示 Minimal、真实跑的是 Low。名单以 caps.vertex.noMinimal 为准，
  // 不是「名字里带 pro」：3.8/3.7 Flash 同样拒（2026-09-02 逐档真打）。
  const thinkList = $derived(
    (caps.data?.vertex?.thinkLevels || [])
      .filter((lv) => lv.id !== 'minimal' || !(caps.data?.vertex?.noMinimal || []).includes(curModelId)),
  );
  const curThink = $derived(vs.chatThink || caps.data?.vertex?.defaults?.think || 'medium');
  // 停在 minimal 时切到不吃 minimal 的模型：把选择提到 low（后端本来就这么夹的），
  // 别留一个菜单里已经不存在的档位——那会让「思考等级」那行的副标题变成空白。
  $effect(() => { if (vs.func === 'chat' && curThink === 'minimal' && !thinkList.some((lv) => lv.id === 'minimal')) vs.chatThink = 'low'; });

  function pickModel(id) { vs[FUNC_MODELKEY[vs.func]] = id; }
  function pickThink(id) { vs.chatThink = id; }
  // 代码执行画的图表在正文里是 /api/vertex/media?id=… 相对链接：apk 里前端在本地、接口在远端，
  // 渲染前换成带 token 的完整地址（mediaUrl），网页端同样适用。
  const withMedia = (md) => (md && md.includes('](/api/vertex/media?id=') ? md.replace(/\]\(\/api\/vertex\/media\?id=([0-9a-fA-F-]{8,})\)/g, (_, id) => '](' + mediaUrl(id, 'preview') + ')') : md);
  // 对话工具：联网搜索 / URL 上下文 / 代码执行 + 识图清晰度 + 系统提示词（都在模型菜单里，改完落盘）。
  // 2.5 Flash/Pro 的代码执行不能和搜索类工具同开（Vertex 400，caps.vertex.codeSolo）：开一个就关另一边。
  const codeSolo = $derived((caps.data?.vertex?.codeSolo || []).includes(curModelId));
  const mediaResList = $derived(caps.data?.vertex?.mediaRes || []);
  const curMediaRes = $derived(vs.chatMediaRes || 'auto');
  let sysOpen = $state(false), sysDraft = $state('');
  function setChatOpt(key, on) {
    vs[key] = on;
    if (codeSolo && on) {
      if (key === 'chatCode') { vs.chatSearch = false; vs.chatUrl = false; }
      else if (key === 'chatSearch' || key === 'chatUrl') vs.chatCode = false;
    }
    saveVertexChatOpts();
  }
  function pickMediaRes(id) { vs.chatMediaRes = id; saveVertexChatOpts(); }
  function openSystem() { sysDraft = vs.chatSystem || ''; pickerOpen = false; sysOpen = true; }
  function saveSystem() { vs.chatSystem = sysDraft.trim().slice(0, caps.data?.vertex?.systemMax || 8000); saveVertexChatOpts(); sysOpen = false; }
  // 模块互切编排：先给 .v-stage 挂 .v-leaving 播离场（旧页 hero 缩回顶部 / 对话页淡出，190ms），
  // 再换 vs.func 重挂新面板——新面板的 hero 卡片自顶推下 + 正文错峰浮起（见 media-neo.css）。
  let funcLeaving = $state(false);
  let funcLeavingT = null;
  function pickFunc(id) {
    vs.funcMenuOpen = false; pickerOpen = false;
    if (id === vs.func || funcLeaving) return;
    // 禁用转场偏好直切。
    if (prefs.noEnterAnim) { vs.func = id; return; }
    funcLeaving = true;
    clearTimeout(funcLeavingT);
    funcLeavingT = setTimeout(() => { funcLeavingT = null; vs.func = id; funcLeaving = false; }, 190);
  }

  // —— 顶部弹层 ——
  let pickerOpen = $state(false);
  function togglePicker() { pickerOpen = !pickerOpen; vs.funcMenuOpen = false; }
  function toggleFuncMenu() { vs.funcMenuOpen = !vs.funcMenuOpen; pickerOpen = false; }
  function closePops() { pickerOpen = false; vs.funcMenuOpen = false; }

  // —— 历史抽屉（按当前模块：对话=会话列表；媒体=该模块自己的历史）——
  let sessions = $state([]);
  const FUNC_HIST = { image: t('历史图片'), video: t('历史视频'), voice: t('历史语音'), music: t('历史音乐') };
  const mediaHist = $derived(vs.func === 'chat' ? [] : (vmedia[vs.func]?.history || []));
  // 列表等值跳过：内容没变不赋值，反复开抽屉不重建列表 DOM（与 ClaudePage 同法）。
  const sameSessions = (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id && x.title === b[i].title);
  async function pullSessions() {
    // 缓存优先：空列表先用本地快照秒出（抽屉一拉开就有内容），网络刷新殿后；离线也有得看。
    if (!sessions.length) { try { const c = await getCachedVertexSessions(); if (c && c.length && !sessions.length) sessions = c; } catch {} }
    // 缓存/预取吃网络原样列表：等值跳过时 sessions 保留旧 mtime，预取器会漏掉刚更新的会话。
    try { const list = (await api.vertexSessions()).sessions || []; if (!sameSessions(sessions, list)) sessions = list; cacheVertexSessions(list); vprefetchSessions(list); }
    catch { if (!sessions.length) sessions = (await getCachedVertexSessions()) || []; }
  }
  function openDrawer() {
    vs.drawerOpen = true;
    // 网络刷新错峰到滑入动画之后（数据返回替换列表撞动画帧=开抽屉卡顿）；首次立即拉。
    if (vs.func === 'chat') { if (sessions.length) setTimeout(pullSessions, 320); else pullSessions(); }
    else { loadHistory(vs.func); }
  }
  let settingsOpen = $state(false);   // 侧栏齿轮拉开的设置子栏（主题 / 快速识图）
  function closeDrawer() { vs.drawerOpen = false; settingsOpen = false; }
  function pickSession(id) { closeDrawer(); vloadSession(id); }
  function freshNew() {
    closeDrawer(); closePops();
    if (vs.func === 'chat') vnewChat();
    else if (vs.func === 'image') newImageChat();   // 图像：清空对话，回到空白
    else vmedia[vs.func].result = null;             // 视频/语音/音乐：清空当前结果
  }
  async function delSession(id, e) {
    e.stopPropagation();
    // 乐观更新：先移除（即时反应，不等隧道往返），删除请求后台跑，失败回滚条目。
    const prev = sessions;
    sessions = sessions.filter((s) => s.id !== id);
    try {
      const r = await api.deleteVertexSession(id);
      if (r && r.ok === false) throw new Error(t('服务器未删除该会话'));
      await Promise.all([cacheVertexSessions(sessions), removeCachedVertexMessages(id)]);
      if (vchat.sessionId === id) vnewChat();
    } catch (e2) {
      sessions = prev;
      const detail = typeof e2?.body === 'string' ? e2.body : (e2?.body?.error || e2?.body?.message || e2?.message || '');
      uiAlert(t('删除失败，请重试'), { type: 'error', detail: tr(detail) });
    }
  }
  // 媒体历史点击：图像=还原整条修改链续改；视频/语音/音乐=加载结果区播放
  function pickMedia(h) {
    closeDrawer();
    if (vs.func === 'image') openImageChat(h);
    else vmedia[vs.func].result = { id: h.id, prompt: h.prompt || h.title || '', kind: vs.func === 'voice' ? 'audio' : vs.func };
  }
  // 图像删的是整条会话（链上图全清）；其余删单个媒体文件。
  function delMediaItem(id, e) { e.stopPropagation(); if (vs.func === 'image') delImageChat(id); else delMedia(vs.func, id); }

  // —— 返回主页：这一页收回它自己的入口（lib/pageMorph.js 的 closePage），与 ClaudePage 同一套 ——
  // 旧版整页右滑出 + 长尾弹簧（落地回调改 screen 的竞态见 ClaudePage 注释）已退役；
  // 左缘右滑＝预测式返回（backPeek：缩小 + 圆角 + 身后露主页），松手完成就从此刻形态续走收回入口。
  let dragX = $state(0), sliding = $state(false);
  let slideEl = $state();
  const peek = $derived(backPeek(dragX));
  function resetSlide() { vs.drawerOpen = false; dragX = 0; sliding = false; ui.vertexSliding = false; }
  // 参数一律不认：本函数还被直接当 onclick 处理器用（onclick={slideOut}），会收到 PointerEvent。
  function slideOut() {
    if (ui.screen !== 'vertex') return;
    closePage('vertex', { onSwitch: resetSlide });
  }
  // 系统返回 / 安卓侧滑：先收弹层 → 收抽屉 → 否则收回入口回主页。
  $effect(() => registerCloser('vertexSlide', () => {
    if (vs.matPicker) { vs.matPicker = false; return; }     // 素材选择器
    if (vs.matMenu) { vs.matMenu = false; return; }         // 素材来源菜单
    if (closeNeoSheet()) return;                            // vmx 浮层（模型选单/参数面板/槽位选择）
    if (sysOpen) { sysOpen = false; return; }               // 系统提示词编辑器
    if (vs.drawerOpen) { closeDrawer(); return; }
    if (pickerOpen || vs.funcMenuOpen) { closePops(); return; }
    slideOut();
  }));
  const edgeSwipe = (node) => swipeDismiss(node, {
    axis: 'x', dir: 1, edge: 40, threshold: 0.32,
    guard: () => !(vs.drawerOpen || ui.morphing),
    base: () => dragX, cur: () => dragX,
    onStart: () => { sliding = true; ui.vertexSliding = true; },
    onMove: (x) => { dragX = x; },
    onSettle: (go) => { if (!go) { sliding = false; ui.vertexSliding = false; } },
    onCommit: () => {
      const rect = () => { const r = slideEl?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; };
      closePage('vertex', {
        fromRect: rect, fromRadius: peek.r, onSwitch: resetSlide,
      });
    },
  });

  // —— 输入 ——
  let field = $state();
  let hasText = $state(false);
  // 问候语：真实 Gemini 是随机池（实测见过「想了解什么，尽管问吧！」「今天有什么安排？」
  // 「嗨，…今天心情怎么样？」等），32px / 字重 360。挂载时抽一条。
  const GREETS = [t('想了解什么，尽管问吧！'), t('今天有什么安排？'), t('今天心情怎么样？'), t('有什么可以帮忙的？')];
  const greetPick = GREETS[Math.floor(Math.random() * GREETS.length)];
  const greetText = $derived(me.user ? t('{name}，{greeting}', { name: me.user, greeting: greetPick }) : greetPick);
  function onInput() { hasText = !!(field?.textContent || '').trim(); }

  // —— 桌面/移动响应式（真实 Gemini 同款：窗口够宽走桌面版左栏+内容区，窄走移动版）——
  //   desktop=false 时完全等价旧版移动布局；desktop=true 时启用桌面 chrome（左栏/侧边栏/顶栏内嵌模型选择器）。
  let desktop = $state(false);
  let sideExpanded = $state(false);   // 桌面侧边栏展开（左上 side_nav 钮切换；折叠=52px 图标栏，展开=276px 带最近列表）
  let dtSettingsOpen = $state(false); // 桌面左下设置菜单（含官方明暗主题面板 + 快速识图）
  function pickTheme(th) { if (vs.theme !== th) toggleVertexTheme(); }   // 官方主题面板：浅色/深色单选
  // 门槛跟随 layout.side（≥700）：折叠屏展开 ~750px 也吃桌面版三栏，
  // 原来卡 900 会让展开态继续显示手机版。断点单源见 lib/layout.svelte.js。
  $effect(() => { desktop = layout.side; });
  // 进 vertex 对话页即预热列表（桌面常驻栏 + 移动抽屉共用）：本地缓存先出 + 网络刷新 +
  // 正文预取，抽屉一拉开就有内容、点会话秒进。untrack：pullSessions 内读 sessions，别成依赖。
  $effect(() => { if (ui.screen === 'vertex' && vs.func === 'chat') untrack(pullSessions); });

  // —— 附件（+ 号真实上传；图片/PDF 以 inlineData 喂 Gemini，单文件 ≤7MB）——
  let fileInput = $state();
  let vAtts = $state([]);          // {path,name,kind,url,pending}
  const uploading = $derived(vAtts.some((a) => a.pending));
  // 工作空间「发送给 AI」→ Gemini：把待投递附件并进 vAtts（VertexPage 挂载/变化时消费，用后清空）。
  $effect(() => { const d = vs.chatDraftAtts; if (d && d.length) { vAtts.push(...d); vs.chatDraftAtts = []; } });
  function pickFiles() { fileInput && fileInput.click(); }
  // 上传一批文件挂成附件（+号选择 / 桌面粘贴 / 拖入 共用）。图片 ≤7MB 走 inlineData 喂 Gemini。
  async function addFiles(files) {
    for (const f of files) {
      if (f.size > 7_000_000) { uiAlert(t('{name}：超过 7MB（Gemini 附件上限）', { name: f.name })); continue; }
      const isImg = (f.type || '').startsWith('image/');
      await uploadAttachment(vAtts, f, {
        draft: { path: null, name: f.name, kind: isImg ? 'image' : 'file', url: isImg ? URL.createObjectURL(f) : null, pending: true },
        upload: async (file) => api.upload(file.name, await fileToBase64(file)),
        onError: () => uiAlert(t('上传失败：{name}', { name: f.name })),
      });
    }
  }
  function onFiles(e) { addFiles(filesFromInput(e)); }
  let dragOver = $state(false);   // 桌面拖文件进对话区时的高亮态
  function removeAtt(a) { removeAttachment(vAtts, a); }

  // —— composer 两态（仿真机 Gemini app，见参考截图）：collapsed=单行 [+][编辑][mic]；
  // 聚焦/有字/有附件 → expanded=双层（上编辑区，下排 [+] … [mic][发送]）。
  // focusout 延迟收起，避免点 composer 内按钮时闪烁。
  let fieldFocus = $state(false);
  let blurT = null;
  // 展开效果仅在【对话过程中】出现；首页（新对话 greeting）保持单行，发送键行内出现。
  // 桌面版输入胶囊恒为单行 pill（[+][编辑][模型⌄][mic/发送]），不走移动版双层展开。
  const expanded = $derived(!desktop && vchat.view === 'chat' && (fieldFocus || hasText || vAtts.length > 0));
  function onFieldFocus() { clearTimeout(blurT); fieldFocus = true; }
  function onFieldBlur() { clearTimeout(blurT); blurT = setTimeout(() => (fieldFocus = false), 160); }
  onDestroy(() => {
    clearTimeout(blurT);
    clearTimeout(funcLeavingT);
    for (const a of vAtts) {
      if (typeof a?.url === 'string' && a.url.startsWith('blob:')) {
        try { URL.revokeObjectURL(a.url); } catch {}
      }
    }
  });
  function submit() { if (uploading) return; const txt = (field?.innerText || '').replace(/ /g, ' ').trim(); if ((!txt && !vAtts.filter((a) => !a.pending).length) || vchat.busy) return; const atts = vAtts.filter((a) => !a.pending); field.textContent = ''; hasText = false; vAtts = []; vsend(txt, atts); }
  // 触屏 Enter=换行（与 claude 页一致：手机没有 Shift，发送靠按钮）
  const touchUI = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  function onKey(e) { if (e.key === 'Enter' && !e.shiftKey && !touchUI) { e.preventDefault(); submit(); } }

  // —— 消息动作（复制 / 重试，gemini 动作排——只放真实可用的）——
  async function copyMsg(m) {
    if (!m.md) return;
    try { await navigator.clipboard.writeText(m.md); }
    catch { const ta = document.createElement('textarea'); ta.value = m.md; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch {} ta.remove(); }
    m.copied = true; setTimeout(() => (m.copied = false), 1400);
  }
  function retryFrom(i) {
    if (vchat.busy) return;
    for (let j = i - 1; j >= 0; j--) {
      if (vchat.messages[j].role === 'user') {
        const u = vchat.messages[j];
        vsend(u.text, (u.atts || []).filter((a) => a.path));
        return;
      }
    }
  }

  // —— 思考动画：1:1 复现原版 Lottie 编排（"Icons Three Dots A 28x28"，693帧@60fps≈11.5s 循环）。
  // 参数为从真实组件提取的三层位置关键帧（合成空间→28px 画布：x-36, y-36；点径 4px）：
  //   0~3.4s 波动（周期1.2s、相位差200ms 左→中→右传波）→ 3.9~8s 三角环绕（两构型对角互换）
  //   → 8.7~11.5s 回归波动收尾成环。思考短只见波动、思考久自然进入环绕——与原版同逻辑。
  const TD_T = 692, TD_EASE = 'cubic-bezier(.45,0,.55,1)';
  const TD_KF = [
    [[0,43.4,53.7],[12,43.4,55],[48,43.4,45],[84,43.4,55],[120,43.4,45],[156,43.4,55],[192,43.4,45],[235,53.2,59.6],[268,43.4,43.1],[301,53.2,59.6],[337,43.4,43.1],[373,53.2,59.6],[409,43.4,43.1],[445,53.2,59.6],[481,43.4,43.1],[524,43.4,45],[536,43.4,45],[560,43.4,55],[596,43.4,45],[632,43.4,55],[668,43.4,45],[692,43.4,53.7]],
    [[0,50,47],[24,50,55],[60,50,45],[96,50,55],[132,50,45],[168,50,55],[204,50,45],[235,40.7,47.8],[268,59.6,47.8],[301,40.7,47.8],[337,59.6,47.8],[373,40.7,47.8],[409,59.6,47.8],[445,40.7,47.8],[481,59.6,47.8],[522,50,45],[536,50,45],[572,50,55],[608,50,45],[644,50,55],[680,50,45],[692,50,47]],
    [[0,56.6,45],[36,56.6,55],[72,56.6,45],[108,56.6,55],[144,56.6,45],[180,56.6,55],[235,56.6,43.1],[268,47.2,59.4],[301,56.6,43.1],[337,47.2,59.4],[373,56.6,43.1],[409,47.2,59.4],[445,56.6,43.1],[481,47.2,59.4],[536,56.6,45],[584,56.6,55],[620,56.6,45],[656,56.6,55],[692,56.6,45]],
  ];
  function tdots(node) {
    const anims = [...node.children].map((dot, i) => dot.animate(
      TD_KF[i].map(([fr, x, y]) => ({ offset: Math.min(1, fr / TD_T), transform: `translate(${(x - 38).toFixed(1)}px, ${(y - 38).toFixed(1)}px)`, easing: TD_EASE })),
      { duration: 11515, iterations: Infinity }
    ));
    return { destroy() { anims.forEach((a) => a.cancel()); } };
  }

  // —— thread 自动滚动（贴底才跟随，发新消息必滚）——
  let scrollEl = $state(), atBottom = $state(true), lastN = 0;
  let lastArrRef = vchat.messages;
  let pendingBottom = false;
  function toBottom() {
    if (!scrollEl) return;
    if (!scrollEl.clientHeight) { pendingBottom = true; return; }
    scrollEl.scrollTop = scrollEl.scrollHeight;
    pendingBottom = false;
  }
  function onScroll() { if (scrollEl) atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 120; }
  $effect(() => {
    const arr = vchat.messages;
    const n = arr.length; const m = arr[n - 1];
    let _ = m && m.role === 'assistant' ? (m.md?.length || 0) : 0;
    const swapped = arr !== lastArrRef; lastArrRef = arr;
    if (swapped) atBottom = true;
    const nm = n > lastN || swapped; lastN = n;
    if (scrollEl && (nm || atBottom)) requestAnimationFrame(toBottom);
  });
  $effect(() => {
    if (ui.screen !== 'vertex' || vs.func !== 'chat' || !pendingBottom) return;
    toBottom();
    requestAnimationFrame(() => { toBottom(); requestAnimationFrame(toBottom); });
  });
</script>

<!-- transform / clip-path 只在左缘右滑跟手期间有值（预测式返回）；入场 / 返回都在转场快照上做。
     问候语上方的 .v-land-star 是入场共享元素的落点（主页方块里那颗十字星飞过来）。 -->
<div class="vertex-slide" class:sliding class:v-dt-slide={desktop} bind:this={slideEl} style:transform={peek.transform}
     style:clip-path={peek.clip} use:edgeSwipe>
<div class="vertex-root" class:v-dark={vs.theme === 'dark'} class:v-dt={desktop} class:side-open={desktop && sideExpanded} class:v-noanim={prefs.noEnterAnim}>

  <!-- 桌面版左栏/侧边栏 + 顶栏（真实 Gemini 桌面三栏结构；折叠 52px 图标栏 ↔ 展开 276px 最近列表）-->
  {#if desktop}
    {@render desktopSide()}
    {@render desktopTop()}
  {/if}

  <!-- 移动版顶部浮层 -->
  {#if !desktop}
  <header class="v-header" class:v-h-media={vs.func !== 'chat'}>
    <div class="v-left">
      <button class="v-iconbtn" aria-label={t('历史')} onclick={openDrawer}><span class="lumi" style="font-size:27px">menu</span></button>
      {#if vs.func === 'chat'}
      <div class="v-model-wrap">
        <button class="v-model" onclick={togglePicker} aria-label={t('选择模型')}>
          <span class="v-model-main">Gemini</span>
          <span class="v-model-sub">{modelName}</span>
          <svg class="v-chev" viewBox="0 0 20 20"><path fill="currentColor" d="M14.13 7.17a.5.5 0 0 1 .74.67l-4.5 5a.5.5 0 0 1-.74 0l-4.5-5a.5.5 0 1 1 .74-.67L10 11.75z"/></svg>
        </button>
        {#if pickerOpen}
          <button class="v-pop-scrim" aria-label={t('关闭')} onclick={closePops}></button>
          <div class="v-picker v-pk-chat" transition:fly={{ y: -8, duration: 160 }}>{@render pickerBody()}</div>
        {/if}
      </div>
      {/if}
    </div>

    <div class="v-right">
      <button class="v-iconbtn" aria-label={t('新对话')} onclick={freshNew}><span class="lumi" style="font-size:28px">plus</span></button>
      <div class="v-func-wrap">
        <button class="v-func" onclick={toggleFuncMenu} aria-label={t('功能模块')}>
          <span class="lumi" style="font-size:23px">{FUNC_GLYPH[vs.func]}</span>
          <span class="lumi v-chev-g">keyboard_arrow_down</span>
        </button>
        {#if vs.funcMenuOpen}
          <button class="v-pop-scrim" aria-label={t('关闭')} onclick={closePops}></button>
          <div class="v-funcmenu" transition:fly={{ y: -8, duration: 160 }}>
            <div class="v-pick-sec">{t('功能模块')}</div>
            {#each FUNCS as f (f)}
              <button class="v-pick-row" class:sel={f === vs.func} onclick={() => pickFunc(f)}>
                <span class="v-func-ico lumi" style="font-size:21px">{FUNC_GLYPH[f]}</span>
                <span class="v-pick-name">{FUNC_LABEL[f]}</span>
                {#if f === vs.func}<span class="lumi v-pick-ck">check</span>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </header>
  {/if}

  <!-- 主区。对话模块：输入条【常驻底部】（真实 Gemini 结构）——greeting 只是上方留白区的
       居中内容。这同时根治了键盘遮挡：旧版 greeting 把输入框垂直居中，键盘弹出视口缩小后
       居中块溢出、输入框被压到键盘下；钉底的输入条会随视口底边一起抬升。 -->
  <div class="v-stage" class:v-leaving={funcLeaving}>
    {#if vs.func === 'chat'}
      <div class="v-chat" class:v-dt-greet={desktop && vchat.view === 'greeting'} class:dnd-on={drag.overKey === 'chat:gemini'} use:dropZone={geminiDrop} use:fileDrop={{ onEnter: () => (dragOver = true), onLeave: () => (dragOver = false), onDrop: addFiles }} use:pasteFiles={{ onFiles: addFiles }}>
      {#if vchat.view === 'greeting'}
        <div class="v-glow" aria-hidden="true"></div>
        <!-- 桌面版极光背景（复刻真实 Gemini nl-blob：彩虹渐变条旋转 + 有机 blob 遮罩 + 模糊，缓慢流动；仅桌面显示）-->
        <div class="v-dt-aura" aria-hidden="true"><div class="v-dt-aura-blob"></div></div>
        <main class="v-hero">
          <!-- |global：媒体模块切回对话时（外层 {#if vs.func} 重建）问候语也要重播入场 -->
          <div class="v-greet" in:fly|global={{ y: 14, duration: 420 }}>
            {#if !desktop}<span class="v-greet-star v-land-star"><GeminiSparkle size={44} glow /></span>{/if}
            <h1>{greetText}</h1>
          </div>
        </main>
      {:else}
        <div class="v-scroll" bind:this={scrollEl} onscroll={onScroll}>
          <div class="v-thread">
            {#each vchat.messages as m, i (i)}
              {#if m.role === 'user'}
                <div class="v-turn-user">
                  <div class="v-bubble sel-text">
                    {#if m.atts && m.atts.length}
                      <div class="v-b-atts">{#each m.atts as a}<span class="v-b-att" use:dragOut={() => attDragSrc(a)}>{#if a.kind === 'image' && a.url}<img src={a.url} alt={a.name} />{:else}📎 {a.name}{/if}</span>{/each}</div>
                    {/if}
                    {m.text}
                  </div>
                </div>
              {:else}
                <div class="v-turn-model">
                  {#if m.status === 'streaming' && !m.md.trim()}
                    <!-- 思考动画：原版 Lottie 编排 1:1 复现（波动→三角环绕→回归，11.5s 循环），见 tdots() -->
                    <span class="v-tdots" use:tdots><i></i><i></i><i></i></span>
                  {/if}
                  <!-- 分块流式渲染（与 claude 页同法）：前缀块稳定不重渲染，delta 只动末块 -->
                  {#if m.md.trim()}<div class="g-md sel-text" use:streamFade={{ md: m.md, live: m.status === 'streaming' }}>{#each streamBlocks(m, m.md) as blk}{@html renderMarkdown(withMedia(blk))}{/each}</div>{/if}
                  {#if m.status === 'error'}<div class="v-err sel-text">{tr(m.error)}</div>{/if}
                  {#if i === vchat.messages.length - 1 && m.status === 'streaming' && m.md.trim()}
                    <div class="v-foot">{fmtElapsed(m.elapsed)}</div>
                  {/if}
                  {#if m.status !== 'streaming' && m.md.trim()}
                    <div class="v-actions">
                      <button class="v-act" aria-label={t('复制')} onclick={() => copyMsg(m)}><span class="lumi" style="font-size:20px">{m.copied ? 'check' : 'content_copy'}</span></button>
                      <button class="v-act" aria-label={t('重试')} disabled={vchat.busy} onclick={() => retryFrom(i)}><span class="lumi" style="font-size:21px">refresh</span></button>
                    </div>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        </div>
      {/if}
      <div class="v-composer-wrap" class:v-cw-chat={vchat.view === 'chat'}>
        {@render composer()}
      </div>
      {#if dragOver}
        <!-- 文件拖拽提示（照搬真站：回形针图标 + 「将文件拖放到此处」+ 蓝色虚线框）-->
        <div class="g-drop-ov g-drop-clip" aria-hidden="true">
          <svg class="g-drop-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          <span class="g-drop-tx">{t('将文件拖放到此处')}</span>
        </div>
      {/if}
      </div>
    {:else if vs.func === 'image'}
      <VImagePanel />
    {:else if vs.func === 'video'}
      <VVideoPanel />
    {:else if vs.func === 'voice'}
      <VVoicePanel />
    {:else if vs.func === 'music'}
      <VMusicPanel />
    {/if}
  </div>

  <!-- 历史抽屉 -->
  <button class="v-scrim {vs.drawerOpen ? 'open' : ''}" aria-label={t('关闭')} onclick={closeDrawer}></button>
  <aside class="v-drawer {vs.drawerOpen ? 'open' : ''}">
    <div class="v-brand">
      <GeminiSparkle size={22} /><span>Gemini</span>
      <button class="v-iconbtn v-d-gear" class:on={settingsOpen} aria-label={t('设置')} onclick={() => (settingsOpen = !settingsOpen)}>
        <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </div>
    {#if settingsOpen}
      <div class="v-settings">
        <button class="v-set-row" onclick={toggleVertexTheme} type="button">
          <span class="v-set-ic">
            {#if vs.theme === 'dark'}
              <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
            {:else}
              <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M4 12H1.6M22.4 12H20M5.6 5.6 3.95 3.95M20.05 20.05 18.4 18.4M18.4 5.6l1.65-1.65M3.95 20.05 5.6 18.4"/></svg>
            {/if}
          </span>
          <span class="v-set-tx">{t('深色主题')}<small>{vs.theme === 'dark' ? t('当前：深色') : t('当前：浅色')}</small></span>
          <span class="v-switch" class:on={vs.theme === 'dark'}><span class="v-knob"></span></span>
        </button>
        <button class="v-set-row" onclick={() => setVertexFastVision(vs.fastVision === false)} type="button">
          <span class="v-set-ic"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg></span>
          <span class="v-set-tx">{t('快速识图')}<small>{t('图片自动降画质、识图更快；关掉发原图更清晰但更慢')}</small></span>
          <span class="v-switch" class:on={vs.fastVision !== false}><span class="v-knob"></span></span>
        </button>
      </div>
    {/if}
    <button class="v-d-item" onclick={slideOut}><span class="lumi v-d-ic">arrow_back</span>{t('主页')}</button>
    <button class="v-d-item" onclick={freshNew}><span class="lumi v-d-ic">gemini_chat</span>{vs.func === 'chat' ? t('发起新对话') : t('新建')}</button>
    {#if vs.func === 'chat'}
      <div class="v-d-sec">{t('历史对话')}</div>
      <div class="v-d-list">
        {#each sessions as s (s.id)}
          <div class="v-d-row" class:cur={s.id === vchat.sessionId}>
            <button class="v-d-pick" onclick={() => pickSession(s.id)}>{tr(s.title) || t('（无标题）')}</button>
            <button class="v-d-del" aria-label={t('删除')} onclick={(e) => delSession(s.id, e)}><span class="lumi" style="font-size:18px">delete</span></button>
          </div>
        {/each}
        {#if !sessions.length}<div class="v-d-empty">{t('还没有历史对话')}</div>{/if}
      </div>
    {:else}
      <div class="v-d-sec">{FUNC_HIST[vs.func]}</div>
      {#if vs.func === 'image' || vs.func === 'video'}
        <div class="vm-grid" style="padding:0 4px">
          {#each mediaHist as h (h.id)}
            <div class="vm-thumb" role="button" tabindex="0" onclick={() => pickMedia(h)} use:dragOut={() => mediaDragSrc(h.coverId || h.id, h.title || h.prompt || '')}>
              <!-- 网格一律 <img> 缩略图（视频=ffmpeg 海报帧）：手机 WebView 的多 <video> 网格会撞
                   解码器上限白块。加载失败隐藏 img 露出灰底+角标，不出碎图图标。
                   图像=会话封面（链上最新一张，coverId）；视频=自身 id。 -->
              <img src={mediaUrl(h.coverId || h.id, 'thumb')} alt="" loading="lazy" onerror={(e) => { const n = mediaFallbackUrl(e.currentTarget.src); if (n !== e.currentTarget.src) e.currentTarget.src = n; else e.currentTarget.style.opacity = '0'; }} />
              {#if vs.func === 'video'}<span class="vm-play lumi">play_arrow</span>{/if}
              {#if vs.func === 'image' && h.count > 1}<span class="vm-count"><span class="lumi" style="font-size:14px">layers</span>{h.count}</span>{/if}
              <button class="vm-del" aria-label={t('删除')} onclick={(e) => delMediaItem(h.id, e)}>×</button>
            </div>
          {/each}
        </div>
      {:else}
        <div class="v-d-list">
          {#each mediaHist as h (h.id)}
            <div class="v-d-row">
              <button class="v-d-pick" onclick={() => pickMedia(h)}>{h.prompt || tr(h.title) || (vs.func === 'voice' ? t('语音') : t('音乐'))}</button>
              <button class="v-d-del" aria-label={t('删除')} onclick={(e) => delMediaItem(h.id, e)}><span class="lumi" style="font-size:18px">delete</span></button>
            </div>
          {/each}
        </div>
      {/if}
      {#if !mediaHist.length}<div class="v-d-empty">{t('还没有历史')}</div>{/if}
    {/if}
  </aside>

  {#if sysOpen}
    <!-- 系统提示词编辑器：对所有对话生效（本机保存），留空 = 不设 -->
    <button class="v-sys-scrim" aria-label={t('关闭')} onclick={() => (sysOpen = false)}></button>
    <div class="v-sys" role="dialog" aria-label={t('系统提示词')} transition:fly={{ y: 16, duration: 180 }}>
      <div class="v-sys-tt">{t('系统提示词')}<small>{t('对之后的每条消息都生效，只存在这台设备上')}</small></div>
      <textarea class="v-sys-ta" bind:value={sysDraft} maxlength={caps.data?.vertex?.systemMax || 8000}
        placeholder={t('例如：你是一位严谨的中文技术编辑，回答简洁，先给结论再给理由。')}></textarea>
      <div class="v-sys-row">
        <span class="v-sys-n">{sysDraft.length} / {caps.data?.vertex?.systemMax || 8000}</span>
        <button class="v-sys-b" onclick={() => (sysDraft = '')}>{t('清空')}</button>
        <button class="v-sys-b" onclick={() => (sysOpen = false)}>{t('取消')}</button>
        <button class="v-sys-b on" onclick={saveSystem}>{t('保存')}</button>
      </div>
    </div>
  {/if}
</div>
</div>

{#snippet composer()}
  <!-- 真实 Gemini 输入条（实测+参考截图）：白底无边框、radius 40、软阴影、17px 编辑区。
       两态：collapsed=单行 [+][编辑][mic/停止]（h=80）；聚焦/有字/有附件=expanded 双层
       （附件chips + 编辑行 + 按钮排 [+] … [mic][蓝圆发送/黑圆停止]）。
       + = 真实文件上传（图片/PDF → Gemini inlineData）；mic = 占位（语音待做）。 -->
  <div class="v-composer" class:expanded>
    {#if vAtts.length}
      <div class="v-c-atts">
        {#each vAtts as a, ai (a.path || 'p' + ai)}
          <div class="v-c-att" class:img={a.kind === 'image'} class:pending={a.pending} use:dragOut={() => attDragSrc(a)}>
            {#if a.kind === 'image' && a.url}<img src={a.url} alt={a.name} />{:else}<span class="v-c-att-name">{a.name}</span>{/if}
            {#if a.pending}<span class="v-c-spin"></span>{/if}
            <button class="v-c-att-x" aria-label={t('移除')} onclick={() => removeAtt(a)}>×</button>
          </div>
        {/each}
      </div>
    {/if}
    <div class="v-c-main">
      <button class="v-cir v-row-only" aria-label={t('上传文件')} onclick={pickFiles}><span class="lumi" style="font-size:28px">plus</span></button>
      <div class="v-field" bind:this={field} contenteditable="true" data-ph={t('问问 Gemini')} role="textbox" tabindex="0" aria-multiline="true"
        oninput={onInput} onkeydown={onKey} onpaste={pastePlainText} onfocus={onFieldFocus} onpointerdown={onFieldFocus} onblur={onFieldBlur}></div>
      {#if desktop && vs.func === 'chat'}
        <!-- 桌面版：模型选择器内嵌在输入胶囊右侧（真实 Gemini 桌面形态：pill「Flash ⌄」），菜单向上弹 -->
        <div class="v-dt-model-wrap">
          <button class="v-dt-model" onclick={togglePicker} aria-label={t('打开模式选择器')}>{modelName}<span class="lumi v-chev-g">keyboard_arrow_down</span></button>
          {#if pickerOpen}
            <button class="v-pop-scrim" aria-label={t('关闭')} onclick={closePops}></button>
            <div class="v-picker v-picker-up v-pk-chat" transition:fly={{ y: 8, duration: 160 }}>{@render pickerBody()}</div>
          {/if}
        </div>
      {/if}
      {#if vchat.busy}
        <button class="v-cir v-stop v-row-only" aria-label={t('停止')} onclick={vstop}><svg viewBox="0 0 20 20" width="12" height="12"><rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor"/></svg></button>
      {:else}
        <button class="v-cir v-row-only" aria-label={t('语音输入（即将上线）')}><span class="lumi" style="font-size:28px">mic</span></button>
        {#if !expanded && (hasText || vAtts.length)}
          <!-- 首页（不展开）：发送键行内出现在 mic 右侧（实测 web 原版同款行为） -->
          <button class="v-cir v-go v-row-only" aria-label={t('发送')} disabled={uploading} onclick={submit}><span class="lumi" style="font-size:26px">arrow_upward</span></button>
        {/if}
      {/if}
    </div>
    <div class="v-c-bar">
      <button class="v-cir" aria-label={t('上传文件')} onclick={pickFiles}><span class="lumi" style="font-size:28px">plus</span></button>
      <span class="v-c-sp"></span>
      <button class="v-cir" aria-label={t('语音输入（即将上线）')}><span class="lumi" style="font-size:28px">mic</span></button>
      {#if vchat.busy}
        <button class="v-cir v-stop" aria-label={t('停止')} onclick={vstop}><svg viewBox="0 0 20 20" width="12" height="12"><rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor"/></svg></button>
      {:else if hasText || vAtts.length}
        <button class="v-cir v-go" aria-label={t('发送')} disabled={uploading} onclick={submit}><span class="lumi" style="font-size:26px">arrow_upward</span></button>
      {/if}
    </div>
    <input type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/gif,image/heic,.pdf" bind:this={fileInput} onchange={onFiles} />
  </div>
{/snippet}

{#snippet pickerBody()}
  <!-- 模型选择器菜单体（移动版顶栏 pill 下拉 / 桌面版输入胶囊内嵌 pill 上弹 共用）。
       对话模块：模型 + 这一轮的全部设置（思考等级 / 工具 / 识图清晰度 / 系统提示词）都在这一张菜单里，
       输入框上不再有单独的「工具」按钮。桌面两栏并排（左模型、右设置）——v5.88 把设置接在模型列表末尾，
       上弹菜单超出窗口、末尾几项落在滚动区底下找不到；手机单栏，宽度撑满屏幕、高度给到屏幕底。 -->
  <div class="v-pk-models">
    {#each modelList as m (m.id)}
      <button class="v-pick-row v-pick-m" class:sel={m.id === curModelId} onclick={() => pickModel(m.id)}>
        <span class="v-pick-ck2">{#if m.id === curModelId}<span class="lumi">check</span>{/if}</span>
        <span class="v-pick-mtx"><span class="v-pick-name">{tr(m.name)}</span>{#if m.desc}<small class="v-pick-desc">{tr(m.desc)}</small>{/if}</span>
      </button>
    {/each}
  </div>
  {#if vs.func === 'chat'}
    <div class="v-pk-opts">
      <div class="v-pk-lab">{tc('vertex', '思考等级')}</div>
      <div class="v-seg">
        {#each thinkList as lv (lv.id)}
          <button class="v-seg-b" class:on={lv.id === curThink} onclick={() => pickThink(lv.id)}>{tr(lv.name)}</button>
        {/each}
      </div>
      <div class="v-pk-lab">{t('工具')}</div>
      <button class="v-toggle-row" onclick={() => setChatOpt('chatSearch', !vs.chatSearch)}>
        <span class="v-tg-tx">{tc('vertex', '联网搜索')}</span>
        <span class="v-switch" class:on={vs.chatSearch}><span class="v-knob"></span></span>
      </button>
      <button class="v-toggle-row" onclick={() => setChatOpt('chatUrl', !vs.chatUrl)}>
        <span class="v-tg-tx">{t('读取网址')}</span>
        <span class="v-switch" class:on={vs.chatUrl}><span class="v-knob"></span></span>
      </button>
      <button class="v-toggle-row" onclick={() => setChatOpt('chatCode', !vs.chatCode)}>
        <span class="v-tg-tx">{t('代码执行')}{#if codeSolo}<small>{t('这个模型开它会关掉联网和读取网址')}</small>{/if}</span>
        <span class="v-switch" class:on={vs.chatCode}><span class="v-knob"></span></span>
      </button>
      <div class="v-pk-lab">{t('识图清晰度')}</div>
      <div class="v-seg">
        {#each mediaResList as r (r.id)}
          <!-- 菜单里只放短名（「低 · 最省」→「低」），说明放 title -->
          <button class="v-seg-b" class:on={r.id === curMediaRes} title={tr(r.name)} onclick={() => pickMediaRes(r.id)}>{tr(r.name).split(' · ')[0]}</button>
        {/each}
      </div>
      <button class="v-toggle-row v-pk-sys" onclick={openSystem}>
        <span class="v-tg-tx">{t('系统提示词')}<small class="v-sys-sum">{(vs.chatSystem || '').trim() || t('未设置')}</small></span>
        <span class="lumi v-chev-g">chevron_right</span>
      </button>
    </div>
  {/if}
{/snippet}

{#snippet desktopSide()}
  <!-- 桌面左栏：折叠=52px 图标竖条 / 展开=276px 带「最近」列表（真实 Gemini 桌面结构；搜索/库/笔记本按需求略去）-->
  <aside class="v-dt-side" class:open={sideExpanded}>
    <div class="v-dt-side-head">
      {#if sideExpanded}
        <div class="v-dt-brand"><GeminiSparkle size={24} /><span>Gemini</span></div>
        <button class="v-dt-ic" aria-label={t('收起边栏')} onclick={() => (sideExpanded = false)}><span class="lumi" style="font-size:24px">side_nav</span></button>
      {:else}
        <!-- 折叠态左上：默认显示 Gemini 星标，鼠标悬停时变形为「打开边栏」按钮（照搬真站 side-nav-sparkle-button 的 :hover 切换）-->
        <div class="v-dt-sparkbtn">
          <span class="v-dt-spark"><GeminiSparkle size={26} /></span>
          <button class="v-dt-ic v-dt-expand" aria-label={t('展开边栏')} onclick={() => (sideExpanded = true)}><span class="lumi" style="font-size:24px">side_nav_expand</span></button>
        </div>
      {/if}
    </div>
    <button class="v-dt-item" onclick={freshNew}><span class="lumi v-dt-item-ic">gemini_chat</span><span class="v-dt-item-tx">{t('发起新对话')}</span></button>
    {#if sideExpanded}
      <div class="v-dt-recent">
        <div class="v-dt-sec">{t('最近')}</div>
        {#each sessions as s (s.id)}
          <div class="v-dt-conv" class:cur={s.id === vchat.sessionId}>
            <button class="v-dt-conv-pick" onclick={() => pickSession(s.id)}>{tr(s.title) || t('（无标题）')}</button>
            <button class="v-dt-conv-del" aria-label={t('删除')} onclick={(e) => delSession(s.id, e)}><span class="lumi" style="font-size:17px">delete</span></button>
          </div>
        {/each}
        {#if !sessions.length}<div class="v-dt-empty">{t('还没有历史对话')}</div>{/if}
      </div>
    {/if}
    <div class="v-dt-side-foot">
      <button class="v-dt-item" onclick={slideOut}><span class="lumi v-dt-item-ic">arrow_back</span><span class="v-dt-item-tx">{t('主页')}</span></button>
      <!-- 左下设置按钮（照搬真站左下齿轮）：点开设置菜单（官方 desktop-settings-menu 样式）-->
      <div class="v-dt-gear-wrap">
        <button class="v-dt-item v-dt-gearbtn" aria-label={t('设置')} onclick={() => (dtSettingsOpen = !dtSettingsOpen)}>
          <span class="v-dt-item-ic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
          <span class="v-dt-item-tx">{t('设置')}</span>
        </button>
      </div>
    </div>
  </aside>
  <!-- 设置菜单放在 aside 外（否则被左栏 overflow:hidden 裁掉），fixed 定位在左下齿轮上方 -->
  {#if dtSettingsOpen}
    <button class="v-pop-scrim" aria-label={t('关闭')} onclick={() => (dtSettingsOpen = false)}></button>
    <div class="v-dt-set-menu" transition:fly={{ y: 6, duration: 150 }}>
      <div class="v-dt-set-sec">{t('主题')}</div>
      <button class="v-dt-set-opt" class:on={vs.theme === 'light'} onclick={() => pickTheme('light')}><span class="lumi v-dt-set-ck">check</span><span class="v-dt-set-lb">{t('浅色')}</span></button>
      <button class="v-dt-set-opt" class:on={vs.theme === 'dark'} onclick={() => pickTheme('dark')}><span class="lumi v-dt-set-ck">check</span><span class="v-dt-set-lb">{t('深色')}</span></button>
      <div class="v-dt-set-div"></div>
      <button class="v-dt-set-toggle" onclick={() => setVertexFastVision(vs.fastVision === false)}>
        <span class="v-dt-set-tt">{t('快速识图')}<small>{t('图片自动降画质、识图更快；关掉发原图更清晰但更慢')}</small></span>
        <span class="v-switch" class:on={vs.fastVision !== false}><span class="v-knob"></span></span>
      </button>
    </div>
  {/if}
{/snippet}

{#snippet desktopTop()}
  <!-- 桌面顶栏（右上）：功能模块菜单（bridge 特性：图像/视频/语音/音乐）+ 新对话 -->
  <div class="v-dt-top">
    <div class="v-dt-func-wrap">
      <button class="v-func" onclick={toggleFuncMenu} aria-label={t('功能模块')}>
        <span class="lumi" style="font-size:22px">{FUNC_GLYPH[vs.func]}</span>
        <span class="lumi v-chev-g">keyboard_arrow_down</span>
      </button>
      {#if vs.funcMenuOpen}
        <button class="v-pop-scrim" aria-label={t('关闭')} onclick={closePops}></button>
        <div class="v-funcmenu" transition:fly={{ y: -8, duration: 160 }}>
          <div class="v-pick-sec">{t('功能模块')}</div>
          {#each FUNCS as f (f)}
            <button class="v-pick-row" class:sel={f === vs.func} onclick={() => pickFunc(f)}>
              <span class="v-func-ico lumi" style="font-size:21px">{FUNC_GLYPH[f]}</span>
              <span class="v-pick-name">{FUNC_LABEL[f]}</span>
              {#if f === vs.func}<span class="lumi v-pick-ck">check</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/snippet}

<style>
  /* 滑动层（fixed 全屏盖主页，translateX 右移露主页；跟手时关过渡）。
     padding-bottom: var(--kb) —— 键盘高度兜底（App.svelte 维护），原生方案生效时恒 0。 */
  .vertex-slide { position: fixed; inset: 0; z-index: 40; display: flex; flex-direction: column;
    padding-bottom: var(--kb, 0px);
    /* transform 只在左缘右滑跟手时由手势 / 弹簧逐帧驱动（同 ClaudePage），不挂 CSS 过渡；
       不挂 box-shadow：转场快照会连阴影一起拍，落位对不齐 */
    will-change: transform; transform-origin: 50% 50%; }

  /* 顶部浮层（真实 Gemini：透明顶栏，48px 触控目标，模型 pill 紧凑 16px）。
     绝对定位悬浮在内容之上：对话滚动到顶栏下方时被「表面色→透明」的渐变晕开（原版同款），
     greeting 页渐变叠在同色底上不可见，零干扰。 */
  .v-header { position: absolute; top: 0; left: 0; right: 0; z-index: 30; display: flex; align-items: center; gap: 2px;
    padding: max(6px, var(--sat)) 8px 14px;
    background: linear-gradient(to bottom, rgba(253,252,252,.97) 0%, rgba(253,252,252,.88) 64%, rgba(253,252,252,0) 100%);
    pointer-events: none; }
  /* 媒体模块（vmx 新版面板）：面板自带彩色 hero 页头，顶栏按钮直接浮在其上，去掉白渐变 */
  .v-header.v-h-media { background: none !important; }
  .v-header > * { pointer-events: auto; }
  .v-left, .v-right { display: flex; align-items: center; gap: 2px; }
  .v-right { margin-left: auto; }
  .v-iconbtn { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--g-on); flex: none; }
  .v-iconbtn:active { background: var(--g-hover); }
  .v-model-wrap, .v-func-wrap { position: relative; }
  .v-model { display: flex; align-items: center; padding: 7px 8px 7px 12px; border-radius: var(--g-r-pill); }
  .v-model:active { background: var(--g-hover); }
  .v-model-main { font-size: 16px; font-weight: 500; color: var(--g-on); letter-spacing: 0; }
  .v-model-sub { font-size: 16px; color: var(--g-on-variant); margin-left: 5px; max-width: 38vw; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .v-chev { width: 16px; height: 16px; color: var(--g-on-variant); margin-left: 2px; flex: none; }
  .v-chev-g { font-size: 19px; color: var(--g-on-variant); flex: none; }
  .v-func { display: flex; align-items: center; gap: 2px; padding: 8px 7px 8px 10px; border-radius: var(--g-r-pill); color: var(--g-on); }
  .v-func:active { background: var(--g-hover); }
  /* 输入条上这两颗（模块芯片 / 圆钮）在手机上只有按下态；桌面鼠标划过毫无反应＝很不像原生 app */
  @media (hover: hover) { .v-func:hover { background: var(--g-hover); } }

  /* 弹层（模型选择器 / 模块菜单）—— 真实 Gemini 菜单：白卡 radius 20 / padding 8 /
     行=名称 17px + 副题 13px 灰 / 选中右侧 ✓ 黑色（不再用蓝底蓝字）*/
  .v-pop-scrim { position: fixed; inset: 0; z-index: 60; }
  .v-picker, .v-funcmenu { position: absolute; top: calc(100% + 4px); z-index: 61; min-width: 232px; max-height: 70vh; overflow-y: auto;
    background: var(--g-bright); border-radius: 20px; box-shadow: var(--g-shadow-pop); padding: 8px; }
  .v-picker { left: 0; }
  .v-funcmenu { right: 0; }
  .v-pick-sec { font-size: 12px; color: var(--g-on-low); padding: 7px 12px 4px; }
  .v-pick-row { width: 100%; display: flex; align-items: center; gap: 11px; padding: 10px 12px; border-radius: 12px; text-align: left; }
  .v-pick-row:active { background: var(--g-hover); }
  .v-pick-row.sel { background: var(--g-dim); }
  .v-pick-dot { flex: none; display: flex; }
  .v-func-ico { width: 22px; flex: none; color: var(--g-on-variant); text-align: center; }
  .v-pick-name { flex: 1; font-size: 16px; color: var(--g-on); }
  .v-pick-row.sel .v-pick-name { font-weight: 540; }
  .v-pick-ck { font-size: 19px; color: var(--g-on); flex: none; }
  /* 模型菜单行（照搬真站样式：勾在左 + 名称/说明两行，选中不高亮底、只显勾）*/
  .v-pick-m { align-items: center; gap: 8px; }
  .v-pick-m.sel { background: transparent; }
  .v-pick-m:hover { background: var(--g-hover); }
  .v-pick-ck2 { width: 20px; flex: none; display: flex; align-items: center; justify-content: center; color: var(--g-on); }
  .v-pick-ck2 .lumi { font-size: 18px; }
  .v-pick-mtx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0; }
  .v-pick-mtx .v-pick-name { flex: none; font-size: 14px; }
  .v-pick-desc { font-size: 12.5px; color: var(--g-on-variant); line-height: 1.35; }
  /* 对话模块的模型菜单 = 模型 + 设置。手机：单栏，左右各留 12px 撑满屏宽（wrap 左缘在 8+44+2=54px，
     左移 42px），高度给到屏幕底；桌面：两栏并排（见下方 min-width:900px 段）。 */
  .v-picker.v-pk-chat { left: -42px; width: min(420px, calc(100vw - 24px)); max-height: calc(100dvh - 96px - var(--sat, 0px)); }
  .v-pk-opts { border-top: 1px solid var(--g-divider); margin: 6px 4px 0; padding-top: 4px; }
  .v-pk-lab { font-size: 12.5px; color: var(--g-on-variant); padding: 10px 8px 6px; }
  .v-toggle-row { width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 8px; border-radius: 12px; font-size: 14px; color: var(--g-on); }
  .v-toggle-row:hover { background: var(--g-hover); }
  .v-tg-tx { display: flex; flex-direction: column; align-items: flex-start; text-align: left; gap: 1px; min-width: 0; padding-right: 12px; }
  .v-tg-tx small { font-size: 12px; color: var(--g-on-variant); line-height: 1.35; }
  .v-seg { display: flex; gap: 4px; padding: 0 4px 4px; }
  .v-seg-b { flex: 1; height: 34px; border-radius: 999px; border: 0; background: var(--g-container); color: var(--g-on); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; padding: 0 6px; }
  .v-seg-b.on { background: var(--g-primary); color: var(--g-on-primary); font-weight: 600; }
  .v-pk-sys { margin-top: 8px; }
  .v-sys-sum { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; max-width: 210px; }
  .v-sys-scrim { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, .42); border: 0; padding: 0; }
  .v-sys {
    position: fixed; z-index: 91; left: 50%; bottom: max(16px, var(--sab, 0px)); transform: translateX(-50%);
    width: min(560px, calc(100vw - 24px)); max-height: 80dvh;
    background: var(--g-bright); color: var(--g-on); border-radius: 28px; box-shadow: var(--g-shadow-pop);
    padding: 20px 20px 16px; display: flex; flex-direction: column; gap: 12px;
  }
  .v-sys-tt { font-size: 18px; font-weight: 600; display: flex; flex-direction: column; gap: 2px; }
  .v-sys-tt small { font-size: 12.5px; font-weight: 400; color: var(--g-on-variant); }
  .v-sys-ta {
    width: 100%; min-height: 180px; max-height: 50dvh; resize: vertical; box-sizing: border-box;
    border: 0; outline: none; border-radius: 18px; padding: 14px 16px;
    background: var(--g-container); color: var(--g-on); font: inherit; font-size: 15px; line-height: 1.55;
  }
  .v-sys-row { display: flex; align-items: center; gap: 6px; }
  .v-sys-n { margin-right: auto; font-size: 12px; color: var(--g-on-low); font-variant-numeric: tabular-nums; }
  .v-sys-b { height: 40px; padding: 0 16px; border-radius: 999px; border: 0; background: transparent; color: var(--g-primary); font: inherit; font-size: 14.5px; font-weight: 600; cursor: pointer; }
  .v-sys-b.on { background: var(--g-primary); color: var(--g-on-primary); }
  @media (min-width: 900px) { .v-sys { top: 50%; bottom: auto; transform: translate(-50%, -50%); } }
  .v-switch { width: 38px; height: 22px; border-radius: 11px; background: var(--g-outline-low); position: relative; transition: background .18s; flex: none; }
  .v-switch.on { background: var(--g-primary); }
  .v-knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .18s; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
  .v-switch.on .v-knob { transform: translateX(16px); }

  /* 主区（真实 Gemini 结构：上方内容区 + 钉底输入条）*/
  .v-stage { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; }
  /* 对话模块包裹层：同时作为桌面拖放区（相对定位供拖放遮罩绝对铺满），保持原本的纵向 flex 布局 */
  .v-chat { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; }
  /* 拎着工作空间的文件悬在对话上：整块亮一圈，松手＝挂进输入栏 */
  .v-chat.dnd-on::after { content: ''; position: absolute; inset: 8px; border-radius: 18px; pointer-events: none; z-index: 4;
    box-shadow: inset 0 0 0 2px var(--v-accent, #6d7cff); background: rgba(109, 124, 255, .07); }
  /* —— 模块切换动效（对话页侧；媒体面板的入/离场编排在 media-neo.css）——
     入场：整页轻淡入 + 底部光晕升起；离场（.v-leaving，pickFunc 编排）：淡出下沉。 */
  @media (prefers-reduced-motion: no-preference) {
    .v-chat { animation: vChatIn .32s ease backwards; }
    .v-glow { animation: vGlowIn .7s ease backwards; }
    .v-stage.v-leaving .v-chat { animation: vChatOut .2s ease forwards; }
  }
  .v-noanim .v-chat, .v-noanim .v-glow { animation: none; }
  @keyframes vChatIn { from { opacity: 0; } }
  @keyframes vGlowIn { from { opacity: 0; transform: translateY(30px); } }
  @keyframes vChatOut { to { opacity: 0; transform: translateY(14px); } }
  /* greeting：星标 + 问候语居中在剩余空间（输入条已钉底，不再参与居中）*/
  .v-hero { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 0 24px 6vh; }
  .v-greet { display: flex; flex-direction: column; align-items: center; gap: 22px; }
  .v-greet-star { display: inline-flex; }
  .v-greet h1 { font-family: var(--g-font); font-weight: 360; font-size: 32px; line-height: 1.3; text-align: center; color: var(--g-on); letter-spacing: 0; }
  /* 底部环境光晕（真实页是巨幅模糊彩虹条；按参考截图加强：更高、更蓝）*/
  .v-glow { position: absolute; left: 0; right: 0; bottom: 0; height: 46%; pointer-events: none;
    background: linear-gradient(180deg, rgba(216,231,251,0) 0%, rgba(208,226,252,.5) 55%, rgba(193,217,250,.92) 100%); }

  .v-scroll { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  /* 顶栏改悬浮后，对话顶距让出顶栏高度（滚动时内容滑进顶栏渐变下方晕开）；
     底距给悬浮输入条让出高度——末条消息要能滚到胶囊上方读全。 */
  .v-thread { max-width: 760px; margin: 0 auto; width: 100%; padding: calc(var(--sat) + 64px) 24px 128px; }
  /* 输入条：悬浮钉底、直接遮挡下方滚动文本（对齐真实 Gemini）。整条不吃指针（让底下文本可滚动），
     仅胶囊本体可交互。对话态额外挂「表面色→透明」的底部渐隐 + 上方留白跑道，文本滑近胶囊时柔和隐去、
     不再有硬白边；greeting 保持透明（胶囊浮在底部光晕上，无渐隐带）。 */
  .v-composer-wrap { position: absolute; left: 0; right: 0; bottom: 0; z-index: 10; padding: 6px 16px max(12px, var(--sab)); pointer-events: none; }
  .v-composer-wrap .v-composer { max-width: 680px; margin: 0 auto; pointer-events: auto; }
  .v-composer-wrap.v-cw-chat { padding-top: 46px; background: linear-gradient(to top, rgba(253,252,252,1) 0%, rgba(253,252,252,.96) 42%, rgba(253,252,252,0) 100%); }

  /* 用户气泡（实测：#f2f0f0 / radius 40 / padding 20px 28px / 右缘距 28→16+12）*/
  .v-turn-user { display: flex; justify-content: flex-end; margin: 18px 0; }
  .v-bubble { background: var(--g-dim); color: var(--g-on); border-radius: var(--g-r-bubble); padding: 17px 24px; font-size: 16px; line-height: 1.5; max-width: 84%; word-break: break-word; white-space: pre-wrap; }
  .v-b-atts { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .v-b-att { display: inline-flex; align-items: center; font-size: 13px; color: var(--g-on-variant); }
  .v-b-att img { width: 64px; height: 64px; object-fit: cover; border-radius: 12px; display: block; }
  /* 模型回复：全宽纯文本，无头像（真实 Gemini 移动结构）*/
  .v-turn-model { margin: 4px 0 26px; min-width: 0; }
  /* 等待动画：28×28 画布 + 三个等大 4px 黑点（原版规格），运动由 tdots() 的 WAAPI
     关键帧驱动（位置基线即关键帧第一帧，无 CSS 动画）。 */
  .v-tdots { position: relative; display: inline-block; width: 28px; height: 28px; margin: 4px 0; }
  .v-tdots i { position: absolute; left: 0; top: 0; width: 4px; height: 4px; border-radius: 50%; background: var(--g-on); will-change: transform; }
  @keyframes vspin { to { transform: rotate(360deg); } }
  .v-err { background: #fce8e6; color: #c5221f; border-radius: 12px; padding: 10px 14px; font-size: 14px; }
  .v-foot { color: var(--g-on-low); font-size: 13px; margin-top: 8px; }
  /* 动作排（复制/重试——只放真实可用的；32px 灰图标，gemini 间距）*/
  .v-actions { display: flex; gap: 4px; margin: 10px 0 0 -8px; }
  .v-act { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #444746; }
  .v-act:active { background: var(--g-hover); }
  .v-act:disabled { opacity: .4; }

  /* 媒体模块占位 */
  .v-soon { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 0 24px 12vh; text-align: center; }
  .v-soon h2 { font-size: 24px; font-weight: 400; color: var(--g-on); margin-top: 4px; }
  .v-soon-model { font-size: 15px; color: var(--g-on-variant); }
  .v-soon-model b { color: var(--g-primary); font-weight: 500; }
  .v-soon-dim { font-size: 14px; color: var(--g-on-low); }

  /* 输入条（实测+参考截图）：白底无边框 / radius 40 / 软阴影 / 编辑区 17px。
     collapsed：单行 padding 20px、行内 [+][编辑][mic]，总高 80；
     expanded：双层（附件chips + 编辑行 + 按钮排），按钮排 40px。 */
  .v-composer { width: 100%; background: var(--g-bright); border: 0; border-radius: var(--g-r-input); box-shadow: var(--g-shadow-input), 0 0 0 .5px rgba(0,0,0,.04); padding: 20px; display: flex; flex-direction: column; gap: 0; }
  .v-c-main { display: flex; align-items: center; gap: 12px; }
  .v-field { flex: 1; min-height: 24px; max-height: 38vh; overflow-y: auto; font-size: 17px; line-height: 24px; color: var(--g-on); outline: none; word-break: break-word; }
  .v-field:empty::before { content: attr(data-ph); color: var(--g-placeholder); }
  /* 圆形图标钮（40×40、28px Luminous 图标、黑色——实测规格）*/
  .v-cir { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--g-on-strong); flex: none; transition: background .15s; }
  .v-cir:active { background: var(--g-hover); }
  @media (hover: hover) { .v-cir:hover:not(:disabled) { background: var(--g-hover); } }
  .v-cir:disabled { opacity: .45; }
  /* 停止＝黑圆白方块；发送＝淡蓝圆 #a8c7fa + 深色箭头（均取自参考截图）*/
  .v-stop { background: #000; color: #fff; }
  .v-stop:active { background: #000; filter: brightness(1.3); }
  .v-go { background: #a8c7fa; color: #1a1c1e; }
  .v-go:active { filter: brightness(.94); }
  /* expanded 按钮排：编辑行下方 [+] … [mic][发送/停止] */
  .v-c-bar { display: none; align-items: center; gap: 8px; margin-top: 10px; }
  .v-c-sp { flex: 1; }
  .v-composer.expanded .v-c-bar { display: flex; }
  .v-composer.expanded .v-row-only { display: none; }
  .v-composer.expanded { padding: 16px 16px 12px 20px; }
  /* 附件 chips（expanded 顶部）*/
  .v-c-atts { display: flex; flex-wrap: wrap; gap: 7px; padding-bottom: 10px; }
  .v-c-att { position: relative; display: flex; align-items: center; height: 52px; border-radius: 14px; overflow: hidden; background: var(--g-dim); }
  .v-c-att.img { width: 52px; }
  .v-c-att img { width: 52px; height: 52px; object-fit: cover; display: block; }
  .v-c-att-name { padding: 0 12px; font-size: 13px; color: var(--g-on); max-width: 160px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .v-c-att.pending { opacity: .55; }
  .v-c-spin { position: absolute; left: 50%; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; border: 2px solid rgba(0,0,0,.25); border-top-color: var(--g-on); animation: vspin .8s linear infinite; }
  .v-c-att-x { position: absolute; top: 0; right: 0; width: 17px; height: 17px; border-radius: 50%; background: rgba(0,0,0,.55); color: #fff; font-size: 13px; line-height: 1; display: flex; align-items: center; justify-content: center; }
  .v-c-att-x::before { content: ''; position: absolute; inset: -8px; }

  /* 历史抽屉（实测：320px 白底、右缘 16px 圆角、行 17px 高 44、激活=灰胶囊 #f2f0f0 加粗）*/
  .v-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.4); opacity: 0; visibility: hidden; transition: opacity .25s, visibility 0s linear .25s; z-index: 50; }
  .v-scrim.open { opacity: 1; visibility: visible; transition: opacity .25s; }
  .v-drawer { position: fixed; top: 0; left: 0; bottom: 0; width: 85vw; max-width: 320px; background: var(--g-bright); border-radius: 0 16px 16px 0; transform: translateX(-100%); visibility: hidden; transition: transform .26s cubic-bezier(.22,1,.36,1), visibility 0s linear .26s; z-index: 51; display: flex; flex-direction: column; padding: 10px 12px; padding-top: max(10px, var(--sat)); overflow-y: auto; }
  .v-drawer.open { transform: none; visibility: visible; transition: transform .26s cubic-bezier(.22,1,.36,1); box-shadow: 0 0 40px rgba(0,0,0,.18); }
  .v-brand { display: flex; align-items: center; gap: 10px; padding: 8px 12px 8px; font-size: 20px; color: var(--g-on); }
  .v-d-gear { margin-left: auto; }    /* 设置齿轮：抽屉顶 Gemini 大图标右侧（原明暗钮位置） */
  .v-d-gear.on { color: var(--g-primary); background: var(--g-hover); }
  /* 设置子栏（齿轮拉开）：仿 Gemini 设置菜单——图标+标题(+副说明)+右侧开关 */
  .v-settings { margin: 4px 2px 8px; padding: 5px; border-radius: 16px; background: var(--g-hover); display: flex; flex-direction: column; gap: 2px; }
  .v-set-row { width: 100%; display: flex; align-items: center; gap: 11px; padding: 9px 10px; border: 0; background: none; border-radius: 12px; text-align: left; color: var(--g-on); cursor: pointer; }
  .v-set-row:active { background: var(--g-hover-strong); }
  .v-set-ic { width: 22px; flex: none; display: flex; align-items: center; justify-content: center; color: var(--g-on-variant); }
  .v-set-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; font-size: 14.5px; }
  .v-set-tx small { font-size: 11px; line-height: 1.35; color: var(--g-on-variant); }
  .v-d-item { width: 100%; display: flex; align-items: center; gap: 13px; min-height: 44px; padding: 10px 12px; border-radius: var(--g-r-pill); font-size: 16px; color: var(--g-on); text-align: left; }
  .v-d-item:active { background: var(--g-hover); }
  .v-d-ic { font-size: 20px; color: var(--g-on); flex: none; width: 22px; text-align: center; }
  .v-d-sec { color: var(--g-on-variant); font-size: 15px; padding: 16px 12px 6px; }
  .v-d-list { display: flex; flex-direction: column; }
  .v-d-row { display: flex; align-items: center; min-height: 44px; border-radius: var(--g-r-pill); }
  .v-d-row.cur { background: var(--g-dim); }
  .v-d-row.cur .v-d-pick { font-weight: 540; color: var(--g-on-strong); }
  .v-d-pick { flex: 1; min-width: 0; padding: 11px 4px 11px 14px; text-align: left; font-size: 16px; color: var(--g-on); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .v-d-del { width: 36px; height: 36px; margin-right: 4px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--g-on-low); flex: none; }
  .v-d-del:active { background: var(--g-hover-strong); }
  .v-d-del svg { width: 16px; height: 16px; }
  .v-d-empty { color: var(--g-on-low); font-size: 14px; padding: 10px 12px; }

  /* ============================================================
     桌面版（.v-dt，窗口 ≥900px）：真实 Gemini 桌面三栏结构。
     左栏折叠 52px 图标竖条 ↔ 展开 276px 带「最近」列表；内容区让开左栏、居中；
     输入胶囊 660px 单行 pill、内嵌模型选择器；顶栏右上功能菜单 + 新对话。
     ============================================================ */
  .vertex-root.v-dt { position: relative; }
  .v-dt .v-header, .v-dt .v-drawer, .v-dt .v-scrim { display: none; }   /* 移动版顶栏/抽屉桌面不用 */

  /* —— 左栏 ——
     顶部一律留出 var(--sat)：v-dt 这套桌面 chrome 从 700px 起就生效（layout.side），
     折叠屏展开正好落在这一档 —— 那仍是台手机，上面有系统状态栏。左栏/顶栏/正文
     此前都按"桌面没有状态栏"写死 top:0，展开后菜单钮与标题被状态栏压住。 */
  .v-dt-side { position: absolute; left: 0; top: 0; bottom: 0; z-index: 32; width: 52px;
    display: flex; flex-direction: column; padding: calc(var(--sat, 0px) + 8px) 6px 8px; gap: 2px;
    background: var(--g-surface); transition: width .2s cubic-bezier(.4,0,.2,1); overflow: hidden; }
  .v-dt-side.open { width: 276px; padding: calc(var(--sat, 0px) + 8px) 12px 8px; background: var(--g-bright); box-shadow: 1px 0 0 var(--g-divider); }
  .v-dt-side-head { display: flex; align-items: center; min-height: 44px; margin-bottom: 4px; }
  .v-dt-side.open .v-dt-side-head { justify-content: space-between; }
  .v-dt-brand { display: flex; align-items: center; gap: 10px; font-size: 20px; color: var(--g-on); padding-left: 4px; }
  .v-dt-ic { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--g-on); flex: none; }
  .v-dt-ic:hover { background: var(--g-hover); }
  .v-dt-item { display: flex; align-items: center; gap: 12px; height: 40px; border-radius: 999px; color: var(--g-on); white-space: nowrap; overflow: hidden; }
  .v-dt-item:hover { background: var(--g-hover); }
  .v-dt-side:not(.open) .v-dt-item { width: 40px; justify-content: center; padding: 0; }
  .v-dt-side.open .v-dt-item { padding: 0 12px; }
  .v-dt-item-ic { font-size: 22px; flex: none; width: 24px; text-align: center; }
  .v-dt-item-tx { font-size: 14px; }
  .v-dt-side:not(.open) .v-dt-item-tx { display: none; }
  .v-dt-recent { flex: 1; min-height: 0; overflow-y: auto; margin-top: 10px; }
  .v-dt-sec { font-size: 12px; color: var(--g-on-variant); padding: 8px 12px 4px; }
  .v-dt-conv { display: flex; align-items: center; border-radius: 999px; }
  .v-dt-conv:hover { background: var(--g-hover); }
  .v-dt-conv.cur { background: var(--g-dim); }
  .v-dt-conv-pick { flex: 1; min-width: 0; text-align: left; padding: 8px 6px 8px 14px; font-size: 14px; color: var(--g-on); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .v-dt-conv-del { width: 30px; height: 30px; margin-right: 4px; border-radius: 50%; display: none; align-items: center; justify-content: center; color: var(--g-on-low); flex: none; }
  .v-dt-conv:hover .v-dt-conv-del { display: flex; }
  .v-dt-conv-del:hover { background: var(--g-hover-strong); }
  .v-dt-empty { color: var(--g-on-low); font-size: 13px; padding: 8px 12px; }
  .v-dt-side-foot { margin-top: auto; padding-top: 6px; }
  .v-dt-user { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 4px; }
  .v-dt-avatar { width: 28px; height: 28px; border-radius: 50%; background: #0ebc5f; color: #fff; font-size: 13px; display: flex; align-items: center; justify-content: center; flex: none; }
  .v-dt-uname { flex: 1; min-width: 0; font-size: 14px; color: var(--g-on); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .v-dt-gear { margin-left: auto; }
  .v-dt-side:not(.open) .v-dt-user { justify-content: center; padding: 0; }
  .v-dt-side:not(.open) .v-dt-gear { display: none; }

  /* 左上 hover 变形：默认 Gemini 星标，悬停 → 「打开边栏」按钮（照搬真站 side-nav-sparkle-button :hover）*/
  .v-dt-sparkbtn { position: relative; width: 40px; height: 40px; flex: none; }
  .v-dt-sparkbtn .v-dt-spark { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transition: opacity .15s; }
  .v-dt-sparkbtn .v-dt-expand { position: absolute; inset: 0; width: 40px; height: 40px; opacity: 0; transition: opacity .15s; }
  .v-dt-sparkbtn:hover .v-dt-spark { opacity: 0; }
  .v-dt-sparkbtn:hover .v-dt-expand { opacity: 1; }

  /* 左下设置按钮 + 菜单（照搬真站 desktop-settings-menu / lm-menu-theme：卡 radius20 软阴影 padding8，行 36）*/
  .v-dt-gear-wrap { position: relative; }
  .v-dt-side:not(.open) .v-dt-gearbtn { width: 40px; justify-content: center; padding: 0; }
  .v-dt-side:not(.open) .v-dt-gearbtn .v-dt-item-tx { display: none; }
  .v-dt-gearbtn .v-dt-item-ic { color: var(--g-on-variant); }
  /* 放 aside 外、fixed 定位在左下齿轮上方——不被左栏 overflow:hidden 裁掉（即用户说的"分界线后被挡住"）*/
  .v-dt-set-menu { position: fixed; left: 10px; bottom: 92px; z-index: 61; width: 260px;
    background: var(--g-bright); border-radius: 20px; box-shadow: var(--g-shadow-pop); padding: 8px; }
  .v-dt-set-sec { font-size: 12px; color: var(--g-on-low); padding: 7px 12px 4px; }
  .v-dt-set-opt { width: 100%; display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 12px; border-radius: 10px; color: var(--g-on); text-align: left; }
  .v-dt-set-opt:hover { background: var(--g-hover); }
  .v-dt-set-ck { font-size: 18px; color: var(--g-on); width: 20px; flex: none; visibility: hidden; }
  .v-dt-set-opt.on .v-dt-set-ck { visibility: visible; }
  .v-dt-set-lb { font-size: 14px; }
  .v-dt-set-div { height: 1px; background: var(--g-divider); margin: 6px 8px; }
  .v-dt-set-toggle { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 10px; color: var(--g-on); text-align: left; }
  .v-dt-set-toggle:hover { background: var(--g-hover); }
  .v-dt-set-tt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; font-size: 14px; }
  .v-dt-set-tt small { font-size: 11px; line-height: 1.3; color: var(--g-on-variant); }

  /* —— 顶栏（右上）—— */
  .v-dt-top { position: absolute; top: 0; right: 0; z-index: 31; display: flex; align-items: center; gap: 4px; padding: calc(var(--sat, 0px) + 12px) 16px 12px; }
  .v-dt-func-wrap { position: relative; }
  .v-dt-func-wrap .v-funcmenu { right: 0; }

  /* —— 内容区让开左栏（折叠 52 / 展开 276）—— */
  .v-dt .v-stage { margin-left: 52px; transition: margin-left .2s cubic-bezier(.4,0,.2,1); }
  .v-dt.side-open .v-stage { margin-left: 276px; }
  .v-dt .v-thread { padding-top: calc(var(--sat, 0px) + 40px); max-width: 760px; }

  /* —— greeting：问候语 + 输入胶囊一组垂直居中（桌面不钉底）—— */
  .v-chat.v-dt-greet { justify-content: center; gap: 30px; padding-top: var(--sat, 0px); }
  .v-chat.v-dt-greet .v-hero { flex: none; padding: 0 24px; }
  .v-chat.v-dt-greet .v-glow { display: none; }
  .v-chat.v-dt-greet .v-composer-wrap { position: static; padding: 0 24px; background: none; }
  /* 桌面问候语：真实 gds-display-m 计算样式（36px / 行高48 / 变量字重 320，很轻，非粗体）*/
  .v-dt .v-greet h1 { font-size: 36px; line-height: 48px; font-weight: 320; font-variation-settings: "wght" 320; letter-spacing: normal; color: var(--g-on); }
  /* 桌面图标：真站是变量图标字体的「细」字重 wght 320（此前我用默认粗体，显得又粗又大）。尺寸照搬：rail 20 / 胶囊内 22 */
  .v-dt .lumi { font-variation-settings: "wght" 320; }
  .v-dt .v-dt-item-ic { font-size: 20px; }
  .v-dt .v-cir .lumi { font-size: 22px !important; }

  /* 桌面 greeting 极光背景（复刻真实 Gemini 柔光：蓝色主辉 + 极光条十色的紫/粉/橙/青点缀。
     用分层 radial-gradient 天生柔和，不用 filter:blur——大面积 blur 会拖垮渲染。取自真实 gradient-strip 配色）*/
  .v-dt-aura { display: none; }
  /* contain:paint 强制把内部（含 blur 辉光）裁在本容器盒内——overflow:hidden 对大 blur 在部分浏览器会漏，
     导致辉光溢到左栏上面；contain 是硬裁，彻底锁在内容区。 */
  .v-dt .v-chat.v-dt-greet .v-dt-aura { display: block; position: absolute; inset: 0; overflow: hidden; contain: paint; pointer-events: none; z-index: 0; }
  .v-dt .v-chat.v-dt-greet .v-hero, .v-dt .v-chat.v-dt-greet .v-composer-wrap { position: relative; z-index: 1; }
  /* 照搬真站 nl-blob 星云机制：有机 blob（真实 border-radius）裁剪一张超大的十色彩虹条（真实
     gradient-strip 配色 + 旋转 36°），整体重模糊成柔光。真站 blur 146px，这里取 110px。
     （filter:blur 会让「预览工具」的 CDP 截图卡死——真站自身的 blur 也一样卡截图——但真机渲染正常；
     静态不做旋转动画：blur 只需合成一次，避免每帧重算模糊卡顿。）blob≈1440×766，::before inset-150% ≈5760×3064 与真站同量级。 */
  /* 真站 nebula「效果本身」照搬：有机 blob（真实 border-radius）裁剪十色彩虹条（真实 gradient-strip 配色，
     蓝居中）+ blur(120px)，整层 opacity 0.29（真站 nl-bg-layer 实测值——这才是它「很淡」的关键，
     我此前盲调成 .5 才糊满屏）。静态（不做旋转，blur 只合成一次省性能）。
     注：filter:blur 会卡「预览工具」的截图（真站自身 blur 也一样卡），但真机渲染正常，此处按真参数搭。 */
  .v-dt-aura-blob { display: block; position: absolute; left: 50%; top: 49%; width: 1440px; height: 766px; transform: translate(-50%, -50%);
    border-radius: 33.86% 65.71% 57.84% 43.23% / 62.53% 43.83% 58.71% 38.74%; overflow: hidden; filter: blur(120px); opacity: .29;
    /* 径向遮罩把辉光收拢到中心、四周淡出到黑（真站图2 那种胶囊周围一圈、四角发黑的收拢感）*/
    -webkit-mask-image: radial-gradient(ellipse 56% 60% at 50% 50%, #000 30%, transparent 70%);
    mask-image: radial-gradient(ellipse 56% 60% at 50% 50%, #000 30%, transparent 70%); }
  .v-dt-aura-blob::before { content: ''; position: absolute; inset: -150%;
    /* 蓝色为主：深蓝 navy → 亮蓝 #3c90ff 居中 → 深蓝，两侧不放青绿/紫暖，避免 blur 糊出杂色（真站可见区就是纯蓝）*/
    background: repeating-linear-gradient(180deg, #101d3a 0%, #1a3670 16%, #2860b8 34%, #3c90ff 50%, #2860b8 66%, #1a3670 84%, #101d3a 100%);
    transform: rotate(36deg); }
  .v-dt .v-chat.v-dt-greet .v-dt-aura { background: none; }
  .vertex-root.v-dark .v-dt .v-chat.v-dt-greet .v-dt-aura { background: none; }
  .vertex-root.v-dark .v-dt-aura-blob { opacity: .34; }

  /* greeting 布局照搬真站：一组垂直中心在视口中线偏上 ~44px（不是正居中）；问候语↔胶囊间距 40px */
  .v-chat.v-dt-greet { justify-content: center; gap: 40px; padding-bottom: 88px; }
  /* 桌面输入胶囊高度 64（真站实测）*/
  .v-dt .v-composer { border-radius: 32px; padding: 12px 10px; min-height: 64px; justify-content: center; }

  /* —— 桌面输入胶囊：660 单行 pill、圆角 32、内嵌模型选择器 pill —— */
  .v-dt .v-composer-wrap .v-composer { width: 660px; max-width: 100%; margin: 0 auto; }
  .v-dt .v-composer { border-radius: 32px; padding: 6px 8px; }
  .v-dt .v-c-main { gap: 4px; }
  .v-dt .v-field { padding: 10px 6px; font-size: 16px; }
  .v-dt-model-wrap { position: relative; flex: none; }
  .v-dt-model { display: flex; align-items: center; gap: 1px; height: 36px; padding: 0 6px 0 12px; border-radius: 999px; font-size: 14px; font-weight: 500; color: var(--g-on-variant); white-space: nowrap; }
  .v-dt-model:hover { background: var(--g-hover); }
  .v-picker.v-picker-up { top: auto; bottom: calc(100% + 8px); left: auto; right: 0; }
  /* 桌面：左栏模型、右栏设置并排，整张菜单不滚动就看全（两栏各自超高时才各自滚） */
  .v-picker.v-pk-chat.v-picker-up { width: 600px; max-height: min(560px, 80vh); display: grid; grid-template-columns: 1fr 1.25fr; gap: 6px; overflow: hidden; }
  .v-picker-up .v-pk-models, .v-picker-up .v-pk-opts { overflow-y: auto; max-height: calc(min(560px, 80vh) - 16px); }
  .v-picker-up .v-pk-opts { border-top: 0; border-left: 1px solid var(--g-divider); margin: 0; padding: 0 0 0 8px; }

  /* —— 英文界面（html[lang=en]，lib/i18n.js 设置）：媒体面板（media-neo.css 的 .vmx）的英文文案比中文长 ——
     两列胶囊（任务类型/人物生成/语音风格）原本 nowrap，英文允许折行；开关行不再定高；
     生成钮的 4px 字距是给汉字的，拉丁字母收回去免得长提示挤出按钮。中文外观不受影响。 */
  :global(html[lang='en'] .vmx .seg.seg-grid2 .seg-b) { white-space: normal; line-height: 1.2; text-align: center; }
  :global(html[lang='en'] .vmx .tgl) { height: auto; min-height: 58px; padding-top: 8px; padding-bottom: 8px; }
  :global(html[lang='en'] .vmx .gen-btn) { letter-spacing: .3px; }
  :global(html[lang='en'] .vmx .gen-btn:disabled) { letter-spacing: 0; }
</style>
