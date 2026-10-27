<script module>
  let clayMod;   // overlay 的 clay 播放器模块：取到一次之后新挂的标记同步可用，不必再等一拍
</script>

<script>
  // Claude 运行标记（设置「思考动画」的默认档 clay）。
  // 维护者的私有 overlay 带了 clay 播放器（清单 modules.clayMark，素材与帧表 data.marks.clay 也在 overlay）→ 挂它逐帧播；
  // 公开版 → 自绘星标 StarMark（活动映射：思考 = 转圈呼吸，读 / 搜 / 跑命令 = 一格格转，写 = 光芒伸缩，等人 = 收短轻抖）。
  // 接口：activity: default|think|search|read|code|write|compose；state: working|blocked|tile
  import { untrack } from 'svelte';
  import { ov, ovData, ovModule } from '../lib/overlay.svelte.js';
  import StarMark from './StarMark.svelte';

  let { activity = 'default', state: markState = 'working', paused = false, size = 20, box = size, standalone = false } = $props();

  const pack = $derived(ovData('marks')?.clay || null);
  // 清单里有这套播放器就等它（先放一颗陶土色圆点，和播放器起步那颗一样）；没有直接 StarMark，免得先空一下
  const expect = $derived(!ov.ready || !!(pack && ov.modules.clayMark));
  let mod = $state(clayMod);   // undefined = 还在取；null = 没有
  $effect(() => {
    if (mod !== undefined || !expect) return;
    let alive = true;
    ovModule('clayMark').then((m) => {
      const v = m && typeof m.ClayMark === 'function' ? m : null;
      if (v) clayMod = v;
      if (alive) mod = v;
    });
    return () => { alive = false; };
  });

  let host = $state(null);
  let player = null;
  $effect(() => {
    const m = mod, el = host, p = pack, s = size, b = box;
    if (!m || !el || !p) return;
    try {
      player = new m.ClayMark(el, { pack: p, size: s, box: b, ...untrack(() => ({ standalone, activity, state: markState, paused })) });
    } catch (e) { console.warn('[overlay] clayMark 挂载失败：', e?.message || e); mod = null; return; }   // i18n-ignore 只进控制台
    return () => { player?.destroy(); player = null; };
  });
  $effect(() => { const a = activity, st = markState, pz = paused; player?.set({ activity: a, state: st, paused: pz }); });

  const mode = $derived(markState === 'blocked' ? 'blocked' : markState === 'tile' ? 'static'
    : activity === 'think' ? 'think' : (activity === 'code' || activity === 'search' || activity === 'read') ? 'tool' : 'work');
</script>

{#if mod && pack}
  <span class="cwm-ov" bind:this={host} style="width:{box}px;height:{box}px" aria-hidden="true" data-cds="WorkingMark"></span>
{:else if mod === null || !expect}
  <span class="cwm-pub" style="width:{box}px;height:{box}px" data-cds="WorkingMark">
    <StarMark {mode} size={size} box={size} {paused} color="#d97757" />
  </span>
{:else}
  <span class="cwm-pub" style="width:{box}px;height:{box}px" aria-hidden="true" data-cds="WorkingMark">
    <span class="dot" style="width:{size * 0.35}px;height:{size * 0.35}px"></span>
  </span>
{/if}

<style>
  .cwm-ov { display: inline-flex; flex: none; line-height: 0; }
  .cwm-pub { display: inline-flex; align-items: center; justify-content: center; flex: none; line-height: 0; }
  .dot { border-radius: 50%; background: #d97757; }
</style>
