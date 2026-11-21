<script>
  // 手机 / 网页设置（iOS 外壳）› Antigravity 主页与子页路由入口（懒加载模块边界，避免扩展代码漏入核心主包）。
  import { untrack } from 'svelte';
  import Sym from '../../../ios27/Sym.svelte';
  import Segmented from '../../../ios27/Segmented.svelte';
  import Toggle from '../../../ios27/Toggle.svelte';
  import { uiConfirm } from '../../../../lib/dialogs.js';
  import { openPreview } from '../../../../lib/preview.svelte.js';
  import { fmtUptime } from '../../../../lib/settings/common.js';
  import { SI } from '../../../../lib/settingsIcons.js';
  import { t } from '../../../../lib/i18n.js';
  import { refreshAgySessions } from '../../../../lib/agy/store.svelte.js';
  import { modelDisplayName } from '../../../../lib/agy/catalog.js';
  import {
    agyPrefs,
    loadAgySettingsAll,
    refreshAgyRuntimeStatus,
    patchAgySettings,
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
  } from '../../../../lib/agy/settings.svelte.js';
  import AgyDefaultsSubpages from './AgyDefaultsSubpages.svelte';
  import AgyExtSubpages from './AgyExtSubpages.svelte';
  import AgyPoolSection from './AgyPoolSection.svelte';
  import AgyPoolSubpages from './AgyPoolSubpages.svelte';

  let { pid = 'ag-agy', enabled = true, push, pop, onModal } = $props();

  const svgOf = (name, w = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;

  $effect(() => {
    if (pid === 'ag-agy' && enabled) untrack(() => loadAgySettingsAll({ probe: true }));
  });

  const cfg = $derived(agyPrefs.settings);
  const st = $derived(agyPrefs.status);

  const modelCat = $derived(settingsModelCatalog());
  const thoughtCat = $derived(settingsThoughtCatalog(cfg.defaultModel));
  const modeCat = $derived(settingsModeCatalog());
  const themeOpts = $derived(agyThemeOptions());
  const fontOpts = $derived(agyFontSizeOptions());

  const curModelName = $derived(
    modelDisplayName(cfg.defaultModel, modelCat.flat)
  );
  const curThoughtName = $derived(
    thoughtCat.options.find((o) => o.id === cfg.defaultThoughtLevel)?.name || cfg.defaultThoughtLevel || '—'
  );
  const curModeName = $derived(
    modeCat.options.find((m) => m.id === cfg.defaultMode)?.name || cfg.defaultMode
  );
  const curProjName = $derived(
    agyPrefs.projects.find((p) => p.id === cfg.defaultProjectId)?.name || t('沿用上次')
  );
  const curThemeName = $derived(
    themeOpts.find((o) => o.value === cfg.theme)?.label || cfg.theme
  );
  const promptChanged = $derived(
    String(cfg.systemPromptAppend ?? '') !== String(agyPrefs.defaults.systemPromptAppend ?? '')
  );

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

  async function handleRestoreAll() {
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
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
</script>

{#snippet chev()}<Sym name="chevron.right" weight={600} size={13} class="chev" />{/snippet}

{#if pid === 'ag-agy'}
  {#if !enabled}
    <!-- 顶部开关已说明当前不可用或已关闭 -->
  {:else if agyPrefs.loading && !agyPrefs.loaded}
    <p class="gfoot">{t('读取中…')}</p>
  {:else}
    <!-- 1. 订阅号池与智能换号（只给主机管理员） -->
    {#if agyHostAdmin()}
      <AgyPoolSection {push} />
    {/if}

    <!-- 2. 新对话默认 -->
    <h2 class="ghead">{t('新对话默认')}</h2>
    <div class="ig">
      <button class="r" type="button" onclick={() => push?.('agy:model', t('默认模型'))}>
        <span class="r-main">
          <span class="r-tx">{t('默认模型')}</span>
          <span class="r-d">{curModelName}</span>
          {@render chev()}
        </span>
      </button>
      <button class="r" type="button" onclick={() => push?.('agy:effort', t('默认思考档位'))}>
        <span class="r-main">
          <span class="r-tx">{t('默认思考档位')}</span>
          <span class="r-d">{thoughtCat.options.length ? curThoughtName : '—'}</span>
          {@render chev()}
        </span>
      </button>
      <button class="r" type="button" onclick={() => push?.('agy:mode', t('默认运行模式'))}>
        <span class="r-main">
          <span class="r-tx">{t('默认运行模式')}</span>
          <span class="r-d">{curModeName}</span>
          {@render chev()}
        </span>
      </button>
      <button class="r" type="button" onclick={() => push?.('agy:project', t('默认项目工作空间'))}>
        <span class="r-main">
          <span class="r-tx">{t('默认项目工作空间')}</span>
          <span class="r-d">{curProjName}</span>
          {@render chev()}
        </span>
      </button>
    </div>
    <p class="gfoot">{t('仅对新建对话生效；单个会话内随时可在输入框底部胶囊切换模型、思考档位与运行模式。')}</p>

    <!-- 3. 权限与附加工作目录 -->
    <h2 class="ghead">{t('权限与附加工作目录')}</h2>
    <div class="ig">
      <button class="r" type="button" onclick={() => push?.('agy:dirs', t('附加工作目录'))}>
        <span class="r-main">
          <span class="r-tx">{t('附加工作目录')}</span>
          <span class="r-d num">
            {(cfg.additionalDirectories?.length || 0) > 0
              ? t('{n} 个', { n: cfg.additionalDirectories.length })
              : t('未添加')}
          </span>
          {@render chev()}
        </span>
      </button>
    </div>
    <p class="gfoot">{t('Antigravity 单次权限审批仅提供「允许 / 拒绝」两项；需要自动放行文件编辑或常规工具时，可将上方运行模式设为「接受编辑」或「自动」。')}</p>

    <!-- 4. 系统提示追加 -->
    <h2 class="ghead">{t('系统提示追加')}</h2>
    <div class="ig">
      <button class="r" type="button" onclick={() => push?.('agy:prompt', t('系统提示追加'))}>
        <span class="r-main">
          <span class="r-tx">
            <span class="r-lbl">
              {t('追加提示词（Bridge 协作约定）')}
              {#if promptChanged}<i class="chg" title={t('已改过默认值')}></i>{/if}
            </span>
          </span>
          <span class="r-d">{promptChanged ? t('已自定义') : t('默认')}</span>
          {@render chev()}
        </span>
      </button>
    </div>

    <!-- 5 & 6. Bridge 工具、MCP 服务器与插件 -->
    <h2 class="ghead">{t('扩展与工具')}</h2>
    <div class="ig">
      <button class="r" type="button" onclick={() => push?.('agy:bridge-tools', t('Bridge 工具协同'))}>
        <span class="r-main">
          <span class="r-tx">{t('Bridge 工具协同')}</span>
          <span class="r-d">{cfg.bridgeTools?.enabled === false ? t('已关闭') : t('已启用')}</span>
          {@render chev()}
        </span>
      </button>
      {#if agyHostAdmin()}
      <button class="r" type="button" onclick={() => push?.('agy:mcp', t('MCP 服务器'))}>
        <span class="r-main">
          <span class="r-tx">{t('MCP 服务器')}</span>
          <span class="r-d num">
            {agyPrefs.mcp.items.length > 0 ? t('{n} 个', { n: agyPrefs.mcp.items.length }) : ''}
          </span>
          {@render chev()}
        </span>
      </button>
      <button class="r" type="button" onclick={() => push?.('agy:plugins', t('CLI 插件'))}>
        <span class="r-main">
          <span class="r-tx">{t('CLI 插件')}</span>
          <span class="r-d num">
            {agyPrefs.plugins.items.length > 0 ? t('{n} 个', { n: agyPrefs.plugins.items.length }) : ''}
          </span>
          {@render chev()}
        </span>
      </button>
      {/if}
    </div>

    <!-- 7. 外观 -->
    <h2 class="ghead">{t('外观')}</h2>
    <div class="ig">
      <button class="r" type="button" onclick={() => push?.('agy:theme', t('界面主题'))}>
        <span class="r-main">
          <span class="r-tx">{t('界面主题')}</span>
          <span class="r-d">{curThemeName}</span>
          {@render chev()}
        </span>
      </button>
      <div class="r font-row">
        <span class="r-main">
          <span class="r-tx">{t('对话字号')}</span>
          <span class="font-seg">
            <Segmented
              size="small"
              options={fontOpts}
              value={cfg.fontSize || 'md'}
              onchange={(v) => patchAgySettings({ fontSize: v }, 'appearance')}
              label={t('对话字号')}
            />
          </span>
        </span>
      </div>
    </div>
    {#if agyPrefs.errors.appearance}<p class="gfoot err">{agyPrefs.errors.appearance}</p>{/if}

    <!-- 8. 运行状态与更新（只给主机管理员） -->
    {#if agyHostAdmin()}
    <div class="ghead-row">
      <h2 class="ghead">{t('运行状态与更新')}</h2>
      <button
        class="gh-ico"
        type="button"
        onclick={() => refreshAgyRuntimeStatus({ ensure: false, probe: false })}
        aria-label={t('刷新')}
      >{@html svgOf('refresh', 1.8)}</button>
    </div>
    <div class="ig">
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{t('常驻进程')}</span>
          <span class="r-d" class:err={st?.stoppedAfterCrashes}>
            {#if st?.running}<i class="live-dot"></i>{/if}
            <span>{daemonStateText(st)}{st?.pid ? ` · PID ${st.pid}` : ''}</span>
          </span>
        </span>
      </div>
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{t('CLI 版本')}</span>
          <span class="r-d num">{st?.cliVersion || st?.agentInfo?.version || '—'}</span>
        </span>
      </div>
      {#if st?.running && st?.startedAt}
        <div class="r">
          <span class="r-main">
            <span class="r-tx">{t('启动与运行时长')}</span>
            <span class="r-d num">{fmtStartedTime(st.startedAt)} · {fmtUptime(Math.floor((st.uptimeMs || 0) / 1000))}</span>
          </span>
        </div>
      {/if}
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{t('在途轮次 / 已挂载会话')}</span>
          <span class="r-d num">{(st?.activeTurns?.length || 0)} / {(st?.mountedSessions?.length || 0)}</span>
        </span>
      </div>
      {#if st?.logInfo?.path}
        <button class="r" type="button" disabled={!st.logInfo.exists} onclick={openLogFilePreview}>
          <span class="r-main">
            <span class="r-tx">
              <span>{t('运行日志文件')}</span>
              <span class="r-sub dm-path">{st.logInfo.path}</span>
            </span>
            <span class="r-d accent">{t('打开日志')}</span>
          </span>
        </button>
      {/if}
      <button class="r" type="button" disabled={agyPrefs.busy === 'restart'} onclick={askRestart}>
        <span class="r-main center">
          <span class="r-tx accent">{agyPrefs.busy === 'restart' ? t('正在重启…') : t('重启常驻进程')}</span>
        </span>
      </button>
      <button class="r" type="button" disabled={agyPrefs.update.busy} onclick={() => checkAgyUpdate()}>
        <span class="r-main center">
          <span class="r-tx accent">{agyPrefs.update.busy ? t('检查中…') : t('检查 CLI 更新')}</span>
        </span>
      </button>
      {#if agyPrefs.update.result?.output}
        <div class="r raw-row">
          <pre class="raw-pre">{agyPrefs.update.result.output}</pre>
          {#if agyPrefs.update.result.updated}
            <button type="button" class="upd-restart" onclick={askRestart}>{t('重启进程使新版本生效')}</button>
          {/if}
        </div>
      {/if}
    </div>
    {#if agyPrefs.errors.runtime}<p class="gfoot err">{agyPrefs.errors.runtime}</p>{/if}
    {#if agyPrefs.errors.update}<p class="gfoot err">{agyPrefs.errors.update}</p>{/if}

    {/if}

    <!-- 9. 会话管理 -->
    <h2 class="ghead">{t('会话管理')}</h2>
    <div class="ig">
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{t('已隐藏的会话')}</span>
          <span class="r-d num">{t('{n} 个', { n: agyPrefs.hiddenCount || 0 })}</span>
        </span>
      </div>
      {#if (agyPrefs.hiddenCount || 0) > 0}
        <button class="r" type="button" disabled={agyPrefs.busy === 'restoreHidden'} onclick={handleRestoreAll}>
          <span class="r-main center">
            <span class="r-tx accent">{agyPrefs.busy === 'restoreHidden' ? t('恢复中…') : t('全部恢复')}</span>
          </span>
        </button>
      {/if}
    </div>
    {#if agyPrefs.errors.sessions}<p class="gfoot err">{agyPrefs.errors.sessions}</p>{/if}
    <p class="gfoot">{t('Antigravity 原生协议不提供物理删除接口，侧栏隐藏仅在 Bridge 视图内折叠，可随时在此全部恢复。')}</p>

    <!-- 10. 调试（改进 harness 用）：只给主机管理员 -->
    {#if agyDebugVisible()}
      <h2 class="ghead">{t('调试')}</h2>
      <div class="ig">
        <div class="r">
          <span class="r-main">
            <span class="r-tx">{t('调试模式')}</span>
            <Toggle
              checked={cfg.debugMode === true}
              disabled={agyPrefs.busy === 'debug'}
              onchange={() => patchAgySettings({ debugMode: cfg.debugMode !== true }, 'debug')}
              label={t('调试模式')}
            />
          </span>
        </div>
      </div>
      {#if agyPrefs.errors.debug}<p class="gfoot err">{agyPrefs.errors.debug}</p>{/if}
      <p class="gfoot">{agyDebugDesc()}</p>
    {/if}
  {/if}

{:else if pid.startsWith('agy:acct')}
  <AgyPoolSubpages {pid} {push} {pop} />
{:else if pid === 'agy:bridge-tools' || pid === 'agy:mcp' || pid === 'agy:mcp-add' || pid === 'agy:plugins'}
  <AgyExtSubpages {pid} {push} {pop} />
{:else}
  <AgyDefaultsSubpages {pid} {onModal} />
{/if}

<style>
  @import '../kit.css';
  .font-seg { width: 168px; flex: none; }
  .raw-row { flex-direction: column; align-items: stretch; gap: 8px; padding: 12px 16px; }
  .raw-pre {
    margin: 0;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--i-fill4);
    font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace);
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .upd-restart {
    align-self: flex-start;
    padding: 6px 12px;
    border: 0;
    border-radius: 9px;
    background: var(--i-accent);
    color: var(--i-on-accent);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
</style>
