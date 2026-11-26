<script module>
  import { loadCodexAll as loadAllForWarm } from '../../../../lib/codex/settings.svelte.js';
  // 设置页一挂上（lib/settings/warm 空闲预取到这块代码后）就把这页要的数据发出去，点进来时多半已经回来；
  // 页面挂上时再调同一组读会接上还在路上的那份（settings.svelte.js 的 once）。核心不能静态 import 扩展的控制器，入口只能放这里
  export function warmCodexSettings() { loadAllForWarm(); }
</script>

<script>
  // 手机 / 网页设置（iOS 外壳）› Codex 主页与子页路由入口（懒加载模块边界，归 codex 扩展）。
  //   'ag-codex'          主页正文（头图与「启用」开关外壳已画）：管理员 = 号池 / 撞线 / 新对话默认 / 成员默认档 / 实验 / 个性化 / 运行 / 外观 / 归档 / 扩展；
  //                       成员 = 自己的默认档 + 外观 + 已归档的对话（外观存在这台设备上，见 lib/codex/prefs.svelte.js）
  //   'cx:acct:<id>' 等   号池子页 → CodexAccountSubpages；'cx:add' / 'cx:login:<id>' → CodexLoginSubpages；其余单选 / 编辑页 → CodexSubpages
  // 数据层：lib/codex/settings.svelte.js（状态 cx 与动作）、lib/codex/settings-logic.js（选项与文案）。
  import { untrack } from 'svelte';
  import Sym from '../../../ios27/Sym.svelte';
  import Toggle from '../../../ios27/Toggle.svelte';
  import { t, tc } from '../../../../lib/i18n.js';
  import { swap } from '../../../../lib/arrive.js';
  import { ags } from '../../../../lib/agentSettings.svelte.js';
  import {
    cx,
    loadCodexAll,
    saveCodexSettings,
    setBehavior,
    approvalOf,
    behavior,
  } from '../../../../lib/codex/settings.svelte.js';
  import {
    approvalOptions,
    sandboxOptions,
    approvalLabel,
    sandboxLabel,
    webSearchOptions,
    verbosityOptions,
    summaryOptions,
    summaryValue,
    optionLabel,
    idleOptions,
    maxRunsOptions,
    cliSourceLabel,
  } from '../../../../lib/codex/settings-logic.js';
  import CodexPoolSection from './CodexPoolSection.svelte';
  import CodexAccountSubpages from './CodexAccountSubpages.svelte';
  import CodexLoginSubpages from './CodexLoginSubpages.svelte';
  import CodexSubpages from './CodexSubpages.svelte';
  import { codexPrefs, setCodexPref } from '../../../../lib/codex/prefs.svelte.js';
  import { chime } from '../../../../lib/codex/feedback.js';
  import { pets, loadPets, petLabel } from './codex-pets.svelte.js';

  let { pid = 'ag-codex', enabled = true, push, pop, openExt, onModal } = $props();

  // 进分区拉一次（设置 + 号池带额度 + 已归档的对话）；直达子页（外壳恢复了深层页栈）且还没读过时补一次
  $effect(() => {
    const p = pid;
    const on = enabled;
    untrack(() => {
      if (!on) return;
      if (p === 'ag-codex') loadCodexAll();
      else if (!cx.loaded && !cx.loading) loadCodexAll();
    });
  });

  // 同一个错误区（behavior / settings）被几组共用：错误只显示在最后动过的那一组下面
  let lastGroup = $state('');
  const errAt = (area, group) => (lastGroup === group ? cx.errors[area] || '' : '');
  function behaviorIn(group, key, value) { lastGroup = group; return setBehavior(key, value); }
  function settingsIn(group, patch) { lastGroup = group; return saveCodexSettings(patch); }

  const adminPol = $derived(approvalOf('admin'));
  const memberPol = $derived(approvalOf('member'));
  const bh = $derived(behavior());
  const instr = $derived(String(bh.instructions ?? ''));
  const instrPreview = $derived(instr.trim() ? (instr.trim().replace(/\s+/g, ' ').slice(0, 14) + (instr.trim().length > 14 ? '…' : '')) : t('未设置'));
  const cliMeta = $derived([cx.cli?.version ? 'v' + String(cx.cli.version).replace(/^v/i, '') : '', cliSourceLabel(cx.cli?.source)].filter(Boolean).join(' · '));
  $effect(() => { if (enabled && pid === 'ag-codex') untrack(() => loadPets()); });
  const noPets = $derived(pets.loaded && !pets.available.length);
  const archivedCount = $derived(cx.archivedLoaded ? t('{n} 个', { n: cx.archived.length }) : '');
</script>

{#snippet chev()}<Sym name="chevron.right" weight={600} size={13} class="chev" />{/snippet}

<!-- 推入行：标题 + 行尾当前值 + 箭头 -->
{#snippet pushRow(id, label, value)}
  <button class="r" type="button" onclick={() => push?.(id, label)}>
    <span class="r-main">
      <span class="r-tx">{label}</span>
      {#if value}<span class="r-d">{value}</span>{/if}
      {@render chev()}
    </span>
  </button>
{/snippet}

{#snippet err(text)}{#if text}<p class="gfoot err">{text}</p>{/if}{/snippet}

{#snippet appearanceGroup()}
  <h2 class="ghead">{t('外观')}</h2>
  <div class="ig">
    <div class="r">
      <span class="r-main" class:dim={noPets}>
        <span class="r-tx">
          <span>{t('吉祥物')}</span>
        </span>
        <Toggle
          checked={codexPrefs.pet && !noPets}
          disabled={noPets || !pets.loaded}
          onchange={() => setCodexPref('pet', !codexPrefs.pet)}
          label={t('吉祥物')}
        />
      </span>
    </div>
    {#if codexPrefs.pet && pets.available.length}
      {@render pushRow('cx:pet', t('角色'), petLabel(codexPrefs.petName))}
    {/if}
    <div class="r">
      <span class="r-main">
        <span class="r-tx">
          <span>{t('完成提示音')}</span>
        </span>
        <span class="dv-minis"><button type="button" onclick={() => chime({ force: true })}>{t('试听')}</button></span>
        <Toggle checked={codexPrefs.sound} onchange={() => setCodexPref('sound', !codexPrefs.sound)} label={t('完成提示音')} />
      </span>
    </div>
    <div class="r">
      <span class="r-main">
        <span class="r-tx">
          <span>{t('吐字震动')}</span>
        </span>
        <Toggle checked={codexPrefs.haptics} onchange={() => setCodexPref('haptics', !codexPrefs.haptics)} label={t('吐字震动')} />
      </span>
    </div>
  </div>
{/snippet}

{#snippet archivedGroup()}
  <div class="ig">
    {@render pushRow('cx:archived', t('已归档的对话'), archivedCount)}
  </div>
  {@render err(cx.errors.archived)}
{/snippet}

{#if pid === 'ag-codex'}
  {#if !enabled}
    <!-- 顶部开关已说明当前不可用或已关闭 -->
  {:else if !cx.loaded && !cx.snap}
    <!-- 第一次用、还什么都不知道：先不画（不出「读取中…」再被整页换掉），到了整页原地淡入；页面下面没有别的东西，不会推开谁 -->
  {:else if cx.admin}
    <div in:swap>
    <!-- 1 & 2. Codex 账号、撞上限额时 -->
    <CodexPoolSection {push} />

    <!-- 3. 新对话默认 -->
    <h2 class="ghead">{t('新对话默认')}</h2>
    <div class="ig">
      {@render pushRow('cx:approval', t('批准策略'), approvalLabel(adminPol.approvalPolicy))}
      {@render pushRow('cx:sandbox', t('沙盒设置'), sandboxLabel(adminPol.sandbox))}
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{t('允许网络访问')}</span>
          <Toggle
            checked={bh.networkAccess === true}
            onchange={() => behaviorIn('defaults', 'networkAccess', bh.networkAccess !== true)}
            label={t('允许网络访问')}
          />
        </span>
      </div>
      {@render pushRow('cx:websearch', t('网页搜索'), optionLabel(webSearchOptions(), bh.webSearch ?? ''))}
      {@render pushRow('cx:verbosity', t('输出详细程度'), optionLabel(verbosityOptions(), bh.verbosity ?? ''))}
      {@render pushRow('cx:summary', t('推理摘要'), optionLabel(summaryOptions(), summaryValue(bh.reasoningSummary)))}
    </div>
    {@render err(cx.errors.approval)}
    {@render err(errAt('behavior', 'defaults'))}

    <!-- 4. 成员的默认档（多人服务器才有成员） -->
    {#if ags.multiUser}
      <h2 class="ghead">{t('成员的默认档')}</h2>
      <div class="ig">
        {@render pushRow('cx:member-approval', t('批准策略'), approvalLabel(memberPol.approvalPolicy))}
        {@render pushRow('cx:member-sandbox', t('沙盒设置'), sandboxLabel(memberPol.sandbox))}
        {@render pushRow('cx:maxruns', t('同时能跑几轮'), optionLabel(maxRunsOptions(), cx.settings?.memberMaxRuns ?? 1))}
      </div>
    {/if}

    <!-- 5. 实验性质功能 -->
    <h2 class="ghead">{t('实验性质功能')}</h2>
    <div class="ig">
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{t('请求用户输入')}</span>
          <Toggle
            checked={bh.askUser !== false}
            onchange={() => behaviorIn('exp', 'askUser', bh.askUser === false)}
            label={t('请求用户输入')}
          />
        </span>
      </div>
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{t('目标')}</span>
          <Toggle
            checked={!!cx.settings?.goalsEnabled}
            onchange={() => settingsIn('exp', { goalsEnabled: !cx.settings?.goalsEnabled })}
            label={t('目标')}
          />
        </span>
      </div>
    </div>
    {@render err(errAt('behavior', 'exp'))}
    {@render err(errAt('settings', 'exp'))}

    <!-- 6. 个性化 -->
    <h2 class="ghead">{t('个性化')}</h2>
    <div class="ig">
      {@render pushRow('cx:instructions', t('自定义指令'), instrPreview)}
    </div>

    <!-- 7. 运行 -->
    <h2 class="ghead">{tc('settings', '运行')}</h2>
    <div class="ig">
      {@render pushRow('cx:idle', t('空闲多久停掉进程'), optionLabel(idleOptions(), cx.settings?.idleStopMinutes ?? 60))}
      {#if cx.cli}
        <div class="r cx-cli">
          <span class="r-main">
            <!-- 版本号很长（0.167.0-alpha.3.2）：放进副标题，别和路径抢一行的宽度 -->
            <span class="r-tx">
              <span>{t('Codex 程序')}</span>
              {#if cliMeta}<span class="r-sub">{cliMeta}</span>{/if}
              {#if cx.cli.file || cx.cli.command}<span class="r-sub cx-path">{cx.cli.file || cx.cli.command}</span>{/if}
            </span>
          </span>
        </div>
      {/if}
    </div>

    <!-- 8. 外观 -->
    {@render appearanceGroup()}

    <!-- 9. 已归档的对话 -->
    {@render archivedGroup()}

    <!-- 10. 扩展 -->
    <h2 class="ghead">{t('扩展')}</h2>
    <div class="ig">
      <button class="r" type="button" onclick={() => openExt?.('skill')}>
        <span class="r-main"><span class="r-tx">{t('技能')}</span>{@render chev()}</span>
      </button>
      <button class="r" type="button" onclick={() => openExt?.('connector')}>
        <span class="r-main"><span class="r-tx">{t('连接器')}</span>{@render chev()}</span>
      </button>
    </div>
    </div>
  {:else if cx.effective}
    <div in:swap>
    <!-- 成员视图：只读的有效档 + 自己的已归档对话 -->
    <h2 class="ghead">{t('你的默认档')}</h2>
    <div class="ig">
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('批准策略')}</span><span class="r-d">{approvalLabel(cx.effective.approvalPolicy)}</span></span>
      </div>
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('沙盒设置')}</span><span class="r-d">{sandboxLabel(cx.effective.sandbox)}</span></span>
      </div>
      {#if cx.effective.maxRuns}
        <div class="r">
          <span class="r-main"><span class="r-tx">{t('同时能跑')}</span><span class="r-d num">{t('{n} 轮', { n: cx.effective.maxRuns })}</span></span>
        </div>
      {/if}
    </div>
    {@render appearanceGroup()}
    {@render archivedGroup()}
    </div>
  {:else}
    {@render err(cx.errors.settings)}
  {/if}

{:else if pid.startsWith('cx:acct:') || pid.startsWith('cx:rename:')}
  <CodexAccountSubpages {pid} {push} {pop} {onModal} />
{:else if pid === 'cx:add' || pid.startsWith('cx:login:')}
  <CodexLoginSubpages {pid} {pop} />
{:else}
  <CodexSubpages {pid} {onModal} />
{/if}

<style>
  @import '../kit.css';
  .cx-cli .r-main { align-items: flex-start; }
  .cx-cli .r-d { padding-top: 0; }
  .cx-path {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    font-size: 12px;
    line-height: 17px;
    word-break: break-all;
    user-select: text;
    -webkit-user-select: text;
  }
</style>
