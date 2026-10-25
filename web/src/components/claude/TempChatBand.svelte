<script>
  // 临时对话（服务端 src/claude-quick.mjs）在输入框上方的两种提示（S1-6，2026-10-22）：
  //   · mode='chip'：临时对话没有项目 / 分支芯片可摆，换成一颗「临时对话」芯片 + 一句它什么时候会被清理，
  //     有对话了再给一个「存为工作空间」——让人一眼知道这条不进任何项目、放久了会清理；
  //   · mode='warn'：离清理只剩几天（服务端 quickPolicy.warnDays）时的提示条，与「此会话已归档」同一套
  //     aux band 外形，给「继续保留」（回收时钟从头算）和「存为工作空间」两条路。
  // 天数一律由宿主按服务端给的到期时刻算好传进来（lib/quickChat.js），这里只管显示。
  import { t } from '../../lib/i18n.js';

  let { mode = 'chip', days = null, ttlDays = 30, canSave = false, busy = false, onSave = null, onKeep = null } = $props();
  const tip = $derived(t('不归任何项目、不带记忆；{n} 天没动会移进回收站，之前可以存为工作空间。', { n: ttlDays }));
</script>

{#if mode === 'warn'}
  <div class="band" role="status">
    <span class="band-msg">{days ? t('这个临时对话 {n} 天后会移进回收站。', { n: days }) : t('这个临时对话很快会移进回收站。')}</span>
    {#if onKeep}<button class="lnk" disabled={busy} onclick={onKeep}>{t('继续保留')}</button>{/if}
    {#if canSave && onSave}<button class="lnk" disabled={busy} onclick={onSave}>{t('存为工作空间')}</button>{/if}
  </div>
{:else}
  <div class="tq" title={tip}>
    <span class="tq-chip">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4.5 3h7A2.5 2.5 0 0 1 14 5.5v3.5a2.5 2.5 0 0 1-2.5 2.5H8l-3 2.25V11.5h-.5A2.5 2.5 0 0 1 2 9V5.5A2.5 2.5 0 0 1 4.5 3Z" stroke-dasharray="2 1.7"/>
      </svg>
      <span>{t('临时对话')}</span>
    </span>
    <span class="tq-note">{days != null ? t('{n} 天后清理', { n: days }) : t('{n} 天没动会自动清理', { n: ttlDays })}</span>
    {#if canSave && onSave}<button class="tq-lnk" disabled={busy} onclick={onSave}>{t('存为工作空间')}</button>{/if}
  </div>
{/if}

<style>
  /* 与 RefusalBand / ArchivedBand 同一套 aux band 外形：min-h 40 / p8 / r10 / 底 --hover */
  .band { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; width: 100%; box-sizing: border-box; min-height: 40px; padding: 8px 8px 8px 12px;
    border-radius: 10px; background: var(--hover); font-size: 14px; line-height: 20px; color: var(--text); }
  .band-msg { flex: 1; min-width: 12em; }
  .lnk { flex: none; padding: 0 4px; color: var(--serif); text-decoration: underline; text-underline-offset: 3px;
    text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); font-size: 14px; line-height: 20px; border-radius: 4px; }
  @media (hover: hover) { .lnk:hover { color: var(--text); } }
  .lnk:disabled { opacity: .5; cursor: default; }

  /* 芯片行：尺寸对齐 WorkspaceChips（高 24 / 左右 6 / 圆角 6 / 字 13-19；行下 4 + 与输入卡片 6） */
  .tq { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 0 0 4px; margin-bottom: 6px; min-width: 0;
    font-size: 13px; line-height: 19px; color: var(--muted); }
  .tq-chip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px; border-radius: 6px; color: var(--serif);
    /* 底色不透明：输入栏悬浮在正文上，半透明会让正文字叠进芯片（同 WorkspaceChips） */
    background-color: var(--bg); background-image: linear-gradient(var(--hover), var(--hover)); }
  :global(html[data-theme="light"]) .tq-chip { box-shadow: inset 0 0 0 1px rgba(11, 11, 11, .1), 0 1px 2px rgba(11, 11, 11, .04); }
  .tq-chip svg { width: 14px; height: 14px; flex: none; }
  .tq-note { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .tq-lnk { flex: none; padding: 0 2px; color: var(--serif); text-decoration: underline; text-underline-offset: 3px;
    text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); font-size: 13px; line-height: 19px; border-radius: 4px; }
  @media (hover: hover) { .tq-lnk:hover { color: var(--text); } }
  .tq-lnk:disabled { opacity: .5; cursor: default; }
</style>
