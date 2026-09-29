<script>
  // 主页：简洁启动器。左上字标 + 右上账户胶囊（LoginCard，含工作空间入口）+ 中央 agent 入口方块。
  // 只在这个身份同时开着多个 agent 时出现（只剩一个时是单 agent 模式，直接落在那一页）。
  // 未登录点任意入口 = 唤起登录。底色跟随全局明暗主题。
  import { ui, me, screenOn } from '../lib/state.svelte.js';
  import { pressable } from '../lib/motion.js';
  import { openPage } from '../lib/pageMorph.js';
  import { drag, dropZone } from '../lib/dragdrop.svelte.js';
  import { WS_FILE, attachToAgent } from '../lib/fileDrag.js';
  import LoginCard from './LoginCard.svelte';
  import { t } from '../lib/i18n.js';

  const BASE = import.meta.env.BASE_URL;

  // claude 入口小人是状态指示器：正面站立 = 默认；举旗 = 有任务完成还没看（ui.taskDone，回 claude 页清除）。
  const claudeMascot = $derived(ui.taskDone ? '举旗' : '正面站立');   // i18n-ignore 素材文件名
  const ENTRIES = $derived([
    { key: 'claude', label: 'Claude', img: `assets/mascot/claude-小人-${claudeMascot}.svg` },   // i18n-ignore 素材路径
    { key: 'harness', label: 'dimensio', img: `assets/icons/dimensio-${ui.theme === 'light' ? 'dark' : 'light'}.svg` },
  // 只摆这个身份开着的 agent（服务端下发的 me.agents：全局开关 ∩ 按人授权）；服务端各路由另有真闸。
  ].filter((e) => screenOn(e.key)));

  // 入口打开方式：被点的方块长成这一页，主页以它为原点往后退（lib/pageMorph.js）。
  function openEntry(e, ev) {
    if (me.kind === 'none') { ui.loginOpen = true; return; } // 未登录 → 唤起登录
    if (ui.morphing) return;
    const tile = ev?.currentTarget?.querySelector('.tile');
    openPage(e.key, { from: tile, radius: 24 });
  }

  // 主页入口也是落点：从工作空间拎一份文件、另一根手指退回主页，直接丢在 Claude 的方块上＝
  // 打开那个分页并挂进它的输入栏。dimensio 的附件契约不同（工作空间相对路径），落法在它自己的分页里。
  const DROP_TARGET = { claude: 'claude' };
  function entryDrop(node, e) {
    const optsFor = (en) => {
      const target = DROP_TARGET[en.key];
      return {
        key: 'home:' + en.key, effect: 'send', disabled: !target,
        label: (p) => (p?.count > 1 ? t('把 {n} 项发给 {name}', { n: p.count, name: en.label }) : t('发给 {name}', { name: en.label })),
        accept: (p) => !!target && p?.type === WS_FILE && !!p.materials && me.kind !== 'none',
        drop: async (p) => {
          if (!(await attachToAgent(p, target))) return;
          openEntry(en, { currentTarget: node });
        },
      };
    };
    const zone = dropZone(node, optsFor(e));
    // ENTRIES 是 $derived，重算就会带着新的 entry 对象来 update——必须重新包成落点参数。
    return { update: (next) => zone.update(optsFor(next)), destroy: zone.destroy };
  }
</script>

<div class="home">
  <div class="brand">Muse Bridge</div>

  <LoginCard />

  <div class="grid">
    {#each ENTRIES as e (e.key)}
      <button class="entry" data-entry={e.key} class:dnd-on={drag.overKey === 'home:' + e.key} use:entryDrop={e} onclick={(ev) => openEntry(e, ev)} aria-label={e.label}>
        <!-- use:pressable —— 按下 90ms 干脆压下、松手弹簧回弹（见 lib/motion.js） -->
        <span class="tile" use:pressable={{ scale: 0.94 }}><img class="ico" src={BASE + e.img} alt="" draggable="false" /></span>
        <span class="lbl">{e.label}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .home { position: fixed; inset: 0; background: var(--bg); color: var(--text); overflow: hidden; }
  .brand {
    position: fixed; top: calc(var(--sat) + 22px); left: 22px; z-index: 10; pointer-events: none;
    font-family: var(--serif-stack); font-size: 19px; font-weight: 500; letter-spacing: .01em; color: var(--text);
  }
  .grid {
    position: fixed; left: 0; right: 0; top: 50%; transform: translateY(-50%); z-index: 5;
    display: flex; justify-content: center; gap: 28px; padding: 0 24px;
  }
  .entry { display: flex; flex-direction: column; align-items: center; gap: 12px; }
  /* transform 由 use:pressable 经 --press-s 驱动（按下 CSS 过渡、松手 JS 弹簧），故此处不写 transition */
  .tile {
    width: 116px; height: 116px; border-radius: 24px; display: flex; align-items: center; justify-content: center;
    background: var(--card); box-shadow: var(--card-shadow);
    transform: scale(var(--press-s, 1));
  }
  @media (hover: hover) {
    .entry:hover .tile { background: color-mix(in srgb, var(--card) 88%, var(--text)); }
  }
  /* 拎着文件悬停在入口上：方块微微鼓起 + 描一圈，说明「丢这儿就发给它」 */
  .entry.dnd-on .tile { transform: scale(1.06); transition: transform .14s ease; box-shadow: 0 0 0 2px var(--coral), var(--card-shadow); }
  .ico { width: 58px; height: 58px; object-fit: contain; }
  .lbl { font-size: 14px; font-weight: 500; color: var(--serif); }
</style>
