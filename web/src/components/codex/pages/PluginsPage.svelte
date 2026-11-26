<script>
  // 窄栏「插件与技能」：Codex 开新线程时能带上的东西，分三组。
  //   bridge 工具：工具中枢下发给 Codex 的那几组（modules/codex/server/tools/groups）。它们的开关是 bridge 的功能扩展（全站、所有 agent 共用），
  //     不该在这里顺手关掉——所以这里只「看」：开着 / 已关 / 仅管理员，管理员每行有「设置」直达那个功能扩展的详情。
  //     开没开按 /api/auth 下发的 plugins.off 判断；「这个身份有没有终端权限」「设备通道开没开」前端拿不到，写成「看账号权限」。
  //   MCP 连接器、技能：扩展中心里勾给 Codex 的（agents.codex），开关就是同一个勾，真改（POST /api/extensions/update）。
  //     Codex 只接本地 stdio 连接器；扩展整体停用的不能单独给 Codex 打开。服务端只给管理员的 Codex 会话注入扩展，成员如实写明。
  // 线程参数只在新建线程时下发：改了对之后的新线程生效（页头写明）。
  import { onMount } from 'svelte';
  import { t, tr } from '../../../lib/i18n.js';
  import { api } from '../../../lib/api.js';
  import { me, pluginOn } from '../../../lib/state.svelte.js';
  import { openSettingsFromChat, canOpenSettingsFromChat } from '../../../lib/settingsNav.svelte.js';
  import { openPluginDetail, canOpenPluginDetail } from '../../../lib/extensionsNav.svelte.js';
  import { anim, EASE, reduced } from '../../../lib/codex/motion.js';
  import Icon from '../Icon.svelte';

  const admin = $derived(me.kind === 'admin');

  // 与服务端工具中枢的组一一对应（key = 组名，plugin = 它挂在哪个功能扩展上）
  const TOOLS = [
    { key: 'bridge', plugin: 'agent-api', icon: 'bridge', name: () => t('bridge 操作'), desc: () => t('查项目手册、调 bridge 自己的各种操作') },
    { key: 'browser', plugin: 'browser', shell: true, icon: 'globe', name: () => t('浏览器'), desc: () => t('打开网页、点按、截图，画面在工作区里直播') },
    { key: 'terminal', plugin: 'terminal', shell: true, icon: 'term', name: () => t('共享终端'), desc: () => t('和工作区里那个终端是同一个会话') },
    { key: 'workspace', plugin: 'workspace-tools', icon: 'eye', name: () => t('工作区协同'), desc: () => t('看你此刻在看什么、给你弹开文件、截你看到的画面') },
    { key: 'visualize', plugin: 'visualize', icon: 'chart', name: () => t('可视化'), desc: () => t('回答里直接画图表、流程图') },
    { key: 'device', plugin: 'devices', icon: 'laptop', name: () => t('操作你的电脑'), desc: () => t('看屏幕、点按、跑命令、读写文件（要那台电脑上的客户端授权）') },
    { key: 'pr', plugin: 'pr', icon: 'pr', name: () => t('拉取请求'), desc: () => t('看 PR 与检查、并入基线分支、自动修复与自动合并') },
    { key: 'sessions', plugin: 'session-tools', adminOnly: true, icon: 'msg', name: () => t('会话协作'), desc: () => t('开 Claude 子会话并行干活，收它们的汇报') },
    { key: 'project', adminOnly: true, icon: 'folder', name: () => t('项目记忆'), desc: () => t('同一个项目里各线程共用的记忆') },
    { key: 'phone', plugin: 'phone-files', icon: 'file', name: () => t('手机文件'), desc: () => t('读写手机上授权过的文件夹；只在从手机 App 发起的那一轮能用') },
    { key: 'phoneControl', plugin: 'phone-control', icon: 'phone', name: () => t('操作手机'), desc: () => t('开 app、看画面、点按输入，还有剪贴板、通知、短信') },
  ];

  function toolState(x) {
    if (x.plugin && !pluginOn(x.plugin)) return { on: false, text: t('已关') };
    if (x.adminOnly && !admin) return { on: false, text: t('仅管理员') };
    if (x.shell && !admin) return { on: true, text: t('看账号权限') };
    return { on: true, text: t('开着') };
  }

  /* ---------- 扩展（管理员） ---------- */
  let ext = $state({ loading: false, loaded: false, err: '', items: [] });
  let busy = $state(new Set());
  let opErr = $state('');
  const connectors = $derived(ext.items.filter((x) => x.type === 'connector'));
  const skills = $derived(ext.items.filter((x) => x.type === 'skill'));

  async function loadExt() {
    ext.loading = true;
    try {
      const [a, s] = await Promise.all([api.get('/api/extensions?scope=admin'), api.get('/api/extensions?scope=shared')]);
      const seen = new Set();
      ext.items = [...(a?.items || []), ...(s?.items || [])].filter((x) => x && !seen.has(x.id) && seen.add(x.id));
      ext.err = ''; ext.loaded = true;
    } catch (e) {
      ext.err = tr(e?.body?.error) || t('扩展列表没读出来');
    } finally { ext.loading = false; }
  }

  const stdio = (x) => x.type !== 'connector' || x.connector?.transport === 'stdio';
  const usable = (x) => x.enabled !== false && stdio(x);
  function extSub(x) {
    if (x.enabled === false) return t('这个扩展整体停用了');
    if (!stdio(x)) return t('远程连接器：Codex 只接本地（stdio）连接器');
    return tr(x.description || '') || (x.type === 'connector' ? t('本地连接器') : '');
  }

  async function toggleExt(x) {
    if (busy.has(x.id) || !usable(x)) return;
    const next = !x.agents?.codex;
    const i = ext.items.findIndex((y) => y.id === x.id);
    const prev = ext.items[i];
    ext.items[i] = { ...prev, agents: { ...(prev.agents || {}), codex: next } };
    busy = new Set([...busy, x.id]);
    opErr = '';
    try {
      const r = await api.post('/api/extensions/update', { id: x.id, agents: { codex: next } });
      if (r?.item) { const j = ext.items.findIndex((y) => y.id === x.id); if (j >= 0) ext.items[j] = r.item; }
    } catch (e) {
      const j = ext.items.findIndex((y) => y.id === x.id);
      if (j >= 0) ext.items[j] = prev;
      opErr = t('「{name}」没改成：{why}', { name: x.name, why: tr(e?.body?.error) || t('请重试') });
    } finally {
      const s = new Set(busy); s.delete(x.id); busy = s;
    }
  }

  let inEl = $state(null);
  onMount(() => {
    if (me.kind === 'admin') loadExt();
    if (!reduced() && inEl) [...inEl.children].forEach((el, i) => anim(el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { dur: 380, delay: i * 40, ease: EASE.out }));
  });
</script>

{#snippet glyph(name)}
  {#if name === 'phone'}
    <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5.6" y="2.8" width="8.8" height="14.4" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8.6 14.6h2.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
  {:else}
    <Icon {name} />
  {/if}
{/snippet}

{#snippet extRow(x)}
  <div class="pg-row" class:off={!usable(x) || !x.agents?.codex}>
    <span class="ic sq">{@render glyph(x.type === 'connector' ? 'branch' : 'edit')}</span>
    <span class="tx"><b>{x.name}</b><span>{extSub(x)}</span></span>
    {#if usable(x)}
      <button class="sw" role="switch" aria-checked={!!x.agents?.codex} disabled={busy.has(x.id)} aria-label={x.name}
        title={x.agents?.codex ? t('不再给 Codex 用') : t('给 Codex 用')} onclick={() => toggleExt(x)}></button>
    {/if}
  </div>
{/snippet}

<div class="pg-in" bind:this={inEl}>
  <div class="pg-hd">
    <div class="t">
      <h2>{t('插件与技能')}</h2>
      <p>{t('Codex 开新线程时会带上这里开着的工具；改了对之后的新线程生效。')}</p>
    </div>
    {#if admin && canOpenSettingsFromChat}<button class="tbtn" onclick={() => openSettingsFromChat('extensions')}>{t('管理扩展')}</button>{/if}
  </div>

  <div class="pg-cap">{t('bridge 工具')}</div>
  <div class="pg-list sq">
    {#each TOOLS as x (x.key)}
      {@const s = toolState(x)}
      <div class="pg-row" class:off={!s.on}>
        <span class="ic sq">{@render glyph(x.icon)}</span>
        <span class="tx"><b>{x.name()}</b><span>{x.desc()}</span></span>
        <span class="side">{s.text}</span>
        {#if x.plugin && canOpenPluginDetail() && canOpenSettingsFromChat}
          <button class="tbtn" onclick={() => openPluginDetail(x.plugin)}>{t('设置')}</button>
        {/if}
      </div>
    {/each}
  </div>

  {#if admin}
    {#if ext.err}
      <div class="pg-cap">{t('MCP 连接器与技能')}</div>
      <div class="pg-list sq"><div class="pg-row"><span class="ic sq"><Icon name="warn" /></span><span class="tx"><b>{t('扩展列表没读出来')}</b><span>{ext.err}</span></span><button class="tbtn" disabled={ext.loading} onclick={loadExt}>{t('重试')}</button></div></div>
    {:else if !ext.loaded}
      <p class="pg-note">{t('正在读取…')}</p>
    {:else}
      <div class="pg-cap">{t('MCP 连接器')}</div>
      <div class="pg-list sq">
        {#each connectors as x (x.id)}{@render extRow(x)}{:else}
          <div class="pg-row"><span class="ic sq">{@render glyph('branch')}</span><span class="tx"><b>{t('还没有连接器')}</b><span>{t('在扩展中心添加本地连接器后，可以在这里给 Codex 打开')}</span></span></div>
        {/each}
      </div>
      <div class="pg-cap">{t('技能')}</div>
      <div class="pg-list sq">
        {#each skills as x (x.id)}{@render extRow(x)}{:else}
          <div class="pg-row"><span class="ic sq">{@render glyph('edit')}</span><span class="tx"><b>{t('还没有技能')}</b><span>{t('在扩展中心上传或安装技能后，可以在这里给 Codex 打开')}</span></span></div>
        {/each}
      </div>
    {/if}
    {#if opErr}<p class="pg-err" role="alert"><Icon name="warn" />{opErr}</p>{/if}
  {:else}
    <div class="pg-cap">{t('MCP 连接器与技能')}</div>
    <div class="pg-list sq"><div class="pg-row off"><span class="ic sq"><Icon name="info" /></span><span class="tx"><b>{t('目前只给管理员的 Codex 会话')}</b><span>{t('扩展中心里的连接器和技能，服务器只注入到管理员开的 Codex 线程里')}</span></span></div></div>
  {/if}
</div>

<style>
  .pg-note { margin: 14px 4px 0; color: var(--fg3); font-size: 12.5px; line-height: 1.55; }
  .pg-err { display: flex; gap: 7px; align-items: flex-start; margin: 12px 4px 0; color: var(--fg2); font-size: 12.5px; line-height: 1.5; }
  .pg-err :global(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; color: var(--warn); }
  .pg-row .tbtn { flex: none; color: var(--fg2); font-weight: 400; }
  .pg-row .tbtn:hover { color: var(--fg); }
  .sw[disabled] { opacity: .6; cursor: default; }
  .ic :global(svg) { width: 18px; height: 18px; }
</style>
