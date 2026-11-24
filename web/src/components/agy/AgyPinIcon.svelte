<script>
  // 置顶 / 取消置顶图标：采用 Material Symbols Rounded 同源矢量路径（viewBox 0 -960 960 960），
  // 绕开精简图标字库未收录 keep / keep_off 的限制。
  const { off = false, filled = false, size = 16, class: cls = '' } = $props();

  const KEEP_OUTLINE = 'M640-480l80 80v80H520v240l-40 40-40-40v-240H240v-80l80-80v-280h-40v-80h400v80h-40v280Zm-286 80h252l-46-46v-314H400v314l-46 46Zm126 0Z';
  const KEEP_FILLED = 'M640-480l80 80v80H520v240l-40 40-40-40v-240H240v-80l80-80v-280h-40v-80h400v80h-40v280Z';
  const KEEP_OFF = 'M680-840v80h-40v327l-80-80v-247H400v87l-87-87h-33v-80h400ZM480-40l-40-40v-240H240v-80l80-80v-46L56-792l56-56 736 736-56 56-264-264h-8v240l-40 40ZM354-400h92l-44-44-2-2-46 46Z';

  const d = $derived(off ? KEEP_OFF : (filled ? KEEP_FILLED : KEEP_OUTLINE));
</script>

<svg
  class="agy-pin-ico {cls}"
  width={size}
  height={size}
  viewBox="0 -960 960 960"
  fill="currentColor"
  aria-hidden="true"
>
  <path {d} />
</svg>

<style>
  .agy-pin-ico {
    flex: none;
    display: block;
  }
</style>
