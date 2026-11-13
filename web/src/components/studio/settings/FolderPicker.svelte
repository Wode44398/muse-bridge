<script>
  // 设置 › Media Studio › 存储 › 保存位置：在【自己的工作空间】里挑一个文件夹（saveDir 是相对工作空间根的路径，
  // 管理员的根是 vault、成员是各自的工作空间）。数据走 /api/files（api.files 只列根内，越不出去），
  // 可以逐级进入、面包屑回退、就地新建文件夹；选定 = 当前所在的这一层。
  // 宽屏是居中小对话框，手机（< 700px）是推入的整页；返回键 / Esc 先退一层目录，到根再关。
  import { onMount, untrack } from 'svelte';
  import { api } from '../../../lib/api.js';
  import { pushBackLayer } from '../../../lib/nav.js';
  import { t, tr } from '../../../lib/i18n.js';

  let { value = '', title = '', onPick, onClose } = $props();

  const norm = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
  let path = $state('');
  let items = $state([]);
  let loading = $state(true);
  let err = $state('');
  let mk = $state(null);      // 新建文件夹：{ name, busy, err }
  let seq = 0;
  const NARROW = '(max-width: 699px)';
  let narrow = $state(typeof window !== 'undefined' && window.matchMedia?.(NARROW).matches);

  async function load(p) {
    const my = ++seq;
    path = norm(p); loading = true; err = '';
    try {
      const r = await api.files(path);
      if (my !== seq) return;
      items = (r.items || []).filter((i) => i.isDir && i.linkType !== 'external-link' && !String(i.name).startsWith('.')).sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
    } catch (e) {
      if (my !== seq) return;
      // 起点（还没建出来的默认文件夹）读不到：退到它的上一层
      if (path && my === 1) { const up = path.split('/').slice(0, -1).join('/'); seq = 0; load(up); return; }
      items = []; err = tr(e?.body?.error || e?.message) || t('读不到这个文件夹');
    }
    loading = false;
  }
  const crumbs = $derived(path ? path.split('/') : []);
  function up() { if (path) load(path.split('/').slice(0, -1).join('/')); }
  async function mkdir() {
    const name = (mk?.name || '').trim();
    if (!name || mk.busy) return;
    if (/[\\/:*?"<>|]/.test(name)) { mk.err = t('名字里不能有 \\ / : * ? " < > |'); return; }
    mk.busy = true; mk.err = '';
    try { await api.mkdir(path, name); mk = null; await load(path ? path + '/' + name : name); }
    catch (e) { mk.err = tr(e?.body?.error || e?.message) || t('新建失败'); mk.busy = false; }
  }
  function back() { if (mk) { mk = null; return; } if (path) up(); else onClose?.(); }

  onMount(() => {
    load(untrack(() => value));
    const off = pushBackLayer(back);
    const key = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); back(); } };
    window.addEventListener('keydown', key);
    const mq = window.matchMedia?.(NARROW);
    const onMq = () => { narrow = mq.matches; };
    mq?.addEventListener?.('change', onMq);
    return () => { off(); window.removeEventListener('keydown', key); mq?.removeEventListener?.('change', onMq); };
  });
</script>

<div class="ov" class:narrow role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
  <div class="dlg" role="dialog" aria-modal="true" aria-label={title || t('保存位置')}>
    <header class="top">
      <button type="button" class="hbtn" aria-label={path ? t('上一级') : t('关闭')} onclick={back}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg>
      </button>
      <div class="ttl">{title || t('保存位置')}</div>
      <button type="button" class="hbtn" aria-label={t('新建文件夹')} title={t('新建文件夹')} onclick={() => (mk = { name: '', busy: false, err: '' })}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.6A2.6 2.6 0 0 1 6.1 5h3.1c.5 0 1 .2 1.3.6l1.3 1.5h6.1a2.6 2.6 0 0 1 2.6 2.6v7.7a2.6 2.6 0 0 1-2.6 2.6H6.1a2.6 2.6 0 0 1-2.6-2.6z"/><path d="M12 11v5M9.5 13.5h5"/></svg>
      </button>
    </header>
    <nav class="crumbs" aria-label={t('位置')}>
      <button type="button" class="cb" class:on={!path} onclick={() => load('')}>{t('工作空间')}</button>
      {#each crumbs as c, i (i)}
        <span class="cs" aria-hidden="true">/</span>
        <button type="button" class="cb" class:on={i === crumbs.length - 1} onclick={() => load(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
      {/each}
    </nav>

    <div class="scroll">
      {#if mk}
        <div class="mk">
          <!-- svelte-ignore a11y_autofocus -->
          <input class="in" placeholder={t('新文件夹的名字')} bind:value={mk.name} autofocus onkeydown={(e) => { if (e.key === 'Enter' && !e.isComposing) mkdir(); }} />
          <button type="button" class="btn sm primary" disabled={!mk.name.trim() || mk.busy} onclick={mkdir}>{t('新建')}</button>
          <button type="button" class="btn sm ghost" onclick={() => (mk = null)}>{t('取消')}</button>
          {#if mk.err}<p class="mkerr">{mk.err}</p>{/if}
        </div>
      {/if}
      {#if loading}
        <div class="msg">{t('载入中…')}</div>
      {:else if err}
        <div class="msg err">{err}</div>
      {:else}
        <div class="ig">
          {#each items as it (it.name)}
            <button type="button" class="row" onclick={() => load(path ? path + '/' + it.name : it.name)}>
              <svg class="fo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.6A2.6 2.6 0 0 1 6.1 5h3.1c.5 0 1 .2 1.3.6l1.3 1.5h6.1a2.6 2.6 0 0 1 2.6 2.6v7.7a2.6 2.6 0 0 1-2.6 2.6H6.1a2.6 2.6 0 0 1-2.6-2.6z"/></svg>
              <span class="nm">{it.name}</span>
              <svg class="chev" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg>
            </button>
          {:else}
            <div class="msg">{t('这里没有子文件夹')}</div>
          {/each}
        </div>
      {/if}
    </div>

    <footer class="foot">
      <span class="here"><span class="hl">{t('存到')}</span><span class="hp">{path || t('工作空间根目录')}</span></span>
      <button type="button" class="btn ghost" onclick={() => onClose?.()}>{t('取消')}</button>
      <button type="button" class="btn primary" disabled={loading || !!err} onclick={() => onPick?.(path)}>{t('选这里')}</button>
    </footer>
  </div>
</div>

<style>
  .ov {
    --bg: #100f0d; --card: #1a1917; --ink: #f1ece2; --ink2: rgba(241, 236, 226, .62); --ink3: rgba(241, 236, 226, .4);
    --line: rgba(241, 236, 226, .08); --sunk: rgba(241, 236, 226, .06); --hover: rgba(241, 236, 226, .05); --acc: #ebe5d8; --on: #151412;
    position: fixed; inset: 0; z-index: 210; display: flex; align-items: center; justify-content: center; padding: 24px;
    background: rgba(0, 0, 0, .5); animation: fade .16s ease; color: var(--ink);
    font-family: var(--font-brand-sans), -apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  :global(html[data-theme="light"]) .ov {
    --bg: #f2f0eb; --card: #fcfbf8; --ink: #1d1b18; --ink2: rgba(29, 27, 24, .62); --ink3: rgba(29, 27, 24, .4);
    --line: rgba(29, 27, 24, .085); --sunk: rgba(29, 27, 24, .05); --hover: rgba(29, 27, 24, .04); --acc: #1d1b18; --on: #f6f3ec;
    background: rgba(24, 21, 17, .3);
  }
  @keyframes fade { from { opacity: 0; } }
  .dlg { width: min(520px, 100%); height: min(620px, 100%); display: flex; flex-direction: column; overflow: hidden; border-radius: 22px; background: var(--bg);
    box-shadow: 0 24px 70px rgba(0, 0, 0, .35), 0 0 0 1px var(--line); animation: pop .22s cubic-bezier(.2, .9, .3, 1.08); }
  @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.985); } }
  .top { flex: none; display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; align-items: center; height: 54px; padding: 0 6px; }
  .ttl { text-align: center; font-size: 16px; font-weight: 600; letter-spacing: -.1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hbtn { width: 40px; height: 40px; display: grid; place-items: center; border: 0; border-radius: 50%; background: transparent; color: var(--ink); cursor: pointer; }
  .hbtn:hover { background: var(--hover); }
  .hbtn svg { width: 20px; height: 20px; }
  .crumbs { flex: none; display: flex; align-items: center; gap: 2px; padding: 0 16px 10px; overflow-x: auto; scrollbar-width: none; white-space: nowrap; }
  .crumbs::-webkit-scrollbar { display: none; }
  .cb { border: 0; background: transparent; padding: 3px 7px; border-radius: 8px; color: var(--ink2); font: inherit; font-size: 13px; cursor: pointer; }
  .cb:hover { background: var(--hover); }
  .cb.on { color: var(--ink); font-weight: 600; }
  .cs { color: var(--ink3); font-size: 12px; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 0 16px 16px; overscroll-behavior: contain; }
  .ig { background: var(--card); border-radius: 16px; overflow: hidden; box-shadow: inset 0 0 0 .5px var(--line); }
  .row { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 0 14px; border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 15px; text-align: left; cursor: pointer; }
  .row:hover { background: var(--hover); }
  .row + .row::before { content: ''; position: absolute; top: 0; left: 46px; right: 0; height: 1px; background: var(--line); }
  .fo { width: 20px; height: 20px; flex: none; color: var(--ink2); }
  .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chev { width: 15px; height: 15px; flex: none; color: var(--ink3); }
  .msg { padding: 28px 16px; text-align: center; font-size: 13.5px; color: var(--ink2); }
  .msg.err { color: #d9534f; }
  .mk { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
  .in { flex: 1; min-width: 160px; height: 38px; box-sizing: border-box; padding: 0 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); color: var(--ink); font: inherit; font-size: 14.5px; outline: 0; }
  .in:focus { border-color: color-mix(in srgb, var(--acc) 60%, transparent); }
  .mkerr { flex-basis: 100%; margin: 0; font-size: 12.5px; color: #d9534f; }
  .foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 16px calc(12px + var(--sab, 0px)); border-top: 1px solid var(--line); }
  .here { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .hl { font-size: 11.5px; color: var(--ink3); }
  .hp { font-size: 13.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn { display: inline-flex; align-items: center; justify-content: center; height: 38px; padding: 0 18px; border: 0; border-radius: 999px; background: var(--sunk); color: var(--ink); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; flex: none; }
  .btn.sm { height: 34px; padding: 0 14px; }
  .btn.ghost { background: transparent; }
  .btn.primary { background: var(--acc); color: var(--on); font-weight: 600; }
  .btn:disabled { opacity: .45; cursor: default; }
  .ov.narrow { padding: 0; align-items: stretch; background: transparent; animation: none; }
  .ov.narrow .dlg { width: 100%; height: 100%; border-radius: 0; box-shadow: none; padding-top: var(--sat, 0px); animation: push .34s cubic-bezier(.2, .95, .25, 1) both; }
  @keyframes push { from { transform: translateX(28%); opacity: 0; } }
</style>
