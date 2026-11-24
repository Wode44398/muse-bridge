<script>
  // 社区市场条目的详情（功能扩展页推入的一层，返回与滚动由 PluginsPanel 管）。
  // 社区插件没有人工审核，所以作者、种类与能力、钉在提交上的源码、举报都摆在明面上；装 / 更新 / 换版本交回 onInstall（那边弹风险确认）。
  import { t, tr, isEn } from '../../../lib/i18n.js';
  import { ic } from '../icons.js';
  import { kindText, capsText, githubUser } from './community.js';

  let { x, backLabel = '', busy = false, tile, onBack = () => {}, onInstall = () => {}, onOpenInstalled = () => {} } = $props();

  const name = $derived(isEn() && x.nameEn ? x.nameEn : tr(x.name));
  const desc = $derived(isEn() && x.descriptionEn ? x.descriptionEn : tr(x.description || ''));
  const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round((n || 0) / 1024)) + ' KB');
  const L = $derived(x.latest);
  const canInstall = $derived(!!L && (x.update || x.state === 'none'));
</script>

<div class="pp-detail">
  <div class="cz-crumb"><button class="cz-back" onclick={onBack}>{@html ic('back', 2)}<span>{backLabel || t('功能扩展')}</span></button></div>
  <div class="cz-dh">
    {@render tile(x, true)}
    <div class="cz-dh-tx">
      <h2>{name}</h2>
      <p>{t('社区')}{x.publisher ? ' · @' + x.publisher : ''}{L ? ' · v' + L.version : ''}</p>
    </div>
  </div>
  {#if x.description}<p class="cz-lead">{desc}</p>{/if}

  {#if x.revoked}<div class="cz-diag err">{t('你装的 v{v} 已被社区市场下架：{reason}', { v: x.current, reason: tr(x.revoked.reason || t('没写原因')) })}</div>{/if}
  {#if x.blocked}<div class="cz-diag">{tr(x.blocked)}</div>{/if}
  {#if x.state === 'taken'}<div class="cz-diag">{t('这台服务器上已经有个同 id 的插件（不是从社区市场装的），先卸载或取消登记它才能从社区市场装。')}</div>{/if}

  <div class="pp-actbar">
    {#if canInstall}
      <button class="cz-btn pri" disabled={busy} onclick={() => onInstall(x)}>{busy ? t('正在安装…') : x.state === 'none' ? t('安装 v{v}', { v: L.version }) : t('更新到 v{v}', { v: L.version })}</button>
    {/if}
    {#if x.state === 'installed'}<button class="cz-btn" onclick={() => onOpenInstalled(x)}>{t('打开已装的插件')}</button>{/if}
  </div>
  {#if x.current}<p class="cz-note">{t('已装 v{v}。', { v: x.current })}</p>{/if}
  <p class="cz-note">{t('任何 bridge 用户都能投稿的插件，只经过自动检查，没有人工审核。只装你信得过的作者的。')}</p>

  {#if L}
    <div class="cz-sec">{t('种类与能力')}</div>
    <div class="cz-list">
      <div class="cz-kv"><span>{t('种类')}</span><b>{kindText(L.kind)}</b></div>
      {#if L.kind === 'server'}<div class="cz-kv"><span>{t('检测到的能力')}</span><b>{capsText(L.caps) || t('没检测到特别的能力')}</b></div>{/if}
      {#if L.permissions?.length}<div class="cz-kv"><span>{t('声明的权限')}</span><b class="pp-mono">{L.permissions.join(' · ')}</b></div>{/if}
    </div>
    <p class="cz-note cm-why">{L.kind === 'server'
      ? t('含服务端代码：它以 bridge 的全部权限在这台服务器上运行，能读写服务器上的文件、用你的账号。能力是自动检测出来的，只供参考，不是限制。')
      : t('纯页面：只在沙箱页面里运行，碰不到服务器；用到对话或文件时还会单独问你。')}</p>
  {/if}

  <div class="cz-list pp-gap">
    {#if L?.source}
      <a class="cz-li act" href={L.source} target="_blank" rel="noopener noreferrer"><span class="cz-li-tx"><span>{t('查看源码')}</span><small>{t('钉在 v{v} 的提交上：看到的就是装上的代码', { v: L.version })}</small></span><span class="cz-chev">{@html ic('link')}</span></a>
    {/if}
    {#if x.publisher}
      <a class="cz-li act" href={githubUser(x.publisher)} target="_blank" rel="noopener noreferrer"><span class="cz-li-tx"><span>{t('作者主页')}</span><small>github.com/{x.publisher}</small></span><span class="cz-chev">{@html ic('link')}</span></a>
    {/if}
    {#if x.report}
      <a class="cz-li act danger" href={x.report} target="_blank" rel="noopener noreferrer"><span class="cz-li-tx"><span>{t('举报')}</span><small>{t('恶意代码、冒名、违规内容：在 GitHub 上提交举报')}</small></span><span class="cz-chev">{@html ic('link')}</span></a>
    {/if}
  </div>

  <div class="cz-sec">{t('版本历史')}</div>
  <div class="cz-list">
    {#each x.versions as v (v.version)}
      <div class="cz-li pp-ver">
        <span class="cz-li-tx"><span>v{v.version}{#if v.version === x.current}<span class="pp-tag">{t('当前')}</span>{/if}{#if v.date}<small class="pp-date">{v.date}</small>{/if}</span>
          <small class="pp-wrap">{v.notes ? tr(v.notes) : t('（没写更新说明）')}</small>
          <small>{kindText(v.kind)}{v.kind === 'server' && capsText(v.caps) ? ' · ' + capsText(v.caps) : ''}{v.restart ? ' · ' + t('装完重启生效') : ''} · {kb(v.size)}</small>
          {#if v.problem}<small class="pp-warn">{tr(v.problem)}</small>{/if}</span>
        {#if !v.problem && v.version !== x.current && x.state !== 'taken'}
          <button class="cz-btn sm" disabled={busy} onclick={() => onInstall(x, v.version)}>{t('装这一版')}</button>
        {/if}
      </div>
    {/each}
  </div>
  {#if !x.versions.length}<p class="cz-note">{t('没有可装的版本。')}</p>{/if}

  <div class="cz-sec">{t('信息')}</div>
  <div class="cz-list">
    <div class="cz-kv"><span>ID</span><b>{x.id}</b></div>
    {#if x.author && x.author !== x.publisher}<div class="cz-kv"><span>{t('署名')}</span><b>{x.author}</b></div>{/if}
    {#if x.homepage}<a class="cz-kv link" href={x.homepage} target="_blank" rel="noopener noreferrer"><span>{t('主页')}</span><b>{x.homepage}</b>{@html ic('link')}</a>{/if}
  </div>
</div>

<style>
  /* pp-* 与 PluginsPanel 里同名的一致（样式按组件隔离，只好各写一份） */
  .pp-detail :global(.cz-chev svg) { width: 15px; height: 15px; }
  .cm-why { margin-top: 10px; }
  .pp-actbar { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .pp-gap { margin-top: 16px; }
  /* 外链行用 <a>（新标签页打开），去掉浏览器默认的链接色与下划线，和按钮做的列表项一个样 */
  a.cz-li { color: inherit; text-decoration: none; }
  a.cz-li:hover { background: var(--cz-hover); }
  .pp-ver { display: flex; align-items: center; gap: 12px; }
  .pp-ver .cz-li-tx { flex: 1; min-width: 0; }
  .pp-tag { margin-left: 8px; padding: 1px 7px; border-radius: 6px; background: var(--cz-sel); color: var(--cz-ink2); font-size: 11.5px; font-weight: 500; vertical-align: 1px; }
  .pp-date { margin-left: 8px; color: var(--cz-ink3); font-size: 12px; }
  .pp-warn { color: var(--cz-warn); }
  .pp-mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 13px; }
  .cz-li-tx small.pp-wrap { white-space: normal; overflow-wrap: anywhere; line-height: 1.45; }
</style>
