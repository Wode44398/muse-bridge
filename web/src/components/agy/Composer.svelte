<script>
  // 输入区：底栏模型 + 紧随其后的淡色思考档位、右端开口仪表（工作空间文件夹在页面顶栏左侧、侧栏按钮右边）
  // （运行模式入口，兼显上下文与额度；空闲时占发送键的位置，有内容 / 在跑时发送键从它身后分身弹出）——全页唯一参数入口；
  // 静息态保持零动画 1px 细描边避免常驻 GPU 光栅化，聚焦时唤醒柔和流光环，生成时提速流转。
  import {
    agy,
    fallbackAgyCaps,
    sendAgyMessage,
    sendAgyLater,
    stopAgyTurn,
    uploadAgyFile,
    attachAgyTransfer,
    removeAgyDraftAtt,
    removeAgyQueued,
    sendAgyQueuedNow,
  } from '../../lib/agy/store.svelte.js';
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
  import { dropZone } from '../../lib/dragdrop.svelte.js';
  import { agentDropZone, dtHasWsFiles, wsDescriptorFrom, attachDescriptorToAgent } from '../../lib/fileDrag.js';
  import { attDragSrc } from '../../lib/dragOut.js';
  import { openPreview } from '../../lib/preview.svelte.js';
  import { rectOf } from '../../lib/chatGallery.js';
  import { attLook, draftAttDescriptor, buildDraftMediaGallery } from '../../lib/agy/attach-look.js';
  import AgyAttachment from './AgyAttachment.svelte';
  import AgyAttachMenu from './AgyAttachMenu.svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { onMount } from 'svelte';
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
  let focused = $state(false);
  let draggingOver = $state(false);
  let slashDismissedFor = $state('');
  let slashIdx = $state(0);

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
  // 11-19 维护者：新对话页也只在聚焦（或在干活）时亮流光，不再常亮
  const glowOn = $derived(focused || agy.busy || glowTail);
  let rateRaf = 0;
  $effect(() => {
    const want = agy.busy ? 2.5 : 1;
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
    const tEl = ev.target;
    if (tEl?.closest?.('button, a, input, textarea, [role="button"], .aa')) return;
    textareaEl?.focus();
  }

  const anyUploading = $derived(agy.draftAtts.some((a) => a.pending));
  const hasDraft = $derived(agy.draftText.trim().length > 0 || agy.draftAtts.length > 0);
  // 发送 / 停止键只在「可能要按它」时出现：输入框有字或有附件、或者正在跑
  const showAction = $derived(agy.busy || hasDraft);
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

  function onDrop(ev) {
    ev.preventDefault();
    draggingOver = false;
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
      class:glow={glowOn}
      class:tail={glowTail && !centered && !focused && !agy.busy}
      style:--agy-ring-a={ringHold}
      class:drag={draggingOver}
      onclick={onBoxClick}
      use:dropZone={agentDropZone('agy', { label: t('挂进这个对话') })}
      ondragover={(ev) => { ev.preventDefault(); draggingOver = true; }}
      ondragleave={() => { draggingOver = false; }}
      ondrop={onDrop}
    >
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

      <textarea
        bind:this={textareaEl}
        use:glowCaret={agy.draftText}
        class="agy-cbox-input"
        rows="1"
        value={agy.draftText}
        placeholder={centered ? t('让 Antigravity 做点什么…') : t('继续对话，键入 / 使用命令')}
        onfocus={() => { focused = true; }}
        onblur={() => { focused = false; }}
        oninput={onInput}
        onkeydown={onKeyDown}
        onpaste={onPaste}
      ></textarea>

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

        <!-- 右端：空闲时只有开口仪表占着发送键的位置；有内容或在跑时发送 / 停止键从仪表里分身出来，把仪表往左挤（AgySendCluster） -->
        <AgySendCluster
          show={showAction}
          busy={asStop}
          disabled={!canSend}
          sendLabel={agy.busy ? t('插话') : t('发送')}
          onsend={() => sendAgyMessage()}
          onstop={() => stopAgyTurn()}
        >
          <button
            type="button"
            class="agy-gauge-btn"
            class:on={agy.sheetKind === 'mode'}
            onclick={(e) => openPop('mode', e.currentTarget)}
            title={gaugeTitle}
            aria-label={gaugeTitle}
          >
            <AgyGauge size={34} value={ctxPct} fill={gq?.weekly?.usedPct ?? null} dot={gq?.fiveH?.usedPct ?? null} mode={agy.mode || 'default'} />
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
  }
  .centered .agy-cbox-input { padding-top: 15px; min-height: 46px; }
  .agy-cbox-input::placeholder { color: var(--ag-cbox-ph); }

  .agy-cbox-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px 8px;
    min-width: 0;
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
  :global(.agy-root.ag-compact) .agy-cbox-bar { padding: 6px 8px 8px; gap: 2px; }
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
