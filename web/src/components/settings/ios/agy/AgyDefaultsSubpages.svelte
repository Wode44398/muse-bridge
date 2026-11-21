<script>
  // 手机 / 网页设置（iOS 外壳）› Antigravity 的配置选择与编辑子页：
  // 默认模型（按系列分组）、默认思考档位、默认运行模式、默认项目、界面主题、附加目录与系统提示追加。
  import Sym from '../../../ios27/Sym.svelte';
  import ProjectPicker from '../../../ProjectPicker.svelte';
  import { hasNativePickDirectory, nativePickDirectory } from '../../../../lib/nativeDesktop.js';
  import { t } from '../../../../lib/i18n.js';
  import {
    agyPrefs,
    patchAgySettings,
    addAgyExtraDir,
    removeAgyExtraDir,
    resetAgySystemPrompt,
    settingsModelCatalog,
    settingsThoughtCatalog,
    settingsModeCatalog,
    agyThemeOptions,
  } from '../../../../lib/agy/settings.svelte.js';

  let { pid = '', onModal = null } = $props();

  let pickingExtraDir = $state(false);
  let promptDraft = $state('');
  let promptInitKey = '';

  $effect(() => {
    onModal?.(pickingExtraDir);
    return () => onModal?.(false);
  });

  const cfg = $derived(agyPrefs.settings);
  const modelCat = $derived(settingsModelCatalog());
  const thoughtCat = $derived(settingsThoughtCatalog(cfg.defaultModel));
  const modeCat = $derived(settingsModeCatalog());
  const themeOpts = $derived(agyThemeOptions());

  const promptChanged = $derived(
    String(cfg.systemPromptAppend ?? '') !== String(agyPrefs.defaults.systemPromptAppend ?? '')
  );

  $effect(() => {
    if (pid === 'agy:prompt') {
      const serverVal = String(cfg.systemPromptAppend ?? '');
      if (promptInitKey !== serverVal) {
        promptInitKey = serverVal;
        promptDraft = serverVal;
      }
    }
  });

  async function pickModel(id) {
    if (id === cfg.defaultModel) return;
    const nextThoughts = settingsThoughtCatalog(id);
    const patch = { defaultModel: id };
    if (nextThoughts.options.length > 0 && !nextThoughts.options.some((o) => o.id === cfg.defaultThoughtLevel)) {
      patch.defaultThoughtLevel = nextThoughts.options.find((o) => o.id === 'medium')?.id || nextThoughts.options[0].id;
    }
    await patchAgySettings(patch, 'defaults');
  }

  async function pickExtraFolder() {
    if (hasNativePickDirectory()) {
      const p = await nativePickDirectory(cfg.defaultCwd || '');
      if (p) await addAgyExtraDir(p);
      return;
    }
    pickingExtraDir = true;
  }

  async function savePrompt() {
    const val = String(promptDraft ?? '');
    promptInitKey = val;
    await patchAgySettings({ systemPromptAppend: val }, 'prompt');
  }

  async function restoreDefaultPrompt() {
    const ok = await resetAgySystemPrompt();
    if (ok) {
      promptDraft = String(agyPrefs.settings.systemPromptAppend ?? '');
      promptInitKey = promptDraft;
    }
  }
</script>

{#snippet check()}<Sym name="checkmark" weight={600} size={15} class="ck" />{/snippet}

{#if pid === 'agy:model'}
  {#each modelCat.groups as grp (grp.series)}
    <h2 class="ghead">{grp.series}</h2>
    <div class="ig">
      {#each grp.models as m (m.id)}
        <button class="r" type="button" onclick={() => pickModel(m.id)}>
          <span class="r-main">
            <span class="r-tx">
              <span>{m.name}</span>
              {#if m.description}<span class="r-sub">{m.description}</span>{/if}
            </span>
            {#if cfg.defaultModel === m.id}{@render check()}{/if}
          </span>
        </button>
      {/each}
    </div>
  {/each}
  <p class="gfoot">{t('仅对新建对话生效；已有对话可在底部模型胶囊里单独切换。')}</p>

{:else if pid === 'agy:effort'}
  {#if thoughtCat.options.length === 0}
    <p class="gfoot">{t('当前所选模型使用固定思考策略。')}</p>
  {:else}
    <div class="ig">
      {#each thoughtCat.options as o (o.id)}
        <button class="r" type="button" onclick={() => patchAgySettings({ defaultThoughtLevel: o.id }, 'defaults')}>
          <span class="r-main">
            <span class="r-tx">
              <span>{o.name}</span>
              {#if o.description}<span class="r-sub">{o.description}</span>{/if}
            </span>
            {#if cfg.defaultThoughtLevel === o.id}{@render check()}{/if}
          </span>
        </button>
      {/each}
    </div>
    <p class="gfoot">{t('随所选默认模型动态调整可用思考深度。')}</p>
  {/if}

{:else if pid === 'agy:mode'}
  <div class="ig">
    {#each modeCat.options as m (m.id)}
      <button class="r" type="button" onclick={() => patchAgySettings({ defaultMode: m.id }, 'defaults')}>
        <span class="r-main">
          <span class="r-tx">
            <span>{m.name}</span>
            {#if m.description}<span class="r-sub">{m.description}</span>{/if}
          </span>
          {#if cfg.defaultMode === m.id}{@render check()}{/if}
        </span>
      </button>
    {/each}
  </div>
  <p class="gfoot">{t('Antigravity 单次权限审批仅提供「允许 / 拒绝」两项；需要自动放行文件编辑或常规工具时，可设为「接受编辑」或「自动」。')}</p>

{:else if pid === 'agy:project'}
  <div class="ig">
    <button class="r" type="button" onclick={() => patchAgySettings({ defaultProjectId: '' }, 'defaults')}>
      <span class="r-main">
        <span class="r-tx">
          <span>{t('不固定（沿用上次项目）')}</span>
        </span>
        {#if !cfg.defaultProjectId}{@render check()}{/if}
      </span>
    </button>
    {#each agyPrefs.projects as p (p.id)}
      <button class="r" type="button" onclick={() => patchAgySettings({ defaultProjectId: p.id }, 'defaults')}>
        <span class="r-main">
          <span class="r-tx">
            <span>{p.name}</span>
            <span class="r-sub dm-path">{p.path}</span>
          </span>
          {#if cfg.defaultProjectId === p.id}{@render check()}{/if}
        </span>
      </button>
    {/each}
  </div>
  {#if agyPrefs.errors.defaults}<p class="gfoot err">{agyPrefs.errors.defaults}</p>{/if}

{:else if pid === 'agy:theme'}
  <div class="ig">
    {#each themeOpts as o (o.value)}
      <button class="r" type="button" onclick={() => patchAgySettings({ theme: o.value }, 'appearance')}>
        <span class="r-main">
          <span class="r-tx">{o.label}</span>
          {#if cfg.theme === o.value}{@render check()}{/if}
        </span>
      </button>
    {/each}
  </div>
  <p class="gfoot">{t('切换后立即作用于 Antigravity 分页与侧边工作区。')}</p>

{:else if pid === 'agy:dirs'}
  {#if (cfg.additionalDirectories || []).length > 0}
    <div class="ig">
      {#each cfg.additionalDirectories as dir (dir)}
        <div class="r">
          <span class="r-main">
            <span class="r-tx dm-path">{dir}</span>
            <span class="dv-minis">
              <button
                type="button"
                class="red"
                disabled={agyPrefs.busy === 'dirs'}
                onclick={() => removeAgyExtraDir(dir)}
              >{t('移除')}</button>
            </span>
          </span>
        </div>
      {/each}
    </div>
  {/if}
  <div class="ig">
    <button class="r" type="button" disabled={agyPrefs.busy === 'dirs'} onclick={pickExtraFolder}>
      <span class="r-main center"><span class="r-tx accent">{t('添加目录…')}</span></span>
    </button>
  </div>
  {#if agyPrefs.errors.dirs}<p class="gfoot err">{agyPrefs.errors.dirs}</p>{/if}
  <p class="gfoot">{t('允许模型在主项目之外额外读取与交付文件的受控文件夹，经服务端路径校验后随新会话一并挂载。')}</p>

{:else if pid === 'agy:prompt'}
  <div class="ig prompt-card">
    <textarea
      class="prompt-area"
      rows="7"
      bind:value={promptDraft}
      placeholder={agyPrefs.defaults.systemPromptAppend}
    ></textarea>
  </div>
  <div class="ig">
    <button
      class="r"
      type="button"
      disabled={agyPrefs.busy === 'prompt' || promptDraft === String(cfg.systemPromptAppend ?? '')}
      onclick={savePrompt}
    >
      <span class="r-main center">
        <span class="r-tx accent">{agyPrefs.busy === 'prompt' ? t('保存中…') : t('保存追加提示词')}</span>
      </span>
    </button>
    {#if promptChanged}
      <button class="r" type="button" disabled={agyPrefs.busy === 'prompt'} onclick={restoreDefaultPrompt}>
        <span class="r-main center"><span class="r-tx">{t('恢复默认')}</span></span>
      </button>
    {/if}
  </div>
  {#if agyPrefs.errors.prompt}<p class="gfoot err">{agyPrefs.errors.prompt}</p>{/if}
  <p class="gfoot">{t('通过 _meta.antigravity.systemPrompt.append 注入，对新发起的对话生效。')}</p>
{/if}

{#if pickingExtraDir}
  <ProjectPicker
    title={t('添加附加工作目录')}
    hint={t('把文件夹拖进底栏，授权给 Antigravity 新会话访问')}
    preferPath={cfg.defaultCwd || ''}
    onPick={async (dir) => {
      pickingExtraDir = false;
      if (dir) await addAgyExtraDir(dir);
    }}
    onClose={() => { pickingExtraDir = false; }}
  />
{/if}

<style>
  @import '../kit.css';
  .prompt-card { padding: 12px 14px; }
  .prompt-area {
    width: 100%;
    box-sizing: border-box;
    border: 0;
    background: transparent;
    color: var(--i-label);
    font: inherit;
    font-size: 14px;
    line-height: 1.5;
    resize: vertical;
    outline: none;
  }
</style>
