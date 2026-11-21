<script>
  // 设置 › Antigravity（桌面壳）：与 Claude / dimensio 分区同一套墨与象牙控件语言，
  // 覆盖账号与登出、新对话默认配置、权限与附加目录、系统提示追加、MCP/插件、外观、运行状态与隐藏会话恢复。
  import { untrack } from 'svelte';
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSegmented from '../kit/DSegmented.svelte';
  import DSelect from '../kit/DSelect.svelte';
  import DButton from '../kit/DButton.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import ProjectPicker from '../../components/ProjectPicker.svelte';
  import { hasNativePickDirectory, nativePickDirectory } from '../../lib/nativeDesktop.js';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { openPreview } from '../../lib/preview.svelte.js';
  import { fmtUptime } from '../../lib/settings/common.js';
  import { SI } from '../../lib/settingsIcons.js';
  import { t } from '../../lib/i18n.js';
  import { refreshAgySessions } from '../../lib/agy/store.svelte.js';
  import { modelDisplayName, modelSeriesOf } from '../../lib/agy/catalog.js';
  import {
    agyPrefs,
    loadAgySettingsAll,
    patchAgySettings,
    addAgyExtraDir,
    removeAgyExtraDir,
    resetAgySystemPrompt,
    restartAgyDaemon,
    checkAgyUpdate,
    restoreAllHiddenFromSettings,
    settingsModelCatalog,
    settingsThoughtCatalog,
    settingsModeCatalog,
    agyThemeOptions,
    agyFontSizeOptions,
    daemonStateText,
    agyDebugVisible,
    agyHostAdmin,
    agyDebugDesc,
  } from '../../lib/agy/settings.svelte.js';
  import AgyExtSection from './AgyExtSection.svelte';
  import AgyPoolSection from './AgyPoolSection.svelte';

  const { fl = () => false, enabled = true } = $props();

  const svgOf = (name, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;

  $effect(() => {
    if (enabled) untrack(() => loadAgySettingsAll({ probe: true }));
  });

  let pickingExtraDir = $state(false);
  let pickingDefaultProj = $state(false);

  const cfg = $derived(agyPrefs.settings);
  const st = $derived(agyPrefs.status);

  const modelCat = $derived(settingsModelCatalog());
  const thoughtCat = $derived(settingsThoughtCatalog(cfg.defaultModel));
  const modeCat = $derived(settingsModeCatalog());

  const modelOptions = $derived.by(() => {
    const base = modelCat.flat.map((m) => ({ value: m.id, label: modelDisplayName(m.id, modelCat.flat), group: m.series }));
    if (cfg.defaultModel && !base.some((o) => o.value === cfg.defaultModel)) {
      base.unshift({
        value: cfg.defaultModel,
        label: modelDisplayName(cfg.defaultModel, modelCat.flat),
        group: modelSeriesOf(cfg.defaultModel),
      });
    }
    return base;
  });
  const selectedModelDesc = $derived(
    modelCat.flat.find((m) => m.id === cfg.defaultModel)?.description || ''
  );

  const thoughtOptions = $derived(
    thoughtCat.options.map((o) => ({ value: o.id, label: o.name }))
  );

  const modeOptions = $derived(
    modeCat.options.map((o) => ({ value: o.id, label: o.name }))
  );
  const selectedModeDesc = $derived(
    modeCat.options.find((o) => o.id === cfg.defaultMode)?.description || ''
  );

  const projectOptions = $derived([
    { value: '', label: t('不固定（沿用上次项目）') },
    ...agyPrefs.projects.map((p) => ({ value: p.id, label: `${p.name}（${p.path}）` })),
  ]);

  const promptChanged = $derived(
    String(cfg.systemPromptAppend ?? '') !== String(agyPrefs.defaults.systemPromptAppend ?? '')
  );

  async function onPickDefaultModel(nextModel) {
    const nextThoughts = settingsThoughtCatalog(nextModel);
    const patch = { defaultModel: nextModel };
    if (nextThoughts.options.length > 0 && !nextThoughts.options.some((o) => o.id === cfg.defaultThoughtLevel)) {
      patch.defaultThoughtLevel = nextThoughts.options.find((o) => o.id === 'medium')?.id || nextThoughts.options[0].id;
    }
    await patchAgySettings(patch, 'defaults');
  }

  async function onSavePromptText(nextText) {
    const val = String(nextText ?? '');
    if (val === cfg.systemPromptAppend) return;
    await patchAgySettings({ systemPromptAppend: val }, 'prompt');
  }

  async function pickExtraFolder() {
    if (hasNativePickDirectory()) {
      const p = await nativePickDirectory(cfg.defaultCwd || '');
      if (p) await addAgyExtraDir(p);
      return;
    }
    pickingExtraDir = true;
  }

  async function askRestart() {
    const activeCount = st?.activeTurns?.length || 0;
    if (activeCount > 0) {
      const ok = await uiConfirm(t('重启 Antigravity 常驻进程？'), {
        detail: t('当前有 {n} 个对话正在生成中，重启会中断在途回复并重新挂载空闲会话。', { n: activeCount }),
        okLabel: t('立即重启'),
        danger: true,
      });
      if (!ok) return;
    }
    await restartAgyDaemon();
  }

  async function handleRestoreAllHidden() {
    const ok = await restoreAllHiddenFromSettings();
    if (ok) refreshAgySessions();
  }

  function openLogFilePreview() {
    const logPath = st?.logInfo?.path;
    if (!logPath) return;
    openPreview({
      origin: 'agy',
      path: logPath,
      name: logPath.split(/[\\/]/).pop() || 'acp.log',
      kind: 'text',
    });
  }

  function fmtStartedTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
</script>

{#if !enabled}
  <!-- 分页未启用或当前机器未装 CLI 时原因已在顶部说明 -->
{:else if agyPrefs.loading && !agyPrefs.loaded}
  <p class="note">{t('读取中…')}</p>
{:else}
  <!-- 1. 订阅号池与智能换号（只给主机管理员） -->
  {#if agyHostAdmin()}
    <AgyPoolSection {fl} />
  {/if}

  <!-- 2. 新对话默认值 -->
  <DGroup label={t('新对话默认')} foot={t('仅对新建对话生效；单个会话内随时可在输入框底部胶囊切换模型、思考档位与运行模式。')}>
    <div class="drow cr" class:hl={fl('ag-def-model')}>
      <span class="cr-tx">
        <span class="cr-t">{t('默认模型')}</span>
        {#if selectedModelDesc}<span class="cr-s">{selectedModelDesc}</span>{/if}
      </span>
      <span class="cr-tr">
        <DSelect options={modelOptions} value={cfg.defaultModel} onchange={onPickDefaultModel} width="240px" />
      </span>
    </div>

    <div class="drow cr" class:hl={fl('ag-def-effort')}>
      <span class="cr-tx">
        <span class="cr-t">{t('默认思考档位')}</span>
        <span class="cr-s">
          {thoughtOptions.length > 0 ? t('随所选模型动态调整可用思考深度') : t('当前所选模型使用固定思考策略')}
        </span>
      </span>
      <span class="cr-tr">
        {#if thoughtOptions.length > 0}
          <DSegmented
            options={thoughtOptions}
            value={cfg.defaultThoughtLevel}
            onchange={(v) => patchAgySettings({ defaultThoughtLevel: v }, 'defaults')}
          />
        {:else}
          <span class="num">—</span>
        {/if}
      </span>
    </div>

    <div class="drow cr" class:hl={fl('ag-def-mode')}>
      <span class="cr-tx">
        <span class="cr-t">{t('默认运行模式')}</span>
        {#if selectedModeDesc}<span class="cr-s">{selectedModeDesc}</span>{/if}
      </span>
      <span class="cr-tr">
        <DSegmented
          options={modeOptions}
          value={cfg.defaultMode}
          onchange={(v) => patchAgySettings({ defaultMode: v }, 'defaults')}
        />
      </span>
    </div>

    <div class="drow cr" class:hl={fl('ag-def-proj')}>
      <span class="cr-tx">
        <span class="cr-t">{t('默认项目工作空间')}</span>
        {#if agyPrefs.errors.defaults}<span class="cr-s bad">{agyPrefs.errors.defaults}</span>{/if}
      </span>
      <span class="cr-tr">
        <DSelect
          options={projectOptions}
          value={cfg.defaultProjectId || ''}
          onchange={(v) => patchAgySettings({ defaultProjectId: v }, 'defaults')}
          width="240px"
        />
      </span>
    </div>
  </DGroup>

  <!-- 3. 权限与附加工作目录 -->
  <DGroup
    label={t('权限与附加工作目录')}
    foot={t('Antigravity 单次权限审批仅提供「允许 / 拒绝」两项；需要自动放行文件编辑或常规工具时，可将上方运行模式设为「接受编辑」或「自动」。附加目录经服务端路径校验后随新会话一并挂载。')}
  >
    {#each (cfg.additionalDirectories || []) as dir (dir)}
      <div class="drow cr" class:hl={fl('ag-dirs')}>
        <span class="cr-tx"><span class="cr-t mono">{dir}</span></span>
        <span class="cr-tr">
          <button
            type="button"
            class="ico-btn danger"
            disabled={agyPrefs.busy === 'dirs'}
            onclick={() => removeAgyExtraDir(dir)}
            title={t('移除目录')}
            aria-label={t('移除目录')}
          >{@html svgOf('trash', 1.7)}</button>
        </span>
      </div>
    {/each}

    <div class="drow cr" class:hl={fl('ag-perm')}>
      <span class="cr-tx">
        <span class="cr-t">{t('附加工作目录')}</span>
        {#if agyPrefs.errors.dirs}
          <span class="cr-s bad">{agyPrefs.errors.dirs}</span>
        {:else}
          <span class="cr-s">{t('允许模型在主项目之外额外读取与交付文件的受控文件夹')}</span>
        {/if}
      </span>
      <span class="cr-tr">
        <DButton size="sm" disabled={agyPrefs.busy === 'dirs'} onclick={pickExtraFolder}>{t('添加目录…')}</DButton>
      </span>
    </div>
  </DGroup>

  <!-- 4. 系统提示追加 -->
  <DGroup label={t('系统提示追加')} foot={t('通过 _meta.antigravity.systemPrompt.append 注入，对新发起的对话生效。')}>
    <div class="drow cr dsp" class:hl={fl('ag-prompt')}>
      <span class="cr-tx">
        <span class="cr-t">
          {t('追加提示词（Bridge 协作约定）')}
          {#if promptChanged}<i class="chg" title={t('已改过默认值')}></i>{/if}
        </span>
        {#if agyPrefs.errors.prompt}<span class="cr-s bad">{agyPrefs.errors.prompt}</span>{/if}
      </span>
      <span class="cr-tr">
        {#if promptChanged}
          <button type="button" class="cr-reset" onclick={() => resetAgySystemPrompt()}>
            {t('恢复默认')}
          </button>
        {/if}
      </span>
      <div class="dsp-box">
        {#key cfg.systemPromptAppend}
          <textarea
            rows="4"
            maxlength="8000"
            value={cfg.systemPromptAppend || ''}
            onblur={(e) => onSavePromptText(e.currentTarget.value)}
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

  <!-- 5 & 6. MCP 服务器与 CLI 插件 -->
  <AgyExtSection {fl} admin={agyHostAdmin()} />

  <!-- 7. 外观 -->
  <DGroup label={t('分页外观')} foot={t('修改后在 Antigravity 分页即时生效。')}>
    <div class="drow cr" class:hl={fl('ag-theme')}>
      <span class="cr-tx"><span class="cr-t">{t('分页主题')}</span></span>
      <span class="cr-tr">
        <DSegmented
          options={agyThemeOptions()}
          value={cfg.theme || 'system'}
          onchange={(v) => patchAgySettings({ theme: v }, 'appearance')}
        />
      </span>
    </div>

    <div class="drow cr" class:hl={fl('ag-font')}>
      <span class="cr-tx"><span class="cr-t">{t('对话字号')}</span></span>
      <span class="cr-tr">
        <DSegmented
          options={agyFontSizeOptions()}
          value={cfg.fontSize || 'md'}
          onchange={(v) => patchAgySettings({ fontSize: v }, 'appearance')}
        />
      </span>
    </div>
  </DGroup>

  <!-- 8. 运行状态与更新（重启进程、升级 CLI、看日志：只给主机管理员） -->
  {#if agyHostAdmin()}
  <DGroup label={t('运行状态与 CLI 维护')}>
    <div class="drow cr" class:hl={fl('ag-runtime')}>
      <span class="cr-tx">
        <span class="cr-t">
          <b>{daemonStateText(st)}</b>
          {#if st?.pid}<span class="pill">PID {st.pid}</span>{/if}
          {#if st?.cliVersion}<span class="pill">v{String(st.cliVersion).replace(/^v/i, '')}</span>{/if}
        </span>
        <span class="cr-s">
          {#if st?.running && st?.startedAt}
            {t('启动于 {at} · 已运行 {up} · 活跃轮次 {live} / 挂载会话 {mounted}', {
              at: fmtStartedTime(st.startedAt),
              up: fmtUptime(Math.floor((st.uptimeMs || 0) / 1000)),
              live: st.activeTurns?.length || 0,
              mounted: st.mountedSessions?.length || 0,
            })}
          {:else if st?.lastExitReason}
            {st.lastExitReason}
          {:else}
            {t('首次进入对话或点击重启时自动拉起常驻进程')}
          {/if}
        </span>
        {#if agyPrefs.errors.runtime}<span class="cr-s bad">{agyPrefs.errors.runtime}</span>{/if}
      </span>
      <span class="cr-tr">
        <DButton size="sm" disabled={agyPrefs.busy === 'restart'} onclick={askRestart}>
          {agyPrefs.busy === 'restart' ? t('重启中…') : t('重启进程')}
        </DButton>
      </span>
    </div>

    <div class="drow cr dsp" class:hl={fl('ag-update')}>
      <span class="cr-tx">
        <span class="cr-t">{t('CLI 版本与更新')}</span>
        <span class="cr-s">{st?.cliPath || 'agy'}</span>
        {#if agyPrefs.errors.update}<span class="cr-s bad">{agyPrefs.errors.update}</span>{/if}
      </span>
      <span class="cr-tr">
        <DButton size="sm" disabled={agyPrefs.update.busy} onclick={() => checkAgyUpdate()}>
          {agyPrefs.update.busy ? t('检查中…') : t('检查更新')}
        </DButton>
      </span>
      {#if agyPrefs.update.result}
        <pre class="raw-box sel-text">{agyPrefs.update.result.output}</pre>
        {#if agyPrefs.update.result.updated}
          <span class="cr-s warn-txt">{t('已安装新版本 CLI，请点击上方「重启进程」让常驻服务加载新版二进制。')}</span>
        {/if}
      {/if}
    </div>

    {#if st?.logInfo?.path}
      <div class="drow cr">
        <span class="cr-tx">
          <span class="cr-t">{t('运行日志文件')}</span>
          <span class="cr-s mono">{st.logInfo.path}</span>
        </span>
        <span class="cr-tr">
          {#if st.logInfo.exists}
            <DButton size="sm" onclick={openLogFilePreview}>{t('打开日志')}</DButton>
          {:else}
            <span class="num">{t('尚未生成')}</span>
          {/if}
        </span>
      </div>
    {/if}
  </DGroup>

  {/if}

  <!-- 9. 会话 -->
  <DGroup
    label={t('会话管理')}
    foot={t('Antigravity ACP 协议不提供物理删除会话接口，侧栏删除操作仅在 Bridge 本地隐藏列表记录。')}
  >
    <div class="drow cr" class:hl={fl('ag-hidden')}>
      <span class="cr-tx">
        <span class="cr-t">{t('已隐藏的会话')}</span>
        <span class="cr-s">{t('当前共隐藏 {n} 条对话记录', { n: agyPrefs.hiddenCount })}</span>
        {#if agyPrefs.errors.sessions}<span class="cr-s bad">{agyPrefs.errors.sessions}</span>{/if}
      </span>
      <span class="cr-tr">
        <DButton
          size="sm"
          disabled={agyPrefs.hiddenCount === 0 || agyPrefs.busy === 'restoreHidden'}
          onclick={handleRestoreAllHidden}
        >{t('全部恢复')}</DButton>
      </span>
    </div>
  </DGroup>

  <!-- 10. 调试（改进 harness 用）：只给主机管理员，说明放组脚（与 Claude 分区同款） -->
  {#if agyDebugVisible()}
    <DGroup label={t('调试')} foot={agyDebugDesc()}>
      <div class="drow cr" class:hl={fl('ag-debug')}>
        <span class="cr-tx">
          <span class="cr-t">{t('调试模式')}</span>
          {#if agyPrefs.errors.debug}<span class="cr-s bad">{agyPrefs.errors.debug}</span>{/if}
        </span>
        <span class="cr-tr">
          <DSwitch
            checked={cfg.debugMode === true}
            disabled={agyPrefs.busy === 'debug'}
            onchange={(v) => patchAgySettings({ debugMode: !!v }, 'debug')}
          />
        </span>
      </div>
    </DGroup>
  {/if}
{/if}

{#if pickingExtraDir}
  <ProjectPicker
    title={t('添加附加工作目录')}
    hint={t('把文件夹拖进底栏，授权给 Antigravity 新会话访问')}
    preferPath={cfg.defaultCwd || ''}
    onPick={async (p) => { pickingExtraDir = false; if (p) await addAgyExtraDir(p); }}
    onClose={() => { pickingExtraDir = false; }}
  />
{/if}

<style>
  @import './kit.css';
  .cr { display: flex; align-items: center; gap: var(--dsk-s3); width: 100%; position: relative; font-family: var(--dsk-font); color: var(--dsk-ink); }
  .cr.dsp { flex-wrap: wrap; align-items: flex-start; row-gap: 8px; padding-bottom: 12px; }
  .cr-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .cr-t { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; font-size: var(--dsk-fs-body); line-height: 1.35; }
  .cr-t.mono, .cr-s.mono { font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace); font-size: 12px; overflow-wrap: anywhere; }
  .cr-s { font-size: var(--dsk-fs-sm); line-height: 1.35; color: var(--dsk-ink-3); }
  .cr-s.bad { color: var(--dsk-crit); }
  .cr-s.warn-txt { color: var(--dsk-warn, #b0741c); }
  .cr-tr { flex: none; display: inline-flex; align-items: center; gap: var(--dsk-s2); color: var(--dsk-ink-2); font-size: var(--dsk-fs-ui); }
  .chg { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsk-accent); }
  .cr-reset { padding: 2px 7px; border-radius: 6px; font-family: inherit; font-size: var(--dsk-fs-sm); color: var(--dsk-ink-3); }
  .cr-reset:hover { background: var(--dsk-hover); color: var(--dsk-ink); }
  .cr.hl { animation: agy-dsk-flash 1.5s var(--dsk-ease) 1; }
  @keyframes agy-dsk-flash { 0%, 70% { background: var(--dsk-sel); } 100% { background: transparent; } }
  .pill { padding: 0 6px; border-radius: 5px; font-size: 10.5px; line-height: 17px; font-weight: 600; color: var(--dsk-ink-2); box-shadow: inset 0 0 0 1px var(--dsk-line-strong); }
  .num { color: var(--dsk-ink-3); }
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
  .dsp-box textarea:focus { outline: none; box-shadow: var(--dsk-focus); background: var(--dsk-panel-strong); }
  .raw-box {
    width: 100%;
    margin: 4px 0 0;
    padding: 8px 10px;
    border-radius: var(--dsk-r-sm);
    background: var(--dsk-panel);
    box-shadow: 0 0 0 1px var(--dsk-line);
    font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace);
    font-size: 12px;
    line-height: 1.5;
    color: var(--dsk-ink-2);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .note { margin: 0 14px; font-size: var(--dsk-fs-sm); color: var(--dsk-ink-3); }
</style>
