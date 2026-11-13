<script>
  // 叠放的 agent 图标：模型行尾「已经添加到哪」、操作条去向片里的单枚标。
  // 顺序固定 claude → dimensio → studio；每枚坐在 size+4 的圆形小底座里，两枚以上向左压叠约 20%，后一枚压前一枚
  // （DOM 顺序在后 = 画在上面，不用 z-index）。图标是各 agent 的真标（agentMark），必须走 <img>：
  // studio / dimensio 的 svg 里按渲染宽度切换精简版（@media max-width），内联进来那套媒体查询就失效了。
  //
  // 动效：新出现的一枚 scale .6 → 1（SPRING.bouncy 采样成 linear()，跑在合成器上），消失的缩小淡出，
  // 左右邻居用 flip 让位。挂载那一刻已有的图标不播——列表按筛选重建行时不会一屏图标同时弹一下。
  import { untrack } from 'svelte';
  import { flip } from 'svelte/animate';
  import { cubicIn } from 'svelte/easing';
  import { agentMark } from '../../lib/settingsIcons.js';
  import { ui } from '../../lib/state.svelte.js';
  import { t } from '../../lib/i18n.js';
  import { AGENT_NAME } from '../../lib/modelHub.svelte.js';
  import { DUR, EASE, SPRING, springCurve, bezier, reduced } from '../../lib/motion.js';

  // 邻居让位用标准曲线（--ea-std 同值）：让位是「挪到新位置」，不是退场，不用 accel
  const easeStd = bezier(0.2, 0, 0, 1);

  // quiet：纯装饰（旁边已经写着 agent 名字，比如操作条的去向片），不出 title / 无障碍名
  let { agents = [], size = 16, quiet = false } = $props();

  const ORDER = ['claude', 'dimensio', 'studio'];
  const pick = (a) => ORDER.filter((id) => Array.isArray(a) && a.includes(id));
  const list = $derived(pick(agents));
  // 明暗判断同 SettingsDesktop：studio / dimensio 的标分明暗两版
  const dark = $derived(ui.theme !== 'light');
  const label = $derived(!quiet && list.length ? t('已添加到 {list}', { list: list.map((a) => AGENT_NAME[a]).join(t('、')) }) : '');

  // 挂载时就在的不播落位动画；某枚被移除（destroy）后从这里删掉，再加回来时照常播
  const seen = new Set(untrack(() => pick(agents)));

  function pop(node, id) {
    if (!seen.has(id)) {
      seen.add(id);
      if (reduced()) {
        node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.micro, easing: EASE.fade });
      } else {
        const c = springCurve(SPRING.bouncy);
        node.animate([{ transform: 'scale(.6)' }, { transform: 'scale(1)' }], { duration: c.duration, easing: c.easing });
        node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.micro, easing: EASE.fade });
      }
    }
    return { destroy() { seen.delete(id); } };
  }

  // 退场：缩小淡出（减弱动效时只淡出）
  function shrink() {
    const still = reduced();
    return {
      duration: still ? DUR.micro : DUR.quick,
      easing: cubicIn,
      css: (k) => (still ? `opacity:${k}` : `opacity:${k};transform:scale(${0.6 + 0.4 * k})`),
    };
  }
</script>

<span class="stack" role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : 'true'}
  title={label || undefined} style:--s="{size}px">
  {#each list as id (id)}
    <span class="ag" use:pop={id} out:shrink animate:flip={{ duration: DUR.quick, easing: easeStd }}>
      <img src={agentMark(id, dark)} alt="" width={size} height={size} draggable="false" />
    </span>
  {/each}
</span>

<style>
  .stack { display: inline-flex; align-items: center; flex: none; vertical-align: middle; }
  .stack:empty { display: none; }
  .ag { position: relative; flex: none; display: grid; place-items: center; box-sizing: border-box;
    width: calc(var(--s) + 4px); height: calc(var(--s) + 4px); border-radius: 50%;
    background: var(--st-surface); box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 18%, transparent); }
  /* 向左压叠 size 的 20%（16px 时 3.2px）：基本只压到前一枚底座的留白，标本身不缺角；分隔环用 18% 的墨，两枚读得出是「叠放」。
     环用 box-shadow 画（不占盒子），叠在一起时线不会变粗 */
  .ag + .ag { margin-left: calc(var(--s) * -0.2); }
  .ag img { display: block; width: var(--s); height: var(--s); border-radius: 50%; pointer-events: none; user-select: none; -webkit-user-select: none; }
</style>
