<script>
  // markdown 积木：{ text }。走 lib/md.js 的 renderMarkdown（marked + DOMPurify 净化、宽表格套横滚壳、代码块带复制钮），
  // 插件给的 markdown 和模型回复一样当不可信内容处理。
  // 链接：一律拦下来走 openExternalUrl（http(s) 外部打开、/ 开头按服务器地址补全）；别的写法（相对路径、javascript: 等）不跳。
  // '#id' 也要拦：放给浏览器会压一条历史、触发 popstate，nav.js 当成系统返回把整个应用页关掉；改成在本积木里找到目标滚过去。
  import { renderMarkdown } from '../../lib/md.js';
  import { openExternalUrl } from '../../lib/pluginUi.svelte.js';
  let { block } = $props();
  let el = $state(null);
  const html = $derived(renderMarkdown(block.text || ''));

  function onclick(e) {
    const a = e.target?.closest?.('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    e.preventDefault();
    if (href.startsWith('#')) { jump(href.slice(1)); return; }
    if (/^https?:\/\//i.test(href) || /^\/(?!\/)/.test(href)) openExternalUrl(href);
  }

  function jump(raw) {
    let id = raw;
    try { id = decodeURIComponent(raw); } catch {}
    if (!id || !el) return;
    const esc = window.CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    el.querySelector('[id="' + esc + '"], a[name="' + esc + '"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="md" bind:this={el} {onclick}>{@html html}</div>

<style>
  /* 正文排版：字号同 text 积木（--av-fs），段距 / 标题 / 列表 / 代码 / 引用 / 表格按卡片语汇收一套；
     全局 reset 把 margin / padding 清零了，这里得一样样补回来 */
  .md {
    padding: 0 var(--av-px); font-size: var(--av-fs); line-height: var(--av-lh); color: var(--av-ink); overflow-wrap: anywhere;
    --md-codecopy-bg: var(--av-card);
  }
  .md > :global(:first-child) { margin-top: 0; }
  .md > :global(:last-child) { margin-bottom: 0; }
  .md :global(p) { margin: 0 0 .7em; }
  .md :global(h1), .md :global(h2), .md :global(h3), .md :global(h4), .md :global(h5), .md :global(h6) {
    margin: 1.1em 0 .45em; font-weight: 650; letter-spacing: -.2px; line-height: 1.3;
  }
  .md :global(h1) { font-size: 1.4em; }
  .md :global(h2) { font-size: 1.22em; }
  .md :global(h3) { font-size: 1.08em; }
  .md :global(h4), .md :global(h5), .md :global(h6) { font-size: 1em; }
  .md :global(ul), .md :global(ol) { margin: 0 0 .7em; padding-left: 1.4em; }
  .md :global(li) { margin: .2em 0; }
  .md :global(li > p) { margin: 0; }
  .md :global(a) { color: inherit; text-decoration: underline; text-decoration-color: var(--av-ink3); text-underline-offset: 2px; }
  .md :global(a:hover) { text-decoration-color: currentColor; }
  .md :global(strong) { font-weight: 650; }
  .md :global(hr) { height: 1px; border: 0; margin: 1em 0; background: var(--av-sep); }
  .md :global(blockquote) { margin: 0 0 .7em; padding: 2px 0 2px 12px; border-left: 2px solid var(--av-sep); color: var(--av-ink2); }
  .md :global(code) {
    font-family: var(--mono, ui-monospace, "SF Mono", Consolas, monospace); font-size: .88em;
    padding: .1em .35em; border-radius: 5px; background: var(--av-fill2);
  }
  .md :global(pre) {
    margin: 0 0 .7em; padding: 10px 12px; border-radius: var(--av-r-sm); overflow-x: auto;
    background: var(--av-card); box-shadow: var(--av-hair); font-size: .9em; line-height: 1.5;
  }
  .md :global(pre code) { padding: 0; background: none; font-size: 1em; }
  .md :global(table) { border-collapse: collapse; font-size: .94em; }
  .md :global(th), .md :global(td) { padding: 6px 10px; border-bottom: 1px solid var(--av-sep); text-align: left; vertical-align: top; }
  .md :global(th) { font-weight: 600; color: var(--av-ink2); }
  .md :global(img) { max-width: 100%; height: auto; border-radius: var(--av-r-sm); }
</style>
