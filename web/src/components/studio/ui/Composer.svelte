<script>
  // Studio 的输入栏（方案 §12.3）：一支笔——只留 ＋、正文、发送；素材行在正文上面。
  // 发送键空着时不在（没有一颗没用的灰键）；能发时一滴墨从中心胀出来（弹簧）、箭头一笔画上去；
  // 按下往回收（像拉弓）、松开射出去，正文往上飘走变糊；发送中原地转、不改宽；不能发（上传中、缺素材、语言不对）键在但淡。
  // 正文是 contenteditable：页面经 bind:field 读写（草稿预填 / 别处填进来）；发出去成功由这里清空，失败原样回来。
  import { untrack } from 'svelte';
  import { pastePlainText } from '../../../lib/dropPaste.js';
  import { t } from '../../../lib/i18n.js';
  import { edgeFade } from '../../../modules/studio/edge.js';
  import { SPRING_POP, springEasing, reducedMotion } from '../../../modules/studio/motion.js';

  let {
    field = $bindable(), hasText = $bindable(false),
    placeholder = '', sendLabel = '',
    // hidden：空着（键不在）· ready：能发 · blocked：键在但淡（原因由页面写在输入栏下面）· busy：发送中
    send = 'hidden',
    onsend,          // async () => boolean：成功了这里清空正文
    // 回车直接发送（触屏一律不发，留给换行）；朗读文本这类长文关掉，改 Ctrl/⌘+Enter 发送
    enterSends = true,
    tall = false,
    atts = null, plus = null,
    ontext = null,   // (正文) → 每次输入后回调（宿主据此做语言等内容检查）
  } = $props();
  const touchUI = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const EIN = 'cubic-bezier(.5,0,.75,0)', EOUT = 'cubic-bezier(.16,1,.3,1)';

  let box = $state(), btn = $state(), arrow = $state();
  let away = $state(false);       // 正文已经飘走、在等结果（失败就回来）
  const quiet = () => reducedMotion() || !!box?.closest('.sd-noanim');

  function onInput() {
    const s = field?.textContent || '';
    // 删空了 contenteditable 常留一个 <br>，:empty 占位词就出不来
    if (!s.trim() && field?.innerHTML && !s) field.innerHTML = '';
    hasText = !!s.trim(); ontext?.(s);
  }
  function onKey(e) {
    if (e.key !== 'Enter' || e.isComposing) return;
    const go = enterSends ? (!e.shiftKey && !touchUI) : (e.ctrlKey || e.metaKey);
    if (go) { e.preventDefault(); fire(); }
  }
  // 整卡点哪儿都能聚焦正文（同 dimensio 的 cursor:text），点到按钮、素材行上除外
  function focusField(e) { if (!e.target.closest('button, a, [contenteditable], .cp-atts, input')) field?.focus(); }

  // —— 发送键的几个姿势 ——
  const paths = () => (arrow ? [...arrow.querySelectorAll('path')] : []);
  function drawArrow(delay = 90) {
    if (quiet()) return;
    paths().forEach((p, i) => p.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: i ? 180 : 200, delay: delay + i * 80, easing: EOUT, fill: 'backwards' }));
  }
  let prev;
  $effect(() => {
    const s = send;
    untrack(() => {
      const p = prev; prev = s;
      if (p === undefined || p === s || !btn || quiet()) return;
      if (p === 'hidden') {
        // 先撤掉上一次收起留下的动画（坑 3），再从中心胀出来
        btn.getAnimations().forEach((a) => a.cancel());
        btn.animate([{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { duration: SPRING_POP.ms, easing: springEasing(SPRING_POP) });
        drawArrow();
      } else if (s === 'hidden') {
        btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(0)' }], { duration: 150, easing: EIN });
      } else if (p === 'busy' && s !== 'hidden') drawArrow(0);   // 没发成：箭头重新画上
    });
  });
  let pressAnims = [];
  function press(e) {
    if (send !== 'ready' || e.button > 0 || quiet()) return;
    pressAnims.forEach((a) => a.cancel());
    pressAnims = [
      btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(.86)' }], { duration: 110, easing: EOUT, fill: 'forwards' }),
      arrow.animate([{ transform: 'none' }, { transform: 'translateY(1.6px)' }], { duration: 110, easing: EOUT, fill: 'forwards' }),
    ];
  }
  // 没点成（拖出去了 / 取消）：弹回原样
  function unpress() {
    if (!pressAnims.length) return;
    pressAnims.forEach((a) => a.cancel());
    pressAnims = [];
    if (!quiet() && btn) btn.animate([{ transform: 'scale(.86)' }, { transform: 'scale(1)' }], { duration: SPRING_POP.ms, easing: springEasing(SPRING_POP) });
  }
  // 正文离开输入栏：整段往上飘、变淡变糊（不是一下清空）；真正的正文先藏着，失败了再回来
  function lift() {
    if (!field || !box || quiet()) return;
    const g = document.createElement('div');
    g.className = 'cp-lift';
    g.textContent = field.textContent;
    const fs = getComputedStyle(field);
    Object.assign(g.style, { left: field.offsetLeft + 'px', top: field.offsetTop + 'px', width: field.offsetWidth + 'px', padding: fs.padding, font: fs.font, lineHeight: fs.lineHeight, maxHeight: field.offsetHeight + 'px' });
    box.appendChild(g);
    g.animate([{ transform: 'none', opacity: 1, filter: 'blur(0)' }, { transform: 'translateY(-26px)', opacity: 0, filter: 'blur(5px)' }], { duration: 280, easing: 'cubic-bezier(.4,0,.8,.6)', fill: 'forwards' })
      .finished.then(() => g.remove(), () => g.remove());
  }
  async function fire() {
    if (send !== 'ready') { unpress(); return; }
    const had = pressAnims.length > 0;
    pressAnims.forEach((a) => a.cancel());
    pressAnims = [];
    if (!quiet() && btn && arrow) {
      // 松开：箭头射出去、键回弹一下（键原地变成转圈，不改宽）
      arrow.animate([{ transform: 'translateY(1.6px)', opacity: 1 }, { transform: 'translateY(-20px)', opacity: 0 }], { duration: 150, easing: EIN });
      btn.animate([{ transform: had ? 'scale(.86)' : 'scale(1)' }, { transform: 'scale(1.06)', offset: 0.4 }, { transform: 'scale(1)' }], { duration: 300, easing: 'cubic-bezier(.3,0,.4,1)' });
    }
    lift();
    away = true;
    let ok = false;
    try { ok = !!(await onsend?.()); } finally { away = false; }
    if (ok && field) { field.textContent = ''; hasText = false; ontext?.(''); }
  }
</script>

<div class="cp" bind:this={box} role="presentation" onclick={focusField}>
  {#if atts}{@render atts()}{/if}
  <div class="cp-row">
    {#if plus}{@render plus()}{/if}
    <div class="cp-field" class:tall class:away bind:this={field} contenteditable="true" role="textbox" tabindex="0" aria-multiline="true" aria-label={placeholder}
      data-ph={placeholder} oninput={onInput} onkeydown={onKey} onpaste={pastePlainText} use:edgeFade={{ top: 8, bot: 8 }}></div>
    <div class="cp-sendw">
      <button class="cp-send" data-s={send} bind:this={btn} disabled={send !== 'ready'} tabindex={send === 'hidden' ? -1 : 0} aria-hidden={send === 'hidden'}
        aria-label={sendLabel || t('生成')} title={send === 'hidden' ? null : sendLabel || t('生成')} aria-busy={send === 'busy'}
        onpointerdown={press} onpointerleave={unpress} onpointercancel={unpress} onclick={fire}>
        <svg class="cp-ar" bind:this={arrow} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path pathLength="1" d="M12 18.5V6.2" /><path pathLength="1" d="M6.6 11.6 12 6.2l5.4 5.4" />
        </svg>
        <span class="cp-spin" aria-hidden="true"></span>
      </button>
    </div>
  </div>
</div>
