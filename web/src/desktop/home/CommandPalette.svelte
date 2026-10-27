<script>
  // Ctrl+K 命令面板（批4）：跨 agent 最近会话 / 打开分页 / 直达设置分区。
  // 仅主页激活（DesktopHome 挂载它；keep-alive display:none 时按键被 screen 门挡掉）。
  import { ui, me, screenOn } from '../../lib/state.svelte.js';
  import { api } from '../../lib/api.js';
  import { openSession } from '../../lib/chat.svelte.js';
  import { dskGlass } from '../glass/domGlass.js';
  import { GLASS } from '../glass/material.js';
  import { settingsNav } from '../settings/settingsNav.svelte.js';
  import { t } from '../../lib/i18n.js';

  let { onOpenAgent } = $props();

  let open = $state(false);
  let q = $state('');
  let hi = $state(0);
  let sessions = $state([]);
  let inputEl = $state();

  function openPal() {
    open = true; q = ''; hi = 0;
    requestAnimationFrame(() => inputEl?.focus());
    api.sessions().then((r) => {
      const list = r?.sessions || r?.items || (Array.isArray(r) ? r : []);
      sessions = list.slice(0, 6).map((s) => ({
        id: s.id || s.sessionId,
        title: s.title || s.name || s.preview || (s.id || '').slice(0, 8),
      })).filter((s) => s.id);
    }).catch(() => { sessions = []; });
  }
  function close() { open = false; }

  function onGlobalKey(e) {
    if (ui.screen !== 'home' || ui.settingsOpen) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      open ? close() : openPal();
    } else if (open && e.key === 'Escape') { e.preventDefault(); close(); }
  }

  const AGENT_ITEMS = $derived([
    { kind: 'agent', key: 'claude', label: t('打开 Claude'), keys: 'claude cc' },
    { kind: 'agent', key: 'chatgpt', label: t('打开 ChatGPT'), keys: 'codex openai gpt' },
    { kind: 'agent', key: 'harness', label: t('打开 dimensio'), keys: 'dimensio harness hx' },
    { kind: 'agent', key: 'vertex', label: t('打开 Vertex'), keys: t('gemini 图片 视频 音乐') },
    { kind: 'agent', key: 'files', label: t('打开工作空间'), keys: t('文件 files workspace') },
  ].filter((it) => screenOn(it.key)));
  const SETTING_ITEMS = [
    { kind: 'settings', sec: 'general', label: t('设置 · 通用'), keys: t('通知 语言 自启') },
    { kind: 'settings', sec: 'appearance', label: t('设置 · 外观'), keys: t('明暗 深色 浅色 动画') },
    { kind: 'settings', sec: 'ag-claude', label: t('设置 · Claude'), keys: t('号池 账号 切号 用量 输入建议 思考动画') },
    { kind: 'settings', sec: 'wallpaper', label: t('设置 · 壁纸'), keys: t('空间 景深 上传 flux 流体') },
    { kind: 'settings', sec: 'connect', label: t('设置 · 连接与更新'), keys: t('服务器 地址 版本 更新') },
    { kind: 'settings', sec: 'help', label: t('设置 · 帮助'), keys: t('反馈 版本') },
  ];
  const items = $derived.by(() => {
    const needle = q.trim().toLowerCase();
    const ses = screenOn('claude') ? sessions.map((s) => ({ kind: 'session', id: s.id, label: t('继续 · {title}', { title: s.title }), keys: t('claude 会话 继续') })) : [];
    const all = [...AGENT_ITEMS, ...ses, ...SETTING_ITEMS];
    const hitList = needle ? all.filter((it) => (it.label + ' ' + it.keys).toLowerCase().includes(needle)) : all;
    return hitList.slice(0, 10);
  });
  $effect(() => { items; hi = 0; });

  function run(it) {
    if (!it) return;
    close();
    if (it.kind === 'agent') onOpenAgent?.(it.key);
    else if (it.kind === 'session') { ui.screen = 'claude'; openSession(it.id).catch(() => {}); }
    else if (it.kind === 'settings') { settingsNav.sec = it.sec; ui.settingsOpen = true; }
  }
  function onInputKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); hi = (hi + 1) % Math.max(1, items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = (hi + items.length - 1) % Math.max(1, items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); run(items[hi]); }
  }
</script>

<svelte:window onkeydown={onGlobalKey} />

{#if open}
  <button class="bd" onclick={close} aria-label={t('关闭')}></button>
  <!-- tint 的 alpha 决定这块玻璃压得住多亮的壁纸：0.35 在明亮风景壁纸上白字几乎读不出来，
       按「面板要先能读」提到 0.66，玻璃感（折射/环/磨砂）不动。 -->
  <div class="cp" use:dskGlass={{ ...GLASS.panel, radius: 18, frost: 3, ring: 0.3, tint: [0.05, 0.05, 0.045, 0.66] }}>
    <div class="in">
      <svg viewBox="0 0 16 16" width="15" height="15"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m11 11 3.4 3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <input bind:this={inputEl} placeholder={t('搜索 agent、最近会话、设置…')} bind:value={q} onkeydown={onInputKey} />
      <kbd>esc</kbd>
    </div>
    <div class="list">
      {#each items as it, i (it.kind + (it.key || it.id || it.sec))}
        <button class="it" class:hi={i === hi} onpointerenter={() => (hi = i)} onclick={() => run(it)}>
          <span class="dot" class:ses={it.kind === 'session'} class:set={it.kind === 'settings'}></span>
          <span class="lb">{it.label}</span>
          {#if i === hi}<kbd>↵</kbd>{/if}
        </button>
      {:else}
        <div class="none">{t('没有匹配项')}</div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .bd { position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, .34); cursor: default; }
  .cp {
    position: fixed; z-index: 81; left: 50%; top: 22%; transform: translateX(-50%);
    width: min(560px, 86vw); overflow: hidden;
    font-family: var(--dsk-font); color: #fff;
    box-shadow: 0 30px 80px rgba(0, 0, 0, .45);
    animation: cp-in .16s var(--dsk-ease-out);
  }
  @keyframes cp-in { from { opacity: 0; transform: translateX(-50%) translateY(-6px) scale(.99); } }
  .in { display: flex; align-items: center; gap: 10px; padding: 13px 15px; border-bottom: 1px solid rgba(255, 255, 255, .12); color: rgba(255, 255, 255, .65); }
  .in input {
    flex: 1; background: none; border: none; outline: none;
    font-family: inherit; font-size: 15px; color: #fff;
  }
  .in input::placeholder { color: rgba(255, 255, 255, .42); }
  kbd {
    padding: 2px 6px; border-radius: 5px; font-family: inherit; font-size: 10.5px;
    background: rgba(255, 255, 255, .1); color: rgba(255, 255, 255, .6);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12);
  }
  .list { padding: 6px; max-height: 340px; overflow: auto; }
  .it {
    display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 8px 10px; border-radius: 10px; text-align: left;
    font-family: inherit; font-size: 13.5px; color: rgba(255, 255, 255, .92);
  }
  .it.hi { background: rgba(255, 255, 255, .14); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsk-accent, #d97757); flex: none; }
  .dot.ses { background: #64d2ff; }
  .dot.set { background: #bf5af2; }
  .lb { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .none { padding: 16px; text-align: center; color: rgba(255, 255, 255, .45); font-size: 13px; }
</style>
