<script>
  // 线程菜单（点顶栏标题弹出）：重命名、从这里分叉、复制线程 ID、在终端里接着跑、归档、删除（方案第十五节第 11 条）。
  // 结果都写在被点的那一项上（「已复制」「已复制命令」、失败原因），不弹提示条。
  // 删除先过 bridge 自己的确认框；在跑的线程删不了——服务端拒绝的原因也回到这张菜单里显示。
  // 两个入口：顶栏标题（操作当前线程，用 props）；侧栏线程行的「⋯」/ 右键 / 长按（openPop 时 data 带 { id, title, onrename }）。
  import { untrack } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { codex, leadOf, sessionMeta, forkThread, archiveThread, deleteThread, errText } from '../../lib/codex/store.svelte.js';
  import { cxPop, closePop, openPop } from '../../lib/codex/ui.svelte.js';
  import { resumeCommand, typeIntoCodexTerminal, copyText } from '../../lib/codex/chrome/terminal.js';
  import Popover from './Popover.svelte';
  import Icon from './Icon.svelte';

  let { id: curId = '', title: curTitle = '', onrename: curRename = null } = $props();

  // 侧栏行打开的：操作那一行；顶栏打开的：操作当前线程
  const target = $derived(cxPop.data?.id ? cxPop.data : { id: curId, title: curTitle, onrename: curRename });
  const id = $derived(target.id);
  const title = $derived(target.title);

  let busy = $state('');        // fork | archive | delete | resume
  let copied = $state(false);
  let resumeNote = $state('');  // 写不进终端时退回复制：这一项上写「已复制命令」
  let err = $state('');
  let keep = false;             // 删除失败后重新打开菜单时，别把原因清掉

  const open = $derived(cxPop.id === 'thread');
  $effect(() => {
    if (!open) return;
    untrack(() => {
      if (keep) { keep = false; return; }
      busy = ''; copied = false; resumeNote = ''; err = '';
    });
  });

  const later = (ms, fn) => setTimeout(fn, ms);

  function rename() {
    const fn = target.onrename;
    closePop();
    fn?.();
  }

  async function fork() {
    if (busy) return;
    const tid = id;
    busy = 'fork'; err = '';
    try { await forkThread(tid); closePop('thread'); }
    catch (e) { err = errText(e, t('分叉没成功')); }
    finally { busy = ''; }
  }

  async function copyId() {
    const tid = id;
    if (await copyText(tid)) { copied = true; later(700, () => closePop('thread')); }
    else err = t('没能写进剪贴板：{id}', { id: tid });
  }

  async function resume() {
    if (busy) return;
    const cmd = resumeCommand(id);
    busy = 'resume'; err = '';
    const typed = await typeIntoCodexTerminal(cmd);
    busy = '';
    if (typed) { closePop('thread'); return; }
    if (await copyText(cmd)) { resumeNote = t('已复制命令'); later(900, () => closePop('thread')); }
    else err = t('终端没接上，命令是：{cmd}', { cmd });
  }

  async function archive() {
    if (busy) return;
    const tid = id;
    busy = 'archive'; err = '';
    try { await archiveThread(tid); closePop('thread'); }
    catch (e) { err = errText(e, t('归档没成功')); }
    finally { busy = ''; }
  }

  async function del() {
    if (busy) return;
    const tid = id;
    const lead = leadOf(tid);
    if (lead === 'think' || lead === 'exec' || lead === 'ask' || lead === 'write') { err = t('这条线程还在跑，停下来再删'); return; }
    const anchor = cxPop.anchor, data = cxPop.data;
    const name = title || sessionMeta(tid)?.title || '';
    const ok = await uiConfirm(t('删除「{name}」？', { name }), {
      detail: t('这条线程的记录会从服务器上删掉，不能恢复。'), okLabel: t('删除'), type: 'warning', danger: true,
    });
    if (!ok) return;
    busy = 'delete';
    try { await deleteThread(tid); closePop('thread'); }
    catch (e) {
      err = errText(e, t('删除没成功'));
      // 确认框那一下已经把菜单收了：带着原因重新打开
      if (anchor?.isConnected) { keep = true; openPop('thread', anchor, data); }
    } finally { busy = ''; }
  }
</script>

<Popover id="thread" side="bottom" align="start" width={250} label={t('线程操作')}>
  <div class="pop-sec">
    <button class="mi" role="menuitem" onclick={rename}>
      <Icon name="edit" class="mi-ico" /><span class="lb">{t('重命名')}</span>
    </button>
    <button class="mi" role="menuitem" disabled={!!busy && busy !== 'fork'} aria-busy={busy === 'fork'} onclick={fork}>
      <Icon name="branch" class="mi-ico" /><span class="lb">{busy === 'fork' ? t('正在分叉…') : t('从这里分叉')}</span><span class="sub mono">/fork</span>
    </button>
    <button class="mi" role="menuitem" onclick={copyId}>
      <Icon name="copy" class="mi-ico" /><span class="lb">{copied ? t('已复制') : t('复制线程 ID')}</span>
      {#if copied}<Icon name="check" class="done-ck" />{/if}
    </button>
    <button class="mi" role="menuitem" disabled={!!busy && busy !== 'resume'} aria-busy={busy === 'resume'} onclick={resume}>
      <Icon name="term" class="mi-ico" /><span class="lb">{resumeNote || (busy === 'resume' ? t('正在打开终端…') : t('在终端里接着跑'))}</span>
      {#if resumeNote}<Icon name="check" class="done-ck" />{:else}<span class="sub mono">codex resume</span>{/if}
    </button>
  </div>
  <div class="pop-sep"></div>
  <div class="pop-sec">
    <button class="mi" role="menuitem" disabled={!!busy && busy !== 'archive'} onclick={archive}>
      <Icon name="archive" class="mi-ico" /><span class="lb">{busy === 'archive' ? t('正在归档…') : t('归档')}</span>
    </button>
    <button class="mi warn" role="menuitem" disabled={!!busy && busy !== 'delete'} onclick={del}>
      <svg class="mi-ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5.8h12M8.2 5.6V4.2h3.6v1.4M5.6 5.8l.7 9.6a1.6 1.6 0 0 0 1.6 1.5h4.2a1.6 1.6 0 0 0 1.6-1.5l.7-9.6M8.4 9v4.6M11.6 9v4.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="lb"><span>{busy === 'delete' ? t('正在删除…') : t('删除')}</span></span>
    </button>
  </div>
  {#if err}<p class="tm-err" role="alert"><Icon name="warn" />{err}</p>{/if}
</Popover>

<style>
  .tm-err { display: flex; gap: 7px; align-items: flex-start; margin: 0; padding: 2px 16px 12px; color: var(--fg2); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
  .tm-err :global(svg) { width: 14px; height: 14px; margin-top: 1px; flex: none; color: var(--warn); }
</style>
