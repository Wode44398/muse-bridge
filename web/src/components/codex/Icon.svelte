<script>
  // Codex 分页的线稿图标（20 网格，描边 1.5–1.7；照 demo 的那套）。name 见下表；size 默认 20。
  // 云朵（codex）带 mask：同一页里会出现多枚，mask id 按实例生成，免得互相引用错。
  let { name, size = 20, class: cls = '', title = '' } = $props();
  const uid = 'cxm' + Math.random().toString(36).slice(2, 8);
  const ICONS = {
    "side": {
    "vb": "0 0 20 20",
    "svg": "<rect x=\"2.8\" y=\"3.8\" width=\"14.4\" height=\"12.4\" rx=\"3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\"/><path d=\"M8 4v12\" stroke=\"currentColor\" stroke-width=\"1.6\"/>"
    },
    "panel": {
    "vb": "0 0 20 20",
    "svg": "<rect x=\"2.8\" y=\"3.8\" width=\"14.4\" height=\"12.4\" rx=\"3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\"/><path d=\"M12 4v12\" stroke=\"currentColor\" stroke-width=\"1.6\"/>"
    },
    "plus": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M10 4.5v11M4.5 10h11\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\"/>"
    },
    "chev": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M5.5 8l4.5 4.5L14.5 8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "back": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M12.3 4.6L6.9 10l5.4 5.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "fwd": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M7.7 4.6l5.4 5.4-5.4 5.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "check": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M4.8 10.4l3.4 3.3 7-7.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "x": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M5.6 5.6l8.8 8.8M14.4 5.6l-8.8 8.8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\"/>"
    },
    "term": {
    "vb": "0 0 20 20",
    "svg": "<rect x=\"2.8\" y=\"3.8\" width=\"14.4\" height=\"12.4\" rx=\"3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M6.3 8l2.3 2-2.3 2M10.3 12.4h3.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "file": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M5.5 2.8h5.6l3.9 3.9v9.1a1.4 1.4 0 0 1-1.4 1.4H5.5a1.4 1.4 0 0 1-1.4-1.4V4.2a1.4 1.4 0 0 1 1.4-1.4z M11 3v3.9h3.9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linejoin=\"round\"/>"
    },
    "folder": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M2.9 6.4a2 2 0 0 1 2-2h3.2l1.8 1.9H15a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H4.9a2 2 0 0 1-2-2z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linejoin=\"round\"/>"
    },
    "eye": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linejoin=\"round\"/><circle cx=\"10\" cy=\"10\" r=\"2.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/>"
    },
    "edit": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M12.6 4.2l3.2 3.2-8.6 8.6H4v-3.2z M11 5.8l3.2 3.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linejoin=\"round\"/>"
    },
    "compose": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M9.4 3.9H6.1a2.2 2.2 0 0 0-2.2 2.2v7.8a2.2 2.2 0 0 0 2.2 2.2h7.8a2.2 2.2 0 0 0 2.2-2.2v-3.3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M14.4 3.3l2.3 2.3-6.2 6.2-2.9.6.6-2.9z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linejoin=\"round\"/>"
    },
    "globe": {
    "vb": "0 0 20 20",
    "svg": "<circle cx=\"10\" cy=\"10\" r=\"7\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M3 10h14M10 3c2 2.1 2.9 4.4 2.9 7s-.9 4.9-2.9 7c-2-2.1-2.9-4.4-2.9-7S8 5.1 10 3z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/>"
    },
    "branch": {
    "vb": "0 0 20 20",
    "svg": "<circle cx=\"6\" cy=\"5\" r=\"1.9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><circle cx=\"6\" cy=\"15\" r=\"1.9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><circle cx=\"14\" cy=\"7\" r=\"1.9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M6 6.9v6.2M14 8.9c0 3-3 3.4-6.6 4.6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\"/>"
    },
    "more": {
    "vb": "0 0 20 20",
    "svg": "<circle cx=\"5\" cy=\"10\" r=\"1.4\" fill=\"currentColor\"/><circle cx=\"10\" cy=\"10\" r=\"1.4\" fill=\"currentColor\"/><circle cx=\"15\" cy=\"10\" r=\"1.4\" fill=\"currentColor\"/>"
    },
    "shield": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M10 2.8l5.6 2.1v4.6c0 3.6-2.4 6.3-5.6 7.7-3.2-1.4-5.6-4.1-5.6-7.7V4.9z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linejoin=\"round\"/>"
    },
    "shield-warn": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M10 2.8l5.6 2.1v4.6c0 3.6-2.4 6.3-5.6 7.7-3.2-1.4-5.6-4.1-5.6-7.7V4.9z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linejoin=\"round\"/><path d=\"M10 6.6v3.6\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/><circle cx=\"10\" cy=\"12.7\" r=\".95\" fill=\"currentColor\"/>"
    },
    "laptop": {
    "vb": "0 0 20 20",
    "svg": "<rect x=\"4\" y=\"4.5\" width=\"12\" height=\"8.5\" rx=\"1.6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M2.5 15.5h15\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\"/>"
    },
    "bolt": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M11.2 2.5L4.8 11h4.6l-.8 6.5L15.2 9h-4.6z\" fill=\"currentColor\"/>"
    },
    "warn": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M10 3.3l7.2 12.4H2.8z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linejoin=\"round\"/><path d=\"M10 8.2v3.4\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/><circle cx=\"10\" cy=\"13.7\" r=\".95\" fill=\"currentColor\"/>"
    },
    "info": {
    "vb": "0 0 20 20",
    "svg": "<circle cx=\"10\" cy=\"10\" r=\"7\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M10 9v4.6\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/><circle cx=\"10\" cy=\"6.4\" r=\".95\" fill=\"currentColor\"/>"
    },
    "swap": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M4 7.2h11.5l-3-3M16 12.8H4.5l3 3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "shrink": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M10 2.8v5.2M7.4 5.6L10 8.2l2.6-2.6M10 17.2V12M7.4 14.4L10 11.8l2.6 2.6M4 10h12\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "expand": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M11.6 3.6h4.8v4.8M8.4 16.4H3.6v-4.8M16.1 3.9l-4.6 4.6M3.9 16.1l4.6-4.6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "pr": {
    "vb": "0 0 20 20",
    "svg": "<circle cx=\"5.5\" cy=\"5\" r=\"1.9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><circle cx=\"5.5\" cy=\"15\" r=\"1.9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><circle cx=\"14.5\" cy=\"15\" r=\"1.9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M5.5 6.9v6.2M14.5 13.1V8.2a2 2 0 0 0-2-2H9.6m1.8-1.9L9.5 6.2l1.9 1.9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "msg": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M3.5 5.3a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6.4a2 2 0 0 1-2 2H9.2L5.5 16.6v-2.9a2 2 0 0 1-2-2z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linejoin=\"round\"/>"
    },
    "retry": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M15.5 10a5.5 5.5 0 1 1-1.6-3.9M15.6 3.6v3.2h-3.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "pause": {
    "vb": "0 0 20 20",
    "svg": "<circle cx=\"10\" cy=\"10\" r=\"7\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M8.3 7.6v4.8M11.7 7.6v4.8\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\"/>"
    },
    "model": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M3.5 6.5h3.2l6.6 7h3.2M13.3 4.5l3.2 2-3.2 2M3.5 13.5h3.2l1.6-1.7\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "search": {
    "vb": "0 0 20 20",
    "svg": "<circle cx=\"9\" cy=\"9\" r=\"5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\"/><path d=\"M12.8 12.8l3.6 3.6\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/>"
    },
    "image": {
    "vb": "0 0 20 20",
    "svg": "<rect x=\"3\" y=\"4\" width=\"14\" height=\"12\" rx=\"2.6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><circle cx=\"7.6\" cy=\"8.3\" r=\"1.4\" fill=\"currentColor\"/><path d=\"M3.6 14.3l4-3.6 3 2.5 2.4-2 3.4 3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linejoin=\"round\"/>"
    },
    "plan": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M8 5.5h8M8 10h8M8 14.5h8\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M3.6 5.3l1 1 1.8-2M3.6 9.8l1 1 1.8-2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><circle cx=\"4.9\" cy=\"14.5\" r=\"1.3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\"/>"
    },
    "chart": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M4 16V9M8 16V4.5M12 16v-5M16 16V7.5\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\"/>"
    },
    "clock": {
    "vb": "0 0 20 20",
    "svg": "<circle cx=\"10\" cy=\"10\" r=\"7\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M10 6.4V10l2.5 1.7\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "archive": {
    "vb": "0 0 20 20",
    "svg": "<rect x=\"3.2\" y=\"4\" width=\"13.6\" height=\"3.4\" rx=\"1\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M4.6 7.4v7a1.8 1.8 0 0 0 1.8 1.8h7.2a1.8 1.8 0 0 0 1.8-1.8v-7M8.2 10.6h3.6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\"/>"
    },
    "clip": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M15.4 9.6l-5.5 5.5a3.6 3.6 0 0 1-5.1-5.1l6-6a2.4 2.4 0 0 1 3.4 3.4l-5.9 5.9a1.2 1.2 0 0 1-1.7-1.7l5.3-5.3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "copy": {
    "vb": "0 0 20 20",
    "svg": "<rect x=\"7.2\" y=\"7.2\" width=\"9\" height=\"9\" rx=\"2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M12.8 4.6H5.9a1.8 1.8 0 0 0-1.8 1.8v6.9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\"/>"
    },
    "sliders": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M3.5 6.2h7.3M15 6.2h1.5M3.5 13.8h1.5M9.2 13.8h7.3\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><circle cx=\"12.9\" cy=\"6.2\" r=\"2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><circle cx=\"7.1\" cy=\"13.8\" r=\"2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/>"
    },
    "slash": {
    "vb": "0 0 20 20",
    "svg": "<rect x=\"3\" y=\"3.5\" width=\"14\" height=\"13\" rx=\"3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M11.6 6.5l-3.2 7\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\"/>"
    },
    "bridge": {
    "vb": "18 18 72 72",
    "svg": "<g fill=\"none\" stroke=\"currentColor\"><path d=\"M35 55A19 19 0 0 1 73 55\" stroke-width=\"7.4\"/><path d=\"M23 55H85\" stroke-width=\"3.4\" stroke-linecap=\"round\"/><path d=\"M72.65 58.63A19 19 0 0 1 35.35 58.63\" stroke-width=\"3.6\" stroke-linecap=\"round\" stroke-opacity=\".42\"/></g>"
    },
    "codex": {
    "vb": "149 149 418 418",
    "svg": "<mask id=\"cx-ic-m\" fill=\"#fff\"><path fill-rule=\"evenodd\" d=\"M247.429 247.43C257.73 208.911 292.871 180.543 334.638 180.543C359.555 180.543 382.115 190.64 398.449 206.964C405.906 204.97 413.743 203.905 421.829 203.905C471.681 203.906 512.096 244.32 512.096 294.173C512.096 302.259 511.031 310.096 509.037 317.553C525.361 333.887 535.458 356.446 535.458 381.364C535.458 423.131 507.09 458.271 468.571 468.572C458.271 507.091 423.131 535.459 381.364 535.459C356.446 535.459 333.886 525.362 317.552 509.037C310.095 511.031 302.258 512.097 294.172 512.097C244.319 512.097 203.906 471.682 203.906 421.829C203.906 413.743 204.969 405.905 206.963 398.448C190.639 382.115 180.543 359.555 180.543 334.638C180.543 292.871 208.91 257.73 247.429 247.43Z\"/></mask><path d=\"M247.429 247.43C257.73 208.911 292.871 180.543 334.638 180.543C359.555 180.543 382.115 190.64 398.449 206.964C405.906 204.97 413.743 203.905 421.829 203.905C471.681 203.906 512.096 244.32 512.096 294.173C512.096 302.259 511.031 310.096 509.037 317.553C525.361 333.887 535.458 356.446 535.458 381.364C535.458 423.131 507.09 458.271 468.571 468.572C458.271 507.091 423.131 535.459 381.364 535.459C356.446 535.459 333.886 525.362 317.552 509.037C310.095 511.031 302.258 512.097 294.172 512.097C244.319 512.097 203.906 471.682 203.906 421.829C203.906 413.743 204.969 405.905 206.963 398.448C190.639 382.115 180.543 359.555 180.543 334.638C180.543 292.871 208.91 257.73 247.429 247.43Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"44\" mask=\"url(#cx-ic-m)\"/><path d=\"M436.706 408.738H370.021M276.533 309.154L303.468 357.831C304.433 359.575 304.412 361.698 303.414 363.423L276.533 409.854\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"30\" stroke-linecap=\"round\"/>"
    },
    "mic": {
    "vb": "0 0 20 20",
    "svg": "<rect x=\"7.2\" y=\"2.9\" width=\"5.6\" height=\"9.4\" rx=\"2.8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M4.6 9.6a5.4 5.4 0 0 0 10.8 0M10 15v2.3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\"/>"
    },
    "mic-off": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M12.8 8.4V5.7a2.8 2.8 0 0 0-5.3-1.3M7.2 7.6v1.9a2.8 2.8 0 0 0 4.6 2.1M4.6 9.6a5.4 5.4 0 0 0 8.7 4.3M15.3 10.6c.07-.33.1-.67.1-1M10 15v2.3M3.6 3.6l12.8 12.8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    },
    "wave": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M4.6 8v4M8.2 4.8v10.4M11.8 6.6v6.8M15.4 8.4v3.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\"/>"
    },
    "play": {
    "vb": "0 0 20 20",
    "svg": "<path d=\"M7 5.2l8.2 4.8L7 14.8z\" fill=\"currentColor\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linejoin=\"round\"/>"
    }
    };
  const icon = $derived(ICONS[name]);
  const body = $derived(icon ? icon.svg.replaceAll('cx-ic-m', uid) : '');
</script>

{#if icon}
  <svg class={cls} viewBox={icon.vb} width={size} height={size} aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
    {#if title}<title>{title}</title>{/if}
    {@html body}
  </svg>
{/if}
