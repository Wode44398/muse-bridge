<script>
  // 设置「Agent」页（管理员）：这台服务器上五个 agent 各自开不开、能不能跑、认证了没有。
  // 关掉的 agent 所有客户端都不再显示它的分页，后台常驻进程也不拉起；改动即时生效并经事件总线
  // 推给在线客户端。注册用户各自能用哪些，另在服务端控制台「用户」页按人勾选。
  // 数据面 = /api/agents（admin 门，可远程——同扩展中心）。外观沿用扩展中心 / 服务端控制台的 .sa-* 玻璃控件，
  // 本页不开 backdrop（磨砂借下层设置页的罩）。
  import './admin/admin.css';
  import { ui } from '../lib/state.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { api } from '../lib/api.js';
  import { sa, saPing } from '../lib/serverAdmin.svelte.js';
  import { t, tr, isEn } from '../lib/i18n.js';

  let closing = $state(false);
  function close() {
    if (closing) return;
    closing = true;
    setTimeout(() => { ui.agentsOpen = false; closing = false; }, 260);
  }
  $effect(() => pushBackLayer(() => close()));
  function onKey(e) { if (e.key === 'Escape') close(); }

  let data = $state(null);      // { edition, features, agents:[{id,label,multiUser,switch,runnable,authed,enabled,note}] }
  let err = $state('');
  let busy = $state('');        // 正在切换的 agent id
  async function load() {
    try { data = await api.get('/api/agents'); err = ''; }
    catch (e) { err = e?.status === 403 || e?.status === 401 ? t('只有管理员能改这里') : t('读取失败：{reason}', { reason: tr(String(e?.message || e)) }); }
  }
  load();

  // 控制台可达才给「去配置认证」的直达（主机形态控制台只在本机桌面壳里开）。
  let consoleOk = $state(false);
  saPing().then(() => { consoleOk = true; }).catch(() => {});

  const toast = $state({ msg: '', err: false, on: false });
  let tT = 0;
  function showToast(msg, isErr = false) { toast.msg = msg; toast.err = isErr; toast.on = true; clearTimeout(tT); tT = setTimeout(() => { toast.on = false; }, 2400); }

  async function toggle(a) {
    if (!a.runnable || busy) return;
    const next = !a.switch;
    // 关掉最后一个开着的 agent 之前问一句：全关之后所有人（包括你自己）都只剩主页。
    if (!next && data.agents.filter((x) => x.enabled).length <= 1 && !confirm(t('这是最后一个开着的 agent，关掉后所有客户端都没有可用的分页。确定吗？'))) return;
    busy = a.id;
    try {
      const r = await api.post('/api/agents', { id: a.id, enabled: next });
      data = { ...data, agents: r.agents };
      showToast(next ? t('{name} 已开启', { name: a.label }) : t('{name} 已关闭', { name: a.label }));
    } catch (e) { showToast(tr(e?.body?.error || e?.message) || t('失败'), true); }
    busy = '';
  }

  const LOOK = {
    claude: { c: '#d97757', g: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 2.5l2 6.1 6.1 1.9-6.1 2L12 18.5l-2-6-6.1-2 6.1-1.9z"/></svg>' },
    gemini: { c: '#4f7cff', g: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 2c.5 5.2 4.8 9.5 10 10-5.2.5-9.5 4.8-10 10-.5-5.2-4.8-9.5-10-10 5.2-.5 9.5-4.8 10-10z"/></svg>' },
    codex: { c: '#10a37f', g: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 9-3 3 3 3M16 9l3 3-3 3M13.5 6l-3 12"/></svg>' },
    dimensio: { c: '#6e6e73', g: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M4 15.5h16"/><path d="M6.5 15.5a5.5 5.5 0 0 1 11 0"/><path d="M12 5v14"/></svg>' },
  };
  const statusText = (a) => {
    if (!a.runnable) return tr(a.note) || t('这台机器上不可用');
    if (!a.switch) return t('已关闭 · 所有客户端都不显示');
    const bits = [a.authed ? t('可用') : t('还没配认证')];
    if (!a.multiUser) bits.push(t('仅管理员（尚不支持多用户）'));
    return bits.join(' · ');
  };
  const AUTH_HINT = {
    claude: t('在「服务端控制台 → Claude 账号」里添加 `claude setup-token` 生成的长期 token，或在服务器环境里配 ANTHROPIC_API_KEY。'),
    gemini: t('服务器配置里填 geminiApiKey，或 vertexProject + 服务账号 / gcloud ADC。'),
    codex: t('在服务器上跑一次 codex login（或配 OPENAI_API_KEY）。'),
    dimensio: t('在 dimensio 的 .env 里填至少一家厂商的 API key（DeepSeek / 智谱 / Kimi / Qwen / Anthropic / Gemini）。'),
  };
  // 只有一个服务端（不再分主机端 / 服务端），这里只说人数
  const editionLine = $derived(!data ? '' : data.features?.multiUser ? t('多用户') : t('单人'));
</script>

<svelte:window onkeydown={onKey} />

<div class="sa-root agp" class:closing>
  <div class="col">
    <header class="top">
      <!-- 中文标题照旧写 Agent；英文用页名「Agent 开关」的译法 Agents（与设置行一致） -->
      <h1 class="big">{isEn() ? t('Agent 开关') : 'Agent'}</h1>
      <span class="sub">{editionLine}</span>
      <div class="sa-sp"></div>
      <button class="sa-cbtn" onclick={close} aria-label={t('关闭')} title={t('关闭')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </header>

    <div class="body">
      {#if err}
        <div class="sa-empty">{err}</div>
      {:else if !data}
        <div class="sa-empty">{t('载入中…')}</div>
      {:else}
        <div class="sa-card">
          <div class="sa-rows">
            {#each data.agents as a (a.id)}
              <div class="sa-row" class:off={!a.enabled}>
                <span class="sa-chip" style="--c:{LOOK[a.id]?.c || '#8e8e93'}">{@html LOOK[a.id]?.g || ''}</span>
                <span class="sa-row-tx">
                  <span>{a.label}</span>
                  <small class:warn={a.runnable && a.switch && !a.authed}>{statusText(a)}</small>
                </span>
                <button class="sa-sw" class:on={a.switch && a.runnable} disabled={!a.runnable || busy === a.id}
                        onclick={() => toggle(a)} aria-label={t('启用 {name}', { name: a.label })}><span class="sa-sw-knob"></span></button>
              </div>
            {/each}
          </div>
        </div>
        <div class="sa-foot">
          {t('关掉的 agent：手机、网页、桌面客户端都不再显示它的分页，服务器上也不再拉起它的常驻进程；改动立刻生效。')}
          {#if data.features?.multiUser}{t('注册用户能用哪些 agent，另在「服务端控制台 → 用户」里按人勾选。')}{/if}
        </div>

        {#if data.agents.some((a) => a.runnable && a.switch && !a.authed)}
          <div class="sa-card-h sec">{t('还没配认证')}</div>
          <div class="sa-card">
            <div class="sa-rows">
              {#each data.agents.filter((a) => a.runnable && a.switch && !a.authed) as a (a.id)}
                <div class="sa-row">
                  <span class="sa-row-tx"><span>{a.label}</span><small>{AUTH_HINT[a.id]}</small></span>
                  {#if a.id === 'claude' && consoleOk}
                    <button class="sa-btn sm" onclick={() => { ui.agentsOpen = false; sa.page = 'accounts'; ui.serverAdminOpen = true; }}>{t('去配置')}</button>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
    </div>
  </div>
  <div class="sa-toast" class:on={toast.on} class:err={toast.err}>{toast.msg}</div>
</div>

<style>
  /* 全屏深色 tint：磨砂来自下层设置页的罩（同屏单层 backdrop 铁律，同扩展中心） */
  .agp {
    position: fixed; inset: 0; z-index: 62; display: flex; justify-content: center;
    background: rgba(9, 11, 16, .38);
    animation: agp-in var(--mo-base) var(--ea-fade);
    transition: opacity var(--mo-quick) var(--ea-fade);
  }
  @keyframes agp-in { from { opacity: 0; } }
  .agp.closing { opacity: 0; pointer-events: none; }
  .col { flex: 1; max-width: 720px; min-width: 0; min-height: 0; display: flex; flex-direction: column;
    padding: max(14px, var(--sat)) 16px max(14px, var(--sab)); }
  .top { flex: none; display: flex; align-items: center; gap: 12px; padding: 4px 4px 12px; }
  .big { font-size: 28px; font-weight: 700; letter-spacing: .2px; color: #fff; }
  .sub { font-size: 12.5px; color: var(--sa-tx3); padding-top: 8px; white-space: nowrap; }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 4px 10px; overscroll-behavior: contain; }
  .sa-row.off .sa-row-tx > span { opacity: .55; }
  .sa-sw:disabled { opacity: .35; cursor: default; }
  small.warn { color: #ffb340; }
  .sec { padding: 18px 18px 8px; }
  @media (max-width: 880px) {
    .col { padding: max(12px, var(--sat)) 12px max(12px, var(--sab)); }
    .big { font-size: 22px; }
  }
</style>
