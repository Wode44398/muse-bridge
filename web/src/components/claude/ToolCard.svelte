<script>
  // 插件工具的结果卡片（工具 spec 写 render:'card'，数据形状与清洗见 lib/toolCard.js）：
  // 标题 / 副标题 / 字段表 / 图片 / 一段 markdown / 一个链接，左缘一道 tone 色（ok 绿 / warn 黄 / error 红 / info 蓝）。
  // markdown 走项目统一的渲染（lib/md.js：marked + DOMPurify），链接点击走 onMdClick（外链交系统浏览器、路径不让页面跳走）。
  import { renderMarkdown } from '../../lib/md.js';
  import { onMdClick } from '../../lib/linkNav.js';
  import { apiUrl } from '../../lib/server.js';
  import { openExternalUrl } from '../../lib/pluginUi.svelte.js';
  import { t } from '../../lib/i18n.js';

  let { card } = $props();
  const imgSrc = $derived(card.image ? (/^\/(?!\/)/.test(card.image) ? apiUrl(card.image) : card.image) : '');
  const md = $derived(card.markdown ? renderMarkdown(card.markdown) : '');
  let imgFailed = $state(false);
</script>

<div class="tc sel-text" data-tone={card.tone || null}>
  {#if card.title || card.subtitle}
    <div class="tc-head">
      {#if card.title}<div class="tc-title">{card.title}</div>{/if}
      {#if card.subtitle}<div class="tc-sub">{card.subtitle}</div>{/if}
    </div>
  {/if}
  {#if imgSrc && !imgFailed}
    <img class="tc-img" src={imgSrc} alt={card.title || ''} loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror={() => (imgFailed = true)} />
  {/if}
  {#if card.fields.length}
    <dl class="tc-fields">
      {#each card.fields as f, i (i)}
        <div class="tc-f"><dt>{f.label}</dt><dd>{f.value}</dd></div>
      {/each}
    </dl>
  {/if}
  {#if md}
    <!-- 链接点击委托（md 里的 <a> 本身可聚焦、可回车），容器只是转交 -->
    <div class="tc-md" role="presentation" onclick={(e) => onMdClick(e)}>{@html md}</div>
  {/if}
  {#if card.link}
    <button class="tc-link" type="button" onclick={() => openExternalUrl(card.link.url)}>
      <span>{card.link.label || t('打开链接')}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4.5h5.5V10M19.5 4.5l-8.5 8.5"/><path d="M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18V8a1.5 1.5 0 0 1 1.5-1.5H10"/></svg>
    </button>
  {/if}
</div>

<style>
  /* 与工具行展开卡同一套外壳（1px 描边、r8），左缘 3px 色条按 tone 着色 */
  .tc {
    position: relative; margin: 8px 0 4px; padding: 11px 13px 12px 15px; border-radius: 10px; min-width: 0; max-width: 560px;
    box-shadow: 0 0 0 1px var(--divider); background: var(--card, transparent); overflow: hidden;
    display: flex; flex-direction: column; gap: 9px;
  }
  .tc::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--tc-tone, transparent); }
  .tc[data-tone="ok"] { --tc-tone: var(--ok); }
  .tc[data-tone="warn"] { --tc-tone: var(--warn); }
  .tc[data-tone="error"] { --tc-tone: var(--crit); }
  .tc[data-tone="info"] { --tc-tone: #4a8fd8; }
  .tc-head { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .tc-title { font-size: 15px; line-height: 21px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
  .tc-sub { font-size: 13px; line-height: 18px; color: var(--muted); overflow-wrap: anywhere; }
  .tc-img { display: block; max-width: 100%; max-height: 260px; width: auto; height: auto; border-radius: 8px; object-fit: contain; align-self: flex-start; background: var(--hover); }
  /* 字段表：窄屏一列、宽了两列；标签灰小字在上、值在下 */
  .tc-fields { margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(120px, 100%), 1fr)); gap: 8px 16px; }
  .tc-f { min-width: 0; }
  .tc-f dt { font-size: 11.5px; line-height: 16px; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .tc-f dd { margin: 1px 0 0; font-size: 14px; line-height: 20px; color: var(--text); overflow-wrap: anywhere; }
  .tc-md { font-size: 14px; line-height: 1.65; color: var(--text); min-width: 0; overflow-wrap: break-word; }
  .tc-md :global(p) { margin: 0 0 8px; }
  .tc-md :global(p:last-child) { margin-bottom: 0; }
  .tc-md :global(ul), .tc-md :global(ol) { margin: 0 0 8px; padding-left: 20px; }
  .tc-md :global(a) { color: var(--coral); }
  .tc-md :global(code) { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: .9em; }
  .tc-md :global(:not(pre) > code) { background: var(--hover); padding: 1px 5px; border-radius: 5px; }
  .tc-md :global(pre) { background: var(--hover); border-radius: 8px; padding: 9px 11px; overflow-x: auto; margin: 0 0 8px; }
  .tc-md :global(img) { max-width: 100%; border-radius: 8px; }
  .tc-link {
    align-self: flex-start; max-width: 100%; display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 8px;
    font-size: 13px; color: var(--text); background: var(--hover); min-width: 0;
  }
  .tc-link span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
  .tc-link svg { width: 14px; height: 14px; flex: none; color: var(--muted); }
  .tc-link:active { background: var(--hover-strong); }
  @media (hover: hover) { .tc-link:hover { background: var(--hover-strong); } }
</style>
