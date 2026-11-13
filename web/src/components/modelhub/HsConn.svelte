<script>
  // 连接：新建时的第一步（mode 'first'：快捷选择 + 地址 + Key + 识别），也是顶栏下方可收放的连接面板的内容：
  //   'draft'   新建中、识别过还没保存：名字、地址、接口类型分段、Key、出站代理、重新识别
  //   'service' 已有服务：名字、地址、Key 列表（标签 / 更换 / 启停 / 测试 / 移除、按顺序或轮流）、
  //             出站代理、启用、共享给成员（多用户服务器的管理员才有）、重新识别、删除；有改动时出「保存连接」（hubPost('update')）
  // 草稿的字段 d 由 HubService 持有（bind 进来）：识别、建服务都要读它；已有服务的编辑态 ed 在这里，面板收起时不丢。
  // 导出 redetect()：先存连接改动再识别——HubService 的列表头、错误条的「重新识别」也经 bind:this 走它。
  // 这段脚本有单测：HubService.logic.test.js（把 <script> 抠出来跑），改 import / $props 的写法时同步那边。
  import { untrack, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import BrandLogo from './BrandLogo.svelte';
  import HsSeg from './HsSeg.svelte';
  import SToggle from '../settings/SToggle.svelte';
  import { G, svg, normUrl, urlOk, hostOf, isLocal, tailText, ago, edgeFade, cleanKey, pasteKey, connMoved } from './HsKit.js';
  import { hubPost, hubAsk, PROTO_NAME, lineNote } from '../../lib/modelHub.svelte.js';
  import { cp, loadProviders, canUseCustomApi } from '../../lib/claudeProviders.svelte.js';
  import { providerOf, FEATURED_PROVIDERS } from '../../../../src/model-knowledge/brands.mjs';
  import { DUR } from '../../lib/motion.js';
  import { t, tc, tr } from '../../lib/i18n.js';

  // locked：外面正在保存模型去向——这期间不许识别（识别结果会和刚落库的目录对不上）
  let {
    mode = 'first', d = $bindable(), svc = null, narrow = false,
    detecting = false, detErr = '', detWarn = [], stale = false, catAt = 0, now = Date.now(),
    ondetect, onsaved, ondelete, testModel = '', dirty = $bindable(false), connErr = '', locked = false,
  } = $props();

  // 「共享给成员」只有多用户服务器的管理员有（cp.canShare，随 Claude 服务的配置下发）：还没拉过就拉一次
  if (untrack(() => mode) !== 'first' && !cp.ok && canUseCustomApi()) loadProviders();

  // —— 地址框左侧的品牌位：没填 = 链接、填了认不出 = 地球、认出来 = 品牌标，三者交叉淡入 ——
  const url = $derived(mode === 'service' ? ed?.baseUrl || '' : d?.url || '');
  const prov = $derived(url.trim() ? providerOf(normUrl(url)) : null);
  const slotKey = $derived(prov ? 'p:' + prov.key : url.trim() ? 'globe' : 'link');
  const local = $derived(isLocal(url));

  // —— 第一步 / 草稿 ——
  const canDetect = $derived(!!d && urlOk(d.url) && (!!d.key.trim() || isLocal(d.url)) && !detecting);
  let keyEl = $state();
  let showKey = $state(false);
  function pick(p) {
    d.url = p.baseUrl;
    d.hint = p.protocol || '';
    // 地址填好了，下一步就是粘 Key
    tick().then(() => keyEl?.focus());
  }
  // Key 框：粘贴 / 打进来的空白、换行、控制字符就地去掉（整串，不只是首尾——夹在中间的换行会让请求头不合法）。
  // 状态里存的和框里显示的必须是同一串：粘贴由这里接管（preventDefault），值算好后同时写进输入框和状态。
  function caretTo(el, pos) { try { el.setSelectionRange(pos, pos); } catch {} }
  function onKeyPaste(e, set) {
    const s = e.clipboardData?.getData('text');
    if (typeof s !== 'string') return;
    e.preventDefault();
    const el = e.currentTarget;
    const v = el.value;
    const r = pasteKey(v, el.selectionStart ?? v.length, el.selectionEnd ?? v.length, s);
    el.value = r.value;
    caretTo(el, r.caret);
    set(r.value);
  }
  // 打字、拖放、输入法联想贴进来的走 input：有要去掉的字符就把框里的也改掉（输入法组字中途不动，免得打断它）
  function onKeyInput(e, set) {
    const el = e.currentTarget;
    let v = el.value;
    const c = e.isComposing ? v : cleanKey(v);
    if (c !== v) {
      const pos = cleanKey(v.slice(0, el.selectionStart ?? v.length)).length;
      el.value = v = c;
      caretTo(el, pos);
    }
    set(v);
  }
  function submit(e) {
    e.preventDefault();
    if (mode === 'first' ? canDetect : !detecting && !locked) ondetect?.();
  }

  // —— 已有服务：编辑态 ——
  let uid = 0;
  const mkLine = (l = {}, keep = null) => ({
    _k: ++uid, id: l.id || '', label: l.label || '', baseUrl: l.baseUrl || '', enabled: l.enabled !== false,
    key: '', editing: false, hasKey: !!l.hasKey, keyTail: l.keyTail || '', state: l.state || null,
    test: keep?.test || null,
  });
  const fromSvc = (s, prev = null) => ({
    id: s.id, name: s.name || '', baseUrl: s.baseUrl || '', useProxy: s.useProxy !== false, enabled: s.enabled !== false,
    members: s.members === true,   // 共享给成员
    strategy: s.strategy === 'round-robin' ? 'round-robin' : 'failover',
    // 测试结果按线路 id 留着：保存模型去向会刷新总览，别把刚测出来的「通了」冲掉
    lines: (s.lines || []).map((l) => mkLine(l, prev?.lines.find((x) => x.id && x.id === l.id))),
  });
  let ed = $state(null);
  const live = (lines) => lines.filter((l) => l.id || l.key.trim());
  function isDirty(e, s) {
    if (!e || !s || e.id !== s.id) return false;
    if (e.name.trim() !== (s.name || '') || normUrl(e.baseUrl) !== normUrl(s.baseUrl)) return true;
    if (e.useProxy !== (s.useProxy !== false) || e.enabled !== (s.enabled !== false)) return true;
    if (cp.canShare && e.members !== (s.members === true)) return true;
    if (e.strategy !== (s.strategy === 'round-robin' ? 'round-robin' : 'failover')) return true;
    const ls = live(e.lines), os = s.lines || [];
    if (ls.length !== os.length) return true;
    return ls.some((l, i) => l.id !== os[i].id || l.label.trim() !== (os[i].label || '') || l.enabled !== (os[i].enabled !== false) || !!l.key.trim());
  }
  const edDirty = $derived(mode === 'service' && isDirty(ed, svc));
  $effect(() => { dirty = edDirty; });
  // 服务刷新了（保存、重拉总览）而本地没改动：跟着换成最新的；有改动就不动，免得把正在填的冲掉
  $effect(() => {
    const s = mode === 'service' ? svc : null;
    if (!s) return;
    untrack(() => { if (!ed || ed.id !== s.id || !isDirty(ed, s)) ed = fromSvc(s, ed); });
  });

  let busy = $state('');      // 'save' | 'reset:<lineId>'
  let err = $state('');
  const strategyOpts = $derived([{ value: 'failover', label: t('按顺序') }, { value: 'round-robin', label: t('轮流') }]);
  const protoOpts = $derived(['openai', 'anthropic', 'gemini'].map((k) => ({ value: k, label: PROTO_NAME[k] })));

  async function save() {
    if (busy || !ed || !svc) return false;
    const name = ed.name.trim();
    const ls = live(ed.lines);
    err = !name ? t('要有名字') : !urlOk(ed.baseUrl) ? t('接口地址不合法') : !ls.length ? t('至少要留一把 Key') : '';
    if (err) return false;
    // 识别要用的地址 / Key 变没变（存之前算：存完 svc 就换成新的了）。变了的话模型目录还是旧连接的，交给外面处理
    const moved = connMoved(ed, svc);
    busy = 'save';
    try {
      const patch = {
        name, baseUrl: normUrl(ed.baseUrl), useProxy: ed.useProxy, enabled: ed.enabled, strategy: ed.strategy,
        ...(cp.canShare ? { members: ed.members } : {}),
        // 标签留空的补成「Key n」；没填 Key 的新线路不提交（服务端要求新线路带 Key）
        lines: ls.map((l, i) => ({
          ...(l.id ? { id: l.id } : {}), label: l.label.trim() || `Key ${i + 1}`, baseUrl: l.baseUrl || '', enabled: l.enabled,
          ...(l.key.trim() ? { key: l.key.trim() } : {}),
        })),
      };
      const r = await hubPost('update', { id: svc.id, patch });
      if (r.service) ed = fromSvc(r.service, ed);
      onsaved?.(r.service || null, r.warnings || [], { moved });
      return true;
    } catch (e) {
      err = tr(e.message);
      return false;
    } finally { busy = ''; }
  }
  function revert() { if (svc) { ed = fromSvc(svc, ed); err = ''; } }
  /**
   * 重新识别。先把连接改动存上：识别读的是存着的地址与 Key（不存就识别，用的是旧 Key，报出来的错会让人以为新 Key 不行）。
   * 返回 false = 改动没存上（原因显示在面板里），没有去识别。
   */
  export async function redetect() {
    if (locked || busy) return true;
    if (mode === 'service' && edDirty && !(await save())) return false;
    ondetect?.();
    return true;
  }
  function addLine() {
    const l = mkLine();
    l.editing = true;
    ed.lines.push(l);
  }
  function removeLine(l) {
    if (ed.lines.length <= 1) return;
    ed.lines = ed.lines.filter((x) => x !== l);
  }
  function replaceKey(l) {
    l.editing = true;
    l.test = null;
  }
  function keyEsc(e, l) {
    if (e.key !== 'Escape' || e.isComposing) return;
    // Esc 还原这一把：已有线路收回成尾号，新加的整条拿掉
    e.preventDefault(); e.stopPropagation();
    if (!l.id) { if (ed.lines.length > 1) ed.lines = ed.lines.filter((x) => x !== l); else { l.key = ''; } return; }
    l.key = ''; l.editing = false;
  }
  async function testLine(l) {
    if (!testModel || !svc || l.test?.busy) return;
    if (!l.id && !l.key.trim()) return;
    l.test = { busy: true };
    try {
      // 统一走草稿形状：面板里改了地址 / 代理还没保存，也按眼前填的测；Key 没重填时服务端用存着的那把
      const r = await hubAsk('test', {
        id: svc.id, model: testModel,
        draft: { baseUrl: normUrl(ed.baseUrl), useProxy: ed.useProxy, line: { id: l.id || undefined, baseUrl: l.baseUrl || '', key: l.key.trim() } },
      });
      l.test = r.result || { ok: false, status: 0, ms: 0, error: t('没有结果') };
    } catch (e) {
      l.test = { ok: false, status: 0, ms: 0, error: e.message };
    }
  }
  async function resetLine(l) {
    if (busy || !svc) return;
    busy = 'reset:' + l.id;
    try {
      const r = await hubPost('line/reset', { id: svc.id, lineId: l.id });
      // quiet：解除冷却不是「保存」，不弹「已保存」
      onsaved?.(r.service || null, [], { quiet: true });
    } catch (e) { err = tr(e.message); } finally { busy = ''; }
  }
  const testText = (r) => r.busy ? t('测试中…') : r.ok ? t('通了，{ms} 毫秒', { ms: r.ms }) : (r.status ? `HTTP ${r.status} · ` : '') + tr(r.error || '');
  const noteOf = (l) => {
    if (!l.hasKey && !l.key.trim() && local) return l.enabled ? '' : t('已停用');
    return l.id ? lineNote(l, now) : '';
  };
  const cooling = (l) => l.enabled && (l.state?.coolUntil || 0) > now;
  const when = $derived(catAt ? ago(catAt, now) : '');
</script>

{#snippet slot()}
  <span class="slot" aria-hidden="true">
    {#key slotKey}
      <span class="sl" in:fade={{ duration: DUR.quick }} out:fade={{ duration: DUR.quick }}>
        {#if prov}<BrandLogo plain size={20} logo={prov.logo} name={prov.name} />{:else}{@html svg(slotKey === 'globe' ? G.globe : G.link)}{/if}
      </span>
    {/key}
  </span>
{/snippet}

{#snippet keyField(value, set, id)}
  <div class="field">
    <input {id} bind:this={keyEl} class="in mono" type={showKey ? 'text' : 'password'} autocomplete="off" spellcheck="false" autocapitalize="off"
      data-1p-ignore data-lpignore="true" value={value} oninput={(e) => onKeyInput(e, set)} onpaste={(e) => onKeyPaste(e, set)}
      placeholder={local ? t('可不填') : ''} />
    <button type="button" class="eye" aria-pressed={showKey} aria-label={showKey ? t('隐藏') : t('显示')} title={showKey ? t('隐藏') : t('显示')}
      onclick={() => { showKey = !showKey; }}>{@html svg(showKey ? G.eyeOff : G.eye)}</button>
  </div>
{/snippet}

{#snippet msgs()}
  {#if detErr}<p class="err" role="alert">{detErr}</p>{/if}
  {#each detWarn as w, i (i)}<p class="warn">{tr(w)}</p>{/each}
{/snippet}

{#snippet saveBtns()}
  <button type="button" class="btn" onclick={revert} disabled={busy === 'save'}>{t('放弃')}</button>
  <button type="button" class="btn primary" class:busy={busy === 'save'} onclick={save} disabled={busy === 'save'}>
    {#if busy === 'save'}<span class="spin" aria-hidden="true"></span>{t('保存中…')}{:else}{t('保存连接')}{/if}
  </button>
{/snippet}

{#if mode === 'first'}
  <form class="first" class:narrow onsubmit={submit} novalidate>
    <div class="feat" class:scroll={narrow} use:edgeFade role="group" aria-label={t('快捷选择')}>
      {#each FEATURED_PROVIDERS as p (p.key)}
        {@const on = prov?.key === p.key}
        <button type="button" class="fc" class:on aria-pressed={on} title={tr(p.name)} onclick={() => pick(p)}>
          <BrandLogo size={24} logo={p.logo} name={p.name} />
          <span class="fn">{tr(p.name)}</span>
        </button>
      {/each}
    </div>
    <label class="fl" for="hs-url">{t('接口地址')}</label>
    <div class="field">
      {@render slot()}
      <!-- svelte-ignore a11y_autofocus -->
      <input id="hs-url" class="in mono lead" type="url" inputmode="url" autocomplete="off" spellcheck="false" autocapitalize="off" autofocus={!narrow}
        bind:value={d.url} placeholder="https://…/v1" />
    </div>
    <label class="fl" for="hs-key">{t('API Key')}</label>
    {@render keyField(d.key, (v) => { d.key = v; }, 'hs-key')}
    {@render msgs()}
    <div class="acts">
      <button type="submit" class="btn primary go" class:busy={detecting} disabled={!canDetect}>
        {#if detecting}<span class="spin" aria-hidden="true"></span>{t('识别中')}{:else}{t('识别模型')}{/if}
      </button>
    </div>
    {#if detecting}
      <div class="skel" aria-hidden="true" transition:fade={{ duration: DUR.quick }}>
        {#each [64, 46, 72, 52, 68, 40] as w, k (k)}
          <div class="sk" style:--w="{w}%"><span class="b cbk"></span><span class="b lgk"></span><span class="b txk"></span></div>
        {/each}
      </div>
    {/if}
  </form>
{:else if mode === 'draft' && d}
  <form class="card" class:narrow onsubmit={submit} novalidate>
    <div class="grid2">
      <div class="fld">
        <label class="fl" for="hs-dname">{t('名字')}</label>
        <input id="hs-dname" class="in" type="text" autocomplete="off" maxlength="40" bind:value={d.name} oninput={() => { d.nameTouched = true; }}
          placeholder={prov ? tr(prov.name) : hostOf(d.url) || t('未命名服务')} />
      </div>
      <div class="fld">
        <label class="fl" for="hs-durl">{t('接口地址')}</label>
        <div class="field">
          {@render slot()}
          <input id="hs-durl" class="in mono lead" type="url" inputmode="url" autocomplete="off" spellcheck="false" autocapitalize="off" bind:value={d.url} placeholder="https://…/v1" />
        </div>
      </div>
    </div>
    <div class="fld">
      <span class="fl">{t('接口类型')}</span>
      <HsSeg label={t('接口类型')} options={protoOpts} value={d.proto} onchange={(v) => { d.proto = v; d.protoTouched = true; }} />
    </div>
    <div class="fld">
      <label class="fl" for="hs-dkey">{t('API Key')}</label>
      {@render keyField(d.key, (v) => { d.key = v; }, 'hs-dkey')}
    </div>
    <div class="sws">
      <label class="sw">
        <span class="swl">{t('走出站代理')}</span>
        <SToggle checked={d.useProxy} label={t('走出站代理')} onchange={(v) => { d.useProxy = v; d.proxyTouched = true; }} />
      </label>
    </div>
    {@render msgs()}
    <div class="foot">
      <button type="submit" class="btn" class:primary={stale} class:busy={detecting} disabled={detecting || locked || !urlOk(d.url)}>
        {#if detecting}<span class="spin" aria-hidden="true"></span>{t('识别中')}{:else}{@html svg(G.refresh)}{t('重新识别')}{/if}
      </button>
      <!-- 「上次识别」宽屏在列表头上就有，这里不重复（窄屏的列表头放不下它） -->
      {#if stale}<span class="hint">{t('连接改了，先重新识别')}</span>{:else if narrow && when}<span class="hint">{t('上次识别 {when}', { when })}</span>{/if}
    </div>
  </form>
{:else if mode === 'service' && ed && svc}
  <div class="card" class:narrow>
    <div class="grid2">
      <div class="fld">
        <label class="fl" for="hs-sname">{t('名字')}</label>
        <input id="hs-sname" class="in" type="text" autocomplete="off" maxlength="40" bind:value={ed.name} />
      </div>
      <div class="fld">
        <label class="fl" for="hs-surl">{t('接口地址')}</label>
        <div class="field">
          {@render slot()}
          <input id="hs-surl" class="in mono lead" type="url" inputmode="url" autocomplete="off" spellcheck="false" autocapitalize="off" bind:value={ed.baseUrl} placeholder="https://…/v1" />
        </div>
      </div>
    </div>
    <!-- 接口类型不在这里重复：顶栏名字下面那行已经写着「host · 接口类型 · Key 尾号」 -->
    <div class="keys">
      <div class="kh">
        <span class="fl">{t('API Key')}</span>
        {#if ed.lines.length >= 2}
          <div class="strat"><HsSeg label={t('多把 Key 的用法')} options={strategyOpts} value={ed.strategy} onchange={(v) => { ed.strategy = v; }} /></div>
        {/if}
      </div>
      <div class="lines">
        {#each ed.lines as l, i (l._k)}
          {@const note = noteOf(l)}
          <div class="ln" class:off={!l.enabled}>
            <input class="lbl" type="text" maxlength="40" autocomplete="off" bind:value={l.label} placeholder={`Key ${i + 1}`} aria-label={t('这把 Key 的标签')} />
            {#if l.editing || !l.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input class="in mono kin" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" data-1p-ignore data-lpignore="true"
                autofocus value={l.key} oninput={(e) => onKeyInput(e, (v) => { l.key = v; l.test = null; })} onpaste={(e) => onKeyPaste(e, (v) => { l.key = v; l.test = null; })}
                onkeydown={(e) => keyEsc(e, l)} placeholder={l.id ? t('新 Key') : t('粘贴 Key')} aria-label={t('新 Key')} />
            {:else}
              <span class="tail" class:none={!l.hasKey}>{l.hasKey ? tailText(l.keyTail) : local ? '—' : t('缺 Key')}</span>
              <button type="button" class="tbtn" onclick={() => replaceKey(l)}>{t('更换')}</button>
            {/if}
            <!-- 窄屏和下面几行用同一种开关（64 宽的墨色开关），一张卡里不混两种 -->
            <SToggle compact={!narrow} checked={l.enabled} label={t('启用这把 Key')} onchange={(v) => { l.enabled = v; }} />
            <button type="button" class="tbtn" disabled={!testModel || (!l.id && !l.key.trim()) || l.test?.busy}
              title={testModel ? testModel : t('还没有文本模型')} onclick={() => testLine(l)}>{tc('线路', '测试')}</button>
            <button type="button" class="ib" disabled={ed.lines.length <= 1} aria-label={t('移除')} title={t('移除')} onclick={() => removeLine(l)}>{@html svg(G.trash)}</button>
          </div>
          {#if l.test || note}
            <div class="lres" class:ok={l.test?.ok} class:bad={l.test && !l.test.busy && !l.test.ok} aria-live="polite">
              {#if l.test}{testText(l.test)}{:else}{note}{/if}
              {#if !l.test && cooling(l)}
                <button type="button" class="tbtn sm" disabled={busy === 'reset:' + l.id} onclick={() => resetLine(l)}>{t('现在就再用')}</button>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
      <button type="button" class="add" onclick={addLine} disabled={ed.lines.length >= 30}>{@html svg(G.plus)}{t('添加 Key')}</button>
    </div>

    <div class="sws">
      <label class="sw">
        <span class="swl">{t('走出站代理')}</span>
        <SToggle checked={ed.useProxy} label={t('走出站代理')} onchange={(v) => { ed.useProxy = v; }} />
      </label>
      <label class="sw">
        <span class="swl">{t('启用这个服务')}</span>
        <SToggle checked={ed.enabled} label={t('启用这个服务')} onchange={(v) => { ed.enabled = v; }} />
      </label>
      {#if cp.canShare}
        <label class="sw">
          <span class="swl">{t('共享给成员')}</span>
          <SToggle checked={ed.members} label={t('共享给成员')} onchange={(v) => { ed.members = v; }} />
        </label>
      {/if}
    </div>

    {#if err || connErr}<p class="err" role="alert">{err || connErr}</p>{/if}
    {#if detErr}<p class="err" role="alert">{detErr}</p>{/if}

    <div class="foot">
      <button type="button" class="btn" class:busy={detecting} disabled={detecting || locked || busy === 'save'} onclick={redetect}>
        {#if detecting}<span class="spin" aria-hidden="true"></span>{t('识别中')}{:else}{@html svg(G.refresh)}{t('重新识别')}{/if}
      </button>
      <!-- 「上次识别」宽屏在列表头上就有，这里不重复；窄屏的列表头放不下它，留在这里 -->
      {#if narrow && when}<span class="hint">{t('上次识别 {when}', { when })}</span>{/if}
      <span class="spx"></span>
      {#if !narrow}
        <!-- 宽屏：「放弃 / 保存连接」常驻占位、只切显隐——改第一个字时卡片不长高，下面的列表不跳 -->
        <div class="sv" class:show={edDirty} inert={!edDirty}>{@render saveBtns()}</div>
      {/if}
      <button type="button" class="tbtn danger" onclick={() => ondelete?.()}>{t('删除服务')}</button>
    </div>
    {#if narrow && edDirty}
      <div class="savebar" transition:fade={{ duration: DUR.micro }}>{@render saveBtns()}</div>
    {/if}
  </div>
{/if}

<style>
  /* —— 字段（宽屏 38 高圆角 10；窄屏 46 高圆角 14、字号 16 防 iOS 缩放） —— */
  .fl { display: block; margin: 0 0 7px 2px; font-size: 12.5px; font-weight: 600; color: var(--st-text2); }
  .field { position: relative; display: flex; align-items: center; }
  .in { width: 100%; min-width: 0; height: 38px; padding: 0 12px; box-sizing: border-box; border: 0; border-radius: 10px; background: var(--st-field); color: var(--text);
    box-shadow: inset 0 0 0 1px var(--st-line); font: inherit; font-size: 14px; outline: none; transition: box-shadow var(--mo-micro) var(--ea-fade); }
  .in:focus { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 55%, transparent); }
  .in::placeholder { color: var(--st-muted); }
  .in.mono { font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 13px; }
  .in.lead { padding-left: 42px; }
  .field:has(.eye) .in { padding-right: 44px; }
  .narrow .in { height: 46px; border-radius: 14px; font-size: 16px; background: var(--st-surface); box-shadow: none; }
  .narrow .in:focus { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 40%, transparent); }
  .narrow .in.mono { font-size: 16px; }
  .narrow .in.lead { padding-left: 46px; }
  .card.narrow .in { background: var(--st-field); }
  .narrow .fl { margin-left: 4px; font-size: 13px; }

  /* 品牌位：线稿 / 品牌标叠在同一格里交叉淡入 */
  .slot { position: absolute; left: 10px; top: 50%; width: 24px; height: 24px; margin-top: -12px; color: var(--st-muted); pointer-events: none; }
  .narrow .slot { left: 12px; }
  .sl { position: absolute; inset: 0; display: grid; place-items: center; }
  .sl :global(svg) { width: 18px; height: 18px; }
  .sl :global(.bl svg) { width: auto; height: auto; }
  .eye { position: absolute; right: 4px; top: 50%; width: 32px; height: 32px; margin-top: -16px; display: grid; place-items: center; border: 0; border-radius: 8px;
    background: transparent; color: var(--st-muted); cursor: pointer; transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade); }
  .eye :global(svg) { width: 17px; height: 17px; }
  @media (hover: hover) { .eye:hover { background: var(--st-hover); color: var(--text); } }
  .eye:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .narrow .eye { width: 44px; height: 44px; margin-top: -22px; right: 1px; border-radius: 13px; }

  /* —— 第一步：居中单列，最宽 560 —— */
  .first { width: 100%; max-width: 560px; margin: 0 auto; padding: 8px 0 24px; }
  .feat { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 22px; }
  /* 窄屏：两行横滑（16 张卡竖排要占大半屏，把地址框挤到折线以下） */
  .feat.scroll { grid-template-columns: none; grid-auto-flow: column; grid-template-rows: repeat(2, 52px); grid-auto-columns: minmax(148px, 42%);
    overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; margin: 0 -16px 22px; padding: 2px 16px;
    -webkit-mask-image: linear-gradient(to right, transparent, #000 var(--fl, 0px), #000 calc(100% - var(--fr, 0px)), transparent);
    mask-image: linear-gradient(to right, transparent, #000 var(--fl, 0px), #000 calc(100% - var(--fr, 0px)), transparent); }
  .feat.scroll::-webkit-scrollbar { display: none; }
  .fc { min-width: 0; display: flex; align-items: center; gap: 9px; height: 44px; padding: 0 10px; border: 0; border-radius: 11px; background: transparent; color: var(--text);
    box-shadow: inset 0 0 0 1px var(--st-line); font: inherit; font-size: 13px; font-weight: 500; text-align: left; cursor: pointer;
    transition: box-shadow var(--mo-micro) var(--ea-fade), background-color var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  @media (hover: hover) { .fc:hover:not(.on) { background: var(--st-hover); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 22%, transparent); } }
  .fc:active { transform: scale(.96); }
  .fc.on { background: var(--st-sel); box-shadow: inset 0 0 0 1.5px var(--text); }
  .fc:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .fn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .narrow .fc { height: 52px; border-radius: 14px; background: var(--st-surface); box-shadow: none; font-size: 14px; }
  .narrow .fc.on { background: var(--st-sel); box-shadow: inset 0 0 0 1.5px var(--text); }
  .first .fl { margin-top: 16px; }
  .first .feat + .fl { margin-top: 0; }
  .acts { display: flex; justify-content: flex-end; margin-top: 18px; }
  .go { height: 38px; min-width: 120px; }
  .narrow .acts { margin-top: 20px; }
  .narrow .go { width: 100%; height: 46px; border-radius: 14px; font-size: 16px; }

  .err { margin: 10px 2px 0; font-size: 13px; line-height: 1.5; color: var(--pm-red); overflow-wrap: anywhere; }
  .warn { margin: 8px 2px 0; font-size: 12.5px; line-height: 1.5; color: var(--st-muted); overflow-wrap: anywhere; }

  .skel { margin-top: 22px; }
  .sk { position: relative; display: flex; align-items: center; gap: 12px; height: 48px; padding: 0 14px; overflow: hidden; }
  .sk .b { display: block; flex: none; height: 12px; border-radius: 6px; background: var(--st-seg); }
  .sk .cbk { width: 18px; height: 18px; border-radius: 5px; }
  .sk .lgk { width: 22px; height: 22px; border-radius: 50%; }
  .sk .txk { flex: 0 1 var(--w); }
  .sk::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--text) 6%, transparent), transparent);
    animation: hs-shimmer 1.4s var(--ea-std) infinite; }
  @keyframes hs-shimmer { to { transform: translateX(100%); } }

  /* —— 连接面板（草稿 / 已有服务）：一张分组卡 —— */
  .card { display: flex; flex-direction: column; gap: 16px; padding: 18px 20px 16px; border-radius: 14px; box-shadow: inset 0 0 0 1px var(--st-line); }
  .card.narrow { padding: 16px; border-radius: 18px; background: var(--st-surface); box-shadow: none; gap: 14px; }
  .grid2 { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 14px; }
  .narrow .grid2 { grid-template-columns: minmax(0, 1fr); }
  .fld { min-width: 0; }

  .keys { display: flex; flex-direction: column; gap: 6px; }
  .kh { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 34px; }
  .kh .fl { margin: 0 0 0 2px; }
  .strat { width: 200px; flex: none; }
  .narrow .strat { width: 180px; }
  .lines { display: flex; flex-direction: column; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--st-line); }
  .narrow .lines { box-shadow: none; background: var(--st-field); }
  .ln { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 5px 8px 5px 12px; }
  .ln + .ln, .lres + .ln { box-shadow: inset 0 1px 0 var(--st-hair); }
  .ln.off .lbl, .ln.off .tail { opacity: .55; }
  .lbl { flex: 1 1 120px; min-width: 60px; height: 32px; padding: 0 8px; margin-left: -8px; border: 0; border-radius: 8px; background: transparent; color: var(--text);
    font: inherit; font-size: 13.5px; font-weight: 500; outline: none; transition: background-color var(--mo-micro) var(--ea-fade), box-shadow var(--mo-micro) var(--ea-fade); }
  @media (hover: hover) { .lbl:hover { background: var(--st-hover); } }
  .lbl:focus { background: var(--st-field); box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 45%, transparent); }
  .lbl::placeholder { color: var(--st-muted); }
  .kin { flex: 2 1 180px; height: 34px; }
  .tail { font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 12.5px; color: var(--st-text2); white-space: nowrap; }
  .tail.none { font-family: inherit; color: var(--pm-warn); }
  .lres { display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 0 12px 8px; margin-top: -4px; font-size: 12.5px; color: var(--st-muted);
    font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .lres.ok { color: var(--st-text2); }
  .lres.bad { color: var(--pm-red); }
  /* 窄屏第二行：尾号 · 更换 · 开关（64 宽）· 测试 · 移除——间距收一点，英文界面也排得进一行 */
  .narrow .ln { flex-wrap: wrap; padding: 6px 6px 6px 12px; gap: 6px; row-gap: 2px; }
  .narrow .lbl { flex: 1 1 100%; order: -1; height: 40px; font-size: 16px; }
  .narrow .kin { flex: 1 1 100%; height: 44px; }
  .narrow .ln .tbtn { padding: 0 8px; }

  /* 开关：宽屏一行内联的「标签 + 开关」对——标签贴着自己的开关（点标签也能拨），不用隔着整张卡去对；
     窄屏一行一个、开关靠右（iOS 列表的习惯） */
  .sws { display: flex; flex-wrap: wrap; gap: 4px 36px; }
  .sw { display: flex; align-items: center; gap: 12px; min-height: 36px; cursor: pointer; }
  .swl { font-size: 13.5px; color: var(--text); user-select: none; -webkit-user-select: none; }
  .narrow .sws { flex-direction: column; flex-wrap: nowrap; gap: 0; }
  .narrow .sw { justify-content: space-between; min-height: 44px; cursor: default; }
  .narrow .swl { font-size: 15px; }

  .foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 2px; }
  .hint { font-size: 12.5px; color: var(--st-muted); }
  .spx { flex: 1; }
  /* 宽屏的「放弃 / 保存连接」：一直占着位置，没改动时看不见也点不到（inert）；只过渡 opacity，卡片高度不变 */
  .sv { display: flex; gap: 10px; opacity: 0; visibility: hidden;
    transition: opacity var(--mo-micro) var(--ea-fade), visibility 0s linear var(--mo-micro); }
  .sv.show { opacity: 1; visibility: visible; transition: opacity var(--mo-micro) var(--ea-fade), visibility 0s; }
  .savebar { display: flex; justify-content: flex-end; gap: 10px; padding-top: 12px; box-shadow: inset 0 1px 0 var(--st-hair); }
  .narrow .savebar .btn { flex: 1 1 0; }

  /* —— 按钮 —— */
  .btn { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 34px; padding: 0 14px; border: 0; border-radius: 10px;
    background: transparent; color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line); font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: transform var(--mo-tap) var(--ea-std), background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade),
      opacity var(--mo-micro) var(--ea-fade); }
  .btn :global(svg) { width: 15px; height: 15px; }
  @media (hover: hover) { .btn:hover:not(:disabled) { background: var(--st-hover); } }
  .btn:active:not(:disabled) { transform: scale(.96); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); box-shadow: none; font-weight: 600; }
  @media (hover: hover) { .btn.primary:hover:not(:disabled) { background: var(--st-primary); opacity: .88; } }
  /* 点不了的主按钮：中性底 + 次要字（不是把墨色调淡——那样在暗色里是一块发浑的褐色，反而最抢眼）；能点了由灰转墨 */
  .btn.primary:disabled { opacity: 1; background: var(--st-seg); color: var(--st-muted); }
  /* 进行中不算禁用：转圈的时候按钮还是原来的颜色，只略淡 */
  .btn.busy:disabled { opacity: .72; }
  .btn.primary.busy:disabled { background: var(--st-primary); color: var(--st-primary-ink); }
  .btn.primary:focus-visible { box-shadow: 0 0 0 2px var(--st-surface), 0 0 0 4px var(--text); }
  .narrow .btn { height: 44px; border-radius: 13px; font-size: 15px; padding: 0 16px; }
  .tbtn { flex: none; display: inline-flex; align-items: center; height: 30px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: var(--text);
    font: inherit; font-size: 12.5px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  @media (hover: hover) { .tbtn:hover:not(:disabled) { background: var(--st-hover); } }
  .tbtn:active:not(:disabled) { transform: scale(.96); }
  .tbtn:disabled { opacity: .4; cursor: default; }
  .tbtn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .tbtn.danger { color: var(--pm-red); }
  .tbtn.sm { height: 26px; padding: 0 6px; }
  .narrow .tbtn { height: 44px; padding: 0 10px; font-size: 14px; }
  .narrow .tbtn.sm { height: 44px; }
  .ib { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--st-muted); cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  .ib :global(svg) { width: 16px; height: 16px; }
  @media (hover: hover) { .ib:hover:not(:disabled) { background: var(--st-hover); color: var(--pm-red); } }
  .ib:active:not(:disabled) { transform: scale(.96); }
  .ib:disabled { opacity: .3; cursor: default; }
  .ib:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .narrow .ib { width: 44px; height: 44px; border-radius: 12px; }
  .add { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px 0 8px; border: 0; border-radius: 8px; background: transparent;
    color: var(--st-text2); font: inherit; font-size: 13px; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  .add :global(svg) { width: 15px; height: 15px; }
  @media (hover: hover) { .add:hover:not(:disabled) { background: var(--st-hover); color: var(--text); } }
  .add:active:not(:disabled) { transform: scale(.96); }
  .add:disabled { opacity: .4; cursor: default; }
  .add:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .narrow .add { height: 44px; font-size: 14.5px; }

  @media (prefers-reduced-motion: reduce) {
    .sk::after { animation: none; }
    .fc:active, .btn:active:not(:disabled), .tbtn:active:not(:disabled), .ib:active:not(:disabled), .add:active:not(:disabled) { transform: none; }
  }
</style>
