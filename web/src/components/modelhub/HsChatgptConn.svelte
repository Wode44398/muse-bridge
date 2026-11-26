<script>
  // ChatGPT 订阅服务的连接面板（HubService 里替代 HsConn 的 'service' 模式）：没有地址、Key、鉴权方式、请求头、共享给成员。
  //   名字、账号列表（邮箱 / 状态、重新登录、启停、删除）、多账号的用法、添加账号、管理用量、出站代理、启用、重新识别、删除服务。
  // 两类改动分开存：名字 / 用法 / 开关是编辑态 ed，有改动时出「放弃 / 保存连接」（同 HsConn）；
  // 账号的启停、删除当场生效（hubPost('update', { lines })，只带 lines）——账号不是表单里的字，点了就该算数。
  // 重新登录 / 添加账号在行下（列表下）展开一块 HsChatgptLogin，一次只开一块。
  // 导出 redetect()：同 HsConn，先存编辑态再识别（HubService 的列表头、错误条经 bind:this 走它）。
  // 这段脚本有单测：HubService.logic.test.js（把 <script> 抠出来跑），改 import / $props 的写法时同步那边。
  import { untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import HsSeg from './HsSeg.svelte';
  import HsChatgptLogin from './HsChatgptLogin.svelte';
  import SToggle from '../settings/SToggle.svelte';
  import { G, svg, ago } from './HsKit.js';
  import { cgAccounts, accountNeed, accountNote, accountName, linesPatch, usageUrlOf } from './chatgptKit.js';
  import { hubPost, loadHub } from '../../lib/modelHub.svelte.js';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { DUR } from '../../lib/motion.js';
  import { t, tr } from '../../lib/i18n.js';

  let {
    svc = null, narrow = false, detecting = false, detErr = '', catAt = 0, now = Date.now(),
    ondetect, onsaved, ondelete, dirty = $bindable(false), connErr = '', locked = false,
  } = $props();

  // —— 编辑态：名字、多账号的用法、出站代理、启用 ——
  const fromSvc = (s) => ({
    id: s.id, name: s.name || '', useProxy: s.useProxy !== false, enabled: s.enabled !== false,
    strategy: s.strategy === 'round-robin' ? 'round-robin' : 'failover',
  });
  let ed = $state(null);
  function isDirty(e, s) {
    if (!e || !s || e.id !== s.id) return false;
    return e.name.trim() !== (s.name || '') || e.useProxy !== (s.useProxy !== false) || e.enabled !== (s.enabled !== false)
      || e.strategy !== (s.strategy === 'round-robin' ? 'round-robin' : 'failover');
  }
  const edDirty = $derived(isDirty(ed, svc));
  $effect(() => { dirty = edDirty; });
  // 服务刷新了而本地没改动：跟着换成最新的（同 HsConn）
  $effect(() => {
    const s = svc;
    if (!s) return;
    untrack(() => { if (!ed || ed.id !== s.id || !isDirty(ed, s)) ed = fromSvc(s); });
  });

  const accounts = $derived(cgAccounts(svc));
  // 线路的冷却状态（额度用完冷却 15 分钟）在 lines[].state 里，按 lineId 对上
  const stateOf = (id) => (svc?.lines || []).find((l) => l && l.id === id)?.state || null;
  const cooling = (a) => a.enabled !== false && (stateOf(a.lineId)?.coolUntil || 0) > now;
  function noteOf(a) {
    const n = accountNote(a);
    if (n || !cooling(a)) return n;
    const st = stateOf(a.lineId);
    const m = Math.max(1, Math.round((st.coolUntil - now) / 60000));
    return t('{why}，约 {m} 分钟后再试', { why: st.coolWhy ? tr(st.coolWhy) : t('冷却中'), m });
  }

  let busy = $state('');      // 'save' | 'line:<lineId>' | 'reset:<lineId>'
  let err = $state('');
  let loginFor = $state('');  // 展开着登录面板的：lineId（重新登录）| '+'（添加账号）| ''
  const strategyOpts = $derived([{ value: 'failover', label: t('按顺序') }, { value: 'round-robin', label: t('轮流') }]);
  const usage = $derived(usageUrlOf(svc));
  const when = $derived(catAt ? ago(catAt, now) : '');

  async function save() {
    if (busy || !ed || !svc) return false;
    const name = ed.name.trim();
    err = name ? '' : t('要有名字');
    if (err) return false;
    busy = 'save';
    try {
      const r = await hubPost('update', { id: svc.id, patch: { name, useProxy: ed.useProxy, enabled: ed.enabled, strategy: ed.strategy } });
      if (r.service) ed = fromSvc(r.service);
      // 这几样都不改识别要用的东西（账号与模型目录）：moved 恒为空
      onsaved?.(r.service || null, r.warnings || [], { moved: '' });
      return true;
    } catch (e) {
      err = tr(e.message);
      return false;
    } finally { busy = ''; }
  }
  function revert() { if (svc) { ed = fromSvc(svc); err = ''; } }
  /** 重新识别：先把编辑态存上（同 HsConn.redetect）。返回 false = 没存上，没去识别。 */
  export async function redetect() {
    if (locked || busy) return true;
    if (edDirty && !(await save())) return false;
    ondetect?.();
    return true;
  }

  // —— 账号：当场生效 ——
  async function patchLines(op, lineId) {
    if (busy || !svc) return false;
    busy = 'line:' + lineId; err = '';
    try {
      const r = await hubPost('update', { id: svc.id, patch: { lines: linesPatch(svc, op) } });
      onsaved?.(r.service || null, r.warnings || [], { quiet: true });
      return true;
    } catch (e) {
      err = tr(e.message);
      return false;
    } finally { busy = ''; }
  }
  const toggleAccount = (a, on) => patchLines({ toggle: a.lineId, on }, a.lineId);
  async function removeAccount(a) {
    if (busy || accounts.length <= 1) return;
    const ok = await uiConfirm(t('移除账号「{name}」？', { name: a.email || a.label || t('ChatGPT 账号') }), {
      danger: true, okLabel: t('移除'), detail: t('这个账号的登录凭据会一并作废，之后要用得重新登录。'),
    });
    if (!ok) return;
    if (await patchLines({ remove: a.lineId }, a.lineId)) {
      if (loginFor === a.lineId) loginFor = '';
      showToast(t('已移除账号'));
    }
  }
  async function resetLine(a) {
    if (busy || !svc) return;
    busy = 'reset:' + a.lineId;
    try {
      const r = await hubPost('line/reset', { id: svc.id, lineId: a.lineId });
      onsaved?.(r.service || null, [], { quiet: true });
    } catch (e) { err = tr(e.message); } finally { busy = ''; }
  }

  function openLogin(key) { err = ''; loginFor = loginFor === key ? '' : key; }
  // 重新登录 / 添加账号成功：login.service 是更新后的服务视图；总览也重拉一次（首页的账号摘要、提醒跟着变）
  function loggedIn(login) {
    const key = loginFor;
    loginFor = '';
    if (login?.service) onsaved?.(login.service, [], { quiet: true });
    loadHub(true);
    const email = login?.account?.email || '';
    showToast(key === '+' ? t('已添加 {email}', { email: email || t('ChatGPT 账号') }) : t('{email} 已重新登录', { email: email || t('账号') }));
  }
</script>

{#snippet saveBtns()}
  <button type="button" class="btn" onclick={revert} disabled={busy === 'save'}>{t('放弃')}</button>
  <button type="button" class="btn primary" class:busy={busy === 'save'} onclick={save} disabled={busy === 'save'}>
    {#if busy === 'save'}<span class="spin" aria-hidden="true"></span>{t('保存中…')}{:else}{t('保存连接')}{/if}
  </button>
{/snippet}

{#if ed && svc}
  <div class="card" class:narrow>
    <div class="fld">
      <label class="fl" for="hs-cgname">{t('名字')}</label>
      <input id="hs-cgname" class="in" type="text" autocomplete="off" maxlength="40" bind:value={ed.name} />
    </div>

    <div class="keys">
      <div class="kh">
        <span class="fl">{t('ChatGPT 账号')}</span>
        {#if accounts.length >= 2}
          <div class="strat"><HsSeg label={t('多个账号的用法')} options={strategyOpts} value={ed.strategy} onchange={(v) => { ed.strategy = v; }} /></div>
        {/if}
      </div>
      <div class="lines">
        {#each accounts as a (a.lineId)}
          {@const need = accountNeed(a)}
          {@const note = noteOf(a)}
          {@const off = a.enabled === false}
          <div class="ln" class:off>
            <span class="who">
              <span class="em" title={accountName(a)}>{accountName(a)}</span>
              {#if note}<span class="st" class:warn={!!need && !off}>{note}</span>{/if}
            </span>
            {#if cooling(a) && !need}
              <button type="button" class="tbtn" disabled={busy === 'reset:' + a.lineId} onclick={() => resetLine(a)}>{t('现在就再用')}</button>
            {/if}
            <button type="button" class="tbtn" class:strong={!!need && !off} aria-expanded={loginFor === a.lineId} onclick={() => openLogin(a.lineId)}>{t('重新登录')}</button>
            <SToggle compact={!narrow} checked={!off} disabled={busy.startsWith('line:')} label={t('启用这个账号')} onchange={(v) => toggleAccount(a, v)} />
            <button type="button" class="ib" disabled={accounts.length <= 1 || !!busy} aria-label={t('移除')}
              title={accounts.length <= 1 ? t('至少要留一个账号；不用了就删除服务') : t('移除')} onclick={() => removeAccount(a)}>{@html svg(G.trash)}</button>
          </div>
          {#if loginFor === a.lineId}
            <div class="relog" transition:fade={{ duration: DUR.quick }}>
              <HsChatgptLogin mode="relogin" compact {narrow} serviceId={svc.id} lineId={a.lineId} email={a.email || ''}
                ondone={loggedIn} oncancel={() => { loginFor = ''; }} />
            </div>
          {/if}
        {:else}
          <div class="ln empty"><span class="st">{t('还没有账号')}</span></div>
        {/each}
      </div>
      {#if loginFor === '+'}
        <div class="relog solo" transition:fade={{ duration: DUR.quick }}>
          <HsChatgptLogin mode="add" compact {narrow} serviceId={svc.id} ondone={loggedIn} oncancel={() => { loginFor = ''; }} />
        </div>
      {/if}
      <div class="kf">
        <button type="button" class="add" aria-expanded={loginFor === '+'} onclick={() => openLogin('+')} disabled={accounts.length >= 30}>{@html svg(G.plus)}{t('添加 ChatGPT 账号')}</button>
        <a class="usage" href={usage} target="_blank" rel="noopener noreferrer">{t('管理用量')}{@html svg(G.out)}</a>
      </div>
    </div>

    <div class="sws">
      <label class="sw">
        <span class="swl">{t('走出站代理')}</span>
        <SToggle checked={ed.useProxy} label={t('走出站代理')} onchange={(v) => { ed.useProxy = v; }} />
      </label>
      <label class="sw">
        <span class="swl">{t('启用这个服务')}</span>
        <SToggle checked={ed.enabled} label={t('启用这个服务')} onchange={(v) => { ed.enabled = v; }} />
      </label>
    </div>

    {#if err || connErr}<p class="err" role="alert">{err || connErr}</p>{/if}
    {#if detErr}<p class="err" role="alert">{detErr}</p>{/if}

    <div class="foot">
      <button type="button" class="btn" class:busy={detecting} disabled={detecting || locked || busy === 'save'} onclick={redetect}>
        {#if detecting}<span class="spin" aria-hidden="true"></span>{t('识别中')}{:else}{@html svg(G.refresh)}{t('重新识别')}{/if}
      </button>
      {#if narrow && when}<span class="hint">{t('上次识别 {when}', { when })}</span>{/if}
      <span class="spx"></span>
      {#if !narrow}
        <div class="sv" class:show={edDirty} inert={!edDirty}>{@render saveBtns()}</div>
      {/if}
      <button type="button" class="tbtn danger" onclick={() => ondelete?.()}>{t('删除服务')}</button>
    </div>
    {#if narrow && edDirty}
      <div class="savebar" transition:fade={{ duration: DUR.micro }}>{@render saveBtns()}</div>
    {/if}
  </div>
{/if}

<style>
  /* 与 HsConn 的 'service' 卡同一套尺寸与层次：一张分组卡，宽屏描边、窄屏实底 */
  .card { display: flex; flex-direction: column; gap: 16px; padding: 18px 20px 16px; border-radius: 14px; box-shadow: inset 0 0 0 1px var(--st-line); }
  .card.narrow { padding: 16px; border-radius: 18px; background: var(--st-surface); box-shadow: none; gap: 14px; }
  .fld { min-width: 0; max-width: 360px; }
  .narrow .fld { max-width: none; }
  .fl { display: block; margin: 0 0 7px 2px; font-size: 12.5px; font-weight: 600; color: var(--st-text2); }
  .narrow .fl { margin-left: 4px; font-size: 13px; }
  .in { width: 100%; min-width: 0; height: 38px; padding: 0 12px; box-sizing: border-box; border: 0; border-radius: 10px; background: var(--st-field); color: var(--text);
    box-shadow: inset 0 0 0 1px var(--st-line); font: inherit; font-size: 14px; outline: none; transition: box-shadow var(--mo-micro) var(--ea-fade); }
  .in:focus { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 55%, transparent); }
  .narrow .in { height: 46px; border-radius: 14px; font-size: 16px; box-shadow: none; }
  .narrow .in:focus { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 40%, transparent); }

  .keys { display: flex; flex-direction: column; gap: 6px; }
  .kh { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 34px; }
  .kh .fl { margin: 0 0 0 2px; }
  .strat { width: 200px; flex: none; }
  .narrow .strat { width: 180px; }
  .lines { display: flex; flex-direction: column; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--st-line); }
  .narrow .lines { box-shadow: none; background: var(--st-field); }
  .ln { display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 6px 8px 6px 14px; }
  .ln + .ln, .relog + .ln { box-shadow: inset 0 1px 0 var(--st-hair); }
  .ln.empty { min-height: 48px; }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .em { min-width: 0; font-size: 13.5px; font-weight: 500; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .st { font-size: 12px; line-height: 1.4; color: var(--st-muted); overflow-wrap: anywhere; }
  .st.warn { color: var(--pm-warn); }
  .ln.off .em { opacity: .55; }
  .relog { padding: 4px 14px 14px; }
  .relog.solo { padding: 12px 14px 14px; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--st-line); }
  .narrow .relog.solo { box-shadow: none; background: var(--st-field); }
  .kf { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  /* 窄屏：邮箱独占第一行，操作排第二行 */
  .narrow .ln { flex-wrap: wrap; padding: 8px 6px 6px 12px; gap: 6px; row-gap: 2px; }
  .narrow .who { flex: 1 1 100%; padding: 2px 0 4px; }
  .narrow .em { font-size: 15px; }
  .narrow .st { font-size: 13px; }

  .sws { display: flex; flex-wrap: wrap; gap: 4px 36px; }
  .sw { display: flex; align-items: center; gap: 12px; min-height: 36px; cursor: pointer; }
  .swl { font-size: 13.5px; color: var(--text); user-select: none; -webkit-user-select: none; }
  .narrow .sws { flex-direction: column; flex-wrap: nowrap; gap: 0; }
  .narrow .sw { justify-content: space-between; min-height: 44px; cursor: default; }
  .narrow .swl { font-size: 15px; }

  .err { margin: 0 2px; font-size: 13px; line-height: 1.5; color: var(--pm-red); overflow-wrap: anywhere; }
  .foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 2px; }
  .hint { font-size: 12.5px; color: var(--st-muted); }
  .spx { flex: 1; }
  .sv { display: flex; gap: 10px; opacity: 0; visibility: hidden;
    transition: opacity var(--mo-micro) var(--ea-fade), visibility 0s linear var(--mo-micro); }
  .sv.show { opacity: 1; visibility: visible; transition: opacity var(--mo-micro) var(--ea-fade), visibility 0s; }
  .savebar { display: flex; justify-content: flex-end; gap: 10px; padding-top: 12px; box-shadow: inset 0 1px 0 var(--st-hair); }
  .narrow .savebar .btn { flex: 1 1 0; }

  .btn { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 34px; padding: 0 14px; border: 0; border-radius: 10px;
    background: transparent; color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line); font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: transform var(--mo-tap) var(--ea-std), background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade); }
  .btn :global(svg) { width: 15px; height: 15px; }
  @media (hover: hover) { .btn:hover:not(:disabled) { background: var(--st-hover); } }
  .btn:active:not(:disabled) { transform: scale(.96); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); box-shadow: none; font-weight: 600; }
  @media (hover: hover) { .btn.primary:hover:not(:disabled) { background: var(--st-primary); opacity: .88; } }
  .btn.busy:disabled { opacity: .72; }
  .btn.primary.busy:disabled { background: var(--st-primary); color: var(--st-primary-ink); }
  .btn.primary:focus-visible { box-shadow: 0 0 0 2px var(--st-surface), 0 0 0 4px var(--text); }
  .narrow .btn { height: 44px; border-radius: 13px; font-size: 15px; padding: 0 16px; }
  .tbtn { flex: none; display: inline-flex; align-items: center; height: 30px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: var(--text);
    font: inherit; font-size: 12.5px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  @media (hover: hover) { .tbtn:hover:not(:disabled) { background: var(--st-hover); } }
  .tbtn:active:not(:disabled) { transform: scale(.96); }
  .tbtn:disabled { opacity: .4; cursor: default; }
  .tbtn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .tbtn[aria-expanded="true"] { background: var(--st-sel); }
  /* 要处理的账号：「重新登录」用描边钮提一下，不上彩色 */
  .tbtn.strong { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 30%, transparent); }
  .tbtn.danger { color: var(--pm-red); }
  .narrow .tbtn { height: 44px; padding: 0 10px; font-size: 14px; }
  .ib { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--st-muted); cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  .ib :global(svg) { width: 16px; height: 16px; }
  @media (hover: hover) { .ib:hover:not(:disabled) { background: var(--st-hover); color: var(--pm-red); } }
  .ib:active:not(:disabled) { transform: scale(.96); }
  .ib:disabled { opacity: .3; cursor: default; }
  .ib:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .narrow .ib { width: 44px; height: 44px; border-radius: 12px; }
  .add { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px 0 8px; border: 0; border-radius: 8px; background: transparent;
    color: var(--st-text2); font: inherit; font-size: 13px; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  .add :global(svg) { width: 15px; height: 15px; }
  @media (hover: hover) { .add:hover:not(:disabled) { background: var(--st-hover); color: var(--text); } }
  .add:active:not(:disabled) { transform: scale(.96); }
  .add:disabled { opacity: .4; cursor: default; }
  .add:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .narrow .add { height: 44px; font-size: 14.5px; }
  .usage { display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 8px; border-radius: 8px; color: var(--st-text2); font-size: 13px; text-decoration: none;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade); }
  .usage :global(svg) { width: 13px; height: 13px; }
  @media (hover: hover) { .usage:hover { background: var(--st-hover); color: var(--text); } }
  .usage:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .narrow .usage { height: 44px; font-size: 14.5px; }

  @media (prefers-reduced-motion: reduce) {
    .btn:active:not(:disabled), .tbtn:active:not(:disabled), .ib:active:not(:disabled), .add:active:not(:disabled) { transform: none; }
  }
</style>
