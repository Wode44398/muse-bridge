<script>
  // 输入框上方的「归属状态栏」——把 claude.ai /code 那套芯片搬了过来：
  //   目录芯片（点开 → 工作台·文件） + 分支/worktree 分体胶囊（点开 → 工作台·审阅）。
  //
  // 形制逐条对齐官方实测规格（bridge前端设计/claude页面设计参考资源/code分页-状态栏芯片/规格.md，
  // 2026-08-21 从 claude.ai DOM + 桌面客户端 ion-dist 源码两路取的）：
  //   高 24 / 左右 padding 6 / 图标文字间距 6 / 圆角 6 / 字 13-19 / 标签 max-w 160；
  //   分支与 worktree 不是两颗芯片，是【同一颗胶囊的左右两半】——底色与描边挂外层、
  //   两半透明且圆角继承，中间 1px×10 分隔线在 hover/focus 整颗时淡出。
  //
  // 两处按 bridge 自己的规矩改：
  //   · 不搬官方那颗「运行设备」芯片（Local/Cloud）——bridge 的 agent 恒在本机，没这个维度。
  //   · worktree 勾选框不用官方那抹蓝（#2a78d6）——本页配色铁律「彩色只留星芒」，
  //     故走 .submit 同款黑白反相（底 --text / 勾 --bg）。
  //
  // worktree 半区两种身份（官方同款：新对话前是开关，会话开跑后只读）：
  //   · armable（空态、还没有会话）且工作空间是 git 主检出 → 【开关】：勾上再发第一条消息，
  //     服务端先从当前分支切一个 worktree（<仓库>/.claude/worktrees/<名>，分支 claude/<名>），
  //     整个会话在里面跑、主检出不动（src/claude-worktrees.mjs）。勾选状态记在 prefs，跨对话保留。
  //   · 当前工作空间本身就是 linked worktree（worktree 会话、或项目目录就是个 worktree）→
  //     【只读指示】已勾，告诉你「不是主检出」——正是删 worktree 前最该看见的一眼。
  import { dock, openDock, ensureDockMeta } from '../lib/dock.svelte.js';
  import { prefs, savePrefs } from '../lib/state.svelte.js';
  import { t } from '../lib/i18n.js';

  // name = 当前项目名（真实项目里就等于文件夹名；快照对话的桶目录名是 UUID，只有项目名可读）
  // armable = 还没有会话的新对话空态——只有这时 worktree 勾选框能点
  let { name = '', armable = false } = $props();

  const ws = $derived(dock.ws || '');
  const meta = $derived(dock.meta);
  // 项目名优先，兜底取路径末段：Windows 反斜杠与 POSIX 斜杠都吃，末尾分隔符先削掉
  const folder = $derived(name || (ws ? ws.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ws : ''));
  const branch = $derived(meta?.git ? meta.branch || null : null);
  const isWorktree = $derived(!!meta?.git && !!meta.worktree);
  const canToggle = $derived(armable && !!meta?.wtNew);   // 服务端认可（git 主检出、支持 worktree 会话）才给开关
  function toggleWorktree() { prefs.worktree = !prefs.worktree; savePrefs(); }
  // 快照访客（/c/ 公开链接）不给看归属：服务端本就不下发真实路径，前端也别露目录名
  const show = $derived(!!ws && ws !== 'snap' && !dock.snap);

  $effect(() => { if (show && !dock.meta) ensureDockMeta(); });
</script>

{#if show}
  <div class="wchips">
    <button class="chip" title={ws} onclick={() => openDock('files')}>
      <span class="ic" aria-hidden="true">&#xe072;</span>
      <span class="lbl">{folder}</span>
    </button>

    {#if branch}
      <div class="split">
        <button class="half" title={t('分支 · 点开审阅变更')} onclick={() => openDock('review')}>
          <span class="ic" aria-hidden="true">&#xe078;</span>
          <span class="lbl">{branch}</span>
        </button>

        {#if canToggle}
          <span class="divi" aria-hidden="true"></span>
          <button class="half wt" role="checkbox" aria-checked={prefs.worktree} title={t('在仓库的隔离副本里工作')} onclick={toggleWorktree}>
            <span class="cb">
              <span class="box" class:off={!prefs.worktree}>
                {#if prefs.worktree}
                  <svg width="6" height="5" viewBox="0 0 5.875 5.375" fill="none" aria-hidden="true">
                    <path d="M0.5 2.75L2.25 4.88L5.38 0.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                {/if}
              </span>
            </span>
            <span class="lbl">worktree</span>
          </button>
        {:else if isWorktree}
          <span class="divi" aria-hidden="true"></span>
          <span class="half wt ro" title={t('此工作空间是 git worktree，不是主检出')}>
            <span class="cb">
              <span class="box">
                <svg width="6" height="5" viewBox="0 0 5.875 5.375" fill="none" aria-hidden="true">
                  <path d="M0.5 2.75L2.25 4.88L5.38 0.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
            </span>
            <span class="lbl">worktree</span>
          </span>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* 令牌只挂在本组件根上——本页 CSS 会被打进宿主 bundle，裸 :root 会漏给别人
     （曾出现过整站暗色令牌被改浅的事故）。 */
  .wchips {
    --wc-h: 24px; --wc-pad: 6px; --wc-gap: 6px; --wc-r: 6px;
    /* 官方 effect-contained-default：亮色一圈 1px 内描边 + 极淡投影，暗色【两条全无】 */
    --wc-ring: none;
    display: flex; flex-wrap: wrap; align-items: center;
    gap: var(--wc-gap);
    /* 官方是行 pb-p3(4) + composer 列 gap-g5(6)，这里合成 10px 与输入框卡片的间距；
       左缘与输入框卡片齐平（官方也是齐平，不做视觉内缩） */
    padding: 0 0 4px; margin-bottom: 6px;
    min-width: 0;
  }
  :global(html[data-theme="light"]) .wchips {
    --wc-ring: inset 0 0 0 1px rgba(11, 11, 11, .1), 0 1px 2px rgba(11, 11, 11, .04);
  }

  /* 芯片原语（官方 z_ 常量的等价物）：描边一律靠 box-shadow，不用 border */
  .chip, .half {
    display: flex; align-items: center; gap: var(--wc-gap);
    height: var(--wc-h); padding: 0 var(--wc-pad);
    border: 0; border-radius: var(--wc-r);
    font-size: 13px; line-height: 19px; color: var(--serif);
    min-width: 0; max-width: 100%;
    transition: background-color var(--mo-micro) var(--ea-std), color var(--mo-micro) var(--ea-std);
  }
  /* 底色要【不透明】：聊天态输入栏是悬浮层、正文从下面穿过（.composer-wrap 无实心隔层），
     半透明芯片会让标题字直接叠进芯片文字里。这里把半透明的 --hover 铺在 --bg 上合成出
     同一个视觉色，但整块挡光——与输入卡片 var(--card) 的不透明取向一致。 */
  .chip { background-color: var(--bg); background-image: linear-gradient(var(--hover), var(--hover)); box-shadow: var(--wc-ring); }
  .chip:active, .half:not(.ro):active { background: var(--hover-strong); color: var(--text); }
  @media (hover: hover) {
    .chip:hover, .half:not(.ro):hover { background: var(--hover-strong); color: var(--text); }
  }

  /* 分体胶囊：底色与描边在外层，两半透明 + 圆角继承（官方 group/split 的搬运） */
  .split {
    display: inline-flex; align-items: center;
    border-radius: var(--wc-r);
    background-color: var(--bg); background-image: linear-gradient(var(--hover), var(--hover));
    box-shadow: var(--wc-ring);
    min-width: 0; max-width: 100%;
  }
  .split .half { background: transparent; border-radius: inherit; }
  /* worktree 半区：左右 padding 不对称（官方 pl-p4 5 / pr-p5 6）、间距 g2 3；
     官方 Checkbox.Root 自身就是 cursor-default（开关态也是），只读态另外不给 hover */
  .half.wt { gap: 3px; padding: 0 6px 0 5px; cursor: default; }
  .divi {
    width: 1px; height: 10px; flex: none; background: var(--divider);
    transition: opacity var(--mo-micro) var(--ea-std);
  }
  .split:hover .divi, .split:focus-within .divi { opacity: 0; }

  /* 图标 = 已内置的 Anthropicons 字形：U+E072 Folder / U+E078 GitBranch。
     liga 关掉直接吃 PUA 码位；轴位取官方芯片实测的 opsz16 / wght533。 */
  .ic {
    flex: none; width: 16px; height: 16px; font-size: 16px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--icons);
    font-feature-settings: "liga" 0;
    font-variation-settings: "opsz" 16, "wght" 533;
  }
  .lbl { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* 勾选框：外槽 16 / 内框 11.2 / 圆角 2.4（官方数值），勾是官方原样 SVG 路径 */
  .cb { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 2.4px; }
  .box {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%; border-radius: 2.4px;
    background: var(--text); color: var(--bg);
    transition: background-color var(--mo-micro) var(--ea-std), box-shadow var(--mo-micro) var(--ea-std);
  }
  /* 未勾：透明底 + 1px 内环（官方 inset 0 0 0 1px var(--t5)，t5 = 正文色 25%）；勾上去环填实 */
  .box.off { background: transparent; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 25%, transparent); }
</style>
