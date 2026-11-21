<script>
  // Antigravity 空状态与环境提示横幅：针对网络离线、未安装 CLI、常驻进程连续异常封顶、尚未登录四种情形，
  // 给出克制清晰的说明与可直达的下一步动作按钮，避免弹满屏红字报错。
  import { ui } from '../../lib/state.svelte.js';
  import { openSettings } from '../../lib/settingsNav.svelte.js';
  import { agy, refreshAgyStatus, refreshAgySessions } from '../../lib/agy/store.svelte.js';
  import { restartAgyDaemon } from '../../lib/agy/settings.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  const { compact = false } = $props();

  let busy = $state('');

  const stateKind = $derived.by(() => {
    if (ui.offline) return 'offline';
    const d = agy.daemon;
    if (!d) return '';
    if (d.cliInstalled === false) return 'missing_cli';
    if (d.stoppedAfterCrashes) return 'crashed';
    if (d.authState === 'logged_out' || d.account?.authed === false) return 'unauthed';
    return '';
  });

  async function handleRetryOffline() {
    if (busy) return;
    busy = 'offline';
    try {
      await Promise.all([
        refreshAgyStatus(false),
        refreshAgySessions({ refresh: true }),
      ]);
    } finally {
      busy = '';
    }
  }

  async function handleCheckStatus(ensure = true) {
    if (busy) return;
    busy = 'check';
    try {
      await refreshAgyStatus(ensure);
      await refreshAgySessions({ refresh: true });
    } finally {
      busy = '';
    }
  }

  async function handleRestartDaemon() {
    if (busy) return;
    busy = 'restart';
    try {
      await restartAgyDaemon();
      await refreshAgyStatus(true);
    } finally {
      busy = '';
    }
  }

  function gotoAgySettings() {
    openSettings('ag-agy');
  }
</script>

{#if stateKind === 'offline'}
  <div class="agy-state-banner warn" class:compact role="status" data-agy-state="offline">
    <span class="msr4 st-ico">error</span>
    <div class="st-body">
      <div class="st-title">{t('当前网络连接已断开')}</div>
      <div class="st-desc">{t('恢复连接后会自动同步当前对话进度；你也可以手动触发重连检查。')}</div>
    </div>
    <div class="st-acts">
      <button type="button" class="st-btn primary" disabled={busy === 'offline'} onclick={handleRetryOffline}>
        <span class="msr">refresh</span>
        <span>{busy === 'offline' ? t('重连中…') : t('立即重试')}</span>
      </button>
    </div>
  </div>
{:else if stateKind === 'missing_cli'}
  <div class="agy-state-banner" class:compact role="status" data-agy-state="missing_cli">
    <span class="msr4 st-ico">terminal</span>
    <div class="st-body">
      <div class="st-title">{t('未检测到 Antigravity CLI')}</div>
      <div class="st-desc">{t('请在运行 Bridge 的电脑上安装 Google Antigravity CLI（确保 agy 在 PATH 中），安装完成后重新检测即可使用。')}</div>
    </div>
    <div class="st-acts">
      <button type="button" class="st-btn primary" disabled={busy === 'check'} onclick={() => handleCheckStatus(true)}>
        <span class="msr">refresh</span>
        <span>{busy === 'check' ? t('检测中…') : t('重新检测')}</span>
      </button>
      <button type="button" class="st-btn" onclick={gotoAgySettings}>
        <span class="msr">tune</span>
        <span>{t('打开设置')}</span>
      </button>
    </div>
  </div>
{:else if stateKind === 'crashed'}
  <div class="agy-state-banner warn" class:compact role="status" data-agy-state="crashed">
    <span class="msr4 st-ico">error</span>
    <div class="st-body">
      <div class="st-title">{t('常驻进程已暂停自动重启')}</div>
      <div class="st-desc">
        {agy.daemon?.lastExitReason
          ? tr(agy.daemon.lastExitReason)
          : t('Antigravity ACP 连续异常退出已达上限，请检查本机环境或运行日志后手动重启。')}
      </div>
    </div>
    <div class="st-acts">
      <button type="button" class="st-btn primary" disabled={busy === 'restart'} onclick={handleRestartDaemon}>
        <span class="msr">replay</span>
        <span>{busy === 'restart' ? t('重启中…') : t('重启进程')}</span>
      </button>
      <button type="button" class="st-btn" onclick={gotoAgySettings}>
        <span class="msr">tune</span>
        <span>{t('设置与日志')}</span>
      </button>
    </div>
  </div>
{:else if stateKind === 'unauthed'}
  <div class="agy-state-banner" class:compact role="status" data-agy-state="unauthed">
    <span class="msr4 st-ico">shield</span>
    <div class="st-body">
      <div class="st-title">{t('尚未登录 Antigravity 账号')}</div>
      <div class="st-desc">{t('请在运行 Bridge 的电脑终端执行一次 agy 完成 Google 浏览器登录授权，完成后点击右侧刷新。')}</div>
    </div>
    <div class="st-acts">
      <button type="button" class="st-btn primary" disabled={busy === 'check'} onclick={() => handleCheckStatus(true)}>
        <span class="msr">refresh</span>
        <span>{busy === 'check' ? t('刷新中…') : t('我已登录，刷新')}</span>
      </button>
      <button type="button" class="st-btn" onclick={gotoAgySettings}>
        <span class="msr">tune</span>
        <span>{t('账号设置')}</span>
      </button>
    </div>
  </div>
{/if}

<style>
  .agy-state-banner {
    width: 100%;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px 15px;
    border-radius: 14px;
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-surface-2);
    animation: agy-banner-in var(--ag-dur-quick, 200ms) var(--ag-ease-decel, cubic-bezier(0.05, 0.7, 0.1, 1)) both;
  }
  .agy-state-banner.compact {
    margin-bottom: 12px;
    padding: 11px 13px;
  }
  .agy-state-banner.warn {
    border-color: color-mix(in srgb, var(--ag-warn) 38%, var(--ag-border-strong));
  }
  @keyframes agy-banner-in {
    from { opacity: 0; transform: translateY(-4px); }
  }
  .st-ico {
    font-size: 20px;
    color: var(--ag-accent);
    flex: none;
  }
  .agy-state-banner.warn .st-ico {
    color: var(--ag-warn);
  }
  .st-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
  }
  .st-title {
    font-size: 13.5px;
    font-weight: 560;
    color: var(--ag-on);
    line-height: 1.35;
  }
  .st-desc {
    font-size: 12px;
    line-height: 1.48;
    color: var(--ag-on-sub);
    word-break: break-word;
  }
  .st-acts {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 7px;
    flex: none;
  }
  .st-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 30px;
    padding: 0 11px;
    border-radius: 999px;
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-surface-1);
    font-size: 12px;
    font-weight: 540;
    color: var(--ag-on-sub);
    white-space: nowrap;
    transition: background var(--ag-dur-micro, 140ms) var(--ag-ease-fade, ease),
      border-color var(--ag-dur-micro, 140ms) var(--ag-ease-fade, ease),
      color var(--ag-dur-micro, 140ms) var(--ag-ease-fade, ease);
  }
  .st-btn:hover:not(:disabled) {
    background: var(--ag-hover);
    color: var(--ag-on);
  }
  .st-btn.primary {
    background: var(--ag-accent-fill);
    border-color: transparent;
    color: var(--ag-on-accent);
  }
  .st-btn.primary:hover:not(:disabled) {
    background: var(--ag-accent-strong);
    color: var(--ag-on-accent);
  }
  .st-btn:disabled {
    opacity: 0.58;
    cursor: default;
  }
  .st-btn .msr { font-size: 16px; }

  @media (max-width: 620px) {
    .agy-state-banner {
      flex-wrap: wrap;
      align-items: flex-start;
    }
    .st-acts {
      width: 100%;
      padding-left: 32px;
    }
  }
</style>
