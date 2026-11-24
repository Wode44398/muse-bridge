<script>
  // 输入区：底栏模型 + 紧随其后的淡色思考档位、右端开口仪表（工作空间文件夹在页面顶栏左侧、侧栏按钮右边）
  // （运行模式入口，兼显上下文与额度；空闲时占发送键的位置，有内容 / 在跑时发送键从它身后分身弹出）——全页唯一参数入口；
  // 静息态保持零动画 1px 细描边避免常驻 GPU 光栅化，聚焦时唤醒柔和流光环，生成时提速流转。
  import {
    agy,
    fallbackAgyCaps,
    sendAgyMessage,
    sendAgyVoice,
    sendAgyLater,
    stopAgyTurn,
    uploadAgyFile,
    attachAgyTransfer,
    removeAgyDraftAtt,
    removeAgyQueued,
    sendAgyQueuedNow,
  } from '../../lib/agy/store.svelte.js';
  import { ui } from '../../lib/state.svelte.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { createVoiceRecorder, voiceErrorMessage } from '../../lib/agy/voice-recorder.js';
  import { formatVoiceTimer } from '../../lib/agy/voice-peaks.js';
  import { devices, loadDevices, thisDeviceId } from '../../lib/devices.svelte.js';
  import { isNativeDesktop } from '../../lib/nativeDesktop.js';
  import {
    groupModels,
    modelDisplayName,
    extractThoughtOptions,
    filterSlashCommands,
  } from '../../lib/agy/logic.js';
  import { brandLogoOfModel, modeShortOf } from '../../lib/agy/composer-meta.js';
  import AgySendCluster from './AgySendCluster.svelte';
  import { agyContextPct, gaugeQuota } from '../../lib/agy/usage.js';
  import { refreshAgyQuota } from '../../lib/agy/store.svelte.js';
  import BrandLogo from '../modelhub/BrandLogo.svelte';
  import AgyGauge from './AgyGauge.svelte';
  import { drag, dragPayload, dropZone } from '../../lib/dragdrop.svelte.js';
  import { agentDropZone, dtHasWsFiles, wsDescriptorFrom, attachDescriptorToAgent } from '../../lib/fileDrag.js';
  import {
    agySideDrag,
    getRawAgySideDrag,
    isAgyChatRef,
    isAgyProjRef,
    canQuoteAgy,
    canRefAgyFolder,
    quoteAgySession,
    refAgyFolder,
  } from '../../lib/agy/chat-quote.svelte.js';
  import { attDragSrc } from '../../lib/dragOut.js';
  import { openPreview } from '../../lib/preview.svelte.js';
  import { rectOf } from '../../lib/chatGallery.js';
  import { attLook, draftAttDescriptor, buildDraftMediaGallery } from '../../lib/agy/attach-look.js';
  import AgyAttachment from './AgyAttachment.svelte';
  import AgyAttachMenu from './AgyAttachMenu.svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { onMount, onDestroy } from 'svelte';
  import { takeComposerFrom } from '../../lib/agy/hero.js';
  import { SPRING, springTiming, reducedMotion, emphasized } from '../../lib/agy/motion.js';
  import { glowCaret } from '../../lib/agy/glow-caret.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { agyDeviceView, agyDeviceText } from '../../lib/agy/device-view.js';

  // centered：欢迎页那只（占位语、不显示排队条）；docked：欢迎页但贴底摆（手机档），外观与位置同对话态
  const { centered = false, docked = false } = $props();
  const floating = $derived(centered && !docked);
  let cboxEl = $state(null);

  let textareaEl = $state(null);
  let fileInputEl = $state(null);
  let clusterRef = $state(null);
  let waveCanvasEl = $state(null);
  let focused = $state(false);
  let draggingOver = $state(false);
  let slashDismissedFor = $state('');
  let slashIdx = $state(0);

  // 原生语音输入态（空输入框空闲时，长按右下角开口仪表开启）
  let voicePhase = $state('idle');      // 'idle' | 'charging' | 'recording' | 'cancelling' | 'sending'
  let voiceCancelArmed = $state(false);
  let voiceCharge = $state(0);
  let voiceElapsedMs = $state(0);
  let voiceSending = $state(false);
  const voiceRecording = $derived(voicePhase === 'recording' || voicePhase === 'cancelling');
  const voiceTimerText = $derived(formatVoiceTimer(voiceElapsedMs));

  const waveHistory = new Array(36).fill(0.06);
  let waveAcc = 0;
  let recorder = createVoiceRecorder({
    onAutoStop: () => {
      showToast(t('已达单条语音 5 分钟上限，自动发送'));
      clusterRef?.commitVoiceNow?.();
    },
  });

  const fallbackCommands = $derived([
    { name: 'plan', description: t('先制定分步实施方案再执行') },
    { name: 'compact', description: t('压缩当前对话上下文窗口') },
    { name: 'goal', description: t('围绕目标持续推进长任务直至完成') },
    { name: 'boost', description: t('深度多视角分析与严格验证') },
    { name: 'grill-me', description: t('通过交互访谈对齐方案细节') },
    { name: 'learn', description: t('将当前经验沉淀为持久知识') },
  ]);

  const slashList = $derived.by(() => {
    if (agy.draftText === slashDismissedFor) return [];
    const pool = agy.commands.length > 0 ? agy.commands : fallbackCommands;
    return filterSlashCommands(pool, agy.draftText);
  });

  const activeModelId = $derived.by(() => {
    const fb = fallbackAgyCaps();
    return agy.model || groupModels(agy.configOptions, fb.models).current;
  });
  const activeModelShort = $derived.by(() => {
    const fb = fallbackAgyCaps();
    const grouped = groupModels(agy.configOptions, fb.models);
    return modelDisplayName(activeModelId, grouped.flat, { short: true }) || 'Gemini 4';
  });

  const activeThought = $derived.by(() => {
    const fb = fallbackAgyCaps();
    const th = extractThoughtOptions(agy.configOptions, fb.efforts, activeModelId, fb.models);
    if (!th.options.length) return null;
    return th.options.find((o) => o.id === (agy.thoughtLevel || th.current)) || th.options[0];
  });

  const modeShort = $derived(modeShortOf(agy.mode || 'default'));

  // 电脑芯片：这个会话连着你哪台电脑（device_* 工具的默认目标）。没有任何设备、也不在桌面客户端里时整颗不出现。
  // 手机档底栏放不下它（一打字仪表就分身出发送键，模型名被挤成省略号）→ 改进仪表菜单的「运行环境」行（ModelSheet kind=mode）
  $effect(() => { if (!devices.loaded) loadDevices(); });
  const showDevice = $derived(!layout.compact && devices.enabled && (devices.list.length > 0 || isNativeDesktop()));
  const devPick = $derived(agy.sessionId ? agy.deviceLink : (agy.deviceDraft === 'auto' ? '' : agy.deviceDraft));
  const devView = $derived(agyDeviceView(devices.list, devPick, thisDeviceId()));
  const devLabel = $derived(agyDeviceText(devView, t));
  const devTone = $derived(devView.tone);
  // 开口仪表：中间数字 = 当前会话上下文占用，环的填充段 = 周额度，指示点 = 5 小时额度（最吃紧的模型分组），
  // 开口 = 运行模式；点开选模式、看明细
  const ctxPct = $derived(agyContextPct(agy.contextUsage));
  const gq = $derived(gaugeQuota(agy.quota));
  // 额度读的是 language server 的本机缓存（不联网、不耗额度）：挂着就每分钟读一次，后台标签页不空转、回前台立刷
  $effect(() => {
    refreshAgyQuota();
    const iv = setInterval(() => { if (!document.hidden) refreshAgyQuota(); }, 60_000);
    const onVis = () => { if (!document.hidden) refreshAgyQuota(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  });
  const gaugeTitle = $derived([
    t('运行模式：{mode}', { mode: modeShort.label }),
    ctxPct != null ? t('上下文 {pct}%', { pct: ctxPct }) : '',
    gq?.weekly ? t('{group} 周额度 {pct}%', { group: gq.group, pct: Math.round(gq.weekly.usedPct) }) : '',
    gq?.fiveH ? t('5 小时额度 {pct}%', { pct: Math.round(gq.fiveH.usedPct) }) : '',
    !hasDraft && !agy.busy ? t('长按录制原生语音') : '',
  ].filter(Boolean).join(' · '));


  // 欢迎页 ⇄ 对话切换：新位置的输入框从旧位置滑过来（弹簧，落位带一点点回弹），
  // 流光环接着旧的那颗转（同一个转角），不从 0° 重新起
  // 接力数据在脚本初始化时就取（切换前 AgyPage 的 pre effect 已记好）：旧饱和度要在插入那一刻就生效，
  // 等到 onMount 再钉就晚了——那时样式已按新状态算过一次，钉旧值反而会触发一次反向过渡
  const from = takeComposerFrom();
  let ringHold = $state(from?.ringA ?? null);
  onMount(() => {
    if (!from || !cboxEl) return;
    const to = cboxEl.getBoundingClientRect();
    const dx = (from.rect.left + from.rect.width / 2) - (to.left + to.width / 2);
    const dy = (from.rect.top + from.rect.height / 2) - (to.top + to.height / 2);
    const spin = spinAnim();
    if (spin && from.spinTime != null) { try { spin.currentTime = from.spinTime; } catch {} }
    if (ringHold != null) {
      // 环的饱和度从旧值过渡到新状态：首帧按旧值画，下一帧放开让 transition 接手
      requestAnimationFrame(() => requestAnimationFrame(() => { ringHold = null; }));
    }
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    try {
      cboxEl.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        springTiming(SPRING.spatial),
      );
    } catch {}
  });

  // 流光环提速 / 减速：只有一条 10s 一圈的转角动画，「在干活」时把它的播放速率在 0.7s 内平滑推到 2.5 倍
  // （= 4s 一圈），停下时再缓回来。直接改 animation-duration 会让转角按新时长重算、整圈跳一下。
  function spinAnim() {
    if (!cboxEl?.getAnimations) return null;
    return cboxEl.getAnimations().find((a) => /agy-conic-spin$/.test(a.animationName)) || null;
  }
  // 一轮结束时流光环不是一帧消失：多留 0.7s（.tail）——转速缓回、饱和度褪回、整圈淡出，再还给静态细描边
  let glowTail = $state(false);
  let wasBusy = agy.busy;
  $effect(() => {
    const b = agy.busy;
    if (b === wasBusy) return;
    wasBusy = b;
    if (b || reducedMotion()) { glowTail = false; return; }
    glowTail = true;
    const tm = setTimeout(() => { glowTail = false; }, 720);
    return () => clearTimeout(tm);
  });
  // 11-19 维护者：新对话页也只在聚焦（或在干活 / 录音）时亮流光，不再常亮
  const glowOn = $derived(focused || agy.busy || glowTail || voiceRecording);
  let rateRaf = 0;
  $effect(() => {
    const want = agy.busy ? 2.5 : (voiceRecording ? 1.55 : 1);
    void glowOn;
    if (!cboxEl) return;
    let cancelled = false;
    // 等这一帧的样式生效（.glow 刚加上时动画对象下一帧才建出来）
    const kick = requestAnimationFrame(() => {
      if (cancelled) return;
      const a = spinAnim();
      if (!a) return;
      const from = a.playbackRate || 1;
      if (Math.abs(from - want) < 0.01) return;
      if (reducedMotion()) { a.playbackRate = want; return; }
      const t0 = performance.now();
      const stepRate = (now) => {
        if (cancelled) return;
        const p = Math.min(1, (now - t0) / 700);
        try { a.playbackRate = from + (want - from) * emphasized(p); } catch { return; }
        if (p < 1) rateRaf = requestAnimationFrame(stepRate);
      };
      rateRaf = requestAnimationFrame(stepRate);
    });
    return () => { cancelled = true; cancelAnimationFrame(kick); cancelAnimationFrame(rateRaf); };
  });

  $effect(() => {
    if (!centered || !textareaEl) return;
    const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches;
    if (!coarse) textareaEl.focus({ preventScroll: true });
  });

  function openPop(kind, el) {
    const r = el?.getBoundingClientRect?.();
    agy.popAnchor = r ? { left: r.left, top: r.top, bottom: r.bottom, width: r.width } : null;
    agy.popAnchorEl = el || null;
    if (kind === 'folder') {
      agy.sheetKind = '';
      agy.projectSheetOpen = !agy.projectSheetOpen;
    } else {
      agy.projectSheetOpen = false;
      agy.sheetKind = agy.sheetKind === kind ? '' : kind;
    }
  }

  function onBoxClick(ev) {
    if (voicePhase !== 'idle') return;
    const tEl = ev.target;
    if (tEl?.closest?.('button, a, input, textarea, [role="button"], .aa')) return;
    textareaEl?.focus();
  }

  const anyUploading = $derived(agy.draftAtts.some((a) => a.pending));
  const hasDraft = $derived(agy.draftText.trim().length > 0 || agy.draftAtts.length > 0);
  // 空输入框且空闲（未在加载 / 未在发送上一条语音）时，长按开口仪表开启原生语音输入
  const voiceEnabled = $derived(!hasDraft && !agy.busy && !agy.loadingSession && !voiceSending);
  // 发送 / 停止键只在「可能要按它」时出现：输入框有字或有附件、或者正在跑
  const showAction = $derived(agy.busy || hasDraft);

  function handleVoiceState(st) {
    voicePhase = st.phase;
    voiceCancelArmed = st.cancelArmed;
    voiceCharge = st.charge;
    voiceElapsedMs = st.elapsedMs;
  }

  async function handleVoiceBegin() {
    agy.sheetKind = '';
    agy.projectSheetOpen = false;
    attachMenuOpen = false;
    textareaEl?.blur();
    waveHistory.fill(0.06);
    waveAcc = 0;
    try {
      const res = await recorder.start();
      if (res?.cancelled) return;
    } catch (err) {
      showToast(voiceErrorMessage(err, t), 'err');
      clusterRef?.abortVoiceToIdle?.();
    }
  }

  function handleVoiceCancel({ reason } = {}) {
    recorder.cancel();
    if (reason === 'short') {
      showToast(t('按住时间太短，请继续按住说完再松手'));
    }
  }

  async function handleVoiceSend() {
    voiceSending = true;
    try {
      const captured = await recorder.stop();
      if (!captured) {
        showToast(t('未录到有效声音，请重试'), 'err');
        return { ok: false };
      }
      return await sendAgyVoice(captured);
    } finally {
      voiceSending = false;
    }
  }

  function drawLiveWaveform(amp, dt, armed) {
    const canvas = waveCanvasEl;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 120;
    const h = canvas.clientHeight || 22;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }

    waveAcc += dt;
    if (waveAcc >= 0.048) {
      waveAcc = 0;
      waveHistory.push(amp);
      if (waveHistory.length > 42) waveHistory.shift();
      if (!armed) recorder.recordEnvelopePoint(amp);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const light = Boolean(cboxEl?.closest?.('.agy-root.light'));
    const gap = 3.2;
    const barW = 2.2;
    const step = barW + gap;
    const count = Math.max(10, Math.min(34, Math.floor(w / step)));
    const startX = (w - count * step + gap) * 0.5;
    const cy = h * 0.5;
    const off = Math.max(0, waveHistory.length - count);

    ctx.fillStyle = armed
      ? (light ? 'rgba(217, 48, 37, 0.52)' : 'rgba(240, 122, 114, 0.55)')
      : (light ? 'rgba(47, 128, 237, 0.85)' : 'rgba(74, 144, 240, 0.9)');
    for (let i = 0; i < count; i++) {
      const v = waveHistory[off + i] ?? 0.08;
      const edge = Math.sin(((i + 0.5) / count) * Math.PI);
      const bh = Math.max(3, (3 + v * 17) * (0.45 + 0.55 * edge));
      const x = startX + i * step;
      const y = cy - bh * 0.5;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barW, bh, 99);
      else ctx.rect(x, y, barW, bh);
      ctx.fill();
    }
    ctx.restore();
  }

  // 键盘无障碍与快捷兜底：空框失焦按住 Space 蓄力录音、Esc 取消；切到后台自动安全停麦
  onMount(() => {
    let spaceHeld = false;
    const isTypingTarget = (el) => Boolean(el?.closest?.('input, textarea, select, button, a, [contenteditable="true"], [role="dialog"]'));
    const onWinKeyDown = (ev) => {
      if (ui.screen !== 'agy') return;
      if (ev.key === 'Escape' && (voicePhase === 'recording' || voicePhase === 'charging')) {
        ev.preventDefault();
        spaceHeld = false;
        clusterRef?.cancelVoice?.({ animate: true, reason: 'cancel' });
        return;
      }
      if (
        ev.code === 'Space'
        && !ev.repeat
        && !ev.ctrlKey && !ev.metaKey && !ev.altKey
        && voiceEnabled
        && !agy.sheetKind && !agy.projectSheetOpen && !agy.pickerOpen && !agy.hiddenOpen && !attachMenuOpen
        && !isTypingTarget(document.activeElement)
      ) {
        if (clusterRef?.startKeyVoice?.()) {
          ev.preventDefault();
          spaceHeld = true;
        }
      }
    };
    const onWinKeyUp = (ev) => {
      if (ev.code === 'Space' && spaceHeld) {
        spaceHeld = false;
        clusterRef?.endKeyVoice?.();
      }
    };
    const onVisChange = () => {
      if (document.hidden && (voicePhase === 'recording' || voicePhase === 'charging')) {
        spaceHeld = false;
        clusterRef?.cancelVoice?.({ animate: false, reason: 'interrupt' });
      }
    };
    window.addEventListener('keydown', onWinKeyDown);
    window.addEventListener('keyup', onWinKeyUp);
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      window.removeEventListener('keydown', onWinKeyDown);
      window.removeEventListener('keyup', onWinKeyUp);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  });

  onDestroy(() => {
    recorder.cancel();
  });
  // 它还在干活时也能发：默认中途插话（做完手头这一步就读到），也可以改成这一轮结束后再发
  //（新对话头一两秒还没有会话 id，送不进去）
  const canSend = $derived(
    !anyUploading
    && (agy.draftText.trim().length > 0 || agy.draftAtts.some((a) => a.path))
    && (!agy.busy || !!agy.sessionId)
  );
  // 在跑且输入框是空的 → 停止键；有内容 → 发送键（发出去就是插话）
  const asStop = $derived(agy.busy && !hasDraft);
  // 在跑且写了东西：输入框上方出一行说明这条会怎么发，并给「稍后发送」这一个入口
  const steerHint = $derived(agy.busy && hasDraft && !!agy.sessionId);
  const queueLabel = (q) => q.text || (q.atts || []).map((a) => a.name).filter(Boolean).join('、') || t('附件');

  function syncHeight() {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = Math.min(180, Math.max(24, textareaEl.scrollHeight)) + 'px';
  }

  $effect(() => {
    agy.draftText;
    syncHeight();
  });

  function applySlash(cmd) {
    if (!cmd) return;
    agy.draftText = `/${cmd.name} `;
    slashIdx = 0;
    textareaEl?.focus();
  }

  function onKeyDown(ev) {
    if (slashList.length > 0) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        slashIdx = (slashIdx + 1) % slashList.length;
        return;
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        slashIdx = (slashIdx - 1 + slashList.length) % slashList.length;
        return;
      }
      if ((ev.key === 'Enter' || ev.key === 'Tab') && !ev.isComposing) {
        ev.preventDefault();
        applySlash(slashList[slashIdx] || slashList[0]);
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        slashDismissedFor = agy.draftText;
        return;
      }
    }

    // 输入框里有字时发送键是「插话」：停止改由 Shift+Esc（同 Claude 页的「立即打断」）
    if (ev.key === 'Escape' && ev.shiftKey && agy.busy) {
      ev.preventDefault();
      stopAgyTurn();
      return;
    }

    // 在跑时 Ctrl / Cmd + Enter = 稍后发送（这一轮结束后再发），同 Claude 页
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.isComposing && agy.busy) {
      ev.preventDefault();
      if (canSend) sendAgyLater();
      return;
    }

    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches;
      if (!coarse) {
        ev.preventDefault();
        if (canSend) sendAgyMessage();
      }
    }
  }

  function onInput(ev) {
    agy.draftText = ev.currentTarget.value;
    if (slashDismissedFor && agy.draftText !== slashDismissedFor) {
      slashDismissedFor = '';
    }
    slashIdx = 0;
    syncHeight();
  }

  function onPaste(ev) {
    const items = ev.clipboardData?.items;
    if (!items) return;
    // 粘贴进来的文件夹（资源管理器复制的目录）走文件夹分支，别当文件上传
    if (attachAgyTransfer(ev.clipboardData)) { ev.preventDefault(); return; }
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          ev.preventDefault();
          uploadAgyFile(file);
        }
      }
    }
  }

  // 加号：触屏多一个照片专用入口（AgyAttachMenu），桌面点了直接选文件
  let photoInputEl = $state(null);
  let addBtnEl = $state(null);
  let attachMenuOpen = $state(false);
  function onAddClick() {
    const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches;
    if (coarse) attachMenuOpen = !attachMenuOpen;
    else fileInputEl?.click();
  }

  function onPickFiles(ev) {
    const files = Array.from(ev.currentTarget.files || []);
    ev.currentTarget.value = '';
    for (const f of files) uploadAgyFile(f);
  }

  const baseDrop = agentDropZone('agy', { label: t('挂进这个对话') });
  const composerDropZone = {
    key: 'agy-composer',
    effect: 'copy',
    label: (p) => {
      if (isAgyChatRef(p)) return t('引用到这个对话');
      if (isAgyProjRef(p)) return t('引用文件夹「{name}」', { name: p.name });
      return typeof baseDrop.label === 'function' ? baseDrop.label(p) : baseDrop.label;
    },
    accept: (p) => {
      if (isAgyChatRef(p)) return canQuoteAgy(p.id, agy.sessionId);
      if (isAgyProjRef(p)) return canRefAgyFolder(p.path);
      return baseDrop.accept ? baseDrop.accept(p) : false;
    },
    drop: (p) => {
      if (isAgyChatRef(p)) return quoteAgySession({ id: p.id, title: p.name, cwd: p.cwd || '' });
      if (isAgyProjRef(p)) return refAgyFolder({ path: p.path, name: p.name });
      return baseDrop.drop?.(p);
    },
  };

  // 侧栏正在拖会话 / 工作空间时的视觉引导（鼠标 HTML5 拖拽 + 触屏长按拿起）
  const touchSidePayload = $derived(drag.on ? dragPayload() : null);
  const sideDragCand = $derived.by(() => {
    if (agySideDrag.kind === 'session') {
      if (agySideDrag.id === agy.sessionId) return { kind: 'session', ok: false, hint: t('当前就在这段对话里') };
      if (!canQuoteAgy(agySideDrag.id, agy.sessionId)) return { kind: 'session', ok: false, hint: t('这个对话已经引用过了') };
      return { kind: 'session', ok: true, hint: t('放到输入框＝引用这段对话') };
    }
    if (agySideDrag.kind === 'project' && agySideDrag.path) {
      if (!canRefAgyFolder(agySideDrag.path)) return { kind: 'project', ok: false, hint: t('这个文件夹已经引用过了') };
      return { kind: 'project', ok: true, hint: t('放到输入框＝引用这个文件夹') };
    }
    if (isAgyChatRef(touchSidePayload)) {
      return canQuoteAgy(touchSidePayload.id, agy.sessionId)
        ? { kind: 'session', ok: true, hint: t('放到输入框＝引用这段对话') }
        : null;
    }
    if (isAgyProjRef(touchSidePayload)) {
      return canRefAgyFolder(touchSidePayload.path)
        ? { kind: 'project', ok: true, hint: t('放到输入框＝引用这个文件夹') }
        : null;
    }
    return null;
  });

  function onDragOver(ev) {
    const side = getRawAgySideDrag();
    if (side?.kind === 'session' || side?.kind === 'project') {
      ev.preventDefault();
      const ok = side.kind === 'session' ? canQuoteAgy(side.id, agy.sessionId) : canRefAgyFolder(side.path);
      try { ev.dataTransfer.dropEffect = ok ? 'copy' : 'none'; } catch {}
      draggingOver = true;
      return;
    }
    ev.preventDefault();
    draggingOver = true;
  }

  function onDragLeave(ev) {
    if (!ev.currentTarget.contains(ev.relatedTarget)) draggingOver = false;
  }

  function onDrop(ev) {
    ev.preventDefault();
    draggingOver = false;
    const side = getRawAgySideDrag();
    if (side?.kind === 'session') {
      quoteAgySession({ id: side.id, title: side.title, cwd: side.cwd });
      return;
    }
    if (side?.kind === 'project' && side.path) {
      refAgyFolder({ path: side.path, name: side.title });
      return;
    }
    if (dtHasWsFiles(ev)) {
      const desc = wsDescriptorFrom(ev.dataTransfer);
      if (desc) attachDescriptorToAgent(desc, 'agy');
      return;
    }
    // 有文件夹 → 引用原目录 / 整树上传（同步段里抓 entry，await 之后 dataTransfer 就废了）
    if (attachAgyTransfer(ev.dataTransfer)) return;
    const files = Array.from(ev.dataTransfer?.files || []);
    for (const f of files) uploadAgyFile(f);
  }

  // 点输入栏里的图片 / 视频瓦片（或已传完的文件卡）：在统一查看器里预览；多张图 / 视频支持左右切换与缩略图放大开场
  function canOpenDraftAtt(att) {
    return !!draftAttDescriptor(att, { sessionId: agy.sessionId || '', sessionCwd: agy.cwd || '' });
  }
  function openDraftAtt(att, el) {
    const opts = { sessionId: agy.sessionId || '', sessionCwd: agy.cwd || '', originRect: rectOf(el) };
    if (attLook(att).media) {
      const gallery = buildDraftMediaGallery(agy.draftAtts, att, opts);
      if (gallery) openPreview(gallery.items, gallery.index);
      return;
    }
    const desc = draftAttDescriptor(att, opts);
    if (desc) openPreview([opts.originRect ? { ...desc, originRect: opts.originRect } : desc], 0);
  }
</script>

<div class="agy-composer-area" class:centered={floating}>
  <div class="agy-composer-inner">
    {#if slashList.length > 0}
      <div class="agy-slash-pop" class:below={floating} role="listbox" aria-label={t('斜杠命令')}>
        {#each slashList as cmd, ci (cmd.name)}
          <button
            type="button"
            class="agy-slash-item"
            class:active={ci === slashIdx}
            onmouseenter={() => { slashIdx = ci; }}
            onclick={() => applySlash(cmd)}
          >
            <span class="slash-name">/{cmd.name}</span>
            {#if cmd.hint}<span class="slash-hint">{cmd.hint}</span>{/if}
            <span class="slash-desc">{tr(cmd.description)}</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if agy.queue.length > 0 && !centered}
      <!-- 排着队的消息：这一轮收尾后依次发出。每行可以立即发送（停下手头这一步）或撤回到输入框 -->
      <div class="agy-queue" role="list" aria-label={t('排队的消息')}>
        {#each agy.queue as q (q.id)}
          <div class="agy-q-row" role="listitem">
            <span class="msr q-ico" aria-hidden="true">schedule</span>
            <span class="q-txt" title={q.text}>{queueLabel(q)}</span>
            {#if q.text && q.atts?.length}
              <span class="q-att"><span class="msr" aria-hidden="true">attach_file</span>{q.atts.length}</span>
            {/if}
            <button type="button" class="q-btn" onclick={() => sendAgyQueuedNow(q.id)} title={t('立即发送（停下手头这一步）')} aria-label={t('立即发送（停下手头这一步）')}>
              <span class="msr" aria-hidden="true">arrow_upward</span>
            </button>
            <button type="button" class="q-btn" onclick={() => removeAgyQueued(q.id)} title={t('撤回到输入框')} aria-label={t('撤回到输入框')}>
              <span class="msr" aria-hidden="true">close</span>
            </button>
          </div>
        {/each}
      </div>
    {/if}

    {#if steerHint && !centered}
      <!-- 它还在干活：说明这条会怎么送达，要等这一轮结束再发就点右边 -->
      <div class="agy-steer-hint">
        <span class="sh-txt">{t('它做完手头这一步就会看到这条')}</span>
        <button type="button" class="sh-btn" disabled={!canSend} onclick={() => sendAgyLater()} title={t('这一轮结束后再发（Ctrl+Enter）')}>{t('稍后发送')}</button>
      </div>
    {/if}

    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={cboxEl}
      class="agy-cbox"
      class:focused
      class:busy={agy.busy}
      class:recording={voiceRecording}
      class:cancel-armed={voiceRecording && voiceCancelArmed}
      class:glow={glowOn}
      class:tail={glowTail && !centered && !focused && !agy.busy && !voiceRecording}
      style:--agy-ring-a={ringHold}
      class:drag={draggingOver || drag.overKey === 'agy-composer'}
      class:drop-cand={Boolean(sideDragCand?.ok)}
      onclick={onBoxClick}
      use:dropZone={composerDropZone}
      ondragover={onDragOver}
      ondragleave={onDragLeave}
      ondrop={onDrop}
    >
      {#if sideDragCand && (draggingOver || drag.overKey === 'agy-composer' || sideDragCand.ok)}
        <div class="agy-drop-hint" class:over={draggingOver || drag.overKey === 'agy-composer'} class:muted={!sideDragCand.ok} aria-hidden="true">
          <span>{sideDragCand.hint}</span>
        </div>
      {/if}
      {#if agy.draftAtts.length > 0}
        <div class="agy-att-strip">
          {#each agy.draftAtts as att, ai (att.url || att.path || 'n' + ai)}
            <AgyAttachment
              {att}
              sessionId={agy.sessionId || ''}
              variant="draft"
              onopen={canOpenDraftAtt(att) ? openDraftAtt : null}
              onremove={removeAgyDraftAtt}
              drag={() => attDragSrc(att)}
            />
          {/each}
        </div>
      {/if}

      <div class="agy-input-wrap">
        <textarea
          bind:this={textareaEl}
          use:glowCaret={agy.draftText}
          class="agy-cbox-input"
          data-sel-composer
          rows="1"
          value={agy.draftText}
          placeholder={centered ? t('让 Antigravity 做点什么…') : t('继续对话，键入 / 使用命令')}
          onfocus={() => { focused = true; }}
          onblur={() => { focused = false; }}
          oninput={onInput}
          onkeydown={onKeyDown}
          onpaste={onPaste}
        ></textarea>

        <!-- 录音态同位 HUD：与 textarea 重合零高度跳变 -->
        <div class="voice-top-hud" aria-live="polite" aria-hidden={!voiceRecording}>
          <span class="vh-dot"></span>
          <span class="vh-time">{voiceTimerText}</span>
          <canvas bind:this={waveCanvasEl} class="vh-wave-canvas"></canvas>
          <span class="vh-hint">
            <span class="vh-chev" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9.8 4L5.8 8l4 4" />
                <path d="M13.2 4L9.2 8l4 4" opacity="0.45" />
              </svg>
            </span>
            <span>{voiceCancelArmed ? t('松手取消') : t('左滑取消')}</span>
          </span>
        </div>
      </div>

      <div class="agy-cbox-bar">
        <input
          bind:this={fileInputEl}
          type="file"
          multiple
          class="agy-hidden-file"
          onchange={onPickFiles}
        />
        <!-- 只收图片：安卓壳据此改开系统照片选择器 -->
        <input
          bind:this={photoInputEl}
          type="file"
          multiple
          accept="image/*"
          class="agy-hidden-file"
          onchange={onPickFiles}
        />
        <div class="bar-left-wrap">
          <div class="bar-left">
            <button
              bind:this={addBtnEl}
              type="button"
              class="agy-bar-icon"
              class:on={attachMenuOpen}
              onclick={onAddClick}
              title={t('添加图片或文件')}
              aria-label={t('添加图片或文件')}
            >
              <span class="msr4">add</span>
            </button>

            <div class="bar-chips">
              <!-- 模型 + 思考深度：一组两个入口，档位是紧跟模型名的淡色调用原名，各自弹自己的小菜单 -->
              <span class="model-grp" class:on={agy.sheetKind === 'model' || agy.sheetKind === 'effort'}>
                <button
                  type="button"
                  class="agy-chip model"
                  class:on={agy.sheetKind === 'model'}
                  onclick={(e) => openPop('model', e.currentTarget)}
                  title={t('模型')}
                >
                  <BrandLogo logo={brandLogoOfModel(activeModelId)} name={activeModelShort} size={layout.compact ? 17 : 15} plain />
                  <span class="chip-txt">{activeModelShort}</span>
                </button>
                {#if activeThought}
                  <button
                    type="button"
                    class="effort-txt"
                    class:on={agy.sheetKind === 'effort'}
                    onclick={(e) => openPop('effort', e.currentTarget)}
                    title={t('思考深度')}
                  >{activeThought.name}</button>
                {/if}
              </span>
              {#if showDevice}
                <!-- 电脑：这个会话连着哪台（它要看屏幕、动你的电脑时用哪台）；贴着芯片弹小菜单，同模型 / 档位 -->
                <button
                  type="button"
                  class="agy-chip dev"
                  class:on={agy.sheetKind === 'device'}
                  onclick={(e) => openPop('device', e.currentTarget)}
                  title={t('电脑：{name}', { name: devLabel })}
                  aria-label={t('电脑：{name}', { name: devLabel })}
                >
                  <span class="msr dev-ic" aria-hidden="true">desktop_windows</span>
                  <span class="chip-txt dev-txt">{devLabel}</span>
                  <span class="dev-dot {devTone}" aria-hidden="true"></span>
                </button>
              {/if}
            </div>
          </div>
          <span class="bar-voice-sub" aria-hidden={!voiceRecording}>
            {voiceCancelArmed ? t('松手取消，不会发送') : t('松开发送 · Gemini 原生音频')}
          </span>
        </div>

        <!-- 右端：空闲时只有开口仪表占着发送键的位置（空框长按开启原生语音输入）；有内容或在跑时发送 / 停止键从仪表里分身出来，把仪表往左挤（AgySendCluster） -->
        <AgySendCluster
          bind:this={clusterRef}
          show={showAction}
          busy={asStop}
          disabled={!canSend}
          {voiceEnabled}
          sendLabel={agy.busy ? t('插话') : t('发送')}
          onsend={() => sendAgyMessage()}
          onstop={() => stopAgyTurn()}
          onGaugeTap={(el) => openPop('mode', el)}
          onVoiceBegin={handleVoiceBegin}
          onVoiceCancel={handleVoiceCancel}
          onVoiceSend={handleVoiceSend}
          onVoiceState={handleVoiceState}
          sampleVoiceLevel={(dt, muted) => recorder.sampleLevel(dt, muted)}
          onVoiceWaveFrame={drawLiveWaveform}
        >
          <button
            type="button"
            class="agy-gauge-btn"
            class:on={agy.sheetKind === 'mode'}
            onclick={(e) => openPop('mode', e.currentTarget)}
            title={gaugeTitle}
            aria-label={gaugeTitle}
          >
            <AgyGauge
              size={34}
              value={ctxPct}
              fill={gq?.weekly?.usedPct ?? null}
              dot={gq?.fiveH?.usedPct ?? null}
              mode={agy.mode || 'default'}
              charge={voicePhase === 'charging' ? voiceCharge : 0}
            />
          </button>
        </AgySendCluster>
      </div>
    </div>
    <!-- 放在输入框外：.agy-cbox 是尺寸容器（container），里面的 fixed 弹层会被它截成相对定位 -->
    {#if attachMenuOpen}
      <AgyAttachMenu
        anchorEl={addBtnEl}
        onPhotos={() => photoInputEl?.click()}
        onFiles={() => fileInputEl?.click()}
        onClose={() => { attachMenuOpen = false; }}
      />
    {/if}
  </div>
</div>

<style>
  .agy-composer-area {
    padding: 4px 16px calc(14px + var(--sab, 0px));
    flex: none;
    /* 光晕会向上溢出到对话区：压在 Thread 底部渐隐遮罩（z 2）之上，低于回到底部按钮（z 5） */
    position: relative;
    z-index: 3;
  }
  .agy-composer-area.centered {
    padding-bottom: 0;
  }
  .agy-composer-inner {
    position: relative;
    width: 100%;
    max-width: var(--ag-col);
    margin: 0 auto;
  }

  .agy-slash-pop {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 6px);
    max-height: 260px;
    overflow-y: auto;
    padding: 4px;
    border-radius: 12px;
    background: var(--ag-pop-bg);
    box-shadow: var(--ag-elev-shadow);
    z-index: 20;
  }
  .agy-slash-pop.below {
    bottom: auto;
    top: calc(100% + 6px);
  }
  .agy-slash-item {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 8px;
    text-align: left;
    font-size: 13px;
  }
  .agy-slash-item.active,
  .agy-slash-item:hover { background: var(--ag-hover); }
  .slash-name {
    font-family: var(--ag-mono);
    font-weight: 500;
    color: var(--ag-on);
    flex: none;
  }
  .slash-hint {
    font-family: var(--ag-mono);
    font-size: 11.5px;
    color: var(--ag-on-faint);
    flex: none;
  }
  .slash-desc {
    color: var(--ag-on-dim);
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agy-cbox {
    container: agy-cbox / inline-size;
    position: relative;
    display: flex;
    flex-direction: column;
    border-radius: 20px;
    background: var(--ag-cbox-bg);
    border: 1px solid var(--ag-cbox-bd);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    cursor: text;
    transition: border-color var(--ag-dur-quick) var(--ag-ease-std), box-shadow var(--ag-dur-quick) var(--ag-ease-std);
  }
  @media (hover: hover) {
    .agy-cbox:not(.glow):not(:has(button:hover, :global(.aa:hover))):hover {
      border-color: var(--ag-cbox-bd-focus);
    }
  }
  /* 锥形光环（逆向 AI Studio /apps 首页输入栏 .input-container，11-18）：
     1px 环 = 中性边框色打底、谷歌四色只占四个点，随 --agy-angle 缓缓转；身后再垫一层同色模糊光晕。
     输入框聚焦时（欢迎页与对话里一样）= 空闲版（半透明色、10s 一圈、光晕 blur 14 / 0.4）；
     （11-19 维护者定：欢迎页不再常亮，只在聚焦时亮；常亮的光晕挪给了欢迎页的 agy 图标，见 Welcome.svelte）
     agy 在干活 = 运行版（全饱和色、4s 一圈、光晕 blur 18 / 0.7）。
     环与光晕都画在负 z 伪元素上：盒子 isolate 后自身底色透明，由 ::before 的 padding-box 填底色。 */
  .agy-cbox.glow {
    isolation: isolate;
    border-color: transparent;
    background: transparent;
    animation: agy-conic-spin 10s linear infinite;
    /* 环的饱和度（空闲 0.5 ⇄ 在干活 1）：注册过的数值属性，切换时 0.7s 平滑过渡，伪元素继承 */
    --agy-ring-a: 0.5;
    transition: border-color var(--ag-dur-quick) var(--ag-ease-std), box-shadow var(--ag-dur-quick) var(--ag-ease-std),
      --agy-ring-a 0.7s cubic-bezier(0.2, 0, 0, 1);
  }
  .agy-cbox.glow.busy { --agy-ring-a: 1; }
  .agy-cbox.glow.recording { --agy-ring-a: 0.78; }
  .agy-cbox.glow.cancel-armed { --agy-ring-a: 0.16; }
  .agy-cbox.glow::before,
  .agy-cbox.glow::after {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    pointer-events: none;
  }
  .agy-cbox.glow::before {
    z-index: -1;
    border: 1px solid transparent;
    background:
      linear-gradient(var(--ag-cbox-bg), var(--ag-cbox-bg)) padding-box,
      conic-gradient(from var(--agy-angle, 0deg) at 50% 50%, var(--ag-conic-neutral) 0deg, var(--ag-conic-neutral) 69deg, rgb(66 133 244 / min(1, calc(var(--agy-ring-a) * 1.1))) 115deg, rgb(26 166 74 / var(--agy-ring-a)) 193deg, var(--ag-conic-neutral) 270deg, rgb(252 189 0 / var(--agy-ring-a)) 291deg, rgb(219 55 45 / var(--agy-ring-a)) 322deg, var(--ag-conic-neutral) 360deg) border-box;
    animation: agy-halo-in 0.42s cubic-bezier(0.05, 0.7, 0.1, 1) both;
  }
  .agy-cbox.glow::after {
    z-index: -2;
    background: conic-gradient(from var(--agy-angle, 0deg) at 50% 50%, var(--ag-conic-neutral) 0deg, var(--ag-conic-neutral) 69deg, rgb(66 133 244 / min(1, calc(var(--agy-ring-a) * 1.1))) 115deg, rgb(26 166 74 / var(--agy-ring-a)) 193deg, var(--ag-conic-neutral) 270deg, rgb(252 189 0 / var(--agy-ring-a)) 291deg, rgb(219 55 45 / var(--agy-ring-a)) 322deg, var(--ag-conic-neutral) 360deg);
    filter: blur(14px);
    opacity: 0.4;
    transition: filter 0.7s cubic-bezier(0.2, 0, 0, 1), opacity 0.7s cubic-bezier(0.2, 0, 0, 1);
    animation: agy-halo-in 0.6s cubic-bezier(0.05, 0.7, 0.1, 1) both;
  }
  .agy-cbox.glow.busy::after {
    filter: blur(18px);
    opacity: 0.7;
  }
  .agy-cbox.glow.recording::after {
    filter: blur(16px);
    opacity: 0.46;
  }
  .agy-cbox.glow.cancel-armed::after {
    opacity: 0.08;
  }
  .agy-cbox.cancel-armed {
    box-shadow: inset 0 0 0 1px var(--ag-err-bd);
  }
  .agy-cbox.glow.tail::before,
  .agy-cbox.glow.tail::after {
    animation: agy-halo-out 0.7s cubic-bezier(0.2, 0, 0, 1) forwards;
  }
  @keyframes agy-halo-out {
    to { opacity: 0; }
  }
  /* 聚焦时流光环淡入（不是一帧亮出来） */
  @keyframes agy-halo-in {
    from { opacity: 0; }
  }
  @keyframes agy-conic-spin {
    to { --agy-angle: 360deg; }
  }
  @media (prefers-reduced-motion: reduce) {
    .agy-cbox.glow { animation: none; }
  }
  .agy-cbox.drag {
    border-color: var(--ag-accent);
    box-shadow: 0 0 0 3px var(--ag-accent-soft);
  }
  .centered .agy-cbox {
    box-shadow: 0 3px 6px -2px rgba(0, 0, 0, 0.08), 0 16px 28px -8px rgba(0, 0, 0, 0.14);
  }

  .agy-input-wrap {
    position: relative;
  }
  .agy-cbox-input {
    display: block;
    width: 100%;
    box-sizing: border-box;
    min-height: 24px;
    max-height: 180px;
    padding: 13px 18px 4px;
    border: 0;
    outline: none;
    resize: none;
    background: transparent;
    color: var(--ag-cbox-on);
    font: inherit;
    font-size: 15px;
    line-height: 1.5;
    transition: opacity 0.16s var(--ag-ease-accel, cubic-bezier(0.3, 0, 0.8, 0.15)), transform 0.2s var(--ag-ease-std);
  }
  .centered .agy-cbox-input { padding-top: 15px; min-height: 46px; }
  .agy-cbox-input::placeholder { color: var(--ag-cbox-ph); }
  .agy-cbox.recording .agy-cbox-input {
    opacity: 0;
    transform: translateY(-3px);
    pointer-events: none;
  }

  /* 录音态同位 HUD：与 textarea 重合零布局抖动 */
  .voice-top-hud {
    position: absolute;
    inset: 0;
    padding: 13px 18px 4px;
    display: flex;
    align-items: center;
    gap: 10px;
    pointer-events: none;
    opacity: 0;
    transform: translateY(5px);
    transition: opacity 0.14s cubic-bezier(0.3, 0, 0.8, 0.15), transform 0.18s cubic-bezier(0.3, 0, 0.8, 0.15);
  }
  .centered .voice-top-hud { padding-top: 15px; }
  .agy-cbox.recording .voice-top-hud {
    opacity: 1;
    transform: translateY(0);
    transition: opacity 0.24s var(--ag-ease-decel) 0.06s, transform 0.3s var(--ag-ease-decel) 0.04s;
  }
  .vh-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ag-accent);
    flex: none;
    transition: background-color 0.16s, transform 0.16s;
    animation: agy-vh-pulse 1.5s ease-in-out infinite;
  }
  .agy-cbox.cancel-armed .vh-dot {
    background: var(--ag-err);
    animation: none;
    transform: scale(0.85);
  }
  @keyframes agy-vh-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(0.76); }
  }
  .vh-time {
    font-size: 14.5px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
    color: var(--ag-on);
    flex: none;
    min-width: 38px;
    transition: color 0.16s;
  }
  .agy-cbox.cancel-armed .vh-time { color: var(--ag-err); }
  .vh-wave-canvas {
    flex: 1;
    min-width: 60px;
    height: 22px;
    display: block;
    transition: opacity 0.18s;
  }
  .agy-cbox.cancel-armed .vh-wave-canvas { opacity: 0.28; }
  .vh-hint {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 12.5px;
    color: var(--ag-on-dim);
    white-space: nowrap;
    transition: color 0.16s;
  }
  .agy-cbox.cancel-armed .vh-hint {
    color: var(--ag-err);
    font-weight: 500;
  }
  .vh-chev {
    display: inline-flex;
    align-items: center;
    opacity: 0.72;
    animation: agy-vh-slide 1.6s var(--ag-ease-std) infinite;
  }
  .agy-cbox.cancel-armed .vh-chev {
    animation: none;
    opacity: 0;
    width: 0;
    overflow: hidden;
  }
  @keyframes agy-vh-slide {
    0%, 100% { transform: translateX(2px); opacity: 0.45; }
    50% { transform: translateX(-3px); opacity: 0.95; }
  }
  @media (prefers-reduced-motion: reduce) {
    .vh-dot, .vh-chev { animation: none; }
  }

  .agy-cbox-bar {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px 8px;
    min-width: 0;
  }
  .bar-left-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
  }
  .bar-left {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    transition: opacity 0.14s cubic-bezier(0.3, 0, 0.8, 0.15), transform 0.2s var(--ag-ease-std);
  }
  .agy-cbox.recording .bar-left {
    opacity: 0;
    transform: translateX(-8px);
    pointer-events: none;
  }
  .bar-voice-sub {
    position: absolute;
    left: 10px;
    right: 6px;
    top: 50%;
    transform: translateY(-50%) translateX(6px);
    font-size: 12px;
    color: var(--ag-on-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.14s cubic-bezier(0.3, 0, 0.8, 0.15), transform 0.22s var(--ag-ease-decel), color 0.16s;
  }
  .agy-cbox.recording .bar-voice-sub {
    opacity: 1;
    transform: translateY(-50%) translateX(0);
    transition: opacity 0.22s var(--ag-ease-decel) 0.08s, transform 0.28s var(--ag-ease-decel) 0.06s, color 0.16s;
  }
  .agy-cbox.cancel-armed .bar-voice-sub { color: var(--ag-err); }
  @container agy-cbox (max-width: 350px) {
    .bar-voice-sub { opacity: 0 !important; }
  }
  .bar-chips {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    overflow: hidden;
  }
  .agy-hidden-file { display: none; }

  /* 在跑时写了东西：一行淡字说明这条怎么送达，右边是「稍后发送」 */
  .agy-steer-hint {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 6px 6px 14px;
    font-size: 12.5px;
    color: var(--ag-on-faint);
  }
  .agy-steer-hint .sh-txt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agy-steer-hint .sh-btn {
    flex: none;
    height: 26px;
    padding: 0 10px;
    border-radius: 13px;
    font-size: 12.5px;
    color: var(--ag-on-dim);
  }
  .agy-steer-hint .sh-btn:hover:not(:disabled) { background: var(--ag-hover); color: var(--ag-on); }
  .agy-steer-hint .sh-btn:disabled { opacity: 0.5; }

  /* 排队的消息：贴在输入框上方的一摞单行，淡底、不抢输入框 */
  .agy-queue {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0 8px 6px;
  }
  .agy-q-row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 4px 0 10px;
    border-radius: 10px;
    background: var(--ag-surface-2);
    color: var(--ag-on-sub);
    font-size: 12.5px;
    min-width: 0;
    animation: agy-q-in 0.22s var(--ag-ease-decel) both;
  }
  @keyframes agy-q-in { from { opacity: 0; transform: translateY(4px); } }
  @media (prefers-reduced-motion: reduce) { .agy-q-row { animation: none; } }
  .q-ico { font-size: 16px; color: var(--ag-on-faint); flex: none; }
  .q-txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .q-att { display: inline-flex; align-items: center; gap: 1px; color: var(--ag-on-faint); font-size: 12px; flex: none; }
  .q-att .msr { font-size: 14px; }
  .q-btn {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-dim);
    flex: none;
  }
  .q-btn:hover { background: var(--ag-hover); color: var(--ag-on); }
  .q-btn .msr { font-size: 16px; }
  @media (pointer: coarse) { .agy-q-row { height: 38px; } .q-btn { width: 34px; height: 34px; } }

  /* 电脑芯片：小屏幕图标 + 名字 + 在线点；窄了只剩图标和点 */
  .agy-chip.dev { flex: 0 1 auto; padding: 0 8px; gap: 5px; }
  .dev-ic { font-size: 16px; }
  .dev-txt { max-width: 110px; font-weight: 400; }
  .dev-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; background: transparent; }
  .dev-dot.on { background: var(--ag-ok); }
  .dev-dot.off { background: var(--ag-on-faint); opacity: 0.6; }
  @container agy-cbox (max-width: 520px) { .dev-txt { display: none; } .agy-chip.dev { padding: 0 6px; } }

  .agy-bar-icon {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-dim);
    flex: none;
  }
  .agy-bar-icon:hover,
  .agy-bar-icon.on { background: var(--ag-hover); color: var(--ag-on); }
  .agy-bar-icon .msr4 { font-size: 20px; }

  .agy-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 30px;
    padding: 0 7px 0 9px;
    border-radius: 8px;
    color: var(--ag-on-dim);
    font-size: 12.5px;
    min-width: 0;
    flex: none;
    transition: background var(--ag-dur-micro) var(--ag-ease-std), color var(--ag-dur-micro) var(--ag-ease-std);
  }
  .agy-chip:hover,
  .agy-chip.on { background: var(--ag-chip-hover); color: var(--ag-on); }
  .agy-chip.model { flex: 0 1 auto; min-width: 0; color: var(--ag-on-sub); padding-right: 0; }
  /* 模型 + 档位一组：整组一块悬停底，档位是紧跟模型名的淡色小字（调用原名 low / medium / high / xhigh） */
  .model-grp {
    display: inline-flex;
    align-items: center;
    min-width: 64px;
    flex: 0 1 auto;
    border-radius: 8px;
    transition: background var(--ag-dur-micro) var(--ag-ease-std);
  }
  .model-grp:hover,
  .model-grp.on { background: var(--ag-chip-hover); }
  .model-grp .agy-chip.model:hover,
  .model-grp .agy-chip.model.on { background: transparent; color: var(--ag-on); }
  .effort-txt {
    display: inline-flex;
    align-items: center;
    height: 30px;
    /* 与模型名之间 0.4em（12.5px 下 5px）：比「Gemini 4」的词间距（≈0.25em）略大，看得出是另一项又紧跟着 */
    padding: 0 9px 0 0.4em;
    flex: none;
    /* 与模型名同字号同字重、同在 30px 里居中 → 基线重合；只靠颜色变淡（字号或字重不同会让两段基线错开，看着没对齐） */
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ag-on-faint);
    opacity: 0.75;
    border-radius: 0 8px 8px 0;
    transition: color var(--ag-dur-micro) var(--ag-ease-std), opacity var(--ag-dur-micro) var(--ag-ease-std);
  }
  .effort-txt:hover,
  .effort-txt.on { color: var(--ag-on-sub); opacity: 1; }

  .chip-txt {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 164px;
    min-width: 0;
  }

  /* 不透明圆底只盖到仪表环外沿（34px 仪表的环外沿 ≈ 13.7px）：发送键从环沿后面探出来，而不是从一块看不见的 36px 圆后面 */
  .agy-gauge-btn {
    position: relative;
    width: 36px;
    height: 36px;
    margin: -2px 0;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    background: radial-gradient(circle, var(--ag-cbox-bg) 0 14.5px, transparent 15px);
  }
  .agy-gauge-btn:hover,
  .agy-gauge-btn.on { background: linear-gradient(var(--ag-chip-hover), var(--ag-chip-hover)), radial-gradient(circle, var(--ag-cbox-bg) 0 14.5px, transparent 15px); }

  .agy-att-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 12px 0;
    cursor: default;
  }

  .agy-cbox.drop-cand {
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--ag-accent) 48%, transparent), var(--ag-cbox-shadow);
  }
  .agy-cbox.drag {
    box-shadow: 0 0 0 2px var(--ag-accent), var(--ag-cbox-shadow);
  }
  .agy-drop-hint {
    position: absolute;
    inset: 0;
    z-index: 6;
    border-radius: inherit;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    background: color-mix(in srgb, var(--ag-cbox-bg) 78%, transparent);
    backdrop-filter: blur(2px);
    font-size: 13px;
    font-weight: 500;
    color: var(--ag-accent);
    transition: background 0.14s, opacity 0.14s;
  }
  .agy-drop-hint.over {
    background: color-mix(in srgb, var(--ag-accent-soft) 72%, var(--ag-cbox-bg));
  }
  .agy-drop-hint.muted {
    color: var(--ag-on-dim);
  }

  @media (max-width: 599px) {
    .agy-composer-area { padding-left: 10px; padding-right: 10px; }
  }
  /* 按输入框自身宽度收：窄时芯片收紧、档位字号略小；模型名始终保留 */
  @container agy-cbox (max-width: 420px) {
    .agy-cbox-bar { gap: 2px; padding: 5px 6px 7px; }
    .agy-chip { padding: 0 5px; gap: 3.5px; font-size: 12px; }
    .effort-txt { font-size: 12px; padding-right: 7px; }
    .model-grp { flex: 1 1 auto; min-width: 0; }
    .agy-chip.model .chip-txt { max-width: none; }
  }
  /* 手机 / 触屏：菜单是底部抽屉、不从芯片长出来，芯片不再垫灰底（点完 :hover 会粘住、和抽屉一起成一块灰条截在输入框里） */
  /* 手机档（.ag-compact）：整体放大一档——输入 17、芯片 13 / 36 高、按钮 40；圆角 28，
     底栏内缩 8 时 40 的圆钮正好与外角同心（28 − 8 = 20） */
  :global(.agy-root.ag-compact) .agy-cbox { border-radius: 28px; }
  :global(.agy-root.ag-compact) .agy-cbox-input { font-size: 17px; padding: 17px 22px 4px; }
  :global(.agy-root.ag-compact) .voice-top-hud { padding: 17px 22px 4px; }
  :global(.agy-root.ag-compact) .agy-cbox-bar { padding: 6px 8px 8px; gap: 2px; }
  :global(.agy-root.ag-compact) .bar-left { gap: 2px; }
  :global(.agy-root.ag-compact) .agy-bar-icon { width: 40px; height: 40px; }
  :global(.agy-root.ag-compact) .agy-bar-icon .msr4 { font-size: 24px; }
  :global(.agy-root.ag-compact) .agy-chip { height: 36px; font-size: 13px; gap: 4px; padding: 0 3px 0 4px; }
  :global(.agy-root.ag-compact) .agy-chip.model { padding-right: 0; max-width: 100%; }
  :global(.agy-root.ag-compact) .effort-txt { height: 36px; font-size: 13px; padding-right: 4px; }
  /* 发送 / 停止键出来后位置更紧：模型名必须留全，让路的是档位——放不下时它整个折到第二行、被这一行的高度裁掉
     （折行 + 定高 + 裁切），而不是把模型名或档位截成半个词 */
  :global(.agy-root.ag-compact) .model-grp { flex-wrap: wrap; height: 36px; overflow: hidden; align-content: flex-start; }
  :global(.agy-root.ag-compact) .dev-dot { width: 6px; height: 6px; }
  :global(.agy-root.ag-compact) .agy-att-strip { padding: 14px 14px 0; }
  @media (max-width: 599px), (hover: none) {
    .agy-chip:hover, .agy-chip.on,
    .model-grp:hover, .model-grp.on { background: transparent; }
    .agy-gauge-btn:hover,
    .agy-gauge-btn.on { background: radial-gradient(circle, var(--ag-cbox-bg) 0 14.5px, transparent 15px); }
  }
</style>
