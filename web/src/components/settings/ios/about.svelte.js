// 设置 › 关于（iOS 外壳）：软件更新、版本、服务器地址与信息、下载 App；以及根页弹出的反馈表单页。
import { untrack } from 'svelte';
import { ui, me } from '../../../lib/state.svelte.js';
import { t, tr } from '../../../lib/i18n.js';
import { api, getToken } from '../../../lib/api.js';
import { getServerBase, onServerBaseChange, apiUrl } from '../../../lib/server.js';
import { canSwitchServers, activeProfile, listProfiles } from '../../../lib/serverProfiles.js';
import { updateState, installPending, hasSilentUpdate, checkForUpdate, startUpdate,
  nativeInfo, fetchLatest, cancelUpdate, autoUpdateEnabled, setAutoUpdateEnabled, waitingLine } from '../../../lib/appUpdate.js';
import { updateInfo } from '../../../lib/updateStore.svelte.js';
import { createServerUpdate } from '../../../lib/serverUpdate.svelte.js';
import { stripBrand } from '../../../lib/distro.js';
import { filesFromInput, removeAttachment, uploadAttachment } from '../../../lib/attachments.js';
import { fmtUptime, compressImage } from '../../../lib/settings/common.js';
import { createVersionLine, createServerInfo, createServerAddress, createFeedbackUpstream } from '../../../lib/settings/common.svelte.js';

export function createUpdate() {
  // —— 软件更新（沿用原自动静默下载逻辑）——
  let upState = $state('idle');
  let progress = $state(0);
  let upMsg = $state(t('检查更新'));
  let pollTimer = null;
  syncUpdateState();
  function syncUpdateState() {
    const st = updateState();
    if (st.state === 'ready') { upState = 'installable'; upMsg = t('一键更新'); }
    else if (st.state === 'downloading') { upState = 'downloading'; progress = (st.pct || 0) / 100; upMsg = t('正在下载'); pollState(); }
    // 桌面壳托管着本机服务端、正等对话跑完去装（S1-5；取消 / 立即安装在桌面设置「连接与更新」里）
    else if (st.state === 'waiting-idle') { upState = 'checking'; upMsg = waitingLine(st); pollState(); }
    else if (st.state === 'handing-off') { upState = 'checking'; upMsg = t('正在拉起安装…'); pollState(); }
  }
  function pollState() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      const st = updateState();
      if (st.state === 'ready') { progress = 1; upState = 'installable'; upMsg = t('一键更新'); clearInterval(pollTimer); }
      else if (st.state === 'downloading') { progress = (st.pct || 0) / 100; }
      else if (st.state === 'waiting-idle' || st.state === 'handing-off' || st.state === 'installing') { upState = 'checking'; upMsg = st.state === 'waiting-idle' ? waitingLine(st) : t('正在拉起安装…'); }
      else { upState = 'error'; upMsg = t('下载失败，点击重试'); clearInterval(pollTimer); }
    }, 500);
  }
  function onUpClick() {
    if (upState === 'downloading' || upState === 'checking') return;
    if (upState === 'installable') {
      upState = 'checking'; upMsg = t('正在拉起安装…');
      installPending().then((r) => {
        if (!r) { upState = 'installable'; return; }   // 安卓壳：交给系统安装器，按钮照旧（文案停在「正在拉起安装…」）
        // 桌面壳：用户取消 / 这次没装（壳回到「可以装」）时按钮还原；在等空闲 / 交接中就跟着壳的状态走
        if (r.cancelled || r.ok === false) { upState = 'installable'; upMsg = t('一键更新'); }
        else if (r.waiting) { upMsg = waitingLine(r); pollState(); }
        else pollState();
      });
      return;
    }
    checkUpdate();
  }
  async function checkUpdate() {
    upState = 'checking'; upMsg = t('检查中…');
    let checked;
    try { checked = await checkForUpdate(); }
    catch { upState = 'error'; upMsg = t('连不上服务器'); return; }
    if (!checked?.available) {
      // 说清楚为什么没有可装的（S1-4：App 只认所连这台服务器发的包）
      upState = 'latest';
      upMsg = checked?.blocked ? (updateInfo.blockedReason === 'package' ? t('包名不同，不能覆盖安装') : t('签名不同，需卸载重装'))
        : checked?.noBuild ? t('服务器没有可发的版本')
        : checked?.appNewer ? t('App 比服务器新')
        : t('已是最新版本');
      return;
    }
    startDownload(checked.latest || {});
  }
  async function startDownload(latest) {
    const A = window.AndroidStore;
    if (hasSilentUpdate()) {
      upState = 'downloading'; progress = 0; upMsg = t('正在下载');
      try { await startUpdate(latest); } catch { upState = 'error'; upMsg = t('下载失败'); return; }
      pollState();
    } else if (A && A.startUpdate) {
      upState = 'downloading'; progress = 0; upMsg = t('正在下载');
      try { await startUpdate(latest); } catch { upState = 'error'; upMsg = t('下载失败'); return; }
      clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        let p = -1;
        try { p = A.updateProgress(); } catch {}
        if (p >= 100) { progress = 1; upState = 'done'; upMsg = t('下载完成，安装中…'); clearInterval(pollTimer); }
        else if (p === -2) { upState = 'error'; upMsg = t('下载失败'); clearInterval(pollTimer); }
        else if (p >= 0) { progress = p / 100; }
      }, 500);
    } else {
      await startUpdate(latest);
      upState = 'done'; upMsg = t('已在浏览器下载');
    }
  }

  // 版本：「The Bridge · v5.67（380）」——根页应用卡片与「关于」页显示。
  const ver = createVersionLine();   // 两套外壳共用（lib/settings/common.svelte.js）
  const verShort = $derived(stripBrand(ver.line));
  // 放弃正在下载 / 已下好的更新包（「关于」页；新壳才有这个桥，旧壳 cancelUpdate 回 false 就不动状态）
  function discardUpdate() {
    if (!cancelUpdate()) return;
    clearInterval(pollTimer);
    upState = 'idle'; progress = 0; upMsg = t('检查更新');
  }
  // 行尾「更新」状态文字（idle 不显示）
  const upDetail = $derived(upState === 'idle' ? '' : upMsg);
  return {
    get upState() { return upState; }, get progress() { return progress; }, get upDetail() { return upDetail; }, onUpClick, discardUpdate,
    get verShort() { return verShort; },
    stopPoll: () => clearInterval(pollTimer),
  };
}

export function createAbout(S) {
  // —— 关于（2026-10-21 并进原单页设置「关于与更新」「连接」两页的内容）——
  // 软件更新、自动检查更新、安装权限、新版本说明、版本历史、这台手机的信息；服务器那头的公网地址 / 后端运行多久。
  let appInfo = $state(S.plat === 'android' ? nativeInfo() : null);   // 装着的这一份 apk（+ 系统、机型、能否装包）
  let autoUp = $state(autoUpdateEnabled());
  function toggleAutoUp() { autoUp = !autoUp; setAutoUpdateEnabled(autoUp); }
  const upLatest = $derived(updateInfo.latest);
  const upHistory = $derived(upLatest?.history || []);
  const installedCode = $derived(S.plat === 'android' ? (appInfo?.code || 0) : (upLatest?.code || 0));
  const newerNotes = $derived(S.plat === 'android' && upLatest && upLatest.available !== false && (upLatest.code || 0) > installedCode ? upLatest : null);
  const aboutFoot = $derived(S.plat !== 'android' ? '' : [
    autoUp ? t('打开 app 时检查，发现新版就在后台下好并通知你，装不装由你决定') : '',
    appInfo && appInfo.canInstall === false ? t('安卓要求先允许「安装未知应用」，否则点安装会被系统拦下') : '',
    hasSilentUpdate() ? '' : t('这个安装包版本较旧，更新会交给浏览器下载，下载完手动安装'),
  ].filter(Boolean).join(' '));
  // /api/app/server-info（要登录）：{ app, multiUser, publicOrigin, server:{ uptimeSec, node } }。
  // 没有隧道状态——接口从来不给 tunnel 字段（原单页「连接」页那一行读的是空气），要显示得先让服务端给。
  const srv = createServerInfo();   // srvInfo、复制公网地址：两套外壳共用（lib/settings/common.svelte.js）；后端跑了多久用 fmtUptime
  function fmtDay(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // —— 服务器地址（iOS 警告框 + 文本框）——
  let addrOpen = $state(false);
  const addr = createServerAddress('');   // 地址框与「连接」两套外壳共用
  function openAddr() { addr.addrInput = getServerBase() || ''; addr.addrErr = ''; addrOpen = true; }
  // 「关于」进页才拉：服务器上的版本与历史（5 分钟内拉过就不重复打）、服务器状态（要登录）、这一份 apk 的信息（watchOpen）
  const aboutOpen = $derived(S.nav.stack.includes('about'));
  let connectOpen = $state(false);   // 关于页「让另一台设备扫码连接」点开才出码（S1-2）
  $effect(() => { if (!aboutOpen) connectOpen = false; });

  // 网页「关于 › 下载 App」：一键下载这台服务器发的 Windows 桌面客户端与安卓 App（都跟服主的版本对齐，见 src/routes/app-update.mjs）。
  // 两个下载都要登录：普通链接带不上 Authorization 头，令牌放在 ?token=（与 App 内更新取包同一做法）
  let deskDl = $state(null);
  // 服务端更新（管理员，lib/serverUpdate.svelte.js）：手机 / 网页上也能查 GitHub 上的版本、一键更新服务端（10-28 以前只能到服务端那台电脑上点）
  let srvUpd = null;
  const srvUpdView = $derived(srvUpd.view);
  const withTok = (p) => { const tok = getToken(); return apiUrl(p + (tok ? '?token=' + encodeURIComponent(tok) : '')); };
  const mb = (n) => (n > 0 ? ' · ' + (n / 1048576).toFixed(n >= 100 * 1048576 ? 0 : 1) + ' MB' : '');
  const dlFoot = $derived.by(() => {
    const pin = deskDl?.pinned, an = upLatest && upLatest.available !== false;
    if (deskDl && !deskDl.loading && !deskDl.available && upLatest && !an) return t('这台服务器上还没有可发的安装包，可以去发布页下载。');
    return pin ? t('和这台服务器同一次发布（v{v}）：装好后打开，登录这台服务器即可。', { v: pin })
      : t('版本和这台服务器对齐：装好后打开，登录这台服务器即可。');
  });
  // 下面两段 effect（以及 createServerUpdate）由外壳在原来的位置（导航栈建好之后）调用 watchOpen / watchBase 建立，保持 effect 与请求的先后
  function watchOpen() {
    $effect(() => {
      if (!aboutOpen) return;
      untrack(() => {
        if (!updateInfo.latest || Date.now() - updateInfo.checkedAt > 5 * 60_000) fetchLatest().catch(() => {});
        if (me.kind !== 'none') srv.load();
        if (me.kind === 'admin') srvUpd.load();
        if (S.plat === 'android') appInfo = nativeInfo();
        if (S.plat === 'web' && me.kind !== 'none') {
          deskDl = deskDl || { loading: true };
          api.get('/api/app/desktop').then((r) => { deskDl = r; }).catch(() => { deskDl = { available: false, failed: true }; });
        }
      });
    });
    srvUpd = createServerUpdate();
  }
  // 服务器换了地址、App 自动跟过去时（lib/server.js 地址簿）这一行要跟着刷新
  let baseTick = $state(0);
  function watchBase() {
    $effect(() => onServerBaseChange(() => { baseTick++; }));
  }
  // 「切换服务器」行右侧：当前那台的名字，存了几台就带上台数（面板关上时重读——里面可能改了名 / 删了）
  const srvSummary = $derived.by(() => {
    if (ui.serverSwitcherOpen || !canSwitchServers()) return '';
    const n = listProfiles().filter((p) => !p.pending).length;
    const name = activeProfile()?.name || '';
    return n > 1 ? t('{name} · 共 {n} 台', { name, n }) : name;
  });
  const serverHost = $derived((baseTick, (getServerBase() || '').replace(/^https?:\/\//, '')) || t('同源'));
  return {
    get appInfo() { return appInfo; }, set appInfo(v) { appInfo = v; }, get autoUp() { return autoUp; }, toggleAutoUp,
    get upLatest() { return upLatest; }, get upHistory() { return upHistory; }, get installedCode() { return installedCode; },
    get newerNotes() { return newerNotes; }, get aboutFoot() { return aboutFoot; },
    get srvInfo() { return srv.srvInfo; }, get pubCopied() { return srv.pubCopied; }, copyPublic: srv.copyPublic, fmtUptime, fmtDay,
    get addrOpen() { return addrOpen; }, set addrOpen(v) { addrOpen = v; }, addr, openAddr,
    get connectOpen() { return connectOpen; }, set connectOpen(v) { connectOpen = v; },
    get deskDl() { return deskDl; }, withTok, mb, get dlFoot() { return dlFoot; }, get srvUpd() { return srvUpd; }, get srvUpdView() { return srvUpdView; },
    watchOpen, watchBase, get srvSummary() { return srvSummary; }, get serverHost() { return serverHost; },
  };
}

export function createFeedback() {
  // —— 反馈（表单页）——
  let fbOpen = $state(false), fbText = $state(''), fbBusy = $state(false), fbDone = $state(false), fbErr = $state('');
  let fbAtts = $state([]), fbFileInput = $state();
  // 反馈去向（/api/feedback/upstream）：默认只留在这台服务器上。管理员在这张表单里主动打开「把用户反馈同时发给 bridge 开发者」
  // （默认关）之后，提交的人还要自己勾「这条也发给 bridge 开发者」（fbConsent，每次打开表单都是不勾）才发。
  // 没配中继地址（reason=no-relay）、不是正式实例时不出开关；开发者自己那台（mode=inbox）是汇总端，不出提示也不出开关。
  const up = createFeedbackUpstream();   // 去向开关、提示文案：两套外壳共用（lib/settings/common.svelte.js）
  let fbSentUp = $state(''), fbConsent = $state(false);
  function toggleFbUp() {
    if (up.fbUpBusy || !up.fbUp) return;
    return up.setFbUp(up.fbUp.mode !== 'push', (m) => { fbErr = m; });
  }
  function openFeedback() { fbText = ''; fbErr = ''; fbDone = false; fbAtts = []; fbSentUp = ''; fbConsent = false; fbOpen = true; up.loadFbUp(); }
  async function uploadFb(file, att) {
    return await api.uploadBlob(file.name, file, {
      onProgress: (p) => { if (att) att.progress = p; },
    });
  }
  async function onFbFiles(e) {
    const files = filesFromInput(e);
    for (const raw of files) {
      const isImg = (raw.type || '').startsWith('image/'), isVid = (raw.type || '').startsWith('video/');
      if (!isImg && !isVid) { fbErr = t('只能加图片或视频'); continue; }
      const f = isImg ? await compressImage(raw) : raw;
      await uploadAttachment(fbAtts, f, {
        draft: { name: f.name, kind: isImg ? 'image' : 'video', url: isImg ? URL.createObjectURL(f) : null, path: null, pending: true, progress: 0 },
        upload: uploadFb,
        applyResult: (att, result) => { att.path = result.path; att.pending = false; att.progress = 1; },
        onError: () => { fbErr = t('上传失败（弱网超时，可重试）：{name}', { name: raw.name }); },
      });
    }
  }
  function removeFbAtt(a) { removeAttachment(fbAtts, a); }
  async function submitFeedback() {
    if (fbDone) { fbOpen = false; return; }
    if (fbAtts.some((a) => a.pending)) { fbErr = t('附件还在上传…'); return; }
    const text = fbText.trim();
    if (!text && !fbAtts.length) { fbErr = t('写点什么、或加个图片/视频吧'); return; }
    fbBusy = true; fbErr = '';
    try {
      const attachments = fbAtts.filter((a) => a.path).map((a) => ({ path: a.path, name: a.name, kind: a.kind }));
      // shareWithDeveloper：提交的人自己勾了「这条也发给 bridge 开发者」才带 true，服务端才推（没带的只落本机）
      const r = await api.post('/api/feedback', { text, screen: ui.screen, attachments, shareWithDeveloper: up.fbUp?.mode === 'push' && fbConsent === true });
      if (r && r.ok === false) throw new Error(r.error || 'fail');
      fbSentUp = (r && r.upstream) || '';
      fbDone = true; fbText = ''; fbAtts = [];
    } catch (e) {
      const msg = e && (e.body?.error || e.message);
      fbErr = t('提交失败：{reason}', { reason: msg ? tr(msg) : t('连不上服务器') });
    }
    finally { fbBusy = false; }
  }
  return {
    get fbOpen() { return fbOpen; }, set fbOpen(v) { fbOpen = v; }, get fbText() { return fbText; }, set fbText(v) { fbText = v; },
    get fbBusy() { return fbBusy; }, get fbDone() { return fbDone; }, get fbErr() { return fbErr; }, get fbAtts() { return fbAtts; },
    get fbFileInput() { return fbFileInput; }, set fbFileInput(v) { fbFileInput = v; },
    get fbUp() { return up.fbUp; }, get fbUpBusy() { return up.fbUpBusy; }, get fbDest() { return up.fbDest; },
    get fbUpNote() { return up.fbUpNote; }, get fbUpAdminSub() { return up.fbUpAdminSub; }, get fbInboxLine() { return up.fbInboxLine; },
    get fbSentUp() { return fbSentUp; }, get fbConsent() { return fbConsent; }, set fbConsent(v) { fbConsent = v; },
    openFeedback, toggleFbUp, onFbFiles, removeFbAtt, submitFeedback,
  };
}
