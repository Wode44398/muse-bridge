<script>
  // 四个创作页共用的骨架（v3，方案 §9.2）：画布（各页给）→ 落点托盘 → 输入框（dimensio Composer）。
  // 输入框底行是 dimensio 的 Chip：＋ · 模型芯片 ⌄ · 基本参数的值芯片（「16:9」「2K」「high」，值为主，参数名只在浮层里出现）
  // · 最后一枚「参数」打开全部；值芯片放不下就整枚藏起来（不切半截字）。
  // 宽屏参数坞开着时（wide），全部参数挂进外壳的坞里（toDock），输入框里只留模型芯片——同屏信息只出一次。
  // 参数只按目录的 ParamSpec 渲染（ParamsList）。素材：＋（按模型 inputs 选角色 → 工作空间 / 本机）、拖放（DropTray）、粘贴。
  import { untrack } from 'svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { dropZone } from '../../lib/dragdrop.svelte.js';
  import { pasteFiles } from '../../lib/dropPaste.js';
  import { dtHasWsFiles, wsDescriptorFrom } from '../../lib/fileDrag.js';
  import { studio, currentModel, valuesOf, setParam, submit, removeInput, swapFrames, clearParent, roleName, roleTag } from '../../modules/studio/media.svelte.js';
  import { basicSpecs, imageRoles, inputRoles, promptLangs, textFitsLangs, optionsOf } from '../../modules/studio/params.js';
  import { chipValue, controlOf, formatOf, selfExplaining } from '../../modules/studio/render.js';
  import { paramLabel, optText, sourceText } from '../../modules/studio/words.js';
  import { paramSource } from '../../modules/studio/picker.js';
  import { providerLogo } from '../../lib/providerLogos.js';
  import { labelForId } from '../../modules/studio/media.svelte.js';
  import { slotDropFor, defaultRole, dropOsFile, dropInto, roleAccepts } from '../../modules/studio/drag.js';
  import { icon, aspectBox } from '../../modules/studio/icons.js';
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
    page, active = false, wide = false,
    title = '', placeholder = '', sendLabel = '', enterSends = true, tall = false,
    needText = () => true,          // (draft) → 这次生成要不要正文
    canvas,
  } = $props();

  const draft = $derived(studio.drafts[page]);
  const model = $derived(currentModel(page));
  const values = $derived(valuesOf(page, model));
  const chipSpecs = $derived(basicSpecs(model?.params || [], values));
  const hasParams = $derived(!!(model?.params?.length || model?.inputs?.negative));

  let field = $state(), hasText = $state(false);
  let sending = $state(false), err = $state('');
  let modelOpen = $state(null);              // 模型芯片元素（选择器锚点）
  let allOpen = $state(null);                // 「参数」芯片元素（全部参数浮层锚点）
  let one = $state(null);                    // { spec, anchor }：值芯片点开的单项浮层
  let voiceSpec = $state(null);
  let addOpen = $state(null), wsPick = $state(null);
  let fileInput = $state(), fileRole = $state('');
  let plusAnchor = $state(null);
  let modelTrig = $state(null), allTrig = $state(null);   // 模型芯片 / 「参数」芯片（浮层锚在整块输入框上，点它们才是开关）

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
  const hint = $derived(err || (bad.length ? t('当前模型不接收{role}', { role: roleName(bad[0].role) }) : '') || langHint || studio.notice);
  const warn = $derived(!!err || !!bad.length || langBad);
  const textOk = $derived((hasText || !needText(draft)) && !langBad);
  $effect(() => { model?.key; untrack(() => { err = ''; }); });
  // 一次性提示（已换到 X）：看过 6 秒自己收
  $effect(() => { if (studio.notice && active) { const n = studio.notice; const tm = setTimeout(() => { if (studio.notice === n) studio.notice = ''; }, 6000); return () => clearTimeout(tm); } });

  // 别处要填进来的正文（文本文件拖入、发到 Studio、接着做、复用参数）
  $effect(() => {
    const pt = studio.pendingText;
    if (pt && pt.page === page && field) untrack(() => { field.textContent = pt.text; hasText = !!pt.text.trim(); curText = pt.text; studio.pendingText = null; });
  });

  async function gen() {
    if (sending || pending || bad.length) return;
    const txt = (field?.textContent || '').trim();
    if (needText(draft) && !txt) return;
    if (langs && !textFitsLangs(txt, langs)) return;
    sending = true; err = '';
    const r = await submit(page, txt);
    sending = false;
    if (r.ok) { if (field) field.textContent = ''; hasText = false; curText = ''; studio.notice = ''; }
    else err = r.error || t('生成失败');
  }

  // —— 值芯片：只出值；放不下的整枚藏起来（都在「参数」里），不横滑切半截字 ——
  function fitChips(node) {
    // 最后一枚是「参数」，永远在；它被挤出容器右缘时，从后往前把值芯片整枚藏起来，直到它放得下
    const fit = () => {
      const kids = [...node.children];
      for (const c of kids) c.hidden = false;
      const all = kids[kids.length - 1];
      const vals = kids.slice(0, -1);
      const right = () => node.getBoundingClientRect().right + 0.5;
      for (let i = vals.length - 1; i >= 0 && all && all.getBoundingClientRect().right > right(); i--) vals[i].hidden = true;
    };
    const ro = new ResizeObserver(fit); ro.observe(node); if (node.parentElement) ro.observe(node.parentElement);
    const mo = new MutationObserver(() => requestAnimationFrame(fit)); mo.observe(node, { childList: true, subtree: true, characterData: true });
    fit();
    return { destroy() { ro.disconnect(); mo.disconnect(); } };
  }
  const optLabel = optText;
  const chipName = paramLabel;
  // 值芯片：值为主；值自己说得清的（比例 / 分辨率 / 尺寸 / 时长 / 张数）只写值，别的前面带一个淡色参数名（「画质 高」）
  const chipOf = (spec) => {
    const v = chipValue(spec, values[spec.key], { labelOf: optLabel, modelId: model?.id, values });
    if (v == null) return null;
    if (v === '') return { name: '', text: chipName(spec) };   // bool 开着只写名字
    return { name: selfExplaining(spec) || spec.type === 'voice' ? '' : chipName(spec), text: v };
  };
  const chips = $derived(chipSpecs.map((s) => ({ spec: s, ...(chipOf(s) || {}) })).filter((c) => c.text != null));
  const logo = $derived(model?.provider ? providerLogo(model.provider) : '');
  const src = $derived(paramSource(model));
  const srcText = $derived(sourceText(src, labelForId, true));
  // 输入框整块：模型选择器、「参数」浮层贴着它的左缘开在它上面，不盖住它（复核 11-06：右对齐芯片时浮层随芯片长短左右跳、压住输入框）
  let cpBox = $state();
  const cpAnchor = () => cpBox?.querySelector('.cp') || null;
  function openChip(e, spec) {
    if (spec.type === 'voice') { voiceSpec = spec; return; }
    const el = e.currentTarget;
    one = one?.spec?.key === spec.key ? null : { spec, anchor: el };
  }
  // 单项浮层里枚举（非比例）直接出选项菜单；其余出那一行控件
  const oneMenu = $derived(one && one.spec.type === 'enum' && controlOf(one.spec, optionsOf(one.spec, model?.id, values)) !== 'aspect');

  // —— ＋：先选角色（只有一种就跳过）再选来源 ——
  function openPlus(e) { plusAnchor = e?.currentTarget || null; addOpen = true; }
  function fromWorkspace(role) { addOpen = null; wsPick = { role }; }
  function fromDevice(role) { addOpen = null; fileRole = role; requestAnimationFrame(() => fileInput?.click()); }
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

  // —— 拖放：指针拖拽松在输入框本体＝默认角色；HTML5（电脑版工作空间 / 系统文件）——
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

<div class="cf" class:wide role="region" aria-label={title}
  ondragenter={h5Enter} ondragover={h5Over} ondragleave={h5Leave} ondrop={(e) => h5Drop(e)}
  use:pasteFiles={{ onFiles: onPaste, filter: (f) => /^(image|audio|video)\//.test(f.type || ''), when: () => active && canAttach }}>

  <div class="cf-scroll">
    <div class="cf-col">{@render canvas?.()}</div>
  </div>

  <div class="cf-dock" use:dockZone>
    <div class="cf-col" bind:this={cpBox}>
      <DropTray {page} {model} html5={h5} onhtml5drop={(e, role) => h5Drop(e, role)} />
      <Composer bind:field bind:hasText busy={sending} disabled={!textOk || pending || !!bad.length || !model}
        {placeholder} sendLabel={pending ? t('素材还在上传') : sendLabel} {enterSends} {tall} onsend={gen} ontext={(s) => (curText = s)}>
        {#snippet atts()}
          {#if draft.inputs.length || draft.parent}
            <!-- 素材条：一行横滑（素材多了不把输入框撑高）；角色写在素材块下面，不压在图上 -->
            <div class="cp-atts" data-hscroll>
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
                  <div class="cp-att" class:pending={x.pending} class:bad={bad.includes(x)}>
                    {#if (x.kind === 'image' || x.kind === 'video') && x.url}<Img src={x.url} alt={x.name} />{:else}<span class="cp-att-ic">{@html icon(x.kind === 'video' ? 'video' : 'audio')}</span>{/if}
                    {#if x.fromAsset}<span class="cp-link" aria-hidden="true">{@html icon('link')}</span>{/if}
                    <!-- 上传中：素材淡下去、底边一条走动的朱线（只一粒点时像图里本来的东西，发送键灰着看不出在等什么，复核 11-06） -->
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
        {#snippet tools()}
          {#if canAttach}
            <button class="cp-ib" aria-label={t('添加素材')} title={t('添加素材')} onclick={openPlus}>{@html icon('plus')}</button>
          {/if}
          <!-- 模型芯片带服务的灰度标：两家都有「Nano Banana Pro」时看得出用的是哪家 -->
          <button class="chip cp-model" class:open={!!modelOpen} disabled={!model} aria-haspopup="dialog" aria-expanded={!!modelOpen}
            title={model ? tr(model.label || model.id) + (model.provider?.name ? ' · ' + tr(model.provider.name) : '') : ''} onclick={(e) => { modelTrig = e.currentTarget; modelOpen = modelOpen ? null : cpAnchor(); }}>
            {#if logo}<span class="cp-logo" aria-hidden="true">{@html logo}</span>{/if}
            <span class="chip-tx">{model ? tr(model.label || model.id) : t('没有模型')}</span>
            <span class="chev">{@html icon('down')}</span>
          </button>
          {#if !wide && hasParams}
            <div class="cp-chips" use:fitChips>
              {#each chips as c (c.spec.key)}
                <button class="chip cp-val" class:open={one?.spec?.key === c.spec.key} title={chipName(c.spec)} onclick={(e) => openChip(e, c.spec)} data-chip={c.spec.key}>
                  {#if c.spec.type === 'bool'}{@html icon('check')}{:else if formatOf(c.spec) === 'aspect' && /^\d/.test(String(values[c.spec.key]))}<span class="cp-asp" aria-hidden="true">{@html aspectBox(values[c.spec.key], 12)}</span>{:else if formatOf(c.spec) === 'aspect'}<span class="cp-asp" aria-hidden="true"><span class="cp-asp-auto"></span></span>{/if}
                  {#if c.name}<i>{c.name}</i>{/if}<span class="chip-tx">{c.text}</span>
                </button>
              {/each}
              <button class="chip cp-all" class:open={!!allOpen} aria-haspopup="dialog" aria-expanded={!!allOpen} aria-label={t('参数')} onclick={(e) => { allTrig = e.currentTarget; allOpen = allOpen ? null : cpAnchor(); }}>
                {@html icon('sliders')}<span class="chip-tx">{t('参数')}</span>
              </button>
            </div>
          {/if}
        {/snippet}
      </Composer>
      {#if hint}<div class="cf-hint" class:warn>{#if warn}{@html icon('warn')}{/if}<span>{hint}</span></div>{/if}
    </div>
  </div>

  {#if wide}
    <div class="sd-dock-pane" class:on={active} use:toDock>
      <ParamsList {page} {model} head onvoice={(s) => (voiceSpec = s)} />
    </div>
  {/if}

  {#if modelOpen}
    <ModelPicker {page} current={model?.key || ''} anchor={modelOpen} trigger={modelTrig} onclose={() => (modelOpen = null)} />
  {/if}
  {#if allOpen}
    <!-- 浮层 / Sheet 的副标题：模型名 ·（不是内置卡时）参数来源——三端同一处 -->
    <Layer title={t('参数')} sub={model ? [tr(model.label || model.id), srcText].filter(Boolean).join(' · ') : ''} anchor={allOpen} trigger={allTrig} align="start" prefer="up" avoid={allOpen} width={380} onclose={() => (allOpen = null)}>
      <ParamsList {page} {model} flat onvoice={(s) => { allOpen = null; voiceSpec = s; }} />
    </Layer>
  {/if}
  {#if one}
    <Layer title={chipName(one.spec)} anchor={one.anchor} align="start" prefer="up" avoid={cpAnchor()} width={oneMenu ? 260 : 320} sheet={layout.compact && !oneMenu ? null : false}
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
    <AddAsset {page} {model} {roles} anchor={plusAnchor} onworkspace={fromWorkspace} ondevice={fromDevice} onclose={() => (addOpen = null)} />
  {/if}
  {#if wsPick}
    <WorkspacePicker kind={roleAccepts(wsPick.role) === 'audio' ? 'audio' : roleAccepts(wsPick.role) === 'video' ? 'video' : 'image'} onPick={onWsPicked} onclose={() => (wsPick = null)} />
  {/if}
  <input type="file" hidden accept={ACCEPT[roleAccepts(fileRole)] || 'image/png,image/jpeg,image/webp'} multiple bind:this={fileInput} onchange={onPicked} />
</div>
