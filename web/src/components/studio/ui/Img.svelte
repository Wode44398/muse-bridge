<script>
  // Studio 的图（缩略图、画布大图、素材块）：带加载自愈（modules/studio/heal.js：局域网 → 隧道 → 重试），
  // 实在加载不出来时在原位显示一个「重新加载」，不再是一块没有任何提示的灰块。
  // 父元素要 position: relative（失败态铺满它）。失败态写「加载失败」，格子太小（< 80px）时只放图标（create.css 的容器查询）；
  // label：大图上图标和字都放大一号。
  import { t } from '../../../lib/i18n.js';
  import { heal, retryMedia } from '../../../modules/studio/heal.js';
  import { icon } from '../../../modules/studio/icons.js';
  import { reduced } from '../../../lib/motion.js';

  // passive：图在按钮里（工作空间选图格）时失败态不能再是按钮，只显示图标
  let { src, alt = '', label = false, passive = false, class: cls = '', img = $bindable(), ...rest } = $props();
  let state = $state('');
  $effect(() => { src; state = ''; });
  function retry(e) { e.stopPropagation(); e.preventDefault(); retryMedia(img); }
  // 还没下完的图先透明、到了淡入：画廊一屏十几张格子各自到货，硬蹦出来就是一片此起彼伏的闪；
  // 已经在缓存里的（挂上时 complete）照常直接显示，不多这一下。只动 opacity，用 WAAPI，不碰调用方给图写的过渡
  function fadeOnLoad(node) {
    let pend = false;
    const check = () => { if (!node.complete || !node.naturalWidth) { pend = true; node.style.opacity = '0'; } };
    const show = () => {
      if (!pend) return;
      pend = false; node.style.opacity = '';
      if (!reduced()) node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'cubic-bezier(.05,.7,.1,1)' });
    };
    const fail = () => { pend = false; node.style.opacity = ''; };
    check();
    node.addEventListener('load', show);
    node.addEventListener('error', fail);
    return { update: check, destroy() { node.removeEventListener('load', show); node.removeEventListener('error', fail); } };
  }
</script>

<img bind:this={img} class={cls} {src} {alt} {...rest} use:heal={{ src, onstate: (s) => (state = s) }} use:fadeOnLoad={src} />
{#if state === 'failed' && passive}
  <span class="sd-mfail" aria-hidden="true">{@html icon('reload')}</span>
{:else if state === 'failed'}
  <button class="sd-mfail" class:label type="button" data-nodrag aria-label={t('重新加载')} title={t('重新加载')} onclick={retry}>
    {@html icon('reload')}<span>{t('加载失败')}</span>
  </button>
{/if}
