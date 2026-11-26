<script>
  // Codex 输入栏（整块 .comp-dock）：托盘、附件、正文、底栏（+、计划药丸、按键提示、模型、发送键），
  // 上沿叠着状态 / 出错 / 稍后发送的消息和吉祥物；轮到你决定时整块原地变成审批 / 提问面板。
  //
  // 和页面的约定（CodexPage 负责另一半）：
  //   cx-launch  首页发第一句前，在 .cx 根上发 { detail:{ from: 发送键的矩形 } }：页面让标志的下划线飞下来
  //   cx-rise    发出去 / 插话后发 { detail:{ kind:'send'|'steer', text, rect: 输入框矩形, padL, padT } }：
  //              页面让对话里那条新消息从输入框的位置升上去（「输入框里那段字往上升，变成你的消息」）
  //   附件       页面级拖放（工作空间文件、整页接住的系统文件）往 lib/codex/composer/atts.svelte.js 里塞
  import { dtHasCxThread, rawCxSideDrag, canQuoteCx, quoteCxThread, endCxMouseDrag } from '../../lib/codex/chrome/sideDnd.svelte.js';
  import { tick, untrack, onMount } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import Icon from './Icon.svelte';
  import Tray from './Tray.svelte';
  import SendKey from './SendKey.svelte';
  import AskPanel from './AskPanel.svelte';
  import QueueStack from './QueueStack.svelte';
  import ComposerAtts from './ComposerAtts.svelte';
  import SlashMenu from './SlashMenu.svelte';
  import PlusMenu from './PlusMenu.svelte';
  import Pet from './Pet.svelte';
  import {
    codex, current, send, stop, steer, enqueue, answerAsk, findModel, effortLabel, projectOf,
    newThread, forkThread, compactThread, errText, isAdmin,
  } from '../../lib/codex/store.svelte.js';
  import { codexApi } from '../../lib/codex/api.js';
  import { cxPop, togglePop, openPop, closePop } from '../../lib/codex/ui.svelte.js';
  import { anim, EASE, reduced, roll } from '../../lib/codex/motion.js';
  import { draft, addFiles, readyAtts, uploading, whenUploaded, clearAtts, sendShape, registerComposer } from '../../lib/codex/composer/atts.svelte.js';
  import { sendState, keyAction, placeholderKind, slashMatches, bangCommand } from '../../lib/codex/composer/logic.js';
  import { riseIn, lineOut } from '../../lib/codex/composer/fx.js';

  let { onAddProject = null } = $props();

  /* ---------------- 环境 ---------------- */
  // 主指针是不是手指（软键盘上回车是换行、发送靠键）。跟着媒体查询走：平板接上 / 拔掉键盘鼠标时会变
  const coarseMq = typeof matchMedia !== 'undefined' ? matchMedia('(pointer: coarse)') : null;
  let touch = $state(!!coarseMq?.matches);
  $effect(() => {
    if (!coarseMq) return;
    const on = () => { touch = coarseMq.matches; };
    coarseMq.addEventListener('change', on);
    return () => coarseMq.removeEventListener('change', on);
  });
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
  const modKey = isMac ? '⌘ ⏎' : 'Ctrl ⏎';
  let narrow = $state(false);

  let dock = $state(null);
  let wrap = $state(null);
  let comp = $state(null);
  let face = $state(null);
  let askEl = $state(null);
  let input = $state(null);
  let mbtn = $state(null);
  let nameEl = $state(null);
  let effEl = $state(null);
  let planEl = $state(null);
  let aboveEl = $state(null);
  let ring = $state(null);
  let projChip = $state(null);
  let sendKey = $state(null);
  let askPanel = $state(null);

  /* ---------------- 状态 ---------------- */
  let text = $state('');
  let opLine = $state('');          // 斜杠命令 / !命令 正在做什么（锚在输入栏上沿，不弹通知）
  let localErr = $state('');
  let pendingSend = $state(false);  // 附件还在传：等传完自己发
  let dropHot = $state(false);
  let mode = $state('input');        // input | ask（.comp 当前显示哪一面）
  let wrapMode = $state('input');    // 托盘跟着收（收回时晚一拍再出来）
  let shownAsk = $state(null);       // 面板上画的那张卡（收起时要留着它演退场）

  const thread = $derived(current());
  const busy = $derived(!!thread.running);
  const inThread = $derived(!!codex.sessionId);
  const proj = $derived(projectOf(inThread ? thread.projectId : codex.projectId));
  const hasText = $derived(text.trim().length > 0);
  // 跑着时插话 / 稍后发送只带字；附件留着等下一句
  const st = $derived(sendState({ draft: busy ? hasText : hasText || draft.atts.length > 0, busy }));
  const errLine = $derived(localErr || thread.error || '');

  const placeholder = $derived.by(() => {
    const k = placeholderKind({ home: !inThread, plan: codex.plan, busy, touch: touch || narrow });
    if (k === 'busy') return t('插话，或 {key} 稍后发送', { key: modKey });
    if (k === 'busyTouch') return t('插话，或长按发送键稍后发送');
    if (k === 'plan') return t('说说要做什么——Codex 先出计划，你点头再动手');
    if (k === 'thread') return t('要求后续更改');
    return t('随心输入');
  });

  /* ---------------- 模型按钮：字一个个滚，宽度弹过去 ---------------- */
  const model = $derived(findModel(codex.model));
  const modelName = $derived(model?.name || codex.model || t('模型'));
  const effortName = $derived(codex.effort ? effortLabel(codex.effort) : '');
  let lastW = 0;
  let firstRoll = true;
  $effect(() => {
    const name = modelName, eff = effortName;
    void codex.fast;
    if (!mbtn || !nameEl || !effEl) return;
    untrack(() => {
      const motion = !firstRoll && !reduced();
      // 正在弹的那一下被打断：从此刻的宽度接着走
      const running = mbtn.getAnimations?.() || [];
      const w0 = running.length ? mbtn.getBoundingClientRect().width : lastW;
      running.forEach((a) => a.cancel());
      roll(nameEl, name, { align: 'left', stagger: 16, instant: !motion });
      roll(effEl, eff, { align: 'left', stagger: 16, instant: !motion });
      const w1 = mbtn.offsetWidth;
      lastW = w1;
      firstRoll = false;
      if (motion && w0 && Math.abs(w0 - w1) > 0.5) anim(mbtn, [{ width: w0 + 'px' }, { width: w1 + 'px' }], { dur: 420, ease: EASE.snap });
    });
  });

  /* ---------------- 输入框 ---------------- */
  function autosize() {
    if (!input) return;
    if (!input.value) { input.style.height = ''; return; }
    input.style.height = 'auto';
    input.style.height = Math.min(220, input.scrollHeight) + 'px';
  }
  $effect(() => { void text; autosize(); });

  function clearText() {
    text = '';
    if (input) input.value = '';
    autosize();
  }

  function insertText(s) {
    if (!input) { text += s; return; }
    const a = input.selectionStart ?? text.length, b = input.selectionEnd ?? text.length;
    text = text.slice(0, a) + s + text.slice(b);
    tick().then(() => { input.focus({ preventScroll: true }); input.selectionStart = input.selectionEnd = a + s.length; });
  }

  function focusInput() {
    if (mode !== 'input') return;
    input?.focus({ preventScroll: true });
  }

  /* ---------------- 计划模式：「+」旁边长出一颗能摘掉的药丸，占位字跟着换 ---------------- */
  let planVis = $state(untrack(() => codex.plan));
  let lastPlan = untrack(() => codex.plan);
  $effect(() => {
    const on = codex.plan;
    if (on === lastPlan) return;
    lastPlan = on;
    untrack(() => planFx(on));
  });
  async function planFx(on) {
    if (on) {
      planVis = true;
      await tick();
      if (planEl && !reduced()) {
        planEl.getAnimations().forEach((a) => a.cancel());
        const w = planEl.offsetWidth;
        anim(planEl, [{ opacity: 0, transform: 'scale(.6)', width: '0px', paddingLeft: '0px', paddingRight: '0px' }, { opacity: 1, transform: 'scale(1)', width: w + 'px' }], { dur: 380, ease: EASE.snap });
      }
    } else if (!planEl || reduced()) {
      planVis = false;
    } else {
      const a = anim(planEl, [{ opacity: 1, transform: 'none', width: planEl.offsetWidth + 'px' }, { opacity: 0, transform: 'scale(.6)', width: '0px', paddingLeft: '0px', paddingRight: '0px' }], { dur: 200, ease: EASE.in });
      a?.finished.then(() => { if (!codex.plan) planVis = false; }, () => {});
    }
    if (input && !reduced()) anim(input, [{ opacity: 0.4 }, { opacity: 1 }], { dur: 260 });
  }
  const togglePlan = () => { codex.plan = !codex.plan; };

  /* ---------------- 斜杠命令 ---------------- */
  const SLASH_TEXT = $derived({
    '/review': [t('审查改动'), t('让 Codex 审查还没提交的改动')],
    '/compact': [t('压缩上下文'), t('把前面的对话整理成摘要，腾出窗口')],
    '/plan': [t('计划模式'), touch ? t('先出计划再动手') : t('先出计划再动手（Shift+Tab）')],
    '/model': [t('换模型'), t('打开模型与强度')],
    '/status': [t('上下文与额度'), t('上下文用了多少、5 小时 / 每周额度、在用哪个号')],
    '/fork': [t('从这里分叉'), t('把这条线程复制一份，另起一条接着聊')],
    '/new': [t('新线程'), t('在当前项目开一条新的')],
  });
  const bang = $derived(isAdmin() && /^!/.test(text) ? bangCommand(text) ?? '' : null);
  const slashItems = $derived.by(() => {
    if (bang !== null) {
      return [{
        cmd: '!', bang: true, disabled: !inThread || !bang,
        name: t('在项目里运行这条命令'),
        desc: !inThread ? t('先发一句话开出线程，才能在它的环境里跑命令') : bang || t('输入要跑的命令，回车运行'),
      }];
    }
    const names = Object.fromEntries(Object.entries(SLASH_TEXT).map(([k, v]) => [k, v[0]]));
    return (slashMatches(text, { inThread, names }) || []).map((s) => ({ cmd: s.cmd, name: SLASH_TEXT[s.cmd][0], desc: SLASH_TEXT[s.cmd][1] }));
  });
  let slashIdx = $state(0);
  let slashSig = '';
  $effect(() => {
    const items = slashItems;
    const m = mode;
    untrack(() => {
      // 筛出来的那几条变了：高亮回到第一条
      const sig = items.map((x) => x.cmd).join(' ');
      if (sig !== slashSig) { slashSig = sig; slashIdx = 0; }
      if (items.length && m === 'input') {
        if (cxPop.id !== 'slash' && comp) openPop('slash', comp);
      } else if (cxPop.id === 'slash') closePop('slash');
    });
  });

  async function runOp(label, fn) {
    opLine = label;
    localErr = '';
    try { await fn(); } catch (e) { localErr = errText(e, t('操作失败')); } finally { if (opLine === label) opLine = ''; }
  }

  function runSlash(i) {
    const it = slashItems[i];
    if (!it || it.disabled) return;
    closePop('slash');
    const id = codex.sessionId;
    if (it.bang) { runShell(bang); return; }
    clearText();
    switch (it.cmd) {
      case '/plan': togglePlan(); break;
      case '/model': if (mbtn) openPop('picker', mbtn); break;
      case '/status': if (ring) openPop('usage', ring); break;
      case '/new': newThread(); break;
      case '/compact': runOp(t('正在压缩上下文'), () => compactThread(id)); break;
      case '/fork': runOp(t('正在分叉'), () => forkThread(id)); break;
      case '/review': runOp(t('正在审查还没提交的改动'), () => codexApi.op('review', id, { target: { type: 'uncommittedChanges' } })); break;
    }
  }

  function runShell(command) {
    if (!command || !codex.sessionId) return;
    clearText();
    const id = codex.sessionId;
    runOp(t('正在运行 {cmd}', { cmd: command.length > 48 ? command.slice(0, 47) + '…' : command }), () => codexApi.op('shell', id, { command }));
  }

  /* ---------------- 发送 / 插话 / 稍后发送 ---------------- */
  function dispatch(name, detail) {
    comp?.closest('.cx')?.dispatchEvent(new CustomEvent(name, { detail }));
  }
  function riseDetail(kind, msg) {
    const r = input?.getBoundingClientRect();
    const cs = input ? getComputedStyle(input) : null;
    return { kind, text: msg, rect: r, padL: cs ? parseFloat(cs.paddingLeft) : 16, padT: cs ? parseFloat(cs.paddingTop) : 13 };
  }

  async function submit(kind) {
    if (cxPop.id === 'slash') closePop('slash');
    const msg = text.trim();
    localErr = '';
    if (busy) {
      if (!msg) return;
      if (kind === 'queue') {
        if (await enqueue(msg)) clearText();
        return;
      }
      sendKey?.steerFly();
      const detail = riseDetail('steer', msg);
      clearText();
      const ok = steer(msg);
      tick().then(() => dispatch('cx-rise', detail));
      await ok;
      return;
    }
    if (bang !== null) { runShell(bang); return; }
    if (uploading()) {
      if (pendingSend) return;
      pendingSend = true;
      await whenUploaded();
      pendingSend = false;
      if (busy) return;
    }
    const body = text.trim();
    const atts = readyAtts();
    if (!body && !atts.length) return;
    const isNew = !codex.sessionId;
    if (isNew && !codex.projectId) {
      localErr = t('先选一个项目');
      if (projChip) { if (codex.projects.length) openPop('proj', projChip); else onAddProject?.(); }
      return;
    }
    if (isNew) dispatch('cx-launch', { from: sendKey?.rect?.() || null });
    const detail = riseDetail('send', body);
    sendKey?.launch();
    const ok = send(body, { attachments: sendShape(atts) });
    if (!ok) return;
    clearText();
    clearAtts();
    tick().then(() => dispatch('cx-rise', detail));
  }

  function onKey(e) {
    if (cxPop.id === 'slash' && slashItems.length && !e.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = slashItems.length;
        slashIdx = (slashIdx + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); runSlash(slashIdx); return; }
    }
    const a = keyAction(e, { busy, draft: busy ? hasText : hasText || draft.atts.length > 0, touch });
    if (!a) return;
    e.preventDefault();
    if (a === 'noop') return;
    if (a === 'plan') { togglePlan(); return; }
    // 键盘发的也按一下键：先收，再推出去
    sendKey ? sendKey.press(() => submit(a)) : submit(a);
  }

  function onSendKey(state) {
    if (state === 'busy') { stop(); return; }
    submit(state === 'steer' ? 'steer' : 'send');
  }

  /* ---------------- 粘贴 / 拖进来的文件 ---------------- */
  function onPaste(e) {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    // 同时带字的（从网页、文档里复制）按字粘；只有文件 / 截图时才当附件
    if (e.clipboardData.getData('text/plain')) return;
    e.preventDefault();
    addFiles(files);
  }
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  // 侧栏拖来的线程 = 引用那条线程（同 Claude 输入栏）；系统文件 = 上传成附件
  const threadDrag = (e) => { const r = dtHasCxThread(e) && rawCxSideDrag(); return r && canQuoteCx(r.id) ? r : null; };
  function onDragOver(e) {
    if (mode === 'input' && threadDrag(e)) {
      e.preventDefault(); e.stopPropagation();
      try { e.dataTransfer.dropEffect = 'copy'; } catch {}
      dropHot = true;
      return;
    }
    if (!hasFiles(e) || mode !== 'input') return;
    e.preventDefault();
    e.stopPropagation();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
    dropHot = true;
  }
  function onDragLeave(e) { if (!comp?.contains(e.relatedTarget)) dropHot = false; }
  function onDrop(e) {
    dropHot = false;
    const rec = mode === 'input' ? threadDrag(e) : null;
    if (rec) { e.preventDefault(); e.stopPropagation(); endCxMouseDrag(); quoteCxThread(rec); return; }
    if (!hasFiles(e) || mode !== 'input') return;
    e.preventDefault();
    e.stopPropagation();
    addFiles(e.dataTransfer.files);
    focusInput();
  }

  /* ---------------- 审批 / 提问：输入栏原地变成决定面板 ---------------- */
  let lastPicked = -1;
  let ghosts = [];

  $effect(() => {
    const a = thread.ask;
    const qid = a?.qid || '';
    untrack(() => {
      if (qid === (shownAsk?.qid || '')) { if (a) shownAsk = a; return; }
      morphAsk(a || null);
    });
  });

  function dropGhosts() {
    ghosts.forEach((g) => g.remove());
    ghosts = [];
  }

  async function morphAsk(next) {
    const picked = lastPicked;
    lastPicked = -1;
    const toAsk = !!next;
    const fromAsk = mode === 'ask';
    if (cxPop.id) closePop();
    if (!comp || !face || reduced()) {
      shownAsk = next;
      mode = wrapMode = toAsk ? 'ask' : 'input';
      if (toAsk) { await tick(); askPanel?.focusFirst?.(); }
      return;
    }
    // 先记下此刻的高度（正弹着就是弹到一半的高度），再取消还在跑的变形，从这里接着走
    const h0 = comp.offsetHeight;
    comp.getAnimations().forEach((a) => a.cancel());
    dropGhosts();
    const src = fromAsk ? askEl : face;
    const ghost = src.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.style.cssText = `position:absolute;left:0;right:0;top:0;pointer-events:none;${fromAsk ? 'display:block;' : ''}`;
    const ta = ghost.querySelector('textarea');
    if (ta && input) ta.value = input.value;

    shownAsk = next;
    mode = toAsk ? 'ask' : 'input';
    if (toAsk) wrapMode = 'ask';
    await tick();
    const h1 = comp.offsetHeight;
    comp.appendChild(ghost);
    ghosts.push(ghost);
    const rm = () => { ghost.remove(); ghosts = ghosts.filter((g) => g !== ghost); };

    if (toAsk) {
      anim(comp, [{ height: h0 + 'px' }, { height: h1 + 'px' }], { dur: 520, ease: EASE.soft });
      anim(ghost, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px) scale(.99)' }], { dur: 130, ease: EASE.in })?.finished.then(rm, rm);
      [...(askEl?.children || [])].forEach((el, i) => anim(el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { dur: 340, delay: 90 + i * 45 }));
      setTimeout(() => { if (mode === 'ask') askPanel?.focusFirst?.(); }, 140);
      return;
    }
    // 收回：按下的那项先收再弹，其余退场；面板停一拍再收回成输入栏，正文淡回来
    ghost.querySelectorAll('.aopt').forEach((o, i) => {
      if (i === picked) anim(o, [{ transform: 'scale(.985)' }, { transform: 'scale(1.01)', offset: 0.5 }, { transform: 'scale(1)' }], { dur: 260, ease: EASE.out });
      else anim(o, [{ opacity: 1 }, { opacity: 0 }], { dur: 140, ease: EASE.in });
    });
    anim(ghost, [{ opacity: 1 }, { opacity: 0 }], { dur: 150, ease: EASE.in, delay: picked >= 0 ? 200 : 0 })?.finished.then(rm, rm);
    anim(comp, [{ height: h0 + 'px' }, { height: h0 + 'px', offset: picked >= 0 ? 0.32 : 0.12 }, { height: h1 + 'px' }], { dur: picked >= 0 ? 640 : 480, ease: EASE.soft });
    anim(face, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { dur: 300, delay: picked >= 0 ? 260 : 120 });
    setTimeout(() => { if (mode === 'input') wrapMode = 'input'; }, 300);
    if (!touch) setTimeout(focusInput, 300);
  }

  async function onAnswer(payload, idx, extra = {}) {
    const th = thread;
    lastPicked = idx;
    const e = await answerAsk(th, payload);
    if (e) { lastPicked = -1; return e; }
    // 拒绝时写了理由：拒绝之后把这句当插话送进这一轮（这一轮已经停了就当一句新话发）
    if (extra.steer) {
      if (th.running) await steer(extra.steer);
      else send(extra.steer);
    }
    return '';
  }

  /* ---------------- 上沿：排队的卡叠起来时，吉祥物蹲到最上面 ---------------- */
  let aboveH = $state(0);
  $effect(() => {
    if (!aboveEl) return;
    const ro = new ResizeObserver(() => {
      const h = aboveEl.offsetHeight;
      aboveH = h > 12 ? h - 6 : 0;
    });
    ro.observe(aboveEl);
    return () => ro.disconnect();
  });

  /* ---------------- 挂载 ---------------- */
  onMount(() => {
    const off = registerComposer({ focus: focusInput, insert: insertText });
    const root = dock?.closest('.cx') || dock?.parentElement;
    let ro = null;
    if (root && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => { narrow = root.clientWidth <= 640; });
      ro.observe(root);
    }
    return () => { off(); ro?.disconnect(); };
  });

  // 换线程 / 选了项目：出错行与操作行是之前的，清掉；桌面上光标回到输入框
  $effect(() => {
    void codex.sessionId;
    void codex.projectId;
    untrack(() => {
      localErr = '';
      opLine = '';
      if (!touch) tick().then(focusInput);
    });
  });

  function dismissErr() {
    localErr = '';
    const th = thread;
    if (th.error) th.error = '';
  }

  function onPlus(e) { e.stopPropagation(); togglePop('plus', e.currentTarget); }
  function onModel(e) { e.stopPropagation(); togglePop('picker', e.currentTarget); }
  function onSlashFromPlus() {
    text = '/';
    tick().then(() => { input?.focus({ preventScroll: true }); autosize(); });
  }
</script>

<div class="comp-dock" bind:this={dock} style="--sp-snap:{EASE.snap}">
  <div class="comp-wrap" data-mode={wrapMode} bind:this={wrap}>
    <Pet lift={aboveH} />

    <div class="above" bind:this={aboveEl}>
      {#if opLine}
        <div class="st-line" in:riseIn={{ dy: 8 }} out:lineOut>
          <svg class="spin" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.2" /></svg><span>{opLine}</span>
        </div>
      {/if}
      {#if errLine}
        <div class="st-line err" role="alert" in:riseIn={{ dy: 8 }} out:lineOut>
          <Icon name="warn" size={15} /><span class="tx">{errLine}</span>
          <button type="button" class="ibtn sm" title={t('知道了')} aria-label={t('知道了')} onclick={dismissErr}><Icon name="x" /></button>
        </div>
      {/if}
      <QueueStack {busy} onerror={(m) => { localErr = m; }} />
    </div>

    <Tray {onAddProject} bind:ring bind:projChip />

    <div
      class="comp sq"
      class:drop={dropHot}
      data-mode={mode}
      data-plan={planVis ? 'on' : 'off'}
      bind:this={comp}
      ondragover={onDragOver}
      ondragleave={onDragLeave}
      ondrop={onDrop}
      role="group"
      aria-label={t('输入栏')}
    >
      <div class="comp-face" bind:this={face} inert={mode === 'ask'}>
        <ComposerAtts onremove={focusInput} />
        <div class="comp-field">
          <textarea
            bind:this={input}
            bind:value={text}
            class="comp-input"
            rows="1"
            {placeholder}
            aria-label={t('给 Codex 的消息')}
            enterkeyhint={touch ? 'enter' : 'send'}
            onkeydown={onKey}
            onpaste={onPaste}
          ></textarea>
        </div>
        <div class="comp-bar">
          <button
            type="button"
            class="cbtn round"
            title={t('添加文件、计划模式、命令')}
            aria-label={t('添加文件、计划模式、命令')}
            aria-expanded={cxPop.id === 'plus' ? 'true' : 'false'}
            onclick={onPlus}
          ><Icon name="plus" /></button>
          <button
            bind:this={planEl}
            type="button"
            class="cbtn planind"
            title={touch ? t('关闭计划模式') : t('关闭计划模式（Shift+Tab）')}
            onclick={() => { codex.plan = false; }}
          ><Icon name="plan" /><span>{t('计划')}</span><Icon name="x" class="x" /></button>
          <div class="hint" class:on={st === 'steer'} aria-hidden="true"><kbd>⏎</kbd> {t('插话')}<span class="sep">·</span><kbd>{modKey}</kbd> {t('稍后发送')}</div>
          <button
            bind:this={mbtn}
            type="button"
            class="cbtn mbtn"
            class:fast={codex.fast}
            title={t('模型与强度')}
            aria-expanded={cxPop.id === 'picker' ? 'true' : 'false'}
            onclick={onModel}
          ><Icon name="bolt" class="fast" /><span class="roll" bind:this={nameEl}></span><span class="eff roll" bind:this={effEl}></span><Icon name="chev" class="cv" /></button>
          <SendKey bind:this={sendKey} {st} touch={touch || narrow} onpress={onSendKey} onqueue={() => submit('queue')} />
        </div>
      </div>
      <div class="comp-ask" bind:this={askEl}>
        {#if shownAsk}
          <AskPanel bind:this={askPanel} ask={shownAsk} active={mode === 'ask'} admin={isAdmin()} root={proj?.path || ''} onanswer={onAnswer} />
        {/if}
      </div>
    </div>
  </div>
</div>

<PlusMenu touch={touch || narrow} onfiles={(files) => { addFiles(files); focusInput(); }} onslash={onSlashFromPlus} />
<SlashMenu items={slashItems} idx={slashIdx} onpick={runSlash} onhover={(i) => { slashIdx = i; }} />

<style>
  .comp-field { position: relative; }
  /* 系统文件拖到输入栏上方：描边提亮一档（不加颜色） */
  .comp.drop { border-color: var(--fg3); }
  .st-line .tx { min-width: 0; overflow-wrap: anywhere; }
  .st-line.err { height: auto; min-height: 28px; padding: 4px 4px 4px 12px; color: var(--fg); }
  .st-line.err > :global(svg) { flex: none; color: var(--warn); }
  .st-line .ibtn { flex: none; }
  .mbtn { flex: none; }
  .mbtn .eff:empty { display: none; }
</style>
