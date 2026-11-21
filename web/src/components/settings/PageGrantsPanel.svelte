<script module>
  // 「页面权限」分区的图标：一面盾牌里一个勾。SI 里没有这一枚（同 HomeLayoutPanel 的 HOME_GLYPH），
  // 两套设置外壳的侧栏 / 根页行都从这里取，同 SI 的画法（24 格、描边、由外壳的 svgOf 包 <svg>）。
  export const PAGE_GRANTS_GLYPH = '<path d="M12 3.5 5.5 6v5.6c0 4.1 2.7 7.3 6.5 8.9 3.8-1.6 6.5-4.8 6.5-8.9V6z"/><path d="m9.2 12.2 2 2 3.8-3.9"/>';
</script>

<script>
  // 设置 ›「页面权限」：插件页面经授权框拿到的权限，一个插件一组，逐项能撤。
  // 授权是「这个使用者 × 这个插件」的（主机、成员各管各的），所以主机和成员、单页模式都有这一页。
  // 数据：GET /api/plugins/grants → { plugins: [{ plugin, pluginName, declared: [{ id, label }], granted: { perm: iso } }] }
  //       只列这个人能用、而且声明了页面权限的插件；没授过的权限也列出来（写「没有允许」），人看得到这个插件会问哪些。
  // 撤销：POST /api/plugins/grants { plugin, perm, allow: false }。撤 page.files 先确认——已经交给页面的文件句柄随之失效，
  //       页面里开着的文件会读写不了，人得知道这一下的后果。
  // 别处授了 / 撤了（授权框、另一台设备）：服务端发 plugins.grants 总线事件（只发给这个人），收到就重拉；
  //       插件装卸、开关（plugins.changed）同样影响列表，一并重拉。
  // 两种样子：touch 照抄 Settings.svelte 的 .ig / .r 分组卡（同 HomeLayoutPanel 的做法）；desktop 用桌面套件 DGroup / DRow / DButton。
  import { untrack } from 'svelte';
  import { api } from '../../lib/api.js';
  import { ui } from '../../lib/state.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { pageGrantsNav } from '../../lib/pageGrantsNav.svelte.js';
  import { busOn } from '../../lib/bus.js';
  import { t, tc, tr } from '../../lib/i18n.js';
  import { relTime } from '../../lib/format.js';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import DGroup from '../../desktop/kit/DGroup.svelte';
  import DRow from '../../desktop/kit/DRow.svelte';
  import DButton from '../../desktop/kit/DButton.svelte';

  let { variant = 'touch' } = $props();

  // 从应用页直达、连设置一起打开的：系统返回一步收起设置回到应用（见 lib/pageGrantsNav）。标记读完即清；
  // 人在设置里退出这一页时面板卸载，这一层跟着撤掉，之后的返回照常逐级走
  const landed = untrack(() => pageGrantsNav.landing);
  pageGrantsNav.landing = false;
  $effect(() => (landed ? pushBackLayer(() => { ui.settingsOpen = false; }) : undefined));

  let list = $state(null);     // null = 还没拉到
  let err = $state('');
  let busy = $state('');       // 正在撤的那一项 'plugin\u0000perm'：按钮先灰掉，防连点
  let seq = 0;

  function errText(e) {
    const raw = e?.body && typeof e.body === 'object' ? e.body.error : typeof e?.body === 'string' ? e.body : '';
    const msg = tr(String(raw || '')).slice(0, 200);
    if (msg) return msg;
    if (e?.status) return t('服务器返回 {code}', { code: e.status });
    return t('网络连接失败');
  }

  // 只认这一形状，别的字段一概不带进界面（服务端旧版本 / 半截回包时也不炸）
  function clean(r) {
    const arr = Array.isArray(r?.plugins) ? r.plugins : [];
    return arr.filter((p) => p && typeof p.plugin === 'string').map((p) => ({
      plugin: p.plugin,
      name: String(p.pluginName || p.plugin),
      declared: (Array.isArray(p.declared) ? p.declared : []).filter((d) => d && typeof d.id === 'string')
        .map((d) => ({ id: d.id, label: tr(String(d.label || d.id)) })),
      granted: p.granted && typeof p.granted === 'object' ? p.granted : {},
    }));
  }

  // 后发的请求为准：总线事件连着来几条时，先回来的旧结果不覆盖后回来的新结果
  async function load() {
    const my = ++seq;
    try {
      const r = await api.get('/api/plugins/grants');
      if (my !== seq) return;
      list = clean(r);
      err = '';
    } catch (e) {
      if (my !== seq) return;
      err = errText(e);
    }
  }
  load();
  $effect(() => busOn((ev) => {
    if (ev?.type === 'plugins.grants' || ev?.type === 'plugins.changed') untrack(() => load());
  }));

  const keyOf = (p, d) => p.plugin + '\u0000' + d.id;
  const grantedAt = (p, d) => {
    const iso = p.granted[d.id];
    if (!iso) return 0;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : 1;   // 时间认不出也算允许过（只是不写多久以前）
  };
  function subOf(p, d) {
    const at = grantedAt(p, d);
    if (!at) return t('没有允许');
    return at > 1 ? t('{when}允许', { when: relTime(at) }) : t('已允许');
  }
  const fullTime = (p, d) => {
    const at = grantedAt(p, d);
    return at > 1 ? new Date(at).toLocaleString() : '';
  };
  // 声明了页面权限的才列（服务端已经滤过，这里再兜一道）
  const shown = $derived(list ? list.filter((p) => p.declared.length) : []);

  async function revoke(p, d) {
    const k = keyOf(p, d);
    if (busy) return;
    if (d.id === 'page.files') {
      const ok = await uiConfirm(t('撤销「{name}」的文件权限？', { name: p.name }), {
        detail: t('已经交给页面的文件随之失效：页面里开着的文件读写不了，要再用得重新经你同意。'),
        okLabel: tc('权限', '撤销'), danger: true,
      });
      if (!ok) return;
    }
    busy = k;
    try {
      await api.post('/api/plugins/grants', { plugin: p.plugin, perm: d.id, allow: false });
      // 先在本地划掉（总线事件可能晚到或断着），再以服务端为准重拉
      const cur = list?.find((x) => x.plugin === p.plugin);
      if (cur) { const g = { ...cur.granted }; delete g[d.id]; cur.granted = g; }
      load();
    } catch (e) {
      showToast(t('没能撤销：{msg}', { msg: errText(e) }), 'err');
    } finally {
      busy = '';
    }
  }

  const FOOT = t('插件页面以你的身份和 Claude 对话、读写你选的文件之前，都要先经你同意。撤销以后页面再要用，会重新问你。');
  const EMPTY = t('没有要过页面权限的插件');
  const EMPTY_SUB = t('装了会向你要权限的插件以后，它们会列在这里。');
</script>

{#if variant === 'desktop'}
  {#if list === null}
    <DGroup label={t('页面权限')}>
      {#if err}
        <DRow title={t('没能读到页面权限')} sub={err}>
          {#snippet trailing()}<DButton size="sm" onclick={load}>{t('重试')}</DButton>{/snippet}
        </DRow>
      {:else}
        <DRow title={t('加载中…')} />
      {/if}
    </DGroup>
  {:else if !shown.length}
    <DGroup label={t('页面权限')} foot={FOOT}>
      <DRow title={EMPTY} sub={EMPTY_SUB} />
    </DGroup>
  {:else}
    {#each shown as p, i (p.plugin)}
      <DGroup label={p.name} foot={i === shown.length - 1 ? FOOT : ''}>
        {#each p.declared as d (d.id)}
          {@const k = keyOf(p, d)}
          <DRow title={d.label} sub={subOf(p, d)}>
            {#snippet trailing()}
              {#if grantedAt(p, d)}
                <span title={fullTime(p, d)}><DButton size="sm" variant="danger" disabled={busy === k} onclick={() => revoke(p, d)}>{tc('权限', '撤销')}</DButton></span>
              {/if}
            {/snippet}
          </DRow>
        {/each}
      </DGroup>
    {/each}
  {/if}
{:else}
  <div class="pg">
    {#if list === null}
      <div class="ig">
        {#if err}
          <div class="r"><span class="r-main"><span class="r-tx"><span class="r-nm">{t('没能读到页面权限')}</span><span class="r-sub">{err}</span></span></span></div>
          <button class="r" type="button" onclick={load}><span class="r-main center"><span class="r-tx accent">{t('重试')}</span></span></button>
        {:else}
          <div class="r"><span class="r-main"><span class="r-tx r-sub">{t('加载中…')}</span></span></div>
        {/if}
      </div>
    {:else if !shown.length}
      <div class="empty">
        <span class="empty-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">{@html PAGE_GRANTS_GLYPH}</svg></span>
        <p class="empty-t">{EMPTY}</p>
        <p class="empty-s">{EMPTY_SUB}</p>
      </div>
      <p class="gfoot">{FOOT}</p>
    {:else}
      {#each shown as p (p.plugin)}
        <p class="ghead">{p.name}</p>
        <div class="ig">
          {#each p.declared as d (d.id)}
            {@const k = keyOf(p, d)}
            {@const on = !!grantedAt(p, d)}
            <div class="r">
              <span class="r-main">
                <span class="r-tx"><span class="r-nm">{d.label}</span><span class="r-sub">{subOf(p, d)}</span></span>
                {#if on}
                  <button class="rv" type="button" disabled={busy === k} onclick={() => revoke(p, d)}>{tc('权限', '撤销')}</button>
                {/if}
              </span>
            </div>
          {/each}
        </div>
      {/each}
      <p class="gfoot">{FOOT}</p>
    {/if}
  </div>
{/if}

<style>
  /* —— touch：照抄 Settings.svelte 的 .ig / .r / .ghead / .gfoot（同尺寸、同令牌，同 HomeLayoutPanel） —— */
  .ghead { margin: 0; padding: 0 16px 8px; font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: .2px; color: var(--i-label2);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ig { position: relative; background: var(--i-card); border-radius: 18px; overflow: hidden; margin-bottom: 26px;
    box-shadow: inset 0 0 0 .5px var(--i-label4); transition: background-color 240ms var(--ea-fade); }
  .ig:has(+ .gfoot) { margin-bottom: 0; }
  .gfoot { margin: 0; padding: 8px 16px 24px; font-size: 12.5px; line-height: 18px; color: var(--i-label2); }
  .r {
    position: relative; display: flex; align-items: center; gap: 14px; width: 100%; min-height: 50px; padding: 0 16px;
    border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent;
    transition: background-color 260ms var(--ea-fade), opacity 200ms var(--ea-fade);
  }
  div.r { cursor: default; }
  button.r:active:not(:disabled) { background: var(--i-press); transition-duration: 60ms; }
  .r-main { position: relative; flex: 1; min-width: 0; align-self: stretch; display: flex; align-items: center; gap: 10px; min-height: 50px; padding: 12px 0; }
  .r + .r .r-main::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 1px; background: var(--i-sep); }
  .r-main.center { justify-content: center; text-align: center; }
  .r-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 16px; line-height: 22px; letter-spacing: -.1px; }
  .r-main.center .r-tx { flex: none; align-items: center; }
  .r-tx.accent { color: var(--i-accent); font-weight: 600; }
  .r-nm, .r-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .r-sub { font-size: 13px; line-height: 18px; letter-spacing: 0; color: var(--i-label2); }
  /* 撤销：红字浅底小胶囊（危险但不刺眼，同 iOS 列表里的破坏性次要按钮） */
  .rv { flex: none; height: 32px; padding: 0 14px; border: 0; border-radius: 16px; font: inherit; font-size: 14px; font-weight: 600;
    background: color-mix(in srgb, var(--i-red) 12%, transparent); color: var(--i-red); cursor: pointer;
    -webkit-tap-highlight-color: transparent; transition: background-color 200ms var(--ea-fade), opacity 200ms; }
  .rv:active:not(:disabled) { background: color-mix(in srgb, var(--i-red) 22%, transparent); }
  .rv:disabled { opacity: .4; cursor: default; }
  /* 空状态：一张卡里居中一枚线稿 + 两行字，不画彩色装饰 */
  .empty { background: var(--i-card); border-radius: 18px; box-shadow: inset 0 0 0 .5px var(--i-label4);
    display: flex; flex-direction: column; align-items: center; text-align: center; padding: 28px 24px 24px; }
  .empty-ico { width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
    background: var(--i-fill4); color: var(--i-label2); margin-bottom: 12px; }
  .empty-ico svg { width: 24px; height: 24px; display: block; }
  .empty-t { margin: 0; font-size: 16px; line-height: 22px; font-weight: 600; color: var(--i-label); }
  .empty-s { margin: 4px 0 0; font-size: 13px; line-height: 18px; color: var(--i-label2); }
  .empty:has(+ .gfoot) { margin-bottom: 0; }
</style>
