<script>
  // 手机 / 网页设置（iOS 外壳）› Codex 加号与登录子页：
  //   · cx:add         添加账号：ChatGPT 设备码登录（拿到验证码后就在本页显示登录进度）或 API 密钥
  //   · cx:login:<id>  重新登录某个 ChatGPT 号：进页就发起设备码流程
  // 流程状态以 cx.flows[flowId] 为准（总线推 + 每 2 秒轮询一次兜底）；成功 / 已在号池里 → 返回上一页；
  // 离开页面时流程还挂着就取消（服务端会收掉新号留下的空目录）。
  import { onDestroy, untrack } from 'svelte';
  import { t, tr } from '../../../../lib/i18n.js';
  import { openExternalUrl } from '../../../../lib/pluginUi.svelte.js';
  import {
    cx,
    startDeviceLogin,
    pollDeviceLogin,
    cancelDeviceLogin,
    addApiKeyAccount,
  } from '../../../../lib/codex/settings.svelte.js';
  import { flowStateText } from '../../../../lib/codex/settings-logic.js';

  let { pid = '', pop } = $props();

  const isAdd = $derived(pid === 'cx:add');
  const reloginId = $derived(pid.startsWith('cx:login:') ? pid.slice('cx:login:'.length) : '');

  let label = $state('');
  let keyLabel = $state('');
  let apiKey = $state('');
  let flowId = $state('');
  let now = $state(Date.now());
  let copied = $state('');
  let copiedTimer = 0;
  let errAt = $state('device');   // cx.errors.login 两条路共用：显示在最后用的那一组下面
  let alive = true;
  let left = false;

  const flow = $derived(flowId ? cx.flows[flowId] || null : null);
  const fstate = $derived(flow?.state || '');
  const waiting = $derived(fstate === 'pending' || fstate === 'finishing');
  const ended = $derived(fstate === 'failed' || fstate === 'expired' || fstate === 'cancelled');
  const starting = $derived(cx.busy === 'login');
  const countdown = $derived.by(() => {
    if (fstate !== 'pending' || !flow?.expiresAt) return '';
    const s = Math.max(0, Math.floor((Number(flow.expiresAt) - now) / 1000));
    return t('{time} 后过期', { time: Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') });
  });

  async function begin() {
    if (starting) return;
    errAt = 'device';
    const f = await startDeviceLogin({ accountId: reloginId || null, label: reloginId ? '' : label });
    if (!f) return;
    // 拿到验证码前人已经走了：别留一个没人管的流程
    if (!alive) { cancelDeviceLogin(f.flowId); return; }
    flowId = f.flowId;
  }

  // 重新登录页：进页就发起
  $effect(() => {
    if (reloginId) untrack(() => begin());
  });

  // 轮询 + 倒计时；换流程 / 离开页面时收掉，流程还挂着就取消
  $effect(() => {
    const id = flowId;
    if (!id) return;
    const poll = setInterval(() => {
      const s = cx.flows[id]?.state;
      if (s === 'pending' || s === 'finishing') pollDeviceLogin(id);
    }, 2000);
    const tick = setInterval(() => {
      if (cx.flows[id]?.state === 'pending') now = Date.now();
    }, 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      if (cx.flows[id]?.state === 'pending') cancelDeviceLogin(id);
    };
  });

  // 成功或这个号本来就在号池里：回上一页（号池列表经总线 / 轮询已经刷新）
  $effect(() => {
    if (fstate !== 'done' && fstate !== 'duplicate') return;
    untrack(() => {
      if (left) return;
      left = true;
      pop?.();
    });
  });

  onDestroy(() => {
    alive = false;
    clearTimeout(copiedTimer);
  });

  // 剪贴板 API 在非安全上下文（局域网 http://192.168…）不可用：退回隐藏 textarea + execCommand
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch { return false; }
  }

  async function copy(what, text) {
    if (!text || !(await copyText(text))) return;
    copied = what;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied = ''; }, 1800);
  }

  function cancelFlow() {
    if (reloginId) { pop?.(); return; }   // 离开页面时的清理会取消它
    flowId = '';                          // 换流程时的清理会取消它，页面回到表单
  }

  async function addKey() {
    if (!apiKey.trim() || cx.busy === 'apikey') return;
    errAt = 'key';
    if (await addApiKeyAccount({ apiKey, label: keyLabel })) {
      apiKey = '';
      left = true;
      pop?.();
    }
  }
</script>

{#snippet flowView()}
  {#if flow}
    {#if flow.userCode && !ended}
      <div class="ig cx-code-card">
        <button class="cx-code" type="button" onclick={() => copy('code', flow.userCode)} aria-label={t('复制验证码')}>
          <span class="cx-code-tx">{flow.userCode}</span>
          <span class="cx-code-hint">{copied === 'code' ? t('已复制') : t('点按复制')}</span>
        </button>
      </div>
    {/if}
    {#if flow.verificationUrl && !ended}
      <div class="ig">
        <button class="r" type="button" onclick={() => openExternalUrl(flow.verificationUrl)}>
          <span class="r-main">
            <span class="r-tx accent">
              <span>{t('打开验证页')}</span>
              <span class="r-sub dv-url cx-url">{flow.verificationUrl}</span>
            </span>
          </span>
        </button>
        <button class="r" type="button" onclick={() => copy('url', flow.verificationUrl)}>
          <span class="r-main"><span class="r-tx">{copied === 'url' ? t('已复制链接') : t('复制链接')}</span></span>
        </button>
      </div>
    {/if}
    <div class="ig">
      <div class="r">
        <span class="r-main">
          {#if waiting}<span class="spin"></span>{/if}
          <span class="r-tx">
            <span>{flowStateText(fstate)}</span>
            {#if ended && flow.error}<span class="r-sub err">{tr(flow.error)}</span>{/if}
          </span>
          {#if countdown}<span class="r-d num">{countdown}</span>{/if}
        </span>
      </div>
      {#if ended}
        <button class="r" type="button" disabled={starting} onclick={begin}>
          <span class="r-main center"><span class="r-tx accent">{starting ? t('正在发起…') : t('重新开始')}</span></span>
        </button>
      {:else if fstate === 'pending'}
        <button class="r" type="button" onclick={cancelFlow}>
          <span class="r-main center"><span class="r-tx">{t('取消登录')}</span></span>
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

{#if flowId}
  {@render flowView()}
  {#if cx.errors.login}<p class="gfoot err">{cx.errors.login}</p>{/if}
  <p class="gfoot">{t('先在 ChatGPT 网页「设置 › 安全」里打开设备码登录')}</p>

{:else if reloginId}
  <!-- 正在发起，或发起失败 -->
  <div class="ig">
    {#if starting}
      <div class="r"><span class="r-main"><span class="spin"></span><span class="r-tx">{t('正在发起…')}</span></span></div>
    {:else}
      <button class="r" type="button" onclick={begin}>
        <span class="r-main center"><span class="r-tx accent">{t('重新开始')}</span></span>
      </button>
    {/if}
  </div>
  {#if cx.errors.login}<p class="gfoot err">{cx.errors.login}</p>{/if}
  <p class="gfoot">{t('先在 ChatGPT 网页「设置 › 安全」里打开设备码登录')}</p>

{:else if isAdd}
  <h2 class="ghead">{t('ChatGPT 账号')}</h2>
  <div class="ig">
    <div class="r">
      <span class="r-main">
        <input class="dv-in" bind:value={label} maxlength="40" placeholder={t('备注名（可不填）')} />
      </span>
    </div>
    <button class="r" type="button" disabled={starting} onclick={begin}>
      <span class="r-main center"><span class="r-tx accent">{starting ? t('正在发起…') : t('用 ChatGPT 账号登录')}</span></span>
    </button>
  </div>
  {#if cx.errors.login && errAt === 'device'}<p class="gfoot err">{cx.errors.login}</p>{/if}
  <p class="gfoot">{t('先在 ChatGPT 网页「设置 › 安全」里打开设备码登录')}</p>

  <h2 class="ghead">{t('改用 API 密钥')}</h2>
  <div class="ig">
    <div class="r">
      <span class="r-main">
        <input class="dv-in" bind:value={keyLabel} maxlength="40" placeholder={t('备注名（可不填）')} />
      </span>
    </div>
    <div class="r">
      <span class="r-main">
        <input
          class="dv-in"
          type="password"
          bind:value={apiKey}
          placeholder={t('API 密钥')}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
      </span>
    </div>
    <button class="r" type="button" disabled={!apiKey.trim() || cx.busy === 'apikey'} onclick={addKey}>
      <span class="r-main center"><span class="r-tx accent">{cx.busy === 'apikey' ? t('验证中…') : t('添加')}</span></span>
    </button>
  </div>
  {#if cx.errors.login && errAt === 'key'}<p class="gfoot err">{cx.errors.login}</p>{/if}
{/if}

<style>
  @import '../kit.css';
  .cx-code-card { padding: 0; }
  .cx-code {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 22px 16px 18px;
    border: 0;
    background: none;
    color: var(--i-label);
    font: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: background-color 260ms var(--ea-fade);
  }
  .cx-code:active { background: var(--i-press); transition-duration: 60ms; }
  .cx-code-tx {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    font-size: 32px;
    line-height: 40px;
    font-weight: 600;
    letter-spacing: 3px;
    font-variant-numeric: tabular-nums;
    user-select: text;
    -webkit-user-select: text;
  }
  .cx-code-hint { font-size: 12.5px; line-height: 18px; color: var(--i-label2); }
  .cx-url { font-weight: 400; }
</style>
