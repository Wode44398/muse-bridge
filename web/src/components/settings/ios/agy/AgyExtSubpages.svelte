<script>
  import { AGY_HUB_TOOL_ROWS } from '../../../../lib/agy/hub-tool-rows.js';
  // 手机 / 网页设置（iOS 外壳）› Antigravity 的 MCP 服务器与 CLI 插件管理子页。
  import Toggle from '../../../ios27/Toggle.svelte';
  import { uiConfirm } from '../../../../lib/dialogs.js';
  import { pluginOn } from '../../../../lib/state.svelte.js';
  import { SI } from '../../../../lib/settingsIcons.js';
  import { t } from '../../../../lib/i18n.js';
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
  } from '../../../../lib/agy/settings.svelte.js';

  let { pid = '', push, pop } = $props();

  const svgOf = (name, w = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;

  let mcpName = $state('');
  let mcpCmd = $state('');
  let mcpArgs = $state('');
  let mcpEnv = $state('');
  let pluginTarget = $state('');

  const bt = $derived(agyPrefs.settings.bridgeTools || {});
  const phonePluginEnabled = $derived(Boolean(pluginOn('phone-files') && agyPrefs.phonePluginOn !== false));

  function toggleBridgeCategory(field, nextVal) {
    return patchAgySettings({ bridgeTools: { [field]: Boolean(nextVal) } }, 'bridgeTools');
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
      pop?.();
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

{#if pid === 'agy:bridge-tools'}
  <div class="ig">
    <div class="r">
      <span class="r-main">
        <span class="r-tx">
          <span>{t('允许 Antigravity 使用 Bridge 工具')}</span>
          <span class="r-sub">{t('仅向 Bridge 发起的会话按需挂载，不改动本机全局 MCP 配置')}</span>
        </span>
        <Toggle
          checked={bt.enabled !== false}
          disabled={agyPrefs.busy === 'bridgeTools'}
          onchange={() => toggleBridgeCategory('enabled', bt.enabled === false)}
          label={t('允许 Antigravity 使用 Bridge 工具')}
        />
      </span>
    </div>
  </div>

  {#if bt.enabled !== false}
    <h2 class="ghead">{t('允许的工具类别')}</h2>
    <div class="ig">
      <div class="r">
        <span class="r-main">
          <span class="r-tx">
            <span>{t('媒体生成')}</span>
            <span class="r-sub">{t('图片、视频、配音与音乐（Media Studio）')}</span>
          </span>
          <Toggle
            checked={bt.media !== false}
            disabled={agyPrefs.busy === 'bridgeTools'}
            onchange={() => toggleBridgeCategory('media', bt.media === false)}
            label={t('媒体生成')}
          />
        </span>
      </div>
      <div class="r">
        <span class="r-main">
          <span class="r-tx">
            <span>{t('界面协同')}</span>
            <span class="r-sub">{t('查看当前页面、按要求跳转预览与轻量提示')}</span>
          </span>
          <Toggle
            checked={bt.ui !== false}
            disabled={agyPrefs.busy === 'bridgeTools'}
            onchange={() => toggleBridgeCategory('ui', bt.ui === false)}
            label={t('界面协同')}
          />
        </span>
      </div>
      <div class="r">
        <span class="r-main">
          <span class="r-tx">
            <span>{t('手机文件收发')}</span>
            <span class="r-sub">
              {phonePluginEnabled
                ? t('访问发起对话的手机上已授权的文件夹')
                : t('需先在「扩展 › 功能扩展」中开启「手机文件」插件')}
            </span>
          </span>
          <Toggle
            checked={phonePluginEnabled && bt.phoneFiles !== false}
            disabled={!phonePluginEnabled || agyPrefs.busy === 'bridgeTools'}
            onchange={() => toggleBridgeCategory('phoneFiles', bt.phoneFiles === false)}
            label={t('手机文件收发')}
          />
        </span>
      </div>
      {#each AGY_HUB_TOOL_ROWS as row (row.key)}
        {@const avail = !row.plugin || pluginOn(row.plugin)}
        <div class="r">
          <span class="r-main">
            <span class="r-tx">
              <span>{row.title}</span>
              <span class="r-sub">{avail ? row.desc : t('需先在「扩展 › 功能扩展」中开启对应插件')}</span>
            </span>
            <Toggle
              checked={avail && bt[row.key] !== false}
              disabled={!avail || agyPrefs.busy === 'bridgeTools'}
              onchange={() => toggleBridgeCategory(row.key, bt[row.key] === false)}
              label={row.title}
            />
          </span>
        </div>
      {/each}
    </div>
  {/if}
  {#if agyPrefs.errors.bridgeTools}<p class="gfoot err">{agyPrefs.errors.bridgeTools}</p>{/if}
  <p class="gfoot">{t('媒体生成同时受管理员在「设置 › Media Studio › 允许的 agent」中的开关控制。')}</p>

{:else if pid === 'agy:mcp'}
  <div class="ghead-row">
    <h2 class="ghead">{t('已配置的服务器')}</h2>
    <button
      class="gh-ico"
      class:busy={agyPrefs.mcp.loading}
      type="button"
      disabled={agyPrefs.mcp.loading}
      onclick={() => loadAgyMcp()}
      aria-label={t('刷新')}
    >{@html svgOf('refresh', 1.8)}</button>
  </div>

  {#if agyPrefs.mcp.parseError}
    <div class="ig raw-card">
      <div class="raw-note">{t('未能结构化解析 CLI 输出，以下为原始返回内容')}</div>
      <pre class="raw-pre">{agyPrefs.mcp.rawOutput}</pre>
    </div>
  {:else if agyPrefs.mcp.items.length === 0}
    <div class="ig">
      <div class="r">
        <span class="r-main">
          <span class="r-tx dim-tx">{agyPrefs.mcp.loading ? t('读取中…') : t('尚未配置 MCP 服务器')}</span>
        </span>
      </div>
    </div>
  {:else}
    <div class="ig">
      {#each agyPrefs.mcp.items as item (item.name)}
        <div class="r ext-row">
          <span class="r-main">
            <span class="r-tx">
              <span class="acct-name">
                <b>{item.name}</b>
                <span class="pill">{item.type}</span>
                {#if item.envKeys?.length}<span class="pill">env: {item.envKeys.join(', ')}</span>{/if}
              </span>
              <span class="r-sub dm-path">{item.target}</span>
            </span>
            <span class="ext-acts">
              <Toggle
                checked={item.enabled}
                disabled={agyPrefs.busy === 'mcp:' + item.name}
                onchange={() => toggleAgyMcp(item.name, !item.enabled)}
                label={item.name}
              />
              <span class="dv-minis">
                <button
                  type="button"
                  class="red"
                  disabled={agyPrefs.busy === 'mcp:' + item.name}
                  onclick={() => askRemoveMcp(item)}
                >{t('删除')}</button>
              </span>
            </span>
          </span>
        </div>
      {/each}
    </div>
  {/if}

  {#if agyPrefs.errors.mcp}<p class="gfoot err">{agyPrefs.errors.mcp}</p>{/if}

  <div class="ig">
    <button class="r" type="button" onclick={() => push?.('agy:mcp-add', t('添加 MCP 服务器'))}>
      <span class="r-main center"><span class="r-tx accent">{t('添加 MCP 服务器')}</span></span>
    </button>
  </div>
  <p class="gfoot">{t('包装 agy mcp 命令读写本机配置，修改对后续新建或重挂载的会话生效。')}</p>

{:else if pid === 'agy:mcp-add'}
  <form onsubmit={submitAddMcp}>
    <h2 class="ghead">{t('基本连接参数')}</h2>
    <div class="ig">
      <div class="r">
        <span class="r-main">
          <input
            class="dv-in"
            bind:value={mcpName}
            placeholder={t('名称（如 filesystem）')}
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
          />
        </span>
      </div>
      <div class="r">
        <span class="r-main">
          <input
            class="dv-in"
            bind:value={mcpCmd}
            placeholder={t('命令或 HTTP 地址（如 npx）')}
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
          />
        </span>
      </div>
      <div class="r">
        <span class="r-main">
          <input
            class="dv-in"
            bind:value={mcpArgs}
            placeholder={t('参数（如 -y @modelcontextprotocol/server-filesystem E:\\work）')}
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
          />
        </span>
      </div>
    </div>

    <h2 class="ghead">{t('环境变量（可选，每行 KEY=VALUE）')}</h2>
    <div class="ig env-card">
      <textarea
        class="env-area"
        rows="3"
        bind:value={mcpEnv}
        placeholder="API_KEY=your_key_here"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
      ></textarea>
    </div>

    {#if agyPrefs.errors.mcpAdd}<p class="gfoot err">{agyPrefs.errors.mcpAdd}</p>{/if}

    <div class="ig">
      <button
        class="r"
        type="submit"
        disabled={!mcpName.trim() || !mcpCmd.trim() || agyPrefs.busy === 'mcp:add'}
      >
        <span class="r-main center">
          <span class="r-tx accent">{agyPrefs.busy === 'mcp:add' ? t('添加中…') : t('保存添加')}</span>
        </span>
      </button>
    </div>
  </form>

{:else if pid === 'agy:plugins'}
  <div class="ghead-row">
    <h2 class="ghead">{t('已安装的插件')}</h2>
    <button
      class="gh-ico"
      class:busy={agyPrefs.plugins.loading}
      type="button"
      disabled={agyPrefs.plugins.loading}
      onclick={() => loadAgyPlugins()}
      aria-label={t('刷新')}
    >{@html svgOf('refresh', 1.8)}</button>
  </div>

  {#if agyPrefs.plugins.parseError}
    <div class="ig raw-card">
      <div class="raw-note">{t('未能结构化解析插件列表，以下为原始返回内容')}</div>
      <pre class="raw-pre">{agyPrefs.plugins.rawOutput}</pre>
    </div>
  {:else if agyPrefs.plugins.items.length === 0}
    <div class="ig">
      <div class="r">
        <span class="r-main">
          <span class="r-tx dim-tx">{agyPrefs.plugins.loading ? t('读取中…') : t('尚未安装任何插件')}</span>
        </span>
      </div>
    </div>
  {:else}
    <div class="ig">
      {#each agyPrefs.plugins.items as plg (plg.name)}
        <div class="r ext-row">
          <span class="r-main">
            <span class="r-tx">
              <span class="acct-name">
                <b>{plg.name}</b>
                {#if plg.version}<span class="pill">v{plg.version}</span>{/if}
                {#if plg.source}<span class="pill">{plg.source}</span>{/if}
              </span>
              {#if plg.path}<span class="r-sub dm-path">{plg.path}</span>{/if}
            </span>
            <span class="ext-acts">
              <Toggle
                checked={plg.enabled}
                disabled={agyPrefs.busy === 'plg:' + plg.name}
                onchange={() => toggleAgyPlugin(plg.name, !plg.enabled)}
                label={plg.name}
              />
              <span class="dv-minis">
                <button
                  type="button"
                  class="red"
                  disabled={agyPrefs.busy === 'plg:' + plg.name}
                  onclick={() => askUninstallPlugin(plg)}
                >{t('卸载')}</button>
              </span>
            </span>
          </span>
        </div>
      {/each}
    </div>
  {/if}

  <h2 class="ghead">{t('从名称 / 地址安装')}</h2>
  <form onsubmit={submitInstallPlugin}>
    <div class="ig">
      <div class="r">
        <span class="r-main">
          <input
            class="dv-in"
            bind:value={pluginTarget}
            placeholder={t('输入插件目录路径或名称（如 plugin@marketplace）')}
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
          />
        </span>
      </div>
      <button
        class="r"
        type="submit"
        disabled={!pluginTarget.trim() || agyPrefs.busy === 'plg:install'}
      >
        <span class="r-main center">
          <span class="r-tx accent">{agyPrefs.busy === 'plg:install' ? t('安装中…') : t('安装')}</span>
        </span>
      </button>
    </div>
  </form>
  {#if agyPrefs.errors.plugins}<p class="gfoot err">{agyPrefs.errors.plugins}</p>{/if}
  <p class="gfoot">{t('包装 agy plugin 命令管理已安装的本地或市场插件。')}</p>
{/if}

<style>
  @import '../kit.css';
  .dim-tx { color: var(--i-label2); }
  .ext-row .r-main { align-items: center; gap: 10px; }
  .ext-acts { flex: none; display: inline-flex; align-items: center; gap: 8px; }
  .raw-card { padding: 12px 16px; }
  .raw-note { font-size: 13px; color: var(--i-label2); margin-bottom: 6px; }
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
  .env-card { padding: 10px 14px; }
  .env-area {
    width: 100%;
    box-sizing: border-box;
    border: 0;
    background: transparent;
    color: var(--i-label);
    font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace);
    font-size: 13px;
    line-height: 1.45;
    resize: vertical;
    outline: none;
  }
</style>
