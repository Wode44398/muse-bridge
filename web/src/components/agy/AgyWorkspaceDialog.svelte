<script>
  // 插件文件夹动作的对话框（agy 的样子）：桌面是 M3 对话框（28 圆角、弹簧进场），手机紧凑档是底部弹层。
  // 用 registerWorkspaceDialog('agy', …) 注册给数据层；内容全是插件的 Dialog 声明：hero 双头像、标题 / 副标题、
  // 分节（图标 + 标题 + 说明 + 小卡片 chip）、开关、确定 / 取消 / 左下的次要按钮（extra）。
  //
  // 编排：
  //   进场：卡片弹簧（420 / 0.78）从 0.94 放大、略微上浮，淡入比位移快；hero 里 agy 的标志「反重力升现」，Claude 的星芒
  //        晚 80ms 从侧面转进来停在一段虚点连线的另一头。编辑态（已经共用）两圆一开始就叠在一起。
  //   确定「设为」：按钮先按下去一点 → 两圆靠拢叠成一组（欠阻尼弹簧）、agy 标志腾辉一下 → 300ms 后交给 lib/agy/decor-flight
  //        提起来飞到侧栏；对话框同时用加速曲线退场（比进场短）。
  //   取消 / 关掉：直接退场。减少动态效果时都直接切。
  import { onMount, tick } from 'svelte';
  import { registerWorkspaceDialog, decorFor } from '../../lib/pluginUi.svelte.js';
  import { pluginIcon } from '../../lib/pluginIcons.js';
  import { t, tr } from '../../lib/i18n.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { Spring, stepAll } from '../../lib/agy/springs.js';
  import { reducedMotion, emphDecel, emphAccel, lerp, clamp01 } from '../../lib/agy/motion.js';
  import { reserveFlight, launchFlight } from '../../lib/agy/decor-flight.svelte.js';
  import { agyLogoSvg } from '../../lib/agy/peer-marks.js';
  import AgyPeerDuo from './AgyPeerDuo.svelte';
  import AgyClaudeThink from './AgyClaudeThink.svelte';

  const { compact = false } = $props();

  const HS = 46;               // hero 头像尺寸
  const APART = 80;            // 分开时 Claude 圆离 agy 圆的距离（margin-left）
  const JOIN = -HS * 0.28;     // 叠成一组（和侧栏头像组同一个叠法）

  let cur = $state(null);      // { dialog, meta, values, editing, bottom, resolve }
  let cardEl = $state(null);
  let scrimEl = $state(null);
  let heroEl = $state(null);
  let agyCtl = $state(null);
  let leaving = false;
  let busy = false;
  let pressed = $state(false);
  let raf = 0;

  onMount(() => registerWorkspaceDialog('agy', (dialog, meta) => new Promise((resolve) => {
    if (cur) settle(null);
    const values = {};
    for (const f of dialog.fields || []) values[f.id] = !!f.value;
    leaving = false;
    busy = false;
    cur = { dialog, meta, values, editing: !!decorFor('agy', meta.path), bottom: compact, resolve };
    tick().then(enter);
  })));

  $effect(() => {
    if (!cur) return;
    return pushBackLayer(() => cancel());
  });
  $effect(() => {
    if (!cur) return;
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  function portal(node) {
    const host = document.querySelector('.agy-root') || document.body;
    host.appendChild(node);
    return { destroy() { node.remove(); } };
  }

  function settle(result) {
    const r = cur?.resolve;
    if (cur) cur.resolve = null;
    r?.(result);
  }

  function springLoop(springs, frame, done) {
    let last = 0;
    const f = (ts) => {
      const dt = last ? (ts - last) / 1000 : 1 / 60;
      last = ts;
      stepAll(springs, dt);
      const fin = springs.every((s) => s.settled(0.0015));
      frame(fin);
      if (fin) { done?.(); return; }
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }

  function enter() {
    if (!cardEl) return;
    const bottom = cur.bottom;
    const hasHero = !!cur.dialog.hero?.peers?.length;
    if (reducedMotion()) {
      cardEl.style.opacity = '1';
      cardEl.style.transform = bottom ? 'none' : 'translateY(-50%)';
      if (scrimEl) scrimEl.style.opacity = '1';
      if (heroEl) heroEl.style.setProperty('--sep', (cur.editing ? JOIN : APART) + 'px');
      return;
    }
    cardEl.style.transformOrigin = bottom ? '50% 100%' : '50% 40%';
    const s = new Spring(0, 420, 0.78).to(1);
    const t0 = performance.now();
    const paint = () => {
      if (!cardEl || leaving) return;
      const el = performance.now() - t0;
      const v = s.x;
      cardEl.style.opacity = emphDecel(clamp01(el / 140)).toFixed(3);
      cardEl.style.transform = bottom
        ? `translateY(${((1 - v) * 60).toFixed(2)}%)`
        : `translateY(-50%) translateY(${((1 - v) * 14).toFixed(2)}px) scale(${(0.94 + 0.06 * v).toFixed(4)})`;
      if (scrimEl) scrimEl.style.opacity = emphDecel(clamp01(el / 180)).toFixed(3);
    };
    paint();
    springLoop([s], paint);

    // hero：Claude 的星芒晚一拍从侧面转进来
    if (hasHero && heroEl && !cur.editing) {
      const avc = heroEl.querySelector('.av-cl');
      const spk = avc?.querySelector('.spk');
      heroEl.style.setProperty('--sep', '150px');
      if (avc) avc.style.opacity = '0';
      if (spk) spk.style.transform = 'rotate(-50deg) scale(.5)';
      setTimeout(() => {
        const s2 = new Spring(0, 300, 0.7).to(1);
        springLoop([s2], () => {
          const v = s2.x;
          heroEl?.style.setProperty('--sep', lerp(150, APART, v).toFixed(2) + 'px');
          if (avc) avc.style.opacity = String(Math.min(1, v * 1.8));
          if (spk) spk.style.transform = `rotate(${(-50 * (1 - v)).toFixed(2)}deg) scale(${(0.5 + 0.5 * v).toFixed(4)})`;
        });
      }, 80);
    } else if (heroEl) {
      heroEl.style.setProperty('--sep', JOIN + 'px');
    }
  }

  function exit() {
    if (!cur || leaving) return;
    leaving = true;
    const card = cardEl, scrim = scrimEl, bottom = cur.bottom;
    const done = () => { cur = null; leaving = false; };
    if (!card || reducedMotion()) { done(); return; }
    const tf0 = card.style.transform || '';
    const t0 = performance.now();
    const f = (ts) => {
      const p = clamp01((ts - t0) / 170);
      const e = emphAccel(p);
      card.style.opacity = String(1 - e);
      if (scrim) scrim.style.opacity = String(1 - e);
      card.style.transform = bottom ? `translateY(${(e * 40).toFixed(2)}%)` : `${tf0} translateY(${(e * 8).toFixed(2)}px) scale(${(1 - e * 0.04).toFixed(4)})`;
      if (p < 1) raf = requestAnimationFrame(f); else done();
    };
    raf = requestAnimationFrame(f);
  }

  function cancel() {
    if (!cur || leaving || busy) return;
    settle(null);
    exit();
  }

  function pickExtra() {
    if (!cur || leaving || busy) return;
    settle({ extra: true });
    exit();
  }

  function toggle(id) {
    if (!cur || busy) return;
    cur.values[id] = !cur.values[id];
  }

  async function confirm() {
    if (!cur || leaving || busy) return;
    busy = true;
    pressed = true;
    setTimeout(() => { pressed = false; }, 140);
    const values = { ...cur.values };
    const fly = !!cur.dialog.hero?.peers?.length && !cur.editing && !!heroEl && !reducedMotion();
    if (!fly) { settle({ values }); busy = false; exit(); return; }
    // 动作请求先发出去，和两圆靠拢同时进行
    reserveFlight(cur.meta.path);
    settle({ values });
    try { agyCtl?.setState?.('success', { then: 'static' }); } catch {}
    heroEl.classList.add('joined');
    const sj = new Spring(0, 440, 0.62).to(1);
    springLoop([sj], () => heroEl?.style.setProperty('--sep', lerp(APART, JOIN, sj.x).toFixed(2) + 'px'));
    await new Promise((r) => setTimeout(r, 300));
    launchFlight({ path: cur.meta.path, heroEl });
    busy = false;
    exit();
  }

  // 副标题「名字 · 路径」：点号后面那截淡一档
  const subParts = $derived.by(() => {
    const s = tr(cur?.dialog?.subtitle || '');
    const i = s.indexOf(' · ');
    return i > 0 ? [s.slice(0, i), s.slice(i)] : [s, ''];
  });
</script>

{#if cur}
  {@const d = cur.dialog}
  <div use:portal class="agy-wsd" class:bottom={cur.bottom}>
    <button type="button" class="scrim" tabindex="-1" data-no-ripple aria-label={t('关闭')} bind:this={scrimEl} onclick={cancel}></button>
    <div class="sheet" class:bottom={cur.bottom} role="dialog" aria-modal="true" aria-label={tr(d.title)} bind:this={cardEl}>
      {#if cur.bottom}<div class="grab" aria-hidden="true"></div>{/if}
      <div class="body">
        {#if d.hero?.peers?.length}
          <div class="hero">
            <AgyPeerDuo
              peers={d.hero.peers}
              size={HS}
              cut="var(--ag-pop-bg)"
              tether={!cur.editing}
              agyState={cur.editing ? 'static' : 'entrance'}
              agyThen={cur.editing ? '' : 'ambient'}
              bind:el={heroEl}
              bind:agyCtl
            />
          </div>
        {/if}
        <h3>{tr(d.title)}</h3>
        {#if d.subtitle}
          <div class="sub">
            <span class="msr">folder</span>
            <span class="sub-t">{subParts[0]}<span class="faint">{subParts[1]}</span></span>
          </div>
        {/if}

        {#each d.sections as sec, si (si)}
          <div class="sec">
            {#if sec.label}<div class="sec-l">{tr(sec.label)}</div>{/if}
            {#each sec.items as it, ii (ii)}
              <div class="it">
                <span class="ic" class:clay={it.agent === 'claude' && !it.icon}>
                  {#if it.agent === 'claude' && (!it.icon || it.icon === 'claude')}
                    <AgyClaudeThink live={false} size={15} />
                  {:else if it.agent === 'agy' && (!it.icon || it.icon === 'agy')}
                    <span class="agl">{@html agyLogoSvg(16, { mono: true })}</span>
                  {:else}
                    <span class="pi">{@html pluginIcon(it.icon || 'plugin')}</span>
                  {/if}
                </span>
                <span class="it-tx">
                  <b>{tr(it.title)}</b>
                  {#if it.desc}<span class="d">{tr(it.desc)}</span>{/if}
                  {#if it.chip}
                    <span class="chip">
                      {#if it.chip.ok}<span class="ok msr">check</span>{/if}
                      <span class="mc">
                        {#if it.chip.code}<code title={it.chip.code}>{it.chip.code}</code>{/if}
                        {#if it.chip.text}<span>{tr(it.chip.text)}</span>{/if}
                      </span>
                    </span>
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        {/each}

        {#each d.fields as f (f.id)}
          <button type="button" class="swr" role="switch" aria-checked={!!cur.values[f.id]} onclick={() => toggle(f.id)}>
            <span class="tx"><b>{tr(f.label)}</b>{#if f.desc}<span class="d">{tr(f.desc)}</span>{/if}</span>
            <span class="sw" class:on={!!cur.values[f.id]} aria-hidden="true"></span>
          </button>
        {/each}
      </div>

      <div class="act">
        {#if d.extra}
          <button type="button" class="tbtn" class:danger={d.extra.danger} onclick={pickExtra}>{tr(d.extra.label)}</button>
          <span class="sp"></span>
        {:else}
          <button type="button" class="tbtn" onclick={cancel}>{tr(d.cancel || '') || t('取消')}</button>
        {/if}
        <button type="button" class="fbtn" class:danger={d.danger} class:press={pressed} onclick={confirm}>{tr(d.ok || '') || t('确定')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .agy-wsd { position: fixed; inset: 0; z-index: 100; }
  .scrim {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.42);
    opacity: 0;
    cursor: default;
  }
  :global(.agy-root.light) .scrim { background: rgba(32, 33, 36, 0.28); }

  .sheet {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 448px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    translate: -50% 0;
    border-radius: 28px;
    background: var(--ag-pop-bg);
    box-shadow: var(--ag-elev-shadow);
    padding: 20px 24px 18px;
    color: var(--ag-on);
    opacity: 0;
    will-change: transform, opacity;
  }
  .sheet.bottom {
    left: 0;
    right: 0;
    top: auto;
    bottom: 0;
    width: auto;
    max-width: none;
    max-height: calc(100vh - var(--sat, 0px) - 24px);
    translate: none;
    border-radius: 28px 28px 0 0;
    padding: 10px 20px calc(22px + var(--sab, 0px));
  }
  .body { overflow-y: auto; min-height: 0; scrollbar-width: none; }
  .grab { width: 32px; height: 4px; border-radius: 2px; background: var(--ag-on-low); margin: 4px auto 10px; flex: none; }
  .hero { height: 72px; display: flex; align-items: center; justify-content: center; margin-bottom: 2px; }
  h3 { margin: 0; text-align: center; font-size: 20px; font-weight: 450; }
  .sub {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 6px;
    margin: 6px 0 16px;
    color: var(--ag-on-dim);
    font-size: 12.5px;
    min-width: 0;
  }
  .sub .msr { font-size: 15px; flex: none; }
  .sub-t { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .faint { color: var(--ag-on-faint); }

  .sec { border-radius: 18px; background: var(--ag-pop-sec); padding: 4px; margin-bottom: 8px; }
  .sec-l { font-size: 11.5px; color: var(--ag-on-faint); padding: 8px 12px 2px; font-weight: 500; }
  .it { display: flex; gap: 12px; padding: 9px 12px; align-items: flex-start; border-radius: 14px; }
  .ic { width: 20px; height: 20px; display: grid; place-items: center; color: var(--ag-on-dim); flex: none; margin-top: 1px; }
  .ic .pi, .ic .agl { display: grid; place-items: center; }
  .ic .pi :global(svg) { width: 18px; height: 18px; }
  .ic .agl :global(svg) { width: 16px; height: 16px; }
  .it-tx { min-width: 0; flex: 1; }
  .it-tx b { display: block; font-weight: 500; font-size: 13.5px; }
  .d { display: block; font-size: 12px; color: var(--ag-on-dim); line-height: 1.55; margin-top: 2px; }
  .chip {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    padding: 7px 10px;
    border-radius: 10px;
    background: var(--ag-bg);
    font-size: 11.5px;
    color: var(--ag-on-dim);
  }
  :global(.agy-root.light) .chip { background: #fff; box-shadow: 0 0 0 1px var(--ag-border); }
  .chip .ok { color: var(--ag-ok); font-size: 15px; flex: none; }
  .mc { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .mc code { font-family: var(--ag-mono); color: var(--ag-on-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mc span { color: var(--ag-on-faint); font-size: 11px; }

  .swr { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; margin: 2px 0 10px; text-align: left; border-radius: 14px; }
  .swr .tx { flex: 1; min-width: 0; }
  .swr b { display: block; font-weight: 500; font-size: 13.5px; }
  .swr .d { margin-top: 1px; }
  .sw {
    width: 40px;
    height: 24px;
    border-radius: 12px;
    border: 2px solid var(--ag-on-low);
    position: relative;
    flex: none;
    box-sizing: border-box;
    transition: background 180ms var(--ag-ease-std), border-color 180ms var(--ag-ease-std);
  }
  .sw::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--ag-on-low);
    transition: transform 260ms var(--ag-ease-decel), width 180ms, height 180ms, top 180ms, left 180ms, background 180ms;
  }
  .swr:active .sw::after { width: 18px; height: 18px; top: 1px; left: 1px; }
  .sw.on { background: var(--ag-accent-fill); border-color: var(--ag-accent-fill); }
  .sw.on::after { transform: translateX(16px); background: #fff; width: 16px; height: 16px; top: 2px; left: 2px; }
  .swr:active .sw.on::after { width: 18px; height: 18px; top: 1px; left: 1px; transform: translateX(15px); }

  .act { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding-top: 2px; flex: none; }
  .act .sp { flex: 1; }
  .tbtn { height: 40px; padding: 0 16px; border-radius: 20px; color: var(--ag-accent); font-weight: 500; font-size: 14px; }
  .tbtn:hover { background: var(--ag-accent-soft); }
  .tbtn.danger { color: var(--ag-err); }
  .tbtn.danger:hover { background: var(--ag-err-bg); }
  .fbtn {
    height: 40px;
    padding: 0 20px;
    border-radius: 20px;
    background: var(--ag-accent-fill);
    color: #fff;
    font-weight: 500;
    font-size: 14px;
    transition: transform 120ms var(--ag-ease-std), border-radius 160ms var(--ag-ease-std);
  }
  .fbtn.danger { background: var(--ag-err); }
  .fbtn.press { transform: scale(0.96); border-radius: 12px; }

  .sheet.bottom h3 { font-size: 21px; }
  .sheet.bottom .it-tx b, .sheet.bottom .swr b { font-size: 15px; }
  .sheet.bottom .d { font-size: 13px; }
  .sheet.bottom .act { padding-top: 6px; }
  .sheet.bottom .fbtn, .sheet.bottom .tbtn { height: 44px; font-size: 15px; }
</style>
