<script>
  // 主机的「Google 云凭据」卡（管理员）：不用上服务器，直接在这里配 Vertex AI 的凭据。
  // 上传 / 拖入 / 粘贴凭据 JSON（服务账号密钥，或自己电脑上 gcloud 生成的 application_default_credentials.json），
  // 填项目 ID（凭据里带的会自动带出）、可选的 Gemini API Key；保存即时生效，顺手真打一次测通不通。
  // 数据面 /api/vertex/credentials（服务端核心 src/routes/vertex-credentials.mjs，11-13 从 Media Studio 扩展搬回核心）；
  // 拿不到（非管理员、老服务端）整块不出现。颜色读所在容器的 --i-* 变量，没有就退到桌面的 --dsk-*。
  // 2026-11-13 从 studio/settings/ 搬到 modelhub/（git mv）：模型中心 › Vertex AI 面板直接嵌这张卡，关了 Media Studio 也能配。
  // 2026-11-04 Gemini 对话下线、Gemini 设置页删除，本卡从 components/ 搬进 Studio 设置（git mv）：
  //   · 设置 › Media Studio 的「一键导入 Vertex」导入的就是这里管的凭据，导入卡上「Google 云凭据」一行的「管理」打开它；
  //   · vertex 方言的服务选「沿用主机凭据」（google.credMode = 'adc'）时，编辑器的连接区里直接嵌这张卡。
  import { api } from '../../lib/api.js';
  import { t, tr } from '../../lib/i18n.js';
  import { uiConfirm } from '../../lib/dialogs.js';   // 安卓 WebView 没接原生 confirm，统一走这里

  let { onchange = () => {} } = $props();

  let st = $state(null);          // 服务端现状
  let pending = $state(null);     // 选好待上传的凭据 { text, kind, account, projectHint, name }
  let pickErr = $state('');
  let paste = $state(false);
  let pasteText = $state('');
  let project = $state('');
  let location = $state('');
  let mediaLocation = $state('');
  let apiKey = $state('');
  let clearKey = $state(false);
  let adv = $state(false);
  let swap = $state(false);       // 已有凭据时点了「更换凭据」
  let busy = $state('');          // 'save' | 'test' | 'remove'
  let err = $state('');
  let test = $state(null);
  let drag = $state(false);
  let fileEl = $state(null);

  function adopt(s) {
    st = s;
    project = s.project || '';
    location = s.location || '';
    mediaLocation = s.mediaLocation || '';
    apiKey = '';
    clearKey = false;
  }
  api.get('/api/vertex/credentials').then(adopt).catch(() => { st = null; });

  // 本地先看一眼结构：选错文件当场说，不用等上传。真校验在服务端。
  function inspect(text, name = '') {
    pickErr = '';
    let j;
    try { j = JSON.parse(String(text || '').replace(/^﻿/, '').trim()); } catch { pickErr = t('不是有效的 JSON'); return; }
    if (j && (j.installed || j.web)) { pickErr = t('这是 OAuth 客户端 ID 文件，不是凭据：请下载服务账号密钥，或上传 gcloud 生成的 application_default_credentials.json'); return; }
    if (!j || !j.type) { pickErr = t('认不出的凭据类型'); return; }
    pending = { text, name, kind: j.type, account: j.client_email || '', projectHint: j.project_id || j.quota_project_id || '' };
    // 项目没填、或还是旧凭据带出来的那个：换成新凭据带的（换了个项目的服务账号时跟着走）
    if (pending.projectHint && !st?.locked?.project && (!project.trim() || project.trim() === (st?.creds?.projectHint || ''))) project = pending.projectHint;
    paste = false;
    pasteText = '';
  }
  async function readFile(f) {
    if (!f) return;
    if (f.size > 200_000) { pickErr = t('文件太大，不像凭据 JSON'); return; }
    inspect(await f.text(), f.name);
  }
  function onDrop(e) {
    e.preventDefault();
    drag = false;
    readFile(e.dataTransfer?.files?.[0]);
  }

  const KIND = {
    service_account: () => t('服务账号'),
    authorized_user: () => t('Google 账号登录（gcloud）'),
    external_account: () => t('工作负载身份联合'),
    impersonated_service_account: () => t('模拟服务账号'),
  };
  const kindText = (k) => (KIND[k] ? KIND[k]() : k);

  const sourceLine = $derived.by(() => {
    if (!st) return '';
    if (st.source === 'upload') return kindText(st.creds?.kind) + (st.creds?.account ? ' · ' + st.creds.account : '');
    if (st.source === 'env') return 'GOOGLE_APPLICATION_CREDENTIALS';
    if (st.source === 'env-missing') return t('环境变量指向的文件不存在：{path}', { path: st.envFile });
    if (st.source === 'gcloud') return t('gcloud 登录');
    return t('还没有凭据');
  });
  const ready = $derived(!!st && st.source !== 'none' && st.source !== 'env-missing' && !!st.project);
  const dirty = $derived(!!st && (!!pending || clearKey || !!apiKey.trim()
    || project.trim() !== (st.project || '') || location.trim() !== (st.location || '') || mediaLocation.trim() !== (st.mediaLocation || '')));

  async function save() {
    if (busy) return;
    busy = 'save'; err = ''; test = null;
    const body = { test: true };
    if (pending) body.credentials = pending.text;
    if (!st.locked?.project && project.trim() !== (st.project || '')) body.project = project.trim();
    if (!st.locked?.location && location.trim() !== (st.location || '')) body.location = location.trim();
    if (!st.locked?.mediaLocation && mediaLocation.trim() !== (st.mediaLocation || '')) body.mediaLocation = mediaLocation.trim();
    if (!st.locked?.apiKey && (apiKey.trim() || clearKey)) body.apiKey = clearKey ? '' : apiKey.trim();
    try {
      const r = await api.post('/api/vertex/credentials', body);
      adopt(r);
      pending = null;
      test = r.test || null;
      onchange();
    } catch (e) { err = tr(e?.body?.error || e?.message) || t('保存失败'); }
    busy = '';
  }
  async function runTest() {
    if (busy) return;
    busy = 'test'; err = ''; test = null;
    try { const r = await api.post('/api/vertex/credentials/test', {}); st = r; test = r.test || null; }
    catch (e) { err = tr(e?.body?.error || e?.message) || t('测试失败'); }
    busy = '';
  }
  async function remove() {
    if (busy || !(await uiConfirm(t('移除上传的凭据？之后 Vertex AI 会改用服务器上的其它凭据（如果有）。')))) return;
    busy = 'remove'; err = ''; test = null;
    try { adopt(await api.post('/api/vertex/credentials', { credentials: null })); onchange(); }
    catch (e) { err = tr(e?.body?.error || e?.message) || t('失败'); }
    busy = '';
  }
  const secs = (ms) => (ms / 1000).toFixed(1);
  const gcpUrl = (page) => 'https://console.cloud.google.com/' + page + '?project=' + encodeURIComponent(st?.project || '');
</script>

{#if st}
  <div class="vxc">
    <div class="vxc-h">
      <span class="vxc-t">{t('Google 云凭据')}</span>
      <span class="vxc-s" class:ok={ready} class:bad={!ready}><i></i>{ready ? t('已配置') : t('未完成')}</span>
    </div>

    {#if st.relay}
      <p class="vxc-n">{t('由主机提供')}</p>
    {:else}
      <div class="vxc-kv"><span>{t('来源')}</span><b>{sourceLine}</b></div>

      <!-- 选凭据：拖进来 / 选文件 / 粘贴。已经有凭据时收成一枚「更换凭据」，别一直摆着上传框（像是还没配） -->
      {#if st.source !== 'none' && !swap && !pending && !paste}
        <div class="vxc-row"><button type="button" class="vxc-btn ghost" onclick={() => (swap = true)}>{t('更换凭据')}</button></div>
      {:else}
      <div class="vxc-drop" class:drag role="region" aria-label={t('凭据 JSON')}
           ondragover={(e) => { e.preventDefault(); drag = true; }} ondragleave={() => (drag = false)} ondrop={onDrop}>
        {#if pending}
          <div class="vxc-pend">
            <span class="vxc-pk">{kindText(pending.kind)}</span>
            <span class="vxc-pa">{pending.account || pending.name || t('粘贴的凭据')}</span>
            <button type="button" class="vxc-x" onclick={() => (pending = null)} aria-label={t('取消')}>×</button>
          </div>
        {:else if paste}
          <textarea class="vxc-ta" rows="5" spellcheck="false" bind:value={pasteText} placeholder={t('把凭据 JSON 的全部内容粘贴到这里')}></textarea>
          <div class="vxc-row">
            <button type="button" class="vxc-btn" onclick={() => inspect(pasteText)} disabled={!pasteText.trim()}>{t('使用')}</button>
            <button type="button" class="vxc-btn ghost" onclick={() => { paste = false; pasteText = ''; pickErr = ''; }}>{t('取消')}</button>
          </div>
        {:else}
          <div class="vxc-row">
            <button type="button" class="vxc-btn" onclick={() => fileEl?.click()}>{t('选择文件')}</button>
            <button type="button" class="vxc-btn ghost" onclick={() => { paste = true; pickErr = ''; }}>{t('粘贴内容')}</button>
          </div>
        {/if}
        <input bind:this={fileEl} type="file" hidden onchange={(e) => { readFile(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
      </div>
      {/if}
      {#if pickErr}<p class="vxc-n err">{pickErr}</p>{/if}

      <label class="vxc-f">
        <span>{t('项目 ID')}</span>
        <input type="text" bind:value={project} disabled={st.locked?.project} placeholder={t('如 my-project-123')} autocomplete="off" spellcheck="false" />
      </label>
      {#if st.locked?.project}<p class="vxc-n">{t('由服务器环境变量指定')}</p>{/if}

      <label class="vxc-f">
        <span>{t('Gemini API Key（可选）')}</span>
        <input type="password" bind:value={apiKey} disabled={st.locked?.apiKey || clearKey} autocomplete="off" spellcheck="false"
               placeholder={st.apiKey?.set ? t('已设置 · 末尾 {tail}', { tail: st.apiKey.tail }) : t('部分模型与 2K/4K 图像要用')} />
      </label>
      {#if st.locked?.apiKey}<p class="vxc-n">{t('由服务器环境变量指定')}</p>
      {:else if st.apiKey?.set}
        <label class="vxc-chk"><input type="checkbox" bind:checked={clearKey} />{t('清除已保存的 API Key')}</label>
      {/if}

      <button type="button" class="vxc-link" onclick={() => (adv = !adv)} aria-expanded={adv}>{adv ? '▾ ' : '▸ '}{t('区域')}</button>
      {#if adv}
        <label class="vxc-f">
          <span>{t('图像区域（Gemini 图像模型）')}</span>
          <input type="text" bind:value={location} disabled={st.locked?.location} placeholder="global" autocomplete="off" spellcheck="false" />
        </label>
        <label class="vxc-f">
          <span>{t('视频 / 配音 / 音乐区域')}</span>
          <input type="text" bind:value={mediaLocation} disabled={st.locked?.mediaLocation} placeholder="us-central1" autocomplete="off" spellcheck="false" />
        </label>
      {/if}

      <div class="vxc-row act">
        <button type="button" class="vxc-btn pri" onclick={save} disabled={!!busy || !dirty}>{busy === 'save' ? t('正在保存…') : t('保存并测试')}</button>
        <button type="button" class="vxc-btn ghost" onclick={runTest} disabled={!!busy}>{busy === 'test' ? t('正在测试…') : t('测试连接')}</button>
        {#if st.source === 'upload'}
          <button type="button" class="vxc-btn ghost danger" onclick={remove} disabled={!!busy}>{t('移除凭据')}</button>
        {/if}
      </div>
      {#if err}<p class="vxc-n err">{err}</p>{/if}
      {#if test}
        <div class="vxc-res">
          {#if test.vertex}
            <p class:ok={test.vertex.ok} class:err={!test.vertex.ok}>
              {test.vertex.ok ? t('✓ Vertex 已连通 · {s} 秒', { s: secs(test.vertex.ms) }) : t('✗ Vertex：{reason}', { reason: tr(test.vertex.error) })}
            </p>
            {#if !test.vertex.ok && test.vertex.detail}<p class="vxc-det">{test.vertex.detail}</p>{/if}
          {/if}
          {#if test.apiKey}
            <p class:ok={test.apiKey.ok} class:err={!test.apiKey.ok}>
              {test.apiKey.ok ? t('✓ API Key 可用 · {s} 秒', { s: secs(test.apiKey.ms) }) : t('✗ API Key：{reason}', { reason: tr(test.apiKey.error) })}
            </p>
          {/if}
        </div>
      {/if}

      {#if st.project}
        <!-- 费用都在用户自己的 Google Cloud 里：直达这个项目的账单、配额与 Vertex AI 用量 -->
        <p class="vxc-gcp"><span>Google Cloud</span><a href={gcpUrl('billing/linkedaccount')} target="_blank" rel="noopener">{t('账单')}</a> · <a href={gcpUrl('iam-admin/quotas')} target="_blank" rel="noopener">{t('配额')}</a> · <a href={gcpUrl('apis/api/aiplatform.googleapis.com/metrics')} target="_blank" rel="noopener">{t('用量')}</a></p>
      {/if}

    {/if}
  </div>
{/if}

<style>
  .vxc {
    margin: 0 0 14px; padding: 12px 14px 10px; border-radius: 14px;
    background: var(--i-card, var(--dsk-panel, rgba(127, 127, 127, .08)));
    color: var(--i-label, var(--dsk-ink, inherit));
    font-size: 13px; line-height: 1.5;
  }
  .vxc-h { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 2px; }
  .vxc-t { font-weight: 600; font-size: 14px; }
  .vxc-s { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--i-label2, var(--dsk-ink-2, currentColor)); white-space: nowrap; }
  .vxc-s i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .vxc-s.ok i { background: var(--i-ok, var(--dsk-ok, #34c759)); }
  .vxc-s.bad i { background: var(--i-red, var(--dsk-crit, #c0392b)); }
  .vxc-n { margin: 3px 0 0; font-size: 12px; color: var(--i-label2, var(--dsk-ink-2, currentColor)); overflow-wrap: anywhere; }
  .vxc-n.err, .vxc-res .err { color: var(--i-red, var(--dsk-crit, #c0392b)); }
  .vxc-res .ok { color: var(--i-ok, var(--dsk-ok, #2e9d4c)); }
  .vxc-res { margin-top: 8px; font-size: 12.5px; }
  .vxc-res p { margin: 2px 0 0; overflow-wrap: anywhere; }
  .vxc-det { font-size: 11px; color: var(--i-label3, var(--dsk-ink-3, currentColor)); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  .vxc-drop {
    margin: 10px 0 4px; padding: 12px; border-radius: 11px; text-align: center;
    border: 1.5px dashed var(--i-sep, var(--dsk-line, rgba(127, 127, 127, .35)));
    transition: border-color .15s ease, background-color .15s ease;
  }
  .vxc-drop.drag { border-color: var(--i-accent, var(--dsk-accent, currentColor)); background: var(--i-fill3, var(--dsk-ctl, rgba(127, 127, 127, .12))); }
  .vxc-pend { display: flex; align-items: center; gap: 8px; text-align: left; }
  .vxc-pk { flex: none; font-size: 11px; padding: 1px 7px; border-radius: 6px; background: var(--i-fill3, var(--dsk-ctl, rgba(127, 127, 127, .16))); }
  .vxc-pa { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vxc-x { flex: none; border: 0; background: transparent; color: inherit; font-size: 18px; line-height: 1; cursor: pointer; opacity: .6; padding: 0 2px; }
  .vxc-ta {
    width: 100%; box-sizing: border-box; resize: vertical; margin-bottom: 8px; padding: 8px 10px; border-radius: 9px;
    font: 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: inherit;
    background: var(--i-bg, var(--dsk-ctl, rgba(127, 127, 127, .1))); border: 1px solid var(--i-sep, var(--dsk-line, rgba(127, 127, 127, .3)));
  }

  .vxc-f { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
  .vxc-f > span { font-size: 12px; color: var(--i-label2, var(--dsk-ink-2, currentColor)); }
  .vxc-f input {
    width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 9px; font: inherit; font-size: 13.5px; color: inherit;
    background: var(--i-bg, var(--dsk-ctl, rgba(127, 127, 127, .1))); border: 1px solid var(--i-sep, var(--dsk-line, rgba(127, 127, 127, .3)));
    outline: none;
  }
  .vxc-f input:focus { border-color: var(--i-accent, var(--dsk-accent, currentColor)); }
  .vxc-f input:disabled { opacity: .55; }
  .vxc-chk { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 12px; color: var(--i-label2, var(--dsk-ink-2, currentColor)); cursor: pointer; }

  .vxc-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
  .vxc-row.act { justify-content: flex-start; margin-top: 14px; }
  .vxc-btn {
    padding: 5px 14px; border-radius: 8px; font: inherit; font-size: 12.5px; cursor: pointer; color: inherit;
    background: var(--i-fill3, var(--dsk-ctl, rgba(127, 127, 127, .14))); border: 1px solid transparent;
  }
  @media (pointer: coarse) { .vxc-btn { position: relative; } .vxc-btn::after { content: ''; position: absolute; inset: -3px 0; } }
  .vxc-btn.ghost { background: transparent; border-color: var(--i-sep, var(--dsk-line, rgba(127, 127, 127, .35))); }
  .vxc-btn.pri { background: var(--i-accent, var(--dsk-accent, #0a84ff)); color: var(--i-on-accent, var(--dsk-accent-ink, #fff)); font-weight: 600; }
  .vxc-btn.danger { color: var(--i-red, var(--dsk-crit, #c0392b)); }
  .vxc-btn:disabled { opacity: .5; cursor: default; }

  .vxc-link {
    display: block; margin: 12px 0 0; padding: 0; border: 0; background: transparent; font: inherit; font-size: 12.5px; cursor: pointer;
    color: var(--i-accent, var(--dsk-accent, currentColor));
  }
  .vxc-kv { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 2px 0 10px; font-size: 13px; color: var(--i-label2, var(--dsk-ink-2, currentColor)); }
  .vxc-kv b { min-width: 0; font-weight: 500; text-align: right; overflow-wrap: anywhere; color: var(--i-label, var(--dsk-ink, currentColor)); }
  .vxc-gcp span { margin-right: 8px; }
  .vxc-gcp { margin: 10px 0 0; font-size: 12px; color: var(--i-label2, var(--dsk-ink-2, currentColor)); }
  .vxc-gcp a { color: var(--i-accent, var(--dsk-accent, currentColor)); text-decoration: none; }
  /* 触屏：行内小链接、展开钮、勾选行的命中区扩到 32 以上（视觉不变） */
  @media (pointer: coarse) {
    .vxc-chk { min-height: 32px; margin-top: 2px; }
    .vxc-link, .vxc-gcp a { position: relative; }
    .vxc-link::after { content: ''; position: absolute; inset: -7px -6px; }
    .vxc-gcp a::after { content: ''; position: absolute; inset: -9px -6px; }
  }
</style>
