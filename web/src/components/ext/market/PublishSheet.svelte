<script>
  // 发布到社区：插件详情推入的一层（返回回到那个插件的详情）。从上到下就是作者要走的四步：
  //   GitHub 账号（这台电脑的 gh / 设备码登录 / 粘贴令牌）→ 填这一版的说明 → 检查（与市场 CI 同一份规则）→ 发布成拉取请求，然后看投稿状态。
  // 令牌只在服务端用，这里从头到尾拿不到；能不能登录、走哪种方式都听 /api/plugins/community/account 的。
  import { onDestroy } from 'svelte';
  import { api } from '../../../lib/api.js';
  import { pushBackLayer } from '../../../lib/nav.js';
  import { t, tr } from '../../../lib/i18n.js';
  import { renderMarkdown } from '../../../lib/md.js';
  import { ic } from '../icons.js';
  import { kindText, capsText, SUB_TEXT, subDone } from './community.js';

  let { plugin, name = '', toast = () => {}, confirm = async () => true, onBack = () => {} } = $props();

  const errMsg = (e) => tr((e?.body && typeof e.body === 'object' ? e.body.error : typeof e?.body === 'string' ? e.body : '') || e?.message || String(e));
  $effect(() => pushBackLayer(() => onBack()));
  let alive = true;
  onDestroy(() => { alive = false; stopDevice(); clearTimeout(subTimer); });

  // ═══ 账号 ═══
  let acct = $state(null);        // { ok, login, via, deviceLogin, canLogout, error? } | null = 拉取中
  let acctErr = $state('');
  let acctBusy = $state(false);
  async function loadAcct() {
    try { acct = await api.get('/api/plugins/community/account'); acctErr = ''; }
    catch (e) { acctErr = errMsg(e); }
  }
  loadAcct();
  const VIA = { gh: t('用的是这台电脑上 gh 登录的账号'), device: t('经 GitHub 登录'), token: t('用的是粘贴的令牌') };

  // 设备码登录：拿到登录码后按服务端给的间隔轮询，GitHub 叫慢一点时服务端会把间隔加上去
  let device = $state(null);      // { userCode, verificationUri, expiresIn, interval }
  let deviceMsg = $state('');
  let devTimer = null;
  function stopDevice() { clearTimeout(devTimer); devTimer = null; }
  async function startDevice() {
    if (acctBusy) return;
    acctBusy = true; deviceMsg = ''; tokenOpen = false;
    try {
      device = await api.post('/api/plugins/community/login/start', {});
      schedulePoll(device.interval);
    } catch (e) { deviceMsg = errMsg(e); }
    finally { acctBusy = false; }
  }
  function schedulePoll(sec) {
    stopDevice();
    devTimer = setTimeout(pollDevice, Math.max(5, Number(sec) || 5) * 1000);
  }
  async function pollDevice() {
    if (!alive || !device) return;
    let r;
    try { r = await api.post('/api/plugins/community/login/poll', {}); }
    catch (e) { if (alive && device) { deviceMsg = errMsg(e); schedulePoll(device.interval); } return; }
    if (!alive || !device) return;
    if (r.status === 'pending') { schedulePoll(r.interval || device.interval); return; }
    if (r.status === 'ok') { device = null; toast(t('已登录 GitHub：@{login}', { login: r.login || '' })); await loadAcct(); return; }
    device = null;
    deviceMsg = r.status === 'expired' ? t('登录码过期了，重新来一次')
      : r.status === 'denied' ? t('在 GitHub 上拒绝了授权')
      : r.status === 'none' ? t('登录流程断了（bridge 可能重启过），重新来一次')
      : t('登录没成：{reason}', { reason: tr(r.error || '') || t('未知原因') });
  }
  function cancelDevice() { stopDevice(); device = null; deviceMsg = ''; }
  async function copyCode() { try { await navigator.clipboard.writeText(device.userCode); toast(t('已复制')); } catch { toast(device.userCode); } }

  let tokenOpen = $state(false);
  let token = $state('');
  let tokenErr = $state('');
  async function saveToken() {
    if (!token.trim() || acctBusy) return;
    acctBusy = true; tokenErr = '';
    try {
      const r = await api.post('/api/plugins/community/token', { token: token.trim() });
      token = ''; tokenOpen = false;
      toast(t('已登录 GitHub：@{login}', { login: r.login || '' }));
      await loadAcct();
    } catch (e) { tokenErr = errMsg(e); }
    finally { acctBusy = false; }
  }
  async function logout() {
    if (acctBusy) return;
    if (!(await confirm({ title: t('退出 GitHub 账号 @{login}？', { login: acct.login }), desc: t('删掉存在这台服务器上的 GitHub 登录；之后发布要重新登录。已经提交的拉取请求不受影响。'), yes: t('退出') }))) return;
    acctBusy = true;
    try { await api.post('/api/plugins/community/logout', {}); await loadAcct(); }
    catch (e) { toast(errMsg(e), true); }
    finally { acctBusy = false; }
  }
  const login = $derived(acct?.ok ? acct.login : '');

  // ═══ 这一版的说明 ═══
  let notes = $state('');
  let nameEn = $state('');
  let descriptionEn = $state('');
  const form = () => ({ id: plugin.id, notes: notes.trim(), nameEn: nameEn.trim(), descriptionEn: descriptionEn.trim() });
  // 检查结果只对检查那一刻填的内容算数：改了说明就得重查（说明写进 market.json，也在检查范围里）
  const formKey = $derived(JSON.stringify([notes.trim(), nameEn.trim(), descriptionEn.trim()]));

  // ═══ 检查 ═══
  let check = $state(null);       // { report, login, upstream, files, key }
  let checking = $state(false);
  let checkErr = $state('');
  async function runCheck() {
    if (checking) return;
    checking = true; checkErr = '';
    const key = formKey;
    try { const r = await api.post('/api/plugins/community/check', form()); check = { ...r, key }; }
    catch (e) { checkErr = errMsg(e); check = null; }
    finally { checking = false; }
  }
  const rep = $derived(check?.report || null);
  const stale = $derived(!!check && check.key !== formKey);
  const canPublish = $derived(!!rep?.ok && !stale && !!login && !!notes.trim());
  const publishHint = $derived(!login ? t('先登录 GitHub 才能发布。')
    : !notes.trim() ? t('更新说明要写。')
    : !rep ? t('先检查一遍，通过了才能发布。')
    : stale ? t('改过说明了，再检查一遍。')
    : !rep.ok ? t('检查没通过，按上面改完再查。') : '');

  // ═══ 发布 ═══
  let publishing = $state(false);
  let pubErr = $state('');
  async function publish() {
    if (!canPublish || publishing) return;
    const ok = await confirm({
      title: t('发布「{name}」v{v} 到社区？', { name, v: rep.version }),
      desc: t('会以 @{login} 的身份在 GitHub 公开提交拉取请求；自动检查通过后自动上架，所有 bridge 用户都能看到、安装。', { login }),
      yes: t('发布'),
    });
    if (!ok) return;
    publishing = true; pubErr = '';
    try {
      const r = await api.post('/api/plugins/community/publish', form());
      sub = { status: 'checking', pr: r.pr, number: r.number, version: r.version };
      toast(t('已提交拉取请求 #{n}', { n: r.number }));
      scheduleSub();
    } catch (e) {
      pubErr = errMsg(e);
      const r2 = e?.body && typeof e.body === 'object' ? e.body.report : null;
      if (r2) check = { ...(check || {}), report: r2, key: formKey };
    } finally { publishing = false; }
  }

  // ═══ 投稿状态 ═══（面板开着时 15 秒一刷，到上架 / 没通过 / 关闭为止）
  let sub = $state(null);
  let subBusy = $state(false);
  let subTimer = null;
  async function loadSub() {
    if (subBusy) return;
    subBusy = true;
    try { const r = await api.get('/api/plugins/community/submission?id=' + encodeURIComponent(plugin.id)); if (alive) sub = r; }
    catch {}
    finally { subBusy = false; }
    if (alive) scheduleSub();
  }
  function scheduleSub() {
    clearTimeout(subTimer);
    if (sub && sub.status !== 'none' && !subDone(sub.status)) subTimer = setTimeout(loadSub, 15000);
  }
  loadSub();
  const subOn = $derived(!!sub && sub.status && sub.status !== 'none');
  const SUB_NOTE = {
    checking: t('市场仓库正在自动检查；通过后会自动合并上架。'),
    failed: t('自动检查没通过：按下面的报告改完，再「检查」「发布」一次，会更新同一个拉取请求。'),
    merged: t('已合并，等社区索引重新发布；bridge 下次拉到索引后就算上架。'),
    live: t('已经上架，所有 bridge 用户都能在社区市场里看到。'),
    closed: t('拉取请求被关掉了。要重新投稿就再发布一次。'),
    unknown: t('暂时查不到 GitHub 上的状态，稍后自动再查。'),
  };
</script>

<div class="pp-detail">
  <div class="cz-crumb"><button class="cz-back" onclick={onBack}>{@html ic('back', 2)}<span>{name}</span></button></div>
  <div class="cz-dh">
    <div class="cz-dh-tx">
      <h2>{t('发布到社区')}</h2>
      <p>{name}{plugin.version ? ' · v' + plugin.version : ''} · {plugin.id}</p>
    </div>
  </div>
  <p class="cz-lead">{t('把这个插件投稿到 bridge 社区插件市场：用你的 GitHub 账号提交拉取请求，自动检查通过后自动上架，所有 bridge 用户都能看到、安装。没有人工审核。')}</p>

  <!-- 一、账号 -->
  <div class="cz-sec">{t('GitHub 账号')}</div>
  <div class="cz-list">
    {#if acctErr}
      <div class="cz-li"><span class="cz-li-tx"><small class="ps-wrap">{acctErr}</small></span><button class="cz-btn sm" onclick={loadAcct}>{t('重试')}</button></div>
    {:else if !acct}
      <div class="cz-li"><span class="cz-li-tx"><small>{t('载入中…')}</small></span></div>
    {:else if acct.ok}
      <div class="cz-li">
        <span class="cz-li-tx"><span>@{acct.login}</span><small>{VIA[acct.via] || ''}</small></span>
        {#if acct.canLogout}<button class="cz-btn sm" disabled={acctBusy} onclick={logout}>{t('退出')}</button>{/if}
      </div>
    {:else if device}
      <div class="ps-code">
        <span class="ps-code-lab">{t('在 GitHub 上输入这个登录码')}</span>
        <b class="ps-code-v">{device.userCode}</b>
        <div class="ps-code-acts">
          <a class="cz-btn pri" href={device.verificationUri} target="_blank" rel="noopener noreferrer">{t('打开 GitHub')}</a>
          <button class="cz-btn" onclick={copyCode}>{t('复制')}</button>
          <button class="cz-btn" onclick={cancelDevice}>{t('取消')}</button>
        </div>
        <small>{t('等你在 GitHub 上确认…确认后这里自动登录。')}</small>
      </div>
    {:else}
      <div class="cz-li">
        <span class="cz-li-tx"><span>{t('还没登录')}</span>{#if acct.error}<small class="ps-wrap">{tr(acct.error)}</small>{/if}</span>
      </div>
      <div class="cz-li ps-acts">
        {#if acct.deviceLogin}<button class="cz-btn pri" disabled={acctBusy} onclick={startDevice}>{t('用 GitHub 登录')}</button>{/if}
        <button class="cz-btn" disabled={acctBusy} onclick={() => { tokenOpen = !tokenOpen; tokenErr = ''; }}>{t('粘贴令牌')}</button>
      </div>
      {#if tokenOpen}
        <div class="ps-form">
          <label class="cz-lab" for="ps-token">{t('GitHub 令牌')}</label>
          <div class="cz-inrow">
            <input id="ps-token" class="cz-in" type="password" autocomplete="off" spellcheck="false" bind:value={token} placeholder="ghp_…" onkeydown={(e) => { if (e.key === 'Enter') saveToken(); }} />
            <button class="cz-btn pri" disabled={!token.trim() || acctBusy} onclick={saveToken}>{t('保存')}</button>
          </div>
          <small>{t('要有 public_repo 权限（classic 令牌勾 public_repo；细粒度令牌给 Contents 与 Pull requests 写权限）。令牌只存在服务器上，不会再发回浏览器。')}</small>
          {#if tokenErr}<div class="cz-err">{tokenErr}</div>{/if}
        </div>
      {/if}
    {/if}
  </div>
  {#if deviceMsg}<div class="cz-err">{deviceMsg}</div>{/if}
  {#if acct && !acct.ok}<p class="cz-note">{t('这台电脑上用 gh 登录过 GitHub 的话，会自动用那个账号。')}</p>{/if}

  <!-- 二、这一版 -->
  <div class="cz-sec">{t('这一版')}</div>
  <label class="cz-lab" for="ps-notes">{t('更新说明（必填）')}</label>
  <textarea id="ps-notes" class="cz-in ta" rows="3" bind:value={notes} maxlength="2000" placeholder={t('这一版改了什么，装的人会在确认框和版本历史里看到')}></textarea>
  <label class="cz-lab" for="ps-name-en">{t('英文名（选填）')}</label>
  <input id="ps-name-en" class="cz-in" bind:value={nameEn} maxlength="60" placeholder={t('英文界面显示的名称')} />
  <label class="cz-lab" for="ps-desc-en">{t('英文说明（选填）')}</label>
  <textarea id="ps-desc-en" class="cz-in ta" rows="2" bind:value={descriptionEn} maxlength="500" placeholder={t('英文界面显示的说明')}></textarea>
  <p class="cz-note ps-tight">{t('英文名与英文说明留空时，沿用插件目录里 market.json 或上一版投稿写过的。')}</p>

  <div class="pp-actbar">
    <button class="cz-btn" disabled={checking} onclick={runCheck}>{checking ? t('正在检查…') : rep ? t('重新检查') : t('检查')}</button>
    <button class="cz-btn pri" disabled={!canPublish || publishing} onclick={publish}>{publishing ? t('正在发布…') : t('发布')}</button>
  </div>
  {#if publishHint && !publishing}<p class="cz-note ps-tight">{publishHint}</p>{/if}
  {#if checkErr}<div class="cz-err">{checkErr}</div>{/if}
  {#if pubErr}<div class="cz-err">{pubErr}</div>{/if}

  <!-- 三、检查结果 -->
  {#if rep}
    <div class="cz-sec">{t('检查结果')}{#if stale}<span class="ps-stale">{t('（说明改过，结果已过时）')}</span>{/if}</div>
    <div class="cz-list" class:ps-dim={stale}>
      <div class="cz-kv"><span>{t('结论')}</span><b>{rep.ok ? t('通过，可以发布') : t('没通过：{n} 处要改', { n: rep.errors.length })}</b></div>
      {#if rep.version}<div class="cz-kv"><span>{t('版本')}</span><b>v{rep.version}</b></div>{/if}
      {#if rep.kind}<div class="cz-kv"><span>{t('种类')}</span><b>{kindText(rep.kind)}</b></div>{/if}
      {#if rep.kind === 'server'}<div class="cz-kv"><span>{t('检测到的能力')}</span><b>{capsText(rep.caps) || t('没检测到特别的能力')}</b></div>{/if}
      {#if rep.permissions?.length}<div class="cz-kv"><span>{t('声明的权限')}</span><b class="pp-mono">{rep.permissions.join(' · ')}</b></div>{/if}
      {#if check.files}<div class="cz-kv"><span>{t('文件数')}</span><b>{check.files}</b></div>{/if}
    </div>
    {#if rep.kind === 'server'}<p class="cz-note ps-tight">{t('含服务端代码的插件，装的人会看到一个强提示确认，列出上面这些能力。')}</p>{/if}

    {#if rep.errors?.length}
      <div class="cz-sec">{t('要改的')} <span class="cz-n">{rep.errors.length}</span></div>
      <div class="cz-list">
        {#each rep.errors as er, i (i)}
          <div class="cz-li"><span class="cz-li-tx"><span class="ps-msg">{tr(er.message)}</span>{#if er.file}<small class="pp-mono">{er.file}{er.line ? ':' + er.line : ''}</small>{/if}</span></div>
        {/each}
      </div>
    {/if}
    {#if rep.warnings?.length}
      <div class="cz-sec">{t('建议')} <span class="cz-n">{rep.warnings.length}</span></div>
      <div class="cz-list">
        {#each rep.warnings as w, i (i)}
          <div class="cz-li"><span class="cz-li-tx"><span class="ps-msg ps-soft">{tr(w.message)}</span></span></div>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- 四、投稿状态 -->
  {#if subOn}
    <div class="cz-sec">{t('投稿状态')}</div>
    <div class="cz-list">
      <div class="cz-kv"><span>{t('状态')}</span><b>{t('v{v} · {status}', { v: sub.version || '?', status: SUB_TEXT[sub.status] || sub.status })}</b></div>
      {#if sub.pr}<a class="cz-kv link" href={sub.pr} target="_blank" rel="noopener noreferrer"><span>{t('拉取请求')}</span><b>#{sub.number}</b>{@html ic('link')}</a>{/if}
    </div>
    <p class="cz-note ps-tight">{SUB_NOTE[sub.status] || ''}{!subDone(sub.status) ? ' ' + t('每 15 秒自动刷新。') : ''}</p>
    {#if sub.error}<div class="cz-diag">{tr(sub.error)}</div>{/if}
    {#if sub.report}
      <div class="cz-sec">{t('自动检查的报告')}</div>
      <div class="cz-prev"><div class="cz-md">{@html renderMarkdown(sub.report)}</div></div>
    {/if}
    <div class="pp-actbar"><button class="cz-btn sm" disabled={subBusy} onclick={loadSub}>{subBusy ? t('正在刷新…') : t('刷新状态')}</button></div>
  {/if}
</div>

<style>
  .pp-actbar { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .pp-mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 13px; }
  .ps-tight { margin-top: 8px; }
  .ps-wrap { white-space: normal !important; overflow-wrap: anywhere; line-height: 1.45; }
  .ps-acts { flex-wrap: wrap; gap: 8px; }
  .ps-form { padding: 2px 16px 14px; }
  .ps-form small { display: block; margin-top: 8px; font-size: 12.5px; line-height: 1.5; color: var(--cz-ink3); }
  /* 登录码：要对着另一个屏幕抄，字号放大、等宽、字距拉开 */
  .ps-code { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 16px; }
  .ps-code-lab { font-size: 13px; color: var(--cz-ink3); }
  .ps-code-v { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 30px; font-weight: 600; letter-spacing: .14em; line-height: 1.1; user-select: all; }
  .ps-code-acts { display: flex; flex-wrap: wrap; gap: 8px; }
  .ps-code-acts a { text-decoration: none; display: inline-flex; align-items: center; }
  .ps-code small { font-size: 12.5px; color: var(--cz-ink3); }
  .ps-msg { font-size: 14px; font-weight: 400; line-height: 1.5; overflow-wrap: anywhere; }
  .ps-soft { color: var(--cz-ink2); }
  .ps-stale { margin-left: 6px; font-weight: 400; }
  .ps-dim { opacity: .55; }
</style>
