<script>
  // 输入栏顶上的附件卡：图片带缩略图，上传中走进度（卡底一道细线 + 百分比），失败把原因写在卡上；× 移除。
  import { t } from '../../lib/i18n.js';
  import Icon from './Icon.svelte';
  import { draft, removeAtt } from '../../lib/codex/composer/atts.svelte.js';
  import { fmtSize } from '../../lib/codex/composer/logic.js';
  import { chipIn, chipOut } from '../../lib/codex/composer/fx.js';

  let { onremove = null } = $props();

  const ext = (name) => (/\.([a-z0-9]{1,6})$/i.exec(name)?.[1] || '').toUpperCase();

  function meta(a) {
    if (a.error) return a.error;
    if (a.kind === 'chat') return a.progress != null ? t('正在整理对话…') : (a.count ? t('引用的对话 · {n} 条', { n: a.count }) : t('引用的对话'));
    if (a.progress != null) return t('上传中 {p}%', { p: Math.round(a.progress * 100) });
    const kind = a.kind === 'image' ? t('图片') : ext(a.name) || t('文件');
    return a.size ? `${kind} · ${fmtSize(a.size)}` : kind;
  }

  function remove(e, id) {
    e.stopPropagation();
    removeAtt(id);
    onremove?.();
  }
</script>

<div class="comp-atts">
  {#each draft.atts as a (a.id)}
    <div class="att sq" class:err={!!a.error} class:up={a.progress != null} title={a.name} in:chipIn out:chipOut>
      <span class="th sq">
        {#if a.thumb}<img src={a.thumb} alt="" draggable="false" />{:else}<Icon name={a.kind === 'image' ? 'image' : a.kind === 'chat' ? 'msg' : 'file'} />{/if}
      </span>
      <span class="tx"><b>{a.name}</b><span>{meta(a)}</span></span>
      <button type="button" class="ibtn sm" title={t('移除')} aria-label={t('移除 {name}', { name: a.name })} onclick={(e) => remove(e, a.id)}><Icon name="x" /></button>
      {#if a.progress != null && a.kind !== 'chat'}<i class="bar" style="transform:scaleX({Math.max(0.04, a.progress)})"></i>{/if}
    </div>
  {/each}
</div>

<style>
  /* 多张卡时横着滑，不把输入栏撑宽（手机上尤其） */
  .comp-atts { overflow-x: auto; scrollbar-width: none; }
  .comp-atts::-webkit-scrollbar { display: none; }
  .att { flex: none; max-width: 240px; overflow: hidden; }
  .th { overflow: hidden; }
  .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tx { min-width: 0; display: flex; flex-direction: column; }
  .tx b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tx > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .att.err .tx > span { color: var(--warn); }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--fg3); transform-origin: 0 50%; transition: transform var(--d-3) var(--ease-out); }
</style>
