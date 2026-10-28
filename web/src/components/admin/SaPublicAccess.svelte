<script>
  // 服务控制 · 公网访问：让手机、朋友从外网打开这台服务端（服务端自己托管 cloudflared，见 src/runtime/public-access.mjs）。
  // 四种方式：关闭 / 临时地址（trycloudflare，免注册）/ Cloudflare 隧道（自己的域名，贴隧道令牌）/ 自己的域名（已有反向代理，只填地址）。
  // 文案按「普通开服者」写：不假设看过部署文档。令牌只往服务端写，回包里从来没有它（hasToken 只说有没有）。
  // 刷新：状态变化服务端经总线推（ServerAdmin 里订阅）；这里另按状态轮询——启动中 / 下载中 4 秒、平时 20 秒，页面在后台不拉。
  import { untrack } from 'svelte';
  import { sa, loadPublicAccess, applyPublicAccess, restartPublicAccess, saToast, saConfirm, fmtAgo, pageVisible } from '../../lib/serverAdmin.svelte.js';
  import { t, tc, tr } from '../../lib/i18n.js';

  const pa = $derived(sa.publicAccess);
  const port = $derived(pa?.port || sa.overview?.phonePort || 8787);
  const MODES = [
    ['off', tc('public-access', '关闭')],
    ['quick', t('临时地址（试用，重启会换）')],
    ['token', t('Cloudflare 隧道')],
    ['manual', t('自己的域名')],
  ];
  let pick = $state('');            // 正在改成的方式（'' = 就是当前方式）
  const sel = $derived(pick || pa?.mode || 'off');
  let tokenIn = $state('');
  let urlIn = $state('');
  let busy = $state(false);
  let logsOpen = $state(false);
  const locked = $derived(!!pa?.managedBy?.locked);
  const unavailable = $derived(pa && pa.available === false);
  const tunnelMode = (k) => k === 'quick' || k === 'token';
  // 锁住的外部托管（本机脚本 / muse-tunnel）：除了「关闭」都不能选——手填的对外地址也会改掉设备拿到的地址和分享链接
  const lockedOut = (k) => locked && k !== 'off';

  $effect(() => { sa.tick; untrack(loadPublicAccess); });
  $effect(() => {
    const fast = pa?.status === 'starting' || pa?.cloudflared?.downloading;
    const timer = setInterval(() => { if (pageVisible()) loadPublicAccess(); }, fast ? 4000 : 20000);
    return () => clearInterval(timer);
  });

  function choose(k) {
    if (busy || unavailable || lockedOut(k)) return;
    pick = k === pa?.mode ? '' : k;
    urlIn = pa?.configuredUrl || '';
    tokenIn = '';
  }
  // 当前方式下改参数（命名隧道换令牌 / 改地址、自己的域名改地址）也走同一个表单
  const editing = $derived(!!pick || sel === 'token' || sel === 'manual');
  // 已保存的对外地址变了（刚保存 / 首次读到）才回填输入框；用户清空输入框不会被轮询顶回去
  const savedUrl = $derived(pa?.configuredUrl || '');
  $effect(() => { const u = savedUrl; untrack(() => { urlIn = u; }); });

  const BADGE = { running: ['green', t('已连通')], starting: ['amber', t('启动中')], error: ['red', t('有问题')], stopped: ['gray', t('未开启')] };
  // 隧道归外部托管（维护者的本机脚本、系统服务、cloudflared 的 Windows 服务）而这里是 off：机器其实正经外部隧道对外服务，
  // 别显示灰色「未开启」和「只能在局域网打开」，徽标中性、说明见上面的提示
  const extManaged = $derived(!!pa?.managedBy && pa?.mode === 'off');
  const badge = $derived(extManaged ? ['blue', t('外部托管')] : (BADGE[pa?.status] || BADGE.stopped));

  async function apply() {
    const k = sel;
    const body = { mode: k };
    if (k === 'token') { if (tokenIn.trim()) body.token = tokenIn.trim(); body.url = urlIn.trim(); }
    if (k === 'manual') body.url = urlIn.trim();
    if (k === 'token' && !body.token && !pa?.hasToken) { saToast(t('先粘贴隧道令牌'), true); return; }
    if (k === 'manual' && !body.url) { saToast(t('先填对外地址'), true); return; }
    const cur = pa?.mode || 'off';
    if (k === 'off' && cur !== 'off') {
      if (!(await saConfirm(t('关闭公网访问？'), t('关掉后只能在这台机器上或同一局域网里打开；正经这个地址连着的手机、网页会断开。'), { yes: tc('public-access-confirm', '关闭'), danger: true }))) return;
    } else if (k !== cur && tunnelMode(cur) && pa?.url) {
      if (!(await saConfirm(t('换一种公网访问方式？'), t('现在的地址 {url} 会停用，手机 App 里的服务器地址要跟着改。', { url: pa.url }), { yes: t('切换') }))) return;
    }
    busy = true;
    try {
      await applyPublicAccess(body);
      pick = ''; tokenIn = '';
      saToast(k === 'off' ? t('已关闭公网访问') : k === 'quick' ? t('正在申请临时地址…') : k === 'token' ? t('正在连接 Cloudflare…') : t('已保存'));
    } catch (e) { saToast(tr(e?.message) || t('保存失败'), true); }
    busy = false;
  }

  async function restart() {
    if (pa?.mode === 'quick' && !(await saConfirm(t('重启临时地址？'), t('快速隧道一重启就换一个新地址，大约要等 20 秒：新地址连上后先推给在线的手机 App，它们会自动换过去，然后才停用旧地址；网页和分享出去的链接要手动改成新地址。'), { yes: t('重启') }))) return;
    // 重启走先接后拆：接口要等新隧道连上（临时地址再多留 15 秒给在线设备换地址）才回，所以先说一声在干什么，换完再报结果
    const mode = pa?.mode;
    busy = true;
    saToast(mode === 'manual' ? t('正在重新检查…') : mode === 'quick' ? t('正在换新地址，大约要等 20 秒…') : t('正在重启隧道…'));
    try {
      await restartPublicAccess();
      if (mode === 'quick') saToast(t('已换成新地址'));
      else if (mode === 'token') saToast(t('隧道已重启'));
    }
    catch (e) { saToast(tr(e?.message) || t('重启失败'), true); }
    busy = false;
  }

  function copy(text) { navigator.clipboard?.writeText(text).then(() => saToast(t('地址已复制'))).catch(() => saToast(t('复制失败'), true)); }

  // lastProbe 恒是对象，at === 0 = 还没探过（关着、刚起的宽限期里、刚切模式）
  const probeLine = $derived(!pa?.lastProbe?.at ? (pa?.url ? t('还没检查') : '—')
    : pa.lastProbe.ok ? t('能打开 · {ms} ms · {ago}', { ms: pa.lastProbe.ms, ago: fmtAgo(pa.lastProbe.at) })
    : t('打不开：{error} · {ago}', { error: tr(pa.lastProbe.error) || '?', ago: fmtAgo(pa.lastProbe.at) }));
  const cfLine = $derived(!pa ? '' : pa.cloudflared?.downloading ? t('正在下载 {pct}%', { pct: pa.cloudflared.progress || 0 })
    : pa.cloudflared?.available ? 'cloudflared ' + (pa.cloudflared.version || '')
    : t('还没装（开启隧道时自动下载 {v}）', { v: pa.cloudflared?.pinned || '' }));

  const DESC = $derived({
    off: pa?.managedBy
      ? t('这里不另开隧道：这台机器的外网访问由{label}负责，它的状态在这里看不到、也不由这里管。', { label: tr(pa.managedBy.label) })
      : t('只能在这台机器上，或同一局域网里用 http://局域网地址:{port} 打开。', { port }),
    quick: t('不用注册，马上得到一个 https://….trycloudflare.com 地址，只适合试用：服务端或隧道每次重启都会换地址（连过的手机 App 会自动跟过去，网页和分享链接要手动改），Cloudflare 也不保证它的可用性。长期使用请换成自己的域名。'),
    token: t('用你托管在 Cloudflare 的域名，地址固定。在 Cloudflare 控制台 Zero Trust → Networks → Tunnels 新建一条隧道，把令牌粘到下面；再给这条隧道加一个 Public Hostname，服务填 http://localhost:{port}。', { port }),
    manual: t('你已经用 Nginx、Caddy 之类把域名转到这台机器的 {port} 端口（要支持长连接）。这里只记下对外地址，用来生成分享链接和扫码登录，并定时检查能不能打开。', { port }),
  });
  const actLabel = $derived(sel === 'off' ? t('关闭公网访问') : sel === 'quick' ? t('开启临时地址') : sel === 'token' ? t('保存并连接') : t('保存'));
  const showAct = $derived(sel !== (pa?.mode || 'off') || sel === 'token' || sel === 'manual');
</script>

<div class="sa-card">
  <div class="sa-card-h">
    <span>{t('公网访问')}</span>
    {#if pa}<span class="sa-badge {badge[0]}">{#if pa.status === 'running'}<span class="sa-live"></span>{/if}{badge[1]}</span>{/if}
    <span class="sa-sp"></span>
    {#if pa && pa.mode !== 'off' && !locked && !unavailable}
      <button class="sa-btn sm" disabled={busy} onclick={restart}>{busy ? t('处理中…') : pa.mode === 'manual' ? t('重新检查') : t('重新启动')}</button>
    {/if}
  </div>

  {#if !pa}
    <div class="sa-empty">{t('读取中…')}</div>
  {:else}
    <div class="hint">{tr(pa.hint)}</div>

    <div class="sa-rows">
      {#if pa.url}
        <div class="sa-row">
          <span class="sa-row-tx">{t('对外地址')}<small class="sa-mono sel-text">{pa.url}</small></span>
          <button class="sa-btn sm ghost" onclick={() => copy(pa.url)}>{t('复制')}</button>
          <a class="sa-btn sm ghost" href={pa.url} target="_blank" rel="noopener noreferrer">{t('打开')}</a>
        </div>
      {/if}
      {#if pa.mode !== 'off'}
        <div class="sa-row">
          <span class="sa-row-tx">{t('从外网检查')}<small>{probeLine}</small></span>
        </div>
      {/if}
      {#if tunnelMode(sel) || tunnelMode(pa.mode)}
        <div class="sa-row">
          <span class="sa-row-tx">{t('隧道程序')}<small class="sa-trunc" title={pa.cloudflared?.path || ''}>{cfLine}</small></span>
        </div>
      {/if}
    </div>

    {#if !unavailable}
      <div class="modes">
        <div class="sa-chips">
          {#each MODES as [k, label] (k)}
            <button class="sa-chip-btn" class:on={sel === k} disabled={busy || lockedOut(k)} onclick={() => choose(k)}>
              {label}{#if k === pa.mode}<em class="cur">{t('当前')}</em>{/if}
            </button>
          {/each}
        </div>
        <p class="desc">{DESC[sel]}</p>

        {#if editing && sel === 'token'}
          <label class="sa-lab" for="pa-token">{t('隧道令牌')}</label>
          <input id="pa-token" class="sa-in sa-mono tok" type="password" autocomplete="off" spellcheck="false" bind:value={tokenIn}
            placeholder={pa.hasToken ? t('已保存（要换才重新粘贴）') : t('eyJ 开头的一长串；整条安装命令粘进来也行')} />
          <label class="sa-lab" for="pa-url">{t('对外地址（可不填，连上后自动识别）')}</label>
          <input id="pa-url" class="sa-in sa-mono" type="url" autocomplete="off" spellcheck="false" bind:value={urlIn} placeholder="https://bridge.example.com" />
        {:else if editing && sel === 'manual'}
          <label class="sa-lab" for="pa-url2">{t('对外地址')}</label>
          <input id="pa-url2" class="sa-in sa-mono" type="url" autocomplete="off" spellcheck="false" bind:value={urlIn} placeholder="https://bridge.example.com" />
        {/if}

        {#if showAct && !lockedOut(sel)}
          <div class="acts">
            {#if pick}<button class="sa-btn sm" disabled={busy} onclick={() => { pick = ''; tokenIn = ''; }}>{t('取消')}</button>{/if}
            <button class="sa-btn sm {sel === 'off' ? 'dgr' : 'pri'}" disabled={busy} onclick={apply}>{busy ? t('处理中…') : actLabel}</button>
          </div>
        {/if}
      </div>
    {/if}

    {#if pa.log?.length}
      <div class="logh">
        <span class="sa-dim">{t('隧道日志')}</span>
        <span class="sa-sp"></span>
        <button class="sa-btn sm ghost" onclick={() => { logsOpen = !logsOpen; if (logsOpen) loadPublicAccess(); }}>{logsOpen ? t('收起') : t('展开')}</button>
      </div>
      {#if logsOpen}
        <div class="logs sel-text">
          {#each pa.log as l, i (i)}<div class="ln" class:le={/\bERR\b|失败|出错/.test(l)} class:lw={/\bWRN\b/.test(l)}>{l}</div>{/each}
        </div>
      {/if}
    {/if}
  {/if}
  <div style="height:12px"></div>
</div>

<style>
  .hint { padding: 8px 18px 2px; font-size: 12.5px; line-height: 1.55; color: var(--sa-tx2); }
  .modes { padding: 6px 18px 0; display: flex; flex-direction: column; gap: 10px; }
  .modes .sa-chips { flex-wrap: wrap; }
  .modes .sa-chip-btn:disabled { opacity: .38; cursor: default; }
  .cur { font-style: normal; font-size: 10.5px; margin-left: 6px; opacity: .7; }
  .desc { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--sa-tx3); }
  .sa-in { height: 40px; font-size: 13px; }
  .tok { letter-spacing: .5px; }
  .acts { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
  .sa-rows a.sa-btn { text-decoration: none; display: inline-flex; align-items: center; }
  .logh { display: flex; align-items: center; gap: 8px; padding: 12px 18px 0; font-size: 12.5px; }
  .logs { margin: 8px 18px 0; max-height: 300px; overflow: auto; padding: 10px 12px; border-radius: 12px; background: var(--sa-code);
    font-family: var(--sa-mono); font-size: 11px; line-height: 1.55; color: var(--sa-tx2); }
  .ln { white-space: pre-wrap; word-break: break-all; }
  .ln.lw { color: var(--sa-warn); }
  .ln.le { color: var(--sa-red); }
  /* 窄屏：地址行的按钮换到下一行，别把地址挤没 */
  @media (max-width: 560px) {
    .sa-row { flex-wrap: wrap; }
    .sa-row .sa-row-tx { flex-basis: 100%; }
  }
</style>
