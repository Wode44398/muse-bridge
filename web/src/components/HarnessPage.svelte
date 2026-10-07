<script>
  // dimensio 分页 = 同仓库 harness 项目的前端【原生嵌入】（vite @hx 别名引源码，
  // 单一真相源：品牌皮肤 / 会话历史 / checkpoint 回滚 / 附件 / 预览全套能力）。
  //
  // 本壳只做这几件事：
  //   1) configureApi 注入 bridge 的基址与鉴权 —— base 每次求值走 apiUrl()；headers 带 Bearer；
  //   2) embedded 模式渲染（主题作用域在分页根、不碰宿主 body/系统栏、字体
  //      复用 bridge 已装载的同名家族，见 harness 侧 fonts.css 注释）；
  //   3) onExit 回 bridge 主页（侧栏「主页」行 + 系统返回都走它）。单 agent 模式（只剩 dimensio）
  //      没有主页：onExit 传 null（harness 据此不摆「主页」行），侧栏底部改挂账户卡（sidebarFoot）。
  import { ui, me, singleMode } from '../lib/state.svelte.js';
  import { closePage } from '../lib/pageMorph.js';
  import { openSettings } from '../lib/settingsNav.svelte.js';
  import { apiUrl } from '../lib/server.js';
  import { authHeaders } from '../lib/api.js';
  import { openPreview } from '../lib/preview.svelte.js';
  import { uploadFile as hxUploadFile } from '@hx/lib/api.ts';
  import { app as hxApp } from '@hx/lib/state.svelte.ts';
  import { resolveMode, themeBg } from '@hx/lib/theme.ts';
  import HarnessApp from '@hx/App.svelte';
  import { drag, dropZone, dropToast } from '../lib/dragdrop.svelte.js';
  import { WS_FILE, dtHasWsFiles, wsDescriptorFrom } from '../lib/fileDrag.js';
  import HxFilesEmbed from './dock/HxFilesEmbed.svelte';
  import ProjectPicker from './ProjectPicker.svelte';
  import AccountCard from './AccountCard.svelte';
  import '@hx/app.css';
  import { t } from '../lib/i18n.js';

  import '../lib/hxApi.js';   // configureApi：接口基址与鉴权（模块级，设置里的 dimensio 一节也靠它）

  // 页面配色跟 dimensio 自己的明暗档（跟系统 / 浅 / 深）走，而不是 bridge 主题：theme-color meta
  // （App.svelte）与内嵌的工作空间视图（HxFilesEmbed）读 ui.pageChrome。「跟随系统」档还要盯系统
  // 深浅切换。分页卸载即清回 null。
  $effect(() => {
    const appearance = hxApp.appearance;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      const mode = resolveMode(appearance);
      ui.pageChrome = { dark: mode === 'dark', bg: themeBg(mode) };
    };
    sync();
    mq.addEventListener?.('change', sync);
    return () => {
      mq.removeEventListener?.('change', sync);
      ui.pageChrome = null;
    };
  });

  // 入场期间延后挂载：dimensio 整个应用（HarnessApp）挂载一次 ~35ms，手机上 ≈140ms，压在入场转场
  // 拍新快照之前就是「点完先愣一下」。转场期间先摆一块与它同色的底板当这一页（快照拍的是它，
  // 卡片从入口长出来的就是这块底），落幕再挂真应用、内容淡入（.hxroot > .shell 的 hx-arrive）。
  // 挂载时机：卡片长到九成（入场弹簧 ~300ms，此后几何只剩几个像素的收尾）就挂，挂载的那一下卡顿
  // 落在看不出来的尾巴上；转场提前结束则立即挂。
  let armed = $state(!ui.morphing);
  $effect(() => {
    if (armed) return;
    if (!ui.morphing) { armed = true; return; }
    const tid = setTimeout(() => { armed = true; }, 300);
    return () => clearTimeout(tid);
  });
  const placeholderBg = $derived(themeBg(resolveMode(hxApp.appearance)));

  // 4) 新建项目的工作空间选择器由宿主接管（dimensio 自带的目录对话框只在独立 8799 兜底）：
  //    开 ProjectPicker（bridge 的工作空间文件管理器 + 底部「拖入选为工作空间」栏）。返回绝对路径，
  //    空串＝取消。与 Claude 分页走的是同一个 ProjectPicker，dimensio 只是把「要一个路径」这件事交出来。
  let pickResolve = $state(null);
  function pickWorkspace() {
    return new Promise((resolve) => { pickResolve = resolve; });
  }
  function finishPick(dir) {
    const resolve = pickResolve;
    pickResolve = null;
    resolve?.(dir || '');
  }

  // 5) 全域拖放的落点：把工作空间里的一份文件投给【当前这个 dimensio 会话】。
  //    dimensio 的附件与 Claude 的不是一回事——它存的是【工作空间相对路径字符串】
  //    （agent 自己去读），不是 bridge uploads 里的素材对象。所以分两种落法：
  //      · 同一个工作空间（从 dimensio 自己的工作台文件视图拖出来就是这种）→ 直接把 rel
  //        塞进 app.chat.attachments，一个字节都不用搬；
  //      · 跨工作空间（从整页工作空间 / 别的 agent 侧栏拖过来）→ 那份 rel 对 dimensio 毫无
  //        意义，先经 bridge 取字节、再走 harness 的上传落进该项目的 uploads/，然后挂它。
  //    文件夹只有同工作空间时能挂（跨空间整树搬运不在这条通路上做）。
  const normPath = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  function hxAttach(paths) {
    if (!paths.length) return;
    hxApp.chat.attachments = [...new Set([...(hxApp.chat.attachments || []), ...paths])];
  }
  async function dropIntoDimensio(rels, ws, dirs = []) {
    const target = hxApp.config?.workspace || '';
    if (ws && normPath(ws) === normPath(target)) {
      hxAttach(rels);
      dropToast(t('已挂进 dimensio 的输入栏'));
      return;
    }
    dropToast(t('正在准备…'));
    let ok = 0, skipDir = 0;
    for (let i = 0; i < rels.length; i++) {
      const rel = rels[i];
      const name = String(rel).split('/').pop() || 'file';
      if (dirs[i]) { skipDir++; continue; }
      try {
        const url = apiUrl('/api/file?path=' + encodeURIComponent(rel) + (ws ? '&ws=' + encodeURIComponent(ws) : ''));
        const res = await fetch(url, { headers: authHeaders(), credentials: 'same-origin' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        await hxUploadFile('uploads/' + name, new File([blob], name));
        hxAttach(['uploads/' + name]);
        ok++;
      } catch {}
    }
    dropToast(ok ? t('已挂进 dimensio 的输入栏') : (skipDir ? t('跨工作空间只能投文件，文件夹请先放进这个项目') : t('准备失败')));
  }

  // 单 agent 模式（只剩 dimensio）：这一页就是根——没有主页可回，账户卡挂到侧栏底部。
  const single = $derived(singleMode());
  // 单页模式下没登录时 LoginDialog 压在页上：别让 dimensio 在登录框底下就开始打 /api/harness（全是 401）。
  const ready = $derived(!single || me.kind !== 'none');

  const dimensioDrop = {
    key: 'chat:dimensio', effect: 'send', label: (p) => (p?.count > 1 ? t('把 {n} 项挂进这个对话', { n: p.count }) : t('挂进这个对话')),
    accept: (p) => p?.type === WS_FILE && !!p.rels?.length,
    drop: (p) => dropIntoDimensio(p.rels, p.ctx?.ws || '', p.dirs),
  };
  // 高亮由本组件的 effect 上（action 里开不了 $effect）；outline 不依赖定位、也不会被
  // harness 那侧的 scoped CSS 剪掉（规则写在 bridge 全局 app.css）。
  let hxChatEl = $state(null);
  $effect(() => {
    if (!hxChatEl) return;
    hxChatEl.classList.toggle('hx-dnd-on', drag.overKey === 'chat:dimensio');
  });
  // 注入给 harness 的 action：手指那套走 dropZone，鼠标那套走 HTML5 拖拽，两条同一个落法。
  function chatDrop(node) {
    hxChatEl = node;
    const zone = dropZone(node, dimensioDrop);
    const over = (v) => node.classList.toggle('hx-dnd-on', v);
    const onOver = (e) => {
      if (!dtHasWsFiles(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch {}
      over(true);
    };
    const onLeave = (e) => { if (!node.contains(e.relatedTarget)) over(false); };
    const onDrop = (e) => {
      if (!dtHasWsFiles(e)) return;
      e.preventDefault();
      over(false);
      const d = wsDescriptorFrom(e.dataTransfer);
      if (d) dropIntoDimensio(d.rels, d.ws || '', d.dirs || []);
    };
    node.addEventListener('dragover', onOver);
    node.addEventListener('dragleave', onLeave);
    node.addEventListener('drop', onDrop);
    return {
      destroy() {
        zone.destroy();
        if (hxChatEl === node) hxChatEl = null;
        node.removeEventListener('dragover', onOver);
        node.removeEventListener('dragleave', onLeave);
        node.removeEventListener('drop', onDrop);
      },
    };
  }
</script>

<!-- 工作台「文件」视图由宿主提供：bridge 的 FilesPanel + 面板内查看器（见 HxFilesEmbed） -->
<!-- p.target = dimensio 侧的定位（产物卡点开）：{ seq, rel, open } —— 落到产物所在目录
     并自动弹出该文件的面板内预览，与 Claude 分页的产物卡同一套体验。 -->
{#snippet hxFiles(p)}
  <HxFilesEmbed ws={p.ws} target={p.target} onExit={p.onExit} />
{/snippet}

<!-- 单 agent 模式：harness 侧栏底部的账户卡（与 Claude 分页侧栏底部同一张，菜单没有「主页」） -->
{#snippet accountFoot()}
  <div class="hx-acct"><AccountCard onhome={null} /></div>
{/snippet}

{#if pickResolve}
  <ProjectPicker onPick={finishPick} onClose={() => finishPick('')} />
{/if}

{#if armed && ready}
<HarnessApp
  embedded
  filesView={hxFiles}
  {pickWorkspace}
  {chatDrop}
  openSettings={() => openSettings('dimensio')}
  onExit={single ? null : () => closePage(ui.screen)}
  sidebarFoot={single ? accountFoot : null}
  onOpenArtifact={(artifact, sessionId) => openPreview({
    origin: 'harness',
    id: sessionId,
    path: artifact.path,
    name: artifact.name,
    kind: artifact.kind,
  })}
/>
{:else}
  <div class="hx-placeholder" style:background={placeholderBg}></div>
{/if}

<style>
  .hx-placeholder { position: fixed; inset: 0; z-index: 30; }
  .hx-acct { padding: 0 0 2px; }   /* harness 底栏自己管安全区与间距，这里只留一点呼吸 */
  /* 真应用挂上来时内容淡入（接在入场转场的底板后面，不是凭空蹦出来） */
  :global(.hxroot > .shell.embedded) { animation: hx-arrive var(--mo-base) var(--ea-fade) both; }
  @keyframes -global-hx-arrive { from { opacity: 0; } }
</style>
