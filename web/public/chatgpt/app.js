/* ChatGPT visual layer — wired to the bridge/Codex host through postMessage. */
(function () {
  "use strict";

  /* ---------------- i18n ----------------
   * 界面语言跟 bridge 主程序同一个偏好（同源 localStorage 'bridge-lang'，地址 ?lang=en|zh 临时覆盖）。
   * 本页是 Vite 原样拷贝的普通脚本、拿不到主程序的字典，所以英文字典就放在这里（构建只给 app.js 打内容
   * 哈希，另起一个文件不会跟着破缓存）。键 = 中文原文；T / tc / TR 的语义同 web/src/lib/i18n.js 的
   * t / tc / tr（{占位}、one/other 单复数）。英文一律取 ChatGPT / Codex 官方英文界面原文，官方没有的按
   * web/src/i18n/GLOSSARY.md 的 OpenAI 口吻补。字典行尾的 i18n-ignore 只是让体检脚本放过中文键。
   * 中文界面：T() 原样返回中文，index.html 的静态文案不动——行为与接入前逐字节一致。 */
  var BRIDGE_LANG = (function () { try { var q = new URLSearchParams(location.search).get('lang'); if (q === 'en' || q === 'zh') return q; return localStorage.getItem('bridge-lang') === 'en' ? 'en' : 'zh'; } catch (e) { return 'zh'; } })();
  try { document.documentElement.lang = BRIDGE_LANG === 'en' ? 'en' : 'zh-CN'; } catch (e) {}
  var EN = {
    // —— 服务端给没标题的 Codex 会话的占位（半角括号，经 TR 显示）——
    '(无标题)': 'Untitled', // i18n-ignore
    // —— index.html 静态文案（applyStaticI18n 启动时替换）——
    '侧边栏': 'Sidebar', // i18n-ignore
    '边栏': 'Sidebar', // i18n-ignore
    '打开边栏': 'Open sidebar', // i18n-ignore
    '关闭边栏': 'Close sidebar', // i18n-ignore
    '历史聊天记录': 'Chat history', // i18n-ignore
    '主页': 'Home', // i18n-ignore
    '新聊天': 'New chat', // i18n-ignore
    '最近聊天': 'Recent chats', // i18n-ignore
    '打开个人资料菜单': 'Open profile menu', // i18n-ignore
    '{name} Plus，打开个人资料菜单': '{name} Plus, open profile menu', // i18n-ignore
    '{name} 免费版，打开“个人资料”菜单': '{name} Free, open profile menu', // i18n-ignore
    '免费版': 'Free', // i18n-ignore
    '下载应用': 'Download app', // i18n-ignore
    '选择聊天界面': 'Choose chat interface', // i18n-ignore
    '开启临时聊天': 'Turn on temporary chat', // i18n-ignore
    '打开对话选项': 'Open conversation options', // i18n-ignore
    '添加文件等': 'Add files and more', // i18n-ignore
    '与 ChatGPT 聊天': 'Chat with ChatGPT', // i18n-ignore
    '有问题，尽管问': 'Ask anything', // i18n-ignore
    '开始听写': 'Start dictation', // i18n-ignore
    '启动语音功能': 'Start voice mode', // i18n-ignore
    '命令': 'Command', // i18n-ignore
    '控制': 'Control', // i18n-ignore
    '相机': 'Camera', // i18n-ignore
    '照片': 'Photos', // i18n-ignore
    'chatgpt::文件': 'Files', // i18n-ignore
    '选择模型': 'Select model', // i18n-ignore
    '最高': 'Max', // i18n-ignore
    '启用快速模式': 'Enable fast mode', // i18n-ignore
    '关闭快速模式': 'Disable fast mode', // i18n-ignore
    '重置为默认值': 'Reset to default', // i18n-ignore
    '更快消耗用量额度': 'Consumes usage limits faster', // i18n-ignore
    '能力': 'Power', // i18n-ignore
    '使用左右箭头键调整能力。': 'Use Left and Right arrow keys to adjust power', // i18n-ignore
    '默认': 'Default', // i18n-ignore
    '推荐的前沿模型组合': 'Recommended set of frontier models', // i18n-ignore
    // —— 附件卡 ——
    '图片': 'Image', // i18n-ignore
    '视频': 'Video', // i18n-ignore
    '音频': 'Audio', // i18n-ignore
    '文档': 'Document', // i18n-ignore
    '文件': 'File', // i18n-ignore
    '预览 {name}': 'Preview {name}', // i18n-ignore
    '上传中 {pct}%': 'Uploading… {pct}%', // i18n-ignore
    '移除': 'Remove', // i18n-ignore
    // —— 顶栏 / 输入栏 / 主页 ——
    '打开项目工作区': 'Open project side panel', // i18n-ignore
    '关闭项目工作区': 'Close project side panel', // i18n-ignore
    '项目工作区': 'Project side panel', // i18n-ignore
    '发送提示': 'Send prompt', // i18n-ignore
    '停止回答': 'Stop', // i18n-ignore
    '开始一个任务': 'Start a task', // i18n-ignore
    '选择工作空间，继续推进项目。': 'Choose a workspace to keep your project moving.', // i18n-ignore
    '工作空间 · {name}': 'Workspace · {name}', // i18n-ignore
    '工作空间': 'Workspace', // i18n-ignore
    '浏览文件': 'Browse files', // i18n-ignore
    '查看更改': 'Review changes', // i18n-ignore
    '生成一张图片：': 'Create an image: ', // i18n-ignore
    '帮我撰写 ': 'Help me write ', // i18n-ignore
    '查找资料：': 'Look up: ', // i18n-ignore
    // —— 消息与过程 ——
    '你的消息操作': 'Your message actions', // i18n-ignore
    '复制消息': 'Copy message', // i18n-ignore
    '编辑消息': 'Edit message', // i18n-ignore
    '你说：': 'You said:', // i18n-ignore
    'ChatGPT 说：': 'ChatGPT said:', // i18n-ignore
    '回复操作': 'Response actions', // i18n-ignore
    '复制回复': 'Copy response', // i18n-ignore
    '切换模型': 'Switch model', // i18n-ignore
    '进度': 'Progress', // i18n-ignore
    '思考摘要': 'Thinking summary', // i18n-ignore
    '正在处理': 'Working', // i18n-ignore
    '已运行命令': 'Ran command', // i18n-ignore
    '正在运行命令': 'Running command', // i18n-ignore
    '已修改文件': 'Edited files', // i18n-ignore
    '正在修改文件': 'Editing files', // i18n-ignore
    '正在搜索网页': 'Searching the web', // i18n-ignore
    '正在使用 {tool}': 'Using {tool}', // i18n-ignore
    '正在使用 工具': 'Using a tool', // i18n-ignore
    '正在使用工具': 'Using a tool', // i18n-ignore
    '已生成内容': 'Generated content', // i18n-ignore
    '正在生成内容': 'Generating content', // i18n-ignore
    '正在思考': 'Thinking', // i18n-ignore
    '正在重新连接': 'Reconnecting', // i18n-ignore
    '调用失败，请重试': 'Couldn’t get a response. Try again.', // i18n-ignore
    '已停止 · 查看过程': 'Stopped · Show thinking', // i18n-ignore
    '已思考 {n} 秒 · 查看过程': 'Thought for {n}s · Show thinking', // i18n-ignore
    '已思考 {n} 秒 · 查看过程（{count}）': 'Thought for {n}s · Show thinking ({count})', // i18n-ignore
    '<p>用户想知道天空为什么是蓝色。这本质上是瑞利散射问题：先解释散射与波长的关系，再回应"为什么不是紫色"和"日落为什么偏红"这两个最常见的疑问，最后给一个可展开的方向。</p>': // i18n-ignore
      '<p>The user wants to know why the sky is blue. This is essentially a Rayleigh scattering question: first explain how scattering relates to wavelength, then address the two most common follow-ups, “why isn’t it violet?” and “why are sunsets red?”, and end with a direction to explore further.</p>',
    // —— 模型与思考强度选择器（官方 ChatGPT Work 面板）——
    '模型与思考强度': 'Model and thinking effort', // i18n-ignore
    '选择强度': 'Select effort', // i18n-ignore
    '思考强度': 'Thinking effort', // i18n-ignore
    '{name}，第 {i} 项，共 {n} 项。': '{name}, {i} of {n}.', // i18n-ignore
    '启用 Fast：更快响应，额度消耗增加': 'Turn on Fast: faster responses, increased usage', // i18n-ignore
    '关闭 Fast：更快响应，额度消耗增加': 'Turn off Fast: faster responses, increased usage', // i18n-ignore
    '加载模型…': 'Loading models…', // i18n-ignore
    '返回强度滑杆': 'Back to effort slider', // i18n-ignore
    // 宿主 capabilities 下发的模型说明（src/config/capabilities.mjs，运行时用 TR 查）
    '编程与日常工作的主力': 'Workhorse for coding and everyday work', // i18n-ignore
    '复杂推理、编程与专业工作': 'Complex reasoning, coding, and professional work', // i18n-ignore
    '复杂、开放式任务': 'Complex, open-ended tasks', // i18n-ignore
    '日常通用工作': 'Everyday work', // i18n-ignore
    '快速、清晰任务': 'Quick, well-defined tasks', // i18n-ignore
    // —— Codex 用量与上下文 ——
    '查看 Codex 用量和上下文': 'View Codex usage and context', // i18n-ignore
    'Codex 用量和上下文': 'Codex usage and context', // i18n-ignore
    '用量与上下文': 'Usage and context', // i18n-ignore
    '关闭用量面板': 'Close usage panel', // i18n-ignore
    '每周额度': 'Weekly limit', // i18n-ignore
    '{n} 小时额度': '{n}-hour limit', // i18n-ignore
    '{n} 分钟额度': '{n}-minute limit', // i18n-ignore
    '用量窗口': 'Usage window', // i18n-ignore
    '重置时间未提供': 'Reset time unavailable', // i18n-ignore
    '重置时间已到，等待更新': 'Reset time reached. Waiting for an update.', // i18n-ignore
    '{h} 小时 {m} 分钟后重置': 'Resets in {h} hr {m} min', // i18n-ignore
    '{m} 分钟后重置': 'Resets in {m} min', // i18n-ignore
    '{time} 重置': 'Resets {time}', // i18n-ignore
    '上下文尚未回传': 'Context not reported yet', // i18n-ignore
    '上下文约 {pct}%': 'Context {pct}%', // i18n-ignore
    'Codex 额度至少剩余 {pct}%': 'Codex limit: at least {pct}% left', // i18n-ignore
    '上下文': 'Context', // i18n-ignore
    '容量未知': 'Capacity unknown', // i18n-ignore
    '{pct}% 已用': '{pct}% used', // i18n-ignore
    '{pct}% 剩余': '{pct}% left', // i18n-ignore
    '输入 {tokens}': 'Input {tokens}', // i18n-ignore
    '发送消息后显示；旧对话将在下次调用后更新。': 'Send a message to see context usage. Older chats update after the next response.', // i18n-ignore
    '按最近一次模型调用的输入与输出估算；压缩后随下次调用更新。': 'Estimated from the input and output of the latest model call. After compacting, it updates on the next call.', // i18n-ignore
    '账号额度': 'Plan usage', // i18n-ignore
    '暂时无法读取额度，稍后可重试。': 'Can’t load usage limits right now. Try again later.', // i18n-ignore
    '正在读取…': 'Loading…', // i18n-ignore
    'Bridge 所连接的 Codex 账号共享额度。': 'Limits are shared with the Codex account connected to The Bridge.', // i18n-ignore
    '更新失败，显示上次数据': 'Couldn’t update. Showing last known data.', // i18n-ignore
    '更新于 {time}': 'Updated {time}', // i18n-ignore
    '尚无实时数据': 'No live data yet', // i18n-ignore
    '刷新': 'Refresh', // i18n-ignore
    // —— 侧栏：返回 / 项目 / 历史 ——
    '返回 Bridge': 'Back to The Bridge', // i18n-ignore
    'chatgpt::项目': 'Projects', // i18n-ignore
    '项目': 'Project', // i18n-ignore
    '新项目': 'New project', // i18n-ignore
    '还没有项目': 'No projects yet', // i18n-ignore
    '未命名项目': 'Untitled project', // i18n-ignore
    '（无标题）': 'Untitled', // i18n-ignore
    '删除对话': 'Delete chat', // i18n-ignore
    '无法打开对话': 'Couldn’t open chat' // i18n-ignore
  };
  var hasOwn = Object.prototype.hasOwnProperty;
  var CJK_RE = /[㐀-鿿]/;
  function i18nValue(key) { return BRIDGE_LANG === 'en' && hasOwn.call(EN, key) ? EN[key] : undefined; }
  function i18nFill(s, p) {
    if (!p) return s;
    return s.replace(/\{(\w+)\}/g, function (m, k) { return p[k] === undefined || p[k] === null ? m : String(p[k]); });
  }
  function i18nPick(v, p) {
    if (typeof v === "string") return v;
    var n = Number(p ? (p.n !== undefined && p.n !== null ? p.n : p.count) : undefined);
    var out = n === 1 ? v.one : v.other;
    return out != null ? out : v.other != null ? v.other : v.one != null ? v.one : "";
  }
  /* T('中文', { 占位 })：中文原样；英文查 EN。键必须是字面量（体检脚本按字面量查）。 */
  function T(s, p) { var v = i18nValue(s); return i18nFill(v === undefined ? s : i18nPick(v, p), p); }
  /* 同一句中文在不同位置要不同英文：键写 'ctx::中文'，没有就退回 T。 */
  function tc(ctx, s, p) {
    var v = i18nValue(ctx + "::" + s);
    if (v === undefined) v = i18nValue(s);
    return i18nFill(v === undefined ? s : i18nPick(v, p), p);
  }
  /* 运行时才知道的文案（宿主下发的模型说明、静态 DOM）：先整句精确匹配，再把带 {占位} 且字面部分 ≥ 2 个汉字的键当模板。 */
  var trPatterns = null;
  function TR(s) {
    if (BRIDGE_LANG !== "en" || typeof s !== "string" || !s || !CJK_RE.test(s)) return s;
    var v = i18nValue(s);
    if (v !== undefined) return i18nPick(v, null);
    var trimmed = s.trim();
    if (trimmed !== s && i18nValue(trimmed) !== undefined) return i18nPick(i18nValue(trimmed), null);
    if (!trPatterns) {
      trPatterns = Object.keys(EN).filter(function (k) {
        return k.indexOf("{") >= 0 && k.indexOf("::") < 0 && (k.replace(/\{\w+\}/g, "").match(/[㐀-鿿]/g) || []).length >= 2;
      }).map(function (k) {
        var names = [];
        var src = k.split(/(\{\w+\})/).map(function (part) {
          var m = /^\{(\w+)\}$/.exec(part);
          if (m) { names.push(m[1]); return "([\\s\\S]+?)"; }
          return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }).join("");
        return { re: new RegExp("^" + src + "$"), names: names, key: k };
      }).sort(function (a, b) { return b.key.length - a.key.length; });
    }
    for (var i = 0; i < trPatterns.length; i++) {
      var m = trPatterns[i].re.exec(trimmed);
      if (!m) continue;
      var params = {};
      trPatterns[i].names.forEach(function (name, j) { params[name] = TR(m[j + 1]); });
      return i18nFill(i18nPick(EN[trPatterns[i].key], params), params);
    }
    return s;
  }
  /* index.html 的静态中文（首屏文字、aria-label、placeholder、title，含 <template> 里的官方选择器）。
   * 只换文字与属性值，不动官方 DOM 结构；放在文件末尾调用——前面的裁剪逻辑按中文原文匹配节点。 */
  function applyStaticI18n() {
    if (BRIDGE_LANG !== "en") return;
    var ATTRS = ["aria-label", "title", "placeholder", "data-placeholder", "alt"];
    function tx(s, ctx) {
      var core = s.trim();
      if (!core || !CJK_RE.test(core)) return s;
      var v = ctx ? i18nValue(ctx + "::" + core) : undefined;
      var out = v !== undefined ? i18nPick(v, null) : TR(core);
      if (out === core) return s;
      var at = s.indexOf(core);
      return s.slice(0, at) + out + s.slice(at + core.length);
    }
    function walk(node, ctx) {
      if (node.nodeType === 3) {
        var text = tx(node.nodeValue, ctx);
        if (text !== node.nodeValue) node.nodeValue = text;
        return;
      }
      if (node.nodeType === 1) {
        if (node.nodeName === "SCRIPT" || node.nodeName === "STYLE") return;
        ATTRS.forEach(function (name) {
          var value = node.getAttribute(name);
          if (!value) return;
          var next = tx(value, ctx);
          if (next !== value) node.setAttribute(name, next);
        });
        if (node.nodeName === "TEMPLATE" && node.content) walk(node.content, ctx);
      }
      for (var c = node.firstChild; c; c = c.nextSibling) walk(c, ctx);
    }
    // 「＋」菜单里的「文件」是入口（Files），附件卡上的「文件」是类型（File）
    $$('#menu-plus-pop [role="menuitem"]').forEach(function (item) { walk(item, "chatgpt"); });
    walk(document.body);
  }

  var SPRITE = "assets/sprites-core-9a8a5f2a.svg";
  var SPRITE2 = "assets/sprites-core-39f59a01.svg"; // 2026-07 官方新雪碧图（新组件用）
  var IC = {
    send: "01bab7", stop: "bbf3a9", mic: "29f921", voice: "f8aa74",
    copy: "ce3544", edit: "6d87e1", switchModel: "ec66f0", chevron: "b140e7"
  };
  var messageImages = {};
  var messageImageSeq = 0;
  function svgIcon(id, cls, size) {
    size = size || 20;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" aria-hidden="true" class="' + (cls || "icon") + '"><use href="' + SPRITE + "#" + id + '" fill="currentColor"></use></svg>';
  }
  function svgIcon2(id, cls, size) {
    size = size || 20;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" aria-hidden="true" class="' + (cls || "icon") + '"><use href="' + SPRITE2 + "#" + id + '" fill="currentColor"></use></svg>';
  }
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(t) {
    return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(t) { return esc(t).replace(/"/g, "&quot;"); }
  function attachmentKind(a) {
    if (a && a.kind) return a.kind;
    var name = String((a && a.name) || "").toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp|heic|heif|avif|svg)$/.test(name)) return "image";
    if (/\.(mp4|webm|mov|m4v|avi|mkv)$/.test(name)) return "video";
    if (/\.(mp3|wav|m4a|aac|ogg|flac|opus)$/.test(name)) return "audio";
    if (/\.pdf$/.test(name)) return "pdf";
    if (/\.(docx?|xlsx?|pptx?)$/.test(name)) return "office";
    if (/\.(md|txt|json|csv|tsv|html?|js|mjs|ts|tsx|jsx|css|py|ps1|sh|ya?ml|xml|log)$/.test(name)) return "text";
    return "other";
  }
  function typeLabel(a) {
    var k = attachmentKind(a);
    return k === "image" ? T("图片") : k === "video" ? T("视频") : k === "audio" ? T("音频") : k === "pdf" ? "PDF" : k === "office" ? T("文档") : k === "text" ? T("文件") : T("文件");
  }
  function formatBytes(value) {
    var n = Number(value) || 0;
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  }
  function fileGlyph(kind) {
    var cls = kind === "pdf" ? " is-pdf" : kind === "office" ? " is-office" : kind === "text" ? " is-text" : "";
    return '<span class="bridge-file-glyph' + cls + '" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3.75h6.2L17.25 7.8V20.25H7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M13 3.75V8h4.25M9.5 12h5M9.5 15.25h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  }
  // 桌面壳（宿主 init 带 dragOut:true）：附件卡挂 draggable，起拖经 drag-out 消息交宿主做原生文件拖拽。
  function dragAttr(a) { return bridge.dragOut && !(a && a.uploading) ? ' draggable="true"' : ''; }
  function fileCardHtml(a, index, extraClass) {
    var meta = [typeLabel(a), formatBytes(a.size)].filter(Boolean).join(" · ");
    return '<button type="button" class="bridge-file-card ' + (extraClass || "") + '" data-preview-attachment="' + index + '"' + dragAttr(a) + '>' +
      fileGlyph(attachmentKind(a)) + '<span class="bridge-file-copy"><b>' + esc(a.name || T("文件")) + '</b><small>' + esc(meta || T("文件")) + '</small></span>' +
      '<span class="bridge-file-open" aria-hidden="true">›</span></button>';
  }
  function imageCardHtml(a, index, role) {
    var imageId = "bridge-message-image-" + (++messageImageSeq);
    messageImages[imageId] = {
      path: a.path || "", sessionId: a.sessionId || "", name: a.name || T("图片")
    };
    return '<button type="button" class="bridge-image-card bridge-image-' + role + '" data-preview-attachment="' + index + '"' + dragAttr(a) + ' aria-label="' + escAttr(T("预览 {name}", { name: a.name || T("图片") })) + '">' +
      '<img src="' + escAttr(a.url || "") + '" alt="' + escAttr(a.name || T("图片")) + '" loading="lazy" data-bridge-image-id="' + imageId + '"><span class="bridge-image-open" aria-hidden="true">↗</span></button>';
  }
  function attachmentHtml(items, role) {
    var attachments = Array.isArray(items) ? items : [];
    var images = [], files = [];
    attachments.forEach(function (a, index) {
      if (attachmentKind(a) === "image" && a.url) images.push(imageCardHtml(a, index, role));
      else files.push(fileCardHtml(a, index, "bridge-file-" + role));
    });
    return (images.length ? '<div class="bridge-image-grid bridge-image-grid-' + role + (images.length === 1 ? ' is-single' : '') + '">' + images.join("") + '</div>' : '') +
      (files.length ? '<div class="bridge-file-list bridge-file-list-' + role + '">' + files.join("") + '</div>' : '');
  }

  var html = document.documentElement;
  var editor = $("#prompt-textarea");
  var trailingBox = $("#composer-trailing-box");
  var turnsBox = $("#turns");
  var scrollRoot = $("#scroll-root");
  var bridge = {
    dragOut: false,
    sessionId: null,
    attachments: [],
    model: "",
    modelLabel: "",
    effort: "",
    serviceTier: null,
    projectId: null,
    projectName: "",
    projects: [],
    sessions: []
  };
  var LAST_PROJECT_KEY = "bridge-chatgpt-last-project";
  function rememberProject(id) {
    if (!id) return;
    try { localStorage.setItem(LAST_PROJECT_KEY, String(id)); } catch (e) {}
  }
  function projectById(id) {
    return bridge.projects.filter(function (p) { return p.id === id; })[0] || null;
  }
  function preferredProject() {
    var saved = "";
    try { saved = localStorage.getItem(LAST_PROJECT_KEY) || ""; } catch (e) {}
    var selected = projectById(saved);
    if (selected) return selected;
    for (var i = 0; i < bridge.sessions.length; i++) {
      selected = projectById(bridge.sessions[i] && bridge.sessions[i].projectId);
      if (selected) return selected;
    }
    return bridge.projects.length === 1 ? bridge.projects[0] : null;
  }
  function applySafeInsets(data) {
    function safeLength(value) {
      var text = String(value || "0px").trim();
      return /^\d+(?:\.\d+)?px$/.test(text) ? text : "0px";
    }
    html.style.setProperty("--bridge-safe-top", safeLength(data.safeTop));
    html.style.setProperty("--bridge-safe-bottom", safeLength(data.safeBottom));
  }
  function sendBridge(type, payload) {
    parent.postMessage(Object.assign({ channel: "bridge-chatgpt", type: type }, payload || {}), "*");
  }
  var workspaceButtons = [];
  function installWorkspaceButtons() {
    ["home-header-actions", "convo-header-actions"].forEach(function (id) {
      var host = $("#" + id);
      if (!host || host.querySelector(".bridge-workspace-button")) return;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "bridge-workspace-button text-token-text-secondary hover:bg-token-surface-hover flex h-10 w-10 items-center justify-center rounded-lg";
      button.setAttribute("aria-label", T("打开项目工作区"));
      button.title = T("项目工作区");
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v13H4zM9 5.5v13M12.5 9h4M12.5 12h4M12.5 15h2.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="bridge-workspace-dot"></span>';
      button.addEventListener("click", function (e) { e.preventDefault(); sendBridge("workspace-toggle"); });
      host.appendChild(button);
      workspaceButtons.push(button);
    });
  }
  installWorkspaceButtons();
  document.addEventListener("error", function (e) {
    var img = e.target && e.target.closest ? e.target.closest("img[data-bridge-image-id]") : null;
    if (!img) return;
    var requestId = img.getAttribute("data-bridge-image-id") || "";
    var item = messageImages[requestId];
    var retries = Number(img.getAttribute("data-bridge-image-retries") || 0);
    if (!item || !item.path || retries >= 2 || img.getAttribute("data-bridge-image-pending") === "1") return;
    img.setAttribute("data-bridge-image-retries", String(retries + 1));
    img.setAttribute("data-bridge-image-pending", "1");
    sendBridge("image-load-error", {
      requestId: requestId, url: img.currentSrc || img.src || "",
      path: item.path, sessionId: item.sessionId, name: item.name
    });
  }, true);

  /* ---------------- theme ---------------- */
  function setTheme(t, persist) {
    html.classList.remove("light", "dark");
    html.classList.add(t);
    html.style.colorScheme = t;
    // the real app bakes the current theme class into each markdown block at render time
    $$(".markdown").forEach(function (el) {
      el.classList.remove("light", "dark");
      el.classList.add(t);
    });
    if (persist) try { localStorage.setItem("clone-theme", t); } catch (e) {}
  }
  window.__setTheme = setTheme;
  (function initTheme() {
    var q = new URLSearchParams(location.search).get("theme");
    var saved = null;
    try { saved = localStorage.getItem("clone-theme"); } catch (e) {}
    var sys = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    setTheme(q === "dark" || q === "light" ? q : (saved || sys), false);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function (e) {
      var s = null;
      try { s = localStorage.getItem("clone-theme"); } catch (er) {}
      if (!s) setTheme(e.matches ? "dark" : "light", false);
    });
  })();

  /* ---------------- sidebar ---------------- */
  // 手机顶栏的侧栏键与工作空间名属于同一个控件。捕获页原本把它们
  // 分成两个透明兄弟节点，这里只加一层 bridge 外壳，保留内部官方 DOM。
  (function joinMobileHeaderCapsule() {
    var sideButton = $("#header-left-capsule");
    var projectTitle = $("#home-chat-menu");
    if (!sideButton || !projectTitle || sideButton.parentNode !== projectTitle.parentNode) return;
    var capsule = document.createElement("div");
    capsule.className = "bridge-mobile-header-capsule";
    sideButton.parentNode.insertBefore(capsule, sideButton);
    capsule.appendChild(sideButton);
    capsule.appendChild(projectTitle);
  })();
  var overlay = $("#sidebar-overlay");
  var sidebar = $("#stage-popover-sidebar");
  function openSidebar() {
    html.setAttribute("data-sidebar", "open");
    sidebar.setAttribute("data-state", "open");
    $('[data-testid="open-sidebar-button"]').setAttribute("aria-expanded", "true");
  }
  function closeSidebar() {
    html.removeAttribute("data-sidebar");
    sidebar.setAttribute("data-state", "closed");
    $('[data-testid="open-sidebar-button"]').setAttribute("aria-expanded", "false");
  }
  $('[data-testid="open-sidebar-button"]').addEventListener("click", openSidebar);
  $('#stage-popover-sidebar [data-testid="close-sidebar-button"]').addEventListener("click", closeSidebar);
  document.addEventListener("click", function (e) {
    if (!e.target.closest('#stage-popover-sidebar [data-testid="close-sidebar-button"]')) return;
    e.preventDefault(); e.stopPropagation(); closeSidebar();
  }, true);
  document.addEventListener("pointerdown", function (e) {
    if (!e.target.closest('#stage-popover-sidebar [data-testid="close-sidebar-button"]')) return;
    e.preventDefault(); e.stopPropagation(); closeSidebar();
  }, true);
  overlay.addEventListener("click", closeSidebar);
  // swipe-left on drawer closes it
  (function () {
    var x0 = null;
    sidebar.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    sidebar.addEventListener("touchmove", function (e) {
      if (x0 !== null && x0 - e.touches[0].clientX > 60) { x0 = null; closeSidebar(); }
    }, { passive: true });
  })();
  $('#stage-popover-sidebar [data-testid="create-new-chat-button"]').addEventListener("click", function (e) {
    e.preventDefault(); closeSidebar(); startProjectChat();
  });
  $$("#stage-popover-sidebar a").forEach(function (a) {
    if (a.getAttribute("data-testid") !== "create-new-chat-button") {
      a.addEventListener("click", function (e) { e.preventDefault(); });
    }
  });
  // 账户行由 bridge 宿主提供身份；主题也跟随宿主，不在 iframe 内另存一套状态。

  /* ---------------- menus (model switcher / plus) ---------------- */
  function bindMenu(btnSel, popSel) {
    var btn = $(btnSel), pop = $(popSel);
    if (!btn || !pop) return;
    function close() {
      pop.classList.remove("clone-menu-open");
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("data-state", "closed");
      document.removeEventListener("pointerdown", onDoc, true);
    }
    function onDoc(e) { if (!pop.contains(e.target) && !btn.contains(e.target)) close(); }
    btn.addEventListener("click", function () {
      if (pop.classList.contains("clone-menu-open")) { close(); return; }
      $$(".clone-menu-open").forEach(function (m) { m.classList.remove("clone-menu-open"); });
      pop.classList.add("clone-menu-open");
      btn.setAttribute("aria-expanded", "true");
      btn.setAttribute("data-state", "open");
      document.addEventListener("pointerdown", onDoc, true);
    });
    pop.addEventListener("click", function (e) {
      var item = e.target.closest("[role='menuitem'],button,a");
      if (item) {
        if (item.textContent.indexOf("思考一下") >= 0) forceThinking = true; // i18n-ignore 按官方中文原文匹配（该菜单项启动时已被裁掉）
        close();
      }
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  }
  bindMenu('[data-testid="composer-plus-btn"]', "#menu-plus-pop");

  /* ---------------- composer ---------------- */
  var PLACEHOLDER = '<p class="placeholder" data-placeholder="' + escAttr(T("有问题，尽管问")) + '"><br class="ProseMirror-trailingBreak"></p>';
  var TRAIL = {
    idle:
      '<button aria-label="' + T("开始听写") + '" class="composer-btn h-9 min-h-9 w-9 min-w-9" type="button">' + svgIcon(IC.mic) + "</button>" +
      '<div><div class="inline-flex"><div>' +
      '<button aria-label="' + T("启动语音功能") + '" class="composer-submit-button-color text-submit-btn-text keyboard-focused:focus-ring relative flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:opacity-70" type="button">' +
      svgIcon(IC.voice, "h-5 w-5") + "</button></div></div></div>",
    typed:
      '<button aria-label="' + T("开始听写") + '" class="composer-btn h-9 min-h-9 w-9 min-w-9" type="button">' + svgIcon(IC.mic) + "</button>" +
      '<div><button id="composer-submit-button" aria-label="' + T("发送提示") + '" data-testid="send-button" class="composer-submit-btn composer-submit-button-color h-9 w-9">' +
      svgIcon(IC.send) + "</button></div>",
    streaming:
      '<button aria-label="' + T("开始听写") + '" class="composer-btn h-9 min-h-9 w-9 min-w-9" type="button">' + svgIcon(IC.mic) + "</button>" +
      '<div><button id="composer-submit-button" aria-label="' + T("停止回答") + '" data-testid="stop-button" class="composer-submit-btn composer-secondary-button-color h-9 w-9">' +
      svgIcon(IC.stop) + "</button></div>"
  };
  var composerState = "idle";
  function setTrailing(state) {
    composerState = state;
    trailingBox.innerHTML = TRAIL[state];
    if (state === "typed") $('[data-testid="send-button"]').addEventListener("click", submit);
    if (state === "streaming") $('[data-testid="stop-button"]').addEventListener("click", stopStreaming);
  }
  function editorText() {
    var p = editor.querySelector("p.placeholder");
    return p ? "" : editor.innerText.replace(/​/g, "").trim();
  }
  function resetEditor() {
    editor.innerHTML = PLACEHOLDER;
  }
  editor.addEventListener("input", function () {
    var ph = editor.querySelector("p.placeholder");
    if (ph && ph.textContent.length > 0) {
      ph.classList.remove("placeholder");
      ph.removeAttribute("data-placeholder");
    }
    var empty = editor.innerText.replace(/\n/g, "").trim().length === 0;
    if (empty) {
      if (!editor.querySelector("p.placeholder")) resetEditor();
      if (composerState === "typed") setTrailing(streamingTurn ? "streaming" : "idle");
    } else if (composerState !== "typed" && !streamingTurn) {
      setTrailing("typed");
    } else if (composerState !== "typed" && streamingTurn) {
      // keep stop button while streaming even if typing
    }
  });
  editor.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  // tapping composer surface focuses editor
  $('[data-composer-surface]').addEventListener("click", function (e) {
    if (e.target.closest("button")) return;
    editor.focus();
  });
  setTrailing("idle");

  /* ---------------- mode switch (home <-> conversation) ---------------- */
  var mode = "home";
  var foldStart = document.createElement('div');
  foldStart.className = 'codex-fold-start';
  foldStart.innerHTML = '<span class="codex-fold-eyebrow">Codex</span><h1>' + T("开始一个任务") + '</h1><p data-fold-project>' + T("选择工作空间，继续推进项目。") + '</p><div class="codex-fold-tools"><button type="button" data-fold-tool="files"><span>' + T("浏览文件") + '</span><span aria-hidden="true">↗</span></button><button type="button" data-fold-tool="review"><span>' + T("查看更改") + '</span><span aria-hidden="true">↗</span></button></div>';
  $('#home-splash').appendChild(foldStart);
  foldStart.addEventListener('click', function (e) {
    var button = e.target.closest('[data-fold-tool]');
    if (!button) return;
    if (!bridge.projectId) { openProjectDialog(); return; }
    sendBridge('workspace-open', { view: button.getAttribute('data-fold-tool') });
  });
  var tbc = $("#thread-bottom-container");
  var TBC_HOME = tbc.className;
  var TBC_CONVO = tbc.className.replace("single-line min-h-0 sm:grow flex flex-col", "content-fade single-line flex flex-col");
  var disclaimer = $("#disclaimer");
  if (disclaimer) disclaimer.remove();
  function enterConvo() {
    if (mode === "convo") return;
    mode = "convo";
    $("#home-splash").classList.add("clone-hidden");
    $("#chips-block").classList.add("clone-hidden");
    $("#messages-region").classList.remove("clone-hidden");
    $("#home-header-actions").classList.add("clone-hidden");
    $("#convo-header-actions").classList.remove("clone-hidden");
    $("#home-chat-menu").classList.add("clone-hidden");
    $("#home-chatwork-seg").classList.add("clone-hidden");
    tbc.className = TBC_CONVO;
  }
  function resetToHome(project) {
    contextUsage = null;
    renderUsage();
    stopStreaming();
    mode = "home";
    bridge.sessionId = null;
    bridge.projectId = project && project.id ? project.id : null;
    bridge.projectName = project && project.name ? project.name : "";
    if (bridge.projectId) rememberProject(bridge.projectId);
    bridge.attachments = [];
    renderAttachments();
    messageImages = {};
    turnsBox.innerHTML = "";
    turnCount = 0;
    $("#home-splash").classList.remove("clone-hidden");
    $("#chips-block").classList.remove("clone-hidden");
    $("#messages-region").classList.add("clone-hidden");
    $("#home-header-actions").classList.remove("clone-hidden");
    $("#convo-header-actions").classList.add("clone-hidden");
    $("#home-chat-menu").classList.remove("clone-hidden");
    $("#home-chatwork-seg").classList.remove("clone-hidden");
    tbc.className = TBC_HOME;
    resetEditor();
    setTrailing("idle");
    scrollRoot.scrollTop = 0;
    updateProjectContext();
    renderSessions(bridge.sessions, bridge.projects);
  }
  function startProjectChat(project) {
    var selected = project || projectById(bridge.projectId) || preferredProject();
    if (!selected) { openProjectDialog(); return; }
    resetToHome(selected);
  }

  /* chips fill the composer like the real ones do */
  $$('#chips-block [data-testid="use-case-prompt-chips"] button').forEach(function (b) {
    // 绑定时按官方中文原文认芯片（英文界面稍后会把静态文字换掉）
    var label = b.textContent.trim();
    var chip = label === "生成图片" ? "image" : label === "撰写或编辑" ? "write" : "search"; // i18n-ignore 与官方静态文案比对
    b.addEventListener("click", function () {
      editor.innerHTML = "<p>" + esc(chip === "image" ? T("生成一张图片：") : chip === "write" ? T("帮我撰写 ") : T("查找资料：")) + "</p>";
      editor.focus();
      var r = document.createRange(); r.selectNodeContents(editor); r.collapse(false);
      var s = getSelection(); s.removeAllRanges(); s.addRange(r);
      editor.dispatchEvent(new Event("input"));
    });
  });

  /* ---------------- turns ---------------- */
  var turnCount = 0;
  function contentShell(inner, padTopOrBottom) {
    return '<div class="text-base my-auto mx-auto ' + padTopOrBottom + ' [--thread-content-margin:var(--thread-content-margin-xs,calc(var(--spacing)*4))] @w-sm/main:[--thread-content-margin:var(--thread-content-margin-sm,calc(var(--spacing)*6))] @w-lg/main:[--thread-content-margin:var(--thread-content-margin-lg,calc(var(--spacing)*16))] px-(--thread-content-margin)">' +
      '<div class="[--thread-content-max-width:40rem] @w-lg/main:[--thread-content-max-width:48rem] mx-auto max-w-(--thread-content-max-width) flex-1 group/turn-messages focus-visible:outline-hidden relative flex w-full min-w-0 flex-col' + (padTopOrBottom.indexOf("pb-10") >= 0 ? " agent-turn" : "") + '">' + inner + "</div></div>";
  }
  function actionBtn(label, icon, testid) {
    return '<button aria-label="' + label + '" class="text-token-text-secondary hover:bg-token-bg-secondary rounded-lg"' + (testid ? ' data-testid="' + testid + '"' : "") + '><span class="flex items-center justify-center touch:w-10 h-8 w-8">' + svgIcon(icon) + "</span></button>";
  }
  function appendUserTurn(text, attachments) {
    turnCount++;
    attachments = Array.isArray(attachments) ? attachments : [];
    var sec = document.createElement("section");
    sec.className = "text-token-text-primary w-full focus:outline-none R6Vx5W_threadScrollVars scroll-mb-[calc(var(--scroll-root-safe-area-inset-bottom,0px)+var(--thread-response-height))] scroll-mt-(--header-height)";
    sec.setAttribute("data-testid", "conversation-turn-" + turnCount);
    sec.setAttribute("data-turn", "user");
    sec.setAttribute("dir", "auto");
    var inner =
      '<div class="flex max-w-full flex-col gap-4 grow">' +
      '<div class="min-h-8 text-message relative flex w-full flex-col items-end gap-2 text-start break-words whitespace-normal outline-none [.text-message+&]:mt-1" data-message-author-role="user" dir="auto">' +
      '<div class="flex w-full flex-col gap-1 empty:hidden items-end rtl:items-start">' +
      attachmentHtml(attachments, "user") +
      (text ? '<div class="user-message-bubble-color corner-superellipse/0.98 relative min-w-0 overflow-hidden rounded-[22px] px-4 py-2.5 leading-6 max-w-(--user-chat-width,70%)">' +
      '<div class="max-w-full min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap">' + esc(text) + "</div></div>" : "") + '</div></div></div>' +
      '<div class="z-0 flex justify-end">' +
      '<div aria-label="' + T("你的消息操作") + '" role="group" class="touch:-me-2 touch:-ms-3.5 -ms-2.5 -me-1 flex flex-wrap items-center gap-y-4 p-1 select-none touch:pointer-events-auto touch:opacity-100 duration-300 pointer-events-none opacity-0 motion-safe:transition-opacity group-hover/turn-messages:pointer-events-auto group-hover/turn-messages:opacity-100" style="mask-position: 0% 0%;">' +
      actionBtn(T("复制消息"), IC.copy, "copy-turn-action-button") +
      actionBtn(T("编辑消息"), IC.edit, "") +
      "</div></div>";
    sec.innerHTML = '<h4 class="sr-only select-none">' + T("你说：") + '</h4>' + contentShell(inner, "pt-3");
    sec._bridgeAttachments = attachments;
    turnsBox.appendChild(sec);
    var cp = sec.querySelector('[data-testid="copy-turn-action-button"]');
    cp.addEventListener("click", function () { try { navigator.clipboard.writeText(text); } catch (e) {} });
    return sec;
  }

  function appendAssistantTurn() {
    turnCount++;
    var sec = document.createElement("section");
    sec.className = "text-token-text-primary w-full focus:outline-none R6Vx5W_threadScrollVars scroll-mb-[calc(var(--scroll-root-safe-area-inset-bottom,0px)+var(--thread-response-height))] scroll-mt-[calc(var(--header-height)+min(200px,max(70px,20svh)))]";
    sec.setAttribute("data-testid", "conversation-turn-" + turnCount);
    sec.setAttribute("data-turn", "assistant");
    sec.setAttribute("dir", "auto");
    var inner =
      '<div class="flex max-w-full flex-col gap-4 grow">' +
      '<div class="cot-row flex items-center justify-between clone-hidden"><div class="flex min-w-0 items-center"></div></div>' +
      '<div class="bridge-assistant-attachments clone-hidden"></div>' +
      '<div class="min-h-8 text-message relative flex w-full flex-col items-end gap-2 text-start break-words whitespace-normal outline-none [.text-message+&]:mt-1" data-message-author-role="assistant" data-turn-start-message="true" dir="auto" tabindex="0">' +
      '<div class="flex w-full flex-col gap-1 empty:hidden">' +
      '<div aria-busy="true" class="result-streaming pulse"><span><pre></pre></span></div>' +
      "</div></div></div>" +
      '<div class="actions-row z-0 flex min-h-[46px] justify-start clone-hidden"></div>';
    sec.innerHTML = '<h4 class="sr-only select-none">' + T("ChatGPT 说：") + '</h4>' + contentShell(inner, "pb-10");
    resetProcessItems(sec);
    turnsBox.appendChild(sec);
    return sec;
  }

  function resetProcessItems(sec) {
    sec._bridgeProcessItems = Object.create(null);
    sec._bridgeProcessOrder = [];
  }

  function processKey(kind, ev) {
    return kind + ":" + (ev.itemId || kind) + (kind === "reasoning" ? ":" + (ev.summaryIndex || 0) : "");
  }

  function recordProcessItem(sec, kind, ev) {
    var key = processKey(kind, ev);
    var item = sec._bridgeProcessItems[key];
    if (!item) {
      item = { kind: kind, key: key, html: "", text: "" };
      sec._bridgeProcessItems[key] = item;
      sec._bridgeProcessOrder.push(key);
    }
    item.html = ev.html || item.html;
    item.text = ev.fullText || item.text;
  }

  function processCount(sec) { return (sec._bridgeProcessOrder || []).length; }

  function processDetailHtml(sec) {
    return (sec._bridgeProcessOrder || []).map(function (key) {
      var item = sec._bridgeProcessItems[key];
      if (!item || !item.html) return "";
      var label = item.kind === "commentary" ? T("进度") : T("思考摘要");
      return '<section class="bridge-process-item bridge-process-' + item.kind + '"><div class="bridge-process-label">' + label + '</div><div class="bridge-process-body">' + item.html + '</div></section>';
    }).join("");
  }

  function shortActivity(value, fallback) {
    var text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return fallback;
    return text.length > 72 ? text.slice(0, 69) + "…" : text;
  }

  function resetAssistantTurn(sec) {
    resetProcessItems(sec);
    sec._bridgeAttachments = [];
    var cot = sec.querySelector(".cot-row");
    cot.classList.add("clone-hidden");
    cot.firstElementChild.innerHTML = "";
    var att = sec.querySelector(".bridge-assistant-attachments");
    att.innerHTML = "";
    att.classList.add("clone-hidden");
    var msgBox = sec.querySelector(".text-message > div");
    msgBox.innerHTML = '<div aria-busy="true" class="result-streaming pulse"><span><pre></pre></span></div>';
    var actions = sec.querySelector(".actions-row");
    actions.innerHTML = "";
    actions.classList.add("clone-hidden");
  }

  function renderAssistantAttachments(sec, attachments) {
    if (!sec) return;
    attachments = Array.isArray(attachments) ? attachments : [];
    sec._bridgeAttachments = attachments;
    var slot = sec.querySelector(".bridge-assistant-attachments");
    if (!slot) return;
    slot.innerHTML = attachmentHtml(attachments, "assistant");
    slot.classList.toggle("clone-hidden", !attachments.length);
  }

  turnsBox.addEventListener("click", function (e) {
    var target = e.target.closest("[data-preview-attachment]");
    if (!target) return;
    var sec = target.closest("section[data-turn]");
    var items = (sec && sec._bridgeAttachments) || [];
    var index = Number(target.getAttribute("data-preview-attachment"));
    if (items[index]) sendBridge("preview", { items: items, index: index, sessionId: bridge.sessionId });
  });

  function dragOutPayload(a) {
    return { attachment: { path: a.path || "", url: a.downloadUrl || a.url || "", name: a.name || "" } };
  }
  turnsBox.addEventListener("dragstart", function (e) {
    if (!bridge.dragOut) return;
    var target = e.target.closest("[data-preview-attachment]");
    if (!target) return;
    var sec = target.closest("section[data-turn]");
    var items = (sec && sec._bridgeAttachments) || [];
    var a = items[Number(target.getAttribute("data-preview-attachment"))];
    if (!a) return;
    e.preventDefault();
    sendBridge("drag-out", dragOutPayload(a));
  });

  /* ---------------- canned replies (original demo content) ---------------- */
  // 下面两段是克隆页早期的演示回复，已无引用（startStream 不再被调用），留作参考、不进界面，所以不翻。
  var REPLY_RICH =
    '<p>好的，下面给你一份从零开始的<strong>手冲咖啡入门指南</strong>，照着做基本不会翻车。</p>' + // i18n-ignore
    '<h2>先准备这些东西</h2>' + // i18n-ignore
    '<ul><li><p>新鲜的咖啡豆（烘焙后 7～30 天内最佳）</p></li>' + // i18n-ignore
    '<li><p>手摇或电动磨豆机，粗细接近白砂糖</p></li>' + // i18n-ignore
    '<li><p>滤杯、滤纸、分享壶，以及一把细口壶</p></li>' + // i18n-ignore
    '<li><p>厨房秤和计时器（手机就行）</p></li></ul>' + // i18n-ignore
    '<h2>核心参数</h2>' + // i18n-ignore
    '<div class="TyagGW_tableContainer"><div class="group TyagGW_tableWrapper flex flex-col-reverse w-fit" tabindex="-1"><table class="w-fit min-w-(--thread-content-width)"><thead><tr><th class="last:pe-10">项目</th><th class="last:pe-10">建议值</th></tr></thead><tbody>' + // i18n-ignore
    '<tr><td>粉水比</td><td>1 : 15</td></tr>' + // i18n-ignore
    '<tr><td>水温</td><td>90～93℃</td></tr>' + // i18n-ignore
    '<tr><td>研磨度</td><td>中度偏细</td></tr>' + // i18n-ignore
    '<tr><td>总时长</td><td>2 分 30 秒左右</td></tr>' + // i18n-ignore
    "</tbody></table></div></div>" +
    '<h2>冲煮步骤</h2>' + // i18n-ignore
    '<ol><li><p><strong>闷蒸</strong>：注入约 2 倍粉重的热水，等 30 秒，让咖啡粉充分排气。</p></li>' + // i18n-ignore
    '<li><p><strong>分段注水</strong>：以画圈方式分两到三段注完剩余热水，水位保持稳定。</p></li>' + // i18n-ignore
    '<li><p><strong>等待滴滤</strong>：水线断流后移开滤杯，轻摇分享壶让浓度均匀。</p></li></ol>' + // i18n-ignore
    '<blockquote><p>新手最容易忽略的其实是<strong>水质</strong>：用过滤水会比直接用自来水干净清甜得多。</p></blockquote>' + // i18n-ignore
    '<hr>' +
    '<p>如果你告诉我现有的器具和喜欢的口味（偏酸果香还是偏醇厚），我可以帮你把参数再调得更细一些。</p>'; // i18n-ignore

  var REPLY_THINKING =
    '<p>白天的天空呈现蓝色，核心原因是<strong>瑞利散射</strong>：大气分子的尺寸远小于可见光波长，散射强度大致与波长的四次方成反比。</p>' + // i18n-ignore
    '<h2>一步步拆开看</h2>' + // i18n-ignore
    '<ol><li><p>太阳光是混合光，包含从红到紫的各种波长。</p></li>' + // i18n-ignore
    '<li><p>波长越短，被空气分子散射得越厉害——蓝紫光被散射的强度可达红光的好几倍。</p></li>' + // i18n-ignore
    '<li><p>被散射的蓝光从四面八方进入你的眼睛，于是整个天空看起来是蓝的。</p></li></ol>' + // i18n-ignore
    '<h2>两个常见追问</h2>' + // i18n-ignore
    '<ul><li><p><strong>为什么不是紫色？</strong>紫光虽然散射更强，但太阳光里紫光占比少，而且人眼对紫色不敏感。</p></li>' + // i18n-ignore
    '<li><p><strong>为什么日落是红的？</strong>夕阳光线斜穿大气层，路径变长，蓝光在途中几乎被散射殆尽，剩下的红橙光直达你的眼睛。</p></li></ul>' + // i18n-ignore
    '<blockquote><p>同样的物理也解释了为什么大海远看偏蓝、烟雾在逆光下偏蓝灰。</p></blockquote>' + // i18n-ignore
    '<p>想更进一步的话，我可以推一遍散射强度与波长关系的简化公式。</p>'; // i18n-ignore

  var THOUGHT_TEXT =
    T('<p>用户想知道天空为什么是蓝色。这本质上是瑞利散射问题：先解释散射与波长的关系，再回应"为什么不是紫色"和"日落为什么偏红"这两个最常见的疑问，最后给一个可展开的方向。</p>');

  var replyIndex = 0;
  var forceThinking = false;

  /* ---------------- streaming engine ---------------- */
  var streamingTurn = null;
  var streamTimers = [];
  var thinkStart = 0;
  function clearTimers() {
    streamTimers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    streamTimers = [];
  }
  function later(fn, ms) { var t = setTimeout(fn, ms); streamTimers.push(t); return t; }

  function submit() {
    var text = editorText();
    if ((!text && !bridge.attachments.length) || streamingTurn || !MODEL_META.length) return;
    if (!bridge.projectId) { startProjectChat(); return; }
    enterConvo();
    var outgoingAttachments = bridge.attachments.slice();
    var userSec = appendUserTurn(text, outgoingAttachments);
    resetEditor();
    setTrailing("streaming");
    var sec = appendAssistantTurn();
    streamingTurn = sec;
    userSec.scrollIntoView({ behavior: "smooth", block: "start" });
    thinkStart = Date.now();
    sendBridge("send", {
      message: text,
      sessionId: bridge.sessionId,
      model: bridge.model,
      effort: bridge.effort,
      serviceTier: bridge.serviceTier,
      projectId: bridge.projectId,
      attachments: outgoingAttachments
    });
    bridge.attachments = [];
    renderAttachments();
  }

  function liveMarkdown(sec) {
    var msgBox = sec.querySelector(".text-message > div");
    var md = msgBox.querySelector(".markdown");
    if (!md) {
      var themeCls = html.classList.contains("dark") ? "dark" : "light";
      msgBox.innerHTML = '<div class="markdown prose dark:prose-invert wrap-break-word w-full ' + themeCls + ' markdown-new-styling result-streaming"></div>';
      md = msgBox.firstElementChild;
    }
    return md;
  }

  function showActivity(sec, label) {
    var row = sec.querySelector(".cot-row");
    row.classList.remove("clone-hidden");
    row.firstElementChild.innerHTML = '<div class="loading-shimmer text-token-text-tertiary select-none">' + esc(label) + "</div>";
  }

  function activityLabel(tool) {
    if (!tool) return T("正在处理");
    if (tool.kind === "command") return tool.status === "completed" ? T("已运行命令") : T("正在运行命令");
    if (tool.kind === "file_change") return tool.status === "completed" ? T("已修改文件") : T("正在修改文件");
    if (tool.kind === "web_search") return T("正在搜索网页");
    if (tool.kind === "mcp") return tool.tool ? T("正在使用 {tool}", { tool: tool.tool }) : T("正在使用 工具");
    if (tool.kind === "dynamic_tool") return tool.status === "completed" ? T("已生成内容") : T("正在生成内容");
    return T("正在使用工具");
  }

  var STREAM_FADE_MS = 260;
  function streamVisibleTextNodes(node) {
    var out = [];
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: function (text) {
        var parent = text.parentElement;
        if (!parent || parent.closest(".katex")) return NodeFilter.FILTER_REJECT;
        if (!/\S/.test(text.nodeValue) && !parent.closest("pre")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var text; while ((text = walker.nextNode())) out.push(text);
    return out;
  }
  function animateStreamTail(md) {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var state = md.__bridgeStreamFade || { shown: 0, chunks: [] };
    md.__bridgeStreamFade = state;
    var nodes = streamVisibleTextNodes(md);
    var total = nodes.reduce(function (sum, node) { return sum + node.nodeValue.length; }, 0);
    var now = performance.now ? performance.now() : Date.now();
    if (total > state.shown) {
      state.chunks.push({ start: state.shown, end: total, born: now });
      state.shown = total;
    } else if (total < state.shown) {
      state.shown = total;
      state.chunks = [];
    }
    state.chunks = state.chunks.filter(function (chunk) {
      return now - chunk.born < STREAM_FADE_MS && chunk.end > chunk.start;
    });
    if (!state.chunks.length) return;
    var index = 0;
    nodes.forEach(function (textNode) {
      var start = index;
      var end = start + textNode.nodeValue.length;
      index = end;
      var hits = [];
      state.chunks.forEach(function (chunk) {
        var a = Math.max(chunk.start, start);
        var b = Math.min(chunk.end, end);
        if (b > a) hits.push({ start: a - start, end: b - start, age: now - chunk.born });
      });
      if (!hits.length || !textNode.parentNode) return;
      hits.sort(function (a, b) { return a.start - b.start; });
      var value = textNode.nodeValue;
      var fragment = document.createDocumentFragment();
      var cursor = 0;
      hits.forEach(function (hit) {
        if (hit.start > cursor) fragment.appendChild(document.createTextNode(value.slice(cursor, hit.start)));
        var span = document.createElement("span");
        span.className = "bridge-stream-in";
        span.style.animationDelay = "-" + Math.round(hit.age) + "ms";
        span.textContent = value.slice(hit.start, hit.end);
        fragment.appendChild(span);
        cursor = hit.end;
      });
      if (cursor < value.length) fragment.appendChild(document.createTextNode(value.slice(cursor)));
      textNode.parentNode.replaceChild(fragment, textNode);
    });
  }

  function handleBridgeEvent(ev) {
    if (!ev) return;
    if (ev.type === "context-usage") {
      if (!ev.sessionId || ev.sessionId === bridge.sessionId) { contextUsage = ev.contextUsage || null; renderUsage(); }
      return;
    }
    if (ev.type === "session") {
      bridge.sessionId = ev.sessionId || bridge.sessionId;
      if (MODEL_META.some(function (m) { return m.id === ev.model; })) {
        bridge.model = ev.model;
        bridge.effort = ev.effort;
        bridge.serviceTier = ev.serviceTier || null;
        renderPicker();
      }
      return;
    }
    if (ev.type === "attach") {
      if (ev.sessionId && bridge.sessionId !== ev.sessionId) { contextUsage = null; renderUsage(); }
      bridge.sessionId = ev.sessionId || bridge.sessionId;
      bridge.projectId = ev.projectId || bridge.projectId;
      if (bridge.projectId) rememberProject(bridge.projectId);
      updateProjectContext();
      enterConvo();
      if (!streamingTurn) {
        if (ev.userText) appendUserTurn(ev.userText, []);
        streamingTurn = appendAssistantTurn();
      } else {
        resetAssistantTurn(streamingTurn);
      }
      setTrailing("streaming");
      thinkStart = Date.now() - Math.max(0, Number(ev.elapsedMs) || 0);
      return;
    }
    var sec = streamingTurn;
    if (!sec) return;
    if (ev.type === "commentary") {
      recordProcessItem(sec, "commentary", ev);
      showActivity(sec, shortActivity(ev.fullText, T("正在处理")));
    } else if (ev.type === "reasoning" || ev.type === "thinking") {
      recordProcessItem(sec, "reasoning", ev);
      showActivity(sec, T("正在思考"));
    } else if (ev.type === "tool") {
      showActivity(sec, activityLabel(ev.tool));
    } else if (ev.type === "reconnecting") {
      showActivity(sec, T("正在重新连接"));
    } else if (ev.type === "text") {
      var md = liveMarkdown(sec);
      md.innerHTML = ev.html || "";
      animateStreamTail(md);
      requestAnimationFrame(function () { scrollRoot.scrollTop = scrollRoot.scrollHeight; });
    } else if (ev.type === "done") {
      if (ev.sessionId) bridge.sessionId = ev.sessionId;
      var doneMd = liveMarkdown(sec);
      if (ev.html) doneMd.innerHTML = ev.html;
      renderAssistantAttachments(sec, ev.attachments || []);
      finishTurn(sec, doneMd, processCount(sec) > 0, false,
        Math.max(1, Math.round((Date.now() - thinkStart) / 1000)));
      sendBridge("sessions");
    } else if (ev.type === "interrupted") {
      var stoppedMd = liveMarkdown(sec);
      if (ev.html) stoppedMd.innerHTML = ev.html;
      renderAssistantAttachments(sec, ev.attachments || []);
      finishTurn(sec, stoppedMd, processCount(sec) > 0, true,
        Math.max(1, Math.round((Date.now() - thinkStart) / 1000)));
      sendBridge("sessions");
    } else if (ev.type === "error") {
      var errMd = liveMarkdown(sec);
      errMd.innerHTML = (ev.html || "") + '<p class="bridge-error">' + esc(ev.message || T("调用失败，请重试")) + "</p>";
      renderAssistantAttachments(sec, ev.attachments || []);
      finishTurn(sec, errMd, processCount(sec) > 0, true,
        Math.max(1, Math.round((Date.now() - thinkStart) / 1000)));
    }
  }

  function startStream(sec, msgBox, replyHTML, hadThinking) {
    if (streamingTurn !== sec) return;
    var themeCls = html.classList.contains("dark") ? "dark" : "light";
    msgBox.innerHTML = '<div class="markdown prose dark:prose-invert wrap-break-word w-full ' + themeCls + ' markdown-new-styling result-streaming"></div>';
    var md = msgBox.firstElementChild;
    var tpl = document.createElement("template");
    tpl.innerHTML = replyHTML;
    // reveal units: list/blockquote children stream item by item, like real parsed markdown
    var units = [];
    Array.prototype.slice.call(tpl.content.children).forEach(function (b) {
      if (/^(UL|OL|BLOCKQUOTE)$/.test(b.tagName)) {
        var shellId = units.length;
        units.push({ kind: "shell", el: b, id: shellId });
        Array.prototype.slice.call(b.children).forEach(function (child) {
          units.push({ kind: "child", el: child, shell: shellId });
        });
      } else {
        units.push({ kind: "block", el: b });
      }
    });
    var shells = {};
    var ui = 0;
    var srcNodes = null, dstNodes = null, ni = 0, ci = 0;

    function nextUnit() {
      if (streamingTurn !== sec) return finalize(true);
      if (ui >= units.length) return finalize(false);
      var u = units[ui++];
      if (u.kind === "shell") {
        var shell = u.el.cloneNode(false);
        shells[u.id] = shell;
        md.appendChild(shell);
        nextUnit();
        return;
      }
      var clone = u.el.cloneNode(true);
      srcNodes = textNodes(u.el);
      dstNodes = textNodes(clone);
      dstNodes.forEach(function (n) { n.nodeValue = ""; });
      (u.kind === "child" ? shells[u.shell] : md).appendChild(clone);
      ni = 0; ci = 0;
      if (u.el.tagName === "HR" || (u.el.tagName === "DIV" && u.el.className.indexOf("tableContainer") >= 0)) {
        // tables & rules appear whole, like parsed markdown chunks
        dstNodes.forEach(function (n, i) { n.nodeValue = srcNodes[i].nodeValue; });
        later(nextUnit, 160);
        return;
      }
      tick();
    }
    function tick() {
      if (streamingTurn !== sec) return finalize(true);
      if (ni >= srcNodes.length) { later(nextUnit, 60 + Math.random() * 120); return; }
      var srcVal = srcNodes[ni].nodeValue;
      var step = 2 + Math.floor(Math.random() * 5);
      ci = Math.min(srcVal.length, ci + step);
      dstNodes[ni].nodeValue = srcVal.slice(0, ci);
      if (ci >= srcVal.length) { ni++; ci = 0; }
      later(tick, 28 + Math.random() * 40);
    }
    function textNodes(root) {
      var out = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var n; while ((n = w.nextNode())) out.push(n);
      return out;
    }
    var thinkSecs = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
    function finalize(aborted) {
      finishTurn(sec, md, hadThinking, aborted, thinkSecs);
    }
    nextUnit();
  }

  function bindCotToggle(sec) {
    var btn = sec.querySelector(".cot-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var ex = sec.querySelector(".cot-detail");
      if (ex) { ex.remove(); return; }
      var d = document.createElement("div");
      d.className = "cot-detail border-token-border-default text-token-text-secondary ms-1 my-1 border-s ps-4 text-sm";
      d.innerHTML = processDetailHtml(sec) || THOUGHT_TEXT;
      btn.closest(".cot-row").after(d);
    });
  }

  function finishTurn(sec, md, hadThinking, aborted, thinkSecs) {
    if (!sec) return;
    clearTimers();
    md.classList.remove("result-streaming");
    md.removeAttribute("aria-busy");
    if (hadThinking) {
      var cotSlot = sec.querySelector(".cot-row").firstElementChild;
      if (cotSlot.querySelector(".loading-shimmer")) {
        var count = processCount(sec);
        var label = aborted ? T("已停止 · 查看过程")
          : count > 1 ? T("已思考 {n} 秒 · 查看过程（{count}）", { n: thinkSecs || 1, count: count })
          : T("已思考 {n} 秒 · 查看过程", { n: thinkSecs || 1 });
        cotSlot.innerHTML =
          '<button class="cot-toggle text-token-text-tertiary hover:text-token-text-primary dark:hover:text-token-text-primary flex items-center gap-0.5 text-start dark:text-(--interactive-label-tertiary-default)" type="button">' + label +
          svgIcon(IC.chevron, "icon-xs") + "</button>";
        bindCotToggle(sec);
      }
    } else {
      sec.querySelector(".cot-row").classList.add("clone-hidden");
    }
    var row = sec.querySelector(".actions-row");
    row.innerHTML =
      '<div aria-label="' + T("回复操作") + '" role="group" class="touch:-me-2 touch:-ms-3.5 -ms-2.5 -me-1 flex flex-wrap items-center gap-y-4 p-1 select-none touch:w-[calc(100%+--spacing(3.5))] -mt-1 w-[calc(100%+--spacing(2.5))] touch:pointer-events-auto" style="mask-position: 0% 0%;">' +
      actionBtn(T("复制回复"), IC.copy, "copy-turn-action-button") +
      '<span data-state="closed"><button aria-label="' + T("切换模型") + '" class="cursor-pointer touch:px-2.5 text-token-text-secondary hover:bg-token-bg-secondary h-[30px] rounded-md px-1.5" type="button"><div class="flex items-center">' + svgIcon(IC.switchModel) + "</div></button></span>" +
      "</div>";
    row.classList.remove("clone-hidden");
    var cp = row.querySelector('[data-testid="copy-turn-action-button"]');
    cp.addEventListener("click", function () { try { navigator.clipboard.writeText(md.innerText); } catch (e) {} });
    streamingTurn = null;
    if (composerState === "streaming") setTrailing(editorText() ? "typed" : "idle");
  }

  function stopStreaming() {
    if (!streamingTurn) return;
    sendBridge("stop");
    var sec = streamingTurn;
    streamingTurn = null;
    clearTimers();
    var md = sec.querySelector(".markdown");
    if (md) {
      finishTurn(sec, md, processCount(sec) > 0, true);
    } else {
      // still in placeholder/thinking phase: keep "已停止思考" semantics
      var msgBox = sec.querySelector(".text-message > div");
      msgBox.innerHTML = '<div class="markdown prose dark:prose-invert wrap-break-word w-full light markdown-new-styling"></div>';
      finishTurn(sec, msgBox.firstElementChild, processCount(sec) > 0, true);
    }
  }

  /* ================= 2026-07 refresh: Chat 菜单 / composer 模型 pill / 横屏 rail ================= */

  function placePop(pop, anchorRect, side, align, gap) {
    var panel = pop.querySelector("[data-radix-menu-content]");
    var viewport = window.visualViewport;
    var vw = viewport ? viewport.width : window.innerWidth;
    var vh = viewport ? viewport.height : window.innerHeight;
    var vy = viewport ? viewport.offsetTop : 0;
    panel.style.maxWidth = Math.max(0, vw - 16) + "px";
    panel.style.maxHeight = Math.max(0, vh - 16) + "px";
    panel.style.overflowY = "auto";
    var mw = panel.offsetWidth, mh = panel.offsetHeight;
    var x = align === "end" ? anchorRect.right - mw : anchorRect.left;
    var y = side === "top" ? anchorRect.top - (gap || 8) - mh : anchorRect.bottom + (gap || 8);
    x = Math.max(8, Math.min(x, vw - mw - 8));
    y = Math.max(vy + 8, Math.min(y, vy + vh - mh - 8));
    pop.style.transform = "translate(" + x + "px, " + y + "px)";
    pop.style.setProperty("--radix-popper-transform-origin",
      (align === "end" ? "100% " : "0% ") + (side === "top" ? mh + "px" : "0px"));
  }

  var activeMenuClose = null;
  function menuController(btn, pop, opts) {
    var open = false;
    var anchorObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(reposition) : null;
    function close() {
      if (!open) return;
      open = false;
      pop.classList.remove("clone-menu-open");
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("data-state", "closed");
      document.removeEventListener("pointerdown", onDoc, true);
      if (anchorObserver) anchorObserver.disconnect();
      if (opts.onClose) opts.onClose();
      if (activeMenuClose === close) activeMenuClose = null;
    }
    function onDoc(e) {
      if (pop.contains(e.target) || btn.contains(e.target)) return;
      if (opts.alsoInside && opts.alsoInside().some(function (el) { return el && el.contains(e.target); })) return;
      close();
    }
    btn.addEventListener("click", function () {
      if (open) { close(); return; }
      if (activeMenuClose) activeMenuClose();
      $$(".clone-menu-open").forEach(function (m) { m.classList.remove("clone-menu-open"); });
      open = true;
      activeMenuClose = close;
      pop.classList.add("clone-menu-open");
      btn.setAttribute("aria-expanded", "true");
      btn.setAttribute("data-state", "open");
      placePop(pop, btn.getBoundingClientRect(), opts.side, opts.align, opts.gap);
      document.addEventListener("pointerdown", onDoc, true);
      if (anchorObserver) {
        anchorObserver.observe(btn);
        anchorObserver.observe(pop.querySelector('[data-radix-menu-content]'));
        if (tbc) anchorObserver.observe(tbc);
      }
      if (opts.onOpen) opts.onOpen();
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    function reposition() { if (open) placePop(pop, btn.getBoundingClientRect(), opts.side, opts.align, opts.gap); }
    window.addEventListener("resize", reposition);
    // The host applies its layout tier after the iframe resize event. Observe the
    // composer as well so open menus follow sidebar transitions and fold changes.
    document.addEventListener('scroll', reposition, { capture: true, passive: true });
    if (window.visualViewport) window.visualViewport.addEventListener("resize", reposition);
    return { close: close };
  }

  /* radio check marks (official trailing span pattern) */
  function setRadio(group, item) {
    $$('[role="menuitemradio"]', group).forEach(function (it) {
      var on = it === item;
      it.setAttribute("aria-checked", on ? "true" : "false");
      it.setAttribute("data-state", on ? "checked" : "unchecked");
      var tr = it.querySelector(".trailing");
      var chk = tr.querySelector('span[data-state="checked"]');
      if (on && !chk) tr.insertAdjacentHTML("afterbegin", '<span data-state="checked">' + svgIcon2("249d41", "icon-sm", 16) + "</span>");
      if (!on && chk) chk.remove();
    });
  }

  /* ---- Chat / Work 菜单（主页顶栏左） ---- */
  var chatBtn = $("#chat-title-button"), chatPop = $("#menu-chat-pop");
  if (chatBtn && chatPop) {
    var chatCtl = menuController(chatBtn, chatPop, { side: "bottom", align: "start" });
    $("#chat-mode-group").addEventListener("click", function (e) {
      var it = e.target.closest('[role="menuitemradio"]');
      if (!it) return;
      applyChatMode(it.getAttribute("data-value"));
      chatCtl.close();
    });
  }

  /* Chat/Work 状态统一入口：同步 Chat˅ 菜单 + md 头部分段控件 */
  function applyChatMode(mode) {
    var isChat = mode === "Chat";
    if (chatBtn) {
      chatBtn.firstElementChild.firstChild.nodeValue = mode;
      setRadio($("#chat-mode-group"), $$('#chat-mode-group [role="menuitemradio"]').filter(function (m) {
        return m.getAttribute("data-value") === mode;
      })[0]);
    }
    var segThumb = $("#seg-thumb");
    if (segThumb) {
      (isChat ? $("#seg-col-chat") : $("#seg-col-work")).appendChild(segThumb);
      segThumb.style.insetInlineStart = isChat ? "" : "-8.5px";
      segThumb.style.insetInlineEnd = isChat ? "" : "-0.5px";
      $$("#home-chatwork-seg [data-seg]").forEach(function (x) {
        var on = x.getAttribute("data-seg") === mode;
        x.setAttribute("data-state", on ? "on" : "off");
        x.setAttribute("aria-checked", on ? "true" : "false");
        x.classList.toggle("text-token-text-primary", on);
        x.classList.toggle("text-token-text-secondary", !on);
      });
    }
  }
  var segEl = $("#home-chatwork-seg");
  if (segEl) segEl.addEventListener("click", function (e) {
    var b = e.target.closest("[data-seg]");
    if (b) applyChatMode(b.getAttribute("data-seg"));
  });

  /* ---- 模型、effort 和 Fast 能力全部由宿主的同源 capabilities 下发 ---- */
  var pill = $("#composer-intelligence-pill"), pillLabel = $("#composer-pill-label");
  var pillPop = $("#menu-pill-pop"), subPop = $("#menu-pill-sub");
  var MODEL_META = [], EFFORT_LABEL = {}, pickerDefaults = {};
  var savedPicker = null;
  try {
    savedPicker = JSON.parse(localStorage.getItem("bridge-chatgpt-picker") || "null");
  } catch (e) {}
  if (subPop) subPop.remove();

  function applyCapabilities(catalog) {
    if (!catalog || !Array.isArray(catalog.models) || !catalog.models.length) return;
    var models = catalog.models.filter(function (m) { return m.id && Array.isArray(m.efforts) && m.efforts.length; });
    if (!models.length) return;
    var selected = bridge.model ? bridge : (savedPicker || catalog.defaults || {});
    MODEL_META = models.map(function (m) {
      return { id: m.id, label: m.name || m.id, desc: m.description || "", efforts: m.efforts, serviceTiers: m.serviceTiers || [] };
    });
    EFFORT_LABEL = {};
    (catalog.efforts || []).forEach(function (e) { EFFORT_LABEL[e.id] = e.name; });
    pickerDefaults = catalog.defaults || {};
    var model = MODEL_META.filter(function (m) { return m.id === selected.model; })[0] ||
      MODEL_META.filter(function (m) { return m.id === pickerDefaults.model; })[0] || MODEL_META[0];
    bridge.model = model.id;
    bridge.effort = selected.effort;
    bridge.serviceTier = selected.serviceTier === "priority" ? "priority" : null;
    renderPicker();
  }

  // The template and CSS are extracted from ChatGPT Work, not recreated markup.
  // Only state, capability enumeration and browser input events belong to Bridge.
  var EFFORT_ZH = { low: '轻量', medium: '中等', high: '高', xhigh: '超高', max: '极高', ultra: '最高' }; // i18n-ignore 中文档名；英文走 EFFORT_EN
  // 英文按档位 id 起名（GLOSSARY §4.7），不能拿 EFFORT_ZH 的中文去查字典：这里的「极高」是 max、「最高」是 ultra
  var EFFORT_EN = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
  var pickerView = 'intensity', pickerPanel, modelRowTemplate, pickerResize, workSlider, pickerOptions = [];
  function effortName(value) { return (BRIDGE_LANG === 'en' ? EFFORT_EN[value] : EFFORT_ZH[value]) || EFFORT_LABEL[value] || value; }
  function modelName(model) { return /^\d/.test(model.label) ? 'GPT-' + model.label : model.label; }
  function currentModel() { return MODEL_META.filter(function (m) { return m.id === bridge.model; })[0] || MODEL_META[0]; }
  function savePicker() {
    try { localStorage.setItem('bridge-chatgpt-picker', JSON.stringify({model:bridge.model, effort:bridge.effort, serviceTier:bridge.serviceTier})); } catch (e) {}
  }
  function mountOfficialPicker() {
    var template = $('#official-work-picker');
    if (!template) return false;
    pickerPanel = template.content.firstElementChild.cloneNode(true);
    pickerPanel.id = 'bridge-work-picker';
    pickerPanel.setAttribute('aria-labelledby', pill.id);
    pickerPanel.removeAttribute('style');
    pickerPanel.setAttribute('aria-label', T('模型与思考强度'));
    pickerPanel.querySelectorAll('[popover="hint"]').forEach(function (n) { n.remove(); });
    pickerPanel.querySelectorAll('[interestfor]').forEach(function (n) {
      n.removeAttribute('interestfor'); n.removeAttribute('aria-describedby'); n.removeAttribute('style');
      n.title = n.getAttribute('aria-label');
    });
    var ids = {'.d1BZWq_ViewToggle':'bridge-model-select', '.d1BZWq_ViewToggleEffortLabel':'bridge-intensity-name',
      '.d1BZWq_ViewToggleModelLabel':'bridge-intensity-model', '.d1BZWq_FastModeToggle':'bridge-fast-toggle',
      '.d1BZWq_ResetToDefault':'bridge-picker-reset', '.d1BZWq_AdvancedView > [role="group"]':'bridge-model-group'};
    Object.keys(ids).forEach(function (selector) { pickerPanel.querySelector(selector).id = ids[selector]; });
    modelRowTemplate = pickerPanel.querySelector('[role="menuitemradio"][aria-checked="true"]').cloneNode(true);
    var control = pickerPanel.querySelector('.d1BZWq_SliderControl');
    control.id = 'bridge-effort-control';
    control.removeAttribute('tabindex'); control.removeAttribute('role'); control.removeAttribute('aria-describedby');
    control.replaceChildren();
    pillPop.replaceChildren(pickerPanel);
    $('#bridge-model-select').onclick = function () { setPickerView('models'); $('#bridge-model-group [aria-checked="true"]').focus({preventScroll:true}); };
    $('#bridge-fast-toggle').onclick = function () {
      if (currentModel().serviceTiers.indexOf('priority') < 0) return;
      bridge.serviceTier = bridge.serviceTier === 'priority' ? null : 'priority'; syncPickerDisplay(); savePicker();
    };
    $('#bridge-picker-reset').onclick = function () {
      bridge.model = pickerDefaults.model; bridge.effort = pickerDefaults.effort; bridge.serviceTier = pickerDefaults.serviceTier || null;
      renderPicker(); savePicker();
    };
    $('#bridge-model-group').onclick = function (e) {
      var row = e.target.closest('[data-value]'); if (!row) return;
      bridge.model = row.dataset.value; renderPicker(); setPickerView('intensity'); savePicker();
      $('#bridge-model-select').focus({preventScroll:true});
    };
    pickerPanel.addEventListener('keydown', function (e) {
      var target = e.target.closest('[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]');
      if (target && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); target.click(); }
      if (pickerView === 'models' && e.key === 'ArrowLeft') { e.preventDefault(); setPickerView('intensity'); $('#bridge-model-select').focus(); }
      if (e.target.id !== 'bridge-effort-range' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        var rows = Array.from(pickerPanel.querySelectorAll(pickerView === 'models' ? '#bridge-model-group [data-value]' : '.d1BZWq_ViewControls [tabindex="0"],#bridge-effort-range'));
        var index = rows.indexOf(document.activeElement);
        e.preventDefault(); rows[(index+(e.key === 'ArrowDown'?1:-1)+rows.length)%rows.length]?.focus({preventScroll:true});
      }
    });
    // Re-measure only the content, not the animated height, to avoid a resize loop.
    pickerResize = new ResizeObserver(function () { updatePickerHeight(); });
    pickerResize.observe($('#bridge-model-group'));
    return true;
  }
  function updatePickerHeight() {
    if (!pickerPanel || !pillPop.classList.contains('clone-menu-open')) return;
    var menu = pickerPanel.querySelector('.d1BZWq_Menu');
    var height = pickerView === 'models' ? $('#bridge-model-group').getBoundingClientRect().height + 12 : 91;
    menu.style.height = height + 'px';
    placePop(pillPop, pill.getBoundingClientRect(), 'top', 'end', 8);
  }
  function setPickerView(view) {
    pickerView = view;
    var advanced = view === 'models';
    pickerPanel.querySelector('.d1BZWq_Menu').dataset.view = advanced ? 'advanced' : 'simple';
    pickerPanel.querySelector('.d1BZWq_ViewControls').dataset.expanded = String(advanced);
    pickerPanel.querySelector('.d1BZWq_SliderTopRowMotion').dataset.active = String(!advanced);
    pickerPanel.querySelector('.d1BZWq_SliderMotion').dataset.active = String(!advanced);
    pickerPanel.querySelector('.d1BZWq_ModelListMotion').dataset.active = String(advanced);
    pickerPanel.querySelectorAll('.d1BZWq_ViewPanel').forEach(function (p,i) { p.dataset.active = String(i === (advanced?1:0)); p.inert = p.dataset.active !== 'true'; });
    pickerPanel.querySelector('.d1BZWq_ViewControls').inert = advanced;
    syncPickerDisplay(); updatePickerHeight();
  }
  function syncPickerDisplay() {
    var model = currentModel(); if (!model || !pickerPanel) return;
    var name = effortName(bridge.effort), fast = bridge.serviceTier === 'priority';
    var open = pillPop.classList.contains('clone-menu-open');
    pillLabel.textContent = open ? T('选择强度') : modelName(model) + ' ' + name;
    pill.setAttribute('aria-haspopup','menu'); pill.setAttribute('aria-controls',pickerPanel.id);
    pill.setAttribute('aria-label',modelName(model)+' '+name+(fast?' · Fast':''));
    // 中文界面的 title 附官方英文档名；英文界面直接用同一个档名，免得胶囊写 Low、提示写 Light
    pill.title = modelName(model)+' · '+(BRIDGE_LANG === 'en' ? name : (EFFORT_LABEL[bridge.effort] || bridge.effort))+(fast?' · Fast':'');
    $('#bridge-intensity-name').textContent = name; $('#bridge-intensity-model').textContent = modelName(model);
    var index = model.efforts.indexOf(bridge.effort), count = model.efforts.length;
    var props = {
      fastModeEnabled:fast, options:pickerOptions, selectedOptionId:bridge.effort,
      onSelectOption:function (option) { bridge.effort=option.id; syncPickerDisplay(); savePicker(); },
      onCommitOption:function () { savePicker(); }, onDragToMaximum:function () {},
      onTooltipOptionHover:function () {}
    };
    if (workSlider) workSlider.update(props);
    else workSlider = window.BridgeWorkSlider.mount($('#bridge-effort-control'),props);
    var range = pickerPanel.querySelector('._9wXMRW_Root');
    range.id='bridge-effort-range'; range.tabIndex=0; range.setAttribute('role','slider');
    range.setAttribute('aria-label',T('思考强度')); range.setAttribute('aria-valuemin','0');
    range.setAttribute('aria-valuemax',count-1); range.setAttribute('aria-valuenow',index);
    range.setAttribute('aria-valuetext',name);
    pickerPanel.querySelector('.d1BZWq_KeyboardAnnouncement').textContent = T('{name}，第 {i} 项，共 {n} 项。', { name: name, i: index+1, n: count });
    var toggle = $('#bridge-fast-toggle');
    toggle.setAttribute('aria-checked',String(fast)); toggle.dataset.fastModeEnabled = String(fast);
    toggle.setAttribute('aria-disabled',String(model.serviceTiers.indexOf('priority')<0));
    toggle.setAttribute('aria-label',fast?T('关闭快速模式'):T('启用快速模式'));
    toggle.title = fast ? T('关闭 Fast：更快响应，额度消耗增加') : T('启用 Fast：更快响应，额度消耗增加');
    toggle.querySelector('use').setAttribute('href','assets/sprites-interaction-4e54fd96.svg#'+(fast?'bolt-fill-16':'bolt-16'));
    // Fast service tier is independent of effort in Codex. Keep all capability stops.
    if (open) updatePickerHeight();
  }
  function renderPicker() {
    if (!pill || !pillPop || !pillLabel) return;
    pill.disabled = !MODEL_META.length;
    if (!MODEL_META.length) { pillLabel.textContent = T('加载模型…'); return; }
    if (!pickerPanel && !mountOfficialPicker()) return;
    var model = currentModel(); bridge.model = model.id; bridge.modelLabel = model.label;
    if (model.efforts.indexOf(bridge.effort)<0) bridge.effort = model.efforts.indexOf(pickerDefaults.effort)>=0?pickerDefaults.effort:model.efforts[0];
    if (model.serviceTiers.indexOf('priority')<0) bridge.serviceTier = null;
    var group = $('#bridge-model-group'), heading = group.querySelector('.__menu-label').cloneNode(true);
    heading.id = 'bridge-picker-back'; heading.tabIndex = 0; heading.setAttribute('role','menuitem');
    heading.setAttribute('aria-label',T('返回强度滑杆')); heading.title = T('返回强度滑杆');
    heading.onclick = function () { setPickerView('intensity'); $('#bridge-model-select').focus({preventScroll:true}); };
    group.replaceChildren(heading);
    MODEL_META.forEach(function (m) {
      var row = modelRowTemplate.cloneNode(true), on = m.id === model.id;
      row.dataset.value = m.id; row.dataset.state = on?'checked':'unchecked'; row.setAttribute('aria-checked',String(on));
      row.querySelector('.truncate').textContent = modelName(m); row.title = TR(m.desc);
      row.querySelector('.trailing > span').hidden = !on;
      group.appendChild(row);
    });
    // Explicit model selections on the official site do not use its auto-router
    // Maximum flag. Keep the original maximum renderer available in the vendor.
    pickerOptions = model.efforts.map(function (id) { return {id:id,label:effortName(id),isLocked:false,isMaximumEffort:false}; });
    syncPickerDisplay();
  }
  var pillCtl = pill && pillPop ? menuController(pill, pillPop, {
    side:'top', align:'end',
    onOpen:function () { syncPickerDisplay(); $('#bridge-effort-range')?.focus({preventScroll:true}); },
    onClose:function () {
      var focusInside = pillPop.contains(document.activeElement);
      if (pickerPanel) setPickerView('intensity');
      if (focusInside) pill.focus({preventScroll:true});
    }
  }) : null;
  if (pillCtl) renderPicker();


  /* Codex usage: an outer context arc and an inner account-limit arc. */
  var contextUsage = null, accountUsage = null;
  var usageButton = document.createElement("button");
  usageButton.type = "button";
  usageButton.id = "codex-usage-button";
  usageButton.className = "codex-usage-button";
  usageButton.setAttribute("aria-label", T("查看 Codex 用量和上下文"));
  usageButton.setAttribute("aria-haspopup", "dialog");
  usageButton.setAttribute("aria-expanded", "false");
  var usagePop = document.createElement("div");
  usagePop.id = "codex-usage-pop";
  usagePop.className = "clone-menu codex-usage-pop";
  usagePop.innerHTML = '<section data-radix-menu-content role="dialog" aria-label="' + T("Codex 用量和上下文") + '" class="codex-usage-panel"></section>';
  document.body.appendChild(usagePop);
  var usageCtl = menuController(usageButton, usagePop, { side: "top", align: "start", onOpen: function () { sendBridge("usage-refresh"); } });
  function tokenLabel(n) {
    if (typeof n !== "number") return "—";
    return n >= 1000000 ? (n / 1000000).toFixed(2).replace(/\.?0+$/, "") + "M" : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
  }
  function windowLabel(n) {
    if (n === 10080) return T("每周额度");
    if (n && n % 60 === 0) return T("{n} 小时额度", { n: n / 60 });
    return n ? T("{n} 分钟额度", { n: n }) : T("用量窗口");
  }
  function resetLabel(seconds) {
    if (!seconds) return T("重置时间未提供");
    var mins = Math.ceil((seconds * 1000 - Date.now()) / 60000);
    if (mins <= 0) return T("重置时间已到，等待更新");
    if (mins < 1440) return mins >= 60 ? T("{h} 小时 {m} 分钟后重置", { h: Math.floor(mins / 60), m: mins % 60 }) : T("{m} 分钟后重置", { m: mins % 60 });
    // 英文按 en-US 12 小时制、月份缩写（Sep 30, 3:00 PM）；中文保持原来的数字月日 + 24 小时
    var when = BRIDGE_LANG === "en"
      ? new Date(seconds * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : new Date(seconds * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return T("{time} 重置", { time: when });
  }
  function usageArc(radius, percent, cls) {
    return '<circle class="' + cls + (percent === null ? ' is-unknown' : '') + '" cx="14" cy="14" r="' + radius + '" pathLength="100" stroke-dasharray="' + (percent === null ? '3 5' : Math.max(0, Math.min(100, percent)) + ' 100') + '"/>';
  }
  function renderUsage() {
    if (!usageButton) return;
    var ctxPct = contextUsage && typeof contextUsage.usedPercent === "number" ? contextUsage.usedPercent : null;
    var buckets = accountUsage && Array.isArray(accountUsage.buckets) ? accountUsage.buckets : [];
    var codexBucket = buckets.filter(function (b) { return b.id === "codex"; })[0];
    var known = codexBucket ? codexBucket.windows.filter(function (w) { return typeof w.usedPercent === "number"; }) : [];
    var quotaPct = known.length ? Math.max.apply(null, known.map(function (w) { return w.usedPercent; })) : null;
    usageButton.classList.toggle("is-warning", Math.max(ctxPct || 0, quotaPct || 0) >= 80);
    usageButton.classList.toggle("is-critical", Math.max(ctxPct || 0, quotaPct || 0) >= 95);
    usageButton.innerHTML = '<svg viewBox="0 0 28 28" aria-hidden="true"><circle class="usage-track" cx="14" cy="14" r="11"/><circle class="usage-track" cx="14" cy="14" r="6.5"/>' + usageArc(11, ctxPct, 'usage-context') + usageArc(6.5, quotaPct, 'usage-quota') + '</svg>';
    usageButton.title = (ctxPct === null ? T("上下文尚未回传") : T("上下文约 {pct}%", { pct: Math.round(ctxPct) })) + (quotaPct === null ? "" : " · " + T("Codex 额度至少剩余 {pct}%", { pct: Math.round(100 - quotaPct) }));
    var context = contextUsage ? '<div class="codex-usage-heading"><span>' + T('上下文') + '</span><strong>' + (ctxPct === null ? T('容量未知') : T('{pct}% 已用', { pct: Math.round(ctxPct) })) + '</strong></div><div class="codex-usage-meter"><i style="width:' + (ctxPct || 0) + '%"></i></div><div class="codex-usage-meta"><span>' + tokenLabel(contextUsage.usedTokens) + ' / ' + tokenLabel(contextUsage.windowTokens) + ' tokens</span><span>' + T('输入 {tokens}', { tokens: tokenLabel(contextUsage.inputTokens) }) + '</span></div>' : '<div class="codex-usage-heading"><span>' + T('上下文') + '</span><strong>—</strong></div><p class="codex-usage-muted">' + T('发送消息后显示；旧对话将在下次调用后更新。') + '</p>';
    var limits = buckets.map(function (b) {
      return '<div class="codex-usage-bucket">' + (buckets.length > 1 || b.id !== 'codex' ? '<div class="codex-usage-bucket-name">' + esc(b.name) + '</div>' : '') + b.windows.map(function (w) {
        var pct = typeof w.remainingPercent === 'number' ? w.remainingPercent : null;
        return '<div class="codex-usage-heading"><span>' + esc(windowLabel(w.durationMins)) + '</span><strong>' + (pct === null ? '—' : T('{pct}% 剩余', { pct: pct })) + '</strong></div><div class="codex-usage-meter quota"><i style="width:' + (pct || 0) + '%"></i></div><div class="codex-usage-meta">' + esc(resetLabel(w.resetsAt)) + '</div>';
      }).join('') + '</div>';
    }).join('');
    var updatedAt = accountUsage && accountUsage.updatedAt ? (BRIDGE_LANG === 'en'
      ? new Date(accountUsage.updatedAt).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'})
      : new Date(accountUsage.updatedAt).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'})) : '';
    usagePop.firstElementChild.innerHTML = '<header><b>Codex</b><span>' + T('用量与上下文') + '</span><button type="button" aria-label="' + T('关闭用量面板') + '">×</button></header><div class="codex-usage-section">' + context + '<p class="codex-usage-note">' + T('按最近一次模型调用的输入与输出估算；压缩后随下次调用更新。') + '</p></div><div class="codex-usage-section"><div class="codex-usage-section-title">' + T('账号额度') + '</div>' + (limits || '<p class="codex-usage-muted">' + (accountUsage ? T('暂时无法读取额度，稍后可重试。') : T('正在读取…')) + '</p>') + '<p class="codex-usage-note">' + T('Bridge 所连接的 Codex 账号共享额度。') + '</p></div><footer><span>' + (accountUsage && accountUsage.stale ? T('更新失败，显示上次数据') : accountUsage && accountUsage.updatedAt ? T('更新于 {time}', { time: updatedAt }) : T('尚无实时数据')) + '</span><button type="button" data-usage-refresh>' + T('刷新') + '</button></footer>';
    usagePop.querySelector('header button').onclick = function () { usageCtl.close(); usageButton.focus(); };
    usagePop.querySelector('[data-usage-refresh]').onclick = function () { sendBridge('usage-refresh'); };
    if (usagePop.classList.contains('clone-menu-open')) placePop(usagePop, usageButton.getBoundingClientRect(), 'top', 'start', 8);
  }
  renderUsage();

  /* ---- 会话态顶栏「新聊天」 ---- */
  var hnc = $("#header-new-chat");
  if (hnc) hnc.addEventListener("click", function (e) {
    e.preventDefault();
    var currentProject = bridge.projects.filter(function (p) { return p.id === bridge.projectId; })[0] || null;
    startProjectChat(currentProject);
  });

  /* ---- 横屏 rail（52px 图标列 ↔ 260px 常驻展开） ---- */
  var rail = $("#stage-slideover-sidebar");
  var applyRailLayout = function () {};
  if (rail) {
    var tiny = $("#stage-sidebar-tiny-bar");
    var railExp = $("#rail-expanded");
    var railLogo = $("#rail-logo-button");
    var railWpx = null;
    var railPinned = true;
    try { railPinned = localStorage.getItem('bridge-codex-sidebar-pinned') !== 'false'; } catch (e) {}
    function railOpenFn() {
      // 宽度用 px 值过渡：var→var 的 width transition 在部分内核里首次插值会假死
      if (railWpx === null) {
        var w = rail.getBoundingClientRect().width;
        railWpx = (w > 0 ? w : 52) + "px";
      }
      rail.setAttribute("data-state", "open");
      rail.style.width = (getComputedStyle(rail).getPropertyValue("--sidebar-width") || "260px").trim();
      tiny.classList.remove("opacity-100", "motion-safe:ease-[steps(1,start)]");
      tiny.classList.add("opacity-0", "pointer-events-none", "motion-safe:ease-[steps(1,end)]");
      railExp.classList.remove("opacity-0", "pointer-events-none");
      railExp.removeAttribute("inert");
      railLogo.setAttribute("aria-expanded", "true");
    }
    function railCloseFn() {
      rail.setAttribute("data-state", "closed");
      rail.style.width = railWpx || "var(--sidebar-rail-width)";
      tiny.classList.add("opacity-100", "motion-safe:ease-[steps(1,start)]");
      tiny.classList.remove("opacity-0", "pointer-events-none", "motion-safe:ease-[steps(1,end)]");
      railExp.classList.add("opacity-0", "pointer-events-none");
      railExp.setAttribute("inert", "");
      railLogo.setAttribute("aria-expanded", "false");
    }
    tiny.addEventListener("click", function (e) {
      var t = e.target.closest("a,button,[role='button']");
      if (t && t.getAttribute("data-testid") === "create-new-chat-button") { e.preventDefault(); startProjectChat(); return; }
      if (t && t.getAttribute("data-testid") === "accounts-profile-button") return;
      e.preventDefault();
      railPinned = true;
      try { localStorage.setItem('bridge-codex-sidebar-pinned', 'true'); } catch (err) {}
      railOpenFn();
    });
    $("#rail-close-button").addEventListener("click", function () {
      railPinned = false;
      try { localStorage.setItem('bridge-codex-sidebar-pinned', 'false'); } catch (e) {}
      railCloseFn();
    });
    applyRailLayout = function () {
      var tier = html.getAttribute('data-layout');
      var yielded = tier === 'medium' && html.getAttribute('data-dock-open') === 'true';
      if (tier === 'compact' || yielded || !railPinned) railCloseFn(); else railOpenFn();
      closeSidebar();
    };
    railExp.addEventListener("click", function (e) {
      var t = e.target.closest("a,button,[role='button']");
      if (!t || t.id === "rail-close-button") return;
      e.preventDefault();
      if (t.getAttribute("data-testid") === "create-new-chat-button" || t.getAttribute("aria-label") === T("新聊天")) { startProjectChat(); return; }
      if (t.getAttribute("data-testid") === "accounts-profile-button") return;
    });
  }

  /* ---- bridge sidebar：返回 / 新聊天 / 真实历史 / 账户 ---- */
  function directNavChild(nav, el) {
    var n = el;
    while (n && n.parentElement !== nav) n = n.parentElement;
    return n || el;
  }
  function pruneSidebar(root) {
    if (!root) return;
    var nav = root.querySelector("nav");
    var killTests = ["sidebar-item-recall", "sidebar-item-projects", "sidebar-item-tasks", "plugins-button", "apps-button"];
    killTests.forEach(function (id) {
      root.querySelectorAll('[data-testid="' + id + '"]').forEach(function (el) { el.remove(); });
    });
    var killText = /^(搜索|搜索聊天|文件库|库|项目|已安排|插件|应用|Codex|更多|升级)$/;
    root.querySelectorAll("a,button,[role='menuitem'],[data-sidebar-item]").forEach(function (el) {
      var t = el.textContent.replace(/Ctrl|Shift|⌘|⇧|K|O/g, "").replace(/\s+/g, " ").trim();
      if (!killText.test(t)) return;
      var target = el.closest("li") || el;
      if (nav && target.parentElement !== nav && !target.closest("ul")) target = directNavChild(nav, target);
      target.remove();
    });
    var fake = root.querySelector("#rail-history");
    if (fake && fake.parentElement) fake.parentElement.remove();
    var create = root.querySelector('[data-testid="create-new-chat-button"]');
    var list = create && create.closest("ul");
    if (list && !list.querySelector(".bridge-back-item")) {
      var li = document.createElement("li");
      li.className = "bridge-back-item list-none";
      li.innerHTML = '<button class="bridge-sidebar-item" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>' + T("返回 Bridge") + '</span></button>';
      li.querySelector("button").addEventListener("click", function () { sendBridge("back"); });
      list.insertBefore(li, list.firstChild);
    }
    if (nav && !nav.querySelector(".bridge-projects-section")) {
      var projectSection = document.createElement("div");
      projectSection.className = "bridge-projects-section";
      projectSection.innerHTML = '<div class="bridge-section-head"><h2>' + tc("chatgpt", "项目") + '</h2><button type="button" class="bridge-project-add" data-new-project aria-label="' + T("新项目") + '">+</button></div>' +
        '<div class="bridge-project-list"><div class="bridge-history-empty">' + T("还没有项目") + '</div></div>';
      var grow = Array.prototype.slice.call(nav.children).filter(function (x) { return x.classList.contains("grow"); })[0];
      nav.insertBefore(projectSection, grow || null);
    }
  }
  pruneSidebar($("#stage-popover-sidebar"));
  pruneSidebar($("#rail-expanded"));
  $$("#stage-sidebar-tiny-bar button").forEach(function (button) {
    var label = button.querySelector(".sr-only");
    if (label && label.textContent.trim() === "搜索") { // i18n-ignore 按官方中文原文裁掉（早于静态文案替换）
      (button.closest("[data-state='closed']") || button).remove();
    }
  });
  $$("main button").forEach(function (button) {
    if (/^(生成图片|撰写或编辑|查找资料)$/.test(button.textContent.trim())) button.remove();
  });

  function sessionRow(s, nested) {
    return '<div class="bridge-history-row' + (nested ? ' bridge-history-row-nested' : '') + '" data-session-id="' + escAttr(String(s.id || "")) + '"><span>' + esc(TR(s.title) || T("（无标题）")) + '</span><button aria-label="' + T("删除对话") + '" data-delete-session="' + escAttr(String(s.id || "")) + '">×</button></div>';
  }

  function renderSessions(sessions, projects) {
    bridge.sessions = Array.isArray(sessions) ? sessions : bridge.sessions;
    bridge.projects = Array.isArray(projects) ? projects : bridge.projects;
    var byProject = {};
    bridge.sessions.forEach(function (s) {
      var key = s.projectId || "";
      if (!byProject[key]) byProject[key] = [];
      byProject[key].push(s);
    });
    $$(".bridge-project-list").forEach(function (list) {
      if (!bridge.projects.length) { list.innerHTML = '<div class="bridge-history-empty">' + T("还没有项目") + '</div>'; return; }
      list.innerHTML = bridge.projects.map(function (p) {
        var active = bridge.projectId === p.id ? " is-active" : "";
        var children = (byProject[p.id] || []).map(function (s) { return sessionRow(s, true); }).join("");
        return '<div class="bridge-project-group' + active + '">' +
          '<button type="button" class="bridge-project-row" data-project-id="' + escAttr(p.id) + '" title="' + escAttr(p.path || "") + '">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>' +
          '<span>' + esc(p.name || T("未命名项目")) + '</span></button>' +
          (children ? '<div class="bridge-project-sessions">' + children + '</div>' : '') + '</div>';
      }).join("");
    });
  }

  document.addEventListener("click", function (e) {
    var add = e.target.closest("[data-new-project]");
    if (add) { e.preventDefault(); openProjectDialog(); return; }
    var del = e.target.closest("[data-delete-session]");
    if (del) { e.preventDefault(); e.stopPropagation(); sendBridge("delete-session", { id: del.getAttribute("data-delete-session") }); return; }
    var row = e.target.closest("[data-session-id]");
    if (row) { e.preventDefault(); closeSidebar(); sendBridge("open-session", { id: row.getAttribute("data-session-id") }); return; }
    var projectRow = e.target.closest("[data-project-id]");
    if (projectRow) {
      e.preventDefault();
      var project = bridge.projects.filter(function (p) { return p.id === projectRow.getAttribute("data-project-id"); })[0];
      if (project) { closeSidebar(); resetToHome(project); }
    }
  });

  function showSession(data) {
    stopStreaming();
    bridge.sessionId = data.id || null;
    contextUsage = data.contextUsage || null;
    renderUsage();
    bridge.projectId = data.projectId || null;
    bridge.projectName = data.projectName || ((bridge.projects.filter(function (p) { return p.id === bridge.projectId; })[0] || {}).name) || "";
    if (bridge.projectId) rememberProject(bridge.projectId);
    updateProjectContext();
    renderSessions(bridge.sessions, bridge.projects);
    messageImages = {};
    turnsBox.innerHTML = "";
    turnCount = 0;
    enterConvo();
    (data.messages || []).forEach(function (m) {
      if (m.role === "user") appendUserTurn(m.text || "", m.attachments || []);
      else {
        var sec = appendAssistantTurn();
        streamingTurn = sec;
        var md = liveMarkdown(sec);
        md.innerHTML = m.html || '<p>' + esc(m.text || "") + "</p>";
        renderAssistantAttachments(sec, m.attachments || []);
        finishTurn(sec, md, false, false, 0);
      }
    });
    requestAnimationFrame(function () { scrollRoot.scrollTop = scrollRoot.scrollHeight; });
  }

  /* ---- 本地项目：新建＝向宿主要选择器 + composer 当前项目提示 ---- */
  // 自建目录浏览弹窗已退役。「新项目」统一由 bridge 宿主接管：本机桌面壳直接唤起系统
  // 原生文件夹选择器，网页/手机走工作空间文件管理器 + 底部「拖入选为工作空间」栏。
  // 项目名固定取文件夹名（与 Claude 分页同规矩），所以这里不再有名称输入框。
  function openProjectDialog() { sendBridge("open-project-picker", {}); }
  function updateProjectContext() {
    if (foldStart) foldStart.querySelector('[data-fold-project]').textContent = bridge.projectName ? T('工作空间 · {name}', { name: bridge.projectName }) : T('选择工作空间，继续推进项目。');
    if (!projectContext) return;
    projectContext.classList.toggle("clone-hidden", !bridge.projectId);
    var label = projectContext.querySelector("span");
    if (label) label.textContent = bridge.projectName || T("项目");
    var project = bridge.projects.filter(function (p) { return p.id === bridge.projectId; })[0] || null;
    sendBridge("workspace-context", {
      projectId: bridge.projectId || null,
      projectName: bridge.projectName || (project && project.name) || "",
      path: project && project.path ? project.path : ""
    });
    projectContext.title = project && project.path ? project.path : (bridge.projectName || "");
    var mobileTitle = $("#chat-title-button > div");
    if (mobileTitle) {
      var mobileLabel = mobileTitle.querySelector(".bridge-mobile-project-name");
      if (!mobileLabel) {
        Array.from(mobileTitle.childNodes).forEach(function (node) {
          if (node.nodeType === Node.TEXT_NODE) node.remove();
        });
        mobileLabel = document.createElement("span");
        mobileLabel.className = "bridge-mobile-project-name";
        mobileTitle.insertBefore(mobileLabel, mobileTitle.firstChild);
      }
      mobileLabel.textContent = bridge.projectName || T("工作空间");
      var mobileTitleButton = mobileTitle.parentElement;
      mobileTitleButton.title = project && project.path ? project.path : (bridge.projectName || "");
      mobileTitleButton.setAttribute("aria-label", bridge.projectName || T("工作空间"));
      mobileTitleButton.removeAttribute("aria-haspopup");
      mobileTitleButton.removeAttribute("aria-expanded");
      mobileTitleButton.removeAttribute("data-state");
      mobileTitleButton.tabIndex = -1;
    }
  }

  /* ---- 附件：样板菜单选文件，宿主完成 bridge 鉴权上传 ---- */
  var attachmentBox = document.createElement("div");
  attachmentBox.className = "bridge-attachments clone-hidden";
  var composerSurface = editor.closest("[data-composer-surface]");
  if (composerSurface) composerSurface.classList.add("bridge-composer-surface");
  var composerLeading = $("[data-testid='composer-plus-btn']").closest("[class*='grid-area:leading']");
  if (composerLeading) composerLeading.classList.add("bridge-composer-leading");
  var composerControls = $("#composer-pill-box").parentElement;
  composerControls.classList.add("bridge-composer-controls");
  var composerHeader = document.createElement("div");
  composerHeader.className = "bridge-composer-header";
  var composerFooter = document.createElement("div");
  composerFooter.className = "bridge-composer-footer";
  var composerFooterLeft = document.createElement("div");
  composerFooterLeft.className = "bridge-composer-footer-left";
  var projectContext = document.createElement("div");
  projectContext.className = "bridge-project-context clone-hidden";
  projectContext.setAttribute("role", "status");
  projectContext.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg><span></span>';
  if (composerSurface) {
    composerSurface.insertBefore(composerHeader, composerSurface.firstChild);
    composerHeader.appendChild(attachmentBox);
    if (composerLeading) composerFooterLeft.appendChild(composerLeading);
    composerFooterLeft.appendChild(usageButton);
    composerFooterLeft.appendChild(projectContext);
    composerFooter.appendChild(composerFooterLeft);
    composerFooter.appendChild(composerControls);
    composerSurface.appendChild(composerFooter);
  }
  updateProjectContext();
  function renderAttachments() {
    var items = bridge.attachments.map(function (a, i) { return Object.assign({ _index: i }, a); })
      .concat((bridge.uploading || []).map(function (a) { return Object.assign({ uploading: true }, a); }));
    attachmentBox.classList.toggle("clone-hidden", !items.length);
    if (composerSurface) composerSurface.classList.toggle("bridge-composer-has-attachments", !!items.length);
    attachmentBox.innerHTML = items.map(function (a, i) {
      var previewAttr = a.uploading ? "" : ' data-preview-composer="' + a._index + '"';
      var progress = a.uploading ? '<span class="bridge-upload-progress"><i style="width:' + Math.max(4, Math.min(100, Number(a.progress) || 4)) + '%"></i></span>' : '';
      if (attachmentKind(a) === "image" && a.url) {
        return '<div class="bridge-composer-image' + (a.uploading ? ' is-uploading' : '') + '"><button type="button" class="bridge-composer-preview"' + previewAttr + dragAttr(a) + ' aria-label="' + escAttr(T("预览 {name}", { name: String(a.name) })) + '"><img src="' + escAttr(a.url) + '" alt=""></button>' +
          (a.uploading ? '<small>' + T('上传中 {pct}%', { pct: Number(a.progress) || 0 }) + '</small>' : '<button type="button" class="bridge-attachment-remove" data-remove-attachment="' + a._index + '" aria-label="' + T('移除') + '">×</button>') + progress + '</div>';
      }
      return '<div class="bridge-composer-file' + (a.uploading ? ' is-uploading' : '') + '"><button type="button" class="bridge-composer-file-main"' + previewAttr + dragAttr(a) + '>' + fileGlyph(attachmentKind(a)) +
        '<span><b>' + esc(a.name) + '</b><small>' + (a.uploading ? T('上传中 {pct}%', { pct: Number(a.progress) || 0 }) : esc(typeLabel(a))) + '</small></span></button>' +
        (a.uploading ? '' : '<button type="button" class="bridge-attachment-remove" data-remove-attachment="' + a._index + '" aria-label="' + T('移除') + '">×</button>') + progress + '</div>';
    }).join("");
  }
  attachmentBox.addEventListener("click", function (e) {
    var preview = e.target.closest("[data-preview-composer]");
    if (preview) {
      var index = Number(preview.getAttribute("data-preview-composer"));
      sendBridge("preview", { items: bridge.attachments, index: index, sessionId: bridge.sessionId });
      return;
    }
    var b = e.target.closest("[data-remove-attachment]"); if (!b) return;
    bridge.attachments.splice(Number(b.getAttribute("data-remove-attachment")), 1); renderAttachments();
    if (!bridge.attachments.length && !editorText()) setTrailing("idle");
  });
  attachmentBox.addEventListener("dragstart", function (e) {
    if (!bridge.dragOut) return;
    var target = e.target.closest("[data-preview-composer]");
    if (!target) return;
    var a = bridge.attachments[Number(target.getAttribute("data-preview-composer"))];
    if (!a) return;
    e.preventDefault();
    sendBridge("drag-out", dragOutPayload(a));
  });
  var fileInput = document.createElement("input");
  fileInput.type = "file"; fileInput.multiple = true; fileInput.hidden = true;
  document.body.appendChild(fileInput);
  fileInput.addEventListener("change", function () {
    var files = Array.prototype.slice.call(fileInput.files || []); fileInput.value = "";
    if (!files.length) return;
    bridge.uploading = files.map(function (f) {
      var kind = attachmentKind({ name: f.name, kind: f.type.indexOf("image/") === 0 ? "image" : "" });
      return { name: f.name, kind: kind, mime: f.type || "", size: f.size || 0, progress: 0, url: kind === "image" ? URL.createObjectURL(f) : "" };
    }); renderAttachments();
    sendBridge("upload", { files: files });
  });
  $$('#menu-plus-pop [role="menuitem"], #menu-plus-pop [role="menuitemradio"]').forEach(function (item) {
    if (!/^(相机|照片|文件)$/.test(item.textContent.trim())) item.remove();
  });
  Array.prototype.slice.call(document.querySelectorAll('#menu-plus-pop [role="group"]')).reverse().forEach(function (group) {
    if (!group.querySelector('[role="menuitem"], [role="menuitemradio"]')) group.remove();
  });
  $$('#menu-plus-pop [role="menuitem"]').filter(function (x) { return /^(相机|照片|文件)$/.test(x.textContent.trim()); }).forEach(function (item) {
    // 绑定时按官方中文原文认入口：英文界面稍后会把菜单文字换成 Camera / Photos / Files
    var kind = item.textContent.trim();
    item.addEventListener("click", function () {
      fileInput.accept = kind === "文件" ? "" : "image/*"; // i18n-ignore 比对官方中文原文
      if (kind === "相机") fileInput.setAttribute("capture", "environment"); else fileInput.removeAttribute("capture"); // i18n-ignore 同上
      fileInput.click();
    });
  });

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.channel !== "bridge-chatgpt") return;
    if (d.type === "init") {
      bridge.dragOut = !!d.dragOut;
      applyCapabilities(d.codex);
      applySafeInsets(d);
      setTheme(d.theme === "light" ? "light" : "dark", false);
      if (d.user) $$('[data-testid="accounts-profile-button"]').forEach(function (p) {
        var leaf = Array.prototype.slice.call(p.querySelectorAll("*")).filter(function (x) { return x.children.length === 0 && x.textContent.trim() === "火乐"; })[0]; // i18n-ignore 样板里的占位用户名，换成真实账户名
        if (leaf) leaf.textContent = d.user;
      });
    } else if (d.type === "capabilities") applyCapabilities(d.codex);
    else if (d.type === "usage") { accountUsage = d.usage || null; renderUsage(); }
    else if (d.type === "layout") {
      if (['compact', 'medium', 'expanded'].indexOf(d.tier) >= 0) html.setAttribute('data-layout', d.tier);
      html.setAttribute('data-dock-open', d.dockOpen ? 'true' : 'false');
      applyRailLayout();
    }
    else if (d.type === "safe-insets") applySafeInsets(d);
    else if (d.type === "theme") setTheme(d.theme === "light" ? "light" : "dark", false);
    else if (d.type === "workspace-state") {
      workspaceButtons.forEach(function (button) {
        button.classList.toggle("is-open", !!d.open);
        button.setAttribute("aria-pressed", d.open ? "true" : "false");
        button.setAttribute("aria-label", d.open ? T("关闭项目工作区") : T("打开项目工作区"));
      });
    }
    else if (d.type === "image-resolved") {
      var requestId = String(d.requestId || "");
      if (!/^bridge-message-image-\d+$/.test(requestId)) return;
      var image = document.querySelector('img[data-bridge-image-id="' + requestId + '"]');
      if (!image) return;
      image.removeAttribute("data-bridge-image-pending");
      if (d.url) image.src = d.url;
    }
    else if (d.type === "sessions") {
      renderSessions(d.sessions || [], d.projects || []);
      if (!bridge.sessionId && !bridge.projectId && bridge.projects.length) {
        var preferred = preferredProject();
        if (preferred) startProjectChat(preferred);
        else updateProjectContext();
      }
    }
    else if (d.type === "session") showSession(d);
    else if (d.type === "session-error") window.alert(d.message || T("无法打开对话"));
    else if (d.type === "project-created") {
      if (d.project) {
        var existing = bridge.projects.filter(function (p) { return p.id !== d.project.id; });
        bridge.projects = [d.project].concat(existing);
        resetToHome(d.project);
      }
    }
    else if (d.type === "event") handleBridgeEvent(d.event);
    else if (d.type === "uploaded") {
      (bridge.uploading || []).forEach(function (a) { if (a.url && a.url.indexOf("blob:") === 0) URL.revokeObjectURL(a.url); });
      bridge.uploading = [];
      bridge.attachments = bridge.attachments.concat(d.attachments || []);
      renderAttachments();
      if (bridge.attachments.length) setTrailing("typed");
    } else if (d.type === "upload-progress") {
      var pending = (bridge.uploading || []).filter(function (a) { return a.name === d.name; })[0];
      if (pending) pending.progress = Math.round(Number(d.progress) || 0);
      renderAttachments();
    } else if (d.type === "upload-error") {
      bridge.uploading = (bridge.uploading || []).filter(function (a) {
        if (a.name !== d.name) return true;
        if (a.url && a.url.indexOf("blob:") === 0) URL.revokeObjectURL(a.url);
        return false;
      });
      renderAttachments();
    }
  });

  /* header no-op buttons stay inert but clickable look */
  $$("#home-header-actions button, #convo-header-actions button, .button-glimmer-cta").forEach(function (b) {
    b.addEventListener("click", function (e) { e.preventDefault(); });
  });
  applyStaticI18n();
  sendBridge("ready");
})();
