<script>
  // 设置 › Codex（桌面壳）的正文：头图与「启用」开关在 AgentSection 里画，这里从号池往下。
  // 管理员：号池与自动换号、新对话默认（照官方「配置」页）、成员的默认档、实验性质功能、个性化、运行、外观、已归档的对话、扩展；
  // 成员：自己的默认档、外观与已归档的对话。外观（吉祥物 / 提示音 / 震动）存在这台设备上，见 lib/codex/prefs.svelte.js。数据与动作全在 lib/codex/settings.svelte.js，文案与选项在 settings-logic.js。
  import { untrack } from 'svelte';
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import DSelect from '../kit/DSelect.svelte';
  import DSegmented from '../kit/DSegmented.svelte';
  import DButton from '../kit/DButton.svelte';
  import CodexPoolSection from './CodexPoolSection.svelte';
  import { codexPrefs, setCodexPref } from '../../lib/codex/prefs.svelte.js';
  import { chime } from '../../lib/codex/feedback.js';
  import { pets, loadPets, loadPetPreviews, petLabel, petPreviewStyle } from '../../components/settings/ios/codex/codex-pets.svelte.js';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { relTime } from '../../lib/format.js';
  import { SI } from '../../lib/settingsIcons.js';
  import { t, tc } from '../../lib/i18n.js';
  import { ags } from '../../lib/agentSettings.svelte.js';
  import {
    cx,
    loadCodexAll,
    saveCodexSettings,
    setBehavior,
    setApproval,
    approvalOf,
    behavior,
    unarchiveSession,
    deleteArchivedSession,
  } from '../../lib/codex/settings.svelte.js';
  import {
    approvalOptions,
    sandboxOptions,
    approvalLabel,
    sandboxLabel,
    webSearchOptions,
    verbosityOptions,
    summaryOptions,
    summaryValue,
    idleOptions,
    maxRunsOptions,
    cliSourceLabel,
  } from '../../lib/codex/settings-logic.js';

  const { fl = () => false, enabled = true, openExt } = $props();

  const svgOf = (name, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;

  // 进分区（且 Codex 开着）读一次：设置 + 号池 + 已归档的对话
  $effect(() => {
    if (enabled) untrack(() => loadCodexAll());
  });

  const ARCHIVED_FOLD = 8;
  let showAllArchived = $state(false);

  // 选项（选中项的说明放副标题）
  const adminApprovals = $derived(approvalOptions(cx.choices?.approvals));
  const adminSandboxes = $derived(sandboxOptions(cx.choices?.sandboxes));
  const memberApprovals = $derived(approvalOptions(cx.choices?.member?.approvals));
  const memberSandboxes = $derived(sandboxOptions(cx.choices?.member?.sandboxes));
  const adminPol = $derived(approvalOf('admin'));
  const memberPol = $derived(approvalOf('member'));
  const bh = $derived(behavior());
  const plain = (opts) => opts.map((o) => ({ value: o.value, label: o.label }));

  // behavior / settings 两个错误区由几组共用：记下最后一次是哪组改的，错误显示在那一组下面
  let behaviorFrom = $state('defaults');
  let settingsFrom = $state('member');
  const saveBehavior = (from, key, v) => { behaviorFrom = from; return setBehavior(key, v); };
  const saveSettings = (from, patch) => { settingsFrom = from; return saveCodexSettings(patch); };

  // 自定义指令：失焦或 Ctrl+Enter 保存，值没变不存
  const instructions = $derived(String(bh.instructions ?? ''));
  function saveInstructions(text) {
    const v = String(text ?? '');
    if (v === instructions) return;
    saveBehavior('personal', 'instructions', v);
  }

  // 外观：先只问有哪些角色；开了吉祥物、角色选择露出来才去取精灵图
  $effect(() => { if (enabled) untrack(() => loadPets()); });
  $effect(() => { if (enabled && codexPrefs.pet && pets.available.length) untrack(() => loadPetPreviews()); });
  const noPets = $derived(pets.loaded && !pets.available.length);

  const archivedShown = $derived(showAllArchived ? cx.archived : cx.archived.slice(0, ARCHIVED_FOLD));

  async function askDeleteArchived(s) {
    const ok = await uiConfirm(t('删除对话「{name}」？', { name: s.title || t('未命名对话') }), {
      detail: t('删除后无法恢复。'),
      okLabel: t('删除'),
      danger: true,
    });
    if (ok) await deleteArchivedSession(s.id);
  }
</script>

{#snippet archivedGroup()}
  <DGroup label={t('已归档的对话')}>
    <div class:hl-line={fl('cx-archived')}>
      {#if !cx.archivedLoaded}
        <div class="drow cr"><span class="cr-tx"><span class="cr-s">{t('读取中…')}</span></span></div>
      {:else if !cx.archived.length}
        <div class="drow cr"><span class="cr-tx"><span class="cr-s">{t('没有已归档的对话')}</span></span></div>
      {:else}
        {#each archivedShown as s (s.id)}
          {@const busy = cx.busy === 'archived:' + s.id}
          <div class="drow cr arow">
            <span class="cr-tx">
              <span class="cr-t"><span class="ell">{s.title || t('未命名对话')}</span></span>
              <span class="cr-s">{[s.projectName, s.mtime ? relTime(s.mtime) : ''].filter(Boolean).join(' · ')}</span>
            </span>
            <span class="cr-tr">
              <DButton size="sm" disabled={busy} onclick={() => unarchiveSession(s.id)}>{t('恢复')}</DButton>
              <button type="button" class="ico-btn danger" disabled={busy} onclick={() => askDeleteArchived(s)} title={t('删除')} aria-label={t('删除')}>{@html svgOf('trash', 1.7)}</button>
            </span>
          </div>
        {/each}
        {#if cx.archived.length > ARCHIVED_FOLD}
          <button type="button" class="drow addrow more" onclick={() => { showAllArchived = !showAllArchived; }}>
            {showAllArchived ? t('收起') : t('显示全部（{n}）', { n: cx.archived.length })}
          </button>
        {/if}
      {/if}
    </div>
  </DGroup>
  {#if cx.errors.archived}<p class="err">{cx.errors.archived}</p>{/if}
{/snippet}

{#snippet appearanceGroup()}
  <DGroup label={t('外观')}>
    <div class="drow cr" class:hl={fl('cx-pet')}>
      <span class="cr-tx">
        <span class="cr-t">{t('吉祥物')}</span>
      </span>
      <span class="cr-tr">
        <DSwitch checked={codexPrefs.pet && !noPets} disabled={noPets || !pets.loaded} onchange={(v) => setCodexPref('pet', v)} />
      </span>
    </div>
    {#if codexPrefs.pet && pets.available.length}
      <div class="drow cr ind pet-row">
        <div class="pets" role="radiogroup" aria-label={t('角色')}>
          {#each pets.available as name (name)}
            {@const on = codexPrefs.petName === name}
            <button type="button" class="pet" class:on role="radio" aria-checked={on} title={petLabel(name)} onclick={() => setCodexPref('petName', name)}>
              <span class="pet-img" style={petPreviewStyle(pets.previews[name])}></span>
              <span class="pet-nm">{petLabel(name)}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
    <div class="drow cr" class:hl={fl('cx-sound')}>
      <span class="cr-tx">
        <span class="cr-t">{t('完成提示音')}</span>
      </span>
      <span class="cr-tr">
        <DButton size="sm" onclick={() => chime({ force: true })}>{t('试听')}</DButton>
        <DSwitch checked={codexPrefs.sound} onchange={(v) => setCodexPref('sound', v)} />
      </span>
    </div>
    <div class="drow cr" class:hl={fl('cx-haptics')}>
      <span class="cr-tx">
        <span class="cr-t">{t('吐字震动')}</span>
      </span>
      <span class="cr-tr">
        <DSwitch checked={codexPrefs.haptics} onchange={(v) => setCodexPref('haptics', v)} />
      </span>
    </div>
  </DGroup>
{/snippet}

{#if !enabled}
  <!-- Codex 关着 / 这台机器跑不起来：原因在头图下 -->
{:else if cx.loading && !cx.loaded}
  <p class="note">{t('读取中…')}</p>
{:else if cx.admin}
  <!-- 1–2. 号池与撞上限额时 -->
  <CodexPoolSection {fl} />

  <!-- 3. 新对话默认（照官方「配置」页） -->
  <DGroup label={t('新对话默认')}>
    <div class="drow cr" class:hl={fl('cx-approval')}>
      <span class="cr-tx">
        <span class="cr-t">{t('批准策略')}</span>
      </span>
      <span class="cr-tr">
        <DSelect options={plain(adminApprovals)} value={adminPol.approvalPolicy} onchange={(v) => setApproval('admin', 'approvalPolicy', v)} width="180px" />
      </span>
    </div>
    <div class="drow cr" class:hl={fl('cx-sandbox')}>
      <span class="cr-tx">
        <span class="cr-t">{t('沙盒设置')}</span>
      </span>
      <span class="cr-tr">
        <DSelect options={plain(adminSandboxes)} value={adminPol.sandbox} onchange={(v) => setApproval('admin', 'sandbox', v)} width="180px" />
      </span>
    </div>
    <div class="drow cr ind" class:hl={fl('cx-network')}>
      <span class="cr-tx">
        <span class="cr-t">{t('允许网络访问')}</span>
      </span>
      <span class="cr-tr">
        <DSwitch checked={!!bh.networkAccess} onchange={(v) => saveBehavior('defaults', 'networkAccess', v)} />
      </span>
    </div>
    <div class="drow cr" class:hl={fl('cx-websearch')}>
      <span class="cr-tx">
        <span class="cr-t">{t('网页搜索')}</span>
        <!-- 选了具体档才说明它是什么；「默认」本身就是说明，不再配一句「跟随默认」 -->
      </span>
      <span class="cr-tr">
        <DSelect options={plain(webSearchOptions())} value={bh.webSearch || ''} onchange={(v) => saveBehavior('defaults', 'webSearch', v)} width="140px" />
      </span>
    </div>
    <div class="drow cr" class:hl={fl('cx-verbosity')}>
      <span class="cr-tx"><span class="cr-t">{t('输出详细程度')}</span></span>
      <span class="cr-tr">
        <DSegmented options={verbosityOptions()} value={bh.verbosity || ''} onchange={(v) => saveBehavior('defaults', 'verbosity', v)} />
      </span>
    </div>
    <div class="drow cr" class:hl={fl('cx-summary')}>
      <span class="cr-tx"><span class="cr-t">{t('推理摘要')}</span></span>
      <span class="cr-tr">
        <DSegmented options={summaryOptions()} value={summaryValue(bh.reasoningSummary)} onchange={(v) => saveBehavior('defaults', 'reasoningSummary', v)} />
      </span>
    </div>
  </DGroup>
  {#if cx.errors.approval}<p class="err">{cx.errors.approval}</p>{/if}
  {#if cx.errors.behavior && behaviorFrom === 'defaults'}<p class="err">{cx.errors.behavior}</p>{/if}

  <!-- 4. 成员的默认档（多用户版才有成员） -->
  {#if ags.multiUser}
    <DGroup label={t('成员的默认档')}>
      <div class="drow cr" class:hl={fl('cx-member')}>
        <span class="cr-tx">
          <span class="cr-t">{t('批准策略')}</span>
        </span>
        <span class="cr-tr">
          <DSelect options={plain(memberApprovals)} value={memberPol.approvalPolicy} onchange={(v) => setApproval('member', 'approvalPolicy', v)} width="180px" />
        </span>
      </div>
      <div class="drow cr" class:hl={fl('cx-member')}>
        <span class="cr-tx">
          <span class="cr-t">{t('沙盒设置')}</span>
        </span>
        <span class="cr-tr">
          <DSelect options={plain(memberSandboxes)} value={memberPol.sandbox} onchange={(v) => setApproval('member', 'sandbox', v)} width="180px" />
        </span>
      </div>
      <div class="drow cr" class:hl={fl('cx-maxruns')}>
        <span class="cr-tx"><span class="cr-t">{t('同时能跑几轮')}</span></span>
        <span class="cr-tr">
          <DSelect options={maxRunsOptions()} value={cx.settings?.memberMaxRuns} onchange={(v) => saveSettings('member', { memberMaxRuns: v })} width="120px" />
        </span>
      </div>
    </DGroup>
    {#if cx.errors.settings && settingsFrom === 'member'}<p class="err">{cx.errors.settings}</p>{/if}
  {/if}

  <!-- 5. 实验性质功能 -->
  <DGroup label={t('实验性质功能')}>
    <div class="drow cr" class:hl={fl('cx-ask')}>
      <span class="cr-tx">
        <span class="cr-t">{t('请求用户输入')}</span>
      </span>
      <span class="cr-tr">
        <DSwitch checked={bh.askUser !== false} onchange={(v) => saveBehavior('exp', 'askUser', v)} />
      </span>
    </div>
    <div class="drow cr" class:hl={fl('cx-goals')}>
      <span class="cr-tx">
        <span class="cr-t">{t('目标')}</span>
      </span>
      <span class="cr-tr">
        <DSwitch checked={!!cx.settings?.goalsEnabled} onchange={(v) => saveSettings('exp', { goalsEnabled: v })} />
      </span>
    </div>
  </DGroup>
  {#if cx.errors.behavior && behaviorFrom === 'exp'}<p class="err">{cx.errors.behavior}</p>{/if}
  {#if cx.errors.settings && settingsFrom === 'exp'}<p class="err">{cx.errors.settings}</p>{/if}

  <!-- 6. 个性化 -->
  <DGroup label={t('个性化')}>
    <div class="drow cr dsp" class:hl={fl('cx-instructions')}>
      <span class="cr-tx"><span class="cr-t">{t('自定义指令')}</span></span>
      <span class="cr-tr">
        {#if instructions}
          <button type="button" class="cr-reset" onclick={() => saveBehavior('personal', 'instructions', '')}>{t('清空')}</button>
        {/if}
      </span>
      <div class="dsp-box">
        {#key instructions}
          <textarea
            rows="4"
            maxlength={cx.choices?.instructionsMax || 8000}
            value={instructions}
            aria-label={t('自定义指令')}
            onblur={(e) => saveInstructions(e.currentTarget.value)}
            onkeydown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          ></textarea>
        {/key}
      </div>
    </div>
  </DGroup>
  {#if cx.errors.behavior && behaviorFrom === 'personal'}<p class="err">{cx.errors.behavior}</p>{/if}

  <!-- 7. 运行 -->
  <DGroup label={tc('settings', '运行')}>
    <div class="drow cr" class:hl={fl('cx-idle')}>
      <span class="cr-tx">
        <span class="cr-t">{t('空闲多久停掉进程')}</span>
      </span>
      <span class="cr-tr">
        <DSelect options={idleOptions()} value={cx.settings?.idleStopMinutes} onchange={(v) => saveSettings('run', { idleStopMinutes: v })} width="120px" />
      </span>
    </div>
    <div class="drow cr" class:hl={fl('cx-cli')}>
      <span class="cr-tx">
        <span class="cr-t">
          {t('Codex 程序')}
          {#if cx.cli?.version}<span class="pill">v{String(cx.cli.version).replace(/^v/i, '')}</span>{/if}
          {#if cx.cli?.source && cliSourceLabel(cx.cli.source)}<span class="pill">{cliSourceLabel(cx.cli.source)}</span>{/if}
        </span>
        <span class="cr-s mono sel-text">{cx.cli?.file || cx.cli?.command || '—'}</span>
      </span>
    </div>
  </DGroup>
  {#if cx.errors.settings && settingsFrom === 'run'}<p class="err">{cx.errors.settings}</p>{/if}

  <!-- 8. 外观（存在这台设备上） -->
  {@render appearanceGroup()}

  <!-- 9. 已归档的对话 -->
  {@render archivedGroup()}

  <!-- 10. 扩展：Codex 用的是 bridge 扩展中心装的技能和连接器 -->
  <DGroup label={t('扩展')}>
    <DRow title={t('技能')} highlight={fl('cx-ext')} onclick={() => openExt?.('skill')} />
    <DRow title={t('连接器')} highlight={fl('cx-ext')} onclick={() => openExt?.('connector')} />
  </DGroup>
{:else}
  <!-- 成员：自己的默认档（只读）与已归档的对话 -->
  <DGroup label={t('你的默认档')}>
    <DRow title={t('批准策略')} highlight={fl('cx-approval')}>
      {#snippet trailing()}<span class="num">{approvalLabel(cx.effective?.approvalPolicy)}</span>{/snippet}
    </DRow>
    <DRow title={t('沙盒设置')} highlight={fl('cx-sandbox')}>
      {#snippet trailing()}<span class="num">{sandboxLabel(cx.effective?.sandbox)}</span>{/snippet}
    </DRow>
    {#if cx.effective?.maxRuns}
      <DRow title={t('同时能跑')} highlight={fl('cx-maxruns')}>
        {#snippet trailing()}<span class="num">{t('{n} 轮', { n: cx.effective.maxRuns })}</span>{/snippet}
      </DRow>
    {/if}
  </DGroup>
  {#if cx.errors.settings}<p class="err">{cx.errors.settings}</p>{/if}

  {@render appearanceGroup()}
  {@render archivedGroup()}
{/if}

<style>
  @import './kit.css';
  .cr.dsp { flex-wrap: wrap; align-items: flex-start; row-gap: 8px; padding-bottom: 12px; }
  .cr-tx { gap: 3px; }
  .cr-t { flex-wrap: wrap; }
  .cr-s.mono { font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace); font-size: 12px; overflow-wrap: anywhere; }
  .ell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .arow .cr-t { flex-wrap: nowrap; }
  .more { justify-content: center; font-size: var(--dsk-fs-ui); }
  .dsp-box { position: relative; flex: 1 0 100%; }
  .dsp-box textarea {
    display: block;
    width: 100%;
    box-sizing: border-box;
    min-height: 84px;
    max-height: 260px;
    resize: vertical;
    padding: 8px 10px;
    border: none;
    border-radius: var(--dsk-r-sm);
    background: var(--dsk-panel);
    box-shadow: 0 0 0 1px var(--dsk-line);
    font-family: var(--dsk-font);
    font-size: var(--dsk-fs-ui);
    line-height: 1.5;
    color: var(--dsk-ink);
  }
  .pet-row { padding-top: 2px; padding-bottom: 12px; }
  .pets { display: flex; flex-wrap: wrap; gap: 6px; }
  .pet {
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    width: 64px; padding: 6px 4px 5px; border-radius: var(--dsk-r-sm);
    font-family: inherit; color: var(--dsk-ink-2);
    transition: background var(--dsk-t-fast) var(--dsk-ease), box-shadow var(--dsk-t-fast) var(--dsk-ease);
  }
  .pet:hover { background: var(--dsk-hover); }
  .pet:focus-visible { outline: none; box-shadow: var(--dsk-focus); }
  .pet.on { background: var(--dsk-sel); box-shadow: inset 0 0 0 1px var(--dsk-line-strong); color: var(--dsk-ink); }
  /* 一帧 192×208：按原比例缩到 44 宽 */
  .pet-img { display: block; width: 44px; height: 48px; image-rendering: auto; }
  .pet-nm { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--dsk-fs-sm); line-height: 1.2; }
  .dsp-box textarea:focus { outline: none; box-shadow: var(--dsk-focus); background: var(--dsk-panel-strong); }
</style>
