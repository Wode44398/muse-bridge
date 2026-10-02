<script>
  // Composer 加号菜单（claude.ai 原版子集）：Add files or photos / Research / Use style。
  // 图标用从 claude.ai 复制的原版 SVG path（lib/icons.js），viewBox 20、fill currentColor。
  // Use style 含自定义风格：本设备 localStorage（lib/styles.svelte.js），编辑表单内嵌第三视图。
  import { settings } from '../lib/state.svelte.js';
  import { customStyles, addStyle, updateStyle, removeStyle } from '../lib/styles.svelte.js';
  import { ICON_PAPERCLIP, ICON_RESEARCH, ICON_FEATHER } from '../lib/icons.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { IS_CSNAP } from '../lib/csnap.js';
  import { t, tc } from '../lib/i18n.js';
  let { onClose, onPickFiles, onPickPhotos, onPickFolder, dir = 'up' } = $props();

  let view = $state('main'); // 'main' | 'style' | 'edit'

  // 安卓系统返回沿内部视图逐级退（编辑→风格→主菜单→关闭）；卸载自动出栈。
  $effect(() => pushBackLayer(() => {
    if (view === 'edit') { view = 'style'; return; }
    if (view === 'style') { view = 'main'; return; }
    onClose?.();
  }));
  const STYLES = [
    { id: 'normal', name: 'Normal' },
    { id: 'learning', name: 'Learning' },
    { id: 'concise', name: 'Concise' },
    { id: 'explanatory', name: 'Explanatory' },
    { id: 'formal', name: 'Formal' },
  ];
  const curStyle = $derived(settings.style || 'normal');
  const curName = $derived(
    (STYLES.find((s) => s.id === curStyle) || customStyles.list.find((s) => s.id === curStyle) || STYLES[0]).name
  );

  // 编辑表单状态：editingId=null 表示新建。
  let editingId = $state(null);
  let editName = $state('');
  let editText = $state('');
  let confirmDel = $state(false);

  const close = () => onClose && onClose();
  function pickStyle(id) { settings.style = id; close(); }
  function files() { close(); onPickFiles && onPickFiles(); }
  function photos() { close(); onPickPhotos && onPickPhotos(); }
  function folder() { close(); onPickFolder && onPickFolder(); }
  function toggleResearch() { settings.research = !settings.research; close(); }

  function openEdit(s) {
    editingId = s ? s.id : null;
    editName = s ? s.name : '';
    editText = s ? s.text : '';
    confirmDel = false;
    view = 'edit';
  }
  function saveEdit() {
    const name = editName.trim() || t('未命名风格');
    const text = editText.trim();
    if (!text) return;
    if (editingId) updateStyle(editingId, name, text);
    else settings.style = addStyle(name, text);   // 新建即选用
    view = 'style';
  }
  function delEdit() {
    if (!confirmDel) { confirmDel = true; return; }
    if (settings.style === editingId) settings.style = 'normal';
    removeStyle(editingId);
    view = 'style';
  }
</script>

<button class="am-backdrop" aria-label={t('关闭')} onclick={close}></button>
<div class="am" class:down={dir === 'down'} role="menu">
  {#if view === 'main'}
    <!-- 照片专用入口：安卓壳见 accept 全是 image/* 就开系统照片选择器（相册网格、按时间倒序），
         不再进文件管理器翻目录；电脑上是只列图片的文件对话框。 -->
    {#if onPickPhotos}
      <button class="am-row" onclick={photos}>
        <svg class="am-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.7"/><circle cx="9" cy="9.7" r="1.6"/><path d="m4 17.2 4.6-4.6a1.6 1.6 0 0 1 2.2 0l5.7 5.7"/><path d="m14.3 15.4 1.6-1.6a1.6 1.6 0 0 1 2.2 0l2.4 2.4"/></svg>
        <span class="am-name">Add photos</span>
      </button>
    {/if}
    <button class="am-row" onclick={files}>
      <svg class="am-ic" viewBox="0 0 20 20" fill="currentColor"><path d={ICON_PAPERCLIP} /></svg>
      <span class="am-name">{onPickPhotos ? 'Add files' : 'Add files or photos'}</span>
    </button>
    <!-- 挂载文件夹：整树传上去，Claude 用 Read/Glob/Grep 按需读（不塞进上下文） -->
    <button class="am-row" onclick={folder}>
      <svg class="am-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.2c0-1.5 1.2-2.7 2.7-2.7h3.4l2 2.3h6.2c1.5 0 2.7 1.2 2.7 2.7v8.3c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7z"/></svg>
      <span class="am-name">{t('挂载文件夹')}</span>
    </button>
    <div class="am-div"></div>
    <!-- 快照模式后端强制 research=false（子 agent 成本），开关一并隐藏免得看着能开实际无效 -->
    {#if !IS_CSNAP}
      <button class="am-row" onclick={toggleResearch}>
        <svg class="am-ic" viewBox="0 0 20 20" fill="currentColor"><path d={ICON_RESEARCH} /></svg>
        <span class="am-name">Research</span>
        {#if settings.research}<span class="am-check">✓</span>{/if}
      </button>
    {/if}
    <button class="am-row" onclick={() => (view = 'style')}>
      <svg class="am-ic" viewBox="0 0 20 20" fill="currentColor"><path d={ICON_FEATHER} /></svg>
      <span class="am-name">Use style</span><span class="am-right">{curName} ›</span>
    </button>
  {:else if view === 'style'}
    <button class="am-back" onclick={() => (view = 'main')}>{t('‹ 返回')}</button>
    {#each STYLES as s}
      <button class="am-row" onclick={() => pickStyle(s.id)}>
        <svg class="am-ic" viewBox="0 0 20 20" fill="currentColor"><path d={ICON_FEATHER} /></svg>
        <span class="am-name">{s.name}</span>
        {#if s.id === curStyle}<span class="am-check">✓</span>{/if}
      </button>
    {/each}
    {#if customStyles.list.length}
      <div class="am-div"></div>
      {#each customStyles.list as s (s.id)}
        <div class="am-row split">
          <button class="am-pickarea" onclick={() => pickStyle(s.id)}>
            <svg class="am-ic" viewBox="0 0 20 20" fill="currentColor"><path d={ICON_FEATHER} /></svg>
            <span class="am-name">{s.name}</span>
            {#if s.id === curStyle}<span class="am-check">✓</span>{/if}
          </button>
          <button class="am-editbtn" aria-label={t('编辑 {name}', { name: s.name })} onclick={() => openEdit(s)}>
            <svg viewBox="0 0 24 24"><path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
          </button>
        </div>
      {/each}
    {/if}
    <div class="am-div"></div>
    <button class="am-row" onclick={() => openEdit(null)}>
      <svg class="am-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
      <span class="am-name">Create &amp; edit styles</span>
    </button>
  {:else}
    <button class="am-back" onclick={() => (view = 'style')}>{t('‹ 返回')}</button>
    <div class="am-form">
      <input class="am-input" type="text" placeholder={t('风格名称（如：翻译腔）')} bind:value={editName} maxlength="20" />
      <textarea class="am-ta" placeholder={t('风格指令，例如：所有回复都用文言文，并在结尾附一句白话总结。')} bind:value={editText} maxlength="4000" rows="5"></textarea>
      <div class="am-form-btns">
        {#if editingId}
          <button class="am-del" class:arm={confirmDel} onclick={delEdit}>{confirmDel ? tc('claude', '确认删除') : t('删除')}</button>
        {/if}
        <button class="am-save" disabled={!editText.trim()} onclick={saveEdit}>{editingId ? t('保存') : t('创建并使用')}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .am-backdrop { position: fixed; inset: 0; z-index: 60; }
  .am {
    position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 61;
    min-width: 246px; max-width: 88vw; padding: 6px;
    background: var(--q-card); border-radius: 16px; box-shadow: var(--q-shadow);
    max-height: 60vh; overflow-y: auto;
  }
  .am.down { bottom: auto; top: calc(100% + 8px); }
  .am-row { width: 100%; display: flex; align-items: center; gap: 11px; padding: 10px 12px; border-radius: 11px; text-align: left; }
  .am-row:active { background: var(--hover); }
  .am-row.split { padding: 0; gap: 0; }
  .am-pickarea { flex: 1; display: flex; align-items: center; gap: 11px; padding: 10px 0 10px 12px; border-radius: 11px 0 0 11px; text-align: left; min-width: 0; }
  .am-pickarea:active { background: var(--hover); }
  .am-editbtn { flex: none; width: 38px; align-self: stretch; display: flex; align-items: center; justify-content: center; color: var(--muted); border-radius: 0 11px 11px 0; }
  .am-editbtn:active { background: var(--hover); color: var(--text); }
  .am-editbtn svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .am-ic { width: 20px; height: 20px; color: var(--serif); flex: none; }
  .am-name { font-size: 15px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .am-right { margin-left: auto; font-size: 13px; color: var(--muted); }
  /* claude 页配色铁律：除星芒图标外全部黑白灰——勾选/按钮不用 coral（审美统一）。 */
  .am-check { margin-left: auto; color: var(--text); font-size: 15px; padding-right: 10px; }
  .am-div { height: 1px; background: var(--divider); margin: 5px 8px; }
  .am-back { width: 100%; padding: 8px 12px; color: var(--muted); font-size: 14px; text-align: left; }
  /* 自定义风格编辑表单（菜单内嵌） */
  .am-form { display: flex; flex-direction: column; gap: 8px; padding: 4px 8px 8px; width: 280px; max-width: 100%; }
  .am-input, .am-ta {
    width: 100%; padding: 9px 11px; border-radius: 10px; font-size: 14px;
    background: var(--hover); color: var(--text); border: 1px solid var(--divider);
  }
  .am-ta { resize: vertical; min-height: 96px; line-height: 1.5; font-family: inherit; }
  .am-input:focus, .am-ta:focus { outline: none; border-color: var(--serif); }
  .am-form-btns { display: flex; gap: 8px; justify-content: flex-end; }
  /* 主按钮与发送键/提交回答同款：黑底反白（亮暗主题自适应），不再是突兀的橙色 */
  .am-save { padding: 8px 16px; border-radius: 10px; background: var(--text); color: var(--bg); font-size: 14px; font-weight: 600; }
  .am-save:disabled { opacity: .45; }
  .am-del { padding: 8px 14px; border-radius: 10px; color: var(--muted); font-size: 14px; border: 1px solid var(--divider); }
  .am-del.arm { color: #fff; background: #c43c3c; border-color: #c43c3c; }
</style>
