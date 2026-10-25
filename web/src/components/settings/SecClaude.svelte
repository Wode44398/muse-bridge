<script>
  // 设置 · Claude：Claude Code 页的行为设置，按身份存在服务端（注册表 src/config/claude-settings.mjs，
  // 数据面 lib/claudeSettings.svelte.js，取值 / 文案 / 可见性 lib/claudeSettingsView.js）。
  // 每一行：标题 + 说明，改过默认值的标一个小点，右侧给「恢复默认」+ 控件（开关 / 分段 / 下拉）。
  // Muse 上不放的项：保持唤醒（VM 没有睡眠）、跟随 Claude Desktop 的归档（Linux 上没有 Desktop）。
  // 「输入建议」「思考动画」在「通用」那一节，这里不重复。
  import { me, prefs, savePrefs } from '../../lib/state.svelte.js';
  import { cs, loadClaudeSettings } from '../../lib/claudeSettings.svelte.js';
  import { S as CS, val, visible, setVal, resetVal, changed, label as csLabel, desc as csDesc, options as csOptions, errText } from '../../lib/claudeSettingsView.js';
  import { branchPrefixError } from '../../../../src/config/claude-settings.mjs';
  import { uiConfirm } from '../../lib/dialogs.js';
  import SSection from './SSection.svelte';
  import SRow from './SRow.svelte';
  import SToggle from './SToggle.svelte';
  import SSegmented from './SSegmented.svelte';
  import SSelect from './SSelect.svelte';
  import SField from './SField.svelte';
  import SButton from './SButton.svelte';
  import { t, tr } from '../../lib/i18n.js';

  if (me.kind !== 'none') loadClaudeSettings();   // 总线会推，开设置页时再拉一次兜底

  // Muse 上隐藏的注册表项
  const HIDDEN = new Set(['followDesktopArchive', 'keepAwake', 'keepAwakeOnBattery', 'promptSuggestions']);
  const show = (key) => !HIDDEN.has(key) && visible(key);
  // 说明文案里提到 Claude Desktop 的：Muse 上换成不提 Desktop 的说法
  const DESC = { crossSessionInbound: () => t('终端里的 Claude 或这台服务器上别的会话发给这里的消息') };
  const descOf = (key) => (DESC[key] ? DESC[key]() : csDesc(key));

  // 短枚举用分段，其余下拉
  const SEGMENTED = new Set(['worktreeBaseRef', 'attribution', 'replyLanguage']);
  const opts = (key) => csOptions(key).map((o) => ({ value: o.value, label: o.label, disabled: !!o.disabled }));
  const segOpts = (key) => csOptions(key).filter((o) => !o.disabled).map((o) => ({ value: o.value, label: o.label }));

  // 通知三项是这台设备的开关，总开关（通用 › 任务通知）关着时置灰
  const notifyOn = (() => { try { return localStorage.getItem('bridge-notify') !== '0'; } catch { return true; } })();

  // 「允许绕过权限模式」打开前确认一次
  async function toggle(key, v) {
    if (key === 'allowBypass' && v) {
      const ok = await uiConfirm(t('允许绕过权限模式？'), { detail: t('打开后，新会话可以选「绕过权限」：Claude 改文件、跑命令都不再问你。只在你清楚后果的环境里用。') });
      if (!ok) { bypassKey++; return; }
    }
    setVal(key, v);
  }
  let bypassKey = $state(0);

  // 分支前缀：失焦 / 回车保存，本地先按注册表校验
  let prefixErr = $state('');
  let prefixDraft = $state('');
  $effect(() => { prefixDraft = changed('branchPrefix') ? String(val('branchPrefix') || '') : ''; });
  async function savePrefix() {
    prefixErr = '';
    const v = String(prefixDraft || '').trim();
    if (v === (changed('branchPrefix') ? String(val('branchPrefix') || '') : '')) return;
    const bad = branchPrefixError(v);
    if (bad) { prefixErr = tr(bad); return; }
    if (!(await setVal('branchPrefix', v || null))) { prefixErr = errText() || t('分支前缀没保存上，请重试'); cs.err = ''; }
  }

  // 子 agent 调度偏好：多行文本，失焦保存（Ctrl/⌘+Enter 也存）；没在编辑时跟着服务端值走
  let dspDraft = $state(''), dspFocus = $state(false), dspMsg = $state(''), dspErr = $state('');
  $effect(() => { const v = val('subagentDispatch') || ''; if (!dspFocus) dspDraft = v; });
  async function saveDispatch() {
    const next = dspDraft.trim();
    if (next === (val('subagentDispatch') || '')) return;
    dspErr = ''; dspMsg = '';
    if (await setVal('subagentDispatch', next || null)) { dspMsg = t('已保存'); setTimeout(() => { dspMsg = ''; }, 1800); }
    else { dspErr = errText() || t('没保存上，请重试'); cs.err = ''; }
  }

  const clErr = $derived(errText(cs.err));
</script>

{#snippet reset(key)}
  {#if changed(key)}<button type="button" class="cr-reset" aria-label={t('将「{label}」恢复默认', { label: csLabel(key) })} onclick={() => resetVal(key)}>{t('恢复默认')}</button>{/if}
{/snippet}

<!-- 注册表驱动的一行：开关 / 分段 / 下拉；自动压缩点只读（在用量弹层里拖） -->
{#snippet crow(key)}
  {#if show(key)}
    <SRow label={csLabel(key)} desc={descOf(key)} sid={'cs-' + key}>
      {#snippet trailing()}
        {#if changed(key)}<i class="chg" title={t('已改过默认值')}></i>{/if}
        {@render reset(key)}
        {#if CS[key].type === 'bool'}
          <SToggle checked={!!val(key)} disabled={CS[key].scope === 'device' && !notifyOn} onchange={(v) => toggle(key, v)} label={csLabel(key)} />
        {:else if key === 'compactFrac'}
          <span class="val">{typeof val(key) === 'number' ? Math.round(val(key) * 100) + '%' : t('默认')}</span>
        {:else if SEGMENTED.has(key)}
          <SSegmented options={segOpts(key)} value={val(key)} onchange={(v) => setVal(key, v)} label={csLabel(key)} />
        {:else}
          <SSelect options={opts(key)} value={val(key)} onchange={(v) => setVal(key, v)} label={csLabel(key)} width="190px" />
        {/if}
      {/snippet}
    </SRow>
  {/if}
{/snippet}

{#if me.kind === 'none'}
  <SSection title={t('Claude')}>
    <SRow label={t('未登录')} desc={t('登录后才能改 Claude 的设置')} />
  </SSection>
{:else}
  <SSection title={t('撞上限额时')}>
    {@render crow('autoContinueOnLimit')}
  </SSection>

  <SSection title={t('新会话默认')} foot={t('会话里可以单独改：模式在输入框旁的模式菜单，输出风格在会话菜单里。')}>
    {@render crow('permissionMode')}
    {@render crow('outputStyle')}
    {@render crow('newChatLanding')}
    {#if cs.shell}
      <SRow label={t('用工作树')} desc={t('新会话在独立的 git 工作树里干活，不动你当前的分支（这台设备）')} sid="cs-worktree">
        {#snippet trailing()}<SToggle checked={!!prefs.worktree} onchange={(v) => { prefs.worktree = v; savePrefs(); }} label={t('用工作树')} />{/snippet}
      </SRow>
    {/if}
  </SSection>

  <SSection title={t('对话')}>
    {@render crow('inlineVisualizations')}
    {@render crow('enableWorkflows')}
    {#if show('subagentDispatch')}
      <SRow label={csLabel('subagentDispatch')} desc={dspErr || csDesc('subagentDispatch')} sid="cs-subagentDispatch" stack>
        {#snippet trailing()}
          <div class="dsp">
            <textarea rows="4" maxlength={CS.subagentDispatch.maxLen} bind:value={dspDraft}
              placeholder={t('例：简单任务（检索、读文件、批量改名）用 mimo-v2.6-flash；普通构建任务用 deepseek-v4.1-flash；难题和最终审查留给主模型。其余按实际情况判断，不局限于这几个。')}
              onfocus={() => { dspFocus = true; }} onblur={() => { dspFocus = false; saveDispatch(); }}
              onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.blur(); } }}></textarea>
            <div class="dsp-f">
              <span class="dsp-n">{dspDraft.length} / {CS.subagentDispatch.maxLen}</span>
              {#if dspMsg}<span class="dsp-ok">{dspMsg}</span>{/if}
              {#if changed('subagentDispatch')}<SButton onclick={() => { dspErr = ''; dspDraft = ''; resetVal('subagentDispatch'); }}>{t('清空')}</SButton>{/if}
            </div>
          </div>
        {/snippet}
      </SRow>
    {/if}
    {@render crow('switchModelsOnFlag')}
    {@render crow('planClearContext')}
    {@render crow('questionTimeout')}
    {@render crow('replyLanguage')}
    {@render crow('compactFrac')}
  </SSection>

  {#if show('newSessionPolicy') || show('crossSessionInbound')}
    <SSection title={t('会话协作')}>
      {@render crow('newSessionPolicy')}
      {@render crow('crossSessionInbound')}
    </SSection>
  {/if}

  {#if cs.shell}
    <SSection title={t('Git 与拉取请求')}>
      <SRow label={csLabel('branchPrefix')} desc={prefixErr || csDesc('branchPrefix')} sid="cs-branchPrefix">
        {#snippet trailing()}
          {#if changed('branchPrefix')}<i class="chg" title={t('已改过默认值')}></i>{/if}
          {#if changed('branchPrefix')}<button type="button" class="cr-reset" onclick={() => { prefixErr = ''; resetVal('branchPrefix'); }}>{t('恢复默认')}</button>{/if}
          <span class="pf" onfocusout={savePrefix}>
            <SField bind:value={prefixDraft} placeholder="claude" width="180px" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); savePrefix(); } }} />
          </span>
        {/snippet}
      </SRow>
      {@render crow('worktreeBaseRef')}
      {@render crow('autoFixPullRequests')}
      {@render crow('autoArchiveOnPrClose')}
      {@render crow('attribution')}
    </SSection>
  {/if}

  <SSection title={t('会话管理')}>
    {@render crow('autoArchiveDays')}
  </SSection>

  <SSection title={t('通知')} foot={notifyOn ? t('这三项只管这台设备。') : t('通知总开关在「通用」里关着')}>
    {@render crow('notifyPermission')}
    {@render crow('notifyQuestion')}
    {@render crow('notifyTaskComplete')}
  </SSection>

  {#if cs.admin}
    <SSection title={t('安全')} foot={t('只有管理员能改这里，对这台服务器上所有人生效。')}>
      {#key bypassKey}{@render crow('allowBypass')}{/key}
      {@render crow('allowAutoMode')}
    </SSection>
  {/if}
  {#if clErr}<p class="err">{clErr}</p>{/if}
{/if}

<style>
  .val { font-size: 14px; color: var(--st-text2); white-space: nowrap; }
  .chg { width: 6px; height: 6px; border-radius: 50%; background: var(--st-accent); flex: none; }
  .cr-reset { border: 0; background: none; padding: 0; font: inherit; font-size: 13px; color: var(--st-muted); cursor: pointer; white-space: nowrap; }
  @media (hover: hover) { .cr-reset:hover { color: var(--text); text-decoration: underline; } }
  .pf { display: inline-flex; }
  .dsp { width: 100%; display: flex; flex-direction: column; gap: 6px; }
  .dsp textarea { width: 100%; box-sizing: border-box; min-height: 92px; resize: vertical; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--st-hair); background: var(--st-field, transparent); color: var(--text); font: inherit; font-size: 13.5px; line-height: 1.5; }
  .dsp textarea:focus-visible { outline: 2px solid var(--st-accent); outline-offset: 1px; }
  .dsp-f { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
  .dsp-n { margin-right: auto; font-size: 12px; color: var(--st-muted); font-variant-numeric: tabular-nums; }
  .dsp-ok { font-size: 12.5px; color: var(--st-muted); }
  .err { margin: 4px 0 0; font-size: 13px; color: var(--crit); }
</style>
