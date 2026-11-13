<script>
  // Studio 的图（缩略图、画布大图、素材块）：带加载自愈（modules/studio/heal.js：局域网 → 隧道 → 重试），
  // 实在加载不出来时在原位显示一个「重新加载」，不再是一块没有任何提示的灰块。
  // 父元素要 position: relative（失败态铺满它）。失败态写「加载失败」，格子太小（< 80px）时只放图标（create.css 的容器查询）；
  // label：大图上图标和字都放大一号。
  import { t } from '../../../lib/i18n.js';
  import { heal, retryMedia } from '../../../modules/studio/heal.js';
  import { icon } from '../../../modules/studio/icons.js';

  // passive：图在按钮里（工作空间选图格）时失败态不能再是按钮，只显示图标
  let { src, alt = '', label = false, passive = false, class: cls = '', img = $bindable(), ...rest } = $props();
  let state = $state('');
  $effect(() => { src; state = ''; });
  function retry(e) { e.stopPropagation(); e.preventDefault(); retryMedia(img); }
</script>

<img bind:this={img} class={cls} {src} {alt} {...rest} use:heal={{ src, onstate: (s) => (state = s) }} />
{#if state === 'failed' && passive}
  <span class="sd-mfail" aria-hidden="true">{@html icon('reload')}</span>
{:else if state === 'failed'}
  <button class="sd-mfail" class:label type="button" data-nodrag aria-label={t('重新加载')} title={t('重新加载')} onclick={retry}>
    {@html icon('reload')}<span>{t('加载失败')}</span>
  </button>
{/if}
