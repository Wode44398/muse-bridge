<script>
  // 吉祥物（可选，默认关）：蹲在输入栏上沿。用官方桌面版精灵图的原始帧（8 列 × 11 行）。
  //   待机；当前线程在跑时敲电脑；等你决定时抬头看你；一轮跑完欢呼一下，出错晕倒；
  //   鼠标停在它身上蹦，点一下挥手；待机时眼睛跟着指针转（官方 16 个方向的「看你」帧）。
  // 精灵图取不到（没装桌面版、Linux、云端）就不出现。
  import { untrack } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import { current, lastTurn } from '../../lib/codex/store.svelte.js';
  import { codexPrefs } from '../../lib/codex/prefs.svelte.js';
  import { assetUrl } from '../../lib/codex/assets.js';
  import { reduced } from '../../lib/codex/motion.js';
  import { haptic } from '../../lib/codex/feedback.js';
  import { petFrames, petPos, petLook, petMood } from '../../lib/codex/composer/logic.js';

  let { lift = 0 } = $props();

  let el = $state(null);
  let sheet = $state(null);
  const on = $derived(!!codexPrefs.pet && !!sheet);

  $effect(() => {
    const name = codexPrefs.petName;
    if (!codexPrefs.pet) return;
    let live = true;
    assetUrl('pet', name).then((u) => { if (live) sheet = u; });
    return () => { live = false; };
  });

  const thread = $derived(current());
  const busy = $derived(!!thread.running);
  const ask = $derived(!!thread.ask);
  const mood = $derived(petMood({ ask, busy }));

  const P = { name: 'idle', loop: false, frames: [], loopAt: 0, i: 0, timer: 0, hover: false, look: null, oneShot: '' };

  function show(f) { if (el) el.style.backgroundPosition = petPos(f); }

  function play(name, loop) {
    clearTimeout(P.timer);
    const eff = P.hover ? 'jumping' : name;
    const { frames, loopAt } = petFrames(eff, loop || eff === 'jumping');
    P.frames = frames; P.loopAt = loopAt; P.i = 0;
    if (reduced()) { show(frames[0]); return; }
    const step = () => {
      if (!on || !el) return;
      if (P.look && !P.hover) { show(P.look); P.timer = setTimeout(step, 80); return; }
      const f = P.frames[P.i];
      show(f);
      P.timer = setTimeout(() => {
        // 一次性的动作演完（落回待机那段）就回到当前心情
        if (P.oneShot && P.i + 1 >= P.loopAt && P.loopAt > 0) { P.oneShot = ''; set(mood.name, mood.loop); return; }
        P.i = P.i + 1 >= P.frames.length ? P.loopAt : P.i + 1;
        step();
      }, f.d);
    };
    step();
  }

  function set(name, loop) { P.name = name; P.loop = !!loop; play(name, loop); }
  function once(name) { P.oneShot = name; P.name = name; P.loop = false; play(name, false); }

  // 心情变了（开跑、等你、跑完）：换段；一次性的动作演着时等它演完
  $effect(() => {
    const m = mood;
    if (!on || !el) return;
    untrack(() => { if (!P.oneShot) set(m.name, m.loop); });
  });

  // 一轮收尾：跑完欢呼，出错晕倒（同一条线程里看到的收尾才演，切线程不算）
  let seen = '';
  $effect(() => {
    const lt = lastTurn(thread);
    const key = (thread.id || 'new') + ':' + (lt?.key || '') + ':' + (lt?.live ? 'live' : lt?.status || '');
    const was = seen;
    seen = key;
    if (!on || !lt || !was) return;
    const [wid, wkey, wst] = was.split(':');
    if (wid !== (thread.id || 'new') && !(wid === 'new' && thread.id)) return;
    if (wkey !== lt.key || wst !== 'live' || lt.live) return;
    untrack(() => {
      if (lt.status === 'done') once('jumping');
      else if (lt.status === 'error') once('failed');
    });
  });

  // 刚打开：挥个手
  let wasOn = false;
  $effect(() => {
    const o = on;
    if (o && !wasOn && el) untrack(() => once('waving'));
    if (!o) clearTimeout(P.timer);
    wasOn = o;
  });

  // 待机时眼睛跟着指针
  $effect(() => {
    if (!on || !el) return;
    const root = el.closest('.cx');
    if (!root) return;
    const move = (e) => {
      if (P.name !== 'idle' || P.oneShot || reduced()) { P.look = null; return; }
      const r = el.getBoundingClientRect();
      P.look = petLook(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    };
    const leave = () => { P.look = null; };
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerleave', leave);
    return () => { root.removeEventListener('pointermove', move); root.removeEventListener('pointerleave', leave); };
  });

  $effect(() => () => clearTimeout(P.timer));

  function enter(e) { if (e.pointerType === 'touch') return; P.hover = true; play(P.name, P.loop); }
  function leave() { if (!P.hover) return; P.hover = false; play(P.name, P.loop); }
  function poke() { haptic('tick'); P.hover = false; once('waving'); }
</script>

{#if codexPrefs.pet}
  <button
    bind:this={el}
    type="button"
    class="pet"
    class:on
    title="Codex"
    aria-label={t('吉祥物')}
    tabindex="-1"
    style="--pet-sheet:{sheet ? `url(${sheet})` : 'none'};{lift ? `--lift:${lift}px` : ''}"
    onpointerenter={enter}
    onpointerleave={leave}
    onclick={poke}
  ></button>
{/if}

<style>
  /* 显隐由自己管（theme.css 里按 .cx[data-pet] 开关，原生页里偏好在 codexPrefs）；排队的卡叠起来时蹲到最上面那张上 */
  :global(.cx .comp-wrap > .pet) { padding: 0; border: 0; bottom: calc(100% - 8px + var(--lift, 0px)); transition: opacity var(--d-3), transform var(--d-4) var(--ease-out), bottom var(--d-4) var(--ease-out); }
  :global(.cx .comp-wrap > .pet.on) { opacity: 1; transform: none; }
  :global(.cx .comp-wrap > .pet:not(.on)) { pointer-events: none; }
</style>
