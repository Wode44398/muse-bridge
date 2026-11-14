<script>
  // 查看器菜单：一个组件、两端分流（判断只看 lib/layout.svelte.js 的 pointer.fine）。
  //   触屏：ios27 MorphMenu（苹果玻璃，从按钮长出来；墨色、媒体场景 dark 由外框的 ios27 上下文给）。
  //         二级菜单 = 收起再从同一按钮长出子菜单（首行「返回」）；勾选项用 MorphMenu 的尾部勾（和文件页菜单一致），图标保留。
  //   电脑：扁平弹层（--st-menu 一系：r12、内距 4、行 32、14px、图标 18），媒体场景钉成暗色；二级菜单原地换页
  //         （YouTube 设置齿轮的做法），顶上一行「‹ 标题」返回；键盘 ↑↓ 移动、→ / Enter 进二级、← 返回、Esc 关。
  // 必须挂成外框根（.vw-root）的子级——MorphMenu 的玻璃要和页面平铺在同一个层叠上下文里。子查看器别自己挂，
  // 用 viewer.openMenu({ anchor, items, title }) 交给外框的浮层槽。
  //
  // 条目格式（items 可以是数组或返回数组的函数，开着时跟状态实时刷新）：
  //   { label, icon?（viewerIcons 名）, detail?（右侧当前值）, note?（标签下一行小字说明）, kbd?（电脑端快捷键提示）, checked?（true/false＝勾选组）,
  //     disabled?, danger?, onSelect?(), keepOpen?（电脑端选完不关，开关类）, submenu?: { title, items } | items[] }
  //   { sep: true }                分隔线
  //   { header: '分组名' }         分组标题（电脑端显示；触屏忽略，靠分隔线分组）
  import { untrack, tick } from 'svelte';
  import MorphMenu from '../../ios27/MorphMenu.svelte';
  import VIcon from './VIcon.svelte';
  import { pointer } from '../../../lib/layout.svelte.js';
  import { pushBackLayer } from '../../../lib/nav.js';
  import { viewerSvg } from '../../../lib/viewerIcons.js';
  import { t } from '../../../lib/i18n.js';
  import { val } from './context.js';

  // point：{x,y} 视口坐标——长按 / 右键弹的上下文菜单没有锚点按钮，按落点长出（触屏 MorphMenu 的 point 模式，电脑弹层贴着落点）
  let { open = false, anchor = null, point = null, items = [], title = '', onclose = null, place = 'auto' } = $props();

  const fine = $derived(pointer.fine);
  // 层级栈：[{ title, items }]，栈顶是当前显示的那一层
  let stack = $state([]);
  const root = $derived({ title, items });
  const level = $derived(stack.length ? stack[stack.length - 1] : root);
  const levelItems = $derived((val(level.items) || []).filter((it) => it && !it.hidden));
  const hasChecks = $derived(levelItems.some((it) => typeof it.checked === 'boolean'));

  $effect(() => { if (!open) untrack(() => { stack = []; }); });
  // 开着时被换成另一个菜单（外框 openMenu 换了 anchor / items）：回到第一层；触屏收起再从新按钮长出来
  let lastAnchor = null, lastItems = null;
  $effect(() => {
    const a = anchor || point, its = items, o = open;
    untrack(() => {
      if (!o) { lastAnchor = lastItems = null; return; }
      if (lastAnchor !== null && (a !== lastAnchor || its !== lastItems)) {
        stack = [];
        if (!fine) { mmOpen = false; setTimeout(() => { if (open) mmOpen = true; }, 0); }
      }
      lastAnchor = a; lastItems = its;
    });
  });
  $effect(() => { if (!open) return; return pushBackLayer(() => { if (stack.length) stack = stack.slice(0, -1); else onclose?.(); }); });

  function subOf(it) {
    const s = it.submenu;
    if (!s) return null;
    return Array.isArray(s) || typeof s === 'function' ? { title: it.label, items: s } : { title: s.title || it.label, items: s.items };
  }

  // —— 触屏：MorphMenu ——
  let mmOpen = $state(false);
  let pendingSub = null, pendingBack = false;
  $effect(() => { const o = open && !fine; untrack(() => { mmOpen = o; }); });
  const mmItems = $derived.by(() => {
    if (fine) return [];
    const out = [];
    if (stack.length) out.push({ label: t('返回'), icon: viewerSvg('back'), onclick: () => { pendingBack = true; } });
    for (const it of levelItems) {
      if (it.sep) { out.push({ sep: true }); continue; }
      if (it.header) continue;
      const sub = subOf(it);
      out.push({
        label: it.label,
        icon: it.icon ? viewerSvg(it.icon) : '',
        checked: it.checked === true,   // 勾选组：用 MorphMenu 自带的尾部勾（和文件页菜单同一套），图标位照常放图标
        detail: it.note || it.detail || '',
        destructive: !!it.danger,
        disabled: !!it.disabled,
        onclick: () => { if (sub) pendingSub = sub; else it.onSelect?.(); },
      });
    }
    // 首尾的分隔线、连着的分隔线去掉
    return out.filter((x, i, a) => !(x.sep && (i === 0 || i === a.length - 1 || a[i - 1]?.sep)));
  });
  // MorphMenu 选中一项时先 onclose 再调 onclick：等这一拍同步代码跑完再判断是进二级、返回还是真关
  function mmClosed() {
    queueMicrotask(() => {
      if (pendingSub || pendingBack) {
        const sub = pendingSub, back = pendingBack;
        pendingSub = null; pendingBack = false;
        mmOpen = false;
        setTimeout(() => {
          if (!open) return;
          stack = back ? stack.slice(0, -1) : [...stack, sub];
          mmOpen = true;
        }, 0);
        return;
      }
      mmOpen = false;
      onclose?.();
    });
  }

  // —— 电脑：扁平弹层 ——
  let popEl = $state(), placed = $state(false), pos = $state({ x: 0, y: 0, ox: 'right', oy: 'top' });
  let opener = null;
  $effect(() => {
    if (!open || !fine) { placed = false; return; }
    level; levelItems.length; anchor; point;
    untrack(() => { opener ||= document.activeElement; });
    tick().then(() => untrack(placePop));
  });
  $effect(() => { if (!open) untrack(() => { const o = opener; opener = null; if (o?.isConnected && fine) try { o.focus({ preventScroll: true }); } catch {} }); });

  function placePop() {
    if (!popEl || !open) return;
    const host = popEl.offsetParent || document.documentElement;
    const hr = host.getBoundingClientRect();
    const ar = anchor?.getBoundingClientRect?.() || (point ? { left: point.x, right: point.x, top: point.y, bottom: point.y, width: 0, height: 0 } : { left: hr.width - 12, right: hr.width - 12, top: 52, bottom: 52, width: 0, height: 0 });
    const w = popEl.offsetWidth, h = popEl.offsetHeight;
    const W = hr.width, H = hr.height;
    const ax = ar.left - hr.left, ay = ar.top - hr.top, aw = ar.width, ah = ar.height;
    const alignRight = ax + aw / 2 > W / 2;
    let x = alignRight ? ax + aw - w : ax;
    x = Math.max(8, Math.min(x, W - w - 8));
    const below = H - (ay + ah) - 8, above = ay - 8;
    const up = place === 'top' || (place === 'auto' && below < h && above > below);
    let y = up ? ay - h - 6 : ay + ah + 6;
    let ox = alignRight ? 'right' : 'left';
    // 落点菜单（右键 / 长按）：系统菜单的摆法——左上角贴着落点往右下长，碰边才翻向左 / 上
    if (!anchor && point) {
      const flipX = ax + w > W - 8;
      x = Math.max(8, flipX ? ax - w : ax);
      y = up ? ay - h : ay;
      ox = flipX ? 'right' : 'left';
    }
    y = Math.max(8, Math.min(y, H - h - 8));
    pos = { x: Math.round(x), y: Math.round(y), ox, oy: up ? 'bottom' : 'top' };
    placed = true;
    // 键盘打开（或菜单本来就有焦点）时把焦点给第一项；鼠标打开只把焦点放到弹层本身，不出焦点环
    queueMicrotask(() => { try { popEl?.focus({ preventScroll: true }); } catch {} });
  }

  function choose(it) {
    if (it.disabled) return;
    const sub = subOf(it);
    if (sub) { stack = [...stack, sub]; return; }
    it.onSelect?.();
    if (!it.keepOpen) onclose?.();
  }
  function back() { if (stack.length) stack = stack.slice(0, -1); }
  function rows() { return popEl ? [...popEl.querySelectorAll('.vw-pop-it:not(:disabled)')] : []; }
  function popKey(e) {
    const list = rows();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'ArrowLeft' && stack.length) { e.preventDefault(); back(); }
    else if (e.key === 'ArrowRight' && i >= 0) {
      const idx = +list[i].dataset.i;
      const it = levelItems[idx];
      if (it && subOf(it)) { e.preventDefault(); choose(it); }
    }
    else if (e.key === 'Escape') { e.preventDefault(); if (stack.length) back(); else onclose?.(); }
    else if (e.key === 'Tab') { e.preventDefault(); }
  }
</script>

{#if !fine}
  <MorphMenu open={mmOpen} {anchor} point={anchor ? null : point} items={mmItems} title={stack.length ? level.title : title} onclose={mmClosed} />
{:else if open}
  <!-- 点外面关：接 click 而不是 pointerdown——按下就卸载的话，抬手那下的 click 会落到底下的 ⋮ 上把菜单又打开 -->
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="vw-pop-back" onpointerdown={(e) => e.preventDefault()} onclick={() => onclose?.()} oncontextmenu={(e) => { e.preventDefault(); onclose?.(); }}></div>
  <div class="vw-pop" class:placed bind:this={popEl} role="menu" tabindex="-1" aria-label={level.title || title || null}
    style:transform="translate({pos.x}px, {pos.y}px)" style:transform-origin="{pos.ox} {pos.oy}" onkeydown={popKey}>
    {#key stack.length}
      <div class="vw-pop-in">
        {#if stack.length}
          <button type="button" class="vw-pop-it vw-pop-head" onclick={back}><VIcon name="back" size={16} /><span class="vw-pop-l">{level.title}</span></button>
          <div class="vw-pop-sep" role="separator"></div>
        {:else if title}
          <div class="vw-pop-h">{title}</div>
        {/if}
        {#each levelItems as it, i (i)}
          {#if it.sep}
            {#if i > 0 && i < levelItems.length - 1 && !levelItems[i - 1]?.sep}<div class="vw-pop-sep" role="separator"></div>{/if}
          {:else if it.header}
            <div class="vw-pop-h">{it.header}</div>
          {:else}
            {@const sub = subOf(it)}
            <button type="button" class="vw-pop-it" class:danger={it.danger} disabled={it.disabled} data-i={i}
              role={typeof it.checked === 'boolean' ? 'menuitemradio' : 'menuitem'} aria-checked={typeof it.checked === 'boolean' ? it.checked : null}
              aria-haspopup={sub ? 'menu' : null} onclick={() => choose(it)}>
              {#if hasChecks}
                <span class="vw-pop-ck">{#if it.checked}<VIcon name="check" size={16} />{/if}</span>
              {/if}
              {#if it.icon}<VIcon name={it.icon} size={18} />{/if}
              {#if it.note}
                <span class="vw-pop-l vw-pop-2"><span>{it.label}</span><small>{it.note}</small></span>
              {:else}
                <span class="vw-pop-l">{it.label}</span>
              {/if}
              {#if it.detail}<span class="vw-pop-detail">{it.detail}</span>{/if}
              {#if it.kbd}<kbd class="vw-pop-kbd">{it.kbd}</kbd>{/if}
              {#if sub}<VIcon name="chev" size={14} class="vw-pop-chev" />{/if}
            </button>
          {/if}
        {/each}
      </div>
    {/key}
  </div>
{/if}
