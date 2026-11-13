<script module>
  // 品牌标库（web/src/lib/brandLogos.js，体积大）只在第一次用到时动态加载。
  // 加载结果是模块级普通变量，所有实例共享；不做成 $state，实例上的 arrived 负责在加载完成时触发重算。
  let lib = null;
  let libTask = null;

  function loadLib() {
    if (lib) return Promise.resolve(lib);
    if (!libTask) {
      libTask = import('../../lib/brandLogos.js').then(
        (m) => (lib = m.BRAND_SVG),
        (e) => {
          libTask = null; // 失败后清掉，下一次调用会重新 import
          throw e;
        },
      );
    }
    return libTask;
  }

  // 首字头像：按名字取色相、取第一个字母 / 数字 / 汉字（与设置里各处的首字头像同一套规则）
  const hueOf = (s) => {
    let h = 0;
    for (const c of String(s || '?')) h = (h * 31 + c.codePointAt(0)) % 360;
    return h;
  };
  const initialOf = (s) => (String(s || '?').trim().match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
</script>

<script>
  // logo：brands.mjs 里的 logoKey，空串或库里没有时显示首字头像
  // name：用于首字与色相；plain：true 只画标本身（模型行里约 20px），false 画圆角底托（服务卡片）
  let { logo = '', name = '', size = 36, plain = false } = $props();

  // 异步加载完成后记下 { logo, svg, fade }：既触发重算，fade 为真时才淡入（挂载时库已在内存里就不闪）
  let arrived = $state(null);

  const hue = $derived(hueOf(name));
  const initial = $derived(initialOf(name));
  const fontSize = $derived(Math.max(9, Math.round(size * 0.42)));
  const svg = $derived.by(() => {
    if (!logo) return '';
    if (arrived?.logo === logo) return arrived.svg;
    return has(lib, logo) ? lib[logo] : '';
  });
  const fresh = $derived(!!svg && arrived?.logo === logo && arrived.fade);

  $effect(() => {
    const key = logo;
    if (!key) return;
    // 库若已在内存里就不淡入；无论如何都走一遍 loadLib，渲染与 effect 之间库加载完也不会卡在首字头像上
    const cached = has(lib, key);
    let alive = true;
    let tries = 0;
    let timer = 0;
    const go = () => {
      loadLib().then(
        (all) => {
          if (alive) arrived = { logo: key, svg: has(all, key) ? all[key] : '', fade: !cached };
        },
        () => {
          // 最多重试两次，间隔 1.5s、3s
          if (alive && ++tries <= 2) timer = setTimeout(go, 1500 * tries);
        },
      );
    };
    go();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  });
</script>

<span
  class="bl"
  style:width="{size}px"
  style:height="{size}px"
  style:font-size="{fontSize}px"
  style:--h={hue}
  aria-hidden="true"
>
  <span class="av" class:gone={!!svg}>{initial}</span>
  {#if svg}
    <span class="mk" class:tile={!plain} class:enter={fresh}>{@html svg}</span>
  {/if}
</span>

<style>
  /* 两层叠在同一个定长方框里，只动 opacity，不产生布局跳动 */
  .bl {
    position: relative;
    display: inline-block;
    flex: none;
    vertical-align: middle;
    pointer-events: none;
  }
  .av,
  .mk {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    border-radius: 28%;
  }
  .av {
    font-weight: 600;
    line-height: 1;
    color: hsl(var(--h) 45% 72%);
    background: hsl(var(--h) 45% 55% / 0.16);
    transition: opacity var(--mo-quick) var(--ea-fade);
  }
  :global(html[data-theme='light']) .av {
    color: hsl(var(--h) 38% 40%);
  }
  .av.gone {
    opacity: 0;
  }
  .mk {
    color: var(--text);
  }
  .mk.tile {
    background: var(--st-seg);
    box-shadow: inset 0 0 0 1px var(--st-hair);
  }
  .mk :global(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }
  .mk.tile :global(svg) {
    width: 58%;
    height: 58%;
  }
  .mk.enter {
    animation: bl-in var(--mo-quick) var(--ea-fade) both;
  }
  @keyframes bl-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .av {
      transition: none;
    }
    .mk.enter {
      animation: none;
    }
  }
</style>
