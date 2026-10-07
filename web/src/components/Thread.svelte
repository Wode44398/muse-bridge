<script>
  import { tick } from 'svelte';
  import { chat, answerQuestion, send, rewindToMessage, attImgFallback, openSession } from '../lib/chat.svelte.js';
  import { IS_CSNAP } from '../lib/csnap.js';
  import { session, prefs } from '../lib/state.svelte.js';
  import { renderMarkdown, streamBlocks } from '../lib/md.js';
  import { claudeFade } from '../lib/claudeFade.js';
  import { fmtElapsed, fmtTokens } from '../lib/format.js';
  import { fade } from 'svelte/transition';
  import ClaudeLogo from './ClaudeLogo.svelte';
  import ClaudeWorkingMark from './ClaudeWorkingMark.svelte';
  import ClaudeSpriteMark from './ClaudeSpriteMark.svelte';
  import { markActivity, spritePhase } from '../lib/workingMark.js';
  import ImgLightbox from './ImgLightbox.svelte';
  // 工具调用分组（含 Agent 行 / Workflow 卡，点开 TaskSheet）与模型切换/安全栅门卡——
  // 官方 /code 页同款，见 impl-contract §5（组件目录 claude/）。
  import ToolGroup from './claude/ToolGroup.svelte';
  import ModelNotice from './claude/ModelNotice.svelte';
  import { openPreview } from '../lib/preview.svelte.js';
  import { saveToDisk } from '../lib/save.js';
  import { onMdClick } from '../lib/linkNav.js';
  import { openDockFiles, openDock } from '../lib/dock.svelte.js';
  import { taskNoun } from '../lib/taskModel.js';
  import { t, tc, tr } from '../lib/i18n.js';

  const hasText = (m) => m.segments.some((s) => s.kind === 'text' && s.md.trim());
  // 运行标记三套（设置 → 思考动画）：默认新版 Claude Code 活动标记（ClaudeWorkingMark，按 markActivity
  // 演思考/搜索/读/跑命令/写/写文档/等人）；「新版聊天页」= ClaudeSpriteMark（spritePhase：星形→节点→等人方块）；
  // 选「经典」则沿用下面这套 claude.ai 星标五态。收轮后都回静态星标。
  // 菊花运行态 → claude.ai 同款动画映射（相位由 chat 内核按事件流维护，见 PHASE）：
  // thinking 推理脉动 / writing 吐字 / orbiting 工具·长后台任务 / shimmer 起步过渡 /
  // waiting 等用户回答·长静默（idle 由计时器判，AskUserQuestion 待答期恒 waiting）。
  const starState = (m) => {
    if (m.status !== 'streaming') return 'static';
    if (m.idle || m.segments.some((s) => s.kind === 'ask' && !s.answered)) return 'waiting';
    const p = m.phase;
    if (p === 'tool') return 'orbiting';
    if (p === 'thinking' || p === 'writing' || p === 'shimmer' || p === 'waiting') return p;
    return hasText(m) ? 'writing' : 'thinking';   // 无相位（同步重建的中途轮）回落旧判据
  };

  // 挂起提示文案（菊花右侧那一段）：种类一致就点名种类（「等待后台命令…」比「等待后台任务…」
  // 更能说明它在等什么），混合种类回落通称。count=0 = 任务刚跑完、正在等模型续轮。
  // 整句带数量（英文要单复数、语序也不同）：种类 → 「{n} 个X运行中」整句模板。
  const HOLD_TEXT = {
    shell: (n) => t('{n} 个后台命令运行中', { n }),
    agent: (n) => t('{n} 个子 agent运行中', { n }),
    workflow: (n) => t('{n} 个工作流运行中', { n }),
    monitor: (n) => t('{n} 个监视任务运行中', { n }),
    task: (n) => t('{n} 个后台任务运行中', { n }),
  };
  // 状态行第三段「正在干啥」（chat 内核 computeHint 给出 {k,…}）——措辞照官方 /code 页 working line。
  const THINK_TEXT = [() => t('思考中…'), () => t('仍在思考…'), () => t('深入思考中…'), () => t('还在深入思考…'), () => t('快想好了…')];
  const RETRY_KIND = { rate_limit: () => t('触发限流'), overloaded: () => t('服务过载'), server_error: () => t('服务端出错') };
  function hintText(h) {
    switch (h.k) {
      case 'think': return (THINK_TEXT[h.n] || THINK_TEXT[0])();
      case 'thought': return t('已思考 {n} 秒', { n: h.n });
      case 'sending': return t('发送中…');
      case 'starting': return t('启动会话中…');
      case 'preparing': return t('准备中…');
      case 'model': return t('等待 Claude…');
      case 'tools': return t('运行工具中…');
      case 'compact': return t('压缩会话中…');
      case 'ask': return t('等待你的回答…');
      case 'retry': {
        const why = RETRY_KIND[h.kind] ? RETRY_KIND[h.kind]() : t('接口出错');
        return why + ' · ' + t('重试中（{a}/{m}）', { a: h.attempt, m: h.max });
      }
    }
    return '';
  }

  function bgHoldText(h) {
    if (!h || !h.count) return t('后台任务收尾中');
    const kinds = new Set((h.tasks || []).map((tk) => taskNoun(tk.taskType)));
    const fmt = kinds.size === 1 ? (HOLD_TEXT[[...kinds][0]] || HOLD_TEXT.task) : HOLD_TEXT.task;
    return fmt(h.count);
  }

  // —— 尾部窗口：切进会话先只渲染最后 ~20 条，其余点「查看更早」展开 ——
  // 长会话一次性全量 markdown 渲染是「点开历史卡半天」的大头；聊天从底部看起，
  // 尾窗首屏即出。数组整体替换（切会话/新会话）时重置窗口；流式 push 不动窗口。
  const WIN = 20;
  let winStart = $state(Math.max(0, chat.messages.length - WIN));
  let lastArr = chat.messages;
  $effect(() => {
    const arr = chat.messages;                    // 依赖数组引用：仅整组替换时触发
    if (arr !== lastArr) { lastArr = arr; winStart = Math.max(0, arr.length - WIN); }
  });
  // —— 屏幕外轮次跳过渲染的开关（配合 <style> 里的 :global(.skip)）——
  // 【2026-09-11 修「聊着聊着视口忽然跳到会话顶部/靠上位置」】class:skip 直接翻类时，
  // Chromium 给一个【正在渲染】的元素加上 content-visibility:auto 的那一帧会先按占位高度
  // 把它锁住（contain-intrinsic-size:auto 此刻还没有「上次记住的尺寸」→ 回落 220px），下一帧
  // 交叉检测到它在视口里才重新展开。新一轮开始时倒数第三条恰好是刚写完、常常还在屏上的
  // 长回答：这一帧滚动容器整体缩短几千像素、scrollTop 被夹到新的底，再展开时滚动锚定
  // 不回补——视口就停在会话靠上位置（短会话直接停在顶部），而 atBottom 已被判 false，
  // 流式期间再也不跟滚。无头 Edge 逐帧实测：不修＝离底 6000px 且一直不动；修后恒在底。
  // 解法：加 skip 之前先把当前真实内容高度写进 --cis，占位高度＝真实高度，缩不了。
  // 首次挂载（切会话/「查看更早」新建的元素）不量——量意味着先全量布局一遍，正是
  // skip 要省的开销；它们用 220px 回落值，expandEarlier 按 scrollHeight 差值补偿视口。
  function skipWhen(el, on) {
    let cur = false;
    const apply = (v, mounted) => {
      v = !!v;
      if (v === cur) return;
      if (v && mounted) {
        const cs = getComputedStyle(el);
        const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
        const h = el.getBoundingClientRect().height - (Number.isFinite(pad) ? pad : 0);
        if (h > 0) el.style.setProperty('--cis', Math.round(h) + 'px');
      }
      el.classList.toggle('skip', v);
      cur = v;
    };
    apply(on, false);
    return { update: (v) => apply(v, true) };
  }
  async function expandEarlier(e) {
    const sc = e.currentTarget.closest('.scroll');
    const h0 = sc ? sc.scrollHeight : 0, t0 = sc ? sc.scrollTop : 0;
    winStart = Math.max(0, winStart - 60);
    await tick();
    if (sc) sc.scrollTop = t0 + (sc.scrollHeight - h0);   // 视口锚定：展开不跳动
  }

  function toggleOpt(it, label) {
    if (it.multi) it.selected = it.selected.includes(label) ? it.selected.filter((o) => o !== label) : [...it.selected, label];
    else it.selected = [label];
  }
  const answered = (q) => q.items.every((it) => it.selected.length > 0 || it.custom.trim());

  // —— 消息操作排（复制 / 重试）。图标与规格来自设计稿 claude.ai 克隆（chat.html ACT_BTNS）。
  const msgText = (m) => m.segments.filter((s) => s.kind === 'text' && s.md.trim()).map((s) => s.md).join('\n\n');
  async function copyMsg(m) {
    const txt = msgText(m);
    if (!txt) return;
    try { await navigator.clipboard.writeText(txt); }
    catch {  // WebView/旧浏览器兜底
      const ta = document.createElement('textarea');
      ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    m.copied = true;
    setTimeout(() => (m.copied = false), 1400);
  }
  // 重试 = 重发该回复对应的上一条用户消息（resume 续聊，作为新一轮追加）。
  // 显式传原轮附件——不消费、不清空 composer 里暂存的新附件；即时失败轮保留的上传
  // path 会原样重发，历史记录里只有展示 URL、无授权 path 的旧附件则安全跳过。
  function retryFrom(i) {
    if (session.busy) return;
    for (let j = i - 1; j >= 0; j--) {
      if (chat.messages[j].role === 'user') {
        const u = chat.messages[j];
        send(u.text, (u.attachments || []).filter((a) => a.path));
        return;
      }
    }
  }

  // —— 助手交付的产物附件卡：claude.ai 官网 100% 同款（2026-07-17 连 Edge 真站逐值逆向）——
  //    结构：整卡 hover 浮起 mini 文档页（-0.1rad→-0.065rad + scale1.035, 400ms 弹簧）+
  //    类型图标 + 「无扩展名标题 / TypeLabel · EXT」+ cds Download 按钮（按压 squish 弹簧回弹）。
  //    点卡=统一沉浸预览、点 Download=下载；文件夹（bridge 特有）整卡即 zip 下载。
  //    图标=Phosphor（claude.ai 同款，MIT），按扩展名细分；label 用官网英文词。
  // 图标（Phosphor/MIT，claude.ai 同款 20px · viewBox 256 · text-muted 灰）：
  // file=素文件 fileText=文档两横线 table=表格 code=尖括号 image=图片 pres=演示板 folder=文件夹
  const ATT_ICON = {
    file: 'M212.24,83.76l-56-56A6,6,0,0,0,152,26H56A14,14,0,0,0,42,40V216a14,14,0,0,0,14,14H200a14,14,0,0,0,14-14V88A6,6,0,0,0,212.24,83.76ZM158,46.48,193.52,82H158ZM200,218H56a2,2,0,0,1-2-2V40a2,2,0,0,1,2-2h90V88a6,6,0,0,0,6,6h50V216A2,2,0,0,1,200,218Z',
    fileText: 'M212.24,83.76l-56-56A6,6,0,0,0,152,26H56A14,14,0,0,0,42,40V216a14,14,0,0,0,14,14H200a14,14,0,0,0,14-14V88A6,6,0,0,0,212.24,83.76ZM158,46.48,193.52,82H158ZM200,218H56a2,2,0,0,1-2-2V40a2,2,0,0,1,2-2h90V88a6,6,0,0,0,6,6h50V216A2,2,0,0,1,200,218Zm-34-82a6,6,0,0,1-6,6H96a6,6,0,0,1,0-12h64A6,6,0,0,1,166,136Zm0,32a6,6,0,0,1-6,6H96a6,6,0,0,1,0-12h64A6,6,0,0,1,166,168Z',
    table: 'M224,50H32a6,6,0,0,0-6,6V192a14,14,0,0,0,14,14H216a14,14,0,0,0,14-14V56A6,6,0,0,0,224,50ZM38,110H82v36H38Zm56,0H218v36H94ZM218,62V98H38V62ZM38,192V158H82v36H40A2,2,0,0,1,38,192Zm178,2H94V158H218v34A2,2,0,0,1,216,194Z',
    code: 'M67.84,92.61,25.37,128l42.47,35.39a6,6,0,1,1-7.68,9.22l-48-40a6,6,0,0,1,0-9.22l48-40a6,6,0,0,1,7.68,9.22Zm176,30.78-48-40a6,6,0,1,0-7.68,9.22L230.63,128l-42.47,35.39a6,6,0,1,0,7.68,9.22l48-40a6,6,0,0,0,0-9.22Zm-81.79-89A6,6,0,0,0,154.36,38l-64,176A6,6,0,0,0,94,221.64a6.15,6.15,0,0,0,2,.36,6,6,0,0,0,5.64-3.95l64-176A6,6,0,0,0,162.05,34.36Z',
    image: 'M216,42H40A14,14,0,0,0,26,56V200a14,14,0,0,0,14,14H216a14,14,0,0,0,14-14V56A14,14,0,0,0,216,42ZM40,54H216a2,2,0,0,1,2,2V163.57L188.53,134.1a14,14,0,0,0-19.8,0l-21.42,21.42L101.9,110.1a14,14,0,0,0-19.8,0L38,154.2V56A2,2,0,0,1,40,54ZM38,200V171.17l52.58-52.58a2,2,0,0,1,2.84,0L176.83,202H40A2,2,0,0,1,38,200Zm178,2H193.8l-38-38,21.41-21.42a2,2,0,0,1,2.83,0l38,38V200A2,2,0,0,1,216,202ZM146,100a10,10,0,1,1,10,10A10,10,0,0,1,146,100Z',
    pres: 'M184,74H40A14,14,0,0,0,26,88V200a14,14,0,0,0,14,14H184a14,14,0,0,0,14-14V88A14,14,0,0,0,184,74Zm2,126a2,2,0,0,1-2,2H40a2,2,0,0,1-2-2V88a2,2,0,0,1,2-2H184a2,2,0,0,1,2,2ZM230,56V176a6,6,0,0,1-12,0V56a2,2,0,0,0-2-2H64a6,6,0,0,1,0-12H216A14,14,0,0,1,230,56Z',
    folder: 'M216,70H130.67L102.93,49.2A14.1,14.1,0,0,0,94.53,46.4H40A14,14,0,0,0,26,60.4V200a14,14,0,0,0,14,14H216.89A13.12,13.12,0,0,0,230,200.89V84A14,14,0,0,0,216,70Zm2,130.89a1.11,1.11,0,0,1-1.11,1.11H40a2,2,0,0,1-2-2V60.4a2,2,0,0,1,2-2H94.53a2,2,0,0,1,1.2.4l29.34,22a6,6,0,0,0,3.6,1.2H216a2,2,0,0,1,2,2Z',
  };
  // 官方逐类映射（2026-07-17 真站 11 类样本原样）：Document=md/pdf/doc/docx、Table=csv/tsv、
  // Spreadsheet=xls/xlsx、Code=json/html/htm、Image=图片、Presentation=ppt/pptx；
  // txt/py/zip 等官方就是【裸扩展名 + 素文件图标】——未映射类型一律走这个官方兜底。
  const ATT_TYPE = {
    md: ['Document', 'fileText'], markdown: ['Document', 'fileText'], mdown: ['Document', 'fileText'], mkd: ['Document', 'fileText'],
    pdf: ['Document', 'fileText'], doc: ['Document', 'fileText'], docx: ['Document', 'fileText'],
    csv: ['Table', 'table'], tsv: ['Table', 'table'],
    xls: ['Spreadsheet', 'table'], xlsx: ['Spreadsheet', 'table'],
    json: ['Code', 'code'], html: ['Code', 'code'], htm: ['Code', 'code'],
    png: ['Image', 'image'], jpg: ['Image', 'image'], jpeg: ['Image', 'image'], gif: ['Image', 'image'], webp: ['Image', 'image'], bmp: ['Image', 'image'], avif: ['Image', 'image'], heic: ['Image', 'image'], svg: ['Image', 'image'],
    ppt: ['Presentation', 'pres'], pptx: ['Presentation', 'pres'],
  };
  const attExt = (a) => (a.name.match(/\.([^.\s]{1,8})$/) || [])[1]?.toLowerCase() || '';
  const attType = (a) => (a.kind === 'folder' ? ['Folder', 'folder'] : (ATT_TYPE[attExt(a)] || ['', 'file']));
  const attIcon = (a) => ATT_ICON[attType(a)[1]];
  const attTitle = (a) => (a.kind === 'folder' ? a.name : a.name.replace(/\.[^.\s]{1,8}$/, ''));
  function attSub(a) {
    // 空文件夹：能在工作空间里打开就不再标 ZIP（那是回落下载态才对得上的词）
    if (a.kind === 'folder') return { label: 'Folder', ext: a.count ? a.count + ' items' : (canOpenFolder(a) ? '' : 'ZIP') };
    return { label: attType(a)[0], ext: attExt(a).toUpperCase() };
  }
  // 文件产物：有工作台定位（nav={ws,rel,open}）→ 右侧工作区打开（文件页落到父目录并
  // 自动弹出该文件的面板内预览）；算不出定位（无 shell 又在根外）→ 回落全屏沉浸查看器。
  const openAtt = (a) => (a.nav && a.nav.open ? openDockFiles(a.nav) : openPreview({ origin: 'claude', id: a.sessionId, path: a.path, name: a.name }));
  // 文件夹产物：点卡＝在右侧工作台的【工作空间视图】里打开这个目录（里面的文件逐个点开就能读），
  // 而不是整包 zip 下载——下载还在卡右边那颗按钮上。服务端算不出定位（无 shell 又在文件根外）
  // 时 nav 为空，回落成老行为（整卡即下载）。
  const canOpenFolder = (a) => a.kind === 'folder' && !!a.nav;
  const openAttFolder = (a) => openDockFiles(a.nav);
  const dlLabel = 'Download';

  // —— 正文链接分流：模型写的产物链接多是裸文件路径，浏览器会按相对 URL
  //    整页跳走。委托拦截：能对上附件卡的 → 应用内预览（文件夹=zip
  //    另存）；对不上但形如路径的 → 借会话 id 尝试 artifact 预览（服务端会再授权校验）。
  function resolveAnswerLink(m, raw) {
    let lk = raw;
    try { lk = decodeURIComponent(raw); } catch {}
    if (/^https?:\/\//i.test(lk)) {
      try { lk = new URL(lk).searchParams.get('path') || lk; } catch {}
    }
    // 兜底两种模型常写、却不是路径本身的包装：CommonMark 尖括号定界 <…>、file:/// 协议头。
    lk = lk.trim().replace(/^<([^<>]*)>$/, '$1').trim();
    if (/^file:/i.test(lk)) lk = lk.replace(/^file:\/*(?:localhost\/)?/i, '').replace(/^(?![a-z]:)/i, '/');
    const norm = (s) => String(s).replace(/[\\/]+/g, '/').replace(/^\.\//, '').toLowerCase();
    const nt = norm(lk);
    const atts = m.attachments || [];
    const hit = atts.find((x) => x.path && norm(x.path) === nt)
      || atts.find((x) => x.path && (norm(x.path).endsWith('/' + nt) || nt.endsWith('/' + norm(x.path))))
      || atts.find((x) => x.name && nt.split('/').pop() === norm(x.name));
    if (hit) {
      if (canOpenFolder(hit)) openAttFolder(hit);
      else if (hit.kind === 'folder') saveToDisk({ url: hit.downloadUrl, name: hit.name + '.zip' }).catch(() => {});
      else openAtt(hit);
      return true;
    }
    const sid = atts[0]?.sessionId || session.id || '';
    if (sid && nt && nt !== '#') { openPreview({ origin: 'claude', id: sid, path: lk }); return true; }
    return false;
  }

  // —— 检查点回滚（用户气泡上的 ↺）：点开就地二段确认，选「文件+对话 / 仅文件」——
  // 只有带 transcript uuid 锚点的气泡才有入口（live 轮由 anchor 事件补挂，历史由
  // /api/session 直接带）；快照访客无此入口。conv 成功时气泡连同其后内容整段消失，
  // 仅文件 / 软失败就地给一行结果反馈。
  async function doRewind(m, mode) {
    m.__rw = 'busy';
    try {
      const r = await rewindToMessage(m, mode);
      m.__rw = 'done';
      m.__rwMsg = (r && r.note) ? tr(r.note) : (r && r.files && r.files.ok ? t('已回滚 {n} 个文件', { n: r.files.changed }) : t('已回滚'));
      setTimeout(() => { if (m.__rw === 'done') m.__rw = null; }, 4000);
    } catch (e) {
      m.__rw = 'err';
      m.__rwMsg = tr((e?.body && typeof e.body === 'object' && (e.body.error || e.body.message)) || e?.message || '') || t('回滚失败');
      setTimeout(() => { if (m.__rw === 'err') m.__rw = null; }, 6000);
    }
  }

  // —— 用户消息里的图片附件 → 点开全屏灯箱（只在图片之间翻页，跳过文件附件）——
  let lb = $state({ open: false, items: [], index: 0 });
  function openImage(atts, clickedIdx) {
    const imgs = (atts || []).filter((a) => a.kind === 'image' && a.url);
    if (!imgs.length) return;
    const start = Math.max(0, imgs.indexOf((atts || [])[clickedIdx]));
    lb = { open: true, items: imgs, index: start };
  }
  function closeLb() { lb = { open: false, items: [], index: 0 }; }
</script>

<div class="thread">
  {#if winStart > 0}
    <button class="earlier" onclick={expandEarlier}>{t('查看更早的 {n} 条消息', { n: winStart })}</button>
  {/if}
  {#each chat.messages.slice(winStart) as m, wi (winStart + wi)}
    {@const i = winStart + wi}
    {@const skippable = wi < chat.messages.length - winStart - 2 && m.status !== 'streaming'}
    {#if m.role === 'user'}
      <div class="turn-user" use:skipWhen={skippable}>
        <div class="u-col">
          {#if m.attachments && m.attachments.length}
            {@const imgCount = m.attachments.filter((x) => x.kind === 'image' && x.url).length}
            <div class="u-atts">
              {#each m.attachments as a, ai}
                {#if a.kind === 'image' && a.url}
                  <!-- 气泡里挂缩略图（a.thumb），原图只在点开灯箱时才拉；直播刚发出的那条
                       没有 thumb（用的是本地 blob:），回落 a.url 不受影响。 -->
                  <button class="u-att u-img" class:single={imgCount === 1} aria-label={t('预览图片')} onclick={() => openImage(m.attachments, ai)}>
                    <img src={a.thumb || a.url} alt={a.name} loading="lazy" decoding="async" onerror={(e) => attImgFallback(e.currentTarget, a)} />
                  </button>
                {:else if a.kind === 'chat'}
                  <!-- 引用对话（侧栏拖进来的另一条会话）：点卡＝打开被引的那段对话；快照访客只看 -->
                  <button class="u-att u-file u-chat" disabled={IS_CSNAP || !a.quoteId} title={t('打开被引用的对话')} onclick={() => openSession(a.quoteId)}>
                    <span class="u-file-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12.2c0 3.9-3.6 7-8 7-1.1 0-2.2-.2-3.1-.6L4.5 20l1.2-3.5C4.6 15.3 4 13.8 4 12.2c0-3.9 3.6-7 8-7s8 3.1 8 7z"/><path d="M8.6 11h6.8M8.6 14h4.2"/></svg></span>
                    <span class="u-chat-col">
                      <span class="u-file-name">{a.name}</span>
                      <span class="u-chat-sub">{t('引用的对话')}</span>
                    </span>
                  </button>
                {:else}
                  <div class="u-att u-file">
                    <span class="u-file-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/></svg></span>
                    <span class="u-file-name">{a.name}</span>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
          {#if m.text}<div class="bubble sel-text">{m.text}</div>{/if}
          {#if m.uuid && !IS_CSNAP}
            <div class="u-acts">
              {#if m.__rw === 'confirm'}
                <span class="rw-ask">{t('回滚到这条消息之前：')}</span>
                <button class="rw-btn primary" onclick={() => doRewind(m, 'both')}>{tc('claude', '文件+对话')}</button>
                <button class="rw-btn" onclick={() => doRewind(m, 'files')}>{tc('claude', '仅文件')}</button>
                <button class="rw-btn" onclick={() => (m.__rw = null)}>{t('取消')}</button>
              {:else if m.__rw === 'busy'}
                <span class="rw-note">{t('回滚中…')}</span>
              {:else if m.__rw === 'done' || m.__rw === 'err'}
                <span class="rw-note" class:err={m.__rw === 'err'}>{m.__rwMsg}</span>
              {:else}
                <button class="act rw-ico" aria-label={t('回滚到这条消息之前')} disabled={session.busy} onclick={() => (m.__rw = 'confirm')}>
                  <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>
                </button>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {:else}
      <div class="turn-assistant" use:skipWhen={skippable}>
        {#if m.thinking.trim()}
          <button class="think {m.thinkingOpen ? 'open' : ''}" onclick={() => (m.thinkingOpen = !m.thinkingOpen)}>
            <span class="lbl">{m.status === 'streaming' ? 'Thinking' : tc('claude', '想法')}</span><span class="chev ic">&#xe0e2;</span>
          </button>
          {#if m.thinkingOpen}<div class="think-body sel-text">{m.thinking}</div>{/if}
        {/if}

        {#each m.segments as seg}
          {#if seg.kind === 'text'}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            {#if seg.md.trim()}<div class="answer sel-text" use:claudeFade={{ md: seg.md, live: m.status === 'streaming' }} onclick={(e) => onMdClick(e, (raw) => resolveAnswerLink(m, raw))}>{#each streamBlocks(seg, seg.md) as blk}{@html renderMarkdown(blk)}{/each}</div>{/if}
          {:else if seg.kind === 'tools'}
            <!-- 工具调用分组：单个普通工具直接一行；多个/含 Agent·Workflow 折叠头 + 展开卡。
                 live 只在本轮流式中为真——组件据此决定流光/计时与「settled」汇总文案。 -->
            <ToolGroup {seg} {m} live={m.status === 'streaming'} onToggle={() => (seg.open = !seg.open)} />
          {:else if seg.kind === 'notice'}
            <!-- 模型切换 / 安全栅门通知卡（system/model_*）：直播与历史同一段模型 -->
            <ModelNotice {seg} />
          {:else if seg.kind === 'ask'}
            <!-- AskUserQuestion：未答=可交互选择；已答=只读块（高亮所选），常驻历史，重开也在 -->
            <div class="qcard ask-seg" class:answered={seg.answered}>
              {#each seg.items as it, qi}
                {#if it.question}<div class="qhead"><div class="qtext">{tr(it.question)}</div></div>{/if}
                {#each it.options as opt, oi}
                  <button class="qopt {it.selected.includes(opt.label) ? 'sel' : ''}" disabled={seg.answered} onclick={() => toggleOpt(it, opt.label)}>
                    <span class="qnum">{oi + 1}</span>
                    <span class="qlabel">{tr(opt.label)}{#if opt.description}<small class="qdesc">{tr(opt.description)}</small>{/if}</span>
                    {#if it.selected.includes(opt.label)}<span class="qcheck">✓</span>{/if}
                  </button>
                {/each}
                {#if !seg.answered}
                  <div class="qfoot"><input class="qelse" placeholder="Something else" bind:value={it.custom} /></div>
                {:else if it.custom}
                  <div class="qfoot"><span class="qcustom">✓ {it.custom}</span></div>
                {/if}
                {#if qi < seg.items.length - 1}<div class="qdiv"></div>{/if}
              {/each}
              {#if !seg.answered}
                {#if seg.submitError}<div class="qerror" role="status">{seg.submitError}</div>{/if}
                <div class="qactions">
                  <button class="qskip" onclick={() => answerQuestion(seg, { cancelled: true })}>Skip</button>
                  <button class="qsubmit" disabled={!answered(seg) || seg.submitting} onclick={() => answerQuestion(seg)}>{t('提交回答')}</button>
                </div>
              {:else if seg.cancelled}
                <div class="qskipped">{t('已跳过')}</div>
              {/if}
            </div>
          {/if}
        {/each}

        {#if m.attachments && m.attachments.length}
          <div class="a-atts">
            {#each m.attachments as a}
              {@const sub = attSub(a)}
              <div class="att-card">
                {#if canOpenFolder(a)}
                  <button class="att-hit" aria-label={t('在工作空间中打开 {name}', { name: a.name })} onclick={() => openAttFolder(a)}></button>
                {:else if a.kind === 'folder'}
                  <a class="att-hit" href={a.downloadUrl} download={a.name + '.zip'} aria-label={a.name}></a>
                {:else}
                  <button class="att-hit" aria-label={a.name} onclick={() => openAtt(a)}></button>
                {/if}
                <div class="att-cell">
                  <div class="att-well">
                    <div class="att-page">
                      <svg class="att-glyph" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d={attIcon(a)} /></svg>
                    </div>
                  </div>
                  <div class="att-texts">
                    <div class="att-name">{attTitle(a)}</div>
                    <!-- 官方规则：有类型词=「Label · EXT」；未映射类型只有裸 EXT -->
                    <div class="att-sub">{#if sub.label}{sub.label}{#if sub.ext}&nbsp;<span class="att-dot">·</span>&nbsp;{sub.ext}{/if}{:else}{sub.ext}{/if}</div>
                  </div>
                </div>
                <div class="att-ctrl">
                  <a class="att-dl" href={a.downloadUrl} download={a.kind === 'folder' ? a.name + '.zip' : a.name} aria-label="{dlLabel} {a.name}"><span class="att-dl-bg"></span>{dlLabel}</a>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if m.status === 'error'}
          <div class="err-box">{tr(m.error)}</div>
        {/if}

        {#if m.status !== 'streaming'}
          <div class="actions" in:fade={{ duration: 220 }}>
            {#if hasText(m)}
              <button class="act" aria-label={t('复制')} onclick={() => copyMsg(m)}>
                {#if m.copied}
                  <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>
                {:else}
                  <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
                {/if}
              </button>
            {/if}
            <button class="act" aria-label={tc('claude', '重试')} disabled={session.busy} onclick={() => retryFrom(i)}>
              <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>
            </button>
          </div>
        {/if}

        {#if i === chat.messages.length - 1}
          <div class="turn-foot">
            <span class="logo-fly" in:fade|global={{ duration: 260 }}>{#if m.status === 'streaming' && prefs.claudeMark === 'sprite'}<ClaudeSpriteMark phase={spritePhase(m)} box={26} />{:else if m.status === 'streaming' && prefs.claudeMark !== 'classic'}{@const ma = markActivity(m)}<ClaudeWorkingMark activity={ma.activity} state={ma.state} size={24} box={26} />{:else}<ClaudeLogo anim={starState(m)} size={26} interactive />{/if}</span>
            {#if m.status === 'streaming'}
              <!-- 官方 desktop 同款状态语法：时长 · tokens · 状态文字。悬停（等后台任务）拼第三段
                   作挂起提示——与真结束（无状态行）一眼可分；这一段可点，直开右侧工作台「任务」
                   面板看逐条详情（命令行/耗时/输出）。 -->
              <span class="meta">{chat.reconnecting ? t('重连中…') : fmtElapsed(m.elapsed) + ' · ' + fmtTokens(m.tokens) + ' tokens'}{#if m.hint && !chat.reconnecting}{' · '}<span class="hint" class:shimmer={m.hint.k !== 'thought'}>{hintText(m.hint)}</span>{/if}</span>
              {#if m.bgHold && !chat.reconnecting}
                <!-- 官方 /code 页同款：菊花右侧一颗蓝色任务芯片（「1 running task」），点开任务面板 -->
                <button class="bgchip" title={t('查看后台任务详情')} onclick={() => openDock('tasks')}>{bgHoldText(m.bgHold)}</button>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/each}
</div>

{#if lb.open}<ImgLightbox items={lb.items} index={lb.index} onClose={closeLb} onIndex={(n) => (lb.index = n)} />{/if}

<style>
  /* 顶部空出 悬浮按钮区（--sat + 10 顶距 + 44 按钮 + 8 间隙）——对话从按钮下方开始，
     滚动时内容滑到毛玻璃按钮底下透出。 */
  .thread { padding: calc(var(--sat) + 62px) 16px 24px; display: flex; flex-direction: column; max-width: 760px; margin: 0 auto; width: 100%; }
  /* 「查看更早」：居中细胶囊，原生 IM 的历史折叠惯例 */
  .earlier { align-self: center; margin: 2px 0 10px; padding: 7px 16px; border-radius: 15px;
    background: var(--hover); color: var(--muted); font-size: 13px; }
  .earlier:active { background: var(--hover-strong); color: var(--text); }
  .turn-user { display: flex; justify-content: flex-end; margin: 14px 0; }
  /* —— 屏幕外的轮次跳过渲染 ——
     长会话（点过「查看更早」后可能几百条）里每一轮都带 markdown、代码高亮、工具卡，
     全量参与布局与绘制是滚动掉帧的大头。content-visibility:auto 让浏览器对视口外的
     子树跳过 layout/paint/hit-test；contain-intrinsic-size 的 auto 关键字让它【记住上次
     渲染的真实高度】，滚回去不会因为占位高度不准而跳动（写死数值才会跳）。
     纪律：只给「已完成 且 不是最近两条」的轮次上——正在流式吐字的那条若被跳过，
     自动滚到底会读到过期高度；最后两条恒在视口附近，跳过没有收益只有风险。
     选中文本跨越被跳过的子树时浏览器会自动强制渲染，复制不受影响。
     类由 skipWhen 动作在运行时翻（不是 class: 指令）：scoped 规则必须写 :global(.skip)，
     否则编译器把它当没用过的类剪掉；--cis 是动作在加类前量好的真实高度（见 skipWhen）。 */
  .turn-user:global(.skip), .turn-assistant:global(.skip) {
    content-visibility: auto;
    contain-intrinsic-size: auto var(--cis, 220px);
  }
  /* 附件缩略图 + 气泡 竖排右对齐（附件在上、文字在下），整列封顶 84%（复刻 claude.ai 消息形态） */
  .u-col { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; max-width: 84%; min-width: 0; }
  .u-atts { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; max-width: 100%; }
  .u-att { display: block; }
  /* 多图：120×120 方形封面切图（object-cover），圆角 8px + 极淡描边 + 轻阴影——复刻 claude.ai */
  .u-img { width: 120px; height: 120px; border-radius: 8px; overflow: hidden; background: var(--hover); border: .5px solid var(--divider); box-shadow: 0 1px 3px rgba(0,0,0,.08); line-height: 0; }
  .u-img img { display: block; width: 100%; height: 100%; object-fit: cover; }
  /* 单图：不裁切，按原始比例展示（封顶尺寸），同 claude.ai 单图更大更完整 */
  .u-img.single { width: auto; height: auto; }
  .u-img.single img { width: auto; height: auto; max-width: min(280px, 72vw); max-height: 320px; object-fit: contain; }
  .u-img:active { filter: brightness(.94); }
  /* 检查点回滚（用户气泡右下）：默认一枚半透明 ↺，点开变就地确认排 */
  .u-acts { display: flex; align-items: center; gap: 6px; justify-content: flex-end; flex-wrap: wrap; min-height: 26px; }
  .rw-ico { width: 28px; height: 28px; opacity: .4; }
  .rw-ico svg { width: 15px; height: 15px; }
  .rw-ico:not(:disabled):active, .rw-ico:not(:disabled):hover { opacity: 1; }
  .rw-ask { font-size: 12px; color: var(--muted); }
  .rw-btn { padding: 4px 11px; border-radius: 8px; font-size: 12px; background: var(--hover); color: var(--text); }
  .rw-btn.primary { background: var(--coral); color: #fff; }
  .rw-btn:active { filter: brightness(.92); }
  .rw-note { font-size: 12px; color: var(--muted); }
  .rw-note.err { color: #e5484d; }
  .u-file { display: flex; align-items: center; gap: 9px; max-width: min(260px, 72vw); padding: 10px 13px; border-radius: 13px; background: var(--card); border: 1px solid var(--divider); }
  .u-file-ic { width: 22px; height: 22px; flex: none; color: var(--serif); }
  .u-file-ic svg { width: 100%; height: 100%; }
  .u-file-name { font-size: 13.5px; color: var(--text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .u-chat { text-align: left; font: inherit; cursor: pointer; }
  .u-chat:disabled { cursor: default; }
  @media (hover: hover) { .u-chat:not(:disabled):hover { background: var(--hover); } }
  .u-chat-col { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .u-chat-sub { font-size: 11.5px; color: var(--muted); }
  .bubble { background: var(--userbubble); color: var(--text); border-radius: 14px; padding: 10px 15px; font-size: 15px; line-height: 1.5; max-width: 100%; word-break: break-word; white-space: pre-wrap; animation: popIn .28s cubic-bezier(.22,1,.36,1); }
  @keyframes popIn { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: none; } }
  .turn-assistant { margin: 6px 0 22px; }

  .think { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 14px; margin-bottom: 10px; }
  .think .chev { font-size: 10px; transition: transform .15s; }
  .think.open .chev { transform: rotate(90deg); }
  .think-body { margin: 0 0 14px 2px; padding: 8px 0 8px 14px; border-left: 2px solid var(--divider); color: var(--muted); font-size: 14px; line-height: 1.7; font-style: italic; white-space: pre-wrap; }

  /* 工具行 / 分组 / Agent 卡 / Workflow 卡的样式全在 claude/ToolGroup.svelte 及其子组件里 */


  /* —— 助手产物附件卡：claude.ai 官网 100% 同款（2026-07-17 Edge 真站逐值提取）——
     卡：radius 8 / border .5px（基 15% 描边，hover 30%）/ hover 底=bg-000 50%，300ms 标准缓动。
     mini 文档页：52px 宽、右缘 8px、translateY 19% 沉入卡底（卡 overflow hidden 裁掉）、
     基态 rotate -0.1rad；hover 弹回 -0.065rad + scale 1.035，400ms cubic-bezier(0,.9,.5,1.35)
     弹簧、离开 300ms easeOutQuart(.165,.84,.44,1)——这就是「鼠标放上去文件图案会动」。
     Download=cds 按钮：32px 高、白10% 底+1px 内环+微投影，按压 squish 弹簧回弹（真站
     0.45s linear() 弹簧曲线原样搬）。字色/描边全部取真站计算值，双主题各一套。 */
  .a-atts { display: flex; flex-direction: column; gap: 8px; margin: 12px 0 4px; }
  .att-card {
    --ac-border: rgba(226, 225, 218, .15); --ac-border-hover: rgba(226, 225, 218, .3);
    --ac-hover-bg: rgba(44, 44, 43, .5); --ac-page-border: rgba(226, 225, 218, .3); --ac-page-bg: #2c2c2b;
    --ac-title: #ffffff; --ac-meta: #97958c; --ac-glyph: #898781;
    --ac-btn-text: #ffffff; --ac-btn-bg: rgba(255, 255, 255, .1); --ac-btn-bg-hover: rgba(255, 255, 255, .14); --ac-btn-ring: rgba(0, 0, 0, 0);
    position: relative; display: flex; width: 100%; padding: 0 16px; border-radius: 8px; overflow: hidden;
    border: .5px solid var(--ac-border); background: transparent;
    transition: background-color .3s cubic-bezier(.4, 0, .2, 1), border-color .3s cubic-bezier(.4, 0, .2, 1);
  }
  :global(html[data-theme='light']) .att-card {
    --ac-border: rgba(31, 31, 30, .15); --ac-border-hover: rgba(31, 31, 30, .3);
    --ac-hover-bg: rgba(255, 255, 255, .5); --ac-page-border: rgba(31, 31, 30, .3); --ac-page-bg: #ffffff;
    --ac-title: #0b0b0b; --ac-meta: #7b7974; --ac-glyph: #898781;
    --ac-btn-text: #0b0b0b; --ac-btn-bg: rgba(255, 255, 255, .1); --ac-btn-bg-hover: rgba(11, 11, 11, .05); --ac-btn-ring: rgba(11, 11, 11, .1);
  }
  .att-hit { position: absolute; inset: 0; cursor: pointer; border-radius: inherit; display: block; }
  .att-hit:focus-visible { outline: none; box-shadow: inset 0 0 0 2px #2563b8; }
  .att-cell { display: flex; flex: 1; gap: 8px; min-width: 0; }
  .att-well { width: 68px; position: relative; flex: none; pointer-events: none; }
  .att-page {
    position: absolute; right: 8px; top: 0; bottom: 0; width: 52px;
    border-radius: 8px 8px 0 0; border: .5px solid var(--ac-page-border);
    background: linear-gradient(to bottom, var(--ac-page-bg), transparent);  /* 官网 from-bg-000 to-bg-000/0 渐隐纸面 */
    display: flex; align-items: flex-start; justify-content: center; padding-top: 16px;
    translate: 0 19%; rotate: -0.1rad; scale: 1; overflow: hidden;
    transition: rotate .3s cubic-bezier(.165, .84, .44, 1), scale .3s cubic-bezier(.165, .84, .44, 1);
  }
  .att-glyph { width: 20px; height: 20px; color: var(--ac-glyph); flex: none; }
  .att-texts { display: flex; flex-direction: column; gap: 4px; padding: 16px 0; min-width: 0; flex: 1; pointer-events: none; }
  .att-name { font-size: 14px; line-height: 1.25; color: var(--ac-title); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .att-sub { font-size: 12px; line-height: 16px; color: var(--ac-meta); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .att-dot { opacity: .5; }
  .att-ctrl { position: relative; z-index: 1; display: flex; align-items: center; flex: none; }
  .att-dl {
    position: relative; isolation: isolate; display: inline-flex; align-items: center; justify-content: center;
    height: 32px; padding: 0 12px; border-radius: 8px; font-size: 14px; font-weight: 500; line-height: 1;
    color: var(--ac-btn-text); white-space: nowrap; text-decoration: none; -webkit-tap-highlight-color: transparent;
  }
  .att-dl-bg {
    position: absolute; inset: 0; z-index: -1; border-radius: inherit;
    background: var(--ac-btn-bg);
    box-shadow: inset 0 0 0 1px var(--ac-btn-ring), 0 1px 2px rgba(0, 0, 0, .05);
    scale: 1;
    transition: background-color .1s ease, scale .45s;
    /* 真站 cds squish 弹簧（0.45s linear() 曲线原样）；不支持 linear() 的内核回落上一行普通过渡 */
    transition: background-color .1s ease, scale .45s linear(0 0%, 0.2459 7.14286%, 0.6526 14.2857%, 0.9468 21.4286%, 1.0764 28.5714%, 1.0915 35.7143%, 1.0585 42.8571%, 1.0219 50%, 0.9993 57.1429%, 0.9914 64.2857%, 0.9921 71.4286%, 0.9957 78.5714%, 0.9988 85.7143%, 1.0004 92.8571%, 1 100%);
  }
  .att-dl:active .att-dl-bg { scale: .97; transition: background-color .1s ease, scale .12s cubic-bezier(.165, .84, .44, 1); }
  @media (hover: hover) {
    .att-card:hover { background: var(--ac-hover-bg); border-color: var(--ac-border-hover); }
    .att-card:hover .att-page { rotate: -0.065rad; scale: 1.035;
      transition: rotate .4s cubic-bezier(0, .9, .5, 1.35), scale .4s cubic-bezier(0, .9, .5, 1.35); }
    .att-dl:hover .att-dl-bg { background: var(--ac-btn-bg-hover); }
  }
  /* 触屏没有 hover：按下整卡时给同款文档页动效，交互反馈不缺席 */
  @media (hover: none) {
    .att-card:active { background: var(--ac-hover-bg); border-color: var(--ac-border-hover); }
    .att-card:active .att-page { rotate: -0.065rad; scale: 1.035;
      transition: rotate .4s cubic-bezier(0, .9, .5, 1.35), scale .4s cubic-bezier(0, .9, .5, 1.35); }
  }

  /* 消息操作排（复制/重试）——尺寸与交互态照搬设计稿 .act 规格 */
  .actions { display: flex; gap: 2px; margin-top: 10px; margin-left: -8px; }
  .act { width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center; color: var(--muted); }
  .act:active { background: var(--hover); color: var(--text); }
  .act:disabled { opacity: .4; }
  .act svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }

  /* min-width:0 + break-word：长 URL / 长标识符这类不可断的单词也不许把正文列撑出去 */
  .answer { font-size: 16px; line-height: 1.75; color: var(--text); min-width: 0; overflow-wrap: break-word; }
  .answer :global(p) { margin: 0 0 12px; }
  .answer :global(p:last-child) { margin-bottom: 0; }
  .answer :global(h1), .answer :global(h2), .answer :global(h3) { margin: 16px 0 8px; line-height: 1.3; }
  .answer :global(ul), .answer :global(ol) { margin: 0 0 12px; padding-left: 22px; }
  .answer :global(li) { margin: 3px 0; }
  .answer :global(pre) { background: var(--userbubble); border: 1px solid var(--divider); border-radius: 12px; padding: 12px 14px; overflow-x: auto; margin: 0 0 12px; }
  .answer :global(code) { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: .9em; }
  .answer :global(:not(pre) > code) { background: var(--hover); padding: 1px 5px; border-radius: 5px; }
  .answer :global(a) { color: var(--coral); }
  .answer :global(img) { max-width: 100%; border-radius: 10px; }
  /* 表格的横向溢出交给外层 .md-tablewrap 滚动壳（lib/md.js 套、app.css 定样式），
     这里只管观感。别在这里给 table 加 display:block —— 那样列宽会被 max-width 压回去，
     十几列的表会被挤成一列一个字。 */
  .answer :global(table) { border-collapse: collapse; font-size: 14px; margin: 0; }
  .answer :global(th), .answer :global(td) { border: 1px solid var(--divider); padding: 6px 10px; }

  /* 流式「吐字渐入」——复刻 claude.ai 官网：新到达文本 opacity 0→1、0.4s linear（见 lib/claudeFade.js）。
     .c-in 由 action 动态生成（不在模板里），故用 :global；keyframes 加 -global- 前缀免被 Svelte 改名。
     inline + 纯 opacity，不改文本流；负 animation-delay 让淡入跨全量重渲染连续、不回跳（对齐官网 linear）。 */
  .answer :global(.c-in) { animation: cIn .4s linear both; }
  @keyframes -global-cIn { from { opacity: 0; } to { opacity: 1; } }
  /* 无障碍：跟随系统「减弱动态效果」，直接实体显示（对齐官网 data-reduce-motion 降级）。 */
  @media (prefers-reduced-motion: reduce) { .answer :global(.c-in) { animation: none; } }

  .err-box { background: #2a1c14; border: 1px solid #5c3522; color: var(--err, #d98a6a); border-radius: 12px; padding: 10px 14px; font-size: 14px; }

  .qcard { margin-top: 16px; border-radius: 16px; background: var(--q-card); box-shadow: var(--q-shadow); overflow: hidden; animation: popIn .3s cubic-bezier(.22,1,.36,1); }
  .qhead { padding: 14px 15px 10px; }
  .qtext { font-size: 15px; line-height: 1.5; color: var(--text); }
  .qopt { width: 100%; display: flex; align-items: center; gap: 13px; min-height: 50px; padding: 0 15px; border-top: 1px solid var(--divider); text-align: left; }
  .qopt:active { background: var(--hover); }
  .qopt.sel { background: var(--q-rowsel); }
  .qnum { color: var(--muted); font-size: 15px; width: 14px; flex: none; }
  .qlabel { flex: 1; font-size: 15px; color: var(--serif); padding: 13px 0; }
  .qdesc { display: block; font-size: 12.5px; color: var(--muted); margin-top: 2px; }
  .qopt.sel .qlabel, .qopt.sel .qnum { color: var(--text); }
  .qcheck { color: var(--text); }   /* 黑白灰铁律：勾选不用 coral */
  .qfoot { display: flex; align-items: center; min-height: 50px; padding: 0 15px; border-top: 1px solid var(--divider); }
  .qelse { flex: 1; background: none; border: none; outline: none; font: inherit; font-size: 15px; color: var(--text); padding: 14px 0; }
  .qelse::placeholder { color: var(--muted); }
  .qdiv { height: 6px; background: var(--divider); opacity: .4; }
  .qactions { display: flex; gap: 10px; justify-content: flex-end; padding: 12px 15px; border-top: 1px solid var(--divider); }
  .qerror { padding: 10px 15px; border-top: 1px solid var(--divider); color: var(--err, #d98a6a); background: rgba(217,138,106,.08); font-size: 13px; line-height: 1.35; }
  .qskip { font-size: 14px; color: var(--text); border: 1px solid var(--q-skipborder); border-radius: 9px; padding: 8px 16px; }
  .qsubmit { font-size: 14px; color: var(--bg); background: var(--text); border-radius: 9px; padding: 8px 16px; }
  .qsubmit:disabled { opacity: .4; }
  /* 已回答 ask 块：只读——未选项淡出、所选保留高亮；自定义答案与「已跳过」提示 */
  .ask-seg.answered .qopt { cursor: default; }
  .ask-seg.answered .qopt:disabled { opacity: 1; }
  .ask-seg.answered .qopt:not(.sel) { opacity: .42; }
  .ask-seg.answered .qopt:active { background: none; }
  .qcustom { flex: 1; font-size: 15px; color: var(--text); padding: 14px 0; }
  .qskipped { padding: 12px 15px; font-size: 14px; color: var(--muted); border-top: 1px solid var(--divider); }

  .turn-foot { display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
  .logo-fly { display: inline-flex; flex: none; }
  .meta { color: var(--muted); font-size: 13px; }
  /* 状态文字的呼吸（官方 epitaxy-thinking-shimmer 原值：opacity 1→.75，2s ease-in-out，先静 3s 再起） */
  .hint.shimmer { animation: hint-breathe 2s ease-in-out 3s infinite; will-change: opacity; }
  @keyframes hint-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .75; } }
  @media (prefers-reduced-motion: reduce) { .hint.shimmer { animation: none; will-change: auto; } }
  /* 后台任务芯片：官方 /code 页菊花右侧那颗蓝色「N running task」——实心蓝底 + 白字小圆角，
     点开右侧工作台的「任务」页。它是状态行里唯一的彩色元素，正是要一眼看见。 */
  .bgchip { background: var(--taskchip); color: var(--taskchip-fg); font-size: 12.5px; line-height: 16px;
    padding: 4px 9px; border-radius: 7px; white-space: nowrap; transition: filter var(--mo-micro) var(--ea-std); }
  @media (hover: hover) { .bgchip:hover { filter: brightness(1.12); } }
  .bgchip:active { filter: brightness(.92); }
</style>
