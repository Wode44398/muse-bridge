<script>
  // 模型中心 › Vertex：Google Vertex AI 上的 Gemini 对话模型给 Claude 和 dimensio 用。
  // 项目与凭据是主机那一份 Google 云凭据（Media Studio 的 vertex 服务也用它）：卡片直接嵌在这里，关了 Media Studio 照样能配。
  // 卡片自己保存（即时生效、顺手测一次）；底栏的「保存」只管开不开、给谁、共不共享给成员、列哪些型号。
  // v2 起挂在 HubOverlays 的浮层外框里（标题栏、关闭、未保存确认归外框）；令牌（--st-* / --pm-*）由外框定义。
  import SToggle from '../settings/SToggle.svelte';
  import AgentStack from './AgentStack.svelte';
  import VertexCredentials from './VertexCredentials.svelte';
  import BuiltinModels from './BuiltinModels.svelte';
  import { hub, hubPost, loadHub } from '../../lib/modelHub.svelte.js';
  import { cp, loadProviders, canUseCustomApi } from '../../lib/claudeProviders.svelte.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t } from '../../lib/i18n.js';

  let { onClose, dirtyOut = $bindable(false) } = $props();

  const v0 = hub.vertex || { enabled: true, agents: [], members: false, models: [], known: [], configured: false };
  // 「共享给成员」只有多用户服务器的管理员有（cp.canShare，随 Claude 服务的配置下发，同 HsConn）：还没拉过就拉一次
  if (!cp.ok && canUseCustomApi()) loadProviders();
  // 凭据卡里刚填上 / 清掉项目时，总览会重拉：「配好没」跟着它走，别停在打开时的快照上
  const configured = $derived(!!hub.vertex?.configured);
  let enabled = $state(v0.enabled);
  let members = $state(v0.members === true);
  let agents = $state([...v0.agents]);
  let models = $state([...v0.models]);
  // Vertex 上的图像 / 视频 / 配音 / 音乐模型：数据在 Media Studio 的 vertex 服务里（同一份 Google 云凭据），这里直接开关（2026-11-13 统一入口）
  const media = (hub.builtins || []).filter((b) => b.dialect === 'vertex');
  let mediaOn = $state(Object.fromEntries(media.map((b) => [b.id, Object.fromEntries((b.models || []).map((m) => [m.id, m.enabled !== false]))])));
  let newModel = $state('');
  let saving = $state(false);
  let err = $state('');

  const snap = () => JSON.stringify({ enabled, members, agents: [...agents].sort(), models, mediaOn });
  let base = $state(snap());
  const mediaBase = JSON.stringify(mediaOn);
  $effect(() => { dirtyOut = snap() !== base; });

  const known = $derived(v0.known || []);
  const extra = $derived(models.filter((id) => !known.some((k) => k.id === id)));
  const toggleAgent = (a) => { agents = agents.includes(a) ? agents.filter((x) => x !== a) : [...agents, a]; };
  const toggleModel = (id) => { models = models.includes(id) ? models.filter((x) => x !== id) : [...models, id]; };
  function addModel() {
    const id = newModel.trim();
    newModel = '';
    if (!id || /\s/.test(id) || models.includes(id)) return;
    models = [...models, id];
  }
  let importing = $state(false);
  let impMsg = $state('');
  async function importMedia() {
    if (importing) return;
    importing = true; impMsg = '';
    try {
      const r = await hubPost('builtin/import', {});
      const g = (r.items || []).find((x) => x.id === 'google');
      // 加上了：总览已重拉，这张面板关掉重开才拿得到新的媒体模型清单（打开时取的快照）
      if (g?.ok) { showToast(t('已加上')); onClose?.(); }
      else impMsg = g?.reason || t('没加上');
    } catch (e) { impMsg = e.message || t('没加上'); }
    importing = false;
  }
  async function save() {
    if (saving) return;
    saving = true; err = '';
    try {
      await hubPost('vertex', { enabled, agents, models, ...(cp.canShare ? { members } : {}) });
      // 媒体模型有改动才写 Studio 那边（共享给成员两边一个开关）
      const before = JSON.parse(mediaBase);
      for (const b of media) {
        const changedMedia = JSON.stringify(mediaOn[b.id]) !== JSON.stringify(before[b.id]);
        const sharedDiff = cp.canShare && (b.shared === true) !== members;
        if (changedMedia || sharedDiff) await hubPost('builtin', { id: b.id, models: mediaOn[b.id], ...(cp.canShare ? { shared: members } : {}) });
      }
      base = snap(); dirtyOut = false; showToast(t('已保存')); onClose?.();
    }
    catch (e) { err = e.message || t('没保存上'); }
    saving = false;
  }
</script>

<div class="body">
  <!-- 凭据卡：没配好时它自己就是上传框 + 项目 ID；配好了收成「来源 + 更换凭据」一行。存完重拉总览，configured 跟着变 -->
  <div class="vxwrap"><VertexCredentials onchange={() => loadHub(true)} /></div>
  {#if !configured}<p class="hint">{t('填好项目 ID 并保存凭据后，这里的型号才会出现在 Claude 和 dimensio 里')}</p>{/if}

  <!-- 开关行与服务浮层的连接面板（HsConn .sw）同款：宽屏标签贴着自己的开关（点标签也能拨），窄屏一行、开关靠右 -->
  <div class="togs">
    <label class="tog">
      <span class="tog-l">{t('启用')}</span>
      <SToggle checked={enabled} onchange={(v) => (enabled = v)} label={t('启用 Vertex')} />
    </label>
    {#if cp.canShare}
      <!-- 成员用的是主机这份 Google 云账号（费用记在主机的项目上）：默认不共享 -->
      <label class="tog">
        <span class="tog-l">{t('共享给成员')}</span>
        <SToggle checked={members} onchange={(v) => (members = v)} label={t('共享给成员')} />
      </label>
    {/if}
  </div>

  <section>
    <div class="fl">{t('提供给')}</div>
    <div class="checks">
      {#each [['claude', 'Claude'], ['dimensio', 'dimensio']] as [a, name] (a)}
        <!-- 与服务浮层操作条的去向片（HsBar .dest）同一个概念、同一副长相：勾选框 + agent 标 + 名字 -->
        <button type="button" class="chk" class:on={agents.includes(a)} aria-pressed={agents.includes(a)} onclick={() => toggleAgent(a)}>
          <span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg></span>
          <AgentStack agents={[a]} size={16} quiet />
          <span class="chk-n">{name}</span>
        </button>
      {/each}
    </div>
  </section>

  <section>
    <div class="fl">{t('型号')}</div>
    <div class="mlist">
      {#each known as k (k.id)}
        <button type="button" class="mrow" class:on={models.includes(k.id)} aria-pressed={models.includes(k.id)} onclick={() => toggleModel(k.id)}>
          <span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg></span>
          <span class="m-tx"><span class="m-n">{k.label}</span><span class="m-id">{k.id}</span></span>
        </button>
      {/each}
      {#each extra as id (id)}
        <button type="button" class="mrow on" aria-pressed="true" onclick={() => toggleModel(id)}>
          <span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg></span>
          <span class="m-tx"><span class="m-n">{id}</span></span>
        </button>
      {/each}
    </div>
    <form class="addm" onsubmit={(e) => { e.preventDefault(); addModel(); }}>
      <input class="in mono" bind:value={newModel} placeholder={t('别的 Vertex 型号 ID，回车添加')} spellcheck="false" autocapitalize="off" aria-label={t('型号 ID')} />
    </form>
  </section>

  {#if hub.builtins && !media.length}
    <!-- Studio 里还没有 Vertex 的媒体服务（没导入过）：凭据配好以后一键加上，数据落在 Studio、这里管开关 -->
    <div class="mhead">{t('媒体模型')}<span class="mhint">{t('图像、视频、配音、音乐模型给 Media Studio 用')}</span></div>
    <div class="mimp">
      <button type="button" class="btn" class:busy={importing} disabled={importing || !configured} onclick={importMedia}>{importing ? t('正在加…') : t('加上 Vertex 的媒体模型')}</button>
      {#if impMsg}<span class="imsg">{impMsg}</span>{/if}
    </div>
  {/if}
  {#each media as b (b.id)}
    <!-- 媒体模型给 Media Studio（图像 / 视频 / 配音 / 音乐），按种类分组 -->
    <div class="mhead">{t('媒体模型')}<span class="mhint">{t('打开的模型会出现在 Media Studio 里')}</span></div>
    <BuiltinModels models={b.models || []} bind:on={mediaOn[b.id]} />
  {/each}
</div>

<footer class="bar">
  {#if err}<span class="err">{err}</span>{/if}
  <span class="sp"></span>
  <!-- busy：保存中虽然点不了，但不是「不可用」——保持墨色，别跟着禁用态变灰 -->
  <button type="button" class="btn primary" class:busy={saving} disabled={saving || !dirtyOut || !models.length} onclick={save}>{saving ? t('保存中…') : t('保存')}</button>
</footer>

<style>
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 28px 28px; display: flex; flex-direction: column; gap: 22px; }
  /* 凭据卡读 --i-* 令牌：映射到浮层的 --st-*（同 Studio 服务管理器的 .vxwrap） */
  .vxwrap { --i-card: var(--st-seg); --i-label: var(--text); --i-label2: var(--st-muted); --i-label3: var(--st-muted);
    --i-sep: var(--st-line); --i-accent: var(--st-accent); --i-on-accent: var(--st-primary-ink); --i-fill3: var(--st-seg); --i-bg: var(--st-field);
    --i-ok: #3fa46a; --i-red: #d9534f; }
  .vxwrap:empty { display: none; }
  .hint { margin: -12px 2px 0; font-size: 12.5px; line-height: 1.5; color: var(--st-muted); }
  .togs { display: flex; flex-wrap: wrap; gap: 8px 28px; }
  /* 字段标签与服务浮层的连接面板（HsConn）同款：12.5 / 600 / 次要色 */
  .fl { margin: 0 0 7px 2px; font-size: 12.5px; font-weight: 600; color: var(--st-text2); }
  .tog { align-self: flex-start; display: flex; align-items: center; gap: 12px; min-height: 36px; cursor: pointer; }
  .tog-l { font-size: 13.5px; color: var(--text); user-select: none; -webkit-user-select: none; }
  .checks { display: flex; flex-wrap: wrap; gap: 8px; }
  /* 去向勾选片：长相与操作条的去向片（HsBar .dest）一致——内描线，勾上 = 选中底 + 1.5px 墨线 */
  .chk { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px 0 11px; border: 0; border-radius: 10px; background: transparent; color: var(--text);
    box-shadow: inset 0 0 0 1px var(--st-line); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
    transition: box-shadow var(--mo-micro, 140ms) var(--ea-fade, ease), background-color var(--mo-micro, 140ms) var(--ea-fade, ease), transform var(--mo-tap, 90ms) var(--ea-std, ease); }
  @media (hover: hover) { .chk:hover:not(.on) { background: var(--st-hover); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 22%, transparent); } }
  .chk.on { background: var(--st-sel); box-shadow: inset 0 0 0 1.5px var(--text); }
  .chk:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .chk-n { white-space: nowrap; }
  .box { width: 18px; height: 18px; flex: none; display: grid; place-items: center; box-sizing: border-box; border-radius: 5px; border: 1.5px solid var(--st-muted); color: transparent;
    transition: background-color var(--mo-micro, 140ms) var(--ea-fade, ease), border-color var(--mo-micro, 140ms) var(--ea-fade, ease); }
  .box svg { width: 12px; height: 12px; }
  .on > .box { background: var(--st-primary); border-color: var(--st-primary); color: var(--st-primary-ink); }
  .mlist { border: 1px solid var(--st-line); border-radius: 14px; overflow: hidden; background: var(--st-surface); }
  .mrow { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 8px 14px; border: 0; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
  @media (hover: hover) { .mrow:hover { background: var(--st-hover); } }
  .mrow:focus-visible { outline: none; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--text) 35%, transparent); }
  .mrow + .mrow::before { content: ''; position: absolute; top: 0; left: 44px; right: 0; height: 1px; background: var(--st-hair); }
  .m-tx { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .m-n { font-size: 14px; font-weight: 500; }
  .m-id { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; color: var(--st-muted); }
  .addm { margin-top: 10px; }
  .mhead { display: flex; flex-direction: column; gap: 2px; margin: 6px 2px -10px; font-size: 14px; font-weight: 600; color: var(--text); }
  .mhint { font-size: 12.5px; font-weight: 400; color: var(--st-muted); }
  .mimp { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
  .imsg { font-size: 13px; color: var(--st-muted); }
  .in { width: 100%; height: 38px; padding: 0 12px; border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-field); color: var(--text); font: inherit; font-size: 14px; outline: none; }
  .in:focus { border-color: color-mix(in srgb, var(--text) 45%, transparent); }
  .in::placeholder { color: var(--st-muted); }
  .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 13px; }
  .bar { flex: none; display: flex; align-items: center; gap: 10px; padding: 12px 20px calc(12px + var(--sab, 0px)); border-top: 1px solid var(--st-hair); }
  .sp { flex: 1; }
  .err { flex: 1 1 auto; min-width: 0; font-size: 13px; color: var(--pm-red); }
  .err + .sp { display: none; }
  /* 保存：应用内对话框（DialogHost .dh-btn）同款的 34 高、14 / 500、最窄 76 */
  .btn { display: inline-flex; align-items: center; justify-content: center; min-width: 76px; height: 34px; padding: 0 16px; border: 0; border-radius: 10px;
    background: var(--st-seg); color: var(--text); font: inherit; font-size: 14px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: transform var(--mo-tap, 90ms) var(--ea-std, ease), background-color var(--mo-micro, 140ms) var(--ea-fade, ease), color var(--mo-micro, 140ms) var(--ea-fade, ease),
      opacity var(--mo-micro, 140ms) var(--ea-fade, ease); }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); }
  @media (hover: hover) { .btn.primary:hover:not(:disabled) { opacity: .88; } }
  /* 禁用的主按钮：中性底 + 次要字（墨色实心打透明度会发浑；勾上东西那一下由灰转墨）。保存中（.busy）不算禁用：保持墨色，只略淡 */
  .btn.primary:disabled { background: var(--st-seg); color: var(--st-muted); cursor: default; }
  .btn.primary.busy:disabled { background: var(--st-primary); color: var(--st-primary-ink); opacity: .72; }
  .btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--st-surface), 0 0 0 4px color-mix(in srgb, var(--text) 55%, transparent); }
  .btn:active:not(:disabled), .chk:active { transform: scale(.96); }
  /* 窄屏（手机整页）：设置页同款无描边卡片、46 高输入框、44 高按钮；去向片平分整行（同 HsBar 的窄屏） */
  @media (max-width: 699px) {
    .body { padding: 10px 16px 24px; gap: 20px; }
    .vxwrap { --i-card: var(--st-surface); }
    .hint { margin: -10px 4px 0; }
    .togs { flex-direction: column; gap: 4px; }
    .fl { margin: 0 4px 8px; font-size: 13px; }
    .tog { align-self: stretch; justify-content: space-between; min-height: 44px; padding: 0 4px; cursor: default; }
    .tog-l { font-size: 15px; }
    .in { height: 46px; border: 0; border-radius: 14px; background: var(--st-surface); font-size: 16px; }
    .btn { height: 44px; border-radius: 14px; font-size: 15px; }
    .btn:focus-visible { box-shadow: 0 0 0 2px var(--pm-bg), 0 0 0 4px color-mix(in srgb, var(--text) 55%, transparent); }
    .bar .btn { flex: 1; }
    .checks { flex-wrap: nowrap; }
    .chk { flex: 1 1 0; min-width: 0; justify-content: center; height: 44px; border-radius: 13px; padding: 0 12px; background: var(--st-surface); box-shadow: none; font-size: 14.5px; }
    .chk.on { background: var(--st-sel); box-shadow: inset 0 0 0 1.5px var(--text); }
    .chk-n { overflow: hidden; text-overflow: ellipsis; }
    .mlist { border: 0; border-radius: 18px; }
    .mrow { min-height: 56px; padding: 8px 16px; }
    .mrow:active { background: var(--pm-press); }
    .mrow + .mrow::before { left: 46px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .btn, .chk, .box { transition: none; }
    .btn:active:not(:disabled), .chk:active { transform: none; }
  }
</style>
