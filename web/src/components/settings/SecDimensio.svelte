<script>
  // 设置 · dimensio。只有一个设置页（这个）：dimensio 分页里的「设置」也直达这一节（HarnessPage 给 HarnessApp 传
  // openSettings），dimensio 自己的设置面板在嵌入时不出。读写的是同一份状态与接口（@hx/lib/state：app.config /
  // saveConfig / reloadMeta），所以与 dimensio 原来的面板逐项等价：
  //   模型服务 + API Key · 记忆入口 · 权限规则（每次问我 / 从不允许）· 工作空间 · 访问范围 → 底部「保存」一起提交；
  //   外观 · 工作过程 → 即点即生效、只存本机；诊断包（要先在 dimensio 里开着一个对话）；版本信息在脚注。
  // 语言与 bridge 共用一个开关（通用 → 语言），这里不重复；连接（独立页 / 安卓壳的服务器地址）在这套前端里归宿主管。
  // dimensio 分页从没打开过时配置还没取：进这一节先取一次（HarnessPage 模块加载时已把接口指到 /api/harness）。
  import '../../lib/hxApi.js';   // 主页直接开设置、dimensio 分页从没挂载过时，接口也得先接到 /api/harness
  import { onMount, untrack } from 'svelte';
  import { ui } from '../../lib/state.svelte.js';
  import { goto } from '../../lib/pageMorph.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import {
    app as hx, reloadMeta, saveConfig, setAppearance, setFeedDetail, vendorInfo,
    openMemory, memoryOverviewAvailable, diagnosticsAvailable, exportDiagnostics,
  } from '@hx/lib/state.svelte.ts';
  import { memoryOverview } from '@hx/lib/api.ts';
  import { countLanes } from '@hx/components/sheets/memory-viz.ts';
  import ProjectPicker from '../ProjectPicker.svelte';
  import SSection from './SSection.svelte';
  import SRow from './SRow.svelte';
  import SField from './SField.svelte';
  import SButton from './SButton.svelte';
  import SToggle from './SToggle.svelte';
  import SSegmented from './SSegmented.svelte';
  import { t, tr } from '../../lib/i18n.js';

  let loadErr = $state('');
  onMount(() => {
    if (hx.config) return;
    reloadMeta().catch(() => {}).finally(() => { if (!hx.config) loadErr = hx.connError || t('连不上 dimensio 服务'); });
  });

  const vendor = $derived(vendorInfo(hx.config?.provider));

  // —— 草稿：配置第一次到位时填一次（开着时别处改了配置不回灌，同 dimensio 原面板）——
  let apiKey = $state('');
  let ask = $state('');
  let deny = $state('');
  let ws = $state('');
  let access = $state('full');
  let seeded = $state(false);
  const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  function seed(cfg) {
    ask = (cfg?.permissionRules?.ask || []).join('\n');
    deny = (cfg?.permissionRules?.deny || []).join('\n');
    ws = cfg?.workspace ?? '';
    access = cfg?.access ?? 'full';
    seeded = true;
  }
  $effect(() => { const cfg = hx.config; if (cfg) untrack(() => { if (!seeded) seed(cfg); }); });
  // 旧后端的配置里没有 workspace 字段：工作空间与访问范围不出
  const hasWs = $derived(seeded && hx.config?.workspace !== undefined);

  const dirty = $derived(seeded && (
    apiKey.trim() !== ''
    || JSON.stringify(lines(ask)) !== JSON.stringify(hx.config?.permissionRules?.ask ?? [])
    || JSON.stringify(lines(deny)) !== JSON.stringify(hx.config?.permissionRules?.deny ?? [])
    || (hasWs && (ws.trim() !== (hx.config?.workspace ?? '') || access !== (hx.config?.access ?? 'full')))));

  let saving = $state(false);
  async function save() {
    if (saving || !dirty) return;
    saving = true;
    try {
      // allow 规则界面上不编辑：保存那一刻现读、原样带回
      const patch = { permissionRules: { allow: hx.config?.permissionRules?.allow ?? [], ask: lines(ask), deny: lines(deny) } };
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      if (hasWs) {
        if (ws.trim() && ws.trim() !== hx.config?.workspace) patch.workspace = ws.trim();
        if (access !== hx.config?.access) patch.access = access;
      }
      await saveConfig(patch);
      apiKey = '';
      seed(hx.config);   // 按服务端现值重填（规则去空行、路径规范化后的样子）
      showToast(t('已保存'));
    } catch (e) {
      showToast(t('保存失败：{reason}', { reason: tr(String(e?.message ?? e)) }), 'err');
    } finally { saving = false; }
  }

  // —— 工作空间：用 bridge 的目录选择器挑，只改草稿 ——
  let picking = $state(false);
  function pickedWs(dir) { picking = false; if (dir) ws = dir; }

  // —— 记忆：一行入口 + 一句话现状；点进去是 dimensio 分页里的记忆面板（‹ 回到这一节）——
  const hasMemory = $derived(Boolean(hx.compat?.caps?.includes('memory')));
  let memLine = $state(null);
  $effect(() => {
    if (!hx.compat || !memoryOverviewAvailable()) return;
    untrack(() => memoryOverview().then((ov) => {
      const c = countLanes(ov.buckets.flatMap((b) => b.items));
      memLine = { active: c.active, waiting: c.proposed + c.held, places: ov.buckets.length };
    }).catch(() => {}));
  });
  const memDesc = $derived(!memLine ? t('模型跨对话记住的事：看、确认、驳回、清理')
    : memLine.active || memLine.waiting
      ? (memLine.places > 1 ? t('{n} 条生效，分布在 {places} 处', { n: memLine.active, places: memLine.places }) : t('{n} 条生效', { n: memLine.active }))
      : t('还没有记忆'));
  function goMemory() {
    if (dirty) { showToast(t('有改动还没保存：先点「保存」，再去看记忆'), 'err'); return; }
    ui.settingsOpen = false;
    openMemory({ fromSettings: true });
    goto('harness');
  }

  // —— 即点即生效、只存本机 ——
  const APPEARANCE = [{ value: 'auto', label: t('跟随系统') }, { value: 'light', label: t('浅色') }, { value: 'dark', label: t('深色') }];
  const ACCESS = [{ value: 'full', label: t('整机可访问') }, { value: 'workspace', label: t('仅工作空间') }];

  let exporting = $state(false);
  async function runExport() {
    exporting = true;
    try { await exportDiagnostics(); } finally { exporting = false; }
  }

  const build = $derived(hx.info?.build ?? null);
  const sha = $derived(build?.codeSha ? `${String(build.codeSha).slice(0, 7)}${build.dirty ? '*' : ''}` : '');
  const proto = $derived(hx.compat?.server ?? 0);
  const aboutLine = $derived([sha ? t('服务端 {sha}', { sha }) : '', proto ? t('协议 {n}', { n: proto }) : ''].filter(Boolean).join(' · '));
</script>

{#if !hx.config}
  <SSection title="dimensio">
    <SRow label={loadErr ? t('连不上 dimensio 服务') : t('正在连接…')} desc={loadErr && loadErr !== t('连不上 dimensio 服务') ? tr(loadErr) : ''} sid="dim-model" />
  </SSection>
{:else}
  <SSection title={t('模型服务')} foot={vendor.custom ? t('自定义服务的 Key 加密存在服务端，不回传浏览器。') : t('Key 只存于服务端内存，不落盘、不回传浏览器。')}>
    <SRow label={vendor.name} desc={`${vendor.company} · ${hx.config.model ?? ''}`} sid="dim-model">
      {#snippet trailing()}<span class="tag" class:warn={!hx.config.hasKey}>{hx.config.hasKey ? t('已配 Key') : t('缺 Key')}</span>{/snippet}
    </SRow>
    <SRow label={t('API Key')} desc={t('换模型服务在 dimensio 输入框旁的型号胶囊里')} sid="dim-key" stack>
      <SField password bind:value={apiKey} width="100%"
        placeholder={hx.config.hasKey ? t('••••••••（留空保持不变）') : t('粘贴 {name} API Key', { name: vendor.name })} />
    </SRow>
  </SSection>

  {#if hasMemory}
    <SSection title={t('记忆')}>
      <SRow label={t('记忆管理')} desc={memDesc} sid="dim-memory" onclick={goMemory}>
        {#snippet trailing()}{#if memLine?.waiting}<span class="tag warn">{t('{n} 条待处理', { n: memLine.waiting })}</span>{/if}<span class="chev" aria-hidden="true">&#xe02a;</span>{/snippet}
      </SRow>
    </SSection>
  {/if}

  <SSection title={t('权限规则')} foot={t('规则匹配命令/路径前缀，是减少误操作的软闸，不是对抗性安全沙箱。保存后对所有会话（包括正开着的）下一次调用就生效，重启也不丢。权限卡上的「本会话都允许」只管当前会话，切了运行档位、访问范围或改了这里的规则就失效，会再问一次。运行档位（自主执行 / 只读 / 先出计划）在输入框旁的档位胶囊，随时可切、对当前会话立刻生效。')}>
    <SRow label={t('每次问我')} desc={t('一行一条，如 Bash(git push:*)')} sid="dim-ask" stack>
      <textarea class="rules" bind:value={ask} rows="3" spellcheck="false" autocomplete="off"></textarea>
    </SRow>
    <SRow label={t('从不允许')} desc={t('一行一条，如 Bash(rm -rf:*)')} sid="dim-deny" stack>
      <textarea class="rules" bind:value={deny} rows="3" spellcheck="false" autocomplete="off"></textarea>
    </SRow>
  </SSection>

  {#if hasWs}
    <SSection title={t('工作空间')} foot={hx.config.accessLocked ? '' : t('“仅工作空间”会拦截明显越界的路径与命令，用于防误操作，不提供对抗恶意命令的强隔离。整机（默认）下 agent 可用绝对路径读写工作空间以外的文件（密钥文件始终封锁）。此设定是新会话的默认，重启也记得；单个对话随时可在输入框的档位胶囊里切。')}>
      <SRow label={t('默认工作空间')} desc={t('新对话没选项目时在这里干活')} sid="dim-ws" stack>
        <div class="ws">
          <SField bind:value={ws} width="100%" />
          <SButton onclick={() => (picking = true)}>{t('选择…')}</SButton>
        </div>
      </SRow>
      <!-- 被锁定（多用户服务端的租户实例，恒仅工作空间）就不给开关 -->
      {#if !hx.config.accessLocked}
        <SRow label={t('访问范围')} sid="dim-access">
          {#snippet trailing()}<SSegmented options={ACCESS} value={access} onchange={(v) => (access = v)} label={t('访问范围')} />{/snippet}
        </SRow>
      {/if}
    </SSection>
  {/if}

  <div class="save">
    <SButton variant="primary" size="md" disabled={!dirty || saving} onclick={save}>{saving ? t('保存中…') : t('保存')}</SButton>
    {#if dirty}<span class="hint">{t('API Key、规则、工作空间与访问范围点「保存」后生效')}</span>{/if}
  </div>
{/if}

<SSection title={t('显示')}>
  <SRow label={t('dimensio 外观')} desc={t('dimensio 分页自己的明暗，与 Claude 的主题分开')} sid="dim-appearance">
    {#snippet trailing()}<SSegmented options={APPEARANCE} value={hx.appearance} onchange={setAppearance} label={t('dimensio 外观')} />{/snippet}
  </SRow>
  <SRow label={t('显示全部工作过程')} desc={t('关着时，连续的工具调用收成一行：在跑说正在做什么，做完说做了哪些，点开再看每一步。打开后每一步都平铺参数、结果和实时输出。')} sid="dim-feed">
    {#snippet trailing()}<SToggle checked={hx.feedDetail} onchange={setFeedDetail} label={t('显示全部工作过程')} />{/snippet}
  </SRow>
</SSection>

{#if hx.config && diagnosticsAvailable()}
  <SSection title={t('诊断')} foot={[t('卡住了、变慢了、报错了，导出这个包发给维护的人：里面是这一轮的事件记录、服务输出、体检结果与版本信息，不含对话正文和任何 key。'), aboutLine].filter(Boolean).join(' ')}>
    <SRow label={t('导出当前对话的诊断包')} desc={hx.chat.id ? '' : t('先在 dimensio 里打开一个对话')} sid="dim-diag">
      {#snippet trailing()}<SButton disabled={!hx.chat.id || exporting} onclick={runExport}>{exporting ? t('生成中…') : t('导出')}</SButton>{/snippet}
    </SRow>
  </SSection>
{/if}

{#if picking}
  <ProjectPicker title={t('选择默认工作空间')} hint={t('把文件夹拖进底栏，它就是 dimensio 的默认工作空间')} preferPath={ws}
    onPick={pickedWs} onClose={() => (picking = false)} />
{/if}

<style>
  .tag { font-size: 12.5px; padding: 2px 8px; border-radius: 999px; background: var(--st-seg); color: var(--st-text2); white-space: nowrap; }
  .tag.warn { background: color-mix(in srgb, #d97706 18%, transparent); color: #c2410c; }
  :global(html:not([data-theme="light"])) .tag.warn { color: #fdba74; }
  .chev { font-family: var(--icons); font-size: 16px; color: var(--st-muted); margin-left: 6px; }
  .rules { width: 100%; min-height: 64px; margin-top: 8px; padding: 8px 12px; border: 0; border-radius: 8px; outline: none; resize: vertical; box-sizing: border-box;
    background: var(--st-field); box-shadow: inset 0 0 0 1px var(--st-line); color: var(--text);
    font: 13px/1.5 var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); transition: box-shadow .15s ease; }
  .rules::placeholder { color: var(--st-muted); }
  .rules:focus { box-shadow: inset 0 0 0 1px var(--st-accent), 0 0 0 3px color-mix(in srgb, var(--st-accent) 22%, transparent); }
  .ws { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .ws :global(.sf) { flex: 1; }
  .save { display: flex; align-items: center; gap: 12px; margin: -16px 0 40px; }
  .hint { font-size: 13px; color: var(--st-muted); }
  :global(.stg.compact) .save { margin: -8px 4px 26px; }
</style>
