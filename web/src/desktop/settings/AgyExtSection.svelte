<script>
  import { AGY_HUB_TOOL_ROWS } from '../../lib/agy/hub-tool-rows.js';
  // 桌面设置 › Antigravity 的 MCP 服务器与 CLI 插件管理子块（包装 agy mcp / agy plugin，解析异常时降级展示原文）。
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import DButton from '../kit/DButton.svelte';
  import DField from '../kit/DField.svelte';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { pluginOn } from '../../lib/state.svelte.js';
  import { SI } from '../../lib/settingsIcons.js';
  import { t } from '../../lib/i18n.js';
  import {
    agyPrefs,
    patchAgySettings,
    loadAgyMcp,
    addAgyMcp,
    toggleAgyMcp,
    removeAgyMcp,
    loadAgyPlugins,
    installAgyPlugin,
    toggleAgyPlugin,
    uninstallAgyPlugin,
  } from '../../lib/agy/settings.svelte.js';

  // admin：是不是主机管理员。MCP 服务器与 CLI 插件管的是主机上 agy 的全局配置，注册成员不出这两块
  const { fl = () => false, admin = true } = $props();

  const svgOf = (name, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;

  let mcpAdding = $state(false);
  let mcpName = $state('');
  let mcpCmd = $state('');
  let mcpArgs = $state('');
  let mcpEnv = $state('');

  let pluginTarget = $state('');

  const bt = $derived(agyPrefs.settings.bridgeTools || {});
  const phonePluginEnabled = $derived(Boolean(pluginOn('phone-files') && agyPrefs.phonePluginOn !== false));

  function toggleBridgeCategory(field, value) {
    return patchAgySettings({ bridgeTools: { [field]: Boolean(value) } }, 'bridgeTools');
  }

  async function submitAddMcp(ev) {
    ev?.preventDefault?.();
    if (!mcpName.trim() || !mcpCmd.trim() || agyPrefs.busy === 'mcp:add') return;
    const ok = await addAgyMcp({
      name: mcpName,
      command: mcpCmd,
      argsText: mcpArgs,
      envText: mcpEnv,
    });
    if (ok) {
      mcpName = '';
      mcpCmd = '';
      mcpArgs = '';
      mcpEnv = '';
      mcpAdding = false;
    }
  }

  async function askRemoveMcp(item) {
    const ok = await uiConfirm(t('删除 MCP 服务器「{name}」？', { name: item.name }), {
      detail: t('将从本机 Antigravity 的 MCP 配置中移除该服务，新开启的会话不再挂载它。'),
      okLabel: t('删除'),
      danger: true,
    });
    if (ok) await removeAgyMcp(item.name);
  }

  async function submitInstallPlugin(ev) {
    ev?.preventDefault?.();
    if (!pluginTarget.trim() || agyPrefs.busy === 'plg:install') return;
    const ok = await installAgyPlugin(pluginTarget);
    if (ok) pluginTarget = '';
  }

  async function askUninstallPlugin(item) {
    const ok = await uiConfirm(t('卸载插件「{name}」？', { name: item.name }), {
      detail: t('卸载后 Antigravity CLI 将移除该插件文件及配置。'),
      okLabel: t('卸载'),
      danger: true,
    });
    if (ok) await uninstallAgyPlugin(item.name);
  }
</script>

<DGroup
  label={t('Bridge 工具协同')}
  foot={t('仅在 Bridge 发起的 Antigravity 会话中按需挂载，不改动本机 ~/.gemini/config/mcp_config.json。媒体生成同时受「设置 › Media Studio › 允许的 agent」控制。')}
>
  <div class="drow cr" class:hl={fl('ag-bridge-tools')}>
    <span class="cr-tx">
      <span class="cr-t">{t('允许 Antigravity 使用 Bridge 工具')}</span>
      <span class="cr-s">{t('为会话挂上 bridge 的原生工具：媒体生成、界面协同、手机文件、侧边浏览器、共享终端、工作区、bridge 操作、电脑与图表')}</span>
      {#if agyPrefs.errors.bridgeTools}<span class="cr-s bad">{agyPrefs.errors.bridgeTools}</span>{/if}
    </span>
    <span class="cr-tr">
      <DSwitch
        checked={bt.enabled !== false}
        disabled={agyPrefs.busy === 'bridgeTools'}
        onchange={(v) => toggleBridgeCategory('enabled', v)}
      />
    </span>
  </div>

  {#if bt.enabled !== false}
    <div class="drow cr">
      <span class="cr-tx">
        <span class="cr-t">{t('媒体生成')}</span>
        <span class="cr-s">{t('调用 Media Studio 生成图片、视频、配音与音乐，并保存到当前会话工作空间')}</span>
      </span>
      <span class="cr-tr">
        <DSwitch
          checked={bt.media !== false}
          disabled={agyPrefs.busy === 'bridgeTools'}
          onchange={(v) => toggleBridgeCategory('media', v)}
        />
      </span>
    </div>

    <div class="drow cr">
      <span class="cr-tx">
        <span class="cr-t">{t('界面协同')}</span>
        <span class="cr-s">{t('查看当前打开的 Bridge 页面，按你的要求跳转到文件预览或弹出轻量提示')}</span>
      </span>
      <span class="cr-tr">
        <DSwitch
          checked={bt.ui !== false}
          disabled={agyPrefs.busy === 'bridgeTools'}
          onchange={(v) => toggleBridgeCategory('ui', v)}
        />
      </span>
    </div>

    <div class="drow cr">
      <span class="cr-tx">
        <span class="cr-t">{t('手机文件收发')}</span>
        <span class="cr-s">
          {phonePluginEnabled
            ? t('在手机 App 发起的对话中浏览、读写或扫描手机已授权文件夹')
            : t('需先在「扩展 › 功能扩展」中开启「手机文件」插件后才会挂载')}
        </span>
      </span>
      <span class="cr-tr">
        <DSwitch
          checked={phonePluginEnabled && bt.phoneFiles !== false}
          disabled={!phonePluginEnabled || agyPrefs.busy === 'bridgeTools'}
          onchange={(v) => toggleBridgeCategory('phoneFiles', v)}
        />
      </span>
    </div>

    {#each AGY_HUB_TOOL_ROWS as row (row.key)}
      {@const avail = !row.plugin || pluginOn(row.plugin)}
      <div class="drow cr">
        <span class="cr-tx">
          <span class="cr-t">{row.title}</span>
          <span class="cr-s">{avail ? row.desc : t('需先在「扩展 › 功能扩展」中开启对应插件')}</span>
        </span>
        <span class="cr-tr">
          <DSwitch
            checked={avail && bt[row.key] !== false}
            disabled={!avail || agyPrefs.busy === 'bridgeTools'}
            onchange={(v) => toggleBridgeCategory(row.key, v)}
          />
        </span>
      </div>
    {/each}
  {/if}
</DGroup>

{#if admin}
<div class="ghd" class:hl-line={fl('ag-mcp')}>
  <h3>{t('MCP 服务器')}</h3>
  <button
    type="button"
    class="ico-btn"
    class:busy={agyPrefs.mcp.loading}
    disabled={agyPrefs.mcp.loading}
    onclick={() => loadAgyMcp()}
    title={t('刷新')}
    aria-label={t('刷新')}
  >{@html svgOf('refresh', 1.8)}</button>
</div>
<DGroup foot={t('包装 agy mcp 命令读写本机配置，修改对后续新建或重挂载的会话生效。')}>
  {#if agyPrefs.mcp.parseError}
    <div class="drow cr dsp">
      <span class="cr-tx">
        <span class="cr-t">{t('未能结构化解析 CLI 输出，以下为原始返回内容')}</span>
      </span>
      <pre class="raw-box sel-text">{agyPrefs.mcp.rawOutput}</pre>
    </div>
  {:else if agyPrefs.mcp.items.length === 0}
    <DRow title={agyPrefs.mcp.loading ? t('读取中…') : t('尚未配置 MCP 服务器')} />
  {:else}
    {#each agyPrefs.mcp.items as item (item.name)}
      <div class="drow cr">
        <span class="cr-tx">
          <span class="cr-t">
            <b>{item.name}</b>
            <span class="pill">{item.type}</span>
            {#if item.envKeys?.length}
              <span class="pill">env: {item.envKeys.join(', ')}</span>
            {/if}
          </span>
          <span class="cr-s mono">{item.target}</span>
        </span>
        <span class="cr-tr">
          <DSwitch
            checked={item.enabled}
            disabled={agyPrefs.busy === 'mcp:' + item.name}
            onchange={(v) => toggleAgyMcp(item.name, v)}
          />
          <button
            type="button"
            class="ico-btn danger"
            disabled={agyPrefs.busy === 'mcp:' + item.name}
            onclick={() => askRemoveMcp(item)}
            title={t('删除')}
            aria-label={t('删除')}
          >{@html svgOf('trash', 1.7)}</button>
        </span>
      </div>
    {/each}
  {/if}

  {#if agyPrefs.errors.mcp}
    <div class="drow cr"><span class="cr-s bad">{agyPrefs.errors.mcp}</span></div>
  {/if}

  {#if !mcpAdding}
    <button type="button" class="drow addrow" onclick={() => { mcpAdding = true; }}>
      {@html svgOf('plus', 1.8)}{t('添加 MCP 服务器')}
    </button>
  {:else}
    <form class="drow cr dsp mcp-form" onsubmit={submitAddMcp}>
      <div class="form-grid">
        <label class="fld">
          <span>{t('名称')}</span>
          <DField bind:value={mcpName} placeholder="filesystem" width="100%" />
        </label>
        <label class="fld">
          <span>{t('命令或 HTTP 地址')}</span>
          <DField bind:value={mcpCmd} placeholder={t('npx 或 https://example.com/mcp')} width="100%" />
        </label>
        <label class="fld full">
          <span>{t('参数（空格分隔，含空格参数可加引号）')}</span>
          <DField bind:value={mcpArgs} placeholder="-y @modelcontextprotocol/server-filesystem E:\work" width="100%" />
        </label>
        <label class="fld full">
          <span>{t('环境变量（可选，每行 KEY=VALUE）')}</span>
          <textarea
            rows="2"
            bind:value={mcpEnv}
            placeholder="API_KEY=your_key_here"
          ></textarea>
        </label>
      </div>
      {#if agyPrefs.errors.mcpAdd}
        <span class="cr-s bad">{agyPrefs.errors.mcpAdd}</span>
      {/if}
      <div class="form-acts">
        <DButton size="sm" onclick={() => { mcpAdding = false; }}>{t('取消')}</DButton>
        <DButton
          type="submit"
          size="sm"
          variant="primary"
          disabled={!mcpName.trim() || !mcpCmd.trim() || agyPrefs.busy === 'mcp:add'}
        >{agyPrefs.busy === 'mcp:add' ? t('添加中…') : t('保存添加')}</DButton>
      </div>
    </form>
  {/if}
</DGroup>

<div class="ghd" class:hl-line={fl('ag-plugins')}>
  <h3>{t('CLI 插件')}</h3>
  <button
    type="button"
    class="ico-btn"
    class:busy={agyPrefs.plugins.loading}
    disabled={agyPrefs.plugins.loading}
    onclick={() => loadAgyPlugins()}
    title={t('刷新')}
    aria-label={t('刷新')}
  >{@html svgOf('refresh', 1.8)}</button>
</div>
<DGroup foot={t('包装 agy plugin 命令管理已安装的本地或市场插件。')}>
  {#if agyPrefs.plugins.parseError}
    <div class="drow cr dsp">
      <span class="cr-tx">
        <span class="cr-t">{t('未能结构化解析插件列表，以下为原始返回内容')}</span>
      </span>
      <pre class="raw-box sel-text">{agyPrefs.plugins.rawOutput}</pre>
    </div>
  {:else if agyPrefs.plugins.items.length === 0}
    <DRow title={agyPrefs.plugins.loading ? t('读取中…') : t('尚未安装任何插件')} />
  {:else}
    {#each agyPrefs.plugins.items as plg (plg.name)}
      <div class="drow cr">
        <span class="cr-tx">
          <span class="cr-t">
            <b>{plg.name}</b>
            {#if plg.version}<span class="pill">v{plg.version}</span>{/if}
            {#if plg.source}<span class="pill">{plg.source}</span>{/if}
          </span>
          {#if plg.path}<span class="cr-s mono">{plg.path}</span>{/if}
        </span>
        <span class="cr-tr">
          <DSwitch
            checked={plg.enabled}
            disabled={agyPrefs.busy === 'plg:' + plg.name}
            onchange={(v) => toggleAgyPlugin(plg.name, v)}
          />
          <button
            type="button"
            class="ico-btn danger"
            disabled={agyPrefs.busy === 'plg:' + plg.name}
            onclick={() => askUninstallPlugin(plg)}
            title={t('卸载')}
            aria-label={t('卸载')}
          >{@html svgOf('trash', 1.7)}</button>
        </span>
      </div>
    {/each}
  {/if}

  <form class="drow cr" onsubmit={submitInstallPlugin}>
    <span class="cr-tx">
      <DField bind:value={pluginTarget} placeholder={t('输入插件目录路径或名称（如 plugin@marketplace）')} width="100%" />
      {#if agyPrefs.errors.plugins}<span class="cr-s bad">{agyPrefs.errors.plugins}</span>{/if}
    </span>
    <span class="cr-tr">
      <DButton type="submit" size="sm" disabled={!pluginTarget.trim() || agyPrefs.busy === 'plg:install'}>
        {agyPrefs.busy === 'plg:install' ? t('安装中…') : t('安装')}
      </DButton>
    </span>
  </form>
</DGroup>
{/if}

<style>
  @import './kit.css';
  .cr { display: flex; align-items: center; gap: var(--dsk-s3); width: 100%; position: relative; font-family: var(--dsk-font); color: var(--dsk-ink); }
  .cr.dsp { flex-wrap: wrap; align-items: flex-start; row-gap: 8px; padding-bottom: 12px; }
  .cr-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .cr-t { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; font-size: var(--dsk-fs-body); line-height: 1.35; }
  .cr-s { font-size: var(--dsk-fs-sm); line-height: 1.35; color: var(--dsk-ink-3); }
  .cr-s.mono { font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace); font-size: 12px; overflow-wrap: anywhere; }
  .cr-s.bad { color: var(--dsk-crit); }
  .cr-tr { flex: none; display: inline-flex; align-items: center; gap: var(--dsk-s2); }
  .pill { padding: 0 6px; border-radius: 5px; font-size: 10.5px; line-height: 17px; font-weight: 600; color: var(--dsk-ink-2); box-shadow: inset 0 0 0 1px var(--dsk-line-strong); }
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
  .mcp-form { flex-direction: column; align-items: stretch; }
  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1.4fr;
    gap: 8px 10px;
    width: 100%;
  }
  .fld { display: flex; flex-direction: column; gap: 4px; font-size: var(--dsk-fs-sm); color: var(--dsk-ink-2); }
  .fld.full { grid-column: 1 / -1; }
  .fld textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 7px 9px;
    border: none;
    border-radius: var(--dsk-r-sm);
    background: var(--dsk-panel);
    box-shadow: 0 0 0 1px var(--dsk-line);
    font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace);
    font-size: 12px;
    color: var(--dsk-ink);
    resize: vertical;
  }
  .fld textarea:focus { outline: none; box-shadow: var(--dsk-focus); }
  .form-acts { display: flex; justify-content: flex-end; gap: 8px; width: 100%; padding-top: 2px; }
</style>
