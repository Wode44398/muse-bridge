<script>
  // 设置 › dimensio（桌面壳）：照 Claude 分区的版式分组——模型 / 模型服务 / 本机模型 / 权限与安全 / 规则 / 工作空间 /
  // 记忆 / 偏好注册表各组 / 诊断，最底下一行安静的版本。数据面 lib/dimensioSettings.svelte.js（手机 Settings 共用）。
  // 自定义模型服务、记忆、本机模型的启动参数不在这里另做编辑器：点进去关掉设置、在 dimensio 页里打开它自己的面板。
  // dimensio 关着 / 起不来时只出一行原因与「重试」；成员身份只出他能改的（本机模型只给管理员，访问范围被锁时只读）。
  import { untrack } from 'svelte';
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import DSegmented from '../kit/DSegmented.svelte';
  import DSelect from '../kit/DSelect.svelte';
  import DButton from '../kit/DButton.svelte';
  import DField from '../kit/DField.svelte';
  import ProjectPicker from '../../components/ProjectPicker.svelte';
  import { hasNativePickDirectory, nativePickDirectory } from '../../lib/nativeDesktop.js';
  import { SI } from '../../lib/settingsIcons.js';
  import { t } from '../../lib/i18n.js';
  import { hub, hubSummaryText } from '../../lib/modelHub.svelte.js';
  import { openSettings } from '../../lib/settingsNav.svelte.js';
  import {
    ds, loadDimensio, dimReady, errOf, setErr, hasCap,
    providerOptions, modelOptions, effortOptions, fastOk, setProvider, setModel, setThinking, setFast,
    keyVendors, canSetKey, setVendorKey, customSummary,
    LOCAL_ENGINES, localOk, localLine,
    MODES, ACCESS, accessLocked, setMode, setAccess, rulesOf, addRules, removeRule,
    setWorkspace,
    memoryOk, memLine,
    prefGroups, prefItems, prefGroupLabel, prefLabel, prefDesc, prefOptions, prefChanged, setPref, parsePrefNumber,
    sessionTitle, exportDiag, versionLine, openInDimensio,
    feed, setFeedDetail, FEED_DESC,
  } from '../../lib/dimensioSettings.svelte.js';

  // fl：设置搜索跳转后的高亮；enabled：管理员视角下 dimensio 开着且跑得起来（成员能看到这一分区就是有权限，恒 true）；
  // openHub：「模型中心」行点了去哪——外壳传自己的换分区（带 ‹ › 历史），没传走通用的直达分区
  let { fl = () => false, enabled = true, openHub = () => openSettings('model-hub') } = $props();

  // 进分区（或刚被打开）才拉：拉 /api/harness 会把没在跑的 harness 拉起来
  $effect(() => { if (enabled) untrack(() => loadDimensio({ quiet: true })); });

  const svgOf = (name, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;
  const cfg = $derived(ds.config);
  const vendorOpts = $derived(providerOptions().map((o) => ({ value: o.value, label: o.desc ? o.label + ' · ' + o.desc : o.label })));
  const efforts = $derived(effortOptions());
  const modeDesc = $derived(MODES().find((m) => m.value === cfg?.permissionMode)?.desc || '');
  const accessDesc = $derived(ACCESS().find((m) => m.value === cfg?.access)?.desc || '');

  // —— API Key：一次只开一家的输入框；保存成功收起 ——
  let keyFor = $state('');
  let keyDraft = $state('');
  function openKey(id) { keyFor = id; keyDraft = ''; setErr('', ''); }
  async function saveKey(e) {
    e?.preventDefault?.();
    if (!keyFor || !keyDraft.trim()) return;
    if (await setVendorKey(keyFor, keyDraft)) { keyFor = ''; keyDraft = ''; }
  }

  // —— 规则：每组一个添加框 ——
  let ruleDraft = $state({ ask: '', deny: '' });
  async function addRule(kind, e) {
    e?.preventDefault?.();
    if (await addRules(kind, ruleDraft[kind])) ruleDraft[kind] = '';
  }

  // —— 工作空间：本机桌面壳用系统文件夹选择器，其余开 bridge 的工作空间选择器；也可以直接改路径 ——
  let picking = $state(false);
  async function pickWs() {
    if (hasNativePickDirectory()) { const p = await nativePickDirectory(cfg?.workspace || ''); if (p) await setWorkspace(p); return; }
    picking = true;
  }
  function typedWs(v) { const p = String(v || '').trim(); if (p && p !== cfg?.workspace) setWorkspace(p); }

  // —— 偏好：数字失焦 / 回车保存；多行文本失焦保存（Ctrl+Enter 也行）——
  function saveNum(p, raw) {
    const r = parsePrefNumber(p, raw);
    if (r.err) { setErr('pref:' + p.key, r.err); return; }
    if (r.v === null ? prefChanged(p) : r.v !== p.value) setPref(p.key, r.v);
  }
  function saveText(p, v) {
    const s = String(v ?? '');
    if (s === p.value) return;
    setPref(p.key, s === p.default ? null : s);
  }

  // —— 诊断：默认最近的那个对话 ——
  let diagId = $state('');
  $effect(() => { const first = ds.sessions[0]?.id || ''; if (!ds.sessions.some((s) => s.id === diagId)) untrack(() => { diagId = first; }); });
  const sessOpts = $derived(ds.sessions.map((s) => ({ value: s.id, label: sessionTitle(s) })));
</script>

{#snippet bad(tag)}{#if errOf(tag)}<span class="cr-s bad">{errOf(tag)}</span>{/if}{/snippet}

{#snippet feedRow()}
  <div class="drow cr" class:hl={fl('dm-feed')}>
    <span class="cr-tx"><span class="cr-t">{t('显示全部工作过程')}</span><span class="cr-s">{FEED_DESC()}</span></span>
    <span class="cr-tr"><DSwitch checked={feed.detail} onchange={(v) => setFeedDetail(v)} /></span>
  </div>
{/snippet}

{#snippet prow(p)}
  {@const tag = 'pref:' + p.key}
  <div class="drow cr" class:dsp={p.type === 'text'} class:hl={fl('dp-' + p.key)}>
    <span class="cr-tx">
      <span class="cr-t">{prefLabel(p)}{#if prefChanged(p)}<i class="chg" title={t('已改过默认值')}></i>{/if}</span>
      {#if errOf(tag)}<span class="cr-s bad">{errOf(tag)}</span>{:else if prefDesc(p)}<span class="cr-s">{prefDesc(p)}</span>{/if}
    </span>
    <span class="cr-tr">
      {#if prefChanged(p)}<button class="cr-reset" aria-label={t('将「{label}」恢复默认', { label: prefLabel(p) })} onclick={() => setPref(p.key, null)}>{t('恢复默认')}</button>{/if}
      {#if p.type === 'bool'}
        <DSwitch checked={!!p.value} onchange={(v) => setPref(p.key, v)} />
      {:else if p.type === 'enum'}
        <DSelect options={prefOptions(p)} value={p.value} onchange={(v) => setPref(p.key, v)} width="170px" />
      {:else if p.type === 'number'}
        {#key p.value}<DField value={String(p.value ?? '')} width="96px" onchange={(v) => saveNum(p, v)} />{/key}
      {/if}
    </span>
    {#if p.type === 'text'}
      <div class="dsp-box">
        {#key p.value}
          <textarea rows="3" maxlength={p.maxLen || 4000} value={String(p.value ?? '')}
            onblur={(e) => saveText(p, e.currentTarget.value)}
            onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.blur(); } }}></textarea>
        {/key}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet rules(kind, label, placeholder, foot)}
  <DGroup {label} {foot}>
    {#each rulesOf(kind) as r (r)}
      <div class="drow cr">
        <span class="cr-tx"><span class="cr-t mono">{r}</span></span>
        <span class="cr-tr"><button class="ico-btn danger" disabled={ds.busy === 'rules:' + kind} onclick={() => removeRule(kind, r)} title={t('删除规则 {rule}', { rule: r })} aria-label={t('删除规则 {rule}', { rule: r })}>{@html svgOf('trash', 1.7)}</button></span>
      </div>
    {/each}
    <form class="drow cr" class:hl={fl('dm-' + kind)} onsubmit={(e) => addRule(kind, e)}>
      <span class="cr-tx"><DField bind:value={ruleDraft[kind]} {placeholder} width="100%" />{@render bad('rules:' + kind)}</span>
      <span class="cr-tr"><DButton type="submit" size="sm" disabled={!ruleDraft[kind].trim() || ds.busy === 'rules:' + kind}>{t('添加')}</DButton></span>
    </form>
  </DGroup>
{/snippet}

{#if !enabled}
  <!-- 开关关着 / 跑不起来：原因已在头图下，这里不再打 harness -->
{:else if ds.phase === 'down'}
  <DGroup>
    <DRow title={t('dimensio 的设置暂时读不到')} sub={ds.why}>
      {#snippet trailing()}<DButton size="sm" onclick={() => loadDimensio()}>{t('重试')}</DButton>{/snippet}
    </DRow>
  </DGroup>
{:else if !dimReady()}
  <p class="note">{t('读取中…')}</p>
{:else}
  <!-- 模型：新会话的默认（对话里随时可在输入框的型号胶囊改） -->
  <DGroup label={t('模型')} foot={t('新对话默认用这里的模型；对话里随时可以在输入框的型号胶囊改。')}>
    <div class="drow cr" class:hl={fl('dm-provider')}>
      <span class="cr-tx"><span class="cr-t">{t('模型服务')}</span>{@render bad('provider')}</span>
      <span class="cr-tr"><DSelect options={vendorOpts} value={cfg.provider} disabled={ds.busy === 'provider'} onchange={setProvider} width="220px" /></span>
    </div>
    {#if modelOptions().length}
      <div class="drow cr" class:hl={fl('dm-model')}>
        <span class="cr-tx"><span class="cr-t">{t('型号')}</span>{@render bad('model')}</span>
        <span class="cr-tr"><DSelect options={modelOptions()} value={cfg.model} disabled={ds.busy === 'model'} onchange={setModel} width="220px" /></span>
      </div>
    {/if}
    {#if efforts.length > 1}
      <div class="drow cr" class:hl={fl('dm-effort')}>
        <span class="cr-tx"><span class="cr-t">{t('思考深度')}</span>{@render bad('thinking')}</span>
        <span class="cr-tr"><DSelect options={efforts} value={cfg.thinking} disabled={ds.busy === 'thinking'} onchange={setThinking} width="140px" /></span>
      </div>
    {/if}
    {#if fastOk()}
      <div class="drow cr" class:hl={fl('dm-fast')}>
        <span class="cr-tx"><span class="cr-t">Fast mode</span><span class="cr-s">{t('输出更快，按更高单价计费')}</span>{@render bad('fast')}</span>
        <span class="cr-tr"><DSwitch checked={cfg.fast === true} disabled={ds.busy === 'fast'} onchange={setFast} /></span>
      </div>
    {/if}
  </DGroup>

  <!-- 各厂商 API Key + 自定义服务入口（编辑器在 dimensio 的模型服务面板里，这里只放摘要） -->
  <DGroup label={keyVendors().length ? t('API Key') : t('模型服务')} foot={keyVendors().length ? t('Key 加密存在服务端，重启不丢，不回传浏览器。') : t('dimensio 能用的模型都在模型中心里添加和修改。')}>
    {#each keyVendors() as v, i (v.id)}
      <div class="drow cr" class:hl={i === 0 && fl('dm-keys')}>
        <span class="cr-tx">
          <span class="cr-t">{v.name}{#if v.current}<span class="pill">{t('默认')}</span>{/if}</span>
          {@render bad('key:' + v.id)}
        </span>
        <span class="cr-tr">
          {#if keyFor === v.id}
            <form class="kform" onsubmit={saveKey}>
              <DField type="password" bind:value={keyDraft} placeholder={t('粘贴 {name} API Key', { name: v.name })} width="230px" />
              <DButton type="submit" size="sm" variant="primary" disabled={!keyDraft.trim() || ds.busy === 'key:' + v.id}>{ds.busy === 'key:' + v.id ? t('保存中…') : t('保存')}</DButton>
              <DButton size="sm" variant="ghost" onclick={() => { keyFor = ''; }}>{t('取消')}</DButton>
            </form>
          {:else}
            <span class="kst" class:warn={!v.hasKey}>{v.hasKey ? t('已配 Key') : t('缺 Key')}</span>
            {#if canSetKey(v.id)}<DButton size="sm" onclick={() => openKey(v.id)}>{v.hasKey ? t('更换') : t('填写')}</DButton>{/if}
          {/if}
        </span>
      </div>
    {/each}
    <!-- 管理员有模型中心总览：自定义服务都在 设置 › 模型中心 管（就在本设置页里换分区）；成员 / 老服务端照旧去 dimensio 自己的面板 -->
    <DRow title={hub.ok ? t('模型中心') : t('自定义模型服务')} sub={hub.ok ? hubSummaryText() : customSummary()} highlight={fl('dm-custom')} onclick={() => { if (hub.ok) openHub(); else openInDimensio('vendors'); }} />
  </DGroup>

  {#if localOk()}
    <DGroup label={t('本机模型')} foot={t('启动参数（上下文、缓存精度、识图……）与启停在 dimensio 的本机模型面板里改。')}>
      {#each LOCAL_ENGINES as e, i (e.id)}
        <DRow title={e.name} sub={localLine(e.id)} highlight={i === 0 && fl('dm-local')} onclick={() => openInDimensio('local:' + e.id)} />
      {/each}
    </DGroup>
  {/if}

  <!-- 权限与安全：新会话的默认档位与访问范围（单个对话在输入框的档位胶囊里切） -->
  <DGroup label={t('权限与安全')} foot={t('新会话的默认；单个对话随时可在输入框的档位胶囊里切，对当前会话立刻生效。')}>
    <div class="drow cr" class:hl={fl('dm-mode')}>
      <span class="cr-tx"><span class="cr-t">{t('默认运行档位')}</span>{#if errOf('mode')}{@render bad('mode')}{:else}<span class="cr-s">{modeDesc}</span>{/if}</span>
      <span class="cr-tr"><DSegmented options={MODES()} value={cfg.permissionMode} disabled={ds.busy === 'mode'} onchange={setMode} /></span>
    </div>
    <div class="drow cr" class:hl={fl('dm-access')}>
      <span class="cr-tx"><span class="cr-t">{t('访问范围')}</span>{#if errOf('access')}{@render bad('access')}{:else}<span class="cr-s">{accessLocked() ? t('这台服务器把访问范围锁定了，改不了。') : accessDesc}</span>{/if}</span>
      <span class="cr-tr">
        {#if accessLocked()}
          <span class="num">{ACCESS().find((m) => m.value === cfg.access)?.label || cfg.access}</span>
        {:else}
          <DSegmented options={ACCESS()} value={cfg.access} disabled={ds.busy === 'access'} onchange={setAccess} />
        {/if}
      </span>
    </div>
  </DGroup>

  {@render rules('ask', t('每次问我'), t('添加规则，如 Bash(git push:*)'), '')}
  {@render rules('deny', t('从不允许'), t('添加规则，如 Bash(rm -rf:*)'), t('规则匹配命令或路径的前缀，是防误操作的软闸，不是安全沙箱。保存后所有会话下一次调用就按新规则判，重启也不丢。'))}

  <DGroup label={t('工作空间')} foot={t('新对话从这个文件夹开始，已经开着的对话不受影响。')}>
    <div class="drow cr" class:hl={fl('dm-ws')}>
      <span class="cr-tx">
        {#key cfg.workspace}<DField value={cfg.workspace || ''} width="100%" onchange={typedWs} />{/key}
        {@render bad('workspace')}
      </span>
      <span class="cr-tr"><DButton size="sm" disabled={ds.busy === 'workspace'} onclick={pickWs}>{t('选择…')}</DButton></span>
    </div>
  </DGroup>

  {#if memoryOk()}
    <DGroup label={t('记忆')}>
      <DRow title={t('记忆管理')} sub={memLine()} highlight={fl('dm-mem')} onclick={() => openInDimensio('memory')}>
        {#snippet trailing()}{#if ds.mem?.waiting}<span class="pill">{t('{n} 条待处理', { n: ds.mem.waiting })}</span>{/if}{/snippet}
      </DRow>
    </DGroup>
  {/if}

  <!-- 偏好注册表：各功能登记的项按分组通用渲染（bool 开关 / enum 下拉 / number 数字 / text 多行） -->
  {#each prefGroups() as g (g.id)}
    <DGroup label={prefGroupLabel(g)}>
      {#if g.id === 'chat'}{@render feedRow()}{/if}
      {#each prefItems(g.id) as p (p.key)}{@render prow(p)}{/each}
    </DGroup>
  {/each}

  {#if hasCap('diagnostics') && ds.sessions.length}
    <DGroup label={t('诊断')} foot={t('卡住了、变慢了、报错了，导出这个包发给维护的人：里面是这一轮的事件记录、服务输出、体检结果与版本信息，不含对话正文和任何 key。')}>
      <div class="drow cr" class:hl={fl('dm-diag')}>
        <span class="cr-tx"><span class="cr-t">{t('导出诊断包')}</span>{#if errOf('diag')}{@render bad('diag')}{:else if ds.diagMsg}<span class="cr-s">{ds.diagMsg}</span>{/if}</span>
        <span class="cr-tr">
          <DSelect options={sessOpts} value={diagId} onchange={(v) => { diagId = v; }} width="200px" />
          <DButton size="sm" disabled={!diagId || ds.busy === 'diag'} onclick={() => exportDiag(diagId)}>{ds.busy === 'diag' ? t('生成中…') : t('导出')}</DButton>
        </span>
      </div>
    </DGroup>
  {/if}

  <p class="ver">{versionLine()}</p>
{/if}

{#if picking}
  <ProjectPicker title={t('选择工作空间')} hint={t('把文件夹拖进底栏，它就是 dimensio 新对话的工作空间')} preferPath={cfg?.workspace || ''}
    onPick={async (p) => { picking = false; if (p) await setWorkspace(p); }} onClose={() => { picking = false; }} />
{/if}

<style>
  /* 行的骨架同 Claude 分区的 crow（SettingsDesktop 里那套是 scoped，这里各写一份） */
  .cr { display: flex; align-items: center; gap: var(--dsk-s3); width: 100%; position: relative; font-family: var(--dsk-font); color: var(--dsk-ink); }
  .cr.dsp { flex-wrap: wrap; align-items: flex-start; row-gap: 8px; padding-bottom: 12px; }
  .cr-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .cr-t { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: var(--dsk-fs-body); line-height: 1.35; }
  .cr-t.mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12.5px; overflow-wrap: anywhere; }
  .cr-s { font-size: var(--dsk-fs-sm); line-height: 1.35; color: var(--dsk-ink-3); }
  .cr-s.bad { color: var(--dsk-crit); }
  .cr-tr { flex: none; display: inline-flex; align-items: center; gap: var(--dsk-s2); color: var(--dsk-ink-2); font-size: var(--dsk-fs-ui); }
  .chg { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsk-accent); }
  .cr-reset { padding: 2px 7px; border-radius: 6px; font-family: inherit; font-size: var(--dsk-fs-sm); color: var(--dsk-ink-3);
    transition: background var(--dsk-t-fast) ease, color var(--dsk-t-fast) ease; }
  .cr-reset:hover { background: var(--dsk-hover); color: var(--dsk-ink); }
  .cr.hl { animation: dm-flash 1.5s var(--dsk-ease) 1; }
  @keyframes dm-flash { 0%, 70% { background: var(--dsk-sel); } 100% { background: transparent; } }
  .pill { padding: 0 6px; border-radius: 5px; font-size: 10.5px; line-height: 17px; font-weight: 600; letter-spacing: .3px; color: var(--dsk-ink-2); box-shadow: inset 0 0 0 1px var(--dsk-line-strong); }
  .num { color: var(--dsk-ink-3); }
  .kst { font-size: var(--dsk-fs-sm); color: var(--dsk-ink-3); }
  .kst.warn { color: var(--dsk-warn); }
  .kform { display: inline-flex; align-items: center; gap: 6px; margin: 0; }
  .dsp-box { position: relative; flex: 1 0 100%; }
  .dsp-box textarea { display: block; width: 100%; box-sizing: border-box; min-height: 72px; max-height: 260px; resize: vertical;
    padding: 8px 10px; border: none; border-radius: var(--dsk-r-sm); background: var(--dsk-panel); box-shadow: 0 0 0 1px var(--dsk-line);
    font-family: var(--dsk-font); font-size: var(--dsk-fs-ui); line-height: 1.5; color: var(--dsk-ink);
    transition: box-shadow var(--dsk-t-fast) var(--dsk-ease), background var(--dsk-t-fast) var(--dsk-ease); }
  .dsp-box textarea:hover:not(:focus) { background: var(--dsk-panel-strong); }
  .dsp-box textarea:focus { outline: none; box-shadow: var(--dsk-focus); background: var(--dsk-panel-strong); }
  .ico-btn { width: 26px; height: 26px; padding: 4px; border-radius: 7px; color: var(--dsk-ink-3); display: inline-flex; align-items: center; justify-content: center;
    transition: background var(--dsk-t-fast) ease, color var(--dsk-t-fast) ease; }
  .ico-btn :global(svg) { width: 17px; height: 17px; display: block; }
  .ico-btn:hover:not(:disabled) { background: var(--dsk-hover); color: var(--dsk-crit); }
  .ico-btn:disabled { opacity: .3; cursor: default; }
  .note { margin: 0 14px; font-size: var(--dsk-fs-sm); color: var(--dsk-ink-3); }
  .ver { margin: 4px 0 0; text-align: center; font-size: var(--dsk-fs-caption, 11px); color: var(--dsk-ink-3); font-variant-numeric: tabular-nums; user-select: text; }
</style>
