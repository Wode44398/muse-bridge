<script>
  // 工作空间 · 桌面版（FilesDesktop）的弹窗：简介、分享链接、压缩选项、发送给 AI。
  // P 是外壳（FilesDesktop.svelte）交出来的状态与动作视图；配色令牌由外壳 .fd-root 给。
  import { relTime } from '../../../lib/format.js';
  import { AI_NAMES, COMPRESS_FORMATS, COMPRESS_LEVELS, SHARE_TTLS, shareClipboardText } from '../../../lib/files-business.js';
  import { nativeWorkspaceReveal } from '../../../lib/nativeDesktop.js';
  import { t, tr } from '../../../lib/i18n.js';
  // 文件夹图标：原版资源
  import wsIcon from '../../../visuals/assets/icons/workspace.png';
  import { fmtSize } from '../../../lib/files/common.js';
  import { fileIcon, fmtFull, joinPath, typeLabel } from './fdLook.js';

  const { P } = $props();
</script>

  <!-- 简介 -->
  {#if P.infoDlg}
    <div class="dlg-mask" onclick={() => (P.infoDlg = null)} role="presentation">
      <div class="dlg info" onclick={(e) => e.stopPropagation()} role="presentation">
        <div class="info-top">
          {#if P.infoDlg.isDir}<img class="info-ico" src={wsIcon} alt="" />{:else}<span class="info-ico file">{@html fileIcon(P.infoDlg.name)}</span>{/if}
          <div class="info-name">{P.infoDlg.name}</div>
        </div>
        <div class="info-rows">
          <div class="ir"><span>{t('种类')}</span><b>{typeLabel(P.infoDlg)}</b></div>
          <div class="ir"><span>{t('大小')}</span><b>{P.infoDlg.isDir ? P.dirInfoLabel(P.infoDlg) : fmtSize(P.infoDlg.size)}</b></div>
          <div class="ir"><span>{t('修改时间')}</span><b>{fmtFull(P.infoDlg.mtime)}</b></div>
          <div class="ir"><span>{t('位置')}</span><b class="loc sel-text">{P.absOk ? joinPath(P.curLoc.abs, P.infoDlg.dir || '') : P.rootLabel + (P.infoDlg.dir ? ' / ' + P.infoDlg.dir.split('/').join(' / ') : '')}</b></div>
          {#if P.infoDlg.loading}<div class="ir"><span>{t('Windows 属性')}</span><b>{t('读取中…')}</b></div>{/if}
          {#if P.infoDlg.absolutePath}
            <div class="ir"><span>{t('完整路径')}</span><b class="loc selectable" title={t('点击复制')} role="button" tabindex="0" onclick={() => P.copyText(P.infoDlg.absolutePath, t('已复制路径'))} onkeydown={(e) => e.key === 'Enter' && P.copyText(P.infoDlg.absolutePath, t('已复制路径'))}>{P.infoDlg.absolutePath}</b></div>
            <div class="ir"><span>{t('访问')}</span><b>{P.infoDlg.readable ? t('可读') : t('不可读')} · {P.infoDlg.writable ? t('可写') : t('只读')}{P.infoDlg.longPath ? ' · ' + t('长路径') : ''}</b></div>
          {/if}
          {#if P.infoDlg.linkType}<div class="ir"><span>{t('链接')}</span><b class="loc sel-text">{P.infoDlg.linkType}{P.infoDlg.linkTarget ? ` → ${P.infoDlg.linkTarget}` : ''}</b></div>{/if}
          {#if P.infoDlg.acl}<div class="ir acl"><span>ACL</span><pre>{P.infoDlg.acl}</pre></div>{/if}
          {#if P.infoDlg.inspectError}<div class="ir"><span>{t('Windows 属性')}</span><b class="sel-text">{tr(P.infoDlg.inspectError)}</b></div>{/if}
        </div>
        <div class="dlg-btns">
          <button class="btn" onclick={() => { nativeWorkspaceReveal(P.infoDlg.rel, P.locationId).catch(() => {}); }}>{t('在资源管理器中显示')}</button>
          <button class="btn go" onclick={() => (P.infoDlg = null)}>{t('完成')}</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- 分享链接 -->
  {#if P.shareDlg}
    <div class="dlg-mask" onclick={() => { if (!P.shareDlg.busy) P.shareDlg = null; }} role="presentation">
      <div class="dlg" onclick={(e) => e.stopPropagation()} role="presentation">
        {#if !P.shareDlg.result}
          <h3>{t('分享链接')}</h3>
          <p class="dlg-sub">{P.shareDlg.item.isDir ? '📁 ' : ''}{P.shareDlg.item.name}</p>
          <div class="sh-row">
            <span>{t('启用分享密码')}</span>
            <button class="sw" class:on={P.shareDlg.pwOn} role="switch" aria-checked={P.shareDlg.pwOn} aria-label={t('启用分享密码')} onclick={() => (P.shareDlg.pwOn = !P.shareDlg.pwOn)}><span class="knob"></span></button>
          </div>
          {#if P.shareDlg.pwOn}
            <input class="dlg-input" bind:value={P.shareDlg.password} placeholder={t('设置分享密码')} maxlength="64" onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') P.doShareLink(); }} />
          {/if}
          <div class="sh-ttl">
            {#each SHARE_TTLS as ttl (ttl.h)}
              <button class:on={P.shareDlg.ttl === ttl.h} onclick={() => (P.shareDlg.ttl = ttl.h)}>{ttl.lb}</button>
            {/each}
          </div>
          <div class="dlg-btns">
            <button class="btn" onclick={() => (P.shareDlg = null)}>{t('取消')}</button>
            <button class="btn go" disabled={P.shareDlg.busy} onclick={P.doShareLink}>{P.shareDlg.busy ? t('创建中…') : t('创建链接')}</button>
          </div>
        {:else}
          <h3>{t('链接已创建')}</h3>
          <p class="dlg-sub">{P.shareDlg.item.isDir ? '📁 ' : ''}{P.shareDlg.item.name}</p>
          <button class="sh-url" onclick={() => P.copyText(shareClipboardText(P.shareDlg.result), t('已复制链接'))}>{P.shareDlg.result.url}</button>
          <p class="sh-meta">{t('{time} 过期', { time: P.fmtExpire(P.shareDlg.result.expiresAt) })}{#if P.shareDlg.result.pw} · {t('密码')} <b class="sel-text">{P.shareDlg.result.pw}</b>{/if}</p>
          <div class="dlg-btns">
            <button class="btn" onclick={() => (P.shareDlg = null)}>{t('完成')}</button>
            <button class="btn go" onclick={() => P.copyText(shareClipboardText(P.shareDlg.result), t('已复制链接'))}>{t('复制链接')}</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- 压缩（内置选项：桌面壳以外；桌面壳弹的是系统「创建存档」窗口） -->
  {#if P.zipDlg}
    <div class="dlg-mask" onclick={() => { if (!P.zipDlg.busy) P.zipDlg = null; }} role="presentation">
      <div class="dlg" onclick={(e) => e.stopPropagation()} role="presentation">
        <h3>{t('压缩')}</h3>
        <p class="dlg-sub">{P.zipDlg.sub}</p>
        <div class="zp-lb">{t('存档名称')}</div>
        <div class="zp-name">
          <input class="dlg-input" bind:value={P.zipDlg.name} disabled={P.zipDlg.busy} spellcheck="false"
            onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') P.runZipDlg(); }} />
          <span class="zp-ext">{COMPRESS_FORMATS.find((f) => f.value === P.zipDlg.format)?.ext}</span>
        </div>
        <div class="zp-lb">{t('格式')}</div>
        <div class="sh-ttl">
          {#each COMPRESS_FORMATS.filter((f) => P.zipDlg.formats.includes(f.value)) as f (f.value)}
            <button class:on={P.zipDlg.format === f.value} disabled={P.zipDlg.busy} onclick={() => (P.zipDlg.format = f.value)}>{f.label}</button>
          {/each}
        </div>
        <div class="zp-lb">{t('压缩级别')}</div>
        <div class="sh-ttl">
          {#each COMPRESS_LEVELS as lv (lv.value)}
            <button class:on={P.zipDlg.level === lv.value} disabled={P.zipDlg.busy} onclick={() => (P.zipDlg.level = lv.value)}>{tr(lv.lb)}</button>
          {/each}
        </div>
        {#if P.zipDlg.note}<p class="sh-meta zp-note">{P.zipDlg.note}</p>{/if}
        <div class="dlg-btns">
          <button class="btn" disabled={P.zipDlg.busy} onclick={() => (P.zipDlg = null)}>{t('取消')}</button>
          <button class="btn go" disabled={P.zipDlg.busy || !P.zipDlg.name.trim()} onclick={P.runZipDlg}>{P.zipDlg.busy ? t('正在压缩…') : t('压缩')}</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- 发送给 AI -->
  {#if P.ai.item}
    <div class="dlg-mask" onclick={() => P.ai.close()} role="presentation">
      <div class="dlg ai" onclick={(e) => e.stopPropagation()} role="presentation">
        {#if P.ai.view === 'root'}
          <h3>{t('发送「{name}」给', { name: P.ai.item.name })}</h3>
          {#if P.ai.caps.claude}
            <button class="ai-opt" onclick={() => P.ai.pick('claude')}>
              <span class="ai-ic" style="background:#d97757"><svg viewBox="0 0 24 24" fill="#fff"><path d="M12 2.5l2 6.1 6.1 1.9-6.1 2L12 18.5l-2-6-6.1-2 6.1-1.9z"/></svg></span>
              <span class="ai-lb">Claude<small>{t('当附件向 Claude 提问')}</small></span>
              <svg class="ai-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
            </button>
          {/if}
          {#if P.ai.caps.studio}
            <button class="ai-opt" onclick={() => (P.ai.view = 'studio')}>
              <span class="ai-ic"><img src="{P.BASE}assets/icons/studio.svg" alt="" /></span>
              <span class="ai-lb">Media Studio<small>{t('生成图像 / 视频 / 配音 / 音乐')}</small></span>
              <svg class="ai-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
            </button>
          {/if}
        {:else if P.ai.view === 'studio'}
          <h3><button class="ai-back" aria-label={t('返回')} onclick={() => (P.ai.view = 'root')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>{t('发到 Media Studio')}</h3>
          {#if P.ai.caps.video}
            <button class="ai-opt" onclick={() => (P.ai.caps.mode === 'image' ? (P.ai.view = 'video') : P.ai.pick('video'))}>
              <span class="ai-ic" style="background:#6d7cff"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.2l4.6 2.8L10 14.8z" fill="#fff" stroke="none"/></svg></span>
              <span class="ai-lb">{t('视频')}<small>{P.ai.caps.mode === 'image' ? t('作为首帧 / 尾帧 / 参考图') : t('作为提示词')}</small></span>
            </button>
          {/if}
          {#if P.ai.caps.image}
            <button class="ai-opt" onclick={() => P.ai.pick('image')}>
              <span class="ai-ic" style="background:#0088ff"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="10" r="1.5" fill="#fff" stroke="none"/><path d="M4 16.5l5-4 4 3 3-2 4 3"/></svg></span>
              <span class="ai-lb">{t('图像')}<small>{P.ai.caps.mode === 'image' ? t('作为改图素材') : t('作为提示词')}</small></span>
            </button>
          {/if}
          {#if P.ai.caps.audio}
            <button class="ai-opt" onclick={() => P.ai.pick('audio')}>
              <span class="ai-ic" style="background:#ff2d55"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"><path d="M5 10v4M9 7.5v9M13 9v6M17 6v12M21 10v4"/></svg></span>
              <span class="ai-lb">{t('配音')}<small>{t('作为朗读文本')}</small></span>
            </button>
          {/if}
          {#if P.ai.caps.music}
            <button class="ai-opt" onclick={() => P.ai.pick('music')}>
              <span class="ai-ic" style="background:#ff8d28"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="2.6" fill="#fff" stroke="none"/><circle cx="17" cy="16" r="2.6" fill="#fff" stroke="none"/></svg></span>
              <span class="ai-lb">{t('音乐')}<small>{t('作为描述')}</small></span>
            </button>
          {/if}
        {:else if P.ai.view === 'video'}
          <h3><button class="ai-back" aria-label={t('返回')} onclick={() => (P.ai.view = 'studio')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>{t('这张图用作')}</h3>
          <button class="ai-opt" onclick={() => P.ai.pickVideoSlot('first')}><span class="ai-ic" style="background:#6d7cff"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7.5 5.5v13" stroke-width="2.6"/></svg></span><span class="ai-lb">{t('首帧素材')}<small>{t('视频从这张图开始')}</small></span></button>
          <button class="ai-opt" onclick={() => P.ai.pickVideoSlot('last')}><span class="ai-ic" style="background:#6d7cff"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M16.5 5.5v13" stroke-width="2.6"/></svg></span><span class="ai-lb">{t('尾帧素材')}<small>{t('视频结束于这张图')}</small></span></button>
          <button class="ai-opt" onclick={() => P.ai.pickVideoSlot('ref')}><span class="ai-ic" style="background:#6d7cff"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8.5v7M8.5 12h7"/></svg></span><span class="ai-lb">{t('参考图')}<small>{t('带入主体 / 风格')}</small></span></button>
        {:else if P.ai.view === 'chat' && P.ai.chat}
          <h3><button class="ai-back" aria-label={t('返回')} onclick={() => P.ai.chatBack()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>{t('发送到 {name} · 选择对话', { name: AI_NAMES[P.ai.chat.target] })}</h3>
          <div class="ai-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
            <input type="search" placeholder={t('搜索对话')} bind:value={P.ai.chat.q} onkeydown={(e) => e.stopPropagation()} />
          </div>
          <button class="ai-opt" onclick={() => P.ai.pickChat('new')}>
            <span class="ai-ic" style="background:#34c759"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg></span>
            <span class="ai-lb">{t('新对话')}<small>{t('开一个新对话，附件挂进输入栏')}</small></span>
          </button>
          <div class="ai-list">
            {#each P.ai.filtered as s (s.id)}
              <button class="ai-row" onclick={() => P.ai.pickChat(s.id)}>
                {#if P.ai.chat.target === 'claude'}<span class="ai-dot" class:work={s.thinking} class:ask={!s.thinking && s.pending}></span>{/if}
                <span class="ai-title">{P.ai.chatTitle(s)}</span>
                {#if s.id === P.ai.cur}<span class="ai-cur">{t('当前')}</span>{/if}
                {#if s.mtime}<span class="ai-time">{relTime(s.mtime)}</span>{/if}
              </button>
            {:else}
              <div class="ai-empty">{P.ai.chat.loading ? t('加载中…') : P.ai.chat.q ? t('没有匹配的对话') : t('还没有历史对话')}</div>
            {/each}
          </div>
        {/if}
        <div class="dlg-btns"><button class="btn" onclick={() => P.ai.close()}>{t('取消')}</button></div>
      </div>
    </div>
  {/if}

<style>
  /* 弹窗 */
  .dlg-mask { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; background: var(--mask); animation: fd-fade .14s ease; }
  @keyframes fd-fade { from { opacity: 0; } }
  .dlg { width: 400px; max-width: calc(100% - 32px); max-height: calc(100% - 56px); overflow-y: auto; padding: 18px; background: var(--dlg-bg); border-radius: 15px; box-shadow: 0 22px 70px rgba(0, 0, 0, .3); animation: fd-rise .16s cubic-bezier(.2, .8, .3, 1); }
  @keyframes fd-rise { from { opacity: 0; transform: translateY(8px) scale(.98); } }
  .dlg h3 { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; font-size: 15px; font-weight: 700; }
  .dlg-sub { margin: -4px 0 12px; font-size: 12.5px; color: var(--ink2); word-break: break-all; }
  .dlg-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .btn { padding: 7px 16px; border: 0; border-radius: 9px; background: rgba(120, 120, 128, .13); font-size: 13px; font-weight: 600; color: var(--ink); cursor: pointer; }
  .btn:hover { background: rgba(120, 120, 128, .2); }
  .btn.go { background: var(--blue); color: #fff; }
  .btn.go:hover { filter: brightness(1.08); }
  .btn.go:disabled { opacity: .55; cursor: default; }
  .dlg-input { width: 100%; margin: 8px 0 2px; padding: 8px 10px; border: 1px solid var(--sep); border-radius: 9px; background: var(--field-bg); color: var(--ink); font: inherit; font-size: 13px; outline: none; user-select: text; }
  .dlg-input:focus { border-color: var(--blue); }

  /* 简介 */
  .dlg.info { width: 440px; }
  .info-top { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 4px 0 12px; }
  .info-ico { width: 52px; height: 52px; object-fit: contain; }
  .info-ico.file { width: 44px; height: 52px; display: block; }
  .info-ico.file :global(svg) { width: 100%; height: 100%; }
  .info-name { font-size: 15px; font-weight: 600; text-align: center; word-break: break-all; }
  .info-rows { border-top: 1px solid var(--sep); }
  .ir { display: flex; align-items: baseline; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--sep); }
  .ir span { flex: 0 0 70px; font-size: 12.5px; color: var(--ink2); }
  .ir b { flex: 1; font-size: 12.5px; font-weight: 500; text-align: right; word-break: break-all; }
  .ir b.loc { text-align: right; }
  .ir b.selectable { user-select: text; cursor: pointer; color: var(--blue); }
  .ir.acl { display: block; }
  .ir.acl pre { margin: 6px 0 0; padding: 8px; max-height: 110px; overflow: auto; border-radius: 8px; background: rgba(120, 120, 128, .1); user-select: text; white-space: pre-wrap; word-break: break-all; font: 11px/1.35 Consolas, monospace; }

  /* 分享 */
  .sh-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; font-size: 13px; }
  .sw { position: relative; width: 44px; height: 26px; border: 0; border-radius: 20px; background: rgba(120, 120, 128, .22); cursor: pointer; transition: background .18s; padding: 0; }
  .sw.on { background: #34c759; }
  .sw .knob { position: absolute; top: 2px; left: 2px; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .25); transition: transform .18s; }
  .sw.on .knob { transform: translateX(18px); }
  .sh-ttl { display: flex; gap: 6px; margin-top: 8px; }
  .sh-ttl button { flex: 1; padding: 7px 0; border: 1px solid var(--sep); border-radius: 8px; background: var(--field-bg); font-size: 12.5px; color: var(--ink); cursor: pointer; }
  .sh-ttl button.on { border-color: var(--blue); background: var(--blue-soft); color: var(--blue); font-weight: 600; }
  .sh-url { display: block; width: 100%; margin: 6px 0 4px; padding: 10px; border: 1px dashed var(--blue-line); border-radius: 9px; background: var(--blue-soft); font-size: 12.5px; color: var(--blue); word-break: break-all; text-align: left; cursor: pointer; user-select: text; }
  .sh-meta { margin: 2px 0 0; font-size: 12px; color: var(--ink2); }
  .zp-lb { margin: 12px 0 0; font-size: 12px; font-weight: 600; color: var(--ink2); }
  .zp-name { display: flex; align-items: center; gap: 6px; }
  .zp-name .dlg-input { flex: 1; min-width: 0; margin-top: 6px; }
  .zp-ext { margin-top: 4px; font-size: 13px; color: var(--ink2); white-space: nowrap; }
  .sh-ttl button:disabled { opacity: .55; cursor: default; }
  .zp-note { margin-top: 12px; }

  /* 发送给 AI */
  .dlg.ai { width: 420px; }
  .ai-back { display: grid; place-items: center; width: 24px; height: 24px; border: 0; border-radius: 7px; background: none; color: var(--ink2); cursor: pointer; padding: 0; }
  .ai-back:hover { background: var(--hover); }
  .ai-back svg { width: 15px; height: 15px; }
  .ai-opt { display: flex; align-items: center; gap: 11px; width: 100%; padding: 9px 10px; border: 0; border-radius: 11px; background: none; text-align: left; cursor: pointer; }
  .ai-opt:hover { background: var(--hover); }
  .ai-ic { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 9px; flex: 0 0 auto; overflow: hidden; }
  .ai-ic svg { width: 19px; height: 19px; }
  .ai-ic img { width: 100%; height: 100%; object-fit: cover; }
  .ai-lb { flex: 1; display: flex; flex-direction: column; gap: 1px; font-size: 13.5px; font-weight: 600; }
  .ai-lb small { font-size: 11.5px; font-weight: 400; color: var(--ink2); }
  .ai-chev { width: 15px; height: 15px; color: var(--ink3); }
  .ai-search { display: flex; align-items: center; gap: 7px; margin: 2px 0 8px; padding: 7px 10px; border: 1px solid var(--sep); border-radius: 9px; background: var(--field-bg); }
  .ai-search svg { width: 14px; height: 14px; color: var(--ink3); }
  .ai-search input { flex: 1; border: 0; background: none; outline: none; font-size: 13px; color: var(--ink); user-select: text; }
  .ai-list { max-height: 300px; overflow-y: auto; }
  .ai-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 0; border-radius: 9px; background: none; text-align: left; cursor: pointer; }
  .ai-row:hover { background: var(--hover); }
  .ai-dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(120, 120, 128, .35); flex: 0 0 auto; }
  .ai-dot.work { background: #34c759; }
  .ai-dot.ask { background: #ff9500; }
  .ai-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .ai-cur { flex: 0 0 auto; padding: 1px 7px; border-radius: 20px; background: var(--blue-soft); font-size: 10.5px; color: var(--blue); }
  .ai-time { flex: 0 0 auto; font-size: 11px; color: var(--ink3); }
  .ai-empty { padding: 20px 0; text-align: center; font-size: 12.5px; color: var(--ink3); }

  :global(html[lang='en']) .ir span { flex-basis: 112px; }                           /* 简介标签列：Date modified / Windows properties 不折行（440px 对话框，值列仍够宽） */
</style>
