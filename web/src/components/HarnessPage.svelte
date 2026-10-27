<script>
  // Harness 分页 = 独立 harness 项目的新前端【原生嵌入】（vite @hx 别名跨仓引源码，
  // 单一真相源：五家品牌皮肤 / 会话历史 / checkpoint 回滚 / 附件 / 预览全套能力）。
  //
  // 本壳只做三件事：
  //   1) configureApi 注入 bridge 的基址与鉴权 —— base 每次求值走 apiUrl()，
  //      自动吃 bridge 的 LAN/隧道自愈；headers 带 admin Bearer；
  //   2) embedded 模式渲染（主题作用域在分页根、不碰宿主 body/系统栏、字体
  //      复用 bridge 已装载的同名家族，见 harness 侧 fonts.css 注释）；
  //   3) onExit 回 bridge 主页（侧栏「主页」行 + 安卓返回键都走它）。单 agent 模式（lib/rootScreen.js：
  //      只开了 dimensio）这一页就是根——onExit 传 null（harness 据此不摆「主页」行、返回键到底交还宿主），
  //      侧栏底部挂账户行（sidebarFoot，与 Claude 页侧栏底部同一套 UserMenu），没登录不挂页面、给登录。
  import { ui, me, singleMode } from '../lib/state.svelte.js';
  import { closePage } from '../lib/pageMorph.js';
  import { apiUrl } from '../lib/server.js';
  import { authHeaders } from '../lib/api.js';
  import { openPreview } from '../lib/preview.svelte.js';
  import { configureApi, uploadFile as hxUploadFile } from '@hx/lib/api.ts';
  import { app as hxApp } from '@hx/lib/state.svelte.ts';
  import { resolveMode, themeBg } from '@hx/lib/theme.ts';
  import HarnessApp from '@hx/App.svelte';
  import { drag, dropZone, dropToast } from '../lib/dragdrop.svelte.js';
  import { WS_FILE, dtHasWsFiles, wsDescriptorFrom } from '../lib/fileDrag.js';
  import HxFilesEmbed from './dock/HxFilesEmbed.svelte';
  import ProjectPicker from './ProjectPicker.svelte';
  import UserMenu from './UserMenu.svelte';
  import { updateInfo } from '../lib/updateStore.svelte.js';
  import { hasNativePickDirectory, nativePickDirectory } from '../lib/nativeDesktop.js';
  import { t } from '../lib/i18n.js';
  import '@hx/app.css';

  configureApi({
    base: () => apiUrl('/api/harness'),
    headers: () => authHeaders(),
  });

  // 桌面壳窗控配色跟 dimensio 自己的明暗档（跟系统 / 浅 / 深）走，而不是 bridge 主题：
  // 两者不一致时右上角三颗系统钮会与页面底色同色（白钮落白底），DesktopChrome 读
  // ui.pageChrome 优先。「跟随系统」档还要盯系统深浅切换。分页卸载即清回 null。
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

  // —— 单 agent 模式：这一页就是根 ——
  const single = $derived(singleMode());
  // 没登录时登录框（App 的 LoginDialog）压在页上：别让 dimensio 在登录框底下就开始打 /api/harness（全是 401），
  // 先摆同色底板；登录框被关掉了，底板正中留一颗「登录」把它叫回来（这一页没登录什么也做不了）。
  const ready = $derived(!single || me.kind !== 'none');
  const placeholderDark = $derived(resolveMode(hxApp.appearance) === 'dark');
  // 侧栏底部账户行（Claude 页 .d-foot 那一行同款：头像 + 名字 · 角色 + ⌄），点开 UserMenu（设置 / 关于与更新 /
  // 工作空间 / 扫一扫，没登录多一条「登录」；没有「主页」）。行住在 harness 侧栏里（常驻列与抽屉可能各渲染
  // 一份），菜单在本页只挂一份（harness 抽屉带 transform，fixed 菜单挂在里面会被吃掉），锚点取被点那颗按钮。
  let umAnchor = $state(null);
  function toggleUserMenu(e) { umAnchor = umAnchor ? null : e.currentTarget.getBoundingClientRect(); }
  const meName = $derived(me.kind === 'none' ? t('未登录') : (me.user || (me.kind === 'admin' ? 'admin' : '')));
  const meRole = $derived(me.kind === 'admin' ? t('管理员') : me.kind === 'user' ? (me.tier === 'pro' || me.tier === 'full' ? t('完全信任用户') : t('用户')) : '');
  const meInitial = $derived(me.kind === 'none' ? '?' : (meName || '?').trim().charAt(0).toUpperCase());
  $effect(() => { if (!single) umAnchor = null; });

  // 4) 新建项目的工作空间选择器由宿主接管（dimensio 自带的目录对话框只在独立 8799 兜底）：
  //    本机桌面壳直接唤起系统原生文件夹选择器；网页/手机开 ProjectPicker（bridge 的工作空间
  //    文件管理器 + 底部「拖入选为工作空间」栏）。返回绝对路径，空串＝取消。
  //    三个 agent 走的是同一个 ProjectPicker，dimensio 只是把「要一个路径」这件事交出来。
  let pickResolve = $state(null);
  function pickWorkspace() {
    if (hasNativePickDirectory()) return nativePickDirectory('');
    return new Promise((resolve) => { pickResolve = resolve; });
  }
  function finishPick(dir) {
    const resolve = pickResolve;
    pickResolve = null;
    resolve?.(dir || '');
  }

  // 5) 全域拖放的落点：把工作空间里的一份文件投给【当前这个 dimensio 会话】。
  //    dimensio 的附件与 Claude/Codex 不是一回事——它存的是【工作空间相对路径字符串】
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

<!-- 单 agent 模式：harness 侧栏底部的账户行（Claude 页侧栏底部那一行同款；菜单里没有「主页」）。
     配色用 dimensio 自己的令牌（--text / --text2 / --text3 / --surface3），跟它的明暗档走。 -->
{#snippet accountFoot()}
  <button class="hx-me" class:open={!!umAnchor} onclick={toggleUserMenu} aria-haspopup="menu" aria-expanded={!!umAnchor}
    title={t('设置与账户')}>
    <span class="av">{meInitial}</span>
    <span class="hx-me-n">{meName}{#if meRole}<span class="hx-me-r">{` · ${meRole}`}</span>{/if}</span>
    {#if updateInfo.available}<span class="hx-me-dot" title={t('有新版本')}></span>{/if}
    <span class="hx-me-chev" aria-hidden="true">&#xe027;</span>
  </button>
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
  <div class="hx-placeholder" style:background={placeholderBg}>
    {#if !ready && ui.booted && !ui.loginOpen}
      <button class="hx-login" class:dark={placeholderDark} onclick={() => (ui.loginOpen = true)}>{t('登录')}</button>
    {/if}
  </div>
{/if}

<!-- 账户行的菜单：页面级只挂一份（见 toggleUserMenu 注释）。onpick 只收菜单——选「设置」时设置外壳盖在
     整页之上，选「工作空间」时整页换走，都不用替 harness 收抽屉 -->
{#if umAnchor && single}
  <!-- 菜单配色跟 dimensio 的明暗档（它就弹在 dimensio 侧栏上），不跟 bridge 主题：两者可以不一致 -->
  <div class="hx-um" class:dark={placeholderDark}>
    <UserMenu anchor={umAnchor} onclose={() => (umAnchor = null)} onpick={() => (umAnchor = null)} onhome={null} />
  </div>
{/if}

<style>
  .hx-placeholder { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; }
  .hx-login { height: 40px; padding: 0 22px; border: 0; border-radius: 999px; font: inherit; font-family: var(--sans); font-size: 15px;
    cursor: pointer; background: #171614; color: #f4f1ea; animation: hx-arrive var(--mo-base) var(--ea-fade) both; }
  .hx-login.dark { background: #eeeae2; color: #131210; }
  /* —— 侧栏底部账户行（ClaudePage .d-me 同一套几何：36px 行、26px 圆头像、名字 14px 次级色、末尾 ⌄；
     手机加高到 44px）。圆角 / 悬停底跟 harness 侧栏的「设置」行对齐 —— */
  .hx-me { width: 100%; height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 5px; border: 0; border-radius: 10px;
    background: none; color: var(--text2); font: inherit; font-size: 14px; text-align: left; cursor: pointer; transition: background-color .12s ease, color .12s ease; }
  .hx-me.open { background: color-mix(in srgb, var(--text) 9%, transparent); color: var(--text); }
  .hx-me:active { background: color-mix(in srgb, var(--text) 8%, transparent); }
  @media (hover: hover) { .hx-me:hover { background: color-mix(in srgb, var(--text) 5%, transparent); color: var(--text); } }
  .hx-me .av { width: 26px; height: 26px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
    background: var(--surface3); color: var(--text); font-size: 12px; font-weight: 560; }
  .hx-me-n { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .hx-me-r { color: var(--text3); }
  .hx-me-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--st-accent); }
  .hx-me-chev { flex: none; font-family: var(--icons); font-size: 16px; line-height: 1; color: var(--text3); transition: transform .15s ease; }
  .hx-me.open .hx-me-chev { transform: rotate(180deg); }
  @media (pointer: coarse) { .hx-me { height: 44px; } .hx-me .av { width: 30px; height: 30px; font-size: 13px; } }
  /* UserMenu 读的那几个令牌按 dimensio 明暗档重给一遍（取值同 app.css 的 :root / html[data-theme="light"]）；
     display:contents 不产生盒子，照常参与继承 */
  .hx-um { display: contents;
    --text: #121212; --st-muted: #898781; --st-hover: rgba(11,11,11,.04); --st-hair: rgba(11,11,11,.05); --st-menu: #ffffff;
    --st-menu-shadow: 0 0 0 1px rgba(11,11,11,.1),0 8px 24px rgba(0,0,0,.12),0 2px 6px rgba(0,0,0,.08); }
  .hx-um.dark {
    --text: #f8f8f6; --st-muted: #97958c; --st-hover: rgba(255,255,255,.05); --st-hair: rgba(255,255,255,.07); --st-menu: #2c2c2a;
    --st-menu-shadow: 0 0 0 1px rgba(255,255,255,.09),0 8px 24px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.3); }
  /* 真应用挂上来时内容淡入（接在入场转场的底板后面，不是凭空蹦出来） */
  :global(.hxroot > .shell.embedded) { animation: hx-arrive var(--mo-base) var(--ea-fade) both; }
  @keyframes -global-hx-arrive { from { opacity: 0; } }
</style>
