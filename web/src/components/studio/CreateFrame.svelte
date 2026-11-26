<script module>
  // 素材从别处飞进素材行（素材架挑选态、作品格子表单）：先记下起点，下一块挂上来的素材从那儿飞过来（同一张图挪过去，不是凭空冒出来）。
  // 调用方：flyNextInput(来源元素或它的 getBoundingClientRect()) 之后再 addInput / dropInto。
  let flyFrom = null;
  export function flyNextInput(from) {
    const r = from?.getBoundingClientRect ? from.getBoundingClientRect() : from;
    flyFrom = r && r.width > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height, at: performance.now() } : null;
  }
</script>

<script>
  // 四个创作页共用的骨架（方案 §12.3「作品台」）：画布占满整页（页面自己管滚动）→ 输入栏浮在底部，身后纸色渐变。
  //   .cf 上写 --cf-dock-h（输入栏实高 + 安全区），墙按它留底距。
  //   托盘：输入栏身后深一档的一条——左 模型钮（服务真标灰度 + 名字 + ⌄）；右 每个基本参数一段（改过默认值的字色加深加粗）、
  //   最后「全部参数」（滑杆，藏起来的改动带数字）。段点开那一项的卡（锚在段上）；手机一行放不下就两行，不藏任何一段。
  //   值变了只这一段滚字（旧字上走、新字下来、宽度弹过去）。宽屏「全部参数」切右边的参数坞（坞开着时托盘的参数段收起）。
  //   输入栏只留 ＋、正文、发送（ui/Composer）。图像焦点打开时素材行最前面多一块「接着改」，× = 关焦点另起一张。
  // 参数只按目录的 ParamSpec 渲染（ParamsList）。素材：＋（作品 / 工作空间 / 本机）、拖放（DropTray）、粘贴。
  import { untrack } from 'svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { dropZone } from '../../lib/dragdrop.svelte.js';
  import { pasteFiles } from '../../lib/dropPaste.js';
  import { dtHasWsFiles, wsDescriptorFrom } from '../../lib/fileDrag.js';
  import { studio, currentModel, valuesOf, setParam, submit, removeInput, swapFrames, clearParent, roleName, roleTag, saveSide, closeFocus, startPick, mediaSrc } from '../../modules/studio/media.svelte.js';
  import { imageRoles, inputRoles, promptLangs, textFitsLangs, optionsOf, resolveValues } from '../../modules/studio/params.js';
  import { sizeIssues, sizeGrid, gridMatch } from '../../modules/studio/size.js';
  import { chipValue, controlOf, formatOf, selfExplaining, paramGroups, isChanged } from '../../modules/studio/render.js';
  import { paramLabel, optText, sourceText } from '../../modules/studio/words.js';
  import { paramSource } from '../../modules/studio/picker.js';
  import { providerLogo } from '../../lib/providerLogos.js';
  import { labelForId } from '../../modules/studio/media.svelte.js';
  import { slotDropFor, defaultRole, dropOsFile, dropInto, roleAccepts, assetPayload } from '../../modules/studio/drag.js';
  import { icon } from '../../modules/studio/icons.js';
  import { edgeFade } from '../../modules/studio/edge.js';
  import { SPRING, SPRING_SOFT, SPRING_POP, springEasing, reducedMotion, pop } from '../../modules/studio/motion.js';
  import Composer from './ui/Composer.svelte';
  import Layer from './ui/Layer.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import ParamsList from './ParamsList.svelte';
  import OptionList from './OptionList.svelte';
  import VoicePicker from './VoicePicker.svelte';
  import AddAsset from './AddAsset.svelte';
  import WorkspacePicker from './WorkspacePicker.svelte';
  import DropTray from './DropTray.svelte';
  import Img from './ui/Img.svelte';
  import Measure from './ui/Measure.svelte';

  let {
    page, active = false,
    title = '', placeholder = '', sendLabel = '', enterSends = true, tall = false,
    needText = () => true,          // (draft) → 这次生成要不要正文
    canvas,
  } = $props();

  const draft = $derived(studio.drafts[page]);
  const model = $derived(currentModel(page));
  const values = $derived(valuesOf(page, model));
  // 托盘的段 = 面板里「基本」那一组，顺序也跟面板一样（比例 → 尺寸 → 画质 → 时长 → 张数…）
  const paramSets = $derived(paramGroups(model?.params || [], values));
  const chipSpecs = $derived(paramSets.find((g) => g.id === 'basic')?.specs || []);
  const hasParams = $derived(!!(model?.params?.length || model?.inputs?.negative));
  // 参数坞（宽屏才有）：开着时全部参数在右栏，托盘只留模型——同屏一份信息只出一次
  const docked = $derived(layout.expanded && !!studio.side.dock && hasParams);

  let field = $state(), hasText = $state(false);
  let sending = $state(false), err = $state('');
  let modelOpen = $state(null);              // 模型钮（选择器锚点）
  let allOpen = $state(null);                // 「全部参数」键（手机 / 平板的参数表单）
  let one = $state(null);                    // { spec, anchor }：托盘上一段点开的那一项的卡
  let voiceSpec = $state(null);
  let addOpen = $state(null), wsPick = $state(null);
  let fileInput = $state(), fileRole = $state('');
  let plusAnchor = $state(null);

  // 素材能力
  const roles = $derived(inputRoles(model));
  const canAttach = $derived(roles.length > 0);
  const bad = $derived(draft.inputs.filter((x) => !roles.includes(x.role) || (x.role !== 'audio' && x.role !== 'video' && !imageRoles(model).includes(x.role))));
  const pending = $derived(draft.inputs.some((x) => x.pending));
  // 提示词语言（模型卡 inputs.promptLang）：Lyria 2 只认英文，中文必然 400——在这里拦下
  let curText = $state('');
  const langs = $derived(promptLangs(model));
  const langBad = $derived(!!langs && hasText && !textFitsLangs(curText, langs));
  const langHint = $derived(!langBad ? '' : langs.length === 1 && langs[0] === 'en' ? t('这个模型只认英文提示词') : t('这个模型只认这些语言的提示词：{langs}', { langs: langs.join(' / ') }));
  // 必填素材（卡上 inputs.images.required：只做图生视频的模型要先给首帧）：没给就不让发，底下写一句
  const needRole = $derived((model?.inputs?.images?.required || []).find((r) => !draft.inputs.some((x) => x.role === r)) || '');
  const hint = $derived(err || (bad.length ? t('当前模型不接收{role}', { role: roleName(bad[0].role) }) : '') || langHint || (needRole ? t('这个模型要先给{role}', { role: roleName(needRole) }) : '') || (pending ? t('素材还在上传') : '') || studio.notice);
  const warn = $derived(!!err || !!bad.length || langBad);
  // 发送键：空着（要正文却没写）时不在；写了但发不了是淡的；发送中原地转
  const wants = $derived(hasText || !needText(draft));
  const blocked = $derived(langBad || pending || !!bad.length || !!needRole || !model);
  const sendState = $derived(sending ? 'busy' : !wants ? 'hidden' : blocked ? 'blocked' : 'ready');
  $effect(() => { model?.key; untrack(() => { err = ''; }); });
  // 一次性提示（已换到 X）：看过 6 秒自己收
  $effect(() => { if (studio.notice && active) { const n = studio.notice; const tm = setTimeout(() => { if (studio.notice === n) studio.notice = ''; }, 6000); return () => clearTimeout(tm); } });

  // 别处要填进来的正文（文本文件拖入、发到 Studio、接着做、复用参数）
  $effect(() => {
    const pt = studio.pendingText;
    if (pt && pt.page === page && field) untrack(() => { field.textContent = pt.text; hasText = !!pt.text.trim(); curText = pt.text; studio.pendingText = null; });
  });

  async function gen() {
    if (sending || blocked) return false;
    const txt = (field?.textContent || '').trim();
    if (needText(draft) && !txt) return false;
    sending = true; err = '';
    const r = await submit(page, txt);
    sending = false;
    if (r.ok) { curText = ''; studio.notice = ''; return true; }
    err = r.error || t('生成失败');
    return false;
  }

  // —— 托盘的段：每个基本参数一段。值自己说得清的（「16:9」「2K」「8 秒」「2048×1152」）只写值，别的前面带淡色参数名 ——
  const optLabel = optText;
  const chipName = paramLabel;
  const chipOf = (spec) => {
    const v = chipValue(spec, values[spec.key], { labelOf: optLabel, modelId: model?.id, values });
    if (v == null) return null;
    if (spec.type === 'bool') return { name: '', text: chipName(spec), toggle: true, on: !!values[spec.key] };
    // 张数 / 条数：带名字（「张数 2」），光一个「×2」猜不出是什么
    if (formatOf(spec) === 'count') return { name: chipName(spec), text: String(v).replace(/^×/, '') };
    // 尺寸落在比例 × 档位格上：写「16:9 · 2K」，不写一串像素（自己打的数才写像素）
    if (spec.type === 'size') {
      const grid = sizeGrid(spec);
      const m = grid ? gridMatch(spec, values[spec.key], grid) : null;
      if (m?.ratio) return { name: '', text: m.ratio + (grid.tiers.length > 1 && m.tier ? ' · ' + m.tier : '') };
    }
    return { name: selfExplaining(spec, v) || spec.type === 'voice' ? '' : chipName(spec), text: v };
  };
  const defaults = $derived(resolveValues(model?.params || [], {}, model?.id || '', { edit: values.$edit, first: values.$first, last: values.$last, ref: values.$ref }));
  const segs = $derived(chipSpecs.map((s) => ({ spec: s, ...(chipOf(s) || {}) })).filter((c) => c.text != null)
    .map((c) => ({ ...c, chg: isChanged(values[c.spec.key], defaults[c.spec.key]), bad: c.spec.type === 'size' && sizeIssues(c.spec, values[c.spec.key]).length > 0 })));
  // 「全部参数」上的小数字：托盘上看不到的那些（「更多」组 + 负面提示词 + 没上托盘的基本项）里改过几项
  const hiddenChanged = $derived(paramSets.flatMap((g) => g.specs).filter((s) => !segs.some((c) => c.spec.key === s.key) && isChanged(values[s.key], defaults[s.key])).length
    + (model?.inputs?.negative && draft.negative ? 1 : 0));
  const logo = $derived(model?.provider ? providerLogo(model.provider) : '');
  const srcText = $derived(sourceText(paramSource(model), labelForId, true));

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const segHtml = (c) => (c.toggle ? (c.on ? `<span class="t-ic">${icon('check')}</span>` : '<span class="t-off"></span>') : '') + (c.name ? `<i>${esc(c.name)}</i> ` : '') + `<span>${esc(c.text)}</span>`;
  const quiet = (node) => reducedMotion() || !!node?.closest?.('.sd-noanim');
  // 值变了：旧字往上走、新字从下面上来，这一段的宽度沿弹簧弹过去（只这一段动）
  function roll(node, c) {
    let html = segHtml(c);
    node.innerHTML = `<span class="rv">${html}</span>`;
    let wAnim = null;
    return {
      update(c2) {
        const h2 = segHtml(c2);
        if (h2 === html) return;
        html = h2;
        node.querySelectorAll('.rv.gone').forEach((g) => g.remove());
        const cur = node.querySelector('.rv');
        if (!cur || !node.isConnected || quiet(node)) { node.innerHTML = `<span class="rv">${h2}</span>`; fitSoon(); return; }
        const w0 = node.offsetWidth;
        wAnim?.cancel();
        cur.classList.add('gone');
        const nu = document.createElement('span');
        nu.className = 'rv';
        nu.innerHTML = h2;
        node.appendChild(nu);
        const w1 = node.offsetWidth;
        wAnim = node.animate([{ width: w0 + 'px' }, { width: w1 + 'px' }], { duration: SPRING.ms, easing: springEasing(SPRING) });
        wAnim.onfinish = () => { wAnim = null; fitSoon(); };
        cur.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(-70%)', opacity: 0 }], { duration: 150, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' })
          .finished.then(() => cur.remove(), () => cur.remove());
        nu.animate([{ transform: 'translateY(70%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: SPRING.ms, delay: 40, easing: springEasing(SPRING), fill: 'backwards' });
      },
      destroy() { wAnim?.cancel(); },
    };
  }
  // 段进出（换了模型、参数坞开合）：从右往左一段段收进右栏 / 依次回来
  function segIn(node, { i = 0 }) {
    if (quiet(node)) return { duration: 0 };
    return { delay: 60 + i * 30, duration: SPRING_SOFT.ms, easing: SPRING_SOFT.ease, css: (k, u) => `opacity:${Math.min(1, k * 1.6)};transform:translateX(${(u * 14).toFixed(1)}px)` };
  }
  function segOut(node, { i = 0, n = 1 }) {
    if (quiet(node)) return { duration: 0 };
    // 参数在离场时才求值：i 是旧列表里的位置、n 已经是新列表的长度（换到段更少的模型时 i ≥ n），
    // 负的 delay 会让 Svelte 的 element.animate 抛错、整棵 Studio 停止更新
    return { delay: Math.max(0, (n - i) * 20), duration: 140, easing: (x) => x * x, css: (k, u) => `opacity:${k};transform:translateX(${(u * 14).toFixed(1)}px)` };
  }

  function openSeg(e, spec) {
    if (spec.type === 'bool') { setParam(page, spec.key, !values[spec.key]); return; }   // 开关：点一下就切
    if (spec.type === 'voice') { voiceSpec = spec; return; }
    const el = e.currentTarget;
    oneVal = undefined;
    one = one?.spec?.key === spec.key ? null : { spec, anchor: el };
  }
  const oneKind = $derived(one ? controlOf(one.spec, optionsOf(one.spec, model?.id, values), { labelOf: optLabel }) : '');
  // 长枚举（选择钮 + 菜单的那种）在卡里直接是选项列表；其余是那一行控件
  const oneMenu = $derived(oneKind === 'select');
  // 几选一的卡：点了一项，墨块滑过去之后自己收（看得见选了哪个）；尺寸这种一张卡里几样东西的不收
  let oneVal;
  $effect(() => {
    if (!one) return;
    const v = JSON.stringify(values[one.spec.key] ?? null);
    untrack(() => {
      if (oneVal === undefined) { oneVal = v; return; }
      if (v === oneVal) return;
      oneVal = v;
      if (!['seg', 'pills', 'aspect', 'steps'].includes(oneKind)) return;
      const o = one;
      setTimeout(() => { if (one === o) one = null; }, 260);
    });
  });
  function openAll(e) {
    if (layout.expanded) { studio.side.dock = !studio.side.dock; saveSide(); return; }
    allOpen = allOpen ? null : e.currentTarget;
  }
  // 宽屏切出 / 切进参数坞：别把手机 / 平板时开着的参数表单留着
  $effect(() => { if (layout.expanded) untrack(() => { allOpen = null; }); });

  // —— 托盘一行放不下就排成两行：模型一行、参数一行（参数行自己再折行，不藏任何一段）——
  let trayEl = $state(), two = $state(false);
  let fitRaf = 0;
  function fitTray() {
    fitRaf = 0;
    const tray = trayEl;
    if (!tray) return;
    const mb = tray.querySelector('.t-model'), nm = mb?.querySelector('.t-nm');
    const ps = tray.querySelector('.t-params'), all = tray.querySelector('.t-all');
    const modelW = mb ? mb.offsetWidth - (nm?.clientWidth || 0) + (nm?.scrollWidth || 0) : 0;
    const segW = ps ? [...ps.children].reduce((s, c) => s + c.offsetWidth, 0) + Math.max(0, ps.children.length - 1) * 2 : 0;
    const cs = getComputedStyle(tray);
    const room = tray.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const need = modelW + segW + (all ? all.offsetWidth : 0) + 12;
    const next = need > room;
    if (next !== two) two = next;
  }
  function fitSoon() { if (!fitRaf) fitRaf = requestAnimationFrame(fitTray); }
  $effect(() => {
    if (!trayEl) return;
    const ro = new ResizeObserver(fitSoon);
    ro.observe(trayEl);
    return () => { ro.disconnect(); cancelAnimationFrame(fitRaf); fitRaf = 0; };
  });
  $effect(() => { void segs.map((c) => c.spec.key + c.text + c.name).join(); void model?.key; void docked; fitSoon(); });

  // —— 输入栏实高写到 .cf 上（--cf-dock-h，含安全区），墙按它留底距 ——
  let cfEl = $state(), dockEl = $state();
  $effect(() => {
    if (!dockEl || !cfEl) return;
    const set = () => cfEl.style.setProperty('--cf-dock-h', Math.ceil(dockEl.offsetHeight) + 'px');
    const ro = new ResizeObserver(set);
    ro.observe(dockEl);
    set();
    return () => ro.disconnect();
  });

  // —— 打开图像焦点时：素材行最前面多一块「接着改」（那一版的缩略图），× = 关焦点另起一张 ——
  const focusImg = $derived(page === 'image' && studio.focus?.page === 'image' ? studio.focus.asset : null);
  const showAtts = $derived(!!(draft.inputs.length || draft.parent || focusImg));

  // —— ＋：先选角色（只有一种就跳过）再选来源（作品 / 工作空间 / 本机）——
  function openPlus(e) { plusAnchor = e?.currentTarget || null; addOpen = true; }
  function fromWorkspace(role) { addOpen = null; wsPick = { role }; }
  function fromDevice(role) { addOpen = null; fileRole = role; requestAnimationFrame(() => fileInput?.click()); }
  // 作品：宽一些的屏让左边的素材架进挑选态（S 的 Shelf 显示）；手机由 AddAsset 自己翻到作品格子
  function fromWorks(role) { addOpen = null; startPick(page, role); }
  async function onWorkPicked(role, a, fromEl) {
    addOpen = null;
    flyNextInput(fromEl);
    await dropInto(page, role, assetPayload(a));
  }
  async function onPicked(e) {
    const files = [...(e.target.files || [])]; e.target.value = '';
    for (const f of files) await dropOsFile(page, fileRole, f);
  }
  function onWsPicked(rel) {
    const role = wsPick?.role;
    wsPick = null;
    dropInto(page, role, { type: 'ws-desc', rels: [rel], ws: '', locationId: '' });
  }
  const ACCEPT = { audio: 'audio/*', video: 'video/mp4,video/quicktime,video/webm' };

  // 新挂上来的素材：有起点就从起点飞过来，没有就原地弹出来（页面刚画出来时已有的——草稿恢复——不弹）
  const born = performance.now();
  function attIn(node, x) {
    const f = x?.flyFrom || (flyFrom && performance.now() - flyFrom.at < 1500 ? flyFrom : null);
    if (flyFrom === f) flyFrom = null;
    if (x?.flyFrom) x.flyFrom = null;
    if (quiet(node)) return {};
    const host = node.closest('.cf');
    if (!f || !host) {
      if (performance.now() - born > 400) node.animate([{ opacity: 0, transform: 'scale(.7)' }, { opacity: 1, transform: 'none' }], { duration: SPRING_POP.ms, easing: springEasing(SPRING_POP) });
      return {};
    }
    const nr = node.getBoundingClientRect(), hr = host.getBoundingClientRect();
    if (!nr.width) return {};
    const g = node.cloneNode(true);
    g.className = 'cp-fly';
    Object.assign(g.style, { left: nr.left - hr.left + 'px', top: nr.top - hr.top + 'px', width: nr.width + 'px', height: nr.height + 'px' });
    host.appendChild(g);
    node.style.opacity = '0';
    g.animate([{ transform: `translate(${f.left - nr.left}px, ${f.top - nr.top}px) scale(${f.width / nr.width}, ${f.height / nr.height})`, borderRadius: '8px' }, { transform: 'none', borderRadius: '10px' }],
      { duration: SPRING_SOFT.ms + 80, easing: springEasing(SPRING_SOFT) })
      .finished.then(() => {
        g.remove(); node.style.opacity = '';
        node.animate([{ transform: 'scale(1.06)' }, { transform: 'none' }], { duration: SPRING_POP.ms, easing: springEasing(SPRING_POP) });
      }, () => { g.remove(); node.style.opacity = ''; });
    return {};
  }

  // —— 拖放：指针拖拽松在输入栏本体＝默认角色；HTML5（电脑版工作空间 / 系统文件）——
  function dockZone(node) {
    const opts = () => ({
      key: 'studio-dock:' + page, effect: 'send', label: () => t('挂进输入框'),
      accept: (p) => active && !!slotDropFor(page, p, null),
      drop: (p) => slotDropFor(page, p, null)?.(),
    });
    const z = dropZone(node, opts());
    return { update: () => z.update(opts()), destroy: z.destroy };
  }
  let h5 = $state(null), h5Depth = 0;
  const h5Kind = (e) => (dtHasWsFiles(e) ? 'ws' : Array.prototype.indexOf.call(e.dataTransfer?.types || [], 'Files') !== -1 ? 'files' : '');
  function h5Enter(e) { const k = h5Kind(e); if (!k || !active) return; e.preventDefault(); h5Depth++; h5 = { k }; }
  function h5Over(e) { if (!h5) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch {} }
  function h5Leave() { if (!h5) return; if (--h5Depth <= 0) { h5Depth = 0; h5 = null; } }
  async function h5Drop(e, role = null) {
    if (!h5) return;
    e.preventDefault();
    h5Depth = 0; h5 = null;
    const desc = dtHasWsFiles(e) ? wsDescriptorFrom(e.dataTransfer) : null;
    if (desc) {
      const p = { type: 'ws-desc', ...desc };
      const go = slotDropFor(page, p, role);
      if (go) await go(); else err = t('这一页用不上这类素材');
      return;
    }
    for (const file of [...(e.dataTransfer?.files || [])]) {
      const p = { type: 'os-file', file };
      const r = role || defaultRole(page, p);
      if (r === 'text') { studio.pendingText = { page, text: (await file.text()).slice(0, 30000) }; continue; }
      if (r && slotDropFor(page, p, r)) await dropOsFile(page, r, file);
    }
  }
  function onPaste(fs) {
    for (const f of fs) { const r = defaultRole(page, { type: 'os-file', file: f }); if (r && r !== 'text') dropOsFile(page, r, f); }
  }

  // 参数坞：这一页的参数面板挂进外壳的 .sd-dock-body（坞是外壳的一栏，四个创作页各挂一份、只显示当前页那份）
  function toDock(node) {
    const host = node.closest('.studio-root')?.querySelector('.sd-dock-body');
    if (host && node.parentNode !== host) host.appendChild(node);
    return { destroy() { node.remove(); } };
  }
</script>

<div class="cf" bind:this={cfEl} role="region" aria-label={title}
  ondragenter={h5Enter} ondragover={h5Over} ondragleave={h5Leave} ondrop={(e) => h5Drop(e)}
  use:pasteFiles={{ onFiles: onPaste, filter: (f) => /^(image|audio|video)\//.test(f.type || ''), when: () => active && canAttach }}>

  <div class="cf-canvas">{@render canvas?.()}</div>

  <div class="cf-dock" bind:this={dockEl}>
    <div class="cf-col" use:dockZone>
      <DropTray {page} {model} html5={h5} onhtml5drop={(e, role) => h5Drop(e, role)} />
      <div class="cf-tray" class:two bind:this={trayEl} role="group" aria-label={t('模型与参数')}>
        <button class="t-model" disabled={!model} aria-haspopup="dialog" aria-expanded={!!modelOpen}
          title={model ? tr(model.label || model.id) + (model.provider?.name ? ' · ' + tr(model.provider.name) : '') : ''} onclick={(e) => { modelOpen = modelOpen ? null : e.currentTarget; }}>
          {#if logo}<span class="t-lg" aria-hidden="true">{@html logo}</span>{/if}
          <span class="t-nm">{model ? tr(model.label || model.id) : t('没有模型')}</span>
          <span class="t-chev" aria-hidden="true">{@html icon('down')}</span>
        </button>
        <span class="t-sp"></span>
        {#if !docked && segs.length}
          <div class="t-params">
            {#each segs as c, i (c.spec.key)}
              <button class="t-seg" class:chg={c.chg} class:tog={c.toggle} class:off={c.toggle && !c.on} class:bad={c.bad}
                aria-haspopup={c.toggle ? null : 'dialog'} aria-expanded={c.toggle ? null : one?.spec?.key === c.spec.key} aria-pressed={c.toggle ? c.on : null}
                aria-label={(c.name || chipName(c.spec)) + '：' + c.text} title={chipName(c.spec)} data-seg={c.spec.key}
                use:roll={c} in:segIn|global={{ i }} out:segOut|global={{ i, n: segs.length }} onclick={(e) => openSeg(e, c.spec)}></button>
            {/each}
          </div>
        {/if}
        {#if hasParams}
          <button class="t-all" class:on={docked} aria-label={t('全部参数')} title={t('全部参数')} aria-haspopup={layout.expanded ? null : 'dialog'}
            aria-expanded={layout.expanded ? docked : !!allOpen} onclick={openAll}>
            {@html icon('sliders')}{#if hiddenChanged && !docked}<span class="t-n" aria-label={t('已改 {n}', { n: hiddenChanged })}>{hiddenChanged}</span>{/if}
          </button>
        {/if}
      </div>
      <Composer bind:field bind:hasText send={sendState} {placeholder} sendLabel={pending ? t('素材还在上传') : sendLabel} {enterSends} {tall}
        onsend={gen} ontext={(s) => (curText = s)}>
        {#snippet atts()}
          {#if showAtts}
            <!-- 素材条：一行横滑（素材多了不把输入栏撑高）；角色写在素材块下面，不压在图上 -->
            <div class="cp-atts" data-hscroll>
              {#if focusImg}
                {#key focusImg.id}
                  <div class="cp-item" title={t('接着改：{p}', { p: focusImg.prompt || '' })} in:pop={{ from: 0.8 }}>
                    <div class="cp-att focus">
                      <Img src={mediaSrc(focusImg, 'thumb')} alt="" />
                      <button class="cp-x" aria-label={t('不接着改，另起一张')} onclick={() => closeFocus()}>{@html icon('close')}</button>
                    </div>
                    <span class="cp-cap">{t('接着改')}</span>
                  </div>
                {/key}
              {/if}
              {#if draft.parent && !draft.inputs.some((x) => x.fromAsset === draft.parent.id)}
                <div class="cp-item" title={t('接着做：来自「{p}」', { p: draft.parent.prompt })}>
                  <div class="cp-att lineage">
                    {#if draft.parent.thumb}<Img src={draft.parent.thumb} alt="" />{:else}<span class="cp-att-ic">{@html icon(draft.parent.kind === 'music' ? 'music' : 'voice')}</span>{/if}
                    <span class="cp-link" aria-hidden="true">{@html icon('link')}</span>
                    <button class="cp-x" aria-label={t('不记血缘')} onclick={() => clearParent(page)}>{@html icon('close')}</button>
                  </div>
                  <span class="cp-cap">{t('接着做')}</span>
                </div>
              {/if}
              {#each draft.inputs as x (x.id)}
                <div class="cp-item" class:bad={bad.includes(x)} title={x.name ? roleName(x.role) + ' · ' + x.name : roleName(x.role)}>
                  <div class="cp-att" class:pending={x.pending} class:bad={bad.includes(x)} data-input={x.id} use:attIn={x}>
                    {#if (x.kind === 'image' || x.kind === 'video') && x.url}<Img src={x.url} alt={x.name} />{:else}<span class="cp-att-ic">{@html icon(x.kind === 'video' ? 'video' : 'audio')}</span>{/if}
                    {#if x.fromAsset}<span class="cp-link" aria-hidden="true">{@html icon('link')}</span>{/if}
                    <!-- 上传中：素材淡下去、底边一条走动的朱线 -->
                    {#if x.pending}<span class="cp-up" aria-hidden="true"><Measure tone="live" /></span>{/if}
                    <button class="cp-x" aria-label={t('移除')} onclick={() => removeInput(page, x.id)}>{@html icon('close')}</button>
                  </div>
                  <span class="cp-cap">{roleTag(x.role)}</span>
                </div>
                {#if page === 'video' && x.role === 'first' && draft.inputs.some((y) => y.role === 'last')}
                  <button class="cp-swap" aria-label={t('互换首尾帧')} title={t('互换首尾帧')} onclick={() => swapFrames(page)}>{@html icon('swap')}</button>
                {/if}
              {/each}
            </div>
          {/if}
        {/snippet}
        {#snippet plus()}
          {#if canAttach}
            <button class="cp-plus" aria-label={t('添加素材')} title={t('添加素材')} aria-haspopup="dialog" aria-expanded={!!addOpen} onclick={openPlus}>{@html icon('plus')}</button>
          {/if}
        {/snippet}
      </Composer>
      {#if hint}<div class="cf-hint" class:warn>{#if warn}{@html icon('warn')}{/if}<span>{hint}</span></div>{/if}
    </div>
  </div>

  <!-- 宽屏一直挂着（外壳关坞时有一段推拢动画，内容要留到推拢结束）；坞显不显示由外壳按 side.dock 管 -->
  {#if layout.expanded}
    <div class="sd-dock-pane" class:on={active} class:docked use:toDock use:edgeFade={{ top: 16, bot: 20 }}>
      <ParamsList {page} {model} head onvoice={(s) => (voiceSpec = s)} />
    </div>
  {/if}

  {#if modelOpen}
    <ModelPicker {page} current={model?.key || ''} anchor={modelOpen} trigger={modelOpen} onclose={() => (modelOpen = null)} />
  {/if}
  {#if allOpen}
    <!-- 表单的副标题：模型名 ·（不是内置卡时）参数来源 -->
    <Layer title={t('参数')} sub={model ? [tr(model.label || model.id), srcText].filter(Boolean).join(' · ') : ''} sheet={layout.compact ? true : null} dialog={!layout.compact}
      width={440} onclose={() => (allOpen = null)}>
      <ParamsList {page} {model} flat onvoice={(s) => { allOpen = null; voiceSpec = s; }} />
    </Layer>
  {/if}
  {#if one}
    <Layer title={chipName(one.spec)} anchor={one.anchor} trigger={one.anchor} align="start" prefer="up" width={oneMenu ? 260 : oneKind === 'size' || oneKind === 'aspect' ? 340 : 320} sheet={false}
      role={oneMenu ? 'listbox' : 'dialog'} onclose={() => (one = null)}>
      {#if oneMenu}
        <OptionList inListbox options={optionsOf(one.spec, model?.id, values)} value={values[one.spec.key]} labelOf={optLabel}
          onpick={(x) => { setParam(page, one.spec.key, x); one = null; }} />
      {:else}
        <ParamsList {page} {model} flat only={[one.spec.key]} onvoice={(s) => { one = null; voiceSpec = s; }} />
      {/if}
    </Layer>
  {/if}
  {#if voiceSpec}
    <VoicePicker modelKey={model?.key || ''} current={values[voiceSpec.key] || ''} onpick={(v) => setParam(page, voiceSpec.key, v)} onclose={() => (voiceSpec = null)} />
  {/if}
  {#if addOpen}
    <AddAsset {page} {model} {roles} anchor={plusAnchor} onworks={fromWorks} onworkpick={onWorkPicked} onworkspace={fromWorkspace} ondevice={fromDevice} onclose={() => (addOpen = null)} />
  {/if}
  {#if wsPick}
    <WorkspacePicker kind={roleAccepts(wsPick.role) === 'audio' ? 'audio' : roleAccepts(wsPick.role) === 'video' ? 'video' : 'image'} onPick={onWsPicked} onclose={() => (wsPick = null)} />
  {/if}
  <input type="file" hidden accept={ACCEPT[roleAccepts(fileRole)] || 'image/png,image/jpeg,image/webp'} multiple bind:this={fileInput} onchange={onPicked} />
</div>
